"""Will it fit: estimate a model's memory at a context length and compare it with each node's free memory.

The estimate and the budgets are pure functions. Every outbound request goes through ``_get_hf_json``, which
``fetch_facts`` and ``weights_of`` call and nothing else in the module does: a GET to ``HF_ORIGIN``, no body,
no credentials, at most ``MAX_RESPONSE_BYTES`` read. The wire types are mirrored in web/src/lib/types.ts.

A lookup reads two files of a repo, its file list and its ``config.json``, and sometimes a third, its weight
index. It fills in a size only when nothing it read is a sign that the model reaches outside the repo's own
weight files, and names the sign it found when it will not. The signs are: a string in ``config.json`` that
names another repo, an ``adapter_config.json``, a ``.safetensors`` file the sizing leaves out, a weight file
in another format whose name does not mark it as a copy or as training state, and a ``config.json`` it could
not read at all. The model's shape comes from that same ``config.json``, and a size is never filled in
without it.

None of that proves the repo holds the whole model, and nothing here claims it does. A repo's own code can
load a second model that no file the lookup reads names, a draft model is served beside a target the repo
need not name, and ``subfolder=``, ``variant=`` and a LoRA flag are the caller's. So what the page fills in
is the size of this repo's own weight files, and the form and the result say that beside the number.

Not modelled: GGUF repos, sliding-window attention, latent attention (the KV cache estimate is 25 times too
high for DeepSeek-V3), splitting a model across GPUs, the AMD GTT limit and the macOS wired-memory limit.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterator
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


class ModelShape(BaseModel):
    """What sizes the KV cache. A lookup reads it from ``config.json``."""

    # Strict, so that JSON true is not read as 1 byte or 1 layer.
    model_config = ConfigDict(strict=True)

    num_layers: int = Field(gt=0)
    num_kv_heads: int = Field(gt=0)
    head_dim: int = Field(gt=0)
    max_context: int | None = Field(default=None, gt=0)


class ModelFacts(ModelShape):
    repo: str | None = None  # set when the facts came from a lookup
    # The size of the weight files a server loads. A parameter count cannot give it: a quantised repo keeps
    # some layers at 16 bits, and Hugging Face counts packed 4-bit weights as the weights they unpack to.
    weights_bytes: int = Field(gt=0)
    # Set when a lookup could not read which files a server loads, and weights_bytes is the total of every
    # weight file in the repo: a server loads that much or less.
    weights_upper_bound: bool = False


class Found(BaseModel):
    """The part of the facts a refused lookup still read. The page fills it in and asks for the rest.

    A size never comes without a shape. Both are read from the same ``config.json``, which is also the only
    place the repo says that a server loads weights from somewhere else, so a size the lookup cannot pair
    with a shape is a size it cannot say covers the model. ``found_by`` is the one way to build this.
    """

    weights_bytes: int | None = None
    weights_upper_bound: bool = False
    shape: ModelShape | None = None


class LookupFailure(BaseModel):
    """The body of a refused lookup."""

    problem: Problem
    found: Found = Found()


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
ADAPTER_FILE = "adapter_config.json"

# A key whose value records where a model was made from. No loader reads weights from it.
PROVENANCE_KEY = "_name_or_path"
# A key of `auto_map`, which names a repo transformers imports model code from, never weights.
AUTO_MAP_KEY = re.compile(r"Auto[A-Za-z]*")


# A weight file in a format the lookup never reads. A server that loads one of these beside the
# safetensors loads more than the lookup sized, so the repo gets no size unless every such file is a copy
# of the same weights or training state. The three lists below are a census of the 10,274 cached file lists
# (.audit/evidence/D/round-6/census_formats.out, priced in price_formats.out): they keep 115 of the 129
# full answers that hold such a file, and 0 of the 796 popular repos and 0 of the 100-repo sample lose one.
OTHER_FORMATS = (".bin", ".pt", ".pth", ".ckpt", ".gguf", ".npz")
# A top-level folder that holds the same model built for another runtime, so its weight files are copies.
ALT_RUNTIME_DIR = re.compile(
    r"(onnx|openvino|coreml|metal|mlx|ggml|gguf|tf|flax|original|llama-cpp|llamafile|ct2|ctranslate2"
    r"|tensorrt|trt|rknn|nemo)(_[A-Za-z0-9._-]+)?",
    re.IGNORECASE,
)
# A file name, its digits folded to N, that marks a copy of the same weights in another format.
COPY_NAMES = frozenset({
    "pytorch_model.bin", "pytorch_model-N-of-N.bin", "model.ckpt",
    "consolidated.pt", "consolidated.pth", "consolidated.N.pt", "consolidated.N.pth",
    "consolidated-N-of-N.pth",
    "openvino_model.bin", "openvino_model_qintN_quantized.bin",
})  # fmt: skip
COPY_NAME_PATTERN = re.compile(r"ggml-model.*\.bin")
# A file name, its digits folded to N, that marks training state. No server loads it to serve the model.
TRAINING_NAMES = frozenset({
    "training_args.bin", "training_state.pt", "trainer_state.pt",
    "optimizer.bin", "optimizer.pt", "optimizer_state_dict.pt",
    "scheduler.bin", "scheduler.pt", "scheduler_state_dict.pt",
    "scaler.pt", "rng_state.pth", "rng_state_N.pth",
})  # fmt: skip


def is_copy_or_training_state(name: str) -> bool:
    """Whether this file's name marks it as a copy of the same weights, or as training state."""
    # vLLM's Flint loads *.gguf instead of a repo's safetensors, never beside them (round 5 read the
    # loaders; loader_paths.out), so a GGUF file is the same model in llama.cpp's format.
    if name.lower().endswith(".gguf"):
        return True
    folder, _, base = name.rpartition("/")
    if folder and ALT_RUNTIME_DIR.fullmatch(folder.split("/")[0]):
        return True
    folded = re.sub(r"\d+", "N", base)
    return folded in COPY_NAMES or folded in TRAINING_NAMES or bool(COPY_NAME_PATTERN.fullmatch(folded))


