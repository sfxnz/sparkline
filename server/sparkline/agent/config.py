"""Agent configuration. Precedence: CLI flag > ``SPARKLINE_*`` environment variable > TOML file
(``--config``, ``$SPARKLINE_CONFIG`` or /etc/sparkline/agent.toml) > default."""

from __future__ import annotations

import os
import re
import socket
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field, fields

DEFAULT_PATH = "/etc/sparkline/agent.toml"
DEFAULT_BENCH_IMAGE = "nvcr.io/nvidia/pytorch:26.07-py3"
_IMAGE_RE = re.compile(r"^[A-Za-z0-9][\w.\-/:@]{0,254}$")


def default_data_dir() -> str:
    sys_dir = "/var/lib/sparkline-agent"
    if os.path.isdir(sys_dir) and os.access(sys_dir, os.W_OK):
        return sys_dir
    return os.path.expanduser("~/.local/share/sparkline-agent")


@dataclass
class AgentConfig:
    node_id: str = field(default_factory=lambda: socket.gethostname().split(".")[0])
    bind: str = "auto"
    port: int = 9750
    token: str = ""
    interval_ms: int = 1000
    data_dir: str = field(default_factory=default_data_dir)
    ring_seconds: int = 900
    retention_10s_days: float = 7
    retention_60s_days: float = 30
    procs_interval_s: float = 5
    peers: dict[str, str | list[str]] = field(default_factory=dict)  # node_id -> IP(s): interconnect peer
    include_virtual: bool = False
    allow_public: bool = False
    bench_image: str = DEFAULT_BENCH_IMAGE  # container image for GPU benchmarks
    bench_work_dir: str = ""  # scratch for benchmark files; default <data_dir>/bench-work
    bench_payload_device: str = "cuda"  # "cpu": code-path smoke test of GPU payloads

    def validate(self) -> None:
        if not 250 <= self.interval_ms <= 5000:
            raise ValueError(f"interval_ms must be between 250 and 5000 (got {self.interval_ms})")
        if self.token and len(self.token) < 16:
            raise ValueError("token must be at least 16 characters (install.sh generates one)")
        if not 1 <= self.port <= 65535:
            raise ValueError(f"port out of range: {self.port}")
        if self.ring_seconds < 10 or self.procs_interval_s < 1:
            raise ValueError("ring_seconds must be >= 10 and procs_interval_s >= 1")
        if not _IMAGE_RE.match(self.bench_image):
            raise ValueError(f"bench_image is not a valid image reference: {self.bench_image!r}")
        if self.bench_payload_device not in ("cuda", "cpu"):
            raise ValueError(f"bench_payload_device must be cuda or cpu (got {self.bench_payload_device!r})")

    @property
    def bench_dir(self) -> str:
        return self.bench_work_dir or os.path.join(self.data_dir, "bench-work")


def env_overrides(env: Mapping[str, str]) -> dict:
    """Config values from ``SPARKLINE_*`` variables (empty ones count as unset). The agent's token is the
    shared agent token: ``SPARKLINE_AGENT_TOKEN``, or ``SPARKLINE_TOKEN`` when that is not set."""
    out: dict = {}
    for key, names in {
        "token": ("SPARKLINE_AGENT_TOKEN", "SPARKLINE_TOKEN"),
        "bind": ("SPARKLINE_BIND",),
        "port": ("SPARKLINE_PORT",),
        "data_dir": ("SPARKLINE_DATA_DIR",),
    }.items():
        name = next((n for n in names if env.get(n)), None)
        if name is not None:
            out[key] = env[name]
    if "port" in out:
        try:
            out["port"] = int(out["port"])
        except ValueError:
            raise ValueError(f"SPARKLINE_PORT must be a port number (got {out['port']!r})") from None
    return out


def load_config(
    path: str | None = None, overrides: dict | None = None, env: Mapping[str, str] | None = None
) -> AgentConfig:
    """``overrides`` are CLI flags (None = not given). ``env`` is the process environment (None: ignored)."""
    data: dict = {}
    if path is None and env:
        path = env.get("SPARKLINE_CONFIG") or None
    if path is None and os.path.exists(DEFAULT_PATH):
        path = DEFAULT_PATH
    if path is not None:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    known = {f.name for f in fields(AgentConfig)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"unknown config keys in {path}: {', '.join(sorted(unknown))}")
    data.update(env_overrides(env or {}))
    data.update({k: v for k, v in (overrides or {}).items() if v is not None})
    cfg = AgentConfig(**data)
    cfg.validate()
    return cfg
