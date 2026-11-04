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

    def caps(self) -> Mapping[int, Mapping[GpuField, Gap | None]]: ...

    def versions(self) -> Mapping[str, str]: ...

    def sample(self) -> list[GpuSample]: ...

    def proc_mem(self) -> Mapping[int, Mapping[int, int]]: ...

    def proc_util(self) -> Mapping[int, float] | None: ...

    def close(self) -> None:
        """Release what open() acquired (a child process, a library handle). Called once on every backend
        that was built, whether or not open() succeeded, when the chain drops it or the agent stops."""
        ...


class Chain(NamedTuple):
    vendor: Vendor
    backends: tuple[type[GpuBackend], ...]
