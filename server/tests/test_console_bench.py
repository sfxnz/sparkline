"""Benchmark orchestration units: params validation, regression math, params_key gating, CSV, rails, ids,
telemetry bounding, store."""

from __future__ import annotations

import csv
import io
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sparkline.agent.bench.specs import REGISTRY as AGENT_REGISTRY
from sparkline.common.schema import (
    BenchParam,
    BenchResult,
    BenchRun,
    BenchSpec,
    ConsoleSettings,
    NodeBenchState,
    NodeInfo,
    Sample,
)
from sparkline.console import bench as bench_mod
from sparkline.console.app import create_app
from sparkline.console.bench import (
    BenchManager,
    _Active,
    apply_baseline,
    canonical,
    merge_description,
    new_run_id,
    rail_ip,
    regression_title,
    runs_csv,
    threshold_text,
    validate_params,
)
from sparkline.console.bench_store import BenchStore
from sparkline.console.cluster import Cluster
from sparkline.console.config import ConsoleConfig
from sparkline.console.hub import Hub
from sparkline.console.nodes import NodeSource
from sparkline.console.store import Store

FIX = Path(__file__).parent / "fixtures" / "console"
INFO = NodeInfo.model_validate_json((FIX / "node_info.json").read_text())

SPEC = BenchSpec(
    id="gpu-matmul",
    name="GPU matmul",
    category="compute",
    description="",
    est_duration_s=90,
    impact={"thermal": "high", "power": "high", "disruptive": True, "note": ""},
    params=[
        BenchParam(name="size", label="Size", type="enum", default="8192", choices=["4096", "8192"]),
        BenchParam(name="iterations", label="Iterations", type="int", default=50, min=10, max=500),
        BenchParam(name="scale", label="Scale", type="float", default=1.0, min=0.5, max=2),
        BenchParam(
            name="dtypes", label="Precisions", type="multi", default=["bf16"], choices=["bf16", "fp8"]
        ),
        BenchParam(name="warm", label="Warm up", type="bool", default=True),
        BenchParam(name="model", label="Model", type="string", default="m"),
    ],
)


def test_validate_params_fills_defaults_and_rejects_bad_input():
    full = validate_params(SPEC, {})
    assert full == {
        "size": "8192",
        "iterations": 50,
        "scale": 1.0,
        "dtypes": ["bf16"],
        "warm": True,
        "model": "m",
    }
    # canonical: explicit defaults and {} give the same key; multi is ordered by the spec's choices
    assert canonical(validate_params(SPEC, {"iterations": 50})) == canonical(full)
    assert validate_params(SPEC, {"dtypes": ["fp8", "bf16", "fp8"]})["dtypes"] == ["bf16", "fp8"]
    assert validate_params(SPEC, {"iterations": 60.0})["iterations"] == 60
    for bad, msg in [
        ({"nope": 1}, "Unknown parameter"),
        ({"size": "1"}, "must be one of"),
        ({"iterations": 5}, "at least 10"),
        ({"iterations": 501}, "at most 500"),
        ({"iterations": True}, "whole number"),
        ({"iterations": "50"}, "whole number"),
        ({"scale": "x"}, "must be a number"),
        ({"dtypes": []}, "non-empty selection"),
        ({"dtypes": ["fp4"]}, "non-empty selection"),
        ({"warm": 1}, "true or false"),
        ({"model": "x" * 501}, "at most 500"),
    ]:
        with pytest.raises(ValueError, match=msg):
            validate_params(SPEC, bad)


def _res(metric: str, value: float, better: str = "higher", node: str = "spark1") -> BenchResult:
    return BenchResult(
        metric=metric, label=metric.upper(), value=value, unit="u", better=better, node_id=node
    )


def test_regression_math_both_directions():
    base = [
        _res("tflops", 100.0),
        _res("lat", 10.0, "lower"),
        _res("bw", 50.0),
        _res("tflops", 90.0, node="n2"),
    ]
    cur = [
        _res("tflops", 94.0),  # 6 % lower, higher is better -> regression
        _res("lat", 10.6, "lower"),  # 6 % higher, lower is better -> regression
        _res("bw", 48.0),  # 4 % lower: within 5 %
        _res("tflops", 80.0, node="n3"),  # no baseline for n3
    ]
    regs = apply_baseline(cur, base, 5.0)
    assert [(r.metric, round(c, 1)) for r, c in regs] == [("tflops", -6.0), ("lat", 6.0)]
    assert [r.baseline for r in cur] == [100.0, 10.0, 50.0, None]
    assert [r.regression for r in cur] == [True, True, False, False]
    # improvements are never regressions
    better = [_res("tflops", 130.0), _res("lat", 5.0, "lower")]
    assert apply_baseline(better, base, 5.0) == [] and not any(r.regression for r in better)


