"""Will it fit: estimate a model's memory at a context length and compare it with each node's free memory.

The estimate and the budgets are pure functions. Every outbound request goes through ``_get_hf_json``, which
``fetch_facts`` and ``weights_of`` call and nothing else in the module does: a GET to ``HF_ORIGIN``, no body,
no credentials, at most ``MAX_RESPONSE_BYTES`` read. The wire types are mirrored in web/src/lib/types.ts.

A lookup reads two files of a repo, its file list and its ``config.json``, and sometimes a third, its weight
index. It fills in a size only when nothing it read is a sign that the model reaches outside the repo's own
weight files, and names the sign it found when it will not. The signs are: a string in ``config.json`` that
names another repo, a key in it that measures a model the repo does not hold, an ``adapter_config.json``, a
``.safetensors`` file the sizing leaves out, a weight file in another format whose name does not mark it as
a copy or as training state, and a ``config.json`` it could not read at all. The model's shape is worked
out from the top-level keys of that same ``config.json``, and a size is never filled in without it. A
config that gives its layers one by one and not all alike has no such shape. A refusal fills in the shape
alone, and not even that after a sign of a second model (the first three above): the shape in the config
may then be an adapter's, a draft's or one part's, not that of the model a server answers with.

A refusal is what the lookup read (``Reason``), then one of two fixed instructions (``Ask``). It never says
what a server loads, what kind of model the repo is, or where a number can be read: advice that is true
of one repo is untrue of the next.

None of that proves the repo holds the whole model, and nothing here claims it does. A repo's own code can
load a second model that no file the lookup reads names, a draft model whose config measures nothing is
still served beside a target, and ``subfolder=``, ``variant=`` and a LoRA flag are the caller's. So what the
page fills in is the size of this repo's safetensors files, and the form and the result say that beside
the number. A copy of the weights in another format is not in it.

The KV cache counts every layer as an attention layer of one width. That is too high, sometimes several
times, for a model that windows its attention, shares a latent cache (25 times for DeepSeek-V3), mixes in
layers that keep no keys (Mamba, convolution, linear attention), or keeps its KV head count under a key the
lookup does not read. Nothing here lowers the estimate for such a model. The page says it is high.

Not modelled: GGUF repos, splitting a model across GPUs, the AMD GTT limit and the macOS wired-memory limit.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterator
from enum import Enum
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

RepoId = NewType("RepoId", str)
_REPO_PART = r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}"
REPO_ID_PATTERN = rf"^{_REPO_PART}/{_REPO_PART}$"
# The pattern in words, for the answer to text that is not of that form. It says what the lookup takes, not
# what a repo id is: Hugging Face also answers to ids with no owner.
REPO_ID_FORM = (
    "Each of the two parts starts with a letter or a digit and holds at most 96 characters: letters, "
    "digits, dots, dashes and underscores, with no two dots in a row"
)


class ModelShape(BaseModel):
    """What sizes the KV cache: every layer counted as an attention layer of one width.

    A lookup reads it from the top-level keys of ``config.json``. It is an upper estimate for a model
    whose layers are not all attention layers of that width.
    """

    # Strict, so that JSON true is not read as 1 byte or 1 layer.
    model_config = ConfigDict(strict=True)

    num_layers: int = Field(gt=0)
    num_kv_heads: int = Field(gt=0)
    head_dim: int = Field(gt=0)
    max_context: int | None = Field(default=None, gt=0)
    # Set by a lookup whose config holds no head_dim: head_dim is then hidden_size // num_attention_heads,
    # a number no file of the repo holds, and the page says so beside it.
    head_dim_worked_out: bool = False


class ModelFacts(ModelShape):
    repo: str | None = None  # set when the facts came from a lookup
    # The size of the weight files a server loads. A parameter count cannot give it: a quantised repo keeps
    # some layers at 16 bits, and Hugging Face counts packed 4-bit weights as the weights they unpack to.
    weights_bytes: int = Field(gt=0)
    # Set when a lookup could not read which files a server loads, and weights_bytes is the total of every
    # weight file in the repo: a server loads that much or less.
    weights_upper_bound: bool = False


class LookupFailure(BaseModel):
    """The body of a refused lookup: why, and the model's shape when the lookup still answers for it.

    It has no field for a size. A size comes only in a full answer, beside the shape it belongs to. The
    shape is set only when the refusal is about this repo's own files. ``fetch_facts`` returns for a sign
    of a second model before it reads a shape, so that refusal has none to send: the shape in the config
    may be an adapter's, a draft's or one part's, and the page would put it under the served model's name.
    """

    problem: Problem
    shape: ModelShape | None = None


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


# What a refusal asks for as the size. The second sentence is there because the first, read to the letter,
# counts a repo's copies of its weights: 38.4 GiB for one popular repo whose weights are 12.8 GiB.
_SIZE_ASKED = (
    "the total of every weight file the server loads, in every folder of this repo and in any other repo. "
    "Where a repo holds the same weights more than once, count them once"
)


class Ask(Enum):
    """The two instructions a refusal ends with, in the same words for every repo.

    No refusal writes its own. ``_failure`` picks one by what the refusal fills in, so an instruction
    cannot name a repo to add, a part of the config to read or a page to copy a number from.
    """

    SIZE = f"Enter the size by hand: {_SIZE_ASKED}"
    SIZE_AND_SHAPE = (
        f"Enter the size and the shape by hand. The size is {_SIZE_ASKED}. The shape is that of the "
        "language model that answers, not of a vision, audio or other part"
    )


class Refusal(NamedTuple):
    """Why a lookup gives no size, as what it read. It has no field for what to do next."""

    message: str
    cause: str


class Reason(Enum):
    """Every reason a lookup refuses, as the message and the cause its refusal is built from.

    Each says what the lookup read: the file, the config string or the answer it saw, and "the lookup
    cannot tell" where that leaves a question open. None says what a server loads, what kind of model the
    repo is, or where a number can be read. ``test_console_fit.py`` walks this table and fails on a
    phrase that does.
    """

    OFF_HOST = (
        "Hugging Face redirected the lookup to another host",
        "The console only reads from {origin} and does not follow {host}",
    )
    USER_NAME = (
        "Hugging Face redirected the lookup to a URL carrying a user name",
        "The console reads {origin} without signing in, and following that redirect would make it send "
        "credentials",
    )
    RATE_LIMITED = ("Hugging Face has rate limited the console host", "HTTP 429 from {url}")
    HTTP_STATUS = ("Hugging Face answered the lookup with HTTP {status}", "From {url}")
    TOO_LARGE = (
        "{what} is larger than the lookup reads",
        "The lookup reads at most {cap} of an answer, and {url} sent more",
    )
    UNREACHABLE = ("Could not reach huggingface.co from the console host", "{error}")
    TIMED_OUT = ("Hugging Face did not answer the lookup in time", "{error} from {url}")
    NOT_JSON = ("Hugging Face sent an answer that is not JSON", "From {url}")
    REDIRECT_LOOP = ("Hugging Face kept redirecting the lookup", "More than {redirects} redirects")
    ABSENT = (
        "Hugging Face has no public model {repo}",
        "The lookup cannot tell whether nothing has that id, or whether a private model, a dataset or a "
        "space has it",
    )
    GATED = (
        "{repo} is gated on Hugging Face",
        "Its files are only served to accounts that accepted the model's terms",
    )
    NO_CONFIG = (
        "{repo} has no config.json at its top level",
        "The estimator reads the model's shape from that file",
    )
    FILE_LIST = (
        "Hugging Face does not list the files of {repo} in a way this estimator reads",
        "Its answer is not a list of file names with sizes",
    )
    LISTED_TWICE = (
        "Hugging Face lists a file of {repo} twice",
        "{files} appears more than once with a size, so the lookup cannot tell how large it is",
    )
    CONFIG_NOT_OBJECT = ("The config.json of {repo} is not a JSON object", "It is {type}")
    ADAPTER = (
        "{repo} has an {file}",
        "The lookup does not read that file, and cannot tell whether the repo's files hold the base model",
    )
    POINTER = (
        "The config.json of {repo} holds a string with the form of a repo id",
        "It holds {where}. The lookup cannot tell whether a string of the form owner/name names a repo, or "
        "whether a server loads weights from one",
    )
    DRAFT_KEYS = (
        "The config.json of {repo} has a key that a draft model's config has",
        "It has {keys}. The lookup cannot tell whether the repo holds a draft model",
    )
    OTHER_FORMAT = (
        "{repo} holds a file that may hold weights, in a format the lookup does not read",
        "It holds {files}, and the lookup cannot tell whether a server loads {them}",
    )
    NO_WEIGHTS_FILE = (
        "{repo} has no {weights} and no {index} at its top level",
        "It holds other .safetensors files ({files}), and with no {index} there the lookup cannot tell "
        "which of them, if any, a server loads",
    )
    NO_SAFETENSORS = (
        "{repo} has no {weights} and no {index} at its top level",
        "It holds no .safetensors files. GGUF, PyTorch .bin and other formats are not read",
    )
    BESIDE_WEIGHTS_FILE = (
        "{repo} holds other safetensors files beside its {weights}, and no {index} at its top level",
        "The lookup cannot tell whether a server loads only {weights} or {files} as well",
    )
    INDEX_UNREADABLE = (
        "The weight index of {repo} is not one this estimator reads",
        "{index} has no weight_map from tensor names to file names",
    )
    INDEX_NAMES_MISSING = (
        "The weight index of {repo} names files the repo does not hold",
        "{index} names {files}, which the repo's file list does not hold",
    )
    INDEX_LEAVES_OUT = (
        "The weight index of {repo} does not name every safetensors file in the repo",
        "It names {named} of them, and the lookup cannot tell whether a server also loads {files}",
    )
    INDEX_TOO_LARGE = (
        "The weight index of {repo} is too large for the lookup to read",
        "{index} is {size} and the lookup reads at most {cap} of an answer, so it cannot tell which of the "
        "repo's files the index names",
    )
    EMPTY_WEIGHTS = ("The weight files of {repo} are empty", "Hugging Face lists them at 0 bytes")
    NO_SHAPE = (
        "The config.json of {repo} holds no shape at its top level",
        "The lookup reads the top level only, and found no whole number above 0 there for {keys}",
    )
    NULL_KV_HEADS = (
        "The config.json of {repo} holds null under num_key_value_heads and names its own config class",
        "It holds {config_class} under AutoConfig in auto_map. The lookup reads no code, and cannot tell "
        "how many KV heads a layer has",
    )
    LAYERS_DIFFER = (
        "The config.json of {repo} holds {key}, {held}",
        "The lookup sizes every layer alike and cannot tell whether an entry changes a layer's KV cache, so "
        "it does not size this model",
    )

    def of(self, **read: object) -> Refusal:
        message, cause = self.value
        return Refusal(message.format(**read), cause.format(**read))


def _failure(refusal: Refusal, shape: ModelShape | None = None) -> LookupFailure:
    """A refusal as the page gets it: what the lookup read, then the instruction for what it fills in."""
    ask = Ask.SIZE if shape else Ask.SIZE_AND_SHAPE
    problem = Problem(message=refusal.message, cause=refusal.cause, fix=ask.value)
    return LookupFailure(problem=problem, shape=shape)


_CAP = f"{MAX_RESPONSE_BYTES / 2**20:.1f} MiB"


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


def other_format_weights(repo: RepoId, sizes: dict[str, int]) -> Refusal | None:
    """Why the lookup will not size a repo holding a weight file it never reads, or None."""
    others = sorted(
        name for name in sizes if name.lower().endswith(OTHER_FORMATS) and not is_copy_or_training_state(name)
    )
    if not others:
        return None
    them = "that file" if len(others) == 1 else "those files"
    return Reason.OTHER_FORMAT.of(repo=repo, files=_listed(others), them=them)


def file_sizes(repo: RepoId, info: object) -> dict[str, int] | Refusal:
    """Every file in the repo and its size, from the repo's ``/api/models`` answer as decoded JSON."""
    try:
        files = _RepoFiles.model_validate(info, strict=True).siblings
    except ValidationError:
        return Reason.FILE_LIST.of(repo=repo)
    sizes = {f.rfilename: f.size for f in files}
    if len(sizes) != len(files):
        seen = Counter(f.rfilename for f in files)
        twice = sorted(name for name, n in seen.items() if n > 1)
        return Reason.LISTED_TWICE.of(repo=repo, files=_listed(twice))
    return sizes


