"""Benchmark runner lifecycle with fake payloads, argv building per bench, and host payload code paths."""

from __future__ import annotations

import asyncio
import fcntl
import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import psutil
import pytest
from netports import free_ports

from sparkline.agent.bench import jobs, probes, specs
from sparkline.agent.bench import runner as runner_mod
from sparkline.agent.bench.metadata import PAYLOAD_DIR
from sparkline.agent.bench.runner import BenchRunner, Job, Rejected
from sparkline.common.schema import (
    BenchStartRequest,
    CoreInfo,
    CpuSample,
    GpuInfo,
    GpuSample,
    MemSample,
    NetIfInfo,
    NodeInfo,
    Problem,
    ProcSample,
    Sample,
)

FIX = Path(__file__).parent / "fixtures" / "agent" / "bench"
FAKE = FIX / "fake_payload.py"
FAKE_DOCKER = FIX / "fake_docker.py"  # housekeeping (ps/rm) never reaches the real Docker daemon
LLM_PORT, NOTHING_PORT = free_ports(2)  # fake OpenAI server; nothing listening
GIB = 2**30


def node_info() -> NodeInfo:
    return NodeInfo(
        node_id="n1",
        hostname="n1",
        agent_version="t",
        os="x",
        kernel="k",
        driver="580.173.02",
        cuda="13.0",
        nvml="13.580",
        cpu_model="c",
        cores=[
            CoreInfo(id=0, kind="efficiency", model="Cortex-A725"),
            CoreInfo(id=1, kind="efficiency", model="Cortex-A725"),
            CoreInfo(id=2, kind="performance", model="Cortex-X925"),
        ],
        mem_total=100,
        swap_total=0,
        gpus=[GpuInfo(index=0, name="NVIDIA GB10", uuid="GPU-abc")],
        net=[
            NetIfInfo(
                name="enp1s0f1np1",
                role="interconnect",
                label="ConnectX-7 rail A",
                ipv4=["10.100.8.1"],
                rdma_device="rocep1s0f1",
            ),
            NetIfInfo(
                name="enP2p1s0f1np1",
                role="interconnect",
                label="ConnectX-7 rail B",
                ipv4=["10.100.9.1"],
                rdma_device="roceP2p1s0f1",
            ),
            NetIfInfo(name="enP7s7", role="lan", label="LAN", ipv4=["10.20.20.48"]),
        ],
        disks=[],
        sensors=[],
        unsupported=[],
        tools={},
        sample_interval_ms=1000,
        boot_time=0,
    )


def sample(
    ts: float, used: int = 10 * 2**30, gpu: int = 5 * 2**30, sm: float = 2000.0, mask: int = 0
) -> Sample:
    return Sample(
        node_id="n1",
        ts=ts,
        seq=1,
        interval_ms=1000,
        gpu=[GpuSample(index=0, util=99, sm_mhz=sm, temp_c=70, power_w=40, throttle_mask=mask)],
        mem=MemSample(
            total=100 * 2**30,
            available=50 * 2**30,
            used=used,
            free=1,
            gpu=gpu,
            anon=1,
            cache=1,
            shmem=1,
            kernel=1,
            other=1,
            swap_total=0,
            swap_used=0,
        ),
        cpu=CpuSample(util=1, per_core=[1], freq_mhz=[None], load1=0, load5=0, load15=0),
        net=[],
        disk=[],
        fs=[],
        temps=[],
    )


def fake(mode: str):
    async def fn(job: Job, _p) -> None:
        await job.run([sys.executable, str(FAKE), mode])

    return fn


def make_runner(tmp_path, job_fns=None, msgs=None, env=None, latest=None, **kw) -> BenchRunner:
    return BenchRunner(
        "n1",
        node_info,
        latest or (lambda: None),
        (msgs if msgs is not None else []).append,
        "img:tag",
        str(tmp_path / "work"),
        jobs=job_fns if job_fns is not None else jobs.JOBS,
        probe=lambda: env or probes.Env(gids={"A": 3, "B": 3}),
        kill_grace_s=0.5,
        **{"docker": str(FAKE_DOCKER), **kw},
    )


def req(run_id="r1", bench_id="cpu-throughput", **kw) -> BenchStartRequest:
    return BenchStartRequest(run_id=run_id, bench_id=bench_id, **kw)


async def wait_for(cond, timeout=10.0):
    t = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > t:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)


def alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


# -----------------------------------------------------------------------------------------------------
# Lifecycle
# -----------------------------------------------------------------------------------------------------


async def test_run_ok_progress_results_series_metadata(tmp_path):
    msgs: list[str] = []
    r = make_runner(tmp_path, {"cpu-throughput": fake("ok")}, msgs, latest=lambda: sample(time.time()))
    st = await r.start(req(params={"seconds_per_test": 1}))
    assert st.status == "running" and st.started_ts and st.node_id == "n1"
    await r.current.task
    st = r.get("r1")
    assert st.status == "succeeded" and st.progress == 1.0 and st.error is None
    assert [x.metric for x in st.results] == ["m"] and st.results[0].node_id == "n1"
    assert st.results[0].extras == {"k": 1}
    assert st.series == {"x": [1.0, 2.0, 3.0]}
    assert "plain output line" in st.log_tail and "a log message" in st.log_tail
    assert any("invalid result" in ln for ln in st.log_tail)
    md = st.metadata
    assert md["params"] == {"seconds_per_test": 1.0} and md["driver"] == "580.173.02"
    assert md["gpu_name"] == "NVIDIA GB10" and md["gpu_uuid"] == "GPU-abc"
    assert md["start"]["sm_mhz"] == 2000.0 and md["end"]["throttle_mask"] == 0
    assert len(md["suite_sha256"]) == 64 and "suite_git" in md
    assert md["cpu_cores"]["performance"] == 1 and md["cpu_cores"]["efficiency"] == 2
    assert md["bench_image"] is None  # host benchmark
    first, last = json.loads(msgs[0]), json.loads(msgs[-1])
    assert first["type"] == "bench" and first["node_id"] == "n1" and first["run"]["status"] == "running"
    assert last["run"]["status"] == "succeeded" and last["run"]["results"][0]["value"] == 42.0
    assert not (tmp_path / "work" / "r1").exists()
    assert r.current is None


