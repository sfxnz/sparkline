"""Python raises a Ctrl-C as KeyboardInterrupt inside whatever code is running, an import included, so main()
sets the stop handlers and error hooks before it imports anything that runs Python code."""

import sys

TYPE_CHECKING = False
if TYPE_CHECKING:
    import signal as _signal
    from collections.abc import Callable
else:
    import _signal  # signal.py also imports enum, which a Ctrl-C can land in; _signal is loaded at startup

STOPPED = 130
FAILED = 4
PR_SET_DUMPABLE = 4
STOPPED_LINE = "sparkline-capture stopped. It keeps no partial recording."
STOP_SIGNALS = (_signal.SIGINT, _signal.SIGHUP, _signal.SIGQUIT, _signal.SIGTERM)

remove_on_stop: "Callable[[], object] | None" = None


class Stopped(KeyboardInterrupt):
    def __init__(self, signum: int) -> None:
        super().__init__()
        self.exit_code = 128 + signum


def stopped(stop: KeyboardInterrupt) -> int:
    print(STOPPED_LINE, file=sys.stderr)
    return stop.exit_code if isinstance(stop, Stopped) else STOPPED


def failed(kind: type[BaseException]) -> None:
    print(f"sparkline-capture failed with {kind.__name__} (message not shown).", file=sys.stderr)


def _print_no_traceback_from_sys() -> None:
    sys.excepthook = lambda kind, _value, _traceback: failed(kind)
    sys.unraisablehook = lambda _ignored: None


def print_no_traceback_from_python() -> None:
    import threading
    import warnings

    _print_no_traceback_from_sys()
    threading.excepthook = lambda args: failed(args.exc_type)
    warnings.showwarning = lambda _message, category, *_where: print(
        f"sparkline-capture: {category.__name__} (message not shown).", file=sys.stderr
    )


def _stop(signum: int, _frame: object) -> None:
    for s in STOP_SIGNALS:
        _signal.signal(s, _signal.SIG_IGN)
    if remove_on_stop is not None:
        remove_on_stop()
    raise Stopped(signum)


def ignore_stops() -> None:
    for s in STOP_SIGNALS:
        if _signal.getsignal(s) is _stop:
            _signal.signal(s, _signal.SIG_IGN)


def stop_like_ctrl_c_on_a_hangup_or_terminate() -> None:
    for s in STOP_SIGNALS:
        if _signal.getsignal(s) in (_signal.SIG_DFL, _signal.default_int_handler):
            _signal.signal(s, _stop)


def no_core_dumps() -> None:
    import resource

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if sys.platform == "linux":
        import ctypes

        zero = ctypes.c_ulong(0)
        if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_DUMPABLE, zero, zero, zero, zero) != 0:
            raise OSError(ctypes.get_errno(), "prctl")


def main() -> int:
    _print_no_traceback_from_sys()
    stop_like_ctrl_c_on_a_hangup_or_terminate()
    try:
        code = _capture()
        ignore_stops()
    except KeyboardInterrupt as e:
        code = stopped(e)
    return code


def _capture() -> int:
    try:
        no_core_dumps()
        print_no_traceback_from_python()
        import faulthandler

        faulthandler.disable()
        from .capture import main as capture
    except Exception as e:
        failed(type(e))
        return FAILED
    try:
        return capture()
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 0
