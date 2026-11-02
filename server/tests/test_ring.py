from __future__ import annotations

import sys
import threading

from sparkline.common.metrics import flatten
from sparkline.common.ring import SampleRing
from sparkline.console.demo import DemoModel


def filled(seconds: float = 900, max_rows: int = 3600, n: int = 10) -> SampleRing:
    ring = SampleRing(seconds, max_rows)
    for t in range(n):
        ring.add(float(t), {"a": float(t), "b": -float(t)})
    return ring


def test_rows_more_than_seconds_older_than_the_newest_are_dropped():
    ring = filled(seconds=5)
    assert [ts for ts, _ in ring.rows()] == [4, 5, 6, 7, 8, 9]


def test_the_ring_never_holds_more_than_max_rows():
    ring = filled(max_rows=3)
    assert [ts for ts, _ in ring.rows()] == [7, 8, 9]


def test_holds_matches_the_rows_still_in_the_ring_after_a_clock_step_back():
    ring = SampleRing(5, 3)
    arrivals: dict[float, int] = {}
    for ts in (10.0, 11.0, 2.0, 12.0, 17.0):
        arrivals[ts] = ring.add(ts, {"a": ts})
        held = [t for t, n in arrivals.items() if ring.holds(n)]
        assert held == [t for t, _ in ring.rows()], ts
    assert held == [12.0, 17.0]


def test_old_rows_behind_a_row_the_row_limit_drops_are_dropped_too():
    ring = SampleRing(5, 4)
    arrivals = {ts: ring.add(ts, {"a": ts}) for ts in (100.0, 50.0, 51.0, 52.0, 58.0)}
    assert [ts for ts, _ in ring.rows()] == [58.0]
    assert [ts for ts, n in arrivals.items() if ring.holds(n)] == [58.0]


def test_rows_in_a_time_range_include_both_ends():
    ring = filled()
    assert [ts for ts, _ in ring.rows(3, 5)] == [3, 4, 5]
    assert [ts for ts, _ in ring.rows(8.5)] == [9]
    assert ring.rows(20) == []


def test_key_filter_keeps_only_the_keys_each_row_has():
    ring = SampleRing(900, 3600)
    ring.add(1.0, {"a": 1.0, "b": 2.0, "c": 3.0})
    ring.add(2.0, {"b": 4.0})
    assert ring.rows(keys=["a", "b", "missing"]) == [(1.0, {"a": 1.0, "b": 2.0}), (2.0, {"b": 4.0})]
    assert ring.rows(keys=[]) == [(1.0, {}), (2.0, {})]
    assert ring.rows() == [(1.0, {"a": 1.0, "b": 2.0, "c": 3.0}), (2.0, {"b": 4.0})]


def test_rows_are_a_snapshot():
    flat = {"a": 1.0}
    ring = SampleRing(5, 3600)
    ring.add(1.0, flat)
    snap = ring.rows()
    flat["a"] = 99.0
    ring.add(2.0, {"a": 2.0})
    ring.add(10.0, {"a": 10.0})
    assert snap == [(1.0, {"a": 1.0})]
    assert ring.rows() == [(10.0, {"a": 10.0})]


def test_rows_share_one_set_of_key_strings():
    m = DemoModel("spark1", 0.0)
    ring = SampleRing(900, 3600)
    for t in (1.0, 2.0):
        ring.add(t, flatten(m.sample_at(t)))
    (_, first), (_, second) = ring.rows()
    assert all(a is b for a, b in zip(first, second, strict=True))


def test_clear_empties_the_ring():
    ring = filled()
    last = ring.add(10.0, {"a": 10.0})
    ring.clear()
    assert ring.rows() == [] and not ring.holds(last)


def test_a_reader_thread_never_sees_a_half_trimmed_ring():
    ring = SampleRing(50, 3600)
    stop = threading.Event()
    bad: list[object] = []

    def read() -> None:
        while not stop.is_set():
            try:
                ts = [t for t, _ in ring.rows()]
            except RuntimeError as e:
                bad.append(e)
                continue
            if ts and ts[-1] - ts[0] > 50:
                bad.append(ts)

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    reader = threading.Thread(target=read)
    reader.start()
    try:
        for t in range(5000):
            ring.add(float(t), {"a": float(t)})
    finally:
        stop.set()
        reader.join()
        sys.setswitchinterval(interval)
    assert not bad
