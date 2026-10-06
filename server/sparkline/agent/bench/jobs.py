"""Per-benchmark job functions: build argv lists (never a shell), run them, turn output into BenchResults."""

from __future__ import annotations

import asyncio
import contextlib
import shutil
import statistics
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import psutil

from ...common.schema import Problem, Sample
from ...common.throttle import LIMITING_MASK, POWER_CAP_BIT, REASONS
from . import probes
from .parsers import parse_fio_json, parse_perftest_bw, parse_perftest_lat
from .runner import BenchError, Job, JobFn
from .specs import (
    CpuThroughputParams,
    GpuMatmulParams,
    LlmInferenceParams,
    MemBandwidthParams,
    NcclAllreduceParams,
    RdmaParams,
    StorageParams,
    ThermalSoakParams,
    nccl_sizes,
)

RDMA_DEFAULT_PORT = 18515
NCCL_DEFAULT_PORT = 29511
GIB = 2**30


def _cores(job: Job, kind: str) -> list[int]:
    return [c.id for c in job.info.cores if c.kind == kind]


def _core_model(job: Job, kind: str) -> str:
    return next((c.model for c in job.info.cores if c.kind == kind and c.model), kind)


def _csv(ids: list[int]) -> str:
    return ",".join(str(i) for i in ids)


# ---------------------------------------------------------------------------------------------------------
# Compute / memory / CPU
# ---------------------------------------------------------------------------------------------------------


async def gpu_matmul(job: Job, p: GpuMatmulParams) -> None:
    dev = job.runner.payload_device
    args = ["--dtypes", ",".join(p.dtypes), "--sizes", ",".join(p.sizes)]
    args += ["--iterations", str(p.iterations), "--warmup", str(p.warmup), "--fp8-scaling", p.fp8_scaling]
    args += ["--device", dev]
    job.progress(0.0, "Starting container")
    await job.run(job.docker_argv("gpu_matmul.py", args, gpus=dev == "cuda"))


async def mem_bandwidth(job: Job, p: MemBandwidthParams) -> None:
    dev = job.runner.payload_device
    args = ["--side", p.side, "--gpu-mib", str(p.gpu_array_mib), "--cpu-mib", str(p.cpu_array_mib)]
    args += ["--iterations", str(p.iterations), "--device", dev]
    all_cores = [c.id for c in job.info.cores]
    for flag, ids in (("--cores-all", all_cores), ("--cores-perf", _cores(job, "performance"))):
        if ids:
            args += [flag, _csv(ids)]
    if eff := _cores(job, "efficiency"):
        args += ["--cores-eff", _csv(eff)]
    job.progress(0.0, "Starting container")
    await job.run(job.docker_argv("mem_bw.py", args, gpus=dev == "cuda" and p.side != "cpu"))


async def cpu_throughput(job: Job, p: CpuThroughputParams) -> None:
    args = ["--seconds", str(p.seconds_per_test)]
    if perf := _cores(job, "performance"):
        args += ["--perf-cores", _csv(perf), "--perf-label", _core_model(job, "performance")]
    if eff := _cores(job, "efficiency"):
        args += ["--eff-cores", _csv(eff), "--eff-label", _core_model(job, "efficiency")]
    if job.info.cores:
        args += ["--all-cores", _csv([c.id for c in job.info.cores])]
    await job.run(job.host_argv("cpu_throughput.py", args))


# ---------------------------------------------------------------------------------------------------------
# Interconnect
# ---------------------------------------------------------------------------------------------------------


def _rail(job: Job, rail: str) -> tuple[Any, int]:
    netif = probes.rails(job.info).get(rail)
    gid = job.env.gids.get(rail)
    if netif is None or gid is None:
        raise BenchError(
            Problem(
                message=f"ConnectX-7 rail {rail} is not usable on {job.node_id}",
                cause="No RDMA device with a RoCE v2 IPv4 GID on that rail"
                if netif
                else "The rail is down or has no RDMA device",
                fix=f"Pick another rail or check `ibv_devinfo` and the cabling on {job.node_id}",
            )
        )
    return netif, gid


