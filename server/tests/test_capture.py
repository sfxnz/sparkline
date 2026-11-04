from __future__ import annotations

import gzip
import io
import json
import os
import pwd
import shutil
import sys
import tarfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, fields
from ipaddress import IPv4Address, IPv6Address
from pathlib import Path
from typing import Any

import pytest
from platforms import GB10
from test_no_private_identifiers import DETECTORS, REAL_LOOKING, findings

from sparkline.agent.capture import OutputNotEmpty, capture, exercise, facts_of
from sparkline.agent.collectors.memory import MemoryCollector
from sparkline.agent.config import AgentConfig
from sparkline.agent.info import Collectors
from sparkline.agent.readset import matching
from sparkline.agent.redact import CaptureRefused, Dir, Facts, Leak, Recording, leaks, redact
from sparkline.agent.sampler import Sampler
from sparkline.agent.sources import NvmlReplay, RootFs, Sources, recorded
from sparkline.common.identifiers import text_of
from sparkline.common.metrics import flatten


def hidden_from_guard(sep: str, *parts: str) -> str:
    return sep.join(parts)


HOST = "alicebox"
USER = "alice"
HOME = hidden_from_guard("/", "", "home", USER)
LAN_IP = hidden_from_guard(".", "10", "1", "2", "3")
DOCKER_IP = hidden_from_guard(".", "172", "17", "0", "5")
MAC = hidden_from_guard(":", "4c", "aa", "bb", "cc", "dd", "ee")
IFACE = "enx" + MAC.replace(":", "")
LINK_LOCAL = hidden_from_guard(":", "fe80", "", "4eaa", "bbff", "fecc", "ddee")
GLOBAL6 = hidden_from_guard(":", "2a01", "4f8", "", "1")
GATEWAY_HEX = hidden_from_guard("", "0201", "A8C0")
SYS_IMAGE_GUID = hidden_from_guard(":", "4caa", "bb03", "00cc", "ddee")
SWITCH_ID = hidden_from_guard("", "5734", "1200", "03bbaa4c")
GPU_UUID = hidden_from_guard(
    "-",
    "GPU",
    hidden_from_guard("", "6a1b", "2c3d"),
    "1234",
    "5678",
    "9abc",
    hidden_from_guard("", "def0", "1234", "5678"),
)
CPU_SERIAL = "ZX81ALICE42"
DMI_SERIAL = "DMI-ALICE-9"
PRODUCT_UUID = hidden_from_guard(
    "-",
    hidden_from_guard("", "1b2c", "3d4e"),
    "2345",
    "6789",
    "abcd",
    hidden_from_guard("", "ef01", "2345", "6789"),
)
MACHINE_ID = "5e" * 16
HF_PATH = hidden_from_guard("--", "/root/.cache/huggingface/hub/models", "alice-private", "M/snapshots/a")
API_KEY = hidden_from_guard("", "sk-", "alicesecretkey123")
CONTAINER_ID = "0123456789abcdef" * 4
CONTAINER_NAME = "alice_vllm"
PRIVATE_IMAGE = "alice/private:latest"
GPU_PID = json.loads((GB10 / "nvml.json").read_text())["nvmlDeviceGetComputeRunningProcesses"]['["gpu0"]'][0][
    "__fields__"
]["pid"]
OTHER_PID = 4242
OTHER_PROGRAM = "secret-tool"
PLANTED = [
    USER,
    HOST,
    LAN_IP,
    DOCKER_IP,
    MAC,
    MAC.replace(":", ""),
    LINK_LOCAL,
    GLOBAL6,
    GATEWAY_HEX,
    SYS_IMAGE_GUID,
    SWITCH_ID,
    GPU_UUID,
    GPU_UUID[4:],
    CPU_SERIAL,
    DMI_SERIAL,
    PRODUCT_UUID,
    MACHINE_ID,
    API_KEY,
    CONTAINER_ID,
    CONTAINER_ID[:12],
    OTHER_PROGRAM,
]


def _append(path: Path, text: str) -> None:
    path.write_text(path.read_text() + text)


def _stat(pid: int, comm: str) -> str:
    return f"{pid} ({comm}) S " + " ".join(["1"] * 10 + ["50", "20"] + ["0"] * 6 + ["12345", "1", "2000"] * 3)


def gb10_copy(tmp: Path) -> Path:
    copy = tmp / "gb10"
    shutil.copytree(GB10, copy, symlinks=True)
    return copy


