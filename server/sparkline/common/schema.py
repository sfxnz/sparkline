"""Wire contract shared by sparkline-agent, sparkline and the web client (mirrored in web/src/lib/types.ts).

Conventions:
- Timestamps are Unix epoch seconds (float). Byte quantities are ints. Rates are per second.
- A metric the node does not report is ``None`` in samples AND listed in ``NodeInfo.unsupported``, with a
  kind; clients render it by kind ("not reported by this hardware", the privilege it needs, what to
  install), never as 0.
- Bump SCHEMA_VERSION on breaking changes.
"""

from __future__ import annotations

import re
from typing import Any, Literal, Self, get_args

from pydantic import BaseModel, Field, field_validator, model_validator

SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Static node description (agent: GET /api/v1/info)
# ---------------------------------------------------------------------------


UnsupportedKind = Literal["hardware", "access", "dependency", "agent"]
Platform = Literal["linux", "darwin"]
Vendor = Literal["nvidia", "amd", "apple"]
MemoryModel = Literal["unified", "dedicated", "carveout"]
CoreKind = Literal["performance", "efficiency", "unknown"]

LEGACY_VERSION_KEYS = {"driver": "nvidia.Driver", "cuda": "nvidia.CUDA", "nvml": "nvidia.NVML"}


class Unsupported(BaseModel):
    metric: str  # flattened key or prefix, e.g. "gpu0.power_limit_w", "fan"; "*" is an index: "gpu*.util"
    reason: str  # human readable, e.g. "Not reported by GB10 (NVML: Not Supported)"
    kind: UnsupportedKind = "hardware"

    @field_validator("kind", mode="before")
    @classmethod
    def _unknown_kind_reads_as_hardware(cls, v: object) -> object:
        # A newer agent may send a kind this console predates; rejecting it would drop the whole hello.
        return v if v in get_args(UnsupportedKind) else "hardware"


class CoreInfo(BaseModel):
    id: int
    kind: CoreKind
    model: str | None = None  # "Cortex-X925"
    max_mhz: float | None = None
    cluster: int | None = None


class GpuInfo(BaseModel):
    index: int
    name: str
    uuid: str | None = None
    arch: str | None = None  # "Blackwell"
    compute_capability: str | None = None  # "12.1"
    cuda_cores: int | None = None
    sm_mhz_max: float | None = None
    temp_slowdown_c: float | None = None
    temp_shutdown_c: float | None = None
    temp_max_c: float | None = None
    power_limit_w: float | None = None  # None on GB10
    vendor: Vendor | str = "nvidia"
    backend: str = "nvml"
    memory: MemoryModel = "unified"
    vram_total: int | None = None  # bytes of dedicated memory (VRAM, or a carve-out); None on unified

    @field_validator("memory", mode="before")
    @classmethod
    def _unknown_memory_reads_as_unified(cls, v: object) -> object:
        # A newer agent may send a model this console predates; rejecting it would drop the whole hello.
        return v if v in get_args(MemoryModel) else "unified"


class NetIfInfo(BaseModel):
    name: str
    role: Literal["interconnect", "lan", "virtual", "wireless", "other"]
    label: str  # "Interconnect A", "Interconnect port (no cable)", "LAN", else the interface name
    mac: str | None = None
    ipv4: list[str] = Field(default_factory=list)
    speed_mbps: int | None = None
    rdma_device: str | None = None
    # "netdev_rdma": netdev bytes + RDMA port_*_data of this PCI function (real agent on CX7);
    # "ethtool_phy" is kept for compatibility but is not emitted by the agent (PHY counters are port-wide)
    counter_source: Literal["netdev_rdma", "ethtool_phy", "netdev"] = "netdev"
    peer: str | None = None  # node_id at the far end of an interconnect link, if known
    nic_model: str | None = None  # "ConnectX-7", from PCI IDs; None if unknown or from an older agent
    rail: str | None = None  # "A", "B": interconnects up at agent start, in PCI order; None for spare ports

    @model_validator(mode="before")
    @classmethod
    def _rail_from_old_agent_label(cls, data: Any) -> Any:
        if isinstance(data, dict) and "rail" not in data and data.get("role") == "interconnect":
            m = re.search(r"rail ([A-Z])$", str(data.get("label", "")))
            if m:
                return {**data, "rail": m.group(1)}
        return data


class DiskInfo(BaseModel):
    name: str  # "nvme0n1"
    model: str | None = None
    size_bytes: int | None = None
    mounts: list[str] = Field(default_factory=list)