def test_percentage_results_compare_in_points():
    def pct_res(metric: str, v: float) -> BenchResult:
        return BenchResult(metric=metric, label=metric, value=v, unit="%", better="lower", node_id="n1")

    cur = [pct_res("throttled_pct", 100.0), pct_res("cv", 0.9), pct_res("loss", 0.4), pct_res("t2", 1.0)]
    base = [pct_res("throttled_pct", 0.0), pct_res("cv", 0.8), pct_res("loss", -0.5), pct_res("t2", 0.5)]
    regs = apply_baseline(cur, base, 5.0)
    assert [(r.metric, c) for r, c in regs] == [("throttled_pct", 100.0)]  # a 0 % baseline still compares
    assert [r.regression for r in cur] == [True, False, False, False]  # +0.1/+0.9/+0.5 points: noise
    assert regression_title("n1", cur[0], 100.0) == (
        "Benchmark regression on n1: throttled_pct 100% vs baseline 0.00% (+100.0 points)"
    )
    assert threshold_text(cur[0], 5.0) == "5 percentage points"
    assert threshold_text(_res("x", 1.0), 5.0) == "5%"


def test_storage_method_is_part_of_the_baseline_key():
    fio = _res("rand_read_iops", 760_000.0)
    fio.extras = {"method": "fio"}
    builtin = _res("rand_read_iops", 16_000.0)
    builtin.extras = {"method": "builtin"}
    assert apply_baseline([builtin], [fio], 5.0) == [] and builtin.baseline is None
    again = _res("rand_read_iops", 15_000.0)
    again.extras = {"method": "builtin"}
    assert [r.metric for r, _ in apply_baseline([again], [builtin], 5.0)] == ["rand_read_iops"]


def test_merged_description_names_the_nodes_a_note_applies_to():
    base = AGENT_REGISTRY["storage-fio"].description
    note = "fio is not installed, so the built-in O_DIRECT runner is used."
    got = merge_description(
        "storage-fio", {"spark1": f"{base} {note}", "spark2": f"{base} {note}", "spark3": base}
    )
    assert got == f"{base} spark1, spark2: {note}" and "this node" not in got
    assert merge_description("storage-fio", {"spark1": "Older agent text"}) is None
    assert merge_description("nope", {"spark1": base}) is None


def test_unsupported_results_are_never_compared():
    fp4 = _res("fp4_tflops", 0.0)
    fp4.extras = {"unsupported": True, "reason": "no FP4 on this PyTorch"}
    assert apply_baseline([fp4], [_res("fp4_tflops", 400.0)], 5.0) == []
    assert fp4.baseline is None and not fp4.regression
    real = _res("fp4_tflops", 380.0)
    assert apply_baseline([real], [fp4], 5.0) == [] and real.baseline is None


def test_regression_title_matches_event_style():
    r = BenchResult(metric="bf16_tflops", label="BF16", value=81.2, unit="TFLOPS", baseline=95.0)
    change = (81.2 - 95.0) / 95.0 * 100
    assert regression_title("spark1", r, change) == (
        "Benchmark regression on spark1: BF16 81.2 TFLOPS vs baseline 95.0 (−14.5%)"
    )


def test_run_ids_are_short_and_sortable():
    ids = [new_run_id(1_791_280_000.0 + i) for i in range(0, 5000, 250)]
    assert ids == sorted(ids) and all(len(i) == 12 and i.isalnum() and i.islower() for i in ids)
    assert len({new_run_id(1_791_280_000.0 + i / 1000) for i in range(200)}) == 200  # distinct ms


def test_rail_ip_by_label_and_position():
    assert rail_ip(INFO, "A") == "10.100.8.1" and rail_ip(INFO, "B") == "10.100.9.1"
    unlabelled = INFO.model_copy(deep=True)
    for n in unlabelled.net:
        n.label = n.name
    assert rail_ip(unlabelled, "B") == "10.100.9.1"
    no_rails = INFO.model_copy(deep=True)
    for n in no_rails.net:
        if n.role == "interconnect":
            n.ipv4 = []
    assert rail_ip(no_rails, "A") is None and rail_ip(None, "A") is None


