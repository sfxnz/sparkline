"""Rail letters: the agent names them, rails() reads them back, and old agents' labels still give them."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sparkline.common.netutil import rails
from sparkline.common.schema import NetIfInfo, NodeInfo
from sparkline.console.bench import rail_ip

SHARED = json.loads((Path(__file__).parents[2] / "web/src/test/fixtures/rails.json").read_text())["cases"]


def _info(net: list[dict]) -> NodeInfo:
    return NodeInfo.model_construct(net=[NetIfInfo.model_validate(n) for n in net])


@pytest.mark.parametrize("case", SHARED, ids=[c["case"] for c in SHARED])
def test_rails_match_the_fixture_the_web_also_checks(case):
    assert {letter: n.name for letter, n in rails(_info(case["net"])).items()} == case["rails"]


def test_a_spare_port_is_never_a_rail_even_with_an_address():
    case = next(c for c in SHARED if c["case"].startswith("Only the second port"))
    info = _info(case["net"])
    assert rail_ip(info, "A") == "192.0.2.1" and rail_ip(info, "B") is None


def test_old_agent_labels_give_the_rail_letters():
    old = [
        {
            "name": "enp1s0f1np1",
            "role": "interconnect",
            "label": "ConnectX-7 rail A",
            "ipv4": ["203.0.113.1"],
        },
        {
            "name": "enP2p1s0f1np1",
            "role": "interconnect",
            "label": "ConnectX-7 rail B",
            "ipv4": ["192.0.2.1"],
        },
        {"name": "enp1s0f0np0", "role": "interconnect", "label": "ConnectX-7 port (no cable)"},
        {"name": "enP7s7", "role": "lan", "label": "LAN"},
    ]
    assert {letter: n.name for letter, n in rails(_info(old)).items()} == {
        "A": "enp1s0f1np1",
        "B": "enP2p1s0f1np1",
    }


def test_a_new_agents_label_is_never_read_for_a_rail():
    sent = {"name": "enp1s0f0np0", "role": "interconnect", "label": "ConnectX-7 rail A", "rail": None}
    assert NetIfInfo.model_validate(sent).rail is None