class SensorInfo(BaseModel):
    id: str  # "acpitz.0", "nvme.composite", "mlx5.0"
    label: str  # "ACPI zone 0", "NVMe composite", "CX7 ASIC 0"
    group: Literal["soc", "gpu", "nvme", "nic", "wireless", "other"]
    crit_c: float | None = None


class NodeInfo(BaseModel):
    schema_version: int = SCHEMA_VERSION
    node_id: str
    hostname: str
    agent_version: str
    os: str
    kernel: str
    platform: Platform | str = "linux"
    versions: dict[str, str] = Field(default_factory=dict)
    driver: str | None = None
    cuda: str | None = None
    nvml: str | None = None
    cpu_model: str
    cores: list[CoreInfo]
    mem_total: int
    swap_total: int
    gpus: list[GpuInfo]
    net: list[NetIfInfo]
    disks: list[DiskInfo]
    sensors: list[SensorInfo]
    unsupported: list[Unsupported]
    tools: dict[str, bool]  # docker, fio, perftest, nccl_tests, nvcc, pytorch_image
    sample_interval_ms: int
    boot_time: float

    @model_validator(mode="after")
    def _versions_from_an_older_agent(self) -> Self:
        if not self.versions:
            self.versions = {k: v for f, k in LEGACY_VERSION_KEYS.items() if (v := getattr(self, f))}
        return self


# ---------------------------------------------------------------------------
# Live sample (agent WS /api/v1/stream, one per tick)
# ---------------------------------------------------------------------------


class GpuSample(BaseModel):
    index: int
    util: float | None = None  # %
    sm_mhz: float | None = None
    gr_mhz: float | None = None
    video_mhz: float | None = None
    temp_c: float | None = None
    power_w: float | None = None
    energy_j: float | None = None  # cumulative counter since driver load
    pstate: int | None = None
    throttle_mask: int | None = None  # NVML clocks-event-reasons bitmask (see throttle.py)
    power_capped_pct: float | None = None  # % of last interval spent power capped
    thermal_capped_pct: float | None = None
    vram_used: int | None = None  # bytes of dedicated memory in use
    shared_used: int | None = None  # bytes of system RAM the GPU holds (GB10: its NVML per-process sum)


class MemSample(BaseModel):
    total: int
    available: int
    used: int  # total - available
    free: int
    gpu: int | None = None  # sum of the GPUs' shared_used
    anon: int  # AnonPages (minus nothing)
    cache: int  # Cached - Shmem
    shmem: int
    kernel: int  # Slab + KernelStack + PageTables + VmallocUsed(if sane)
    other: int  # used - gpu - anon - shmem - kernel - (cache counted as available) ; clamped >= 0
    swap_total: int
    swap_used: int
    psi_some: float | None = None  # avg10 %
    psi_full: float | None = None


class CpuSample(BaseModel):
    util: float  # % across all cores
    perf_util: float | None = None  # mean over performance cores
    eff_util: float | None = None  # mean over efficiency cores
    per_core: list[float]  # % per core, index = core id
    freq_mhz: list[float | None]
    load1: float
    load5: float
    load15: float
    psi_some: float | None = None


class NetSample(BaseModel):
    name: str
    up: bool
    speed_mbps: int | None = None
    rx_bps: float  # bytes/s
    tx_bps: float
    errors: float = 0  # new errors in this interval (rx+tx, incl. CRC / RDMA error counters)
    drops: float = 0  # new drops/discards in this interval
    rdma_state: str | None = None  # "ACTIVE", "DOWN"
    rdma_rate: str | None = None  # "200 Gb/sec (4X HDR)"


class DiskSample(BaseModel):
    name: str
    read_bps: float
    write_bps: float
    read_iops: float
    write_iops: float
    busy_pct: float


class FsSample(BaseModel):
    mount: str
    key: str  # "root" for "/"
    device: str
    total: int
    used: int
    free: int


class TempSample(BaseModel):
    id: str
    c: float | None


class ProcSample(BaseModel):
    pid: int
    name: str
    cmdline: str  # truncated to 300 chars
    user: str | None = None
    cpu_pct: float | None = None  # % of ONE core (top-style, can exceed 100); None until a second reading
    rss: int
    gpu_mem: int | None = None
    gpu_util: float | None = None
    container: str | None = None
    model: str | None = None  # detected model name, e.g. "DeepSeek-V4.1-Flash-EXL3"


ServerState = Literal["ready", "loading", "sleeping", "down"]

