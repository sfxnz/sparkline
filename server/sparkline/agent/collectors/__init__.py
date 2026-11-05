"""Collectors. Each module keeps pure parsing functions (unit-tested on fixtures) separate from IO.

A collector implements ``Collector``: ``collect()`` returns a dict whose keys are ``Sample`` field names, and
``caps()`` maps each metric key it owns to None (reported) or the reason it is not. Caps are fixed at startup.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal, Protocol, get_args

from ...common.metrics import GPU_TOTALS
from ...common.schema import Unsupported
from ..sources import RootFs

Caps = Mapping[str, Unsupported | None]

GpuField = Literal[
    "util",
    "sm_mhz",
    "temp_c",
    "power_w",
    "energy_j",
    "throttle_mask",
    "power_capped_pct",
    "thermal_capped_pct",
    "proc_mem",
    "power_limit_w",
    "mem_mhz",
    "fan_pct",
    "fb_memory",
    "ecc",
    "pcie_bps",
]
_MEM = (
    "used",
    "available",
    "anon",
    "cache",
    "shmem",
    "kernel",
    "other",
    "swap_used",
    "used_pct",
    "psi_some",
    "psi_full",
)
_CPU = ("util", "perf_util", "eff_util", "load1", "load5", "load15", "psi_some", "core*.util", "core*.mhz")

VOCABULARY: dict[str, str] = {
    **{f"gpu*.{f}": "gpu" for f in get_args(GpuField)},
    "mem.gpu": "gpu",
    "gpu.backend": "gpu",
    **{f"gpu.{f}": "gpu" for f in GPU_TOTALS},
    **{f"mem.{f}": "memory" for f in _MEM},
    **{f"cpu.{f}": "cpu" for f in _CPU},
    "net": "net",
    "disk": "storage",
    "fs": "storage",
    **{k: "thermal" for k in ("temp", "cpu.temp", "fan", "system.power_w")},
    "procs": "procs",
}


def psi_caps(fs: RootFs, resource: str, keys: tuple[str, ...]) -> dict[str, Unsupported | None]:
    path = f"/proc/pressure/{resource}"
    if fs.exists(path):
        return dict.fromkeys(keys)
    reason = (
        f"Pressure stall information is not exposed: {path} is missing (kernel without CONFIG_PSI, or psi=0)"
    )
    return {k: Unsupported(metric=k, reason=reason) for k in keys}


def covers(metric: str, key: str) -> bool:
    return re.fullmatch(re.escape(metric).replace(r"\*", r"\d+") + r"(\..*)?", key) is not None


def declares(declared: str, vocab: str) -> bool:
    indexes = re.findall(r"\d+", declared) or ["0"]
    return covers(vocab, declared) or any(covers(declared, vocab.replace("*", i)) for i in indexes)


class Collector(Protocol):
    name: str

    def collect(self) -> dict[str, Any]: ...

    def caps(self) -> Caps: ...


SLOW_EVERY_S = 10.0


def slow_due(last: float, now: float) -> bool:
    """Whether a read done every SLOW_EVERY_S, last at ``last``, is due. A collector runs a different few
    ms into each tick, so at 1 Hz the tenth tick can land just under SLOW_EVERY_S after the last read."""
    return now - last >= SLOW_EVERY_S - 0.5


def counter_delta(prev: float | None, cur: float) -> float:
    """Delta of a monotonic counter; 0 on first read or counter reset."""
    if prev is None or cur < prev:
        return 0.0
    return cur - prev


def parse_psi(text: str) -> dict[str, float]:
    """/proc/pressure/* -> {"some": avg10, "full": avg10}."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        for kv in parts[1:]:
            if kv.startswith("avg10="):
                out[parts[0]] = float(kv[6:])
    return out
