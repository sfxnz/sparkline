"""Environment checks for benchmark availability: Docker + image, GPU, perftest, RoCE GIDs, fio, CPU cap,
tool-eval-bench."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import socket
from dataclasses import dataclass, field
from typing import Any

from ...common.schema import NetIfInfo, NodeInfo, Problem

DOCKER_SOCK = "/var/run/docker.sock"
IB_SYSFS = "/sys/class/infiniband"


def docker_request(
    method: str, path: str, sock_path: str = DOCKER_SOCK, timeout: float = 2.0
) -> tuple[int, Any]:
    """Minimal HTTP/1.0 request to the Docker Engine API. Returns (status, parsed JSON body or None)."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(sock_path)
        s.sendall(f"{method} {path} HTTP/1.0\r\nHost: docker\r\n\r\n".encode())
        chunks = []
        while b := s.recv(65536):
            chunks.append(b)
    head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    try:
        return status, json.loads(body) if body.strip() else None
    except ValueError:
        return status, None


def image_id(image: str, sock_path: str = DOCKER_SOCK) -> str | None:
    """Local image ID, None if the image is not present. Raises OSError if Docker is unreachable."""
    status, body = docker_request("GET", f"/images/{image}/json", sock_path)
    if status == 404:
        return None
    if status != 200 or not isinstance(body, dict):
        raise OSError(f"docker API returned HTTP {status} for image {image}")
    return body.get("Id")


def roce_v2_ipv4_gid(dev: str, root: str = IB_SYSFS) -> int | None:
    """Index of the RoCE v2 GID carrying an IPv4-mapped address on port 1 of ``dev``."""
    gids = os.path.join(root, dev, "ports", "1", "gids")
    try:
        idx = sorted(int(n) for n in os.listdir(gids) if n.isdigit())
    except OSError:
        return None
    for i in idx:
        try:
            with open(os.path.join(gids, str(i))) as f:
                gid = f.read().strip()
            with open(os.path.join(root, dev, "ports", "1", "gid_attrs", "types", str(i))) as f:
                kind = f.read().strip()
        except OSError:  # unpopulated entries raise EINVAL
            continue
        if kind == "RoCE v2" and gid.startswith("0000:0000:0000:0000:0000:ffff:"):
            return i
    return None


def rails(info: NodeInfo) -> dict[str, NetIfInfo]:
    """'A'/'B' -> interconnect interface with an RDMA device (labels come from the net collector)."""
    out = {}
    for n in info.net:
        if n.role == "interconnect" and n.rdma_device and n.label.startswith("ConnectX-7 rail "):
            out[n.label.rsplit(" ", 1)[1]] = n
    return out


def port_listening(port: int, proc_root: str = "/proc") -> bool:
    """True if any TCP socket on this host is in LISTEN state on ``port``."""
    for name in ("tcp", "tcp6"):
        try:
            with open(os.path.join(proc_root, "net", name)) as f:
                lines = f.readlines()[1:]
        except OSError:
            continue
        for line in lines:
            cols = line.split()
            if len(cols) > 3 and cols[3] == "0A" and int(cols[1].rsplit(":", 1)[1], 16) == port:
                return True
    return False


def cpu_quota(proc_root: str = "/proc", cgroup_root: str = "/sys/fs/cgroup") -> float | None:
    """CPUs this process's cgroup v2 may use (cpu.max), None if uncapped or unknown."""
    try:
        with open(os.path.join(proc_root, "self", "cgroup")) as f:
            path = next(ln.split(":", 2)[2].strip() for ln in f if ln.startswith("0::"))
        with open(os.path.join(cgroup_root, path.lstrip("/"), "cpu.max")) as f:
            quota, period = f.read().split()
        return None if quota == "max" else int(quota) / int(period)
    except (OSError, StopIteration, ValueError):
        return None


@dataclass
class Env:
    """One snapshot of what this node can run (refreshed by the runner every few seconds)."""

    docker: Problem | None = None
    image: Problem | None = None
    image_id: str | None = None
    gpu: Problem | None = None
    perftest: Problem | None = None
    rdma: Problem | None = None
    gids: dict[str, int | None] = field(default_factory=dict)  # rail -> GID index
    fio: str | None = None
    all_reduce_perf: str | None = None
    work_dir: Problem | None = None
    cpu_cap: Problem | None = None  # benchmarks that run as agent children would be throttled
    tool_eval: Problem | None = None  # the tool-eval payload imports tool-eval-bench from the agent's venv


