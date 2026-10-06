"""NodeInfo assembly and the default collector set."""

from __future__ import annotations

import glob
import importlib.metadata
import logging
import platform
import shutil
import socket

import psutil

from ..common.schema import NodeInfo
from .collectors.cpu import CpuCollector
from .collectors.gpu import GpuCollector
from .collectors.memory import MemoryCollector
from .collectors.net import NetCollector
from .collectors.procs import ProcsCollector, docker_get
from .collectors.storage import StorageCollector
from .collectors.thermal import ThermalCollector
from .config import AgentConfig

log = logging.getLogger(__name__)

try:
    AGENT_VERSION = importlib.metadata.version("sparkline")
except importlib.metadata.PackageNotFoundError:  # pragma: no cover
    AGENT_VERSION = "0.0.0"


def os_name() -> str:
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.system()


def probe_tools() -> dict[str, bool]:
    def which(*names: str) -> bool:
        return any(shutil.which(n) for n in names)

    docker = which("docker")
    pytorch = False
    if docker:
        try:
            pytorch = any(
                t.startswith("nvcr.io/nvidia/pytorch:")
                for img in docker_get("/images/json")
                for t in (img.get("RepoTags") or [])
            )
        except (OSError, ValueError) as e:
            log.debug("docker image probe failed: %s", e)
    return {
        "docker": docker,
        "fio": which("fio"),
        "perftest": which("ib_write_bw"),
        "nccl_tests": which("all_reduce_perf"),
        "nvcc": which("nvcc") or bool(glob.glob("/usr/local/cuda*/bin/nvcc")),
        "pytorch_image": pytorch,
    }


class Collectors:
    """Builds the real collectors in tick order (GPU first: memory and procs reuse its per-process data)."""

    def __init__(self, cfg: AgentConfig) -> None:
        self.gpu = GpuCollector()
        self.memory = MemoryCollector(lambda: self.gpu.proc_mem_total)
        self.cpu = CpuCollector()
        self.net = NetCollector(cfg.peers, cfg.include_virtual)
        self.storage = StorageCollector()
        self.thermal = ThermalCollector()
        self.procs = ProcsCollector(self.gpu, cfg.procs_interval_s)
        self.tools = probe_tools()

    def ordered(self) -> list:
        return [self.gpu, self.memory, self.cpu, self.net, self.storage, self.thermal, self.procs]

    def node_info(self, cfg: AgentConfig) -> NodeInfo:
        return NodeInfo(
            node_id=cfg.node_id,
            hostname=socket.gethostname(),
            agent_version=AGENT_VERSION,
            os=os_name(),
            kernel=platform.release(),
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
            boot_time=psutil.boot_time(),
        )
