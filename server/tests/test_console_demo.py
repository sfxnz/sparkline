from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import time

import pytest
from fastapi.testclient import TestClient

from sparkline.common.metrics import flatten
from sparkline.common.schema import ConsoleSettings, NodeInfo, Sample
from sparkline.common.throttle import POWER_CAP_BIT
from sparkline.console.app import create_app
from sparkline.console.cluster import Cluster
from sparkline.console.config import ConsoleConfig
from sparkline.console.demo import DemoModel, DemoSource, demo_history
from sparkline.console.demo_fleets import FLEETS
from sparkline.console.hub import Hub
from sparkline.console.store import Store

T0 = 1_791_280_000.0
THERMAL_BITS = 0x20 | 0x40


def ws1(t0: float = T0):
    return FLEETS["mixed"]["ws1"](t0, 1.0)


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
    assert {u.metric for u in info.unsupported} == gpu | {"cpu.temp", "fan", "system.power_w"}
    hidden = {n.name for n in info.net if n.role in ("virtual", "wireless")}
    assert hidden == {"docker0", "tailscale0", "wlP9s9"}


def test_demo_dynamics_and_scripted_episodes():
    m1, m2 = DemoModel("spark1", T0), DemoModel("spark2", T0)
    # all-reduce: spark1 tx on rail A ~= spark2 rx on rail A
    for t in range(0, 600, 37):
        a, b = m1.sample_at(T0 + t), m2.sample_at(T0 + t)
        assert abs(a.net[0].tx_bps - b.net[0].rx_bps) <= 0.002 * a.net[0].tx_bps + 1
    # spark1 thermal episode: hot, sw+hw thermal bits, clocks drop
    hot = m1.sample_at(T0 + 90).gpu[0]
    assert hot.temp_c > 85 and hot.throttle_mask & 0x20 and hot.throttle_mask & 0x40 and hot.sm_mhz < 2000
    # spark2 storage collector error: disk=[] and an error entry; other collectors still report
    s = m2.sample_at(T0 + 245)
    assert s.disk == [] and "storage" in s.errors and s.fs
    # schedules
    m3 = DemoModel("spark3", T0)
    states = [m3.link_state(T0 + x) for x in (10, 155, 180, 215, 305)]
    assert states == ["ok", "stall", "refused", "ok", "stall"]
    assert m2.link_state(T0 + 125) == "stall" and m2.link_state(T0 + 135) == "ok"


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
    assert h.ts[0] % 10 == 5  # stamped at bucket centres, like agent rollups


def test_demo_energy_integrates_the_power_series():
    """History energy must agree with the power chart, and differ between nodes with different loads."""
    now = T0 + 10
    inc = {}
    for nid in ("spark1", "spark3"):
        keys = ["gpu0.energy_j", "gpu0.power_w"]
        h = demo_history(DemoModel(nid, T0), keys, now - 6 * 3600, now, 600, now=now)
        e, p = h.series["gpu0.energy_j"], h.series["gpu0.power_w"]
        span = h.ts[-1] - h.ts[0]
        mean_p = sum(x for x in p if x is not None) / len(p)
        inc[nid] = (e[-1] or 0) - (e[0] or 0)
        assert inc[nid] == pytest.approx(mean_p * span, rel=0.03)
    assert abs(inc["spark1"] - inc["spark3"]) > 0.05 * inc["spark1"]


async def test_demo_failure_schedule_drives_stale_and_offline(tmp_path):
    """spark3 at 5x speed: online -> 4 s stall (stale) -> refused (offline + Problem) -> reconnect (online).

    The stall must exceed the 1 Hz agent's interval floor (2 * 1 s + 1 s) to count as stale."""
    store = Store(tmp_path / "c.sqlite")
    cluster = Cluster(store, Hub(), ConsoleSettings(stale_after_s=0.5, offline_after_s=30), demo=True)
    model = DemoModel("spark3", time.time() - 130 / 5, speed=5)  # 20 scenario-s before the stall
    src = DemoSource(model, cluster)
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
    assert problem.cause == "Connection refused at 198.51.100.61:9750"


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


