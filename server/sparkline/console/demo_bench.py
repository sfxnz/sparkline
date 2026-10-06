"""--demo benchmarks: a simulated runner behind the BenchBackend interface, plus seeded history.

The catalog, parameter validation, duration estimates and availability notes come from the agent's own
registry (sparkline.agent.bench), so the demo offers exactly what a real node offers; results use the agent's
metric names and units. Runs are time-compressed (the agent's estimate / 10; the thermal soak takes 60-90 s)
and report plausible GB10 numbers with small run-to-run noise. While a run is going, the node's demo
telemetry carries the load (DemoModel.bench_windows), so the telemetry overlay is alive. fio is "not
installed" on the demo nodes (built-in runner, noted), and spark3 has no ConnectX-7 peer, so 2-node
benchmarks are unavailable there.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import statistics
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from ..agent.bench import probes
from ..agent.bench.specs import REGISTRY as AGENT_REGISTRY
from ..agent.bench.specs import nccl_sizes, validation_message
from ..common.schema import (
    BenchResult,
    BenchRun,
    BenchSpec,
    BenchStartRequest,
    Event,
    NodeBenchState,
    NodeInfo,
    Problem,
)
from ..common.throttle import LIMITING_MASK, POWER_CAP_BIT
from .bench import (
    CLUSTER_RESULTS,
    BenchError,
    StateCallback,
    apply_baseline,
    canonical,
    new_run_id,
    rail_ip,
    regression_title,
    threshold_text,
)
from .bench_store import BenchStore
from .demo import DemoModel

log = logging.getLogger("sparkline.console.demo_bench")
SUITE_GIT = "demo"  # the real agent reports the suite's git hash
IMAGE = "nvcr.io/nvidia/pytorch:26.07-py3"
GPU_LOAD = {
    "gpu-matmul": 1.0,
    "mem-bandwidth": 0.75,
    "nccl-allreduce": 0.55,
    "llm-inference": 0.9,
    "thermal-soak": 1.0,
}
TICK_S = 0.5
FINISHED_KEEP = 20
SOAK_KEYS = ("gpu0.sm_mhz", "gpu0.temp_c", "gpu0.power_w", "gpu0.throttle_mask", "gpu0.util")
STORAGE_LABEL = {
    "seq_write": "Sequential write 1 MiB",
    "seq_read": "Sequential read 1 MiB",
    "rand_read": "Random read 4 KiB",
    "rand_write": "Random write 4 KiB",
}
SERVED_MODEL = {
    "spark1": "DeepSeek-V4.1-Flash-EXL3",
    "spark2": "DeepSeek-V4.1-Flash-EXL3",
    "spark3": "Qwen3-32B",
}


def _env(node: str, info: NodeInfo | None) -> probes.Env:
    env = probes.Env()
    if rail_ip(info, "A") is None:
        env.rdma = Problem(
            message=f"{node} has no ConnectX-7 peer",
            cause="Its ConnectX-7 ports have no cable or address, so it cannot reach another Spark",
            fix="Run this benchmark on spark1 + spark2, or cable this node's ConnectX-7 port to a peer",
        )
    return env


def demo_catalog(node: str, info: NodeInfo | None) -> list[BenchSpec]:
    env = _env(node, info)
    out = []
    for b in AGENT_REGISTRY.values():
        problem, note = probes.availability(b.id, env)
        out.append(b.spec({node: problem}, note))
    return out


def validate(bench_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """The agent's own validation (pydantic model per benchmark). Raises BenchError(400) like its 422."""
    b = AGENT_REGISTRY.get(bench_id)
    if b is None:
        raise BenchError(
            400, Problem(message=f"Unknown benchmark {bench_id!r}", cause="Not in the registry", fix="")
        )
    try:
        return b.validate(params).model_dump()
    except ValidationError as e:
        raise BenchError(
            400,
            Problem(
                message=f"Invalid parameters for {b.name}",
                cause=validation_message(e),
                fix="Correct the parameters",
            ),
        ) from None


def real_duration(bench: str, p: dict[str, Any]) -> float:
    b = AGENT_REGISTRY[bench]
    return b.estimate(b.validate(p))


