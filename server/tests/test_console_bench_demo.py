"""--demo benchmarks: simulated catalog, runs that finish and validate, plausible GB10 numbers, telemetry that
reflects the load, seeded history with a baseline and a regression."""

from __future__ import annotations

import json
import random
import time

import pytest
from fastapi.testclient import TestClient
from test_agent_bench_runner import amd_info, mac_info

from sparkline.agent.bench.runner import DETAIL_MAX_BYTES, LIVE_MAX_BYTES
from sparkline.agent.bench.specs import REGISTRY as AGENT_REGISTRY
from sparkline.common.schema import BenchRun, BenchSpec, BenchStartRequest, Event, NodeBenchState
from sparkline.console import demo_bench
from sparkline.console.app import create_app
from sparkline.console.bench import REGISTRY, BenchError, params_key, validate_params
from sparkline.console.bench_store import BenchStore
from sparkline.console.config import ConsoleConfig
from sparkline.console.demo import BenchWindow, DemoModel
from sparkline.console.demo_bench import (
    demo_catalog,
    demo_duration,
    make_results,
    seed_history,
    soak_point,
    soak_results,
    validate,
)
from sparkline.console.demo_fleets import FLEETS
from sparkline.console.demo_workstation import SM_MAX_MHZ
from sparkline.console.store import Store

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


def test_a_node_without_rdma_cannot_run_multi_node_benchmarks_and_says_why():
    info = FLEETS["mixed"]["ws1"](T0, 1.0).info
    ws1 = {s.id: s.availability["ws1"] for s in demo_catalog("ws1", info)}
    rdma = [ws1["nccl-allreduce"], ws1["rdma-bw-lat"]]
    assert all(p and p.message == "ws1 has no RDMA interconnect" for p in rdma)
    assert all(p and "ConnectX-7" not in p.cause for p in rdma)


def test_demo_results_modelled_on_gb10_are_offered_only_on_gb10_nodes(tmp_path):
    gb10_only = {"gpu-matmul", "mem-bandwidth", "cpu-throughput", "storage-fio"}
    reason = "Demo results are modelled on GB10 only"
    info = FLEETS["mixed"]["ws1"](T0, 1.0).info
    ws1 = {s.id: s.availability["ws1"] for s in demo_catalog("ws1", info)}
    assert {k for k, p in ws1.items() if p} == gb10_only | {"nccl-allreduce", "rdma-bw-lat"}
    assert {ws1[b].message for b in gb10_only} == {reason}

    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True, fleet="mixed")) as c:
        catalog = {s["id"]: s["availability"] for s in c.get("/api/v1/bench/catalog").json()}
        for bench in sorted(gb10_only):
            assert catalog[bench]["ws1"]["message"] == reason
            assert catalog[bench]["spark1"] is None
            r = c.post("/api/v1/bench/runs", json={"bench_id": bench, "nodes": ["ws1"], "confirm": True})
            assert r.status_code == 400 and r.json()["problem"]["message"] == reason


GPU_BENCHES = ("gpu-matmul", "mem-bandwidth", "nccl-allreduce", "thermal-soak")


@pytest.mark.parametrize(
    ("info", "fix"), [(amd_info, "AMD GPUs (ROCm) yet"), (mac_info, "Apple GPUs yet")], ids=["amd", "mac"]
)
def test_the_demo_says_gpu_benchmarks_need_an_nvidia_gpu_on_other_hardware(info, fix):
    av = {s.id: s.availability["n1"] for s in demo_catalog("n1", info())}
    assert all(av[b] and av[b].message == "GPU benchmarks need an NVIDIA GPU" for b in GPU_BENCHES), av
    assert all(fix in av[b].fix for b in GPU_BENCHES)


def test_ws1_offers_its_four_gpus_to_the_gpu_benchmarks_and_spark1_offers_none():
    ws1 = {s.id: s.gpu_options for s in demo_catalog("ws1", FLEETS["mixed"]["ws1"](T0, 1.0).info)}
    assert {b for b, o in ws1.items() if o} == set(GPU_BENCHES)
    assert [(o.index, o.problem) for o in ws1["thermal-soak"]["ws1"]] == [(i, None) for i in range(4)]
    assert all(s.gpu_options == {} for s in demo_catalog("spark1", DemoModel("spark1", T0).info))


def test_ws1_benchmark_load_lands_on_the_gpu_the_run_chose():
    t = T0 + 4000
    idle, busy = FLEETS["mixed"]["ws1"](T0, 1.0), FLEETS["mixed"]["ws1"](T0, 1.0)
    busy.bench_windows.append(BenchWindow(t, t + 90, 1.0, gpu=2))
    before = {g.index: g.util for g in idle.sample_at(t + 60).gpu}
    during = {g.index: g.util for g in busy.sample_at(t + 60).gpu}
    assert during.pop(2) >= 95 and before.pop(2) < 95 and during == before


def test_a_ws1_thermal_soak_on_gpu_2_records_gpu_2(mixed):
    body = {"bench_id": "thermal-soak", "nodes": ["ws1"], "gpu_index": {"ws1": 2}, "confirm": True}
    r = mixed.post("/api/v1/bench/runs", json=body)
    assert r.status_code == 201, r.json()
    run = BenchRun.model_validate(_wait(mixed, r.json()["id"]))
    assert run.status == "succeeded" and run.results, run.error
    md = run.metadata["nodes"]["ws1"]
    gpu2 = next(g for g in FLEETS["mixed"]["ws1"](T0, 1.0).info.gpus if g.index == 2)
    assert run.gpu_index == {"ws1": 2} and (md["gpu_index"], md["gpu_uuid"]) == (2, gpu2.uuid)
    assert "ws1.gpu2.sm_mhz" in run.series and not any(k.startswith("ws1.gpu0.") for k in run.series)
    assert {"sm_mhz_mean", "temp_max_c", "throttled_pct"} <= {x.metric for x in run.results}


