"""Thermals: hwmon temperature sensors with stable ids and human labels. GPU temp lives in GpuSample."""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Literal

from ...common.schema import SensorInfo, TempSample, Unsupported
from ..sources import RootFs, Sources
from . import SLOW_EVERY_S, Caps, slow_due

# A read of these is a command to the device (NVMe admin command, Wi-Fi firmware query).
SLOW_GROUPS = ("nvme", "wireless")
# https://docs.kernel.org/hwmon/k10temp.html: Tctl is "a non-physical temperature on an arbitrary scale", and
# Tdie appears only on family 17h parts that offset Tctl.
# https://github.com/torvalds/linux/blob/v6.14/drivers/hwmon/coretemp.c: "Package id N", "Core N" per core id.
CPU_CHIPS: dict[str, tuple[tuple[re.Pattern[str], str], ...]] = {
    "k10temp": (
        (re.compile(r"Tctl"), "control (Tctl)"),
        (re.compile(r"Tdie"), "die (Tdie)"),
        (re.compile(r"Tccd(\d+)"), r"CCD \1"),
    ),
    "coretemp": (
        (re.compile(r"Package id \d+"), "package"),
        (re.compile(r"Core (\d+)"), r"core \1"),
    ),
}


@dataclass
class Chip:
    name: str  # hwmon "name"
    device: str  # realpath of hwmon/device (stable ordering across boots)
    temps: dict[int, tuple[str | None, float | None]] = field(default_factory=dict)  # idx -> (label, crit_c)
    path: str = ""
    nic: str | None = None  # mlx5: sys_image_guid shared by all PCI functions of one ConnectX chip


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def _cpu_label(chip: str, label: str | None) -> str | None:
    if label is None:
        return None
    return next((m.expand(text) for pat, text in CPU_CHIPS[chip] if (m := pat.fullmatch(label))), label)


def feeds_cpu_temp(chip: Chip, idx: int) -> bool:
    if chip.name not in CPU_CHIPS:
        return False
    return chip.temps[idx][0] != "Tctl" or "Tdie" not in {label for label, _ in chip.temps.values()}


def build_sensors(chips: list[Chip]) -> list[tuple[SensorInfo, list[tuple[str, int]]]]:
    """-> [(SensorInfo, [(chip path, temp index), ...])] with stable ids: acpitz.N, nvme.<label>, mlx5.N, ...

    The mlx5 driver registers one hwmon per PCI function, but on GB10 all four read the same ASIC sensor of
    one ConnectX-7 chip; functions sharing a chip (sys_image_guid) become one sensor."""
    out: list[tuple[SensorInfo, list[tuple[str, int]]]] = []
    used: set[str] = set()
    counters: dict[str, int] = {}
    nics: dict[tuple[str, int], list[tuple[str, int]]] = {}  # (chip id, temp index) -> member paths
    nvme_chips = 0
    cpu_chips = sum(1 for c in chips if c.name in CPU_CHIPS)
    cpu_chip = 0
    group: Literal["soc", "gpu", "nvme", "nic", "wireless", "other"]  # SensorInfo.group
    for chip in sorted(chips, key=lambda c: (c.name, c.device)):
        if chip.name == "nvme":
            prefix = "nvme" if nvme_chips == 0 else f"nvme{nvme_chips}"
            nvme_chips += 1
        if chip.name in CPU_CHIPS:
            cpu_chip += 1
            cpu = f"CPU {cpu_chip}" if cpu_chips > 1 else "CPU"
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
            elif chip.name in CPU_CHIPS:
                sid = f"{chip.name}.{_slug(label) if label else idx}"
                readable = _cpu_label(chip.name, label)
                text, group = f"{cpu} {readable}" if readable else cpu, "other"
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


def _first_reading(fs: RootFs, paths: list[str]) -> float | None:
    for p in paths:
        try:
            return int(fs.read(p)) / 1000
        except (OSError, ValueError):
            continue
    return None