def with_free_text(copy: Path, text: str) -> Path:
    _append(copy / "root/proc/cpuinfo", f"Hardware\t: {text}\n")
    return copy


def planted(tmp: Path) -> Path:
    copy = gb10_copy(tmp)
    root = copy / "root"
    (root / "proc/sys/kernel/hostname").write_text(HOST + "\n")
    _append(
        root / "proc/self/mounts",
        f"/dev/mapper/{HOST}--vg-home {HOME} ext4 rw,relatime 0 0\n"
        f"{LAN_IP}:/export /mnt/nfs nfs4 rw,addr={LAN_IP} 0 0\n",
    )
    device = root / "sys/devices/pci000a:00/000a:00:00.0/000a:01:00.0"
    net = device / "net" / IFACE
    net.mkdir(parents=True)
    for name, value in {"operstate": "up", "speed": "1000", "address": MAC}.items():
        (net / name).write_text(value + "\n")
    (net / "device").symlink_to("../../../000a:01:00.0")
    (root / "sys/class/net" / IFACE).symlink_to(
        f"../../devices/pci000a:00/000a:00:00.0/000a:01:00.0/net/{IFACE}"
    )
    _append(root / "proc/self/net/dev", f"{IFACE}: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n")
    lan_hex = IPv4Address(LAN_IP).packed[::-1].hex().upper()
    _append(
        root / "proc/self/net/route",
        f"{IFACE}\t00000000\t{GATEWAY_HEX}\t0003\t0\t0\t50\t00000000\t0\t0\t0\n"
        f"{IFACE}\t{lan_hex}\t00000000\t0001\t0\t0\t50\tFFFFFFFF\t0\t0\t0\n",
    )
    (root / "sys/class/infiniband/rocep1s0f0/sys_image_guid").write_text(SYS_IMAGE_GUID + "\n")
    (root / "sys/class/net/enp1s0f0np0/phys_switch_id").write_text(SWITCH_ID + "\n")
    _append(root / "proc/cpuinfo", f"Serial\t\t: {CPU_SERIAL}\n")
    with_free_text(copy, f"{USER} {MACHINE_ID} {DMI_SERIAL} {PRODUCT_UUID}")
    gpu = root / "proc" / str(GPU_PID)
    gpu.mkdir()
    (gpu / "stat").write_text(_stat(GPU_PID, "python3"))
    argv = [
        f"{HOME}/venv/bin/python3",
        "-m",
        "vllm",
        "--model",
        HF_PATH,
        "--host",
        LAN_IP,
        "--api-key",
        API_KEY,
    ]
    (gpu / "cmdline").write_text("\0".join(argv) + "\0")
    (gpu / "cgroup").write_text(f"0::/system.slice/docker-{CONTAINER_ID}.scope\n")
    other = root / "proc" / str(OTHER_PID)
    other.mkdir()
    (other / "stat").write_text(_stat(OTHER_PID, OTHER_PROGRAM))
    (other / "cmdline").write_text(f"{OTHER_PROGRAM}\0--user\0{USER}\0")
    (root / "etc/passwd").write_text(
        f"root:x:0:0:root:/root:/bin/bash\n{USER}:x:1000:1000::{HOME}:/bin/bash\n"
    )
    (root / "etc/machine-id").write_text(MACHINE_ID + "\n")
    dmi = root / "sys/class/dmi/id"
    dmi.mkdir(parents=True)
    (dmi / "product_serial").write_text(DMI_SERIAL + "\n")
    (dmi / "product_uuid").write_text(PRODUCT_UUID + "\n")

    nvml = json.loads((copy / "nvml.json").read_text())
    nvml["nvmlDeviceGetUUID"] = {'["gpu0"]': GPU_UUID}
    (copy / "nvml.json").write_text(json.dumps(nvml))
    host = json.loads((copy / "host.json").read_text())
    six = "ffff:ffff:ffff:ffff::"
    host["net_if_addrs"][IFACE] = [
        {"family": "AF_INET", "address": LAN_IP, "netmask": "255.255.255.0"},
        {"family": "AF_INET6", "address": f"{LINK_LOCAL}%{IFACE}", "netmask": six},
        {"family": "AF_INET6", "address": GLOBAL6, "netmask": six},
        {"family": "AF_LINK", "address": MAC, "netmask": None},
    ]
    host["statvfs"][HOME] = host["statvfs"]["/"]
    host["which"]["fio"] = f"{HOME}/.local/bin/fio"
    host["docker"]["/images/json"]["result"].append({"RepoTags": [PRIVATE_IMAGE]})
    host["docker"]["/containers/json"] = {
        "result": [
            {
                "Id": CONTAINER_ID,
                "Names": ["/" + CONTAINER_NAME],
                "Image": PRIVATE_IMAGE,
                "Command": f"python3 -m vllm --host {LAN_IP}",
                "Mounts": [{"Source": f"{HOME}/models", "Destination": "/models"}],
                "NetworkSettings": {"Networks": {"bridge": {"IPAddress": DOCKER_IP, "MacAddress": MAC}}},
            }
        ]
    }
    (copy / "host.json").write_text(json.dumps(host))
    return copy


