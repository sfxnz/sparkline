from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

OUT = Path(__file__).parent / "fixtures" / "platforms"
COMMAND = "python tests/synthesized_platforms.py"
BUILT = (
    "Synthesized by server/tests/synthesized_platforms.py from documented sysfs layouts and kernel source; "
    "no real device was read"
)
KERNEL, OS = "6.14.0-35-generic", "Ubuntu 24.04.3 LTS"
LINUX = "https://github.com/torvalds/linux/blob/v6.14"
CPU_ABI = f"{LINUX}/Documentation/ABI/testing/sysfs-devices-system-cpu"
PLACEHOLDERS = (
    "Everything outside the CPU and its sensor is a placeholder: memory, disk, NIC, addresses, /proc/stat "
    "counters, load, pressure, hostname and boot time"
)
NO_NVIDIA = (
    "No NVIDIA driver: no /proc/driver/nvidia, and nvidia-ml-py's nvmlInit fails as it does without "
    "libnvidia-ml.so.1 (NVML_ERROR_LIBRARY_NOT_FOUND)"
)


@dataclass(frozen=True)
class Link:
    target: str


Tree = dict[str, str | Link]


@dataclass(frozen=True)
class Cpu:
    max_khz: int
    cur_khz: int
    cluster_id: int
    core_id: int | None = None


class Box:
    def __init__(self) -> None:
        self.tree: Tree = {}

    def file(self, path: str, text: str) -> None:
        self.tree[f"root{path}"] = text if text.endswith("\n") else text + "\n"

    def link(self, path: str, target: str) -> None:
        self.tree[f"root{path}"] = Link(os.path.relpath(target, os.path.dirname(path)))


def _json(obj: Any) -> str:
    return json.dumps(obj, indent=1, sort_keys=True) + "\n"


def _lines(*rows: tuple[object, ...]) -> str:
    return "\n".join(" ".join(map(str, row)) for row in rows)


def _cpus(
    box: Box, cpus: list[Cpu], model_name: str, vendor: str, family: int, model: int, cores: int
) -> None:
    sys_cpu = "/sys/devices/system/cpu"
    entries = []
    for i, c in enumerate(cpus):
        box.link(f"{sys_cpu}/cpu{i}/cpufreq", f"{sys_cpu}/cpufreq/policy{i}")
        box.file(f"{sys_cpu}/cpufreq/policy{i}/cpuinfo_max_freq", str(c.max_khz))
        box.file(f"{sys_cpu}/cpufreq/policy{i}/scaling_cur_freq", str(c.cur_khz))
        box.file(f"{sys_cpu}/cpu{i}/topology/cluster_id", str(c.cluster_id))
        lines = [
            ("processor", i),
            ("vendor_id", vendor),
            ("cpu family", family),
            ("model", model),
            ("model name", model_name),
            ("physical id", 0),
            ("siblings", len(cpus)),
            *([("core id", c.core_id)] if c.core_id is not None else []),
            ("cpu cores", cores),
        ]
        entries.append("".join(f"{k}\t: {v}\n" for k, v in lines))
    box.file("/proc/cpuinfo", "\n".join(entries))
    rows = [
        (4100 + 13 * i, 20 + i % 7, 900 + 5 * i, 880_000 - 11 * i, 60 + i % 5, 0, 30 + i % 3, 0, 0, 0)
        for i in range(len(cpus))
    ]
    total = [sum(col) for col in zip(*rows, strict=True)]
    stat = [f"cpu  {' '.join(map(str, total))}"] + [
        f"cpu{i} {' '.join(map(str, r))}" for i, r in enumerate(rows)
    ]
    stat += ["ctxt 912345678", "btime 1792800000", "processes 412345", "procs_running 2", "procs_blocked 0"]
    box.file("/proc/stat", "\n".join(stat))


