"""--demo benchmarks: simulated catalog, runs that finish and validate, plausible GB10 numbers, telemetry that
reflects the load, seeded history with a baseline and a regression."""

from __future__ import annotations

import random
import time

import pytest
from fastapi.testclient import TestClient

from sparkline.agent.bench.specs import REGISTRY as AGENT_REGISTRY
from sparkline.common.schema import BenchRun, BenchSpec, Event
from sparkline.console import demo_bench
from sparkline.console.app import create_app
from sparkline.console.bench import REGISTRY, validate_params
from sparkline.console.config import ConsoleConfig
from sparkline.console.demo import DemoModel
from sparkline.console.demo_bench import demo_catalog, demo_duration, make_results, validate

T0 = 1_791_280_000.0


def test_demo_catalog_is_the_agents_catalog():
    s1 = demo_catalog("spark1", DemoModel("spark1", T0).info)
    assert [s.id for s in s1] == REGISTRY == list(AGENT_REGISTRY)
    for s in s1:
        BenchSpec.model_validate_json(s.model_dump_json())
        assert validate_params(s, {}) == validate(s.id, {})  # console-side checks agree with the agent's
        assert s.availability == {"spark1": None}
    s3 = {s.id: s.availability["spark3"] for s in demo_catalog("spark3", DemoModel("spark3", T0).info)}
    assert {k for k, p in s3.items() if p} == {"nccl-allreduce", "rdma-bw-lat"}
    assert s3["rdma-bw-lat"].message == "spark3 has no ConnectX-7 peer"
    desc = {s.id: s.description for s in s1}
    assert "fio is not installed, so the built-in O_DIRECT runner is used" in desc["storage-fio"]
    assert "torch.distributed (NCCL backend)" in desc["nccl-allreduce"]


def test_demo_durations_are_compressed():
    for b in REGISTRY:
        p = validate(b, {})
        real = AGENT_REGISTRY[b].estimate(AGENT_REGISTRY[b].validate(p))
        if b == "thermal-soak":
            assert demo_duration(b, p) == 60
        else:
            assert demo_duration(b, p) == max(4.0, real / 10)
    assert demo_duration("thermal-soak", validate("thermal-soak", {"minutes": 30})) == 90


def _vals(bench: str, node: str = "spark1", seed: int = 0, role: str = "single", info=None, **over):
    info = info or DemoModel(node, T0).info
    results, _ = make_results(bench, validate(bench, over), node, random.Random(seed), role, info)
    return {r.metric: r.value for r in results}


def test_demo_numbers_are_plausible_for_gb10():
    for seed in range(5):
        g = _vals("gpu-matmul", seed=seed)
        assert 90 <= g["bf16_tflops"] <= 100 and 88 <= g["fp16_tflops"] <= 100
        assert (
            1.8 <= g["fp8_tflops"] / g["bf16_tflops"] <= 2.2
            and 1.8 <= g["fp4_tflops"] / g["fp8_tflops"] <= 2.2
        )
        m = _vals("mem-bandwidth", seed=seed)
        assert 220 <= m["gpu_copy_gbps"] <= 250 and 220 <= m["gpu_triad_gbps"] <= 250
        assert 100 <= m["cpu_all_copy_gbps"] <= 130 and 100 <= m["cpu_all_triad_gbps"] <= 130
        r = _vals("rdma-bw-lat", seed=seed, role="client")
        assert 185 <= r["rdma_write_bw"] <= 195 and 2 <= r["rdma_write_lat"] <= 3
        assert _vals("rdma-bw-lat", role="server") == {}  # the client measures
        n = _vals("nccl-allreduce", seed=seed, role="rank0")
        assert 20 <= n["allreduce_busbw_peak"] <= 24 and _vals("nccl-allreduce", role="rank1") == {}
        llm = _vals("llm-inference", seed=seed)
        assert 30 <= llm["decode_tok_s"] <= 60 and 150 <= llm["ttft_p50_ms"] <= 600
        c = _vals("cpu-throughput", seed=seed)
        assert c["single_perf_mbps"] > 1.5 * c["single_eff_mbps"]
    s = _vals("storage-fio")  # fio not installed on the demo nodes: built-in runner, lower 4K IOPS
    assert 5000 <= s["seq_read_mbps"] <= 7000 and 3500 <= s["seq_write_mbps"] <= 5000
    assert s["rand_read_iops"] < 600_000
    fio_info = DemoModel("spark1", T0).info.model_copy(update={"tools": {"fio": True}})
    fio = _vals("storage-fio", info=fio_info)
    assert 6000 <= fio["seq_read_mbps"] <= 7000 and 4000 <= fio["seq_write_mbps"] <= 5000
    assert 600_000 <= fio["rand_read_iops"] <= 900_000
    assert _vals("gpu-matmul", seed=1) != _vals("gpu-matmul", seed=2)  # run-to-run noise


