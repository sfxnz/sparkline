"""sparkline HTTP/WS API (see PLAN.md wire table) and static web serving."""

from __future__ import annotations

import asyncio
import gzip
import hmac
import json
import logging
import mimetypes
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, Query, Request, Response, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import HTTPConnection

from ..common.metrics import flatten
from ..common.schema import (
    AlertRule,
    ClusterState,
    ConsoleSettings,
    Event,
    HistoryResponse,
    NodeState,
    Problem,
)
from ..common.schema import Severity as SeverityT
from .alerts import validate_rules
from .bench import AgentBackend, BenchError, BenchManager
from .bench_routes import bench_router
from .bench_store import BenchStore
from .cluster import VERSION, Cluster
from .config import ConsoleConfig
from .demo import NODES as DEMO_NODES
from .demo import DemoSource, demo_history
from .demo_bench import DemoBench, seed_history
from .hub import Hub
from .nodes import AgentClient, AuthRejected, classify
from .store import SESSION_TTL_S, Store

log = logging.getLogger("sparkline.console.app")
COOKIE = "sparkline_session"
LOGIN_LIMIT = 10  # attempts per minute per client IP

NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Sparkline</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Frontend not built</h1><p>The API is running, but the web app has not been built yet.</p>
<p>Run <code>npm ci &amp;&amp; npm run build</code> in <code>web/</code>, then reload this page.</p></body>"""


class ProblemError(Exception):
    def __init__(
        self, status: int, message: str, cause: str = "", fix: str = "", problem: Problem | None = None
    ):
        super().__init__(message)
        self.status = status
        self.problem = problem or Problem(message=message, cause=cause, fix=fix)


def problem_response(status: int, problem: Problem) -> JSONResponse:
    return JSONResponse({"problem": problem.model_dump()}, status_code=status)


def validate_settings(s: ConsoleSettings) -> None:
    if s.energy_rate_per_kwh < 0:
        raise ValueError("energy_rate_per_kwh must be >= 0")
    if not 1 <= len(s.currency) <= 8:
        raise ValueError("currency must be 1-8 characters")
    if s.stale_after_s <= 0 or s.offline_after_s <= s.stale_after_s:
        raise ValueError("Need 0 < stale_after_s < offline_after_s")
    if not 0 < s.regression_pct < 100:
        raise ValueError("regression_pct must be between 0 and 100")


class LoginBody(BaseModel):
    token: str = Field(max_length=1024)


class ConfirmBody(BaseModel):
    confirm: Literal["DELETE"]


def origin_ok(headers) -> bool:
    """Reject cross-site requests: an Origin header, when present, must match Host."""
    origin = headers.get("origin")
    if origin is None:
        return True
    return urlsplit(origin).netloc.lower() == (headers.get("host") or "").lower()


def create_app(
    cfg: ConsoleConfig,
    data_dir: Path,
    demo: bool = False,
    demo_speed: float = 1.0,
    demo_empty_bench: bool = False,
) -> FastAPI:
    data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(data_dir / "console.sqlite")
    hub = Hub()
    cluster = Cluster(store, hub, cfg.settings, demo=demo)
    if demo:
        t0 = time.time()
        for node_id in DEMO_NODES:
            cluster.add_source(DemoSource(node_id, cluster, t0, demo_speed))
    else:
        for n in cfg.nodes:
            cluster.add_source(AgentClient(n.id, n.url, cluster, cfg.agent_token))
    bench_store = BenchStore(store.db)
    if demo:
        if demo_empty_bench:  # demo DB only: show the empty benchmark state
            bench_store.clear()
        else:
            models = {nid: src.model for nid, src in cluster.sources.items()}
            seed_history(bench_store, models, cluster.settings.regression_pct, store.add_event)
        bench = BenchManager(cluster, bench_store, DemoBench(cluster))
    else:
        bench = BenchManager(cluster, bench_store, AgentBackend(cluster, cfg.agent_token))
    auth_enabled = bool(cfg.token) or not demo
    token = cfg.token.encode()
    login_attempts: dict[str, deque[float]] = {}
    http: dict[str, httpx.AsyncClient] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        http["c"] = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))
        await cluster.start()
        await bench.start()
        try:
            yield
        finally:
            await bench.stop()
            await cluster.stop()
            await http["c"].aclose()
            store.close()

    app = FastAPI(
        title="Sparkline",
        version=VERSION,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.cluster = cluster
    app.state.hub = hub
    app.state.store = store
    app.state.bench = bench

    # -- errors as {"problem": {...}} ----------------------------------------------------------------
    @app.exception_handler(ProblemError)
    async def _problem(_req: Request, exc: ProblemError) -> JSONResponse:
        return problem_response(exc.status, exc.problem)

    @app.exception_handler(BenchError)
    async def _bench(_req: Request, exc: BenchError) -> JSONResponse:
        return problem_response(exc.status, exc.problem)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_req: Request, exc: RequestValidationError) -> JSONResponse:
        errs = "; ".join(f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}" for e in exc.errors()[:5])
        return problem_response(
            422,
            Problem(
                message="Invalid request", cause=errs, fix="Correct the highlighted fields and try again"
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_req: Request, exc: StarletteHTTPException) -> JSONResponse:
        return problem_response(exc.status_code, Problem(message=str(exc.detail), cause="", fix=""))

    # -- auth ---------------------------------------------------------------------------------------
    def attempts(conn: HTTPConnection) -> deque[float]:
        """Sign-in attempts and failed bearer tokens from this client IP in the last minute."""
        now = time.time()
        q = login_attempts.setdefault(conn.client.host if conn.client else "?", deque())
        while q and q[0] < now - 60:
            q.popleft()
        return q

    def too_many() -> ProblemError:
        return ProblemError(
            429,
            "Too many sign-in attempts",
            f"{LOGIN_LIMIT} attempts per minute allowed",
            "Wait a minute and try again",
        )

    def authenticate(conn: HTTPConnection) -> tuple[int, str | None]:
        """(200 | 401 | 429, session id when signed in by cookie). Wrong bearer tokens count as attempts."""
        if not auth_enabled:
            return 200, None
        h = conn.headers.get("authorization", "")
        if h[:7].lower() == "bearer ":
            q = attempts(conn)
            if len(q) >= LOGIN_LIMIT:
                return 429, None
            if hmac.compare_digest(h[7:].strip().encode(), token):
                return 200, None
            q.append(time.time())
        sid = conn.cookies.get(COOKIE)
        if sid and store.session_valid(sid):
            return 200, sid
        return 401, None

    def check_origin(request: Request) -> None:
        if request.method not in ("GET", "HEAD", "OPTIONS") and not origin_ok(request.headers):
            raise ProblemError(
                403,
                "Cross-site request blocked",
                f"Origin {request.headers.get('origin')} does not match this console",
                "Open the console from its own address",
            )

    async def require_auth(request: Request) -> None:
        check_origin(request)
        status, _ = authenticate(request)
        if status == 429:
            raise too_many()
        if status != 200:
            raise ProblemError(
                401,
                "Sign in required",
                "No valid session or bearer token",
                "Sign in with the token from /etc/sparkline/console.toml",
            )

    Auth = [Depends(require_auth)]

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True, "version": VERSION}

    @app.post("/api/v1/auth/login")
    async def login(body: LoginBody, request: Request, response: Response) -> dict:
        check_origin(request)
        q = attempts(request)
        if len(q) >= LOGIN_LIMIT:
            raise too_many()
        q.append(time.time())
        if not auth_enabled:
            return {"ok": True, "auth_required": False}
        if not hmac.compare_digest(body.token.encode(), token):
            raise ProblemError(
                401,
                "Wrong token",
                "The token does not match this console's token",
                "Copy `token` from /etc/sparkline/console.toml on the console host",
            )
        response.set_cookie(
            COOKIE,
            store.create_session(),
            max_age=SESSION_TTL_S,
            httponly=True,
            samesite="strict",
            path="/",
            secure=request.url.scheme == "https",
        )
        return {"ok": True, "auth_required": True}

    @app.post("/api/v1/auth/logout", dependencies=Auth)
    async def logout(request: Request, response: Response) -> dict:
        sid = request.cookies.get(COOKIE)
        if sid:
            store.delete_session(sid)
            for c in list(hub.clients):  # live streams opened with this session stop too
                if c.session == sid:
                    c.kick()
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True}

    @app.get("/api/v1/auth/me", dependencies=Auth)
    async def me() -> dict:
        return {"authenticated": True, "auth_required": auth_enabled, "demo": demo}

    # -- cluster / nodes ----------------------------------------------------------------------------
    def source(node: str):
        src = cluster.sources.get(node)
        if src is None:
            raise ProblemError(
                404,
                f"Unknown node {node!r}",
                "This node is not in the console configuration",
                "Add it under [[nodes]] in /etc/sparkline/console.toml",
            )
        return src

    def require_reachable(src) -> None:
        if src.state.status in ("offline", "error"):
            raise ProblemError(
                503,
                "",
                problem=src.state.error
                or Problem(
                    message=f"{src.node_id} is {src.state.status}",
                    cause="The agent is not connected",
                    fix="Wait for the console to reconnect, or press Retry",
                ),
            )

    @app.get("/api/v1/cluster", dependencies=Auth)
    async def get_cluster() -> ClusterState:
        return cluster.cluster_state()

    @app.post("/api/v1/nodes/{node_id}/retry", dependencies=Auth)
    async def retry(node_id: str) -> NodeState:
        src = source(node_id)
        src.retry_now()
        return src.state

    # -- history / live -----------------------------------------------------------------------------
    @app.get("/api/v1/history", dependencies=Auth)
    async def history(
        node: str,
        keys: str = "",
        from_: Annotated[float | None, Query(alias="from")] = None,
        to: float | None = None,
        points: Annotated[int, Query(ge=1, le=5000)] = 600,
    ):
        src = source(node)
        require_reachable(src)
        to = time.time() if to is None else to
        from_ = to - 3600 if from_ is None else from_
        key_list = [k for k in keys.split(",") if k]
        if demo:  # seconds of CPU for long ranges: keep it off the event loop that feeds live streams
            return await asyncio.to_thread(demo_history, src.model, key_list or None, from_, to, points)
        params = {"keys": keys, "from": from_, "to": to, "points": points}
        try:
            r = await http["c"].get(
                f"{src.url.rstrip('/')}/api/v1/history",
                params=params,
                headers={"Authorization": f"Bearer {cfg.agent_token}"},
            )
        except Exception as e:  # noqa: BLE001
            raise ProblemError(503, "", problem=classify(e, src.node_id, src.url)[1]) from None
        if r.status_code in (401, 403):
            raise ProblemError(
                502, "", problem=classify(AuthRejected(r.status_code), src.node_id, src.url)[1]
            )
        if r.status_code != 200:
            raise ProblemError(
                502,
                f"Agent on {node} could not serve history",
                f"HTTP {r.status_code}: {r.text[:200]}",
                f"Check `journalctl -u sparkline-agent` on {node}",
            )
        try:
            return HistoryResponse.model_validate(r.json())
        except (ValidationError, ValueError) as e:
            raise ProblemError(
                502,
                f"Agent on {node} returned invalid history",
                str(e)[:200],
                "Upgrade sparkline-agent and sparkline to the same release",
            ) from None

    @app.delete("/api/v1/history", dependencies=Auth)
    async def delete_history(node: str, body: ConfirmBody) -> dict:
        src = source(node)
        require_reachable(src)
        if demo:
            return {"ok": True, "demo": True}
        try:
            r = await http["c"].request(
                "DELETE",
                f"{src.url.rstrip('/')}/api/v1/history",
                json=body.model_dump(),
                headers={"Authorization": f"Bearer {cfg.agent_token}"},
            )
        except Exception as e:  # noqa: BLE001
            _, p = classify(e, src.node_id, src.url)
            raise ProblemError(503, "", problem=p) from None
        if r.status_code != 200:
            raise ProblemError(
                502,
                f"Agent on {node} could not clear history",
                f"HTTP {r.status_code}: {r.text[:200]}",
                f"Check `journalctl -u sparkline-agent` on {node}",
            )
        return r.json()

    @app.get("/api/v1/live", dependencies=Auth)
    async def live(
        node: str, seconds: Annotated[float, Query(gt=0, le=900)] = 900, keys: str = ""
    ) -> HistoryResponse:
        src = source(node)
        cutoff = time.time() - seconds
        samples = [s for s in src.ring if s.ts >= cutoff]  # snapshot on the loop: the ring keeps changing
        want = [k for k in keys.split(",") if k]

        def build() -> HistoryResponse:
            flats = [flatten(s) for s in samples]
            names = want or sorted({k for f in flats for k in f})
            return HistoryResponse(
                node_id=node,
                resolution_s=1,
                ts=[s.ts for s in samples],
                series={k: [f.get(k) for f in flats] for k in names},
            )

        return await asyncio.to_thread(build)

    # -- alerts / events / settings -----------------------------------------------------------------
    @app.get("/api/v1/alerts/rules", dependencies=Auth)
    async def get_rules() -> list[AlertRule]:
        return cluster.alerts.rules

    @app.put("/api/v1/alerts/rules", dependencies=Auth)
    async def put_rules(rules: list[AlertRule]) -> list[AlertRule]:
        try:
            validate_rules(rules)
        except ValueError as e:
            raise ProblemError(422, "Invalid alert rules", str(e), "Fix the rule and save again") from None
        cluster.update_rules(rules)
        return rules

    @app.get("/api/v1/events", dependencies=Auth)
    async def events(
        since: float | None = None,
        limit: Annotated[int, Query(ge=1, le=1000)] = 200,
        node: str | None = None,
        severity: SeverityT | None = None,
    ) -> list[Event]:
        return store.list_events(since, limit, node, severity)

    @app.post("/api/v1/events/{event_id}/ack", dependencies=Auth)
    async def ack(event_id: int) -> Event:
        ev = cluster.ack_event(event_id)
        if ev is None:
            raise ProblemError(
                404, f"No event {event_id}", "It may have expired (events are kept 30 days)", ""
            )
        return ev

    @app.get("/api/v1/settings", dependencies=Auth)
    async def get_settings() -> ConsoleSettings:
        return cluster.settings

    @app.put("/api/v1/settings", dependencies=Auth)
    async def put_settings(s: ConsoleSettings) -> ConsoleSettings:
        try:
            validate_settings(s)
        except ValueError as e:
            raise ProblemError(422, "Invalid settings", str(e), "Correct the value and save again") from None
        cluster.update_settings(s)
        return s

    # -- live stream ----------------------------------------------------------------------------------
    @app.websocket("/api/v1/stream")
    async def stream(ws: WebSocket) -> None:
        status, sid = authenticate(ws) if origin_ok(ws.headers) else (403, None)
        if status != 200:
            await ws.close(code=1008)
            return
        await ws.accept()
        client = hub.add(ws, sid)
        try:
            hello = {"type": "hello", "cluster": cluster.cluster_state().model_dump(mode="json")}
            await ws.send_text(json.dumps(hello, separators=(",", ":")))
            for smp in cluster.latest_samples():
                await ws.send_text(
                    f'{{"type":"sample","node_id":{json.dumps(smp.node_id)},"sample":{smp.model_dump_json()}}}'
                )
            tasks = {asyncio.create_task(client.pump()), asyncio.create_task(_drain(ws))}
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for t in done:
                if t.exception() is not None:  # client went away mid-send: normal
                    log.debug("browser stream ended: %r", t.exception())
        finally:
            hub.remove(client)
            if client.overflowed:
                await ws.close(code=1013)
            elif client.kicked:
                await ws.close(code=1008)

    app.include_router(bench_router(bench, Auth))

    # -- static web app (registered last: catch-all) -----------------------------------------------
    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def static(path: str, request: Request):
        if path == "api" or path.startswith("api/"):
            raise ProblemError(404, "Not found", f"No API endpoint /{path}", "")
        dist = cfg.web_dist.resolve()
        index = dist / "index.html"
        if not index.is_file():
            return HTMLResponse(NOT_BUILT, headers={"Cache-Control": "no-cache"})
        if path:
            f = (dist / path).resolve()
            if f.is_relative_to(dist) and f.is_file():
                hashed = f.relative_to(dist).parts[0] == "assets"
                cache = "public, max-age=31536000, immutable" if hashed else "no-cache"
                return _static_file(f, request, cache)
            if path.startswith("assets/"):
                raise ProblemError(404, "Not found", f"/{path} is not part of this build", "Reload the page")
        return _static_file(index, request, "no-cache")

    return app


_COMPRESSIBLE = {".js", ".css", ".html", ".svg", ".json", ".map", ".txt", ".webmanifest"}
_gz_cache: dict[Path, tuple[float, bytes]] = {}


def _static_file(f: Path, request: Request, cache_control: str) -> Response:
    """A web-app file, gzip-compressed (once per build file, kept in memory) for clients that accept it:
    the initial JS is ~3x smaller on the wire. Other files and clients get the plain file."""
    headers = {"Cache-Control": cache_control}
    if f.suffix not in _COMPRESSIBLE:
        return FileResponse(f, headers=headers)
    headers["Vary"] = "Accept-Encoding"
    if "gzip" not in request.headers.get("accept-encoding", ""):
        return FileResponse(f, headers=headers)
    mtime = f.stat().st_mtime
    hit = _gz_cache.get(f)
    if hit is None or hit[0] != mtime:
        hit = (mtime, gzip.compress(f.read_bytes(), compresslevel=6, mtime=0))
        _gz_cache[f] = hit
    media = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if media.startswith("text/") or media == "application/javascript":
        media += "; charset=utf-8"
    return Response(hit[1], media_type=media, headers={**headers, "Content-Encoding": "gzip"})


async def _drain(ws: WebSocket) -> None:
    """Read (and ignore) client messages until the socket closes."""
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
