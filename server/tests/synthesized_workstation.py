"""A 4-GPU discrete NVIDIA workstation, synthesized from NVML's documented answers: no such machine is here.

`python tests/synthesized_workstation.py` (from server/) rewrites fixtures/platforms/workstation/;
test_synthesized_workstation.py fails when the committed files drift from what build() returns.
tests/platforms.py::workstation lays the directory over the GB10 recording's host files.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

import pynvml

OUT = Path(__file__).parent / "fixtures" / "platforms" / "workstation"
COMMAND = "python tests/synthesized_workstation.py"
NVML_H = "/usr/local/cuda-13.0/targets/sbsa-linux/include/nvml.h"
NVML_DOCS = "https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceQueries.html"
DATASHEET = "https://lenovopress.lenovo.com/LP1940"

GIB = 1 << 30
MIB = 1 << 20
GPUS = 4
NAME = "NVIDIA RTX 6000 Ada Generation"
VRAM_TOTAL = 48 * GIB
RESERVED = 512 * MIB
ENGINE_PID = 41187
WORKERS = [(41240 + 3 * i, (41_340 + 16 * i) * MIB) for i in range(GPUS)]  # (pid, usedGpuMemory)
NO_MIG = 0xFFFFFFFF
NOT_FOUND = {"__error__": pynvml.NVML_ERROR_NOT_FOUND, "str": "Not Found"}

MEMINFO_KB = {
    "MemTotal": 263_617_544,
    "MemFree": 119_540_168,
    "MemAvailable": 217_960_252,
    "Buffers": 1_048_576,
    "Cached": 100_663_296,
    "SwapCached": 0,
    "Active": 52_428_800,
    "Inactive": 83_886_080,
    "SwapTotal": 8_388_604,
    "SwapFree": 8_074_236,
    "AnonPages": 35_651_584,
    "Mapped": 4_194_304,
    "Shmem": 2_411_724,
    "Slab": 5_242_880,
    "SReclaimable": 3_145_728,
    "SUnreclaim": 2_097_152,
    "KernelStack": 61_440,
    "PageTables": 409_600,
    "VmallocTotal": 34_359_738_367,
    "VmallocUsed": 307_200,
    "HugePages_Total": 0,
}

ASSUMED = [
    "Host files are the GB10 recording's (CPU, disks, NICs, sensors, /proc/stat, hostname, host.json): "
    "tests/platforms.py::workstation lays this directory over them. Moving it onto the Threadripper "
    "recording of #77 is a follow-up",
    f"Four {NAME} cards with the datasheet's Ada architecture, compute capability 8.9, 18,176 CUDA cores, "
    "300 W board power and 48 GB of GDDR6, read as a v1 total of 48 GiB (a real card reports a little less)",
    "Each card's v1 used is its one worker's usedGpuMemory plus 512 MiB the driver reserves, and free is "
    "total less used",
    "One vLLM tensor-parallel worker per card (pids 41240, 41243, 41246, 41249) holding about 40.4 GiB each, "
    "about 161.6 GiB in all, more than the 43.5 GiB of system memory in use",
    "The workers' /proc/<pid>/stat values and cmdline, which is vLLM's process title VLLM::Worker_TP<i> "
    "(comm cut to 15 characters)",
    "Every /proc/meminfo value: 251 GiB of RAM, as ws1 in the demo, with AnonPages, Shmem and the kernel's "
    "share all inside the memory in use",
    "Every clock, temperature, threshold, power, energy, utilisation, fan, PCIe and violation reading",
    "ECC on; the driver 580.95.05, CUDA 13.0 and NVML 13.580.95.05, as ws1 in the demo",
    "nvmlDeviceGetProcessUtilization answers NOT_FOUND: no sample is newer than timestamp 0",
    "Placeholder GPU UUIDs GPU-00000000-0000-0000-0000-00000000000<i>",
]
META = {
    "assumed": ASSUMED,
    "built": (
        "Synthesized by server/tests/synthesized_workstation.py from NVML's documented answers; "
        "no real device was read"
    ),
    "device": f"Workstation with 4x {NAME}, serving one model with vLLM tensor parallel 4",
    "generated_by": COMMAND,
    "platform": "linux",
    "sources": {
        NVML_DOCS: "NVML device queries, the online reference nvml.h is published as",
        DATASHEET: f"{NAME}: Ada, 18,176 CUDA cores, 48 GB GDDR6, 300 W",
        f"{NVML_H}:250-260": "nvmlMemory_t (v1): total = free + used, and used is reserved plus allocated",
        f"{NVML_H}:262-274": "nvmlMemory_v2_t takes reserved out of used; the agent reads v1",
        f"{NVML_H}:278-286 and :7214-7240": (
            "BAR1, the CPU-visible aperture onto VRAM: its use is not VRAM use, so the agent does not read it"
        ),
        f"{NVML_H}:303-313": "nvmlProcessInfo_t: usedGpuMemory, and instance ids of 0xFFFFFFFF outside MIG",
        f"{NVML_H}:1496": "NVML_DEVICE_ARCH_ADA is 8",
        f"{NVML_H}:6286-6335": (
            "nvmlDeviceGetMemoryInfo, for all products: NOT_SUPPORTED on an iGPU without a framebuffer, "
            "NO_PERMISSION in MIG mode without privilege"
        ),
        f"{NVML_H}:6945-6985": (
            "nvmlDeviceGetComputeRunningProcesses: usedGpuMemory is all the memory the application uses"
        ),
        f"{NVML_H}:8040-8074": "nvmlDeviceGetProcessUtilization: NOT_FOUND when no sample is newer",
    },
    "synthesized": True,
}


def _fields(**values: Any) -> dict[str, Any]:
    return {"__fields__": values}


def nvml_calls() -> dict[str, dict[str, Any]]:
    calls: dict[str, dict[str, Any]] = {}

    def answer(fn: str, args: list[Any], value: Any) -> None:
        calls.setdefault(fn, {})[json.dumps(args)] = value

    answer("nvmlInit", [], None)
    answer("nvmlDeviceGetCount", [], GPUS)
    answer("nvmlSystemGetDriverVersion", [], "580.95.05")
    answer("nvmlSystemGetCudaDriverVersion_v2", [], 13000)
    answer("nvmlSystemGetNVMLVersion", [], "13.580.95.05")
    for i, (pid, held) in enumerate(WORKERS):
        h = f"gpu{i}"
        used = held + RESERVED
        answer("nvmlDeviceGetHandleByIndex", [i], h)
        answer("nvmlDeviceGetName", [h], NAME)
        answer("nvmlDeviceGetUUID", [h], f"GPU-00000000-0000-0000-0000-00000000000{i}")
        answer("nvmlDeviceGetArchitecture", [h], 8)
        answer("nvmlDeviceGetCudaComputeCapability", [h], [8, 9])
        answer("nvmlDeviceGetNumGpuCores", [h], 18176)
        answer("nvmlDeviceGetMaxClockInfo", [h, pynvml.NVML_CLOCK_SM], 3105)
        for threshold, c in (
            (pynvml.NVML_TEMPERATURE_THRESHOLD_SHUTDOWN, 96),
            (pynvml.NVML_TEMPERATURE_THRESHOLD_SLOWDOWN, 93),
            (pynvml.NVML_TEMPERATURE_THRESHOLD_GPU_MAX, 89),
        ):
            answer("nvmlDeviceGetTemperatureThreshold", [h, threshold], c)
        answer("nvmlDeviceGetUtilizationRates", [h], _fields(gpu=92 - i, memory=61 - i))
        for clock, mhz in (
            (pynvml.NVML_CLOCK_GRAPHICS, 2730 - 15 * i),
            (pynvml.NVML_CLOCK_SM, 2730 - 15 * i),
            (pynvml.NVML_CLOCK_MEM, 10001),
            (pynvml.NVML_CLOCK_VIDEO, 1965),
        ):
            answer("nvmlDeviceGetClockInfo", [h, clock], mhz)
        answer("nvmlDeviceGetTemperature", [h, pynvml.NVML_TEMPERATURE_GPU], 66 + 2 * i)
        answer("nvmlDeviceGetPowerUsage", [h], 271_500 - 4_250 * i)
        answer("nvmlDeviceGetTotalEnergyConsumption", [h], 41_873_215_442 + 1_000_003 * i)
        answer("nvmlDeviceGetCurrentClocksEventReasons", [h], 0)
        answer("nvmlDeviceGetPerformanceState", [h], 0)
        for policy, ns in ((pynvml.NVML_PERF_POLICY_POWER, 0), (pynvml.NVML_PERF_POLICY_THERMAL, 0)):
            answer(
                "nvmlDeviceGetViolationStatus",
                [h, policy],
                _fields(referenceTime=1_793_782_407_871_489, violationTime=ns),
            )
        answer(
            "nvmlDeviceGetComputeRunningProcesses",
            [h],
            [_fields(computeInstanceId=NO_MIG, gpuInstanceId=NO_MIG, pid=pid, usedGpuMemory=held)],
        )
        answer("nvmlDeviceGetPowerManagementLimit", [h], 300_000)
        answer("nvmlDeviceGetFanSpeed", [h], 41 + 3 * i)
        answer("nvmlDeviceGetMemoryInfo", [h], _fields(total=VRAM_TOTAL, free=VRAM_TOTAL - used, used=used))
        answer("nvmlDeviceGetEccMode", [h], [1, 1])
        answer("nvmlDeviceGetPcieThroughput", [h, pynvml.NVML_PCIE_UTIL_TX_BYTES], 1_843_200 + 1024 * i)
        answer("nvmlDeviceGetProcessUtilization", [h, 0], NOT_FOUND)
    return calls


def stat_line(pid: int, comm: str, ppid: int, utime: int, stime: int, start: int, rss_pages: int) -> str:
    """/proc/<pid>/stat as proc(5) lays it out: pid, (comm), then 50 fields."""
    fields = [
        "S", ppid, ppid, ppid, 0, -1, 4194560, 2_413_877, 0, 1_204, 0, utime, stime, 0, 0, 20, 0, 41, 0,
        start, 31_457_280_000, rss_pages, 18_446_744_073_709_551_615, 1, 1, 0, 0, 0, 0, 0, 16_781_312,
        16_386, 0, 0, 0, 17, 2, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]  # fmt: skip
    return f"{pid} ({comm}) {' '.join(map(str, fields))}\n"


def build() -> dict[str, str]:
    tree = {
        "nvml.json": json.dumps(nvml_calls(), indent=1, sort_keys=True) + "\n",
        "platform.json": json.dumps(META, indent=1, sort_keys=True) + "\n",
        "root/proc/meminfo": "".join(f"{k}:{v:>16} kB\n" for k, v in MEMINFO_KB.items()),
    }
    for i, (pid, _) in enumerate(WORKERS):
        stat = stat_line(
            pid, "VLLM::Worker_TP", ENGINE_PID, 912_345 + 811 * i, 40_211 + 37 * i, 18_432_117, 1_598_000
        )
        tree[f"root/proc/{pid}/stat"] = stat
        tree[f"root/proc/{pid}/cmdline"] = f"VLLM::Worker_TP{i}\0"
    return tree


def read_tree(directory: Path) -> dict[str, str]:
    return {
        Path(dirpath, name).relative_to(directory).as_posix(): Path(dirpath, name).read_text()
        for dirpath, _, names in os.walk(directory)
        for name in names
    }


def write(directory: Path, tree: dict[str, str]) -> None:
    if directory.exists():
        shutil.rmtree(directory)
    for rel, text in sorted(tree.items()):
        path = directory / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


if __name__ == "__main__":
    write(OUT, build())
    print(f"wrote {OUT}")
