"""The console's live state as Prometheus text format 0.0.4 (GET /metrics). Pure: no IO and no clock.

EXPORTED is the only place that names a metric: one row per flattened key (common/metrics.py), one family
per row. A key's unit comes from alerts.UNIT_PATTERNS, and BASE_UNITS says which base unit that makes the
family and how to scale the value to it, so a name and its values cannot disagree.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from typing import NamedTuple

from ..common.metrics import GPU_TOTALS, flatten
from ..common.schema import NodeState, Sample
from .alerts import Unit, unit_of


class BaseUnit(NamedTuple):
    suffix: str  # what the family name must end with
    scale: float = 1.0  # flattened value -> base unit


BASE_UNITS: dict[Unit, BaseUnit] = {
    "celsius": BaseUnit("_celsius"),
    "gib": BaseUnit("_bytes"),
    "percent": BaseUnit("_ratio", 0.01),
    "watts": BaseUnit("_watts"),
    "mhz": BaseUnit("_hertz", 1e6),
    "mbit_s": BaseUnit("_bytes_per_second"),
    "mbyte_s": BaseUnit("_bytes_per_second"),
    "kwh": BaseUnit("_joules_total"),
    "plain": BaseUnit(""),
}


class Family(NamedTuple):
    name: str  # a counter if it ends in _total, else a gauge
    help: str


NODE_UP = Family("sparkline_node_up", "1 while the console receives samples from the node, else 0.")
NODE_LAST_SAMPLE = Family(
    "sparkline_node_last_sample_timestamp_seconds", "When the console last received a sample from the node."
)
MODEL_SERVER_INFO = Family(
    "sparkline_model_server_info", "Always 1. The labels name the server's software and each loaded model."
)

# Flattened key -> its family. "{gpu}" takes that part of the key as the value of the label gpu.
EXPORTED: dict[str, Family] = {
    "gpu{gpu}.util": Family("sparkline_gpu_utilization_ratio", "GPU utilization."),
    "gpu{gpu}.sm_mhz": Family("sparkline_gpu_sm_clock_hertz", "GPU compute (SM) clock."),
    "gpu{gpu}.temp_c": Family("sparkline_gpu_temperature_celsius", "GPU temperature."),
    "gpu{gpu}.power_w": Family("sparkline_gpu_power_watts", "GPU power draw."),
    "gpu{gpu}.energy_j": Family(
        "sparkline_gpu_energy_joules_total", "Energy the GPU has used since its driver loaded."
    ),
    "gpu{gpu}.throttle_mask": Family(
        "sparkline_gpu_throttle_mask",
        "NVML clocks-event-reasons bitmask. 0 while nothing limits the GPU's clocks.",
    ),
    "gpu{gpu}.power_capped_pct": Family(
        "sparkline_gpu_power_capped_ratio",
        "Share of the last sample interval the GPU spent power capped.",
    ),
    "gpu{gpu}.thermal_capped_pct": Family(
        "sparkline_gpu_thermal_capped_ratio",
        "Share of the last sample interval the GPU spent thermally capped.",
    ),
    "gpu{gpu}.vram_used": Family("sparkline_gpu_vram_used_bytes", "Dedicated GPU memory in use."),
    "gpu{gpu}.shared_used": Family("sparkline_gpu_shared_memory_used_bytes", "System memory the GPU holds."),
    "mem.used": Family("sparkline_memory_used_bytes", "Memory in use: total minus available."),
    "mem.available": Family("sparkline_memory_available_bytes", "Memory available to new work."),
    "mem.gpu": Family("sparkline_memory_gpu_bytes", "System memory the GPUs hold."),
    "mem.anon": Family("sparkline_memory_anon_bytes", "Anonymous process memory."),
    "mem.cache": Family("sparkline_memory_cache_bytes", "Page cache, without shared memory."),
    "mem.shmem": Family("sparkline_memory_shmem_bytes", "Shared memory and tmpfs."),
    "mem.kernel": Family("sparkline_memory_kernel_bytes", "Kernel memory: slab, stacks and page tables."),
    "mem.other": Family("sparkline_memory_other_bytes", "Memory in use that no other memory series counts."),
    "mem.swap_used": Family("sparkline_memory_swap_used_bytes", "Swap in use."),
    "mem.psi_some": Family(
        "sparkline_memory_pressure_some_ratio",
        "Share of the last 10 s in which some task waited for memory.",
    ),
    "mem.psi_full": Family(
        "sparkline_memory_pressure_full_ratio",
        "Share of the last 10 s in which every task waited for memory.",
    ),
    "mem.used_pct": Family("sparkline_memory_used_ratio", "Memory in use as a share of total memory."),
    "cpu.util": Family("sparkline_cpu_utilization_ratio", "CPU utilization across all cores."),
    "cpu.perf_util": Family(
        "sparkline_cpu_performance_cores_utilization_ratio",
        "Mean utilization of the performance cores.",
    ),
    "cpu.eff_util": Family(
        "sparkline_cpu_efficiency_cores_utilization_ratio", "Mean utilization of the efficiency cores."
    ),
    "cpu.load1": Family("sparkline_load1", "1 minute load average."),
    "cpu.load5": Family("sparkline_load5", "5 minute load average."),
    "cpu.load15": Family("sparkline_load15", "15 minute load average."),
    "cpu.psi_some": Family(
        "sparkline_cpu_pressure_some_ratio", "Share of the last 10 s in which some task waited for CPU."
    ),
    "cpu.temp": Family("sparkline_cpu_temperature_celsius", "CPU temperature."),
    "cpu.core{core}.util": Family("sparkline_cpu_core_utilization_ratio", "Utilization of one core."),
    "cpu.core{core}.mhz": Family("sparkline_cpu_core_frequency_hertz", "Clock of one core."),
    "net.{iface}.rx_bps": Family("sparkline_network_receive_bytes_per_second", "Receive rate."),
    "net.{iface}.tx_bps": Family("sparkline_network_transmit_bytes_per_second", "Transmit rate."),
    "net.{iface}.up": Family("sparkline_network_up", "1 while the interface has a link, else 0."),
    "disk.{disk}.read_bps": Family("sparkline_disk_read_bytes_per_second", "Read rate."),
    "disk.{disk}.write_bps": Family("sparkline_disk_write_bytes_per_second", "Write rate."),
    "disk.{disk}.read_iops": Family("sparkline_disk_reads_per_second", "Read operations per second."),
    "disk.{disk}.write_iops": Family("sparkline_disk_writes_per_second", "Write operations per second."),
    "disk.{disk}.busy_pct": Family(
        "sparkline_disk_busy_ratio", "Share of the last sample interval the disk was busy."
    ),
    "fs.{fs}.used": Family("sparkline_filesystem_used_bytes", "Space in use."),
    "fs.{fs}.total": Family("sparkline_filesystem_size_bytes", "Size of the filesystem."),
    "fs.{fs}.free": Family("sparkline_filesystem_free_bytes", "Space an unprivileged user can still write."),
    "fs.{fs}.used_pct": Family(
        "sparkline_filesystem_used_ratio", "Space in use as a share of used plus free, as df."
    ),
    "temp.{sensor}": Family("sparkline_sensor_temperature_celsius", "Temperature of one hwmon sensor."),
    "llm.{port}.up": Family("sparkline_model_server_up", "1 while the model server answers, else 0."),
    "llm.{port}.running": Family("sparkline_model_server_requests_running", "Requests in prefill or decode."),
    "llm.{port}.waiting": Family("sparkline_model_server_requests_waiting", "Requests queued."),
    "llm.{port}.kv_cache_pct": Family("sparkline_model_server_kv_cache_usage_ratio", "KV cache in use."),
    "llm.{port}.gen_tps": Family(
        "sparkline_model_server_generation_tokens_per_second",
        "Tokens generated per second over the last 10 s.",
    ),
    "llm.{port}.prompt_tps": Family(
        "sparkline_model_server_prompt_tokens_per_second",
        "Prompt tokens processed per second over the last 10 s.",
    ),
    "llm.{port}.preempt_per_s": Family(
        "sparkline_model_server_preemptions_per_second", "Requests preempted per second."
    ),
    "llm.{port}.ttft_p50_s": Family(
        "sparkline_model_server_time_to_first_token_p50_seconds",
        "Median time to first token over the last 60 s.",
    ),
    "llm.{port}.ttft_p95_s": Family(
        "sparkline_model_server_time_to_first_token_p95_seconds",
        "95th percentile time to first token over the last 60 s.",
    ),
    "llm.{port}.mem_bytes": Family("sparkline_model_server_memory_bytes", "Memory the model server holds."),
}

# Flattened keys (fnmatch patterns) with no family, and why. A key in neither table fails the tests.
NOT_EXPORTED: dict[str, str] = {
    **{
        f"gpu.{name}": "A total over the node's GPUs. Aggregate the sparkline_gpu_* series by node instead."
        for name in GPU_TOTALS
    },
    "net.*.errors": "Events in one sample interval. A scrape would miss the intervals between scrapes.",
    "net.*.drops": "Events in one sample interval. A scrape would miss the intervals between scrapes.",
    "llm.*.*": "A reading from a newer agent. This console does not know its unit, so it cannot name it.",
}


class _Rule(NamedTuple):
    key: re.Pattern[str]
    family: Family
    scale: float


def _rule(key: str, family: Family) -> _Rule:
    # UNIT_PATTERNS matches real keys: "gpu0.util", not "gpu{gpu}.util".
    unit = BASE_UNITS[unit_of(re.sub(r"\{\w+\}", "0", key))]
    if not family.name.endswith(unit.suffix):
        raise ValueError(f"{key} is exported as {family.name}, which must end with {unit.suffix}")
    slots = re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>.+)", re.escape(key))
    return _Rule(re.compile(slots, re.DOTALL), family, unit.scale)


_RULES = tuple(_rule(key, family) for key, family in EXPORTED.items())


def _match(key: str) -> tuple[_Rule, tuple[tuple[str, str], ...]] | None:
    for rule in _RULES:
        if m := rule.key.fullmatch(key):
            return rule, tuple(m.groupdict().items())
    return None


def family_for(key: str) -> str | None:
    """The family a flattened key is exported under. None: it is not exported."""
    hit = _match(key)
    return hit[0].family.name if hit else None


_ESCAPES = str.maketrans({"\\": r"\\", '"': r"\"", "\n": r"\n"})


def _number(v: float) -> str:
    if math.isnan(v):
        return "NaN"
    if math.isinf(v):
        return "+Inf" if v > 0 else "-Inf"
    return str(int(v)) if v.is_integer() else repr(v)


def render(nodes: Iterable[NodeState], samples: Iterable[Sample]) -> str:
    """One scrape. ``samples`` holds each node's latest sample. A node that is not online exports only
    node_up and its last sample time, so its other series go stale in Prometheus instead of freezing."""
    latest = {s.node_id: s for s in samples}
    rows: dict[Family, list[str]] = {
        f: [] for f in (NODE_UP, NODE_LAST_SAMPLE, *EXPORTED.values(), MODEL_SERVER_INFO)
    }

    def add(family: Family, labels: Iterable[tuple[str, object]], value: float) -> None:
        pairs = ",".join(f'{k}="{str(v).translate(_ESCAPES)}"' for k, v in labels if v is not None)
        rows[family].append(f"{family.name}{{{pairs}}} {_number(value)}")

    for n in nodes:
        node = (("node", n.node_id),)
        add(NODE_UP, node, float(n.status == "online"))
        if n.last_sample_ts is not None:
            add(NODE_LAST_SAMPLE, node, n.last_sample_ts)
        s = latest.get(n.node_id)
        if s is None or n.status != "online":
            continue
        for key, value in flatten(s).items():
            if hit := _match(key):
                rule, labels = hit
                add(rule.family, node + labels, value * rule.scale)
        for srv in s.llm or []:
            server = (*node, ("port", srv.port), ("software", srv.software), ("version", srv.version))
            models: list[str | None] = [m.name for m in srv.models]
            for model in models or [None]:
                add(MODEL_SERVER_INFO, (*server, ("model", model)), 1.0)

    out = []
    for family, lines in rows.items():
        if lines:
            kind = "counter" if family.name.endswith("_total") else "gauge"
            out += [f"# HELP {family.name} {family.help}", f"# TYPE {family.name} {kind}", *lines]
    return "".join(line + "\n" for line in out)