async def test_busy_409_and_duplicate_run_id(tmp_path):
    r = make_runner(tmp_path, {"cpu-throughput": fake("hang"), "storage-fio": fake("ok")})
    await r.start(req("a"))
    with pytest.raises(Rejected) as e:
        await r.start(req("b", "storage-fio"))
    assert e.value.status == 409 and "already running" in e.value.problem.message
    r.cancel("a")
    await wait_for(lambda: r.current is None)
    with pytest.raises(Rejected) as e:
        await r.start(req("a"))
    assert e.value.status == 409


async def test_cancel_kills_process_group_and_cleans_files(tmp_path):
    msgs: list[str] = []
    r = make_runner(tmp_path, {"cpu-throughput": fake("hang")}, msgs)
    await r.start(req())
    pids_file = tmp_path / "work" / "r1" / "pids"
    await wait_for(pids_file.exists)
    await wait_for(lambda: r.get("r1").ready)
    parent, child = (int(x) for x in pids_file.read_text().split())
    assert (tmp_path / "work" / "r1" / "scratch.tmp").exists()
    assert alive(parent) and alive(child)
    st = r.cancel("r1")
    assert st.phase == "Cancelling"
    await wait_for(lambda: r.current is None)
    st = r.get("r1")
    assert st.status == "cancelled" and st.error is None and st.finished_ts
    await wait_for(lambda: not alive(parent) and not alive(child), 5)  # both ignored SIGTERM -> SIGKILL
    assert not (tmp_path / "work" / "r1").exists()
    assert json.loads(msgs[-1])["run"]["status"] == "cancelled"


async def test_cancel_removes_container(tmp_path):
    removed: list[str] = []

    async def fn(job: Job, _p) -> None:
        argv = job.docker_argv("x.py", [])
        assert argv[:2] == ["docker", "run"]
        await job.run([sys.executable, str(FAKE), "hang"])

    r = make_runner(tmp_path, {"cpu-throughput": fn})

    async def rm(name: str) -> None:
        removed.append(name)

    r._docker_rm = rm  # type: ignore[method-assign]
    job_started = await r.start(req("c1"))
    assert job_started.status == "running"
    r.current.containers.add(r.current.container_name())
    await wait_for(lambda: (tmp_path / "work" / "c1" / "pids").exists())
    r.cancel("c1")
    await wait_for(lambda: r.current is None)
    assert removed == ["sparkline-bench-c1"]


async def test_timeout_fails_with_problem(tmp_path, monkeypatch):
    monkeypatch.setattr(specs.Bench, "timeout_s", lambda self, p: 0.5)
    r = make_runner(tmp_path, {"cpu-throughput": fake("hang")})
    await r.start(req())
    pids_file = tmp_path / "work" / "r1" / "pids"
    await wait_for(lambda: pids_file.exists() or r.current is None)
    pids = [int(x) for x in pids_file.read_text().split()] if pids_file.exists() else []
    await wait_for(lambda: r.current is None)
    st = r.get("r1")
    assert st.status == "failed" and "timed out" in st.error.message
    await wait_for(lambda: not any(alive(p) for p in pids), 5)


async def test_payload_error_becomes_problem(tmp_path):
    r = make_runner(tmp_path, {"cpu-throughput": fake("fail")})
    await r.start(req())
    await r.current.task
    st = r.get("r1")
    assert st.status == "failed"
    assert st.error == Problem(message="Payload says no", cause="because", fix="do this")


async def test_crash_and_no_result(tmp_path):
    r = make_runner(tmp_path, {"cpu-throughput": fake("crash"), "storage-fio": fake("noresult")})
    await r.start(req("x1"))
    await r.current.task
    st = r.get("x1")
    assert st.status == "failed" and "exited with code 2" in st.error.cause
    assert "something went wrong" in st.error.cause
    await r.start(req("x2", "storage-fio"))
    await r.current.task
    assert "no results" in r.get("x2").error.message


async def test_exit_problem_recognises_missing_image(tmp_path):
    r = make_runner(tmp_path, {})
    job = Job(r, req(), specs.REGISTRY["gpu-matmul"], specs.GpuMatmulParams(), probes.Env())
    p = job._exit_problem(
        ["docker"], 125, ["Unable to find image 'img:tag' locally", "docker: Error response from daemon"]
    )
    assert p.fix == "docker pull img:tag on n1"


