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

from sparkline.agent.collectors import gpu as gpu_mod
from sparkline.agent.collectors import procs as procs_mod
from sparkline.agent.collectors import thermal as thermal_mod
from sparkline.agent.sampler import Sampler

# -- NVML ------------------------------------------------------------------------------------------------


class NVMLError(Exception):
    pass


class NVMLError_NotSupported(NVMLError):  # noqa: N801 - pynvml's name
    pass


class FakeNvml:
    """Stands in for pynvml. ``fail``: the exception every device read raises (None: healthy)."""

    NVMLError = NVMLError
    NVMLError_NotSupported = NVMLError_NotSupported

    def __init__(self) -> None:
        self.fail: BaseException | None = None

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
        }

        def call(*_args):
            device_read = name.startswith("nvmlDevice") and name != "nvmlDeviceGetHandleByIndex"
            if self.fail is not None and device_read:
                raise self.fail
            return values.get(name, 1)

        return call


@pytest.fixture
def nvml(monkeypatch):
    fake = FakeNvml()
    monkeypatch.setattr(gpu_mod, "nv", fake)
    return fake


def test_gpu_reads_recover_after_transient_nvml_errors(nvml):
    g = gpu_mod.GpuCollector()
    assert len(g.gpus) == 1
    healthy = g.collect()["gpu"][0]
    assert (healthy.util, healthy.temp_c, healthy.power_w) == (42, 55, 30.0)
    assert g.proc_mem == {1234: 2**30}

    nvml.fail = NVMLError("Unknown Error")  # e.g. GPU busy / driver hiccup: readings missing, not fatal
    bad = g.collect()["gpu"][0]
    assert (bad.util, bad.temp_c, bad.power_w, bad.throttle_mask) == (None, None, None, None)
    assert g.proc_mem_total is None

    nvml.fail = None  # transient: nothing was disabled, the next tick reads everything again
    again = g.collect()["gpu"][0]
    assert (again.util, again.temp_c, again.power_w) == (42, 55, 30.0)
    assert g.gpus[0].disabled == set()


def test_unexpected_nvml_exception_is_isolated_by_the_sampler(nvml, tmp_path):
    g = gpu_mod.GpuCollector()
    s = Sampler("n1", [g], 1000, ring_seconds=10)
    nvml.fail = RuntimeError("ctypes blew up")  # not an NVMLError: escapes the collector
    s.collect_once()
    assert s.latest is not None and s.latest.gpu == [] and "RuntimeError" in s.latest.errors["gpu"]
    nvml.fail = None
    s.collect_once()
    assert s.latest.seq == 2 and s.latest.gpu[0].util == 42 and "gpu" not in s.latest.errors


def test_nvml_init_failure_leaves_an_empty_gpu_list(monkeypatch):
    fake = FakeNvml()

    def broken_init():
        raise NVMLError("Driver Not Loaded")

    fake.nvmlInit = broken_init  # type: ignore[attr-defined]
    monkeypatch.setattr(gpu_mod, "nv", fake)
    g = gpu_mod.GpuCollector()
    assert g.collect() == {"gpu": []}
    assert "NVML unavailable" in g.unsupported[0].reason


