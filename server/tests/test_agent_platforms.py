from __future__ import annotations

import json
import logging
import os
import shutil
import socket
from pathlib import Path

import pynvml
import pytest
from fastapi.testclient import TestClient
from platforms import AMD_THREADRIPPER, GB10, INTEL_HYBRID, WORKSTATION, gb10_without, paths_read, workstation
from synthesized_workstation import stat_line

from sparkline.agent.app import create_app
from sparkline.agent.collectors.gpu.nvml import VRAM_ONLY
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
    assert flat == {**golden["flat"], **golden["added"]}, (
        "today's keys keep their values; only keys are added"
    )
    assert flat["gpu.mem_used"] == flat["gpu0.shared_used"] == flat["mem.gpu"]
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
FLAT = {**GOLDEN["flat"], **GOLDEN["added"]}
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
    assert outside(seen, Path(src.fs.root).parent) == []
    return info, sample, collectors


NO_SPLIT = "This CPU has no performance/efficiency core split"
AMD_CPU = "AMD Ryzen Threadripper PRO 7975WX 32-Cores"
INTEL_CPU = "13th Gen Intel(R) Core(TM) i9-13900K"


def hwmon_readings(recording: Path, chip: str) -> list[float]:
    return [
        int(t.read_text()) / 1000
        for d in (recording / "root/sys/class/hwmon").iterdir()
        if (d / "name").read_text().strip() == chip
        for t in d.glob("temp*_input")
    ]


def test_an_amd_threadripper_names_its_cores_has_no_split_and_reports_its_k10temp_readings(offline, tmp_path):
    src = recorded(AMD_THREADRIPPER)
    info, sample, _ = start(src, tmp_path)
    flat = flatten(sample)

    assert info.cpu_model == AMD_CPU
    assert len(info.cores) == 64 and {(c.kind, c.model) for c in info.cores} == {("unknown", AMD_CPU)}
    gaps = {u.metric: u.reason for u in info.unsupported}
    assert (gaps["cpu.perf_util"], gaps["cpu.eff_util"]) == (NO_SPLIT, NO_SPLIT)
    assert [(s.id, s.label, s.group) for s in info.sensors] == [
        ("k10temp.tctl", "CPU control (Tctl)", "other"),
        *((f"k10temp.tccd{n}", f"CPU CCD {n}", "other") for n in range(1, 5)),
    ]
    assert "cpu.temp" not in gaps
    assert flat["cpu.temp"] == max(hwmon_readings(AMD_THREADRIPPER, "k10temp"))
    assert "Arm core" not in info.model_dump_json()
    assert src.nvml.misses == []


def test_an_intel_hybrid_splits_by_its_pmus_not_by_its_favoured_cores_higher_clock(offline, tmp_path):
    src = recorded(INTEL_HYBRID)
    info, sample, _ = start(src, tmp_path)
    flat = flatten(sample)

    favoured = [c.max_mhz or 0 for c in info.cores if c.id in (4, 5, 6, 7)]
    other_p_cores = [c.max_mhz or 0 for c in info.cores if c.id < 16 and c.id not in (4, 5, 6, 7)]
    assert min(favoured) > max(other_p_cores), "the favoured pair clocks highest, the old rule's trap"
    assert [c.id for c in info.cores if c.kind == "performance"] == list(range(16))
    assert [c.id for c in info.cores if c.kind == "efficiency"] == list(range(16, 32))
    assert {"cpu.perf_util", "cpu.eff_util"} <= set(flat)
    assert info.cpu_model == INTEL_CPU and {c.model for c in info.cores} == {INTEL_CPU}
    assert [s.label for s in info.sensors] == ["CPU package"] + [
        f"CPU core {n}" for n in (*range(0, 32, 4), *range(32, 48))
    ]
    assert {(s.group, s.crit_c) for s in info.sensors} == {("other", 100.0)}
    assert "cpu.temp" not in {u.metric for u in info.unsupported}
    assert flat["cpu.temp"] == max(hwmon_readings(INTEL_HYBRID, "coretemp"))
    assert "Arm core" not in info.model_dump_json()
    assert src.nvml.misses == []


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
    want = {k: v for k, v in FLAT.items() if not k.startswith("net.") and k not in PSI}
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
    assert {k: v for k, v in FLAT.items() if not k.startswith("mem.")} == flat


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


