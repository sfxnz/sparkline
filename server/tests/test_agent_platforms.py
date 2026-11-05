from __future__ import annotations

import json
import shutil
import socket
from pathlib import Path

import pynvml
import pytest
from platforms import GB10, paths_read

from sparkline.agent.collectors.net import NetCollector
from sparkline.agent.config import AgentConfig
from sparkline.agent.info import AGENT_VERSION, Collectors
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import RootFs, recorded
from sparkline.common.metrics import flatten


@pytest.fixture
def offline(monkeypatch):
    def refuse(*_a: object, **_kw: object) -> None:
        raise AssertionError("a recorded platform reached the live machine")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(pynvml, "nvmlInit", refuse)


@pytest.mark.parametrize("through_symlink", [False, True], ids=["recording", "symlinked-recording"])
def test_recorded_gb10_gives_todays_node_info_and_flattened_sample(offline, tmp_path, through_symlink):
    recording = GB10
    if through_symlink:  # macOS /tmp and /var are symlinks, and so may be a capture directory
        (tmp_path / "alias").symlink_to(GB10.parent, target_is_directory=True)
        recording = tmp_path / "alias" / GB10.name
    with paths_read() as seen:
        src = recorded(recording)
        cfg = AgentConfig(node_id="gb10", data_dir=str(tmp_path / "data"))
        collectors = Collectors(cfg, src)
        info = collectors.node_info(cfg)
        flat = flatten(Sampler(cfg.node_id, collectors.ordered(), cfg.interval_ms, ring_seconds=10).tick())

    golden = json.loads((GB10 / "golden.json").read_text())
    assert info.model_dump(mode="json") == {**golden["node_info"], "agent_version": AGENT_VERSION}
    assert flat == golden["flat"]
    assert src.nvml.misses == []
    inside = (str(recording) + "/", str(GB10.resolve()) + "/")
    assert [p for p in seen if not p.startswith(inside)] == []


def test_a_root_whose_path_has_glob_characters_still_globs_and_resolves(tmp_path):
    root = tmp_path / "capture [spark1]"
    (root / "sys/class/net/eth0").mkdir(parents=True)
    (root / "sys/devices/pci0").mkdir(parents=True)
    (root / "sys/class/net/eth0/device").symlink_to("../../../devices/pci0")
    fs = RootFs(root)
    assert fs.glob("/sys/class/net/*") == ["/sys/class/net/eth0"]
    assert fs.realpath("/sys/class/net/eth0/device") == "/sys/devices/pci0"


def test_a_recording_missing_an_ethtool_stat_loses_only_those_counters(offline, tmp_path, caplog):
    rec = tmp_path / GB10.name
    rec.mkdir()
    for name in ("platform.json", "nvml.json"):
        shutil.copy(GB10 / name, rec / name)
    (rec / "root").symlink_to(GB10 / "root", target_is_directory=True)
    host = json.loads((GB10 / "host.json").read_text())
    del host["ethtool"]["enp1s0f0np0"]["stats"]["rx_crc_errors_phy"]
    Path(rec / "host.json").write_text(json.dumps(host))

    net = NetCollector(recorded(rec))

    assert (
        "enp1s0f0np0: ethtool PHY counters unavailable (enp1s0f0np0: ethtool stats missing rx_crc_errors_phy)"
        in caplog.messages
    )
    assert "enp1s0f0np0" in {s.name for s in net.collect()["net"]}