async def test_rejections(tmp_path):
    env = probes.Env(
        image=Problem(message="Benchmark image not present on n1", cause="c", fix="docker pull x")
    )
    r = make_runner(tmp_path, {**jobs.JOBS}, env=env)
    cases = [
        (req(bench_id="nope"), 422, "Unknown benchmark"),
        (req(run_id="../etc"), 422, "Invalid run id"),
        (req(run_id="a b"), 422, "Invalid run id"),
        (req(params={"seconds_per_test": 999}), 422, "Invalid parameters"),
        (req(params={"shell": "id"}), 422, "Invalid parameters"),
        (req(role="rank", rank=0, world_size=2), 422, "cannot run in role"),
        (req(bench_id="rdma-bw-lat", role="client"), 422, "Missing server address"),
        (req(bench_id="rdma-bw-lat", role="client", peer_ip="8.8.8.8"), 422, "Peer address refused"),
        (req(bench_id="rdma-bw-lat", role="client", peer_ip="evil; ls"), 422, "Peer address refused"),
        (req(bench_id="rdma-bw-lat", role="server", peer_port=22), 422, "Peer port refused"),
        (req(bench_id="nccl-allreduce", role="rank", rank=1, world_size=2), 422, "Invalid rank"),
        (req(bench_id="nccl-allreduce", role="rank", rank=0, world_size=3), 422, "Invalid rank"),
        (req(bench_id="gpu-matmul"), 422, "Benchmark image not present"),
    ]
    for rq, status, msg in cases:
        with pytest.raises(Rejected) as e:
            await r.start(rq)
        assert e.value.status == status and msg in e.value.problem.message, rq
    assert r.current is None


async def test_publish_is_throttled(tmp_path):
    msgs: list[str] = []
    r = make_runner(tmp_path, {"cpu-throughput": fake("chatty")}, msgs)
    t0 = time.monotonic()
    await r.start(req())
    await r.current.task
    elapsed = time.monotonic() - t0
    # 200 progress lines: at most ~2 messages/s plus the immediate start and terminal messages
    assert len(msgs) <= elapsed * 2 + 4
    assert json.loads(msgs[-1])["run"]["status"] == "succeeded"


async def test_history_keeps_last_20(tmp_path):
    async def quick(job: Job, _p) -> None:
        job.add_result(metric="m", label="M", value=1.0, unit="u")

    r = make_runner(tmp_path, {"cpu-throughput": quick})
    for i in range(21):
        await r.start(req(f"h{i}"))
        await r.current.task
    assert r.get("h0") is None and r.get("h20").status == "succeeded" and len(r.finished) == 20


async def test_shutdown_cancels_running_job(tmp_path):
    r = make_runner(tmp_path, {"cpu-throughput": fake("hang")})
    await r.start(req())
    await wait_for(lambda: (tmp_path / "work" / "r1" / "pids").exists())
    await r.shutdown()
    assert r.get("r1").status == "cancelled" and r.current is None


def docker_state(tmp_path, monkeypatch, containers: list[dict]) -> Path:
    path = tmp_path / "docker-state.json"
    path.write_text(json.dumps({"containers": containers, "calls": []}))
    monkeypatch.setenv("FAKE_DOCKER_STATE", str(path))
    return path


def add_docker_container(path: Path, container: dict) -> None:
    """Update the fake docker state like fake_docker.py does: under its lock, so no update is lost."""
    with open(f"{path}.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        st = json.loads(path.read_text())
        st["containers"].append(container)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(st))
        os.replace(tmp, path)


async def test_sweep_removes_leftovers_of_a_killed_agent(tmp_path, monkeypatch):
    """A killed agent leaves its container running and its work dir behind: both go before the next start."""
    state = docker_state(
        tmp_path,
        monkeypatch,
        [{"id": "c0ffee", "run": "old", "node": "n1"}, {"id": "other", "run": "x", "node": "spark9"}],
    )
    stale = tmp_path / "work" / "old"
    stale.mkdir(parents=True)
    (stale / runner_mod.WORK_MARKER).touch()
    keep = tmp_path / "work" / "not-a-run"  # no marker: never deleted
    keep.mkdir()
    r = make_runner(tmp_path, {"cpu-throughput": fake("ok")})
    await r.start(req("new"))
    assert [c["id"] for c in json.loads(state.read_text())["containers"]] == ["other"]
    assert not stale.exists() and keep.exists()
    await r.current.task
    assert r.get("new").status == "succeeded"


async def test_start_refused_while_a_leftover_container_survives(tmp_path, monkeypatch):
    docker_state(tmp_path, monkeypatch, [{"id": "stuck1", "run": "old", "node": "n1", "stuck": True}])
    r = make_runner(tmp_path, {"cpu-throughput": fake("ok")})
    with pytest.raises(Rejected) as e:
        await r.start(req("new"))
    assert e.value.status == 409 and "earlier run" in e.value.problem.message
    assert "docker rm -f stuck1" in e.value.problem.fix and r.current is None


async def test_late_created_container_is_removed_after_cancel(tmp_path, monkeypatch):
    """docker CLI killed mid-create: dockerd finishes creating the container after `rm -f` ran."""
    state = docker_state(tmp_path, monkeypatch, [])

    async def fn(job: Job, _p) -> None:
        job.containers.add(job.container_name())
        job.docker_killed = True  # as Job.run records when it had to signal a `docker run`
        await job.run([sys.executable, str(FAKE), "hang"])

    r = make_runner(tmp_path, {"cpu-throughput": fn}, late_container_s=1.5)
    await r.start(req("late1"))
    await wait_for(lambda: (tmp_path / "work" / "late1" / "pids").exists())
    r.cancel("late1")

    async def dockerd_finishes_create():
        await wait_for(
            lambda: ["rm", "-f", "sparkline-bench-late1"] in json.loads(state.read_text())["calls"]
        )
        add_docker_container(state, {"id": "created1", "run": "late1", "node": "n1"})

    await dockerd_finishes_create()
    await wait_for(lambda: r.current is None)
    st = json.loads(state.read_text())
    assert st["containers"] == [] and ["rm", "-f", "created1"] in st["calls"]
    assert r.get("late1").status == "cancelled"