def _host(box: Box, hostname: str, mem_kb: int, lan: tuple[str, str, int, str, str], nvme_pci: str) -> dict:
    name, lan_pci, speed, mac, ip = lan
    box.file("/proc/sys/kernel/hostname", hostname)
    box.file("/proc/sys/kernel/osrelease", KERNEL)
    box.link("/etc/os-release", "/usr/lib/os-release")
    box.file("/usr/lib/os-release", f'PRETTY_NAME="{OS}"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n')
    box.file("/proc/loadavg", "0.42 0.37 0.31 1/1203 48211")
    for res in ("cpu", "memory"):
        box.file(
            f"/proc/pressure/{res}",
            _lines(
                ("some", "avg10=0.00", "avg60=0.02", "avg300=0.01", "total=1840211"),
                ("full", "avg10=0.00", "avg60=0.00", "avg300=0.00", "total=0"),
            ),
        )
    free, cached = mem_kb * 9 // 10, mem_kb // 20
    meminfo = {
        "MemTotal": mem_kb,
        "MemFree": free,
        "MemAvailable": free + cached,
        "Buffers": 210_344,
        "Cached": cached,
        "SwapCached": 0,
        "SwapTotal": 8_388_604,
        "SwapFree": 8_388_604,
        "AnonPages": mem_kb // 40,
        "Shmem": 120_512,
        "Slab": 880_104,
        "KernelStack": 21_760,
        "PageTables": 40_220,
        "VmallocUsed": 98_304,
    }
    box.file("/proc/meminfo", "\n".join(f"{k}:{v:>16} kB" for k, v in meminfo.items()))

    nic = f"/sys/devices/{lan_pci}"
    box.link(f"/sys/class/net/{name}", f"{nic}/net/{name}")
    box.link(f"{nic}/net/{name}/device", nic)
    box.file(f"{nic}/net/{name}/operstate", "up")
    box.file(f"{nic}/net/{name}/speed", str(speed))
    box.link("/sys/class/net/lo", "/sys/devices/virtual/net/lo")
    box.file("/sys/devices/virtual/net/lo/operstate", "unknown")
    box.link("/proc/net", "/proc/self/net")
    box.file(
        "/proc/self/net/dev",
        _lines(
            ("Inter-|", "Receive", "|", "Transmit"),
            (
                " face",
                "|bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo",
            ),
            ("lo:", 18452231, 120344, 0, 0, 0, 0, 0, 0, 18452231, 120344, 0, 0, 0, 0, 0, 0),
            (f"{name}:", 9123456789, 7012345, 0, 12, 0, 0, 0, 40123, 1234567890, 3012345, 0, 0, 0, 0, 0, 0),
        ),
    )
    box.file(  # default route via 198.51.100.1, on 198.51.100.0/24
        "/proc/self/net/route",
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
        f"{name}\t00000000\t016433C6\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
        f"{name}\t006433C6\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
    )

    ctrl = f"/sys/devices/{nvme_pci}/nvme/nvme0"
    box.link("/sys/block/nvme0n1", f"{ctrl}/nvme0n1")
    box.link(f"{ctrl}/nvme0n1/device", ctrl)
    box.file(f"{ctrl}/model", "Samsung SSD 990 PRO 2TB")
    box.file(f"{ctrl}/nvme0n1/size", "3907029168")
    for n in (1, 2):
        box.file(f"{ctrl}/nvme0n1/nvme0n1p{n}/partition", str(n))
    box.file(
        "/proc/diskstats",
        _lines(
            (259, 0, "nvme0n1", 812345, 1023, 64123456, 201234, 456789, 345678, 98765432, 512345, 0, 401234)
            + (713579, 0, 0, 0, 0, 23456, 9876),
            (259, 1, "nvme0n1p1", 312, 0, 9876, 54, 2, 0, 2, 1, 0, 61, 55, 0, 0, 0, 0, 0, 0),
            (259, 2, "nvme0n1p2", 811900, 1023, 64100000, 201100, 456787, 345678, 98765430, 512344, 0, 401100)
            + (713444, 0, 0, 0, 0, 0, 0),
        ),
    )
    box.file(
        "/proc/self/mounts",
        _lines(
            ("sysfs", "/sys", "sysfs", "rw,nosuid,nodev,noexec,relatime", 0, 0),
            ("proc", "/proc", "proc", "rw,nosuid,nodev,noexec,relatime", 0, 0),
            ("tmpfs", "/run", "tmpfs", "rw,nosuid,nodev,noexec,relatime,mode=755,inode64", 0, 0),
            ("/dev/nvme0n1p2", "/", "ext4", "rw,relatime", 0, 0),
            ("/dev/nvme0n1p1", "/boot/efi", "vfat", "rw,relatime,fmask=0077,dmask=0077", 0, 0),
        ),
    )
    return {
        "docker": {},
        "ethtool": {},
        "net_if_addrs": {
            name: [
                {"address": ip, "family": "AF_INET", "netmask": "255.255.255.0"},
                {"address": mac, "family": "AF_LINK", "netmask": None},
            ],
            "lo": [
                {"address": "127.0.0.1", "family": "AF_INET", "netmask": "255.0.0.0"},
                {"address": "00:00:00:00:00:00", "family": "AF_LINK", "netmask": None},
            ],
        },
        "statvfs": {
            "/": [
                4096,
                4096,
                480_309_840,
                401_234_567,
                376_812_345,
                122_101_760,
                121_234_567,
                121_234_567,
                4096,
                255,
            ]
        },
        "which": dict.fromkeys(("all_reduce_perf", "docker", "fio", "ib_write_bw", "nvcc")),
    }


