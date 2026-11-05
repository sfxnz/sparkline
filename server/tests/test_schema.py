from __future__ import annotations

import json
import re
import typing
from pathlib import Path

from sparkline.common.schema import MemoryModel, NodeInfo, Unsupported, UnsupportedKind

WEB_TYPES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "types.ts"


def test_an_unsupported_entry_without_a_kind_reads_as_not_reported_by_the_hardware():
    old = Unsupported.model_validate({"metric": "gpu0.power_limit_w", "reason": "NVML: Not Supported"})
    assert old.kind == "hardware"
    for kind in typing.get_args(UnsupportedKind):
        entry = Unsupported(metric="gpu*", reason="r", kind=kind)
        assert Unsupported.model_validate(entry.model_dump()) == entry


def test_node_info_from_an_agent_that_predates_kinds_reads_every_entry_as_hardware():
    info = (Path(__file__).parent / "fixtures/console/node_info.json").read_text()
    entries = NodeInfo.model_validate_json(info).unsupported
    assert entries and {u.kind for u in entries} == {"hardware"}


def test_a_kind_this_console_predates_reads_as_hardware_and_keeps_the_hello():
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    info["unsupported"] = [
        {"metric": "gpu0.power_limit_w", "reason": "Needs CAP_PERFMON", "kind": "capability"},
        {"metric": "fan", "reason": "No fan sensors", "kind": None},
        {"metric": "gpu*", "reason": "Install nvidia-ml-py", "kind": "dependency"},
    ]
    entries = NodeInfo.model_validate(info).unsupported
    assert [(u.reason, u.kind) for u in entries] == [
        ("Needs CAP_PERFMON", "hardware"),
        ("No fan sensors", "hardware"),
        ("Install nvidia-ml-py", "dependency"),
    ]


def test_web_types_list_the_same_unsupported_kinds():
    m = re.search(r"UNSUPPORTED_KINDS = \[([^\]]*)\] as const", WEB_TYPES.read_text())
    assert m, f"UNSUPPORTED_KINDS not found in {WEB_TYPES}"
    assert re.findall(r"'([^']+)'", m.group(1)) == list(typing.get_args(UnsupportedKind))


def test_node_info_from_an_agent_that_predates_gpu_backends_reads_with_defaults_and_its_versions():
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    assert not {"platform", "versions"} & set(info) and not {"vendor", "backend"} & set(info["gpus"][0])
    info |= {"driver": "999.0", "cuda": "1.2", "nvml": "1.2.3"}
    parsed = NodeInfo.model_validate(info)
    assert parsed.platform == "linux"
    assert parsed.versions == {"nvidia.Driver": "999.0", "nvidia.CUDA": "1.2", "nvidia.NVML": "1.2.3"}
    assert [(g.vendor, g.backend) for g in parsed.gpus] == [("nvidia", "nvml")]


def test_versions_an_agent_sends_are_kept_as_sent():
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    info |= {"driver": None, "cuda": None, "nvml": None}
    assert NodeInfo.model_validate(info).versions == {}
    info |= {"driver": "999.0", "versions": {"amd.Driver": "1.2.3"}}
    assert NodeInfo.model_validate(info).versions == {"amd.Driver": "1.2.3"}


def test_a_vendor_or_platform_this_console_predates_keeps_the_hello_and_is_kept_as_sent():
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    info["platform"] = "freebsd"
    info["gpus"][0] |= {"vendor": "intel", "backend": "level-zero"}
    parsed = NodeInfo.model_validate(info)
    assert parsed.platform == "freebsd"
    assert [(g.vendor, g.backend) for g in parsed.gpus] == [("intel", "level-zero")]
    assert NodeInfo.model_validate_json(parsed.model_dump_json()) == parsed


def test_a_gpu_from_an_agent_that_predates_memory_models_or_sends_an_unknown_one_reads_as_unified():
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    assert not {"memory", "vram_total"} & set(info["gpus"][0])
    old = NodeInfo.model_validate(info).gpus[0]
    assert (old.memory, old.vram_total) == ("unified", None)
    info["gpus"][0] |= {"memory": "stacked-hbm", "vram_total": 2**30}
    newer = NodeInfo.model_validate(info).gpus[0]
    assert (newer.memory, newer.vram_total) == ("unified", 2**30)
    for model in typing.get_args(MemoryModel):
        info["gpus"][0]["memory"] = model
        assert NodeInfo.model_validate(info).gpus[0].memory == model
