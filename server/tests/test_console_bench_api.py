"""Benchmark orchestration end-to-end: fake agents (uvicorn threads) <-> real console over real sockets.

Ports (free ones, picked per run): fake agent n1, fake agent n2, console, fake agent n3 (killed mid-run),
restartable console, fake agent n4 (restart tests).
"""

from __future__ import annotations

import copy
import csv
import io
import json
import sys
import time
from pathlib import Path

import httpx
import pytest
from websockets.sync.client import connect as ws_connect

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "console"))
from fakeagent import INFO, ServerThread, bench_defaults, make_fake_agent  # noqa: E402
from netports import free_ports  # noqa: E402

from sparkline.common.schema import BenchRun, BenchSpec  # noqa: E402
from sparkline.console import bench as bench_mod  # noqa: E402
from sparkline.console.app import create_app  # noqa: E402
from sparkline.console.config import ConsoleConfig  # noqa: E402

N1, N2, CONSOLE, N3, CONSOLE2, N4 = free_ports(6)
BROWSER = {"Authorization": "Bearer browser-tok"}


def info_for(node: str, a: str, b: str) -> dict:
    info = copy.deepcopy(INFO)
    info["node_id"] = info["hostname"] = node
    rails = [n for n in info["net"] if n["role"] == "interconnect" and n["ipv4"]]
    rails[0]["ipv4"], rails[1]["ipv4"] = [a], [b]
    return info


def wait_for(pred, timeout: float, what: str):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = pred()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def console_cfg(tmp, nodes: dict[str, int]) -> ConsoleConfig:
    return ConsoleConfig.model_validate(
        {
            "token": "browser-tok",
            "agent_token": "agent-tok",
            "nodes": [{"id": n, "url": f"http://127.0.0.1:{p}"} for n, p in nodes.items()],
            "settings": {"stale_after_s": 0.6, "offline_after_s": 2.5, "regression_pct": 5.0},
            "web_dist": str(tmp / "nodist"),
        }
    )


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    apps = {
        "n1": make_fake_agent("agent-tok", info=info_for("spark1", "10.100.8.1", "10.100.9.1")),
        "n2": make_fake_agent("agent-tok", info=info_for("spark2", "10.100.8.2", "10.100.9.2")),
        "n3": make_fake_agent("agent-tok"),
    }
    threads = {
        "n1": ServerThread(apps["n1"], N1).start(),
        "n2": ServerThread(apps["n2"], N2).start(),
        "n3": ServerThread(apps["n3"], N3).start(),
    }
    tmp = tmp_path_factory.mktemp("bench")
    app = create_app(console_cfg(tmp, {"n1": N1, "n2": N2, "n3": N3}), tmp / "data")
    console = ServerThread(app, CONSOLE).start()
    http = httpx.Client(base_url=f"http://127.0.0.1:{CONSOLE}", headers=BROWSER, timeout=15)
    wait_for(
        lambda: all(n["status"] == "online" for n in http.get("/api/v1/cluster").json()["nodes"]),
        10,
        "online",
    )
    yield {"apps": apps, "threads": threads, "http": http, "app": app}
    http.close()
    console.stop()
    for t in threads.values():
        t.stop()


@pytest.fixture(autouse=True)
def reset_agents(env):
    for a in env["apps"].values():
        a.state.bench.update(bench_defaults())
        a.state.bench_starts.clear()
        a.state.bench_cancels.clear()
    yield


def create(env, bench_id: str, nodes: list[str], params: dict | None = None, confirm: bool = True):
    body = {"bench_id": bench_id, "nodes": nodes, "params": params or {}, "confirm": confirm}
    return env["http"].post("/api/v1/bench/runs", json=body)


def finished(env, run_id: str, timeout: float = 15) -> dict:
    def done():
        r = env["http"].get(f"/api/v1/bench/runs/{run_id}").json()
        return r if r["status"] in ("succeeded", "failed", "cancelled") else None

    return wait_for(done, timeout, f"run {run_id} to finish")


def events(env, limit: int = 20) -> list[dict]:
    return env["http"].get(f"/api/v1/events?limit={limit}").json()


def test_catalog_merges_nodes_and_availability(env):
    specs = [BenchSpec.model_validate(s) for s in env["http"].get("/api/v1/bench/catalog").json()]
    assert [s.id for s in specs] == ["gpu-matmul", "nccl-allreduce", "rdma-bw-lat", "storage-fio"]
    gm = specs[0]
    assert gm.availability == {"n1": None, "n2": None, "n3": None}
    assert gm.max_nodes is None and specs[1].max_nodes == 2  # per-node benches run on any number of nodes
    fio = specs[-1].availability
    assert fio["n1"] is not None and fio["n1"].message == "fio missing"


