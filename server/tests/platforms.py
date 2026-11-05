from __future__ import annotations

import os
import shutil
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

from sparkline.agent.sources import Sources, recorded

PLATFORMS = Path(__file__).parent / "fixtures" / "platforms"
GB10 = PLATFORMS / "gb10"
WORKSTATION = PLATFORMS / "workstation"

_FS_EVENTS = {"open", "os.listdir", "os.scandir", "glob.glob", "glob.glob/2"}
_seen: list[str] | None = None
_hooked = False


def gb10(**changes: Any) -> Sources:
    return replace(recorded(GB10), **changes)


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if _seen is not None and event in _FS_EVENTS and isinstance(args[0], (str, bytes, os.PathLike)):
        _seen.append(os.path.abspath(os.fsdecode(args[0])))


@contextmanager
def paths_read() -> Iterator[list[str]]:
    """An audit hook cannot be removed, so one hook serves every test and records only inside this block."""
    global _seen, _hooked
    if not _hooked:
        sys.addaudithook(_audit)
        _hooked = True
    _seen = seen = []
    try:
        yield seen
    finally:
        _seen = None


def gb10_without(tmp: Path, *missing: str) -> Sources:
    """The GB10 recording with some machine paths removed, as on a box whose kernel or hardware lacks them."""
    copy = tmp / "gb10"
    shutil.copytree(GB10, copy, symlinks=True)
    for p in missing:
        target = copy / "root" / p.lstrip("/")
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    return recorded(copy)


def workstation(tmp: Path) -> Sources:
    """The synthesized 4-GPU workstation (its NVML answers, /proc/meminfo and vLLM workers) laid over the GB10
    recording's host files, as its platform.json says."""
    copy = tmp / "workstation"
    shutil.copytree(GB10, copy, symlinks=True)
    shutil.copytree(WORKSTATION, copy, symlinks=True, dirs_exist_ok=True)
    return recorded(copy)
