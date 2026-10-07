"""CPU throughput by core type (host Python, no container).

Workload: SHA-256 plus zlib level-1 compression over a fixed 64 KiB buffer (both C implementations), one
process per core pinned with os.sched_setaffinity. Throughput = buffer bytes processed per second (MB/s).
Tests: one performance core, one efficiency core, all performance cores, all efficiency cores, all cores.

glibc heap trimming is turned off first. Otherwise every zlib.compress call frees its ~270 KB deflate state at
the top of the heap, glibc hands it back to the kernel, and the next call page-faults it in again: about 43
faults per call, 15-20 % of the run in the kernel, varying with how fragmented the node's memory is.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import hashlib
import multiprocessing as mp
import os
import random
import time
import zlib

from benchlib import int_list, on_sigterm, progress, result

_rng = random.Random(1234)
_TEXT = b"The quick brown fox jumps over the lazy dog while the GPU hums along. " * 512
BUF = (_rng.randbytes(32 * 1024) + _TEXT)[: 64 * 1024]
WORKLOAD = "sha256 + zlib level 1 over a fixed 64 KiB buffer"
M_TRIM_THRESHOLD = -1  # glibc mallopt() parameter


def keep_heap() -> bool:
    """Stop glibc from returning freed heap memory to the kernel (inherited by forked workers)."""
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"))
        return bool(libc.mallopt(M_TRIM_THRESHOLD, 1 << 30))
    except (OSError, AttributeError):  # not glibc: no mallopt
        return False


def _work(core: int, seconds: float, go, q) -> None:
    on_sigterm()
    os.sched_setaffinity(0, {core})
    go.wait()
    n, t0 = 0, time.perf_counter()
    deadline = t0 + seconds
    while True:
        hashlib.sha256(BUF).digest()
        zlib.compress(BUF, 1)
        n += 1
        if n % 4 == 0 and time.perf_counter() >= deadline:
            break
    q.put((core, n * len(BUF) / (time.perf_counter() - t0) / 1e6))


def run_set(cores: list[int], seconds: float) -> dict[int, float]:
    """MB/s per core while all ``cores`` run at once."""
    ctx = mp.get_context("fork")
    go, q = ctx.Event(), ctx.Queue()
    procs = [ctx.Process(target=_work, args=(c, seconds, go, q), daemon=True) for c in cores]
    for p in procs:
        p.start()
    time.sleep(0.05)  # let every worker pin itself before the start signal
    go.set()
    out = dict(q.get(timeout=seconds + 30) for _ in procs)
    for p in procs:
        p.join()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--perf-cores")
    ap.add_argument("--eff-cores")
    ap.add_argument("--all-cores")
    ap.add_argument("--perf-label", default="", help="core model, e.g. Cortex-X925")
    ap.add_argument("--eff-label", default="", help="core model, e.g. Cortex-A725")
    a = ap.parse_args()
    on_sigterm()
    heap_kept = keep_heap()
    perf, eff = int_list(a.perf_cores), int_list(a.eff_cores)
    allc = int_list(a.all_cores) or sorted(os.sched_getaffinity(0))
    pm, em = (f" ({m})" if m else "" for m in (a.perf_label, a.eff_label))
    tests = []  # (metric, label, cores)
    if perf:
        tests.append(("single_perf_mbps", f"Single performance core{pm}", perf[:1]))
    if eff:
        tests.append(("single_eff_mbps", f"Single efficiency core{em}", eff[:1]))
    if not perf and not eff:
        tests.append(("single_mbps", "Single core", allc[:1]))
    if perf:
        tests.append(("multi_perf_mbps", f"All {len(perf)} performance cores{pm}", perf))
    if eff:
        tests.append(("multi_eff_mbps", f"All {len(eff)} efficiency cores{em}", eff))
    mix = f" ({len(perf)} performance + {len(eff)} efficiency)" if perf and eff else ""
    tests.append(("multi_all_mbps", f"All {len(allc)} cores{mix}", allc))
    for i, (metric, label, cores) in enumerate(tests):
        progress(i / len(tests), label)
        per_core = run_set(cores, a.seconds)
        extras = {"cores": cores, "seconds": a.seconds, "workload": WORKLOAD, "heap_trim_off": heap_kept}
        if len(cores) > 1:
            extras["per_core_mbps"] = {str(c): round(v, 1) for c, v in sorted(per_core.items())}
        result(metric, label, round(sum(per_core.values()), 1), "MB/s", **extras)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