async def test_the_demo_backend_refuses_a_gpu_ws1_cannot_run_on_as_its_agent_would(mixed):
    deadline = time.time() + 10
    while mixed.app.state.cluster.sources["ws1"].state.info is None and time.time() < deadline:
        time.sleep(0.05)
    req = BenchStartRequest(run_id="x1", bench_id="thermal-soak", gpu_index=9)
    with pytest.raises(BenchError) as e:
        await mixed.app.state.bench.backend.start("ws1", req)
    assert (e.value.status, e.value.problem.message) == (400, "GPU 9 is not a GPU of ws1")


def test_off_gb10_a_demo_run_estimated_from_gb10_rates_reports_no_estimate(mixed):
    run = _llm_run(mixed, "ws1", False)
    assert run.node_states["ws1"].metadata["est_duration_s"] is None
    assert run.metadata["nodes"]["ws1"]["est_duration_s"] is None
    assert "est_duration_s" not in _llm_run(mixed, "spark1", False).metadata["nodes"]["spark1"]


def _soak(model, gpu: int = 0) -> dict[str, float]:
    series: dict[str, list[float]] = {}
    rng = random.Random(0)
    for k in range(0, 60, 2):
        for key, v in soak_point(model, T0 + k, rng, gpu).items():
            series.setdefault(key, []).append(v)
    return {r.metric: r.value for r in soak_results(series, gpu)}


def test_the_thermal_soak_reports_gb10_throughput_only_on_gb10():
    ws1 = _soak(FLEETS["mixed"]["ws1"](T0, 1.0))
    assert not any("tflops" in m for m in ws1)
    assert {"sm_mhz_mean", "sm_mhz_min", "temp_max_c", "throttled_pct", "power_capped_pct"} <= set(ws1)
    assert 2000 <= ws1["sm_mhz_mean"] <= SM_MAX_MHZ
    spark1 = _soak(DemoModel("spark1", T0))
    assert 80 <= spark1["tflops_first"] <= 100 and "tflops_change_pct" in spark1


def test_seeded_history_stays_on_the_dgx_cluster_in_the_mixed_fleet(tmp_path):
    store = Store(tmp_path / "c.sqlite")
    bench = BenchStore(store.db)
    models = {nid: make(T0, 1.0) for nid, make in FLEETS["mixed"].items()}
    seed_history(bench, models, 5.0, store.add_event, now=T0)
    runs = bench.run_list(limit=100)
    assert len(runs) == len(demo_bench._SEED) and all("ws1" not in r.nodes for r in runs)
    assert models["ws1"].bench_windows == [] and models["ws1"].disk_windows == []


def test_demo_durations_are_compressed():
    for b in REGISTRY:
        p = validate(b, {})
        real = AGENT_REGISTRY[b].estimate(AGENT_REGISTRY[b].validate(p))
        if b == "thermal-soak":
            assert demo_duration(b, p) == 60
        elif b == "llm-inference":  # compressed less, so its streams can be watched
            assert 6 <= demo_duration(b, p) <= real / 4
        elif b == "llm-showcase":  # likewise: the streams play at double speed, 4 s at least
            assert 4.6 <= demo_duration(b, p) <= real / 3
        else:
            assert demo_duration(b, p) == max(4.0, real / 10)
    assert demo_duration("thermal-soak", validate("thermal-soak", {"minutes": 30})) == 90
    sweep = validate("llm-inference", {"concurrency": 32, "sweep": True})
    assert 0.6 + 6 * 4 <= demo_duration("llm-inference", sweep) <= 60  # 6 levels, each on screen 4 s or more


def _vals(bench: str, node: str = "spark1", seed: int = 0, role: str = "single", info=None, **over):
    info = info or DemoModel(node, T0).info
    results, _ = make_results(bench, validate(bench, over), node, random.Random(seed), role, info)
    return {r.metric: r.value for r in results}


def test_demo_numbers_are_plausible_for_gb10():
    for seed in range(5):
        g = _vals("gpu-matmul", seed=seed)
        # measured: BF16 98.4-99.2, FP16 97.7-98.9, FP8/BF16 1.98-2.02, FP4/FP8 1.74-1.77
        assert 93 <= g["bf16_tflops"] <= 104 and 93 <= g["fp16_tflops"] <= 104
        assert (
            1.85 <= g["fp8_tflops"] / g["bf16_tflops"] <= 2.15
            and 1.65 <= g["fp4_tflops"] / g["fp8_tflops"] <= 1.9
        )
        m = _vals("mem-bandwidth", seed=seed)
        assert 205 <= m["gpu_copy_gbps"] <= 240 and 205 <= m["gpu_triad_gbps"] <= 240
        assert 100 <= m["cpu_all_copy_gbps"] <= 140 and 100 <= m["cpu_all_triad_gbps"] <= 140
        assert 0.85 <= m["cpu_eff_copy_gbps"] / m["cpu_perf_copy_gbps"] <= 1.25  # sets span both clusters
        r = _vals("rdma-bw-lat", seed=seed, role="client")
        assert 105 <= r["rdma_write_bw"] <= 112 and 1.3 <= r["rdma_write_lat"] <= 1.6  # measured: 108.9, 1.4
        assert r["rdma_write_lat"] < r["rdma_write_lat_p99"] <= 2.2
        assert _vals("rdma-bw-lat", role="server") == {}  # the client measures
        n = _vals("nccl-allreduce", seed=seed, role="rank0")
        assert 20 <= n["allreduce_busbw_peak"] <= 24 and _vals("nccl-allreduce", role="rank1") == {}
        assert 11 <= n["allreduce_latency_small"] <= 16  # measured: 12.4-14.5 us for 8 B-2 KiB
        llm = _vals("llm-inference", seed=seed)
        assert 30 <= llm["decode_tok_s"] <= 60 and 150 <= llm["ttft_p50_ms"] <= 600
        c = _vals("cpu-throughput", seed=seed)
        assert 230 <= c["single_perf_mbps"] <= 260 and 115 <= c["single_eff_mbps"] <= 135  # real: 246, 125
        assert 1.8 <= c["single_perf_mbps"] / c["single_eff_mbps"] <= 2.2  # real: 1.97
        scaling = c["multi_all_mbps"] / (c["multi_perf_mbps"] + c["multi_eff_mbps"])
        assert 0.95 <= scaling <= 1.02  # real: 0.988
    s = _vals("storage-fio")  # fio not installed on the demo nodes: built-in runner, lower 4K IOPS
    assert 8000 <= s["seq_read_mbps"] <= 9500 and 5800 <= s["seq_write_mbps"] <= 7800  # real GB/s
    assert 12_000 <= s["rand_read_iops"] <= 17_000 and 600 <= s["rand_read_p99_us"] <= 1000  # real, QD 4
    fio_info = DemoModel("spark1", T0).info.model_copy(update={"tools": {"fio": True}})
    fio = _vals("storage-fio", info=fio_info)
    assert fio["seq_read_mbps"] > s["seq_read_mbps"] and fio["seq_write_mbps"] >= 0.9 * s["seq_write_mbps"]
    assert 600_000 <= fio["rand_read_iops"] <= 900_000
    assert _vals("gpu-matmul", seed=1) != _vals("gpu-matmul", seed=2)  # run-to-run noise