async def test_terminate_reports_whether_it_signalled(tmp_path):
    r = make_runner(tmp_path, {})
    quick = await asyncio.create_subprocess_exec(sys.executable, "-c", "pass", start_new_session=True)
    await quick.wait()
    assert await r._terminate(quick) is False
    slow = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time; time.sleep(60)", start_new_session=True
    )
    assert await r._terminate(slow) is True and slow.returncode is not None


async def test_double_cancel_during_grace_still_kills_and_finishes(tmp_path):
    r = make_runner(tmp_path, {"cpu-throughput": fake("hang"), "storage-fio": fake("ok")})
    await r.start(req("d1"))
    pids_file = tmp_path / "work" / "d1" / "pids"
    await wait_for(pids_file.exists)
    await wait_for(lambda: r.get("d1").ready)
    parent, child = (int(x) for x in pids_file.read_text().split())
    r.cancel("d1")
    await asyncio.sleep(0.1)  # inside the SIGTERM grace period (the payload ignores SIGTERM)
    r.cancel("d1")
    await wait_for(lambda: r.current is None)
    assert r.get("d1").status == "cancelled"
    await wait_for(lambda: not alive(parent) and not alive(child), 5)
    assert not (tmp_path / "work" / "d1").exists()
    await r.start(req("d2", "storage-fio"))  # the node is not wedged
    await r.current.task


async def test_cancel_during_cleanup_does_not_wedge_the_node(tmp_path):
    r = make_runner(tmp_path, {"cpu-throughput": fake("hang"), "storage-fio": fake("ok")})
    removing = asyncio.Event()

    async def slow_rm(name: str) -> None:
        removing.set()
        await asyncio.sleep(0.5)

    r._docker_rm = slow_rm  # type: ignore[method-assign]
    await r.start(req("w1"))
    await wait_for(lambda: (tmp_path / "work" / "w1" / "pids").exists())
    r.current.containers.add("sparkline-bench-w1")
    task = r.current.task
    r.cancel("w1")
    await asyncio.wait_for(removing.wait(), 10)
    r.cancel("w1")  # a no-op now
    task.cancel()  # and even a raw second cancellation lands in the cleanup harmlessly
    await wait_for(lambda: r.current is None)
    assert r.get("w1").status == "cancelled" and not (tmp_path / "work" / "w1").exists()
    await r.start(req("w2", "storage-fio"))
    await r.current.task
    assert r.get("w2").status == "succeeded"


async def test_terminate_cancelled_in_grace_period_still_sigkills(tmp_path):
    r = make_runner(tmp_path, {})
    code = (
        "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('up', flush=True); "
        "time.sleep(60)"
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", code, start_new_session=True, stdout=asyncio.subprocess.PIPE
    )
    await proc.stdout.readline()
    r.kill_grace_s = 5
    t = asyncio.create_task(r._terminate(proc))
    await asyncio.sleep(0.2)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    await wait_for(lambda: not alive(proc.pid), 3)


# -----------------------------------------------------------------------------------------------------
# argv building (never a shell) per bench
# -----------------------------------------------------------------------------------------------------


def capture(job: Job, outputs=None):
    calls: list[dict] = []
    outs = list(outputs or [])

    async def run(argv, *, check=True, ready_port=None):
        calls.append({"argv": argv, "ready_port": ready_port})
        assert all(isinstance(a, str) for a in argv)
        return outs.pop(0) if outs else (0, [])

    job.run = run  # type: ignore[method-assign]
    return calls


def make_job(tmp_path, bench_id: str, params: dict | None = None, **rq) -> Job:
    r = make_runner(tmp_path)
    b = specs.REGISTRY[bench_id]
    return Job(
        r, req(bench_id=bench_id, **rq), b, b.validate(params or {}), probes.Env(gids={"A": 3, "B": 5})
    )


def test_docker_argv(tmp_path):
    job = make_job(tmp_path, "nccl-allreduce", role="rank", rank=0, world_size=2)
    argv = job.docker_argv("nccl_allreduce.py", ["--rank", "0"], infiniband=True, env={"NCCL_IB_HCA": "x"})
    assert argv == [
        "docker",
        "run",
        "--rm",
        "--name",
        "sparkline-bench-r1",
        "--label",
        "sparkline.bench=r1",
        "--label",
        "sparkline.node=n1",
        "--gpus",
        "all",
        "--ipc=host",
        "--ulimit",
        "memlock=-1",
        "--network",
        "host",
        "--device",
        "/dev/infiniband",
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        "-e",
        "NCCL_IB_HCA=x",
        "-v",
        f"{PAYLOAD_DIR}:/payloads:ro",
        "img:tag",
        "python3",
        "-u",
        "/payloads/nccl_allreduce.py",
        "--json",
        "--rank",
        "0",
    ]
    assert "--gpus" not in job.docker_argv("x.py", [], gpus=False)
    host = job.host_argv("cpu_throughput.py", ["--seconds", "1"])
    assert host[0] == sys.executable and host[2] == os.path.join(PAYLOAD_DIR, "cpu_throughput.py")


