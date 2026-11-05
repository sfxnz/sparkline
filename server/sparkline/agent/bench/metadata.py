"""Run metadata: versions, hardware, telemetry snapshot at start/end, suite hashes."""

from __future__ import annotations

import functools
import hashlib
import os
import socket
import subprocess
from collections import Counter
from typing import Any

from ...common.schema import GpuInfo, GpuSample, NodeInfo, Sample
from .probes import GpuTarget

PAYLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "bench", "payloads")
_BENCH_DIR = os.path.dirname(__file__)


@functools.cache
def suite_hashes() -> dict[str, str | bool | None]:
    """'suite_git': HEAD of the repo holding the code (None outside a checkout), 'suite_git_dirty': the suite
    has uncommitted changes; 'suite_sha256': sha256 over the payload scripts and the agent's bench modules
    (always available, so installs without git are still traceable)."""
    h = hashlib.sha256()
    for d in (PAYLOAD_DIR, _BENCH_DIR):
        for name in sorted(os.listdir(d)):
            if name.endswith(".py"):
                h.update(name.encode() + b"\0")
                with open(os.path.join(d, name), "rb") as f:
                    h.update(f.read())
    git, dirty = None, None
    try:
        rev = subprocess.run(
            ["git", "-C", PAYLOAD_DIR, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5
        )
        if rev.returncode == 0:
            git = rev.stdout.strip()
            st = subprocess.run(
                ["git", "-C", PAYLOAD_DIR, "status", "--porcelain", "--", PAYLOAD_DIR, _BENCH_DIR],
                capture_output=True,
                text=True,
                timeout=5,
            )
            dirty = bool(st.stdout.strip()) if st.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        pass
    return {"suite_git": git, "suite_git_dirty": dirty, "suite_sha256": h.hexdigest()}


def gpu_index(target: GpuTarget | None) -> int:
    return target.gpu.index if target else 0


def named_gpu(count: int, target: GpuTarget | None) -> int | None:
    """The GPU a run's metadata describes: its target, else the GPU of a node with one. A run that uses no GPU
    on a node with several describes none of them."""
    return target.gpu.index if target else 0 if count <= 1 else None


def gpu_sample(s: Sample, index: int) -> GpuSample | None:
    return next((g for g in s.gpu if g.index == index), None)


def gpu(gpus: list[GpuInfo], target: GpuTarget | None) -> dict[str, Any]:
    i = named_gpu(len(gpus), target)
    if i is None:
        return {}
    g = next((x for x in gpus if x.index == i), None)
    out = {
        "gpu_name": g.name if g else None,
        "gpu_uuid": g.uuid if g else None,
        "gpu_cc": g.compute_capability if g else None,
    }
    return {**out, "gpu_index": i} if target and target.pinned else out


def telemetry(s: Sample | None, target: GpuTarget | None) -> dict[str, Any]:
    if s is None:
        return {}
    out: dict[str, Any] = {"ts": s.ts, "mem_used": s.mem.used, "mem_gpu": s.mem.gpu}
    i = named_gpu(len(s.gpu), target)
    if i is not None and (g := gpu_sample(s, i)) is not None:
        out.update(
            sm_mhz=g.sm_mhz, temp_c=g.temp_c, power_w=g.power_w, throttle_mask=g.throttle_mask, util=g.util
        )
    return out


def static(
    info: NodeInfo, image: str | None, image_id: str | None, target: GpuTarget | None
) -> dict[str, Any]:
    kinds = Counter(c.kind for c in info.cores)
    models = Counter(c.model for c in info.cores if c.model)
    return {
        "hostname": socket.gethostname(),
        "node_id": info.node_id,
        "agent_version": info.agent_version,
        "os": info.os,
        "kernel": info.kernel,
        "driver": info.driver,
        "cuda": info.cuda,
        "nvml": info.nvml,
        **gpu(info.gpus, target),
        "cpu_model": info.cpu_model,
        "cpu_cores": {"total": len(info.cores), **dict(kinds), "models": dict(models)},
        "bench_image": image,
        "bench_image_id": image_id,
        **suite_hashes(),
    }