def _safetensors(sizes: dict[str, int]) -> list[str]:
    return [name for name in sizes if name.endswith(".safetensors")]


def _total(repo: RepoId, sizes: dict[str, int], names: set[str]) -> int | Refusal:
    return sum(sizes[n] for n in names) or Reason.EMPTY_WEIGHTS.of(repo=repo)


def _listed(names: list[str]) -> str:
    return f"{', '.join(names[:3])}{f' and {len(names) - 3} more' if len(names) > 3 else ''}"


def _left_out(sizes: dict[str, int], named: set[str]) -> list[str]:
    """The repo's safetensors files, at any depth, that ``named`` leaves out."""
    return sorted(set(_safetensors(sizes)) - named)


def unindexed_weights(repo: RepoId, sizes: dict[str, int]) -> int | Refusal:
    """The size of the weights a server loads from a repo with no index: its ``model.safetensors``.

    Only when that is the one safetensors file in the repo. Any other is a second candidate for the
    weights: with no index some servers load every top-level file, and a model class can load a subfolder
    of the repo it serves (vLLM's kimi_audio reads ``whisper-large-v3/``).
    """
    others = _left_out(sizes, {WEIGHTS_FILE})
    if WEIGHTS_FILE not in sizes:
        reason = Reason.NO_WEIGHTS_FILE if others else Reason.NO_SAFETENSORS
        return reason.of(repo=repo, weights=WEIGHTS_FILE, index=INDEX_FILE, files=_listed(others))
    if others:
        return Reason.BESIDE_WEIGHTS_FILE.of(
            repo=repo, weights=WEIGHTS_FILE, index=INDEX_FILE, files=_listed(others)
        )
    return _total(repo, sizes, {WEIGHTS_FILE})


