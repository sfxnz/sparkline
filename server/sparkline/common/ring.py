from __future__ import annotations

import math
import sys
from collections import deque
from collections.abc import Collection, Mapping


class SampleRing:
    """The newest ``seconds`` of one node's flattened samples, at most ``max_rows`` of them, oldest first.

    One writer and any number of readers in other threads: ``add`` trims before it appends, and ``rows``
    copies the deque in one C call, which the GIL makes atomic. A snapshot therefore never holds a row more
    than ``seconds`` older than its newest row. Rows are shared, not copied, so readers must not change them.
    """

    def __init__(self, seconds: float, max_rows: int) -> None:
        self._seconds = seconds
        self._rows: deque[tuple[float, dict[str, float]]] = deque(maxlen=max_rows)

    def add(self, ts: float, flat: Mapping[str, float]) -> None:
        row = (ts, {sys.intern(k): v for k, v in flat.items()})
        while self._rows and self._rows[0][0] < ts - self._seconds:
            self._rows.popleft()
        self._rows.append(row)

    def rows(
        self, t0: float = -math.inf, t1: float = math.inf, keys: Collection[str] | None = None
    ) -> list[tuple[float, Mapping[str, float]]]:
        """Rows with ``t0 <= ts <= t1``. With ``keys``, each row holds only the keys it has from ``keys``."""
        snap = list(self._rows)
        if keys is None:
            return [r for r in snap if t0 <= r[0] <= t1]
        return [(ts, {k: f[k] for k in keys if k in f}) for ts, f in snap if t0 <= ts <= t1]

    @property
    def oldest(self) -> float | None:
        return self._rows[0][0] if self._rows else None

    def clear(self) -> None:
        self._rows.clear()
