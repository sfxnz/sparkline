from __future__ import annotations

import json
import posixpath
import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from ipaddress import IPv4Address, IPv6Address, IPv6Network
from typing import Any, Literal

from ..common.identifiers import CAPTURE, PUBLIC_HF_ORGS, Detector, scan, text_of
from .collectors.procs import container_id
from .collectors.storage import REAL_FS
from .readset import (
    DOCKER_APIS,
    HOST_READINGS,
    NVML_CALLS,
    admits,
    fixed_parts,
    matching,
    parts_a_bare_star_matches,
)


@dataclass(frozen=True)
class File:
    data: bytes


@dataclass(frozen=True)
class Dir:
    pass


@dataclass(frozen=True)
class Link:
    target: str


Node = File | Dir | Link


@dataclass
class Recording:
    platform: str
    meta: dict[str, Any]
    tree: dict[str, Node]
    nvml: dict[str, dict[str, Any]]
    host: dict[str, Any]


@dataclass(frozen=True)
class User:
    name: str
    home: str
    gecos: str = ""


@dataclass(frozen=True)
class Facts:
    hostnames: tuple[str, ...] = ()
    users: tuple[User, ...] = ()
    machine_ids: tuple[str, ...] = ()
    serials: tuple[str, ...] = ()
    uuids: tuple[str, ...] = ()
    guids: tuple[str, ...] = ()
    macs: tuple[str, ...] = ()


@dataclass(frozen=True)
class Leak:
    surface: str
    category: str


class CaptureRefused(Exception):
    def __init__(self, found: list[Leak], advice: str = "") -> None:
        self.leaks = found
        lines = [f"  {leak.surface}: {leak.category}" for leak in found]
        super().__init__(
            "The capture was refused and nothing was written. It cannot record these places safely "
            "(values are not shown):\n" + "\n".join(lines) + (f"\n{advice}" if advice else "")
        )


IN_A_READING = "a word in what the agent reads"
RENAME = (
    "A name of this machine is also an ordinary word in what the agent reads, so replacing the name "
    "would change a reading and show the name. Give that name another value for the run, then capture "
    "again. For the hostname, run sudo hostname sparkline-capture and set it back after. For a Docker "
    "container, run docker rename. For a user name, capture from another account. For the full name of an "
    "account, run sudo chfn -f '' <account> and set it back after. Before you attach, "
    "search the recording for the old name, for example with grep -ri, and read the mount points in "
    "root/proc/self/mounts and the statvfs keys in host.json. Or open an issue and paste these lines."
)


NGC_PYTORCH = "nvcr.io/nvidia/pytorch:"
NGC_TAG = re.compile(r"\d{2}\.\d{2}-py3(?:-igpu)?")
SERIAL_FILES = {
    "serial",
    "serial_number",
    "unique_id",
    "product_serial",
    "board_serial",
    "chassis_serial",
    "serial-number",
}
GENERIC_NAMES = {
    "root",
    "admin",
    "user",
    "ubuntu",
    "debian",
    "nvidia",
    "pi",
    "localhost",
    "dgx",
    "spark",
    "local",
    "localdomain",
    "lan",
    "home.arpa",
    "home",
    "sparkline-capture",
}
OS_RELEASE = ("/etc/os-release", "/usr/lib/os-release")
OS_RELEASE_KEYS = {"PRETTY_NAME"}
SYSTEM_BIN = {"/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/usr/local/sbin", "/snap/bin"}
ELSEWHERE = "<elsewhere>"
DISK = re.compile(r"/dev/(?:nvme\d+n\d+(?:p\d+)?|(?:sd|vd|xvd|hd)[a-z]+\d*|mmcblk\d+(?:p\d+)?|md\d+|dm-\d+)")
LONG_NAME = 8
NAME_PART = 4

_HEX = "[0-9A-Fa-f]"
Form = Literal["hex", "name", "host", "anywhere", "ipv4", "ipv6", "path"]
_WORDS: set[Form] = {"name", "host", "anywhere"}
_UUID = re.compile(rf"(?<!{_HEX}){_HEX}{{8}}(?:-{_HEX}{{4}}){{3}}-{_HEX}{{12}}(?!{_HEX})")
_UUID_PLACEHOLDER = "00000000-0000-0000-0000-0000"
_PID = re.compile(r"/proc/\d+/(cmdline|cgroup)")
_LINK_LOCAL = IPv6Network("fe80::/10")
_IPV4_COMPATIBLE = IPv6Network("::/96")
_IPV4_POOL = [f"198.51.100.{i}" for i in range(1, 255)] + [
    f"{net}.{i}" for net in ("203.0.113", "192.0.2") for i in range(1, 255)
]

_WORD_START = r"(?:(?<![A-Za-z0-9])|(?<=\\[0-7]{3}))"
_NOT_ADJACENT: dict[Form, tuple[str, str]] = {
    "hex": (rf"(?<!{_HEX})", rf"(?!{_HEX})"),
    "name": (_WORD_START, r"(?![A-Za-z0-9])"),
    "host": (_WORD_START, r"(?:\.[A-Za-z][A-Za-z0-9-]*)*(?![A-Za-z0-9])"),
    "anywhere": ("", ""),
    "ipv4": (r"(?<![\d.])", r"(?!\d|\.\d)"),
    "ipv6": (r"(?<![0-9A-Fa-f:])", r"(?![0-9A-Fa-f:])"),
    "path": (r"(?<![\w.])", r"(?![\w.-])"),
}
_NAME_PLACEHOLDER = re.compile(r"(?:host|user|person|serial|container|domain)\d+|<(?:org|model)\d+>")
_NAME_FORMATS = {
    "hostname": "host{}",
    "user": "user{}",
    "full name": "person{}",
    "serial number": "serial{}",
    "container name": "container{}",
    "domain name": "domain{}",
    "Hugging Face org": "<org{}>",
    "Hugging Face model": "<model{}>",
}
_CASE_KEPT = {"Hugging Face org", "Hugging Face model"}


def dumps(doc: Any) -> str:
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


