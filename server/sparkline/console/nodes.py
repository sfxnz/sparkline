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

from ..common.schema import (
    SCHEMA_VERSION,
    NodeBenchState,
    NodeInfo,
    NodeState,
    NodeStatus,
    Problem,
    Sample,
)

log = logging.getLogger("sparkline.console.nodes")

BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 30.0
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


def classify(exc: BaseException, node: str, url: str) -> tuple[NodeStatus, Problem]:
    """Map a connection failure to a status and a human Problem (message, likely cause, concrete fix)."""
    host, port = _host_port(url)
    systemctl = f"Check `systemctl status sparkline-agent` on {node}"
    status = getattr(getattr(exc, "response", None), "status_code", None)  # websockets InvalidStatus
    if isinstance(exc, AuthRejected):
        status = exc.status
    if status in (401, 403):
        return "error", Problem(
            message=f"Agent on {node} rejected the console's token",
            cause=f"HTTP {status} from {host}:{port}: agent token mismatch",
            fix=(
                "agent_token in /etc/sparkline/console.toml must match token in "
                f"/etc/sparkline/agent.toml on {node}"
            ),
        )
    if status is not None:
        return "error", Problem(
            message=f"Agent on {node} refused the stream",
            cause=f"HTTP {status} from {host}:{port}",
            fix=f"Check that {node}'s url in console.toml points at sparkline-agent (port 9750)",
        )
    if isinstance(exc, SchemaMismatch):
        return "error", Problem(
            message=f"Agent on {node} speaks a different protocol version",
            cause=f"Agent schema_version {exc.version}, console expects {SCHEMA_VERSION}",
            fix=f"Upgrade sparkline-agent on {node} and sparkline to one release (re-run deploy/install.sh)",
        )
    if isinstance(exc, socket.gaierror):
        return "offline", Problem(
            message=f"Cannot resolve {host}",
            cause=f"DNS lookup for {host} failed ({exc.strerror or exc})",
            fix=f"Use {node}'s IP address in the url in console.toml, or fix name resolution (/etc/hosts)",
        )
    text = str(exc).lower()
    if isinstance(exc, ConnectionRefusedError) or "refused" in text or "connect call failed" in text:
        return "offline", Problem(
            message=f"Agent unreachable on {node}",
            cause=f"Connection refused at {host}:{port}",
            fix=systemctl,
        )
    journal = f"Check `journalctl -u sparkline-agent` on {node}"
    if isinstance(exc, HandshakeTimeout | httpx.ReadTimeout):
        return "offline", Problem(
            message=f"Agent on {node} is not answering",
            cause=f"{host}:{port} accepted the connection but did not answer (agent hung or overloaded)",
            fix=f"{journal} and `systemctl status sparkline-agent`; the console retries automatically",
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
                f"and that no firewall blocks port {port}"
            ),
        )
    if "keepalive ping timeout" in text:
        return "offline", Problem(
            message=f"Agent on {node} stopped responding",
            cause="The connection stayed open but the agent stopped answering keepalive pings "
            "(hung or overloaded)",
            fix=f"{journal}; the console reconnects automatically",
        )
    if type(exc).__name__ == "InvalidMessage":  # websockets: TCP accepted, connection closed before any reply
        return "offline", Problem(
            message=f"Agent on {node} is not answering",
            cause=f"{host}:{port} accepted the connection but closed it without replying (agent starting, "
            "stopping or hung)",
            fix=f"{journal}; the console retries automatically",
        )
    closed = isinstance(exc, StreamClosed | ConnectionError) or type(exc).__name__.startswith(
        "ConnectionClosed"
    )
    if closed:
        return "offline", Problem(
            message=f"Lost connection to agent on {node}",
            cause=f"Connection closed ({exc or 'no reason given'})",
            fix=(
                f"The agent may have restarted; reconnecting automatically. If this repeats, check "
                f"`journalctl -u sparkline-agent` on {node}"
            ),
        )
    return "error", Problem(
        message=f"Cannot read from agent on {node}",
        cause=f"{type(exc).__name__}: {exc}",
        fix=f"Check `journalctl -u sparkline-agent` on {node} and the sparkline log",
    )


class NodeSource:
    def __init__(self, node_id: str, url: str, listener: Listener):
        self.node_id = node_id
        self.url = url
        self.listener = listener
        self.state = NodeState(node_id=node_id, url=url, status="connecting", since=time.time())
        self.ring: deque[Sample] = deque(maxlen=int(RING_S * 4))  # bounded even at 250 ms intervals
        self._attempt = 0
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
        self.ring.append(s)
        while self.ring and self.ring[0].ts < s.ts - RING_S:
            self.ring.popleft()
        self._attempt = 0
        now = time.time()
        self.state.last_sample_ts = now  # console clock: the watchdog must not depend on the agent's clock
        if abs(s.ts - now) > SKEW_WARN_S and not self._skew_warned:
            self._skew_warned = True
            log.warning("%s: agent clock is %+.0f s off the console's; check NTP", self.node_id, s.ts - now)
        if self.state.status != "online":
            self.set_status("online", None, None)
        self.listener.on_sample(self, s)

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

    def retry_now(self) -> None:
        if self.state.status != "online" and self._session_task and not self._session_task.done():
            self._session_task.cancel()
        self._attempt = 0
        self._wake.set()

    def backoff_delay(self) -> float:
        return min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** min(self._attempt, 10) * random.uniform(0.8, 1.2))

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
                status, problem = classify(failure, self.node_id, self.url)
                log.debug("%s: session failed: %r", self.node_id, failure)
            delay = self.backoff_delay()
            self._wake.clear()
            self.set_status(status, problem, time.time() + delay)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), delay)
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
