"""History: rollup math (pure), resolution choice (pure) and the SQLite store.

Each bucket row is ``{key: [agg, min, max]}`` where agg is the average, except counter keys (last value) and
bitmask keys (bitwise OR). The ``Store`` is not thread-safe; the sampler drives it from one dedicated thread.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3

from ..common.metrics import BITMASK_KEYS_SUFFIX, COUNTER_KEYS_SUFFIX

TABLES = {10: "r10", 60: "r60"}


def agg_kind(key: str) -> str:
    if key.endswith(COUNTER_KEYS_SUFFIX):
        return "last"
    if key.endswith(BITMASK_KEYS_SUFFIX):
        return "or"
    return "avg"


class Acc:
    """Accumulates [agg, min, max] triples (a raw value v is the triple (v, v, v))."""

    def __init__(self) -> None:
        self.d: dict[str, list[float]] = {}  # key -> [sum|last|or, count, min, max]
        self.ts_sum = 0.0
        self.n = 0

    def add_ts(self, ts: float) -> None:
        self.ts_sum += ts
        self.n += 1

    def add(self, key: str, agg: float, mn: float, mx: float) -> None:
        a = self.d.get(key)
        if a is None:
            self.d[key] = [agg, 1, mn, mx]
            return
        kind = agg_kind(key)
        if kind == "avg":
            a[0] += agg
        elif kind == "last":
            a[0] = agg
        else:
            a[0] = float(int(a[0]) | int(agg))
        a[1] += 1
        if mn < a[2]:
            a[2] = mn
        if mx > a[3]:
            a[3] = mx

    def result(self) -> dict[str, list[float]]:
        out = {}
        for k, (s, n, mn, mx) in self.d.items():
            agg = s / n if agg_kind(k) == "avg" else s
            out[k] = [round(agg, 3), round(mn, 3), round(mx, 3)]
        return out


class Rollup:
    """Feeds raw flattened samples into fixed-width buckets; returns each bucket when it closes."""

    def __init__(self, width: int) -> None:
        self.width = width
        self.bucket: int | None = None
        self.acc = Acc()

    def add(self, ts: float, flat: dict[str, float]) -> tuple[int, dict] | None:
        b = int(ts // self.width * self.width)
        done = None
        if self.bucket is not None and b != self.bucket:
            done = self.flush()
        if self.bucket is None:
            self.bucket = b
        for k, v in flat.items():
            self.acc.add(k, v, v, v)
        return done

    def flush(self) -> tuple[int, dict] | None:
        if self.bucket is None or not self.acc.d:
            self.bucket = None
            return None
        out = (self.bucket, self.acc.result())
        self.bucket, self.acc = None, Acc()
        return out


def choose_resolution(
    t_from: float,
    t_to: float,
    now: float,
    ring_oldest: float | None,
    interval_s: float,
    retention_10s_s: float,
    points: int,
) -> float:
    """Ring if 'from' is inside its window (with 2 samples of slack, so a client's 'now - 900' computed a few
    ms before ours still counts), else 10 s if within its retention, else 60 s. A 10 s query whose
    downsampled points would each span >= 60 s anyway uses the 60 s table (6x fewer rows to read)."""
    if ring_oldest is not None and t_from >= ring_oldest - 2 * interval_s:
        return interval_s
    if t_from >= now - retention_10s_s and (t_to - t_from) / max(points, 1) < 60:
        return 10
    return 60


def downsample(
    rows: list[tuple[float, dict[str, list[float]]]],
    t0: float,
    t1: float,
    points: int,
    keys: list[str] | None,
    res: float,
) -> list[tuple[float, dict[str, list[float]]]]:
    """Bucket-average rows (ts-sorted) into at most ``points`` buckets over [t0, t1]. Bucket edges are
    multiples of the width (itself a multiple of the source resolution ``res``), not offsets from t0, so a
    sliding window keeps the same buckets from one refresh to the next."""
    if not rows:
        return []
    if len(rows) <= points:
        if keys is None:
            return rows
        return [(ts, {k: d[k] for k in keys if k in d}) for ts, d in rows]
    width = res * max(1, math.ceil((t1 - t0) / points / res - 0.01))  # tolerate a client's ms of skew
    out: list[tuple[float, dict]] = []
    acc, cur = Acc(), None
    for ts, d in rows:
        b = int(ts // width)
        if cur is not None and b != cur:
            out.append((acc.ts_sum / acc.n, acc.result()))
            acc = Acc()
        cur = b
        acc.add_ts(ts)
        for k in keys if keys is not None else d:
            v = d.get(k)
            if v is not None:
                acc.add(k, *v)
    out.append((acc.ts_sum / acc.n, acc.result()))
    return out[-points:]  # aligned edges can cut the range into points + 1 buckets: drop the oldest


class Store:
    def __init__(self, data_dir: str) -> None:
        os.makedirs(data_dir, exist_ok=True)
        self.path = os.path.join(data_dir, "history.sqlite")
        self.db: sqlite3.Connection | None = None

    def _conn(self) -> sqlite3.Connection:
        if self.db is None:  # opened lazily on the store thread
            self.db = sqlite3.connect(self.path)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=NORMAL")
            for t in TABLES.values():
                self.db.execute(
                    f"CREATE TABLE IF NOT EXISTS {t} (ts INTEGER PRIMARY KEY, data TEXT NOT NULL)"
                )
        return self.db

    def write(self, res: int, ts: int, data: dict) -> None:
        db = self._conn()
        db.execute(
            f"INSERT OR REPLACE INTO {TABLES[res]} VALUES (?, ?)",
            (ts, json.dumps(data, separators=(",", ":"))),
        )
        db.commit()

    def query(self, res: int, t0: float, t1: float) -> list[tuple[float, dict]]:
        """Rows are keyed by bucket start; they are served stamped at the bucket centre."""
        cur = self._conn().execute(
            f"SELECT ts, data FROM {TABLES[res]} WHERE ts >= ? AND ts <= ? ORDER BY ts", (int(t0), int(t1))
        )
        return [(ts + res / 2, json.loads(d)) for ts, d in cur]

    def prune(self, now: float, retention: dict[int, float]) -> None:
        db = self._conn()
        for res, keep_s in retention.items():
            db.execute(f"DELETE FROM {TABLES[res]} WHERE ts < ?", (int(now - keep_s),))
        db.commit()

    def clear(self) -> None:
        db = self._conn()
        for t in TABLES.values():
            db.execute(f"DELETE FROM {t}")
        db.commit()
        db.execute("VACUUM")

    def close(self) -> None:
        if self.db is not None:
            self.db.close()
            self.db = None