def with_gpu_process(copy: Path, cmdline: bytes, cgroup: bytes = b"0::/\n") -> Path:
    proc = copy / "root/proc" / str(GPU_PID)
    proc.mkdir()
    (proc / "stat").write_text(_stat(GPU_PID, "python3"))
    (proc / "cmdline").write_bytes(cmdline)
    (proc / "cgroup").write_bytes(cgroup)
    return copy


def capture_of(src_dir: Path, out: Path) -> Any:
    src = recorded(src_dir)
    return capture(src, out, facts_of(src))


def surfaces(out: Path) -> Iterator[tuple[str, bytes]]:
    for p in sorted(out.rglob("*")):
        rel = p.relative_to(out).as_posix()
        yield "path", rel.encode()
        if p.is_symlink():
            yield f"{rel} -> ", os.readlink(p).encode()
        elif p.is_file() and p.name != "recording.tgz":
            yield rel, p.read_bytes()
    with tarfile.open(out / "recording.tgz") as tar:
        for m in tar.getmembers():
            yield "archive path", m.name.encode()
            yield f"archive {m.name} -> ", m.linkname.encode()
            if m.isfile():
                f = tar.extractfile(m)
                assert f is not None
                yield f"archive {m.name}", f.read()


def tree(d: Path) -> dict[str, bytes]:
    return {
        p.relative_to(d).as_posix(): os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
        for p in sorted(d.rglob("*"))
        if p.is_symlink() or p.is_file()
    }


def shape(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: shape(x) for k, x in v.items()}
    if isinstance(v, list):
        return [shape(x) for x in v]
    return type(v).__name__


def test_a_capture_of_the_gb10_recording_loads_with_no_nvml_misses_and_the_same_node_info_shape(tmp_path):
    report = capture(recorded(GB10), tmp_path / "out", Facts())
    assert report.differences == []
    replay = recorded(tmp_path / "out")
    info, sample, _ = exercise(replay)
    assert isinstance(replay.nvml, NvmlReplay) and replay.nvml.misses == []
    original, original_sample, _ = exercise(recorded(GB10))
    assert shape(info.model_dump(mode="json")) == shape(original.model_dump(mode="json"))
    assert sorted(flatten(sample)) == sorted(flatten(original_sample))


CGNAT_IN_HEX = (hidden_from_guard("", "6445", "1234"), hidden_from_guard("", "1234", "4064"))


def with_counters(copy: Path, first: str, second: str) -> Path:
    root = copy / "root"
    stat = root / "proc/stat"
    head, *rest = stat.read_text().splitlines(keepends=True)
    stat.write_text(" ".join(["cpu ", first, second, *head.split()[3:]]) + "\n" + "".join(rest))
    dev = root / "proc/self/net/dev"
    dev.write_text(dev.read_text().replace("240869647387 204811693", f"240869647387 {first}"))
    host = json.loads((copy / "host.json").read_text())
    host["statvfs"]["/"][3] = int(second)
    (copy / "host.json").write_text(json.dumps(host))
    nvml = json.loads((copy / "nvml.json").read_text())
    nvml["nvmlDeviceGetTotalEnergyConsumption"]['["gpu0"]'] = int(first)
    (copy / "nvml.json").write_text(json.dumps(nvml))
    return copy