def test_confirm_and_validation_are_enforced(env):
    r = create(env, "gpu-matmul", ["n1"], confirm=False)
    assert r.status_code == 400 and r.json()["problem"]["message"] == "Confirmation required"
    r = env["http"].post("/api/v1/bench/runs", json={"bench_id": "gpu-matmul", "nodes": ["n1"]})
    assert r.status_code == 422  # confirm missing entirely
    checks = [
        (("nope", ["n1"], {}), 404, "Unknown benchmark"),
        (("gpu-matmul", ["zz"], {}), 400, "Invalid node selection"),
        (("gpu-matmul", ["n1", "n1"], {}), 400, "Invalid node selection"),
        (("rdma-bw-lat", ["n1"], {}), 400, "needs exactly 2 node(s)"),
        (("storage-fio", ["n1"], {}), 400, "fio missing"),
        (("gpu-matmul", ["n1"], {"iterations": 5}), 400, "Invalid benchmark parameters"),
        (("gpu-matmul", ["n1"], {"rm -rf": 1}), 400, "Invalid benchmark parameters"),
    ]
    for args, status, msg in checks:
        r = create(env, *args)
        assert r.status_code == status and msg in r.json()["problem"]["message"], (args, r.json())
    assert all(not a.state.bench_starts for a in env["apps"].values())  # nothing reached an agent


def test_single_node_lifecycle(env):
    before = {e["id"] for e in events(env)}
    env["apps"]["n1"].state.bench["duration"] = 2.0
    r = create(env, "gpu-matmul", ["n1"], {"size": "4096"})
    assert r.status_code == 201
    run = BenchRun.model_validate(r.json())
    assert run.status == "running" and run.params == {"size": "4096", "iterations": 50}
    assert run.params_key == '{"iterations":50,"size":"4096"}'
    ((_, req),) = env["apps"]["n1"].state.bench_starts
    assert req == {
        "run_id": run.id,
        "bench_id": "gpu-matmul",
        "params": run.params,
        "role": "single",
        "rank": None,
        "world_size": None,
        "peer_node": None,
        "peer_ip": None,
        "peer_port": None,
    }
    done = BenchRun.model_validate(finished(env, run.id))
    assert done.status == "succeeded" and done.progress == 1.0 and done.error is None
    assert [(x.metric, x.node_id, x.value) for x in done.results] == [("score", "n1", 100.0)]
    assert done.series["n1.curve"] == [1.0, 2.0, 3.0]
    assert done.metadata["nodes"]["n1"]["driver"] == "580.173.02"
    assert done.node_states["n1"].status == "succeeded"
    tele = done.series["telemetry.n1.util"]
    assert 2 <= len(tele) <= 5 and tele[0] == 54.6 and len(done.series["telemetry.n1.ts"]) == len(tele)
    assert done.log_tail == ["[n1] done"]
    listed = env["http"].get("/api/v1/bench/runs", params={"bench_id": "gpu-matmul", "limit": 1}).json()
    assert listed[0]["id"] == run.id and listed[0]["node_states"] == {} and listed[0]["results"]
    assert not any(k.startswith("telemetry.") for k in listed[0]["series"])
    new = [e for e in events(env) if e["id"] not in before]
    assert {e["title"] for e in new} == {
        "Benchmark started: GPU matmul on n1",
        "Benchmark finished: GPU matmul on n1",
    }
    assert all(e["kind"] == "bench" and e["severity"] == "info" and e["node_id"] == "n1" for e in new)


def test_single_node_bench_on_two_nodes_runs_concurrently(env):
    env["apps"]["n2"].state.bench["value"] = 90.0
    run = create(env, "gpu-matmul", ["n1", "n2"]).json()
    t1 = env["apps"]["n1"].state.bench_starts[0][0]
    t2 = env["apps"]["n2"].state.bench_starts[0][0]
    assert abs(t1 - t2) < 0.5
    done = finished(env, run["id"])
    assert done["status"] == "succeeded"
    assert sorted((x["node_id"], x["value"]) for x in done["results"]) == [("n1", 100.0), ("n2", 90.0)]
    assert set(done["metadata"]["nodes"]) == {"n1", "n2"}


