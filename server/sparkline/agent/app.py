"""sparkline-agent HTTP/WS API."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import time
from collections.abc import Callable
from typing import Annotated

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from ..common.schema import HistoryResponse, NodeInfo, Sample
from .sampler import Sampler

PING_EVERY_S = 15.0


def _token_ok(expected: str, got: str | None) -> bool:
    if not expected:
        return True  # tokenless mode is only allowed on loopback (enforced by main)
    return got is not None and hmac.compare_digest(got.encode(), expected.encode())


def _bearer(header: str | None) -> str | None:
    if header and header[:7].lower() == "bearer ":
        return header[7:].strip()
    return None


def create_app(
    sampler: Sampler, info: Callable[[], NodeInfo], token: str, manage_sampler: bool = True
) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        if manage_sampler:
            sampler.start()
        yield
        if manage_sampler:
            await sampler.stop()

    app = FastAPI(title="sparkline-agent", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def auth(request: Request) -> None:
        if not _token_ok(token, _bearer(request.headers.get("authorization"))):
            raise HTTPException(
                401, "Missing or invalid bearer token", headers={"WWW-Authenticate": "Bearer"}
            )

    @app.get("/healthz")
    async def healthz() -> dict:
        latest = sampler.latest
        return {"ok": True, "node_id": sampler.node_id, "last_sample_ts": latest.ts if latest else None}

    @app.get("/api/v1/info", dependencies=[Depends(auth)])
    async def get_info() -> NodeInfo:
        return info()

    @app.get("/api/v1/snapshot", dependencies=[Depends(auth)], response_model=None)
    async def snapshot() -> Sample | JSONResponse:
        if sampler.latest is None:
            return JSONResponse({"detail": "No sample collected yet"}, status_code=503)
        return sampler.latest

    @app.get("/api/v1/history", dependencies=[Depends(auth)])
    async def history(
        keys: str = "",
        from_: float | None = Query(None, alias="from"),
        to: float | None = None,
        points: int = Query(600, ge=1, le=5000),
    ) -> HistoryResponse:
        key_list = [k for k in (s.strip() for s in keys.split(",")) if k] or None
        if from_ is not None and to is not None and from_ >= to:
            raise HTTPException(400, "'from' must be earlier than 'to'")
        return await sampler.history(key_list, from_, to, points)

    @app.delete("/api/v1/history", dependencies=[Depends(auth)])
    async def delete_history(body: Annotated[dict, Body()]) -> dict:
        if body.get("confirm") != "DELETE":
            raise HTTPException(400, 'Send {"confirm": "DELETE"} to erase all stored history on this node')
        await sampler.clear_history()
        return {"ok": True}

    @app.websocket("/api/v1/stream")
    async def stream(ws: WebSocket) -> None:
        got = _bearer(ws.headers.get("authorization")) or ws.query_params.get("token")
        if not _token_ok(token, got):
            await ws.close(code=1008)  # before accept -> HTTP 403 to the client
            return
        await ws.accept()
        q = sampler.subscribe()

        async def drain() -> None:  # read (and ignore) client messages so disconnects are noticed
            with contextlib.suppress(WebSocketDisconnect):
                while True:
                    await ws.receive_text()

        reader = asyncio.create_task(drain())
        try:
            await ws.send_text('{"type":"hello","info":' + info().model_dump_json() + "}")
            next_ping = time.monotonic() + PING_EVERY_S
            while not reader.done():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=max(0.0, next_ping - time.monotonic()))
                    await ws.send_text(msg)
                except TimeoutError:
                    await ws.send_text(f'{{"type":"ping","ts":{time.time():.3f}}}')
                    next_ping = time.monotonic() + PING_EVERY_S
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            sampler.unsubscribe(q)
            reader.cancel()

    return app
