from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import pytest
from platforms import GB10
from test_capture import (
    a_collector_also_reads,
    capture_of,
    gb10_copy,
    surfaces,
    with_free_text,
    with_gpu_process,
)
from test_capture import hidden_from_guard as j

from sparkline.agent.redact import (
    IN_A_READING,
    CaptureRefused,
    Dir,
    Facts,
    File,
    Leak,
    Link,
    Node,
    Recording,
    Redacted,
    User,
    leaks,
    redact,
)

HOST = "zorbhost"
USER = "quuxuser"
HOME = j("/", "", "home", USER)
MAC = j(":", "4c", "aa", "bb", "cc", "dd", "ee")
BARE_MAC = MAC.replace(":", "")
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


def full_name(gecos: str, *also: Plant) -> Plant:
    def plant(copy: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        (copy / "root/etc/passwd").write_text(f"{USER}:x:1000:1000:{gecos},,,:{HOME}:/bin/bash\n")
        for other in also:
            other(copy, monkeypatch)

    return plant


def mounted_at(point: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        mounts = copy / "root/proc/self/mounts"
        mounts.write_text(mounts.read_text() + f"/dev/sda1 {point} ext4 rw 0 0\n")

    return plant


def bind_mounted_again_at(point: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        mounts = copy / "root/proc/self/mounts"
        mounts.write_text(mounts.read_text() + f"/dev/sda1 /srv ext4 rw 0 0\n/dev/sda1 {point} ext4 rw 0 0\n")
        host = json.loads((copy / "host.json").read_text())
        host["statvfs"]["/srv"] = next(iter(host["statvfs"].values()))
        (copy / "host.json").write_text(json.dumps(host))

    return plant


def cpuinfo_lines(text: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        cpuinfo = copy / "root/proc/cpuinfo"
        cpuinfo.write_text(cpuinfo.read_text() + text)

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
        a_collector_also_reads(monkeypatch, lambda fs: fs.read(path))

    return plant


def a_collector_lists(directory: str, name: str) -> Plant:
    def plant(copy: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        listed = copy / "root" / directory.lstrip("/")
        listed.mkdir(parents=True)
        (listed / name).symlink_to("../../nvme0n1")
        a_collector_also_reads(monkeypatch, lambda fs: fs.listdir(directory))

    return plant


def gpu_name(name: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        nvml = json.loads((copy / "nvml.json").read_text())
        nvml["nvmlDeviceGetName"]['["gpu0"]'] = name
        (copy / "nvml.json").write_text(json.dumps(nvml))

    return plant


def an_address_list_for(interface: str) -> Plant:
    def plant(copy: Path, _: pytest.MonkeyPatch) -> None:
        host = json.loads((copy / "host.json").read_text())
        host["net_if_addrs"][interface] = []
        (copy / "host.json").write_text(json.dumps(host))

    return plant


def blob(inside: bytes) -> bytes:
    return b"\xff\xfe" + inside + b"\x00"


GPU_METRICS = "/sys/class/drm/card0/device/gpu_metrics"
UNKNOWN_IPV6 = j(":", "2a01", "4f8", "abcd", "", "1234")
UNKNOWN_IPV4 = j(".", "10", "20", "30", "41")


NAMES_WITH_MARKS = {
    "Devanagari": "ज़ोरबिना क्वक्सलेकर",
    "Bengali": "জোরবিনা কোয়াক্সলে",
    "Thai": "ซอร์บีนา ควักซ์ลีย์",
    "Hebrew with points": "זוֹרְבִּינָה קְוָוקְסְלִי",
    "Arabic with harakat": "زُورْبِينَا كُوَاكْسْلِي",
    "Yoruba": "Ọ̀zọ̀rbí Kúùxlè",
}


def uuid(head: str) -> str:
    return j("-", head, "1234", "5678", "9abc", j("", "def012", "345670"))


@dataclass(frozen=True)
class Case:
    name: str
    expected: Literal["replaced", "refused"]
    watch: tuple[str, ...]
    text: str = ""
    plant: Plant | None = None
    hostname: str = HOST
    because: str = "not in the reviewed read set"


CASES = [
    Case(
        "hostname inside a node_desc-like string",
        "refused",
        (HOST,),
        f"{HOST} mlx5_0",
        because="hostname",
    ),
    Case("FQDN of this host", "refused", (HOST, "zorbcorp"), f"{HOST}.zorbcorp.example", because="hostname"),
    Case(
        "domain of a dotted hostname, on its own",
        "refused",
        (HOST, "zorbcorp"),
        "mail.zorbcorp.example",
        hostname=f"{HOST}.zorbcorp.example",
        because="domain name",
    ),
    Case(
        "other or old hostname, in node_desc",
        "refused",
        ("oldname-zorb7",),
        plant=a_collector_reads("/sys/class/infiniband/rocep1s0f0/node_desc", b"oldname-zorb7 mlx5_0\n"),
    ),
    Case("home under /home", "replaced", (USER,), f"{HOME}/proj/x"),
    Case("home under /Users", "replaced", (USER,), j("/", "", "Users", USER, "proj")),
    Case("bare user name", "refused", (USER,), f"owner {USER}", because="user"),
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
    Case(
        "NVMe serial, harvested",
        "refused",
        (SERIAL,),
        f"SN={SERIAL}",
        an_nvme_serial,
        because="serial number",
    ),
    Case(
        "NVMe serial, harvested, inside a subsysnqn",
        "refused",
        (SERIAL,),
        f"nqn.2014.08.org.nvmexpress:144d144d{SERIAL} Samsung",
        an_nvme_serial,
        because="serial number",
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
    Case("vfat volume id, lower case", "replaced", ("ab12-34cd",), "UUID=ab12-34cd"),
    Case(
        "domain of a hostname set with a trailing dot",
        "refused",
        ("zorbcorp",),
        "search zorbcorp.example",
        hostname=f"{HOST}.zorbcorp.example.",
        because="domain name",
    ),
    Case(
        "punycode of a non-ASCII hostname",
        "refused",
        ("xn--zrbhost-90a",),
        "xn--zrbhost-90a.example",
        hostname="zörbhost",
        because="hostname",
    ),
    Case(
        "Unicode spelling of a hostname set in its xn-- form",
        "refused",
        ("zörbhost",),
        "zörbhost lab",
        hostname="xn--zrbhost-90a",
        because="hostname",
    ),
    Case(
        "Unicode spelling of an xn-- hostname written decomposed (NFD)",
        "refused",
        ("zörbhost",),
        "zörbhost lab",
        hostname="xn--zrbhost-90a",
        because="hostname",
    ),
    Case(
        "Unicode spelling of an xn-- hostname of eight letters inside a longer word",
        "refused",
        ("zörbhost2",),
        "vm zörbhost2",
        hostname="xn--zrbhost-90a",
        because="hostname",
    ),
    Case(
        "Unicode spelling of an IDNA2008 xn-- hostname with a sharp s",
        "refused",
        ("zorbstraße",),
        "zorbstraße lab",
        hostname="xn--zorbstrae-n1a",
        because="hostname",
    ),
    Case(
        "Unicode spelling of a domain label set in its xn-- form",
        "refused",
        ("zörbcorp",),
        "zörbcorp vpn",
        hostname=f"{HOST}.xn--zrbcorp-90a.example",
        because="domain name",
    ),
    Case(
        "SSSD home under its domain, another user",
        "replaced",
        ("otherquux", "zorbcorp"),
        j("/", "", "home", "zorbcorp.example", "otherquux", "x"),
    ),
    Case(
        "Hugging Face dataset cache path",
        "replaced",
        ("zorb-private", "secretdata"),
        j("--", "/root/.cache/huggingface/hub/datasets", "zorb-private", "secretdata/x"),
    ),
    Case(
        "Hugging Face space cache path",
        "replaced",
        ("zorb-private", "secretspace"),
        j("--", "/root/.cache/huggingface/hub/spaces", "zorb-private", "secretspace/x"),
    ),
    Case(
        "Hugging Face repo id after the hub's address",
        "replaced",
        ("zorb-private", "secretmodel"),
        "https://huggingface.co/zorb-private/secretmodel",
    ),
    Case("NVMe EUI after eui.", "refused", (WWID,), f"eui.{WWID}", because="InfiniBand GUID"),
    Case("Docker id, 64 hex", "replaced", ("c0ffee" + "ab" * 29,), "c0ffee" + "ab" * 29),
    Case("hostname GB10, a word of the GPU name", "refused", ("GB10",), hostname="GB10", because="hostname"),
    Case("hostname acpitz, a sensor name", "refused", ("acpitz",), hostname="acpitz", because="hostname"),
    Case("hostname cpu, a word of reviewed paths", "refused", (), hostname="cpu", because="hostname"),
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
        because="hostname",
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
    Case(
        "hostname on the line after an empty cpuinfo Serial",
        "refused",
        (HOST,),
        plant=cpuinfo_lines(f"Serial\t\t: \nHardware\t: {HOST} board\n"),
        because="hostname",
    ),
    Case(
        "hostname after a carriage return that ends a cpuinfo Serial line",
        "refused",
        (HOST,),
        plant=cpuinfo_lines(f"Serial\t\t: 0000\rHardware\t: {HOST} board\n"),
        because="hostname",
    ),
    Case(
        "hostname in the CPU model after an empty cpuinfo Serial",
        "refused",
        (HOST,),
        plant=cpuinfo_lines(f"Serial\t\t:\nmodel name\t: {HOST} CPU\n"),
        because="hostname",
    ),
    Case(
        "full name from passwd",
        "refused",
        ("Zorbina Quuxley",),
        "owner Zorbina Quuxley",
        full_name("Zorbina Quuxley"),
        because="full name",
    ),
    Case(
        "last name from passwd",
        "refused",
        ("Quuxley",),
        "Quuxley lab",
        full_name("Zorbina Quuxley"),
        because="full name",
    ),
    Case(
        "first name from passwd, in a mount point",
        "refused",
        ("Zorbina",),
        plant=full_name("Zorbina Quuxley", mounted_at("/mnt/Zorbina-backup")),
        because="full name",
    ),
    Case(
        "parent domain of a three-label domain",
        "refused",
        ("zorbcorp.example",),
        "mail.zorbcorp.example",
        hostname=f"{HOST}.lab.zorbcorp.example",
        because="domain name",
    ),
    Case(
        "organization label of the domain, alone",
        "refused",
        ("zorbcorp",),
        "zorbcorp vpn",
        hostname=f"{HOST}.zorbcorp.example",
        because="domain name",
    ),
    Case(
        "organization label of a three-label domain, alone",
        "refused",
        ("zorbcorp",),
        "zorbcorp vpn",
        hostname=f"{HOST}.lab.zorbcorp.example",
        because="domain name",
    ),
    Case(
        "IDNA2008 form of a hostname with a sharp s",
        "refused",
        ("xn--zorbstrae-n1a",),
        "xn--zorbstrae-n1a.example",
        hostname="zorbstraße",
        because="hostname",
    ),
    Case(
        "hostname with - written with _",
        "refused",
        ("zorb_host",),
        "zorb_host",
        hostname="zorb-host",
        because="hostname",
    ),
    Case(
        "hostname of eight letters inside a longer word",
        "refused",
        (f"{HOST}2",),
        f"vm {HOST}2",
        because="hostname",
    ),
    Case(
        "last name after an escaped space in a mount point the agent does not statvfs",
        "refused",
        ("Quuxley",),
        plant=full_name("Zorbina Quuxley", bind_mounted_again_at("/srv/backup\\040Quuxley")),
        because="full name",
    ),
    Case(
        "short hostname after an escaped tab in a mount point the agent does not statvfs",
        "refused",
        ("zorbhst",),
        plant=bind_mounted_again_at("/srv/backup\\011zorbhst"),
        hostname="zorbhst",
        because="hostname",
    ),
    Case(
        "organization under a two-label public suffix",
        "refused",
        ("zorbcorp",),
        "zorbcorp vpn",
        hostname=f"{HOST}.zorbcorp.co.uk",
        because="domain name",
    ),
    Case(
        "three-letter organization under a two-label public suffix",
        "refused",
        ("zrb",),
        "zrb vpn",
        hostname=f"{HOST}.zrb.co.uk",
        because="domain name",
    ),
    *(
        Case(
            f"three-letter organization under {suffix}",
            "refused",
            ("zrb",),
            "zrb vpn",
            hostname=f"{HOST}.cs.zrb.{suffix}",
            because="domain name",
        )
        for suffix in ("edu.cn", "edu.tw", "ac.at", "com.pl")
    ),
    Case(
        "three-letter organization under a Japanese public suffix",
        "refused",
        ("zrb",),
        "zrb vpn",
        hostname=f"{HOST}.zrb.co.jp",
        because="domain name",
    ),
    *(
        Case(
            f"three-letter organization right under {suffix}",
            "refused",
            ("zrb",),
            "zrb vpn",
            hostname=f"{HOST}.zrb.{suffix}",
            because="domain name",
        )
        for suffix in (
            "nhs.uk",
            "me.uk",
            "sch.ae",
            "info.pl",
            "biz.pl",
            "nom.fr",
            "lancs.sch.uk",
            "k12.ca.us",
        )
    ),
    Case(
        "domain that is exactly a registry label under a country code",
        "refused",
        ("org.ch",),
        "see org.ch",
        hostname=f"{HOST}.org.ch",
        because="domain name",
    ),
    Case(
        "domain label with - written with _",
        "refused",
        ("zorb_corp",),
        "zorb_corp vpn",
        hostname=f"{HOST}.zorb-corp.example",
        because="domain name",
    ),
    Case(
        "domain label of eight letters inside a longer word",
        "refused",
        ("zorbcorp",),
        "vpn zorbcorpgw",
        hostname=f"{HOST}.zorbcorp.example",
        because="domain name",
    ),
    Case(
        "tailnet name of a Tailscale hostname",
        "refused",
        ("tail7f3a9c",),
        "tail7f3a9c peer",
        hostname=j(".", HOST, "tail7f3a9c", "ts", "net"),
        because="domain name",
    ),
    Case(
        "site label below the organization",
        "refused",
        ("quuxlab",),
        "quuxlab rack",
        hostname=f"{HOST}.quuxlab.zorbcorp.example",
        because="domain name",
    ),
    Case(
        "part of a hyphenated last name from passwd",
        "refused",
        ("Quuxley",),
        "Quuxley lab",
        full_name("Zorbina Quuxley-Smythe"),
        because="full name",
    ),
    Case(
        "first name of a full name written last name first",
        "refused",
        ("Zorbina",),
        "Zorbina lab",
        full_name("Quuxley, Zorbina"),
        because="full name",
    ),
    Case(
        "accented last name written without its accent",
        "refused",
        ("Quuxlee",),
        "Quuxlee lab",
        full_name("Zorbina Quuxlée"),
        because="full name",
    ),
    Case(
        "IPv4 address after an escaped space in a mount point the agent does not statvfs",
        "refused",
        (UNKNOWN_IPV4,),
        plant=bind_mounted_again_at(f"/srv/nas\\040{UNKNOWN_IPV4}"),
        because="IPv4 address",
    ),
    Case(
        "last name with a letter that has no accent to strip",
        "refused",
        ("Quuxley",),
        "Quuxley lab",
        full_name("Zorbina Quuxłey"),
        because="full name",
    ),
    Case(
        "last name joined to the first name by a dot",
        "refused",
        ("Quuxley",),
        "Quuxley lab",
        full_name("Zorbina.Quuxley"),
        because="full name",
    ),
    Case(
        "nickname in parentheses in the full name",
        "refused",
        ("Zorbie",),
        "Zorbie lab",
        full_name("Zorbina (Zorbie) Quuxley"),
        because="full name",
    ),
    Case(
        "private top-level label named after the organization",
        "refused",
        ("zorbcorp",),
        "zorbcorp vpn",
        hostname=f"{HOST}.ad.zorbcorp",
        because="domain name",
    ),
    Case(
        "work phone number from the comment field, as written",
        "refused",
        ("555-0100",),
        "on call +1-555-0100",
        full_name("Zorbina Quuxley,Room 12,+1-555-0100,555-0199"),
        because="full name",
    ),
    Case(
        "home phone number from the comment field, as digits alone",
        "refused",
        ("5550199",),
        "ext 5550199",
        full_name("Zorbina Quuxley,Room 12,+1-555-0100,555-0199"),
        because="full name",
    ),
    Case(
        "room number of six digits after a word in the comment field",
        "refused",
        ("204117",),
        "bay 204117",
        full_name("Zorbina Quuxley,Room 204117"),
        because="full name",
    ),
    Case(
        "phone number after a word in the comment field, as written",
        "refused",
        ("555-0199",),
        "call +1-555-0199",
        full_name("Zorbina Quuxley,,,,mobile +1-555-0199"),
        because="full name",
    ),
    Case(
        "phone number with an extension in the comment field, as digits alone",
        "refused",
        ("15550100",),
        "ext 15550100",
        full_name("Zorbina Quuxley,,+1 555 0100 x2"),
        because="full name",
    ),
    Case(
        "room number of six digits from the comment field",
        "refused",
        ("204117",),
        "bay 204117",
        full_name("Zorbina Quuxley,204117"),
        because="full name",
    ),
    Case(
        "accented last name in free text written decomposed, as macOS writes names (NFD)",
        "refused",
        ("Quuxle\u0301e", "Quuxlée"),
        "Quuxle\u0301e lab",
        full_name("Zorbina Quuxlée"),
        because="full name",
    ),
    Case(
        "accented last name in the comment field written decomposed (NFD), composed in free text",
        "refused",
        ("Quuxle\u0301e", "Quuxlée"),
        "Quuxlée lab",
        full_name("Zorbina Quuxle\u0301e"),
        because="full name",
    ),
    Case(
        "surname with an accent that has no composed form, written without it",
        "refused",
        ("Quuxeley",),
        "Quuxeley lab",
        full_name("Zorbina Quux\u1eb9\u0300ley"),
        because="full name",
    ),
    *(
        Case(
            f"{part} of a full name in {script} alone in free text",
            "refused",
            (word,),
            f"{word} lab",
            full_name(name),
            because="full name",
        )
        for script, name in NAMES_WITH_MARKS.items()
        for part, word in zip(("given name", "surname"), name.split(), strict=True)
    ),
    *(
        Case(
            f"{part} alone in free text",
            "refused",
            (word,),
            f"{word} lab",
            full_name(name),
            because="full name",
        )
        for part, name, word in (
            ("Greek surname without its tonos", "Ζορμπίνα Κουξλέη", "Κουξλεη"),
            ("Greek surname in capitals, which drop the tonos", "Ζορμπίνα Κουξλέη", "ΚΟΥΞΛΕΗ"),
            ("Cyrillic surname with ё written е", "Зорбина Квуксёлева", "Квукселева"),
            ("Hebrew surname without its points", NAMES_WITH_MARKS["Hebrew with points"], "קווקסלי"),
            ("Arabic surname without its harakat", NAMES_WITH_MARKS["Arabic with harakat"], "كواكسلي"),
            (
                "Armenian surname in capitals, where the ligature և is two letters",
                "Զորբինա Քուքսևյան",
                "ՔՈՒՔՍԵՒՅԱՆ",
            ),
            ("Latin given name in capitals without its accent", "Zorbína Quuxley", "ZORBINA"),
        )
    ),
    *(
        Case(
            f"Turkish given name with İ alone in free text, {spelling}",
            "refused",
            (word,),
            f"{word} lab",
            full_name("İzorbina Quuxley"),
            because="full name",
        )
        for spelling, word in (
            ("as written", "İzorbina"),
            ("written decomposed (NFD), as macOS writes names", "I\u0307zorbina"),
            ("as str.lower writes it, i and a combining dot", "i\u0307zorbina"),
            ("in capitals without the dot", "IZORBINA"),
            ("in Turkish lower case", "izorbina"),
        )
    ),
    Case(
        "dotted MAC after an accented letter",
        "replaced",
        (j(".", "4caa", "bbcc", "ddee"),),
        "é" + j(".", "4caa", "bbcc", "ddee"),
    ),
    Case(
        "Docker bridge name after an accented letter",
        "replaced",
        ("br-5734120003bb",),
        "ébr-5734120003bb up",
    ),
    Case(
        "bare MAC after a backspace in the GPU name, which JSON writes as \\b",
        "refused",
        (BARE_MAC,),
        plant=gpu_name(f"NVIDIA \b{BARE_MAC}"),
        because="MAC address",
    ),
    Case(
        "bare MAC after a form feed in an interface name, which JSON writes as \\f",
        "refused",
        (BARE_MAC,),
        plant=an_address_list_for(f"\f{BARE_MAC}"),
        because="MAC address",
    ),
    Case(
        "bare MAC after a control character in the GPU name, which JSON writes as \\u0001",
        "refused",
        (BARE_MAC,),
        plant=gpu_name(f"NVIDIA \x01{BARE_MAC}"),
        because="MAC address",
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
    if case.text:
        with_free_text(copy, case.text)
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


FACTS = Facts(hostnames=(HOST,), users=(User(USER, HOME),), macs=(MAC,))
ENX = "enx" + MAC.replace(":", "")


def redacted_tree(*nodes: tuple[str, Node]) -> Redacted:
    tree: dict[str, Node] = {"/": Dir()}
    for path, _ in nodes:
        parts = path.split("/")
        tree |= {"/".join(parts[:i]): Dir() for i in range(2, len(parts))}
    tree |= dict(nodes)
    return redact(Recording("linux", {"left_out": {}}, tree, {}, gb10_host()), FACTS)


def written(red: Redacted) -> bytes:
    return b"".join(
        p.encode() + (n.target.encode() if isinstance(n, Link) else n.data if isinstance(n, File) else b"")
        for p, n in red.recording.tree.items()
    )


def test_a_part_of_a_full_name_shorter_than_four_letters_is_not_taken_for_the_name(tmp_path, monkeypatch):
    copy = base_copy(tmp_path, HOST)
    full_name("Zorbina Li")(copy, monkeypatch)
    with_free_text(copy, "li board")
    capture_of(copy, tmp_path / "out")
    assert "li board" in (tmp_path / "out/root/proc/cpuinfo").read_text()


def test_a_number_of_the_comment_field_shorter_than_six_digits_is_not_taken_for_the_name(
    tmp_path, monkeypatch
):
    copy = base_copy(tmp_path, HOST)
    full_name("Zorbina Quuxley,Room 4711,555-0100")(copy, monkeypatch)
    with_free_text(copy, "bay 4711 port 0100")
    capture_of(copy, tmp_path / "out")
    assert "bay 4711 port 0100" in (tmp_path / "out/root/proc/cpuinfo").read_text()


def test_a_domain_label_shorter_than_four_characters_is_not_taken_for_the_name(tmp_path):
    copy = base_copy(tmp_path, f"{HOST}.lab.zorbcorp.example")
    with_free_text(copy, "lab bench")
    capture_of(copy, tmp_path / "out")
    assert "lab bench" in (tmp_path / "out/root/proc/cpuinfo").read_text()


@pytest.mark.parametrize(
    ("domain", "label"),
    [
        ("zorbcorp.co.uk", "co"),
        ("zorbcorp.com.au", "com"),
        ("zorbcorp.co.jp", "co"),
        ("zorbcorp.edu.cn", "edu"),
        (j(".", "tail7f3a9c", "ts", "net"), "ts"),
        ("zrb.nhs.uk", "nhs"),
        ("zrb.lancs.sch.uk", "lancs"),
        ("zrb.lancs.sch.uk", "sch"),
        ("zrb.k12.tx.us", "tx"),
    ],
)
def test_the_labels_of_a_public_suffix_are_not_taken_for_the_name(domain, label, tmp_path):
    copy = base_copy(tmp_path, f"{HOST}.{domain}")
    with_free_text(copy, f"{label} port")
    capture_of(copy, tmp_path / "out")
    assert f"{label} port" in (tmp_path / "out/root/proc/cpuinfo").read_text()


def test_a_hostname_shorter_than_eight_letters_is_not_found_inside_a_longer_word(tmp_path):
    copy = base_copy(tmp_path, "zorbq")
    with_free_text(copy, "vm zorbq2")
    capture_of(copy, tmp_path / "out")
    assert "vm zorbq2" in (tmp_path / "out/root/proc/cpuinfo").read_text()


def test_a_domain_label_shorter_than_eight_letters_is_not_found_inside_a_longer_word(tmp_path):
    copy = base_copy(tmp_path, f"{HOST}.quuxlab.example")
    with_free_text(copy, "rack quuxlabs")
    capture_of(copy, tmp_path / "out")
    assert "rack quuxlabs" in (tmp_path / "out/root/proc/cpuinfo").read_text()


def test_a_mac_in_an_interface_name_is_replaced_in_the_path_and_the_link_target():
    red = redacted_tree(
        (f"/sys/class/net/{ENX}", Link(f"../../devices/virtual/net/{ENX}")),
        (f"/sys/devices/virtual/net/{ENX}/operstate", File(b"up\n")),
    )
    assert leaks(red) == []
    assert MAC.replace(":", "").encode() not in written(red).lower()


def test_a_hostname_in_an_interface_name_refuses_as_a_word_of_what_the_agent_reads():
    red = redacted_tree(
        (f"/sys/class/net/{HOST}-br", Link(f"../../devices/virtual/net/{HOST}-br")),
        (f"/sys/devices/virtual/net/{HOST}-br/operstate", File(b"up\n")),
    )
    assert red.collisions == [Leak(IN_A_READING, "hostname")]


def test_the_final_check_passes_a_name_only_in_a_fixed_word_and_refuses_it_anywhere_else():
    facts = Facts(hostnames=("dev",), users=(User("pytorch", j("/", "", "home", "pytorch")),))
    mounts = b"/dev/nvme0n1p2 / ext4 rw 0 0\n"
    tree: dict[str, Node] = {
        "/": Dir(),
        "/proc": Dir(),
        "/proc/self": Dir(),
        "/proc/self/mounts": File(mounts),
        "/proc/self/net": Dir(),
        "/proc/self/net/dev": File(b"Inter-|\n"),
    }
    red = redact(Recording("linux", {"left_out": {}}, tree, {}, gb10_host()), facts)
    assert red.collisions == []
    assert red.recording.tree["/proc/self/mounts"] == File(mounts)
    assert "/proc/self/net/dev" in red.recording.tree
    assert leaks(red) == []
    red.recording.tree["/proc/self/mounts"] = File(b"/dev/nvme0n1p2 /mnt/dev ext4 rw 0 0\n")
    red.recording.host["which"]["nvidia-smi"] = "/opt/pytorch/nvidia-smi"
    assert {"hostname", "user"} <= {leak.category for leak in leaks(red)}


def test_a_fixed_word_in_a_key_is_kept_by_the_rewrite_as_the_name_check_keeps_it():
    host = gb10_host()
    host["docker"]["/images/json"] = {"result": {"RepoTags": {"nvcr.io/nvidia/pytorch:26.07-py3": 1}}}
    tree: dict[str, Node] = {"/": Dir()}
    red = redact(Recording("linux", {"left_out": {}}, tree, {}, host), Facts(hostnames=("pytorch",)))
    assert red.collisions == []
    assert red.recording.host["docker"]["/images/json"]["result"]["RepoTags"] == {
        "nvcr.io/nvidia/pytorch:26.07-py3": 1
    }
    assert leaks(red) == []


def test_a_link_into_a_home_directory_is_refused_without_showing_it():
    red = redacted_tree(
        ("/sys/class/net/eth0", Link("../../devices/virtual/net/eth0")),
        ("/sys/devices/virtual/net/eth0/operstate", File(b"up\n")),
        ("/sys/class/net/eth9", Link(f"../..{HOME}/x")),
    )
    found = leaks(red)
    assert Leak("root/sys/class/net/*", "not in the reviewed read set") in found
    assert [leak for leak in found if USER in leak.surface] == []


def test_os_release_keeps_only_the_line_the_agent_reads(tmp_path):
    report = capture_of(with_os_release_line(gb10_copy(tmp_path), "X_OWNER=someone"), tmp_path / "out")
    kept = (tmp_path / "out/root/usr/lib/os-release").read_text().splitlines()
    assert kept == ['PRETTY_NAME="Ubuntu 24.04.5 LTS"']
    assert report.left_out["os-release lines other than PRETTY_NAME"] == 13


def test_a_tool_found_outside_the_system_directories_is_recorded_without_its_directory(tmp_path):
    copy = gb10_copy(tmp_path)
    host = json.loads((copy / "host.json").read_text())
    host["which"] |= {
        "fio": "/opt/zorbcorp-internal/bin/fio",
        "nvcc": j("/", "", "home", USER, "acme-nda-project", "bin", "nvcc"),
    }
    (copy / "host.json").write_text(json.dumps(host))
    report = capture_of(copy, tmp_path / "out")
    assert report.differences == []
    assert json.loads((tmp_path / "out/host.json").read_text())["which"] == {
        "all_reduce_perf": None,
        "docker": "/usr/bin/docker",
        "fio": "<elsewhere>/fio",
        "ib_write_bw": "/usr/bin/ib_write_bw",
        "nvcc": "<elsewhere>/nvcc",
    }


def test_a_mount_line_keeps_a_disk_source_its_mount_point_and_type_and_drops_the_rest(tmp_path):
    copy = gb10_copy(tmp_path)
    mounts = copy / "root/proc/self/mounts"
    mounts.write_text(
        mounts.read_text()
        + "/dev/mapper/zorbcorp--vg-data /data ext4 rw,relatime,x-gvfs-name=zorbcorp 0 0\n"
        + "tank/zorbcorp-nda /tank zfs ro,xattr,context=zorbcorp 0 0\n"
        + "/dev/mapper/zorbcorp--vg-data /data/again ext4 rw,nosuid 0 0\n"
    )
    report = capture_of(copy, tmp_path / "out")
    assert report.differences == []
    kept = (tmp_path / "out/root/proc/self/mounts").read_text().splitlines()
    assert kept == [
        "/dev/nvme0n1p2 / ext4 rw 0 0",
        "<source1> /data ext4 rw 0 0",
        "<source2> /tank zfs ro 0 0",
        "<source1> /data/again ext4 rw 0 0",
    ]