def test_rdma_starts_server_then_client_after_ready(env):
    env["apps"]["n2"].state.bench["ready_delay"] = 0.8
    r = create(env, "rdma-bw-lat", ["n1", "n2"], {"rail": "B"})
    assert r.status_code == 201
    done = finished(env, r.json()["id"])
    assert done["status"] == "succeeded"
    ((ts_server, server),) = env["apps"]["n2"].state.bench_starts
    ((ts_client, client),) = env["apps"]["n1"].state.bench_starts
    assert server["role"] == "server" and server["peer_node"] == "n1"
    assert client["role"] == "client" and client["peer_node"] == "n2"
    assert client["peer_ip"] == "10.100.9.2"  # the server's rail B address
    assert ts_client - ts_server >= 0.8  # not before the server said ready
    assert [x["node_id"] for x in done["results"]] == ["n1"]  # the client measures


def test_nccl_starts_both_ranks(env):
    done = finished(env, create(env, "nccl-allreduce", ["n1", "n2"]).json()["id"])
    assert done["status"] == "succeeded"
    ((t0, r0),) = env["apps"]["n1"].state.bench_starts
    ((t1, r1),) = env["apps"]["n2"].state.bench_starts
    assert abs(t0 - t1) < 0.5
    for i, req in enumerate((r0, r1)):
        assert (req["role"], req["rank"], req["world_size"]) == ("rank", i, 2)
        assert (req["peer_ip"], req["peer_port"]) == ("10.100.8.1", 29620)  # rank 0's rail A
    assert done["results"] and all(r["node_id"] is None for r in done["results"])  # a cluster measurement


def test_agent_409_and_422_are_mapped(env):
    count = len(env["http"].get("/api/v1/bench/runs").json())
    env["apps"]["n1"].state.bench["reject"] = 409
    r = create(env, "gpu-matmul", ["n1"])
    assert r.status_code == 409 and r.json()["problem"]["message"] == "Busy"
    env["apps"]["n1"].state.bench["reject"] = 422
    r = create(env, "gpu-matmul", ["n1"])
    assert r.status_code == 400
    assert r.json()["problem"] == {
        "message": "Invalid parameters",
        "cause": "size: not allowed",
        "fix": "Fix it",
    }
    # a rejected start on one node cancels the other node and leaves no run behind
    r = create(env, "gpu-matmul", ["n2", "n1"])
    assert r.status_code == 400
    wait_for(lambda: env["apps"]["n2"].state.bench_cancels, 5, "n2 cancelled")
    assert len(env["http"].get("/api/v1/bench/runs").json()) == count


def test_console_refuses_a_second_run_on_a_busy_node(env):
    env["apps"]["n1"].state.bench["duration"] = 3.0
    run = create(env, "gpu-matmul", ["n1"]).json()
    r = create(env, "gpu-matmul", ["n1", "n2"])
    assert r.status_code == 409 and "already running on n1" in r.json()["problem"]["message"]
    assert not env["apps"]["n2"].state.bench_starts
    r = env["http"].delete(f"/api/v1/bench/runs/{run['id']}")
    assert r.status_code == 409  # not while running
    env["http"].post(f"/api/v1/bench/runs/{run['id']}/cancel")
    assert finished(env, run["id"])["status"] == "cancelled"


def test_cancel_forwards_and_finishes_cancelled(env):
    before = {e["id"] for e in events(env)}
    env["apps"]["n1"].state.bench["duration"] = 10.0
    env["apps"]["n2"].state.bench["duration"] = 10.0
    run = create(env, "gpu-matmul", ["n1", "n2"]).json()
    time.sleep(0.5)
    r = env["http"].post(f"/api/v1/bench/runs/{run['id']}/cancel")
    assert r.status_code == 202 and r.json()["phase"] == "Cancelling"
    done = finished(env, run["id"], 5)
    assert done["status"] == "cancelled" and done["results"] == []
    assert env["apps"]["n1"].state.bench_cancels == [run["id"]]
    assert env["apps"]["n2"].state.bench_cancels == [run["id"]]
    titles = [e["title"] for e in events(env) if e["id"] not in before]
    assert "Benchmark cancelled: GPU matmul on n1, n2" in titles