async def nccl_allreduce(job: Job, p: NcclAllreduceParams) -> None:
    req = job.req
    rails = ["A", "B"] if p.rails == "both" else [p.rails]
    usable = [(r, probes.rails(job.info).get(r)) for r in rails]
    usable = [(r, n) for r, n in usable if n is not None and job.env.gids.get(r) is not None]
    if not usable:
        _rail(job, rails[0])  # raises with a specific problem
    master = req.peer_ip or (usable[0][1].ipv4[0] if usable[0][1].ipv4 else None)
    if master is None:
        raise BenchError(
            Problem(
                message="No rendezvous address for NCCL",
                cause="peer_ip was not sent and rail A has no IPv4 address",
                fix="Start the run from the Sparkline console",
            )
        )
    env = {
        "NCCL_SOCKET_IFNAME": ",".join(n.name for _, n in usable),
        "NCCL_IB_HCA": ",".join(n.rdma_device or "" for _, n in usable),
        # NCCL_IB_GID_INDEX applies to every HCA, but the RoCE v2 IPv4 GID index can differ per rail (spark2:
        # A=4, B=3). Without it, NCCL picks each device's GID by address family and RoCE version.
        "NCCL_IB_ROCE_VERSION_NUM": "2",
        "NCCL_IB_ADDR_FAMILY": "AF_INET",
    }
    gids = {job.env.gids[r] for r, _ in usable}
    if len(gids) == 1:
        env["NCCL_IB_GID_INDEX"] = str(gids.pop())
    args = ["--rank", str(req.rank), "--world-size", str(req.world_size), "--master", master]
    args += [
        "--port",
        str(req.peer_port or NCCL_DEFAULT_PORT),
        "--max-bytes",
        str(nccl_sizes(p.max_size_mib)[-1]),
    ]
    args += ["--iterations", str(p.iterations), "--warmup", str(p.warmup)]
    job.expect_results = req.rank == 0  # both ranks measure the same collective; rank 0 reports it
    job.progress(0.0, "Starting container")
    await job.run(job.docker_argv("nccl_allreduce.py", args, infiniband=True, env=env))


def _connect_failed(lines: list[str]) -> bool:
    text = "\n".join(lines[-20:])
    return "Couldn't connect" in text or "Unable to init the socket connection" in text


async def rdma_bw_lat(job: Job, p: RdmaParams) -> None:
    netif, gid = _rail(job, p.rail)
    req = job.req
    port = req.peer_port or RDMA_DEFAULT_PORT
    tests = [t for t in ("bw", "lat") if t in p.tests]
    job.expect_results = req.role == "client"
    for i, t in enumerate(tests):
        exe = "ib_write_bw" if t == "bw" else "ib_write_lat"
        argv = [exe, "-d", netif.rdma_device, "-x", str(gid), "-F", "-p", str(port)]
        if t == "bw":
            argv += ["--report_gbits", "-D", str(p.duration_s), "-s", p.msg_size]
        else:
            argv += ["-n", str(p.lat_iterations)]
        if req.role == "server":
            job.progress(i / len(tests), f"{exe}: waiting for the client")
            _, lines = await job.run(argv, ready_port=port)
        else:
            assert req.peer_ip is not None
            job.progress(i / len(tests), f"{exe} to {req.peer_ip}")
            deadline = time.monotonic() + 30
            while True:  # the server may not be listening yet (its previous test is still finishing)
                rc, lines = await job.run([*argv, req.peer_ip], check=False)
                if rc == 0 or not _connect_failed(lines) or time.monotonic() > deadline:
                    break
                await asyncio.sleep(0.5)
            if rc != 0:
                raise BenchError(job._exit_problem(argv, rc, lines))
        if req.role != "client":
            continue
        text = "\n".join(lines)
        extras = {"rail": p.rail, "device": netif.rdma_device, "gid_index": gid, "peer": req.peer_node}
        if t == "bw":
            bw = parse_perftest_bw(text)
            if bw is None:
                raise BenchError(_unparsed(job, exe))
            bw.pop("peak", None)  # -D (duration) mode does not measure a peak: perftest prints 0.00
            job.add_result(
                metric="rdma_write_bw",
                label=f"RDMA write bandwidth (rail {p.rail})",
                value=bw["average"],
                unit="Gb/s",
                extras={**extras, **bw, "msg_size": int(p.msg_size), "duration_s": p.duration_s},
            )
        else:
            lat = parse_perftest_lat(text)
            if lat is None:
                raise BenchError(_unparsed(job, exe))
            job.add_result(
                metric="rdma_write_lat",
                label=f"RDMA write latency (rail {p.rail})",
                value=lat.get("typical", lat.get("avg", 0.0)),
                unit="us",
                better="lower",
                extras={**extras, **lat},
            )
            if "p99" in lat:
                job.add_result(
                    metric="rdma_write_lat_p99",
                    label=f"RDMA write latency p99 (rail {p.rail})",
                    value=lat["p99"],
                    unit="us",
                    better="lower",
                    extras=extras,
                )


