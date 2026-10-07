"""Benchmark runner: one job at a time per node, subprocesses in their own process group, JSON-line payloads.

Lifecycle: ``start`` validates (bench id, run id, role, params, availability) and returns the initial
``NodeBenchState``; the job runs as an asyncio task. Cancel and timeout terminate the process group (SIGTERM,
then SIGKILL after ``kill_grace_s``), force-remove any container the job started, and delete the run's work
directory. State changes are published as {"type":"bench","node_id":..,"run":NodeBenchState}, at most twice
per second, and always immediately on status/ready changes.

Containers carry the labels ``sparkline.bench=<run id>`` and ``sparkline.node=<node id>``. At agent start-up
and before every start, ``sweep`` removes labelled containers and marked work directories that a killed agent
left behind; a start is refused while such a container cannot be removed.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import os
import re
import shutil
import signal
import sys
import time
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ...common.netutil import is_private
from ...common.schema import (
    BenchResult,
    BenchSpec,
    BenchStartRequest,
    NodeBenchState,
    NodeInfo,
    Problem,
    Sample,
)
from . import metadata, probes
from .parsers import parse_json_line
from .specs import REGISTRY, Bench, Params, validation_message

log = logging.getLogger(__name__)

RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
LOG_TAIL = 50
HISTORY = 20
PUBLISH_MIN_S = 0.5
WORK_MARKER = ".sparkline-bench-run"  # marks a run's work dir, so the sweep only ever deletes those
CPU_SMOKE_BENCHES = ("gpu-matmul", "mem-bandwidth", "thermal-soak")  # the payloads that honour --device cpu


class BenchError(Exception):
    def __init__(self, problem: Problem) -> None:
        super().__init__(problem.message)
        self.problem = problem


class Rejected(Exception):
    """Start request refused: HTTP status + Problem."""

    def __init__(self, status: int, problem: Problem) -> None:
        super().__init__(problem.message)
        self.status = status
        self.problem = problem


JobFn = Callable[["Job", Any], Awaitable[None]]


class Job:
    """Context handed to a bench function: progress/results/logging and subprocess helpers."""

    def __init__(
        self, runner: BenchRunner, req: BenchStartRequest, bench: Bench, params: Params, env: probes.Env
    ) -> None:
        self.runner = runner
        self.req = req
        self.bench = bench
        self.params = params
        self.env: probes.Env = env
        self.info: NodeInfo = runner.info()
        self.node_id = runner.node_id
        self.dir = Path(runner.work_dir) / req.run_id
        self.containers: set[str] = set()
        self.docker_killed = False  # a `docker run` CLI was signalled: dockerd may still finish creating it
        self.expect_results = True
        self.payload_error: Problem | None = None
        self.gauges: dict[str, float] = {}  # latest {"gauge": ...} values from the payload
        self.timeout_s = bench.timeout_s(params)
        self.est_s = bench.estimate(params)
        self._log: deque[str] = deque(maxlen=LOG_TAIL)
        self.task: asyncio.Task | None = None
        self.begun = False  # the task has started executing (cancelling before that never reaches it)
        self.cancel_requested = False
        self.state = NodeBenchState(
            run_id=req.run_id,
            bench_id=bench.id,
            node_id=runner.node_id,
            role=req.role,
            status="running",
            phase="Starting",
            started_ts=time.time(),
        )

    # -- state ---------------------------------------------------------------------------------------------
    def changed(self, immediate: bool = False) -> None:
        self.runner._changed(self, immediate)

    def progress(self, p: float, phase: str | None = None) -> None:
        self.state.progress = min(1.0, max(0.0, float(p)))
        if phase is not None:
            self.state.phase = phase[:200]
        self.changed()

    def log(self, line: str) -> None:
        self._log.append(line.rstrip()[:500])
        self.state.log_tail = list(self._log)
        self.changed()

    def add_result(self, **kw: Any) -> None:
        kw.setdefault("node_id", self.node_id)
        if self.runner.payload_device == "cpu" and self.bench.id in CPU_SMOKE_BENCHES:
            # Every result of a CPU smoke run (payload or agent-computed, e.g. soak clocks of an unloaded GPU)
            # is flagged, so it is never compared with a GPU baseline.
            kw["extras"] = {**(kw.get("extras") or {}), "smoke": True}
        self.state.results.append(BenchResult(**kw))
        self.changed()

    def set_ready(self) -> None:
        if not self.state.ready:
            self.state.ready = True
            self.changed(immediate=True)

    def append_series(self, series: dict[str, list[float]]) -> None:
        for k, vals in series.items():
            self.state.series.setdefault(str(k)[:64], []).extend(float(v) for v in vals)
        self.changed()

    def handle(self, msg: dict[str, Any]) -> None:
        """One payload JSON line."""
        if "progress" in msg:
            self.progress(msg["progress"], msg.get("phase"))
        elif "phase" in msg:
            self.progress(self.state.progress, msg["phase"])
        if isinstance(msg.get("result"), dict):
            try:
                self.add_result(**msg["result"])
            except (TypeError, ValidationError) as e:
                self.log(f"invalid result from payload ignored: {e}")
        if isinstance(msg.get("series"), dict):
            self.append_series(msg["series"])
        if isinstance(msg.get("gauge"), dict):
            for k, v in msg["gauge"].items():
                with contextlib.suppress(TypeError, ValueError):
                    self.gauges[str(k)[:64]] = float(v)
        if "log" in msg:
            self.log(str(msg["log"]))
        if msg.get("ready"):
            self.set_ready()
        if isinstance(msg.get("error"), dict):
            err = msg["error"]
            self.payload_error = Problem(
                message=str(err.get("message", "Benchmark failed")),
                cause=str(err.get("cause", "")),
                fix=str(err.get("fix", "")),
            )

    def make_dir(self) -> Path:
        """The run's work directory, created with the marker that lets a later sweep recognise it."""
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / WORK_MARKER).touch()
        return self.dir

    # -- argv builders ---------------------------------------------------------------------------------
    def container_name(self) -> str:
        return f"sparkline-bench-{self.req.run_id}"

    def docker_argv(
        self,
        script: str,
        args: list[str],
        *,
        gpus: bool = True,
        infiniband: bool = False,
        env: dict[str, str] | None = None,
    ) -> list[str]:
        argv = ["docker", "run", "--rm", "--name", self.container_name()]
        argv += ["--label", f"sparkline.bench={self.req.run_id}", "--label", f"sparkline.node={self.node_id}"]
        if gpus:
            argv += ["--gpus", "all"]
        argv += ["--ipc=host", "--ulimit", "memlock=-1", "--network", "host"]
        if infiniband:
            argv += ["--device", "/dev/infiniband"]
        for k, v in {"PYTHONDONTWRITEBYTECODE": "1", **(env or {})}.items():
            argv += ["-e", f"{k}={v}"]
        argv += ["-v", f"{self.runner.payload_dir}:/payloads:ro", self.runner.image]
        return argv + ["python3", "-u", f"/payloads/{script}", "--json", *args]

    def host_argv(self, script: str, args: list[str]) -> list[str]:
        return [self.runner.python, "-u", os.path.join(self.runner.payload_dir, script), "--json", *args]

    # -- subprocesses ----------------------------------------------------------------------------------
    async def run(
        self,
        argv: list[str],
        *,
        check: bool = True,
        ready_port: int | None = None,
    ) -> tuple[int, list[str]]:
        """Run argv (never through a shell) in its own session; JSON lines -> handle(), other lines -> log.

        Returns (exit code, all output lines). Cancellation terminates the whole process group.
        """
        self.make_dir()
        if argv[:2] == ["docker", "run"]:
            self.containers.add(self.container_name())
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                cwd=self.dir,
                env=env,
                limit=2**20,
            )
        except FileNotFoundError as e:
            raise BenchError(
                Problem(
                    message=f"{argv[0]} is not installed on {self.node_id}",
                    cause=str(e),
                    fix=f"Install {argv[0]} on {self.node_id} or check the agent's PATH",
                )
            ) from None
        lines: deque[str] = deque(maxlen=5000)
        watcher = asyncio.create_task(self._watch_port(ready_port, proc)) if ready_port else None
        try:
            assert proc.stdout is not None
            while raw := await proc.stdout.readline():
                line = raw.decode(errors="replace").rstrip("\n")
                lines.append(line)
                msg = parse_json_line(line)
                if msg is not None:
                    self.handle(msg)
                elif line.strip():
                    self.log(line)
            rc = await proc.wait()
        finally:
            if watcher:
                watcher.cancel()
            if await self.runner._terminate(proc) and argv[:2] == ["docker", "run"]:
                self.docker_killed = True
        if check and rc != 0:
            raise BenchError(self.payload_error or self._exit_problem(argv, rc, list(lines)))
        return rc, list(lines)

    async def _watch_port(self, port: int, proc: asyncio.subprocess.Process) -> None:
        while proc.returncode is None:
            if await asyncio.to_thread(probes.port_listening, port):
                self.set_ready()
                return
            await asyncio.sleep(0.2)

    def _exit_problem(self, argv: list[str], rc: int, lines: list[str]) -> Problem:
        text = "\n".join(lines[-40:])
        node, image = self.node_id, self.runner.image
        last = next((ln.strip() for ln in reversed(lines) if ln.strip()), "no output")[:300]
        if "Unable to find image" in text or "No such image" in text or "pull access denied" in text:
            return Problem(
                message=f"Benchmark image not present on {node}",
                cause=f"{image} is not in the local Docker image store",
                fix=f"docker pull {image} on {node}",
            )
        if "could not select device driver" in text or "nvidia-container-cli" in text:
            return Problem(
                message=f"Docker cannot give the container the GPU on {node}",
                cause=last,
                fix=f"Check the NVIDIA Container Toolkit on {node}: `docker run --rm --gpus all {image} "
                "nvidia-smi`",
            )
        if "Cannot connect to the Docker daemon" in text or "permission denied while trying" in text:
            return Problem(
                message=f"Docker is not reachable on {node}",
                cause=last,
                fix="Check `systemctl status docker` and that the agent's user is in the `docker` group",
            )
        if "is already in use by container" in text:
            return Problem(
                message=f"A container named {self.container_name()} already exists on {node}",
                cause=last,
                fix=f"docker rm -f {self.container_name()} on {node}, then run again",
            )
        if "CUDA out of memory" in text or "OutOfMemoryError" in text:
            return Problem(
                message=f"Not enough free GPU memory on {node}",
                cause=last,
                fix="Stop other GPU workloads or choose smaller sizes, then run again",
            )
        return Problem(
            message=f"{self.bench.name} failed on {node}",
            cause=f"{os.path.basename(argv[0])} exited with code {rc}: {last}",
            fix=f"See the log tail; if it keeps failing, check `journalctl -u sparkline-agent` on {node}",
        )

    async def cleanup(self) -> None:
        for name in sorted(self.containers):
            await self.runner._docker_rm(name)
        if self.docker_killed:
            # The CLI died before dockerd finished `create`: the container appears after `rm -f` ran (and
            # --rm never applies to a container that was never started). Remove late arrivals by label.
            await self.runner._remove_late(self.req.run_id)
        self.containers.clear()
        await asyncio.to_thread(shutil.rmtree, self.dir, True)


