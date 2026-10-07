"""GPU via NVML (nvidia-ml-py). Only fields that probe as supported are read each tick."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from ...common.schema import GpuInfo, GpuSample, Unsupported
from . import counter_delta

log = logging.getLogger(__name__)

try:
    import pynvml as nv
except ImportError:  # pragma: no cover - dependency is declared, but stay alive without it
    nv = None

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


class _Gpu:
    def __init__(self, index: int, handle: Any) -> None:  # an NVML device handle
        self.index = index
        self.h = handle
        self.disabled: set[str] = set()  # fields that raised NotSupported
        self.prev_viol: dict[int, int] = {}
        self.viol_t: float | None = None
        self.caps: dict[int, float | None] = {}
        self.energy_base: float | None = None  # last NVML counter reading (J)
        self.energy_integ = 0.0  # GPU power integrated since that reading (J)
        self.energy_j: float | None = None  # last reported value
        self.energy_t = -ENERGY_EVERY_S
        self.prev_t: float | None = None
        self.last_proc_ts = 0


class GpuCollector:
    name = "gpu"

    def __init__(self) -> None:
        self.gpus: list[_Gpu] = []
        self.info: list[GpuInfo] = []
        self.unsupported: list[Unsupported] = []
        self.driver = self.cuda = self.nvml = None
        self.proc_mem: dict[int, int] = {}  # pid -> bytes, refreshed every tick
        self.proc_mem_total: int | None = None
        if nv is None:
            self.unsupported.append(Unsupported(metric="gpu", reason="nvidia-ml-py is not installed"))
            return
        try:
            nv.nvmlInit()
            n = nv.nvmlDeviceGetCount()
        except Exception as e:
            self.unsupported.append(Unsupported(metric="gpu", reason=f"NVML unavailable ({_reason(e)})"))
            return
        self.driver = self._try(nv.nvmlSystemGetDriverVersion)
        cuda = self._try(nv.nvmlSystemGetCudaDriverVersion_v2)
        self.cuda = f"{cuda // 1000}.{cuda % 1000 // 10}" if cuda else None
        self.nvml = self._try(nv.nvmlSystemGetNVMLVersion)
        for i in range(n):
            try:
                g = _Gpu(i, nv.nvmlDeviceGetHandleByIndex(i))
            except Exception as e:
                log.warning("GPU %d handle failed: %s", i, e)
                continue
            self.gpus.append(g)
            self.info.append(self._probe(g))

    @staticmethod
    def _try(fn: Callable[..., Any], *args: Any) -> Any:
        try:
            return fn(*args)
        except Exception:
            return None

    def _probe(self, g: _Gpu) -> GpuInfo:
        h, p = g.h, f"gpu{g.index}."
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
        probes = [
            ("power_limit_w", "Power limit", lambda: nv.nvmlDeviceGetPowerManagementLimit(h)),
            ("mem_mhz", "Memory clock", lambda: nv.nvmlDeviceGetClockInfo(h, nv.NVML_CLOCK_MEM)),
            ("fan_pct", "Fan speed", lambda: nv.nvmlDeviceGetFanSpeed(h)),
            ("fb_memory", "Dedicated GPU memory (FB)", lambda: nv.nvmlDeviceGetMemoryInfo(h)),
            ("ecc", "ECC", lambda: nv.nvmlDeviceGetEccMode(h)),
            (
                "pcie_bps",
                "PCIe throughput",
                lambda: nv.nvmlDeviceGetPcieThroughput(h, nv.NVML_PCIE_UTIL_TX_BYTES),
            ),
        ]
        for key, label, fn in probes:
            try:
                v = fn()
                if key == "power_limit_w":
                    info.power_limit_w = v / 1000
            except Exception as e:
                why = " — unified memory is reported under Memory instead" if key == "fb_memory" else ""
                self.unsupported.append(
                    Unsupported(
                        metric=p + key, reason=f"{label} not reported by {info.name} ({_reason(e)}){why}"
                    )
                )
        return info

    def _read(self, g: _Gpu, field: str, fn: Callable[..., Any], *args: Any) -> Any:
        if field in g.disabled:
            return None
        try:
            return fn(g.h, *args)
        except nv.NVMLError_NotSupported:
            g.disabled.add(field)
        except nv.NVMLError as e:
            log.debug("gpu%d %s: %s", g.index, field, e)
        return None

    def collect(self) -> dict:
        out = []
        proc_mem: dict[int, int] = {}
        any_procs = False
        for g in self.gpus:
            now = time.monotonic()
            util = self._read(g, "util", nv.nvmlDeviceGetUtilizationRates)
            power = self._read(g, "power", nv.nvmlDeviceGetPowerUsage)
            power_w = power / 1000 if power is not None else None
            self._update_energy(g, now, power_w)
            g.prev_t = now
            mask = self._read(g, "reasons", nv.nvmlDeviceGetCurrentClocksEventReasons)
            if g.viol_t is None or now - g.viol_t >= VIOLATION_EVERY_S:
                elapsed = now - g.viol_t if g.viol_t is not None else 0.0
                g.viol_t = now
                for pol in (nv.NVML_PERF_POLICY_POWER, nv.NVML_PERF_POLICY_THERMAL):
                    v = self._read(g, f"viol{pol}", nv.nvmlDeviceGetViolationStatus, pol)
                    if v is None:
                        g.caps[pol] = None
                        continue
                    g.caps[pol] = violation_pct(g.prev_viol.get(pol), v.violationTime, elapsed)
                    g.prev_viol[pol] = v.violationTime
            out.append(
                GpuSample(
                    index=g.index,
                    util=util.gpu if util is not None else None,
                    sm_mhz=self._read(g, "sm", nv.nvmlDeviceGetClockInfo, nv.NVML_CLOCK_SM),
                    gr_mhz=self._read(g, "gr", nv.nvmlDeviceGetClockInfo, nv.NVML_CLOCK_GRAPHICS),
                    video_mhz=self._read(g, "video", nv.nvmlDeviceGetClockInfo, nv.NVML_CLOCK_VIDEO),
                    temp_c=self._read(g, "temp", nv.nvmlDeviceGetTemperature, nv.NVML_TEMPERATURE_GPU),
                    power_w=power_w,
                    energy_j=round(g.energy_j, 3) if g.energy_j is not None else None,
                    pstate=self._read(g, "pstate", nv.nvmlDeviceGetPerformanceState),
                    throttle_mask=mask,
                    power_capped_pct=g.caps.get(nv.NVML_PERF_POLICY_POWER),
                    thermal_capped_pct=g.caps.get(nv.NVML_PERF_POLICY_THERMAL),
                )
            )
            procs = self._read(g, "procs", nv.nvmlDeviceGetComputeRunningProcesses)
            if procs is not None:
                any_procs = True
                for pr in procs:
                    if isinstance(pr.usedGpuMemory, int):
                        proc_mem[pr.pid] = proc_mem.get(pr.pid, 0) + pr.usedGpuMemory
        self.proc_mem = proc_mem
        self.proc_mem_total = sum(proc_mem.values()) if any_procs else None
        return {"gpu": out}

    def _update_energy(self, g: _Gpu, now: float, power_w: float | None) -> None:
        if now - g.energy_t >= ENERGY_EVERY_S:
            mj = self._read(g, "energy", nv.nvmlDeviceGetTotalEnergyConsumption)
            if mj is not None:
                g.energy_t, g.energy_base, g.energy_integ = now, mj / 1000, 0.0
        elif g.energy_base is not None and power_w is not None and g.prev_t is not None:
            g.energy_integ += power_w * (now - g.prev_t)
        if g.energy_base is not None:
            g.energy_j = monotonic_energy(g.energy_j, g.energy_base + g.energy_integ)

    def process_util(self) -> dict[int, float]:
        """pid -> mean SM % over samples since the last call (best effort; empty if none)."""
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
