import pytest

from sparkline.agent.store import Rollup, Store, agg_kind, choose_resolution, downsample


def test_agg_kinds():
    assert agg_kind("gpu0.energy_j") == "last"
    assert agg_kind("gpu0.throttle_mask") == "or"
    assert agg_kind("gpu0.util") == "avg"


def test_rollup_avg_min_max_last_or():
    r = Rollup(10)
    samples = [
        (100.0, {"gpu0.util": 10, "gpu0.energy_j": 1000, "gpu0.throttle_mask": 0x4}),
        (104.0, {"gpu0.util": 30, "gpu0.energy_j": 1030, "gpu0.throttle_mask": 0x20}),
        (109.9, {"gpu0.util": 20, "gpu0.energy_j": 1050, "gpu0.throttle_mask": 0x0, "mem.used": 7}),
    ]
    for ts, flat in samples:
        assert r.add(ts, flat) is None  # same bucket
    done = r.add(110.0, {"gpu0.util": 99})
    assert done is not None
    ts, data = done
    assert ts == 100
    assert data["gpu0.util"] == [20.0, 10.0, 30.0]
    assert data["gpu0.energy_j"] == [1050.0, 1000.0, 1050.0]
    assert data["gpu0.throttle_mask"][0] == float(0x4 | 0x20)
    assert data["mem.used"] == [7.0, 7.0, 7.0]  # key present in only one sample
    assert r.flush() == (110, {"gpu0.util": [99.0, 99.0, 99.0]})
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
    s.write(10, 100, {"a": [1, 0, 2]})
    s.write(10, 110, {"a": [3, 3, 3]})
    s.write(60, 60, {"a": [2, 0, 3]})
    # rows are keyed by bucket start and served at the bucket centre
    assert s.query(10, 100, 110) == [(105.0, {"a": [1, 0, 2]}), (115.0, {"a": [3, 3, 3]})]
    s.prune(now=125, retention={10: 20, 60: 1000})
    assert s.query(10, 0, 1000) == [(115.0, {"a": [3, 3, 3]})]
    assert s.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    s.clear()
    assert s.query(10, 0, 1000) == [] and s.query(60, 0, 1000) == []
    s.close()