def demo_duration(bench: str, p: dict[str, Any]) -> float:
    if bench == "thermal-soak":
        return max(30.0, min(90.0, 60 + (p["minutes"] - 10) * 1.5))
    return max(4.0, real_duration(bench, p) / 10)


# ---------------------------------------------------------------------------------------------------------
# Phases and results (metric names and units as the real agent reports them)
# ---------------------------------------------------------------------------------------------------------


def _bytes(n: float) -> str:
    for unit, k in (("GiB", 1 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)):
        if n >= k:
            return f"{n / k:g} {unit}"
    return f"{n:g} B"


def phases(bench: str, p: dict[str, Any], peer_ip: str | None) -> list[tuple[str, float]]:
    """[(label, weight)] in order."""
    if bench == "gpu-matmul":
        steps = [(f"{d.upper()} {s}³", int(s) / 8192) for d in p["dtypes"] for s in p["sizes"]]
        return [("Starting container", 1.0), *steps]
    if bench == "mem-bandwidth":
        out = [("Starting container", 1.0)]
        if p["side"] in ("both", "gpu"):
            out.append(("GPU copy and triad", 1.0))
        if p["side"] in ("both", "cpu"):
            out += [(f"CPU, {x}", 1.0) for x in ("all cores", "performance cores", "efficiency cores")]
        return out
    if bench == "cpu-throughput":
        return [
            ("Single core (Cortex-X925)", 1),
            ("Single core (Cortex-A725)", 1),
            ("All performance cores (10x Cortex-X925)", 1),
            ("All efficiency cores (10x Cortex-A725)", 1),
            ("All cores (20)", 1),
        ]
    if bench == "nccl-allreduce":
        sizes = nccl_sizes(p["max_size_mib"])[::3]
        return [
            ("Starting container", 2.0),
            (f"Rendezvous at {peer_ip}:29620", 0.5),
            *[(f"all_reduce {_bytes(s)}", 6 / len(sizes)) for s in sizes],
        ]
    if bench == "rdma-bw-lat":
        out = [(f"Connecting to {peer_ip}", 0.3)]
        if "bw" in p["tests"]:
            out.append((f"ib_write_bw · {_bytes(int(p['msg_size']))}", 1.0))
        if "lat" in p["tests"]:
            out.append(("ib_write_lat", 0.6))
        return out
    if bench == "storage-fio":
        return [(f"Writing {p['size_mib']} MiB test file", 1.0)] + [
            (STORAGE_LABEL[x], 1.0) for x in p["profiles"] if x != "seq_write"
        ]
    if bench == "llm-inference":
        n = p["requests"]
        return [("Checking endpoint", 0.3)] + [(f"Request {i + 1} of {n}", 1.0) for i in range(n)]
    return [("Starting container", 0.4), ("Sustained load", 18.0)]  # thermal-soak


def _r(metric: str, label: str, value: float, unit: str, better: str = "higher", **extras) -> BenchResult:
    return BenchResult(
        metric=metric, label=label, value=round(value, 3), unit=unit, better=better, extras=extras
    )


