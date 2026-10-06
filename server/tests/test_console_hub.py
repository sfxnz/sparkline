from __future__ import annotations

import asyncio

from sparkline.console.hub import PRIORITY_QUEUE, SAMPLE_QUEUE, Hub


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
