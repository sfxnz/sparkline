import shutil
import sqlite3
from pathlib import Path

import pytest

from sparkline.agent.store import Rollup, Store, agg_kind, choose_resolution, downsample

HISTORY_FIXTURES = Path(__file__).parent / "fixtures" / "agent" / "history"


def test_agg_kinds():
    assert agg_kind("gpu0.energy_j") == "last"
    assert agg_kind("gpu0.throttle_mask") == "or"
    assert agg_kind("gpu0.util") == "avg"
    assert agg_kind("net.enp1s0f1np1.errors") == "sum"
    assert agg_kind("net.enp1s0f1np1.drops") == "sum"


def test_event_counts_are_summed_through_rollup_and_downsample():
    """Per-interval error counts must total exactly over any range, not average out."""
    r = Rollup(10, 1.0)
    for t, n in [(100.0, 0), (101.0, 3), (102.0, 0), (109.0, 1)]:
        r.add(t, {"net.x.errors": n})
    first = r.add(110.0, {"net.x.errors": 2})
    assert first is not None and first[1]["net.x.errors"] == [4.0, 0.0, 3.0]
    second = r.flush()
    assert second is not None
    rows = [(float(first[0]), first[1]), (float(second[0]), second[1])]
    merged = downsample(rows, 100, 120, 1, None, 10.0)
    assert merged[0][1]["net.x.errors"][0] == 6.0


def test_rollup_avg_min_max_last_or():
    r = Rollup(10, 0.5)
    samples = [
        (100.0, {"gpu0.util": 10, "gpu0.energy_j": 1000, "gpu0.throttle_mask": 0x4}),
        (104.0, {"gpu0.util": 30, "gpu0.energy_j": 1030, "gpu0.throttle_mask": 0x20}),
        (109.9, {"gpu0.util": 20, "gpu0.energy_j": 1050, "gpu0.throttle_mask": 0x0, "mem.used": 7}),
    ]
    for ts, flat in samples:
        assert r.add(ts, flat) is None  # same bucket
    done = r.add(110.0, {"gpu0.util": 99})
    assert done is not None
    ts, data, covered_s = done
    assert ts == 100 and covered_s == 1.5, "3 samples of 0.5 s"
    assert data["gpu0.util"] == [20.0, 10.0, 30.0]
    assert data["gpu0.energy_j"] == [1050.0, 1000.0, 1050.0]
    assert data["gpu0.throttle_mask"][0] == float(0x4 | 0x20)
    assert data["mem.used"] == [7.0, 7.0, 7.0]  # key present in only one sample
    assert r.flush() == (110, {"gpu0.util": [99.0, 99.0, 99.0]}, 0.5)
    assert r.flush() is None


def test_downsample_buckets():
    rows = [
        (float(t), {"a": [float(t), float(t) - 1, float(t) + 1], "gpu0.energy_j": [t, t, t]})
        for t in range(100)
    ]
    out = downsample(rows, 0, 100, 10, None, 1.0)
    assert len(out) == 10
    ts0, d0 = out[0]
    assert ts0 == pytest.approx(4.5)
    assert d0["a"] == [4.5, -1.0, 10.0]  # avg of avgs, min of mins, max of maxes
    assert d0["gpu0.energy_j"][0] == 9  # counter keeps last
    assert downsample(rows[:5], 0, 5, 10, ["a"], 1.0)[0][1] == {"a": [0.0, -1.0, 1.0]}  # passthrough
    assert downsample([], 0, 1, 10, None, 1.0) == []


def test_downsample_buckets_stable_across_refreshes():
    """A sliding window re-queried 30 s later must not re-bucket (and change) the overlapping points."""
    rows = [(float(t), {"x": [float(t % 7)] * 3}) for t in range(0, 7200, 10)]

    def window(t0):
        return dict(downsample([r for r in rows if t0 <= r[0] <= t0 + 3600], t0, t0 + 3600.004, 60, None, 10))

    a, b = window(1000), window(1030)
    common = set(a) & set(b)
    assert len(common) >= 55 and all(a[t] == b[t] for t in common)
    assert len(a) <= 60 and len(b) <= 60


