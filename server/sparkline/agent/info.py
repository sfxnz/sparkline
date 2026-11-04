"""NodeInfo assembly and the default collector set."""

from __future__ import annotations

import importlib.metadata
import logging
import platform
from collections.abc import Callable
from typing import TypeVar

from ..common.schema import NodeInfo, Unsupported, UnsupportedKind
from .collectors import VOCABULARY, Collector, declares
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

C = TypeVar("C", bound=Collector)

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


def startup_gaps(name: str, prefixes: list[str], e: Exception, root: str) -> list[Unsupported]:
    if isinstance(e, OSError) and e.filename:
        path = str(e.filename).removeprefix(root)
        reason = (
            f"Needs read access to {path}"
            if isinstance(e, PermissionError)
            else f"The {name} collector could not start: {path}: {e.strerror}"
        )
    else:
        reason = f"The {name} collector could not start: {type(e).__name__}: {e}"
    kind: UnsupportedKind = "access" if isinstance(e, PermissionError) else "hardware"
    return [Unsupported(metric=p, reason=reason, kind=kind) for p in prefixes]


class Collectors:
    """Builds the real collectors in tick order (GPU first: memory and procs reuse its per-process data)."""

    def __init__(self, cfg: AgentConfig, src: Sources) -> None:
        self.fs = src.fs
        self.failed: list[Unsupported] = []
        self.gpu = self._start("gpu", ["gpu*", "mem.gpu"], lambda: GpuCollector(src))
        self.memory = self._start("memory", ["mem"], lambda: MemoryCollector(src, self._gpu_mem))
        self.cpu = self._start("cpu", ["cpu"], lambda: CpuCollector(src))
        self.net = self._start("net", ["net"], lambda: NetCollector(src, cfg.peers, cfg.include_virtual))
        self.storage = self._start("storage", ["disk", "fs"], lambda: StorageCollector(src))
        self.thermal = self._start(
            "thermal", ["temp", "cpu.temp", "fan", "system.power_w"], lambda: ThermalCollector(src)
        )
        self.procs = self._start(
            "procs", ["procs"], lambda: ProcsCollector(src, self.gpu, cfg.procs_interval_s)
        )
        self.tools = probe_tools(src)

    def _start(self, name: str, prefixes: list[str], make: Callable[[], C]) -> C | None:
        """Build one collector. One that raises is left out and its metric prefixes are declared unsupported,
        so a missing file or permission takes down that collector only, not the agent."""
        try:
            return make()
        except Exception as e:
            log.warning("collector %s could not start: %s", name, e)
            log.debug("collector %s could not start", name, exc_info=True)
            self.failed += startup_gaps(name, prefixes, e, self.fs.root)
            return None

    def _gpu_mem(self) -> int | None:
        return self.gpu.proc_mem_total if self.gpu else None

    def ordered(self) -> list[Collector]:
        built = [self.gpu, self.memory, self.cpu, self.net, self.storage, self.thermal, self.procs]
        return [c for c in built if c is not None]

    def unsupported(self) -> list[Unsupported]:
        caps = [(key, gap) for c in self.ordered() for key, gap in c.caps().items()]
        declared = [key for key, _ in caps] + [u.metric for u in self.failed]
        silent = [
            Unsupported(metric=key, reason=f"Not reported by the {owner} collector", kind="agent")
            for key, owner in VOCABULARY.items()
            if not any(declares(d, key) for d in declared)
        ]
        return [gap for _, gap in caps if gap] + self.failed + silent

    def node_info(self, cfg: AgentConfig) -> NodeInfo:
        return NodeInfo(
            node_id=cfg.node_id,
            hostname=self.fs.read("/proc/sys/kernel/hostname").strip(),
            agent_version=AGENT_VERSION,
            os=os_name(self.fs),
            kernel=self.fs.read("/proc/sys/kernel/osrelease").strip(),
            driver=self.gpu.driver if self.gpu else None,
            cuda=self.gpu.cuda if self.gpu else None,
            nvml=self.gpu.nvml if self.gpu else None,
            cpu_model=self.cpu.model if self.cpu else "unknown CPU",
            cores=self.cpu.cores if self.cpu else [],
            mem_total=self.memory.mem_total if self.memory else 0,
            swap_total=self.memory.swap_total if self.memory else 0,
            gpus=self.gpu.info if self.gpu else [],
            net=self.net.info if self.net else [],
            disks=self.storage.info() if self.storage else [],
            sensors=self.thermal.sensors if self.thermal else [],
            unsupported=self.unsupported(),
            tools=self.tools,
            sample_interval_ms=cfg.interval_ms,
            boot_time=boot_time(self.fs),
        )
