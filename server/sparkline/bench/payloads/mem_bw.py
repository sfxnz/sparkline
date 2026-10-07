"""Unified-memory bandwidth from the GPU and from the CPU (STREAM-style copy and triad, best of N).

GPU: CUDA copy (b = a) and triad (a = b + s*c) on device tensors, timed with CUDA events.
CPU: one thread per core, each pinned with sched_setaffinity and working on its own first-touched arrays
(torch CPU ops, single-threaded, GIL released); run for all cores, performance cores and efficiency cores.
Bytes counted as read + written: copy 2 x N, triad 3 x N. Runs inside the PyTorch container.
"""

from __future__ import annotations

import argparse
import os
import threading
import time

import torch
from benchlib import int_list, log, on_sigterm, progress, result

SCALAR = 3.0


def gpu_side(mib: int, iters: int) -> dict[str, float]:
    n = mib * 2**20 // 4
    a = torch.ones(n, device="cuda")
    b = torch.full((n,), 2.0, device="cuda")
    c = torch.full((n,), 0.5, device="cuda")
    ops = {"copy": (lambda: b.copy_(a), 2), "triad": (lambda: torch.add(b, c, alpha=SCALAR, out=a), 3)}
    out = {}
    for name, (fn, k) in ops.items():
        fn()
        torch.cuda.synchronize()
        best = float("inf")
        for _ in range(iters):
            s, e = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            s.record()
            fn()
            e.record()
            e.synchronize()
            best = min(best, s.elapsed_time(e) / 1000)
        out[name] = k * n * 4 / best / 1e9
    return out


def cpu_side(cores: list[int], mib: int, iters: int) -> dict[str, float]:
    torch.set_num_threads(1)
    per = max(1024, mib * 2**20 // 4 // len(cores))
    start = threading.Barrier(len(cores) + 1)
    end = threading.Barrier(len(cores) + 1)
    state = {"op": ""}
    errors: list[str] = []

    def worker(core: int) -> None:
        try:
            os.sched_setaffinity(0, {core})  # 0 = the calling thread
            a = torch.ones(per)
            b = torch.full((per,), 2.0)
            c = torch.full((per,), 0.5)
        except Exception as e:  # report, but keep the barriers consistent
            errors.append(f"core {core}: {e}")
            a = b = c = None
        while True:
            start.wait()
            op = state["op"]
            if op == "stop":
                return
            if a is not None:
                if op == "copy":
                    b.copy_(a)
                else:
                    torch.add(b, c, alpha=SCALAR, out=a)
            end.wait()

    threads = [threading.Thread(target=worker, args=(core,), daemon=True) for core in cores]
    for t in threads:
        t.start()
    out = {}
    for op, k in (("copy", 2), ("triad", 3)):
        best = float("inf")
        for i in range(iters + 1):  # first pass is a warm-up (page faults)
            state["op"] = op
            # Clock starts before the release: once released, workers race this thread for the GIL and can be
            # well into the pass before a post-release t0 (measured +30 % at 20 threads on GB10).
            t0 = time.perf_counter()
            start.wait()
            end.wait()
            if i:
                best = min(best, time.perf_counter() - t0)
        out[op] = k * per * 4 * len(cores) / best / 1e9
    state["op"] = "stop"
    start.wait()
    for t in threads:
        t.join()
    if errors:
        raise RuntimeError("; ".join(errors))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--side", choices=["both", "gpu", "cpu"], default="both")
    ap.add_argument("--gpu-mib", type=int, default=1024)
    ap.add_argument("--cpu-mib", type=int, default=1024)
    ap.add_argument("--iterations", type=int, default=20)
    ap.add_argument("--cores-all")
    ap.add_argument("--cores-perf")
    ap.add_argument("--cores-eff")
    ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    a = ap.parse_args()
    on_sigterm()
    smoke = a.device == "cpu"
    iters = 2 if smoke else a.iterations
    cpu_mib = 16 if smoke else a.cpu_mib
    common = {"smoke": smoke, "torch": torch.__version__}
    sets = [("all", "all cores", int_list(a.cores_all) or sorted(os.sched_getaffinity(0)))]
    if a.cores_perf:
        sets.append(("perf", "performance cores", int_list(a.cores_perf)))
    if a.cores_eff:
        sets.append(("eff", "efficiency cores", int_list(a.cores_eff)))
    steps = (a.side in ("both", "gpu")) + (len(sets) if a.side in ("both", "cpu") else 0)
    done = 0
    if a.side in ("both", "gpu"):
        if smoke:
            log("GPU side skipped: CPU smoke run")
        else:
            progress(0.0, f"GPU copy/triad, 3 x {a.gpu_mib} MiB")
            g = gpu_side(a.gpu_mib, iters)
            torch.cuda.empty_cache()
            ex = {
                "array_mib": a.gpu_mib,
                "iterations": iters,
                "device": torch.cuda.get_device_name(0),
                **common,
            }
            result("gpu_copy_gbps", "GPU copy", round(g["copy"], 2), "GB/s", **ex)
            result("gpu_triad_gbps", "GPU triad", round(g["triad"], 2), "GB/s", **ex)
        done += 1
    if a.side in ("both", "cpu"):
        for key, label, cores in sets:
            progress(done / steps, f"CPU copy/triad, {label} ({len(cores)})")
            r = cpu_side(cores, cpu_mib, iters)
            ex = {"cores": cores, "threads": len(cores), "array_mib": cpu_mib, "iterations": iters, **common}
            result(f"cpu_{key}_copy_gbps", f"CPU copy, {label}", round(r["copy"], 2), "GB/s", **ex)
            result(f"cpu_{key}_triad_gbps", f"CPU triad, {label}", round(r["triad"], 2), "GB/s", **ex)
            done += 1
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