def test_csv_export_one_row_per_result():
    run = BenchRun(
        id="abc",
        bench_id="gpu-matmul",
        params={},
        nodes=["spark1", "spark2"],
        status="succeeded",
        created_ts=1_791_280_000.0,
        started_ts=1_791_280_001.0,
        finished_ts=1_791_280_091.0,
        results=[_res("tflops", 94.0), _res("tflops", 95.5, node="spark2")],
        metadata={"nodes": {"spark1": {"driver": "580.173.02", "cuda": "13.0", "suite_git": "abc1234"}}},
    )
    run.results[0].baseline, run.results[0].regression = 100.0, True
    rows = list(csv.reader(io.StringIO(runs_csv([run]))))
    assert rows[0] == [
        "run_id",
        "bench_id",
        "node_id",
        "metric",
        "label",
        "value",
        "unit",
        "better",
        "baseline",
        "regression",
        "started",
        "finished",
        "driver",
        "cuda",
        "suite_git",
    ]
    assert rows[1] == [
        "abc",
        "gpu-matmul",
        "spark1",
        "tflops",
        "TFLOPS",
        "94.0",
        "u",
        "higher",
        "100.0",
        "true",
        "2026-10-06T09:46:41+00:00",
        "2026-10-06T09:48:11+00:00",
        "580.173.02",
        "13.0",
        "abc1234",
    ]
    assert rows[2][2] == "spark2" and rows[2][8:10] == ["", "false"] and rows[2][12:] == ["", "", ""]


class _NullBackend:
    def bind(self, on_state):
        pass


def _manager(tmp_path, sources=()):
    store = Store(tmp_path / "c.sqlite")
    cluster = Cluster(store, Hub(), ConsoleSettings(regression_pct=5.0))
    for s in sources:
        cluster.add_source(s)
    return BenchManager(cluster, BenchStore(store.db), _NullBackend()), cluster


def _run(rid: str, key: str, value: float, status: str = "succeeded") -> BenchRun:
    return BenchRun(
        id=rid,
        bench_id="gpu-matmul",
        params=json.loads(key),
        nodes=["spark1"],
        status=status,
        created_ts=time.time(),
        params_key=key,
        results=[_res("tflops", value)],
    )


def test_params_key_gates_baseline_comparison(tmp_path):
    mgr, _ = _manager(tmp_path)
    k50, k60 = canonical({"iterations": 50}), canonical({"iterations": 60})
    mgr.store.save(_run("base", k50, 100.0))
    mgr.store.set_baseline("gpu-matmul", k50, "base")
    assert mgr.store.get("base").baseline_for is True
    other = _run("other", k60, 50.0)  # different params: never compared
    assert mgr._compare_baseline(other) == [] and other.baseline_run_id is None
    assert other.results[0].baseline is None and not other.results[0].regression
    same = _run("same", k50, 80.0)
    regs = mgr._compare_baseline(same)
    assert same.baseline_run_id == "base" and len(regs) == 1 and same.results[0].regression
    assert same.metadata["regression_pct"] == 5.0  # the threshold the flags were set with


def test_store_lists_filters_and_deletes(tmp_path):
    mgr, _ = _manager(tmp_path)
    st = mgr.store
    a, b = _run("a", "{}", 1.0), _run("b", "{}", 2.0, status="failed")
    b.nodes = ["spark1", "spark2"]
    b.created_ts = a.created_ts + 1
    st.save(a)
    st.save(b)
    assert [r.id for r in st.list()] == ["b", "a"]  # newest first
    assert [r.id for r in st.list(node="spark2")] == ["b"]
    assert [r.id for r in st.list(status="succeeded")] == ["a"]
    assert [r.id for r in st.list(bench_id="other")] == []
    st.set_baseline("gpu-matmul", "{}", "a")
    st.delete("a")
    assert st.get("a") is None and st.baseline_id("gpu-matmul", "{}") is None


class _Src(NodeSource):
    async def session(self) -> None:  # pragma: no cover - never run
        raise NotImplementedError


def test_telemetry_overlay_is_recorded_and_bounded(tmp_path, monkeypatch):
    sample = Sample.model_validate_json((FIX / "sample.json").read_text())
    src = _Src("spark1", "http://127.0.0.1:1", listener=None)  # type: ignore[arg-type]
    mgr, _ = _manager(tmp_path, [src])
    monkeypatch.setattr(bench_mod, "TELEMETRY_MAX", 100)
    act = _Active(run=_run("r", "{}", 1.0, status="running"), name="GPU matmul")
    t0 = time.time() - 1000
    for i in range(1000):
        gpu = sample.gpu[0].model_copy(update={"util": float(i % 100), "throttle_mask": 4 if i == 501 else 0})
        src.ring.append(sample.model_copy(update={"ts": t0 + i, "gpu": [gpu]}))
        mgr._record_telemetry(act, t0 + i)
        mgr._record_telemetry(act, t0 + i)  # same sample twice: recorded once
    series = act.run.series
    n = len(series["telemetry.spark1.ts"])
    assert 50 <= n <= 100
    keys = {f"telemetry.spark1.{k}" for k in ("ts", "util", "temp_c", "power_w", "sm_mhz", "throttle_mask")}
    assert set(series) == keys and all(len(series[k]) == n for k in keys)
    ts = series["telemetry.spark1.ts"]
    assert ts == sorted(ts) and ts[0] == round(t0, 3)
    assert any(m == 4 for m in series["telemetry.spark1.throttle_mask"])  # bitmask survives downsampling


