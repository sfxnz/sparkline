from __future__ import annotations

import itertools
import json
import re
import time
import typing

import pytest
from platforms import GB10, gb10, gb10_without

from sparkline.agent.collectors import VOCABULARY, covers, declares
from sparkline.agent.collectors.gpu import VIOLATION_EVERY_S
from sparkline.agent.config import AgentConfig
from sparkline.agent.info import Collectors
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import NvmlReplay, Sources
from sparkline.common.metrics import flatten
from sparkline.common.schema import NodeInfo, Sample, UnsupportedKind
from sparkline.console.demo import UNSUPPORTED, DemoModel

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
    if key.endswith(PROBED_ONLY):
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
    assert {"fan", "system.power_w"} <= {u.metric for u in gaps}


def warm(monkeypatch: pytest.MonkeyPatch, src: Sources) -> tuple[NodeInfo, Sample, Collectors]:
    clock = itertools.count(1000.0, VIOLATION_EVERY_S + 1)
    monkeypatch.setattr(time, "monotonic", lambda: next(clock))
    cfg = AgentConfig(node_id="gb10")
    collectors = Collectors(cfg, src)
    sampler = Sampler(cfg.node_id, collectors.ordered(), ring_seconds=10)
    sampler.tick()
    return collectors.node_info(cfg), sampler.tick(), collectors


RECORDED = {
    "gb10": lambda tmp: gb10(),
    "degraded box without pressure or network files": lambda tmp: gb10_without(
        tmp, "/proc/pressure", "/sys/class/net", "/proc/self/net/dev"
    ),
    "no nvidia-ml-py": lambda tmp: gb10(nvml=None),
    "no hwmon": lambda tmp: gb10_without(tmp, "/sys/class/hwmon"),
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


MISSING_PSI = (
    "Pressure stall information is not exposed: /proc/pressure/{} is missing "
    "(kernel without CONFIG_PSI, or psi=0)"
)


def test_a_key_no_collector_speaks_for_is_declared_not_collected(monkeypatch):
    monkeypatch.setitem(VOCABULARY, "gpu*.vram_used", "gpu")
    info = Collectors(AgentConfig(node_id="n"), gb10()).node_info(AgentConfig(node_id="n"))
    (gap,) = [u for u in info.unsupported if u.metric == "gpu*.vram_used"]
    assert (gap.kind, gap.reason) == ("agent", "Not reported by the gpu collector")


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
