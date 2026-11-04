from __future__ import annotations

import itertools
import json
import re
import shutil
import time
import typing
from dataclasses import replace
from pathlib import Path

import pytest
from platforms import GB10, gb10, gb10_without

from sparkline.agent.capture import capture
from sparkline.agent.collectors import VOCABULARY, covers, declares
from sparkline.agent.collectors.gpu.nvml import VIOLATION_EVERY_S
from sparkline.agent.config import AgentConfig
from sparkline.agent.info import Collectors, catch_all
from sparkline.agent.redact import Facts
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import NvmlReplay, Sources, recorded
from sparkline.common.metrics import flatten
from sparkline.common.schema import NodeInfo, Sample, UnsupportedKind
from sparkline.console.demo import UNSUPPORTED, DemoModel

WEB = Path(__file__).resolve().parents[2] / "web" / "src"
PROBED_ONLY = ("mem_mhz", "fan_pct", "fb_memory", "ecc", "pcie_bps", "cpu.temp")


def vocabulary_keys(info: NodeInfo) -> list[str]:
    keys = []
    for key in VOCABULARY:
        if key.startswith("gpu*"):
            keys += [key.replace("*", str(g.index), 1) for g in info.gpus]
        elif key.startswith("cpu.core*"):
            keys += [key.replace("*", str(i), 1) for i in range(len(info.cores))]
        else:
            keys.append(key)
    return keys


def reported(key: str, info: NodeInfo, sample: Sample, flat: dict[str, float]) -> bool | None:
    if key.endswith(PROBED_ONLY) or key == "gpu.backend":
        return None
    if m := re.fullmatch(r"gpu(\d+)\.power_limit_w", key):
        return next(g.power_limit_w for g in info.gpus if g.index == int(m.group(1))) is not None
    if key.endswith(".proc_mem"):
        return "mem.gpu" in flat if "mem.used" in flat else None
    if key == "procs":
        return sample.procs is not None
    return any(covers(key, k) for k in flat)


def assert_every_metric_is_reported_or_declared(info: NodeInfo, sample: Sample) -> None:
    flat = flatten(sample)
    gaps = info.unsupported
    assert {u.kind for u in gaps} <= set(typing.get_args(UnsupportedKind))
    assert [u.metric for u in gaps if not any(declares(u.metric, v) for v in VOCABULARY)] == []
    assert [k for k in flat if any(covers(u.metric, k) for u in gaps)] == [], (
        "reported and declared unsupported"
    )
    silent = [
        k
        for k in vocabulary_keys(info)
        if reported(k, info, sample, flat) is False and not any(covers(u.metric, k) for u in gaps)
    ]
    assert silent == [], "neither reported nor declared unsupported"
    assert [u.metric for u in gaps if u.metric in VOCABULARY and u == catch_all(u.metric)] == [], (
        "a collector that started left part of its vocabulary to the catch-all"
    )
    assert {"fan", "system.power_w"} <= {u.metric for u in gaps}
    by_metric = {u.metric: (u.reason, u.kind) for u in gaps}
    if info.gpus:
        assert "gpu*" not in by_metric, "a gpu* gap would hide the GPUs that opened"
    else:
        assert by_metric["gpu*"] == by_metric["mem.gpu"], "one reason for having no GPU"
        assert by_metric.get("gpu.backend") in (None, by_metric["gpu*"])


def warm(monkeypatch: pytest.MonkeyPatch, src: Sources) -> tuple[NodeInfo, Sample, Collectors]:
    clock = itertools.count(1000.0, VIOLATION_EVERY_S + 1)
    monkeypatch.setattr(time, "monotonic", lambda: next(clock))
    cfg = AgentConfig(node_id="gb10")
    collectors = Collectors(cfg, src)
    sampler = Sampler(cfg.node_id, collectors.ordered(), ring_seconds=10)
    sampler.tick()
    return collectors.node_info(cfg), sampler.tick(), collectors


def gb10_with(
    tmp: Path,
    *,
    diskstats: str | None = None,
    block: dict[str, str] | None = None,
    nics: tuple[str, ...] | None = None,
) -> Sources:
    copy = tmp / "gb10"
    shutil.copytree(GB10, copy, symlinks=True)
    root = copy / "root"
    if diskstats is not None:
        (root / "proc/diskstats").write_text(diskstats)
    if block is not None:
        shutil.rmtree(root / "sys/block")
        (root / "sys/block").mkdir()
        for name, target in block.items():
            (root / "sys/block" / target).mkdir(parents=True)
            (root / "sys/block" / name).symlink_to(target)
    if nics is not None:
        for link in (root / "sys/class/net").iterdir():
            if link.name not in (*nics, "lo"):
                link.unlink()
    return recorded(copy)


