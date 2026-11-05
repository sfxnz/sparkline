"""The agent keeps sampling when its data sources misbehave: NVML errors, the docker socket going away, hwmon
files vanishing. No hardware access: NVML is a fake module, docker a unix socket in tmp, hwmon a tmp tree."""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import shutil
import socket
import threading
from types import SimpleNamespace

import pytest
from platforms import gb10

from sparkline.agent.collectors import procs as procs_mod
from sparkline.agent.collectors import thermal as thermal_mod
from sparkline.agent.collectors.gpu import GpuCollector
from sparkline.agent.collectors.gpu import nvml as nvml_mod
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import RootFs

# -- NVML ------------------------------------------------------------------------------------------------


class NVMLError(Exception):
    pass


class NVMLError_NotSupported(NVMLError):  # noqa: N801 - pynvml's name
    pass


class NVMLError_NoPermission(NVMLError):  # noqa: N801 - pynvml's name
    pass


class FakeNvml:
    """Stands in for pynvml, as a GB10. ``fail``: the exception every device read raises (None: healthy);
    ``answers`` replaces a call's healthy answer."""

    NVMLError = NVMLError
    NVMLError_NotSupported = NVMLError_NotSupported
    NVMLError_NoPermission = NVMLError_NoPermission

    def __init__(self) -> None:
        self.fail: BaseException | None = None
        self.fail_on: dict[str, BaseException] = {}
        self.answers: dict[str, object] = {}

    def __getattr__(self, name: str):
        if name.startswith("NVML_"):
            return hash(name) % 1000  # constants
        values = {
            "nvmlDeviceGetCount": 1,
            "nvmlDeviceGetName": "NVIDIA GB10",
            "nvmlDeviceGetUUID": "GPU-00000000-fake",
            "nvmlSystemGetDriverVersion": "580.95",
            "nvmlSystemGetNVMLVersion": "13.580.95",
            "nvmlDeviceGetCudaComputeCapability": (12, 1),
            "nvmlSystemGetCudaDriverVersion_v2": 13000,
            "nvmlDeviceGetUtilizationRates": SimpleNamespace(gpu=42),
            "nvmlDeviceGetPowerUsage": 30_000,
            "nvmlDeviceGetTemperature": 55,
            "nvmlDeviceGetClockInfo": 2400,
            "nvmlDeviceGetCurrentClocksEventReasons": 0,
            "nvmlDeviceGetViolationStatus": SimpleNamespace(violationTime=0),
            "nvmlDeviceGetComputeRunningProcesses": [SimpleNamespace(pid=1234, usedGpuMemory=2**30)],
            "nvmlDeviceGetTotalEnergyConsumption": 1_000_000,
            "nvmlDeviceGetProcessUtilization": [],
            "nvmlDeviceGetMemoryInfo": NVMLError_NotSupported("Not Supported"),
            **self.answers,
        }

        def call(*_args):
            if name in self.fail_on:
                raise self.fail_on[name]
            device_read = name.startswith("nvmlDevice") and name != "nvmlDeviceGetHandleByIndex"
            if self.fail is not None and device_read:
                raise self.fail
            value = values.get(name, 1)
            if isinstance(value, BaseException):
                raise value
            return value

        return call


@pytest.fixture
def nvml():
    return FakeNvml()


def test_gpu_reads_recover_after_transient_nvml_errors(nvml):
    g = GpuCollector(gb10(nvml=nvml))
    assert len(g.info) == 1
    healthy = g.collect()["gpu"][0]
    assert (healthy.util, healthy.temp_c, healthy.power_w) == (42, 55, 30.0)
    assert g.proc_mem == {1234: 2**30}

    nvml.fail = NVMLError("Unknown Error")  # e.g. GPU busy / driver hiccup: readings missing, not fatal
    bad = g.collect()["gpu"][0]
    assert (bad.util, bad.temp_c, bad.power_w, bad.throttle_mask) == (None, None, None, None)
    assert g.shared_total is None

    nvml.fail = None  # transient: nothing was disabled, the next tick reads everything again
    again = g.collect()["gpu"][0]
    assert (again.util, again.temp_c, again.power_w) == (42, 55, 30.0)


