"""Top processes by GPU memory / RSS / CPU, with container and model-name detection. Runs every N seconds."""

from __future__ import annotations

import json
import logging
import os
import pwd
import re
import socket
import time
from typing import TYPE_CHECKING, Any

from ...common.schema import ProcSample
from . import read_once

if TYPE_CHECKING:
    from .gpu import GpuCollector

log = logging.getLogger(__name__)

TOP_N = 10
MAX_PROCS = 25
CMDLINE_MAX = 300
DOCKER_SOCK = "/var/run/docker.sock"
DOCKER_TTL_S = 30.0

_CONTAINER_ID = re.compile(r"(?:docker-|cri-containerd-|crio-|/docker/|/kubepods[^\n]*/)([0-9a-f]{64})")
_HF = re.compile(r"models--[^/\s]+?--([^/\s]+)")
_MODEL_ARG = re.compile(r"--model(?:-path)?(?:=|\s+)(\S+)")
_GGUF = re.compile(r"([^/\s]+)\.gguf\b")
_MODELS_DIR = re.compile(r"/models/([^/\s]+)")


# Secrets in argv (vLLM --api-key, --hf-token, NAME_TOKEN=..., sk-... keys) never leave the node:
# /proc/<pid>/cmdline is readable only by local users; samples go to every console session over LAN HTTP.
_SECRET_FLAG = re.compile(
    r"^--?(?:[a-z0-9]+[-_])*(?:api[-_]?key|token|password|passwd|secret|credentials?)(?:[-_][a-z0-9]+)*$",
    re.I,
)
_SECRET_ENV = re.compile(r"^([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=.+$")
_SECRET_TEXT = [
    (re.compile(r"\b(sk|hf)([-_])[A-Za-z0-9_-]{8,}"), r"\1\2***"),  # OpenAI-style and Hugging Face keys
    (re.compile(r"(://[^:/@\s]+:)[^@\s]+@"), r"\1***@"),  # user:password@ in URLs
]
REDACTED = "***"


def redact_argv(argv: list[str]) -> list[str]:
    """argv with secret values replaced by ***: `--api-key X`, `--api-key=X`, `HF_TOKEN=X`, `sk-…`, `hf_…`."""
    out: list[str] = []
    hide_next = False
    for arg in argv:
        if hide_next and not arg.startswith("-"):
            out.append(REDACTED)
            hide_next = False
            continue
        hide_next = False
        flag, eq, _ = arg.partition("=")
        if _SECRET_FLAG.match(flag):
            if eq:
                arg = f"{flag}={REDACTED}"
            else:
                hide_next = True
        elif m := _SECRET_ENV.match(arg):
            arg = f"{m.group(1)}={REDACTED}"
        for pat, rep in _SECRET_TEXT:
            arg = pat.sub(rep, arg)
        out.append(arg)
    return out


def container_id(cgroup_text: str) -> str | None:
    m = _CONTAINER_ID.search(cgroup_text)
    return m.group(1) if m else None


def detect_model(cmdline: str) -> str | None:
    if m := _HF.search(cmdline):
        return m.group(1)
    if m := _MODEL_ARG.search(cmdline):
        v = m.group(1).rstrip("/")
        return os.path.basename(v) if v.startswith(("/", ".", "~")) else v
    if m := _GGUF.search(cmdline):
        return m.group(1)
    if m := _MODELS_DIR.search(cmdline):
        return m.group(1)
    return None


def select_top(rows: dict[int, dict]) -> list[int]:
    """Union of top N by GPU memory, RSS and CPU (in that priority), capped at MAX_PROCS."""
    by_gpu = sorted((p for p in rows if rows[p]["gpu_mem"]), key=lambda p: -rows[p]["gpu_mem"])[:TOP_N]
    by_rss = sorted(rows, key=lambda p: -rows[p]["rss"])[:TOP_N]
    by_cpu = sorted(rows, key=lambda p: -(rows[p]["cpu"] or 0.0))[:TOP_N]
    out: list[int] = []
    for p in by_gpu + by_rss + by_cpu:
        if p not in out:
            out.append(p)
    return out[:MAX_PROCS]