def test_demo_telemetry_reflects_a_running_benchmark():
    m = DemoModel("spark2", T0)
    t = T0 + 4000
    m.bench_windows.append([t, t + 90, 1.0])
    start, later = m.sample_at(t + 2).gpu[0], m.sample_at(t + 85).gpu[0]
    assert start.util >= 95 and later.util >= 95
    assert later.power_w > start.power_w - 1 and later.power_w >= 38
    assert 74 <= later.temp_c <= 84 and later.temp_c > m.sample_at(t - 5).gpu[0].temp_c
    assert later.sm_mhz < 2200 and later.throttle_mask & 0x4  # power capping: clocks sag a little
    assert m.sample_at(t + 200).gpu[0].util < 100  # back to the normal workload afterwards


@pytest.fixture
def demo(tmp_path, monkeypatch):
    monkeypatch.setattr(demo_bench, "demo_duration", lambda bench, p: 1.5)
    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True)) as c:
        yield c


def _wait(c, run_id: str, timeout: float = 15) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = c.get(f"/api/v1/bench/runs/{run_id}").json()
        if r["status"] not in ("queued", "running"):
            return r
        time.sleep(0.1)
    raise AssertionError(f"run {run_id} did not finish")


def test_demo_runs_validate_and_finish(demo):
    plan = [
        (b, ["spark1", "spark2"] if b in ("nccl-allreduce", "rdma-bw-lat") else ["spark1"]) for b in REGISTRY
    ]
    plan.append(("gpu-matmul", ["spark1", "spark2", "spark3"]))
    for bench, nodes in plan:
        r = demo.post("/api/v1/bench/runs", json={"bench_id": bench, "nodes": nodes, "confirm": True})
        assert r.status_code == 201, r.json()
        run = BenchRun.model_validate(_wait(demo, r.json()["id"]))
        assert run.status == "succeeded", (bench, run.error)
        owners = {None} if bench == "nccl-allreduce" else set(nodes)  # all-reduce: a cluster measurement
        assert run.results and all(x.node_id in owners for x in run.results), bench
        assert set(run.metadata["nodes"]) == set(nodes)
        assert run.metadata["nodes"][nodes[0]]["driver"] == "580.173.02"
        assert f"telemetry.{nodes[0]}.util" in run.series
    soak = demo.get("/api/v1/bench/runs?bench_id=thermal-soak&limit=1").json()[0]
    assert {"tflops_first", "temp_max_c", "throttled_pct"} <= {x["metric"] for x in soak["results"]}


def test_demo_rejects_what_the_agent_would(demo):
    def post(bench, nodes, params):
        return demo.post(
            "/api/v1/bench/runs", json={"bench_id": bench, "nodes": nodes, "params": params, "confirm": True}
        )

    r = post("llm-inference", ["spark1"], {"base_url": "http://8.8.8.8/v1"})
    assert r.status_code == 400 and "not a LAN or loopback address" in r.json()["problem"]["cause"]
    r = post("llm-inference", ["spark1"], {"model": "x; rm -rf /"})
    assert r.status_code == 400 and "model name may only contain" in r.json()["problem"]["cause"]
    r = post("rdma-bw-lat", ["spark3", "spark1"], {})
    assert r.status_code == 400 and r.json()["problem"]["message"] == "spark3 has no ConnectX-7 peer"
    r = post("thermal-soak", ["spark2"], {})
    assert r.status_code == 201
    assert post("gpu-matmul", ["spark2"], {}).status_code == 409
    demo.post(f"/api/v1/bench/runs/{r.json()['id']}/cancel")
    assert _wait(demo, r.json()["id"])["status"] == "cancelled"


def test_demo_history_is_seeded_with_a_baseline_and_a_regression(demo):
    runs = [BenchRun.model_validate(r) for r in demo.get("/api/v1/bench/runs").json()]
    assert len(runs) == 12 and {r.bench_id for r in runs} == set(REGISTRY)
    assert {r.status for r in runs} == {"succeeded", "failed", "cancelled"}
    latest = runs[0]
    assert latest.bench_id == "gpu-matmul" and latest.baseline_run_id is not None
    bf16 = next(x for x in latest.results if x.metric == "bf16_tflops")
    assert (bf16.value, bf16.baseline, bf16.regression) == (81.2, 95.0, True)
    assert [x.metric for x in latest.results if x.regression] == ["bf16_tflops"]
    base = BenchRun.model_validate(demo.get(f"/api/v1/bench/runs/{latest.baseline_run_id}").json())
    assert base.baseline_for and base.params_key == latest.params_key
    full = BenchRun.model_validate(demo.get(f"/api/v1/bench/runs/{latest.id}").json())
    assert len(full.series["telemetry.spark1.util"]) == len(full.series["telemetry.spark1.ts"]) > 10
    warn = [
        Event.model_validate(e)
        for e in demo.get("/api/v1/events?severity=warning").json()
        if e["kind"] == "bench"
    ]
    assert [e.title for e in warn] == [
        "Benchmark regression on spark1: BF16 dense GEMM 81.2 TFLOPS vs baseline 95.0 (−14.5%)"
    ]


def test_demo_empty_bench_flag(tmp_path):
    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True)) as c:
        assert len(c.get("/api/v1/bench/runs").json()) == 12
    with TestClient(create_app(cfg, tmp_path / "data", demo=True, demo_empty_bench=True)) as c:
        assert c.get("/api/v1/bench/runs").json() == []
        assert len(c.get("/api/v1/bench/catalog").json()) == 8