# The fields an agent writes into ModelServerSample.values and .reports. The wire keys stay `str`, so a
# field a newer agent adds still gets history on an older console.
LlmField = Literal[
    "up",  # 1 while the server answers (ready or sleeping), else 0; always in `values`
    "running",  # requests in prefill or decode
    "waiting",  # requests queued
    "kv_cache_pct",  # 0..100, the fullest pool when the server reports several
    "gen_tps",  # generated tokens/s over the last ~10 s
    "prompt_tps",  # prompt tokens/s over the last ~10 s
    "preempt_per_s",
    "ttft_p50_s",  # over requests whose first token came in the last ~60 s
    "ttft_p95_s",
    "mem_bytes",  # memory the server holds: its own gauge, else its process's GPU memory (mem_source)
]
LLM_FIELDS: tuple[str, ...] = get_args(LlmField)


class LoadedModel(BaseModel):
    name: str  # as clients address it
    context_len: int | None = None  # tokens
    size_bytes: int | None = None
    vram_bytes: int | None = None
    expires_ts: float | None = None  # when the server unloads it if idle


class ModelServerSample(BaseModel):
    port: int  # the series key: llm.<port>.<field>
    adapter: str  # how the agent reads it: "prometheus"
    software: str | None = None  # "vLLM", "llama.cpp", or the name the server gives itself
    version: str | None = None
    prefix: str | None = None  # metric namespace in its exposition: "vllm:", "trtllm_", "" for bare names
    state: ServerState = "ready"
    models: list[LoadedModel] = Field(default_factory=list)
    # Three states per field. In `values`: a reading. In `reports` only: the server has the series and
    # nothing to say now (no request in the window, first poll after a restart). In neither: not reported
    # by this server. A missing reading is never 0.
    values: dict[str, float] = Field(default_factory=dict)
    reports: list[str] = Field(default_factory=list)
    mem_source: str | None = None  # whose figure mem_bytes is: "server" (its own gauge) or "process"
    pid: int | None = None
    container: str | None = None
    started_ts: float | None = None  # process start, as the server reports it
    scraped_ts: float | None = None  # last poll the server answered
    problem: str | None = None  # why readings are missing, phrased as the fix

    @field_validator("state", mode="before")
    @classmethod
    def _unknown_state_reads_as_ready(cls, v: object) -> object:
        # A newer agent may send a state this console predates; rejecting it would drop the whole sample.
        return v if v in get_args(ServerState) else "ready"


class Sample(BaseModel):
    node_id: str
    ts: float
    seq: int
    interval_ms: int
    gpu: list[GpuSample]
    mem: MemSample
    cpu: CpuSample
    net: list[NetSample]
    disk: list[DiskSample]
    fs: list[FsSample]
    temps: list[TempSample]
    # Highest coretemp or k10temp reading, °C. k10temp's Tctl counts when the chip has no Tdie, and Tctl is a
    # fan-control value on an arbitrary scale, not a measured die temperature.
    cpu_temp_c: float | None = None
    procs: list[ProcSample] | None = None  # only on ticks where processes were refreshed
    procs_ts: float | None = None  # when the process list was last refreshed (on every tick)
    # Model servers listening on the node. None: the agent predates them, or looks for none. []: none found.
    llm: list[ModelServerSample] | None = None
    errors: dict[str, str] = Field(default_factory=dict)  # collector name -> error; others still report


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


class HistoryResponse(BaseModel):
    node_id: str
    resolution_s: float  # 1 (ring), 10, 60
    ts: list[float]
    series: dict[str, list[float | None]]  # key -> avg values aligned with ts
    min: dict[str, list[float | None]] = Field(default_factory=dict)
    max: dict[str, list[float | None]] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Console: cluster state, alerts, events
# ---------------------------------------------------------------------------

NodeStatus = Literal["connecting", "online", "stale", "offline", "error"]


class Problem(BaseModel):
    message: str  # "Agent unreachable on spark2"
    cause: str  # "Connection refused on 192.168.1.12:9750"
    fix: str  # "Start the agent on spark2: `sudo systemctl start sparkline-agent`."


class NodeState(BaseModel):
    node_id: str
    url: str
    status: NodeStatus
    since: float  # when status last changed
    last_sample_ts: float | None = None
    error: Problem | None = None
    info: NodeInfo | None = None
    next_retry_ts: float | None = None
    first_seen: float | None = None  # when this console first received a sample from the node. None: never


class Onboarding(BaseModel):
    """One per console: how far the person who set it up has come."""

    started: float | None = None  # first successful sign-in on this console. None: nobody has signed in
    finished: float | None = None  # the guide was completed or dismissed: it never opens by itself again
    reopened: bool = False  # brought back after it was finished: it stays until the person dismisses it
    seen: list[str] = Field(default_factory=list)  # ids of guide items the person opened. Sorted, unique


