from __future__ import annotations

import asyncio
import logging

from sparkline.console.hub import PRIORITY_BYTES, PRIORITY_QUEUE, SAMPLE_QUEUE, Hub


class StuckSocket:
    """A browser that never reads: every send blocks forever."""

    def __init__(self):
        self.sent: list[str] = []
        self.block = asyncio.Event()

    async def send_text(self, data: str) -> None:
        self.sent.append(data)
        await self.block.wait()


async def test_slow_client_drops_oldest_samples_but_keeps_events():
    hub = Hub()
    ws = StuckSocket()
    c = hub.add(ws)
    pump = asyncio.create_task(c.pump())
    for i in range(10_000):
        hub.broadcast({"type": "sample", "i": i}, droppable=True)
        if i % 1000 == 0:
            hub.broadcast({"type": "event", "i": i})
        await asyncio.sleep(0)
    assert len(c.samples) == SAMPLE_QUEUE
    assert c.samples[-1].endswith('"i":9999}')  # newest kept, oldest dropped
    assert c.dropped > 9000
    assert len(ws.sent) + len(c.priority) >= 1  # nothing lost from the priority lane
    assert sum('"event"' in m for m in list(c.priority) + ws.sent) == 10
    pump.cancel()


async def test_priority_overflow_disconnects_instead_of_growing():
    hub = Hub()
    c = hub.add(StuckSocket())
    for i in range(PRIORITY_QUEUE + 5):
        hub.broadcast({"type": "event", "i": i})
    assert len(c.priority) == PRIORITY_QUEUE and c.overflowed
    await asyncio.wait_for(c.pump(), 1)  # returns immediately: caller closes the socket


BENCH = '{"type":"bench","run":"' + "x" * 330_000 + '"}'  # a late tool-eval broadcast, live and detail data


async def test_priority_overflow_by_size_disconnects_long_before_the_count(caplog):
    """A stalled browser is cut off once PRIORITY_BYTES are queued, not after PRIORITY_QUEUE bench broadcasts
    (~660 MB of them)."""
    hub = Hub()
    c = hub.add(StuckSocket())
    fits = PRIORITY_BYTES // len(BENCH)
    for _ in range(fits):
        hub.broadcast_text(BENCH, droppable=False)
    assert not c.overflowed and c.priority_bytes == fits * len(BENCH)
    hub.broadcast_text(BENCH, droppable=False)
    assert c.overflowed and len(c.priority) == fits < PRIORITY_QUEUE
    with caplog.at_level(logging.WARNING, logger="sparkline.console.hub"):
        await asyncio.wait_for(c.pump(), 1)  # returns immediately: caller closes the socket
    assert "overflowed its event queue; disconnecting it" in caplog.text


class ReadingSocket:
    """A browser that keeps up."""

    def __init__(self):
        self.sent = 0

    async def send_text(self, data: str) -> None:
        self.sent += 1
        await asyncio.sleep(0)


async def test_sent_messages_give_their_bytes_back():
    hub = Hub()
    ws = ReadingSocket()
    c = hub.add(ws)
    pump = asyncio.create_task(c.pump())
    n = 3 * PRIORITY_BYTES // len(BENCH)  # three budgets' worth in all, sent as they come
    for _ in range(n):
        hub.broadcast_text(BENCH, droppable=False)
        await asyncio.sleep(0)
    await asyncio.wait_for(_until(lambda: ws.sent == n), 5)
    assert not c.overflowed and c.priority_bytes == 0 and not c.priority
    pump.cancel()


async def _until(cond) -> None:
    while not cond():
        await asyncio.sleep(0)