def indexed_weights(repo: RepoId, sizes: dict[str, int], index: object) -> int | Refusal:
    """The size of the files the repo's index names, from ``model.safetensors.index.json`` as decoded JSON.

    The index maps every tensor of the model it describes to the file that holds it, so its files are ones
    a server loads. File names do not say this: an index can name several shard families and files under any
    name. It does not say that nothing else is loaded, so a safetensors file it leaves out is refused.
    """
    try:
        names = set(_WeightIndex.model_validate(index, strict=True).weight_map.values())
    except ValidationError:
        return Reason.INDEX_UNREADABLE.of(repo=repo, index=INDEX_FILE)
    missing = sorted(names - sizes.keys())
    if missing:
        return Reason.INDEX_NAMES_MISSING.of(repo=repo, index=INDEX_FILE, files=_listed(missing))
    others = _left_out(sizes, names)
    if others:
        return Reason.INDEX_LEAVES_OUT.of(repo=repo, named=len(names), files=_listed(others))
    return _total(repo, sizes, names)


_SHARD = re.compile(r"(.*)-\d+-of-(\d+)\.safetensors")


def unread_index_weights(repo: RepoId, sizes: dict[str, int]) -> int | Refusal:
    """An upper bound on the weights of a repo whose index is too large to read: the total of its shards.

    Only when every ``.safetensors`` file in the repo, at any depth, is a top-level shard of one family,
    ``<stem>-N-of-M.safetensors`` with one stem and one M. A server loads that family or a part of it, so
    the total is never too low. With a second family, a single file or a file in a subfolder the total can
    be far above what a server loads, and the repo is refused.
    """
    files = _safetensors(sizes)
    families = {m.groups() if "/" not in f and (m := _SHARD.fullmatch(f)) else None for f in files}
    if len(families) != 1 or None in families:
        size = f"{sizes[INDEX_FILE] / 2**20:.1f} MiB"
        return Reason.INDEX_TOO_LARGE.of(repo=repo, index=INDEX_FILE, size=size, cap=_CAP)
    return _total(repo, sizes, set(files))


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


