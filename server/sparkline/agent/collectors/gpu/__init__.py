from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, get_args

from ....common.metrics import GPU_TOTALS
from ....common.schema import LEGACY_VERSION_KEYS, GpuInfo, GpuSample, Unsupported, UnsupportedKind, Vendor
from ...sources import Sources
from .. import Caps, GpuField
from .backend import CannotOpen, Chain, Gap, GpuBackend, NoDevice
from .nvml import Nvml

log = logging.getLogger(__name__)

CHAINS: dict[str, tuple[Chain, ...]] = {"linux": (Chain("nvidia", (Nvml,)),), "darwin": ()}

_MOST_ACTIONABLE: tuple[UnsupportedKind, ...] = ("access", "dependency", "agent", "hardware")

# A healthy tick reads every backend in milliseconds, so 5 s means a read is wedged (a hung driver call).
# It is far inside systemd's 90 s stop timeout, so the agent still exits on its own instead of being killed.
CLOSE_WAIT_S = 5.0


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


def _failure(backend: str, e: Exception, root: str) -> _Failure:
    if isinstance(e, CannotOpen):
        return _Failure(backend, e.reason, e.kind, isinstance(e, NoDevice))
    if isinstance(e, OSError):
        path = str(e.filename).removeprefix(root) if e.filename else None
        if isinstance(e, PermissionError):
            reason = f"Needs access to {path}" if path else f"Not permitted ({e.strerror or e})"
            return _Failure(backend, reason, "access", False)
        if path:
            return _Failure(backend, f"Could not open {path} ({e.strerror})", "hardware", False)
    return _Failure(backend, f"Failed unexpectedly ({type(e).__name__}: {e})", "hardware", False)


def _versions_after_failed_open(backend: GpuBackend) -> Mapping[str, str]:
    try:
        return backend.versions()
    except Exception as e:
        log.debug("%s versions after a failed open: %s", backend.name, e)
        return {}


def _close(backend: GpuBackend) -> None:
    try:
        backend.close()
    except Exception as e:
        log.warning("closing the %s backend failed: %s", backend.name, e)


def _labelled(vendor: Vendor, versions: Mapping[str, str]) -> dict[str, str]:
    return {f"{vendor}.{label}": v for label, v in versions.items()}


def _joined(metric: str, failures: list[_Failure]) -> Unsupported:
    return Unsupported(
        metric=metric,
        reason="; ".join(f"{f.backend}: {f.reason}" for f in failures),
        kind=min((f.kind for f in failures), key=_MOST_ACTIONABLE.index),
    )