def test_the_mixed_fleet_runs_a_four_gpu_workstation_beside_the_dgx_cluster(tmp_path):
    cfg = ConsoleConfig(token="", agent_token="a", web_dist=tmp_path / "missing-dist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True, fleet="mixed")) as c:
        deadline = time.time() + 10
        while time.time() < deadline:
            nodes = {n["node_id"]: n for n in c.get("/api/v1/cluster").json()["nodes"]}
            if nodes["ws1"]["info"]:
                break
            time.sleep(0.05)
    assert list(nodes) == ["spark1", "spark2", "spark3", "ws1"]
    gpus = nodes["ws1"]["info"]["gpus"]
    assert [g["index"] for g in gpus] == [0, 1, 2, 3]
    assert {g["name"] for g in gpus} == {"NVIDIA RTX 6000 Ada Generation"}
    assert len({g["uuid"] for g in gpus}) == 4


def test_workstation_samples_stay_plausible_over_a_long_span():
    m = ws1()
    gpu = m.info.gpus[0]
    assert gpu.power_limit_w == 300.0 and gpu.temp_shutdown_c is not None and gpu.temp_slowdown_c is not None
    last = [0.0] * 4
    bits = [0] * 4
    for i in range(0, 2 * 3600, 3):
        s = m.sample_at(T0 + i, i, procs=i % 300 == 0)
        if i % 300 == 0:
            assert Sample.model_validate(json.loads(s.model_dump_json())) == s
        assert [g.index for g in s.gpu] == [0, 1, 2, 3] and s.mem.gpu is None
        for g in s.gpu:
            assert 0 <= g.util <= 100
            assert g.power_w <= gpu.power_limit_w * 1.02, (i, g)
            assert g.temp_c < gpu.temp_shutdown_c, (i, g)
            assert g.energy_j > last[g.index], (i, g)
            last[g.index] = g.energy_j
            bits[g.index] |= g.throttle_mask
    assert bits[3] & THERMAL_BITS == THERMAL_BITS
    assert [b & THERMAL_BITS for b in bits[:3]] == [0, 0, 0]
    hot = m.sample_at(T0 + 115).gpu
    assert hot[3].temp_c > gpu.temp_slowdown_c and hot[3].sm_mhz < min(g.sm_mhz for g in hot[:3]) * 0.75
    assert max(hot[:3], key=lambda g: g.temp_c).index == 2


def test_an_unlimited_workstation_gpu_runs_clear_of_the_full_speed_cut():
    m = ws1()
    top = m.info.gpus[0].sm_mhz_max or 0.0
    samples = [m.sample_at(T0 + i) for i in range(0, 3600, 3)]
    clocks = [g.sm_mhz or 0.0 for s in samples for g in s.gpu if g.throttle_mask == 0]
    # The GPU tab calls a clock at or above 80 % of the maximum "full speed"; stay well clear of that cut.
    assert top > 0 and clocks and min(clocks) >= 0.85 * top


def test_sample_noise_never_flips_a_workstation_gpus_power_cap_for_one_sample():
    m = ws1()
    caps = [[bool(g.throttle_mask & 0x4) for g in m.sample_at(T0 + k).gpu] for k in range(3 * 3600)]
    for i in range(4):
        bits = [row[i] for row in caps]
        assert any(bits) and not all(bits), i
        blips = [k for k in range(1, len(bits) - 1) if bits[k - 1] == bits[k + 1] != bits[k]]
        assert blips == [], (i, blips[:5])


def test_a_workstation_gpus_power_cap_holds_between_its_off_and_on_points(monkeypatch):
    m = ws1()
    t1 = T0 + 1000

    def draw(i: int, t: float, noise: bool = True) -> float:
        return 300.0 if t < t1 else 293.0 if t < t1 + 400 else 285.0

    monkeypatch.setattr(m, "raw_power", draw)

    def capped(t: float) -> bool:
        return bool(next(g for g in m.sample_at(t).gpu if g.index == 0).throttle_mask & POWER_CAP_BIT)

    assert all(capped(t1 + k) for k in range(0, 400, 9))
    assert not capped(t1 + 400)


def _cap_bit(m, t: float) -> bool:
    return bool(next(g for g in m.sample_at(t).gpu if g.index == 0).throttle_mask & POWER_CAP_BIT)


def test_a_workstation_gpus_power_cap_clears_once_10_s_have_passed_since_the_draw_was_last_above_on(
    monkeypatch,
):
    m = ws1()
    t1 = T0 + 1000
    monkeypatch.setattr(m, "raw_power", lambda i, t, noise=True: 299.0 if t < t1 else 280.0)
    last_above = t1 - 1
    assert [_cap_bit(m, last_above + s) for s in (9, 10)] == [True, False]


def test_a_workstation_gpus_power_cap_clears_after_10_min_between_its_points_and_looks_back_no_further(
    monkeypatch,
):
    m = ws1()
    t1 = T0 + 1000
    calls: list[float] = []

    def draw(i: int, t: float, noise: bool = True) -> float:
        calls.append(t)
        return 299.0 if t < t1 else 293.0

    monkeypatch.setattr(m, "raw_power", draw)
    last_above = t1 - 1
    assert [_cap_bit(m, last_above + s) for s in (599, 600)] == [True, False]
    calls.clear()
    assert not m.power_capped(0, t1 + 86400)
    assert len(calls) <= 600


def test_a_workstation_gpu_at_full_draw_before_boot_shows_its_power_cap():
    m = ws1()
    h = demo_history(m, None, T0 - 7 * 86400, T0, 2000, now=T0)
    full_draw_w = 299.6  # more than the 1.2 W of sample noise above the 296.4 W on point
    for i in range(4):
        draw = h.max[f"gpu{i}.power_w"]
        full = [k for k, t in enumerate(h.ts) if t < m.boot and (draw[k] or 0) > full_draw_w]
        assert full, i
        for k in full:
            assert (h.series[f"gpu{i}.power_capped_pct"][k] or 0) > 0, (i, h.ts[k] - m.boot)
            assert int(h.series[f"gpu{i}.throttle_mask"][k] or 0) & POWER_CAP_BIT, (i, h.ts[k] - m.boot)


def test_the_workstation_carries_only_documentation_addresses_and_local_macs():
    docs = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
    m = ws1()
    for n in m.info.net:
        assert all(any(ipaddress.ip_address(a) in d for d in docs) for a in n.ipv4), n
        first = int(n.mac.split(":")[0], 16)
        assert first & 0x02 and not first & 0x01, n.mac  # locally administered, unicast


def test_every_mixed_fleet_gpu_carries_a_placeholder_uuid():
    uuids = [g.uuid or "" for make in FLEETS["mixed"].values() for g in make(T0, 1.0).info.gpus]
    assert len(set(uuids)) == len(uuids) == 7
    assert all(re.fullmatch(r"GPU-00000000-0000-0000-0000-0000[0-9a-f]{8}", u) for u in uuids), uuids


def test_the_workstation_reports_its_platform_gpu_backend_and_versions_as_an_nvml_agent_does():
    info = ws1().info
    assert info.platform == "linux"
    assert info.versions == {
        "nvidia.Driver": "580.95.05",
        "nvidia.CUDA": "13.0",
        "nvidia.NVML": "13.580.95.05",
    }
    assert {(g.vendor, g.backend) for g in info.gpus} == {("nvidia", "nvml")}


def test_workstation_flattens_to_four_gpus_and_declares_no_rdma():
    m = ws1()
    keys = flatten(m.sample_at(T0, procs=True))
    assert {k.split(".")[0] for k in keys if k.startswith("gpu")} == {"gpu0", "gpu1", "gpu2", "gpu3"}
    assert "mem.gpu" not in keys
    assert not [n.name for n in m.info.net if n.rdma_device or n.role == "interconnect"]
    assert {u.metric for u in m.info.unsupported} == {"fan", "system.power_w"}
    assert len(m.info.cores) == 64 and {c.cluster for c in m.info.cores} == {0, 1, 2, 3}
    assert {"temp.k10temp.tctl", "temp.nvme.composite", "temp.nvme1.composite"} <= set(keys)
    procs = m.sample_at(T0, procs=True).procs or []
    assert sorted(p.gpu_mem for p in procs if p.gpu_mem) == pytest.approx([43.4e9] * 4, rel=0.01)


def test_demo_history_works_for_the_workstation():
    m = ws1()
    now = T0 + 600
    keys = ["gpu0.util", "gpu3.temp_c", "gpu3.energy_j"]
    h = demo_history(m, keys, now - 3600, now, 600, now=now)
    assert h.node_id == "ws1" and h.resolution_s == 10 and set(h.series) == set(keys)
    assert all(len(v) == len(h.ts) and None not in v for v in h.series.values())
    energy = h.series["gpu3.energy_j"]
    assert all(b > a for a, b in zip(energy, energy[1:], strict=False))


class _Collect:
    def __init__(self) -> None:
        self.samples: list[Sample] = []

    def on_hello(self, src) -> None:
        pass

    def on_sample(self, src, s: Sample) -> None:
        self.samples.append(s)

    def on_status(self, src, old) -> None:
        pass


@pytest.mark.parametrize("node", ["spark1", "ws1"])
async def test_the_live_energy_counter_of_every_gpu_integrates_its_power(node):
    listener = _Collect()
    src = DemoSource(FLEETS["mixed"][node](time.time(), 1.0), listener)
    src.interval = 0.01
    task = asyncio.create_task(src.session())
    try:
        while len(listener.samples) < 8:
            await asyncio.sleep(0.01)
    finally:
        task.cancel()
    first, rest = listener.samples[0], listener.samples[1:]
    for i, g in enumerate(first.gpu):
        gained = rest[-1].gpu[i].energy_j - g.energy_j
        assert gained == pytest.approx(sum(s.gpu[i].power_w for s in rest) * 0.01, abs=0.2), i