def _milli(fs: RootFs, path: str) -> float | None:
    v = fs.read_once(path)
    try:
        return int(v) / 1000 if v else None
    except ValueError:
        return None


def scan_hwmon(fs: RootFs) -> tuple[list[Chip], int, bool]:
    chips, fans, power = [], 0, False
    for h in sorted(fs.glob("/sys/class/hwmon/hwmon*")):
        try:
            files = fs.listdir(h)
        except OSError:  # removed between glob and listdir (driver unbind, NVMe reset)
            continue
        fans += sum(1 for f in files if re.fullmatch(r"fan\d+_input", f))
        power |= any(re.fullmatch(r"power\d+_input", f) for f in files)
        temps = {}
        for f in files:
            m = re.fullmatch(r"temp(\d+)_input", f)
            if m:
                i = int(m.group(1))
                temps[i] = (fs.read_once(f"{h}/temp{i}_label"), _milli(fs, f"{h}/temp{i}_crit"))
        if temps:
            dev = fs.realpath(f"{h}/device") if fs.exists(f"{h}/device") else h
            guids = fs.glob(f"{dev}/infiniband/*/sys_image_guid")
            chips.append(
                Chip(
                    name=fs.read_once(f"{h}/name") or os.path.basename(h),
                    device=dev,
                    temps=temps,
                    path=h,
                    nic=fs.read_once(guids[0]) if guids else None,
                )
            )
    return chips, fans, power


class ThermalCollector:
    name = "thermal"

    def __init__(self, src: Sources) -> None:
        self.fs = src.fs
        chips, fans, power = scan_hwmon(self.fs)
        built = build_sensors(chips)
        self.sensors = [s for s, _ in built]
        self._paths = [
            (s.id, s.group in SLOW_GROUPS, [f"{path}/temp{idx}_input" for path, idx in members])
            for s, members in built
        ]
        by_path = {c.path: c for c in chips}
        self._cpu_ids = [
            s.id for s, members in built if any(feeds_cpu_temp(by_path[p], i) for p, i in members)
        ]
        self._last: dict[str, float | None] = {}
        self._slow_t = -SLOW_EVERY_S
        no_sensors = "No temperature sensors exposed (hwmon)"
        self._caps: dict[str, Unsupported | None] = {
            **(
                dict.fromkeys(f"temp.{s.id}" for s in self.sensors)
                if self.sensors
                else {"temp": Unsupported(metric="temp", reason=no_sensors)}
            ),
            "cpu.temp": None
            if any(c.name in CPU_CHIPS for c in chips)
            else Unsupported(
                metric="cpu.temp",
                reason="Per-core CPU temperature is not exposed (only unlabelled ACPI zones)"
                if self.sensors
                else no_sensors,
            ),
            "fan": Unsupported(
                metric="fan",
                reason=f"Fan speed is not collected yet (hwmon exposes {fans} fan sensor{'s' * (fans != 1)})",
                kind="agent",
            )
            if fans
            else Unsupported(metric="fan", reason="No fan sensors exposed by this hardware (hwmon)"),
            "system.power_w": Unsupported(
                metric="system.power_w",
                reason="Whole-system power is not collected yet; only the GPU rail (NVML) is",
                kind="agent",
            )
            if power
            else Unsupported(
                metric="system.power_w",
                reason="Whole-system power is not exposed; only the GPU rail (NVML) is",
            ),
        }

    def caps(self) -> Caps:
        return self._caps

    def collect(self) -> dict:
        now = time.monotonic()
        slow = slow_due(self._slow_t, now)
        if slow:
            self._slow_t = now
        for sid, is_slow, paths in self._paths:
            if slow or not is_slow or self._last.get(sid) is None:
                self._last[sid] = _first_reading(self.fs, paths)
        cpu = [c for sid in self._cpu_ids if (c := self._last[sid]) is not None]
        return {
            "temps": [TempSample(id=sid, c=self._last[sid]) for sid, _, _ in self._paths],
            "cpu_temp_c": max(cpu, default=None),
        }
