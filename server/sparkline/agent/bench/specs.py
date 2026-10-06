"""Benchmark registry: parameter models (validation), duration estimates and the BenchSpec catalog.

Every benchmark has a pydantic params model with bounded ints/floats, enums and pattern-checked strings;
unknown keys are rejected. ``BenchParam`` descriptors for the UI are derived from the same models, so the
catalog can never drift from what the agent accepts.
"""

from __future__ import annotations

import ipaddress
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal, get_args, get_origin
from urllib.parse import urlsplit

import annotated_types
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, field_validator

from ...common.netutil import is_private
from ...common.schema import BenchImpact, BenchParam, BenchSpec


def _param(default: Any, label: str, help: str, unit: str | None = None, **bounds: Any) -> Any:
    return Field(default, title=label, description=help, json_schema_extra={"unit": unit}, **bounds)


def _unique(v: list) -> list:
    if not v:
        raise ValueError("choose at least one")
    if len(set(v)) != len(v):
        raise ValueError("duplicate choices")
    return v


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------------------------------------
# Parameter models
# --------------------------------------------------------------------------------------------------------

Dtype = Literal["bf16", "fp16", "fp8", "fp4"]
Size = Literal["4096", "8192", "16384"]


class GpuMatmulParams(Params):
    dtypes: Annotated[list[Dtype], AfterValidator(_unique)] = _param(
        ["bf16", "fp16", "fp8", "fp4"],
        "Precisions",
        "FP8 uses torch._scaled_mm (e4m3). FP4 is reported as unsupported if this PyTorch/GPU cannot run it.",
    )
    sizes: Annotated[list[Size], AfterValidator(_unique)] = _param(
        ["4096", "8192", "16384"],
        "Matrix sizes",
        "Square M = N = K. The best size is reported per precision.",
    )
    iterations: int = _param(50, "Iterations", "Timed GEMMs per size and precision.", ge=10, le=1000)
    warmup: int = _param(10, "Warm-up", "Untimed GEMMs before timing.", ge=1, le=100)
    fp8_scaling: Literal["tensor", "row"] = _param(
        "tensor", "FP8 scaling", "Per-tensor or per-row scale factors for the FP8 GEMM."
    )


class MemBandwidthParams(Params):
    side: Literal["both", "gpu", "cpu"] = _param("both", "Measure from", "GPU kernels, CPU threads, or both.")
    gpu_array_mib: int = _param(
        1024, "GPU array size", "Each of the 3 arrays used by the GPU copy/triad.", "MiB", ge=256, le=8192
    )
    cpu_array_mib: int = _param(
        1024,
        "CPU array size",
        "Each of the 3 arrays, split across the pinned threads.",
        "MiB",
        ge=256,
        le=16384,
    )
    iterations: int = _param(
        20, "Iterations", "Repetitions; the best one is reported (STREAM style).", ge=5, le=200
    )


class CpuThroughputParams(Params):
    seconds_per_test: float = _param(
        5.0, "Seconds per test", "Each of the 5 core sets runs this long.", "s", ge=0.5, le=60
    )


class NcclAllreduceParams(Params):
    max_size_mib: Literal["16", "64", "256", "1024"] = _param(
        "1024", "Largest message", "Sizes double from 8 B up to this.", "MiB"
    )
    iterations: int = _param(20, "Iterations", "Timed all-reduces per size.", ge=5, le=200)
    warmup: int = _param(5, "Warm-up", "Untimed all-reduces per size.", ge=1, le=50)
    rails: Literal["both", "A", "B"] = _param("both", "ConnectX-7 rails", "Which RDMA rails NCCL may use.")


class RdmaParams(Params):
    rail: Literal["A", "B"] = _param("A", "Rail", "ConnectX-7 rail to test.")
    tests: Annotated[list[Literal["bw", "lat"]], AfterValidator(_unique)] = _param(
        ["bw", "lat"], "Tests", "ib_write_bw (bandwidth) and ib_write_lat (latency)."
    )
    duration_s: int = _param(5, "Bandwidth duration", "How long ib_write_bw runs.", "s", ge=2, le=60)
    msg_size: Literal["4096", "65536", "1048576"] = _param(
        "65536", "Bandwidth message size", "Bytes per RDMA write in the bandwidth test.", "B"
    )
    lat_iterations: int = _param(
        5000, "Latency iterations", "Ping-pong exchanges in ib_write_lat.", ge=100, le=100000
    )