def test_demo_telemetry_reflects_a_running_benchmark():
    m = DemoModel("spark2", T0)
    t = T0 + 4000
    m.bench_windows.append(BenchWindow(t, t + 90, 1.0))
    start, later = m.sample_at(t + 2).gpu[0], m.sample_at(t + 85).gpu[0]
    assert start.util >= 95 and later.util >= 95
    assert later.power_w > start.power_w - 1 and later.power_w >= 38
    assert 74 <= later.temp_c <= 84 and later.temp_c > m.sample_at(t - 5).gpu[0].temp_c
    assert later.sm_mhz < 2200 and later.throttle_mask & 0x4  # power capping: clocks sag a little
    assert m.sample_at(t + 200).gpu[0].util < 100  # back to the normal workload afterwards


def test_demo_storage_run_loads_the_disk_and_says_runs_are_compressed():
    m = DemoModel("spark1", T0)
    t = T0 + 4000
    p = validate("storage-fio", {})
    windows = demo_bench.storage_windows(p, t, 4.0)
    assert [w[:2] for w in windows] == [[t + i, t + i + 1] for i in range(4)]  # write file, then each profile
    m.disk_windows += windows
    during, after = m.sample_at(t + 0.5).disk[0], m.sample_at(t + 30).disk[0]
    assert during.write_bps > 4e9 and during.busy_pct == 100  # next to a ~4.6 GB/s sequential-write result
    assert m.sample_at(t + 1.5).disk[0].read_bps > 5e9  # then sequential read
    assert after.write_bps < 1e8
    desc = {s.id: s.description for s in demo_catalog("spark1", m.info)}
    assert desc.pop("llm-inference").endswith(demo_bench.LLM_NOTE)  # compressed less: streams to watch
    assert desc.pop("llm-showcase").endswith(demo_bench.SHOWCASE_NOTE)
    assert desc["tool-eval"].endswith(demo_bench.TE_NOTE)  # trials compressed more: still watchable
    assert all(demo_bench.COMPRESSED_NOTE in d for d in desc.values())


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
    assert len(runs) == len(demo_bench._SEED) and {r.bench_id for r in runs} == set(REGISTRY)
    assert {r.status for r in runs} == {"succeeded", "failed", "cancelled"}
    assert all(r.params_key == params_key(r.bench_id, r.params) for r in runs)  # as the console keys runs
    latest = runs[0]
    assert latest.bench_id == "gpu-matmul" and latest.baseline_run_id is not None
    bf16 = next(x for x in latest.results if x.metric == "bf16_tflops")
    assert (bf16.value, bf16.baseline, bf16.regression) == (81.2, 98.0, True)
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
        "Benchmark regression on spark1: BF16 dense GEMM 81.2 TFLOPS vs baseline 98.0 (−17.1%)"
    ]


def test_demo_empty_bench_flag(tmp_path):
    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True)) as c:
        assert len(c.get("/api/v1/bench/runs").json()) == len(demo_bench._SEED)
    with TestClient(create_app(cfg, tmp_path / "data", demo=True, demo_empty_bench=True)) as c:
        assert c.get("/api/v1/bench/runs").json() == []
        assert len(c.get("/api/v1/bench/catalog").json()) == len(REGISTRY)


def _compact(obj) -> int:
    return len(json.dumps(obj, separators=(",", ":"), allow_nan=False))