class BenchRunner:
    def __init__(
        self,
        node_id: str,
        info: Callable[[], NodeInfo],
        latest: Callable[[], Sample | None],
        publish: Callable[[str], None],
        image: str,
        work_dir: str,
        jobs: dict[str, JobFn] | None = None,
        payload_dir: str = metadata.PAYLOAD_DIR,
        python: str = sys.executable,
        docker_sock: str = probes.DOCKER_SOCK,
        kill_grace_s: float = 5.0,
        env_ttl_s: float = 30.0,
        probe: Callable[[], probes.Env] | None = None,
        payload_device: str = "cuda",
        docker: str = "docker",
        late_container_s: float = 3.0,
    ) -> None:
        if jobs is None:
            from .jobs import JOBS

            jobs = JOBS
        self.node_id = node_id
        self.info = info
        self.latest = latest
        self.publish = publish
        self.image = image
        self.work_dir = work_dir
        self.jobs = jobs
        self.payload_dir = payload_dir
        self.python = python
        self.docker_sock = docker_sock
        self.kill_grace_s = kill_grace_s
        self.env_ttl_s = env_ttl_s
        self.payload_device = payload_device  # "cpu" only for code-path smoke tests of GPU payloads
        self.docker = docker  # the CLI used for housekeeping (ps / rm); tests swap in a fake
        self.late_container_s = late_container_s
        self._start_lock = asyncio.Lock()
        self._probe = probe or (
            lambda: probes.probe(self.info(), self.image, self.work_dir, self.docker_sock)
        )
        self._env: tuple[float, probes.Env] | None = None
        self.current: Job | None = None
        self.finished: deque[NodeBenchState] = deque(maxlen=HISTORY)
        self._last_pub = 0.0
        self._pending: asyncio.TimerHandle | None = None

    # -- catalog ---------------------------------------------------------------------------------------
    async def env(self, fresh: bool = False) -> probes.Env:
        now = time.monotonic()
        if fresh or self._env is None or now - self._env[0] > self.env_ttl_s:
            self._env = (now, await asyncio.to_thread(self._probe))
        return self._env[1]

    async def catalog(self) -> list[BenchSpec]:
        env = await self.env()
        out = []
        for b in REGISTRY.values():
            problem, note = probes.availability(b.id, env)
            if self.payload_device == "cpu" and b.id in CPU_SMOKE_BENCHES:
                note = (
                    f"{note} SMOKE MODE: this agent runs GPU payloads on the CPU (bench_payload_device = "
                    '"cpu"); tiny sizes, results are flagged smoke and are not GPU measurements.'
                ).strip()
            out.append(b.spec({self.node_id: problem}, note))
        return out

    # -- lifecycle -------------------------------------------------------------------------------------
    def _reject(self, status: int, message: str, cause: str, fix: str) -> Rejected:
        return Rejected(status, Problem(message=message, cause=cause, fix=fix))

    def _check_role(self, bench: Bench, req: BenchStartRequest) -> None:
        if req.role not in bench.roles:
            raise self._reject(
                422,
                f"{bench.name} cannot run in role '{req.role}'",
                f"Allowed roles: {', '.join(bench.roles)}",
                "Start it from the Sparkline console, which assigns roles",
            )
        if req.peer_ip is not None:
            try:
                ok = is_private(str(ipaddress.ip_address(req.peer_ip)))
            except ValueError:
                ok = False
            if not ok:
                raise self._reject(
                    422,
                    "Peer address refused",
                    f"{req.peer_ip!r} is not a private IP address",
                    "Use the peer's ConnectX-7 rail address",
                )
        if req.peer_port is not None and not 1024 <= req.peer_port <= 65535:
            raise self._reject(
                422, "Peer port refused", f"{req.peer_port} is outside 1024-65535", "Pick 1024-65535"
            )
        if req.role == "client" and req.peer_ip is None:
            raise self._reject(422, "Missing server address", "role 'client' needs peer_ip", "Send peer_ip")
        if req.role == "rank":
            ws = req.world_size
            if ws is None or req.rank is None or not (bench.min_nodes <= ws <= (bench.max_nodes or ws)):
                raise self._reject(
                    422,
                    "Invalid rank",
                    f"rank={req.rank} world_size={ws}",
                    f"world_size must be {bench.min_nodes}",
                )
            if not 0 <= req.rank < ws or (req.rank != 0 and req.peer_ip is None):
                raise self._reject(
                    422,
                    "Invalid rank",
                    f"rank={req.rank} world_size={ws} peer_ip={req.peer_ip}",
                    "Send the master IP",
                )

    async def start(self, req: BenchStartRequest) -> NodeBenchState:
        async with self._start_lock:  # one start at a time: the sweep must not race another start
            return await self._start(req)

    async def _start(self, req: BenchStartRequest) -> NodeBenchState:
        bench = REGISTRY.get(req.bench_id)
        if bench is None or req.bench_id not in self.jobs:
            raise self._reject(
                422, f"Unknown benchmark '{req.bench_id}'", "Not in this agent's registry", "Update the agent"
            )
        if not RUN_ID_RE.match(req.run_id):
            raise self._reject(
                422, "Invalid run id", f"{req.run_id!r}", "Use 1-64 letters, digits, '.', '_' or '-'"
            )
        try:
            params = bench.validate(req.params)
        except ValidationError as e:
            raise self._reject(
                422, f"Invalid parameters for {bench.name}", validation_message(e), "Correct the parameters"
            ) from None
        self._check_role(bench, req)
        if self.current is not None:
            cur = self.current.state
            raise self._reject(
                409,
                f"A benchmark is already running on {self.node_id}",
                f"{cur.bench_id} (run {cur.run_id}) is {cur.status}",
                "Wait for it to finish or cancel it",
            )
        if any(s.run_id == req.run_id for s in self.finished):
            raise self._reject(409, "Run id already used", req.run_id, "Use a new run id")
        left = await self.sweep()
        if left:
            raise self._reject(
                409,
                f"A benchmark container from an earlier run is still on {self.node_id}",
                f"docker could not remove {', '.join(left)}",
                f"Run `docker rm -f {' '.join(left)}` on {self.node_id}, then run again",
            )
        env = await self.env(fresh=True)
        problem, _ = probes.availability(bench.id, env)
        if problem is not None:
            raise Rejected(422, problem)
        await asyncio.to_thread(metadata.suite_hashes)  # cached; the first call runs git
        if self.current is not None:  # re-check after the awaits
            raise self._reject(409, f"A benchmark is already running on {self.node_id}", "", "Wait or cancel")
        job = Job(self, req, bench, params, env)
        docker = "docker" in bench.requires
        job.state.metadata = {
            **metadata.static(job.info, self.image if docker else None, env.image_id if docker else None),
            "params": params.model_dump(),
            "role": req.role,
            "rank": req.rank,
            "world_size": req.world_size,
            "peer_node": req.peer_node,
            "peer_ip": req.peer_ip,
            "timeout_s": job.timeout_s,
            "est_duration_s": round(job.est_s, 1),
            "start": metadata.telemetry(self.latest()),
            "started_ts": job.state.started_ts,
        }
        self.current = job
        job.task = asyncio.create_task(self._execute(job, self.jobs[bench.id]))
        job.changed(immediate=True)
        return job.state.model_copy(deep=True)

    async def _execute(self, job: Job, fn: JobFn) -> None:
        job.begun = True
        status, error = "succeeded", None
        try:
            if job.cancel_requested:
                raise asyncio.CancelledError
            async with asyncio.timeout(job.timeout_s) as tmo:
                try:
                    await fn(job, job.params)
                except TimeoutError:
                    if tmo.expired():
                        raise
                    raise BenchError(
                        Problem(
                            message=f"{job.bench.name} timed out talking to a peer or service",
                            cause="A network operation timed out",
                            fix="Check the peer node and the endpoint, then run again",
                        )
                    ) from None
            if job.expect_results and not job.state.results:
                raise BenchError(
                    job.payload_error
                    or Problem(
                        message=f"{job.bench.name} produced no results on {job.node_id}",
                        cause="The benchmark finished without reporting a measurement",
                        fix="See the log tail for details",
                    )
                )
        except TimeoutError:
            status = "failed"
            error = Problem(
                message=f"{job.bench.name} timed out on {job.node_id}",
                cause=f"Still running after {job.timeout_s:.0f} s (estimate {job.est_s:.0f} s)",
                fix="Check the log tail; another workload may be competing for the GPU or link. "
                "Run again when the node is idle.",
            )
        except asyncio.CancelledError:
            status = "cancelled"
            task = asyncio.current_task()
            if task is not None:
                task.uncancel()
        except BenchError as e:
            status, error = "failed", e.problem
        except Exception as e:
            log.exception("benchmark %s crashed", job.bench.id)
            status = "failed"
            error = Problem(
                message=f"{job.bench.name} crashed on {job.node_id}",
                cause=f"{type(e).__name__}: {e}",
                fix="This is a bug in the agent's benchmark code; the log tail has details",
            )
        finally:
            await self._cleanup(job)
        st = job.state
        st.status = status  # type: ignore[assignment]
        st.error = error
        st.finished_ts = time.time()
        if status == "succeeded":
            st.progress = 1.0
            st.phase = "Done"
        else:
            st.phase = {"cancelled": "Cancelled", "failed": "Failed"}[status]
        st.metadata["end"] = metadata.telemetry(self.latest())
        st.metadata["finished_ts"] = st.finished_ts
        self.finished.appendleft(st)
        self.current = None
        self._changed(job, immediate=True)

    async def _cleanup(self, job: Job) -> None:
        """Run job.cleanup() to the end even if this task is cancelled again meanwhile: the bookkeeping after
        it must always happen, or the node stays 'busy' for good."""
        t = asyncio.ensure_future(job.cleanup())
        while True:
            try:
                await asyncio.shield(t)
                return
            except asyncio.CancelledError:
                cur = asyncio.current_task()
                if cur is not None:
                    cur.uncancel()
                if t.done():
                    return
            except Exception:
                log.exception("benchmark cleanup failed for %s", job.req.run_id)
                return

    async def sweep(self) -> list[str]:
        """Remove bench containers and work directories left by an earlier agent process (e.g. one that was
        OOM-killed mid-run: dockerd keeps its container running). Returns the ids that could not be removed.

        Only called while no job runs (agent start-up, and start() under the start lock)."""
        if self.current is not None:
            return []
        ids = await self._labelled_containers()
        for cid in ids:
            log.warning("removing leftover benchmark container %s", cid)
            await self._docker_rm(cid)
        left = await self._labelled_containers() if ids else []
        work = Path(self.work_dir)
        with contextlib.suppress(OSError):
            for d in work.iterdir():
                if d.is_dir() and not d.is_symlink() and (d / WORK_MARKER).is_file():
                    log.warning("removing leftover benchmark work directory %s", d)
                    await asyncio.to_thread(shutil.rmtree, d, True)
        return left

    async def _labelled_containers(self, run_id: str | None = None) -> list[str]:
        """Ids of this node's bench containers (all, or one run's), in any state. [] if docker is unusable."""
        label = f"sparkline.bench={run_id}" if run_id else "sparkline.bench"
        argv = [self.docker, "ps", "-aq", "--filter", f"label={label}"]
        argv += ["--filter", f"label=sparkline.node={self.node_id}"]
        try:
            p = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(p.communicate(), 30)
        except (OSError, TimeoutError) as e:
            log.debug("docker ps failed: %s", e)
            return []
        return out.decode(errors="replace").split() if p.returncode == 0 else []

    async def _remove_late(self, run_id: str) -> None:
        """After a killed `docker run`, remove the run's container if dockerd creates it within the window."""
        deadline = time.monotonic() + self.late_container_s
        while True:
            for cid in await self._labelled_containers(run_id):
                await self._docker_rm(cid)
            if time.monotonic() >= deadline:
                return
            await asyncio.sleep(0.25)

    def get(self, run_id: str) -> NodeBenchState | None:
        if self.current is not None and self.current.state.run_id == run_id:
            return self.current.state.model_copy(deep=True)
        return next((s for s in self.finished if s.run_id == run_id), None)

    def cancel(self, run_id: str) -> NodeBenchState | None:
        job = self.current
        if job is not None and job.state.run_id == run_id:
            if job.task is not None and not job.task.done() and not job.cancel_requested:
                # Once only: a second CancelledError would land in the SIGTERM grace wait or the cleanup.
                job.state.phase = "Cancelling"
                job.cancel_requested = True
                if job.begun:
                    job.task.cancel()
                job.changed(immediate=True)
            return job.state.model_copy(deep=True)
        return self.get(run_id)

    async def shutdown(self) -> None:
        job = self.current
        if job is not None and job.task is not None:
            self.cancel(job.state.run_id)
            await asyncio.wait({job.task}, timeout=self.kill_grace_s + 15)
        if self._pending:
            self._pending.cancel()

    # -- processes -------------------------------------------------------------------------------------
    async def _terminate(self, proc: asyncio.subprocess.Process) -> bool:
        """SIGTERM the process group, SIGKILL it after the grace period; also reaps stragglers.

        Returns True if the process was still running (it was signalled rather than exiting on its own)."""
        killed = proc.returncode is None
        try:
            if killed:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGTERM)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(proc.wait()), self.kill_grace_s)
        finally:  # even if cancelled during the grace wait: never leave a payload that ignores SIGTERM
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)  # children left in the group (leader may be gone already)
            if proc.returncode is None:
                await proc.wait()
        return killed

    async def _docker_rm(self, name: str) -> None:
        try:
            p = await asyncio.create_subprocess_exec(
                self.docker,
                "rm",
                "-f",
                name,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(p.wait(), 30)
        except (OSError, TimeoutError) as e:
            log.warning("docker rm -f %s failed: %s", name, e)

    # -- publishing ------------------------------------------------------------------------------------
    def _changed(self, job: Job, immediate: bool = False) -> None:
        now = time.monotonic()
        if immediate or now - self._last_pub >= PUBLISH_MIN_S:
            self._publish_now(job)
        elif self._pending is None:
            delay = PUBLISH_MIN_S - (now - self._last_pub)
            self._pending = asyncio.get_running_loop().call_later(delay, self._publish_now, job)

    def _publish_now(self, job: Job) -> None:
        if self._pending is not None:
            self._pending.cancel()
            self._pending = None
        self._last_pub = time.monotonic()
        msg = f'{{"type":"bench","node_id":{json.dumps(self.node_id)},"run":{job.state.model_dump_json()}}}'
        try:
            self.publish(msg)
        except Exception:
            log.exception("publishing bench state failed")
