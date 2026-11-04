from __future__ import annotations

import json
import os
import shutil
import socket
from pathlib import Path

import pynvml
import pytest
from fastapi.testclient import TestClient
from platforms import GB10, gb10_without, paths_read

from sparkline.agent.app import create_app
from sparkline.agent.collectors.net import NetCollector
from sparkline.agent.config import AgentConfig
from sparkline.agent.info import AGENT_VERSION, Collectors
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import RootFs, Sources, recorded
from sparkline.common.metrics import flatten
from sparkline.common.schema import NodeInfo, Sample, Unsupported


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


GOLDEN = json.loads((GB10 / "golden.json").read_text())
PSI = ("cpu.psi_some", "mem.psi_some", "mem.psi_full")


def outside(seen: list[str], recording: Path) -> list[str]:
    inside = (str(recording) + "/", str(recording.resolve()) + "/")
    return [p for p in seen if not p.startswith(inside)]


def start(src: Sources, tmp: Path) -> tuple[NodeInfo, Sample, Collectors]:
    cfg = AgentConfig(node_id="gb10", data_dir=str(tmp / "data"))
    with paths_read() as seen:
        collectors = Collectors(cfg, src)
        info = collectors.node_info(cfg)
        sample = Sampler(cfg.node_id, collectors.ordered(), ring_seconds=10).tick()
    assert outside(seen, tmp / "gb10") == []
    return info, sample, collectors


def test_a_degraded_box_without_pressure_or_network_files_serves_everything_else(tmp_path):
    src = gb10_without(tmp_path, "/proc/pressure", "/sys/class/net", "/proc/self/net/dev")
    cfg = AgentConfig(node_id="gb10", data_dir=str(tmp_path / "data"))
    with paths_read() as seen:
        collectors = Collectors(cfg, src)
        sampler = Sampler(cfg.node_id, collectors.ordered(), ring_seconds=10)
        sampler.collect_once()
    assert outside(seen, tmp_path / "gb10") == []
    with TestClient(create_app(sampler, lambda: collectors.node_info(cfg), "t", manage_sampler=False)) as c:
        auth = {"Authorization": "Bearer t"}
        info = c.get("/api/v1/info", headers=auth).json()
        snap = Sample.model_validate(c.get("/api/v1/snapshot", headers=auth).json())

    assert [u for u in info["unsupported"] if u["metric"] == "net"] == [
        {
            "metric": "net",
            "reason": "The net collector could not start: /sys/class/net: No such file or directory",
            "kind": "hardware",
        }
    ]
    assert info["net"] == []
    want = {k: v for k, v in GOLDEN["flat"].items() if not k.startswith("net.") and k not in PSI}
    assert flatten(snap) == want
    assert snap.errors == {}


def test_a_memory_collector_that_cannot_start_writes_no_mem_keys(tmp_path):
    info, sample, _ = start(gb10_without(tmp_path, "/proc/meminfo"), tmp_path)

    gap = next(u for u in info.unsupported if u.metric == "mem")
    assert (gap.kind, gap.reason) == (
        "hardware",
        "The memory collector could not start: /proc/meminfo: No such file or directory",
    )
    flat = flatten(sample)
    assert not [k for k in flat if k.startswith("mem.")]
    assert {k: v for k, v in GOLDEN["flat"].items() if not k.startswith("mem.")} == flat


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads files regardless of their mode")
def test_a_collector_without_read_permission_is_declared_unsupported_for_access(offline, tmp_path):
    src = gb10_without(tmp_path)
    (tmp_path / "gb10/root/proc/diskstats").chmod(0)
    info, sample, collectors = start(src, tmp_path)

    assert [u for u in info.unsupported if u.metric in ("disk", "fs")] == [
        Unsupported(metric="disk", reason="Needs read access to /proc/diskstats", kind="access"),
        Unsupported(metric="fs", reason="Needs read access to /proc/diskstats", kind="access"),
    ]
    assert info.disks == [] and sample.disk == [] and sample.fs == []
    assert collectors.gpu is not None and sample.gpu