def other_format_weights(repo: RepoId, sizes: dict[str, int]) -> Problem | None:
    """Why the lookup will not size a repo holding a weight file it never reads, or None."""
    others = sorted(
        name for name in sizes if name.lower().endswith(OTHER_FORMATS) and not is_copy_or_training_state(name)
    )
    if not others:
        return None
    return _problem(
        f"{repo} holds a weight file in a format the lookup does not read",
        f"{_listed(others)} sits in the repo beside its safetensors files, and the lookup cannot tell "
        "whether a server loads it as well",
    )


def file_sizes(repo: RepoId, info: object) -> dict[str, int] | Problem:
    """Every file in the repo and its size, from the repo's ``/api/models`` answer as decoded JSON."""
    try:
        files = _RepoFiles.model_validate(info, strict=True).siblings
    except ValidationError:
        return _problem(
            f"Hugging Face does not list the files of {repo} in a way this estimator reads",
            "Its answer is not a list of file names with sizes",
        )
    sizes = {f.rfilename: f.size for f in files}
    if len(sizes) != len(files):
        seen = Counter(f.rfilename for f in files)
        twice = sorted(name for name, n in seen.items() if n > 1)
        return _problem(
            f"Hugging Face lists a file of {repo} twice",
            f"{_listed(twice)} appears more than once with a size, so the lookup cannot tell how large it is",
        )
    return sizes


def _safetensors(sizes: dict[str, int]) -> list[str]:
    return [name for name in sizes if name.endswith(".safetensors")]


def _total(repo: RepoId, sizes: dict[str, int], names: set[str]) -> int | Problem:
    return sum(sizes[n] for n in names) or _problem(
        f"The weight files of {repo} are empty", "Hugging Face lists them at 0 bytes"
    )


