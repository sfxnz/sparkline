from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any, ClassVar, NamedTuple

from ....common.schema import GpuInfo, GpuSample
from ...sources import Sources
from .. import GpuField, counter_delta
from .backend import CannotOpen, Gap, NoDevice

log = logging.getLogger(__name__)

# Energy and violation counters cost ~1.5-3.5 ms of CPU per NVML call on GB10 (vs ~0.03 ms for the
# others), so they are read on a slower cadence: violations every 10 s (the window's % is reported on each
# tick until the next read), energy every 30 s with GPU power integrated in between.
VIOLATION_EVERY_S = 10.0
ENERGY_EVERY_S = 30.0

ARCH = {
    2: "Kepler",
    3: "Maxwell",
    4: "Pascal",
    5: "Volta",
    6: "Turing",
    7: "Ampere",
    8: "Ada",
    9: "Hopper",
    10: "Blackwell",
}


def violation_pct(prev_ns: int | None, cur_ns: int, elapsed_s: float) -> float | None:
    """% of the interval spent in a violation state, from a cumulative ns counter. None until there is a
    previous reading (no interval yet), never a made-up 0."""
    if prev_ns is None or elapsed_s <= 0:
        return None
    return max(0.0, min(100.0, counter_delta(prev_ns, cur_ns) / (elapsed_s * 1e9) * 100.0))


def monotonic_energy(last: float | None, value: float) -> float:
    """Keep the reported energy counter from stepping back when a fresh NVML reading lands slightly below
    the power-integrated estimate; a large drop means the driver reset the counter, so follow it."""
    if last is None or value < last - 1e6:
        return value
    return max(last, value)


def _reason(e: Exception) -> str:
    return f"NVML: {e}" if str(e) else f"NVML: {type(e).__name__}"


def _no_permission(nv: Any, e: Exception) -> bool:
    return isinstance(e, nv.NVMLError_NoPermission)


def _denied(e: Exception) -> str:
    return f"Permission denied to the agent's user ({_reason(e)})"


class _Probe(NamedTuple):
    key: GpuField
    label: str
    retried: bool  # read every tick, so only Not Supported or No Permission at startup is a gap
    call: Callable[[], Any]


def _probes(nv: Any, h: Any) -> list[_Probe]:
    return [
        _Probe("util", "Utilisation", True, lambda: nv.nvmlDeviceGetUtilizationRates(h)),
        _Probe("sm_mhz", "SM clock", True, lambda: nv.nvmlDeviceGetClockInfo(h, nv.NVML_CLOCK_SM)),
        _Probe(
            "temp_c", "Temperature", True, lambda: nv.nvmlDeviceGetTemperature(h, nv.NVML_TEMPERATURE_GPU)
        ),
        _Probe("power_w", "Power draw", True, lambda: nv.nvmlDeviceGetPowerUsage(h)),
        _Probe("energy_j", "Energy counter", True, lambda: nv.nvmlDeviceGetTotalEnergyConsumption(h)),
        _Probe(
            "throttle_mask", "Clock event reasons", True, lambda: nv.nvmlDeviceGetCurrentClocksEventReasons(h)
        ),
        _Probe(
            "power_capped_pct",
            "Power-capped time",
            True,
            lambda: nv.nvmlDeviceGetViolationStatus(h, nv.NVML_PERF_POLICY_POWER),
        ),
        _Probe(
            "thermal_capped_pct",
            "Thermal-capped time",
            True,
            lambda: nv.nvmlDeviceGetViolationStatus(h, nv.NVML_PERF_POLICY_THERMAL),
        ),
        _Probe(
            "proc_mem", "Per-process GPU memory", True, lambda: nv.nvmlDeviceGetComputeRunningProcesses(h)
        ),
        _Probe("power_limit_w", "Power limit", False, lambda: nv.nvmlDeviceGetPowerManagementLimit(h)),
        _Probe("mem_mhz", "Memory clock", False, lambda: nv.nvmlDeviceGetClockInfo(h, nv.NVML_CLOCK_MEM)),
        _Probe("fan_pct", "Fan speed", False, lambda: nv.nvmlDeviceGetFanSpeed(h)),
        _Probe("fb_memory", "Dedicated GPU memory (FB)", False, lambda: nv.nvmlDeviceGetMemoryInfo(h)),
        _Probe("ecc", "ECC", False, lambda: nv.nvmlDeviceGetEccMode(h)),
        _Probe(
            "pcie_bps",
            "PCIe throughput",
            False,
            lambda: nv.nvmlDeviceGetPcieThroughput(h, nv.NVML_PCIE_UTIL_TX_BYTES),
        ),
    ]


def _gap(nv: Any, e: Exception, what: str, retried: bool, note: str = "") -> Gap | None:
    if _no_permission(nv, e):
        return Gap(_denied(e), "access")
    if retried and not isinstance(e, nv.NVMLError_NotSupported):
        return None
    return Gap(f"{what} ({_reason(e)}){note}")