@dataclass(frozen=True)
class Spelling:
    form: Form
    original: str
    placeholder: str
    category: str


Spans = Sequence[tuple[int, int]]
Where = tuple[str, ...]
Fixed = Callable[[Where, str], list[tuple[int, int]]]


def _within(m: re.Match[str], spans: Spans) -> bool:
    return any(start <= m.start() and m.end() <= end for start, end in spans)


class Spellings:
    def __init__(self, spellings: Iterable[Spelling]) -> None:
        unique: dict[tuple[str, str], Spelling] = {}
        for s in spellings:
            key = s.original.lower() if s.form in _WORDS else s.original
            if s.original != s.placeholder:
                unique.setdefault((s.form, key), s)
        self._items = sorted(unique.values(), key=lambda s: -len(s.original))
        alternatives = []
        for s in self._items:
            lead, trail = _NOT_ADJACENT[s.form]
            body = f"(?i:{re.escape(s.original)})" if s.form in _WORDS else re.escape(s.original)
            alternatives.append(f"({lead}{body}{trail})")
        self._rx = re.compile("|".join(alternatives)) if alternatives else None

    def _spelling(self, m: re.Match[str]) -> Spelling:
        assert m.lastindex is not None
        return self._items[m.lastindex - 1]

    def sub(self, text: str, keep: Spans = ()) -> str:
        if self._rx is None:
            return text
        return self._rx.sub(lambda m: m[0] if _within(m, keep) else self._spelling(m).placeholder, text)

    def categories_in(self, text: str) -> set[str]:
        return {self._spelling(m).category for m in self._rx.finditer(text)} if self._rx else set()

    def names_in(self, text: str) -> set[str]:
        found = (self._spelling(m) for m in self._rx.finditer(text)) if self._rx else ()
        return {s.category for s in found if s.form in _WORDS}

    def outside(self, text: str, slots: Spans) -> set[str]:
        found = self._rx.finditer(text) if self._rx else ()
        return {self._spelling(m).category for m in found if not _within(m, slots)}

    def categories_in_bytes(self, data: bytes) -> set[str]:
        low = data.lower()
        return {s.category for s in self._items if s.original.lower().encode() in low}


def _mac_forms(b: bytes) -> list[str]:
    forms = [":".join(f"{x:02x}" for x in b), "-".join(f"{x:02x}" for x in b), b.hex()]
    return forms + [f.upper() for f in forms]


def _guid_spellings(b: bytes) -> list[str]:
    forms = []
    for order in (b, b[::-1]):
        h = order.hex()
        forms += [":".join(h[i : i + 4] for i in range(0, 16, 4)), h]
    return forms + [f.upper() for f in forms]


def _guid_as_sysfs_writes_it(b: bytes) -> list[str]:
    return [":".join(b.hex()[i : i + 4] for i in range(0, 16, 4)), b.hex(), b[::-1].hex()]


def _ipv4_forms(a: IPv4Address) -> list[str]:
    return [
        str(a),
        a.packed.hex(),
        a.packed[::-1].hex(),
        a.packed.hex().upper(),
        a.packed[::-1].hex().upper(),
    ]


def _compress(groups: list[str]) -> str:
    best, size = -1, 1
    i = 0
    while i < len(groups):
        j = i
        while j < len(groups) and groups[j] == "0":
            j += 1
        if j - i > size:
            best, size = i, j - i
        i = max(j, i + 1)
    if best < 0:
        return ":".join(groups)
    return ":".join(groups[:best]) + "::" + ":".join(groups[best + size :])


def _spell6(a: IPv6Address, like: str) -> str:
    groups = [f"{int.from_bytes(a.packed[i : i + 2]):x}" for i in range(0, 16, 2)]
    if "::" not in like and like.count(":") == 7:
        text = ":".join(g.zfill(4) for g in groups)
    elif "." in like:
        head = _compress(groups[:6])
        text = head + ("" if head.endswith(":") else ":") + str(IPv4Address(a.packed[12:]))
    else:
        text = _compress(groups)
    return text.upper() if re.search("[A-F]", like) else text


def _ipv6_forms(a: IPv6Address) -> list[str]:
    forms = [_spell6(a, "::"), _spell6(a, "0:0:0:0:0:0:0:0")]
    return forms + [f.upper() for f in forms]


def _flagged(spelling: str) -> bool:
    return bool(scan(spelling, GATE))


def _flagged_as_an_identifier(spelling: str) -> bool:
    return bool(scan(spelling, CAPTURE))


def _colon_mac(m: re.Match[str]) -> str:
    h = m[1] + m[2] + m[3]
    return ":".join(h[i : i + 2] for i in range(0, 12, 2))


