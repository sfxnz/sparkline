from __future__ import annotations

import json

from synthesized_workstation import COMMAND, NVML_DOCS, NVML_H, OUT, build, read_tree


def test_the_synthesized_workstation_matches_its_generator():
    assert read_tree(OUT) == build(), f"The workstation recording drifted. Run `cd server && {COMMAND}`"


def test_the_synthesized_workstation_says_so_and_names_its_sources_and_assumptions():
    meta = json.loads(build()["platform.json"])
    assert meta["synthesized"] is True and meta["assumed"]
    assert NVML_DOCS in meta["sources"]
    cited = " ".join(meta["sources"])
    for lines in ("250-260", "262-274", "303-313", "6286-6335", "6945-6985", "7214-7240"):
        assert f":{lines}" in cited, lines
    assert any(k.startswith(NVML_H) and "BAR1" in v for k, v in meta["sources"].items())


def test_each_synthesized_gpu_answers_as_nvml_documents_its_memory():
    tree = build()
    calls = json.loads(tree["nvml.json"])
    procs = calls["nvmlDeviceGetComputeRunningProcesses"]
    pids = []
    for key, answer in calls["nvmlDeviceGetMemoryInfo"].items():
        m = answer["__fields__"]
        held = [p["__fields__"]["usedGpuMemory"] for p in procs[key]]
        assert m["total"] == m["free"] + m["used"], key
        assert m["used"] >= sum(held), key
        pids += [p["__fields__"]["pid"] for p in procs[key]]
    dirs = {int(parts[2]) for rel in tree if len(parts := rel.split("/")) == 4 and parts[2].isdigit()}
    assert sorted(pids) == sorted(dirs), "a /proc/<pid> directory for each process NVML lists"
    for pid in pids:
        stat = tree[f"root/proc/{pid}/stat"]
        assert stat.startswith(f"{pid} (") and len(stat.rpartition(")")[2].split()) >= 22
    ticks = calls["nvmlDeviceGetProcessUtilization"].values()
    assert all(v.get("__error__") == 6 for v in ticks), (
        "NOT_FOUND, never a timestamp the next call would miss"
    )