LOOPS = "   7       0 loop0 14 0 34 9 0 0 0 0 0 5 9 0 0 0 0 0 0\n"
EMMC = (
    LOOPS
    + " 179       0 mmcblk0 1000 0 8000 100 500 0 4000 50 0 120 150 0 0 0 0 0 0\n"
    + " 179       1 mmcblk0p1 900 0 7000 90 450 0 3600 45 0 110 135 0 0 0 0 0 0\n"
    + " 179       8 mmcblk0boot0 30 0 240 3 0 0 0 0 0 4 3 0 0 0 0 0 0\n"
    + " 179      16 mmcblk0boot1 30 0 240 3 0 0 0 0 0 4 3 0 0 0 0 0 0\n"
)
MMC = "../devices/platform/soc/mmc0/mmc_host/mmc0/mmc0:0001/block"
EMMC_BLOCK = {
    "loop0": "../devices/virtual/block/loop0",
    **{name: f"{MMC}/{name}" for name in ("mmcblk0", "mmcblk0boot0", "mmcblk0boot1")},
}

ZERO_INSTANCES = {
    "no hwmon": lambda tmp: gb10_without(tmp, "/sys/class/hwmon"),
    "eMMC only": lambda tmp: gb10_with(tmp, diskstats=EMMC, block=EMMC_BLOCK),
    "no physical disks": lambda tmp: gb10_with(tmp, diskstats=LOOPS, block={"loop0": EMMC_BLOCK["loop0"]}),
    "Wi-Fi and virtual interfaces only": lambda tmp: gb10_with(tmp, nics=("wlP9s9", "docker0")),
    "loopback only": lambda tmp: gb10_with(tmp, nics=()),
}


def gb10_recaptured(tmp: Path) -> Sources:
    capture(recorded(GB10), tmp / "recaptured", Facts())
    return recorded(tmp / "recaptured")


RECORDED = {
    "gb10": lambda tmp: gb10(),
    "gb10, recaptured": gb10_recaptured,
    **ZERO_INSTANCES,
    "degraded box without pressure or network files": lambda tmp: gb10_without(
        tmp, "/proc/pressure", "/sys/class/net", "/proc/self/net/dev"
    ),
    "no nvidia-ml-py": lambda tmp: gb10(nvml=None),
    "no NVIDIA driver": lambda tmp: replace(gb10_without(tmp, "/proc/driver/nvidia"), nvml=None),
    "no meminfo": lambda tmp: gb10_without(tmp, "/proc/meminfo"),
}


@pytest.mark.parametrize("platform", RECORDED)
def test_every_metric_on_a_recorded_platform_is_reported_or_declared_unsupported(
    platform, monkeypatch, tmp_path
):
    info, sample, _ = warm(monkeypatch, RECORDED[platform](tmp_path))
    assert_every_metric_is_reported_or_declared(info, sample)


@pytest.mark.parametrize("platform", RECORDED)
def test_every_flattened_key_the_agent_writes_is_declared_by_a_collector(platform, monkeypatch, tmp_path):
    _, sample, collectors = warm(monkeypatch, RECORDED[platform](tmp_path))
    declared = [k for c in collectors.ordered() for k in c.caps()] + [u.metric for u in collectors.failed]
    assert [k for k in flatten(sample) if not any(covers(d, k) for d in declared)] == []


@pytest.mark.parametrize("node", ["spark1", "spark2", "spark3"])
def test_every_metric_on_a_demo_node_is_reported_or_declared_unsupported(node):
    model = DemoModel(node, time.time() - 3600)
    assert_every_metric_is_reported_or_declared(model._info(), model.sample_at(time.time(), procs=True))


def test_the_demo_declares_what_the_gb10_recording_declares():
    golden = json.loads((GB10 / "golden.json").read_text())["node_info"]["unsupported"]
    assert [u.model_dump(mode="json") for u in UNSUPPORTED] == golden


def test_a_box_without_pressure_files_declares_psi_unsupported(tmp_path):
    info = Collectors(AgentConfig(node_id="n"), gb10_without(tmp_path, "/proc/pressure")).node_info(
        AgentConfig(node_id="n")
    )
    psi = {u.metric: (u.kind, u.reason) for u in info.unsupported if "psi" in u.metric}
    assert psi == {
        "mem.psi_some": ("hardware", MISSING_PSI.format("memory")),
        "mem.psi_full": ("hardware", MISSING_PSI.format("memory")),
        "cpu.psi_some": ("hardware", MISSING_PSI.format("cpu")),
    }


NO_SENSORS = "No temperature sensors exposed (hwmon)"


