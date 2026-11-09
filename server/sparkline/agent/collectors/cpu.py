"""CPU: per-core utilisation (/proc/stat deltas), frequency, load, PSI, runtime core classification."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass

from ...common.schema import CoreInfo, CoreKind, CpuSample, Unsupported
from ..sources import RootFs, Sources
from . import Caps, parse_psi, psi_caps

ARM_LTD_IMPLEMENTER = 0x41
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
# cluster_id where the kernel has none: x86 leaves l2c_id at BAD_APICID (AMD), arm64 at -1.
NO_CLUSTER = (0xFFFF, -1)
PMU_DIR = "/sys/bus/event_source/devices"
# One perf PMU per Intel hybrid core type, from intel_hybrid_pmu_type_map in arch/x86/events/intel/core.c;
# cpu_lowpower holds Arrow Lake-H's low-power E-cores.
# https://github.com/torvalds/linux/blob/v6.14/tools/perf/Documentation/intel-hybrid.txt
HYBRID_PMUS: dict[str, CoreKind] = {
    "cpu_core": "performance",
    "cpu_atom": "efficiency",
    "cpu_lowpower": "efficiency",
}


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


@dataclass(frozen=True)
class Processor:
    midr: tuple[int, int] | None = None
    model_name: str | None = None

    @property
    def core_model(self) -> str | None:
        arm = ARM_PARTS.get(self.midr[1]) if self.midr and self.midr[0] == ARM_LTD_IMPLEMENTER else None
        return arm or self.model_name


def parse_cpuinfo(text: str) -> dict[int, Processor]:
    entries: dict[int, dict[str, str]] = {}
    fields: dict[str, str] = {}
    for line in text.splitlines():
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if key == "processor":
            fields = entries.setdefault(int(val), {})
        else:
            fields[key] = val
    out = {}
    for cpu, f in entries.items():
        impl, part = f.get("CPU implementer"), f.get("CPU part")
        midr = (int(impl, 16), int(part, 16)) if impl and part else None
        out[cpu] = Processor(midr=midr, model_name=f.get("model name") or None)
    return out


def parse_cpulist(text: str) -> set[int]:
    out: set[int] = set()
    for part in text.strip().split(","):
        if part:
            lo, _, hi = part.partition("-")
            out.update(range(int(lo), int(hi or lo) + 1))
    return out


def core_kinds(
    ids: list[int],
    hybrid: Mapping[str, set[int]],
    midr: Mapping[int, tuple[int, int]],
    capacity: Mapping[int, int | None],
) -> dict[int, CoreKind]:
    """Not from clock speed, which favoured cores raise, nor from cpu_capacity alone: it varies inside a
    design (GB10's X925 cores read 997, 1017 and 1024), so its top value also picks a favoured core."""
    kinds: dict[int, CoreKind] = dict.fromkeys(ids, "unknown")
    by_pmu = {cpu: HYBRID_PMUS[pmu] for pmu, cpus in hybrid.items() for cpu in cpus if cpu in kinds}
    if by_pmu:
        return kinds | by_pmu if len(set(by_pmu.values())) > 1 else kinds
    designs: dict[tuple[int, int], list[int]] = {}
    for cpu in ids:
        if cpu in midr:
            designs.setdefault(midr[cpu], []).append(cpu)
    grouped = [cpu for cpus in designs.values() for cpu in cpus]
    known = {cpu: c for cpu in grouped if (c := capacity.get(cpu)) is not None}
    if len(designs) < 2 or len(known) < len(grouped):
        return kinds
    top = {d: max(known[cpu] for cpu in cpus) for d, cpus in designs.items()}
    best = max(top.values())
    if list(top.values()).count(best) > 1:
        return kinds
    for d, cpus in designs.items():
        kind: CoreKind = "performance" if top[d] == best else "efficiency"
        kinds |= dict.fromkeys(cpus, kind)
    return kinds


def describe_cpu(cores: list[CoreInfo]) -> str:
    """'10× Cortex-X925 + 10× Cortex-A725' (performance first)."""
    order = {"performance": 0, "unknown": 1, "efficiency": 2}
    counts = Counter((order[c.kind], c.model or "Arm core") for c in cores)
    return " + ".join(f"{n}× {model}" for (_, model), n in sorted(counts.items())) or "unknown CPU"


def _int(fs: RootFs, path: str) -> int | None:
    v = fs.read_once(path)
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


def _clock_path(fs: RootFs, core: int) -> str:
    """cpuinfo_avg_freq is the measured clock; scaling_cur_freq can be the requested one (flat on GB10).
    It fails with EAGAIN while the core has no recent sample (idle), and that tick then reports None."""
    d = f"{SYS_CPU}/cpu{core}/cpufreq"
    return f"{d}/cpuinfo_avg_freq" if fs.exists(f"{d}/cpuinfo_avg_freq") else f"{d}/scaling_cur_freq"


class CpuCollector:
    name = "cpu"

    def __init__(self, src: Sources) -> None:
        fs = self.fs = src.fs
        ids = sorted(
            int(m.group(1)) for p in fs.glob(f"{SYS_CPU}/cpu[0-9]*") if (m := re.search(r"cpu(\d+)$", p))
        )
        procs = parse_cpuinfo(fs.read_once("/proc/cpuinfo") or "")
        hybrid = {
            pmu: parse_cpulist(text)
            for pmu in HYBRID_PMUS
            if (text := fs.read_once(f"{PMU_DIR}/{pmu}/cpus")) is not None
        }
        kinds = core_kinds(
            ids,
            hybrid,
            {i: p.midr for i, p in procs.items() if p.midr},
            {i: _int(fs, f"{SYS_CPU}/cpu{i}/cpu_capacity") for i in ids},
        )
        max_khz = {i: _int(fs, f"{SYS_CPU}/cpu{i}/cpufreq/cpuinfo_max_freq") for i in ids}
        raw_clusters = {i: _int(fs, f"{SYS_CPU}/cpu{i}/topology/cluster_id") for i in ids}
        cluster_ids = {i: None if c in NO_CLUSTER else c for i, c in raw_clusters.items()}
        clusters = {c: n for n, c in enumerate(sorted({c for c in cluster_ids.values() if c is not None}))}
        self.cores = [
            CoreInfo(
                id=i,
                kind=kinds[i],
                model=procs.get(i, Processor()).core_model,
                max_mhz=f / 1000 if (f := max_khz[i]) else None,
                cluster=None if (c := cluster_ids[i]) is None else clusters[c],
            )
            for i in ids
        ]
        names = list(dict.fromkeys(p.model_name for p in procs.values() if p.model_name))
        self.model = " + ".join(names) or describe_cpu(self.cores)
        self.ids = ids
        self.perf = [n for n, c in enumerate(self.cores) if c.kind == "performance"]
        self.eff = [n for n, c in enumerate(self.cores) if c.kind == "efficiency"]
        self._freq_paths = [_clock_path(fs, i) for i in ids]
        self._prev: dict[int, tuple[int, int]] | None = None
        self._psi = fs.exists("/proc/pressure/cpu")
        split = "This CPU has no performance/efficiency core split"
        no_clock = "CPU clocks are not exposed (no cpufreq under /sys/devices/system/cpu)"
        self._caps: dict[str, Unsupported | None] = {
            **dict.fromkeys(("cpu.util", "cpu.load1", "cpu.load5", "cpu.load15", "cpu.core*.util")),
            "cpu.perf_util": None if self.perf else Unsupported(metric="cpu.perf_util", reason=split),
            "cpu.eff_util": None if self.eff else Unsupported(metric="cpu.eff_util", reason=split),
            "cpu.core*.mhz": None
            if any(fs.exists(p) for p in self._freq_paths)
            else Unsupported(metric="cpu.core*.mhz", reason=no_clock),
            **psi_caps(fs, "cpu", ("cpu.psi_some",)),
        }

    def caps(self) -> Caps:
        return self._caps

    def collect(self) -> dict:
        cur = parse_proc_stat(self.fs.read("/proc/stat"))
        per_core = core_utils(self._prev, cur, self.ids)
        self._prev = cur
        freq: list[float | None] = []
        for p in self._freq_paths:
            try:
                freq.append(int(self.fs.read(p)) / 1000)
            except (OSError, ValueError):
                freq.append(None)
        l1, l5, l15 = parse_loadavg(self.fs.read("/proc/loadavg"))
        psi = parse_psi(self.fs.read("/proc/pressure/cpu")).get("some") if self._psi else None

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
