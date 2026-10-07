"""Sampling loop: runs collectors, keeps the ring buffer, fans samples out to subscribers, feeds rollups."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import psutil

from ..common.metrics import flatten
from ..common.schema import CpuSample, HistoryResponse, MemSample, Sample
from .store import Rollup, Store, bucket_width, choose_resolution, downsample

log = logging.getLogger(__name__)

QUEUE_SIZE = 32
PRUNE_EVERY_S = 3600
SELF_LOG_EVERY_S = 60

_EMPTY: dict[str, list | None] = {"gpu": [], "net": [], "disk": [], "fs": [], "temps": [], "procs": None}


def _placeholder(field: str) -> MemSample | CpuSample:
    if field == "mem":
        return MemSample(
            total=0,
            available=0,
            used=0,
            free=0,
            anon=0,
            cache=0,
            shmem=0,
            kernel=0,
            other=0,
            swap_total=0,
            swap_used=0,
        )
    return CpuSample(util=0, per_core=[], freq_mhz=[], load1=0, load5=0, load15=0)


class Sampler:
    def __init__(
        self,
        node_id: str,
        collectors: list,
        interval_ms: int = 1000,
        ring_seconds: int = 900,
        store: Store | None = None,
        retention_10s_days: float = 7,
        retention_60s_days: float = 30,
    ):
        if not 250 <= interval_ms <= 5000:
            raise ValueError("interval_ms must be between 250 and 5000")
        self.node_id = node_id
        self.collectors = collectors
        self.interval_ms = interval_ms
        # (ts, sample JSON): ~3 kB per entry instead of ~22 kB as live pydantic objects
        self.ring: deque[tuple[float, str]] = deque(maxlen=max(1, ring_seconds * 1000 // interval_ms))
        self.latest: Sample | None = None
        self.seq = 0
        self.subscribers: set[asyncio.Queue] = set()
        self.store = store
        self.retention = {10: retention_10s_days * 86400, 60: retention_60s_days * 86400}
        self.rollups = [Rollup(10), Rollup(60)]
        self._db = ThreadPoolExecutor(1, thread_name_prefix="store")
        self._last_good: dict[str, object] = {}
        self._procs_ts: float | None = None
        self._task: asyncio.Task | None = None

    # -- collection (runs in a worker thread) -------------------------------------------------------
    def tick(self) -> Sample:
        fields: dict = dict(_EMPTY)
        errors: dict[str, str] = {}
        for c in self.collectors:
            try:
                fields.update(c.collect())
            except Exception as e:  # fault isolation: one collector never sinks the sample
                errors[c.name] = f"{type(e).__name__}: {e}"
                log.debug("collector %s failed", c.name, exc_info=True)
        for f in ("mem", "cpu"):  # required by the schema: reuse the last good reading, flagged in errors
            if f in fields:
                self._last_good[f] = fields[f]
            else:
                fields[f] = self._last_good.get(f) or _placeholder(f)
                errors.setdefault(f, "no data")
        self.seq += 1
        ts = time.time()
        if fields["procs"] is not None:
            self._procs_ts = ts
        return Sample(
            node_id=self.node_id,
            ts=ts,
            seq=self.seq,
            interval_ms=self.interval_ms,
            errors=errors,
            procs_ts=self._procs_ts,
            **fields,
        )

    def _record(self, s: Sample) -> str:
        """Ring + rollups (worker thread). Closed buckets are written on the store thread."""
        js = s.model_dump_json()
        self.ring.append((s.ts, js))
        self.latest = s
        if self.store is None:
            return js
        flat = flatten(s)
        for r in self.rollups:
            done = r.add(s.ts, flat)
            if done:
                self._db.submit(self._safe, self.store.write, r.width, *done)
        return js

    @staticmethod
    def _safe(fn: Callable[..., object], *args: object) -> object:
        try:
            return fn(*args)
        except Exception:
            log.exception("store operation failed")
            return None

    def collect_once(self) -> str:
        """One tick: collect, record; returns the sample JSON."""
        return self._record(self.tick())

    # -- loop ------------------------------------------------------------------------------------------
    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self.run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self.store is not None:
            for r in self.rollups:
                done = r.flush()
                if done:
                    self._db.submit(self._safe, self.store.write, r.width, *done)
            self._db.submit(self.store.close)
        self._db.shutdown(wait=True)

    async def run(self) -> None:
        interval = self.interval_ms / 1000
        loop = asyncio.get_running_loop()
        # Warm-up tick, discarded: primes the delta collectors (CPU, net, disk, GPU violations, process CPU)
        # so the first recorded sample carries real rates instead of 0.0 for "no previous reading".
        try:
            await asyncio.to_thread(self.tick)
        except Exception:
            log.exception("warm-up tick failed")
        self.seq = 0
        next_t = loop.time() + interval
        last_prune = last_self = loop.time()
        me = psutil.Process()
        me.cpu_percent(None)
        if self.store is not None:
            self._db.submit(self._safe, self.store.prune, time.time(), self.retention)
        while True:
            try:
                self._broadcast(await asyncio.to_thread(self.collect_once))
            except Exception:
                log.exception("sampling tick failed")
            now = loop.time()
            if self.store is not None and now - last_prune > PRUNE_EVERY_S:
                last_prune = now
                self._db.submit(self._safe, self.store.prune, time.time(), self.retention)
            if now - last_self > SELF_LOG_EVERY_S:
                last_self = now
                log.debug(
                    "self: cpu %.2f%% rss %.1f MiB, %d subscribers",
                    me.cpu_percent(None),
                    me.memory_info().rss / 2**20,
                    len(self.subscribers),
                )
            next_t += interval
            if next_t < now:  # fell behind (e.g. suspended): resync instead of bursting
                next_t = now + interval
            await asyncio.sleep(next_t - now)

    # -- fan-out -----------------------------------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(QUEUE_SIZE)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def _broadcast(self, sample_json: str) -> None:
        if not self.subscribers:
            return
        self.publish(f'{{"type":"sample","node_id":{json.dumps(self.node_id)},"sample":{sample_json}}}')

    def publish(self, msg: str) -> None:
        """Send a pre-serialised stream message (e.g. "bench") to every subscriber."""
        for q in self.subscribers:
            if q.full():
                q.get_nowait()  # drop oldest for slow consumers
            q.put_nowait(msg)

    # -- history -----------------------------------------------------------------------------------------
    async def history(
        self, keys: list[str] | None, t_from: float | None, t_to: float | None, points: int = 600
    ) -> HistoryResponse:
        now = time.time()
        t_to = t_to if t_to is not None else now
        t_from = t_from if t_from is not None else t_to - 900
        points = max(1, min(points, 5000))
        ring = list(self.ring)
        interval = self.interval_ms / 1000
        # The ring's oldest sample (not its nominal window) decides: just after an agent restart the ring
        # holds a minute or two, and older data in the range is read from SQLite instead of being dropped.
        ring_oldest = ring[0][0] if ring else None
        res = choose_resolution(t_from, t_to, now, ring_oldest, interval, self.retention[10], points)
        loop = asyncio.get_running_loop()
        merged = False
        if res == interval or self.store is None:
            rows = await asyncio.to_thread(_ring_rows, ring, t_from, t_to, keys)
        else:
            rows = await loop.run_in_executor(self._db, self.store.query, int(res), t_from, t_to)
            if ring_oldest is not None and t_to > ring_oldest:
                # Whole buckets older than the ring; the newest part (incl. the open bucket, not in SQLite
                # yet) comes from the ring. With nothing older (a young agent): the ring alone, at full rate.
                older = [r for r in rows if r[0] + res / 2 <= ring_oldest]
                recent = await asyncio.to_thread(_ring_rows, ring, max(t_from, ring_oldest), t_to, keys)
                if older:
                    rows, merged = older + recent, True  # bucketed to one width below
                else:
                    rows, res = recent, interval
        bucketed = merged or len(rows) > points
        rows = await asyncio.to_thread(downsample, rows, t_from, t_to, points, keys, res, merged)
        all_keys = keys if keys is not None else sorted({k for _, d in rows for k in d})
        out = HistoryResponse(
            node_id=self.node_id,
            # The width of each returned point, not the source table's: clients draw buckets this wide.
            resolution_s=bucket_width(t_from, t_to, points, res) if bucketed else res,
            ts=[round(t, 3) for t, _ in rows],
            series={},
            min={},
            max={},
        )
        for k in all_keys:
            vals = [d.get(k) for _, d in rows]
            out.series[k] = [v[0] if v else None for v in vals]
            out.min[k] = [v[1] if v else None for v in vals]
            out.max[k] = [v[2] if v else None for v in vals]
        return out

    async def clear_history(self) -> None:
        self.ring.clear()
        if self.store is not None:
            await asyncio.get_running_loop().run_in_executor(self._db, self.store.clear)


def _ring_rows(
    ring: list[tuple[float, str]], t0: float, t1: float, keys: list[str] | None = None
) -> list[tuple[float, dict]]:
    """Ring samples in [t0, t1] as rows of {key: [avg, min, max]}, holding only ``keys`` (None: all). A full
    250 ms ring is 3600 samples of ~150 keys: keeping every key for a 2-key chart costs ~90 MB of RSS."""
    out = []
    for ts, js in ring:
        if t0 <= ts <= t1:
            flat = flatten(Sample.model_validate_json(js))
            if keys is not None:
                flat = {k: flat[k] for k in keys if k in flat}
            out.append((ts, {k: [v, v, v] for k, v in flat.items()}))
    return out
