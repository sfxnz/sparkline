from __future__ import annotations

import re
import typing
from pathlib import Path

from sparkline.common.schema import NodeInfo, Unsupported, UnsupportedKind

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


def test_web_types_list_the_same_unsupported_kinds():
    m = re.search(r"UNSUPPORTED_KINDS = \[([^\]]*)\] as const", WEB_TYPES.read_text())
    assert m, f"UNSUPPORTED_KINDS not found in {WEB_TYPES}"
    assert re.findall(r"'([^']+)'", m.group(1)) == list(typing.get_args(UnsupportedKind))
