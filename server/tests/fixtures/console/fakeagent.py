"""Minimal fake sparkline-agent (FastAPI) speaking the agent wire protocol, plus a uvicorn-in-a-thread helper.

Independent of sparkline.agent on purpose: the console is tested against the contract.
"""

from __future__ import annotations

import asyncio
import copy
import json
import threading
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket
from fastapi.responses import JSONResponse

HERE = Path(__file__).parent
INFO = json.loads((HERE / "node_info.json").read_text())
SAMPLE = json.loads((HERE / "sample.json").read_text())


BENCH_SPECS: list[dict[str, Any]] = [
    {
        "id": "gpu-matmul",
        "name": "GPU matmul",
        "category": "compute",
        "description": "Dense GEMM",
        "est_duration_s": 90,
        "impact": {"thermal": "high", "power": "high", "disruptive": True, "note": "Busy GPU"},
        "params": [
            {"name": "size", "label": "Size", "type": "enum", "default": "8192", "choices": ["4096", "8192"]},
            {
                "name": "iterations",
                "label": "Iterations",
                "type": "int",
                "default": 50,
                "min": 10,
                "max": 500,
            },
        ],
        "min_nodes": 1,
        "max_nodes": 1,  # as the real agent says; the console still runs it on several nodes at once
    },
    {
        "id": "rdma-bw-lat",
        "name": "RDMA",
        "category": "interconnect",
        "description": "perftest",
        "est_duration_s": 40,
        "impact": {"thermal": "low", "power": "low", "disruptive": True, "note": "Fills a rail"},
        "params": [{"name": "rail", "label": "Rail", "type": "enum", "default": "A", "choices": ["A", "B"]}],
        "min_nodes": 2,
        "max_nodes": 2,
        "requires": ["perftest"],
    },
    {
        "id": "nccl-allreduce",
        "name": "NCCL all-reduce",
        "category": "interconnect",
        "description": "all_reduce",
        "est_duration_s": 120,
        "impact": {"thermal": "medium", "power": "medium", "disruptive": True, "note": "Fills the rails"},
        "params": [],
        "min_nodes": 2,
        "max_nodes": 2,
    },
    {
        "id": "storage-fio",
        "name": "Storage",
        "category": "storage",
        "description": "fio",
        "est_duration_s": 60,
        "impact": {"thermal": "low", "power": "low", "disruptive": False, "note": "Disk I/O"},
        "params": [],
        "min_nodes": 1,
        "max_nodes": None,
        "unavailable": True,  # stripped; availability gets a Problem
    },
]


def bench_defaults() -> dict[str, Any]:
    """Per-agent knobs for the fake bench runner (app.state.bench)."""
    return {
        "duration": 1.0,  # seconds of "running"
        "steps": 10,
        "value": 100.0,  # result value
        "fail": False,  # fail at the end instead of succeeding
        "reject": None,  # None | 409 | 422: answer POST /runs with this
        "ignore_cancel": False,  # accept cancel but keep running
        "stream": True,  # push "bench" messages on the stream (else only GET reveals progress)
        "ready_delay": 0.3,  # server role: seconds before ready=true
    }


