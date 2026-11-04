"""Demo fleets: node_id -> a factory (t0, speed) for that simulated node.

--demo runs "dgx", the DGX Spark cluster; --demo-mixed runs "mixed", which adds other hardware.
"""

from __future__ import annotations

from collections.abc import Callable
from functools import partial

from .demo import NODES, DemoModel, DemoNode
from .demo_workstation import WorkstationModel

NodeFactory = Callable[[float, float], DemoNode]

DGX: dict[str, NodeFactory] = {nid: partial(DemoModel, nid) for nid in NODES}

FLEETS: dict[str, dict[str, NodeFactory]] = {
    "dgx": DGX,
    "mixed": {**DGX, "ws1": partial(WorkstationModel, "ws1")},
}
