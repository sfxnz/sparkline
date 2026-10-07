"""NCCL all-reduce bandwidth sweep with torch.distributed, one rank per node (PyTorch container).

Used because nccl-tests (all_reduce_perf) is not installed and needs an MPI launcher across nodes. Reports
the same quantities as nccl-tests: algbw = bytes / time and busbw = algbw x 2(n-1)/n, in GB/s (1e9 B/s).
Sizes double from 8 B to --max-bytes (float32 elements, sum).
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import os
import re

import torch
import torch.distributed as dist
from benchlib import emit, fail, log, on_sigterm, progress, result

METHOD = "torch.distributed (nccl-tests not installed)"
NCCL_LOG = "/tmp/sparkline-nccl-debug.txt"  # inside the container (removed with it)


def nccl_transport(text: str) -> dict:
    """What NCCL's INFO log says it used: network ("IB" for RDMA/RoCE, "Socket" for TCP), the devices the
    channels run over, and whether GPU Direct RDMA was on."""
    out: dict = {"network": None, "devices": [], "gdr": None}
    if m := re.findall(r"Using network (\w+)", text):
        out["network"] = m[-1]
    names: dict[str, str] = {}
    for line in re.findall(r"NET/(?:IB|Socket) : Using (.*)", text):
        names = dict(re.findall(r"\[(\d+)\]([^\s:\[]+)", line)) or names
    used = sorted(set(re.findall(r"via NET/\w+/(\d+)", text)), key=int)
    out["devices"] = [names.get(i, f"#{i}") for i in used]
    gdr = re.findall(r"NET/IB : GPU Direct RDMA (Enabled|Disabled)", text)
    if gdr:
        out["gdr"] = "Enabled" in gdr
    return out


def transport_summary(t: dict) -> str:
    if t["network"] is None:
        return "NCCL did not report its network transport"
    kind = {"IB": "RDMA (NET/IB)", "Socket": "TCP sockets (NET/Socket)"}.get(t["network"], t["network"])
    via = f" over {', '.join(t['devices'])}" if t["devices"] else ""
    gdr = {True: ", GPU Direct RDMA on", False: ", GPU Direct RDMA off", None: ""}[t["gdr"]]
    note = " - not RDMA: check NCCL_IB_HCA and `ibv_devinfo`" if t["network"] == "Socket" else ""
    return f"NCCL transport: {kind}{via}{gdr}{note}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--rank", type=int, required=True)
    ap.add_argument("--world-size", type=int, required=True)
    ap.add_argument("--master", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--max-bytes", type=int, default=2**30)
    ap.add_argument("--iterations", type=int, default=20)
    ap.add_argument("--warmup", type=int, default=5)
    a = ap.parse_args()
    on_sigterm()
    if not torch.cuda.is_available():
        fail(
            "CUDA is not available in the benchmark container",
            "torch.cuda.is_available() is False",
            "Check that Docker passes the GPU: docker run --rm --gpus all <image> nvidia-smi",
        )
    n = a.world_size
    progress(0.0, f"Waiting for {n} ranks at {a.master}:{a.port}")
    log(f"rank {a.rank}/{n}, NCCL_IB_HCA={os.environ.get('NCCL_IB_HCA')}, torch {torch.__version__}")
    # NCCL reads these at init; the INFO log goes to a file so it does not flood the log tail.
    os.environ.update(NCCL_DEBUG="INFO", NCCL_DEBUG_SUBSYS="INIT,NET", NCCL_DEBUG_FILE=NCCL_LOG)
    torch.cuda.set_device(0)
    dist.init_process_group(
        "nccl",
        init_method=f"tcp://{a.master}:{a.port}",
        rank=a.rank,
        world_size=n,
        timeout=datetime.timedelta(seconds=120),
        device_id=torch.device("cuda", 0),
    )
    emit(ready=True)
    sizes = []
    s = 8
    while s <= a.max_bytes:
        sizes.append(s)
        s *= 2
    buf = torch.ones(a.max_bytes // 4, dtype=torch.float32, device="cuda")
    rows = []
    try:
        for i, size in enumerate(sizes):
            progress(i / len(sizes), f"all-reduce {size} B")
            x = buf[: max(1, size // 4)]
            for _ in range(a.warmup):
                dist.all_reduce(x)
            torch.cuda.synchronize()
            dist.barrier()
            # The ranks leave the barrier up to a few hundred us apart, and rank 0's first timed all-reduce
            # would wait for rank 1 inside the timing (8 B read 16-48 us instead of 12-14 us on GB10). One
            # untimed all-reduce queued before the start event makes it fire only once both ranks are in.
            dist.all_reduce(x)
            start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            start.record()
            for _ in range(a.iterations):
                dist.all_reduce(x)
            end.record()
            end.synchronize()
            t = start.elapsed_time(end) / 1000 / a.iterations
            nbytes = x.numel() * 4
            algbw = nbytes / t / 1e9
            rows.append((nbytes, t * 1e6, algbw, algbw * 2 * (n - 1) / n))
    finally:
        dist.destroy_process_group()
    transport = nccl_transport("")
    with contextlib.suppress(OSError), open(NCCL_LOG, errors="replace") as f:
        transport = nccl_transport(f.read())
    log(transport_summary(transport))
    if a.rank == 0:
        emit(
            series={
                "size_bytes": [r[0] for r in rows],
                "time_us": [round(r[1], 2) for r in rows],
                "algbw_gbps": [round(r[2], 3) for r in rows],
                "busbw_gbps": [round(r[3], 3) for r in rows],
            }
        )
        peak = max(rows, key=lambda r: r[3])
        result(
            "allreduce_busbw_peak",
            "All-reduce peak bus bandwidth",
            round(peak[3], 3),
            "GB/s",
            method=METHOD,
            peak_size_bytes=peak[0],
            world_size=n,
            iterations=a.iterations,
            nccl_ib_hca=os.environ.get("NCCL_IB_HCA"),
            nccl_version=".".join(str(v) for v in torch.cuda.nccl.version()),
            nccl_transport=transport["network"],
            nccl_net_devices=transport["devices"],
            gpu_direct_rdma=transport["gdr"],
        )
        big = rows[-1]
        result(
            "allreduce_algbw_max_size",
            f"All-reduce algorithm bandwidth at {big[0] // 2**20} MiB",
            round(big[2], 3),
            "GB/s",
            method=METHOD,
            size_bytes=big[0],
        )
        small = rows[0]
        result(
            "allreduce_latency_small",
            f"All-reduce time at {small[0]} B",
            round(small[1], 2),
            "us",
            better="lower",
            method=METHOD,
        )
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
