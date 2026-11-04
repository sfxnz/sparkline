from __future__ import annotations

import json
import socket

import pynvml
from platforms import GB10, gb10

from sparkline.agent.config import AgentConfig
from sparkline.agent.info import AGENT_VERSION, Collectors
from sparkline.agent.sampler import Sampler
from sparkline.common.metrics import flatten


def test_recorded_gb10_gives_todays_node_info_and_flattened_sample(monkeypatch):
    def offline(*_a: object, **_kw: object) -> None:
        raise AssertionError("a recorded platform reached the live machine")

    monkeypatch.setattr(socket, "socket", offline)
    monkeypatch.setattr(pynvml, "nvmlInit", offline)
    src = gb10()
    cfg = AgentConfig(node_id="gb10")
    collectors = Collectors(cfg, src)
    info = collectors.node_info(cfg)
    flat = flatten(Sampler(cfg.node_id, collectors.ordered(), cfg.interval_ms, ring_seconds=10).tick())

    golden = json.loads((GB10 / "golden.json").read_text())
    assert info.model_dump(mode="json") == {**golden["node_info"], "agent_version": AGENT_VERSION}
    assert flat == golden["flat"]
    assert src.nvml.misses == []
