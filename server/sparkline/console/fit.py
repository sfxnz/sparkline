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
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..common.schema import NodeInfo, NodeState, Problem, Sample

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
    # Strict, so that JSON true is not read as 1 byte or 1 layer.
    model_config = ConfigDict(strict=True)

    repo: str | None = None  # set when the facts came from a lookup
    # The size of the weight files a server loads. A parameter count cannot give it: a quantised repo keeps
    # some layers at 16 bits, and Hugging Face counts packed 4-bit weights as the weights they unpack to.
    weights_bytes: int = Field(gt=0)
    num_layers: int = Field(gt=0)
    num_kv_heads: int = Field(gt=0)
    head_dim: int = Field(gt=0)
    max_context: int | None = Field(default=None, gt=0)


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
    model_config = ConfigDict(strict=True)

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
    weights = facts.weights_bytes
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


class _RepoFile(BaseModel):
    rfilename: str
    size: int = Field(ge=0)


class _RepoFiles(BaseModel):
    siblings: list[_RepoFile]


class _WeightIndex(BaseModel):
    weight_map: dict[str, str] = Field(min_length=1)


WEIGHTS_FILE = "model.safetensors"
INDEX_FILE = "model.safetensors.index.json"


def file_sizes(repo: RepoId, info: object) -> dict[str, int] | Problem:
    """Every file in the repo and its size, from the repo's ``/api/models`` answer as decoded JSON."""
    try:
        files = _RepoFiles.model_validate(info, strict=True).siblings
    except ValidationError:
        return _problem(
            f"Hugging Face does not list the files of {repo} in a way this estimator reads",
            "Its answer is not a list of file names with sizes",
        )
    return {f.rfilename: f.size for f in files}


def _safetensors(sizes: dict[str, int]) -> list[str]:
    return [name for name in sizes if name.endswith(".safetensors")]


def _total(repo: RepoId, sizes: dict[str, int], names: set[str]) -> int | Problem:
    return sum(sizes[n] for n in names) or _problem(
        f"The weight files of {repo} are empty", "Hugging Face lists them at 0 bytes"
    )


def unindexed_weights(repo: RepoId, sizes: dict[str, int]) -> int | Problem:
    """The size of the weights a server loads from a repo with no index: its ``model.safetensors``.

    Other safetensors files beside it are copies (``consolidated.safetensors``, an fp32 variant) or parts
    of something else, and no file says which, so they are not counted.
    """
    if WEIGHTS_FILE in sizes:
        return _total(repo, sizes, {WEIGHTS_FILE})
    others = _safetensors(sizes)
    return _problem(
        f"{repo} has no {WEIGHTS_FILE} and no {INDEX_FILE} at its top level",
        f"Its .safetensors files have other names ({', '.join(others[:3])}"
        f"{f' and {len(others) - 3} more' if len(others) > 3 else ''}), and without an index the lookup "
        "cannot tell which of them a server loads"
        if others
        else "It holds no .safetensors files. GGUF, PyTorch .bin and other formats are not read",
    )


def indexed_weights(repo: RepoId, sizes: dict[str, int], index: object) -> int | Problem:
    """The size of the files the repo's index names, from ``model.safetensors.index.json`` as decoded JSON.

    The index maps every tensor to the file that holds it, so its files are the ones a server loads. File
    names do not say this: an index can name several shard families and files under any name.
    """
    try:
        names = set(_WeightIndex.model_validate(index, strict=True).weight_map.values())
    except ValidationError:
        return _problem(
            f"The weight index of {repo} is not one this estimator reads",
            f"{INDEX_FILE} has no weight_map from tensor names to file names",
        )
    missing = sorted(names - sizes.keys())
    if missing:
        return _problem(
            f"The weight index of {repo} names files the repo does not hold",
            f"{missing[0]}{f' and {len(missing) - 1} more' if len(missing) > 1 else ''} in {INDEX_FILE}, "
            "so a server cannot load the repo as it is",
        )
    if WEIGHTS_FILE in sizes and WEIGHTS_FILE not in names:
        return _problem(
            f"{repo} holds two sets of safetensors weights",
            f"It has {WEIGHTS_FILE}, and an index that names other files. Some loaders read the first and "
            "some the second",
        )
    return _total(repo, sizes, names)