class GpuCollector:
    name = "gpu"
    prefixes = ("gpu*", "gpu.backend", "mem.gpu", *(f"gpu.{f}" for f in GPU_TOTALS))

    def __init__(self, src: Sources) -> None:
        self.info: list[GpuInfo] = []
        self.versions: dict[str, str] = {}
        self.proc_mem: dict[int, int] = {}
        self.proc_mem_total: int | None = None
        self._live: list[_Live] = []
        self._caps: dict[str, Unsupported | None] = {}
        self._lock = threading.Lock()
        self._reading: GpuBackend | None = None
        try:
            self._open(src)
        except BaseException:
            self.close()
            raise

    def _open(self, src: Sources) -> None:
        chains = CHAINS.get(src.platform, ())
        names = [b.name for chain in chains for b in chain.backends]
        if len(set(names)) < len(names):
            raise ValueError(f"GPU backend names must be unique on {src.platform}: {', '.join(names)}")
        failures: list[_Failure] = []
        for chain in chains:
            for make in chain.backends:
                try:
                    backend = make(src)
                except Exception as e:
                    failures.append(_failure(make.name, e, src.fs.root))
                    continue
                try:
                    gpus = backend.open()
                    if not gpus:
                        raise NoDevice("Opened, but found no GPU")
                    caps = backend.caps()
                    versions = backend.versions()
                    for i, g in enumerate(gpus):
                        if g.index != i:
                            raise CannotOpen(f"open() numbered GPU {i} as {g.index}", "agent")
                except Exception as e:
                    failures.append(_failure(make.name, e, src.fs.root))
                    self.versions |= _labelled(chain.vendor, _versions_after_failed_open(backend))
                    _close(backend)
                    continue
                self._adopt(chain.vendor, backend, gpus, caps)
                self.versions |= _labelled(chain.vendor, versions)
                break
        if self.info:
            procs = [self._caps[f"gpu{g.index}.proc_mem"] for g in self.info]
            first = procs[0]
            self._caps["mem.gpu"] = (
                first.model_copy(update={"metric": "mem.gpu"}) if first and all(procs) else None
            )
            self._caps["gpu.backend"] = None
            for field in GPU_TOTALS:
                self._caps[f"gpu.{field}"] = self._total_gap(field)
            failures = [f for f in failures if not f.vendor_absent]
        else:
            none = Unsupported(metric="gpu*", reason=f"No GPU backend reads {src.platform} yet", kind="agent")
            gap = _joined("gpu*", failures) if failures else none
            self._caps["gpu*"] = gap
            self._caps["mem.gpu"] = gap.model_copy(update={"metric": "mem.gpu"})
            absent = failures and all(f.vendor_absent for f in failures)
            self._caps["gpu.backend"] = None if absent else gap.model_copy(update={"metric": "gpu.backend"})
            for field in GPU_TOTALS:
                self._caps[f"gpu.{field}"] = gap.model_copy(update={"metric": f"gpu.{field}"})
        for f in failures:
            metric = f"gpu.backend.{f.backend}"
            self._caps[metric] = Unsupported(metric=metric, reason=f.reason, kind=f.kind)

    def _total_gap(self, field: str) -> Unsupported | None:
        every = GPU_TOTALS[field].needs_every_gpu
        gaps = [(g.index, gap) for g in self.info if (gap := self._caps[f"gpu{g.index}.{field}"])]
        if not gaps or (not every and len(gaps) < len(self.info)):
            return None
        index, gap = gaps[0]
        reason = f"GPU {index}: {gap.reason}" if every and len(self.info) > 1 else gap.reason
        return gap.model_copy(update={"metric": f"gpu.{field}", "reason": reason})

    def _adopt(
        self,
        vendor: Vendor,
        backend: GpuBackend,
        gpus: list[GpuInfo],
        caps: Mapping[int, Mapping[GpuField, Gap | None] | Gap],
    ) -> None:
        base = len(self.info)
        self._live.append(_Live(backend, base))
        missing = Gap(f"Not reported by the {backend.name} backend", "agent")
        for g in gpus:
            index = base + g.index
            self.info.append(g.model_copy(update={"index": index, "vendor": vendor, "backend": backend.name}))
            gaps = caps.get(g.index, {})
            if isinstance(gaps, Gap):
                key = f"gpu{index}"
                self._caps[key] = Unsupported(metric=key, reason=gaps.reason, kind=gaps.kind)
                gaps = dict.fromkeys(get_args(GpuField), gaps)
            for field, gap in {**gaps, **{f: missing for f in get_args(GpuField) if f not in gaps}}.items():
                key = f"gpu{index}.{field}"
                self._caps[key] = Unsupported(metric=key, reason=gap.reason, kind=gap.kind) if gap else None

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

    def collect(self) -> dict[str, Any]:
        with self._lock:
            return self._collect()

    def _collect(self) -> dict[str, Any]:
        out: list[GpuSample] = []
        proc_mem: dict[int, int] = {}
        reported = False
        failed: list[str] = []
        for live in self._live:
            self._reading = live.backend
            try:
                samples = live.backend.sample()
                procs = live.backend.proc_mem()
            except Exception as e:
                log.debug("%s backend failed a tick", live.backend.name, exc_info=True)
                failed.append(f"{live.backend.name}: {type(e).__name__}: {e}")
                continue
            finally:
                self._reading = None
            out += [
                s if live.base == 0 else s.model_copy(update={"index": live.base + s.index}) for s in samples
            ]
            for pids in procs.values():
                reported = True
                for pid, used in pids.items():
                    proc_mem[pid] = proc_mem.get(pid, 0) + used
        self.proc_mem = proc_mem
        self.proc_mem_total = sum(proc_mem.values()) if reported else None
        return {"gpu": out, "errors": {"gpu": "; ".join(failed)}} if failed else {"gpu": out}

    def close(self) -> None:
        """Close every backend once a tick in progress returns. A read that hangs (a wedged GPU) delays
        shutdown by up to CLOSE_WAIT_S; then every backend except the one still reading is closed, and that
        one is left open, since closing a library under a call still inside it is not safe."""
        if not self._live:
            return
        locked = self._lock.acquire(timeout=CLOSE_WAIT_S)
        try:
            stuck = None if locked else self._reading
            live = list(self._live)
            # In place: a tick still iterating this list stops after its stuck read, before a closed backend.
            self._live.clear()
        finally:
            if locked:
                self._lock.release()
        if stuck is not None:
            log.warning(
                "the %s backend is still inside a read after %g s; closing the other backends without it",
                stuck.name,
                CLOSE_WAIT_S,
            )
        for each in live:
            if each.backend is not stuck:
                _close(each.backend)

    def process_util(self) -> dict[int, float]:
        acc: dict[int, list[float]] = {}
        with self._lock:
            for live in self._live:
                self._reading = live.backend
                try:
                    utils = live.backend.proc_util() or {}
                except Exception as e:
                    log.debug("%s backend process utilisation failed: %s", live.backend.name, e)
                    continue
                finally:
                    self._reading = None
                for pid, util in utils.items():
                    acc.setdefault(pid, []).append(util)
        return {pid: sum(v) / len(v) for pid, v in acc.items()}