def probe(info: NodeInfo, image: str, work_dir: str, sock_path: str = DOCKER_SOCK) -> Env:
    node = info.node_id
    env = Env()
    try:
        env.image_id = image_id(image, sock_path)
        if env.image_id is None:
            env.image = Problem(
                message=f"Benchmark image not present on {node}",
                cause=f"{image} is not in the local Docker image store",
                fix=f"docker pull {image} on {node}",
            )
    except (OSError, ValueError, IndexError) as e:
        env.docker = Problem(
            message=f"Docker is not reachable on {node}",
            cause=f"{sock_path}: {e}",
            fix="Check `systemctl status docker` and that the agent's user is in the `docker` group, "
            "then restart sparkline-agent",
        )
    if not info.gpus:
        env.gpu = Problem(
            message=f"No NVIDIA GPU detected on {node}",
            cause="NVML reported no GPUs when the agent started",
            fix=f"Check `nvidia-smi` on {node}, then restart sparkline-agent",
        )
    if not (shutil.which("ib_write_bw") and shutil.which("ib_write_lat")):
        env.perftest = Problem(
            message=f"perftest is not installed on {node}",
            cause="ib_write_bw / ib_write_lat were not found on PATH",
            fix=f"sudo apt install perftest on {node}",
        )
    r = rails(info)
    env.gids = {k: roce_v2_ipv4_gid(n.rdma_device or "") for k, n in r.items()}
    if not r:
        env.rdma = Problem(
            message=f"No active ConnectX-7 rail with RDMA on {node}",
            cause="No interconnect interface with link up and an RDMA device was found",
            fix=f"Check the ConnectX-7 cabling and `ibv_devinfo` on {node}",
        )
    elif not any(g is not None for g in env.gids.values()):
        devs = ", ".join(n.rdma_device or "" for n in r.values())
        env.rdma = Problem(
            message=f"No RoCE v2 IPv4 GID on {node}",
            cause=f"{devs}: no GID of type 'RoCE v2' with an IPv4 address",
            fix=f"Assign an IPv4 address to the ConnectX-7 interfaces on {node}",
        )
    env.fio = shutil.which("fio")
    env.all_reduce_perf = shutil.which("all_reduce_perf")
    try:
        os.makedirs(work_dir, mode=0o700, exist_ok=True)
        if not os.access(work_dir, os.W_OK):
            raise OSError("not writable")
    except OSError as e:
        env.work_dir = Problem(
            message=f"Benchmark work directory unusable on {node}",
            cause=f"{work_dir}: {e}",
            fix="Set bench_work_dir in the agent config to a writable directory on the NVMe drive",
        )
    cap = cpu_quota()
    if cap is not None:
        env.cpu_cap = Problem(
            message=f"sparkline-agent is CPU-capped on {node}",
            cause=f"Its cgroup allows {cap:g} CPUs (cpu.max), which would throttle this benchmark "
            "and skew its results",
            fix=f"Run `sudo ./deploy/install.sh agent --enable-benchmarks` on {node}",
        )
    if importlib.util.find_spec("tool_eval_bench") is None:
        env.tool_eval = Problem(
            message=f"tool-eval-bench isn't installed on {node}",
            cause="The agent's Python environment doesn't include the tool-eval-bench package.",
            fix="Reinstall the agent (`sudo ./deploy/install.sh agent --enable-benchmarks` installs the "
            "pinned version), or for a dev agent run `server/.venv/bin/pip install tool-eval-bench==2.8.0`.",
        )
    return env


def availability(bench_id: str, env: Env) -> tuple[Problem | None, str]:
    """(blocking problem or None, note appended to the description)."""
    docker = env.docker or env.image
    if bench_id in ("gpu-matmul", "thermal-soak", "mem-bandwidth"):
        return docker or env.gpu, ""
    if bench_id == "nccl-allreduce":
        why = (
            "all_reduce_perf needs an MPI launcher across nodes"
            if env.all_reduce_perf
            else "nccl-tests is not installed"
        )
        note = f"{why}, so torch.distributed (NCCL backend) in the PyTorch container is used."
        return docker or env.gpu or env.rdma, note
    if bench_id == "rdma-bw-lat":
        return env.perftest or env.rdma or env.cpu_cap, ""
    if bench_id == "storage-fio":
        note = "" if env.fio else "fio is not installed, so the built-in O_DIRECT runner is used."
        return env.work_dir or env.cpu_cap, note
    if bench_id == "tool-eval":
        return env.tool_eval or env.cpu_cap, ""
    return env.cpu_cap, ""  # cpu-throughput, llm-inference, llm-showcase: host processes in the agent cgroup