def test_a_counter_that_reads_as_a_cgnat_address_in_hex_is_kept(tmp_path):
    out = tmp_path / "out"
    report = capture_of(with_counters(gb10_copy(tmp_path), *CGNAT_IN_HEX), out)
    assert report.differences == []
    assert f"cpu  {CGNAT_IN_HEX[0]} {CGNAT_IN_HEX[1]} " in (out / "root/proc/stat").read_text()
    assert f" {CGNAT_IN_HEX[0]} " in (out / "root/proc/self/net/dev").read_text()
    assert json.loads((out / "host.json").read_text())["statvfs"]["/"][3] == int(CGNAT_IN_HEX[1])
    energy = json.loads((out / "nvml.json").read_text())["nvmlDeviceGetTotalEnergyConsumption"]
    assert energy == {'["gpu0"]': int(CGNAT_IN_HEX[0])}


def test_a_route_table_still_refuses_an_address_in_decimal_looking_hex(tmp_path):
    copy = gb10_copy(tmp_path)
    _append(
        copy / "root/proc/self/net/route",
        f"enP7s7\t00000000\t00000000\t0001\t0\t0\t0\t{CGNAT_IN_HEX[1]}\t0\t0\t0\n",
    )
    with pytest.raises(CaptureRefused) as refused:
        capture_of(copy, tmp_path / "out")
    assert Leak("root/proc/self/net/route", "IPv4 address (hex)") in refused.value.leaks


def test_no_planted_identifier_survives_a_capture(tmp_path):
    report = capture_of(planted(tmp_path), tmp_path / "out")
    assert report.differences == []
    found = [f for name, data in surfaces(tmp_path / "out") for f in findings(name, *text_of(data))]
    assert found == []
    survived = [
        (name, value)
        for name, data in surfaces(tmp_path / "out")
        for value in PLANTED
        if value.lower().encode() in data.lower()
    ]
    assert survived == []
    assert not (tmp_path / "out/root/proc" / str(OTHER_PID)).exists()
    cfg = AgentConfig(node_id="t")
    sample = Sampler("t", Collectors(cfg, recorded(tmp_path / "out")).ordered()).tick()
    assert sample.procs is not None
    assert [(p.name, p.cmdline) for p in sample.procs if p.pid == GPU_PID] == [("python3", "python3")]


SECRET = "zorbsecretvalue42"


def recorded_cmdline(out: Path) -> bytes:
    return (out / "root/proc" / str(GPU_PID) / "cmdline").read_bytes()


def test_a_command_line_that_is_not_utf8_records_only_the_program_name(tmp_path):
    argv = b"python3\0/data/caf\xe9.txt\0--api-key\0" + SECRET.encode() + b"\0"
    capture_of(with_gpu_process(gb10_copy(tmp_path), argv), tmp_path / "out")
    assert recorded_cmdline(tmp_path / "out") == b"python3\0"
    assert [name for name, data in surfaces(tmp_path / "out") if SECRET.encode() in data] == []


def test_a_cgroup_file_that_is_not_utf8_is_rewritten_like_a_utf8_one(tmp_path):
    line = f"0::/system.slice/docker-{CONTAINER_ID}.scope".encode()
    recorded_cgroup = {}
    for name, tail in (("utf8", b""), ("latin1", b"\xe9")):
        copy = with_gpu_process(gb10_copy(tmp_path / name), b"python3\0", line + tail + b"\n")
        capture_of(copy, tmp_path / name / "out")
        recorded_cgroup[name] = (tmp_path / name / "out/root/proc" / str(GPU_PID) / "cgroup").read_bytes()
    assert recorded_cgroup["latin1"] == recorded_cgroup["utf8"]
    assert CONTAINER_ID.encode() not in recorded_cgroup["latin1"]


@pytest.mark.parametrize(
    ("title", "program"),
    [
        ("vllm: serve --served-model-name team/zorbrun", b"vllm:"),
        (f"python3 {hidden_from_guard('/', '', 'home', 'u', 'train.py')}", b"python3"),
    ],
)
def test_a_command_line_in_one_argument_records_only_its_first_word(title, program, tmp_path):
    capture_of(with_gpu_process(gb10_copy(tmp_path), title.encode() + b"\0"), tmp_path / "out")
    assert recorded_cmdline(tmp_path / "out") == program + b"\0"