def _listed(names: list[str]) -> str:
    return f"{', '.join(names[:3])}{f' and {len(names) - 3} more' if len(names) > 3 else ''}"


def _left_out(sizes: dict[str, int], named: set[str]) -> list[str]:
    """The repo's safetensors files, at any depth, that ``named`` leaves out."""
    return sorted(set(_safetensors(sizes)) - named)


def unindexed_weights(repo: RepoId, sizes: dict[str, int]) -> int | Problem:
    """The size of the weights a server loads from a repo with no index: its ``model.safetensors``.

    Only when that is the one safetensors file in the repo. Any other is a second candidate for the
    weights: with no index some servers load every top-level file, and a model class can load a subfolder
    of the repo it serves (vLLM's kimi_audio reads ``whisper-large-v3/``).
    """
    others = _left_out(sizes, {WEIGHTS_FILE})
    if WEIGHTS_FILE not in sizes:
        return _problem(
            f"{repo} has no {WEIGHTS_FILE} and no {INDEX_FILE} at its top level",
            f"It holds other .safetensors files ({_listed(others)}), and without an index the lookup "
            "cannot tell which of them a server loads"
            if others
            else "It holds no .safetensors files. GGUF, PyTorch .bin and other formats are not read",
        )
    if others:
        return _problem(
            f"{repo} holds other safetensors files beside its {WEIGHTS_FILE}, and no index",
            f"The lookup cannot tell whether a server loads only {WEIGHTS_FILE} or {_listed(others)} as well",
        )
    return _total(repo, sizes, {WEIGHTS_FILE})


def indexed_weights(repo: RepoId, sizes: dict[str, int], index: object) -> int | Problem:
    """The size of the files the repo's index names, from ``model.safetensors.index.json`` as decoded JSON.

    The index maps every tensor of the model it describes to the file that holds it, so its files are ones
    a server loads. File names do not say this: an index can name several shard families and files under any
    name. It does not say that nothing else is loaded, so a safetensors file it leaves out is refused.
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
    others = _left_out(sizes, names)
    if others:
        return _problem(
            f"The weight index of {repo} does not name every safetensors file in the repo",
            f"It names {len(names)} of them, and the lookup cannot tell whether a server also loads "
            f"{_listed(others)}: some models load a file in a subfolder, or one beside the index's",
        )
    return _total(repo, sizes, names)


_SHARD = re.compile(r"(.*)-\d+-of-(\d+)\.safetensors")


def unread_index_weights(repo: RepoId, sizes: dict[str, int]) -> int | Problem:
    """An upper bound on the weights of a repo whose index is too large to read: the total of its shards.

    Only when every ``.safetensors`` file in the repo, at any depth, is a top-level shard of one family,
    ``<stem>-N-of-M.safetensors`` with one stem and one M. A server loads that family or a part of it, so
    the total is never too low. With a second family, a single file or a file in a subfolder the total can
    be far above what a server loads, and the repo is refused.
    """
    files = _safetensors(sizes)
    families = {m.groups() if "/" not in f and (m := _SHARD.fullmatch(f)) else None for f in files}
    if len(families) != 1 or None in families:
        return _index_too_large(repo, sizes)
    return _total(repo, sizes, set(files))


def _index_too_large(repo: RepoId, sizes: dict[str, int]) -> Problem:
    files = _safetensors(sizes)
    # Rounded up to 0.1 GB: the weights are some of these files, never more than all of them.
    at_most = -(-sum(sizes[f] for f in files) // 10**8) / 10
    return _problem(
        f"The weight index of {repo} is too large for the lookup to read",
        f"{INDEX_FILE} is {sizes[INDEX_FILE] / 2**20:.1f} MiB and the lookup reads at most "
        f"{MAX_RESPONSE_BYTES / 2**20:.1f} MiB of an answer, so it cannot tell which files a server loads",
        f"{MANUAL_FIX}: the weights are at most {at_most} GB, the total of the repo's {len(files)} "
        ".safetensors files",
    )


_SHAPE_KEYS = {
    "num_layers": "num_hidden_layers",
    "num_kv_heads": "num_key_value_heads or num_attention_heads",
    "head_dim": "head_dim, or hidden_size and num_attention_heads",
    "max_context": "max_position_embeddings",
}


def _whole(value: object) -> int | None:
    """``value`` if it is a JSON whole number above 0. A JSON ``true`` is not 1: ``True // True`` is 1 in
    Python, and a config holding a boolean where a dimension belongs describes no model."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def parse_shape(repo: RepoId, config: dict[str, object]) -> ModelShape | Problem:
    """The model's shape, from the repo's ``config.json`` as decoded JSON."""
    heads, hidden = config.get("num_attention_heads"), config.get("hidden_size")
    head_dim = config.get("head_dim")
    if head_dim is None and (h := _whole(heads)) is not None and (w := _whole(hidden)) is not None:
        head_dim = w // h
    try:
        return ModelShape.model_validate(
            {
                "num_layers": config.get("num_hidden_layers"),
                "num_kv_heads": config.get("num_key_value_heads", heads),
                "head_dim": head_dim,
                "max_context": config.get("max_position_embeddings"),
            }
        )
    except ValidationError as e:
        keys = "; ".join(_SHAPE_KEYS[str(err["loc"][0])] for err in e.errors())
        # "at its top level" is the whole of what the lookup looked at. 1,472 of 3,867 cached configs keep
        # the shape in a sub-object such as text_config, and the cause without those words is false of
        # every one of them (.audit/evidence/verify/D4/nested_shape_census.out).
        return _problem(
            f"Hugging Face does not describe {repo} in a way this estimator reads",
            f"Its config.json has no whole number above 0 for {keys} at its top level",
            f"{MANUAL_FIX}: the lookup reads the top level of config.json only, so a shape kept in a "
            "sub-object such as text_config, or under an older name such as n_layer, is read off the "
            "config and typed in",
        )


