"""Will it fit: estimate a model's memory at a context length and compare it with each node's free memory.

The estimate and the budgets are pure functions. The only IO is ``fetch_facts``, which reads a public
Hugging Face repo when the user asks for a lookup. The wire types are mirrored in web/src/lib/types.ts.

Not modelled: GGUF repos, sliding-window attention layers, splitting a model across GPUs, the AMD GTT limit
and the macOS wired-memory limit.
"""

from __future__ import annotations

import json
import re
from typing import Annotated, Literal, NamedTuple, NewType

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator

from ..common.schema import NodeInfo, NodeState, Problem, Sample

DTYPE_BYTES = {
    "F64": 8,
    "F32": 4,
    "F16": 2,
    "BF16": 2,
    "I64": 8,
    "I32": 4,
    "I16": 2,
    "I8": 1,
    "U8": 1,
    "BOOL": 1,
    "F8_E4M3": 1,
    "F8_E5M2": 1,
}
KV_DTYPE_BYTES = {"fp16": 2, "bf16": 2, "fp8": 1}
KEY_AND_VALUE = 2
OVERHEAD_PCT = (10, 20)
UNIFIED_HEADROOM_BYTES = 4 * 2**30

HF_ORIGIN = "https://huggingface.co"
MAX_RESPONSE_BYTES = 1 << 20
MAX_REDIRECTS = 3
MANUAL_FIX = "Enter the model facts by hand"
OR_MANUAL_FIX = "or enter the model facts by hand"

RepoId = NewType("RepoId", str)
_REPO_PART = r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}"
REPO_ID_PATTERN = rf"^{_REPO_PART}/{_REPO_PART}$"


class ModelFacts(BaseModel):
    repo: str | None = None  # set when the facts came from a lookup
    params_by_dtype: dict[str, Annotated[int, Field(ge=0)]] = Field(min_length=1)
    num_layers: int = Field(gt=0)
    num_kv_heads: int = Field(gt=0)
    head_dim: int = Field(gt=0)
    max_context: int | None = Field(default=None, gt=0)

    @field_validator("params_by_dtype")
    @classmethod
    def _known_dtypes(cls, v: dict[str, int]) -> dict[str, int]:
        unknown = sorted(set(v) - set(DTYPE_BYTES))
        if unknown:
            raise ValueError(f"unknown weight dtype {', '.join(unknown)} (known: {', '.join(DTYPE_BYTES)})")
        return v


class Estimate(BaseModel):
    weights_bytes: int
    kv_bytes_per_token: int
    kv_bytes: int
    total_low: int
    total_high: int


class UnifiedBudget(BaseModel):
    kind: Literal["unified"] = "unified"
    bytes: int  # available - headroom, never below 0
    available: int
    headroom: int
    gpu_vendor: str | None  # "nvidia" on a GB10


class GpuBudget(BaseModel):
    """Free dedicated memory of the one GPU with the most free: a model that needs two GPUs is not a fit."""

    kind: Literal["gpu"] = "gpu"
    bytes: int
    gpu_index: int
    gpu_name: str


class UnknownBudget(BaseModel):
    kind: Literal["unknown"] = "unknown"
    reason: str


NodeBudget = Annotated[UnifiedBudget | GpuBudget | UnknownBudget, Field(discriminator="kind")]
Verdict = Literal["fits", "tight", "no", "unknown"]


class NodeFit(BaseModel):
    node_id: str
    budget: NodeBudget
    verdict: Verdict


class FitRequest(BaseModel):
    facts: ModelFacts
    context_tokens: int = Field(gt=0)
    kv_dtype: str

    @field_validator("kv_dtype")
    @classmethod
    def _known_kv_dtype(cls, v: str) -> str:
        if v not in KV_DTYPE_BYTES:
            raise ValueError(f"unknown KV cache dtype {v!r} (known: {', '.join(KV_DTYPE_BYTES)})")
        return v


class FitResponse(BaseModel):
    estimate: Estimate
    nodes: list[NodeFit]