class _Gpu:
    def __init__(self, index: int, handle: Any) -> None:  # an NVML device handle
        self.index = index
        self.h = handle
        self.disabled: set[str] = set()
        self.prev_viol: dict[int, int] = {}
        self.viol_t: float | None = None
        self.caps: dict[int, float | None] = {}
        self.energy_base: float | None = None  # last NVML counter reading (J)
        self.energy_integ = 0.0  # GPU power integrated since that reading (J)
        self.energy_j: float | None = None  # last reported value
        self.energy_t = -ENERGY_EVERY_S
        self.prev_t: float | None = None
        self.last_proc_ts = 0


NO_DRIVER = "No NVIDIA driver is loaded (/proc/driver/nvidia is missing)"


class Nvml:
    name: ClassVar[str] = "nvml"

    def __init__(self, src: Sources) -> None:
        self.nv = src.nvml
        self.fs = src.fs
        self.gpus: list[_Gpu] = []
        self._caps: dict[int, dict[GpuField, Gap | None] | Gap] = {}
        self._versions: dict[str, str] = {}
        self._lost: list[int] = []
        self._inited = False

    def _driver_loaded(self) -> bool:
        return self.fs.exists("/proc/driver/nvidia")

    def open(self) -> list[GpuInfo]:
        nv = self.nv
        if nv is None:
            if self._driver_loaded():
                raise CannotOpen("Install nvidia-ml-py to read NVIDIA GPU metrics", "dependency")
            raise NoDevice(NO_DRIVER)
        try:
            nv.nvmlInit()
            self._inited = True
            n = nv.nvmlDeviceGetCount()
        except Exception as e:
            if _no_permission(nv, e):
                raise CannotOpen(_denied(e), "access") from e
            # Tried before the driver check: WSL runs NVML without /proc/driver/nvidia.
            if self._driver_loaded():
                raise CannotOpen(f"NVML unavailable ({_reason(e)})", "hardware") from e
            raise NoDevice(NO_DRIVER) from e
        driver = self._try(nv.nvmlSystemGetDriverVersion)
        cuda = self._try(nv.nvmlSystemGetCudaDriverVersion_v2)
        versions = {
            "Driver": driver,
            "CUDA": f"{cuda // 1000}.{cuda % 1000 // 10}" if cuda else None,
            "NVML": self._try(nv.nvmlSystemGetNVMLVersion),
        }
        self._versions = {label: v for label, v in versions.items() if v}
        info = []
        lost: dict[int, str] = {}
        for i in range(n):
            try:
                g = _Gpu(i, nv.nvmlDeviceGetHandleByIndex(i))
            except Exception as e:
                log.warning("GPU %d handle failed: %s", i, e)
                lost[i] = _reason(e)
                continue
            self.gpus.append(g)
            info.append(self._probe(g))
        if not n:
            raise NoDevice("NVML found no NVIDIA GPU")
        for i, why in lost.items():
            info.append(GpuInfo(index=i, name=f"GPU {i}"))
            self._caps[i] = Gap(f"NVML could not open GPU {i} ({why})")
        self._lost = sorted(lost)
        return sorted(info, key=lambda g: g.index)

    def caps(self) -> dict[int, dict[GpuField, Gap | None] | Gap]:
        return self._caps

    def close(self) -> None:
        if self._inited:
            self._inited = False
            self.nv.nvmlShutdown()

    def versions(self) -> dict[str, str]:
        return self._versions

    @staticmethod
    def _try(fn: Callable[..., Any], *args: Any) -> Any:
        try:
            return fn(*args)
        except Exception:
            return None

    def _probe(self, g: _Gpu) -> GpuInfo:
        nv = self.nv
        h = g.h
        cc = self._try(nv.nvmlDeviceGetCudaComputeCapability, h)
        info = GpuInfo(
            index=g.index,
            name=self._try(nv.nvmlDeviceGetName, h) or f"GPU {g.index}",
            uuid=self._try(nv.nvmlDeviceGetUUID, h),
            arch=ARCH.get(self._try(nv.nvmlDeviceGetArchitecture, h)),
            compute_capability=f"{cc[0]}.{cc[1]}" if cc else None,
            cuda_cores=self._try(nv.nvmlDeviceGetNumGpuCores, h),
            sm_mhz_max=self._try(nv.nvmlDeviceGetMaxClockInfo, h, nv.NVML_CLOCK_SM),
            temp_slowdown_c=self._try(
                nv.nvmlDeviceGetTemperatureThreshold, h, nv.NVML_TEMPERATURE_THRESHOLD_SLOWDOWN
            ),
            temp_shutdown_c=self._try(
                nv.nvmlDeviceGetTemperatureThreshold, h, nv.NVML_TEMPERATURE_THRESHOLD_SHUTDOWN
            ),
            temp_max_c=self._try(
                nv.nvmlDeviceGetTemperatureThreshold, h, nv.NVML_TEMPERATURE_THRESHOLD_GPU_MAX
            ),
        )
        caps = self._caps[g.index] = {}
        for key, label, retried, call in _probes(nv, h):
            try:
                v = call()
                if key == "power_limit_w":
                    info.power_limit_w = v / 1000
            except Exception as e:
                note = " — unified memory is reported under Memory instead" if key == "fb_memory" else ""
                gap = _gap(nv, e, f"{label} not reported by {info.name}", retried, note)
                caps[key] = gap
                if gap:
                    g.disabled.add(key)
            else:
                caps[key] = None
        return info

    def _read(self, g: _Gpu, field: str, fn: Callable[..., Any], *args: Any) -> Any:
        if field in g.disabled:
            return None
        try:
            return fn(g.h, *args)
        except self.nv.NVMLError_NotSupported:
            g.disabled.add(field)
        except self.nv.NVMLError as e:
            log.debug("gpu%d %s: %s", g.index, field, e)
        return None

    def sample(self) -> list[GpuSample]:
        nv = self.nv
        out = []
        for g in self.gpus:
            now = time.monotonic()
            util = self._read(g, "util", nv.nvmlDeviceGetUtilizationRates)
            power = self._read(g, "power_w", nv.nvmlDeviceGetPowerUsage)
            power_w = power / 1000 if power is not None else None
            self._update_energy(g, now, power_w)
            g.prev_t = now
            mask = self._read(g, "throttle_mask", nv.nvmlDeviceGetCurrentClocksEventReasons)
            if g.viol_t is None or now - g.viol_t >= VIOLATION_EVERY_S:
                elapsed = now - g.viol_t if g.viol_t is not None else 0.0
                g.viol_t = now
                policies = (
                    (nv.NVML_PERF_POLICY_POWER, "power_capped_pct"),
                    (nv.NVML_PERF_POLICY_THERMAL, "thermal_capped_pct"),
                )
                for pol, key in policies:
                    v = self._read(g, key, nv.nvmlDeviceGetViolationStatus, pol)
                    if v is None:
                        g.caps[pol] = None
                        continue
                    g.caps[pol] = violation_pct(g.prev_viol.get(pol), v.violationTime, elapsed)
                    g.prev_viol[pol] = v.violationTime
            out.append(
                GpuSample(
                    index=g.index,
                    util=util.gpu if util is not None else None,
                    sm_mhz=self._read(g, "sm_mhz", nv.nvmlDeviceGetClockInfo, nv.NVML_CLOCK_SM),
                    gr_mhz=self._read(g, "gr", nv.nvmlDeviceGetClockInfo, nv.NVML_CLOCK_GRAPHICS),
                    video_mhz=self._read(g, "video", nv.nvmlDeviceGetClockInfo, nv.NVML_CLOCK_VIDEO),
                    temp_c=self._read(g, "temp_c", nv.nvmlDeviceGetTemperature, nv.NVML_TEMPERATURE_GPU),
                    power_w=power_w,
                    energy_j=round(g.energy_j, 3) if g.energy_j is not None else None,
                    pstate=self._read(g, "pstate", nv.nvmlDeviceGetPerformanceState),
                    throttle_mask=mask,
                    power_capped_pct=g.caps.get(nv.NVML_PERF_POLICY_POWER),
                    thermal_capped_pct=g.caps.get(nv.NVML_PERF_POLICY_THERMAL),
                )
            )
        out += [GpuSample(index=i) for i in self._lost]
        return sorted(out, key=lambda s: s.index)

    def proc_mem(self) -> dict[int, dict[int, int]]:
        out: dict[int, dict[int, int]] = {}
        for g in self.gpus:
            procs = self._read(g, "proc_mem", self.nv.nvmlDeviceGetComputeRunningProcesses)
            if procs is None:
                continue
            mem = out[g.index] = {}
            for pr in procs:
                if isinstance(pr.usedGpuMemory, int):
                    mem[pr.pid] = mem.get(pr.pid, 0) + pr.usedGpuMemory
        return out

    def _update_energy(self, g: _Gpu, now: float, power_w: float | None) -> None:
        if now - g.energy_t >= ENERGY_EVERY_S:
            mj = self._read(g, "energy_j", self.nv.nvmlDeviceGetTotalEnergyConsumption)
            if mj is not None:
                g.energy_t, g.energy_base, g.energy_integ = now, mj / 1000, 0.0
        elif g.energy_base is not None and power_w is not None and g.prev_t is not None:
            g.energy_integ += power_w * (now - g.prev_t)
        if g.energy_base is not None:
            g.energy_j = monotonic_energy(g.energy_j, g.energy_base + g.energy_integ)

    def proc_util(self) -> dict[int, float]:
        """pid -> mean SM % over samples since the last call (best effort; empty if none)."""
        nv = self.nv
        acc: dict[int, list[int]] = {}
        for g in self.gpus:
            if "putil" in g.disabled:
                continue
            try:
                samples = nv.nvmlDeviceGetProcessUtilization(g.h, g.last_proc_ts)
            except nv.NVMLError_NotSupported:
                g.disabled.add("putil")
                continue
            except nv.NVMLError:  # NOT_FOUND when there are no new samples
                continue
            for s in samples:
                g.last_proc_ts = max(g.last_proc_ts, s.timeStamp)
                acc.setdefault(s.pid, []).append(s.smUtil)
        return {pid: sum(v) / len(v) for pid, v in acc.items()}
