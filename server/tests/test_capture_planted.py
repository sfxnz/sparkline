from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import pytest
from platforms import GB10
from test_capture import (
    also_reading,
    capture_of,
    gb10_copy,
    surfaces,
    with_gpu_process,
    with_version,
)
from test_capture import hidden_from_guard as j

from sparkline.agent.redact import (
    CaptureRefused,
    Dir,
    Facts,
    File,
    Link,
    Node,
    Recording,
    User,
    leaks,
    redact,
)

HOST = "zorbhost"
USER = "quuxuser"
HOME = j("/", "", "home", USER)
MAC = j(":", "4c", "aa", "bb", "cc", "dd", "ee")
SERIAL = "S5GXZORB123456Z"
SECRET = "zorbsecretvalue42"
WWID = j("", "0025388b", "91e4a1b2")
NVME = "sys/block/nvme0n1"

Plant = Callable[[Path, pytest.MonkeyPatch], None]


def passwd(name: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        home = j("/", "", "home", name)
        (copy / "root/etc/passwd").write_text(f"{name}:x:1000:1000::{home}:/bin/bash\n")

    return plant


def with_os_release_line(copy: Path, line: str) -> Path:
    release = copy / "root/usr/lib/os-release"
    release.write_text(release.read_text() + line + "\n")
    return copy


def os_release_line(line: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        with_os_release_line(copy, line)

    return plant


def an_interface_with_this_mac(copy: Path, _: pytest.MonkeyPatch) -> None:
    root = copy / "root"
    net = root / "sys/devices/pci000a:00/000a:00:00.0/000a:01:00.0/net/enxq"
    net.mkdir(parents=True)
    (net / "address").write_text(MAC + "\n")
    (net / "operstate").write_text("down\n")
    (root / "sys/class/net/enxq").symlink_to("../../devices/pci000a:00/000a:00:00.0/000a:01:00.0/net/enxq")


def an_nvme_serial(copy: Path, _: pytest.MonkeyPatch) -> None:
    nvme = copy / "root/sys/class/nvme/nvme0"
    nvme.mkdir(parents=True)
    (nvme / "serial").write_text(SERIAL + "\n")


def a_gpu_process(cmdline: bytes) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        with_gpu_process(copy, cmdline)

    return plant


def a_collector_reads(path: str, data: bytes, *also: Plant) -> Plant:
    def plant(copy: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        for other in also:
            other(copy, monkeypatch)
        carrier = copy / "root" / path.lstrip("/")
        carrier.parent.mkdir(parents=True, exist_ok=True)
        carrier.write_bytes(data)
        also_reading(monkeypatch, lambda fs: fs.read(path))

    return plant


def a_collector_lists(directory: str, name: str) -> Plant:
    def plant(copy: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        listed = copy / "root" / directory.lstrip("/")
        listed.mkdir(parents=True)
        (listed / name).symlink_to("../../nvme0n1")
        also_reading(monkeypatch, lambda fs: fs.listdir(directory))

    return plant


def blob(inside: bytes) -> bytes:
    return b"\xff\xfe" + inside + b"\x00"


GPU_METRICS = "/sys/class/drm/card0/device/gpu_metrics"
UNKNOWN_IPV6 = j(":", "2a01", "4f8", "abcd", "", "1234")
UNKNOWN_IPV4 = j(".", "10", "20", "30", "41")


def uuid(head: str) -> str:
    return j("-", head, "1234", "5678", "9abc", j("", "def012", "345670"))


@dataclass(frozen=True)
class Case:
    name: str
    expected: Literal["replaced", "refused"]
    watch: tuple[str, ...]
    version: str = ""
    plant: Plant | None = None
    hostname: str = HOST
    because: str = "not in the reviewed read set"


CASES = [
    Case("hostname inside a node_desc-like string", "replaced", (HOST,), f"{HOST} mlx5_0"),
    Case("FQDN of this host", "replaced", (HOST, "zorbcorp"), f"{HOST}.zorbcorp.example"),
    Case(
        "domain of a dotted hostname, on its own",
        "replaced",
        (HOST, "zorbcorp"),
        "mail.zorbcorp.example",
        hostname=f"{HOST}.zorbcorp.example",
    ),
    Case(
        "other or old hostname, in node_desc",
        "refused",
        ("oldname-zorb7",),
        plant=a_collector_reads("/sys/class/infiniband/rocep1s0f0/node_desc", b"oldname-zorb7 mlx5_0\n"),
    ),
    Case("home under /home", "replaced", (USER,), f"{HOME}/proj/x"),
    Case("home under /Users", "replaced", (USER,), j("/", "", "Users", USER, "proj")),
    Case("bare user name", "replaced", (USER,), f"owner {USER}"),
    Case("HF_HOME under a home", "replaced", (USER,), f"HF_HOME={HOME}/.cache/hf"),
    Case("two-letter user name", "refused", ("qz",), "owner qz", passwd("qz"), because="user"),
    Case(
        "SSSD-style user@domain home",
        "replaced",
        (USER, "zorbcorp"),
        j("/", "", "home", f"{USER}@zorbcorp.example", "x"),
    ),
    Case(
        "Hugging Face cache path of a private org and model",
        "replaced",
        ("zorb-private", "secretmodel"),
        j("--", "/root/.cache/huggingface/hub/models", "zorb-private", "secretmodel/x"),
    ),
    Case("IPv6, compressed global", "replaced", (j(":", "2a01", "4f8", "abcd"),), UNKNOWN_IPV6),
    Case(
        "IPv6, uncompressed",
        "replaced",
        (j(":", "2a01", "04f8"),),
        j(":", "2a01", "04f8", "abcd", "0000", "0000", "0000", "0000", "1234"),
    ),
    Case(
        "IPv4-mapped IPv6",
        "replaced",
        (j(".", "10", "20", "30", "40"),),
        "::ffff:" + j(".", "10", "20", "30", "40"),
    ),
    Case(
        "link-local IPv6 with a zone",
        "replaced",
        (j(":", "4eaa", "bbff"), j(":", "fecc", "ddee")),
        j(":", "fe80", "", "4eaa", "bbff", "fecc", "ddee") + "%enp1s0",
    ),
    Case(
        "EUI-64 global IPv6 from a MAC",
        "replaced",
        (j(":", "fecc", "ddee"), j(":", "2a01", "4f8", "1")),
        j(":", "2a01", "4f8", "1", "", "4eaa", "bbff", "fecc", "ddee"),
    ),
    Case(
        "if_inet6 line, link-local",
        "replaced",
        (j("", "4eaabb", "fffeccddee"),),
        j("", "fe80", "0000", "0000", "0000", "4eaa", "bbff", "fecc", "ddee") + " 02 40 20 80 enp1s0",
    ),
    Case(
        "if_inet6 line, global",
        "replaced",
        (j("", "2a01", "04f8", "abcd"),),
        j("", "2a01", "04f8", "abcd", "0000", "0000", "0000", "0000", "1234") + " 03 40 00 80 enp1s0",
    ),
    Case(
        "/proc/net/if_inet6 read by a collector",
        "refused",
        (j("", "4eaabb", "fffeccddee"),),
        plant=a_collector_reads(
            "/proc/net/if_inet6",
            j("", "fe80", "0000", "0000", "0000", "4eaa", "bbff", "fecc", "ddee").encode()
            + b" 02 40 20 80 enp1s0\n",
        ),
    ),
    Case("CGNAT IPv4", "replaced", (j(".", "100", "72", "13", "5"),), j(".", "100", "72", "13", "5")),
    Case(
        "MAC with dashes, upper case",
        "replaced",
        (j("-", "4C", "AA", "BB", "CC", "DD", "EF"),),
        j("-", "4C", "AA", "BB", "CC", "DD", "EF"),
    ),
    Case(
        "MAC with colons, upper case",
        "replaced",
        (j(":", "4C", "AA", "BB", "CC", "DD", "EF"),),
        j(":", "4C", "AA", "BB", "CC", "DD", "EF"),
    ),
    Case("MAC, Cisco dotted", "replaced", (j(".", "4caa", "bbcc", "ddef"),), j(".", "4caa", "bbcc", "ddef")),
    Case(
        "MAC with no separator, this machine's",
        "replaced",
        (MAC.replace(":", ""),),
        MAC.replace(":", "").upper(),
        an_interface_with_this_mac,
    ),
    Case(
        "MAC with no separator, unknown",
        "refused",
        (j("", "4caabb", "ccddef"),),
        j("", "4caabb", "ccddef"),
        because="MAC address",
    ),
    Case("InfiniBand GUID", "replaced", (j(":", "4caa", "bb03"),), j(":", "4caa", "bb03", "00cc", "ddef")),
    Case(
        "GPU UUID",
        "replaced",
        ("6a1b2c3d",),
        "GPU-" + j("-", "6a1b2c3d", "1234", "5678", "9abc", "def012345679"),
    ),
    Case(
        "MIG UUID",
        "replaced",
        ("7a1b2c3d",),
        "MIG-" + j("-", "7a1b2c3d", "1234", "5678", "9abc", "def012345679"),
    ),
    Case(
        "MIG UUID, new form",
        "replaced",
        ("8a1b2c3d",),
        "MIG-GPU-" + j("-", "8a1b2c3d", "1234", "5678", "9abc", "def012345679") + "/1/0",
    ),
    Case("NVMe serial, harvested", "replaced", (SERIAL,), f"SN={SERIAL}", an_nvme_serial),
    Case(
        "NVMe serial, harvested, inside a subsysnqn",
        "replaced",
        (SERIAL,),
        f"nqn.2014.08.org.nvmexpress:144d144d{SERIAL} Samsung",
        an_nvme_serial,
    ),
    Case(
        "NVMe serial, not harvested, in an unknown os-release key",
        "replaced",
        (SERIAL,),
        plant=os_release_line(f"X_SN={SERIAL}"),
    ),
    Case(
        "subsysnqn read by a collector",
        "refused",
        (SERIAL,),
        plant=a_collector_reads(
            f"/{NVME}/device/subsysnqn", f"nqn.2014.08.org.nvmexpress:144d144d{SERIAL}\n".encode()
        ),
    ),
    Case(
        "wwid read by a collector",
        "refused",
        (WWID,),
        plant=a_collector_reads(f"/{NVME}/wwid", f"eui.{WWID}\n".encode()),
    ),
    Case(
        "/dev/disk/by-id name read by a collector",
        "refused",
        (SERIAL,),
        plant=a_collector_lists("/dev/disk/by-id", f"nvme-Samsung_SSD_990_PRO_2TB_{SERIAL}"),
    ),
    Case("machine-id, 32 hex", "replaced", ("5f" * 16,), "5f" * 16),
    Case("boot_id", "replaced", ("9c1b2c3d",), uuid("9c1b2c3d")),
    Case("filesystem UUID in mount data", "replaced", ("ab1b2c3d",), "/dev/disk/by-uuid/" + uuid("ab1b2c3d")),
    Case(
        "kernel command line root=UUID", "replaced", ("bb1b2c3d",), f"root=UUID={uuid('bb1b2c3d')} ro quiet"
    ),
    Case("vfat volume id", "replaced", ("AB12-34CD",), "UUID=AB12-34CD"),
    Case("Docker id, 64 hex", "replaced", ("c0ffee" + "ab" * 29,), "c0ffee" + "ab" * 29),
    Case("hostname power", "replaced", (), hostname="power"),
    Case("hostname GB10, a word of the GPU name", "refused", ("GB10",), hostname="GB10", because="hostname"),
    Case("hostname acpitz, a sensor name", "refused", ("acpitz",), hostname="acpitz", because="hostname"),
    Case("hostname cpu, a word of reviewed paths", "refused", (), hostname="cpu", because="hostname"),
    Case("user max, a word of reviewed paths", "refused", (), plant=passwd("max"), because="user"),
    Case(
        "GPU process command line with --api-key",
        "replaced",
        (SECRET, "--api-key"),
        plant=a_gpu_process(b"python3\0serve\0--api-key\0" + SECRET.encode() + b"\0"),
    ),
    Case(
        "GPU process command line that is not UTF-8, with --api-key",
        "replaced",
        (SECRET, "--api-key", "caf"),
        plant=a_gpu_process(b"python3\0/data/caf\xe9.txt\0--api-key\0" + SECRET.encode() + b"\0"),
    ),
    Case(
        "GPU process title rewritten into one argument",
        "replaced",
        ("zorbrun",),
        plant=a_gpu_process(b"vllm: serve --served-model-name team/zorbrun\0"),
    ),
    Case(
        "/dev/disk/by-uuid name read by a collector",
        "refused",
        ("cb1b2c3d",),
        plant=a_collector_lists("/dev/disk/by-uuid", uuid("cb1b2c3d")),
    ),
    Case(
        "binary blob, harvested hostname",
        "refused",
        (HOST,),
        plant=a_collector_reads(GPU_METRICS, blob(HOST.encode())),
    ),
    Case(
        "binary blob, unknown IPv6",
        "refused",
        (UNKNOWN_IPV6,),
        plant=a_collector_reads(GPU_METRICS, blob(UNKNOWN_IPV6.encode())),
    ),
    Case(
        "binary blob, unknown IPv4",
        "refused",
        (UNKNOWN_IPV4,),
        plant=a_collector_reads(GPU_METRICS, blob(UNKNOWN_IPV4.encode())),
    ),
    Case(
        "binary blob, raw MAC bytes of this machine",
        "refused",
        (),
        plant=a_collector_reads(
            GPU_METRICS, blob(bytes.fromhex(MAC.replace(":", ""))), an_interface_with_this_mac
        ),
    ),
    Case(
        "binary blob, unknown hostname",
        "refused",
        ("otherbox9",),
        plant=a_collector_reads(GPU_METRICS, blob(b"otherbox9")),
    ),
]


def base_copy(tmp: Path, hostname: str) -> Path:
    copy = gb10_copy(tmp)
    (copy / "root/proc/sys/kernel/hostname").write_text(hostname + "\n")
    (copy / "root/etc/passwd").write_text(
        f"root:x:0:0:root:/root:/bin/bash\n{USER}:x:1000:1000::{HOME}:/bin/bash\n"
    )
    return copy


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_a_planted_identifier_is_replaced_or_refused(case, tmp_path, monkeypatch):
    copy = base_copy(tmp_path, case.hostname)
    if case.version:
        with_version(copy, case.version)
    if case.plant:
        case.plant(copy, monkeypatch)
    out = tmp_path / "out"
    if case.expected == "refused":
        with pytest.raises(CaptureRefused) as refused:
            capture_of(copy, out)
        assert not out.exists(), "nothing is written"
        assert case.because in {leak.category for leak in refused.value.leaks}
        assert [w for w in case.watch if w.lower() in str(refused.value).lower()] == [], (
            "the refusal shows no value"
        )
        return
    report = capture_of(copy, out)
    assert report.differences == []
    survived = [
        (name, w) for name, data in surfaces(out) for w in case.watch if w.lower().encode() in data.lower()
    ]
    assert survived == []


def gb10_host() -> dict:
    return json.loads((GB10 / "host.json").read_text())


@pytest.mark.parametrize(
    ("path", "node", "watch"),
    [
        (f"/sys/class/net/{HOST}-br", Link(f"../../devices/virtual/net/{HOST}-br"), HOST),
        (
            "/sys/class/net/enx" + MAC.replace(":", ""),
            Link("../../devices/virtual/net/x"),
            MAC.replace(":", ""),
        ),
        ("/sys/class/net/eth9", Link(f"../..{HOME}/x"), USER),
    ],
    ids=["hostname in a file name", "MAC in a file name", "home in a link target"],
)
def test_a_name_in_a_reviewed_path_or_link_target_is_replaced(path: str, node: Node, watch: str):
    facts = Facts(hostnames=(HOST,), users=(User(USER, HOME),), macs=(MAC,))
    red = redact(Recording("linux", {"left_out": {}}, {"/": Dir(), path: node}, {}, gb10_host()), facts)
    assert leaks(red) == []
    written = b"".join(
        p.encode() + (n.target.encode() if isinstance(n, Link) else n.data if isinstance(n, File) else b"")
        for p, n in red.recording.tree.items()
    )
    assert watch.lower().encode() not in written.lower()


def test_an_os_release_key_that_does_not_name_the_os_or_its_version_is_dropped(tmp_path):
    report = capture_of(with_os_release_line(gb10_copy(tmp_path), "X_OWNER=someone"), tmp_path / "out")
    kept = (tmp_path / "out/root/usr/lib/os-release").read_text().splitlines()
    assert [line.partition("=")[0] for line in kept] == [
        "PRETTY_NAME",
        "NAME",
        "VERSION_ID",
        "VERSION",
        "VERSION_CODENAME",
        "ID",
        "ID_LIKE",
    ]
    assert report.left_out["os-release lines other than the OS name and version"] == 7
