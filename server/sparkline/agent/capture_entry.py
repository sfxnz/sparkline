"""The sparkline-capture command. It quiets Python's tracebacks before it imports the capture, whose
imports take long enough for a Ctrl-C to land in them."""

from __future__ import annotations

import sys
import threading

STOPPED = 130
STOPPED_LINE = "sparkline-capture stopped. It keeps no partial recording."


def print_no_traceback_from_python() -> None:
    def failed(kind: type[BaseException]) -> None:
        print(f"sparkline-capture failed with {kind.__name__} (message not shown).", file=sys.stderr)

    sys.excepthook = lambda kind, _value, _traceback: failed(kind)
    threading.excepthook = lambda args: failed(args.exc_type)
    sys.unraisablehook = lambda _ignored: None


def main() -> int:
    print_no_traceback_from_python()
    try:
        from .capture import main as capture
    except KeyboardInterrupt:
        print(STOPPED_LINE, file=sys.stderr)
        return STOPPED
    return capture()
