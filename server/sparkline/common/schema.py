"""Wire contract shared by sparkline-agent, sparkline and the web client (mirrored in web/src/lib/types.ts).

Conventions:
- Timestamps are Unix epoch seconds (float). Byte quantities are ints. Rates are per second.
- A metric that the hardware does not report is ``None`` in samples AND listed in ``NodeInfo.unsupported``;
  clients render it as "not reported by this hardware", never as 0.
- Bump SCHEMA_VERSION on breaking changes.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Static node description (agent: GET /api/v1/info)
# ---------------------------------------------------------------------------


class Unsupported(BaseModel):
    metric: str  # flattened key or prefix, e.g. "gpu0.power_limit_w", "fan"
    reason: str  # human readable, e.g. "Not reported by GB10 (NVML: Not Supported)"


class CoreInfo(BaseModel):
    id: int
    kind: Literal["performance", "efficiency", "unknown"]
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


class NetIfInfo(BaseModel):
    name: str
    role: Literal["interconnect", "lan", "virtual", "wireless", "other"]
    label: str  # "CX7 rail A", "LAN"
    mac: str | None = None
    ipv4: list[str] = Field(default_factory=list)
    speed_mbps: int | None = None
    rdma_device: str | None = None
    # "netdev_rdma": netdev bytes + RDMA port_*_data of this PCI function (real agent on CX7);
    # "ethtool_phy" is kept for compatibility but is not emitted by the agent (PHY counters are port-wide)
    counter_source: Literal["netdev_rdma", "ethtool_phy", "netdev"] = "netdev"
    peer: str | None = None  # node_id at the far end of an interconnect link, if known


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


class MemSample(BaseModel):
    total: int
    available: int
    used: int  # total - available
    free: int
    gpu: int | None = None  # sum of NVML per-process usedGpuMemory
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
    procs: list[ProcSample] | None = None  # only on ticks where processes were refreshed
    procs_ts: float | None = None  # when the process list was last refreshed (on every tick)
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
    cause: str  # "Connection refused on 10.20.20.195:9750"
    fix: str  # "Check `systemctl status sparkline-agent` on spark2"


class NodeState(BaseModel):
    node_id: str
    url: str
    status: NodeStatus
    since: float  # when status last changed
    last_sample_ts: float | None = None
    error: Problem | None = None
    info: NodeInfo | None = None
    next_retry_ts: float | None = None


class ConsoleSettings(BaseModel):
    energy_rate_per_kwh: float = 0.28
    currency: str = "£"
    stale_after_s: float = 5.0  # no sample for this long -> stale
    offline_after_s: float = 30.0
    regression_pct: float = 5.0


class ClusterState(BaseModel):
    nodes: list[NodeState]
    settings: ConsoleSettings
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


class BenchCreate(BaseModel):
    """Browser -> console: POST /api/v1/bench/runs."""

    bench_id: str
    nodes: list[str]
    params: dict[str, Any] = Field(default_factory=dict)
    confirm: bool  # must be true; the UI only sets it from the confirmation dialog


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


BenchRun.model_rebuild()


# ---------------------------------------------------------------------------
# WebSocket messages (console -> browser; agent -> console uses "hello"/"sample"/"bench"/"ping")
# ---------------------------------------------------------------------------
# {"type": "hello", "cluster": ClusterState}   (console) / {"type": "hello", "info": NodeInfo}   (agent)
# {"type": "sample", "node_id": str, "sample": Sample}
# {"type": "node_status", "node": NodeState}
# {"type": "event", "event": Event}
# {"type": "bench", "run": BenchRun}   (console); agent sends {"type":"bench","node_id":..,"run":NodeBenchState}
# {"type": "settings", "settings": ConsoleSettings}   (after PUT /api/v1/settings, so every open tab updates)
# {"type": "ping", "ts": float}