def test_cancel_times_out_when_an_agent_never_confirms(env, monkeypatch):
    monkeypatch.setattr(bench_mod, "CANCEL_TIMEOUT_S", 1.5)
    env["apps"]["n1"].state.bench.update(duration=8.0, ignore_cancel=True)
    run = create(env, "gpu-matmul", ["n1"]).json()
    t = time.time()
    env["http"].post(f"/api/v1/bench/runs/{run['id']}/cancel")
    done = finished(env, run["id"], 6)
    assert done["status"] == "cancelled" and time.time() - t < 6
    assert "[console] n1 did not confirm cancellation within 2 s" in done["log_tail"]
    runs = env["apps"]["n1"].state.bench_runs
    wait_for(lambda: all(r["status"] != "running" for r in runs.values()), 10, "the fake agent's run to end")


def test_failure_on_one_node_cancels_the_others(env):
    env["apps"]["n1"].state.bench.update(duration=0.4, fail=True)
    env["apps"]["n2"].state.bench["duration"] = 8.0
    run = create(env, "gpu-matmul", ["n1", "n2"]).json()
    done = finished(env, run["id"], 6)
    assert done["status"] == "failed"
    assert done["error"]["message"] == "GEMM crashed"
    assert done["node_states"]["n2"]["status"] == "cancelled"
    assert env["apps"]["n2"].state.bench_cancels == [run["id"]]


def test_polling_fallback_without_stream_messages(env, monkeypatch):
    monkeypatch.setattr(bench_mod, "POLL_S", 1.0)
    env["apps"]["n1"].state.bench.update(stream=False, duration=0.5)
    run = create(env, "gpu-matmul", ["n1"]).json()
    assert finished(env, run["id"], 6)["status"] == "succeeded"


def test_regression_detection_and_params_gating(env):
    http = env["http"]
    base = finished(env, create(env, "gpu-matmul", ["n1"], {"iterations": 40}).json()["id"])
    r = http.put("/api/v1/bench/baselines/gpu-matmul", json={"run_id": base["id"]})
    assert r.status_code == 200 and r.json()["baseline_for"] is True
    assert any(e["title"] == "Baseline set: GPU matmul" for e in events(env, 5))
    env["apps"]["n1"].state.bench["value"] = 80.0  # 20 % worse
    other = finished(env, create(env, "gpu-matmul", ["n1"], {"iterations": 41}).json()["id"])
    assert other["baseline_run_id"] is None and not other["results"][0]["regression"]
    worse = finished(env, create(env, "gpu-matmul", ["n1"], {"iterations": 40}).json()["id"])
    assert worse["baseline_run_id"] == base["id"]
    res = worse["results"][0]
    assert res["baseline"] == 100.0 and res["regression"] is True
    warn = [e for e in events(env, 5) if e["severity"] == "warning"]
    assert warn and warn[0]["title"] == "Benchmark regression on n1: Score 80.0 pts vs baseline 100 (−20.0%)"
    assert warn[0]["kind"] == "bench" and warn[0]["node_id"] == "n1"
    # only successful runs of the same benchmark can be baselines
    failed = next(x for x in http.get("/api/v1/bench/runs?status=failed").json())
    assert http.put("/api/v1/bench/baselines/gpu-matmul", json={"run_id": failed["id"]}).status_code == 400
    assert http.put("/api/v1/bench/baselines/rdma-bw-lat", json={"run_id": base["id"]}).status_code == 400
    assert http.put("/api/v1/bench/baselines/gpu-matmul", json={"run_id": "zzzz"}).status_code == 404


def test_export_compare_delete(env):
    http = env["http"]
    a = finished(env, create(env, "gpu-matmul", ["n1"]).json()["id"])
    env["apps"]["n2"].state.bench["value"] = 77.0
    b = finished(env, create(env, "gpu-matmul", ["n1", "n2"]).json()["id"])
    r = http.get(f"/api/v1/bench/runs/{a['id']}/export?format=json")
    assert r.headers["content-disposition"] == f'attachment; filename="sparkline-gpu-matmul-{a["id"]}.json"'
    assert BenchRun.model_validate(r.json()).id == a["id"]
    r = http.get(f"/api/v1/bench/runs/{b['id']}/export", params={"format": "csv"})
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"].endswith(f'filename="sparkline-gpu-matmul-{b["id"]}.csv"')
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert [(x["node_id"], x["value"], x["suite_git"]) for x in rows] == [
        ("n1", "100.0", "abc1234"),
        ("n2", "77.0", "abc1234"),
    ]
    assert http.get(f"/api/v1/bench/runs/{a['id']}/export?format=xml").status_code == 422
    cmp = http.get(f"/api/v1/bench/compare?ids={a['id']},{b['id']}").json()
    assert [x["id"] for x in cmp["runs"]] == [a["id"], b["id"]]
    assert cmp["metrics"] == [
        {
            "metric": "score",
            "label": "Score",
            "unit": "pts",
            "better": "higher",
            "node_id": "n1",
            "values": {a["id"]: 100.0, b["id"]: 100.0},
        },
        {
            "metric": "score",
            "label": "Score",
            "unit": "pts",
            "better": "higher",
            "node_id": "n2",
            "values": {b["id"]: 77.0},
        },
    ]
    assert http.get(f"/api/v1/bench/compare?ids={a['id']},nope").status_code == 404
    assert http.get("/api/v1/bench/compare?ids=").status_code == 400
    assert http.delete(f"/api/v1/bench/runs/{a['id']}").status_code == 200
    assert http.get(f"/api/v1/bench/runs/{a['id']}").status_code == 404
    assert http.delete(f"/api/v1/bench/runs/{a['id']}").status_code == 404