class StorageParams(Params):
    size_mib: int = _param(
        4096, "Test file size", "Written once (timed sequential write), then read.", "MiB", ge=64, le=65536
    )
    runtime_s: float = _param(
        10.0, "Seconds per profile", "Runtime of each read/random profile.", "s", ge=0.5, le=120
    )
    threads: int = _param(4, "Threads", "Concurrent I/O threads for the 4 KiB random profiles.", ge=1, le=32)
    profiles: Annotated[
        list[Literal["seq_write", "seq_read", "rand_read", "rand_write"]], AfterValidator(_unique)
    ] = _param(
        ["seq_write", "seq_read", "rand_read", "rand_write"],
        "Profiles",
        "Sequential 1 MiB and random 4 KiB, read and write.",
    )


_MODEL_RE = re.compile(r"^[\w.\-/:]{1,200}$")


_CGNAT = ipaddress.ip_network("100.64.0.0/10")  # Tailscale & co. (100.100.100.100 is its local service)


def check_base_url(url: str) -> str:
    """http(s) URL whose host is a private/loopback IP literal (or localhost). Returns it without /v1."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as e:
        raise ValueError(f"not a valid URL: {e}") from None
    if parts.scheme not in ("http", "https"):
        raise ValueError("must start with http:// or https://")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("must not contain credentials, a query or a fragment")
    host = parts.hostname or ""
    if host == "localhost":
        host = "127.0.0.1"
    try:
        ipaddress.ip_address(host)
    except ValueError:
        raise ValueError("host must be an IP address on this network (or localhost)") from None
    addr = ipaddress.ip_address(host)
    if not is_private(host) or addr.is_link_local or addr in _CGNAT:  # LAN (RFC1918 / ULA) or loopback only
        raise ValueError(f"{host} is not a LAN or loopback address; Sparkline only tests LAN endpoints")
    if port == 0:
        raise ValueError("port must not be 0")
    path = parts.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    if not re.fullmatch(r"[\w.\-/]*", path):
        raise ValueError("path contains unsupported characters")
    return f"{parts.scheme}://{parts.netloc}{path}"


class LlmInferenceParams(Params):
    base_url: str = _param(
        "http://127.0.0.1:8000",
        "Endpoint",
        "OpenAI-compatible server (vLLM, TRT-LLM, llama.cpp, SGLang...) on a private or loopback address.",
    )
    model: str = _param("", "Model", "Model name as served; empty picks the first from /v1/models.")
    api: Literal["chat", "completions"] = _param("chat", "API", "/v1/chat/completions or /v1/completions.")
    prompt_tokens: int = _param(512, "Prompt length", "Approximate prompt size.", "tokens", ge=16, le=32768)
    max_tokens: int = _param(128, "Output length", "max_tokens per request.", "tokens", ge=1, le=4096)
    concurrency: int = _param(1, "Concurrency", "Requests in flight at once.", ge=1, le=32)
    requests: int = _param(8, "Requests", "Total requests.", ge=1, le=512)

    @field_validator("base_url")
    @classmethod
    def _url(cls, v: str) -> str:
        return check_base_url(v)

    @field_validator("model")
    @classmethod
    def _model(cls, v: str) -> str:
        if v and not _MODEL_RE.match(v):
            raise ValueError("model name may only contain letters, digits and . - / : _ (max 200)")
        return v


class ThermalSoakParams(Params):
    minutes: int = _param(
        10, "Duration", "Sustained BF16 GEMM load. 10-30 min is typical.", "min", ge=1, le=60
    )
    size: Literal["4096", "8192"] = _param("8192", "Matrix size", "Square GEMM size used for the load.")


# --------------------------------------------------------------------------------------------------------
# Duration estimates (seconds). Rates are rough GB10 figures used only to size progress bars and timeouts.
# --------------------------------------------------------------------------------------------------------

CONTAINER_START_S = 20.0
_GEMM_RATE = {"bf16": 100e12, "fp16": 100e12, "fp8": 200e12, "fp4": 400e12}


def est_gpu_matmul(p: GpuMatmulParams) -> float:
    t = CONTAINER_START_S
    for d in p.dtypes:
        for s in p.sizes:
            n = int(s)
            t += 1.0 + (p.warmup + p.iterations) * 2 * n**3 / _GEMM_RATE[d]
    return t


def est_mem_bandwidth(p: MemBandwidthParams) -> float:
    t = CONTAINER_START_S
    if p.side in ("both", "gpu"):
        t += 3 + p.iterations * 5 * p.gpu_array_mib * 2**20 / 150e9
    if p.side in ("both", "cpu"):
        t += 3 * (2 + p.iterations * 5 * p.cpu_array_mib * 2**20 / 40e9)
    return t


def est_cpu_throughput(p: CpuThroughputParams) -> float:
    return 1.0 + 5 * (p.seconds_per_test + 0.2)


def nccl_sizes(max_size_mib: str) -> list[int]:
    out, s = [], 8
    while s <= int(max_size_mib) * 2**20:
        out.append(s)
        s *= 2
    return out


def est_nccl(p: NcclAllreduceParams) -> float:
    per = sum(50e-6 + 2 * s / 20e9 for s in nccl_sizes(p.max_size_mib))
    return CONTAINER_START_S + 5 + (p.warmup + p.iterations) * per


def est_rdma(p: RdmaParams) -> float:
    t = 3.0
    if "bw" in p.tests:
        t += p.duration_s + 2
    if "lat" in p.tests:
        t += 2 + p.lat_iterations * 5e-6
    return t


def est_storage(p: StorageParams) -> float:
    reads = sum(1 for x in p.profiles if x != "seq_write")
    return 1.0 + p.size_mib * 2**20 / 1.5e9 + reads * p.runtime_s


def est_llm(p: LlmInferenceParams) -> float:
    waves = math.ceil(p.requests / p.concurrency)
    return 5.0 + waves * (0.5 + p.prompt_tokens / 2000 + p.max_tokens / 20)


def est_soak(p: ThermalSoakParams) -> float:
    return CONTAINER_START_S + p.minutes * 60


# --------------------------------------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Bench:
    id: str
    name: str
    category: str
    description: str
    impact: BenchImpact
    params: type[Params]
    estimate: Callable[[Any], float]
    requires: tuple[str, ...] = ()
    min_nodes: int = 1
    max_nodes: int | None = 1
    roles: tuple[str, ...] = ("single",)

    def validate(self, raw: dict[str, Any]) -> Params:
        return self.params.model_validate(raw)

    def timeout_s(self, p: Params) -> float:
        return self.estimate(p) * 3 + 120

    def spec(self, availability: dict, note: str = "") -> BenchSpec:
        return BenchSpec(
            id=self.id,
            name=self.name,
            category=self.category,  # type: ignore[arg-type]
            description=self.description + (f" {note}" if note else ""),
            est_duration_s=round(self.estimate(self.params()), 1),
            impact=self.impact,
            params=bench_params(self.params),
            min_nodes=self.min_nodes,
            max_nodes=self.max_nodes,
            requires=list(self.requires),
            availability=availability,
        )


def bench_params(model: type[Params]) -> list[BenchParam]:
    out = []
    for name, f in model.model_fields.items():
        ann = f.annotation
        choices = None
        if get_origin(ann) is Literal:
            kind, choices = "enum", [str(a) for a in get_args(ann)]
        elif get_origin(ann) is list:
            kind, choices = "multi", [str(a) for a in get_args(get_args(ann)[0])]
        else:
            kind = {int: "int", float: "float", bool: "bool", str: "string"}[ann]  # type: ignore[index]
        lo = next((m.ge for m in f.metadata if isinstance(m, annotated_types.Ge)), None)
        hi = next((m.le for m in f.metadata if isinstance(m, annotated_types.Le)), None)
        extra = f.json_schema_extra if isinstance(f.json_schema_extra, dict) else {}
        out.append(
            BenchParam(
                name=name,
                label=f.title or name,
                type=kind,  # type: ignore[arg-type]
                default=f.default,
                min=lo,
                max=hi,
                choices=choices,
                unit=extra.get("unit"),  # type: ignore[arg-type]
                help=f.description,
            )
        )
    return out


def _impact(thermal: str, power: str, disruptive: bool, note: str) -> BenchImpact:
    return BenchImpact(thermal=thermal, power=power, disruptive=disruptive, note=note)  # type: ignore[arg-type]


GPU_TOOLS = ("docker", "pytorch_image")

REGISTRY: dict[str, Bench] = {
    b.id: b
    for b in [
        Bench(
            "gpu-matmul",
            "GPU matmul throughput",
            "compute",
            "How fast the GPU multiplies large matrices at each precision, in TFLOPS. "
            "Dense square GEMMs timed with CUDA events in the PyTorch container: torch.matmul for BF16 and "
            "FP16, torch._scaled_mm for FP8 (e4m3) and FP4 (e2m1) where this GPU and PyTorch support it. "
            "Reports the best achieved TFLOPS per precision; an unsupported precision is reported as such, "
            "never as a number.",
            _impact("high", "high", True, "Saturates the GPU; will slow any running inference."),
            GpuMatmulParams,
            est_gpu_matmul,
            GPU_TOOLS,
        ),
        Bench(
            "mem-bandwidth",
            "Unified memory bandwidth",
            "memory",
            "How fast the CPU and the GPU read and write the memory they share. "
            "STREAM-style copy and triad over the shared LPDDR5X, from the GPU (CUDA kernels on device "
            "tensors) and from the CPU (one pinned thread per core: all cores, performance cores only, "
            "efficiency cores only). Best-of-N GB/s, counting bytes read plus written.",
            _impact(
                "medium",
                "medium",
                True,
                "Saturates memory bandwidth shared by CPU and GPU; running inference slows while it runs.",
            ),
            MemBandwidthParams,
            est_mem_bandwidth,
            GPU_TOOLS,
        ),
        Bench(
            "cpu-throughput",
            "CPU throughput by core type",
            "cpu",
            "How much work one core and all cores of each kind (performance, efficiency) get done. "
            "SHA-256 plus zlib over a fixed buffer, one process pinned per core. "
            "Single-core results for one performance and one efficiency core, then all performance cores, "
            "all efficiency cores and all cores together, in MB/s processed.",
            _impact("medium", "low", False, "Loads the CPU cores briefly; GPU work is barely affected."),
            CpuThroughputParams,
            est_cpu_throughput,
        ),
        Bench(
            "nccl-allreduce",
            "NCCL all-reduce across nodes",
            "interconnect",
            "How fast the two nodes combine GPU data over the ConnectX-7 link, as multi-node inference does. "
            "All-reduce sweep from 8 B doubling to the largest size, one rank per node over the ConnectX-7 "
            "RDMA rails. Reports algorithm and bus bandwidth like nccl-tests (equal for two nodes).",
            _impact(
                "medium",
                "medium",
                True,
                "Saturates the ConnectX-7 link and uses the GPU on both nodes; a TP=2 job across the "
                "nodes will stall while it runs.",
            ),
            NcclAllreduceParams,
            est_nccl,
            GPU_TOOLS,
            2,
            2,
            ("rank",),
        ),
        Bench(
            "rdma-bw-lat",
            "RDMA bandwidth and latency",
            "interconnect",
            "Raw bandwidth and latency of one ConnectX-7 rail between the two nodes. "
            "perftest ib_write_bw and ib_write_lat between the two nodes over one ConnectX-7 rail (RoCE v2). "
            "Bandwidth in Gb/s; latency typical and 99th percentile in microseconds.",
            _impact(
                "low",
                "low",
                True,
                "Saturates the chosen ConnectX-7 rail; cross-node inference traffic on it slows down.",
            ),
            RdmaParams,
            est_rdma,
            ("perftest",),
            2,
            2,
            ("server", "client"),
        ),
        Bench(
            "storage-fio",
            "NVMe storage profiles",
            "storage",
            "Sequential and random read and write speed of the NVMe drive. "
            "Sequential 1 MiB and random 4 KiB read/write with O_DIRECT against a test file in the agent's "
            "bench directory (removed afterwards, also on cancel). Uses fio when installed, otherwise a "
            "built-in runner; the method is recorded with the results, and results of different methods "
            "are never compared. MB/s, IOPS and p99 latency.",
            _impact("low", "low", False, "Heavy disk I/O; model loading or checkpointing will be slower."),
            StorageParams,
            est_storage,
        ),
        Bench(
            "llm-inference",
            "LLM inference",
            "inference",
            "Time to first token and prefill and decode speed of a model you are already serving. "
            "Streams requests to an OpenAI-compatible endpoint you are already serving (vLLM, TRT-LLM, "
            "llama.cpp, SGLang...) and measures time to first token, prefill and decode tokens/s, and the "
            "memory footprint seen by the agent. The endpoint may itself span both nodes (TP=2); the run "
            "measures it from this node.",
            _impact(
                "medium",
                "medium",
                True,
                "Sends real requests to the chosen server; other users of that server will see slower "
                "responses.",
            ),
            LlmInferenceParams,
            est_llm,
        ),
        Bench(
            "thermal-soak",
            "Thermal soak",
            "soak",
            "Whether the GPU keeps its clocks and throughput under sustained full load. "
            "Sustained BF16 GEMM load in the PyTorch container while the agent records SM clock, "
            "temperature, power, utilisation and throttle reasons every second. Reports clock stability, "
            "time throttled (thermal or hardware) and at the power cap, peak temperature and TFLOPS in the "
            "first versus the last minute.",
            _impact(
                "high",
                "high",
                True,
                "Holds the GPU at full load for the whole run; any running inference slows down.",
            ),
            ThermalSoakParams,
            est_soak,
            GPU_TOOLS,
        ),
    ]
}


def validation_message(e: ValidationError) -> str:
    parts = []
    for err in e.errors():
        loc = ".".join(str(x) for x in err["loc"]) or "params"
        msg = "unknown parameter" if err["type"] == "extra_forbidden" else err["msg"]
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts)