def test_demo_llm_streams_are_plausible_and_within_the_agents_limits():
    p = validate("llm-inference", {"concurrency": 32, "sweep": True})
    qwen = demo_bench.LlmDemo(p, "spark3", random.Random(3))
    assert (qwen.sizes, qwen.counts) == ([1, 2, 4, 8, 16, 32], [8, 8, 8, 8, 16, 32])
    levels = [qwen.summary(k) for k in range(6)]
    assert 30 <= levels[0]["decode_tok_s_p50"] <= 60 and 150 <= levels[0]["ttft_p50_ms"] <= 600
    decode = [lv["decode_tok_s_p50"] for lv in levels]
    assert decode == sorted(decode, reverse=True)  # more streams: each one slower, ...
    assert levels[-1]["ttft_p50_ms"] > 3 * levels[0]["ttft_p50_ms"]  # ... a longer wait, more output in all
    assert levels[-1]["out_tok_s"] > 4 * levels[0]["out_tok_s"]
    mid, end = qwen.snapshot(5, qwen.duration(5) / 2), qwen.snapshot(5, qwen.duration(5))
    for snap in (mid, end):
        assert (snap["kind"], snap["level"], snap["level_index"]) == ("llm-streams", 32, 5)
        assert len(snap["streams"]) == 32 and _compact(snap) <= LIVE_MAX_BYTES
    assert "decode" in {s["state"] for s in mid["streams"]} and any(s["think"] for s in mid["streams"])
    assert [s["state"] for s in end["streams"]] == ["done"] * 32 and end["completed_levels"] == levels
    times = [qwen.duration(0) * f for f in (0.1, 0.3, 0.6, 1.0)]  # one stream, request after request
    chars = [qwen.snapshot(0, t)["streams"][0]["chars"] for t in times]
    assert chars == sorted(chars) and chars[-1] > chars[0]
    plain = demo_bench.LlmDemo(p, "spark1", random.Random(3))  # only spark3's Qwen reasons
    assert not any(s["think"] for k in range(6) for s in plain.snapshot(k, plain.duration(k) / 2)["streams"])
    results = qwen.results()
    heads = [r.metric for r in results if r.extras.get("headline")]
    assert heads == ["peak_output_tok_s", "decode_tok_s_c1", "ttft_p50_ms_c32"]
    assert all(r.extras["level"] in qwen.sizes and r.extras["sweep"] for r in results[:-2])
    val = {r.metric: r.value for r in results}
    for lv in levels:  # the sweep table shows exactly the results' numbers, as the payload's does
        n = lv["level"]
        assert (val[f"decode_tok_s_total_c{n}"], val[f"decode_tok_s_c{n}"]) == (
            lv["out_tok_s"],
            lv["decode_tok_s_p50"],
        )
        assert (val[f"ttft_p50_ms_c{n}"], val[f"ttft_p95_ms_c{n}"]) == (lv["ttft_p50_ms"], lv["ttft_p95_ms"])
    assert val["peak_output_tok_s"] == max(lv["out_tok_s"] for lv in levels)
    one = demo_bench.LlmDemo(validate("llm-inference", {}), "spark1", random.Random(3)).results()
    assert [r.metric for r in one] == [
        "decode_tok_s",
        "ttft_p50_ms",
        "prefill_tok_s",
        "ttft_p95_ms",
        "decode_tok_s_total",
        "serving_gpu_mem_gib",
        "mem_used_delta_gib",
    ]
    big = validate("llm-inference", {"concurrency": 32, "requests": 512, "max_tokens": 4096, "sweep": True})
    most = demo_bench.LlmDemo(big, "spark3", random.Random(3))  # the largest run the agent accepts
    assert _compact(most.snapshot(5, most.duration(5) / 3)) <= LIVE_MAX_BYTES
    detail = most.detail(6)
    assert _compact(detail) <= DETAIL_MAX_BYTES and all(t["truncated"] for t in detail["timeline"].values())


def test_runs_are_keyed_on_the_requests_they_send(demo):
    body = {"bench_id": "llm-inference", "nodes": ["spark2"], "params": {"concurrency": 16, "requests": 4}}
    r = demo.post("/api/v1/bench/runs", json={**body, "confirm": True})
    assert r.status_code == 201, r.json()
    run = BenchRun.model_validate(r.json())
    assert run.params["requests"] == 4 and '"requests":16' in run.params_key  # one request per stream
    assert _wait(demo, run.id)["status"] == "succeeded"


def test_demo_llm_sweep_streams_live_and_leaves_detail_and_results(demo):
    body = {"bench_id": "llm-inference", "nodes": ["spark3"], "params": {"concurrency": 4, "sweep": True}}
    r = demo.post("/api/v1/bench/runs", json={**body, "confirm": True})
    assert r.status_code == 201, r.json()
    seen, deadline = [], time.time() + 15
    while time.time() < deadline:
        run = demo.get(f"/api/v1/bench/runs/{r.json()['id']}").json()
        if run["status"] not in ("queued", "running"):
            break
        seen.append(run["node_states"]["spark3"]["live"])
        time.sleep(0.1)
    done = BenchRun.model_validate(run)
    assert done.status == "succeeded" and '"sweep":true' in done.params_key
    assert done.params_key == params_key("llm-inference", done.params)
    assert {x["level"] for x in seen if x} >= {1, 2}  # streams were live while it ran
    st = done.node_states["spark3"]
    assert st.live["level"] == 4 and [s["state"] for s in st.live["streams"]] == ["done"] * 4
    assert [lv["level"] for lv in st.detail["llm"]["levels"]] == [1, 2, 4]
    heads = [x.metric for x in done.results if x.extras.get("headline")]
    assert heads == ["peak_output_tok_s", "decode_tok_s_c1", "ttft_p50_ms_c4"]
    seeded = [x for x in demo.get("/api/v1/bench/runs").json() if x["bench_id"] == "llm-inference"]
    assert seeded and all("sweep" not in x["params_key"] for x in seeded if not x["params"]["sweep"])


@pytest.fixture
def mixed(tmp_path, monkeypatch):
    monkeypatch.setattr(demo_bench, "demo_duration", lambda bench, p: 1.5)
    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True, fleet="mixed")) as c:
        yield c


def _llm_run(c, node: str, sweep: bool) -> BenchRun:
    body = {"bench_id": "llm-inference", "nodes": [node], "params": {"concurrency": 2, "sweep": sweep}}
    r = c.post("/api/v1/bench/runs", json={**body, "confirm": True})
    assert r.status_code == 201, r.json()
    run = BenchRun.model_validate(_wait(c, r.json()["id"]))
    assert run.status == "succeeded", run.error
    return run


@pytest.mark.parametrize("sweep", [False, True])
def test_ws1_llm_results_describe_ws1_and_say_which_figures_are_modelled_on_gb10(mixed, sweep):
    run = _llm_run(mixed, "ws1", sweep)
    res = {x.metric: x for x in run.results}
    growth, serving = res.pop("mem_used_delta_gib"), res.pop("serving_gpu_mem_gib")
    assert growth.label == "System memory growth during run"
    st = run.node_states["ws1"]
    assert st.started_ts and st.finished_ts
    ws1 = FLEETS["mixed"]["ws1"](T0, 1.0)
    span = [st.started_ts + k for k in range(int(st.finished_ts - st.started_ts) + 1)] + [st.finished_ts]
    used = [ws1.sample_at(t).mem.used / 2**30 for t in span]
    assert growth.value == pytest.approx(max(used) - used[0], abs=0.002)
    assert growth.extras["mem_used_before_gib"] == pytest.approx(used[0], abs=0.002)
    assert growth.extras["mem_used_peak_gib"] == pytest.approx(max(used), abs=0.002)
    assert serving.extras["source"] == "pid 41022 and its children"
    workers = [
        p.gpu_mem for p in FLEETS["mixed"]["ws1"](T0, 1.0).sample_at(time.time(), procs=True).procs or []
    ]
    assert serving.value == pytest.approx(sum(m for m in workers if m) / 2**30, rel=0.01)
    assert res and all(x.extras["modelled_on"] == "GB10" and "GB10" not in x.label for x in res.values())
    assert "modelled_on" not in growth.extras and "modelled_on" not in serving.extras
    assert st.metadata["modelled_on"] == run.metadata["nodes"]["ws1"]["modelled_on"] == "GB10"


