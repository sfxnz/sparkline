"""Agent configuration: TOML file (``--config`` or /etc/sparkline/agent.toml) overridden by CLI flags."""

from __future__ import annotations

import os
import socket
import tomllib
from dataclasses import dataclass, field, fields

DEFAULT_PATH = "/etc/sparkline/agent.toml"


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

    def validate(self) -> None:
        if not 250 <= self.interval_ms <= 5000:
            raise ValueError(f"interval_ms must be between 250 and 5000 (got {self.interval_ms})")
        if not 1 <= self.port <= 65535:
            raise ValueError(f"port out of range: {self.port}")
        if self.ring_seconds < 10 or self.procs_interval_s < 1:
            raise ValueError("ring_seconds must be >= 10 and procs_interval_s >= 1")


def load_config(path: str | None = None, overrides: dict | None = None) -> AgentConfig:
    data: dict = {}
    if path is None and os.path.exists(DEFAULT_PATH):
        path = DEFAULT_PATH
    if path is not None:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    known = {f.name for f in fields(AgentConfig)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"unknown config keys in {path}: {', '.join(sorted(unknown))}")
    data.update({k: v for k, v in (overrides or {}).items() if v is not None})
    cfg = AgentConfig(**data)
    cfg.validate()
    return cfg