class _Json(NamedTuple):
    value: object


async def _get_hf_json(
    client: httpx.AsyncClient, path: str, by_status: dict[int, Problem], what: str = "The answer"
) -> _Json | Problem:
    """One file of a repo as decoded JSON, or why not. ``what`` names the file in a problem about its size."""
    url = httpx.URL(HF_ORIGIN + path)
    try:
        for _ in range(MAX_REDIRECTS + 1):
            # The lookup signs in to nothing, so it keeps no cookie from an earlier answer or an earlier
            # lookup. httpx stores every Set-Cookie on the client and would send them back.
            client.cookies.clear()
            async with client.stream("GET", url, follow_redirects=False) as r:
                if r.has_redirect_location:
                    url = url.join(r.headers["location"])
                    if f"{url.scheme}://{url.netloc.decode()}" != HF_ORIGIN:
                        return _problem(
                            "Hugging Face redirected the lookup to another host",
                            f"The console only reads from {HF_ORIGIN} and does not follow {url.host}",
                        )
                    # netloc leaves out the user info, so a redirect to user:pass@huggingface.co is on
                    # the right host. httpx would turn it into an Authorization: Basic header.
                    if url.userinfo:
                        return _problem(
                            "Hugging Face redirected the lookup to a URL carrying a user name",
                            f"The console reads {HF_ORIGIN} without signing in, and following that "
                            "redirect would make it send credentials",
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
                            f"{what} is larger than the lookup reads",
                            f"The lookup reads at most {MAX_RESPONSE_BYTES / 2**20:.1f} MiB of an answer, "
                            f"and {HF_ORIGIN}{path} sent more",
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


class _Weights(NamedTuple):
    bytes: int
    upper_bound: bool


def found_by(weights: _Weights | Problem, shape: ModelShape | Problem) -> Found:
    """What one lookup read, as the page fills it in. No size without the shape it belongs to."""
    if isinstance(shape, Problem):
        return Found()
    if isinstance(weights, Problem):
        return Found(shape=shape)
    return Found(weights_bytes=weights.bytes, weights_upper_bound=weights.upper_bound, shape=shape)


def read_config(repo: RepoId, answer: _Json | Problem) -> dict[str, object] | Problem:
    """The repo's ``config.json`` as an object, or why the lookup has none.

    It is read twice over: for the model's shape, and because it is the only place the repo says that a
    server loads weights from somewhere else. Without it neither is known.
    """
    if isinstance(answer, Problem):
        problem = answer
    elif isinstance(answer.value, dict):
        return answer.value
    else:
        problem = _problem(
            f"The config.json of {repo} is not a JSON object", f"It is a {type(answer.value).__name__}"
        )
    return _problem(
        problem.message,
        f"{problem.cause}. Without the repo's config.json the lookup has neither the model's shape nor any "
        "sign that the model names another repo, so it fills in no size either",
        problem.fix,
    )


def config_strings(config: dict[str, object]) -> Iterator[tuple[tuple[str, ...], str]]:
    """Every string in a decoded ``config.json``, with the dict keys above it.

    A list does not add to the path, so a string in ``mm_vision_tower_aux_list`` is reported under that
    key. Iterative, so a config nested deeply enough to pass ``json.loads`` cannot exhaust the stack here.
    """
    stack: list[tuple[object, tuple[str, ...]]] = [(config, ())]
    while stack:
        node, path = stack.pop()
        if isinstance(node, dict):
            stack.extend((value, (*path, key)) for key, value in node.items())
        elif isinstance(node, list):
            stack.extend((value, path) for value in node)
        elif isinstance(node, str):
            yield path, node


def names_another_repo(repo: RepoId, path: tuple[str, ...], value: str) -> bool:
    """Whether this ``config.json`` string names a Hugging Face repo other than the one looked up.

    A repo id is ``owner/name``, as ``parse_repo_id`` spells it. Three kinds of value are not another repo,
    each for a reason, and nothing else is exempt:

    - the repo being looked up, which is not another repo;
    - a value under ``_name_or_path`` at any depth: the key records where a model was made from, and no
      loader reads weights from any config.json key (round 5 read every weight source in vLLM,
      transformers and peft; loader_paths.out). The contract exempts the top-level key, and the key means
      the same thing in a sub-config;
    - an ``auto_map`` entry: transformers imports model code from there, never weights. A repo's own code
      can load whatever it likes, the lookup never reads code, and a repo whose code sits in its own
      modeling_*.py gets a size, so where that code lives changes nothing the lookup can see.
    """
    value = value.strip()
    if not re.fullmatch(REPO_ID_PATTERN, value) or value.lower() == repo.lower():
        return False
    if path[-1] == PROVENANCE_KEY:
        return False
    return not (len(path) > 1 and path[-2] == "auto_map" and AUTO_MAP_KEY.fullmatch(path[-1]))


def points_elsewhere(repo: RepoId, config: dict[str, object]) -> Problem | None:
    """Why the lookup will not size a repo whose ``config.json`` names a model outside it, or None.

    Only that the name is there, never that a server reads it: no loader reads a weight path out of
    config.json today, the repo's own code can, and the lookup reads no code.
    """
    named = {
        path[-1]: value.strip()
        for path, value in config_strings(config)
        if path and names_another_repo(repo, path, value)
    }
    if not named:
        return None
    where = ", ".join(f"{value} in {key}" for key, value in sorted(named.items()))
    return _problem(
        f"The config.json of {repo} names a model outside the repo",
        f"It names {where}, and the lookup cannot tell whether a server loads weights from there",
        f"{MANUAL_FIX}: the total of every weight file a server loads, which is this repo's own files plus "
        f"those of {_listed(sorted(set(named.values())))}",
    )


async def weights_of(
    client: httpx.AsyncClient,
    repo: RepoId,
    sizes: dict[str, int],
    config: dict[str, object] | Problem,
    gated: Problem,
) -> _Weights | Problem:
    """The size of the weights a server loads from this repo, or why the lookup will not give one.

    A size needs no sign that the model reaches outside the repo's own weight files: the repo's
    ``config.json`` was read and names no model outside the repo, the repo is not an adapter, every weight
    file in another format is a copy or training state, and the file rules place every ``.safetensors``
    file in the repo. Without all of that the lookup gives no size, because every way a server loads
    weights from outside the files it sized ends in a number below what the server loads.
    """
    if ADAPTER_FILE in sizes:
        return _problem(
            f"{repo} is an adapter, not a whole model",
            f"It holds {ADAPTER_FILE}, which marks these weights as a layer trained on top of another "
            "model, and a server loads that model as well",
            f"{MANUAL_FIX}: the total of this repo's weight files and the base model's",
        )
    if isinstance(config, Problem):
        return config
    elsewhere = points_elsewhere(repo, config) or other_format_weights(repo, sizes)
    if elsewhere is not None:
        return elsewhere
    if INDEX_FILE not in sizes:
        weights, upper_bound = unindexed_weights(repo, sizes), False
    # The file list gives the index's size, so an index over the cap is never asked for.
    elif sizes[INDEX_FILE] > MAX_RESPONSE_BYTES:
        weights, upper_bound = unread_index_weights(repo, sizes), True
    else:
        index = await _get_hf_json(
            client,
            f"/{repo}/resolve/main/{INDEX_FILE}",
            {401: gated, 403: gated},
            f"The weight index of {repo}",
        )
        weights = index if isinstance(index, Problem) else indexed_weights(repo, sizes, index.value)
        upper_bound = False
    return weights if isinstance(weights, Problem) else _Weights(weights, upper_bound)


async def fetch_facts(client: httpx.AsyncClient, repo: RepoId) -> ModelFacts | LookupFailure:
    """Read the size of a public repo's weights and its shape. Each is read even when the other is not."""
    # Hugging Face answers 401 for a repo that does not exist and for a private one alike.
    absent = _problem(
        f"Hugging Face has no public model {repo}",
        "The repo does not exist or is private",
        f"Check the repo id, {OR_MANUAL_FIX}",
    )
    # expand[]=siblings keeps the answer to the file list. Without it the model card comes too, which is
    # a third of the response cap for some repos.
    info = await _get_hf_json(
        client,
        f"/api/models/{repo}?expand[]=siblings&blobs=true",
        {401: absent, 403: absent, 404: absent},
        f"The file list of {repo}",
    )
    if isinstance(info, Problem):
        return LookupFailure(problem=info)
    sizes = file_sizes(repo, info.value)
    if isinstance(sizes, Problem):
        return LookupFailure(problem=sizes)
    gated = _problem(
        f"{repo} is gated on Hugging Face",
        "Its files are only served to accounts that accepted the model's terms",
    )
    no_config = _problem(f"{repo} has no config.json", "The estimator reads the model's shape from it")
    config = read_config(
        repo,
        await _get_hf_json(
            client,
            f"/{repo}/resolve/main/config.json",
            {401: gated, 403: gated, 404: no_config},
            f"The config.json of {repo}",
        ),
    )
    shape = config if isinstance(config, Problem) else parse_shape(repo, config)
    weights = await weights_of(client, repo, sizes, config, gated)
    found = found_by(weights, shape)
    if found.weights_bytes is not None and found.shape is not None:
        return ModelFacts(
            repo=repo,
            weights_bytes=found.weights_bytes,
            weights_upper_bound=found.weights_upper_bound,
            **found.shape.model_dump(),
        )
    problems = [part for part in (weights, shape) if isinstance(part, Problem)]
    return LookupFailure(problem=problems[0], found=found)
