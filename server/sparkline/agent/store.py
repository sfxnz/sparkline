"""History: rollup math (pure), resolution choice (pure) and the SQLite store.

Each bucket row is ``{key: [agg, min, max]}`` where agg is the average, except counter keys (last value),
bitmask keys (bitwise OR) and per-interval event counts (sum). The ``Store`` is not thread-safe; the sampler
drives it from one dedicated thread.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3

from ..common.metrics import BITMASK_KEYS_SUFFIX, COUNTER_KEYS_SUFFIX, SUM_KEYS_SUFFIX

TABLES = {10: "r10", 60: "r60"}
# The seconds each row's samples cover, in tables of their own rather than a column: an older agent's
# two-value INSERT keeps working after a rollback
COVERED = {res: f"{t}_covered" for res, t in TABLES.items()}
EXTRACT_MAX_KEYS = 20


def agg_kind(key: str) -> str:
    if key.endswith(COUNTER_KEYS_SUFFIX):
        return "last"
    if key.endswith(BITMASK_KEYS_SUFFIX):
        return "or"
    if key.endswith(SUM_KEYS_SUFFIX):
        return "sum"
    return "avg"


class Acc:
    """Accumulates [agg, min, max] triples (a raw value v is the triple (v, v, v))."""

    def __init__(self) -> None:
        self.d: dict[str, list[float]] = {}  # key -> [sum|last|or, weight, min, max]
        self.ts_sum = 0.0
        self.n = 0.0

    def add_ts(self, ts: float, weight: float = 1.0) -> None:
        self.ts_sum += ts * weight
        self.n += weight

    def add(self, key: str, agg: float, mn: float, mx: float, *, weight: float = 1.0) -> None:
        a = self.d.get(key)
        kind = agg_kind(key)
        if a is None:
            self.d[key] = [agg * weight if kind == "avg" else agg, weight, mn, mx]
            return
        if kind == "avg":
            a[0] += agg * weight
        elif kind == "sum":
            a[0] += agg
        elif kind == "last":
            a[0] = agg
        else:
            a[0] = float(int(a[0]) | int(agg))
        a[1] += weight
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

    def __init__(self, width: int, interval_s: float) -> None:
        self.width = width
        self.interval_s = interval_s
        self.bucket: int | None = None
        self.acc = Acc()
        self.samples = 0

    def add(self, ts: float, flat: dict[str, float]) -> tuple[int, dict, float] | None:
        b = int(ts // self.width * self.width)
        done = None
        if self.bucket is not None and b != self.bucket:
            done = self.flush()
        if self.bucket is None:
            self.bucket = b
        for k, v in flat.items():
            self.acc.add(k, v, v, v)
        self.samples += 1
        return done

    def flush(self) -> tuple[int, dict, float] | None:
        out = None
        if self.bucket is not None and self.acc.d:
            out = (self.bucket, self.acc.result(), self.samples * self.interval_s)
        self.bucket, self.acc, self.samples = None, Acc(), 0
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


def bucket_width(t0: float, t1: float, points: int, res: float) -> float:
    """Width of the buckets ``downsample`` uses for [t0, t1]: a multiple of the source resolution ``res``."""
    return res * max(1, math.ceil((t1 - t0) / max(points, 1) / res - 0.01))  # tolerate a client's ms of skew


def downsample(
    rows: list[tuple[float, dict[str, list[float]]]],
    t0: float,
    t1: float,
    points: int,
    keys: list[str] | None,
    res: float,
    weights: list[float] | None = None,
) -> list[tuple[float, dict[str, list[float]]]]:
    """Bucket-average rows (ts-sorted) into at most ``points`` buckets over [t0, t1]. Bucket edges are
    multiples of the width (``bucket_width``), not offsets from t0, so a sliding window keeps the same
    buckets from one refresh to the next. Each bucket is stamped at the mean time of its rows. That mean
    and the averages weight each row by the seconds it covers (``weights``, 1 each by default). Fewer rows
    than ``points`` pass through unchanged unless ``weights`` (rows of mixed resolution must be bucketed)."""
    if not rows:
        return []
    if len(rows) <= points and weights is None:
        if keys is None:
            return rows
        return [(ts, {k: d[k] for k in keys if k in d}) for ts, d in rows]
    width = bucket_width(t0, t1, points, res)
    out: list[tuple[float, dict]] = []
    acc, cur = Acc(), None
    for (ts, d), weight in zip(rows, [1.0] * len(rows) if weights is None else weights, strict=True):
        b = int(ts // width)
        if cur is not None and b != cur:
            out.append((acc.ts_sum / acc.n, acc.result()))
            acc = Acc()
        cur = b
        acc.add_ts(ts, weight)
        for k in keys if keys is not None else d:
            v = d.get(k)
            if v is not None:
                acc.add(k, *v, weight=weight)
    out.append((acc.ts_sum / acc.n, acc.result()))
    return out[-points:]  # aligned edges can cut the range into points + 1 buckets: drop the oldest


def _dumps(v: object) -> str:
    return json.dumps(v, separators=(",", ":"))


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
            for t, c in zip(TABLES.values(), COVERED.values(), strict=True):
                self.db.execute(
                    f"CREATE TABLE IF NOT EXISTS {c} (ts INTEGER PRIMARY KEY, covered_s REAL NOT NULL)"
                )
                # In the file, so it also clears a row's seconds when an older agent replaces the row
                self.db.execute(
                    f"CREATE TRIGGER IF NOT EXISTS {t}_row_replaced AFTER INSERT ON {t}"
                    f" BEGIN DELETE FROM {c} WHERE ts = NEW.ts; END"
                )
        return self.db

    def write(self, res: int, ts: int, data: dict, covered_s: float) -> None:
        db = self._conn()
        db.execute(f"INSERT OR REPLACE INTO {TABLES[res]} VALUES (?, ?)", (ts, _dumps(data)))
        db.execute(f"INSERT OR REPLACE INTO {COVERED[res]} VALUES (?, ?)", (ts, covered_s))
        db.commit()

    def query(
        self, res: int, t0: float, t1: float, keys: list[str] | None = None
    ) -> tuple[list[tuple[float, dict]], list[float]]:
        """Rows are keyed by bucket start; they are served stamped at the bucket centre. Beside them, the
        seconds each row's samples cover: the full width for a row an older agent wrote."""
        frm = (
            f"FROM {TABLES[res]} r LEFT JOIN {COVERED[res]} c ON c.ts = r.ts"
            " WHERE r.ts >= ? AND r.ts <= ? ORDER BY r.ts"
        )
        span = (int(t0), int(t1))
        rows: list[tuple[float, dict]] = []
        weights: list[float] = []
        # A JSON path label ends at the first '"', escaped or not
        if keys is None or len(keys) > EXTRACT_MAX_KEYS or any('"' in k for k in keys):
            for ts, covered, d in self._conn().execute(f"SELECT r.ts, c.covered_s, r.data {frm}", span):
                data = json.loads(d)
                rows.append((ts + res / 2, data if keys is None else {k: data[k] for k in keys if k in data}))
                weights.append(res if covered is None else covered)
            return rows, weights
        cols = ", ".join(["json_extract(r.data, ?)"] * len(keys))
        cur = self._conn().execute(
            f"SELECT r.ts, c.covered_s, {cols} {frm}",
            # Spelled as write() stored it, a label matches on SQLite 3.40 (raw compare) and 3.45 (unescaped)
            [*("$." + _dumps(k) for k in keys), *span],
        )
        for ts, covered, *vals in cur:
            row = json.loads("[" + ",".join(v or "null" for v in vals) + "]")
            rows.append((ts + res / 2, {k: v for k, v in zip(keys, row, strict=True) if v is not None}))
            weights.append(res if covered is None else covered)
        return rows, weights

    def prune(self, now: float, retention: dict[int, float]) -> None:
        db = self._conn()
        for res, keep_s in retention.items():
            for t in (TABLES[res], COVERED[res]):
                db.execute(f"DELETE FROM {t} WHERE ts < ?", (int(now - keep_s),))
        db.commit()

    def clear(self) -> None:
        db = self._conn()
        for t in (*TABLES.values(), *COVERED.values()):
            db.execute(f"DELETE FROM {t}")
        db.commit()
        db.execute("VACUUM")

    def close(self) -> None:
        if self.db is not None:
            self.db.close()
            self.db = None
