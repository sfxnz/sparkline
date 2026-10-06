"""Run metadata: versions, hardware, telemetry snapshot at start/end, suite hashes."""

from __future__ import annotations

import functools
import hashlib
import os
import socket
import subprocess
from collections import Counter
from typing import Any

from ...common.schema import NodeInfo, Sample

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


def telemetry(s: Sample | None) -> dict[str, Any]:
    """GPU 0 clocks/temp/power/throttle and memory use from the sampler's latest sample."""
    if s is None:
        return {}
    out: dict[str, Any] = {"ts": s.ts, "mem_used": s.mem.used, "mem_gpu": s.mem.gpu}
    if s.gpu:
        g = s.gpu[0]
        out.update(
            sm_mhz=g.sm_mhz, temp_c=g.temp_c, power_w=g.power_w, throttle_mask=g.throttle_mask, util=g.util
        )
    return out


def static(info: NodeInfo, image: str | None, image_id: str | None) -> dict[str, Any]:
    kinds = Counter(c.kind for c in info.cores)
    models = Counter(c.model for c in info.cores if c.model)
    gpu = info.gpus[0] if info.gpus else None
    return {
        "hostname": socket.gethostname(),
        "node_id": info.node_id,
        "agent_version": info.agent_version,
        "os": info.os,
        "kernel": info.kernel,
        "driver": info.driver,
        "cuda": info.cuda,
        "nvml": info.nvml,
        "gpu_name": gpu.name if gpu else None,
        "gpu_uuid": gpu.uuid if gpu else None,
        "gpu_cc": gpu.compute_capability if gpu else None,
        "cpu_model": info.cpu_model,
        "cpu_cores": {"total": len(info.cores), **dict(kinds), "models": dict(models)},
        "bench_image": image,
        "bench_image_id": image_id,
        **suite_hashes(),
    }
