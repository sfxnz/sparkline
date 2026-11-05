from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import ClassVar, NamedTuple, Protocol

from ....common.schema import GpuInfo, GpuSample, UnsupportedKind, Vendor
from ...sources import Sources
from .. import GpuField


@dataclass(frozen=True)
class Gap:
    reason: str
    kind: UnsupportedKind = "hardware"


class CannotOpen(Exception):
    def __init__(self, reason: str, kind: UnsupportedKind = "hardware") -> None:
        super().__init__(reason)
        self.reason = reason
        self.kind = kind


class NoDevice(CannotOpen):
    def __init__(self, reason: str) -> None:
        super().__init__(reason, "hardware")


class GpuBackend(Protocol):
    name: ClassVar[str]

    def __init__(self, src: Sources) -> None: ...

    def open(self) -> list[GpuInfo]: ...

    def caps(self) -> Mapping[int, Mapping[GpuField, Gap | None] | Gap]:
        """Per GPU, each field's gap (None when reported). A single Gap in place of the map says the backend
        sees this GPU but cannot read it at all (a lost GPU): the agent names it as one gpu<i> entry."""
        ...

    def versions(self) -> Mapping[str, str]: ...

    def sample(self) -> list[GpuSample]:
        """One reading per GPU. A GPU whose memory is system RAM reports what it holds there as
        shared_used; a GPU with memory of its own reports vram_used."""
        ...

    def proc_mem(self) -> Mapping[int, Mapping[int, int]]:
        """Per GPU index, pid -> bytes: the lists the last sample() read; the collector calls it right after
        sample()."""
        ...

    def proc_util(self) -> Mapping[int, float] | None: ...

    def close(self) -> None:
        """Release what open() acquired (a child process, a library handle). Called exactly once on every
        backend that was built, whether or not open() succeeded:

        - at start-up, as soon as the chain drops it (open(), caps() or versions() raised, or no GPU found);
        - at start-up, on every backend already opened, if building the GPU collector fails;
        - at shutdown on SIGTERM or SIGINT, after the sampler stops and any sample() or proc_util() call in
          progress returns; or when start-up fails after the collectors exist.

        A SIGKILL or a crash of the interpreter skips it. So does a read that hangs: shutdown waits up to
        CLOSE_WAIT_S (5 s) for it, then closes every other backend and leaves the one still reading open."""
        ...


class Chain(NamedTuple):
    vendor: Vendor
    backends: tuple[type[GpuBackend], ...]