HEX32 = Detector(
    "32-digit hex id",
    re.compile(rf"(?<!{_HEX}){_HEX}{{32}}(?!{_HEX})"),
    lambda m: not _flagged_as_an_identifier(str(IPv6Address(bytes.fromhex(m[0])))),
)
HEX64 = Detector(
    "container id",
    re.compile(rf"(?<!{_HEX}){_HEX}{{64}}(?!{_HEX})"),
    lambda m: m[0].lower().endswith("0" * 52),
)
HOME_WITH_DOMAIN = Detector(
    "home directory", re.compile(r"(?<![\w.])/(home|Users)/(<?[\w.-]+>?)@[\w.-]+"), lambda m: False
)
MEDIA = Detector("home directory", re.compile(r"(?<![\w.])(/(?:run/)?media)/([\w.-]+)"), lambda m: False)
HOME_UNDER_DOMAIN = Detector(
    "home directory",
    re.compile(r"(?<![\w.])/home/((?:[\w-]+\.)+[\w-]+|domain\d+)/(<?[\w.-]+>?)"),
    lambda m: False,
)
HF_MODEL = Detector(
    "Hugging Face cache path",
    re.compile(r"(models|datasets|spaces)--([\w.-]+?)--([\w.-]+)"),
    lambda m: m[2] in PUBLIC_HF_ORGS,
)
HF_REPO = Detector(
    "Hugging Face repo",
    re.compile(r"(?<![\w.-])(?:huggingface\.co|hf\.co)/((?:datasets/|spaces/)?)([\w.-]+)/([\w.-]+)"),
    lambda m: m[2] in PUBLIC_HF_ORGS,
)
DOTTED_MAC = Detector(
    "MAC address",
    re.compile(rf"(?<![\w:.-])({_HEX}{{4}})\.({_HEX}{{4}})\.({_HEX}{{4}})(?![\w:-]|\.\w)"),
    lambda m: not _flagged_as_an_identifier(_colon_mac(m)),
)
BRIDGE = Detector(
    "virtual interface name",
    re.compile(r"(?<![\w-])br-([0-9a-f]{12})(?![\w-])"),
    lambda m: m[1].startswith("0" * 8),
)
VETH = Detector(
    "virtual interface name",
    re.compile(r"(?<![\w-])veth([0-9a-f]{7})(?![\w-])"),
    lambda m: m[1].startswith("000"),
)
VOLUME_ID = Detector(
    "volume id",
    re.compile(r"(?<![\w-])(?:([0-9A-F]{4})-[0-9A-F]{4}|([0-9a-f]{4})-[0-9a-f]{4})(?![\w-])"),
    lambda m: (m[1] or m[2]) == "0000",
)
ROUTE_TABLES = ("/proc/net/route", "/proc/self/net/route")
ROUTE_ADDRESS_COLUMNS = (1, 2, 7)
_HEX_IPV4 = next(d for d in CAPTURE if d.category == "IPv4 address (hex)")
DECIMAL_IS_A_COUNTER = Detector(
    _HEX_IPV4.category, _HEX_IPV4.pattern, lambda m: m[0].isdigit() or _HEX_IPV4.ok(m)
)
GATE = [
    *(DECIMAL_IS_A_COUNTER if d is _HEX_IPV4 else d for d in CAPTURE),
    HEX32,
    HEX64,
    HOME_UNDER_DOMAIN,
    HOME_WITH_DOMAIN,
    MEDIA,
    HF_MODEL,
    HF_REPO,
    DOTTED_MAC,
    BRIDGE,
    VETH,
    VOLUME_ID,
]


def _route_addresses(text: str) -> str:
    rows = [line.split() for line in text.splitlines()[1:]]
    return "\n".join(" ".join(row[i] for i in ROUTE_ADDRESS_COLUMNS if i < len(row)) for row in rows)


class Placeholders:
    def __init__(self, lowered_surfaces: str) -> None:
        self._lowered_surfaces = lowered_surfaces
        self._table: dict[str, dict[str, str]] = {}
        self._next: dict[str, int] = {}
        self.counts: Counter[str] = Counter()

    def _take(
        self,
        category: str,
        key: str,
        make: Callable[[int], str | None],
        forms: Callable[[str], list[str]] = lambda s: [s],
        counter: str | None = None,
    ) -> str:
        table = self._table.setdefault(category, {})
        if key in table:
            return table[key]
        counter = counter or category
        n = self._next.get(counter, 0)
        while True:
            n += 1
            candidate = make(n)
            if candidate is None:
                raise CaptureRefused([Leak("this machine", f"more {category} values than placeholders")])
            spelled = forms(candidate)
            if not any(_flagged(s) or s.lower() in self._lowered_surfaces for s in spelled):
                break
        self._next[counter] = n
        table[key] = candidate
        self.counts[category] += 1
        return candidate

    def ipv4(self, a: IPv4Address) -> IPv4Address:
        if not _flagged(str(a)):
            return a
        pool = _IPV4_POOL
        got = self._take(
            "IPv4 address",
            str(a),
            lambda n: pool[n - 1] if n <= len(pool) else None,
            lambda s: _ipv4_forms(IPv4Address(s)),
        )
        return IPv4Address(got)

    def mac(self, b: bytes) -> bytes:
        if not _flagged(":".join(f"{x:02x}" for x in b)) and not _flagged(b.hex()):
            return b
        got = self._take(
            "MAC address",
            b.hex(),
            lambda n: f"020000{n:06x}" if n < 1 << 24 else None,
            lambda s: _mac_forms(bytes.fromhex(s)),
        )
        return bytes.fromhex(got)

    def guid(self, b: bytes) -> bytes:
        if not any(_flagged(f) for f in _guid_as_sysfs_writes_it(b)):
            return b
        got = self._take(
            "InfiniBand GUID",
            b.hex(),
            lambda n: f"020000000000{n:04x}" if n < 1 << 16 else None,
            lambda s: _guid_as_sysfs_writes_it(bytes.fromhex(s)),
        )
        return bytes.fromhex(got)

    def ipv6(self, a: IPv6Address) -> IPv6Address:
        if not _flagged(str(a)):
            return a
        if a.ipv4_mapped:
            return IPv6Address(b"\0" * 10 + b"\xff\xff" + self.ipv4(a.ipv4_mapped).packed)
        if a in _IPV4_COMPATIBLE:
            return IPv6Address(b"\0" * 12 + self.ipv4(IPv4Address(a.packed[12:])).packed)
        if a in _LINK_LOCAL:
            iid = a.packed[8:]
            if iid[3:5] == b"\xff\xfe":  # modified EUI-64: the interface's MAC with its U/L bit flipped
                mac = self.mac(bytes([iid[0] ^ 2]) + iid[1:3] + iid[5:])
                return IPv6Address(
                    b"\xfe\x80" + b"\0" * 6 + bytes([mac[0] ^ 2]) + mac[1:3] + b"\xff\xfe" + mac[3:]
                )
            got = self._take(
                "IPv6 address",
                str(a),
                lambda n: f"fe80::200:0:0:{n:x}" if n < 1 << 16 else None,
                counter="ll",
            )
            return IPv6Address(got)
        return IPv6Address(self._take("IPv6 address", str(a), lambda n: f"2001:db8::{n:x}"))

    def gpu_uuid(self, text: str) -> str:
        if not _flagged(text):
            return text
        return self._take("GPU UUID", text.lower()[4:], lambda n: f"GPU-{_UUID_PLACEHOLDER}{n:08x}")

    def uuid(self, text: str) -> str:
        if text.lower().startswith(_UUID_PLACEHOLDER):
            return text
        return self._take("UUID", text.lower(), lambda n: f"{_UUID_PLACEHOLDER}{n:08x}")

    def machine_id(self, text: str) -> str:
        if re.fullmatch("0{24}[0-9a-f]{8}", text.lower()):
            return text
        return self._take("machine-id", text.lower(), lambda n: f"{n:032x}")

    def container_id(self, cid: str) -> str:
        if cid.endswith("0" * 52):
            return cid
        return self._take("container id", cid, lambda n: f"{n:012x}" + "0" * 52)

    def virtual_interface(self, name: str) -> str:
        prefix, digits = ("br-", 12) if name.startswith("br-") else ("veth", 7)
        return self._take(
            "virtual interface name",
            name,
            lambda n: f"{prefix}{n:0{digits}x}" if n < 1 << 16 else None,
            counter=prefix,
        )

    def volume_id(self, text: str) -> str:
        return self._take("volume id", text, lambda n: f"0000-{n:04X}" if n < 1 << 16 else None)

    def name(self, category: str, value: str) -> str:
        if _NAME_PLACEHOLDER.fullmatch(value):
            return value
        key = value if category in _CASE_KEPT else value.lower()
        return self._take(category, key, _NAME_FORMATS[category].format)


