"""Fan-out of live messages to browser WebSocket clients with bounded per-client queues.

Samples and pings are droppable (oldest dropped first under backpressure); node_status and event messages
are never dropped. A client whose priority queue still overflows (in messages or bytes) is disconnected rather
than buffered forever.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from typing import Any, Protocol

log = logging.getLogger("sparkline.console.hub")

SAMPLE_QUEUE = 64  # ~20 s of 3 nodes at 1 Hz
PRIORITY_QUEUE = 2000
PRIORITY_BYTES = 32 * 2**20  # bench broadcasts carry live/detail data (tens to hundreds of KB each)


class _Sender(Protocol):
    async def send_text(self, data: str) -> None: ...


class Client:
    def __init__(self, ws: _Sender, session: str | None = None):
        self.ws = ws
        self.session = session  # sign-in session id when authenticated by cookie
        self.samples: deque[str] = deque(maxlen=SAMPLE_QUEUE)
        self.priority: deque[str] = deque()
        self.priority_bytes = 0  # length of the queued priority messages (JSON text)
        self.wake = asyncio.Event()
        self.dropped = 0
        self.overflowed = False
        self.kicked = False  # signed out / session expired: stop streaming

    def put(self, text: str, droppable: bool) -> None:
        if droppable:
            if len(self.samples) == self.samples.maxlen:
                self.dropped += 1
            self.samples.append(text)
        else:
            if len(self.priority) >= PRIORITY_QUEUE or self.priority_bytes + len(text) > PRIORITY_BYTES:
                self.overflowed = True
            else:
                self.priority.append(text)
                self.priority_bytes += len(text)
        self.wake.set()

    def kick(self) -> None:
        self.kicked = True
        self.wake.set()

    async def pump(self) -> None:
        """Send queued messages until the connection fails or the client overflows."""
        while not (self.overflowed or self.kicked):
            await self.wake.wait()
            self.wake.clear()
            while (self.priority or self.samples) and not (self.overflowed or self.kicked):
                if self.priority:
                    text = self.priority.popleft()
                    self.priority_bytes -= len(text)
                else:
                    text = self.samples.popleft()
                await self.ws.send_text(text)
        if self.overflowed:
            log.warning("browser client overflowed its event queue; disconnecting it")


class Hub:
    def __init__(self) -> None:
        self.clients: set[Client] = set()

    def add(self, ws: _Sender, session: str | None = None) -> Client:
        c = Client(ws, session)
        self.clients.add(c)
        return c

    def remove(self, c: Client) -> None:
        self.clients.discard(c)

    def broadcast_text(self, text: str, droppable: bool) -> None:
        for c in list(self.clients):
            c.put(text, droppable)

    def broadcast(self, msg: dict[str, Any], droppable: bool = False) -> None:
        if self.clients:
            self.broadcast_text(json.dumps(msg, separators=(",", ":")), droppable)