def with_a_live_os_name(monkeypatch: pytest.MonkeyPatch, os_name: str) -> None:
    import sparkline.agent.capture as cli

    exercise = cli.exercise
    runs: list[str] = []

    def live_first(src: Sources) -> Any:
        info, sample, pids = exercise(src)
        runs.append("live" if not runs else "replay")
        return (info.model_copy(update={"os": os_name}) if runs[-1] == "live" else info), sample, pids

    monkeypatch.setattr(cli, "exercise", live_first)


def test_a_replay_difference_prints_its_field_path_and_no_value(tmp_path, monkeypatch):
    with_a_live_os_name(monkeypatch, "Ubuntu zorbsecret")
    report = capture(recorded(GB10), tmp_path / "out", Facts())
    assert report.differences == ["node_info.os"]


def test_a_replay_difference_that_holds_a_name_of_this_machine_refuses_and_removes_the_output(
    tmp_path, monkeypatch
):
    with_a_live_os_name(monkeypatch, "Ubuntu zorbsecret")
    out = tmp_path / "out"
    with pytest.raises(CaptureRefused) as refused:
        capture(recorded(GB10), out, Facts(hostnames=("zorbsecret",)))
    assert not out.exists(), "the written recording is removed"
    assert "a reading that the agent reports: hostname" in str(refused.value)
    assert "zorbsecret" not in str(refused.value)
    assert "node_info.os" not in str(refused.value), "naming the reading would narrow the name to its words"
    assert "sudo hostname" in str(refused.value), "it says what to do"


def test_an_interface_labelled_with_its_own_name_replays_as_it_ran(tmp_path):
    copy = gb10_copy(tmp_path)
    root = copy / "root"
    net = root / "sys/devices/pci000a:00/000a:00:00.0/000a:01:00.0/net" / IFACE
    net.mkdir(parents=True)
    (net / "operstate").write_text("up\n")
    (root / "sys/class/net" / IFACE).symlink_to(
        f"../../devices/pci000a:00/000a:00:00.0/000a:01:00.0/net/{IFACE}"
    )
    host = json.loads((copy / "host.json").read_text())
    host["net_if_addrs"][IFACE] = [{"family": "AF_LINK", "address": MAC, "netmask": None}]
    (copy / "host.json").write_text(json.dumps(host))
    report = capture_of(copy, tmp_path / "out")
    assert report.differences == []
    assert not (tmp_path / "out/root/sys/class/net" / IFACE).exists(), "the interface is renamed"


def test_a_name_that_is_a_word_of_a_reviewed_path_refuses_before_writing(tmp_path):
    copy = gb10_copy(tmp_path)
    (copy / "root/proc/sys/kernel/hostname").write_text("cpu\n")
    message = refusal_of(copy, tmp_path / "out")
    assert "a fixed part of a path that the agent reads: hostname" in message
    assert "cpufreq" not in message, "naming the path would narrow the name to its words"
    assert "sudo hostname" in message, "it says what to do"


def test_one_identifier_keeps_one_placeholder_across_files_and_encodings(tmp_path):
    capture_of(planted(tmp_path), tmp_path / "out")
    out = tmp_path / "out"
    host = json.loads((out / "host.json").read_text())
    (iface,) = [n for n in host["net_if_addrs"] if n.startswith("enx")]
    addrs = {
        a["family"]: a["address"] for a in host["net_if_addrs"][iface] if not a["address"].startswith("2001")
    }
    mac = bytes.fromhex(addrs["AF_LINK"].replace(":", ""))
    assert iface == "enx" + mac.hex()
    eui64 = bytes([mac[0] ^ 2]) + mac[1:3] + b"\xff\xfe" + mac[3:]
    assert addrs["AF_INET6"] == f"{IPv6Address(b'\xfe\x80' + bytes(6) + eui64)}%{iface}"
    ip_hex = IPv4Address(addrs["AF_INET"]).packed[::-1].hex().upper()
    assert f"{iface}\t{ip_hex}\t" in (out / "root/proc/self/net/route").read_text()
    cgroup = (out / "root/proc" / str(GPU_PID) / "cgroup").read_text()
    (container,) = host["docker"]["/containers/json"]["result"]
    assert cgroup == f"0::/docker/{container['Id']}\n"


BRIDGE = "br-1a2b3c4d5e6f"
VETH = "veth1a2b3c4"