def test_a_dedicated_gpus_vram_reading_recovers_after_a_transient_nvml_error(nvml):
    nvml.answers["nvmlDeviceGetMemoryInfo"] = SimpleNamespace(
        total=48 * 2**30, free=8 * 2**30, used=40 * 2**30
    )
    g = GpuCollector(gb10(nvml=nvml))
    assert (g.info[0].memory, g.info[0].vram_total) == ("dedicated", 48 * 2**30)
    assert g.collect()["gpu"][0].vram_used == 40 * 2**30

    nvml.fail_on = {"nvmlDeviceGetMemoryInfo": NVMLError("Unknown Error")}
    assert g.collect()["gpu"][0].vram_used is None

    nvml.fail_on = {}
    assert g.collect()["gpu"][0].vram_used == 40 * 2**30


def test_an_unexpected_nvml_exception_fails_only_that_tick_and_names_the_backend(nvml, tmp_path):
    g = GpuCollector(gb10(nvml=nvml))
    s = Sampler("n1", [g], 1000, ring_seconds=10)
    nvml.fail = RuntimeError("ctypes blew up")  # not an NVMLError: the collector isolates the backend
    s.collect_once()
    assert s.latest is not None and s.latest.gpu == [] and "RuntimeError" in s.latest.errors["gpu"]
    nvml.fail = None
    s.collect_once()
    assert s.latest.seq == 2 and s.latest.gpu[0].util == 42 and "gpu" not in s.latest.errors


def test_nvml_init_failure_leaves_an_empty_gpu_list():
    fake = FakeNvml()

    def broken_init():
        raise NVMLError("Driver Not Loaded")

    fake.nvmlInit = broken_init  # type: ignore[attr-defined]
    g = GpuCollector(gb10(nvml=fake))
    assert g.collect() == {"gpu": []}
    gap = g.caps()["gpu*"]
    assert (gap.kind, gap.reason) == ("hardware", "nvml: NVML unavailable (NVML: Driver Not Loaded)")


def test_unsupported_gpu_fields_say_whether_the_hardware_or_a_privilege_is_missing(nvml):
    nvml.fail_on = {
        "nvmlDeviceGetPowerManagementLimit": NVMLError_NoPermission("Insufficient Permissions"),
        "nvmlDeviceGetFanSpeed": NVMLError_NotSupported("Not Supported"),
    }
    gaps = {k: u for k, u in GpuCollector(gb10(nvml=nvml)).caps().items() if u}
    assert set(gaps) == {"gpu0.power_limit_w", "gpu0.fan_pct", "gpu0.vram_used"}
    limit = gaps["gpu0.power_limit_w"]
    assert limit.kind == "access"
    assert limit.reason == "Permission denied to the agent's user (NVML: Insufficient Permissions)"
    assert gaps["gpu0.fan_pct"].kind == "hardware"
    assert gaps["gpu0.fan_pct"].reason == "Fan speed not reported by NVIDIA GB10 (NVML: Not Supported)"


@pytest.mark.parametrize(
    "refusal", [NVMLError_NotSupported("Not Supported"), NVMLError_NoPermission("Insufficient Permissions")]
)
def test_a_gpu_reading_declared_unsupported_at_startup_is_never_reported_later(refusal, nvml, monkeypatch):
    per_tick = {
        "util": "nvmlDeviceGetUtilizationRates",
        "power_w": "nvmlDeviceGetPowerUsage",
        "temp_c": "nvmlDeviceGetTemperature",
        "energy_j": "nvmlDeviceGetTotalEnergyConsumption",
        "throttle_mask": "nvmlDeviceGetCurrentClocksEventReasons",
        "power_capped_pct": "nvmlDeviceGetViolationStatus",
        "thermal_capped_pct": "nvmlDeviceGetViolationStatus",
    }
    nvml.fail_on = {fn: refusal for fn in per_tick.values()}
    g = GpuCollector(gb10(nvml=nvml))
    assert {f"gpu0.{f}" for f in per_tick} <= {k for k, u in g.caps().items() if u}
    nvml.fail_on = {}
    clock = itertools.count(1000.0, nvml_mod.VIOLATION_EVERY_S + 1)
    monkeypatch.setattr(nvml_mod.time, "monotonic", lambda: next(clock))
    g.collect()
    sample = g.collect()["gpu"][0]
    assert {f: getattr(sample, f) for f in per_tick} == dict.fromkeys(per_tick)