def _hwmon(box: Box, device: str, name: str, temps: dict[int, tuple[str, int, int | None]]) -> None:
    hw = f"{device}/hwmon/hwmon0"
    box.link("/sys/class/hwmon/hwmon0", hw)
    box.link(f"{hw}/device", device)
    box.file(f"{hw}/name", name)
    for i, (label, milli, crit) in temps.items():
        box.file(f"{hw}/temp{i}_label", label)
        box.file(f"{hw}/temp{i}_input", str(milli))
        if crit is not None:
            box.file(f"{hw}/temp{i}_crit", str(crit))


def _recording(box: Box, host: dict, meta: dict[str, Any]) -> Tree:
    nvml = {"nvmlInit": {"[]": {"__error__": 12, "str": "NVML Shared Library Not Found"}}}
    platform = {"built": BUILT, "generated_by": COMMAND, "platform": "linux", "synthesized": True, **meta}
    return {
        **box.tree,
        "host.json": _json(host),
        "nvml.json": _json(nvml),
        "platform.json": _json(platform),
    }


AMD_META = {
    "device": "AMD Ryzen Threadripper PRO 7975WX workstation (Zen 4, family 25 model 24), no NVIDIA driver",
    "sources": {
        "https://docs.kernel.org/hwmon/k10temp.html": "k10temp: Tctl on an arbitrary scale, Tdie, Tccd",
        f"{LINUX}/drivers/hwmon/k10temp.c": (
            "temp1 Tctl; temp2 Tdie only with a family 17h Tctl offset; family 19h models 10h-1Fh probe "
            "Tccd1-12 as temp3-14; labels on Zen; no max or crit on Zen"
        ),
        f"{LINUX}/arch/x86/kernel/cpu/cacheinfo.c": "only init_intel_cacheinfo sets l2c_id (cluster_id)",
        f"{LINUX}/arch/x86/kernel/cpu/topology_common.c": "l2c_id defaults to BAD_APICID (65535)",
        CPU_ABI: "cpu_capacity, from drivers/base/arch_topology.c, which x86 does not build",
        f"{LINUX}/drivers/cpufreq/cpufreq.c": "no cpuinfo_avg_freq in 6.14, so scaling_cur_freq",
    },
    "assumed": [
        "CPU numbering: cpu0-31 the 32 cores' first threads, cpu32-63 their SMT siblings",
        "The four CCDs report in slots Tccd1-4 (k10temp shows each of its 12 slots that reads valid)",
        "cpuinfo_max_freq 5300000 (the 5.3 GHz boost) on every CPU, and the scaling_cur_freq values",
        "cluster_id 65535 on every CPU, read from the code paths above, not observed on a 7975WX",
        "No cpu_capacity and no hybrid PMU, read from the code, not observed",
        "Every temperature",
        NO_NVIDIA,
        PLACEHOLDERS,
    ],
}


def amd_threadripper() -> Tree:
    box = Box()
    cpus = [Cpu(5_300_000, 3_000_000 + 37_000 * (i % 23), 65535) for i in range(64)]
    _cpus(box, cpus, "AMD Ryzen Threadripper PRO 7975WX 32-Cores", "AuthenticAMD", 25, 24, 32)
    lan = ("enp68s0f0", "pci0000:40/0000:40:01.1/0000:44:00.0", 10000, "02:00:00:00:01:01", "198.51.100.20")
    host = _host(box, "ws-amd", 263_617_544, lan, "pci0000:00/0000:00:01.1/0000:01:00.0")
    tccd = {3: 51_250, 4: 53_500, 5: 49_750, 6: 54_000}
    _hwmon(
        box,
        "/sys/devices/pci0000:00/0000:00:18.3",
        "k10temp",
        {1: ("Tctl", 58_375, None), **{i: (f"Tccd{i - 2}", t, None) for i, t in tccd.items()}},
    )
    return _recording(box, host, AMD_META)


