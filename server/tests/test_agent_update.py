"""POST /api/v1/update: the agent leaves a request for its root helper (sparkline-update.path)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_agent_bench_api import AUTH, TOKEN, poll
from test_agent_bench_runner import FAKE_DOCKER, fake, node_info

from sparkline.agent.app import create_app
from sparkline.agent.bench import probes
from sparkline.agent.bench.runner import BenchRunner
from sparkline.agent.sampler import Sampler

PATH_UNIT = """\
[Path]
PathExists=/var/lib/sparkline-agent/update-request
"""


def helper_installed(root: Path) -> Path:
    units = root / "etc/systemd/system"
    units.mkdir(parents=True)
    (units / "sparkline-update.path").write_text(PATH_UNIT)
    state = root / "var/lib/sparkline-agent"
    state.mkdir(parents=True)
    return state


def agent(tmp_path: Path, update_root: Path | None) -> TestClient:
    sampler = Sampler("n1", [], 1000)
    runner = BenchRunner(
        "n1",
        node_info,
        lambda: None,
        sampler.publish,
        "img:tag",
        str(tmp_path / "work"),
        jobs={"cpu-throughput": fake("hang")},
        probe=lambda: probes.Env(),
        kill_grace_s=0.5,
        docker=str(FAKE_DOCKER),
    )
    return TestClient(create_app(sampler, node_info, TOKEN, False, runner, update_root=update_root))


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "root"


def test_request_lands_where_the_path_unit_watches_and_repeats_collapse(tmp_path: Path, root: Path) -> None:
    state = helper_installed(root)
    with agent(tmp_path, root) as c:
        for _ in range(3):
            r = c.post("/api/v1/update", headers=AUTH)
            assert r.status_code == 202, r.text
    assert sorted(p.name for p in state.iterdir()) == ["update-request"]
    assert (state / "update-request").read_bytes() == b""


def test_update_needs_the_agent_token(tmp_path: Path, root: Path) -> None:
    state = helper_installed(root)
    with agent(tmp_path, root) as c:
        assert c.post("/api/v1/update").status_code == 401
        assert c.post("/api/v1/update", headers={"Authorization": "Bearer wrong-token"}).status_code == 401
    assert list(state.iterdir()) == []


@pytest.mark.parametrize("installed", [False, True])
def test_without_the_root_helper_the_node_says_it_cannot_update_itself(
    tmp_path: Path, root: Path, installed: bool
) -> None:
    if installed:
        helper_installed(root)
        (root / "etc/systemd/system/sparkline-update.path").write_text("[Path]\n")
    else:
        root.mkdir()
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/update", headers=AUTH)
    assert r.status_code == 501
    assert r.json()["problem"]["message"] == "n1 cannot update itself"


def test_an_agent_given_no_root_cannot_update_itself(tmp_path: Path) -> None:
    with agent(tmp_path, None) as c:
        assert c.post("/api/v1/update", headers=AUTH).status_code == 501


def test_a_running_benchmark_refuses_the_update_until_it_ends(tmp_path: Path, root: Path) -> None:
    state = helper_installed(root)
    with agent(tmp_path, root) as c:
        body = {"run_id": "r1", "bench_id": "cpu-throughput", "params": {"seconds_per_test": 1}}
        assert c.post("/api/v1/bench/runs", json=body, headers=AUTH).status_code == 202
        r = c.post("/api/v1/update", headers=AUTH)
        assert r.status_code == 409
        assert r.json()["problem"]["message"] == "A benchmark is running on n1"
        assert list(state.iterdir()) == []
        c.post("/api/v1/bench/runs/r1/cancel", headers=AUTH)
        poll(c, "r1", "cancelled")
        assert c.post("/api/v1/update", headers=AUTH).status_code == 202
    assert (state / "update-request").exists()
