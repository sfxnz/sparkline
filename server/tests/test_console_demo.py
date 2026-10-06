from __future__ import annotations

import asyncio
import json
import time

from sparkline.common.schema import ConsoleSettings, NodeInfo, Sample
from sparkline.console.cluster import Cluster
from sparkline.console.demo import DemoModel, DemoSource, demo_history
from sparkline.console.hub import Hub
from sparkline.console.store import Store

T0 = 1_791_280_000.0


def test_demo_samples_and_info_validate_against_schema():
    for node in ("spark1", "spark2", "spark3"):
        m = DemoModel(node, T0)
        NodeInfo.model_validate_json(m.info.model_dump_json())
        for i in range(0, 900, 3):  # covers thermal episode, storage error, stalls
            s = m.sample_at(T0 + i, i, procs=i % 5 == 0)
            assert Sample.model_validate(json.loads(s.model_dump_json())) == s


def test_demo_hardware_mirrors_discovery():
    info = DemoModel("spark1", T0).info
    perf = [c.id for c in info.cores if c.kind == "performance"]
    assert perf == [5, 6, 7, 8, 9, 15, 16, 17, 18, 19]
    assert {c.max_mhz for c in info.cores} == {2808.0, 3900.0}
    rails = {n.name: n for n in info.net if n.role == "interconnect" and n.ipv4}
    assert set(rails) == {"enp1s0f1np1", "enP2p1s0f1np1"} and rails["enp1s0f1np1"].rdma_device == "rocep1s0f1"
    assert info.gpus[0].name == "NVIDIA GB10" and info.gpus[0].power_limit_w is None
    assert {s.id for s in info.sensors} >= {"acpitz.6", "nvme.composite", "nvme.sensor_2", "mlx5.3"}
    # same keys the real agent reports on GB10 (checked live on spark1/spark2)
    gpu = {f"gpu0.{k}" for k in ("power_limit_w", "mem_mhz", "fan_pct", "fb_memory", "ecc", "pcie_bps")}
    assert {u.metric for u in info.unsupported} == gpu | {"fan", "system.power_w"}


def test_demo_dynamics_and_scripted_episodes():
    m1, m2 = DemoModel("spark1", T0), DemoModel("spark2", T0)
    # all-reduce: spark1 tx on rail A ~= spark2 rx on rail A
    for t in range(0, 600, 37):
        a, b = m1.sample_at(T0 + t), m2.sample_at(T0 + t)
        assert abs(a.net[0].tx_bps - b.net[0].rx_bps) <= 0.002 * a.net[0].tx_bps + 1
    # spark1 thermal episode: hot, sw+hw thermal bits, clocks drop
    hot = m1.sample_at(T0 + 40).gpu[0]
    assert hot.temp_c > 85 and hot.throttle_mask & 0x20 and hot.throttle_mask & 0x40 and hot.sm_mhz < 2000
    # spark2 storage collector error: disk=[] and an error entry; other collectors still report
    s = m2.sample_at(T0 + 105)
    assert s.disk == [] and "storage" in s.errors and s.fs
    # schedules
    m3 = DemoModel("spark3", T0)
    assert [m3.link_state(T0 + x) for x in (10, 35, 60, 95)] == ["ok", "stall", "refused", "ok"]
    assert m2.link_state(T0 + 85) == "stall" and m2.link_state(T0 + 95) == "ok"


def test_demo_history_resolution_and_determinism():
    m = DemoModel("spark1", T0)
    now = T0 + 10
    h = demo_history(m, ["gpu0.util", "gpu0.energy_j"], now - 3600, now, 600, now=now)
    assert h.resolution_s == 10 and 300 <= len(h.ts) <= 361
    assert all(len(v) == len(h.ts) for v in h.series.values())
    month = demo_history(m, ["gpu0.util"], now - 30 * 86400, now, 600, now=now)
    assert month.resolution_s % 60 == 0 and len(month.ts) <= 601
    assert demo_history(m, ["gpu0.util"], now - 3600, now, 60, now=now) == demo_history(
        DemoModel("spark1", T0), ["gpu0.util"], now - 3600, now, 60, now=now
    )
    energy = h.series["gpu0.energy_j"]
    assert all(b >= a for a, b in zip(energy, energy[1:], strict=False))


async def test_demo_failure_schedule_drives_stale_and_offline(tmp_path):
    """spark3 at 5x speed: online -> 4 s stall (stale) -> refused (offline + Problem) -> reconnect (online).

    The stall must exceed the 1 Hz agent's interval floor (2 * 1 s + 1 s) to count as stale."""
    store = Store(tmp_path / "c.sqlite")
    cluster = Cluster(store, Hub(), ConsoleSettings(stale_after_s=0.5, offline_after_s=30), demo=True)
    src = DemoSource("spark3", cluster, time.time(), speed=5)
    cluster.add_source(src)
    await cluster.start()
    seen: list[str] = []
    problem = None
    try:
        deadline = time.time() + 45
        while time.time() < deadline:
            st = src.state
            if not seen or seen[-1] != st.status:
                seen.append(st.status)
                if st.status == "offline":
                    problem = st.error
            if seen[-3:] == ["stale", "offline", "online"]:
                break
            await asyncio.sleep(0.05)
    finally:
        await cluster.stop()
    assert seen[-4:] == ["online", "stale", "offline", "online"], seen
    assert problem is not None and problem.message == "Agent unreachable on spark3"
    assert problem.cause == "Connection refused at 10.20.20.61:9750"


def test_demo_gpu_matches_discovery_numbers():
    """GB10 measured: ~30-35 W, SM ~2171 MHz at ~90 % util; idle ~4-5 W at 208 MHz; capping is not routine."""
    for node in ("spark1", "spark2"):
        m = DemoModel(node, T0)
        busy, idle, capped = [], [], 0
        for i in range(0, 3600, 5):
            g = m.sample_at(T0 + i).gpu[0]
            hot = m.thermal(T0 + i) > 0
            capped += bool(g.throttle_mask & 0x4) and not hot
            if hot:
                continue
            if g.util >= 85:
                busy.append(g)
            elif g.util < 5:
                idle.append(g)
        assert busy and capped == 0, node
        assert all(28 <= g.power_w <= 40 and 2100 <= g.sm_mhz <= 2300 for g in busy), node
        assert idle and all(g.power_w <= 8 and g.sm_mhz == 208 and g.throttle_mask == 0 for g in idle), node
