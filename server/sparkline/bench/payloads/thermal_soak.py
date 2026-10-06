"""Thermal soak: sustained BF16 GEMM load for --seconds (PyTorch container).

Emits achieved TFLOPS about once a second as gauge "tflops" (the agent records it with its own telemetry
samples, so all soak series share one time axis) and, at the end, TFLOPS over the first versus the last
window (1 min, or a third of a shorter run) with the signed change (negative: slower at the end).
The agent records clocks, temperature, power and throttle reasons itself.
"""

from __future__ import annotations

import argparse
import statistics
import time

import torch
from benchlib import emit, fail, log, on_sigterm, progress, result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--size", type=int, default=8192)
    ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    a = ap.parse_args()
    on_sigterm()
    dev = a.device
    n = 256 if dev == "cpu" else a.size
    if dev == "cuda" and not torch.cuda.is_available():
        fail(
            "CUDA is not available in the benchmark container",
            "torch.cuda.is_available() is False",
            "Check that Docker passes the GPU: docker run --rm --gpus all <image> nvidia-smi",
        )
    x = torch.randn(n, n, dtype=torch.bfloat16, device=dev)
    y = torch.randn(n, n, dtype=torch.bfloat16, device=dev)
    out = torch.empty(n, n, dtype=torch.bfloat16, device=dev)
    flop = 2 * n**3
    name = torch.cuda.get_device_name(0) if dev == "cuda" else "cpu"
    log(f"soak {a.seconds:.0f} s, BF16 {n}³, device {name}")
    sync = torch.cuda.synchronize if dev == "cuda" else (lambda: None)
    batch = 1
    cold = True
    t_start = time.perf_counter()
    pts: list[tuple[float, float]] = []
    while True:
        t0 = time.perf_counter()
        for _ in range(batch):
            torch.mm(x, y, out=out)
        sync()
        dt = time.perf_counter() - t0
        tf = batch * flop / dt / 1e12  # the batch that was actually timed, before any resize below
        if dt < 0.5:  # aim for ~1 s windows
            batch = max(1, int(batch * min(4.0, 1.0 / max(dt, 1e-3))))
        if cold or (not pts and dt < 0.5):
            cold = False  # the first call (cuBLAS/allocator set-up) and sizing windows are not measurements
            continue
        el = time.perf_counter() - t_start
        pts.append((el, tf))
        emit(gauge={"tflops": round(tf, 3)})
        progress(el / a.seconds, f"Sustained load {el / 60:.1f} of {a.seconds / 60:.0f} min")
        if el >= a.seconds:
            break
    window = min(60.0, a.seconds / 3)
    first = [tf for t, tf in pts if t <= window] or [pts[0][1]]
    last = [tf for t, tf in pts if t >= pts[-1][0] - window] or [pts[-1][1]]
    f, last_mean = statistics.fmean(first), statistics.fmean(last)
    ex = {"window_s": round(window, 1), "size": n, "smoke": dev == "cpu"}
    result("tflops_first", "BF16 TFLOPS, first window", round(f, 3), "TFLOPS", **ex)
    result("tflops_last", "BF16 TFLOPS, last window", round(last_mean, 3), "TFLOPS", **ex)
    change = round((last_mean - f) / f * 100, 2)
    result("tflops_change_pct", "Throughput change, last vs first window", change, "%", **ex)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
