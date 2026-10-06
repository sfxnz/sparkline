"""Sampler + FastAPI app with injected fake collectors (no hardware access)."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from sparkline.agent.app import create_app
from sparkline.agent.sampler import Sampler
from sparkline.agent.store import Store
from sparkline.common.schema import CpuSample, GpuSample, MemSample, NodeInfo, Sample

TOKEN = "s3cret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class FakeGpu:
    name = "gpu"

    def __init__(self) -> None:
        self.n = 0

    def collect(self) -> dict:
        self.n += 1
        return {"gpu": [GpuSample(index=0, util=float(self.n), temp_c=60.0, throttle_mask=0)]}


class FakeMem:
    name = "memory"

    def collect(self) -> dict:
        return {
            "mem": MemSample(
                total=100,
                available=40,
                used=60,
                free=10,
                anon=20,
                cache=25,
                shmem=5,
                kernel=5,
                other=30,
                swap_total=0,
                swap_used=0,
            )
        }


class FakeCpu:
    name = "cpu"

    def collect(self) -> dict:
        return {"cpu": CpuSample(util=5, per_core=[5.0], freq_mhz=[None], load1=0.1, load5=0.1, load15=0.1)}


class Broken:
    name = "thermal"

    def collect(self) -> dict:
        raise OSError("hwmon vanished")


def info() -> NodeInfo:
    return NodeInfo(
        node_id="n1",
        hostname="n1",
        agent_version="t",
        os="x",
        kernel="k",
        cpu_model="c",
        cores=[],
        mem_total=100,
        swap_total=0,
        gpus=[],
        net=[],
        disks=[],
        sensors=[],
        unsupported=[],
        tools={},
        sample_interval_ms=250,
        boot_time=0,
    )


def make(tmp_path, interval_ms=1000, collectors=None, ring_seconds=10):
    return Sampler(
        "n1",
        collectors or [FakeGpu(), FakeMem(), FakeCpu(), Broken()],
        interval_ms,
        ring_seconds=ring_seconds,
        store=Store(str(tmp_path)),
    )


def test_fault_isolation_and_ring(tmp_path):
    s = make(tmp_path)
    assert s.ring.maxlen == 10
    for _ in range(15):
        js = s.collect_once()
    smp = s.latest
    assert smp.errors == {"thermal": "OSError: hwmon vanished"}
    assert smp.gpu[0].util == 15 and smp.temps == [] and smp.mem.used == 60
    assert len(s.ring) == 10 and json.loads(s.ring[0][1])["seq"] == 6 and s.ring[-1] == (smp.ts, js)


def test_missing_mem_uses_last_good_and_flags(tmp_path):
    mem = FakeMem()
    s = make(tmp_path, collectors=[mem, FakeCpu()])
    s.collect_once()
    mem.collect = Broken.collect.__get__(mem)
    s.collect_once()
    smp = s.latest
    assert smp.mem.used == 60 and "memory" in smp.errors


def test_interval_validation(tmp_path):
    with pytest.raises(ValueError):
        make(tmp_path, interval_ms=100)


def test_rest_auth_snapshot_history(tmp_path):
    s = make(tmp_path, ring_seconds=900)
    app = create_app(s, info, TOKEN, manage_sampler=False)
    with TestClient(app) as c:
        assert c.get("/healthz").status_code == 200
        assert c.get("/api/v1/info").status_code == 401
        assert c.get("/api/v1/info", headers={"Authorization": "Bearer nope"}).status_code == 401
        assert c.get("/api/v1/info", headers=AUTH).json()["node_id"] == "n1"
        assert c.get("/api/v1/snapshot", headers=AUTH).status_code == 503
        for _ in range(5):
            s.collect_once()
        snap = c.get("/api/v1/snapshot", headers=AUTH).json()
        assert snap["seq"] == 5 and snap["errors"] == {"thermal": "OSError: hwmon vanished"}
        h = c.get("/api/v1/history", params={"keys": "gpu0.util,mem.used,nope"}, headers=AUTH).json()
        assert h["resolution_s"] == 1.0 and len(h["ts"]) == 5
        assert h["series"]["gpu0.util"] == [1.0, 2.0, 3.0, 4.0, 5.0]
        assert h["min"]["mem.used"] == [60.0] * 5 and h["max"]["gpu0.util"][-1] == 5.0
        assert h["series"]["nope"] == [None] * 5
        h = c.get("/api/v1/history", params={"keys": "gpu0.util", "points": 1}, headers=AUTH).json()
        assert (h["series"]["gpu0.util"], h["min"]["gpu0.util"], h["max"]["gpu0.util"]) == (
            [3.0],
            [1.0],
            [5.0],
        )
        assert c.get("/api/v1/history", params={"from": 10, "to": 5}, headers=AUTH).status_code == 400
        assert c.request("DELETE", "/api/v1/history", headers=AUTH, json={}).status_code == 400
        assert c.request("DELETE", "/api/v1/history", json={"confirm": "DELETE"}).status_code == 401
        r = c.request("DELETE", "/api/v1/history", headers=AUTH, json={"confirm": "DELETE"})
        assert r.status_code == 200 and len(s.ring) == 0


def test_websocket_hello_sample_and_auth(tmp_path):
    s = make(tmp_path, interval_ms=250)
    app = create_app(s, info, TOKEN)  # sampler loop runs inside the app lifespan
    with TestClient(app) as c:
        with pytest.raises(WebSocketDisconnect), c.websocket_connect("/api/v1/stream") as ws:
            ws.receive_text()
        with c.websocket_connect(f"/api/v1/stream?token={TOKEN}") as ws:
            hello = json.loads(ws.receive_text())
            assert hello["type"] == "hello" and hello["info"]["node_id"] == "n1"
            msg = json.loads(ws.receive_text())
            assert msg["type"] == "sample" and msg["node_id"] == "n1"
            assert msg["sample"]["gpu"][0]["util"] >= 1
        with c.websocket_connect("/api/v1/stream", headers=AUTH) as ws:
            assert json.loads(ws.receive_text())["type"] == "hello"
    assert s.subscribers == set()


def test_rollups_reach_sqlite(tmp_path):
    s = make(tmp_path)
    t0 = 1_000_000.0
    for i in range(25):  # 25 s of samples -> two closed 10 s buckets
        smp = s.tick()
        smp.ts = t0 + i
        s._record(smp)
    s._db.submit(lambda: None).result()
    rows = s._db.submit(s.store.query, 10, t0, t0 + 100).result()
    assert [ts for ts, _ in rows] == [t0 + 5, t0 + 15]  # served at bucket centres
    assert rows[0][1]["gpu0.util"] == [5.5, 1.0, 10.0]


async def test_run_discards_warmup_tick():
    """The first tick only primes delta collectors (their 'no previous reading' 0.0 is not data)."""
    gpu = FakeGpu()
    s = Sampler("n1", [gpu, FakeMem(), FakeCpu()], interval_ms=250)
    s.start()
    await asyncio.sleep(0.4)
    await s.stop()
    first = Sample.model_validate_json(s.ring[0][1])
    assert first.seq == 1 and first.gpu[0].util == 2.0  # call 1 was the warm-up
