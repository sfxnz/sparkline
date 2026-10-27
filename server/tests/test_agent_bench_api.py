"""Agent bench HTTP API and stream messages (fake payloads, no hardware)."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from test_agent_bench_runner import FAKE_DOCKER, fake, node_info

from sparkline.agent.app import create_app
from sparkline.agent.bench import probes
from sparkline.agent.bench.runner import BenchRunner
from sparkline.agent.sampler import Sampler

TOKEN = "s3cret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path):
    sampler = Sampler("n1", [], 1000)
    runner = BenchRunner(
        "n1",
        node_info,
        lambda: None,
        sampler.publish,
        "img:tag",
        str(tmp_path / "work"),
        jobs={"cpu-throughput": fake("hang"), "storage-fio": fake("ok")},
        probe=lambda: probes.Env(),
        kill_grace_s=0.5,
        docker=str(FAKE_DOCKER),
    )
    app = create_app(sampler, node_info, TOKEN, manage_sampler=False, bench=runner)
    with TestClient(app) as c:
        yield c


def poll(c: TestClient, run_id: str, status: str, timeout: float = 10) -> dict:
    t = time.monotonic() + timeout
    while time.monotonic() < t:
        st = c.get(f"/api/v1/bench/runs/{run_id}", headers=AUTH).json()
        if st["status"] == status:
            return st
        time.sleep(0.05)
    raise AssertionError(f"{run_id} never reached {status}")


def test_auth_required(client):
    assert client.get("/api/v1/bench/catalog").status_code == 401
    assert client.post("/api/v1/bench/runs", json={}).status_code == 401
    assert client.get("/api/v1/bench/runs/x").status_code == 401
    assert client.post("/api/v1/bench/runs/x/cancel").status_code == 401


def test_tokenless_bench_routes_refuse_rebinding_and_browsers(tmp_path):
    sampler = Sampler("n1", [], 1000)
    runner = BenchRunner(
        "n1",
        node_info,
        lambda: None,
        sampler.publish,
        "img:tag",
        str(tmp_path / "work"),
        jobs={"thermal-soak": fake("hang")},
        probe=lambda: probes.Env(),
        docker=str(FAKE_DOCKER),
    )
    app = create_app(sampler, node_info, "", manage_sampler=False, bench=runner)
    body = {"run_id": "x1", "bench_id": "thermal-soak", "params": {"minutes": 60}}
    with TestClient(app, base_url="http://127.0.0.1:29972") as c:
        bad = {"Host": "rebind.attacker.example:29972", "Origin": "http://rebind.attacker.example:29972"}
        assert c.get("/api/v1/bench/catalog", headers=bad).status_code == 403
        assert c.post("/api/v1/bench/runs", headers=bad, json=body).status_code == 403
        assert (
            c.post("/api/v1/bench/runs", headers={"Origin": "http://127.0.0.1:29972"}, json=body).status_code
            == 403
        )
        assert runner.current is None
        assert c.get("/api/v1/bench/catalog").status_code == 200  # the local console still works


def test_catalog(client):
    r = client.get("/api/v1/bench/catalog", headers=AUTH)
    assert r.status_code == 200
    cat = r.json()
    assert [s["id"] for s in cat][:3] == ["gpu-matmul", "mem-bandwidth", "cpu-throughput"] and len(cat) == 10
    assert all(s["availability"] == {"n1": None} for s in cat)


def test_start_busy_get_cancel(client):
    body = {"run_id": "r1", "bench_id": "cpu-throughput", "params": {"seconds_per_test": 1}}
    r = client.post("/api/v1/bench/runs", json=body, headers=AUTH)
    assert r.status_code == 202 and r.json()["status"] == "running" and r.json()["run_id"] == "r1"
    r = client.post("/api/v1/bench/runs", json={**body, "run_id": "r2"}, headers=AUTH)
    assert r.status_code == 409 and "already running" in r.json()["problem"]["message"]
    assert set(r.json()["problem"]) == {"message", "cause", "fix"}
    assert client.get("/api/v1/bench/runs/r1", headers=AUTH).json()["status"] == "running"
    r = client.post("/api/v1/bench/runs/r1/cancel", headers=AUTH)
    assert r.status_code == 202
    poll(client, "r1", "cancelled")
    assert client.get("/api/v1/bench/runs/nope", headers=AUTH).status_code == 404
    assert client.post("/api/v1/bench/runs/nope/cancel", headers=AUTH).status_code == 404


def test_invalid_requests_422(client):
    bad = [
        {"run_id": "r1", "bench_id": "cpu-throughput", "params": {"seconds_per_test": 0}},
        {"run_id": "r1", "bench_id": "cpu-throughput", "params": {"argv": ["sh"]}},
        {"run_id": "r1", "bench_id": "cpu-throughput", "role": "boss"},
        {"bench_id": "cpu-throughput"},
        {"run_id": "r 1", "bench_id": "cpu-throughput"},
    ]
    for body in bad:
        r = client.post("/api/v1/bench/runs", json=body, headers=AUTH)
        assert r.status_code == 422, body
        assert r.json()["problem"]["message"], body


def test_stream_carries_bench_messages(client):
    with client.websocket_connect("/api/v1/stream", headers=AUTH) as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        body = {"run_id": "s1", "bench_id": "storage-fio", "params": {}}
        assert client.post("/api/v1/bench/runs", json=body, headers=AUTH).status_code == 202
        seen = []
        while True:
            m = json.loads(ws.receive_text())
            if m["type"] != "bench":
                continue
            assert m["node_id"] == "n1" and m["run"]["run_id"] == "s1"
            seen.append(m["run"]["status"])
            if m["run"]["status"] not in ("queued", "running"):
                break
    assert seen[0] == "running" and seen[-1] == "succeeded"
    assert len(seen) <= 6  # throttled
