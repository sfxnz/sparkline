"""--demo-mixed: ws1, a simulated 4-GPU x86 NVIDIA workstation with no RDMA, behind the DemoNode interface.

Hardware: 4x NVIDIA RTX 6000 Ada Generation (Ada, compute capability 8.9, 18,176 CUDA cores, 48 GB GDDR6,
300 W board power, PCIe 4.0 x16; NVIDIA RTX 6000 Ada datasheet, https://lenovopress.lenovo.com/LP1940) and an
AMD Ryzen Threadripper PRO 7975WX (32 cores, 64 threads, 4 CCDs, 5.3 GHz boost).
Synthesized, with no primary source: the max SM clock and temperature thresholds, every power, clock and
temperature curve, the RAM, disks, NICs, sensors, OS and driver versions, and the workload's memory figures.

Telemetry is a deterministic function of wall time, as in DemoModel. vLLM serves Llama-3.3-70B-Instruct FP8
with tensor parallel 4, so the four GPUs load together. On scenario time: GPU 3, with impaired cooling, heats
past slowdown every 6 min from 90 s for ~50 s under a burst of requests (sw_thermal then hw_thermal, clocks
sag). Otherwise GPU 2, between two cards, runs hottest. GPU 2's power reading drops out every 6 min from 200 s
for 20 s, as on a transient NVML power read error.
"""

from __future__ import annotations

import hashlib
import math
import time

