"""Shared helpers for Sparkline benchmark payloads (stdlib only; runs on the host and in the container).

Protocol: one JSON object per stdout line, read by the agent's runner:
  {"progress": 0..1, "phase": "..."}   {"result": {BenchResult fields}}
  {"series": {key: [values]}} (appended to the run's series)
  {"gauge": {key: value}} (latest value only; the agent samples it on its own clock, e.g. soak TFLOPS)
  {"live": {...}} (replaces the run's live snapshot; <= 256 KiB of compact JSON)
  {"detail": {key: ...}} (top-level keys replace the run's detail keys; <= 1 MiB in all)
  {"log": "..."}   {"ready": true}   {"error": {"message", "cause", "fix"}}
live/detail nest at most 64 levels and hold no NaN/inf (round, and use null for a missing number).
"""

from __future__ import annotations

import json
import signal
import sys


def emit(**msg) -> None:
    sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def progress(p: float, phase: str | None = None) -> None:
    emit(progress=round(max(0.0, min(1.0, p)), 4), **({"phase": phase} if phase else {}))


def result(metric: str, label: str, value: float, unit: str, better: str = "higher", **extras) -> None:
    emit(
        result={
            "metric": metric,
            "label": label,
            "value": value,
            "unit": unit,
            "better": better,
            "extras": extras,
        }
    )


def live(snapshot: dict) -> None:
    emit(live=snapshot)


def detail(**parts) -> None:
    emit(detail=parts)


def log(text: str) -> None:
    emit(log=text)


def fail(message: str, cause: str, fix: str, code: int = 1) -> None:
    emit(error={"message": message, "cause": cause, "fix": fix})
    sys.exit(code)


def on_sigterm() -> None:
    """SIGTERM -> SystemExit so `finally` blocks (temp file removal) run on cancel."""
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))


def int_list(s: str | None) -> list[int]:
    return [int(x) for x in s.split(",") if x.strip()] if s else []