async def test_gpu_and_soak_and_mem_argv(tmp_path):
    job = make_job(
        tmp_path, "gpu-matmul", {"dtypes": ["bf16", "fp8"], "sizes": ["4096"], "fp8_scaling": "row"}
    )
    calls = capture(job)
    await jobs.gpu_matmul(job, job.params)
    argv = calls[0]["argv"]
    tail = argv[argv.index("/payloads/gpu_matmul.py") + 1 :]
    assert tail == [
        "--json",
        "--dtypes",
        "bf16,fp8",
        "--sizes",
        "4096",
        "--iterations",
        "50",
        "--warmup",
        "10",
        "--fp8-scaling",
        "row",
        "--device",
        "cuda",
    ]
    assert "--gpus" in argv
    job = make_job(tmp_path, "mem-bandwidth", {"side": "cpu"})
    calls = capture(job)
    await jobs.mem_bandwidth(job, job.params)
    argv = calls[0]["argv"]
    assert "--gpus" not in argv  # CPU side only needs no GPU
    assert argv[argv.index("--cores-perf") + 1] == "2" and argv[argv.index("--cores-eff") + 1] == "0,1"
    job = make_job(tmp_path, "cpu-throughput", {"seconds_per_test": 2})
    calls = capture(job)
    await jobs.cpu_throughput(job, job.params)
    argv = calls[0]["argv"]
    assert (
        argv[argv.index("--perf-label") + 1] == "Cortex-X925"
        and argv[argv.index("--all-cores") + 1] == "0,1,2"
    )


async def test_nccl_job_env_and_roles(tmp_path):
    job = make_job(tmp_path, "nccl-allreduce", {"max_size_mib": "16"}, role="rank", rank=0, world_size=2)
    job.env = probes.Env(gids={"A": 4, "B": 3})  # spark2's real layout: the rails differ
    calls = capture(job)
    await jobs.nccl_allreduce(job, job.params)
    argv = calls[0]["argv"]
    assert (
        "NCCL_IB_HCA=rocep1s0f1,roceP2p1s0f1" in argv
        and "NCCL_SOCKET_IFNAME=enp1s0f1np1,enP2p1s0f1np1" in argv
    )
    assert not any(a.startswith("NCCL_IB_GID_INDEX=") for a in argv)  # one index cannot fit both rails
    assert "NCCL_IB_ROCE_VERSION_NUM=2" in argv and "NCCL_IB_ADDR_FAMILY=AF_INET" in argv
    assert "/dev/infiniband" in argv
    job.env = probes.Env(gids={"A": 3, "B": 3})  # spark1: the same index on both rails
    calls = capture(job)
    await jobs.nccl_allreduce(job, job.params)
    assert "NCCL_IB_GID_INDEX=3" in calls[0]["argv"]
    assert argv[argv.index("--master") + 1] == "10.100.8.1"  # rank 0 without peer_ip: its own rail A
    assert argv[argv.index("--port") + 1] == str(jobs.NCCL_DEFAULT_PORT)
    assert argv[argv.index("--max-bytes") + 1] == str(16 * 2**20)
    assert job.expect_results
    job = make_job(
        tmp_path,
        "nccl-allreduce",
        {"rails": "B"},
        role="rank",
        rank=1,
        world_size=2,
        peer_ip="10.100.8.1",
        peer_port=29600,
    )
    calls = capture(job)
    await jobs.nccl_allreduce(job, job.params)
    argv = calls[0]["argv"]
    assert "NCCL_IB_HCA=roceP2p1s0f1" in argv and argv[argv.index("--port") + 1] == "29600"
    assert "NCCL_IB_GID_INDEX=5" in argv  # a single rail: its own index
    assert not job.expect_results


async def test_rdma_server_and_client(tmp_path):
    bw = (FIX / "perftest_write_bw_client.txt").read_text().splitlines()
    lat = (FIX / "perftest_write_lat_client.txt").read_text().splitlines()
    srv = make_job(tmp_path, "rdma-bw-lat", {"rail": "B", "duration_s": 3}, role="server")
    calls = capture(srv, [(0, bw), (0, lat)])
    await jobs.rdma_bw_lat(srv, srv.params)
    assert calls[0]["argv"] == [
        "ib_write_bw",
        "-d",
        "roceP2p1s0f1",
        "-x",
        "5",
        "-F",
        "-p",
        "18515",
        "--report_gbits",
        "-D",
        "3",
        "-s",
        "65536",
    ]
    assert calls[0]["ready_port"] == 18515
    assert calls[1]["argv"][:1] == ["ib_write_lat"] and "-n" in calls[1]["argv"]
    assert srv.state.results == [] and not srv.expect_results

    cli = make_job(tmp_path, "rdma-bw-lat", {}, role="client", peer_ip="10.100.8.2", peer_node="spark2")
    calls = capture(cli, [(1, ["Couldn't connect to 10.100.8.2:18515"]), (0, bw), (0, lat)])
    await jobs.rdma_bw_lat(cli, cli.params)
    assert len(calls) == 3  # retried the first connection
    assert calls[1]["argv"][-1] == "10.100.8.2" and calls[1]["argv"][:5] == [
        "ib_write_bw",
        "-d",
        "rocep1s0f1",
        "-x",
        "3",
    ]
    res = {x.metric: x for x in cli.state.results}
    assert res["rdma_write_bw"].value == 188.86 and res["rdma_write_bw"].unit == "Gb/s"
    assert res["rdma_write_lat"].value == 1.71 and res["rdma_write_lat"].better == "lower"
    assert res["rdma_write_lat_p99"].value == 2.02
    assert res["rdma_write_bw"].extras["peer"] == "spark2"
    assert "peak" not in res["rdma_write_bw"].extras and res["rdma_write_bw"].extras["msg_rate_mpps"] > 0


async def test_rdma_rail_without_gid_fails(tmp_path):
    job = make_job(tmp_path, "rdma-bw-lat", {"rail": "A"}, role="server")
    job.env = probes.Env(gids={"A": None})
    with pytest.raises(jobs.BenchError) as e:
        await jobs.rdma_bw_lat(job, job.params)
    assert "rail A is not usable" in e.value.problem.message