@pytest.mark.parametrize(
    ("bench", "timed"),
    [("llm-showcase", None), ("tool-eval", {"median_turn_ms", "responsiveness", "deployability"})],
)
def test_ws1_marks_every_speed_figure_of_a_demo_llm_benchmark_as_modelled_on_gb10(mixed, bench, timed):
    r = mixed.post("/api/v1/bench/runs", json={"bench_id": bench, "nodes": ["ws1"], "confirm": True})
    assert r.status_code == 201, r.json()
    run = BenchRun.model_validate(_wait(mixed, r.json()["id"]))
    assert run.status == "succeeded", run.error
    marked = {x.metric for x in run.results if x.extras.get("modelled_on") == "GB10"}
    assert marked == (timed or {x.metric for x in run.results})
    assert not any("GB10" in x.label for x in run.results)
    assert run.node_states["ws1"].metadata["modelled_on"] == "GB10"
    assert run.metadata["nodes"]["ws1"]["modelled_on"] == "GB10"


def test_the_showcase_story_on_ws1_gives_no_sensor_reading_and_spark1_keeps_its_own(mixed):
    body = {"bench_id": "llm-showcase", "params": {"streams": 1, "prompt_type": "text"}, "confirm": True}
    told = {}
    for node in ("ws1", "spark1"):
        r = mixed.post("/api/v1/bench/runs", json={**body, "nodes": [node]})
        assert r.status_code == 201, r.json()
        st = BenchRun.model_validate(_wait(mixed, r.json()["id"])).node_states[node]
        [story] = st.detail["showcase"]["streams"]
        assert story["prompt"].startswith("Write a short story about a DGX Spark")
        told[node] = " ".join([story["text"], *(s["text"] for s in st.live["streams"])])
    assert "The Spark checked its sensors:" in told["ws1"]
    assert "degrees" not in told["ws1"]
    assert "The Spark checked its sensors: 41 degrees," in told["spark1"]


@pytest.mark.parametrize("bench", ["llm-inference", "llm-showcase", "tool-eval"])
def test_ws1_says_its_speeds_are_modelled_from_its_first_state_through_a_cancelled_run(mixed, bench):
    r = mixed.post("/api/v1/bench/runs", json={"bench_id": bench, "nodes": ["ws1"], "confirm": True})
    assert r.status_code == 201, r.json()
    rid, first, deadline = r.json()["id"], None, time.time() + 15
    while first is None and time.time() < deadline:
        first = mixed.get(f"/api/v1/bench/runs/{rid}").json()["node_states"].get("ws1")
        time.sleep(0.02)
    assert first and first["status"] == "running" and first["metadata"]["modelled_on"] == "GB10"
    mixed.post(f"/api/v1/bench/runs/{rid}/cancel")
    run = BenchRun.model_validate(_wait(mixed, rid))
    assert run.status == "cancelled" and run.results == []
    assert run.node_states["ws1"].metadata["modelled_on"] == "GB10"
    assert run.metadata["nodes"]["ws1"]["modelled_on"] == "GB10"


def test_ws1_thermal_soak_is_its_own_telemetry_so_nothing_is_marked_modelled(mixed):
    body = {"bench_id": "thermal-soak", "nodes": ["ws1"], "confirm": True}
    r = mixed.post("/api/v1/bench/runs", json=body)
    assert r.status_code == 201, r.json()
    run = BenchRun.model_validate(_wait(mixed, r.json()["id"]))
    assert run.status == "succeeded" and run.results, run.error
    assert "modelled_on" not in run.model_dump_json()


def test_spark1_llm_results_keep_their_gb10_labels_and_serving_process(mixed):
    run = _llm_run(mixed, "spark1", False)
    res = {x.metric: x for x in run.results}
    assert res["mem_used_delta_gib"].label == "Unified memory growth during run"
    assert res["serving_gpu_mem_gib"].extras["source"] == "pid 4242 and its children"
    assert not any("GB10" in x.label for x in res.values())
    assert "modelled_on" not in run.model_dump_json()


def test_demo_history_holds_a_finished_sweep(demo):
    sweeps = [x for x in demo.get("/api/v1/bench/runs?bench_id=llm-inference").json() if x["params"]["sweep"]]
    assert len(sweeps) == 1 and sweeps[0]["status"] == "succeeded" and sweeps[0]["node_states"] == {}  # list
    run = BenchRun.model_validate(demo.get(f"/api/v1/bench/runs/{sweeps[0]['id']}").json())
    st = run.node_states["spark1"]
    assert (st.status, st.live["kind"], st.live["level"]) == ("succeeded", "llm-streams", 32)
    assert [s["state"] for s in st.live["streams"]] == ["done"] * 32
    levels = st.detail["llm"]["levels"]
    assert [lv["level"] for lv in levels] == st.live["levels"] == [1, 2, 4, 8, 16, 32]
    assert set(st.detail["llm"]["timeline"]) == {"1", "2", "4", "8", "16", "32"}
    assert _compact(st.live) <= LIVE_MAX_BYTES and _compact(st.detail) <= DETAIL_MAX_BYTES
    heads = [x.metric for x in run.results if x.extras.get("headline")]
    assert heads == ["peak_output_tok_s", "decode_tok_s_c1", "ttft_p50_ms_c32"]
    assert {x.node_id for x in run.results} == {"spark1"}
    took = (run.finished_ts or 0) - (run.started_ts or 0)  # as long as its requests took
    assert took == pytest.approx(demo_bench.LLM_START_S + sum(lv["wall_s"] for lv in levels), abs=0.01)


