"""The sparkline-capture command. Before it imports the capture, whose imports take long enough for a Ctrl-C
to land in them, it quiets Python and makes SIGHUP, SIGQUIT and SIGTERM stop the capture as Ctrl-C does."""

from __future__ import annotations

import faulthandler
import signal
import sys
import threading
import warnings

STOPPED = 130
STOPPED_LINE = "sparkline-capture stopped. It keeps no partial recording."
STOP_SIGNALS = (signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGTERM)


class Stopped(KeyboardInterrupt):
    def __init__(self, signum: int) -> None:
        super().__init__()
        self.exit_code = 128 + signum


def stopped(stop: KeyboardInterrupt) -> int:
    print(STOPPED_LINE, file=sys.stderr)
    return stop.exit_code if isinstance(stop, Stopped) else STOPPED


def print_no_traceback_from_python() -> None:
    def failed(kind: type[BaseException]) -> None:
        print(f"sparkline-capture failed with {kind.__name__} (message not shown).", file=sys.stderr)

    sys.excepthook = lambda kind, _value, _traceback: failed(kind)
    threading.excepthook = lambda args: failed(args.exc_type)
    sys.unraisablehook = lambda _ignored: None
    warnings.showwarning = lambda _message, category, *_where: print(
        f"sparkline-capture: {category.__name__} (message not shown).", file=sys.stderr
    )


def stop_like_ctrl_c_on_a_hangup_or_terminate() -> None:
    def stop(signum: int, _frame: object) -> None:
        for s in STOP_SIGNALS:
            signal.signal(s, signal.SIG_IGN)
        raise Stopped(signum)

    for s in STOP_SIGNALS:
        if signal.getsignal(s) in (signal.SIG_DFL, signal.default_int_handler):
            signal.signal(s, stop)


def main() -> int:
    print_no_traceback_from_python()
    faulthandler.disable()
    stop_like_ctrl_c_on_a_hangup_or_terminate()
    try:
        from .capture import main as capture
    except KeyboardInterrupt as e:
        return stopped(e)
    return capture()
