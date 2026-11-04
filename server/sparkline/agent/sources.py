from __future__ import annotations

import glob
import json
import os
import shutil
import socket
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

import psutil

try:
    import pynvml
except ImportError:  # pragma: no cover - dependency is declared, but stay alive without it
    pynvml = None


class RootFs:
    def __init__(self, root: str | Path = "/") -> None:
        self.root = "" if str(root) == "/" else os.path.realpath(root)
        self._fds: dict[str, int] = {}

    def host_path(self, p: str) -> str:
        return self.root + p

    def read(self, p: str) -> str:
        """Read a /proc or /sys file, keeping its fd open between calls (pread at offset 0 regenerates it)."""
        path = self.root + p
        fd = self._fds.get(path)
        if fd is None:
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
            self._fds[path] = fd
        try:
            chunks = []
            off = 0
            while True:
                b = os.pread(fd, 65536, off)
                chunks.append(b)
                if len(b) < 65536:
                    break
                off += len(b)
            return b"".join(chunks).decode(errors="replace")
        except OSError:
            os.close(fd)
            del self._fds[path]
            raise

    def read_once(self, p: str) -> str | None:
        """Plain read for static files; None if missing/unreadable."""
        try:
            with open(self.root + p) as f:
                return f.read().strip()
        except OSError:
            return None

    def exists(self, p: str) -> bool:
        return os.path.exists(self.root + p)

    def listdir(self, p: str) -> list[str]:
        return os.listdir(self.root + p)

    def glob(self, pattern: str) -> list[str]:
        return [self._strip(p) for p in glob.glob(glob.escape(self.root) + pattern)]

    def realpath(self, p: str) -> str:
        return self._strip(os.path.realpath(self.root + p))

    def _strip(self, path: str) -> str:
        return path[len(self.root) :] if self.root else path


class EthReader(Protocol):
    def read(self) -> dict[str, int]: ...


@dataclass(frozen=True)
class Sources:
    platform: str
    fs: RootFs
    nvml: Any
    if_addrs: Callable[[], dict[str, list[Any]]]
    statvfs: Callable[[str], os.statvfs_result]
    ethtool: Callable[[str, list[str]], EthReader]
    docker: Callable[[str], Any]
    which: Callable[[str], str | None]


def live() -> Sources:
    from .collectors.procs import docker_get
    from .ethtool import EthtoolStats

    return Sources(
        platform=sys.platform,
        fs=RootFs(),
        nvml=pynvml,
        if_addrs=psutil.net_if_addrs,
        statvfs=os.statvfs,
        ethtool=EthtoolStats,
        docker=docker_get,
        which=shutil.which,
    )


_FAMILY = {"AF_INET": socket.AF_INET, "AF_INET6": socket.AF_INET6, "AF_LINK": psutil.AF_LINK}


class NvmlReplay:
    def __init__(self, calls: dict[str, dict[str, Any]]) -> None:
        self._calls = calls
        self.misses: list[str] = []

    def __getattr__(self, name: str) -> Any:
        if not name.startswith("nvml"):
            return getattr(pynvml, name)
        table = self._calls.get(name, {})

        def call(*args: Any) -> Any:
            key = json.dumps(list(args))
            if key not in table:
                self.misses.append(f"{name}{key}")
                raise LookupError(f"{name}({key[1:-1]}) is not in the recording")
            return _replay(table[key])

        return call


def _replay(v: Any) -> Any:
    if isinstance(v, list):
        return [_replay(x) for x in v]
    if isinstance(v, dict) and "__fields__" in v:
        return SimpleNamespace(**{k: _replay(x) for k, x in v["__fields__"].items()})
    if isinstance(v, dict) and "__error__" in v:
        raise _nvml_error(v["__error__"], v["str"])
    return v


def _nvml_error(value: int, text: str) -> Exception:
    """pynvml's NVMLError.__str__ looks the message up in the NVML library, which a test machine may lack."""
    cls = type(pynvml.NVMLError(value))
    return type(cls.__name__, (cls,), {"__str__": lambda self: text})(value)


class _RecordedEthtool:
    def __init__(self, stats: dict[str, int]) -> None:
        self._stats = stats

    def read(self) -> dict[str, int]:
        return dict(self._stats)


def recorded(directory: str | Path) -> Sources:
    """A recorded platform directory holds:

    - ``platform.json``: the platform name and how it was recorded (``synthesized`` when no real device)
    - ``root/``: the files the agent reads (/proc, /sys, /etc, /usr) at machine paths, symlinks relative
    - ``nvml.json``: NVML responses, ``{function: {json args: result}}``, a device handle written as "gpu<i>"
    - ``host.json``: readings that are not files (net_if_addrs, statvfs, ethtool, docker, which)
    """
    d = Path(directory)
    meta = json.loads((d / "platform.json").read_text())
    host = json.loads((d / "host.json").read_text())
    addrs = {
        name: [SimpleNamespace(**{**a, "family": _FAMILY[a["family"]]}) for a in entries]
        for name, entries in host["net_if_addrs"].items()
    }

    def statvfs(mount: str) -> os.statvfs_result:
        if mount not in host["statvfs"]:
            raise FileNotFoundError(2, "not in the recording", mount)
        return os.statvfs_result(host["statvfs"][mount])

    def ethtool(ifname: str, wanted: list[str]) -> EthReader:
        rec = host["ethtool"].get(ifname, {"error": f"{ifname}: not in the recording"})
        if "error" in rec:
            raise OSError(rec["error"])
        missing = [w for w in wanted if w not in rec["stats"]]
        if missing:
            raise OSError(f"{ifname}: ethtool stats missing {', '.join(missing)}")
        return _RecordedEthtool({k: rec["stats"][k] for k in wanted})

    def docker(path: str) -> Any:
        rec = host["docker"].get(path, {"error": f"docker API {path}: not in the recording"})
        if "error" in rec:
            raise OSError(rec["error"])
        return rec["result"]

    return Sources(
        platform=meta["platform"],
        fs=RootFs(d / "root"),
        nvml=NvmlReplay(json.loads((d / "nvml.json").read_text())),
        if_addrs=lambda: addrs,
        statvfs=statvfs,
        ethtool=ethtool,
        docker=docker,
        which=lambda name: host["which"].get(name),
    )
