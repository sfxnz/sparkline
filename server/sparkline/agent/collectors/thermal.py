"""Thermals: hwmon temperature sensors with stable ids and human labels. GPU temp lives in GpuSample."""

from __future__ import annotations

import glob
import os
import re
from dataclasses import dataclass, field

from ...common.schema import SensorInfo, TempSample, Unsupported
from . import read, read_once


@dataclass
class Chip:
    name: str  # hwmon "name"
    device: str  # realpath of hwmon/device (stable ordering across boots)
    temps: dict[int, tuple[str | None, float | None]] = field(default_factory=dict)  # idx -> (label, crit_c)
    path: str = ""
    nic: str | None = None  # mlx5: sys_image_guid shared by all PCI functions of one ConnectX chip


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def build_sensors(chips: list[Chip]) -> list[tuple[SensorInfo, list[tuple[str, int]]]]:
    """-> [(SensorInfo, [(chip path, temp index), ...])] with stable ids: acpitz.N, nvme.<label>, mlx5.N, ...

    The mlx5 driver registers one hwmon per PCI function, but on GB10 all four read the same ASIC sensor of
    one ConnectX-7 chip; functions sharing a chip (sys_image_guid) become one sensor reporting their max."""
    out: list[tuple[SensorInfo, list[tuple[str, int]]]] = []
    used: set[str] = set()
    counters: dict[str, int] = {}
    nics: dict[tuple[str, int], list[tuple[str, int]]] = {}  # (chip id, temp index) -> member paths
    nvme_chips = 0
    for chip in sorted(chips, key=lambda c: (c.name, c.device)):
        if chip.name == "nvme":
            prefix = "nvme" if nvme_chips == 0 else f"nvme{nvme_chips}"
            nvme_chips += 1
        for idx in sorted(chip.temps):
            label, crit = chip.temps[idx]
            paths = [(chip.path, idx)]
            if chip.name == "mlx5":
                nic = (chip.nic or chip.device, idx)
                if nic in nics:  # another PCI function of a chip already listed
                    nics[nic] += paths
                    continue
                nics[nic] = paths
            if chip.name == "acpitz":
                n = counters.get(chip.name, 0)
                counters[chip.name] = n + 1
                sid, text, group = f"acpitz.{n}", f"ACPI zone {n}", "soc"
            elif chip.name == "mlx5":
                n = counters.get(chip.name, 0)
                counters[chip.name] = n + 1
                sid, text, group = f"mlx5.{n}", "ConnectX-7 ASIC" + (f" {n + 1}" if n else ""), "nic"
            elif chip.name == "nvme":
                sid = f"{prefix}.{_slug(label) if label else f'temp{idx}'}"
                text, group = f"NVMe {label or f'temp{idx}'}", "nvme"
            elif chip.name.startswith(("mt79", "iwl")):
                sid = f"{chip.name}.{_slug(label) if label else idx}"
                text, group = f"Wi-Fi {label}" if label else "Wi-Fi", "wireless"
            else:
                sid = f"{chip.name}.{_slug(label) if label else idx}"
                text, group = f"{chip.name} {label}" if label else chip.name, "other"
            base, k = sid, 1
            while sid in used:
                sid = f"{base}_{k}"
                k += 1
            used.add(sid)
            out.append((SensorInfo(id=sid, label=text, group=group, crit_c=crit), paths))
    return out


def _milli(path: str) -> float | None:
    v = read_once(path)
    try:
        return int(v) / 1000 if v else None
    except ValueError:
        return None


def scan_hwmon(root: str = "/sys/class/hwmon") -> tuple[list[Chip], bool, bool]:
    """-> (chips with temp inputs, any fan inputs, any power inputs)."""
    chips, fans, power = [], False, False
    for h in sorted(glob.glob(f"{root}/hwmon*")):
        files = os.listdir(h)
        fans |= any(re.fullmatch(r"fan\d+_input", f) for f in files)
        power |= any(re.fullmatch(r"power\d+_input", f) for f in files)
        temps = {}
        for f in files:
            m = re.fullmatch(r"temp(\d+)_input", f)
            if m:
                i = int(m.group(1))
                temps[i] = (read_once(f"{h}/temp{i}_label"), _milli(f"{h}/temp{i}_crit"))
        if temps:
            dev = os.path.realpath(f"{h}/device") if os.path.exists(f"{h}/device") else h
            guids = glob.glob(f"{dev}/infiniband/*/sys_image_guid")
            chips.append(
                Chip(
                    name=read_once(f"{h}/name") or os.path.basename(h),
                    device=dev,
                    temps=temps,
                    path=h,
                    nic=read_once(guids[0]) if guids else None,
                )
            )
    return chips, fans, power


class ThermalCollector:
    name = "thermal"

    def __init__(self) -> None:
        chips, self.has_fans, self.has_power = scan_hwmon()
        built = build_sensors(chips)
        self.sensors = [s for s, _ in built]
        self._paths = [(s.id, [f"{path}/temp{idx}_input" for path, idx in members]) for s, members in built]
        self.has_core_temps = any(
            re.fullmatch(r"core\s*\d+", label or "", re.I) for c in chips for label, _ in c.temps.values()
        )

    def unsupported(self) -> list[Unsupported]:
        out = []
        if not self.has_core_temps:
            out.append(
                Unsupported(
                    metric="cpu.temp",
                    reason="Per-core CPU temperature is not exposed (only unlabelled ACPI zones)",
                )
            )
        if not self.has_fans:
            out.append(Unsupported(metric="fan", reason="No fan sensors exposed by this hardware (hwmon)"))
        if not self.has_power:
            out.append(
                Unsupported(
                    metric="system.power_w",
                    reason="Whole-system power is not exposed; only the GPU rail (NVML) is",
                )
            )
        return out

    def collect(self) -> dict:
        temps = []
        for sid, paths in self._paths:
            vals = []
            for p in paths:
                try:
                    vals.append(int(read(p)) / 1000)
                except (OSError, ValueError):
                    continue
            temps.append(TempSample(id=sid, c=max(vals) if vals else None))
        return {"temps": temps}