INTEL_META = {
    "device": "13th Gen Intel Core i9-13900K desktop (Raptor Lake, family 6 model 183), no NVIDIA driver",
    "sources": {
        f"{LINUX}/tools/perf/Documentation/intel-hybrid.txt": "/sys/devices/cpu_core and cpu_atom, with cpus",
        f"{LINUX}/arch/x86/events/intel/core.c": (
            "intel_hybrid_pmu_type_map: the cpu_core, cpu_atom and cpu_lowpower PMUs"
        ),
        "https://docs.kernel.org/hwmon/coretemp.html": "coretemp: per-core and package sensors, crit = TjMax",
        f"{LINUX}/drivers/hwmon/coretemp.c": (
            'temp1 "Package id N"; "Core N" of the core id at temp(core id + 2), so sparse core ids leave '
            'gaps; the docs\' "Physical id" label is older text'
        ),
        f"{LINUX}/arch/x86/kernel/cpu/cacheinfo.c": (
            "cluster_id (l2c_id): the APIC id with the L2-sharing bits cleared"
        ),
        CPU_ABI: "cpu_capacity, from drivers/base/arch_topology.c, which x86 does not build",
        f"{LINUX}/drivers/cpufreq/cpufreq.c": "no cpuinfo_avg_freq in 6.14, so scaling_cur_freq",
    },
    "assumed": [
        "CPU numbering: cpu0-15 the P-cores' threads (siblings 2k, 2k+1), cpu16-31 the E-cores",
        "core id 4k for P-core k and 32-47 for the E-cores (APIC ids 8k, and 64 + 2j for E-core j)",
        "cluster_id 8k for P-core k and 64 + 8m for E-core module m (2 threads or 4 E-cores per L2)",
        "cpuinfo_max_freq 5800000 on the two favoured P-cores (cpu4-7), 5500000 on the other P-cores, "
        "4300000 on the E-cores, and the scaling_cur_freq values",
        "TjMax 100 C (temp*_crit) and every temperature",
        NO_NVIDIA,
        PLACEHOLDERS,
    ],
}


def intel_hybrid() -> Tree:
    box = Box()
    p_cores = [
        Cpu(5_800_000 if k in (2, 3) else 5_500_000, 1_100_000 + 300_000 * (k % 3), 8 * k, 4 * k)
        for k in range(8)
        for _ in range(2)
    ]
    e_cores = [Cpu(4_300_000, 800_000 + 100_000 * (j % 4), 64 + 8 * (j // 4), 32 + j) for j in range(16)]
    cpus = p_cores + e_cores
    _cpus(box, cpus, "13th Gen Intel(R) Core(TM) i9-13900K", "GenuineIntel", 6, 183, 24)
    for pmu, cpulist in (("cpu_core", "0-15"), ("cpu_atom", "16-31")):
        box.file(f"/sys/devices/{pmu}/cpus", cpulist)
        box.link(f"/sys/bus/event_source/devices/{pmu}", f"/sys/devices/{pmu}")
    lan = ("enp5s0", "pci0000:00/0000:00:1c.0/0000:05:00.0", 2500, "02:00:00:00:02:01", "198.51.100.21")
    host = _host(box, "ws-intel", 65_617_084, lan, "pci0000:00/0000:00:06.0/0000:01:00.0")
    core_temps = [45_000 + 1_000 * k for k in range(8)] + [41_000 + 750 * (j % 4) for j in range(16)]
    temps = {1: ("Package id 0", max(core_temps), 100_000)}
    for c, milli in zip(p_cores[::2] + e_cores, core_temps, strict=True):
        temps[c.core_id + 2] = (f"Core {c.core_id}", milli, 100_000)
    _hwmon(box, "/sys/devices/platform/coretemp.0", "coretemp", temps)
    return _recording(box, host, INTEL_META)


PLATFORMS: dict[str, Callable[[], Tree]] = {
    "amd-threadripper": amd_threadripper,
    "intel-hybrid": intel_hybrid,
}


def build() -> dict[str, Tree]:
    return {name: make() for name, make in PLATFORMS.items()}


def read_tree(directory: Path) -> Tree:
    out: Tree = {}
    for dirpath, dirnames, filenames in os.walk(directory):
        for name in dirnames + filenames:
            path = Path(dirpath) / name
            rel = path.relative_to(directory).as_posix()
            if path.is_symlink():
                out[rel] = Link(os.readlink(path))
            elif path.is_file():
                out[rel] = path.read_text()
    return out


def write(directory: Path, tree: Tree) -> None:
    if directory.exists():
        shutil.rmtree(directory)
    for rel, entry in sorted(tree.items()):
        path = directory / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(entry, Link):
            path.symlink_to(entry.target)
        else:
            path.write_text(entry)


if __name__ == "__main__":
    for name, tree in build().items():
        write(OUT / name, tree)
        print(f"wrote {OUT / name}")
