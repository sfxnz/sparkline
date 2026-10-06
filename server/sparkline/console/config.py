"""Console configuration: TOML file + CLI overrides."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field

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


def default_data_dir() -> Path:
    system = Path("/var/lib/sparkline")
    if os.access(system, os.W_OK) or (not system.exists() and os.access(system.parent, os.W_OK)):
        return system
    return Path.home() / ".local/share/sparkline"


def load_config(path: Path | None) -> ConsoleConfig:
    """Load the TOML file. ``path=None`` means the default path, which may be absent (-> defaults)."""
    if path is None:
        if not DEFAULT_CONFIG.exists():
            return ConsoleConfig()
        path = DEFAULT_CONFIG
    with open(path, "rb") as f:
        return ConsoleConfig.model_validate(tomllib.load(f))
