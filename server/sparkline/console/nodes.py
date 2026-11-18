"""Node sources: one interface (NodeSource) for real agents (AgentClient) and demo nodes (DemoSource).

A source owns its NodeState + recent-sample ring and runs a connect/stream/backoff loop. Subclasses only
implement ``session()``: connect, call ``got_hello``/``got_sample`` as data arrives, raise on failure.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import json
import logging
import random
import socket
import time
from collections import deque
from collections.abc import Callable
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from ..common.metrics import flatten
from ..common.ring import SampleRing
from ..common.schema import (
    SCHEMA_VERSION,
    NodeBenchState,
    NodeInfo,
    NodeState,
    NodeStatus,
    Problem,
    ProcSample,
    Sample,
)

log = logging.getLogger("sparkline.console.nodes")

BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 30.0
BACKOFF_NEW_CAP_S = 5.0  # a node that has never answered: someone is setting it up and watching the page
BACKOFF_TURNED_AWAY_CAP_S = 10.0  # ...and whose agent turned the console away: leaves tries for "Retry"
# The agent counts the wrong tokens a client IP sent in the last minute and, once it holds FAIL_LIMIT of them
# (agent/app.py token_check), turns every request away without looking at its token. The console sends at
# most one fewer in a minute and a second, so every answer it gets is a check of its token.
WRONG_TOKEN_TRIES = 9
WRONG_TOKEN_WINDOW_S = 61.0
RING_S = 900.0
SKEW_WARN_S = 5.0


class Listener(Protocol):
    def on_hello(self, src: NodeSource) -> None: ...
    def on_sample(self, src: NodeSource, s: Sample) -> None: ...
    def on_status(self, src: NodeSource, old: NodeState) -> None: ...


class StreamClosed(Exception):
    """The agent closed the stream (or it ended)."""


class AuthRejected(Exception):
    def __init__(self, status: int):
        super().__init__(f"HTTP {status}")
        self.status = status


class HandshakeTimeout(Exception):
    """TCP connected, but the agent never answered the WebSocket handshake."""


class SchemaMismatch(Exception):
    def __init__(self, version: object):
        super().__init__(f"schema_version {version}")
        self.version = version


def _host_port(url: str) -> tuple[str, int]:
    u = urlsplit(url)
    return u.hostname or url, u.port or 9750


def http_status(exc: BaseException) -> int | None:
    """The HTTP status the agent answered a request with, when that is why it failed."""
    if isinstance(exc, AuthRejected):
        return exc.status
    return getattr(getattr(exc, "response", None), "status_code", None)  # websockets InvalidStatus


def classify(exc: BaseException, node: str, url: str, new: bool = False) -> tuple[NodeStatus, Problem]:
    """Map a connection failure to a status and a human Problem (message, likely cause, concrete fix).

    A fix is what to do, in the order to do it, one step per sentence, each ending with a full stop. A step
    that has something to run ends in it, after a colon and in backticks ("Start the agent on spark2: `sudo
    systemctl start sparkline-agent`."): the web shows the words, and the command in a box of its own with a
    copy button. Keys and paths are single words in backticks. The console reads its config once, at start,
    so a fix that edits ``console.toml`` ends with the restart. ``new``: the node has never answered this
    console, so its agent may not be installed yet."""
    host, port = _host_port(url)
    console_toml = "`/etc/sparkline/console.toml`"
    restart_console = "restart the console: `sudo systemctl restart sparkline`."
    agent_log = f"read the agent’s log on {node}: `journalctl -u sparkline-agent -n 50`."
    status = http_status(exc)
    if status in (401, 403):
        return "error", Problem(
            message=f"Agent on {node} rejected the console’s token",
            cause=f"HTTP {status} from {host}:{port}: agent token mismatch",
            fix=(
                f"`agent_token` in {console_toml} must equal `token` in `/etc/sparkline/agent.toml` on "
                f"{node}. See both, on the console host and on {node}: `sudo grep token "
                f"/etc/sparkline/*.toml`. Edit one file so they match, then restart its service. For the "
                f"console: `sudo systemctl restart sparkline`. For the agent on {node}: `sudo systemctl "
                f"restart sparkline-agent`."
            ),
        )
    if status is not None:
        return "error", Problem(
            message=f"Agent on {node} refused the stream",
            cause=f"HTTP {status} from {host}:{port}",
            fix=(
                f"Check that {node}’s `url` in {console_toml} points at sparkline-agent (port 9750). "
                f"After editing it, {restart_console}"
            ),
        )
    if isinstance(exc, SchemaMismatch):
        return "error", Problem(
            message=f"Agent on {node} speaks a different protocol version",
            cause=f"Agent schema_version {exc.version}, console expects {SCHEMA_VERSION}",
            fix=f"Bring the console and {node} to one release, on the console host: `sudo sparkline update`.",
        )
    if isinstance(exc, socket.gaierror):
        return "offline", Problem(
            message=f"Cannot resolve {host}",
            cause=f"DNS lookup for {host} failed ({exc.strerror or exc})",
            fix=(
                f"Use {node}’s IP address as its `url` in {console_toml}, or fix name resolution "
                f"(`/etc/hosts`). After editing `console.toml`, {restart_console}"
            ),
        )
    text = str(exc).lower()
    if isinstance(exc, ConnectionRefusedError) or "refused" in text or "connect call failed" in text:
        install = (
            f" If the agent was never installed on {node}, install it from the Sparkline folder there: "
            "`sudo ./install.sh agent`."
        )
        return "offline", Problem(
            message=f"Agent unreachable on {node}",
            cause=f"Connection refused at {host}:{port}",
            fix=(
                f"Start the agent on {node}: `sudo systemctl start sparkline-agent`. If it does not stay "
                f"up, read why: `journalctl -u sparkline-agent -n 50`.{install if new else ''}"
            ),
        )
    if isinstance(exc, HandshakeTimeout | httpx.ReadTimeout):
        return "offline", Problem(
            message=f"Agent on {node} is not answering",
            cause=f"{host}:{port} accepted the connection but did not answer (agent hung or overloaded)",
            fix=(
                f"The console retries by itself. See what the agent on {node} is doing: `systemctl status "
                f"sparkline-agent`. If it keeps happening, {agent_log}"
            ),
        )
    no_route = isinstance(exc, OSError) and exc.errno in (
        errno.EHOSTUNREACH,
        errno.ENETUNREACH,
        errno.ETIMEDOUT,
    )
    if isinstance(exc, TimeoutError | httpx.ConnectTimeout) or no_route:
        unreachable = isinstance(exc, OSError) and exc.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH)
        why = "no route to host" if unreachable else "timed out"
        return "offline", Problem(
            message=f"Agent unreachable on {node}",
            cause=f"No response from {host}:{port} ({why}): a network problem",
            fix=(
                f"Check that {node} is powered on and connected to the LAN, that {host} is still its IP, "
                f"and that no firewall blocks port {port}. For the address its agent listens on, "
                f"{agent_log}"
            ),
        )
    if "keepalive ping timeout" in text:
        return "offline", Problem(
            message=f"Agent on {node} stopped responding",
            cause="The connection stayed open but the agent stopped answering keepalive pings "
            "(hung or overloaded)",
            fix=f"The console reconnects by itself. If it keeps happening, {agent_log}",
        )
    if type(exc).__name__ == "InvalidMessage":  # websockets: TCP accepted, connection closed before any reply
        return "offline", Problem(
            message=f"Agent on {node} is not answering",
            cause=f"{host}:{port} accepted the connection but closed it without replying (agent starting, "
            "stopping or hung)",
            fix=f"The console retries by itself. If it keeps happening, {agent_log}",
        )
    closed = isinstance(exc, StreamClosed | ConnectionError) or type(exc).__name__.startswith(
        "ConnectionClosed"
    )
    if closed:
        return "offline", Problem(
            message=f"Lost connection to agent on {node}",
            cause=f"Connection closed ({exc or 'no reason given'})",
            fix=(
                f"The agent may have restarted, and the console reconnects by itself. If this repeats, "
                f"{agent_log}"
            ),
        )
    return "error", Problem(
        message=f"Cannot read from agent on {node}",
        cause=f"{type(exc).__name__}: {exc}",
        fix=(
            f"First, {agent_log} Then read the console’s log on the console host: `journalctl -u sparkline "
            "-n 50`."
        ),
    )