def test_browser_stream_is_throttled_and_terminal_is_full(env):
    env["apps"]["n1"].state.bench.update(duration=2.5, steps=25)  # 10 agent updates per second
    with ws_connect(f"ws://127.0.0.1:{CONSOLE}/api/v1/stream", additional_headers=BROWSER) as ws:
        run = create(env, "gpu-matmul", ["n1"]).json()
        got: list[tuple[float, dict]] = []
        deadline = time.time() + 10
        while time.time() < deadline:
            msg = json.loads(ws.recv(timeout=5))
            if msg["type"] == "bench" and msg["run"]["id"] == run["id"]:
                got.append((time.time(), msg["run"]))
                if msg["run"]["status"] == "succeeded":
                    break
    assert got[-1][1]["status"] == "succeeded"
    live = got[:-1]
    assert 3 <= len(live) <= 9  # ~2/s over 2.5 s, never 25
    gaps = [b[0] - a[0] for a, b in zip(live, live[1:], strict=False)]
    assert min(gaps) >= 0.4
    assert not any(k.startswith("telemetry.") for _, r in live for k in r["series"])
    assert "telemetry.n1.util" in got[-1][1]["series"]


def test_disconnect_mid_run_fails_the_run(env):
    env["apps"]["n3"].state.bench["duration"] = 30.0
    run = create(env, "gpu-matmul", ["n3"]).json()
    time.sleep(0.5)
    env["threads"]["n3"].stop()
    done = finished(env, run["id"], 10)
    assert done["status"] == "failed"
    assert done["error"]["message"] == "Lost contact with n3 during the run"
    assert "systemctl status sparkline-agent" in done["error"]["fix"]
    ev = next(e for e in events(env, 10) if e["title"].startswith("Benchmark failed"))
    assert ev["title"] == "Benchmark failed: GPU matmul on n3"
    assert "Lost contact with n3" in ev["detail"]


def test_console_restart_recovers_or_fails_runs(tmp_path):
    agent_app = make_fake_agent("agent-tok")
    agent = ServerThread(agent_app, N4).start()
    cfg = console_cfg(tmp_path, {"n4": N4})
    http = httpx.Client(base_url=f"http://127.0.0.1:{CONSOLE2}", headers=BROWSER, timeout=15)

    def boot() -> ServerThread:
        c = ServerThread(create_app(cfg, tmp_path / "data"), CONSOLE2).start()
        wait_for(lambda: http.get("/api/v1/cluster").json()["nodes"][0]["status"] == "online", 10, "online")
        return c

    console = None
    try:
        console = boot()
        agent_app.state.bench["duration"] = 3.0
        kept = create({"http": http}, "gpu-matmul", ["n4"]).json()
        console.stop()  # the agent keeps running the benchmark
        console = boot()
        done = finished({"http": http}, kept["id"], 15)
        assert done["status"] == "succeeded" and done["results"][0]["value"] == 100.0

        agent_app.state.bench["duration"] = 10.0
        lost = create({"http": http}, "gpu-matmul", ["n4"]).json()
        console.stop()
        agent_app.state.bench_runs.clear()  # e.g. the agent restarted too
        for t in agent_app.state.bench_tasks.values():
            agent.loop.call_soon_threadsafe(t.cancel)
        console = boot()
        done = finished({"http": http}, lost["id"], 15)
        assert done["status"] == "failed"
        assert done["error"]["message"] == "Console restarted during the run"
    finally:
        if console:
            console.stop()
        http.close()
        agent.stop()
