"""CPU: per-core utilisation (/proc/stat deltas), frequency, load, PSI, runtime core classification."""

from __future__ import annotations

import glob
import os
import re
from collections import Counter
from typing import Literal

from ...common.schema import CoreInfo, CpuSample
from . import parse_psi, read, read_once

# MIDR "CPU part" for implementer 0x41 (Arm Ltd).
ARM_PARTS = {
    0xD03: "Cortex-A53",
    0xD05: "Cortex-A55",
    0xD07: "Cortex-A57",
    0xD08: "Cortex-A72",
    0xD0B: "Cortex-A76",
    0xD0C: "Neoverse-N1",
    0xD0D: "Cortex-A77",
    0xD40: "Neoverse-V1",
    0xD41: "Cortex-A78",
    0xD44: "Cortex-X1",
    0xD46: "Cortex-A510",
    0xD47: "Cortex-A710",
    0xD48: "Cortex-X2",
    0xD49: "Neoverse-N2",
    0xD4D: "Cortex-A715",
    0xD4E: "Cortex-X3",
    0xD4F: "Neoverse-V2",
    0xD80: "Cortex-A520",
    0xD81: "Cortex-A720",
    0xD82: "Cortex-X4",
    0xD84: "Neoverse-V3",
    0xD85: "Cortex-X925",
    0xD87: "Cortex-A725",
    0xD8E: "Neoverse-N3",
}

SYS_CPU = "/sys/devices/system/cpu"


def parse_proc_stat(text: str) -> dict[int, tuple[int, int]]:
    """-> {core_id: (total_jiffies, idle_jiffies)}; idle includes iowait; guest is already in user."""
    out = {}
    for line in text.splitlines():
        if not line.startswith("cpu") or line.startswith("cpu "):
            continue
        parts = line.split()
        vals = [int(v) for v in parts[1:9]]  # user nice system idle iowait irq softirq steal
        out[int(parts[0][3:])] = (sum(vals), vals[3] + vals[4])
    return out


def core_utils(
    prev: dict[int, tuple[int, int]] | None, cur: dict[int, tuple[int, int]], ids: list[int]
) -> list[float]:
    """Per-core busy % between two reads. First read or counter reset -> 0."""
    out = []
    for i in ids:
        c = cur.get(i)
        p = prev.get(i) if prev else None
        if c is None or p is None:
            out.append(0.0)
            continue
        dt, di = c[0] - p[0], c[1] - p[1]
        out.append(0.0 if dt <= 0 or di < 0 else max(0.0, min(100.0, 100.0 * (dt - di) / dt)))
    return out


def parse_loadavg(text: str) -> tuple[float, float, float]:
    a, b, c = text.split()[:3]
    return float(a), float(b), float(c)


def parse_cpuinfo_parts(text: str) -> dict[int, str]:
    """-> {core_id: model name} from MIDR implementer/part; unknown parts omitted."""
    out: dict[int, str] = {}
    cur = impl = None
    for line in text.splitlines():
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if key == "processor":
            cur, impl = int(val), None
        elif key == "CPU implementer":
            impl = int(val, 16)
        elif key == "CPU part" and cur is not None and impl == 0x41:
            name = ARM_PARTS.get(int(val, 16))
            if name:
                out[cur] = name
    return out


def classify_cores(
    max_khz: dict[int, int | None], models: dict[int, str], cluster_ids: dict[int, int | None]
) -> list[CoreInfo]:
    """Cores at the highest cpuinfo_max_freq are performance, others efficiency; all equal -> unknown.
    Raw cluster ids (e.g. 56, 1144) are renumbered 0, 1, ... in ascending order."""
    known = {f for f in max_khz.values() if f}
    top = max(known) if known else None
    clusters = {c: n for n, c in enumerate(sorted({c for c in cluster_ids.values() if c is not None}))}
    cores = []
    for i in sorted(max_khz):
        f = max_khz[i]
        kind: Literal["performance", "efficiency", "unknown"]
        kind = "unknown" if len(known) < 2 or not f else "performance" if f == top else "efficiency"
        cid = cluster_ids.get(i)
        cores.append(
            CoreInfo(
                id=i,
                kind=kind,
                model=models.get(i),
                max_mhz=f / 1000 if f else None,
                cluster=clusters.get(cid) if cid is not None else None,
            )
        )
    return cores


def describe_cpu(cores: list[CoreInfo]) -> str:
    """'10× Cortex-X925 + 10× Cortex-A725' (performance first)."""
    order = {"performance": 0, "unknown": 1, "efficiency": 2}
    counts = Counter((order[c.kind], c.model or "Arm core") for c in cores)
    return " + ".join(f"{n}× {model}" for (_, model), n in sorted(counts.items())) or "unknown CPU"


def _int(path: str) -> int | None:
    v = read_once(path)
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


class CpuCollector:
    name = "cpu"

    def __init__(self) -> None:
        ids = sorted(
            int(m.group(1)) for p in glob.glob(f"{SYS_CPU}/cpu[0-9]*") if (m := re.search(r"cpu(\d+)$", p))
        )
        models = parse_cpuinfo_parts(read_once("/proc/cpuinfo") or "")
        self.cores = classify_cores(
            {i: _int(f"{SYS_CPU}/cpu{i}/cpufreq/cpuinfo_max_freq") for i in ids},
            models,
            {i: _int(f"{SYS_CPU}/cpu{i}/topology/cluster_id") for i in ids},
        )
        self.model = describe_cpu(self.cores)
        self.ids = ids
        self.perf = [n for n, c in enumerate(self.cores) if c.kind == "performance"]
        self.eff = [n for n, c in enumerate(self.cores) if c.kind == "efficiency"]
        self._freq_paths = [f"{SYS_CPU}/cpu{i}/cpufreq/scaling_cur_freq" for i in ids]
        self._prev: dict[int, tuple[int, int]] | None = None
        self._psi = os.path.exists("/proc/pressure/cpu")

    def collect(self) -> dict:
        cur = parse_proc_stat(read("/proc/stat"))
        per_core = core_utils(self._prev, cur, self.ids)
        self._prev = cur
        freq: list[float | None] = []
        for p in self._freq_paths:
            try:
                freq.append(int(read(p)) / 1000)
            except (OSError, ValueError):
                freq.append(None)
        l1, l5, l15 = parse_loadavg(read("/proc/loadavg"))
        psi = parse_psi(read("/proc/pressure/cpu")).get("some") if self._psi else None

        def mean(idx: list[int]) -> float | None:
            return sum(per_core[n] for n in idx) / len(idx) if idx else None

        return {
            "cpu": CpuSample(
                util=sum(per_core) / len(per_core) if per_core else 0.0,
                perf_util=mean(self.perf),
                eff_util=mean(self.eff),
                per_core=per_core,
                freq_mhz=freq,
                load1=l1,
                load5=l5,
                load15=l15,
                psi_some=psi,
            )
        }
