"""--demo: simulated DGX Spark nodes behind the NodeSource interface, plus synthetic history.

Telemetry is a deterministic function of wall time (seeded smooth noise + per-second jitter), so live samples
and synthesized history share one model. Scripted failures run on "scenario time" = elapsed * demo_speed:
  spark3: online 90 s -> stops sending 20 s (stale) -> connection refused 40 s (offline) -> reconnects
  spark2: stream stalls 8 s every 4 min; storage collector error (disk=[]) 15 s every 5 min
  spark1: thermal episode every 6 min (~87 °C, sw_thermal then hw_thermal, clocks drop) for ~40 s
Offsets put the first of each in the first two minutes so a short demo shows them.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import math
import time

from ..common.metrics import BITMASK_KEYS_SUFFIX, COUNTER_KEYS_SUFFIX, flatten
from ..common.schema import (
    CoreInfo,
    CpuSample,
    DiskInfo,
    DiskSample,
    FsSample,
    GpuInfo,
    GpuSample,
    HistoryResponse,
    MemSample,
    NetIfInfo,
    NetSample,
    NodeInfo,
    ProcSample,
    Sample,
    SensorInfo,
    TempSample,
    Unsupported,
)
from .nodes import Listener, NodeSource

GIB = 1 << 30
MEM_TOTAL = 127_658_684 * 1024  # 121.7 GiB (MemTotal)
SWAP_TOTAL = 16 * GIB
FS_TOTAL = 3_936_502_300_672
DISK_SIZE = 4_000_787_030_016
PERF = [5, 6, 7, 8, 9, 15, 16, 17, 18, 19]  # Cortex-X925
EFF = [0, 1, 2, 3, 4, 10, 11, 12, 13, 14]  # Cortex-A725
ACPI_BASE = [63, 65, 67, 72, 68, 64, 70]
MODEL_PATH = "/root/.cache/huggingface/hub/models--sfxnz--DeepSeek-V4.1-Flash-EXL3/snapshots/3f2a9c1e"

NODES = {  # node_id -> (LAN ip, rail A ip, rail B ip, peer, root used fraction, workload)
    "spark1": ("10.20.20.48", "10.100.8.1", "10.100.9.1", "spark2", 0.82, "tp2"),
    "spark2": ("10.20.20.195", "10.100.8.2", "10.100.9.2", "spark1", 0.84, "tp2"),
    "spark3": ("10.20.20.61", None, None, None, 0.61, "vllm"),
}
RAILS = [
    ("enp1s0f1np1", "rocep1s0f1", "ConnectX-7 rail A"),
    ("enP2p1s0f1np1", "roceP2p1s0f1", "ConnectX-7 rail B"),
]
SPARE_PORTS = [
    ("enp1s0f0np0", "rocep1s0f0", "ConnectX-7 port (no cable)"),
    ("enP2p1s0f0np0", "roceP2p1s0f0", "ConnectX-7 port (no cable)"),
]
LAN = "enP7s7"

# Copied from the real agent's NodeInfo on spark1 (GB10), so demo and hardware render identically.
UNSUPPORTED = [
    Unsupported(
        metric=f"gpu0.{key}", reason=f"{label} not reported by NVIDIA GB10 (NVML: Not Supported){extra}"
    )
    for key, label, extra in [
        ("power_limit_w", "Power limit", ""),
        ("mem_mhz", "Memory clock", ""),
        ("fan_pct", "Fan speed", ""),
        ("fb_memory", "Dedicated GPU memory (FB)", " — unified memory is reported under Memory instead"),
        ("ecc", "ECC", ""),
        ("pcie_bps", "PCIe throughput", ""),
    ]
] + [
    Unsupported(metric="fan", reason="No fan sensors exposed by this hardware (hwmon)"),
    Unsupported(
        metric="system.power_w", reason="Whole-system power is not exposed; only the GPU rail (NVML) is"
    ),
]
TOOLS = {
    "docker": True,
    "fio": False,
    "perftest": True,
    "nccl_tests": False,
    "nvcc": True,
    "pytorch_image": True,
}


def _h(*parts: object) -> float:
    """Deterministic hash -> [-1, 1)."""
    d = hashlib.blake2b(repr(parts).encode(), digest_size=8).digest()
    return int.from_bytes(d, "big") / 2**63 - 1.0


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


class Smooth:
    """Deterministic smooth noise, roughly in [-1, 1]: a few sines with seeded periods and phases."""

    def __init__(self, key: str, periods: tuple[float, ...]):
        self.c = [
            (2 * math.pi / (p * (1 + 0.2 * _h(key, i, "p"))), math.pi * (1 + _h(key, i, "ph")), 1 / (i + 1))
            for i, p in enumerate(periods)
        ]
        self.norm = sum(a for _, _, a in self.c) * 0.7

    def __call__(self, t: float) -> float:
        return _clamp(sum(a * math.sin(w * t + ph) for w, ph, a in self.c) / self.norm, -1.0, 1.0)


def _episode(p: float, ramp: float, hold: float, fall: float) -> float:
    """0..1 envelope: ramp up, hold, ramp down."""
    if p < 0:
        return 0.0
    if p < ramp:
        return p / ramp
    if p < ramp + hold:
        return 1.0
    if p < ramp + hold + fall:
        return 1.0 - (p - ramp - hold) / fall
    return 0.0


class DemoModel:
    def __init__(self, node_id: str, t0: float, speed: float = 1.0):
        self.node_id = node_id
        self.t0 = t0
        self.speed = speed
        self.lan_ip, self.ip_a, self.ip_b, self.peer, self.root_frac, self.workload = NODES[node_id]
        load_key = "cluster" if self.workload == "tp2" else node_id  # TP=2: both nodes busy together
        self.waves = Smooth(load_key + "waves", (45, 170, 610))
        self.valley = Smooth(load_key + "valley", (430, 1300))
        self.burst = Smooth("cluster-burst", (23, 61))
        self.disk_burst = Smooth(node_id + "disk", (240, 700))
        self.slow = Smooth(node_id + "slow", (1800, 5400))
        self.blip = Smooth(node_id + "psi", (90, 300))
        self.core_noise = [Smooth(f"{node_id}core{i}", (20, 75)) for i in range(20)]
        self.boot = t0 - 3.2 * 86400 - 3600 * (1 + _h(node_id, "boot"))
        self.info = self._info()

    # -- scenario ------------------------------------------------------------------------------------
    def scen(self, t: float) -> float:
        return (t - self.t0) * self.speed

    def link_state(self, t: float) -> str:
        """'ok' | 'stall' (connected, no samples) | 'refused' (agent down)."""
        s = self.scen(t)
        if self.node_id == "spark3":
            p = (s + 60) % 150
            return "ok" if p < 90 else "stall" if p < 110 else "refused"
        if self.node_id == "spark2" and (s + 150) % 240 >= 232:
            return "stall"
        return "ok"

    def thermal(self, t: float) -> float:
        if self.node_id != "spark1":
            return 0.0
        return _episode((self.scen(t) - 15) % 360, 12, 25, 15)

    def storage_error(self, t: float) -> bool:
        return self.node_id == "spark2" and (self.scen(t) + 200) % 300 < 15

    # -- workload ------------------------------------------------------------------------------------
    def diurnal(self, t: float) -> float:
        hour = time.localtime(t).tm_hour + time.localtime(t).tm_min / 60
        return 0.72 + 0.28 * math.cos((hour - 16) / 24 * 2 * math.pi)  # busiest late afternoon

    def shared_busy(self, t: float) -> tuple[float, float]:
        """(busy 0..1, active 0..1): request intensity and whether the server is serving at all.

        For the TP=2 pair this is identical on both nodes (same load key)."""
        scale = 1.0 if self.workload == "tp2" else 0.6
        b = _clamp(0.5 + 0.75 * self.waves(t), 0, 1) * self.diurnal(t) * scale
        return b, _clamp((self.valley(t) + 0.9) / 0.08, 0, 1)

    def busy(self, t: float) -> tuple[float, float]:
        b, active = self.shared_busy(t)
        heat = self.thermal(t)
        if heat:  # the thermal episode happens under full load
            b, active = max(b, heat), max(active, min(1.0, 4 * heat))
        return b, active

    def util(self, t: float) -> float:
        b, a = self.busy(t)
        return _clamp(a * (55 + 43 * b) + (1 - a) * 1.5 + 1.5 * _h(self.node_id, "u", int(t)), 0, 100)

    def raw_power(self, t: float) -> float:
        """GB10 GPU rail: ~4 W idle, ~30-35 W at ~90 % util (DISCOVERY); thermal episode > 40 W."""
        return 4 + 0.33 * self.util(t) + 8 * self.thermal(t) + 0.8 * _h(self.node_id, "p", int(t))

    def cpu_expected(self, t: float) -> float:
        b, a = self.busy(t)
        return 10 * (16 + 42 * b * a) + 10 * (4 + 9 * b * a) + 50 * a

    def rail_flow(self, t: float, src: str, rail: int) -> float:
        b, a = self.shared_busy(t)
        base = 2.2e9 * b * a
        x = self.burst(t)
        peak = 19e9 * (x - 0.5) / 0.5 if x > 0.5 else 0.0
        return _clamp((base + peak * a) * (0.985 + 0.03 * _h(src, rail, int(t))), 0, 23.4e9)

    # -- sample --------------------------------------------------------------------------------------
    def sample_at(self, t: float, seq: int = 0, procs: bool = False) -> Sample:
        nid = self.node_id
        j = lambda key: _h(nid, key, int(t))  # noqa: E731 - per-second jitter in [-1, 1)
        b, active = self.busy(t)
        heat = self.thermal(t)

        util = self.util(t)
        raw = self.raw_power(t)
        capped = _clamp((raw - 40) / 4 * 100, 0, 100)  # power capping only in the thermal episode
        power = 40 + (raw - 40) * 0.5 if raw > 40 else raw
        lag = 0.4 * self.raw_power(t - 8) + 0.35 * self.raw_power(t - 25) + 0.25 * self.raw_power(t - 60)
        temp = 40 + 0.9 * lag + 0.4 * j("t")  # ~44 °C idle (40-45 measured), ~70 °C at 90 % util
        temp += heat * (87.6 + 0.4 * j("th") - temp)
        mask = 0  # measured idle GB10 reports no clocks-event reasons (0x0) at 208 MHz
        sm = 2200 + 80 * j("sm") if util >= 5 else 208.0  # DISCOVERY: SM 2171 of 3003 MHz under load
        if capped > 5:
            mask |= 0x4
            sm -= capped / 100 * 460
        thermal_pct = 0.0
        if temp >= 84:
            mask |= 0x20
            sm *= 0.86
            thermal_pct = 40.0
        if temp >= 86.5:
            mask |= 0x40
            sm *= 0.72
            thermal_pct = 100.0
        gpu = GpuSample(
            index=0,
            util=round(util, 1),
            sm_mhz=round(sm),
            gr_mhz=round(sm),
            video_mhz=1785.0,
            temp_c=round(temp, 1),
            power_w=round(power, 2),
            energy_j=round(25.0 * (t - self.boot), 1),
            pstate=0,
            throttle_mask=mask,
            power_capped_pct=round(capped if capped > 5 else 0.0, 1),
            thermal_capped_pct=thermal_pct,
        )

        # unified memory
        if self.workload == "tp2":
            gpu_mem = int(86.0e9 + 0.12e9 * self.slow(t))
        else:
            gpu_mem = int(61.0e9 + 0.1e9 * self.slow(t))
        anon = int(5.0 * GIB + 0.25 * GIB * self.slow(t + 900))
        shmem, kernel, other = int(1.4 * GIB), int(3.6 * GIB + 0.1 * GIB * self.slow(t + 300)), int(1.8 * GIB)
        disk_x = self.disk_burst(t)
        cache = int(15 * GIB + 4 * GIB * self.slow(t + 1700) + (2 * GIB if disk_x > 0.6 else 0))
        used = gpu_mem + anon + shmem + kernel + other
        available = MEM_TOTAL - used
        psi = max(0.0, self.blip(t) - 0.62) * 22
        mem = MemSample(
            total=MEM_TOTAL,
            available=available,
            used=used,
            free=max(available - cache, GIB // 2),
            gpu=gpu_mem,
            anon=anon,
            cache=cache,
            shmem=shmem,
            kernel=kernel,
            other=other,
            swap_total=SWAP_TOTAL,
            swap_used=int(4.1 * GIB + 0.2 * GIB * self.slow(t + 2500)),
            psi_some=round(psi, 2),
            psi_full=round(psi * 0.35, 2),
        )

        # CPU: X925 cores carry the serving threads; core 7 holds the busy-polling main thread
        per_core, freq = [0.0] * 20, [0.0] * 20
        for c in PERF:
            u = 16 + 42 * b * active + 10 * self.core_noise[c](t) + 4 * j(f"c{c}")
            if c == 7 and self.workload == "tp2":
                u = 93 + 5 * j("c7") if active > 0.5 else u
            per_core[c] = round(_clamp(u, 0, 100), 1)
            freq[c] = round(3900 * (0.96 + 0.04 * abs(j(f"f{c}")))) if u > 8 else 3402.0
        for c in EFF:
            u = 4 + 9 * b * active + 4 * self.core_noise[c](t) + 2 * j(f"c{c}")
            per_core[c] = round(_clamp(u, 0, 100), 1)
            freq[c] = round(2808 * (0.95 + 0.05 * abs(j(f"f{c}")))) if u > 8 else 2106.0
        cpu = CpuSample(
            util=round(sum(per_core) / 20, 1),
            perf_util=round(sum(per_core[c] for c in PERF) / 10, 1),
            eff_util=round(sum(per_core[c] for c in EFF) / 10, 1),
            per_core=per_core,
            freq_mhz=freq,
            load1=round(self.cpu_expected(t) / 100 + 0.4 + 0.2 * j("l1"), 2),
            load5=round(sum(self.cpu_expected(t - d) for d in (30, 120, 240)) / 300 + 0.4, 2),
            load15=round(sum(self.cpu_expected(t - d) for d in (120, 450, 800)) / 300 + 0.4, 2),
            psi_some=round(max(0.0, self.blip(t + 40) - 0.7) * 10, 2),
        )

        # network: rails carry the TP=2 all-reduce; this node's tx is the peer's rx on the same rail
        net = []
        for i, (name, _rdma, _label) in enumerate(RAILS):
            if self.peer:
                tx = self.rail_flow(t, nid, i)
                rx = self.rail_flow(t, self.peer, i) * 0.999
                err = 1.0 if _h(nid, name, "err", int(t)) > 0.9995 else 0.0
                net.append(
                    NetSample(
                        name=name,
                        up=True,
                        speed_mbps=200000,
                        rx_bps=round(rx),
                        tx_bps=round(tx),
                        errors=err,
                        rdma_state="ACTIVE",
                        rdma_rate="200 Gb/sec (4X HDR)",
                    )
                )
            else:
                net.append(NetSample(name=name, up=False, rx_bps=0, tx_bps=0, rdma_state="DOWN"))
        for name, _rdma, _label in SPARE_PORTS:
            net.append(NetSample(name=name, up=False, rx_bps=0, tx_bps=0, rdma_state="DOWN"))
        net.append(
            NetSample(
                name=LAN,
                up=True,
                speed_mbps=10000,
                rx_bps=round(60e3 + 380e3 * b * active + 20e3 * j("lr")),
                tx_bps=round(150e3 + 1.4e6 * b * active + 50e3 * j("lt")),
            )
        )

        # storage
        errors: dict[str, str] = {}
        disk: list[DiskSample] = []
        if self.storage_error(t):
            errors["storage"] = "Failed to read /proc/diskstats: [Errno 5] Input/output error"
        else:
            rd = 3e6 + 2e6 * j("dr") + (2.6e9 * (disk_x - 0.75) / 0.25 if disk_x > 0.75 else 0.0)
            wr = 12e6 + 9e6 * j("dw")
            disk.append(
                DiskSample(
                    name="nvme0n1",
                    read_bps=round(rd),
                    write_bps=round(wr),
                    read_iops=round(rd / 131072 + 30),
                    write_iops=round(wr / 16384 + 12),
                    busy_pct=round(_clamp(rd / 3.2e9 * 100 + wr / 1.5e9 * 100 + 1, 0, 100), 1),
                )
            )
        root_used = int(FS_TOTAL * (self.root_frac + 0.002 * self.slow(t)))
        fs = [
            FsSample(
                mount="/",
                key="root",
                device="/dev/nvme0n1p2",
                total=FS_TOTAL,
                used=root_used,
                free=FS_TOTAL - root_used,
            ),
            FsSample(
                mount="/boot/efi",
                key="boot_efi",
                device="/dev/nvme0n1p1",
                total=1_124_999_168,
                used=6_709_248,
                free=1_118_289_920,
            ),
        ]

        load_heat = 5 * b * active + 6 * heat
        nvme = 46 + 5 * _clamp(disk_x, 0, 1) + 1.5 * self.slow(t + 60)
        net_x = _clamp(self.burst(t), 0, 1) if self.peer else 0.0
        temps = [
            TempSample(id=f"acpitz.{i}", c=round(base + load_heat + 0.8 * self.core_noise[i](t), 1))
            for i, base in enumerate(ACPI_BASE)
        ]
        temps += [
            TempSample(id="nvme.composite", c=round(nvme, 1)),
            TempSample(id="nvme.sensor_1", c=round(nvme + 9, 1)),
            TempSample(id="nvme.sensor_2", c=round(nvme - 2, 1)),
        ]
        temps += [
            TempSample(id=f"mlx5.{i}", c=round(62 + 5 * net_x + 2 * b + 0.6 * j(f"m{i}"), 1))
            for i in range(4)
        ]

        return Sample(
            node_id=nid,
            ts=t,
            seq=seq,
            interval_ms=1000,
            gpu=[gpu],
            mem=mem,
            cpu=cpu,
            net=net,
            disk=disk,
            fs=fs,
            temps=temps,
            procs=self._procs(t, gpu_mem, util, b) if procs else None,
            errors=errors,
        )

    def _procs(self, t: float, gpu_mem: int, util: float, b: float) -> list[ProcSample]:
        j = lambda key: _h(self.node_id, key, int(t))  # noqa: E731
        if self.workload == "tp2":
            rank = 0 if self.node_id == "spark1" else 1
            main = ProcSample(
                pid=48213 + rank * 7,
                name="python",
                cmdline=f"python serve_stats.py --model {MODEL_PATH} --tp 2 --rank {rank} --host 0.0.0.0 "
                "--port 8000 --max-batch 32",
                user="root",
                cpu_pct=round(100 + 60 * b + 5 * j("pc"), 1),
                rss=int(4.6 * GIB),
                gpu_mem=gpu_mem,
                gpu_util=round(util, 1),
                container="c5-2B-r0",
                model="DeepSeek-V4.1-Flash-EXL3",
            )
        else:
            main = ProcSample(
                pid=30544,
                name="python3",
                cmdline="python3 -m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-32B "
                "--gpu-memory-utilization 0.5 --port 8001",
                user="root",
                cpu_pct=round(60 + 40 * b + 5 * j("pc"), 1),
                rss=int(6.1 * GIB),
                gpu_mem=gpu_mem,
                gpu_util=round(util, 1),
                container="vllm-qwen3",
                model="Qwen3-32B",
            )
        system = [
            (
                1873,
                "dockerd",
                "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock",
                "root",
                0.4,
                112 << 20,
            ),
            (1622, "containerd", "/usr/bin/containerd", "root", 0.2, 61 << 20),
            (
                2301,
                "sparkline-agent",
                "/opt/sparkline/venv/bin/python -m sparkline.agent.main",
                "spark",
                0.7,
                58 << 20,
            ),
            (
                1544,
                "tailscaled",
                "/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state",
                "root",
                0.3,
                52 << 20,
            ),
            (512, "systemd-journald", "/usr/lib/systemd/systemd-journald", "root", 0.1, 41 << 20),
        ]
        return [main] + [
            ProcSample(
                pid=pid,
                name=name,
                cmdline=cmd,
                user=user,
                cpu_pct=round(max(0.0, cpu + 0.1 * j(name)), 1),
                rss=rss,
            )
            for pid, name, cmd, user, cpu, rss in system
        ]

    def _info(self) -> NodeInfo:
        cluster = lambda c: 1 if 1 <= c <= 10 else 0  # noqa: E731 - cpu1-10 vs cpu0,11-19
        cores = [
            CoreInfo(
                id=c,
                kind="performance" if c in PERF else "efficiency",
                model="Cortex-X925" if c in PERF else "Cortex-A725",
                max_mhz=3900.0 if c in PERF else 2808.0,
                cluster=cluster(c),
            )
            for c in range(20)
        ]

        def mac(i: int) -> str:
            a, b = int(_h(self.node_id) * 127) & 0xFF, int(_h(self.node_id, i) * 127) & 0xFF
            return f"4c:bb:47:{a:02x}:{i:02x}:{b:02x}"

        net = []
        for i, (name, rdma, label) in enumerate(RAILS):
            net.append(
                NetIfInfo(
                    name=name,
                    role="interconnect",
                    label=label,
                    mac=mac(i),
                    ipv4=[ip] if (ip := (self.ip_a, self.ip_b)[i]) else [],
                    speed_mbps=200000,
                    rdma_device=rdma,
                    counter_source="ethtool_phy",
                    peer=self.peer,
                )
            )
        for i, (name, rdma, label) in enumerate(SPARE_PORTS, start=2):
            net.append(
                NetIfInfo(
                    name=name,
                    role="interconnect",
                    label=label,
                    mac=mac(i),
                    rdma_device=rdma,
                    counter_source="ethtool_phy",
                )
            )
        net.append(
            NetIfInfo(name=LAN, role="lan", label="LAN", mac=mac(9), ipv4=[self.lan_ip], speed_mbps=10000)
        )
        sensors = [SensorInfo(id=f"acpitz.{i}", label=f"ACPI zone {i}", group="soc") for i in range(7)]
        sensors += [
            SensorInfo(id="nvme.composite", label="NVMe Composite", group="nvme", crit_c=84.85),
            SensorInfo(id="nvme.sensor_1", label="NVMe Sensor 1", group="nvme"),
            SensorInfo(id="nvme.sensor_2", label="NVMe Sensor 2", group="nvme"),
        ]
        sensors += [
            SensorInfo(id=f"mlx5.{i}", label=f"CX7 ASIC {i}", group="nic", crit_c=105.0) for i in range(4)
        ]
        uuid_hex = hashlib.md5(self.node_id.encode()).hexdigest()
        return NodeInfo(
            node_id=self.node_id,
            hostname=self.node_id,
            agent_version="0.1.0",
            os="Ubuntu 24.04.4 LTS (DGX OS)",
            kernel="6.17.0-1032-nvidia",
            driver="580.173.02",
            cuda="13.0",
            nvml="13.580.173.02",
            cpu_model="NVIDIA GB10 (10x Cortex-X925 + 10x Cortex-A725)",
            cores=cores,
            mem_total=MEM_TOTAL,
            swap_total=SWAP_TOTAL,
            gpus=[
                GpuInfo(
                    index=0,
                    name="NVIDIA GB10",
                    uuid=f"GPU-{uuid_hex[:8]}-{uuid_hex[8:12]}-{uuid_hex[12:16]}-{uuid_hex[16:20]}-{uuid_hex[20:]}",
                    arch="Blackwell",
                    compute_capability="12.1",
                    cuda_cores=6144,
                    sm_mhz_max=3003.0,
                    temp_slowdown_c=86.0,
                    temp_shutdown_c=90.0,
                    temp_max_c=99.0,
                    power_limit_w=None,
                )
            ],
            net=net,
            disks=[
                DiskInfo(
                    name="nvme0n1",
                    model="Samsung MZALC4T0HBL1-00B07",
                    size_bytes=DISK_SIZE,
                    mounts=["/", "/boot/efi"],
                )
            ],
            sensors=sensors,
            unsupported=UNSUPPORTED,
            tools=TOOLS,
            sample_interval_ms=1000,
            boot_time=self.boot,
        )


class DemoSource(NodeSource):
    """A simulated agent connection; failures are raised/withheld exactly where a real link would fail."""

    def __init__(self, node_id: str, listener: Listener, t0: float, speed: float = 1.0):
        lan_ip = NODES[node_id][0]
        super().__init__(node_id, f"http://{lan_ip}:9750", listener)
        self.model = DemoModel(node_id, t0, speed)
        self.seq = 0
        self.energy: float | None = None
        self.interval = 1.0

    def _refused(self) -> ConnectionRefusedError:
        return ConnectionRefusedError(
            errno.ECONNREFUSED, f"Connect call failed ('{self.model.lan_ip}', 9750)"
        )

    async def session(self) -> None:
        if self.model.link_state(time.time()) == "refused":
            await asyncio.sleep(0.05)
            raise self._refused()
        self.got_hello(self.model.info)
        next_t = time.time()
        while True:
            next_t += self.interval
            await asyncio.sleep(max(0.0, next_t - time.time()))
            now = time.time()
            state = self.model.link_state(now)
            if state == "refused":
                raise self._refused()
            if state == "stall":
                continue
            s = self.model.sample_at(now, self.seq, procs=self.seq % 5 == 0)
            g = s.gpu[0]
            # energy counter integrates the live power
            self.energy = (
                (g.energy_j or 0.0) if self.energy is None else self.energy + (g.power_w or 0) * self.interval
            )
            g.energy_j = round(self.energy, 1)
            self.seq += 1
            self.got_sample(s)


def demo_history(
    model: DemoModel,
    keys: list[str] | None,
    t_from: float,
    t_to: float,
    points: int,
    now: float | None = None,
) -> HistoryResponse:
    """Deterministic 10 s (last 7 d) / 60 s (up to 30 d) history, downsampled to ~``points`` buckets."""
    now = time.time() if now is None else now
    t_to = min(t_to, now)
    t_from = max(t_from, now - 30 * 86400)
    base = 10 if t_from >= now - 7 * 86400 else 60
    res = max(base, math.ceil(max(t_to - t_from, 0) / max(points, 1) / base) * base)
    ts: list[float] = []
    series: dict[str, list[float | None]] = {}
    mins: dict[str, list[float | None]] = {}
    maxs: dict[str, list[float | None]] = {}
    want = set(keys) if keys else None
    b = math.floor(t_from / res) * res
    while b <= t_to - res and len(ts) < 5000:
        subs = [flatten(model.sample_at(b + res * f)) for f in (0.15, 0.5, 0.85)]
        idx = len(ts)
        ts.append(float(b))
        for k in want if want is not None else subs[1].keys():
            vals = [s[k] for s in subs if k in s]
            for d in (series, mins, maxs):
                d.setdefault(k, [None] * idx).append(None)
            if not vals:
                continue
            if k.endswith(COUNTER_KEYS_SUFFIX):
                avg = vals[-1]
            elif k.endswith(BITMASK_KEYS_SUFFIX):
                avg = float(int(vals[0]) | int(vals[1 % len(vals)]) | int(vals[-1]))
            else:
                avg = sum(vals) / len(vals)
            series[k][idx], mins[k][idx], maxs[k][idx] = avg, min(vals), max(vals)
        b += res
    for d in (series, mins, maxs):
        for v in d.values():
            v.extend([None] * (len(ts) - len(v)))
    return HistoryResponse(node_id=model.node_id, resolution_s=res, ts=ts, series=series, min=mins, max=maxs)
