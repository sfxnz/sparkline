#!/usr/bin/env python3
"""Fake `docker` CLI for runner housekeeping tests (ps -aq --filter label=..., rm -f ID|NAME).

State: $FAKE_DOCKER_STATE is a JSON file {"containers": [{"id", "run", "node"}], "calls": [[argv...]]}.
Without it the fake knows no containers and records nothing, so tests never touch the real Docker daemon.
"""

import json
import os
import sys

path = os.environ.get("FAKE_DOCKER_STATE")
state = {"containers": [], "calls": []}
if path and os.path.exists(path):
    with open(path) as f:
        state = json.load(f)
args = sys.argv[1:]
state["calls"].append(args)
if args[:2] == ["ps", "-aq"]:
    labels = [args[i + 1].removeprefix("label=") for i, a in enumerate(args) if a == "--filter"]
    for c in state["containers"]:
        tags = {"sparkline.bench": c["run"], "sparkline.node": c["node"]}
        ok = all(
            (lab in tags) if "=" not in lab else tags.get(lab.split("=", 1)[0]) == lab.split("=", 1)[1]
            for lab in labels
        )
        if ok:
            print(c["id"])
elif args[:2] == ["rm", "-f"]:
    target = args[2]
    state["containers"] = [
        c
        for c in state["containers"]
        if c.get("stuck") or target not in (c["id"], f"sparkline-bench-{c['run']}")
    ]
if path:
    with open(path, "w") as f:
        json.dump(state, f)