def _unparsed(job: Job, exe: str) -> Problem:
    return Problem(
        message=f"Could not read the {exe} output on {job.node_id}",
        cause="The results table was not found in the output",
        fix="See the log tail; the perftest version may print a different format",
    )


# ---------------------------------------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------------------------------------

_PROFILE_LABEL = {
    "seq_write": "Sequential write 1 MiB",
    "seq_read": "Sequential read 1 MiB",
    "rand_read": "Random read 4 KiB",
    "rand_write": "Random write 4 KiB",
}


def fio_argv(fio: str, path: str, p: StorageParams) -> list[str]:
    runtime = f"{int(p.runtime_s * 1000)}ms"
    argv = [fio, "--output-format=json", f"--filename={path}", f"--size={p.size_mib}M", "--direct=1"]
    argv += ["--ioengine=libaio", "--group_reporting", "--unlink=0"]
    jobs = {
        "seq_write": ["--rw=write", "--bs=1M", "--iodepth=16", "--end_fsync=1"],
        "seq_read": ["--rw=read", "--bs=1M", "--iodepth=16", f"--runtime={runtime}", "--time_based"],
        "rand_read": ["--rw=randread", "--bs=4k", "--iodepth=32", f"--numjobs={p.threads}"]
        + [f"--runtime={runtime}", "--time_based"],
        "rand_write": ["--rw=randwrite", "--bs=4k", "--iodepth=32", f"--numjobs={p.threads}"]
        + [f"--runtime={runtime}", "--time_based", "--end_fsync=1"],
    }
    for name in ("seq_write", "seq_read", "rand_read", "rand_write"):
        if name in p.profiles:
            argv += [f"--name={name}", "--stonewall", *jobs[name]]
    return argv


async def storage(job: Job, p: StorageParams) -> None:
    job.make_dir()
    path = str(job.dir / "sparkline-io.test")
    free = shutil.disk_usage(job.dir).free
    need = p.size_mib * 2**20
    if free < need * 1.1 + GIB:
        raise BenchError(
            Problem(
                message=f"Not enough free space for a {p.size_mib} MiB test file on {job.node_id}",
                cause=f"{free / GIB:.1f} GiB free in {job.runner.work_dir}",
                fix="Choose a smaller file size or free up space",
            )
        )
    if job.env.fio:
        job.progress(0.0, "fio")
        _, lines = await job.run(fio_argv(job.env.fio, path, p))
        try:
            rows = parse_fio_json("\n".join(lines))
        except ValueError as e:
            raise BenchError(
                Problem(message="Could not read fio's JSON output", cause=str(e), fix="See the log tail")
            ) from None
        for r in rows:
            if r["name"] not in _PROFILE_LABEL:
                continue
            extras = {"method": "fio", "size_mib": p.size_mib, "threads": p.threads}
            _storage_results(job, r["name"], r["mb_s"], r["iops"], r["p99_us"], extras)
        return
    args = ["--file", path, "--size-mib", str(p.size_mib), "--runtime", str(p.runtime_s)]
    args += ["--threads", str(p.threads), "--profiles", ",".join(p.profiles)]
    await job.run(job.host_argv("builtin_io.py", args))


def _storage_results(
    job: Job, name: str, mb_s: float, iops: float, p99_us: float | None, extras: dict
) -> None:
    label = _PROFILE_LABEL[name]
    job.add_result(metric=f"{name}_mbps", label=label, value=mb_s, unit="MB/s", extras=extras)
    if name.startswith("rand"):
        job.add_result(metric=f"{name}_iops", label=f"{label} IOPS", value=iops, unit="IOPS", extras=extras)
    if p99_us is not None:
        job.add_result(
            metric=f"{name}_p99_us",
            label=f"{label} p99 latency",
            value=p99_us,
            unit="us",
            better="lower",
            extras=extras,
        )


