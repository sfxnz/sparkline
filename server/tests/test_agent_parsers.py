"""Collector parsers against fixture text captured from spark1 (DGX Spark / GB10)."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from sparkline.agent.collectors import counter_delta, parse_psi
from sparkline.agent.collectors.cpu import (
    classify_cores,
    core_utils,
    describe_cpu,
    parse_cpuinfo_parts,
    parse_loadavg,
    parse_proc_stat,
)
from sparkline.agent.collectors.gpu import monotonic_energy, violation_pct
from sparkline.agent.collectors.memory import build_mem, parse_meminfo
from sparkline.agent.collectors.net import (
    NetCollector,
    _If,
    assign_labels,
    classify,
    display_order,
    find_peer,
    parse_net_dev,
    parse_rdma_state,
    phy_owners,
)
from sparkline.agent.collectors.procs import (
    container_id,
    container_names,
    detect_model,
    parse_pid_stat,
    select_top,
)
from sparkline.agent.collectors.storage import disk_rates, parse_diskstats, parse_mounts
from sparkline.agent.collectors.thermal import Chip, build_sensors
from sparkline.agent.ethtool import parse_gstrings
from sparkline.common.netutil import default_route_iface
from sparkline.common.schema import NetIfInfo

FIX = Path(__file__).parent / "fixtures" / "agent"


def fx(name: str) -> str:
    return (FIX / name).read_text()


# -- memory -------------------------------------------------------------------------------------------


def test_meminfo_parse_and_breakdown():
    mi = parse_meminfo(fx("meminfo"))
    assert mi["MemTotal"] == 127600752 * 1024
    assert mi["HugePages_Total"] == 0  # unitless field kept as count
    gpu = 86300 * 2**20  # NVML usedGpuMemory of the inference job at capture time
    m = build_mem(mi, gpu, parse_psi(fx("pressure_memory")))
    assert m.used == m.total - m.available
    assert m.gpu == gpu and m.anon == mi["AnonPages"] and m.shmem == mi["Shmem"]
    assert m.gpu + m.anon + m.shmem + m.kernel + m.other == m.used
    assert m.other >= 0
    assert m.cache == mi["Cached"] - mi["Shmem"]
    assert m.swap_used == mi["SwapTotal"] - mi["SwapFree"]
    assert m.psi_some == 0.0 and m.psi_full == 0.0


def test_mem_components_never_exceed_used():
    mi = parse_meminfo(fx("meminfo"))
    m = build_mem(mi, 10**15, None)  # absurd GPU figure: everything is clamped into used
    assert m.gpu == m.used and m.anon == m.shmem == m.kernel == m.other == 0
    m = build_mem(mi, None, None)  # no NVML: gpu stays None (not 0), the rest still adds up
    assert m.gpu is None and m.anon + m.shmem + m.kernel + m.other == m.used


def test_psi_parse():
    assert parse_psi(fx("pressure_io")) == {"some": 0.0, "full": 0.0}
    assert parse_psi("some avg10=1.25 avg60=0 avg300=0 total=1\n") == {"some": 1.25}
    assert parse_psi(fx("pressure_cpu"))["some"] == 0.0


# -- cpu ------------------------------------------------------------------------------------------------


def test_proc_stat_utils():
    a, b = parse_proc_stat(fx("stat_1")), parse_proc_stat(fx("stat_2"))
    ids = sorted(a)
    assert ids == list(range(20))
    assert core_utils(None, a, ids) == [0.0] * 20  # first read: zeros, not garbage
    u = core_utils(a, b, ids)
    assert len(u) == 20 and all(0 <= x <= 100 for x in u) and sum(u) > 0
    assert core_utils(b, a, ids) == [0.0] * 20  # counters went backwards (reset): 0


def test_core_classification_from_fixture():
    models = parse_cpuinfo_parts(fx("cpuinfo"))
    assert models[0] == "Cortex-A725" and models[5] == "Cortex-X925" and len(models) == 20
    max_khz = {i: 3900000 if i in (5, 6, 7, 8, 9, 15, 16, 17, 18, 19) else 2808000 for i in range(20)}
    clusters = {i: 56 if i < 10 else 1144 for i in range(20)}
    cores = classify_cores(max_khz, models, clusters)
    assert [c.kind for c in cores[:6]] == ["efficiency"] * 5 + ["performance"]
    assert cores[5].max_mhz == 3900 and cores[0].model == "Cortex-A725"
    assert {c.cluster for c in cores} == {0, 1}
    assert describe_cpu(cores) == "10× Cortex-X925 + 10× Cortex-A725"
    same = classify_cores(dict.fromkeys(range(4), 2000000), {}, {})
    assert {c.kind for c in same} == {"unknown"}


def test_loadavg():
    assert parse_loadavg(fx("loadavg")) == (2.59, 2.44, 2.63)


# -- storage ----------------------------------------------------------------------------------------------


def test_diskstats_whole_devices_only():
    a, b = parse_diskstats(fx("diskstats_1")), parse_diskstats(fx("diskstats_2"))
    assert list(a) == ["nvme0n1"]  # no loops, no partitions
    r = disk_rates(a["nvme0n1"], b["nvme0n1"], 1.0)
    assert r[0] == (b["nvme0n1"][1] - a["nvme0n1"][1]) * 512
    assert 0 <= r[4] <= 100
    assert disk_rates(None, b["nvme0n1"], 1.0) == (0.0,) * 5
    assert disk_rates(b["nvme0n1"], a["nvme0n1"], 1.0) == (0.0,) * 5  # reset


def test_mounts_filter():
    assert parse_mounts(fx("mounts")) == [("/dev/nvme0n1p2", "/")]  # /boot/efi (vfat) excluded
    text = (
        "/dev/sda1 /data ext4 rw 0 0\n/dev/sda1 /srv/data ext4 rw 0 0\n"
        "/dev/sdb1 /snap/foo ext4 ro 0 0\n/dev/sdc1 /boot xfs rw 0 0\n/dev/sdd1 /mnt/my\\040disk xfs rw 0 0\n"
    )
    assert parse_mounts(text) == [("/dev/sda1", "/data"), ("/dev/sdd1", "/mnt/my disk")]


# -- network ----------------------------------------------------------------------------------------------


def test_net_dev():
    d = parse_net_dev(fx("net_dev"))
    assert d["enp1s0f1np1"]["rx_bytes"] == 148999122601 and d["enp1s0f1np1"]["rx_drop"] == 70
    assert d["docker0"]["tx_drop"] == 146


def test_roles_and_labels_from_sysfs_fixture():
    snap = json.loads(fx("net_sysfs.json"))
    default_if = default_route_iface(snap["default_route"])
    assert default_if == "enP7s7"
    rdma = {i["name"] for i in snap["ifaces"] if i["rdma"]}
    raw = [
        (i["name"], classify(i["name"], rdma, default_if), i["operstate"] == "up", i["device"] or i["name"])
        for i in snap["ifaces"]
        if i["name"] != "lo"
    ]
    roles = {n: r for n, r, _, _ in raw}
    assert roles["enP7s7"] == "lan" and roles["tailscale0"] == "virtual" and roles["docker0"] == "virtual"
    assert roles["wlP9s9"] == "wireless" and roles["enp1s0f0np0"] == "interconnect"
    labels = assign_labels(raw)
    assert labels["enp1s0f1np1"] == "ConnectX-7 rail A"  # PCI domain 0000 sorts before 0002
    assert labels["enP2p1s0f1np1"] == "ConnectX-7 rail B"
    assert labels["enp1s0f0np0"] == labels["enP2p1s0f0np0"] == "ConnectX-7 port (no cable)"
    assert labels["enP7s7"] == "LAN"
    ordered = [n for n, r, _, _ in sorted(raw, key=lambda x: display_order(x[1], labels[x[0]], x[0]))]
    assert ordered[:2] == ["enp1s0f1np1", "enP2p1s0f1np1"]  # rail A then B, though "enP2" sorts first by name
    assert ordered.index("enP7s7") < ordered.index("docker0") < ordered.index("wlP9s9")


def test_peer_and_rdma_state():
    peers = {"spark2": "10.100.8.2"}
    assert find_peer([("10.100.8.1", "255.255.255.0")], peers) == "spark2"
    assert find_peer([("10.100.9.1", "255.255.255.0")], peers) is None
    both = {"spark2": ["10.100.8.2", "10.100.9.2"]}
    assert find_peer([("10.100.9.1", "255.255.255.0")], both) == "spark2"
    assert parse_rdma_state("4: ACTIVE\n") == "ACTIVE" and parse_rdma_state("1: DOWN") == "DOWN"


def test_phy_counters_owned_by_first_function_of_each_port():
    # GB10: rails A/B are two PCI functions of physical port p1; the no-cable functions share p0
    sw = "72817e000347bb4c"
    funcs = [
        ("/sys/devices/pci0002:00/0002:00:00.0/0002:01:00.1", f"{sw}/p1", "enP2p1s0f1np1"),
        ("/sys/devices/pci0000:00/0000:00:00.0/0000:01:00.1", f"{sw}/p1", "enp1s0f1np1"),
        ("/sys/devices/pci0000:00/0000:00:00.0/0000:01:00.0", f"{sw}/p0", "enp1s0f0np0"),
        ("/sys/devices/pci0002:00/0002:00:00.0/0002:01:00.0", f"{sw}/p0", "enP2p1s0f0np0"),
    ]
    assert phy_owners(funcs) == {"enp1s0f1np1", "enp1s0f0np0"}
    assert phy_owners([("k", "eth9", "eth9")]) == {"eth9"}  # no phys_switch_id: its own port


def test_net_one_unreadable_iface_keeps_the_others():
    nc = NetCollector.__new__(NetCollector)
    ok = _If(NetIfInfo(name="lo", role="other", label="lo"))
    gone = _If(NetIfInfo(name="lo", role="interconnect", label="x", rdma_device="rocep1s0f0_gone"))
    nc.ifaces = [gone, ok]
    out = nc.collect()["net"]
    assert [(n.name, n.up) for n in out] == [("lo", False), ("lo", False)]  # both present, nothing raised


def test_ethtool_gstrings():
    names = [b"rx_bytes_phy", b"tx_bytes_phy", b"x" * 32]
    buf = struct.pack("=III", 0x1B, 1, 3) + b"".join(n.ljust(32, b"\0") for n in names)
    assert parse_gstrings(buf, 3) == ["rx_bytes_phy", "tx_bytes_phy", "x" * 32]


# -- thermal ---------------------------------------------------------------------------------------------


def chips_from_listing(text: str) -> list[Chip]:
    by: dict[str, dict[str, str]] = {}
    for line in text.splitlines():
        path, _, val = line.partition("=")
        d, _, f = path.rpartition("/")
        by.setdefault(d, {})[f] = val
    chips = []
    for d, files in sorted(by.items()):
        temps = {}
        for f in files:
            if f.startswith("temp") and f.endswith("_input"):
                i = int(f[4:-6])
                crit = files.get(f"temp{i}_crit")
                temps[i] = (files.get(f"temp{i}_label"), int(crit) / 1000 if crit else None)
        chips.append(
            Chip(name=files["name"], device=files["device"], temps=temps, path=d, nic=files.get("nic"))
        )
    return chips


def test_hwmon_sensors():
    built = build_sensors(chips_from_listing(fx("hwmon_listing")))
    s = {info.id: info for info, _ in built}
    assert [f"acpitz.{n}" for n in range(7)] == [i for i in s if i.startswith("acpitz")]
    assert s["acpitz.0"].label == "ACPI zone 0" and s["acpitz.0"].group == "soc"
    assert s["nvme.composite"].label == "NVMe Composite" and s["nvme.composite"].crit_c == 84.85
    assert s["nvme.sensor_1"].group == "nvme"
    # four PCI functions (hwmon2-5) of one ConnectX-7 chip: one sensor, read from all four (max)
    assert [i for i in s if i.startswith("mlx5")] == ["mlx5.0"] and s["mlx5.0"].label == "ConnectX-7 ASIC"
    assert [p for i, p in built if i.id == "mlx5.0"][0] == [
        (f"/sys/class/hwmon/hwmon{n}", 1) for n in (2, 3, 4, 5)
    ]
    assert s["mlx5.0"].crit_c == 105.0 and s["mlx5.0"].group == "nic"
    assert s["mt7925_phy0.1"].group == "wireless"
    assert len(s) == len(built) == 12  # ids unique


# -- processes -------------------------------------------------------------------------------------------


def test_container_id_variants():
    cid = "bbc4b004fd764d1f0dc5c547f6f91214920a4764c7b4d22f6e8aeceb1c0bc215"
    assert container_id(fx("cgroup_docker")) == cid
    assert container_id(fx("cgroup_session")) is None
    assert container_id(f"0::/docker/{cid}") == cid
    assert container_id(f"0::/kubepods.slice/kubepods-pod1.slice/cri-containerd-{cid}.scope") == cid
    assert container_id(f"0::/kubepods/burstable/pod-uid/{cid}") == cid
    names = container_names(json.loads(fx("docker_containers.json")))
    assert names[cid] == "c5-3B-r0"


def test_model_detection():
    cmd = fx("cmdline_exl3").replace("\0", " ").strip()
    assert detect_model(cmd) == "DeepSeek-V4.1-Flash-EXL3"
    assert detect_model("vllm serve --model=meta-llama/Llama-3.1-8B") == "meta-llama/Llama-3.1-8B"
    assert detect_model("python x.py --model-path /data/ckpt/qwen3-32b/") == "qwen3-32b"
    assert detect_model("llama-server -m /srv/llm/mistral-7b.Q4_K_M.gguf") == "mistral-7b.Q4_K_M"
    assert detect_model("python serve.py /models/gemma-3") == "gemma-3"
    assert detect_model("/usr/bin/python3 -m http.server") is None


def test_pid_stat_parse():
    line = b"1234 (weird ) name) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 4 0 987654 1000 2048 x"
    assert parse_pid_stat(line) == ("weird ) name", 300, 2048, 987654)


def test_select_top_caps():
    rows = {p: {"gpu_mem": None, "rss": p, "cpu": -p} for p in range(100)}
    rows[5]["gpu_mem"] = 10
    top = select_top(rows)
    assert top[0] == 5 and len(top) <= 25 and 99 in top and 0 in top


# -- counters --------------------------------------------------------------------------------------------


def test_counter_helpers():
    assert counter_delta(None, 10) == 0 and counter_delta(10, 5) == 0 and counter_delta(5, 12) == 7
    assert violation_pct(None, 10**9, 1.0) is None  # first reading: no interval yet
    assert violation_pct(0, 10**9, 0.0) is None
    assert violation_pct(0, 5 * 10**8, 1.0) == pytest.approx(50.0)
    assert violation_pct(0, 5 * 10**9, 1.0) == 100.0  # clamped
    assert monotonic_energy(None, 100.0) == 100.0
    assert monotonic_energy(100.0, 99.5) == 100.0  # fresh NVML reading slightly below integrated estimate
    assert monotonic_energy(5e6, 10.0) == 10.0  # driver reset
