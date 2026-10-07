"""Keep secrets out of logs, whatever --log-level says.

At DEBUG, websockets logs every handshake header ("> Authorization: Bearer ...", "< cookie: ..."), both
through its own loggers (the console's agent client) and through uvicorn.error (uvicorn's WebSocket server).
Under systemd that lands in the journal, which other users can read. The filter masks those values.
"""

from __future__ import annotations

import logging
import re

# Loggers that websockets' handshake debug lines are created on (a logger's filters see only its own records).
HEADER_LOGGERS = ("uvicorn.error", "websockets.client", "websockets.server", "websockets")
_SECRET_HEADER = re.compile(r"((?:proxy-)?authorization|cookie|set-cookie|x-api-key)(\s*:\s*)(.+)", re.I)


class RedactHeaders(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # a malformed record is not ours to fix
            return True
        red = _SECRET_HEADER.sub(r"\1\2***", msg)
        if red != msg:
            record.msg, record.args = red, None
        return True


def install() -> None:
    """Attach the filter to every logger that can log a handshake header."""
    f = RedactHeaders()
    for name in HEADER_LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(x, RedactHeaders) for x in logger.filters):
            logger.addFilter(f)