@dataclass(frozen=True)
class Redacted:
    recording: Recording
    counts: dict[str, int]
    left_out: dict[str, int]
    originals: Spellings
    read_at: dict[str, str]
    collisions: list[Leak]
    rewrite: Callable[[str], str] = field(repr=False)

    def printable(self, line: str) -> str | None:
        return None if self.rewrite(line) != line or _categories(line, False, self.originals) else line


def _text(node: Node | None) -> str | None:
    if not isinstance(node, File):
        return None
    try:
        return node.data.decode()
    except UnicodeDecodeError:
        return None


def _minimize(rec: Recording) -> tuple[Recording, Counter[str]]:
    tree = dict(rec.tree)
    left: Counter[str] = Counter()
    mounts = _text(tree.get("/proc/self/mounts"))
    if mounts is not None:
        lines = mounts.splitlines()
        kept: list[str] = []
        sources: dict[str, str] = {}
        for f in (line.split() for line in lines):
            if len(f) < 3 or f[2] not in REAL_FS:
                continue
            source = f[0] if DISK.fullmatch(f[0]) else sources.setdefault(f[0], f"<source{len(sources) + 1}>")
            options = "ro" if "ro" in (f[3] if len(f) > 3 else "").split(",") else "rw"
            left["mount options other than rw or ro"] += len(f) > 3 and f[3] != options
            kept.append(f"{source} {f[1]} {f[2]} {options} 0 0\n")
        left["mount lines of other filesystems"] += len(lines) - len(kept)
        left["mount sources that are not a disk"] += len(sources)
        tree["/proc/self/mounts"] = File("".join(kept).encode())
    for path in OS_RELEASE:
        text = _text(tree.get(path))
        if text is None:
            continue
        lines = [line for line in text.splitlines(keepends=True) if line.strip()]
        kept = [line for line in lines if line.partition("=")[0].strip() in OS_RELEASE_KEYS]
        left["os-release lines other than PRETTY_NAME"] += len(lines) - len(kept)
        tree[path] = File("".join(kept).encode())
    cids: set[str] = set()
    for path, node in list(tree.items()):
        m = _PID.fullmatch(path)
        if m is None or not isinstance(node, File):
            continue
        text = node.data.decode(errors="surrogateescape")
        if m[1] == "cmdline":
            argv = text.split("\0")
            words = argv[0].split()
            left["command-line arguments"] += len(words[1:]) + len([a for a in argv[1:] if a])
            program = posixpath.basename(words[0]) if words else ""
            tree[path] = File(f"{program}\0".encode(errors="surrogateescape") if program else b"")
        else:
            cid = container_id(text)
            if cid:
                cids.add(cid)
            tree[path] = File(f"0::/docker/{cid}\n".encode() if cid else b"0::/\n")
    docker: dict[str, Any] = {}
    for api, entry in rec.host["docker"].items():
        result = entry.get("result")
        if "error" in entry:
            docker[api] = {"error": str(entry["error"])}
        elif api == "/images/json" and isinstance(result, list):
            images = [
                {"RepoTags": tags}
                for img in result
                if (tags := [_ngc_pytorch(t) for t in img.get("RepoTags") or [] if t.startswith(NGC_PYTORCH)])
            ]
            left["Docker images other than NGC PyTorch"] += len(result) - len(images)
            docker[api] = {"result": images}
        elif api == "/containers/json" and isinstance(result, list):
            kept_containers = [
                {k: c[k] for k in ("Id", "Names") if k in c} for c in result if c.get("Id") in cids
            ]
            left["Docker containers no recorded process runs in"] += len(result) - len(kept_containers)
            docker[api] = {"result": kept_containers}
        else:
            docker[api] = entry
    which: dict[str, str | None] = {}
    for name, found in rec.host["which"].items():
        which[name] = (
            found if found is None or posixpath.dirname(found) in SYSTEM_BIN else f"{ELSEWHERE}/{name}"
        )
        left["directories of tools found outside the system directories"] += which[name] != found
    host = {**rec.host, "docker": docker, "which": which}
    return Recording(rec.platform, dict(rec.meta), tree, rec.nvml, host), +left


def _ngc_pytorch(tag: str) -> str:
    return tag if NGC_TAG.fullmatch(tag.removeprefix(NGC_PYTORCH)) else f"{NGC_PYTORCH}<tag>"


def _strings(doc: Any) -> Iterable[str]:
    if isinstance(doc, str):
        yield doc
    elif isinstance(doc, dict):
        for k, v in doc.items():
            yield str(k)
            yield from _strings(v)
    elif isinstance(doc, list):
        for v in doc:
            yield from _strings(v)


