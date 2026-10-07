"""Secrets never reach the log (handshake headers are masked at debug); the Docker hint names a usable URL."""

from __future__ import annotations

import logging

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from sparkline.common import logsafe
from sparkline.console.main import container_hint
from tests.netports import free_ports

TOKEN = "SECRET-AGENT-TOKEN-abcdef123456"
SESSION = "SESSION-COOKIE-zyx987"


async def test_websocket_handshake_at_debug_never_logs_the_token_or_cookie(caplog):
    logsafe.install()
    caplog.set_level(logging.DEBUG)

    async def echo(ws):
        async for m in ws:
            await ws.send(m)

    (port,) = free_ports(1)
    async with serve(echo, "127.0.0.1", port):
        headers = {"Authorization": f"Bearer {TOKEN}", "Cookie": f"sparkline_session={SESSION}"}
        async with connect(f"ws://127.0.0.1:{port}", additional_headers=headers) as ws:
            await ws.send("hi")
            assert await ws.recv() == "hi"
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "> Authorization: ***" in text  # the handshake was logged, masked (client side)
    assert "< Authorization: ***" in text  # and on the server side
    assert TOKEN not in text and SESSION not in text


class _Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def test_uvicorn_server_handshake_lines_are_masked():
    """uvicorn's WebSocket server logs the handshake through uvicorn.error ("< authorization: Bearer ...").

    A handler on the logger itself: once uvicorn has configured logging (another test ran a server),
    uvicorn.error no longer propagates to the root logger that caplog listens on."""
    logsafe.install()
    logger = logging.getLogger("uvicorn.error")
    sink, level = _Collect(), logger.level
    logger.addHandler(sink)
    logger.setLevel(logging.DEBUG)
    try:
        logger.debug("< %s: %s", "authorization", f"Bearer {TOKEN}")
        logger.debug("< %s: %s", "cookie", f"sparkline_session={SESSION}")
        logger.debug("< %s: %s", "host", "10.20.20.48:9750")
    finally:
        logger.removeHandler(sink)
        logger.setLevel(level)
    text = "\n".join(sink.lines)
    assert TOKEN not in text and SESSION not in text
    assert "< authorization: ***" in text and "< host: 10.20.20.48:9750" in text


def test_container_hint_only_in_the_image():
    assert container_hint(9700, {}) is None
    hint = container_hint(9700, {"SPARKLINE_CONTAINER": "1"})
    assert hint and "http://127.0.0.1:9701" in hint and "-p 127.0.0.1:9701:9700" in hint
