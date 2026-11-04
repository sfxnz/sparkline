"""Demo fleets: node_id -> a factory (t0, speed) for that simulated node. --demo runs "dgx"."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial

from .demo import NODES, DemoModel, DemoNode

NodeFactory = Callable[[float, float], DemoNode]

DGX: dict[str, NodeFactory] = {nid: partial(DemoModel, nid) for nid in NODES}

FLEETS: dict[str, dict[str, NodeFactory]] = {
    "dgx": DGX,
}