def estimate(facts: ModelFacts, context_tokens: int, kv_dtype: str) -> Estimate:
    weights = sum(n * DTYPE_BYTES[dtype] for dtype, n in facts.params_by_dtype.items())
    per_head = KEY_AND_VALUE * facts.head_dim * KV_DTYPE_BYTES[kv_dtype]
    per_token = facts.num_layers * facts.num_kv_heads * per_head
    kv = per_token * context_tokens
    low, high = ((weights + kv) * (100 + pct) // 100 for pct in OVERHEAD_PCT)
    return Estimate(
        weights_bytes=weights, kv_bytes_per_token=per_token, kv_bytes=kv, total_low=low, total_high=high
    )


def node_budget(info: NodeInfo | None, sample: Sample | None) -> NodeBudget:
    if info is None or sample is None:
        return UnknownBudget(reason="No sample from this node yet")
    dedicated = [g for g in info.gpus if g.memory != "unified"]
    if not dedicated:
        if not sample.mem.total:
            return UnknownBudget(reason="This node's agent has no memory reading")
        available = sample.mem.available
        return UnifiedBudget(
            bytes=max(0, available - UNIFIED_HEADROOM_BYTES),
            available=available,
            headroom=UNIFIED_HEADROOM_BYTES,
            gpu_vendor=info.gpus[0].vendor if info.gpus else None,
        )
    used = {g.index: g.vram_used for g in sample.gpu}
    free = [
        (g.vram_total - u, g)
        for g in dedicated
        if g.vram_total is not None and (u := used.get(g.index)) is not None
    ]
    if not free:
        return UnknownBudget(reason="This node's GPUs do not report their dedicated memory in use")
    most, gpu = max(free, key=lambda f: f[0])
    return GpuBudget(bytes=max(0, most), gpu_index=gpu.index, gpu_name=gpu.name)


def verdict(est: Estimate, budget: NodeBudget) -> Verdict:
    if isinstance(budget, UnknownBudget):
        return "unknown"
    if est.total_high <= budget.bytes:
        return "fits"
    return "tight" if est.total_low <= budget.bytes else "no"


def node_fit(state: NodeState, sample: Sample | None, est: Estimate) -> NodeFit:
    budget: NodeBudget = (
        node_budget(state.info, sample)
        if state.status == "online"
        else UnknownBudget(reason=f"The node is {state.status}, so its free memory is not known")
    )
    return NodeFit(node_id=state.node_id, budget=budget, verdict=verdict(est, budget))


# -- Hugging Face lookup ------------------------------------------------------------------------------


def parse_repo_id(raw: str) -> RepoId | None:
    """``owner/name`` as Hugging Face spells it, or None. The id goes into a URL path."""
    raw = raw.strip()
    return RepoId(raw) if re.fullmatch(REPO_ID_PATTERN, raw) and ".." not in raw else None


def _problem(message: str, cause: str, fix: str = MANUAL_FIX) -> Problem:
    return Problem(message=message, cause=cause, fix=fix)


def _params(info: object) -> object:
    safetensors = info.get("safetensors") if isinstance(info, dict) else None
    return safetensors.get("parameters") if isinstance(safetensors, dict) else None


def _no_safetensors(repo: RepoId) -> Problem:
    return _problem(
        f"{repo} has no safetensors parameter counts on Hugging Face",
        "Only safetensors repos can be looked up. GGUF and PyTorch .bin repos are not read",
    )


def parse_facts(repo: RepoId, info: object, config: object) -> ModelFacts | Problem:
    """The repo's ``/api/models`` answer and its ``config.json``, both as decoded JSON."""
    params = _params(info)
    if not params:
        return _no_safetensors(repo)
    if not isinstance(config, dict):
        return _problem(f"The config.json of {repo} is not a JSON object", f"It is a {type(config).__name__}")
    heads, hidden = config.get("num_attention_heads"), config.get("hidden_size")
    head_dim = config.get("head_dim")
    if head_dim is None and isinstance(heads, int) and isinstance(hidden, int) and heads > 0:
        head_dim = hidden // heads
    try:
        return ModelFacts.model_validate(
            {
                "repo": repo,
                "params_by_dtype": params,
                "num_layers": config.get("num_hidden_layers"),
                "num_kv_heads": config.get("num_key_value_heads", heads),
                "head_dim": head_dim,
                "max_context": config.get("max_position_embeddings"),
            },
            strict=True,
        )
    except ValidationError as e:
        errs = "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()[:3])
        return _problem(f"Hugging Face does not describe {repo} in a way this estimator reads", errs)


class _Json(NamedTuple):
    value: object


async def _get_hf_json(
    client: httpx.AsyncClient, path: str, by_status: dict[int, Problem]
) -> _Json | Problem:
    url = httpx.URL(HF_ORIGIN + path)
    try:
        for _ in range(MAX_REDIRECTS + 1):
            async with client.stream("GET", url, follow_redirects=False) as r:
                if r.has_redirect_location:
                    url = url.join(r.headers["location"])
                    if f"{url.scheme}://{url.netloc.decode()}" != HF_ORIGIN:
                        return _problem(
                            "Hugging Face redirected the lookup to another host",
                            f"The console only reads from {HF_ORIGIN} and does not follow {url.host}",
                        )
                    continue
                if r.status_code != 200:
                    return by_status.get(r.status_code) or _problem(
                        "Hugging Face could not answer the lookup",
                        f"HTTP {r.status_code} from {HF_ORIGIN}{path}",
                    )
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_RESPONSE_BYTES:
                        return _problem(
                            "Hugging Face sent more data than a model description needs",
                            f"More than {MAX_RESPONSE_BYTES} bytes from {HF_ORIGIN}{path}",
                        )
                return _Json(json.loads(body))
    except httpx.HTTPError as e:
        return _problem(
            "Could not reach huggingface.co from the console host",
            f"{type(e).__name__}: {e}".removesuffix(": "),
            f"Check the console host's internet access, {OR_MANUAL_FIX}",
        )
    # json.loads raises RecursionError, not ValueError, for an answer nested too deep to decode.
    except (ValueError, RecursionError):
        return _problem("Hugging Face sent an answer that is not JSON", f"From {HF_ORIGIN}{path}")
    return _problem("Hugging Face kept redirecting the lookup", f"More than {MAX_REDIRECTS} redirects")


async def fetch_facts(client: httpx.AsyncClient, repo: RepoId) -> ModelFacts | Problem:
    """Read a public repo's parameter counts and architecture."""
    # Hugging Face answers 401 for a repo that does not exist and for a private one alike.
    absent = _problem(
        f"Hugging Face has no public model {repo}",
        "The repo does not exist or is private",
        f"Check the repo id, {OR_MANUAL_FIX}",
    )
    info = await _get_hf_json(
        client, f"/api/models/{repo}?expand[]=safetensors", {401: absent, 403: absent, 404: absent}
    )
    if isinstance(info, Problem):
        return info
    if not _params(info.value):
        return _no_safetensors(repo)
    gated = _problem(
        f"{repo} is gated on Hugging Face",
        "Its config.json is only served to accounts that accepted the model's terms",
    )
    no_config = _problem(f"{repo} has no config.json", "The estimator reads the model's shape from it")
    config = await _get_hf_json(
        client, f"/{repo}/resolve/main/config.json", {401: gated, 403: gated, 404: no_config}
    )
    if isinstance(config, Problem):
        return config
    return parse_facts(repo, info.value, config.value)