def _surfaces(rec: Recording) -> Iterable[str]:
    for path, node in rec.tree.items():
        yield path
        if isinstance(node, Link):
            yield node.target
        elif isinstance(node, File):
            yield text_of(node.data)[0]
    for doc in (rec.nvml, rec.host, rec.meta):
        yield from _strings(doc)


def _mac_of(text: str) -> bytes | None:
    h = re.sub("[:-]", "", text.strip())
    return bytes.fromhex(h) if re.fullmatch(f"{_HEX}{{12}}", h) else None


def _guid_of(text: str) -> bytes | None:
    h = text.strip()
    if re.fullmatch(rf"{_HEX}{{4}}(?::{_HEX}{{4}}){{3}}", h):
        return bytes.fromhex(h.replace(":", ""))
    if re.fullmatch(f"(?:0x)?{_HEX}{{16}}", h):
        return bytes.fromhex(h.removeprefix("0x"))[::-1]  # sysfs prints these as a little-endian integer
    return None


class _Harvest:
    def __init__(self, ph: Placeholders) -> None:
        self.ph = ph
        self.spellings: list[Spelling] = []

    def _pairs(self, form: Form, originals: list[str], placeholders: list[str], category: str) -> None:
        self.spellings += [
            Spelling(form, o, p, category) for o, p in zip(originals, placeholders, strict=True)
        ]

    def mac(self, b: bytes | None) -> None:
        if b is not None and len(b) == 6:
            self._pairs("hex", _mac_forms(b), _mac_forms(self.ph.mac(b)), "MAC address")

    def guid(self, b: bytes | None) -> None:
        if b is not None:
            self._pairs("hex", _guid_spellings(b), _guid_spellings(self.ph.guid(b)), "InfiniBand GUID")

    def ipv4(self, a: IPv4Address) -> None:
        o, p = _ipv4_forms(a), _ipv4_forms(self.ph.ipv4(a))
        self._pairs("ipv4", o[:1], p[:1], "IPv4 address")
        self._pairs("hex", o[1:], p[1:], "IPv4 address")

    def ip(self, text: str) -> None:
        address = text.split("%")[0]
        if ":" in address:
            try:
                a6 = IPv6Address(address)
            except ValueError:
                return
            self._pairs("ipv6", _ipv6_forms(a6), _ipv6_forms(self.ph.ipv6(a6)), "IPv6 address")
            self._pairs("ipv6", [address], [_spell6(self.ph.ipv6(a6), address)], "IPv6 address")
        else:
            try:
                self.ipv4(IPv4Address(address))
            except ValueError:
                return

    def name(self, category: str, value: str) -> None:
        value = value.strip().rstrip(".") if category == "hostname" else value.strip()
        if category == "hostname" and "." in value:
            value, _, domain = value.partition(".")
            for name in _domain_names(domain):
                self.name("domain name", name)
        if not value or value.lower() in GENERIC_NAMES:
            return
        if category == "serial number" and (len(value) < 3 or len(set(value)) == 1):
            return
        placeholder = self.ph.name(category, value)
        form: Form = "name"
        if category == "hostname":
            form = "host"
        elif category == "serial number" and len(value) >= LONG_NAME:
            form = "anywhere"
        self._pairs(form, [value], [placeholder], category)
        if category == "hostname" and len(value) >= LONG_NAME:
            self._pairs("anywhere", [value], [placeholder], category)
        if not value.isascii():
            forms = _idna_forms(value)
            self._pairs(form, forms, [placeholder] * len(forms), category)
        if category == "hostname" and "-" in value:
            self._pairs(form, [value.replace("-", "--")], [placeholder.replace("-", "--")], category)
            self._pairs(form, [value.replace("-", "_")], [placeholder], category)

    def hexes(self, category: str, values: list[str], placeholders: list[str]) -> None:
        self._pairs("hex", values, placeholders, category)


def _domain_names(domain: str) -> list[str]:
    labels = domain.split(".")
    parents = [".".join(labels[i:]) for i in range(max(len(labels) - 1, 1))]
    return parents + labels[-2:-1] + [label for label in labels[:-1] if len(label) >= NAME_PART]


def _idna_forms(value: str) -> list[str]:
    forms = []
    with suppress(UnicodeError):
        forms.append(value.encode("idna").decode())
    with suppress(UnicodeError):
        forms.append(
            ".".join(
                label
                if label.isascii()
                else "xn--" + unicodedata.normalize("NFC", label.lower()).encode("punycode").decode()
                for label in value.split(".")
            )
        )
    return forms


def _full_name_spellings(user: User) -> list[str]:
    full_name = user.gecos.split(",")[0].strip()
    whole = [full_name] if len(full_name.split()) > 1 else []
    parts = [
        p for p in re.split(r"[\s,@-]+", user.gecos) if len(p) >= NAME_PART and re.search(r"[^\W\d_]", p)
    ]
    names = [n for n in whole + parts if n.lower() != user.name.lower()]
    return names + [a for n in names if (a := _ascii(n)) != n and len(a) >= NAME_PART]