# ---------------------------------------------------------------------------------------------------------
# Telemetry-assisted benches (LLM inference memory, thermal soak)
# ---------------------------------------------------------------------------------------------------------


async def _every_sample(job: Job, fn: Callable[[Sample], None], stop: asyncio.Event) -> None:
    """Call fn once per new agent sample until stop is set."""
    last = None
    while not stop.is_set():
        s = job.runner.latest()
        if s is not None and s.ts != last:
            last = s.ts
            fn(s)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), 0.25)


async def _with_sampling(job: Job, coro, fn: Callable[[Sample], None]) -> Any:
    stop = asyncio.Event()
    task = asyncio.create_task(_every_sample(job, fn, stop))
    try:
        return await coro
    finally:
        stop.set()
        await task


def serving_gpu_mem(port: int, latest: Sample | None, model: str | None = None) -> tuple[int | None, str]:
    """GPU memory of the process tree listening on ``port``, else (None, reason).

    A server run by root or in a container hides its listening socket's pid from the agent's user, but NVML
    still lists its GPU compute processes: then the footprint is theirs (those whose detected model matches
    ``model`` when any do), and the returned source says how it was attributed."""
    pid = None
    try:
        for c in psutil.net_connections(kind="tcp"):
            if c.status == psutil.CONN_LISTEN and c.laddr and c.laddr.port == port and c.pid:
                pid = c.pid
                break
    except (psutil.Error, OSError):
        pass
    procs = (latest.procs if latest else None) or []
    if pid is None:
        gpu = [pr for pr in procs if pr.gpu_mem]
        m = (model or "").lower()
        named = [pr for pr in gpu if m and pr.model and (pr.model.lower() in m or m in pr.model.lower())]
        pick = named or gpu
        if not pick:
            return None, (
                f"the process listening on port {port} is hidden from the agent's user and no GPU compute "
                "process reports memory"
            )
        names = ", ".join(sorted({pr.name for pr in pick}))
        how = "with that model" if named else "on this node"
        return sum(pr.gpu_mem or 0 for pr in pick), (
            f"GPU compute processes {how} ({names}); the serving process's pid is hidden from the agent"
        )
    try:
        tree = {pid, *(c.pid for c in psutil.Process(pid).children(recursive=True))}
    except psutil.Error:
        tree = {pid}
    mem = [pr.gpu_mem for pr in procs if pr.pid in tree and pr.gpu_mem]
    if not mem:
        return None, f"no GPU memory reported for the process tree of pid {pid}"
    return sum(mem), f"pid {pid} and its children"