class OnboardingPatch(BaseModel):
    seen: list[str] | None = None  # ids to add. Unknown ids are kept
    finished: bool | None = None  # True stamps `finished` once. False clears it and sets `reopened`


class ConsoleSettings(BaseModel):
    energy_rate_per_kwh: float = 0.28
    currency: str = "£"
    stale_after_s: float = 5.0  # no sample for this long -> stale
    offline_after_s: float = 30.0
    regression_pct: float = 5.0


class ClusterState(BaseModel):
    nodes: list[NodeState]
    settings: ConsoleSettings
    onboarding: Onboarding
    demo: bool = False
    version: str
    server_time: float


Severity = Literal["info", "warning", "critical"]


class AlertRule(BaseModel):
    id: str
    name: str
    enabled: bool = True
    kind: Literal["threshold", "throttle", "node_offline", "link_down"] = "threshold"
    metric: str | None = None  # flattened key, e.g. "gpu0.temp_c", "mem.psi_some"; fs.*.used_pct allowed
    op: Literal[">", "<"] = ">"
    threshold: float | None = None
    for_s: float = 10.0
    severity: Severity = "warning"
    nodes: list[str] | None = None  # None = all


class AlertRulesStatus(BaseModel):
    reset: bool  # on the default rules because the saved ones were unreadable, until rules are saved


class Event(BaseModel):
    id: int
    ts: float
    node_id: str | None = None
    severity: Severity
    kind: Literal["alert", "recovered", "node", "bench", "system"]
    rule_id: str | None = None
    title: str  # "GPU temperature high on spark1"
    detail: str  # "87 °C for 10 s (threshold 85 °C)"
    metric: str | None = None
    value: float | None = None
    resolved_ts: float | None = None
    acked: bool = False


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

ChannelKind = Literal["ntfy", "discord", "slack", "webhook"]

# A closed vocabulary: a delivery's failure is one of these words, never exception text, a URL or a
# response body.
NotifyFailure = Literal[
    "dns",  # the host did not resolve
    "address_refused",  # resolved to an address the scheme may not reach (http:// to a public address)
    "connect",  # refused, unreachable, reset
    "tls",  # the certificate did not verify for the configured host
    "timeout",
    "redirect",  # 3xx, never followed
    "rate_limited",  # 429
    "rejected",  # any other 4xx: a bad token, a deleted webhook
    "server_error",  # 5xx
]


class NotifyDelivery(BaseModel):
    ts: float
    ok: bool
    test: bool  # made by "Send test"
    notices: int  # alerts and recoveries in the message (0 for a test)
    failure: NotifyFailure | None = None
    http_status: int | None = None
    problem: Problem | None = None


class NotifyChannelStatus(BaseModel):
    name: str
    kind: ChannelKind
    host: str  # host and port only, never the path or the token
    min_severity: Severity
    send_resolved: bool
    pending: int  # notices waiting to be sent
    retry_at: float | None = None  # when waiting notices are next tried, while backing off or rate limited
    last: NotifyDelivery | None = None  # None until the first delivery since the console started


# ---------------------------------------------------------------------------
# Benchmarks
# ---------------------------------------------------------------------------


class BenchParam(BaseModel):
    name: str
    label: str
    type: Literal["int", "float", "enum", "bool", "string", "multi"]
    default: Any
    min: float | None = None
    max: float | None = None
    choices: list[str] | None = None
    unit: str | None = None
    help: str | None = None


class BenchImpact(BaseModel):
    thermal: Literal["low", "medium", "high"]
    power: Literal["low", "medium", "high"]
    disruptive: bool  # competes with running GPU workloads
    note: str


class GpuOption(BaseModel):
    """A GPU a GPU benchmark can run on, offered on nodes with two or more NVIDIA GPUs."""

    index: int  # GpuInfo.index: the GPU number the UI shows
    name: str
    uuid: str | None = None  # GpuInfo.uuid: Docker pins the container to it (--gpus device=<uuid>)
    problem: Problem | None = None  # why the benchmark cannot run on this GPU, e.g. it is not responding