def test_telemetry_overlay_keeps_every_sample_when_ticks_drift(tmp_path):
    """Real soak 0muykplobp9x: the 1 s tick plus the 5 s agent polls drifted against the agent's 1 Hz samples,
    so some ticks found two new samples and only the newest was kept: 2 s holes in every telemetry chart."""
    sample = Sample.model_validate_json((FIX / "sample.json").read_text())
    src = _Src("spark1", "http://127.0.0.1:1", listener=None)  # type: ignore[arg-type]
    mgr, _ = _manager(tmp_path, [src])
    act = _Active(run=_run("r", "{}", 1.0, status="running"), name="Thermal soak")
    t0 = time.time() - 100
    for i in range(5):  # history from before the run is not part of it
        src.ring.append(sample.model_copy(update={"ts": t0 - 5 + i}))
    mgr._record_telemetry(act, t0 - 0.5)
    tick = t0 - 0.5
    for i in range(60):
        src.ring.append(sample.model_copy(update={"ts": t0 + i}))
        if i % 5 != 4:  # every fifth sample, the tick runs late and finds two new samples
            tick = t0 + i + 0.5
            mgr._record_telemetry(act, tick)
    mgr._record_telemetry(act, t0 + 60)
    ts = act.run.series["telemetry.spark1.ts"]
    assert ts == [round(t0 - 1, 3)] + [round(t0 + i, 3) for i in range(60)]
    assert len(act.run.series["telemetry.spark1.util"]) == len(ts)


def test_bench_api_requires_auth_and_same_origin(tmp_path):
    cfg = ConsoleConfig(token="tok", agent_token="a", web_dist=tmp_path / "nodist")
    auth = {"Authorization": "Bearer tok"}
    with TestClient(create_app(cfg, tmp_path / "data")) as c:
        for method, path in [
            ("GET", "/api/v1/bench/catalog"),
            ("GET", "/api/v1/bench/runs"),
            ("POST", "/api/v1/bench/runs"),
            ("GET", "/api/v1/bench/runs/abc"),
            ("POST", "/api/v1/bench/runs/abc/cancel"),
            ("DELETE", "/api/v1/bench/runs/abc"),
            ("GET", "/api/v1/bench/runs/abc/export"),
            ("PUT", "/api/v1/bench/baselines/gpu-matmul"),
            ("GET", "/api/v1/bench/compare?ids=abc"),
        ]:
            assert c.request(method, path).status_code == 401, path
        body = {"bench_id": "gpu-matmul", "nodes": ["n1"], "confirm": True}
        r = c.post("/api/v1/bench/runs", json=body, headers={**auth, "Origin": "http://evil.example"})
        assert r.status_code == 403
        assert c.get("/api/v1/bench/catalog", headers=auth).json() == []  # no nodes configured
        assert c.get("/api/v1/bench/runs/abc", headers=auth).status_code == 404
        assert c.get("/api/v1/bench/runs/ABC%2F..", headers=auth).status_code in (404, 422)


def test_unsuccessful_runs_discard_partial_results_but_keep_series(tmp_path):
    mgr, _ = _manager(tmp_path)
    for status in ("cancelled", "failed"):
        run = _run(f"r{status}", canonical({}), 0.0, status="running")
        run.results = []
        run.node_states = {
            "spark1": NodeBenchState(
                run_id=run.id,
                bench_id="gpu-matmul",
                node_id="spark1",
                status=status,
                results=[_res("seq_write_mbps", 5000.0)],
                series={"t": [0.0, 1.0]},
            )
        }
        act = bench_mod._Active(run=run, name="x")
        mgr.active[run.id] = act
        mgr._finalize(act)
        saved = mgr.store.get(run.id)
        assert saved.status == status and saved.results == [] and saved.series["spark1.t"] == [0.0, 1.0]


def test_smoke_results_never_compare_with_measurements():
    smoke = _res("bf16_tflops", 0.005)
    smoke.extras = {"smoke": True}
    assert apply_baseline([smoke], [_res("bf16_tflops", 95.0)], 5.0) == [] and smoke.baseline is None
    real = _res("bf16_tflops", 95.0)
    assert apply_baseline([real], [smoke], 5.0) == [] and real.baseline is None