def _ascii(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def _harvest(rec: Recording, facts: Facts, ph: Placeholders) -> list[Spelling]:
    h = _Harvest(ph)
    tree = rec.tree
    for name in [_text(tree.get("/proc/sys/kernel/hostname")) or "", *facts.hostnames]:
        h.name("hostname", name)
    for user in facts.users:
        h.name("user", user.name)
        if user.home.count("/") >= 2 and not _NAME_PLACEHOLDER.search(user.home):
            top = "/Users/" if user.home.startswith("/Users/") else "/home/"
            placeholder = f"{top}<{ph.name('user', user.name)}>"
            h.spellings.append(Spelling("path", user.home.rstrip("/"), placeholder, "home directory"))
        for name in _full_name_spellings(user):
            h.name("full name", name)
    addrs = rec.host["net_if_addrs"]
    for entries in addrs.values():
        for a in entries:
            if a["family"] == "AF_LINK":
                h.mac(_mac_of(a["address"] or ""))
    for path, node in tree.items():
        if posixpath.basename(path) == "address" and "/net/" in path:
            h.mac(_mac_of(_text(node) or ""))
    for mac in facts.macs:
        h.mac(_mac_of(mac))
    for entries in addrs.values():
        for a in entries:
            if a["family"] in ("AF_INET", "AF_INET6") and a["address"]:
                h.ip(a["address"])
    for route in ("/proc/net/route", "/proc/self/net/route"):
        for line in (_text(tree.get(route)) or "").splitlines()[1:]:
            for column in line.split()[1:3]:
                if re.fullmatch(f"{_HEX}{{8}}", column):
                    h.ipv4(IPv4Address(bytes.fromhex(column)[::-1]))
    for path, node in tree.items():
        base = posixpath.basename(path)
        if base in ("node_guid", "sys_image_guid", "phys_switch_id", "phys_port_id"):
            h.guid(_guid_of(_text(node) or ""))
    for guid in facts.guids:
        h.guid(_guid_of(guid))
    serials = [*facts.serials]
    for path, node in tree.items():
        if posixpath.basename(path) in SERIAL_FILES:
            serials.append((_text(node) or "").strip("\0 \n"))
    for line in (_text(tree.get("/proc/cpuinfo")) or "").splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "Serial":
            serials.append(value.strip())
    for fn, table in rec.nvml.items():
        if "Serial" in fn:
            serials += [v for v in table.values() if isinstance(v, str)]
    for serial in serials:
        h.name("serial number", serial)
    for value in rec.nvml.get("nvmlDeviceGetUUID", {}).values():
        if isinstance(value, str):
            p = ph.gpu_uuid(value)
            h.hexes(
                "GPU UUID", [value, value[4:].lower(), value[4:].upper()], [p, p[4:].lower(), p[4:].upper()]
            )
    uuids = [
        *facts.uuids,
        *[_text(n) or "" for p, n in tree.items() if posixpath.basename(p) == "product_uuid"],
    ]
    for u in (u.strip() for u in uuids):
        if _UUID.fullmatch(u):
            p = ph.uuid(u)
            h.hexes("UUID", [u.lower(), u.upper()], [p.lower(), p.upper()])
    for mid in (m.strip() for m in facts.machine_ids):
        if re.fullmatch(f"{_HEX}{{32}}", mid):
            p = ph.machine_id(mid)
            h.hexes("machine-id", [mid.lower(), mid.upper()], [p, p.upper()])
    cids = [container_id(_text(n) or "") for p, n in tree.items() if p.endswith("/cgroup")]
    containers = (rec.host["docker"].get("/containers/json") or {}).get("result") or []
    cids += [c.get("Id") for c in containers]
    for cid in cids:
        if isinstance(cid, str) and re.fullmatch("[0-9a-f]{64}", cid):
            p = ph.container_id(cid)
            h.hexes("container id", [cid, cid[:12]], [p, p[:12]])
    for c in containers:
        for name in c.get("Names") or []:
            h.name("container name", name.lstrip("/"))
    return h.spellings


HOSTNAME = "/proc/sys/kernel/hostname"
CPUINFO = "/proc/cpuinfo"
CONTAINER_NAMES = ("docker", "/containers/json", "result", "Names")
READING_META = ("device", "unreadable")
_HOME_SLOT = re.compile(
    r"(?<![\w.])/(?:home/((?:[\w-]+\.)+[\w-]+/[\w.-]+)|(?:home|Users|media|run/media)/([\w.-]+(?:@[\w.-]+)?))"
)
_SERIAL_LINE = re.compile(r"^Serial[ \t]*:[ \t]*(\S.*)$", re.MULTILINE)


MOUNTS = "/proc/self/mounts"
REPO_TAGS = ("docker", "/images/json", "result", "RepoTags")
_DISK_SOURCE = re.compile(rf"^(?=(?:{DISK.pattern}) )/(dev)/", re.MULTILINE)


def _fixed_parts_of(path: str) -> list[tuple[int, int]]:
    fixed = fixed_parts(path)
    return [m.span() for i, m in enumerate(re.finditer("[^/]+", path)) if i in fixed]


def _fixed_text(path: str, text: str) -> list[tuple[int, int]]:
    return [m.span(1) for m in _DISK_SOURCE.finditer(text)] if path == MOUNTS else []


def _fixed_in_host(where: Where, text: str) -> list[tuple[int, int]]:
    return [(0, len(NGC_PYTORCH))] if where == REPO_TAGS and text.startswith(NGC_PYTORCH) else []


def _fixed_in_nvml(where: Where, text: str) -> list[tuple[int, int]]:
    return [(0, len(text))] if where == () and text in NVML_CALLS else []


def _fixed_in_meta(where: Where, text: str) -> list[tuple[int, int]]:
    return _fixed_parts_of(text) if where == ("unreadable",) else []


def _where_names_live(path: str, text: str) -> list[tuple[int, int]]:
    if path == HOSTNAME:
        return [(0, len(text))]
    slots = [m.span(1 if m[1] else 2) for m in _HOME_SLOT.finditer(text)]
    if path == CPUINFO:
        slots += [m.span(1) for m in _SERIAL_LINE.finditer(text)]
    return slots


def _strings_at(doc: Any, where: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], str]]:
    if isinstance(doc, str):
        yield where, doc
    elif isinstance(doc, dict):
        for k, v in doc.items():
            yield where, str(k)
            yield from _strings_at(v, (*where, str(k)))
    elif isinstance(doc, list):
        for v in doc:
            yield from _strings_at(v, where)


def _collisions(rec: Recording, names: Spellings) -> list[Leak]:
    found: set[str] = set()
    for path, node in rec.tree.items():
        found |= names.outside(path, _where_names_live("", path) + _fixed_parts_of(path))
        if isinstance(node, Link):
            found |= names.outside(node.target, _where_names_live("", node.target))
        elif isinstance(node, File):
            text = text_of(node.data)[0]
            found |= names.outside(text, _where_names_live(path, text) + _fixed_text(path, text))
    readings = {k: rec.meta[k] for k in READING_META if k in rec.meta}
    for doc, fixed in ((rec.nvml, _fixed_in_nvml), (rec.host, _fixed_in_host), (readings, _fixed_in_meta)):
        for where, text in _strings_at(doc):
            slots = [(0, len(text))] if where == CONTAINER_NAMES else _where_names_live("", text)
            found |= names.outside(text, slots + fixed(where, text))
    return [Leak(IN_A_READING, c) for c in sorted(found)]


