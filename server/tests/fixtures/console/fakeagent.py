"""Minimal fake sparkline-agent (FastAPI) speaking the agent wire protocol, plus a uvicorn-in-a-thread helper.

Independent of sparkline.agent on purpose: the console is tested against the contract.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket
from fastapi.responses import JSONResponse

HERE = Path(__file__).parent
INFO = json.loads((HERE / "node_info.json").read_text())
SAMPLE = json.loads((HERE / "sample.json").read_text())


def make_fake_agent(token: str, interval: float = 0.2) -> FastAPI:
    app = FastAPI()
    app.state.paused = False
    app.state.ts_offset = 0.0  # simulated agent clock skew
    app.state.deleted = 0
    app.state.connections = 0

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

    @app.websocket("/api/v1/stream")
    async def stream(ws: WebSocket) -> None:
        if not authed(ws.headers, ws.query_params):
            await ws.send_denial_response(Response(status_code=401))
            return
        await ws.accept()
        app.state.connections += 1
        info = dict(INFO, sample_interval_ms=round(interval * 1000))
        await ws.send_text(json.dumps({"type": "hello", "info": info}))
        seq = 0
        while True:
            await asyncio.sleep(interval)
            if app.state.paused:
                continue
            seq += 1
            s = dict(
                SAMPLE, ts=time.time() + app.state.ts_offset, seq=seq, interval_ms=round(interval * 1000)
            )
            await ws.send_text(json.dumps({"type": "sample", "node_id": INFO["node_id"], "sample": s}))

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