def test_demo_showcase_streams_start_and_end_together_and_keep_every_answer():
    p = validate("llm-showcase", {"streams": 8, "prompt_type": "mixed", "thinking": True})
    show = demo_bench.ShowcaseDemo(p, "spark1", random.Random(3))
    ends = [s.end for s in show.streams]
    assert max(ends) / min(ends) < 1.15 and all(s.tokens == 512 for s in show.streams)  # filled to the length
    mid, end = show.snapshot(show.duration / 2), show.snapshot(show.duration)
    for snap in (mid, end):
        assert (snap["kind"], snap["v"], snap["level"], snap["levels"], snap["level_index"]) == (
            "llm-streams",
            1,
            8,
            [8],
            0,
        )
        assert snap["showcase"] is True and snap["completed_levels"] == [] and snap["requests"] == 8
        assert isinstance(snap["server_tok_s"], float) and len(snap["streams"]) == 8
    labels = [s["label"] for s in mid["streams"]]
    assert labels[0].startswith("Write a JSON inventory") and labels[1].startswith("Write a short story")
    assert all(len(x) <= 60 for x in labels) and len(set(labels)) == 8
    assert {s["state"] for s in mid["streams"]} == {"decode"} and all(s["think"] for s in mid["streams"])
    assert mid["tok_s"] == pytest.approx(sum(s["tok_s"] for s in mid["streams"]), abs=0.1)
    assert all(s["tok_s"] <= s["peak_tok_s"] for s in mid["streams"])
    assert 20 <= mid["tok_s"] <= 400 and mid["server_tok_s"] == pytest.approx(mid["tok_s"], rel=0.1)
    assert [s["state"] for s in end["streams"]] == ["done"] * 8 and end["done"] == 8
    detail = show.detail()
    assert set(detail) == {"streams", "server_tok_s", "fill_to_max", "truncated"}
    assert detail["fill_to_max"] == {"requested": True, "applied": True} and not detail["truncated"]
    for row, live in zip(
        detail["streams"], end["streams"], strict=True
    ):  # the whole text; the live tail ends it
        assert row["state"] == "done" and row["prompt"].endswith(demo_bench.SHOWCASE_FILL)
        assert len(row["text"]) == live["chars"] > 280 and row["text"].endswith(live["text"])
        assert row["think"].endswith(live["think"]) and row["tokens"] == 512
    assert (
        "\n" in detail["streams"][0]["text"] and "\n" not in detail["streams"][1]["text"]
    )  # JSON, then prose
    server = detail["server_tok_s"]
    assert server["samples"] > 10 and server["median"] <= server["max"]
    results = show.results()
    assert [(r.metric, bool(r.extras.get("headline"))) for r in results] == [
        ("output_tok_s", True),
        ("decode_tok_s", True),
        ("ttft_p50_ms", True),
        ("server_tok_s_median", False),
    ]
    val = {r.metric: r.value for r in results}
    assert val["server_tok_s_median"] == server["median"] and 15 <= val["decode_tok_s"] <= 45
    assert results[0].extras["prompt_type"] == "mixed" and results[0].extras["simulated"] is True
    stopped = show.detail(show.duration / 2)  # cancelled half-way
    assert {s["state"] for s in stopped["streams"]} == {"stopped"}
    assert all(0 < s["tokens"] < 512 and s["decode_tok_s"] is None for s in stopped["streams"])
    early = demo_bench.ShowcaseDemo(
        validate("llm-showcase", {"fill_to_max": False}), "spark1", random.Random(3)
    )
    assert early.detail()["fill_to_max"] == {"requested": False, "applied": False}
    assert not any(s.prompt.endswith(demo_bench.SHOWCASE_FILL) for s in early.streams)
    big = validate("llm-showcase", {"streams": 32, "max_tokens": 2048, "thinking": True})
    most = demo_bench.ShowcaseDemo(big, "spark3", random.Random(3))  # the largest run the agent accepts
    assert _compact(most.snapshot(most.duration / 3)) <= LIVE_MAX_BYTES
    assert _compact({"showcase": most.detail()}) <= 900_000 < DETAIL_MAX_BYTES


def test_demo_showcase_runs_live_cancels_with_its_answers_and_history_holds_one(demo):
    body = {"bench_id": "llm-showcase", "nodes": ["spark2"], "params": {"streams": 3}, "confirm": True}
    r = demo.post("/api/v1/bench/runs", json=body)
    assert r.status_code == 201, r.json()
    seen, deadline = [], time.time() + 15
    while time.time() < deadline:
        run = demo.get(f"/api/v1/bench/runs/{r.json()['id']}").json()
        if run["status"] not in ("queued", "running"):
            break
        seen.append(run["node_states"]["spark2"]["live"])
        time.sleep(0.1)
    done = BenchRun.model_validate(run)
    assert done.status == "succeeded" and any(x and x["showcase"] for x in seen)
    st = done.node_states["spark2"]
    assert [s["state"] for s in st.live["streams"]] == ["done"] * 3
    assert [s["state"] for s in st.detail["showcase"]["streams"]] == ["done"] * 3
    assert [x.metric for x in done.results if x.extras.get("headline")] == [
        "output_tok_s",
        "decode_tok_s",
        "ttft_p50_ms",
    ]
    r = demo.post("/api/v1/bench/runs", json=body)
    time.sleep(0.8)
    demo.post(f"/api/v1/bench/runs/{r.json()['id']}/cancel")
    cancelled = BenchRun.model_validate(_wait(demo, r.json()["id"]))
    assert cancelled.status == "cancelled"
    rows = cancelled.node_states["spark2"].detail["showcase"]["streams"]
    assert {s["state"] for s in rows} == {"stopped"} and all(s["text"] for s in rows)
    [seeded] = demo.get("/api/v1/bench/runs?bench_id=llm-showcase").json()[2:]  # newest first
    run = BenchRun.model_validate(demo.get(f"/api/v1/bench/runs/{seeded['id']}").json())
    assert run.status == "succeeded" and run.params["streams"] == 8 and run.params["prompt_type"] == "mixed"
    st = run.node_states["spark1"]
    assert st.live["showcase"] is True and [s["state"] for s in st.live["streams"]] == ["done"] * 8
    assert len(st.detail["showcase"]["streams"]) == 8 and st.detail["showcase"]["server_tok_s"]["samples"]
    assert {x.metric for x in run.results} >= {"output_tok_s", "decode_tok_s", "ttft_p50_ms"}
    took = (run.finished_ts or 0) - (run.started_ts or 0)  # as long as its streams took
    assert took == pytest.approx(demo_bench.LLM_START_S + st.live["t"], abs=0.01)