async def test_storage_uses_fio_when_installed(tmp_path):
    job = make_job(tmp_path, "storage-fio", {"size_mib": 64, "threads": 8})
    job.env = probes.Env(fio="/usr/bin/fio")
    calls = capture(job, [(0, (FIX / "fio_3.36.json").read_text().splitlines())])
    await jobs.storage(job, job.params)
    argv = calls[0]["argv"]
    assert argv[0] == "/usr/bin/fio" and "--direct=1" in argv and "--output-format=json" in argv
    assert f"--filename={job.dir / 'sparkline-io.test'}" in argv and "--size=64M" in argv
    assert argv.count("--stonewall") == 4 and "--numjobs=8" in argv
    res = {x.metric: x for x in job.state.results}
    assert res["rand_read_iops"].value == 230400.0 and res["rand_read_iops"].extras["method"] == "fio"
    assert res["seq_write_p99_us"].better == "lower"


def test_fio_argv_subset(tmp_path):
    p = specs.StorageParams(profiles=["rand_read"], runtime_s=1.5)
    argv = jobs.fio_argv("fio", "/w/f", p)
    assert "--name=rand_read" in argv and "--name=seq_write" not in argv and "--runtime=1500ms" in argv


async def test_soak_results():
    job = make_job(Path("/nonexistent"), "thermal-soak")
    s = {
        "gpu0.sm_mhz": [3000.0, 2900.0, 2800.0, 2900.0],
        "gpu0.temp_c": [60.0, 70.0, 80.0, 82.0],
        "gpu0.throttle_mask": [0.0, 4.0, 4.0 + 32.0, 1.0],  # idle (0x1) does not count as throttled
    }
    jobs.soak_results(job, s)
    res = {x.metric: x for x in job.state.results}
    assert res["sm_mhz_mean"].value == 2900.0 and res["sm_mhz_min"].value == 2800.0
    assert res["temp_max_c"].value == 82.0
    assert res["throttled_pct"].value == 25.0  # thermal only; the power cap is reported on its own
    assert res["power_capped_pct"].value == 50.0
    assert res["throttled_pct"].extras["by_reason"] == {
        "sw_power_cap": {"title": "Power cap", "pct": 50.0},
        "sw_thermal": {"title": "Thermal limit", "pct": 25.0},
    }
    assert 0 < res["sm_clock_cv_pct"].value < 5 and res["sm_clock_cv_pct"].better == "lower"


async def test_thermal_soak_records_telemetry(tmp_path):
    """The runner samples its own telemetry into series while the (fake) payload runs."""
    t = [time.time()]

    def latest() -> Sample:
        t[0] += 0.3
        return sample(t[0], sm=2500.0, mask=4)

    async def fake_soak(job: Job, p) -> None:
        async def payload():
            await asyncio.sleep(1.0)

        await jobs._with_sampling(
            job, payload(), lambda s: job.append_series({"gpu0.sm_mhz": [s.gpu[0].sm_mhz]})
        )

    r = make_runner(tmp_path, {"thermal-soak": fake_soak}, latest=latest)
    await r.start(req(bench_id="thermal-soak"))
    await r.current.task
    st = r.get("r1")
    assert len(st.series["gpu0.sm_mhz"]) >= 3  # ~4 samples per second here


async def test_thermal_soak_aligns_payload_tflops_with_samples(tmp_path):
    """Payload TFLOPS arrive as a gauge; the soak records it with each sample, from the first gauge on."""
    t = [time.time()]

    def latest() -> Sample:
        t[0] += 0.3
        return sample(t[0], sm=2500.0)

    job = make_job(tmp_path, "thermal-soak", {"minutes": 1})
    job.runner.latest = latest

    async def fake_run(argv, **_kw):
        await asyncio.sleep(0.6)  # container start-up: no load yet, nothing recorded
        job.handle({"gauge": {"tflops": 90.5}})
        await asyncio.sleep(1.0)
        job.handle({"gauge": {"tflops": "bad"}})  # ignored
        return 0, []

    job.run = fake_run
    await jobs.thermal_soak(job, job.params)
    s = job.state.series
    assert s["tflops"] and set(s["tflops"]) == {90.5}
    assert len(s["tflops"]) == len(s["t"]) == len(s["gpu0.sm_mhz"]) and "tflops_t" not in s
    assert {x.metric for x in job.state.results} >= {"sm_mhz_mean", "temp_max_c"}


async def test_thermal_soak_gauges_flow_through_the_real_pipeline(tmp_path):
    """Gauge lines from a real subprocess go through Job.run's parser into the soak series and results."""
    t = [time.time()]

    def latest() -> Sample:
        t[0] += 0.3
        return sample(t[0], sm=2500.0, mask=4)

    r = make_runner(tmp_path, latest=latest)
    r.jobs = {"thermal-soak": jobs.thermal_soak}
    Job.docker_argv = lambda self, *a, **k: [sys.executable, str(FAKE), "soak"]  # type: ignore[method-assign]
    try:
        await r.start(req(bench_id="thermal-soak", params={"minutes": 1}))
        await r.current.task
    finally:
        del Job.docker_argv  # back to the class attribute lookup
    st = r.get("r1")
    assert st.status == "succeeded", st.error
    assert set(st.series["tflops"]) <= {91.0, 92.5} and len(st.series["tflops"]) >= 3
    res = {x.metric: x for x in st.results}
    assert {"sm_mhz_mean", "temp_max_c", "throttled_pct", "power_capped_pct", "tflops_first"} <= set(res)
    assert res["throttled_pct"].value == 0.0  # power capping alone is not throttling
    assert res["power_capped_pct"].value == 100.0
    assert not any(x.extras.get("smoke") for x in st.results)


