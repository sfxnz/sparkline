"""NodeInfo assembly and the default collector set."""

from __future__ import annotations

import importlib.metadata
import logging
import platform

from ..common.schema import NodeInfo
from .collectors import Collector
from .collectors.cpu import CpuCollector
from .collectors.gpu import GpuCollector
from .collectors.memory import MemoryCollector
from .collectors.net import NetCollector
from .collectors.procs import ProcsCollector
from .collectors.storage import StorageCollector
from .collectors.thermal import ThermalCollector
from .config import AgentConfig
from .sources import RootFs, Sources

log = logging.getLogger(__name__)

try:
    AGENT_VERSION = importlib.metadata.version("sparkline")
except importlib.metadata.PackageNotFoundError:  # pragma: no cover
    AGENT_VERSION = "0.0.0"


def os_name(fs: RootFs) -> str:
    for line in (fs.read_once("/etc/os-release") or "").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return platform.system()


def boot_time(fs: RootFs) -> float:
    return next(
        float(line.split()[1]) for line in fs.read("/proc/stat").splitlines() if line.startswith("btime")
    )


def probe_tools(src: Sources) -> dict[str, bool]:
    def which(*names: str) -> bool:
        return any(src.which(n) for n in names)

    docker = which("docker")
    pytorch = False
    if docker:
        try:
            pytorch = any(
                t.startswith("nvcr.io/nvidia/pytorch:")
                for img in src.docker("/images/json")
                for t in (img.get("RepoTags") or [])
            )
        except (OSError, ValueError) as e:
            log.debug("docker image probe failed: %s", e)
    return {
        "docker": docker,
        "fio": which("fio"),
        "perftest": which("ib_write_bw"),
        "nccl_tests": which("all_reduce_perf"),
        "nvcc": which("nvcc") or bool(src.fs.glob("/usr/local/cuda*/bin/nvcc")),
        "pytorch_image": pytorch,
    }


class Collectors:
    def __init__(self, cfg: AgentConfig, src: Sources) -> None:
        self.fs = src.fs
        self.gpu = GpuCollector(src)
        self.memory = MemoryCollector(src, lambda: self.gpu.proc_mem_total)
        self.cpu = CpuCollector(src)
        self.net = NetCollector(src, cfg.peers, cfg.include_virtual)
        self.storage = StorageCollector(src)
        self.thermal = ThermalCollector(src)
        self.procs = ProcsCollector(src, self.gpu, cfg.procs_interval_s)
        self.tools = probe_tools(src)

    def ordered(self) -> list[Collector]:
        return [self.gpu, self.memory, self.cpu, self.net, self.storage, self.thermal, self.procs]

    def node_info(self, cfg: AgentConfig) -> NodeInfo:
        return NodeInfo(
            node_id=cfg.node_id,
            hostname=self.fs.read("/proc/sys/kernel/hostname").strip(),
            agent_version=AGENT_VERSION,
            os=os_name(self.fs),
            kernel=self.fs.read("/proc/sys/kernel/osrelease").strip(),
            driver=self.gpu.driver,
            cuda=self.gpu.cuda,
            nvml=self.gpu.nvml,
            cpu_model=self.cpu.model,
            cores=self.cpu.cores,
            mem_total=self.memory.mem_total,
            swap_total=self.memory.swap_total,
            gpus=self.gpu.info,
            net=self.net.info,
            disks=self.storage.info(),
            sensors=self.thermal.sensors,
            unsupported=self.gpu.unsupported + self.thermal.unsupported(),
            tools=self.tools,
            sample_interval_ms=cfg.interval_ms,
            boot_time=boot_time(self.fs),
        )