def _tool_eval(node: str = "spark1", rng: str = "x", **over) -> demo_bench.ToolEvalDemo:
    return demo_bench.ToolEvalDemo(validate("tool-eval", over), node, random.Random(rng))


def test_demo_tool_eval_single_trial_is_unchanged():
    te = _tool_eval(rng="xspark1standard", suite="standard")
    results = {r.metric: r for r in te.bench_results()}
    st = te.node_state("r", "spark1", T0, T0 + 1)
    final = st.detail["tool_eval"]
    # the values the demo gave for this rng state before trials existed
    assert (final["final_score"], final["total_points"], final["fingerprint"]) == (92, 127, "12add3861cfd")
    missed = {t["id"]: t["points"] for t in st.live["board"] if t["points"] != 2}
    assert missed == {"TC-32": 0, "TC-34": 1, "TC-54": 1, "TC-57": 1, "TC-58": 0, "TC-60": 0, "TC-65": 0}
    assert (results["median_turn_ms"].value, results["deployability"].value) == (2520.9, 81.0)
    assert (final["trials"], final["seed"], final["trial_stats"]) == (1, None, None)
    assert final["envelope"]["metadata"]["trials"] == 1 and "trial_statistics" not in final["envelope"]
    live = st.live
    assert (live["trial"], live["trials"], live["seed"]) == (1, 1, None)
    assert [x["trial"] for x in live["trial_scores"]] == [1] and live["trial_scores"][0]["score"] == 92
    assert all(t["history"] == [t["points"]] for t in live["board"])
    assert st.detail["te:TC-32"]["history"] == [0] and all(x["trial"] == 1 for x in live["recent"])
    assert {"score_stddev", "pass_at_k", "pass_hat_k"}.isdisjoint(results)
    assert results["score"].extras["whole"] is True and results["score"].extras["total_points"] == 127
    assert all((r.extras["trials"], r.extras["seed"]) == (1, None) for r in results.values())
    assert not any(line.startswith("Trial") for line in st.log_tail)
    assert st.log_tail[-1].startswith("Score 92 (")
    assert [x[0] for x in demo_bench.phases("tool-eval", te.p, None)][2] == "Scenario 1 of 69 · TC-01 " + (
        te.scenarios[0].title
    )


def test_demo_tool_eval_trials_aggregate_as_upstream_does():
    from tool_eval_bench.cli.run_io import aggregate_trials
    from tool_eval_bench.domain.scenarios import rating_for_score
    from tool_eval_bench.runner.orchestrator import score_results

    te = _tool_eval(rng="t", suite="standard", trials=4)
    results = {r.metric: r for r in te.bench_results()}
    st = te.node_state("r", "spark1", T0, T0 + 1)
    final, live, stats = st.detail["tool_eval"], st.live, st.detail["tool_eval"]["trial_stats"]
    # every trial played: the board and records show the last, with each scenario's points in every trial
    assert (live["trial"], live["trials"], live["done"], live["seed"]) == (4, 4, 69, None)
    assert [x["trial"] for x in live["trial_scores"]] == [1, 2, 3, 4]
    assert all(len(t["history"]) == 4 and t["history"][-1] == t["points"] for t in live["board"])
    records = {k[3:]: v for k, v in st.detail.items() if k.startswith("te:")}
    assert len(records) == 69 and all(r["history"] == records[r["id"]]["history"] for r in live["board"])
    # upstream's own statistics over the trials, scored as its CLI scores each one
    summaries = [score_results(r, te.scenarios, alpha=0.7) for r in te.by_trial]
    agg = aggregate_trials(summaries)
    assert stats["scores"] == [s.final_score for s in summaries] == [x["score"] for x in live["trial_scores"]]
    assert (stats["mean"], stats["stddev"], stats["median"]) == (
        agg["final_score_mean"],
        agg["final_score_stddev"],
        agg["final_score_median"],
    )
    assert stats["ci95"] == list(agg["final_score_ci95"]) and stats["min"] == min(stats["scores"])
    assert (stats["pass_at_k"], stats["pass_hat_k"], stats["reliability_gap"]) == (
        agg["pass_at_k"],
        agg["pass_hat_k"],
        agg["reliability_gap"],
    )
    assert stats["per_scenario"] == agg["per_scenario"] and stats["per_category"] == agg["per_category"]
    assert stats["rating"] == rating_for_score(round(stats["mean"]))
    assert {k: v["points"] for k, v in agg["per_scenario"].items()} == {
        k: r["history"] for k, r in records.items()
    }
    flaky = [k for k, v in agg["per_scenario"].items() if v["pass_at_k"] and not v["pass_hat_k"]]
    assert stats["flaky"] == flaky and 1 <= len(flaky) <= 8  # most scenarios give the same verdict each trial
    assert stats["never"] == [k for k, v in agg["per_scenario"].items() if not v["pass_at_k"]]
    assert (stats["graded"], stats["completion_rate"]) == (4 * 69, 100.0)
    env = final["envelope"]
    assert env["trial_statistics"]["final_score_mean"] == stats["mean"] and env["metadata"]["trials"] == 4
    assert final["final_score"] == stats["scores"][-1] and (final["trials"], final["seed"]) == (4, None)
    # the results: the mean and its spread, Pass@k and Pass^k
    score = results["score"]
    assert score.value == stats["mean"] and "whole" not in score.extras and "total_points" not in score.extras
    assert (score.extras["stddev"], score.extras["ci95_low"], score.extras["ci95_high"]) == (
        stats["stddev"],
        *stats["ci95"],
    )
    assert (score.extras["graded"], score.extras["rating"]) == (4 * 69, stats["rating"])
    assert (results["pass_at_k"].label, results["pass_hat_k"].label) == ("Pass@4", "Pass^4")
    assert (results["score_stddev"].unit, results["score_stddev"].better) == ("pts", "lower")
    heads = [m for m, r in results.items() if r.extras.get("headline")]
    assert heads == ["score", "score_stddev", "pass_at_k", "pass_hat_k", "completion_rate", "median_turn_ms"]
    turn = [s.to_dict()["median_turn_ms"] for s in summaries]
    assert results["median_turn_ms"].value == round(sum(turn) / 4, 1)
    cat = results["cat_a"]
    assert cat.value == agg["per_category"]["A"]["mean_percent"] and "whole" not in cat.extras
    assert all((r.extras["trials"], r.extras["seed"]) == (4, None) for r in results.values())
    assert [x for x in st.log_tail if x.startswith("Trial ")] == [
        f"Trial {t + 1} of 4: score {s} ({r})"
        for t, (s, r) in enumerate(zip(stats["scores"], stats["ratings"], strict=True))
    ]
    assert st.log_tail[-1].startswith(f"Mean score {stats['mean']} ± {stats['stddev']} over 4 trials")
    # the same rng state gives the same run; a seed fixes how the later trials vary, and is reported
    assert _tool_eval(rng="t", suite="standard", trials=4).by_trial == te.by_trial
    a, b = (_tool_eval(rng=x, suite="core", trials=3, seed="42") for x in ("a", "b"))
    assert a.by_trial[0] != b.by_trial[0] and a.seed == 42
    seeded = {r.metric: r for r in a.bench_results()}
    assert seeded["score"].extras["seed"] == 42
    assert a.summary()["envelope"]["config"]["seed"] == 42