async def test_cpu_smoke_mode_flags_every_result_smoke(tmp_path):
    t = [time.time()]

    def latest() -> Sample:
        t[0] += 0.3
        return sample(t[0])

    async def soak(job: Job, p) -> None:
        job.handle({"result": {"metric": "tflops_first", "label": "T", "value": 1.0, "unit": "TFLOPS"}})
        jobs.soak_results(
            job, {"gpu0.sm_mhz": [1200.0, 1210.0], "gpu0.temp_c": [40.0, 41.0], "gpu0.throttle_mask": [0, 0]}
        )

    r = make_runner(tmp_path, {"thermal-soak": soak, "cpu-throughput": fake("ok")}, payload_device="cpu")
    await r.start(req(bench_id="thermal-soak"))
    await r.current.task
    assert all(x.extras.get("smoke") is True for x in r.get("r1").results)
    await r.start(req("r2"))  # cpu-throughput always runs on the CPU: a real measurement, not smoke
    await r.current.task
    assert not any(x.extras.get("smoke") for x in r.get("r2").results)


# -----------------------------------------------------------------------------------------------------
# Host payloads (tiny real runs)
# -----------------------------------------------------------------------------------------------------


def run_payload(script: str, *args: str, cwd=None, timeout=30) -> list[dict]:
    out = subprocess.run(
        [sys.executable, "-u", os.path.join(PAYLOAD_DIR, script), "--json", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd,
    )
    assert out.returncode == 0, out.stdout[-2000:] + out.stderr[-2000:]
    return [json.loads(ln) for ln in out.stdout.splitlines() if ln.startswith("{")]


def test_cpu_throughput_payload():
    msgs = run_payload("cpu_throughput.py", "--seconds", "0.2", "--perf-cores", "0", "--eff-cores", "1")
    res = {m["result"]["metric"]: m["result"] for m in msgs if "result" in m}
    assert set(res) == {
        "single_perf_mbps",
        "single_eff_mbps",
        "multi_perf_mbps",
        "multi_eff_mbps",
        "multi_all_mbps",
    }
    assert all(r["value"] > 0 and r["unit"] == "MB/s" for r in res.values())
    assert msgs[-1] == {"progress": 1.0, "phase": "Done"}


FAKE_TORCH = """
import time
bfloat16 = "bf16"
_calls = [0]
class cuda:
    is_available = staticmethod(lambda: True)
    synchronize = staticmethod(lambda: None)
    get_device_name = staticmethod(lambda i: "fake")
def randn(*a, **k): return None
def empty(*a, **k): return None
def mm(x, y, out=None):
    _calls[0] += 1
    time.sleep(0.6 if _calls[0] == 1 else 0.004)  # cold first call (cuBLAS set-up), then 4 ms per GEMM
"""


def test_thermal_soak_payload_tflops_use_the_timed_batch(tmp_path):
    """TFLOPS come from the batch that was timed; the cold first call and sizing windows are not recorded."""
    (tmp_path / "torch.py").write_text(FAKE_TORCH)
    out = subprocess.run(
        [sys.executable, "-u", os.path.join(PAYLOAD_DIR, "thermal_soak.py"), "--json", "--seconds", "2.5"],
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "PYTHONPATH": f"{tmp_path}{os.pathsep}{PAYLOAD_DIR}"},
    )
    assert out.returncode == 0, out.stdout[-2000:] + out.stderr[-2000:]
    msgs = [json.loads(ln) for ln in out.stdout.splitlines() if ln.startswith("{")]
    true_tf = 2 * 8192**3 / 0.004 / 1e12  # upper bound: sleep() never returns early
    gauges = [m["gauge"]["tflops"] for m in msgs if "gauge" in m]
    assert gauges and all(0.6 * true_tf < g <= true_tf for g in gauges), (true_tf, gauges)
    res = {m["result"]["metric"]: m["result"]["value"] for m in msgs if "result" in m}
    assert res["tflops_first"] <= true_tf and abs(res["tflops_change_pct"]) < 15


def test_llm_percentile_is_nearest_rank(monkeypatch):
    monkeypatch.syspath_prepend(PAYLOAD_DIR)
    from llm_inference import pct

    assert pct([2.0, 1.0], 50) == 1.0
    assert pct([float(i) for i in range(1, 7)], 50) == 3.0
    assert pct([float(i) for i in range(1, 11)], 50) == 5.0
    assert pct([float(i) for i in range(1, 21)], 95) == 19.0
    assert pct([4.0], 95) == 4.0 and pct([1.0, 9.0], 100) == 9.0


def test_llm_errors_never_echo_the_endpoints_body(monkeypatch):
    """A loopback service answering 403 must not leak its body through the run error."""
    monkeypatch.syspath_prepend(PAYLOAD_DIR)
    from llm_inference import http_error

    leak = b'{"internal": "loopback-only service data: db_password=hunter2"}'
    assert http_error(403, leak) == "HTTP 403 (not an OpenAI error; body not shown)"
    assert "hunter2" not in http_error(500, b"<html>db_password=hunter2</html>")
    assert http_error(404, b'{"error": {"message": "model x not found"}}') == "HTTP 404: model x not found"
    assert http_error(400, b'{"object": "error", "message": "bad max_tokens"}') == "HTTP 400: bad max_tokens"


def test_builtin_io_payload_small_file_removed(tmp_path):
    f = tmp_path / "io.test"
    msgs = run_payload(
        "builtin_io.py", "--file", str(f), "--size-mib", "2", "--runtime", "0.2", "--threads", "2"
    )
    res = {m["result"]["metric"]: m["result"] for m in msgs if "result" in m}
    assert {"seq_write_mbps", "seq_read_mbps", "rand_read_iops", "rand_write_p99_us"} <= set(res)
    assert res["rand_read_iops"]["extras"]["method"] == "builtin"
    assert not f.exists()


