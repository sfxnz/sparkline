"""Unified memory: /proc/meminfo + NVML per-process GPU allocations + PSI."""

from __future__ import annotations

import os
from collections.abc import Callable

from ...common.schema import MemSample
from . import parse_psi, read


def parse_meminfo(text: str) -> dict[str, int]:
    """-> {field: bytes} (kB fields converted; unitless counts kept as-is)."""
    out = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if not parts:
            continue
        v = int(parts[0])
        out[key] = v * 1024 if len(parts) > 1 and parts[1] == "kB" else v
    return out


def build_mem(mi: dict[str, int], gpu: int | None, psi: dict[str, float] | None) -> MemSample:
    """Breakdown of used (= total - available). Components are allocated in order gpu, anon, shmem,
    kernel, each capped to what is left of used, so they never exceed it; the remainder is ``other``.
    ``cache`` (Cached - Shmem) is mostly reclaimable, i.e. part of available, and is reported alongside."""
    total = mi["MemTotal"]
    available = mi.get("MemAvailable", mi["MemFree"])
    used = max(0, total - available)
    vmalloc = mi.get("VmallocUsed", 0)
    if vmalloc > total // 4:  # some kernels report nonsense here
        vmalloc = 0
    kernel_raw = mi.get("Slab", 0) + mi.get("KernelStack", 0) + mi.get("PageTables", 0) + vmalloc
    shmem_raw = mi.get("Shmem", 0)
    left = used
    parts = []
    for v in (gpu or 0, mi.get("AnonPages", 0), shmem_raw, kernel_raw):
        take = min(v, left)
        parts.append(take)
        left -= take
    g, anon, shmem, kernel = parts
    psi = psi or {}
    return MemSample(
        total=total,
        available=available,
        used=used,
        free=mi["MemFree"],
        gpu=g if gpu is not None else None,
        anon=anon,
        cache=max(0, mi.get("Cached", 0) - shmem_raw),
        shmem=shmem,
        kernel=kernel,
        other=left,
        swap_total=mi.get("SwapTotal", 0),
        swap_used=max(0, mi.get("SwapTotal", 0) - mi.get("SwapFree", 0)),
        psi_some=psi.get("some"),
        psi_full=psi.get("full"),
    )


class MemoryCollector:
    name = "memory"

    def __init__(self, gpu_mem: Callable[[], int | None] = lambda: None) -> None:
        self._gpu_mem = gpu_mem
        self._psi = os.path.exists("/proc/pressure/memory")
        mi = parse_meminfo(read("/proc/meminfo"))
        self.mem_total, self.swap_total = mi["MemTotal"], mi.get("SwapTotal", 0)

    def collect(self) -> dict:
        mi = parse_meminfo(read("/proc/meminfo"))
        psi = parse_psi(read("/proc/pressure/memory")) if self._psi else None
        return {"mem": build_mem(mi, self._gpu_mem(), psi)}