def _shape_in(config: dict[str, object]) -> ModelShape:
    """The shape these keys hold. Raises ``ValidationError`` when they hold none.

    A key that holds null is read as a key the config lacks, which is how the config classes of
    transformers read it: ``"num_key_value_heads": null`` is a model whose KV heads are its attention heads.
    """
    heads, hidden = config.get("num_attention_heads"), config.get("hidden_size")
    kv_heads, head_dim = config.get("num_key_value_heads"), config.get("head_dim")
    worked_out = head_dim is None
    if worked_out and (h := _whole(heads)) is not None and (w := _whole(hidden)) is not None:
        head_dim = w // h
    return ModelShape.model_validate(
        {
            "num_layers": config.get("num_hidden_layers"),
            "num_kv_heads": heads if kv_heads is None else kv_heads,
            "head_dim": head_dim,
            "max_context": config.get("max_position_embeddings"),
            "head_dim_worked_out": worked_out,
        }
    )


def _number_or_object(value: object) -> bool:
    return isinstance(value, int | float | dict) and not isinstance(value, bool)


def layers_one_by_one(config: dict[str, object], layers: int) -> tuple[str, str] | None:
    """The first top-level key that gives the layers one by one and not all alike, and what it holds.

    Two values count: a list as long as the model has layers, and an object whose every key is the number
    of a layer. The entries are numbers or objects. Names do not count: 181 of 3,867 cached configs hold a
    ``layer_types`` list whose names differ, and a name gives no width. An object with fewer entries than
    the model has layers counts whatever its entries are. A key whose name ends in ``token_id`` or
    ``token_ids`` holds vocabulary ids and is skipped: two end-of-sequence ids in a model of two layers
    are no layer's setting.
    """
    for key, value in config.items():
        if key.endswith(("token_id", "token_ids")):
            continue
        if isinstance(value, list):
            entries, held = value, "a list of"
        elif isinstance(value, dict) and all(
            re.fullmatch(r"[0-9]{1,9}", k) and int(k) < layers for k in value
        ):
            entries, held = list(value.values()), "an object keyed by layer number with"
        else:
            continue
        if not entries or not all(map(_number_or_object, entries)):
            continue
        if len(entries) == layers and any(entry != entries[0] for entry in entries):
            return key, f"{held} {layers} entries, as many as num_hidden_layers, that are not all alike"
        if isinstance(value, dict) and len(entries) < layers:
            fewer = f"fewer than the {layers} layers num_hidden_layers counts"
            return key, f"an object keyed by layer number with {len(entries)} entries, {fewer}"
    return None