def make_fake_agent(token: str, interval: float = 0.2, info: dict | None = None) -> FastAPI:
    app = FastAPI()
    app.state.paused = False
    app.state.ts_offset = 0.0  # simulated agent clock skew
    app.state.deleted = 0
    app.state.connections = 0
    info_doc = info or INFO
    app.state.bench = bench_defaults()
    app.state.bench_runs: dict[str, dict] = {}  # run_id -> NodeBenchState (dict)
    app.state.bench_tasks: dict[str, asyncio.Task] = {}
    app.state.bench_starts: list[tuple[float, dict]] = []  # (time, BenchStartRequest) as received
    app.state.bench_cancels: list[str] = []
    app.state.bench_queues: set[asyncio.Queue] = set()

    def authed(headers, query) -> bool:
        return headers.get("authorization") == f"Bearer {token}" or query.get("token") == token

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True}

    @app.get("/api/v1/history")
    async def history(request: Request):
        if not authed(request.headers, request.query_params):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        keys = [k for k in request.query_params.get("keys", "").split(",") if k]
        now = time.time()
        return {
            "node_id": INFO["node_id"],
            "resolution_s": 10,
            "ts": [now - 20, now - 10],
            "series": {k: [1.0, 2.0] for k in keys},
        }

    @app.delete("/api/v1/history")
    async def delete_history(request: Request):
        if not authed(request.headers, request.query_params):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        body = await request.json()
        if body.get("confirm") != "DELETE":
            return JSONResponse({"detail": "confirm"}, status_code=400)
        app.state.deleted += 1
        return {"ok": True}

    def push(rid: str) -> None:
        if not app.state.bench["stream"]:
            return
        msg = json.dumps({"type": "bench", "node_id": info_doc["node_id"], "run": app.state.bench_runs[rid]})
        for q in app.state.bench_queues:
            q.put_nowait(msg)

    async def runner(rid: str) -> None:
        st, cfg = app.state.bench_runs[rid], app.state.bench
        try:
            if st["role"] == "server":
                await asyncio.sleep(cfg["ready_delay"])
                st.update(ready=True, phase="Listening")
                push(rid)
            for i in range(cfg["steps"]):
                await asyncio.sleep(cfg["duration"] / cfg["steps"])
                st.update(progress=(i + 1) / cfg["steps"], phase=f"Step {i + 1}")
                push(rid)
            if cfg["fail"]:
                problem = {"message": "GEMM crashed", "cause": "CUDA error: illegal address", "fix": "Retry"}
                st.update(status="failed", error=problem)
            else:
                st.update(
                    status="succeeded",
                    results=[]
                    if st["role"] == "server"
                    else [{"metric": "score", "label": "Score", "value": cfg["value"], "unit": "pts"}],
                    series={"curve": [1.0, 2.0, 3.0]},
                    metadata={"driver": "580.173.02", "cuda": "13.0", "suite_git": "abc1234"},
                    log_tail=["done"],
                )
        except asyncio.CancelledError:
            st.update(status="cancelled", phase="Cancelled")
        st["finished_ts"] = time.time()
        push(rid)

    def bench_auth(request: Request) -> JSONResponse | None:
        if not authed(request.headers, request.query_params):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return None

    @app.get("/api/v1/bench/catalog")
    async def bench_catalog(request: Request):
        if (denied := bench_auth(request)) is not None:
            return denied
        out = []
        for spec in copy.deepcopy(BENCH_SPECS):
            off = spec.pop("unavailable", False)
            problem = {"message": "fio missing", "cause": "not installed", "fix": "apt install fio"}
            spec["availability"] = {info_doc["node_id"]: problem if off else None}
            out.append(spec)
        return out

    @app.post("/api/v1/bench/runs")
    async def bench_start(request: Request):
        if (denied := bench_auth(request)) is not None:
            return denied
        req = await request.json()
        app.state.bench_starts.append((time.time(), req))
        reject = app.state.bench["reject"]
        busy = any(r["status"] == "running" for r in app.state.bench_runs.values())
        if reject == 409 or busy:
            problem = {"message": "Busy", "cause": "A benchmark is already running", "fix": "Wait"}
            return JSONResponse({"problem": problem}, status_code=409)
        if reject == 422:
            problem = {"message": "Invalid parameters", "cause": "size: not allowed", "fix": "Fix it"}
            return JSONResponse({"problem": problem}, status_code=422)
        rid = req["run_id"]
        app.state.bench_runs[rid] = {
            "run_id": rid,
            "bench_id": req["bench_id"],
            "node_id": info_doc["node_id"],
            "role": req.get("role", "single"),
            "status": "running",
            "progress": 0.0,
            "phase": "Starting",
            "ready": False,
            "started_ts": time.time(),
        }
        app.state.bench_tasks[rid] = asyncio.create_task(runner(rid))
        return JSONResponse(app.state.bench_runs[rid], status_code=202)

    @app.get("/api/v1/bench/runs/{rid}")
    async def bench_get(rid: str, request: Request):
        if (denied := bench_auth(request)) is not None:
            return denied
        if rid not in app.state.bench_runs:
            return JSONResponse(
                {"problem": {"message": "No such run", "cause": "", "fix": ""}}, status_code=404
            )
        return app.state.bench_runs[rid]

    @app.post("/api/v1/bench/runs/{rid}/cancel")
    async def bench_cancel(rid: str, request: Request):
        if (denied := bench_auth(request)) is not None:
            return denied
        app.state.bench_cancels.append(rid)
        task = app.state.bench_tasks.get(rid)
        if task is None:
            return JSONResponse(
                {"problem": {"message": "No such run", "cause": "", "fix": ""}}, status_code=404
            )
        if not app.state.bench["ignore_cancel"]:
            task.cancel()
        return JSONResponse({"ok": True}, status_code=202)

    @app.websocket("/api/v1/stream")
    async def stream(ws: WebSocket) -> None:
        if not authed(ws.headers, ws.query_params):
            await ws.send_denial_response(Response(status_code=401))
            return
        await ws.accept()
        app.state.connections += 1
        info = dict(info_doc, sample_interval_ms=round(interval * 1000))
        await ws.send_text(json.dumps({"type": "hello", "info": info}))
        queue: asyncio.Queue = asyncio.Queue()
        app.state.bench_queues.add(queue)
        seq = 0
        next_t = time.time() + interval
        try:
            while True:
                try:  # bench messages as they happen, samples every interval
                    msg = await asyncio.wait_for(queue.get(), max(0.0, next_t - time.time()))
                    await ws.send_text(msg)
                    continue
                except TimeoutError:
                    pass
                next_t += interval
                if app.state.paused:
                    continue
                seq += 1
                s = dict(
                    SAMPLE, ts=time.time() + app.state.ts_offset, seq=seq, interval_ms=round(interval * 1000)
                )
                await ws.send_text(json.dumps({"type": "sample", "node_id": INFO["node_id"], "sample": s}))
        finally:
            app.state.bench_queues.discard(queue)

    return app


class ServerThread:
    """Run a uvicorn server on its own event loop in a daemon thread."""

    def __init__(self, app, port: int):
        self.app = app
        self.port = port
        self.loop: asyncio.AbstractEventLoop | None = None
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> ServerThread:
        self.server = uvicorn.Server(
            uvicorn.Config(
                self.app,
                host="127.0.0.1",
                port=self.port,
                log_level="warning",
                timeout_graceful_shutdown=1,
                lifespan="on",
            )
        )

        def run() -> None:
            self.loop = asyncio.new_event_loop()
            self.loop.run_until_complete(self.server.serve())
            self.loop.close()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            if time.time() > deadline or not self.thread.is_alive():
                raise RuntimeError(f"server on port {self.port} did not start")
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        if self.server and self.thread:
            self.server.should_exit = True
            self.thread.join(10)
            assert not self.thread.is_alive(), f"server on port {self.port} did not stop"

    def call(self, coro, timeout: float = 30):
        """Run a coroutine on the server's loop and wait for its result."""
        assert self.loop is not None
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)