def test_builtin_io_sigterm_removes_file(tmp_path):
    f = tmp_path / "io.test"
    argv = [sys.executable, "-u", os.path.join(PAYLOAD_DIR, "builtin_io.py"), "--json", "--file", str(f)]
    argv += ["--size-mib", "2", "--runtime", "60", "--profiles", "rand_read"]
    p = subprocess.Popen(argv, stdout=subprocess.PIPE, text=True)
    assert p.stdout is not None
    for line in p.stdout:  # wait until the random-read phase has started
        if "Random read" in line:
            break
    assert f.exists()
    p.send_signal(signal.SIGTERM)
    assert p.wait(10) == 143
    assert not f.exists()


# -----------------------------------------------------------------------------------------------------
# LLM inference against a fake OpenAI-compatible server (never a real endpoint)
# -----------------------------------------------------------------------------------------------------


class FakeOpenAI(http.server.BaseHTTPRequestHandler):
    server_version = "uvicorn"

    def log_message(self, *a) -> None:
        pass

    def do_GET(self) -> None:
        if self.path != "/v1/models":
            self.send_error(404)
            return
        body = json.dumps({"data": [{"id": "fake/Model-8B", "owned_by": "vllm"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        req_body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert self.path == "/v1/chat/completions" and req_body["stream"] is True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        time.sleep(0.05)  # "prefill"
        n = req_body["max_tokens"]
        for i in range(n):
            chunk = {"choices": [{"delta": {"content": f"t{i} "}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.005)
        usage = {"choices": [], "usage": {"prompt_tokens": 130, "completion_tokens": n}}
        self.wfile.write(f"data: {json.dumps(usage)}\n\ndata: [DONE]\n\n".encode())


@pytest.fixture
def fake_llm():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", LLM_PORT), FakeOpenAI)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{LLM_PORT}"
    srv.shutdown()
    srv.server_close()


async def test_llm_inference_end_to_end(tmp_path, fake_llm):
    t = [time.time(), 0]

    def latest() -> Sample:
        t[0] += 0.5
        t[1] += 1
        return sample(t[0], used=(10 + min(t[1], 4)) * 2**30)

    r = make_runner(tmp_path, latest=latest)
    params = {
        "base_url": fake_llm + "/v1",
        "prompt_tokens": 128,
        "max_tokens": 16,
        "concurrency": 2,
        "requests": 4,
    }
    await r.start(req(bench_id="llm-inference", params=params))
    await r.current.task
    st = r.get("r1")
    assert st.status == "succeeded", st.error
    res = {x.metric: x for x in st.results}
    assert {"ttft_p50_ms", "ttft_p95_ms", "prefill_tok_s", "decode_tok_s", "decode_tok_s_total"} <= set(res)
    assert res["ttft_p50_ms"].value >= 50 and res["ttft_p50_ms"].better == "lower"
    assert (
        res["prefill_tok_s"].extras["engine"] == "vllm"
        and res["prefill_tok_s"].extras["model"] == "fake/Model-8B"
    )
    assert res["decode_tok_s"].label == "Decode tokens/s per request"  # engine/model are in extras
    heads = [x.metric for x in st.results if x.extras.get("headline")]
    assert heads == ["decode_tok_s", "ttft_p50_ms", "prefill_tok_s"]
    assert res["prefill_tok_s"].extras["prompt_tokens"] == 130  # from the server's usage block
    assert 50 < res["decode_tok_s"].value < 400
    assert res["mem_used_delta_gib"].value > 0 and res["mem_used_delta_gib"].unit == "GiB"


def test_serving_gpu_mem_falls_back_to_gpu_processes_when_the_pid_is_hidden(monkeypatch):
    """A root/docker vLLM hides its listening pid; NVML still lists its GPU workers."""
    monkeypatch.setattr(jobs.psutil, "net_connections", lambda kind: [])
    s = sample(time.time())
    s.procs = [
        ProcSample(pid=10, name="VLLM::Worker_TP0", cmdline="", rss=1, gpu_mem=90 * GIB, model="Qwen3-8B"),
        ProcSample(pid=11, name="python3", cmdline="", rss=1, gpu_mem=2 * GIB, model=None),
        ProcSample(pid=12, name="bash", cmdline="", rss=1),
    ]
    mem, how = jobs.serving_gpu_mem(8000, s, "Qwen/Qwen3-8B")
    assert mem == 90 * GIB and "with that model" in how and "VLLM::Worker_TP0" in how and "hidden" in how
    mem, how = jobs.serving_gpu_mem(8000, s, "other-model")
    assert mem == 92 * GIB and "on this node" in how
    s.procs = s.procs[2:]
    mem, how = jobs.serving_gpu_mem(8000, s, None)
    assert mem is None and "no GPU compute process" in how


async def test_llm_unreachable_endpoint_problem(tmp_path):
    r = make_runner(tmp_path)
    await r.start(req(bench_id="llm-inference", params={"base_url": f"http://127.0.0.1:{NOTHING_PORT}"}))
    await r.current.task
    st = r.get("r1")
    assert st.status == "failed" and st.error.message == "LLM endpoint unreachable"


async def test_catalog_flags_cpu_smoke_mode_only_where_it_applies(tmp_path):
    r = make_runner(tmp_path, payload_device="cpu")
    notes = {s.id: "SMOKE MODE" in s.description for s in await r.catalog()}
    assert notes == {b: b in ("gpu-matmul", "mem-bandwidth", "thermal-soak") for b in specs.REGISTRY}
    assert not any("SMOKE MODE" in s.description for s in await make_runner(tmp_path).catalog())