def docker_get(path: str, sock_path: str = DOCKER_SOCK, timeout: float = 1.0) -> Any:
    """Minimal HTTP/1.0 GET against the Docker Engine API over its unix socket."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(sock_path)
        s.sendall(f"GET {path} HTTP/1.0\r\nHost: docker\r\n\r\n".encode())
        chunks = []
        while b := s.recv(65536):
            chunks.append(b)
    head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0]
    if b" 200 " not in status + b" ":
        raise OSError(f"docker API {path}: {status.decode(errors='replace')}")
    return json.loads(body)


def container_names(containers: list[dict]) -> dict[str, str]:
    return {c["Id"]: (c.get("Names") or ["/" + c["Id"][:12]])[0].lstrip("/") for c in containers}


def parse_pid_stat(data: bytes) -> tuple[str, int, int, int]:
    """/proc/<pid>/stat -> (comm, utime+stime ticks, rss pages, starttime ticks)."""
    lp, rp = data.index(b"("), data.rindex(b")")
    f = data[rp + 2 :].split()
    return data[lp + 1 : rp].decode(errors="replace"), int(f[11]) + int(f[12]), int(f[21]), int(f[19])


def scan_procs() -> dict[int, tuple[str, int, int, int]]:
    """All processes from /proc/<pid>/stat (one read per process; far cheaper than psutil per pid)."""
    out = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                fd = os.open(f"/proc/{d}/stat", os.O_RDONLY)  # ~35% cheaper than open() per file
                try:
                    out[int(d)] = parse_pid_stat(os.read(fd, 4096))
                finally:
                    os.close(fd)
            except (OSError, ValueError):
                continue
    return out


class ProcsCollector:
    name = "procs"

    def __init__(self, gpu: GpuCollector | None = None, interval_s: float = 5.0) -> None:
        self.gpu = gpu  # GpuCollector or None
        self.interval_s = interval_s
        self._last: float | None = None
        self._page = os.sysconf("SC_PAGE_SIZE")
        self._hz = os.sysconf("SC_CLK_TCK")
        self._prev: dict[int, tuple[int, int]] = {}  # pid -> (starttime, cpu ticks)
        self._names: dict[str, str] = {}
        self._names_t = -DOCKER_TTL_S
        self._cid: dict[tuple[int, int], str | None] = {}  # (pid, starttime) -> container id
        self._users: dict[int, str | None] = {}

    def _container(self, pid: int, start: int) -> str | None:
        key = (pid, start)
        if key not in self._cid:
            self._cid[key] = container_id(read_once(f"/proc/{pid}/cgroup") or "")
        cid = self._cid[key]
        if cid is None:
            return None
        now = time.monotonic()
        if cid not in self._names and now - self._names_t > DOCKER_TTL_S:
            self._names_t = now
            try:
                self._names = container_names(docker_get("/containers/json"))
            except (OSError, ValueError) as e:
                log.debug("docker name lookup failed: %s", e)
        return self._names.get(cid, cid[:12])

    def _user(self, pid: int) -> str | None:
        try:
            uid = os.stat(f"/proc/{pid}").st_uid
        except OSError:
            return None
        if uid not in self._users:
            try:
                self._users[uid] = pwd.getpwuid(uid).pw_name
            except KeyError:
                self._users[uid] = str(uid)
        return self._users[uid]

    def collect(self) -> dict:
        now = time.monotonic()
        if self._last is not None and now - self._last < self.interval_s - 0.05:
            return {"procs": None}
        elapsed = now - self._last if self._last is not None else 0.0
        self._last = now
        gpu_mem = self.gpu.proc_mem if self.gpu else {}
        gpu_util = self.gpu.process_util() if self.gpu else {}
        rows: dict[int, dict] = {}
        prev, self._prev = self._prev, {}
        for pid, (comm, ticks, rss, start) in scan_procs().items():
            self._prev[pid] = (start, ticks)
            p = prev.get(pid)
            cpu = None  # first sighting (or pid reuse): no interval to measure yet, so no reading (not 0 %)
            if p and p[0] == start and elapsed > 0 and ticks >= p[1]:
                cpu = (ticks - p[1]) / self._hz / elapsed * 100
            rows[pid] = {
                "name": comm,
                "cpu": cpu,
                "rss": rss * self._page,
                "start": start,
                "gpu_mem": gpu_mem.get(pid),
            }
        self._cid = {k: v for k, v in self._cid.items() if k[0] in rows}
        out = []
        for pid in select_top(rows):
            r = rows[pid]
            argv = [a for a in (read_once(f"/proc/{pid}/cmdline") or "").split("\0") if a]
            if len(argv) == 1:  # a process that rewrote its title into one string ("vllm: serve --api-key X")
                argv = argv[0].split()
            raw = " ".join(redact_argv(argv)).strip()
            cmd = raw or f"[{r['name']}]"  # kernel threads have no cmdline
            out.append(
                ProcSample(
                    pid=pid,
                    name=r["name"],
                    cmdline=cmd[:CMDLINE_MAX],
                    user=self._user(pid),
                    cpu_pct=None if r["cpu"] is None else round(r["cpu"], 1),
                    rss=r["rss"],
                    gpu_mem=r["gpu_mem"],
                    gpu_util=gpu_util.get(pid),
                    container=self._container(pid, r["start"]),
                    model=detect_model(cmd),
                )
            )
        return {"procs": out}