def make_results(
    bench: str, p: dict[str, Any], node: str, rng: random.Random, role: str, info: NodeInfo | None = None
) -> tuple[list[BenchResult], dict[str, list[float]]]:
    """Plausible GB10 results for one node. role: single | client | server | rank0 | rank1; the rdma server
    and NCCL rank 1 report none (the client / rank 0 measure). The thermal soak's come from soak_results."""
    if role in ("server", "rank1"):
        return [], {}

    def n(sd: float = 0.012) -> float:
        return 1 + rng.gauss(0, sd) + (-0.006 if node == "spark2" else 0.0)

    if bench == "gpu-matmul":
        base = {"bf16": 95.0, "fp16": 93.5, "fp8": 188.0, "fp4": 371.0}
        scale = {"4096": 0.86, "8192": 0.97, "16384": 1.0}
        best = max(p["sizes"], key=lambda s: scale[s])
        labels = {"bf16": "BF16", "fp16": "FP16", "fp8": "FP8", "fp4": "FP4"}
        out = []
        for d in p["dtypes"]:
            per = {s: round(base[d] * scale[s] * n(), 3) for s in p["sizes"]}
            extra = {"scaling": p["fp8_scaling"]} if d == "fp8" else {}
            out.append(
                _r(
                    f"{d}_tflops",
                    f"{labels[d]} dense GEMM",
                    per[best],
                    "TFLOPS",
                    size=best,
                    per_size=per,
                    **extra,
                )
            )
        return out, {}
    if bench == "mem-bandwidth":
        out = []
        if p["side"] in ("both", "gpu"):
            out += [
                _r("gpu_copy_gbps", "GPU copy", 231 * n(), "GB/s", array_mib=p["gpu_array_mib"]),
                _r("gpu_triad_gbps", "GPU triad", 242 * n(), "GB/s", array_mib=p["gpu_array_mib"]),
            ]
        if p["side"] in ("both", "cpu"):
            for key, label, copy, triad, threads in (
                ("all", "all cores", 112, 121, 20),
                ("perf", "performance cores", 98, 105, 10),
                ("eff", "efficiency cores", 64, 69, 10),
            ):
                out += [
                    _r(f"cpu_{key}_copy_gbps", f"CPU copy, {label}", copy * n(0.02), "GB/s", threads=threads),
                    _r(
                        f"cpu_{key}_triad_gbps",
                        f"CPU triad, {label}",
                        triad * n(0.02),
                        "GB/s",
                        threads=threads,
                    ),
                ]
        return out, {}
    if bench == "cpu-throughput":
        wl = {"workload": "sha256+zlib", "seconds": p["seconds_per_test"]}
        # measured on spark1: X925 core ~199, A725 core ~114, all 20 cores ~2800 MB/s
        return [
            _r("single_perf_mbps", "Single core (Cortex-X925)", 199 * n(), "MB/s", **wl),
            _r("single_eff_mbps", "Single core (Cortex-A725)", 114 * n(), "MB/s", **wl),
            _r("multi_perf_mbps", "All performance cores (10x Cortex-X925)", 1880 * n(0.015), "MB/s", **wl),
            _r("multi_eff_mbps", "All efficiency cores (10x Cortex-A725)", 1080 * n(0.015), "MB/s", **wl),
            _r("multi_all_mbps", "All cores (20)", 2800 * n(0.015), "MB/s", **wl),
        ], {}
    if bench == "nccl-allreduce":
        peak = 22.6 * n(0.015)
        sizes = nccl_sizes(p["max_size_mib"])
        lat_us = 27.0 * n(0.04)
        times = [lat_us + s / (peak * 1e3) for s in sizes]  # µs; for 2 ranks busbw == algbw
        bw = [s / (t * 1e3) for s, t in zip(sizes, times, strict=True)]
        series = {
            "size_bytes": [float(s) for s in sizes],
            "time_us": [round(t, 2) for t in times],
            "algbw_gbps": [round(x, 3) for x in bw],
            "busbw_gbps": [round(x, 3) for x in bw],
        }
        method = "torch.distributed (NCCL)"
        at = sizes[bw.index(max(bw))]
        return [
            _r(
                "allreduce_busbw_peak",
                "All-reduce peak bus bandwidth",
                max(bw),
                "GB/s",
                method=method,
                peak_size_bytes=at,
            ),
            _r(
                "allreduce_algbw_max_size",
                f"All-reduce algorithm bandwidth at {sizes[-1] // 2**20} MiB",
                bw[-1],
                "GB/s",
                method=method,
            ),
            _r(
                "allreduce_latency_small",
                f"All-reduce time at {sizes[0]} B",
                times[0],
                "us",
                "lower",
                method=method,
            ),
        ], series
    if bench == "rdma-bw-lat":
        out, rail = [], p["rail"]
        if "bw" in p["tests"]:
            bw = {"4096": 141.0, "65536": 189.5, "1048576": 193.2}[p["msg_size"]] * n(0.006)
            out.append(
                _r(
                    "rdma_write_bw",
                    f"RDMA write bandwidth (rail {rail})",
                    bw,
                    "Gb/s",
                    rail=rail,
                    msg_size=int(p["msg_size"]),
                )
            )
        if "lat" in p["tests"]:
            lat = 2.38 * n(0.03)
            out += [
                _r("rdma_write_lat", f"RDMA write latency (rail {rail})", lat, "us", "lower", rail=rail),
                _r(
                    "rdma_write_lat_p99",
                    f"RDMA write latency p99 (rail {rail})",
                    lat * 1.31 * n(0.05),
                    "us",
                    "lower",
                ),
            ]
        return out, {}
    if bench == "storage-fio":
        fio = bool(info and info.tools.get("fio"))
        ex = {"method": "fio" if fio else "builtin", "size_mib": p["size_mib"], "threads": p["threads"]}
        # (MB/s, IOPS, p99 µs) with fio / with the built-in single-process runner
        table = {
            "seq_write": ((4750, 0, 350), (4650, 0, 400)),  # built-in measured on spark1: ~5.0 GB/s
            "seq_read": ((6600, 0, 420), (5750, 0, 480)),  # built-in measured: ~5.9 GB/s, p99 ~0.48 ms
            # built-in measured (64 MiB, 4 threads, synchronous O_DIRECT, QD 4): ~16k / ~18.7k IOPS
            "rand_read": ((3110, 760_000, 95), (65.5, 16_000, 685)),
            "rand_write": ((1970, 480_000, 40), (76.6, 18_700, 320)),
        }
        out = []
        for prof in p["profiles"]:
            mbps, iops, p99 = table[prof][0 if fio else 1]
            k, label = n(0.025), STORAGE_LABEL[prof]
            out.append(_r(f"{prof}_mbps", label, mbps * k, "MB/s", **ex))
            if prof.startswith("rand"):
                out.append(_r(f"{prof}_iops", f"{label} IOPS", iops * k, "IOPS", **ex))
            out.append(_r(f"{prof}_p99_us", f"{label} p99 latency", p99 / k, "us", "lower", **ex))
        return out, {}
    if bench == "llm-inference":
        c, model = p["concurrency"], p["model"] or SERVED_MODEL.get(node, "model")
        ex = {"engine": "OpenAI-compatible", "model": model, "simulated": True}  # labels stay short
        head = {**ex, "headline": True}
        ttft = (150 + p["prompt_tokens"] / 1024 * 170) * n(0.06) * (1 + 0.15 * (c - 1))
        decode = 46.0 * n(0.03) / (1 + 0.09 * (c - 1))
        prefill = p["prompt_tokens"] / ttft * 1000 * 0.92
        mem = {**ex, "source": "pid 4242 and its children"}
        return [
            _r("decode_tok_s", "Decode tokens/s per request", decode, "tok/s", **head),
            _r("ttft_p50_ms", "Time to first token p50", ttft, "ms", "lower", **head),
            _r("prefill_tok_s", "Prefill tokens/s", prefill, "tok/s", **head),
            _r("ttft_p95_ms", "Time to first token p95", ttft * 1.28 * n(0.04), "ms", "lower", **ex),
            _r("decode_tok_s_total", "Output tokens/s, all requests", decode * c * 0.97, "tok/s", **ex),
            _r("serving_gpu_mem_gib", "Serving process GPU memory", 80.1 * n(0.002), "GiB", "lower", **mem),
            _r("mem_used_delta_gib", "Unified memory growth during run", 0.35 * n(0.2), "GiB", "lower", **ex),
        ], {}
    return [], {}