def parse_shape(repo: RepoId, config: dict[str, object]) -> ModelShape | Refusal:
    """The model's shape, from the repo's ``config.json`` as decoded JSON.

    A null ``num_key_value_heads`` beside a config class the config names for itself gets no shape. Only
    the config classes of transformers are known to read that null as the attention heads. One family's
    own class groups its heads per layer, and the attention heads gave it a KV cache 13 times too large.

    Nor does a config that gives its layers one by one and not all alike: the shape is one width for every
    layer. One family holds a head size per layer, 256 in a third of its layers and 64 in the rest, and
    the top-level keys gave it 80, a KV cache below what its weights hold.
    """
    auto_map = config.get("auto_map")
    config_class = auto_map.get("AutoConfig") if isinstance(auto_map, dict) else None
    if config.get("num_key_value_heads", 0) is None and isinstance(config_class, str) and config_class:
        return Reason.NULL_KV_HEADS.of(repo=repo, config_class=config_class)
    try:
        shape = _shape_in(config)
    except ValidationError as e:
        keys = "; ".join(_SHAPE_KEYS[str(err["loc"][0])] for err in e.errors())
        # The refusal names no sub-object. 1,472 of 3,867 cached configs keep a shape in one, and the only
        # one that holds a shape can be a vision tower or a waveform decoder.
        return Reason.NO_SHAPE.of(repo=repo, keys=keys)
    unlike = layers_one_by_one(config, shape.num_layers)
    return Reason.LAYERS_DIFFER.of(repo=repo, key=unlike[0], held=unlike[1]) if unlike else shape