class BenchSpec(BaseModel):
    id: str
    name: str
    category: Literal["compute", "memory", "cpu", "interconnect", "storage", "inference", "soak"]
    description: str
    est_duration_s: float  # with default params
    impact: BenchImpact
    params: list[BenchParam]
    min_nodes: int = 1
    max_nodes: int | None = 1
    requires: list[str] = Field(default_factory=list)  # NodeInfo.tools keys
    availability: dict[str, Problem | None] = Field(default_factory=dict)  # node_id -> None if runnable
    gpu_options: dict[str, list[GpuOption]] = Field(default_factory=dict)  # node_id -> GPUs to choose from
    # Nodes whose agent gives no duration estimate: its rates are GB10 figures and the node is not a GB10.
    no_estimate: list[str] = Field(default_factory=list)


RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class BenchResult(BaseModel):
    metric: str  # "bf16_tflops"
    label: str  # "BF16 dense GEMM"
    value: float
    unit: str  # "TFLOPS"
    better: Literal["higher", "lower"] = "higher"
    node_id: str | None = None
    extras: dict[str, Any] = Field(default_factory=dict)
    baseline: float | None = None  # filled by console when a baseline exists
    regression: bool = False


class BenchRun(BaseModel):
    id: str
    bench_id: str
    params: dict[str, Any]
    nodes: list[str]
    status: RunStatus
    created_ts: float
    started_ts: float | None = None
    finished_ts: float | None = None
    progress: float = 0.0  # 0..1
    phase: str = ""  # "Warming up", "BF16 16384³"
    results: list[BenchResult] = Field(default_factory=list)
    series: dict[str, list[float]] = Field(default_factory=dict)  # per-run time series (e.g. soak clocks)
    metadata: dict[str, Any] = Field(default_factory=dict)
    error: Problem | None = None
    log_tail: list[str] = Field(default_factory=list)
    baseline_for: bool = False
    params_key: str = ""  # canonical params JSON; baselines compare equal bench_id+params_key
    baseline_run_id: str | None = None  # the baseline this run's results were compared against
    node_states: dict[str, NodeBenchState] = Field(default_factory=dict)  # per-node progress from agents
    gpu_index: dict[str, int] = Field(default_factory=dict)  # node_id -> its GPU, on nodes with a choice


class BenchCreate(BaseModel):
    """Browser -> console: POST /api/v1/bench/runs."""

    bench_id: str
    nodes: list[str]
    params: dict[str, Any] = Field(default_factory=dict)
    confirm: bool  # must be true; the UI only sets it from the confirmation dialog
    gpu_index: dict[str, int] = Field(default_factory=dict)  # node_id -> chosen GPU (BenchSpec.gpu_options)


class BenchStartRequest(BaseModel):
    """Console -> agent: POST /api/v1/bench/runs. Multi-node benches get one request per node with a role."""

    run_id: str
    bench_id: str
    params: dict[str, Any] = Field(default_factory=dict)
    role: Literal["single", "server", "client", "rank"] = "single"
    rank: int | None = None
    world_size: int | None = None
    peer_node: str | None = None
    peer_ip: str | None = None  # rdma server IP (client role) or rendezvous/master IP (rank role)
    peer_port: int | None = None
    gpu_index: int | None = None  # the GPU to run a GPU benchmark on; None: the node's first usable GPU


class NodeBenchState(BaseModel):
    """Agent -> console: GET /api/v1/bench/runs/{id} and the agent stream's "bench" messages."""

    run_id: str
    bench_id: str
    node_id: str
    role: str = "single"
    status: RunStatus
    progress: float = 0.0
    phase: str = ""
    ready: bool = False  # server role is listening; console may start the clients
    started_ts: float | None = None
    finished_ts: float | None = None
    results: list[BenchResult] = Field(default_factory=list)
    series: dict[str, list[float]] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    error: Problem | None = None
    log_tail: list[str] = Field(default_factory=list)
    live: dict[str, Any] = Field(default_factory=dict)  # what the payload is doing now (bounded); replaced
    detail: dict[str, Any] = Field(default_factory=dict)  # structured per-run detail; top-level keys merge


BenchRun.model_rebuild()


# ---------------------------------------------------------------------------
# WebSocket messages (console -> browser; agent -> console uses "hello"/"sample"/"bench"/"ping")
# ---------------------------------------------------------------------------
# {"type": "hello", "cluster": ClusterState}   (console) / {"type": "hello", "info": NodeInfo}   (agent)
# {"type": "sample", "node_id": str, "sample": Sample}
# {"type": "node_status", "node": NodeState}
# {"type": "event", "event": Event}
# {"type": "bench", "run": BenchRun}   (console); agent: {"type":"bench","node_id":..,"run":NodeBenchState}
# {"type": "settings", "settings": ConsoleSettings}   (after PUT /api/v1/settings, so every open tab updates)
# {"type": "ping", "ts": float}