def test_a_docker_interface_keeps_one_placeholder_across_paths_and_readings(tmp_path):
    copy = gb10_copy(tmp_path)
    root = copy / "root"
    host = json.loads((copy / "host.json").read_text())
    for name in (BRIDGE, VETH):
        device = root / "sys/devices/virtual/net" / name
        device.mkdir(parents=True)
        (device / "operstate").write_text("up\n")
        (root / "sys/class/net" / name).symlink_to(f"../../devices/virtual/net/{name}")
        _append(root / "proc/self/net/dev", f"{name}: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n")
        host["net_if_addrs"][name] = []
    docker_net = hidden_from_guard("", "0000", "12AC")
    _append(
        root / "proc/self/net/route", f"{BRIDGE}\t{docker_net}\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
    )
    (copy / "host.json").write_text(json.dumps(host))
    out = tmp_path / "out"
    capture_of(copy, out)
    assert [n for _, data in surfaces(out) for n in (BRIDGE, VETH) if n.encode() in data] == []
    names = {p.name for p in (out / "root/sys/class/net").iterdir()}
    (bridge,) = [n for n in names if n.startswith("br-")]
    (veth,) = [n for n in names if n.startswith("veth")]
    readings = json.loads((out / "host.json").read_text())["net_if_addrs"]
    dev = (out / "root/proc/self/net/dev").read_text()
    for name in (bridge, veth):
        assert (out / "root/sys/devices/virtual/net" / name / "operstate").exists()
        assert f"{name}: 100 1" in dev
        assert name in readings
    assert f"{bridge}\t" in (out / "root/proc/self/net/route").read_text()


GUARDED = {
    line: [m[0] for d in DETECTORS for m in d.pattern.finditer(line) if not d.ok(m)] for line in REAL_LOOKING
}


@pytest.mark.parametrize("line", REAL_LOOKING)
def test_every_identifier_form_the_guard_knows_is_replaced_or_refused(line, tmp_path):
    copy = gb10_copy(tmp_path)
    with_free_text(copy, line)
    out = tmp_path / "out"
    try:
        capture_of(copy, out)
    except CaptureRefused:
        assert not out.exists()
        return
    assert [f for name, data in surfaces(out) for f in findings(name, *text_of(data))] == []
    assert GUARDED[line]
    assert [v for v in GUARDED[line] for _, data in surfaces(out) if v.encode() in data] == []


def test_a_capture_that_meets_an_identifier_it_cannot_replace_writes_nothing(tmp_path):
    copy = gb10_copy(tmp_path)
    (copy / "root/proc/sys/kernel/hostname").write_text(HOST + "\n")
    (copy / "root/proc/sys/kernel/osrelease").write_bytes(b"6.17.0-\xff\xfe" + HOST.encode() + b"\n")
    out = tmp_path / "out"
    with pytest.raises(CaptureRefused) as refused:
        capture_of(copy, out)
    assert not out.exists()
    assert "root/proc/sys/kernel/osrelease: hostname" in str(refused.value)
    assert HOST not in str(refused.value)


def a_collector_also_reads(monkeypatch: pytest.MonkeyPatch, read: Callable[[RootFs], object]) -> None:
    collect = MemoryCollector.collect

    def collect_and_read(self: MemoryCollector) -> dict:
        read(self.fs)
        return collect(self)

    monkeypatch.setattr(MemoryCollector, "collect", collect_and_read)


def refusal_of(copy: Path, out: Path) -> str:
    with pytest.raises(CaptureRefused) as refused:
        capture_of(copy, out)
    assert not out.exists(), "nothing is written"
    return str(refused.value)


def test_a_collector_that_reads_outside_the_reviewed_read_set_is_refused_by_name(tmp_path, monkeypatch):
    copy = gb10_copy(tmp_path)
    (copy / "root/proc/vmstat").write_text("nr_free_pages 1\n")
    a_collector_also_reads(monkeypatch, lambda fs: fs.read("/proc/vmstat"))
    assert "root/proc/vmstat: not in the reviewed read set" in refusal_of(copy, tmp_path / "out")


def test_a_reviewed_text_file_that_is_not_utf8_is_refused(tmp_path):
    copy = gb10_copy(tmp_path)
    (copy / "root/proc/sys/kernel/osrelease").write_bytes(b"6.17.0-\xff\xfe-nvidia\n")
    assert "root/proc/sys/kernel/osrelease: binary content" in refusal_of(copy, tmp_path / "out")


