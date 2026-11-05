from __future__ import annotations

import json

from web_fixtures import COMMAND, OUT, build

from sparkline.common.schema import NodeInfo, Sample


def test_web_fixtures_match_the_mixed_demo_fleet():
    files = build()
    drifted = sorted(
        rel for rel, text in files.items() if not (OUT / rel).is_file() or (OUT / rel).read_text() != text
    )
    assert not drifted, (
        f"Web fixtures drifted from the mixed demo fleet: {drifted}. Run `cd server && {COMMAND}`"
    )


def test_web_fixtures_hold_valid_wire_data_for_each_platform():
    files = build()
    for platform, gpus in (("gb10", 1), ("workstation", 4)):
        info = NodeInfo.model_validate_json(files[f"{platform}/info.json"])
        sample = Sample.model_validate_json(files[f"{platform}/sample.json"])
        assert len(info.gpus) == len(sample.gpu) == gpus and sample.procs
        assert json.loads(files[f"{platform}/meta.json"])["node"] == info.node_id == sample.node_id