def test_demo_tool_eval_trials_replay_the_board():
    te = _tool_eval(node="spark3", rng="r", suite="core", trials=3)
    labels = [x[0] for x in demo_bench.phases("tool-eval", te.p, None)]
    assert (
        len(labels) == 2 + 3 * 15
        and labels[2 + 15] == f"Trial 2 of 3 · Scenario 1 of 15 · TC-01 {te.scenarios[0].title}"
    )
    st = NodeBenchState(run_id="r", bench_id="tool-eval", node_id="spark3", status="running")
    te.show(st, 0, 15, None)
    te.show(st, 1, 2, T0)  # trial 2: two scenarios done, the third running
    live = st.live
    assert (live["trial"], live["done"], [x["trial"] for x in live["trial_scores"]]) == (2, 2, [1])
    assert [t["status"] for t in live["board"][:4]] == [te.status(0), te.status(1), "running", "pending"]
    assert [len(t["history"]) for t in live["board"][:4]] == [2, 2, 1, 1]
    assert [len(st.detail[f"te:{s.id}"]["history"]) for s in te.scenarios[:4]] == [2, 2, 1, 1]
    assert [x["trial"] for x in live["recent"]] == [2, 2, 1, 1, 1]
    assert [x["id"] for x in live["recent"]] == ["TC-02", "TC-01", "TC-15", "TC-14", "TC-13"]
    assert st.log_tail == [
        f"Trial 1 of 3: score {live['trial_scores'][0]['score']} ({live['trial_scores'][0]['rating']})"
    ]
    # a K-trial run takes √K times one trial in the demo, not K times
    one, four = (
        demo_duration("tool-eval", validate("tool-eval", {"suite": "all", "trials": k})) for k in (1, 4)
    )
    assert four == pytest.approx(2 * one)


def test_demo_tool_eval_trials_run_live_and_history_holds_one(demo):
    body = {
        "bench_id": "tool-eval",
        "nodes": ["spark2"],
        "params": {"suite": "core", "trials": 2, "seed": "7"},
    }
    r = demo.post("/api/v1/bench/runs", json={**body, "confirm": True})
    assert r.status_code == 201, r.json()
    run = BenchRun.model_validate(_wait(demo, r.json()["id"]))
    assert run.status == "succeeded", run.error
    st = run.node_states["spark2"]
    stats = st.detail["tool_eval"]["trial_stats"]
    assert (st.live["trial"], st.live["trials"], st.live["seed"], len(stats["scores"])) == (2, 2, 7, 2)
    score = next(x for x in run.results if x.metric == "score")
    assert score.value == stats["mean"] and score.extras["seed"] == 7  # make_results replays the live run
    listed = demo.get("/api/v1/bench/runs?bench_id=tool-eval").json()
    seeded = [x for x in listed if x["params"]["trials"] > 1 and x["id"] != run.id]
    assert [(x["params"]["suite"], x["params"]["trials"], x["params"]["seed"]) for x in seeded] == [
        ("all", 4, "42")
    ]
    assert [(x["params"]["suite"], x["params"]["trials"], x["params"]["seed"]) for x in seeded] == [
        ("all", 4, "42")
    ]
    run = BenchRun.model_validate(demo.get(f"/api/v1/bench/runs/{seeded[0]['id']}").json())
    st = run.node_states["spark1"]
    assert (st.live["trial"], st.live["done"], len(st.live["trial_scores"])) == (4, 97, 4)
    assert all(len(t["history"]) == 4 for t in st.live["board"])
    assert _compact(st.live) <= LIVE_MAX_BYTES and _compact(st.detail) <= DETAIL_MAX_BYTES
    assert next(x for x in run.results if x.metric == "pass_at_k").label == "Pass@4"