def soak_point(model: DemoModel, t: float, rng: random.Random) -> dict[str, float]:
    g = model.sample_at(t).gpu[0]
    vals = [g.sm_mhz, g.temp_c, g.power_w, g.throttle_mask, g.util]
    pt = {k: float(v or 0.0) for k, v in zip(SOAK_KEYS, vals, strict=True)}
    pt["tflops"] = round(95.0 * 0.97 * min(1.0, (g.sm_mhz or 0.0) / 2200) * (1 + rng.gauss(0, 0.004)), 3)
    return pt


def soak_results(s: dict[str, list[float]]) -> list[BenchResult]:
    clk, temp, mask, tf = (
        s.get("gpu0.sm_mhz", []),
        s.get("gpu0.temp_c", []),
        s.get("gpu0.throttle_mask", []),
        s.get("tflops", []),
    )
    if len(clk) < 2 or not tf:
        return []
    k = max(1, len(tf) // 10)
    first, last = statistics.fmean(tf[:k]), statistics.fmean(tf[-k:])
    mean = statistics.fmean(clk)
    return [
        _r("tflops_first", "BF16 TFLOPS, first window", first, "TFLOPS"),
        _r("tflops_last", "BF16 TFLOPS, last window", last, "TFLOPS"),
        _r("tflops_change_pct", "Throughput change, last vs first window", (last - first) / first * 100, "%"),
        _r("sm_mhz_mean", "Mean SM clock", mean, "MHz", samples=len(clk)),
        _r("sm_mhz_min", "Lowest SM clock", min(clk), "MHz", samples=len(clk)),
        _r("sm_clock_cv_pct", "Clock variation (CV)", statistics.pstdev(clk) / mean * 100, "%", "lower"),
        _r("temp_max_c", "Peak GPU temperature", max(temp), "°C", "lower"),
        _r(
            "throttled_pct",
            "Time throttled (thermal or hardware)",
            sum(1 for m in mask if int(m) & LIMITING_MASK) / len(mask) * 100,
            "%",
            "lower",
        ),
        _r(
            "power_capped_pct",
            "Time at the power cap",
            sum(1 for m in mask if int(m) & POWER_CAP_BIT) / len(mask) * 100,
            "%",
            "lower",
        ),
    ]


def node_metadata(info: NodeInfo | None, model: DemoModel, t0: float, t1: float, extra: dict) -> dict:
    """The keys the real agent records (agent/bench/metadata.py), with telemetry snapshots at start/end."""
    g = info.gpus[0] if info and info.gpus else None

    def snap(t: float) -> dict:
        s = model.sample_at(t)
        x = s.gpu[0]
        return {"ts": t, "mem_used": s.mem.used, "sm_mhz": x.sm_mhz, "temp_c": x.temp_c, "power_w": x.power_w}

    return {
        "hostname": info.hostname if info else model.node_id,
        "node_id": model.node_id,
        "agent_version": info.agent_version if info else "",
        "driver": info.driver if info else None,
        "cuda": info.cuda if info else None,
        "nvml": info.nvml if info else None,
        "gpu_name": g.name if g else None,
        "gpu_uuid": g.uuid if g else None,
        "gpu_cc": g.compute_capability if g else None,
        "suite_git": SUITE_GIT,
        "start": snap(t0),
        "end": snap(t1),
        "simulated": True,
        **extra,
    }


def _extra(bench: str, info: NodeInfo | None) -> dict:
    if bench in ("gpu-matmul", "mem-bandwidth", "nccl-allreduce", "thermal-soak"):
        return {"bench_image": IMAGE}
    if bench == "storage-fio":
        return {"method": "fio" if info and info.tools.get("fio") else "builtin"}
    return {}


# ---------------------------------------------------------------------------------------------------------
# Simulated runner
# ---------------------------------------------------------------------------------------------------------


def _log_failure(t: asyncio.Task) -> None:
    if not t.cancelled() and t.exception() is not None:
        log.error("demo benchmark failed", exc_info=t.exception())


@dataclass
class _Sim:
    node: str
    req: BenchStartRequest
    state: NodeBenchState
    duration: float
    window: list[float] | None = None
    task: asyncio.Task | None = None


class DemoBench:
    def __init__(self, cluster):
        self.cluster = cluster
        self.on_state: StateCallback | None = None
        self.current: dict[str, _Sim] = {}
        self.finished: dict[str, deque[_Sim]] = {}

    def bind(self, on_state: StateCallback) -> None:
        self.on_state = on_state

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        for sim in list(self.current.values()):
            if sim.task:
                sim.task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sim.task

    async def catalog(self, node: str) -> list[BenchSpec]:
        return demo_catalog(node, self.cluster.sources[node].state.info)

    async def start(self, node: str, req: BenchStartRequest) -> NodeBenchState:
        if node in self.current:
            raise BenchError(
                409,
                Problem(
                    message=f"A benchmark is already running on {node}",
                    cause=f"Run {self.current[node].req.run_id} is in progress",
                    fix="Wait for it to finish, or cancel it",
                ),
            )
        params = validate(req.bench_id, req.params)
        st = NodeBenchState(
            run_id=req.run_id,
            bench_id=req.bench_id,
            node_id=node,
            role=req.role,
            status="running",
            phase="Starting",
            started_ts=time.time(),
        )
        sim = _Sim(
            node=node,
            req=req.model_copy(update={"params": params}),
            state=st,
            duration=demo_duration(req.bench_id, params),
        )
        self.current[node] = sim
        sim.task = asyncio.create_task(self._run(sim))
        sim.task.add_done_callback(_log_failure)
        return st.model_copy()

    def _find(self, node: str, run_id: str) -> _Sim | None:
        cur = self.current.get(node)
        if cur and cur.req.run_id == run_id:
            return cur
        return next((s for s in self.finished.get(node, ()) if s.req.run_id == run_id), None)

    async def get(self, node: str, run_id: str) -> NodeBenchState | None:
        sim = self._find(node, run_id)
        return sim.state.model_copy() if sim else None

    async def cancel(self, node: str, run_id: str) -> None:
        sim = self._find(node, run_id)
        if sim and sim.task and not sim.task.done():
            sim.task.cancel()

    def _emit(self, sim: _Sim) -> None:
        if self.on_state:
            self.on_state(sim.node, sim.state.model_copy(deep=True))

    def _peer_status(self, sim: _Sim) -> str | None:
        peer = self._find(sim.req.peer_node or "", sim.req.run_id)
        return peer.state.status if peer else None

    async def _run(self, sim: _Sim) -> None:
        req, st = sim.req, sim.state
        model: DemoModel = self.cluster.sources[sim.node].model
        info = self.cluster.sources[sim.node].state.info
        p = req.params
        rng = random.Random(f"{req.run_id}{sim.node}")
        t0 = time.time()
        load = GPU_LOAD.get(req.bench_id, 0.0)
        if load and req.role != "server":
            sim.window = [t0, t0 + sim.duration + 1, load]
            model.bench_windows.append(sim.window)
            del model.bench_windows[:-64]
        try:
            if req.role == "server":  # ib_write_bw server: listen until the client is done
                await asyncio.sleep(0.6)
                st.phase, st.ready = f"Listening on {rail_ip(info, p['rail'])} (rail {p['rail']})", True
                self._emit(sim)
                deadline = t0 + sim.duration * 2 + 35
                while self._peer_status(sim) not in ("succeeded", "failed", "cancelled"):
                    if time.time() > deadline:
                        raise TimeoutError
                    await asyncio.sleep(TICK_S)
            else:
                await self._timeline(sim, model, rng, t0)
            if req.bench_id == "thermal-soak":
                st.results = soak_results(st.series)
            else:
                role = f"rank{req.rank}" if req.role == "rank" else req.role
                st.results, series = make_results(req.bench_id, p, sim.node, rng, role, info)
                st.series.update(series)
            st.status, st.finished_ts, st.phase, st.progress = "succeeded", time.time(), "Done", 1.0
            st.log_tail.append(f"{req.bench_id}: {len(st.results)} results")
        except asyncio.CancelledError:
            st.status, st.finished_ts, st.phase = "cancelled", time.time(), "Cancelled"
            st.log_tail.append("Cancelled: stopped the benchmark container and removed its files")
        except TimeoutError:
            st.status, st.finished_ts, st.phase = "failed", time.time(), "Failed"
            st.error = Problem(
                message=f"No RDMA client connected to {sim.node}",
                cause="ib_write_bw waited for its client and gave up",
                fix="Run the benchmark again",
            )
        finally:
            if sim.window:
                sim.window[1] = min(sim.window[1], time.time())
            extra = {"role": req.role, "params": p, **_extra(req.bench_id, info)}
            st.metadata = node_metadata(info, model, t0, time.time(), extra)
            if self.current.get(sim.node) is sim:
                del self.current[sim.node]
            self.finished.setdefault(sim.node, deque(maxlen=FINISHED_KEEP)).append(sim)
            self._emit(sim)

    async def _timeline(self, sim: _Sim, model: DemoModel, rng: random.Random, t0: float) -> None:
        req, st, p = sim.req, sim.state, sim.req.params
        steps = phases(req.bench_id, p, req.peer_ip)
        total = sum(w for _, w in steps)
        soak = req.bench_id == "thermal-soak"
        while True:
            now = time.time()
            frac = (now - t0) / sim.duration
            if frac >= 1:
                return
            acc, label = 0.0, steps[-1][0]
            for name, w in steps:
                acc += w / total
                if frac < acc:
                    label = name
                    break
            if soak and frac > 0.03:
                if label == "Sustained load":  # in real-run minutes, as the agent shows it
                    label = f"Sustained load {frac * p['minutes']:.1f} of {p['minutes']} min"
                pt = soak_point(model, now, rng)
                pt["t"] = round(now - t0, 2)
                for k, v in pt.items():
                    st.series.setdefault(k, []).append(v)
            if label.split(" ")[0] != st.phase.split(" ")[0] or not st.log_tail:
                st.log_tail = (st.log_tail + [label])[-20:]
            st.phase, st.progress = label, round(min(frac, 0.99), 3)
            self._emit(sim)
            await asyncio.sleep(TICK_S)


# ---------------------------------------------------------------------------------------------------------
# Seeded history
# ---------------------------------------------------------------------------------------------------------

# (bench, nodes, params overrides, hours ago, outcome, baseline?)
_SEED: list[tuple[str, list[str], dict, float, str, bool]] = [
    ("gpu-matmul", ["spark1"], {}, 9 * 24, "succeeded", True),
    ("cpu-throughput", ["spark1", "spark2"], {}, 8 * 24 + 3, "succeeded", False),
    ("gpu-matmul", ["spark1", "spark2"], {}, 6 * 24, "succeeded", False),
    ("mem-bandwidth", ["spark1", "spark2"], {}, 5 * 24 + 2, "succeeded", False),
    ("rdma-bw-lat", ["spark1", "spark2"], {}, 4 * 24, "succeeded", True),
    ("storage-fio", ["spark2"], {}, 3 * 24 + 5, "succeeded", False),
    ("rdma-bw-lat", ["spark1", "spark2"], {"rail": "B"}, 2 * 24 + 6, "failed", False),
    ("thermal-soak", ["spark1"], {}, 2 * 24, "succeeded", False),
    ("llm-inference", ["spark1"], {}, 26, "succeeded", False),
    ("nccl-allreduce", ["spark1", "spark2"], {}, 20, "succeeded", False),
    ("thermal-soak", ["spark2"], {"minutes": 20}, 7, "cancelled", False),
    ("gpu-matmul", ["spark1"], {}, 3, "succeeded", False),  # the regression (BF16 81.2 vs 95.0)
]


def seed_history(
    store: BenchStore, models: dict[str, DemoModel], settings_pct: float, add_event, now: float | None = None
) -> None:
    """Populate an empty demo DB with a believable history: baselines, a regression, a failure, a cancel.
    Runs keep their real (uncompressed) durations; they 'happened' on hardware."""
    now = time.time() if now is None else now
    if store.count():
        _register_windows(store, models)
        return
    for i, (bench, nodes, over, hours, outcome, baseline) in enumerate(_SEED):
        name = AGENT_REGISTRY[bench].name
        params = validate(bench, over)
        rng = random.Random(f"seed{i}")
        started = now - hours * 3600
        dur = real_duration(bench, params) * (0.35 if outcome == "cancelled" else 1.0)
        run = BenchRun(
            id=new_run_id(started - 2),
            bench_id=bench,
            params=params,
            nodes=nodes,
            status=outcome,  # type: ignore[arg-type]
            created_ts=started - 2,
            started_ts=started,
            finished_ts=started + dur,
            progress=1.0 if outcome == "succeeded" else 0.35,
            phase={"succeeded": "Done", "failed": "Failed", "cancelled": "Cancelled"}[outcome],
            params_key=canonical(params),
            metadata={"bench_name": name, "nodes": {}},
        )
        for n in nodes:
            m = models[n]
            if bench in GPU_LOAD:
                m.bench_windows.append([started, started + dur, GPU_LOAD[bench]])
            first = n == nodes[0]
            role = {
                "nccl-allreduce": "rank0" if first else "rank1",
                "rdma-bw-lat": "client" if first else "server",
            }
            series: dict[str, list[float]] = {}
            if bench == "thermal-soak":
                for k in range(0, int(dur), 2):
                    pt = soak_point(m, started + k, rng)
                    pt["t"] = float(k)
                    for key, v in pt.items():
                        series.setdefault(key, []).append(v)
                results = soak_results(series)
            else:
                results, series = make_results(bench, params, n, rng, role.get(bench, "single"), m.info)
            if outcome != "succeeded":
                results = []
            if i == len(_SEED) - 1:  # the regression run
                for r in results:
                    r.value = 81.2 if r.metric == "bf16_tflops" else round(r.value * 0.985, 3)
            if i == 0:
                for r in results:  # a round, memorable baseline
                    r.value = 95.0 if r.metric == "bf16_tflops" else r.value
            owner = None if bench in CLUSTER_RESULTS else n
            run.results += [r.model_copy(update={"node_id": owner}) for r in results]
            run.series.update({f"{n}.{k}": v for k, v in series.items()})
            extra = {"params": params, **_extra(bench, m.info)}
            run.metadata["nodes"][n] = node_metadata(m.info, m, started, started + dur, extra)
            _telemetry(run, n, m, started, started + dur)
        if outcome == "failed":
            run.error = Problem(
                message=f"Lost contact with {nodes[1]} during the run",
                cause=f"Lost connection to agent on {nodes[1]}: Connection closed (no reason given)",
                fix=f"Check `systemctl status sparkline-agent` on {nodes[1]}",
            )
            run.log_tail = [f"[{nodes[0]}] Connecting to 10.100.9.2", f"[{nodes[0]}] ib_write_bw · 64 KiB"]
        elif outcome == "cancelled":
            run.log_tail = ["[console] Cancelled by user"]
        base_id = store.baseline_id(bench, run.params_key)
        base = store.get(base_id) if base_id and outcome == "succeeded" else None
        if base is not None:
            run.baseline_run_id = base.id
            for r, change in apply_baseline(run.results, base.results, settings_pct):
                add_event(
                    Event(
                        id=0,
                        ts=run.finished_ts or now,
                        node_id=r.node_id,
                        severity="warning",
                        kind="bench",
                        title=regression_title(r.node_id, r, change),
                        detail=f"{name} run {run.id} is more than {threshold_text(r, settings_pct)} worse "
                        f"than baseline run {base.id}",
                        metric=r.metric,
                        value=r.value,
                    )
                )
        store.save(run)
        if baseline:
            store.set_baseline(bench, run.params_key, run.id, ts=run.finished_ts)


def _telemetry(run: BenchRun, node: str, m: DemoModel, t0: float, t1: float) -> None:
    """The overlay a real run would have recorded: 1 s points (<= 1800 by stepping)."""
    step = max(1.0, (t1 - t0) / 1800)
    pre = f"telemetry.{node}."
    t = t0
    while t < t1:
        g = m.sample_at(t).gpu[0]
        for key, v in (
            ("ts", t),
            ("util", g.util),
            ("temp_c", g.temp_c),
            ("power_w", g.power_w),
            ("sm_mhz", g.sm_mhz),
            ("throttle_mask", g.throttle_mask),
        ):
            run.series.setdefault(pre + key, []).append(float(v or 0.0))
        t += step


def _register_windows(store: BenchStore, models: dict[str, DemoModel]) -> None:
    """After a demo restart, put the stored runs' load back into the demo telemetry model."""
    for run in store.list(limit=60):
        if run.bench_id not in GPU_LOAD or not run.started_ts or not run.finished_ts:
            continue
        for n in run.nodes:
            if n in models:
                models[n].bench_windows.append([run.started_ts, run.finished_ts, GPU_LOAD[run.bench_id]])
