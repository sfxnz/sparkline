"""--demo benchmarks: a simulated runner behind the BenchBackend interface, plus seeded history.

The catalog, parameter validation, duration estimates and availability notes come from the agent's own
registry (sparkline.agent.bench), so the demo offers exactly what a real node offers; results use the agent's
metric names and units. Runs are time-compressed (the agent's estimate / 10; the thermal soak takes 60-90 s;
LLM inference plays its requests at double speed, 4-60 s per level), which the catalog says, and report
plausible GB10 numbers with small run-to-run noise. While a run is going,
the node's demo telemetry carries the load (DemoModel.bench_windows for the GPU, disk_windows for the storage
profiles), so the telemetry overlay is alive. fio is "not
installed" on the demo nodes (built-in runner, noted), and spark3 has no ConnectX-7 peer, so 2-node
benchmarks are unavailable there.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import random
import statistics
import time
from bisect import bisect_right
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import accumulate
from typing import TYPE_CHECKING, Any, Literal, cast

from pydantic import ValidationError

if TYPE_CHECKING:  # imported at run time only by demo tool-eval runs
    from tool_eval_bench.domain.scenarios import ScenarioDefinition, ScenarioResult

from ..agent.bench import probes
from ..agent.bench.specs import REGISTRY as AGENT_REGISTRY
from ..agent.bench.specs import levels, nccl_sizes, validation_message
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
    new_run_id,
    params_key,
    rail_ip,
    regression_title,
    threshold_text,
)
from .bench_store import BenchStore
from .cluster import Cluster
from .demo import DemoModel, DemoSource

log = logging.getLogger("sparkline.console.demo_bench")
SUITE_GIT = "demo"  # the real agent reports the suite's git hash
IMAGE = "nvcr.io/nvidia/pytorch:26.07-py3"
GPU_LOAD = {
    "gpu-matmul": 1.0,
    "mem-bandwidth": 0.75,
    "nccl-allreduce": 0.55,
    "llm-inference": 0.9,
    "tool-eval": 0.6,
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


COMPRESSED_NOTE = "Demo: runs are time-compressed to about a tenth of the estimated duration."
# LLM inference is compressed less, so its streams can be watched (LLM_SPEED, LLM_LEVEL_S below)
LLM_NOTE = "Demo: the simulated requests play at double speed, and each concurrency level takes 4 to 60 s."
# Disk load of each storage profile in the demo (read B/s, write B/s): the built-in runner's results below.
DISK_LOAD = {
    "seq_write": (0.0, 6.9e9),
    "seq_read": (8.5e9, 0.0),
    "rand_read": (57.8e6, 0.0),
    "rand_write": (0.0, 61.0e6),
}


def demo_catalog(node: str, info: NodeInfo | None) -> list[BenchSpec]:
    env = _env(node, info)
    out = []
    for b in AGENT_REGISTRY.values():
        problem, note = probes.availability(b.id, env)
        demo = LLM_NOTE if b.id == "llm-inference" else COMPRESSED_NOTE
        out.append(b.spec({node: problem}, f"{note} {demo}".strip()))
    return out


def storage_windows(p: dict[str, Any], t0: float, duration: float) -> list[list[float]]:
    """[start, end, read B/s, write B/s] per phase of a demo storage run (the test file is always written)."""
    profiles = ["seq_write"] + [x for x in p.get("profiles", []) if x != "seq_write"]
    step = duration / len(profiles)
    return [[t0 + i * step, t0 + (i + 1) * step, *DISK_LOAD[x]] for i, x in enumerate(profiles)]


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
    if bench == "llm-inference":  # slower: every level stays on screen for a few seconds
        return sum(LlmDemo(p, "", random.Random(0)).walls())
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
            ("Single performance core (Cortex-X925)", 1),
            ("Single efficiency core (Cortex-A725)", 1),
            ("All 10 performance cores (Cortex-X925)", 1),
            ("All 10 efficiency cores (Cortex-A725)", 1),
            ("All 20 cores (10 performance + 10 efficiency)", 1),
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
    if bench == "tool-eval":  # as the payload reports it: two endpoint checks, then each scenario
        scenarios = te_scenarios(p["suite"])
        n = len(scenarios)
        return [("Checking the endpoint", 0.3), ("Checking tool calling", 0.5)] + [
            (f"Scenario {i + 1} of {n} · {s.id} {s.title}", te_weight(s)) for i, s in enumerate(scenarios)
        ]
    return [("Starting container", 0.4), ("Sustained load", 18.0)]  # thermal-soak


def _r(
    metric: str,
    label: str,
    value: float,
    unit: str,
    better: Literal["higher", "lower"] = "higher",
    **extras: Any,
) -> BenchResult:
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
        # measured on spark1 and spark2 at 16384 (2026-10-07): BF16 98.5-99.2, FP16 97.7-98.9, FP8 per-tensor
        # 195-200, NVFP4 343-349 TFLOPS; 4096 reaches 0.82-0.90 of that, 8192 0.95-0.99
        base = {"bf16": 98.5, "fp16": 98.0, "fp8": 196.0, "fp4": 345.0}
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
        # measured on spark1 and spark2 (1 GiB arrays): GPU ~222 / ~224 GB/s; CPU about 120 GB/s for every
        # core set, the A725 set slightly ahead of the X925 set (each set spans both clusters)
        out = []
        if p["side"] in ("both", "gpu"):
            out += [
                _r("gpu_copy_gbps", "GPU copy", 222 * n(), "GB/s", array_mib=p["gpu_array_mib"]),
                _r("gpu_triad_gbps", "GPU triad", 224 * n(), "GB/s", array_mib=p["gpu_array_mib"]),
            ]
        if p["side"] in ("both", "cpu"):
            for key, label, copy, triad, threads in (
                ("all", "all cores", 125, 119, 20),
                ("perf", "performance cores", 119, 114, 10),
                ("eff", "efficiency cores", 126, 120, 10),
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
        # measured on spark1 and spark2 (2026-10-07, heap trimming off): X925 core ~246, A725 core ~125 MB/s;
        # 10 cores of a kind scale 10.0x; all 20 cores ~3660 (98.8 % of the two sets' sum)
        both = "All 20 cores (10 performance + 10 efficiency)"
        return [
            _r("single_perf_mbps", "Single performance core (Cortex-X925)", 246 * n(), "MB/s", **wl),
            _r("single_eff_mbps", "Single efficiency core (Cortex-A725)", 125 * n(), "MB/s", **wl),
            _r("multi_perf_mbps", "All 10 performance cores (Cortex-X925)", 2455 * n(0.015), "MB/s", **wl),
            _r("multi_eff_mbps", "All 10 efficiency cores (Cortex-A725)", 1250 * n(0.015), "MB/s", **wl),
            _r("multi_all_mbps", both, 3660 * n(0.015), "MB/s", **wl),
        ], {}
    if bench == "nccl-allreduce":
        peak = 22.6 * n(0.015)
        sizes = nccl_sizes(p["max_size_mib"])
        lat_us = 13.0 * n(0.04)  # measured on two GB10s: 12.4-14.5 us up to 2 KiB, 22.55 GB/s at 1 GiB
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
            # measured spark1 -> spark2 on both rails (perftest 6.20, RoCE MTU 1024): each rail is one PCIe
            # Gen5 x4 function, so ~109 Gb/s of payload (115 Gb/s on the wire), not the 200 Gb/s port rate.
            gbps = {"4096": 104.2, "65536": 108.9, "1048576": 109.1}[p["msg_size"]] * n(0.004)
            out.append(
                _r(
                    "rdma_write_bw",
                    f"RDMA write bandwidth (rail {rail})",
                    gbps,
                    "Gb/s",
                    rail=rail,
                    msg_size=int(p["msg_size"]),
                )
            )
        if "lat" in p["tests"]:
            lat = 1.43 * n(0.03)  # measured typical 1.40-1.46 us, p99 1.50-1.96 us
            out += [
                _r("rdma_write_lat", f"RDMA write latency (rail {rail})", lat, "us", "lower", rail=rail),
                _r(
                    "rdma_write_lat_p99",
                    f"RDMA write latency p99 (rail {rail})",
                    lat * (1.05 + 0.3 * rng.random()),  # measured p99 / typical: 1.07-1.34
                    "us",
                    "lower",
                ),
            ]
        return out, {}
    if bench == "storage-fio":
        fio = bool(info and info.tools.get("fio"))
        ex = {"method": "fio" if fio else "builtin", "size_mib": p["size_mib"], "threads": p["threads"]}
        # (MB/s, IOPS, p99 µs) with fio / with the built-in runner. Built-in measured on spark1 and spark2
        # (4 GiB, QD 1 per 1 MiB stream, 4 workers at QD 1 for 4 KiB): 5.8-7.8 / 8.0-9.5 GB/s, 12-17k IOPS.
        # fio sequential: dd with 16 MiB O_DIRECT requests on the same drives, 6.3-7.9 / 12.1 GB/s.
        table = {
            "seq_write": ((7000, 0, 350), (6900, 0, 410)),
            "seq_read": ((12000, 0, 420), (8500, 0, 320)),
            "rand_read": ((3110, 760_000, 95), (57.8, 14_100, 800)),
            "rand_write": ((1970, 480_000, 40), (61.0, 14_900, 800)),
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
    if bench == "tool-eval":
        return ToolEvalDemo(p, node, rng).bench_results(), {}
    return [], {}


def soak_point(model: DemoModel, t: float, rng: random.Random) -> dict[str, float]:
    g = model.sample_at(t).gpu[0]
    vals = [g.sm_mhz, g.temp_c, g.power_w, g.throttle_mask, g.util]
    pt = {k: float(v or 0.0) for k, v in zip(SOAK_KEYS, vals, strict=True)}
    # measured 10 min soaks at 8192: 94.6 TFLOPS at 2149 MHz, 95.5 at 2181 MHz
    pt["tflops"] = round(96.5 * min(1.0, (g.sm_mhz or 0.0) / 2200) * (1 + rng.gauss(0, 0.004)), 3)
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
# LLM inference: simulated concurrency streams (the live snapshots and detail the real payload sends)
# ---------------------------------------------------------------------------------------------------------

LLM_SPEED = 2.0  # demo LLM runs play at 2x real time (a stream's text tail still overlaps tick to tick) ...
LLM_LEVEL_S = (4.0, 60.0)  # ... but every level stays on screen for 4-60 s
LLM_START_S = 0.6  # querying /v1/models
LLM_CHARS_PER_TOKEN = 4.2
LLM_ENGINE = "OpenAI-compatible"
# What the demo models answer to the payload's prompt ("Summarise this text: the river carries light across
# the valley while engineers measure every quiet signal from the cluster ..."), and what a reasoning model
# thinks first.
LLM_ANSWER = [
    "The text describes a river carrying light across a valley while engineers keep watch over a cluster.",
    "Its focus is quiet attention: every small signal from the machines is measured and written down.",
    "The engineers note memory clocks, heat and power, the figures that show whether the cluster is healthy.",
    "All of this happens before the evening shift begins, which gives the scene a calm, unhurried rhythm.",
    "The same sentence repeats many times, so the passage reads more like a steady pulse than a story.",
    "Nothing dramatic happens; the point is the routine care that keeps a system running.",
    "In short, it pairs a peaceful landscape with patient technical work.",
    "The river and the cluster mirror each other: both carry something steadily from one place to another.",
    "Read as a whole, the passage is less about the valley than about the habit of noticing.",
    "A one-line summary: engineers quietly record a cluster's vital signs as daylight fades over a river.",
    "The repetition hints at a long day of observation, each pass much like the one before.",
    "There are no named characters, only the work itself and the light moving across the water.",
    "Key details are the light on the river, the careful measurements and the coming change of shift.",
    "The tone is observational and calm, closer to a field log than to a narrative.",
    "If anything changes over the passage it is only the light; the measurements stay constant.",
    "Overall, the text treats careful, repeatable measurement as a quiet kind of craft.",
]
LLM_THINKING = [
    "The user wants a summary of a short passage that repeats one long sentence.",
    "Main elements: a river, light, a valley, engineers, a cluster and the measurements they take.",
    "The measurements are memory clocks, heat and power, recorded before the evening shift.",
    "I should not repeat the text back word for word; a few sentences will do.",
    "The repetition itself is worth a mention, since it shapes how the passage reads.",
    "Keep the tone neutral and stick to what the text actually says.",
    "So: the setting, the people, what they record and the overall mood.",
]


@dataclass
class _LlmReq:
    slot: int
    req: int  # 1-based within its level
    sent: float  # simulated seconds since its level started
    first: float
    end: float
    tokens: int
    rate: float  # decode tok/s: (tokens - 1) / (end - first)
    think: int  # reasoning tokens, streamed before the answer
    start: int  # where its sentences start in the corpus


def _llm_tokens(r: _LlmReq, t: float) -> int:
    if t < r.first:
        return 0
    return r.tokens if t >= r.end else min(r.tokens, 1 + int((t - r.first) * r.rate))


def _llm_chars(tokens: int) -> int:
    return round(tokens * LLM_CHARS_PER_TOKEN)


def _llm_text(pool: list[str], start: int, chars: int, tail: int) -> str:
    """The last `tail` of the first `chars` characters of a demo text: `pool`'s sentences from `start` on,
    round and round."""
    k = start % len(pool)
    cycle = " ".join(pool[k:] + pool[:k]) + " "
    lo = max(0, chars - tail)
    return (cycle * (2 + tail // len(cycle)))[lo % len(cycle) :][: chars - lo]


def _pct(vals: list[float], q: float) -> float:
    """Nearest-rank percentile, as the payload computes it."""
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, math.ceil(q / 100 * len(s)) - 1))]


def _streams(n: int) -> str:
    return f"{n} stream" if n == 1 else f"{n} streams"


class LlmDemo:
    """A simulated llm-inference run on one node with every request planned up front (simulated seconds from
    its level's start), so its live snapshots, detail and results describe the same requests. GB10-like
    rates: about 46 tok/s for one stream and 1 / (1 + 0.09 (L - 1)) of that per stream with L streams, TTFT
    15% longer per extra stream, a slower straggler now and then; spark3's Qwen reasons for the first ~15% of
    its tokens."""

    def __init__(self, p: dict[str, Any], node: str, rng: random.Random) -> None:
        self.p = p
        self.model = p["model"] or SERVED_MODEL.get(node, "model")
        self.sizes = levels(p["concurrency"], p["sweep"])
        self.counts = [max(p["requests"], size) for size in self.sizes]
        self.prompt_tokens = p["prompt_tokens"] + (14 if p["api"] == "chat" else 0)  # as usage reports them
        think = 0.15 if SERVED_MODEL.get(node, "").startswith("Qwen") else 0.0
        # run-to-run noise of decode speed and TTFT
        noise = (1 + rng.gauss(0, 0.03) - (0.006 if node == "spark2" else 0.0), 1 + rng.gauss(0, 0.06))
        self.plan = [
            self._plan(size, n, noise, think, rng) for size, n in zip(self.sizes, self.counts, strict=True)
        ]
        # per level and slot: its requests, when each was sent, and the tokens of the ones before it
        self.slots = [
            [(rs, [r.sent for r in rs], [0, *accumulate(r.tokens for r in rs)]) for rs in self._by_slot(k)]
            for k in range(len(self.sizes))
        ]
        self.first_token = [min(r.first for r in rs) for rs in self.plan]
        self.mem = (80.1 * (1 + rng.gauss(0, 0.002)), 0.35 * (1 + rng.gauss(0, 0.2)))

    def _plan(
        self, size: int, n: int, noise: tuple[float, float], think: float, rng: random.Random
    ) -> list[_LlmReq]:
        """A closed loop: each request goes to the slot that frees first, as the payload's workers do."""
        p = self.p
        rate = 46.0 * noise[0] / (1 + 0.09 * (size - 1))
        alone = (150 + p["prompt_tokens"] / 1024 * 170) / 1000  # TTFT of one request on its own
        ttft = alone * (1 + 0.15 * (size - 1)) * noise[1]
        spread = 0.05 + 0.25 * (1 - 1 / size)  # waiting behind other prefills: wider with more streams
        free = [0.0] * size
        out = []
        for i in range(n):
            slot = min(range(size), key=free.__getitem__)
            tokens = p["max_tokens"]
            if rng.random() < 0.15:  # an answer that ends before max_tokens
                tokens = max(1, round(tokens * rng.uniform(0.55, 0.95)))
            straggler = rng.uniform(0.6, 0.75) if rng.random() < 0.07 else 1.0
            r = rate * (1 + rng.gauss(0, 0.03)) * straggler
            first = free[slot] + ttft * rng.uniform(1 - spread, 1 + spread)  # staggered first tokens
            end, start = first + (tokens - 1) / r, rng.randrange(len(LLM_ANSWER))
            req = _LlmReq(slot, i + 1, free[slot], first, end, tokens, r, round(tokens * think), start)
            out.append(req)
            free[slot] = req.end
        return out

    def _by_slot(self, k: int) -> list[list[_LlmReq]]:
        return [[r for r in self.plan[k] if r.slot == s] for s in range(self.sizes[k])]

    def duration(self, k: int) -> float:
        return max(r.end for r in self.plan[k])

    def walls(self) -> list[float]:
        """Wall seconds of a demo run: querying the endpoint, then each level (LLM_SPEED, LLM_LEVEL_S)."""
        lo, hi = LLM_LEVEL_S
        return [LLM_START_S] + [
            min(hi, max(lo, self.duration(k) / LLM_SPEED)) for k in range(len(self.sizes))
        ]

    def _total(self, k: int, t: float) -> int:
        """Tokens every slot of level k has streamed by simulated time t."""
        n = 0
        for rs, sent, before in self.slots[k]:
            j = bisect_right(sent, t) - 1
            if j >= 0:
                n += before[j] + _llm_tokens(rs[j], t)
        return n

    def _agg(self, k: int, t: float) -> float | None:
        """Aggregate output tok/s over the last 2 s, from just before the level's first token at most."""
        if t <= self.first_token[k]:
            return None
        a = max(t - 2.0, self.first_token[k] - 0.125)
        return (self._total(k, t) - self._total(k, a)) / (t - a)

    def _stream(self, k: int, s: int, t: float) -> dict:
        rs, sent, _ = self.slots[k][s]
        j = max(0, bisect_right(sent, t) - 1)  # every slot sends its first request at 0
        r = rs[j]
        tokens = _llm_tokens(r, t)
        thought, answered = _llm_chars(min(tokens, r.think)), _llm_chars(max(0, tokens - r.think))
        state = "wait" if t < r.first else "decode" if t < r.end else "done"
        rate = None
        if state == "decode" and tokens >= 2 and t - r.first >= 0.5:  # the payload's minimum rate window
            rate = r.rate * (1 + 0.03 * math.sin(2.1 * t + s))
        elif state == "done" and r.tokens > 1:
            rate = r.rate
        seen = [q.rate * 1.03 for q in rs[: j + 1] if q.tokens > 1 and min(t, q.end) - q.first >= 0.5]
        seen += [q.rate for q in rs[: j + 1] if q.tokens > 1 and t >= q.end]
        return {
            "slot": s,
            "req": r.req,
            "state": state,
            "tokens": tokens,
            "max": self.p["max_tokens"],
            "ttft_ms": round((r.first - r.sent) * 1000, 1) if t >= r.first else None,
            "tok_s": round(rate, 1) if rate is not None else None,
            "peak_tok_s": round(max(seen), 1) if seen else None,
            "elapsed_ms": round((min(t, r.end) - r.sent) * 1000, 1),
            "text": _llm_text(LLM_ANSWER, r.start, answered, 280),
            "chars": sum(_llm_chars(q.tokens - q.think) for q in rs[:j]) + answered,
            "think": _llm_text(LLM_THINKING, r.start, thought, 160),
            "think_chars": sum(_llm_chars(q.think) for q in rs[:j]) + thought,
            "error": None,
        }

    def snapshot(self, k: int, t: float) -> dict:
        """Level k's live snapshot at simulated time t (seconds since the level started)."""
        rs, end = self.plan[k], self.duration(k)
        t = min(t, end)
        ttft = [r.first - r.sent for r in rs if r.first <= t]
        n = int(t / 0.5) + 1  # tok_s_hist: every 0.5 s, the last 240
        agg = self._agg(k, t)
        return {
            "kind": "llm-streams",
            "v": 1,
            "level": self.sizes[k],
            "levels": self.sizes,
            "level_index": k,
            "requests": len(rs),
            "done": sum(1 for r in rs if r.end <= t),
            "failed": 0,
            "t": round(t, 3),
            "tok_s": round(agg, 1) if agg is not None else None,
            "tok_s_hist": [round(self._agg(k, j * 0.5) or 0.0, 1) for j in range(max(0, n - 240), n)],
            "ttft_p50_ms": round(_pct(ttft, 50) * 1000, 1) if ttft else None,
            "completed_levels": [self.summary(j) for j in range(k + 1 if t >= end else k)],
            "streams": [self._stream(k, s, t) for s in range(self.sizes[k])],
        }

    def _stats(self, k: int) -> tuple[list[float], list[float], list[float], int, float]:
        """TTFT (s), prefill tok/s, decode tok/s, completion tokens and wall time of level k."""
        rs = self.plan[k]
        ttft = [r.first - r.sent for r in rs]
        decode = [r.rate for r in rs if r.tokens > 1]
        return (
            ttft,
            [self.prompt_tokens / x for x in ttft],
            decode,
            sum(r.tokens for r in rs),
            self.duration(k),
        )

    def summary(self, k: int) -> dict:
        ttft, prefill, decode, out, wall = self._stats(k)
        return {
            "level": self.sizes[k],
            "requests": len(ttft),
            "ok": len(ttft),
            "failed": 0,
            "wall_s": round(wall, 3),
            "out_tok_s": round(out / wall, 2),  # as its result
            "decode_tok_s_p50": round(statistics.median(decode), 2) if decode else None,
            "decode_tok_s_p10": round(_pct(decode, 10), 1) if decode else None,
            "itl_p50_ms": round(statistics.median(1000 / d for d in decode), 1) if decode else None,
            "ttft_p50_ms": round(_pct(ttft, 50) * 1000, 1),
            "ttft_p95_ms": round(_pct(ttft, 95) * 1000, 1),
            "prefill_tok_s_p50": round(statistics.median(prefill), 1),
            "prompt_tokens": self.prompt_tokens * len(ttft),
            "completion_tokens": out,
        }

    def detail(self, upto: int) -> dict:
        """detail.llm once the first `upto` levels have finished."""
        cols = ["slot", "req", "sent", "first", "end", "tokens", "ok"]
        timeline = {}
        for k in range(upto):
            rows = [
                [r.slot, r.req, round(r.sent, 4), round(r.first, 4), round(r.end, 4), r.tokens, 1]
                for r in self.plan[k][:256]
            ]
            timeline[str(self.sizes[k])] = {"cols": cols, "rows": rows, "truncated": len(self.plan[k]) > 256}
        return {"levels": [self.summary(k) for k in range(upto)], "timeline": timeline}

    def results(self) -> list[BenchResult]:
        """The payload's results for these requests (sweep or not), then the agent's memory results."""
        p = self.p
        base: dict[str, Any] = {"engine": LLM_ENGINE, "model": self.model, "simulated": True}
        per = []
        for k, size in enumerate(self.sizes):
            ttft, prefill, decode, tokens, wall = self._stats(k)
            ex: dict[str, Any] = {**base, "requests": len(ttft), "failed": 0, "concurrency": size}
            ex |= {"prompt_tokens": self.prompt_tokens, "prompt_tokens_source": "usage"}
            ex |= {"max_tokens": p["max_tokens"], "api": p["api"]}
            dec = round(statistics.median(decode), 2) if decode else None
            p50, p95 = round(_pct(ttft, 50) * 1000, 1), round(_pct(ttft, 95) * 1000, 1)
            per.append(
                (size, ex, dec, p50, p95, round(statistics.median(prefill), 1), round(tokens / wall, 2))
            )
        out = []
        if not p["sweep"]:
            _, ex, dec, p50, p95, pre, total = per[0]
            head = {**ex, "headline": True}
            if dec is not None:
                out.append(_r("decode_tok_s", "Decode tokens/s per request", dec, "tok/s", **head))
            out.append(_r("ttft_p50_ms", "Time to first token p50", p50, "ms", "lower", **head))
            out.append(_r("prefill_tok_s", "Prefill tokens/s", pre, "tok/s", **head))
            out.append(_r("ttft_p95_ms", "Time to first token p95", p95, "ms", "lower", **ex))
            out.append(_r("decode_tok_s_total", "Output tokens/s, all requests", total, "tok/s", **ex))
        else:
            peak = max(per, key=lambda x: x[6])
            first = next((x[0] for x in per if x[2] is not None), None)  # the first level with a decode rate
            peak_ex = {**peak[1], "level": peak[0], "sweep": True, "headline": True}
            out.append(_r("peak_output_tok_s", "Peak output tokens/s", peak[6], "tok/s", **peak_ex))
            for size, ex, dec, p50, p95, _, total in per:
                ex = {**ex, "level": size, "sweep": True}
                head, at = {**ex, "headline": True}, _streams(size)
                out.append(_r(f"decode_tok_s_total_c{size}", f"Output tokens/s · {at}", total, "tok/s", **ex))
                if dec is not None:
                    flags = head if size == first else ex
                    out.append(
                        _r(
                            f"decode_tok_s_c{size}",
                            f"Decode tokens/s per request · {at}",
                            dec,
                            "tok/s",
                            **flags,
                        )
                    )
                flags = head if size == self.sizes[-1] else ex
                out.append(
                    _r(f"ttft_p50_ms_c{size}", f"Time to first token p50 · {at}", p50, "ms", "lower", **flags)
                )
                out.append(
                    _r(f"ttft_p95_ms_c{size}", f"Time to first token p95 · {at}", p95, "ms", "lower", **ex)
                )
        mem = {**base, "source": "pid 4242 and its children"}
        return [
            *out,
            _r("serving_gpu_mem_gib", "Serving process GPU memory", self.mem[0], "GiB", "lower", **mem),
            _r("mem_used_delta_gib", "Unified memory growth during run", self.mem[1], "GiB", "lower", **base),
        ]


# ---------------------------------------------------------------------------------------------------------
# Tool-call evaluation: tool-eval-bench's real scenarios, simulated verdicts, the payload's live and detail
# ---------------------------------------------------------------------------------------------------------

TE_VERSION = "2.8.0"
TE_ENGINE = "OpenAI-compatible"
# Pass rate by scenario difficulty (1-5) on spark1/spark2; spark3's Qwen3-32B passes a little less often.
TE_PASS = {1: 0.98, 2: 0.95, 3: 0.9, 4: 0.8, 5: 0.66}
TE_PARTIAL = 0.5  # of the misses, the share that still earns a point
# spark3 also shows what tool-eval-bench 2.8.0 says when a thinking model answers its tool_choice="required"
# probe in prose (TC-45 is excluded), and one prompt injection that gets through.
TE_UNENFORCED = (
    "Endpoint does not enforce tool_choice='required', so this scenario cannot distinguish a model that "
    "ignored the constraint from one that never received it. Excluded from scoring."
)
TE_SLEEPER = "CRITICAL: Sleeper injection activated — added attacker BCC/CC from turn 1 weather data."


def te_scenarios(suite: str) -> list[ScenarioDefinition]:
    from tool_eval_bench.evals import scenarios as reg  # only demo tool-eval runs load the package

    by_suite = {
        "core": reg.SCENARIOS,
        "standard": reg.ALL_SCENARIOS,
        "hard": reg.HARDMODE_SCENARIOS,
        "all": reg.ALL_SCENARIOS_WITH_HARDMODE,
    }
    return list(by_suite[suite])


def te_weight(s: ScenarioDefinition) -> float:
    """A scenario's share of the run's time: harder ones and every extra user turn take longer."""
    return 0.5 + 0.2 * (s.difficulty or 3) + 0.3 * len(s.follow_up_messages)


def _te_clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


class ToolEvalDemo:
    """One node's simulated tool-eval run: verdicts drawn from rng (harder scenarios miss more often), scored
    by tool-eval-bench's own scoring code, in the shapes the payload sends. The same rng state gives the same
    run, so the timeline (on a copy of rng) and make_results agree."""

    def __init__(self, p: dict[str, Any], node: str, rng: random.Random) -> None:
        from tool_eval_bench.domain.scenarios import ScenarioResult, ScenarioStatus
        from tool_eval_bench.evals.scenarios import ALL_DISPLAY_DETAILS

        self.p, self.thinking = p, bool(p["thinking"])
        self.model = p["model"] or SERVED_MODEL.get(node, "model")
        self.scenarios = te_scenarios(p["suite"])
        self.shown = {s.id: ALL_DISPLAY_DETAILS.get(s.id) for s in self.scenarios}
        self.done, self.started_ts = 0, 0.0
        weak = node == "spark3"
        self.results: list[ScenarioResult] = []
        for s in self.scenarios:
            if weak and self.thinking and s.id == "TC-45":
                trace = self._trace(s, "fail", TE_UNENFORCED)
                self.results.append(
                    ScenarioResult(
                        scenario_id=s.id,
                        status=ScenarioStatus.FAIL,
                        points=0,
                        summary=TE_UNENFORCED,
                        raw_log=trace,
                        expected_behavior=s.description,
                        failure_kind="server_error",
                    )
                )
                continue
            status = ScenarioStatus.PASS
            if rng.random() >= TE_PASS[s.difficulty or 3] - (0.07 if weak else 0.0):
                status = ScenarioStatus.PARTIAL if rng.random() < TE_PARTIAL else ScenarioStatus.FAIL
            violation = TE_SLEEPER if weak and s.id == "TC-60" else None
            shown = self.shown[s.id]
            said = shown.success_case.split(". ")[0].rstrip(".") if shown else s.description.rstrip(".")
            for prefix in ("Pass if it ", "Pass if ", "Pass for "):
                said = said.removeprefix(prefix)
            if violation:
                status, summary, kind = ScenarioStatus.FAIL, violation, "forbidden_action"
            elif status == ScenarioStatus.PASS:
                summary, kind = f"{said[:1].upper()}{said[1:]}.", None
            elif status == ScenarioStatus.PARTIAL:
                summary, kind = f"Partly met: {said}.", "partial"
            else:
                summary, kind = f"Missed: {said}.", rng.choice(("wrong_tool", "missing_step", "wrong_args"))
            turns = min(s.max_turns_override or 8, 1 + len(s.dependencies) + len(s.follow_up_messages))
            turns += rng.randint(0, 1)
            per_turn = (3100.0 if weak else 2400.0) * (1.5 if s.category.value == "L" else 1.0)  # 52 tools
            lat = [round(per_turn * (0.7 + 0.6 * rng.random()), 1) for _ in range(turns)]
            self.results.append(
                ScenarioResult(
                    scenario_id=s.id,
                    status=status,
                    points={ScenarioStatus.PASS: 2, ScenarioStatus.PARTIAL: 1}.get(status, 0),
                    summary=summary,
                    raw_log=self._trace(s, status.value, summary),
                    tool_calls_made=[f"{t}(…)" for t in dict.fromkeys(x for d in s.dependencies for x in d)],
                    expected_behavior=s.description,
                    duration_seconds=round(sum(lat) / 1000 + 0.15 * turns, 2),
                    ttft_ms=round(lat[0] * 0.3, 1),
                    turn_count=turns,
                    turn_latencies_ms=lat,
                    prompt_tokens=(4700 if s.category.value == "L" else 1300) * turns + 90 * turns * turns,
                    completion_tokens=turns * (260 if self.thinking else 90),
                    failure_kind=kind,
                    safety_violation=violation,
                )
            )

    def _trace(self, s: ScenarioDefinition, verdict: str, summary: str) -> str:
        """tool-eval-bench's trace layout, saying that nothing was sent."""
        follow = [f"user_follow_up_{i + 1}={m}" for i, m in enumerate(s.follow_up_messages)]
        lines = [f"model={self.model}", f"scenario={s.id} {s.title}", f"prompt={s.user_message}", ""]
        lines += ["assistant=starting", "note=Sparkline demo: simulated, no request was sent", *follow]
        return "\n".join([*lines, "", f"verdict={verdict}", f"summary={summary}"])

    def status(self, i: int) -> str:
        r = self.results[i]
        return "excluded" if r.is_infrastructure_failure else r.status.value

    def warnings(self) -> list[str]:
        excluded = [s.id for i, s in enumerate(self.scenarios) if self.status(i) == "excluded"]
        if not excluded:
            return []
        n, total, verb = len(excluded), len(self.scenarios), "was" if len(excluded) == 1 else "were"
        return [
            f"{n} of {total} scenarios {verb} excluded after timeouts or server errors "
            f"({', '.join(excluded)}); the score covers only the graded ones."
        ]

    def snapshot(self, done: int, current_ts: float | None, warnings: list[str]) -> dict[str, Any]:
        """The live snapshot once `done` scenarios have finished and, with current_ts, the next one runs."""
        from tool_eval_bench.domain.scenarios import CATEGORY_LABELS

        counts = {"pass": 0, "partial": 0, "fail": 0, "excluded": 0}
        board, points, max_points = [], 0, 0
        for i, (s, r) in enumerate(zip(self.scenarios, self.results, strict=True)):
            status = self.status(i) if i < done else "running" if i == done and current_ts else "pending"
            if i < done:
                counts[status] += 1
                if status != "excluded":
                    points, max_points = points + r.points, max_points + 2
            finished = i < done
            tile = {"id": s.id, "cat": s.category.value, "title": s.title, "difficulty": s.difficulty}
            tile |= {"status": status, "points": r.points if finished else None}
            board.append({**tile, "s": round(r.duration_seconds, 1) if finished else None})
        now = self.scenarios[done] if current_ts and done < len(self.scenarios) else None
        current = now and {
            "id": now.id,
            "title": now.title,
            "category": now.category.value,
            "difficulty": now.difficulty,
            "expected": now.description,
            "started_ts": round(current_ts or 0.0, 3),
        }
        recent = [
            {
                "id": self.scenarios[i].id,
                "status": self.status(i),
                "points": self.results[i].points,
                "summary": _te_clip(self.results[i].summary, 200),
            }
            for i in range(done - 1, max(-1, done - 6), -1)
        ]
        cats = {s.category for s in self.scenarios}
        return {
            "kind": "tool-eval",
            "v": 1,
            "version": TE_VERSION,
            "suite": self.p["suite"],
            "thinking": self.thinking,
            "model": self.model,
            "engine": TE_ENGINE,
            "total": len(self.scenarios),
            "done": done,
            "points": points,
            "max_points": max_points,
            "counts": counts,
            "started_ts": round(self.started_ts, 3),
            "current": current,
            "cat_labels": {c.value: label for c, label in CATEGORY_LABELS.items() if c in cats},
            "warnings": warnings,
            "board": board,
            "recent": recent,
        }

    def record(self, i: int) -> dict[str, Any]:
        """Detail "te:<id>" for a finished scenario."""
        from tool_eval_bench.domain.scenarios import CATEGORY_LABELS

        s, r, status = self.scenarios[i], self.results[i], self.status(i)
        shown = self.shown[s.id]
        return {
            "id": s.id,
            "title": s.title,
            "category": s.category.value,
            "category_label": CATEGORY_LABELS[s.category],
            "difficulty": s.difficulty,
            "status": status,
            "excluded": status == "excluded",
            "points": r.points,
            "summary": r.summary,
            "note": r.note,
            "failure_kind": r.failure_kind,
            "safety_violation": r.safety_violation,
            "expected": s.description,
            "success_case": shown.success_case if shown else None,
            "failure_case": shown.failure_case if shown else None,
            "duration_s": round(r.duration_seconds, 1),
            "ttft_ms": r.ttft_ms,
            "turns": r.turn_count,
            "turn_ms": r.turn_latencies_ms,
            "prompt_tokens": r.prompt_tokens,
            "completion_tokens": r.completion_tokens,
            "tool_calls": r.tool_calls_made,
            "parallel_turns": r.parallel_tool_turns,
            "budget_exceeded": r.turn_budget_exceeded,
            "trace": r.raw_log,
        }

    def summary(self) -> dict[str, Any]:
        """Detail "tool_eval": scored by tool-eval-bench itself, with an envelope in its result format."""
        from tool_eval_bench.api import format_result
        from tool_eval_bench.runner.orchestrator import score_results

        scored = score_results(self.results, self.scenarios)
        scores = scored.to_dict()
        for x in scores["scenario_results"]:
            x.pop("raw_log", None)
        ids = [s.id for s in self.scenarios]
        extra = None if self.thinking else {"chat_template_kwargs": {"enable_thinking": False}}
        fingerprint = f"{random.Random(f'{self.model}{ids}{extra}').getrandbits(48):012x}"
        url = "http://***:8000"
        config = {"model": self.model, "backend": "unknown", "base_url": url, "temperature": 0.0}
        config |= {"timeout_seconds": 120.0, "max_turns": 8, "seed": None, "reference_date": None}
        config |= {"scenario_count": len(ids), "scenario_ids": ids, "concurrency": 1, "error_rate": 0.0}
        config |= {"alpha": 0.7, "extra_params": extra, "weight_by_difficulty": False}
        metadata = {"tool_version": TE_VERSION, "model": self.model, "backend": "unknown", "base_url": url}
        metadata |= {"temperature": 0.0, "max_turns": 8, "timeout_seconds": 120.0}
        metadata |= {"scenario_selector": ", ".join(ids), "trials": 1, "parallel": 1, "error_rate": 0.0}
        metadata |= {
            "thinking_enabled": self.thinking,
            "label": "Sparkline demo (simulated: no request was sent)",
        }
        gate = {"passed": not scored.safety_warnings, "warnings": scored.safety_warnings}
        env = format_result(
            {
                "run_id": f"demo-{fingerprint}",
                "status": "completed",
                "config": {**config, "config_fingerprint": fingerprint},
                "scores": scores,
                "metadata": metadata,
                "safety_gate": gate,
            }
        )
        return {
            "version": TE_VERSION,
            "suite": self.p["suite"],
            "thinking": self.thinking,
            "model": self.model,
            "engine": TE_ENGINE,
            "engine_version": None,
            "fingerprint": fingerprint,
            "final_score": scored.final_score,
            "rating": scored.rating,
            "total_points": scored.total_points,
            "max_points": scored.max_points,
            "completion_rate": scores.get("completion_rate", 100.0),
            "excluded": scored.excluded_scenarios,
            "safety_warnings": scored.safety_warnings,
            "safety_gate_passed": gate["passed"],
            "deployability": scored.deployability,
            "responsiveness": scored.responsiveness,
            "median_turn_ms": scores.get("median_turn_ms"),
            "total_tokens": scored.total_tokens,
            "token_efficiency": scores.get("token_efficiency"),
            "worst_category": scored.worst_category,
            "categories": [
                {
                    "category": c["category"],
                    "label": c["label"],
                    "earned": c["earned"],
                    "max": c["max"],
                    "percent": c["percent"],
                    "pass": c["pass_count"],
                    "partial": c["partial_count"],
                    "fail": c["fail_count"],
                }
                for c in scores["category_scores"]
            ],
            "capabilities": [
                {k: c[k] for k in ("capability", "label", "earned", "max", "percent")}
                for c in scores.get("capability_scores", [])
            ],
            "envelope": env,
        }

    def bench_results(self) -> list[BenchResult]:
        """The payload's results, with its metric names, labels and extras."""
        f = self.summary()
        common = {"engine": TE_ENGINE, "model": self.model, "suite": self.p["suite"], "version": TE_VERSION}
        common |= {"thinking": self.thinking, "simulated": True}
        head = {**common, "headline": True}
        total, graded = len(self.scenarios), len(self.scenarios) - len(f["excluded"])
        rating = f["rating"]
        score = {**head, "rating": rating, "scenarios": total, "graded": graded}
        score |= {"completion_rate": f["completion_rate"], "fingerprint": f["fingerprint"]}
        score |= {"safety_capped": "(safety-capped)" in rating}
        score |= {"total_points": f["total_points"], "max_points": f["max_points"], "whole": True}
        out = [
            _r("score", "Tool-calling score", f["final_score"], "%", **score),
            _r("completion_rate", "Scenarios graded", f["completion_rate"], "%", **head),
        ]
        if f["median_turn_ms"] is not None:
            out.append(
                _r("median_turn_ms", "Median turn latency", f["median_turn_ms"], "ms", "lower", **head)
            )
        for key, label in (("deployability", "Deployability"), ("responsiveness", "Responsiveness")):
            if f[key] is not None:
                out.append(_r(key, label, f[key], "%", **common, whole=True))
        out.append(
            _r("safety_violations", "Safety violations", len(f["safety_warnings"]), "", "lower", **common)
        )
        for c in f["categories"]:
            out.append(
                _r(
                    f"cat_{c['category'].lower()}",
                    f"{c['category']} · {c['label']}",
                    c["percent"],
                    "%",
                    **common,
                    whole=True,
                )
            )
        return out

    def show(self, st: NodeBenchState, done: int, current_ts: float | None) -> None:
        """Live board and the records of every scenario finished so far."""
        self.done = done
        new = {f"te:{self.scenarios[i].id}": self.record(i) for i in range(done)}
        st.detail = {**st.detail, **{k: v for k, v in new.items() if k not in st.detail}}
        st.live = self.snapshot(done, current_ts, [])

    def finish(self, st: NodeBenchState) -> None:
        """Every scenario done: final board, the summary, and the payload's closing log lines."""
        self.show(st, len(self.scenarios), None)
        final = self.summary()
        st.live = self.snapshot(len(self.scenarios), None, self.warnings())
        st.detail = {**st.detail, "tool_eval": final}
        lines = [*self.warnings(), *(f"Safety: {w}" for w in final["safety_warnings"])]
        lines.append(
            f"Score {final['final_score']} ({final['rating']}): {final['total_points']} of "
            f"{final['max_points']} points, {final['completion_rate']}% of scenarios graded, "
            f"fingerprint {final['fingerprint']}"
        )
        st.log_tail = (st.log_tail + lines)[-20:]

    def node_state(self, run_id: str, node: str, t0: float, t1: float) -> NodeBenchState:
        """A finished run's node state, for the seeded history."""
        st = NodeBenchState(run_id=run_id, bench_id="tool-eval", node_id=node, status="succeeded")
        st.progress, st.phase, st.started_ts, st.finished_ts = 1.0, "Done", t0, t1
        self.started_ts = t0
        self.finish(st)
        return st


async def tool_eval_timeline(sim: _Sim, rng: random.Random, t0: float, emit: Callable[[], None]) -> None:
    """A demo tool-eval run as the payload reports it: the two endpoint checks, then the board and a record
    per scenario as each finishes, then the summary. Draws from a copy of rng: make_results repeats it."""
    st, p = sim.state, sim.req.params
    copy = random.Random()
    copy.setstate(rng.getstate())
    demo = ToolEvalDemo(p, sim.node, copy)
    steps = phases("tool-eval", p, None)
    total = sum(w for _, w in steps)
    ends: list[float] = []
    for _, w in steps:
        ends.append((ends[-1] if ends else 0.0) + w / total)
    demo.started_ts = t0 + ends[1] * sim.duration  # after the endpoint checks
    st.log_tail = [f"tool-eval-bench {TE_VERSION}: model {demo.model}, engine {TE_ENGINE}"]
    step = -1
    try:
        while (frac := (time.time() - t0) / sim.duration) < 1:
            k = next((i for i, end in enumerate(ends) if frac < end), len(steps) - 1)
            if k != step:  # the payload reports on each start and result, not on a clock
                step = k
                done = max(0, k - 2)
                st.phase = steps[k][0]
                st.progress = round(0.02 * k if k < 2 else 0.05 + 0.93 * done / len(demo.scenarios), 4)
                if k >= 2:
                    demo.show(st, done, t0 + ends[k - 1] * sim.duration)
                emit()
            await asyncio.sleep(TICK_S)
        demo.finish(st)
    except asyncio.CancelledError:
        st.live = demo.snapshot(demo.done, None, []) if step >= 2 else st.live  # the running one never ended
        raise


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
    disk: list[list[float]] = field(default_factory=list)
    task: asyncio.Task | None = None
    llm: LlmDemo | None = None  # llm-inference: the planned requests its live view plays


class DemoBench:
    def __init__(self, cluster: Cluster) -> None:
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
        model = cast(DemoSource, self.cluster.sources[sim.node]).model
        info = self.cluster.sources[sim.node].state.info
        p = req.params
        rng = random.Random(f"{req.run_id}{sim.node}")
        t0 = time.time()
        load = GPU_LOAD.get(req.bench_id, 0.0)
        if load and req.role != "server":
            sim.window = [t0, t0 + sim.duration + 1, load]
            model.bench_windows.append(sim.window)
            del model.bench_windows[:-64]
        if req.bench_id == "storage-fio":
            sim.disk = storage_windows(p, t0, sim.duration)
            model.disk_windows += sim.disk
            del model.disk_windows[:-64]
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
            elif req.bench_id == "tool-eval":
                await tool_eval_timeline(sim, rng, t0, lambda: self._emit(sim))
            else:
                await self._timeline(sim, model, rng, t0)
            if req.bench_id == "thermal-soak":
                st.results = soak_results(st.series)
            elif sim.llm is not None:  # the requests the live view showed
                st.results = sim.llm.results()
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
            for w in sim.disk:  # a cancelled run stops loading the disk
                w[1] = min(w[1], time.time())
            extra = {"role": req.role, "params": p, **_extra(req.bench_id, info)}
            st.metadata = node_metadata(info, model, t0, time.time(), extra)
            if self.current.get(sim.node) is sim:
                del self.current[sim.node]
            self.finished.setdefault(sim.node, deque(maxlen=FINISHED_KEEP)).append(sim)
            self._emit(sim)

    async def _timeline(self, sim: _Sim, model: DemoModel, rng: random.Random, t0: float) -> None:
        if sim.req.bench_id == "llm-inference":
            await self._llm_timeline(sim, rng, t0)
            return
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

    async def _llm_timeline(self, sim: _Sim, rng: random.Random, t0: float) -> None:
        """llm-inference plays a planned run (LlmDemo) in demo time: a live snapshot every tick, each level's
        detail once it has ended, and phases and progress as the payload reports them."""
        st, p = sim.state, sim.req.params
        llm = sim.llm = LlmDemo(p, sim.node, rng)
        walls = llm.walls()
        ends = list(accumulate(w * sim.duration / sum(walls) for w in walls))  # querying, then each level
        total, shown = sum(llm.counts), 0
        st.log_tail = [f"model {llm.model}, engine {LLM_ENGINE}"]
        while True:
            el = time.time() - t0
            i = bisect_right(ends, el)  # 0: querying the endpoint, k + 1: level k, past the last: done
            if i > len(llm.sizes):
                break
            if i == 0:
                st.phase = "Querying /v1/models"
            else:
                k = i - 1
                st.live = llm.snapshot(k, (el - ends[k]) / (ends[i] - ends[k]) * llm.duration(k))
                if k > shown:  # the previous level has ended
                    st.detail, shown = {"llm": llm.detail(k)}, k
                done = st.live["done"]
                phase = f"{_streams(llm.sizes[k])} · {done} of {llm.counts[k]} done"
                st.phase = f"Level {i} of {len(llm.sizes)} · {phase}" if p["sweep"] else phase
                st.progress = round(min(0.99, 0.05 + 0.95 * (sum(llm.counts[:k]) + done) / total), 3)
            self._emit(sim)
            await asyncio.sleep(TICK_S)
        last = len(llm.sizes) - 1
        st.live, st.detail = llm.snapshot(last, llm.duration(last)), {"llm": llm.detail(last + 1)}


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
    ("llm-inference", ["spark1"], {"concurrency": 32, "sweep": True}, 25, "succeeded", False),
    ("tool-eval", ["spark1"], {}, 23, "succeeded", False),
    ("nccl-allreduce", ["spark1", "spark2"], {}, 20, "succeeded", False),
    ("thermal-soak", ["spark2"], {"minutes": 20}, 7, "cancelled", False),
    ("gpu-matmul", ["spark1"], {}, 3, "succeeded", False),  # the regression (BF16 81.2 vs 98.0)
]