from ..common.schema import (
    CoreInfo,
    CpuSample,
    DiskInfo,
    DiskSample,
    FsSample,
    GpuInfo,
    GpuSample,
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
from .demo import BenchWindow, Smooth, _clamp, _episode, _h, bench_load

GIB = 1 << 30
MEM_TOTAL = 263_617_544 * 1024
SWAP_TOTAL = 8 * GIB
THREADS = 64  # cpu0-31 are the 32 cores' first threads, cpu32-63 their SMT siblings
CPU_MODEL = "AMD Ryzen Threadripper PRO 7975WX 32-Cores"
CPU_MAX_MHZ = 5300.0
LAN_IP = "198.51.100.20"
LAN, SPARE_PORT = "enp68s0f0", "enp68s0f1"
ROOT_DISK = ("nvme0n1", "Samsung SSD 990 PRO 2TB", 2_000_398_934_016)
DATA_DISK = ("nvme1n1", "Samsung SSD 990 PRO 4TB", 4_000_787_030_016)
FS_ROOT = 1_967_317_032_960
FS_DATA = 3_936_502_300_672

GPUS = 4
GPU_NAME = "NVIDIA RTX 6000 Ada Generation"
VRAM_TOTAL = 48 * GIB
VRAM_RESERVED = 512 << 20  # the driver's own share, which NVML's v1 used counts and no process list shows
POWER_LIMIT_W = 300.0
SM_MAX_MHZ = 3105.0
MAX_OPERATING_C, SLOWDOWN_C, SHUTDOWN_C = 89.0, 93.0, 96.0
IDLE_W = 24.0
CAP_ON_W, CAP_OFF_W = POWER_LIMIT_W - 3.6, POWER_LIMIT_W - 10
CAP_MIN_S, CAP_HOLD_S = 10, 600
SLOT_HEAT_C = (1.0, 3.0, 6.0, 0.0)
POWER_SKEW_W = (0.0, 2.5, -2.0, 3.5)
EPISODE_GPU = 3
POWER_DROPOUT_GPU, POWER_DROPOUT_S = 2, (200, 220)
CCD_HEAT_C = (0.0, 1.5, -1.0, 2.0)
WORKER_CPUS = (2, 10, 18, 26)
ENGINE_CPU, API_CPU = 5, 1
MODEL_ID = "nvidia/Llama-3.3-70B-Instruct-FP8"
VRAM_ONLY = "NVML does not report the system memory this GPU uses; its memory is dedicated VRAM"


class WorkstationModel:
    ENERGY_STEP_S = 30.0
    PREV_SESSION_S = 40 * 86400.0

    def __init__(self, node_id: str, t0: float, speed: float = 1.0):
        self.node_id = node_id
        self.t0 = t0
        self.speed = speed
        self.lan_ip = LAN_IP
        self.waves = Smooth(node_id + "waves", (45, 170, 610))
        self.valley = Smooth(node_id + "valley", (430, 1300))
        self.skew = [Smooth(f"{node_id}gpu{i}", (30, 110)) for i in range(GPUS)]
        self.disk_burst = Smooth(node_id + "disk", (240, 700))
        self.slow = Smooth(node_id + "slow", (1800, 5400))
        self.blip = Smooth(node_id + "psi", (90, 300))
        self.core_noise = [Smooth(f"{node_id}core{i}", (20, 75)) for i in range(THREADS)]
        self.boot = t0 - 2.4 * 86400 - 3600 * (1 + _h(node_id, "boot"))
        self.info = self._info()
        self._cum: dict[tuple[str, int], list[float]] = {}
        self.bench_windows: list[BenchWindow] = []
        self.disk_windows: list[list[float]] = []

    def scen(self, t: float) -> float:
        return (t - self.t0) * self.speed

    def link_state(self, t: float) -> str:
        return "ok"

    def thermal(self, t: float) -> float:
        return _episode((self.scen(t) - 90) % 360, 12, 25, 15)

    def diurnal(self, t: float) -> float:
        hour = time.localtime(t).tm_hour + time.localtime(t).tm_min / 60
        return 0.72 + 0.28 * math.cos((hour - 16) / 24 * 2 * math.pi)

    def busy(self, t: float) -> tuple[float, float]:
        b = _clamp(0.5 + 0.75 * self.waves(t), 0, 1) * self.diurnal(t)
        active = _clamp((self.valley(t) + 0.9) / 0.08, 0, 1)
        heat = self.thermal(t)
        if heat:
            b, active = max(b, heat), max(active, min(1.0, 4 * heat))
        return b, active

    def util(self, i: int, t: float, noise: bool = True) -> float:
        b, a = self.busy(t)
        u = a * (62 + 36 * b + 1.5 * self.skew[i](t)) + (1 - a) * 0.3
        if noise:
            u += 0.8 * _h(self.node_id, "u", i, int(t))
        load, _ = bench_load(self.bench_windows, t, i)
        return _clamp(max(u, 98 * load), 0, 100)

    def raw_power(self, i: int, t: float, noise: bool = True) -> float:
        p = IDLE_W + 2.8 * self.util(i, t, noise) + POWER_SKEW_W[i]
        if noise:
            p += 1.2 * _h(self.node_id, "p", i, int(t))
        if i == EPISODE_GPU:
            p += 12 * self.thermal(t)
        _, heat = bench_load(self.bench_windows, t, i)
        return p + 25 * heat

    def power_at(self, i: int, t: float) -> float:
        raw = self.raw_power(i, t)
        return POWER_LIMIT_W + (raw - POWER_LIMIT_W) * 0.1 if raw > POWER_LIMIT_W else raw

    def driver_loaded(self, t: float) -> float:
        """When the driver session holding t began: at boot, or for the session before it, PREV_SESSION_S
        earlier."""
        return self.boot if t >= self.boot else self.boot - self.PREV_SESSION_S

    def power_capped(self, i: int, t: float) -> bool:
        """Hysteresis on the noise-free draw, so noise near the limit never flips the bit for one sample: set
        above CAP_ON_W; cleared below CAP_OFF_W once CAP_MIN_S have passed since the draw was last above, or
        once it has stayed at or below CAP_ON_W for CAP_HOLD_S; off when the driver loads. The scan back
        ends at the first decisive second, within a minute on this model's load and never past CAP_HOLD_S."""
        start = self.driver_loaded(t)
        low = None
        for k in range(CAP_HOLD_S):
            if t - k < start or (low is not None and k >= low + CAP_MIN_S):
                return False
            p = self.raw_power(i, t - k, noise=False)
            if p > CAP_ON_W:
                return True
            if low is None and p < CAP_OFF_W:
                low = k
        return False

    def energy_at(self, i: int, t: float) -> float:
        """GPU i's energy counter (J): the integral of power_at since the driver loaded."""
        origin = self.driver_loaded(t)
        return self._integral("boot" if origin == self.boot else "prev", i, origin, max(t, origin))

    def _integral(self, name: str, i: int, origin: float, t: float) -> float:
        step = self.ENERGY_STEP_S if name == "boot" else 4 * self.ENERGY_STEP_S
        cum = self._cum.setdefault((name, i), [0.0])
        k = int((t - origin) // step)
        while len(cum) <= k:
            n = len(cum) - 1
            cum.append(cum[-1] + self.power_at(i, origin + (n + 0.5) * step) * step)
        return cum[k] + self.power_at(i, origin + (k + 0.5) * step) * (t - origin - k * step)

    def worker_gpu_mem(self, i: int, t: float) -> int:
        return int(43.4e9 + 0.05e9 * self.slow(t + 400 * i))

    def _gpu(self, i: int, t: float) -> GpuSample:
        j = lambda key: _h(self.node_id, key, i, int(t))  # noqa: E731
        util = self.util(i, t)
        raw = self.raw_power(i, t)
        capped = _clamp((raw - (POWER_LIMIT_W - 4)) / 8 * 100, 0, 100)
        at_cap = self.power_capped(i, t)
        lag = (
            0.4 * self.power_at(i, t - 8) + 0.35 * self.power_at(i, t - 25) + 0.25 * self.power_at(i, t - 60)
        )
        temp = 31 + SLOT_HEAT_C[i] + 0.165 * lag + 0.4 * j("t")
        if i == EPISODE_GPU:
            temp += self.thermal(t) * (94.4 + 0.4 * j("th") - temp)
        dropout = i == POWER_DROPOUT_GPU and POWER_DROPOUT_S[0] <= self.scen(t) % 360 < POWER_DROPOUT_S[1]
        busy = util >= 5
        mask = 0 if busy else 0x1
        sm = 2700 + 40 * j("sm") if busy else 210.0
        if at_cap:
            mask |= 0x4
            sm -= capped / 100 * 330
        thermal_pct = 0.0
        if temp >= MAX_OPERATING_C:
            mask |= 0x20
            sm *= 0.86
            thermal_pct = 40.0
        if temp >= SLOWDOWN_C:
            mask |= 0x40
            sm *= 0.72
            thermal_pct = 100.0
        return GpuSample(
            index=i,
            util=round(util, 1),
            sm_mhz=round(sm),
            gr_mhz=round(sm),
            video_mhz=1965.0 if busy else 765.0,
            temp_c=round(temp, 1),
            power_w=None if dropout else round(self.power_at(i, t), 2),
            energy_j=round(self.energy_at(i, t), 1),
            pstate=0 if busy else 8,
            throttle_mask=mask,
            power_capped_pct=round(capped if at_cap else 0.0, 1),
            thermal_capped_pct=thermal_pct,
            vram_used=self.worker_gpu_mem(i, t) + VRAM_RESERVED,
        )

    def cpu_busy(self, c: int, b: float, active: float) -> float:
        if c in WORKER_CPUS:
            return 2 + 93 * active
        if c == ENGINE_CPU:
            return 2 + 86 * active
        if c == API_CPU:
            return 3 + (18 + 30 * b) * active
        return 1.5 + 3 * b * active

    def sample_at(self, t: float, seq: int = 0, procs: bool = False) -> Sample:
        nid = self.node_id
        j = lambda key: _h(nid, key, int(t))  # noqa: E731
        b, active = self.busy(t)
        gpus = [self._gpu(i, t) for i in range(GPUS)]

        anon = int(34 * GIB + 0.4 * GIB * self.slow(t + 900))
        shmem, kernel, other = (
            int(2.3 * GIB),
            int(6.2 * GIB + 0.15 * GIB * self.slow(t + 300)),
            int(2.6 * GIB),
        )
        disk_x = self.disk_burst(t)
        cache = int(96 * GIB + 3 * GIB * self.slow(t + 1700) + (4 * GIB if disk_x > 0.6 else 0))
        used = anon + shmem + kernel + other
        available = MEM_TOTAL - used
        psi = max(0.0, self.blip(t) - 0.7) * 12
        mem = MemSample(
            total=MEM_TOTAL,
            available=available,
            used=used,
            free=available - cache,
            gpu=None,
            anon=anon,
            cache=cache,
            shmem=shmem,
            kernel=kernel,
            other=other,
            swap_total=SWAP_TOTAL,
            swap_used=int(0.3 * GIB + 0.05 * GIB * self.slow(t + 2500)),
            psi_some=round(psi, 2),
            psi_full=round(psi * 0.3, 2),
        )

        per_core: list[float] = []
        freq: list[float | None] = []
        for c in range(THREADS):
            u = self.cpu_busy(c, b, active) + 1.5 * self.core_noise[c](t) + 1.5 * j(f"c{c}")
            per_core.append(round(_clamp(u, 0, 100), 1))
            freq.append(round(CPU_MAX_MHZ * (0.92 + 0.04 * abs(j(f"f{c}")))) if u > 8 else 2950.0)
        expected = sum(self.cpu_busy(c, b, active) for c in range(THREADS))
        cpu = CpuSample(
            util=round(sum(per_core) / THREADS, 1),
            perf_util=None,
            eff_util=None,
            per_core=per_core,
            freq_mhz=freq,
            load1=round(expected / 100 + 0.3 + 0.2 * j("l1"), 2),
            load5=round(expected / 100 + 0.4, 2),
            load15=round(expected / 100 + 0.45, 2),
            psi_some=round(max(0.0, self.blip(t + 40) - 0.75) * 6, 2),
        )

        net = [
            NetSample(
                name=LAN,
                up=True,
                speed_mbps=10000,
                rx_bps=round(40e3 + 220e3 * b * active + 15e3 * j("lr")),
                tx_bps=round(120e3 + 950e3 * b * active + 40e3 * j("lt")),
            ),
            NetSample(name=SPARE_PORT, up=False, rx_bps=0, tx_bps=0),
        ]

        rd_root, wr_root = 1.5e6 + 1e6 * j("dr"), 9e6 + 6e6 * j("dw")
        for a, z, brd, bwr in self.disk_windows:
            if a <= t < z:
                rd_root, wr_root = rd_root + brd, wr_root + bwr
        rd_data = 0.4e6 + 0.3e6 * j("dd") + (3.1e9 * (disk_x - 0.75) / 0.25 if disk_x > 0.75 else 0.0)
        disk = [
            DiskSample(
                name=name,
                read_bps=round(rd),
                write_bps=round(wr),
                read_iops=round(rd / 131072 + 20),
                write_iops=round(wr / 16384 + 8),
                busy_pct=round(_clamp(rd / 3.2e9 * 100 + wr / 1.5e9 * 100 + 1, 0, 100), 1),
            )
            for name, rd, wr in ((ROOT_DISK[0], rd_root, wr_root), (DATA_DISK[0], rd_data, 0.2e6))
        ]
        root_used = int(FS_ROOT * (0.27 + 0.002 * self.slow(t)))
        data_used = int(FS_DATA * 0.46)
        fs = [
            FsSample(
                mount="/",
                key="root",
                device="/dev/nvme0n1p2",
                total=FS_ROOT,
                used=root_used,
                free=FS_ROOT - root_used,
            ),
            FsSample(
                mount="/boot/efi",
                key="boot_efi",
                device="/dev/nvme0n1p1",
                total=1_124_999_168,
                used=6_709_248,
                free=1_118_289_920,
            ),
            FsSample(
                mount="/data",
                key="data",
                device="/dev/nvme1n1p1",
                total=FS_DATA,
                used=data_used,
                free=FS_DATA - data_used,
            ),
        ]

        tctl = 47 + 12 * active + 4 * b * active + 0.8 * self.core_noise[0](t)
        nvme = 41 + 4 * _clamp(disk_x, 0, 1) + 1.2 * self.slow(t + 60)
        temps = [TempSample(id="k10temp.tctl", c=round(tctl, 1))]
        temps += [
            TempSample(id=f"k10temp.tccd{k + 1}", c=round(tctl - 4 + off + 0.5 * j(f"ccd{k}"), 1))
            for k, off in enumerate(CCD_HEAT_C)
        ]
        cpu_temp = max(t.c for t in temps if t.c is not None)
        for prefix, base in (("nvme", nvme), ("nvme1", nvme - 3)):
            temps += [
                TempSample(id=f"{prefix}.composite", c=round(base, 1)),
                TempSample(id=f"{prefix}.sensor_1", c=round(base + 8, 1)),
                TempSample(id=f"{prefix}.sensor_2", c=round(base - 1, 1)),
            ]

        return Sample(
            node_id=nid,
            ts=t,
            seq=seq,
            interval_ms=1000,
            gpu=gpus,
            mem=mem,
            cpu=cpu,
            net=net,
            disk=disk,
            fs=fs,
            temps=temps,
            cpu_temp_c=cpu_temp,
            procs=self._procs(t, gpus, b) if procs else None,
        )

    def _procs(self, t: float, gpus: list[GpuSample], b: float) -> list[ProcSample]:
        j = lambda key: _h(self.node_id, key, int(t))  # noqa: E731
        _, active = self.busy(t)
        serve = ProcSample(
            pid=41022,
            name="vllm",
            cmdline=f"/usr/bin/python3 /usr/local/bin/vllm serve {MODEL_ID} --tensor-parallel-size 4 "
            "--gpu-memory-utilization 0.85 --max-model-len 32768 --host 0.0.0.0 --port 8000",
            user="root",
            cpu_pct=round(3 + (18 + 30 * b) * active + 2 * j("api"), 1),
            rss=int(3.4 * GIB),
            container="vllm-llama70b",
            model=MODEL_ID,
        )
        engine = ProcSample(
            pid=41187,
            name="VLLM::EngineCor",  # comm is cut to 15 characters
            cmdline="VLLM::EngineCore",
            user="root",
            cpu_pct=round(2 + 86 * active + 2 * j("eng"), 1),
            rss=int(2.8 * GIB),
            container="vllm-llama70b",
        )
        workers = [
            ProcSample(
                pid=41240 + 3 * g.index,
                name="VLLM::Worker_TP",
                cmdline=f"VLLM::Worker_TP{g.index}",
                user="root",
                cpu_pct=round(2 + 93 * active + 2 * j(f"w{g.index}"), 1),
                rss=int(6.1 * GIB + 0.05 * GIB * g.index),
                gpu_mem=self.worker_gpu_mem(g.index, t),
                gpu_util=g.util,
                container="vllm-llama70b",
            )
            for g in gpus
        ]
        system = [
            (
                1904,
                "dockerd",
                "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock",
                0.3,
                118,
            ),
            (1651, "containerd", "/usr/bin/containerd", 0.2, 64),
            (2388, "sparkline-agent", "/opt/sparkline/venv/bin/python -m sparkline.agent.main", 0.9, 61),
            (498, "systemd-journald", "/usr/lib/systemd/systemd-journald", 0.1, 44),
        ]
        return (
            [serve, engine]
            + workers
            + [
                ProcSample(
                    pid=pid,
                    name=name,
                    cmdline=cmd,
                    user="spark" if name == "sparkline-agent" else "root",
                    cpu_pct=round(max(0.0, cpu + 0.1 * j(name)), 1),
                    rss=mib << 20,
                )
                for pid, name, cmd, cpu, mib in system
            ]
        )

    def _info(self) -> NodeInfo:
        cores = [
            CoreInfo(id=c, kind="unknown", model=CPU_MODEL, max_mhz=CPU_MAX_MHZ, cluster=None)
            for c in range(THREADS)
        ]

        def mac(i: int) -> str:
            a = int(_h(self.node_id) * 127) & 0xFF
            return f"02:00:00:{a:02x}:{i:02x}:{0x10 + i:02x}"

        net = [
            NetIfInfo(name=LAN, role="lan", label="LAN", mac=mac(0), ipv4=[self.lan_ip], speed_mbps=10000),
            NetIfInfo(name=SPARE_PORT, role="other", label=SPARE_PORT, mac=mac(1)),
            NetIfInfo(name="docker0", role="virtual", label="docker0", mac=mac(2)),
        ]
        sensors = [SensorInfo(id="k10temp.tctl", label="CPU control (Tctl)", group="other")]
        sensors += [
            SensorInfo(id=f"k10temp.tccd{k}", label=f"CPU CCD {k}", group="other") for k in range(1, 5)
        ]
        for prefix in ("nvme", "nvme1"):
            sensors += [
                SensorInfo(id=f"{prefix}.composite", label="NVMe Composite", group="nvme", crit_c=84.85),
                SensorInfo(id=f"{prefix}.sensor_1", label="NVMe Sensor 1", group="nvme"),
                SensorInfo(id=f"{prefix}.sensor_2", label="NVMe Sensor 2", group="nvme"),
            ]

        def uuid(i: int) -> str:
            x = hashlib.md5(f"{self.node_id}gpu{i}".encode()).hexdigest()
            return f"GPU-00000000-0000-0000-0000-0000{x[:8]}"

        return NodeInfo(
            node_id=self.node_id,
            hostname=self.node_id,
            agent_version="0.1.0",
            os="Ubuntu 24.04.3 LTS",
            kernel="6.14.0-35-generic",
            platform="linux",
            versions={"nvidia.Driver": "580.95.05", "nvidia.CUDA": "13.0", "nvidia.NVML": "13.580.95.05"},
            driver="580.95.05",
            cuda="13.0",
            nvml="13.580.95.05",
            cpu_model=CPU_MODEL,
            cores=cores,
            mem_total=MEM_TOTAL,
            swap_total=SWAP_TOTAL,
            gpus=[
                GpuInfo(
                    index=i,
                    name=GPU_NAME,
                    uuid=uuid(i),
                    arch="Ada",
                    compute_capability="8.9",
                    cuda_cores=18176,
                    sm_mhz_max=SM_MAX_MHZ,
                    temp_slowdown_c=SLOWDOWN_C,
                    temp_shutdown_c=SHUTDOWN_C,
                    temp_max_c=MAX_OPERATING_C,
                    power_limit_w=POWER_LIMIT_W,
                    vendor="nvidia",
                    backend="nvml",
                    memory="dedicated",
                    vram_total=VRAM_TOTAL,
                )
                for i in range(GPUS)
            ],
            net=net,
            disks=[
                DiskInfo(
                    name=ROOT_DISK[0], model=ROOT_DISK[1], size_bytes=ROOT_DISK[2], mounts=["/", "/boot/efi"]
                ),
                DiskInfo(name=DATA_DISK[0], model=DATA_DISK[1], size_bytes=DATA_DISK[2], mounts=["/data"]),
            ],
            sensors=sensors,
            unsupported=[
                *(Unsupported(metric=f"gpu{i}.shared_used", reason=VRAM_ONLY) for i in range(GPUS)),
                Unsupported(metric="mem.gpu", reason=VRAM_ONLY),
                *(
                    Unsupported(metric=m, reason="This CPU has no performance/efficiency core split")
                    for m in ("cpu.perf_util", "cpu.eff_util")
                ),
                Unsupported(metric="fan", reason="No fan sensors exposed by this hardware (hwmon)"),
                Unsupported(
                    metric="system.power_w",
                    reason="Whole-system power is not exposed; only GPU board power (NVML) is",
                ),
            ],
            tools={
                "docker": True,
                "fio": False,
                "perftest": False,
                "nccl_tests": False,
                "nvcc": True,
                "pytorch_image": True,
            },
            sample_interval_ms=1000,
            boot_time=self.boot,
        )