def _rewriters(ph: Placeholders) -> list[tuple[Detector, Callable[[re.Match[str]], str]]]:
    def mac(m: re.Match[str]) -> str:
        text = m[0]
        if not re.search("[:-]", text):
            return text
        p = ph.mac(bytes.fromhex(re.sub("[:-]", "", text)))
        spelled = text[2].join(f"{x:02x}" for x in p)
        return spelled.upper() if re.search("[A-F]", text) else spelled

    def guid(m: re.Match[str]) -> str:
        text = m[0]
        if ":" not in text:
            return text
        h = ph.guid(bytes.fromhex(text.replace(":", ""))).hex()
        spelled = ":".join(h[i : i + 4] for i in range(0, 16, 4))
        return spelled.upper() if re.search("[A-F]", text) else spelled

    def home(m: re.Match[str]) -> str:
        top, _, name = m[0][1:].partition("/")
        return f"/{top}/<{ph.name('user', name)}>"

    def same_case(text: str, like: str) -> str:
        return text.upper() if re.search("[A-F]", like) else text

    def dotted_mac(m: re.Match[str]) -> str:
        h = ph.mac(bytes.fromhex(m[1] + m[2] + m[3])).hex()
        return same_case(".".join(h[i : i + 4] for i in range(0, 12, 4)), m[0])

    def hf_model(m: re.Match[str]) -> str:
        return f"{m[1]}--{ph.name('Hugging Face org', m[2])}--{ph.name('Hugging Face model', m[3])}"

    def hf_repo(m: re.Match[str]) -> str:
        return (
            f"huggingface.co/{m[1]}{ph.name('Hugging Face org', m[2])}/{ph.name('Hugging Face model', m[3])}"
        )

    def volume_id(m: re.Match[str]) -> str:
        p = ph.volume_id(m[0].upper())
        return p if m[1] else p.lower()

    by_category = {
        "IPv4 address": lambda m: str(ph.ipv4(IPv4Address(m[0]))),
        "IPv6 address": lambda m: _spell6(ph.ipv6(IPv6Address(m[0])), m[0]),
        "MAC address": mac,
        "InfiniBand GUID": guid,
        "GPU UUID": lambda m: ph.gpu_uuid(m[0]),
        "home directory": home,
    }
    return [
        (HOME_UNDER_DOMAIN, lambda m: f"/home/<{ph.name('user', m[2].strip('<>'))}>"),
        (HOME_WITH_DOMAIN, lambda m: f"/{m[1]}/<{ph.name('user', m[2].strip('<>'))}>"),
        (MEDIA, lambda m: f"{m[1]}/<{ph.name('user', m[2])}>"),
        (HF_MODEL, hf_model),
        (HF_REPO, hf_repo),
        *((d, by_category[d.category]) for d in CAPTURE if d.category in by_category),
        (HEX32, lambda m: same_case(ph.ipv6(IPv6Address(bytes.fromhex(m[0]))).packed.hex(), m[0])),
        (HEX64, lambda m: same_case(ph.container_id(m[0].lower()), m[0])),
        (DOTTED_MAC, dotted_mac),
        (BRIDGE, lambda m: ph.virtual_interface(m[0])),
        (VETH, lambda m: ph.virtual_interface(m[0])),
        (VOLUME_ID, volume_id),
    ]


def _sub_flagged(d: Detector, fix: Callable[[re.Match[str]], str], text: str) -> str:
    return d.pattern.sub(lambda m: m[0] if d.ok(m) else fix(m), text)


def redact(rec: Recording, facts: Facts) -> Redacted:
    rec, left_out = _minimize(rec)
    ph = Placeholders("\n".join(_surfaces(rec)).lower())
    harvested = _harvest(rec, facts, ph)
    originals = Spellings(harvested)
    collisions = _collisions(rec, Spellings(s for s in harvested if s.form in _WORDS))
    passes = _rewriters(ph)

    def plain_uuid(m: re.Match[str]) -> str:
        p = ph.uuid(m[0])
        return p.upper() if re.search("[A-F]", m[0]) else p

    def rewrite(text: str, keep: Spans = ()) -> str:
        text = originals.sub(text, keep)
        for detector, fix in passes:
            text = _sub_flagged(detector, fix, text)
        return _UUID.sub(plain_uuid, text)

    def rewrite_doc(doc: Any, fixed: Fixed, where: Where = ()) -> Any:
        if isinstance(doc, str):
            return rewrite(doc, fixed(where, doc))
        if isinstance(doc, dict):
            return {
                rewrite(str(k), fixed(where, str(k))): rewrite_doc(v, fixed, (*where, str(k)))
                for k, v in doc.items()
            }
        if isinstance(doc, list):
            return [rewrite_doc(v, fixed, where) for v in doc]
        return doc

    def rewrite_node(path: str, node: Node) -> Node:
        if isinstance(node, Link):
            return Link(rewrite(node.target))
        if isinstance(node, File) and (text := _text(node)) is not None:
            return File(rewrite(text, _fixed_text(path, text)).encode())
        return node

    read_at = {rewrite(path, _fixed_parts_of(path)): path for path in rec.tree}
    tree = {path: rewrite_node(raw, rec.tree[raw]) for path, raw in read_at.items()}
    nvml = rewrite_doc(rec.nvml, _fixed_in_nvml)
    host = rewrite_doc(rec.host, _fixed_in_host)
    meta = {k: rewrite_doc(v, _fixed_in_meta, (k,)) if k in READING_META else v for k, v in rec.meta.items()}
    left = {**meta.get("left_out", {}), **left_out}
    counts = dict(sorted(ph.counts.items()))
    meta |= {"redacted": counts, "left_out": dict(sorted(left.items()))}
    return Redacted(
        Recording(rec.platform, meta, tree, nvml, host), counts, left, originals, read_at, collisions, rewrite
    )


