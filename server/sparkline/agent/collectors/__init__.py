"""Collectors. Each module keeps pure parsing functions (unit-tested on fixtures) separate from IO.

A collector implements ``Collector``: ``collect()`` returns a dict whose keys are ``Sample`` field names, and
``caps()`` maps flattened metric keys to None (supported) or the reason they are not.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from ...common.schema import Unsupported

Caps = Mapping[str, Unsupported | None]


class Collector(Protocol):
    name: str

    def collect(self) -> dict[str, Any]: ...

    def caps(self) -> Caps: ...


SLOW_EVERY_S = 10.0


def slow_due(last: float, now: float) -> bool:
    """Whether a read done every SLOW_EVERY_S, last at ``last``, is due. A collector runs a different few
    ms into each tick, so at 1 Hz the tenth tick can land just under SLOW_EVERY_S after the last read."""
    return now - last >= SLOW_EVERY_S - 0.5


def counter_delta(prev: float | None, cur: float) -> float:
    """Delta of a monotonic counter; 0 on first read or counter reset."""
    if prev is None or cur < prev:
        return 0.0
    return cur - prev


def parse_psi(text: str) -> dict[str, float]:
    """/proc/pressure/* -> {"some": avg10, "full": avg10}."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        for kv in parts[1:]:
            if kv.startswith("avg10="):
                out[parts[0]] = float(kv[6:])
    return out
