from __future__ import annotations

from fnmatch import fnmatchcase
from functools import cache
from typing import Literal

Holds = Literal["text", "entry", "binary"]

# The capture writes only what this list allows, so adding an entry is the privacy review when collectors
# grow the read set (#21 to #28). No file an entry matches may hold an identifier that the redaction misses.
PATHS: dict[str, Holds] = {
    "/proc/*": "entry",
    "/proc/[0-9]*/cgroup": "text",
    "/proc/[0-9]*/cmdline": "text",
    "/proc/[0-9]*/stat": "text",
    "/proc/cpuinfo": "text",
    "/proc/diskstats": "text",
    "/proc/driver/nvidia": "entry",
    "/proc/loadavg": "text",
    "/proc/meminfo": "text",
    "/proc/net/dev": "text",
    "/proc/net/route": "text",
    "/proc/pressure/cpu": "text",
    "/proc/pressure/memory": "text",
    "/proc/self/mounts": "text",
    "/proc/self/net/dev": "text",
    "/proc/self/net/route": "text",
    "/proc/stat": "text",
    "/proc/sys/kernel/hostname": "text",
    "/proc/sys/kernel/osrelease": "text",
    "/etc/os-release": "text",
    "/usr/lib/os-release": "text",
    "/etc/alternatives/cuda*": "entry",
    "/usr/local/cuda*/bin/nvcc": "entry",
    "/sys/devices/system/cpu/cpu[0-9]*/topology/cluster_id": "text",
    "/sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_avg_freq": "text",
    "/sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq": "text",
    "/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq": "text",
    "/sys/devices/system/cpu/cpufreq/policy[0-9]*/cpuinfo_avg_freq": "text",
    "/sys/devices/system/cpu/cpufreq/policy[0-9]*/cpuinfo_max_freq": "text",
    "/sys/devices/system/cpu/cpufreq/policy[0-9]*/scaling_cur_freq": "text",
    "/sys/class/hwmon/hwmon*": "entry",
    "/sys/devices/**/hwmon*/*": "entry",
    "/sys/devices/**/hwmon*/name": "text",
    "/sys/devices/**/hwmon*/temp*_crit": "text",
    "/sys/devices/**/hwmon*/temp*_input": "text",
    "/sys/devices/**/hwmon*/temp*_label": "text",
    "/sys/class/net/*": "entry",
    "/sys/devices/**/net/*/operstate": "text",
    "/sys/devices/**/net/*/phys_port_name": "text",
    "/sys/devices/**/net/*/phys_switch_id": "text",
    "/sys/devices/**/net/*/speed": "text",
    "/sys/class/infiniband/*": "entry",
    "/sys/devices/**/infiniband/*/sys_image_guid": "text",
    "/sys/devices/**/infiniband/*/ports/1/rate": "text",
    "/sys/devices/**/infiniband/*/ports/1/state": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/link_downed": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/local_link_integrity_errors": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/port_rcv_data": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/port_rcv_errors": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/port_xmit_data": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/port_xmit_discards": "text",
    "/sys/devices/**/infiniband/*/ports/1/counters/symbol_error": "text",
    "/sys/devices/**/infiniband/*/ports/1/hw_counters/local_ack_timeout_err": "text",
    "/sys/devices/**/infiniband/*/ports/1/hw_counters/out_of_sequence": "text",
    "/sys/devices/**/infiniband/*/ports/1/hw_counters/packet_seq_err": "text",
    "/sys/block/*": "entry",
    "/sys/devices/**/nvme[0-9]*n[0-9]*/size": "text",
    "/sys/devices/**/block/*/size": "text",
    "/sys/devices/**/nvme[0-9]*/model": "text",
    "/sys/devices/**/nvme-subsys[0-9]*/model": "text",
    "/sys/devices/**/[0-9]*:[0-9]*:[0-9]*:[0-9]*/model": "text",
}
NVML_CALLS = frozenset(
    {
        "nvmlDeviceGetArchitecture",
        "nvmlDeviceGetClockInfo",
        "nvmlDeviceGetComputeRunningProcesses",
        "nvmlDeviceGetCount",
        "nvmlDeviceGetCudaComputeCapability",
        "nvmlDeviceGetCurrentClocksEventReasons",
        "nvmlDeviceGetEccMode",
        "nvmlDeviceGetFanSpeed",
        "nvmlDeviceGetHandleByIndex",
        "nvmlDeviceGetMaxClockInfo",
        "nvmlDeviceGetMemoryInfo",
        "nvmlDeviceGetName",
        "nvmlDeviceGetNumGpuCores",
        "nvmlDeviceGetPcieThroughput",
        "nvmlDeviceGetPerformanceState",
        "nvmlDeviceGetPowerManagementLimit",
        "nvmlDeviceGetPowerUsage",
        "nvmlDeviceGetProcessUtilization",
        "nvmlDeviceGetTemperature",
        "nvmlDeviceGetTemperatureThreshold",
        "nvmlDeviceGetTotalEnergyConsumption",
        "nvmlDeviceGetUUID",
        "nvmlDeviceGetUtilizationRates",
        "nvmlDeviceGetViolationStatus",
        "nvmlInit",
        "nvmlSystemGetCudaDriverVersion_v2",
        "nvmlSystemGetDriverVersion",
        "nvmlSystemGetNVMLVersion",
    }
)
HOST_READINGS = frozenset({"net_if_addrs", "statvfs", "ethtool", "docker", "which"})
DOCKER_APIS = frozenset({"/images/json", "/containers/json"})
IDENTIFIER_FIELDS = frozenset(
    {
        "node_info.hostname",
        "node_info.node_id",
        "node_info.gpus[*].uuid",
        "node_info.net[*].name",
        "node_info.net[*].label",
        "node_info.net[*].mac",
        "node_info.net[*].ipv4",
        "node_info.net[*].peer",
        "node_info.disks[*].mounts",
        "procs[*].user",
        "procs[*].container",
        "procs[*].model",
        "procs[*].cmdline",
    }
)


def admits(holds: Holds, data: bytes) -> bool:
    if holds == "entry":
        return not data
    if holds == "text":
        try:
            data.decode()
        except UnicodeDecodeError:
            return False
    return True


def _parts(path: str) -> tuple[str, ...]:
    return tuple(p for p in path.split("/") if p)


_PATTERNS = [(pattern, _parts(pattern), holds) for pattern, holds in PATHS.items()]


def _match(path: tuple[str, ...], pattern: tuple[str, ...], prefix: bool) -> bool:
    if not path:
        return prefix or all(p == "**" for p in pattern)
    if not pattern:
        return False
    if pattern[0] == "**":
        return _match(path, pattern[1:], prefix) or _match(path[1:], pattern, prefix)
    return fnmatchcase(path[0], pattern[0]) and _match(path[1:], pattern[1:], prefix)


@cache
def matching(path: str) -> tuple[tuple[str, Holds], ...]:
    parts = _parts(path)
    return tuple((pattern, holds) for pattern, pat, holds in _PATTERNS if _match(parts, pat, prefix=False))


@cache
def leads_to(path: str) -> bool:
    parts = _parts(path)
    return any(_match(parts, pat, prefix=True) for _, pat, _ in _PATTERNS)