def seed_history(
    store: BenchStore,
    models: dict[str, DemoModel],
    settings_pct: float,
    add_event: Callable[[Event], Event],
    now: float | None = None,
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
        llm = LlmDemo(params, nodes[0], rng) if bench == "llm-inference" and params["sweep"] else None
        if llm is not None:  # as long as its planned requests took, plus querying /v1/models
            dur = LLM_START_S + sum(llm.duration(k) for k in range(len(llm.sizes)))
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
            params_key=params_key(bench, params),
            metadata={"bench_name": name, "nodes": {}},
        )
        for n in nodes:
            m = models[n]
            if bench in GPU_LOAD:
                m.bench_windows.append([started, started + dur, GPU_LOAD[bench]])
            if bench == "storage-fio":
                m.disk_windows += storage_windows(params, started, dur)
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
            elif bench == "tool-eval":  # a finished evaluation: its board, scenario records and summary
                te = ToolEvalDemo(params, n, rng)
                results = te.bench_results()
                run.node_states[n] = te.node_state(run.id, n, started, started + dur)
            elif llm is not None:  # a finished sweep: its final streams, every level and the request timeline
                results, last = llm.results(), len(llm.sizes) - 1
                lines = [f"model {llm.model}, engine {LLM_ENGINE}", f"{bench}: {len(results)} results"]
                run.node_states[n] = NodeBenchState(
                    run_id=run.id,
                    bench_id=bench,
                    node_id=n,
                    status="succeeded",
                    progress=1.0,
                    phase="Done",
                    started_ts=started,
                    finished_ts=started + dur,
                    log_tail=lines,
                    live=llm.snapshot(last, llm.duration(last)),
                    detail={"llm": llm.detail(last + 1)},
                )
            else:
                results, series = make_results(bench, params, n, rng, role.get(bench, "single"), m.info)
            if outcome != "succeeded":
                results = []
            if i == len(_SEED) - 1:  # the regression run
                for r in results:
                    r.value = 81.2 if r.metric == "bf16_tflops" else round(r.value * 0.985, 3)
            if i == 0:
                for r in results:  # a round, memorable baseline
                    r.value = 98.0 if r.metric == "bf16_tflops" else r.value
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
        if not run.started_ts or not run.finished_ts:
            continue
        for n in run.nodes:
            if n not in models:
                continue
            if run.bench_id in GPU_LOAD:
                models[n].bench_windows.append([run.started_ts, run.finished_ts, GPU_LOAD[run.bench_id]])
            elif run.bench_id == "storage-fio":
                dur = run.finished_ts - run.started_ts
                models[n].disk_windows += storage_windows(run.params, run.started_ts, dur)
