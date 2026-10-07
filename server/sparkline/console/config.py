"""Console configuration. Precedence: CLI flag > ``SPARKLINE_*`` environment variable > TOML file
(``--config``, ``$SPARKLINE_CONFIG`` or /etc/sparkline/console.toml) > default."""

from __future__ import annotations

import ipaddress
import os
import tomllib
from collections.abc import Mapping
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from ..common.schema import ConsoleSettings

DEFAULT_CONFIG = Path("/etc/sparkline/console.toml")
# console/config.py -> console -> sparkline -> server -> <repo>
REPO_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"


class NodeConfig(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")
    url: str  # http://10.20.20.48:9750


class ConsoleConfig(BaseModel):
    bind: str = "auto"
    port: int = 9700
    token: str = ""  # browser token
    agent_token: str = ""
    nodes: list[NodeConfig] = Field(default_factory=list)
    data_dir: Path | None = None
    web_dist: Path = REPO_WEB_DIST
    settings: ConsoleSettings = Field(default_factory=ConsoleSettings)
    # Reverse proxies (IPs or CIDRs) whose X-Forwarded-For / -Proto are believed: behind a TLS proxy the
    # session cookie is then Secure, and sign-in limits count the real client, not the proxy.
    trusted_proxies: list[str] = Field(default_factory=list)

    @field_validator("trusted_proxies")
    @classmethod
    def _proxies(cls, v: list[str]) -> list[str]:
        for p in v:
            try:
                ipaddress.ip_network(p, strict=False)
            except ValueError:
                raise ValueError(f"{p!r} is not an IP address or network (e.g. 127.0.0.1)") from None
        return v


def default_data_dir() -> Path:
    system = Path("/var/lib/sparkline")
    if os.access(system, os.W_OK) or (not system.exists() and os.access(system.parent, os.W_OK)):
        return system
    return Path.home() / ".local/share/sparkline"


ENV_KEYS = {
    "SPARKLINE_TOKEN": "token",
    "SPARKLINE_AGENT_TOKEN": "agent_token",
    "SPARKLINE_BIND": "bind",
    "SPARKLINE_PORT": "port",
    "SPARKLINE_DATA_DIR": "data_dir",
}


def load_config(path: Path | None, env: Mapping[str, str] | None = None) -> ConsoleConfig:
    """Load the TOML file and apply ``SPARKLINE_*`` variables from ``env`` (None: ignored; empty values count
    as unset). ``path=None`` means ``$SPARKLINE_CONFIG``, else the default path, which may be absent."""
    env = env or {}
    if path is None and env.get("SPARKLINE_CONFIG"):
        path = Path(env["SPARKLINE_CONFIG"])
    data: dict = {}
    if path is None and DEFAULT_CONFIG.exists():
        path = DEFAULT_CONFIG
    if path is not None:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    data.update({key: env[name] for name, key in ENV_KEYS.items() if env.get(name)})
    return ConsoleConfig.model_validate(data)