def _categories(text: str, binary: bool, originals: Spellings, fixed: Spans = ()) -> set[str]:
    found = {category for _, category in scan(text, GATE, binary)}
    if any(not m[0].lower().startswith(_UUID_PLACEHOLDER) for m in _UUID.finditer(text)):
        found.add("UUID")
    return found | originals.outside(text, fixed)


def _numbers(doc: Any) -> Iterable[str]:
    if isinstance(doc, dict | list):
        for v in doc.values() if isinstance(doc, dict) else doc:
            yield from _numbers(v)
    elif not isinstance(doc, str):
        yield json.dumps(doc)


def _doc_categories(doc: Any, originals: Spellings, fixed: Fixed) -> set[str]:
    found = _categories(dumps(doc), False, Spellings([])) | originals.categories_in(" ".join(_numbers(doc)))
    for where, text in _strings_at(doc):
        found |= originals.outside(text, fixed(where, text))
    return found


def platform_doc(rec: Recording) -> dict[str, Any]:
    return {"platform": rec.platform, **rec.meta}


NOT_REVIEWED = "not in the reviewed read set"
BINARY = "binary content"


def _ancestors(path: str) -> list[str]:
    parts = path.split("/")
    return ["/".join(parts[:i]) or "/" for i in range(1, len(parts))]


def _resolve(tree: dict[str, Node], path: str, depth: int = 0) -> str | None:
    cur = "/"
    for part in [p for p in posixpath.normpath(path).split("/") if p]:
        nxt = posixpath.join(cur, part)
        node = tree.get(nxt)
        if node is None or depth > 40:
            return None
        if isinstance(node, Link):
            got = _resolve(tree, posixpath.join(cur, node.target), depth + 1)
            if got is None:
                return None
            cur = got
        else:
            cur = nxt
    return cur


def _admitted(tree: dict[str, Node], raw_of: dict[str, str]) -> set[str]:
    named = {
        p
        for p, n in tree.items()
        if (isinstance(n, File) and any(admits(holds, n.data) for _, holds in matching(raw_of[p])))
        or (isinstance(n, Dir) and matching(raw_of[p]))
    }
    links = {p: n.target for p, n in tree.items() if isinstance(n, Link)}
    while True:
        on_the_way = {a for p in named for a in _ancestors(p)} & tree.keys()
        reached = named | on_the_way | {"/"}
        more = {
            p
            for p, target in links.items()
            if p not in named and _resolve(tree, posixpath.join(posixpath.dirname(p), target)) in reached
        }
        if not more:
            break
        named |= more
    kept_empty = {
        p
        for p, n in tree.items()
        if posixpath.basename(p) == ".keep" and n == File(b"") and posixpath.dirname(p) in reached
    }
    return reached | kept_empty


def _shown(path: str, raw: str, up_to_the_first_part_not_in: set[str] | None = None) -> str:
    parts = path.split("/")
    depth = len(parts)
    if up_to_the_first_part_not_in is not None:
        reviewed = up_to_the_first_part_not_in
        depth = next((i for i in range(2, len(parts)) if "/".join(parts[:i]) not in reviewed), depth)
    stars = parts_a_bare_star_matches(raw)
    shown = ["*" if i - 1 in stars else part for i, part in enumerate(parts[:depth])]
    return "root" + "/".join(shown) + ("/..." if depth < len(parts) else "")


def _unreviewed_readings(rec: Recording, originals: Spellings) -> list[Leak]:
    named = [
        *(("nvml.json", fn, NVML_CALLS) for fn in rec.nvml),
        *(("host.json", key, HOST_READINGS) for key in rec.host),
        *(("host.json docker", api, DOCKER_APIS) for api in rec.host.get("docker") or {}),
    ]
    return [
        Leak(
            f"{where}, a name that leaks" if _categories(name, False, originals) else f"{where} {name}",
            NOT_REVIEWED,
        )
        for where, name, reviewed in named
        if name not in reviewed
    ]


def leaks(red: Redacted) -> list[Leak]:
    rec, originals = red.recording, red.originals
    admitted = _admitted(rec.tree, red.read_at)
    out: list[Leak] = []
    clean: set[str] = set()
    for path in rec.tree:
        found = _categories(path, False, originals, _fixed_parts_of(path))
        out += [Leak("a path in root/", c) for c in sorted(found)]
        if not found:
            clean.add(path)
    for path, node in rec.tree.items():
        raw = red.read_at[path]
        leaked = "a node in root/ whose path leaks"
        where = _shown(path, raw) if path in clean else leaked
        if path not in admitted:
            text_kind = isinstance(node, File) and any(holds == "text" for _, holds in matching(raw))
            unreviewed = _shown(path, raw, admitted) if path in clean else leaked
            out.append(Leak(where, BINARY) if text_kind else Leak(unreviewed, NOT_REVIEWED))
        if isinstance(node, Link):
            out += [
                Leak(f"the link target of {where}", c)
                for c in sorted(_categories(node.target, False, originals))
            ]
        elif isinstance(node, File):
            text, binary = text_of(node.data)
            found = _categories(text, binary, originals, _fixed_text(raw, text))
            if red.read_at[path] in ROUTE_TABLES:
                found |= {category for _, category in scan(_route_addresses(text), [_HEX_IPV4])}
            if binary:
                found |= originals.categories_in_bytes(node.data)
            out += [Leak(where, c) for c in sorted(found)]
    out += _unreviewed_readings(rec, originals)
    for name, doc, fixed in (
        ("nvml.json", rec.nvml, _fixed_in_nvml),
        ("host.json", rec.host, _fixed_in_host),
    ):
        out += [Leak(name, c) for c in sorted(_doc_categories(doc, originals, fixed))]
    meta = platform_doc(rec)
    readings = {k: meta[k] for k in READING_META if k in meta}
    found = _categories(dumps(meta), False, Spellings([])) | _doc_categories(
        readings, originals, _fixed_in_meta
    )
    out += [Leak("platform.json", c) for c in sorted(found)]
    return list(dict.fromkeys(out))