@pytest.mark.parametrize("disk", ["sda", "vda", "xvda", "hda", "mmcblk0"])
def test_the_read_set_takes_the_size_of_any_disk_the_storage_collector_reads(disk):
    assert ("/sys/devices/**/block/*/size", "text") in matching(f"/sys/devices/platform/x/block/{disk}/size")


def gb10_readings() -> Recording:
    nvml, host = (json.loads((GB10 / name).read_text()) for name in ("nvml.json", "host.json"))
    return Recording("linux", {"left_out": {}}, {"/": Dir()}, nvml, host)


@pytest.mark.parametrize(
    ("unreviewed", "surface"),
    [
        (lambda rec: rec.nvml.update(nvmlDeviceGetBoardId={'["gpu0"]': 1}), "nvml.json nvmlDeviceGetBoardId"),
        (lambda rec: rec.host.update(smi={"gpu0": "x"}), "host.json smi"),
        (lambda rec: rec.host["docker"].update({"/info": {"result": {}}}), "host.json docker /info"),
    ],
)
def test_a_reading_outside_the_reviewed_sets_is_refused_by_name(unreviewed, surface):
    rec = gb10_readings()
    assert leaks(redact(rec, Facts())) == [], "the GB10 readings are all reviewed"
    unreviewed(rec)
    assert leaks(redact(rec, Facts())) == [Leak(surface, "not in the reviewed read set")]


def test_a_source_the_capture_does_not_trace_stops_it(tmp_path):
    @dataclass(frozen=True)
    class WithSmi(Sources):
        smi: Callable[[], str] = lambda: ""

    gb10 = recorded(GB10)
    src = WithSmi(**{f.name: getattr(gb10, f.name) for f in fields(Sources)})
    with pytest.raises(TypeError, match="smi"):
        capture(src, tmp_path / "out", Facts())
    assert not (tmp_path / "out").exists()


_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_written: list[str] | None = None
_hooked = False


_CHANGES_FIRST = {"os.mkdir", "os.remove", "os.rmdir", "shutil.rmtree", "os.chmod", "os.truncate", "os.utime"}
_CHANGES_BOTH = {"os.rename", "os.link", "shutil.copyfile", "shutil.move"}


def _changed(event: str, args: tuple[Any, ...]) -> list[Any]:
    if event == "open":
        return [args[0]] if isinstance(args[2], int) and args[2] & _WRITE_FLAGS else []
    if event in _CHANGES_FIRST:
        return [args[0]]
    if event in _CHANGES_BOTH:
        return [args[0], args[1]]
    return [args[1]] if event == "os.symlink" else []


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if _written is not None:
        paths = [p for p in _changed(event, args) if isinstance(p, str | bytes | os.PathLike)]
        _written.extend(os.path.abspath(os.fsdecode(p)) for p in paths)


@contextmanager
def paths_written() -> Iterator[list[str]]:
    """An audit hook cannot be removed, so one hook serves every test and records only inside this block."""
    global _written, _hooked
    if not _hooked:
        sys.addaudithook(_audit)
        _hooked = True
    _written = written = []
    try:
        yield written
    finally:
        _written = None


def test_a_capture_writes_only_inside_its_output_directory(tmp_path):
    copy = planted(tmp_path)
    capture_of(copy, tmp_path / "warm-up")  # first-time imports may write bytecode caches
    before = tree(copy)
    out = tmp_path / "out"
    with paths_written() as written:
        capture_of(copy, out)
    assert written
    assert [p for p in written if not Path(p).is_relative_to(out)] == []
    assert tree(copy) == before


def test_a_capture_refuses_an_output_directory_that_has_files(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    (out / "notes.txt").write_text("mine")
    with pytest.raises(OutputNotEmpty):
        capture(recorded(GB10), out, Facts())
    assert [p.name for p in out.iterdir()] == ["notes.txt"]
    assert (out / "notes.txt").read_text() == "mine"


def test_capturing_a_capture_changes_nothing(tmp_path):
    capture_of(planted(tmp_path), tmp_path / "first")
    capture_of(tmp_path / "first", tmp_path / "second")
    first, second = tree(tmp_path / "first"), tree(tmp_path / "second")
    del first["recording.tgz"], second["recording.tgz"]
    meta = [json.loads(t.pop("platform.json")) for t in (first, second)]
    assert first == second
    kept = ("platform", "device", "synthesized", "unreadable")
    a, b = ({k: m[k] for k in kept} for m in meta)
    assert a == b


def test_the_archive_names_no_owner_and_no_time(tmp_path):
    report = capture(recorded(GB10), tmp_path / "out", Facts())
    data = report.archive.read_bytes()
    assert data[4:8] == bytes(4), "gzip header time"
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data))) as tar:
        members = tar.getmembers()
    assert {(m.uid, m.gid, m.uname, m.gname, m.mtime) for m in members} == {(0, 0, "", "", 0)}
    assert {m.name.split("/")[0] for m in members} == {"platform.json", "host.json", "nvml.json", "root"}
    assert set(tree(tmp_path / "out")) - {"recording.tgz"} == {m.name for m in members if not m.isdir()}