def test_nvml_refusing_access_at_startup_says_a_privilege_is_missing(nvml):
    nvml.fail_on = {"nvmlInit": NVMLError_NoPermission("Insufficient Permissions")}
    gap = GpuCollector(gb10(nvml=nvml)).caps()["gpu*"]
    assert (gap.metric, gap.kind) == ("gpu*", "access")
    assert gap.reason == "nvml: Permission denied to the agent's user (NVML: Insufficient Permissions)"


def test_missing_nvidia_ml_py_says_what_to_install():
    g = GpuCollector(gb10(nvml=None))
    assert g.collect() == {"gpu": []}
    gap = g.caps()["gpu*"]
    assert (gap.metric, gap.kind) == ("gpu*", "dependency")
    assert gap.reason == "nvml: Install nvidia-ml-py to read NVIDIA GPU metrics"


async def test_sampling_loop_keeps_running_through_collector_failures(tmp_path):
    """The real run() loop at 250 ms with collectors that fail in every way still ticks on schedule."""

    class Flaky:
        name = "flaky"

        def __init__(self) -> None:
            self.n = 0

        def caps(self) -> dict:
            return {}

        def collect(self) -> dict:
            self.n += 1
            errors = [OSError("hwmon vanished"), RuntimeError("nvml"), ValueError("garbage"), KeyError("x")]
            if self.n % 2:
                raise errors[(self.n // 2) % len(errors)]
            return {}

    s = Sampler("n1", [Flaky()], 250, ring_seconds=10)
    q = s.subscribe()
    s.start()
    try:
        await asyncio.sleep(1.6)
        assert s._task is not None and not s._task.done()
        assert s.seq >= 4  # warm-up tick discarded; ~6 ticks in 1.6 s
        failed = ["flaky" in json.loads(q.get_nowait())["sample"]["errors"] for _ in range(q.qsize())]
        assert any(failed) and not all(failed)
    finally:
        await s.stop()


# -- docker socket ---------------------------------------------------------------------------------------

CID = "a" * 64


def serve_docker_once(path: str, body: bytes) -> threading.Thread:
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(1)

    def run() -> None:
        conn, _ = srv.accept()
        with conn:
            conn.recv(4096)
            conn.sendall(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n" + body)
        srv.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


class AllInDocker(RootFs):
    def read_once(self, p: str) -> str | None:
        return f"0::/docker/{CID}" if p.endswith("/cgroup") else super().read_once(p)


def test_docker_socket_disappearing_keeps_process_collection_running(tmp_path):
    sock = str(tmp_path / "docker.sock")
    src = gb10(fs=AllInDocker(), docker=lambda path: procs_mod.docker_get(path, sock_path=sock, timeout=1.0))
    c = procs_mod.ProcsCollector(src, gpu=None, interval_s=1)

    # 1. docker is up: names resolve
    t = serve_docker_once(sock, json.dumps([{"Id": CID, "Names": ["/vllm-worker"]}]).encode())
    rows = c.collect()["procs"]
    t.join(5)
    assert rows and {r.container for r in rows} == {"vllm-worker"}

    # 2. the socket file is gone (docker stopped): cached names keep working, nothing raises
    os.unlink(sock)
    c._names_t = -procs_mod.DOCKER_TTL_S  # force a lookup now instead of after the 30 s TTL
    c._last = None
    rows = c.collect()["procs"]
    assert rows and {r.container for r in rows} == {"vllm-worker"}

    # 3. a fresh collector with no cache and no socket: short container ids instead of names
    c2 = procs_mod.ProcsCollector(src, gpu=None, interval_s=1)
    rows = c2.collect()["procs"]
    assert rows and {r.container for r in rows} == {CID[:12]}

    # 4. something else answers on the path with garbage: still no exception
    t = serve_docker_once(sock, b"not json")
    c3 = procs_mod.ProcsCollector(src, gpu=None, interval_s=1)
    assert {r.container for r in c3.collect()["procs"]} == {CID[:12]}
    t.join(5)


def test_docker_get_errors_are_oserror_or_valueerror(tmp_path):
    with pytest.raises(OSError):
        procs_mod.docker_get("/containers/json", sock_path=str(tmp_path / "missing.sock"))
    sock = str(tmp_path / "d.sock")
    t = serve_docker_once(sock, b"{")
    with pytest.raises(ValueError):
        procs_mod.docker_get("/containers/json", sock_path=sock)
    t.join(5)


# -- hwmon -----------------------------------------------------------------------------------------------


def make_hwmon(root, n: int, name: str, temps: dict[int, int], label: str | None = None) -> str:
    d = root / f"hwmon{n}"
    d.mkdir(parents=True)
    (d / "name").write_text(name + "\n")
    for i, milli in temps.items():
        (d / f"temp{i}_input").write_text(f"{milli}\n")
        if label:
            (d / f"temp{i}_label").write_text(label + "\n")
    return str(d)


HWMON = "sys/class/hwmon"


def test_hwmon_sensor_vanishing_reports_none_and_the_rest_keep_reading(tmp_path, monkeypatch):
    root = tmp_path / HWMON
    make_hwmon(root, 0, "acpitz", {1: 45_000})
    nvme = make_hwmon(root, 1, "nvme", {1: 38_850}, label="Composite")

    class GoneOnRead(RootFs):
        """sysfs semantics: once a device is removed, reads through an fd opened earlier fail with ENODEV."""

        def __init__(self) -> None:
            super().__init__(tmp_path)
            self.gone: set[str] = set()

        def read(self, p: str) -> str:
            if any(self.host_path(p).startswith(g) for g in self.gone):
                raise OSError(19, "No such device")
            with open(self.host_path(p)) as f:
                return f.read()

    read = GoneOnRead()
    monkeypatch.setattr(thermal_mod.time, "monotonic", itertools.count(0, thermal_mod.SLOW_EVERY_S).__next__)
    t = thermal_mod.ThermalCollector(gb10(fs=read))
    temps = {x.id: x.c for x in t.collect()["temps"]}
    assert temps == {"acpitz.0": 45.0, "nvme.composite": 38.85}

    read.gone.add(nvme)  # NVMe reset / driver unbind
    shutil.rmtree(nvme)
    temps = {x.id: x.c for x in t.collect()["temps"]}
    assert temps == {"acpitz.0": 45.0, "nvme.composite": None}  # unknown, never a fake 0

    read.gone.clear()  # the device comes back at the same path
    make_hwmon(root, 1, "nvme", {1: 40_000}, label="Composite")
    assert {x.id: x.c for x in t.collect()["temps"]}["nvme.composite"] == 40.0


class CountingFs(RootFs):
    def __init__(self, root) -> None:
        super().__init__(root)
        self.reads: list[str] = []

    def read(self, p: str) -> str:
        self.reads.append(os.path.basename(os.path.dirname(p)))
        with open(self.host_path(p)) as f:
            return f.read()


def test_device_queried_sensors_are_read_every_slow_interval_and_carried_between(tmp_path, monkeypatch):
    root = tmp_path / HWMON
    acpi = make_hwmon(root, 0, "acpitz", {1: 45_000})
    nvme = make_hwmon(root, 1, "nvme", {1: 38_000}, label="Composite")
    wifi = make_hwmon(root, 2, "mt7925_phy0", {1: 50_000})
    chip_functions = [make_hwmon(root, n, "mlx5", {1: 66_000}, label="asic") for n in (3, 4)]
    for n, h in enumerate(chip_functions):
        ib = tmp_path / f"pci{n}" / "infiniband" / f"mlx5_{n}"
        ib.mkdir(parents=True)
        (ib / "sys_image_guid").write_text("0200:0000:0000:0001\n")
        os.symlink(tmp_path / f"pci{n}", f"{h}/device")
    fs = CountingFs(tmp_path)
    reads = fs.reads
    now = [100.0]
    monkeypatch.setattr(thermal_mod.time, "monotonic", lambda: now[0])
    t = thermal_mod.ThermalCollector(gb10(fs=fs))

    def tick(at: float) -> tuple[dict, list[str]]:
        now[0] = at
        reads.clear()
        return {x.id: x.c for x in t.collect()["temps"]}, sorted(reads)

    temps = {"acpitz.0": 45.0, "nvme.composite": 38.0, "mt7925_phy0.1": 50.0, "mlx5.0": 66.0}
    assert tick(100) == (temps, ["hwmon0", "hwmon1", "hwmon2", "hwmon3"])
    for h, milli in ((acpi, 46_000), (nvme, 39_000), (wifi, 51_000)):
        with open(f"{h}/temp1_input", "w") as f:
            f.write(f"{milli}\n")
    assert tick(101) == ({**temps, "acpitz.0": 46.0}, ["hwmon0", "hwmon3"])
    assert tick(109)[0]["nvme.composite"] == 38.0
    later = {**temps, "acpitz.0": 46.0, "nvme.composite": 39.0, "mt7925_phy0.1": 51.0}
    assert tick(110) == (later, ["hwmon0", "hwmon1", "hwmon2", "hwmon3"])

    shutil.rmtree(chip_functions[0])
    assert tick(111) == (later, ["hwmon0", "hwmon3", "hwmon4"])

    # Ticks land on an exact 1 s grid, but the collectors before thermal take a different 0-60 ms each tick.
    lag = (0.0, 0.03, 0.06, 0.02, 0.05, 0.01, 0.04)
    assert [k for k in range(2, 41) if "hwmon1" in tick(110 + k + lag[k % 7])[1]] == [10, 20, 30, 40]


def test_a_failed_device_queried_read_is_retried_on_the_next_tick(tmp_path, monkeypatch):
    make_hwmon(tmp_path / HWMON, 0, "nvme", {1: 38_000}, label="Composite")
    failing = [True]

    class FailingFs(CountingFs):
        def read(self, p: str) -> str:
            if failing[0]:
                self.reads.append(p)
                raise OSError(5, "Input/output error")
            return super().read(p)

    fs = FailingFs(tmp_path)
    reads = fs.reads
    now = [100.0]
    monkeypatch.setattr(thermal_mod.time, "monotonic", lambda: now[0])
    t = thermal_mod.ThermalCollector(gb10(fs=fs))

    def tick(at: float) -> tuple[float | None, int]:
        now[0] = at
        reads.clear()
        return t.collect()["temps"][0].c, len(reads)

    assert tick(100) == (None, 1)
    failing[0] = False
    assert tick(101) == (38.0, 1)
    assert tick(102) == (38.0, 0)


def test_hwmon_dir_removed_during_scan_is_skipped(tmp_path, monkeypatch):
    root = tmp_path / HWMON
    make_hwmon(root, 0, "acpitz", {1: 45_000})
    gone = make_hwmon(root, 1, "nvme", {1: 38_850}, label="Composite")
    real_listdir = os.listdir

    def racy_listdir(path):
        if str(path) == gone:
            raise FileNotFoundError(2, "No such file or directory", path)
        return real_listdir(path)

    monkeypatch.setattr(thermal_mod.os, "listdir", racy_listdir)
    chips, _fans, _power = thermal_mod.scan_hwmon(RootFs(tmp_path))
    assert [c.name for c in chips] == ["acpitz"]


def test_bench_probe_reports_docker_unreachable_instead_of_raising(tmp_path):
    from pathlib import Path

    from sparkline.agent.bench import probes
    from sparkline.common.schema import NodeInfo

    info = NodeInfo.model_validate_json(
        (Path(__file__).parent / "fixtures/console/node_info.json").read_text()
    )
    env = probes.probe(info, "img:tag", str(tmp_path / "work"), sock_path=str(tmp_path / "gone.sock"))
    assert env.docker is not None and env.docker.message.startswith("Docker is not reachable")
    sock = str(tmp_path / "d.sock")
    t = serve_docker_once(sock, b"")  # answers, then the socket is gone mid-way: an empty reply
    env = probes.probe(info, "img:tag", str(tmp_path / "work"), sock_path=sock)
    t.join(5)
    assert env.docker is not None


class _Returns:
    def __init__(self, name: str, out: dict) -> None:
        self.name, self.out = name, out

    def caps(self) -> dict:
        return {}

    def collect(self) -> dict:
        return dict(self.out)


def test_a_collector_returning_errors_that_are_not_a_map_fails_alone():
    cpu = Sampler("n1", [], 1000, ring_seconds=10).tick().cpu
    collectors = [_Returns("gpu", {"gpu": [], "errors": "oops"}), _Returns("cpu", {"cpu": cpu})]
    s = Sampler("n1", collectors, 1000, ring_seconds=10).tick()
    assert s.errors["gpu"].startswith("TypeError") and "cpu" not in s.errors