async def test_sampling_loop_keeps_running_through_collector_failures(tmp_path):
    """The real run() loop at 250 ms with collectors that fail in every way still ticks on schedule."""

    class Flaky:
        name = "flaky"

        def __init__(self) -> None:
            self.n = 0

        def collect(self) -> dict:
            self.n += 1
            errors = [OSError("hwmon vanished"), RuntimeError("nvml"), ValueError("garbage"), KeyError("x")]
            if self.n % 2:
                raise errors[(self.n // 2) % len(errors)]
            return {}

    s = Sampler("n1", [Flaky()], 250, ring_seconds=10)
    s.start()
    try:
        await asyncio.sleep(1.6)
        assert s._task is not None and not s._task.done()
        assert s.seq >= 4  # warm-up tick discarded; ~6 ticks in 1.6 s
        failed = ["flaky" in json.loads(js)["errors"] for _, js in s.ring]
        assert any(failed) and not all(failed)  # failing ticks recorded with the error, others clean
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


def test_docker_socket_disappearing_keeps_process_collection_running(tmp_path, monkeypatch):
    sock = str(tmp_path / "docker.sock")
    real_get = procs_mod.docker_get
    monkeypatch.setattr(procs_mod, "docker_get", lambda path: real_get(path, sock_path=sock, timeout=1.0))
    real_read_once = procs_mod.read_once
    # every process looks containerised, so every collect() wants container names
    monkeypatch.setattr(
        procs_mod,
        "read_once",
        lambda p: f"0::/docker/{CID}" if p.endswith("/cgroup") else real_read_once(p),
    )
    c = procs_mod.ProcsCollector(gpu=None, interval_s=1)

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
    c2 = procs_mod.ProcsCollector(gpu=None, interval_s=1)
    rows = c2.collect()["procs"]
    assert rows and {r.container for r in rows} == {CID[:12]}

    # 4. something else answers on the path with garbage: still no exception
    t = serve_docker_once(sock, b"not json")
    c3 = procs_mod.ProcsCollector(gpu=None, interval_s=1)
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


def test_hwmon_sensor_vanishing_reports_none_and_the_rest_keep_reading(tmp_path, monkeypatch):
    root = tmp_path / "hwmon"
    make_hwmon(root, 0, "acpitz", {1: 45_000})
    nvme = make_hwmon(root, 1, "nvme", {1: 38_850}, label="Composite")
    real_scan = thermal_mod.scan_hwmon
    monkeypatch.setattr(thermal_mod, "scan_hwmon", lambda: real_scan(str(root)))

    class GoneOnRead:
        """sysfs semantics: once a device is removed, reads through an fd opened earlier fail with ENODEV."""

        def __init__(self) -> None:
            self.gone: set[str] = set()

        def __call__(self, path: str) -> str:
            if any(path.startswith(g) for g in self.gone):
                raise OSError(19, "No such device")
            with open(path) as f:
                return f.read()

    read = GoneOnRead()
    monkeypatch.setattr(thermal_mod, "read", read)
    monkeypatch.setattr(thermal_mod.time, "monotonic", itertools.count(0, thermal_mod.SLOW_EVERY_S).__next__)
    t = thermal_mod.ThermalCollector()
    temps = {x.id: x.c for x in t.collect()["temps"]}
    assert temps == {"acpitz.0": 45.0, "nvme.composite": 38.85}

    read.gone.add(nvme)  # NVMe reset / driver unbind
    shutil.rmtree(nvme)
    temps = {x.id: x.c for x in t.collect()["temps"]}
    assert temps == {"acpitz.0": 45.0, "nvme.composite": None}  # unknown, never a fake 0

    read.gone.clear()  # the device comes back at the same path
    make_hwmon(root, 1, "nvme", {1: 40_000}, label="Composite")
    assert {x.id: x.c for x in t.collect()["temps"]}["nvme.composite"] == 40.0


def test_device_queried_sensors_are_read_every_slow_interval_and_carried_between(tmp_path, monkeypatch):
    root = tmp_path / "hwmon"
    acpi = make_hwmon(root, 0, "acpitz", {1: 45_000})
    nvme = make_hwmon(root, 1, "nvme", {1: 38_000}, label="Composite")
    wifi = make_hwmon(root, 2, "mt7925_phy0", {1: 50_000})
    chip_functions = [make_hwmon(root, n, "mlx5", {1: 66_000}, label="asic") for n in (3, 4)]
    for n, h in enumerate(chip_functions):
        ib = tmp_path / f"pci{n}" / "infiniband" / f"mlx5_{n}"
        ib.mkdir(parents=True)
        (ib / "sys_image_guid").write_text("0200:0000:0000:0001\n")
        os.symlink(tmp_path / f"pci{n}", f"{h}/device")
    real_scan = thermal_mod.scan_hwmon
    monkeypatch.setattr(thermal_mod, "scan_hwmon", lambda: real_scan(str(root)))
    reads: list[str] = []

    def read(path: str) -> str:
        reads.append(os.path.basename(os.path.dirname(path)))
        with open(path) as f:
            return f.read()

    monkeypatch.setattr(thermal_mod, "read", read)
    now = [100.0]
    monkeypatch.setattr(thermal_mod.time, "monotonic", lambda: now[0])
    t = thermal_mod.ThermalCollector()

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
    root = tmp_path / "hwmon"
    make_hwmon(root, 0, "nvme", {1: 38_000}, label="Composite")
    real_scan = thermal_mod.scan_hwmon
    monkeypatch.setattr(thermal_mod, "scan_hwmon", lambda: real_scan(str(root)))
    failing = [True]
    reads = []

    def read(path: str) -> str:
        reads.append(path)
        if failing[0]:
            raise OSError(5, "Input/output error")
        with open(path) as f:
            return f.read()

    monkeypatch.setattr(thermal_mod, "read", read)
    now = [100.0]
    monkeypatch.setattr(thermal_mod.time, "monotonic", lambda: now[0])
    t = thermal_mod.ThermalCollector()

    def tick(at: float) -> tuple[float | None, int]:
        now[0] = at
        reads.clear()
        return t.collect()["temps"][0].c, len(reads)

    assert tick(100) == (None, 1)
    failing[0] = False
    assert tick(101) == (38.0, 1)
    assert tick(102) == (38.0, 0)


def test_hwmon_dir_removed_during_scan_is_skipped(tmp_path, monkeypatch):
    root = tmp_path / "hwmon"
    make_hwmon(root, 0, "acpitz", {1: 45_000})
    gone = make_hwmon(root, 1, "nvme", {1: 38_850}, label="Composite")
    real_listdir = os.listdir

    def racy_listdir(path):
        if str(path) == gone:
            raise FileNotFoundError(2, "No such file or directory", path)
        return real_listdir(path)

    monkeypatch.setattr(thermal_mod.os, "listdir", racy_listdir)
    chips, _fans, _power = thermal_mod.scan_hwmon(str(root))
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
