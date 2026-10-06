"""Dense GEMM throughput (TFLOPS) for BF16 / FP16 / FP8 / FP4. Runs inside the PyTorch container.

FP8 uses torch._scaled_mm with float8_e4m3fn operands (per-tensor or per-row scales). FP4 tries
torch._scaled_mm with float4_e2m1fn_x2 operands and block scales (NVFP4, then MXFP4); if this PyTorch/GPU
cannot run it, the result is reported with extras.unsupported=true and the reason, never with a number.
--device cpu is a code-path smoke test: tiny sizes, results flagged extras.smoke=true.
"""

from __future__ import annotations

import argparse
import time

import torch
from benchlib import fail, int_list, log, on_sigterm, progress, result

LABEL = {"bf16": "BF16", "fp16": "FP16", "fp8": "FP8", "fp4": "FP4"}


class Unsupported(Exception):
    pass


def _round_up(x: int, m: int) -> int:
    return (x + m - 1) // m * m


def operands(dtype: str, n: int, dev: str, fp8_scaling: str):
    """Return a zero-arg callable doing one n x n x n GEMM."""
    if dtype in ("bf16", "fp16"):
        t = torch.bfloat16 if dtype == "bf16" else torch.float16
        a = torch.randn(n, n, dtype=t, device=dev)
        b = torch.randn(n, n, dtype=t, device=dev)
        c = torch.empty(n, n, dtype=t, device=dev)
        return lambda: torch.mm(a, b, out=c)
    if dev != "cuda":
        raise Unsupported("torch._scaled_mm needs a CUDA device (CPU smoke run)")
    if dtype == "fp8":
        a = torch.randn(n, n, device=dev).to(torch.float8_e4m3fn)
        b = torch.randn(n, n, device=dev).to(torch.float8_e4m3fn).t()  # column-major, as cuBLASLt requires
        if fp8_scaling == "row":
            sa = torch.ones(n, 1, device=dev, dtype=torch.float32)
            sb = torch.ones(1, n, device=dev, dtype=torch.float32)
        else:
            sa = torch.tensor(1.0, device=dev)
            sb = torch.tensor(1.0, device=dev)
        fn = lambda: torch._scaled_mm(a, b, scale_a=sa, scale_b=sb, out_dtype=torch.bfloat16)  # noqa: E731
        fn()
        return fn
    if not hasattr(torch, "float4_e2m1fn_x2"):
        raise Unsupported(f"PyTorch {torch.__version__} has no float4_e2m1fn_x2 dtype")
    a = torch.randint(0, 256, (n, n // 2), dtype=torch.uint8, device=dev).view(torch.float4_e2m1fn_x2)
    b = torch.randint(0, 256, (n, n // 2), dtype=torch.uint8, device=dev).view(torch.float4_e2m1fn_x2).t()
    errors = []
    # NVFP4: one e4m3 scale per 16 values; MXFP4: one e8m0 scale per 32 values; both in 128x4 swizzled tiles.
    for name, block, sdt in (("nvfp4", 16, "float8_e4m3fn"), ("mxfp4", 32, "float8_e8m0fnu")):
        if not hasattr(torch, sdt):
            errors.append(f"{name}: no torch.{sdt}")
            continue
        size = _round_up(n, 128) * _round_up(n // block, 4)
        sa = torch.ones(size, device=dev).to(getattr(torch, sdt))
        sb = torch.ones(size, device=dev).to(getattr(torch, sdt))
        fn = lambda a=a, b=b, sa=sa, sb=sb: torch._scaled_mm(a, b, sa, sb, out_dtype=torch.bfloat16)  # noqa: E731
        try:
            fn()
            torch.cuda.synchronize()
            return fn
        except (RuntimeError, ValueError, TypeError, NotImplementedError) as e:
            errors.append(f"{name}: {str(e).splitlines()[0][:200]}")
    raise Unsupported("; ".join(errors))


def time_gemm(fn, iters: int, warmup: int, dev: str) -> float:
    """Seconds per GEMM."""
    for _ in range(warmup):
        fn()
    if dev == "cuda":
        torch.cuda.synchronize()
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        start.record()
        for _ in range(iters):
            fn()
        end.record()
        end.synchronize()
        return start.elapsed_time(end) / 1000 / iters
    t0 = time.perf_counter()
    for _ in range(iters):
        fn()
    return (time.perf_counter() - t0) / iters


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dtypes", default="bf16,fp16,fp8,fp4")
    ap.add_argument("--sizes", default="4096,8192,16384")
    ap.add_argument("--iterations", type=int, default=50)
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--fp8-scaling", choices=["tensor", "row"], default="tensor")
    ap.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    a = ap.parse_args()
    on_sigterm()
    dev = a.device
    smoke = dev == "cpu"
    sizes = [256] if smoke else int_list(a.sizes)
    iters, warmup = (3, 1) if smoke else (a.iterations, a.warmup)
    dtypes = a.dtypes.split(",")
    if dev == "cuda":
        if not torch.cuda.is_available():
            fail(
                "CUDA is not available in the benchmark container",
                "torch.cuda.is_available() is False",
                "Check that Docker passes the GPU: docker run --rm --gpus all <image> nvidia-smi",
            )
        gpu = torch.cuda.get_device_name(0)
        torch.backends.cuda.matmul.allow_tf32 = False
    else:
        gpu = "cpu"
    log(f"torch {torch.__version__}, CUDA {torch.version.cuda}, device {gpu}")
    steps, done = len(dtypes) * len(sizes), 0
    for d in dtypes:
        per_size: dict[str, float] = {}
        reason = None
        for n in sizes:
            progress(done / steps, f"{LABEL[d]} {n}³")
            try:
                fn = operands(d, n, dev, a.fp8_scaling)
                sec = time_gemm(fn, iters, warmup, dev)
                per_size[str(n)] = 2 * n**3 / sec / 1e12
                del fn
            except Unsupported as e:
                reason = str(e)
                break
            finally:
                done += 1
                if dev == "cuda":
                    torch.cuda.empty_cache()
        common = {"device": gpu, "torch": torch.__version__, "cuda": torch.version.cuda, "smoke": smoke}
        if reason is not None:
            log(f"{LABEL[d]} unsupported: {reason}")
            result(
                f"{d}_tflops",
                f"{LABEL[d]} dense GEMM",
                0.0,
                "TFLOPS",
                unsupported=True,
                reason=reason,
                **common,
            )
            continue
        best = max(per_size, key=per_size.__getitem__)
        extras = {
            "per_size": per_size,
            "best_size": int(best),
            "iterations": iters,
            "warmup": warmup,
            **common,
        }
        if d == "fp8":
            extras["scaling"] = a.fp8_scaling
        result(f"{d}_tflops", f"{LABEL[d]} dense GEMM", round(per_size[best], 3), "TFLOPS", **extras)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