def test_choose_resolution():
    now = 1_000_000.0
    day = 86400
    ring_oldest = now - 900
    assert choose_resolution(now - 300, now, now, ring_oldest, 1.0, 7 * day, 600) == 1.0
    # a client's "now - 900" lands a few ms before the ring window computed at request time: still the ring
    assert choose_resolution(now - 900.05, now, now, ring_oldest, 1.0, 7 * day, 600) == 1.0
    assert choose_resolution(now - 3600, now, now, ring_oldest, 1.0, 7 * day, 600) == 10
    assert choose_resolution(now - 6 * day, now - 6 * day + 3600, now, ring_oldest, 1.0, 7 * day, 600) == 10
    assert choose_resolution(now - 8 * day, now, now, ring_oldest, 1.0, 7 * day, 600) == 60
    # 7 days into 600 points is ~1000 s per point: the 60 s table is plenty
    assert choose_resolution(now - 7 * day + 10, now, now, ring_oldest, 1.0, 7 * day, 600) == 60


def test_store_roundtrip(tmp_path):
    s = Store(str(tmp_path / "d"))
    s.write(10, 100, {"a": [1, 0, 2]}, 10.0)
    s.write(10, 110, {"a": [3, 3, 3]}, 2.0)
    s.write(60, 60, {"a": [2, 0, 3]}, 60.0)
    # rows are keyed by bucket start and served at the bucket centre
    assert s.query(10, 100, 110) == ([(105.0, {"a": [1, 0, 2]}), (115.0, {"a": [3, 3, 3]})], [10.0, 2.0])
    s.prune(now=125, retention={10: 20, 60: 1000})
    assert s.query(10, 0, 1000) == ([(115.0, {"a": [3, 3, 3]})], [2.0])
    assert s.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    s.clear()
    assert s.query(10, 0, 1000) == ([], []) and s.query(60, 0, 1000) == ([], [])
    s.close()


def test_store_query_with_keys_returns_just_those_keys_as_stored(tmp_path):
    s = Store(str(tmp_path / "d"))
    row = {
        "gpu0.util": [0.1, 1e-05, 3531036839936.0],
        "fs.media_Ünï dísk.used": [1.5, 1.0, 2.0],
        "temp.odd\\name": [40.0, 39.5, 41.25],
        "mem.used": [5.0, 5.0, 5.0],
    }
    s.write(60, 60, row, 60.0)
    s.write(60, 120, {"mem.used": [6.0, 6.0, 6.0]}, 30.0)
    keys = ["gpu0.util", "fs.media_Ünï dísk.used", "temp.odd\\name", "nope"]
    assert s.query(60, 0, 1000, keys) == ([(90.0, {k: row[k] for k in keys[:3]}), (150.0, {})], [60.0, 30.0])
    assert s.query(60, 0, 1000) == ([(90.0, row), (150.0, {"mem.used": [6.0, 6.0, 6.0]})], [60.0, 30.0])
    s.close()


def test_store_upgrades_a_database_the_agent_at_d96ee29_wrote(tmp_path):
    db = tmp_path / "history.sqlite"
    shutil.copy(HISTORY_FIXTURES / "main-d96ee29.sqlite", db)
    with sqlite3.connect(db) as half_upgraded:
        half_upgraded.execute("CREATE TABLE r10_covered (ts INTEGER PRIMARY KEY, covered_s REAL NOT NULL)")
    t0 = 1_793_000_100
    s = Store(str(tmp_path))
    rows, covered = s.query(60, t0, t0 + 120, ["gpu0.util"])
    assert rows == [(t0 + 30 + 60 * i, {"gpu0.util": [u, u, u]}) for i, u in enumerate([10.0, 20.0, 30.0])]
    assert covered == [60.0, 60.0, 60.0], "an older row counts as a full minute, as it did before"
    rows, covered = s.query(10, t0 + 110, t0 + 120)
    assert [r[1]["gpu0.util"][0] for r in rows] == [20.0, 30.0] and covered == [10.0, 10.0]
    s.write(60, t0 + 180, {"gpu0.util": [40.0, 40.0, 40.0]}, 12.0)
    s.close()

    with sqlite3.connect(db) as rolled_back:
        rolled_back.execute(
            "INSERT OR REPLACE INTO r60 VALUES (?, ?)", (t0 + 240, '{"gpu0.util":[50,50,50]}')
        )
    s = Store(str(tmp_path))
    rows, covered = s.query(60, t0, t0 + 240)
    assert [r[1]["gpu0.util"][0] for r in rows] == [10.0, 20.0, 30.0, 40.0, 50.0]
    assert covered == [60.0, 60.0, 60.0, 12.0, 60.0], "a row the older agent writes after a rollback"
    s.close()