@pytest.mark.parametrize(
    ("platform", "expected"),
    [
        ("no hwmon", {"temp": ("hardware", NO_SENSORS), "cpu.temp": ("hardware", NO_SENSORS)}),
        (
            "eMMC only",
            {
                "disk": (
                    "agent",
                    "Disk I/O is not collected yet for mmcblk0 "
                    "(Sparkline reads NVMe, SATA/SAS and virtio disks)",
                )
            },
        ),
        ("no physical disks", {"disk": ("hardware", "No physical disks exposed in /proc/diskstats")}),
        (
            "Wi-Fi and virtual interfaces only",
            {
                "net": (
                    "agent",
                    "Only Wi-Fi or virtual interfaces (docker0, wlP9s9), which Sparkline skips "
                    "unless include_virtual = true",
                )
            },
        ),
        ("loopback only", {"net": ("hardware", "No network interfaces exposed besides loopback")}),
    ],
)
def test_a_collector_that_finds_nothing_declares_its_prefix_with_the_true_reason(
    platform, expected, monkeypatch, tmp_path
):
    info, sample, _ = warm(monkeypatch, ZERO_INSTANCES[platform](tmp_path))
    gaps = {u.metric: (u.kind, u.reason) for u in info.unsupported if u.metric in expected}
    assert gaps == expected
    assert [k for k in flatten(sample) if k.startswith("fs.")], "filesystem capacity is still reported"


MISSING_PSI = (
    "Pressure stall information is not exposed: /proc/pressure/{} is missing "
    "(kernel without CONFIG_PSI, or psi=0)"
)


def test_a_key_no_collector_speaks_for_is_declared_not_collected(monkeypatch):
    monkeypatch.setitem(VOCABULARY, "gpu*.vram_used", "gpu")
    info, sample, _ = warm(monkeypatch, gb10())
    (gap,) = [u for u in info.unsupported if u.metric == "gpu*.vram_used"]
    assert (gap.kind, gap.reason) == ("agent", "Not reported by the gpu collector")
    with pytest.raises(AssertionError, match="left part of its vocabulary to the catch-all"):
        assert_every_metric_is_reported_or_declared(info, sample)


def test_the_catch_all_check_reads_the_entry_not_its_wording(monkeypatch):
    info, sample, _ = warm(monkeypatch, gb10())
    own = [
        u.model_copy(update={"reason": "Not reported by the BMC"}) if u.metric == "fan" else u
        for u in info.unsupported
    ]
    assert_every_metric_is_reported_or_declared(info.model_copy(update={"unsupported": own}), sample)


def gb10_nvml(**answers: object) -> Sources:
    calls = json.loads((GB10 / "nvml.json").read_text())
    return gb10(nvml=NvmlReplay({**calls, **{fn: {'["gpu0"]': v} for fn, v in answers.items()}}))


NOT_SUPPORTED = {"__error__": 3, "str": "Not Supported"}


def test_a_gpu_that_reports_a_power_limit_shows_it_and_does_not_declare_it(monkeypatch):
    info, sample, _ = warm(monkeypatch, gb10_nvml(nvmlDeviceGetPowerManagementLimit=140000))
    assert info.gpus[0].power_limit_w == 140.0
    assert "gpu0.power_limit_w" not in {u.metric for u in info.unsupported}
    assert_every_metric_is_reported_or_declared(info, sample)


def test_gpu_readings_nvml_does_not_support_are_declared_at_startup(monkeypatch):
    src = gb10_nvml(
        nvmlDeviceGetPowerUsage=NOT_SUPPORTED,
        nvmlDeviceGetTotalEnergyConsumption=NOT_SUPPORTED,
        nvmlDeviceGetCurrentClocksEventReasons=NOT_SUPPORTED,
    )
    info, sample, _ = warm(monkeypatch, src)
    gaps = {u.metric: u.reason for u in info.unsupported if u.metric.startswith("gpu0.")}
    assert gaps["gpu0.power_w"] == "Power draw not reported by NVIDIA GB10 (NVML: Not Supported)"
    assert gaps["gpu0.energy_j"] == "Energy counter not reported by NVIDIA GB10 (NVML: Not Supported)"
    assert (
        gaps["gpu0.throttle_mask"] == "Clock event reasons not reported by NVIDIA GB10 (NVML: Not Supported)"
    )
    assert_every_metric_is_reported_or_declared(info, sample)


WEB_LOOKUP = re.compile(r"""notReported\(\s*info\s*,\s*['"]([^'"]+)['"]""")


def test_every_key_the_web_asks_about_is_one_the_agent_declares():
    asked = {
        (path.relative_to(WEB).as_posix(), key)
        for path in WEB.rglob("*.tsx")
        if not path.name.endswith(".test.tsx")
        for key in WEB_LOOKUP.findall(path.read_text())
    }
    assert asked, "no notReported(info, '<key>') lookups found under web/src"
    assert sorted((f, k) for f, k in asked if not any(declares(k, v) for v in VOCABULARY)) == []