def _index_too_large(repo: RepoId, sizes: dict[str, int]) -> Problem:
    files = _safetensors(sizes)
    # Rounded up to 0.1 GB: the weights are some of these files, never more than all of them.
    at_most = -(-sum(sizes[f] for f in files) // 10**8) / 10
    return _problem(
        f"The weight index of {repo} is too large for the lookup to read",
        f"{INDEX_FILE} is {sizes[INDEX_FILE] / 2**20:.1f} MiB and the lookup reads at most "
        f"{MAX_RESPONSE_BYTES / 2**20:.1f} MiB of an answer, so it cannot tell which files a server loads",
        f"{MANUAL_FIX}. The weights are at most {at_most} GB, the total of the repo's {len(files)} "
        ".safetensors files",
    )


_SHAPE_KEYS = {
    "num_layers": "num_hidden_layers",
    "num_kv_heads": "num_key_value_heads or num_attention_heads",
    "head_dim": "head_dim, or hidden_size and num_attention_heads",
    "max_context": "max_position_embeddings",
}


def parse_facts(repo: RepoId, weights: int, config: object) -> ModelFacts | Problem:
    """The size of the repo's weights and its ``config.json`` as decoded JSON."""
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
                "weights_bytes": weights,
                "num_layers": config.get("num_hidden_layers"),
                "num_kv_heads": config.get("num_key_value_heads", heads),
                "head_dim": head_dim,
                "max_context": config.get("max_position_embeddings"),
            }
        )
    except ValidationError as e:
        keys = "; ".join(_SHAPE_KEYS[str(err["loc"][0])] for err in e.errors())
        return _problem(
            f"Hugging Face does not describe {repo} in a way this estimator reads",
            f"Its config.json has no whole number above 0 for {keys}",
        )


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
                if r.status_code == 429:
                    return _problem(
                        "Hugging Face has rate limited the console host",
                        f"HTTP 429 from {HF_ORIGIN}{path}",
                        f"Try again in a few minutes, {OR_MANUAL_FIX}",
                    )
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
    """Read the size of a public repo's weights and its architecture."""
    # Hugging Face answers 401 for a repo that does not exist and for a private one alike.
    absent = _problem(
        f"Hugging Face has no public model {repo}",
        "The repo does not exist or is private",
        f"Check the repo id, {OR_MANUAL_FIX}",
    )
    # expand[]=siblings keeps the answer to the file list. Without it the model card comes too, which is
    # a third of the response cap for some repos.
    info = await _get_hf_json(
        client, f"/api/models/{repo}?expand[]=siblings&blobs=true", {401: absent, 403: absent, 404: absent}
    )
    if isinstance(info, Problem):
        return info
    sizes = file_sizes(repo, info.value)
    if isinstance(sizes, Problem):
        return sizes
    gated = _problem(
        f"{repo} is gated on Hugging Face",
        "Its files are only served to accounts that accepted the model's terms",
    )
    weights: int | Problem
    if INDEX_FILE not in sizes:
        weights = unindexed_weights(repo, sizes)
    # The file list gives the index's size, so an index over the cap is never asked for.
    elif sizes[INDEX_FILE] > MAX_RESPONSE_BYTES:
        weights = _index_too_large(repo, sizes)
    else:
        index = await _get_hf_json(client, f"/{repo}/resolve/main/{INDEX_FILE}", {401: gated, 403: gated})
        weights = index if isinstance(index, Problem) else indexed_weights(repo, sizes, index.value)
    if isinstance(weights, Problem):
        return weights
    no_config = _problem(f"{repo} has no config.json", "The estimator reads the model's shape from it")
    config = await _get_hf_json(
        client, f"/{repo}/resolve/main/config.json", {401: gated, 403: gated, 404: no_config}
    )
    if isinstance(config, Problem):
        return config
    return parse_facts(repo, weights, config.value)