class NodeSource:
    def __init__(self, node_id: str, url: str, listener: Listener):
        self.node_id = node_id
        self.url = url
        self.listener = listener
        self.state = NodeState(node_id=node_id, url=url, status="connecting", since=time.time())
        self.ring = SampleRing(RING_S, int(RING_S * 4))  # bounded even at 250 ms intervals
        self._latest: Sample | None = None
        self._procs: tuple[int, list[ProcSample]] | None = None
        self._attempt = 0
        self._next_try = 0.0
        # when the agent refused this console's token, oldest first
        self._turned_away: deque[float] = deque(maxlen=WRONG_TOKEN_TRIES)
        self.connected_at: float | None = None  # when the current session connected; None between sessions
        self._skew_warned = False
        self._wake = asyncio.Event()
        self._session_task: asyncio.Task | None = None
        self.on_bench: Callable[[str, NodeBenchState], None] | None = None  # set by the bench manager

    # -- implemented by subclasses ------------------------------------------------------------------
    async def session(self) -> None:
        """Connect and stream until failure (raise) or end of stream (return)."""
        raise NotImplementedError

    # -- data from the session ----------------------------------------------------------------------
    def got_hello(self, info: NodeInfo) -> None:
        info = info.model_copy(update={"node_id": self.node_id})
        self.connected_at = time.time()
        self.state = self.state.model_copy(update={"info": info, "next_retry_ts": None})  # connected
        self.listener.on_hello(self)

    def got_sample(self, s: Sample) -> None:
        if s.node_id != self.node_id:
            s = s.model_copy(update={"node_id": self.node_id})
        arrival = self.ring.add(s.ts, flatten(s))
        self._latest = s
        if s.procs is not None:
            self._procs = (arrival, s.procs)
        self._attempt = 0
        now = time.time()
        self.state.last_sample_ts = now  # console clock: the watchdog must not depend on the agent's clock
        if abs(s.ts - now) > SKEW_WARN_S and not self._skew_warned:
            self._skew_warned = True
            log.warning("%s: agent clock is %+.0f s off the console's; check NTP", self.node_id, s.ts - now)
        if self.state.status != "online":
            self.set_status("online", None, None)
        self.listener.on_sample(self, s)

    def latest_sample(self) -> Sample | None:
        """The newest sample, carrying the last process list while the sample that brought it is still in
        the ring."""
        s, procs = self._latest, self._procs
        if s is None or s.procs is not None or procs is None or not self.ring.holds(procs[0]):
            return s
        return s.model_copy(update={"procs": procs[1]})

    def got_bench(self, st: NodeBenchState) -> None:
        if self.on_bench is not None:
            self.on_bench(self.node_id, st)

    # -- status machine -----------------------------------------------------------------------------
    def set_status(self, status: NodeStatus, problem: Problem | None, next_retry_ts: float | None) -> None:
        old = self.state
        changed_status = status != old.status
        if not changed_status and problem == old.error and next_retry_ts == old.next_retry_ts:
            return
        self.state = old.model_copy(
            update={
                "status": status,
                "error": problem,
                "next_retry_ts": next_retry_ts,
                "since": time.time() if changed_status else old.since,
            }
        )
        if changed_status:
            log.info(
                "%s: %s -> %s%s", self.node_id, old.status, status, f" ({problem.cause})" if problem else ""
            )
        self.listener.on_status(self, old)

    def force_reconnect(self, status: NodeStatus, problem: Problem) -> None:
        """Watchdog/retry: drop the current session (if any) and reconnect with backoff."""
        self.set_status(status, problem, None)
        if self._session_task and not self._session_task.done():
            self._session_task.cancel()

    def _room_at(self) -> float:
        """The earliest time a try is not the wrong token that fills the agent's limit."""
        q = self._turned_away
        return q[0] + WRONG_TOKEN_WINDOW_S if len(q) == q.maxlen else 0.0

    def retry_now(self) -> None:
        """One try, at once or as soon as the agent's limit has room for it, and the state says which: no
        time for the next try, or that time. A try that is under way is that try. The doubling goes on."""
        task = self._session_task
        if self.state.status == "online" or task is None:
            return
        if not task.done():
            if self.connected_at is not None:  # a stream that is open and silent: start over
                task.cancel()
            return
        now = time.time()
        self._next_try = max(now, self._room_at())
        self.set_status(self.state.status, self.state.error, self._next_try if self._next_try > now else None)
        self._wake.set()

    def backoff_delay(self, status: NodeStatus) -> float:
        """The wait before the next try, after one that ended in ``status``: doubling, up to 30 s for a node
        that has answered before. Until a node's first answer the wait stays short, so starting its agent
        shows on the page within seconds."""
        if self.state.first_seen is not None:
            cap = BACKOFF_CAP_S
        else:
            cap = BACKOFF_TURNED_AWAY_CAP_S if status == "error" else BACKOFF_NEW_CAP_S
        return min(cap, BACKOFF_BASE_S * 2 ** min(self._attempt, 10) * random.uniform(0.8, 1.2))

    async def run(self) -> None:
        while True:
            self._session_task = asyncio.create_task(self.session())
            failure: BaseException | None = None
            try:
                await self._session_task
                failure = StreamClosed("agent ended the stream")
            except asyncio.CancelledError:
                me = asyncio.current_task()
                if me is not None and me.cancelling():
                    self._session_task.cancel()
                    raise
                # cancelled by force_reconnect/retry_now: status already set
            except Exception as e:  # noqa: BLE001 - a node must never crash the console
                failure = e
            self.connected_at = None
            status, problem = self.state.status, self.state.error
            if failure is not None:
                status, problem = classify(failure, self.node_id, self.url, self.state.first_seen is None)
                log.debug("%s: session failed: %r", self.node_id, failure)
                if http_status(failure) in (401, 403):
                    self._turned_away.append(time.time())
            self._next_try = max(time.time() + self.backoff_delay(status), self._room_at())
            self._wake.clear()
            self.set_status(status, problem, self._next_try)
            while (wait := self._next_try - time.time()) > 0:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), wait)
                self._wake.clear()
            self._attempt += 1