def test_system_accounts_are_not_taken_for_people(tmp_path):
    copy = gb10_copy(tmp_path)
    (copy / "root/etc/passwd").write_text(
        f"nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n{USER}:x:1000:1000::{HOME}:/bin/bash\n"
    )
    assert [u.name for u in facts_of(recorded(copy)).users] == [USER]


def test_a_capture_that_fails_unexpectedly_prints_no_message_that_could_hold_a_value(
    tmp_path, monkeypatch, capsys
):
    import sparkline.agent.capture as cli

    def fail(*_a: object) -> None:
        raise OSError(2, "No such file or directory", f"{HOME}/{LAN_IP}")

    monkeypatch.setattr(cli, "live", lambda: recorded(GB10))
    monkeypatch.setattr(cli, "capture", fail)
    monkeypatch.setattr(cli.logging, "disable", lambda _level: None)
    assert cli.main([str(tmp_path / "out")]) == 4
    err = capsys.readouterr().err
    assert "failed with FileNotFoundError" in err
    assert USER not in err and LAN_IP not in err


def as_user(user: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Path]:
    import sparkline.agent.capture as cli

    home = tmp_path / "home" / user
    home.mkdir(parents=True)
    copy = gb10_copy(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(home))
    me = pwd.struct_passwd((user, "x", 1000, 1000, "", str(home), "/bin/bash"))
    monkeypatch.setattr(cli.pwd, "getpwuid", lambda _uid: me)
    monkeypatch.setattr(cli.socket, "gethostname", lambda: HOST)
    monkeypatch.setattr(cli, "live", lambda: recorded(copy))
    monkeypatch.setattr(cli.logging, "disable", lambda _level: None)
    return cli, home


def test_no_printed_line_holds_the_home_or_the_user_name(tmp_path, monkeypatch, capsys):
    user = "zorbuser"
    cli, home = as_user(user, tmp_path, monkeypatch)
    codes = [cli.main([str(home / "first")]), cli.main(["~/second"]), cli.main([str(home / "first")])]
    assert codes == [0, 0, 3]
    assert (home / "second/recording.tgz").exists(), "a quoted ~ is expanded"
    printed = capsys.readouterr()
    lines = (printed.out + printed.err).splitlines()
    assert any(line.startswith("Recorded this machine into") for line in lines)
    assert [line for line in lines if str(home) in line or user in line] == []


def test_a_user_named_like_a_word_of_the_printed_text_leaves_that_text_alone(tmp_path, monkeypatch, capsys):
    cli, home = as_user("sparkline", tmp_path, monkeypatch)
    assert cli.main([str(home / "out")]) == 0
    printed = capsys.readouterr().out
    assert f"Attach recording.tgz from /home/<user1>/out to a new issue: {cli.ISSUE_URL}" in printed


def test_a_refusal_names_an_unreviewed_path_up_to_its_first_unreviewed_part(tmp_path, monkeypatch):
    copy = gb10_copy(tmp_path)
    (copy / "root/proc/self/net/if_inet6").write_text(f"{'0' * 31}1 01 80 10 80 lo\n")
    by_id = copy / "root/dev/disk/by-id"
    by_id.mkdir(parents=True)
    (by_id / "nvme-Model_ZORBSERIAL9").symlink_to("../../nvme0n1")
    a_collector_also_reads(
        monkeypatch, lambda fs: (fs.read("/proc/net/if_inet6"), fs.listdir("/dev/disk/by-id"))
    )
    message = refusal_of(copy, tmp_path / "out")
    assert "root/proc/self/net/if_inet6: not in the reviewed read set" in message
    assert "root/dev/...: not in the reviewed read set" in message
    assert "ZORBSERIAL9" not in message and "by-id" not in message