def test_a_collector_that_cannot_start_logs_its_traceback_at_debug(offline, tmp_path, caplog):
    caplog.set_level(logging.DEBUG, logger="sparkline.agent.info")
    cfg = AgentConfig(node_id="gb10", data_dir=str(tmp_path / "data"))
    Collectors(cfg, gb10_without(tmp_path, "/sys/class/net"))

    net = [r for r in caplog.records if r.getMessage().startswith("collector net could not start")]
    assert [(r.levelno, r.exc_info is None) for r in net] == [(logging.WARNING, True), (logging.DEBUG, False)]
    assert net[1].exc_info and isinstance(net[1].exc_info[1], FileNotFoundError)


def _meminfo_bytes(text: str) -> dict[str, int]:
    return {k: int(v.split()[0]) * 1024 for k, v in (line.split(":") for line in text.splitlines())}


def test_the_recorded_workstation_shows_each_gpus_vram_and_no_gpu_segment_in_system_memory(offline, tmp_path):
    src = workstation(tmp_path)
    info, sample, _ = start(src, tmp_path)

    calls = json.loads((WORKSTATION / "nvml.json").read_text())
    memory = [calls["nvmlDeviceGetMemoryInfo"][f'["gpu{i}"]']["__fields__"] for i in range(4)]
    held = {
        p["__fields__"]["pid"]: p["__fields__"]["usedGpuMemory"]
        for procs in calls["nvmlDeviceGetComputeRunningProcesses"].values()
        for p in procs
    }
    mi = _meminfo_bytes((WORKSTATION / "root/proc/meminfo").read_text())
    flat = flatten(sample)
    assert sum(held.values()) > flat["mem.used"], "subtracting the workers' VRAM would empty the breakdown"

    assert [(g.name, g.memory, g.vram_total) for g in info.gpus] == [
        ("NVIDIA RTX 6000 Ada Generation", "dedicated", m["total"]) for m in memory
    ]
    assert [flat[f"gpu{i}.vram_used"] for i in range(4)] == [m["used"] for m in memory]
    assert flat["gpu.mem_used"] == sum(m["used"] for m in memory)
    assert "mem.gpu" not in flat and not [k for k in flat if k.endswith(".shared_used")]
    assert (flat["mem.anon"], flat["mem.shmem"], flat["mem.kernel"]) == (
        mi["AnonPages"],
        mi["Shmem"],
        mi["Slab"] + mi["KernelStack"] + mi["PageTables"] + mi["VmallocUsed"],
    )
    gaps = {u.metric: u.reason for u in info.unsupported if u.metric.startswith(("gpu", "mem."))}
    assert gaps == {
        **{f"gpu{i}.shared_used": VRAM_ONLY.reason for i in range(4)},
        "mem.gpu": VRAM_ONLY.reason,
    }
    assert {p.pid: p.gpu_mem for p in sample.procs or [] if p.gpu_mem} == held
    assert src.nvml.misses == []


def test_on_gb10_mem_gpu_is_the_gpu_memory_of_the_process_table(offline, tmp_path):
    src = gb10_without(tmp_path)
    proc = tmp_path / "gb10/root/proc/3605742"
    proc.mkdir()
    (proc / "stat").write_text(stat_line(3605742, "python3", 1, 5_000, 300, 9_000_000, 120_000))
    (proc / "cmdline").write_text("python3\0-m\0vllm.entrypoints.openai.api_server\0")
    _, sample, _ = start(src, tmp_path)

    assert sample.procs and [p.pid for p in sample.procs if p.gpu_mem] == [3605742]
    assert sample.mem.gpu == sum(p.gpu_mem or 0 for p in sample.procs) == GOLDEN["flat"]["mem.gpu"]