class AgentClient(NodeSource):
    def __init__(self, node_id: str, url: str, listener: Listener, agent_token: str):
        super().__init__(node_id, url, listener)
        self.agent_token = agent_token
        u = urlsplit(url.rstrip("/"))
        self.ws_url = f"{'wss' if u.scheme == 'https' else 'ws'}://{u.netloc}{u.path}/api/v1/stream"

    async def session(self) -> None:
        from websockets.asyncio.client import ClientConnection, connect

        tcp_up = False

        class Conn(ClientConnection):
            def connection_made(self, transport: asyncio.BaseTransport) -> None:  # TCP connected
                nonlocal tcp_up
                tcp_up = True
                super().connection_made(transport)

        headers = {"Authorization": f"Bearer {self.agent_token}"}
        try:
            ws = await connect(
                self.ws_url,
                additional_headers=headers,
                open_timeout=10,
                max_size=1 << 23,
                ping_interval=20,
                ping_timeout=20,
                create_connection=Conn,
            )
        except TimeoutError:
            if tcp_up:
                raise HandshakeTimeout() from None
            raise
        self.connected_at = time.time()
        async with ws:
            async for raw in ws:
                msg = json.loads(raw)
                kind = msg.get("type")
                try:
                    if kind == "hello":
                        version = (msg.get("info") or {}).get("schema_version")
                        if version != SCHEMA_VERSION:
                            raise SchemaMismatch(version)
                        self.got_hello(NodeInfo.model_validate(msg["info"]))
                    elif kind == "sample":
                        self.got_sample(Sample.model_validate(msg["sample"]))
                    elif kind == "bench":
                        self.got_bench(NodeBenchState.model_validate(msg["run"]))
                except ValidationError as e:
                    log.warning("%s: invalid %s message skipped: %s", self.node_id, kind, e.errors()[:2])
            raise StreamClosed(f"code {ws.close_code}")