async def llm_inference(job: Job, p: LlmInferenceParams) -> None:
    before = job.runner.latest()
    peak = {"used": 0, "gpu": 0}

    def track(s: Sample) -> None:
        peak["used"] = max(peak["used"], s.mem.used)
        peak["gpu"] = max(peak["gpu"], s.mem.gpu or 0)

    args = ["--base-url", p.base_url, "--api", p.api, "--prompt-tokens", str(p.prompt_tokens)]
    args += [
        "--max-tokens",
        str(p.max_tokens),
        "--concurrency",
        str(p.concurrency),
        "--requests",
        str(p.requests),
    ]
    if p.model:
        args += ["--model", p.model]
    await _with_sampling(job, job.run(job.host_argv("llm_inference.py", args)), track)
    if not job.state.results:
        return
    extras = dict(job.state.results[0].extras)
    labels = {k: extras.get(k) for k in ("engine", "model")}  # in extras: result labels stay short
    parts = urlsplit(p.base_url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    serving, how = (None, "endpoint is on another host")
    if parts.hostname in ("127.0.0.1", "localhost") or parts.hostname in _local_ips():
        serving, how = await asyncio.to_thread(serving_gpu_mem, port, job.runner.latest(), labels["model"])
    if serving is None:
        job.log(f"No memory footprint attributed to the serving process: {how}")
    if serving is not None:
        job.add_result(
            metric="serving_gpu_mem_gib",
            label="Serving process GPU memory",
            value=serving / GIB,
            unit="GiB",
            better="lower",
            extras={**labels, "source": how},
        )
    if before is not None and peak["used"]:
        job.add_result(
            metric="mem_used_delta_gib",
            label="Unified memory growth during run",
            value=(peak["used"] - before.mem.used) / GIB,
            unit="GiB",
            better="lower",
            extras={
                **labels,
                "mem_used_before_gib": before.mem.used / GIB,
                "mem_used_peak_gib": peak["used"] / GIB,
                "gpu_alloc_before_gib": (before.mem.gpu or 0) / GIB,
                "gpu_alloc_peak_gib": peak["gpu"] / GIB,
                "serving_gpu_mem_note": None if serving is not None else how,
            },
        )


def _local_ips() -> set[str]:
    return {a.address for addrs in psutil.net_if_addrs().values() for a in addrs}


SOAK_KEYS = ("gpu0.sm_mhz", "gpu0.temp_c", "gpu0.power_w", "gpu0.throttle_mask", "gpu0.util")


async def thermal_soak(job: Job, p: ThermalSoakParams) -> None:
    t0 = time.time()

    def record(s: Sample) -> None:
        tflops = job.gauges.get("tflops")
        if not s.gpu or tflops is None:  # nothing before the load starts (container start-up is not soak)
            return
        g = s.gpu[0]
        vals = (g.sm_mhz, g.temp_c, g.power_w, g.throttle_mask, g.util)
        if any(v is None for v in vals):
            return
        point = {"t": round(s.ts - t0, 2), **dict(zip(SOAK_KEYS, vals, strict=True)), "tflops": tflops}
        job.append_series({k: [float(v)] for k, v in point.items()})

    dev = job.runner.payload_device
    args = ["--seconds", str(p.minutes * 60), "--size", p.size, "--device", dev]
    job.progress(0.0, "Starting container")
    await _with_sampling(job, job.run(job.docker_argv("thermal_soak.py", args, gpus=dev == "cuda")), record)
    soak_results(job, {k: job.state.series.get(k, []) for k in SOAK_KEYS})


def soak_results(job: Job, s: dict[str, list[float]]) -> None:
    clk, temp, mask = s["gpu0.sm_mhz"], s["gpu0.temp_c"], s["gpu0.throttle_mask"]
    if len(clk) < 2:
        job.log("too few telemetry samples to summarise clocks")
        return
    mean = statistics.fmean(clk)
    cv = statistics.pstdev(clk) / mean * 100 if mean else 0.0
    n = len(mask)
    by_reason = {}
    for bit, (code, title, _sev, _ex) in REASONS.items():
        if bit == 0x1:  # idle is not throttling
            continue
        share = sum(1 for m in mask if int(m) & bit) / n * 100
        if share:
            by_reason[code] = {"title": title, "pct": round(share, 2)}
    throttled = sum(1 for m in mask if int(m) & LIMITING_MASK) / n * 100
    capped = sum(1 for m in mask if int(m) & POWER_CAP_BIT) / n * 100
    ex = {"samples": n}
    job.add_result(metric="sm_mhz_mean", label="Mean SM clock", value=mean, unit="MHz", extras=ex)
    job.add_result(metric="sm_mhz_min", label="Lowest SM clock", value=min(clk), unit="MHz", extras=ex)
    job.add_result(
        metric="sm_clock_cv_pct",
        label="Clock variation (CV)",
        value=cv,
        unit="%",
        better="lower",
        extras={**ex, "stdev_mhz": statistics.pstdev(clk)},
    )
    job.add_result(
        metric="temp_max_c",
        label="Peak GPU temperature",
        value=max(temp),
        unit="°C",
        better="lower",
        extras=ex,
    )
    job.add_result(
        metric="throttled_pct",
        label="Time throttled (thermal or hardware)",
        value=throttled,
        unit="%",
        better="lower",
        extras={
            **ex,
            "by_reason": by_reason,
            "reasons": "sw_thermal, hw_slowdown, hw_thermal, hw_power_brake",
        },
    )
    job.add_result(
        metric="power_capped_pct",
        label="Time at the power cap",
        value=capped,
        unit="%",
        better="lower",
        extras=ex,
    )


JOBS: dict[str, JobFn] = {
    "gpu-matmul": gpu_matmul,
    "mem-bandwidth": mem_bandwidth,
    "cpu-throughput": cpu_throughput,
    "nccl-allreduce": nccl_allreduce,
    "rdma-bw-lat": rdma_bw_lat,
    "storage-fio": storage,
    "llm-inference": llm_inference,
    "thermal-soak": thermal_soak,
}
