"""CPU throughput by core type (host Python, no container).

Workload: SHA-256 plus zlib level-1 compression over a fixed 64 KiB buffer (both C implementations), one
process per core pinned with os.sched_setaffinity. Throughput = buffer bytes processed per second (MB/s).
Tests: one performance core, one efficiency core, all performance cores, all efficiency cores, all cores.
"""

from __future__ import annotations

import argparse
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
    ap.add_argument("--perf-label", default="performance")
    ap.add_argument("--eff-label", default="efficiency")
    a = ap.parse_args()
    on_sigterm()
    perf, eff = int_list(a.perf_cores), int_list(a.eff_cores)
    allc = int_list(a.all_cores) or sorted(os.sched_getaffinity(0))
    tests = []  # (metric, label, cores)
    if perf:
        tests.append(("single_perf_mbps", f"Single core ({a.perf_label})", perf[:1]))
    if eff:
        tests.append(("single_eff_mbps", f"Single core ({a.eff_label})", eff[:1]))
    if not perf and not eff:
        tests.append(("single_mbps", "Single core", allc[:1]))
    if perf:
        tests.append(("multi_perf_mbps", f"All performance cores ({len(perf)}x {a.perf_label})", perf))
    if eff:
        tests.append(("multi_eff_mbps", f"All efficiency cores ({len(eff)}x {a.eff_label})", eff))
    tests.append(("multi_all_mbps", f"All cores ({len(allc)})", allc))
    for i, (metric, label, cores) in enumerate(tests):
        progress(i / len(tests), label)
        per_core = run_set(cores, a.seconds)
        extras = {"cores": cores, "seconds": a.seconds, "workload": WORKLOAD}
        if len(cores) > 1:
            extras["per_core_mbps"] = {str(c): round(v, 1) for c, v in sorted(per_core.items())}
        result(metric, label, round(sum(per_core.values()), 1), "MB/s", **extras)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