class _Json(NamedTuple):
    value: object


async def _get_hf_json(
    client: httpx.AsyncClient, path: str, by_status: dict[int, Refusal], what: str = "The answer"
) -> _Json | Refusal:
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
                        return Reason.OFF_HOST.of(origin=HF_ORIGIN, host=url.host)
                    # netloc leaves out the user info, so a redirect to user:pass@huggingface.co is on
                    # the right host. httpx would turn it into an Authorization: Basic header.
                    if url.userinfo:
                        return Reason.USER_NAME.of(origin=HF_ORIGIN)
                    continue
                if r.status_code == 429:
                    return Reason.RATE_LIMITED.of(url=HF_ORIGIN + path)
                if r.status_code != 200:
                    return by_status.get(r.status_code) or Reason.HTTP_STATUS.of(
                        status=r.status_code, url=HF_ORIGIN + path
                    )
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_RESPONSE_BYTES:
                        return Reason.TOO_LARGE.of(what=what, cap=_CAP, url=HF_ORIGIN + path)
                return _Json(json.loads(body))
    except httpx.TimeoutException as e:
        return Reason.TIMED_OUT.of(error=type(e).__name__, url=HF_ORIGIN + path)
    except httpx.HTTPError as e:
        return Reason.UNREACHABLE.of(error=f"{type(e).__name__}: {e}".removesuffix(": "))
    # json.loads raises RecursionError, not ValueError, for an answer nested too deep to decode.
    except (ValueError, RecursionError):
        return Reason.NOT_JSON.of(url=HF_ORIGIN + path)
    return Reason.REDIRECT_LOOP.of(redirects=MAX_REDIRECTS)


class _Weights(NamedTuple):
    bytes: int
    upper_bound: bool


# What JSON calls each value ``json.loads`` returns that is not an object.
_JSON_TYPE = {
    type(None): "null",
    bool: "a boolean",
    int: "a number",
    float: "a number",
    str: "a string",
    list: "an array",
}


def read_config(repo: RepoId, answer: _Json | Refusal) -> dict[str, object] | Refusal:
    """The repo's ``config.json`` as an object, or why the lookup has none.

    It is read twice over: for the model's shape, and because it is the only place the repo says that a
    server loads weights from somewhere else. Without it neither is known.
    """
    if isinstance(answer, Refusal):
        refusal = answer
    elif isinstance(answer.value, dict):
        return answer.value
    else:
        refusal = Reason.CONFIG_NOT_OBJECT.of(repo=repo, type=_JSON_TYPE[type(answer.value)])
    return Refusal(
        refusal.message,
        f"{refusal.cause}. Without the repo's config.json the lookup has no shape and cannot tell whether "
        "the config names another repo, so it fills in no size either",
    )


# Keys that measure a model the repo does not hold: how many layers it has, which of its layers this one
# attaches to, how wide its vocabulary is. A draft model carries them, and a draft model is served beside
# the target it drafts for, which its config need not name anywhere. Census over the 10,274 cached file
# lists: 43 of 1,417 full answers hold one, every one of them a draft
# (.audit/evidence/D/round-6/census_draft.out).
TARGET_KEYS = (
    "num_target_layers", "target_layer_ids", "draft_vocab_size", "target_hidden_size", "target_model_type",
)  # fmt: skip


def drafts_for_another_model(repo: RepoId, config: dict[str, object]) -> Refusal | None:
    """Why the lookup will not size a repo whose ``config.json`` measures a model it does not hold."""
    keys = [key for key in TARGET_KEYS if key in config]
    if not keys:
        return None
    return Reason.DRAFT_KEYS.of(repo=repo, keys=_listed(keys))


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


def points_elsewhere(repo: RepoId, config: dict[str, object]) -> Refusal | None:
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
    where = ", ".join(f"{value} under {key}" for key, value in sorted(named.items()))
    return Reason.POINTER.of(repo=repo, where=where)


