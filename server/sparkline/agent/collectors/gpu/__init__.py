from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import get_args

from ....common.schema import LEGACY_VERSION_KEYS, GpuInfo, GpuSample, Unsupported, UnsupportedKind, Vendor
from ...sources import Sources
from .. import Caps, GpuField
from .backend import CannotOpen, Chain, Gap, GpuBackend, NoDevice
from .nvml import Nvml

CHAINS: dict[str, tuple[Chain, ...]] = {"linux": (Chain("nvidia", (Nvml,)),), "darwin": ()}

_MOST_ACTIONABLE: tuple[UnsupportedKind, ...] = ("access", "dependency", "agent", "hardware")


@dataclass(frozen=True)
class _Live:
    backend: GpuBackend
    base: int


@dataclass(frozen=True)
class _Failure:
    backend: str
    reason: str
    kind: UnsupportedKind
    vendor_absent: bool


def _failure(backend: str, e: Exception) -> _Failure:
    if isinstance(e, CannotOpen):
        return _Failure(backend, e.reason, e.kind, isinstance(e, NoDevice))
    kind: UnsupportedKind = "access" if isinstance(e, PermissionError) else "hardware"
    return _Failure(backend, f"{type(e).__name__}: {e}", kind, False)


def _gap(metric: str, failures: list[_Failure]) -> Unsupported:
    return Unsupported(
        metric=metric,
        reason="; ".join(f"{f.backend}: {f.reason}" for f in failures),
        kind=min((f.kind for f in failures), key=_MOST_ACTIONABLE.index),
    )


class GpuCollector:
    name = "gpu"
    prefixes = ("gpu*", "gpu.backend", "mem.gpu")

    def __init__(self, src: Sources) -> None:
        self.info: list[GpuInfo] = []
        self.versions: dict[str, str] = {}
        self.proc_mem: dict[int, int] = {}
        self.proc_mem_total: int | None = None
        self._live: list[_Live] = []
        self._caps: dict[str, Unsupported | None] = {}
        failures: list[_Failure] = []
        for chain in CHAINS.get(src.platform, ()):
            for make in chain.backends:
                try:
                    backend = make(src)
                    gpus = backend.open()
                    if not gpus:
                        raise NoDevice("Opened, but found no GPU")
                    caps = backend.caps()
                    versions = backend.versions()
                    for i, g in enumerate(gpus):
                        if g.index != i:
                            raise CannotOpen(f"open() numbered GPU {i} as {g.index}", "agent")
                except Exception as e:
                    failures.append(_failure(make.name, e))
                    continue
                self._adopt(chain.vendor, backend, gpus, caps)
                self.versions |= {f"{chain.vendor}.{label}": v for label, v in versions.items()}
                break
        if self.info:
            procs = [self._caps[f"gpu{g.index}.proc_mem"] for g in self.info]
            first = procs[0]
            self._caps["mem.gpu"] = (
                first.model_copy(update={"metric": "mem.gpu"}) if first and all(procs) else None
            )
            fallbacks = [f for f in failures if not f.vendor_absent]
            self._caps["gpu.backend"] = _gap("gpu.backend", fallbacks) if fallbacks else None
            return
        for metric in ("gpu*", "mem.gpu", "gpu.backend"):
            self._caps[metric] = (
                _gap(metric, failures)
                if failures
                else Unsupported(
                    metric=metric, reason=f"No GPU backend reads {src.platform} yet", kind="agent"
                )
            )

    def _adopt(
        self,
        vendor: Vendor,
        backend: GpuBackend,
        gpus: list[GpuInfo],
        caps: Mapping[int, Mapping[GpuField, Gap | None]],
    ) -> None:
        base = len(self.info)
        missing = Gap(f"Not reported by the {backend.name} backend", "agent")
        for g in gpus:
            index = base + g.index
            self.info.append(g.model_copy(update={"index": index, "vendor": vendor, "backend": backend.name}))
            gaps = caps.get(g.index, {})
            for field, gap in {**gaps, **{f: missing for f in get_args(GpuField) if f not in gaps}}.items():
                key = f"gpu{index}.{field}"
                self._caps[key] = Unsupported(metric=key, reason=gap.reason, kind=gap.kind) if gap else None
        self._live.append(_Live(backend, base))

    @property
    def driver(self) -> str | None:
        return self.versions.get(LEGACY_VERSION_KEYS["driver"])

    @property
    def cuda(self) -> str | None:
        return self.versions.get(LEGACY_VERSION_KEYS["cuda"])

    @property
    def nvml(self) -> str | None:
        return self.versions.get(LEGACY_VERSION_KEYS["nvml"])

    def caps(self) -> Caps:
        return self._caps

    def collect(self) -> dict[str, list[GpuSample]]:
        out = []
        proc_mem: dict[int, int] = {}
        reported = False
        for live in self._live:
            for s in live.backend.sample():
                out.append(s if live.base == 0 else s.model_copy(update={"index": live.base + s.index}))
            for pids in live.backend.proc_mem().values():
                reported = True
                for pid, used in pids.items():
                    proc_mem[pid] = proc_mem.get(pid, 0) + used
        self.proc_mem = proc_mem
        self.proc_mem_total = sum(proc_mem.values()) if reported else None
        return {"gpu": out}

    def process_util(self) -> dict[int, float]:
        acc: dict[int, list[float]] = {}
        for live in self._live:
            for pid, util in (live.backend.proc_util() or {}).items():
                acc.setdefault(pid, []).append(util)
        return {pid: sum(v) / len(v) for pid, v in acc.items()}