def second_model(repo: RepoId, sizes: dict[str, int], config: dict[str, object] | Refusal) -> Refusal | None:
    """Why serving this repo involves a model the repo may not hold, or None when nothing read says so.

    The signs are an ``adapter_config.json``, a ``config.json`` string that names another repo, and a
    ``config.json`` key that measures another model. Any of them means the weights a server loads may
    reach past this repo, and that the shape in this repo's config may not be the served model's.
    """
    if ADAPTER_FILE in sizes:
        return Reason.ADAPTER.of(repo=repo, file=ADAPTER_FILE)
    if isinstance(config, Refusal):
        return None
    return points_elsewhere(repo, config) or drafts_for_another_model(repo, config)


async def weights_of(
    client: httpx.AsyncClient,
    repo: RepoId,
    sizes: dict[str, int],
    config: dict[str, object] | Refusal,
    gated: Refusal,
) -> _Weights | Refusal:
    """The size of the weights a server loads from this repo, or why the lookup will not give one.

    ``fetch_facts`` calls this once ``second_model`` has found no sign of one. A size then needs the rest
    of what says the model stays inside the repo's own weight files: the repo's ``config.json`` was read,
    every weight file in another format is a copy or training state, and the file rules place every
    ``.safetensors`` file in the repo. Without all of that the lookup gives no size, because every way a
    server loads weights from outside the files it sized ends in a number below what the server loads.
    """
    if isinstance(config, Refusal):
        return config
    other_format = other_format_weights(repo, sizes)
    if other_format is not None:
        return other_format
    if INDEX_FILE not in sizes:
        weights, upper_bound = unindexed_weights(repo, sizes), False
    # The file list gives the index's size, so an index over the cap is never asked for.
    elif sizes[INDEX_FILE] > MAX_RESPONSE_BYTES:
        weights, upper_bound = unread_index_weights(repo, sizes), True
    else:
        index = await _get_hf_json(
            client,
            f"/{repo}/resolve/main/{INDEX_FILE}",
            {401: gated},
            f"The weight index of {repo}",
        )
        weights = index if isinstance(index, Refusal) else indexed_weights(repo, sizes, index.value)
        upper_bound = False
    return weights if isinstance(weights, Refusal) else _Weights(weights, upper_bound)


async def fetch_facts(client: httpx.AsyncClient, repo: RepoId) -> ModelFacts | LookupFailure:
    """Read the size of a public repo's weights and its shape, or say why not and what was still read.

    Three outcomes, and this function is the one place that decides between them: the size with the
    shape, the shape alone, or nothing. A size never comes without a shape.
    """
    # Hugging Face answers 401 for an id nothing has, for a private model and for a dataset or a space alike.
    absent = Reason.ABSENT.of(repo=repo)
    # expand[]=siblings keeps the answer to the file list. Without it the model card comes too, which is
    # a third of the response cap for some repos.
    info = await _get_hf_json(
        client,
        f"/api/models/{repo}?expand[]=siblings&blobs=true",
        {401: absent, 404: absent},
        f"The file list of {repo}",
    )
    if isinstance(info, Refusal):
        return _failure(info)
    sizes = file_sizes(repo, info.value)
    if isinstance(sizes, Refusal):
        return _failure(sizes)
    gated = Reason.GATED.of(repo=repo)
    no_config = Reason.NO_CONFIG.of(repo=repo)
    config = read_config(
        repo,
        await _get_hf_json(
            client,
            f"/{repo}/resolve/main/config.json",
            {401: gated, 404: no_config},
            f"The config.json of {repo}",
        ),
    )
    second = second_model(repo, sizes, config)
    if second is not None:
        return _failure(second)
    shape = config if isinstance(config, Refusal) else parse_shape(repo, config)
    weights = await weights_of(client, repo, sizes, config, gated)
    if isinstance(shape, Refusal):
        return _failure(weights if isinstance(weights, Refusal) else shape)
    if isinstance(weights, Refusal):
        return _failure(weights, shape)
    return ModelFacts(
        repo=repo, weights_bytes=weights.bytes, weights_upper_bound=weights.upper_bound, **shape.model_dump()
    )
