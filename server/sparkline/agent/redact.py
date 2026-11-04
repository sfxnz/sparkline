from __future__ import annotations

import json
import posixpath
import re
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from ipaddress import IPv4Address, IPv6Address, IPv6Network
from typing import Any, Literal

from ..common.identifiers import CAPTURE, Detector, scan, text_of
from .collectors.procs import container_id
from .collectors.storage import REAL_FS


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
    def __init__(self, found: list[Leak]) -> None:
        self.leaks = found
        lines = [f"  {leak.surface}: {leak.category}" for leak in found]
        super().__init__(
            "The capture was refused and nothing was written: these places hold an identifier it cannot "
            "replace (values are not shown):\n" + "\n".join(lines)
        )


PUBLIC_IMAGES = ("nvcr.io/nvidia/",)
SERIAL_FILES = {
    "serial",
    "serial_number",
    "unique_id",
    "product_serial",
    "board_serial",
    "chassis_serial",
    "serial-number",
}
GENERIC_NAMES = {"root", "admin", "user", "ubuntu", "debian", "nvidia", "pi", "localhost", "dgx", "spark"}

_HEX = "[0-9A-Fa-f]"
Form = Literal["hex", "name", "ipv4", "ipv6", "path"]
_UUID = re.compile(rf"(?<!{_HEX}){_HEX}{{8}}(?:-{_HEX}{{4}}){{3}}-{_HEX}{{12}}(?!{_HEX})")
_UUID_PLACEHOLDER = "00000000-0000-0000-0000-0000"
_PID = re.compile(r"/proc/\d+/(cmdline|cgroup)")
_LINK_LOCAL = IPv6Network("fe80::/10")
_IPV4_COMPATIBLE = IPv6Network("::/96")
_IPV4_POOL = [f"198.51.100.{i}" for i in range(1, 255)] + [
    f"{net}.{i}" for net in ("203.0.113", "192.0.2") for i in range(1, 255)
]

_NOT_ADJACENT: dict[Form, tuple[str, str]] = {
    "hex": (rf"(?<!{_HEX})", rf"(?!{_HEX})"),
    "name": (r"(?<![A-Za-z0-9])", r"(?![A-Za-z0-9])"),
    "ipv4": (r"(?<![\d.])", r"(?!\d|\.\d)"),
    "ipv6": (r"(?<![0-9A-Fa-f:])", r"(?![0-9A-Fa-f:])"),
    "path": (r"(?<![\w.])", r"(?![\w.-])"),
}
_NAME_PLACEHOLDER = re.compile(r"(?:host|user|serial|container)\d+|<org\d+>")


def dumps(doc: Any) -> str:
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


@dataclass(frozen=True)
class Spelling:
    form: Form
    original: str
    placeholder: str
    category: str


class Spellings:
    def __init__(self, spellings: Iterable[Spelling]) -> None:
        unique: dict[tuple[str, str], Spelling] = {}
        for s in spellings:
            key = s.original.lower() if s.form == "name" else s.original
            if s.original != s.placeholder:
                unique.setdefault((s.form, key), s)
        self._items = sorted(unique.values(), key=lambda s: -len(s.original))
        alternatives = []
        for s in self._items:
            lead, trail = _NOT_ADJACENT[s.form]
            body = f"(?i:{re.escape(s.original)})" if s.form == "name" else re.escape(s.original)
            alternatives.append(f"({lead}{body}{trail})")
        self._rx = re.compile("|".join(alternatives)) if alternatives else None

    def _spelling(self, m: re.Match[str]) -> Spelling:
        assert m.lastindex is not None
        return self._items[m.lastindex - 1]

    def sub(self, text: str) -> str:
        return self._rx.sub(lambda m: self._spelling(m).placeholder, text) if self._rx else text

    def categories_in(self, text: str) -> set[str]:
        return {self._spelling(m).category for m in self._rx.finditer(text)} if self._rx else set()

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
    return bool(scan(spelling, CAPTURE))


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

    def name(self, category: str, value: str) -> str:
        if _NAME_PLACEHOLDER.fullmatch(value):
            return value
        prefix = {
            "hostname": "host",
            "user": "user",
            "serial number": "serial",
            "container name": "container",
        }
        if category == "Hugging Face org":
            return self._take(category, value, lambda n: f"<org{n}>")
        return self._take(category, value.lower(), lambda n: f"{prefix[category]}{n}")


@dataclass(frozen=True)
class Redacted:
    recording: Recording
    counts: dict[str, int]
    left_out: dict[str, int]
    originals: Spellings
    rewrite: Callable[[str], str] = field(repr=False)


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
        lines = mounts.splitlines(keepends=True)
        kept = [line for line in lines if len(f := line.split()) > 2 and f[2] in REAL_FS]
        left["mount lines of other filesystems"] += len(lines) - len(kept)
        tree["/proc/self/mounts"] = File("".join(kept).encode())
    cids: set[str] = set()
    for path in list(tree):
        m = _PID.fullmatch(path)
        text = _text(tree[path]) if m else None
        if m is None or text is None:
            continue
        if m[1] == "cmdline":
            argv = text.split("\0")
            words = posixpath.basename(argv[0]).split()
            left["command-line arguments"] += len([a for a in argv if a]) - 1 if argv[0] else 0
            tree[path] = File(f"{words[0]}\0".encode() if words else b"")
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
                if (tags := [t for t in img.get("RepoTags") or [] if t.startswith(PUBLIC_IMAGES)])
            ]
            left["Docker images not from " + ", ".join(PUBLIC_IMAGES)] += len(result) - len(images)
            docker[api] = {"result": images}
        elif api == "/containers/json" and isinstance(result, list):
            kept_containers = [
                {k: c[k] for k in ("Id", "Names") if k in c} for c in result if c.get("Id") in cids
            ]
            left["Docker containers no recorded process runs in"] += len(result) - len(kept_containers)
            docker[api] = {"result": kept_containers}
        else:
            left["other Docker API answers"] += 1
            docker[api] = {"error": "not recorded"}
    host = {**rec.host, "docker": docker}
    return Recording(rec.platform, dict(rec.meta), tree, rec.nvml, host), +left


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
        value = value.strip()
        if len(value) < 3 or value.lower() in GENERIC_NAMES:
            return
        placeholder = self.ph.name(category, value)
        self._pairs("name", [value], [placeholder], category)
        if category == "hostname" and "-" in value:
            self._pairs("name", [value.replace("-", "--")], [placeholder.replace("-", "--")], category)

    def hexes(self, category: str, values: list[str], placeholders: list[str]) -> None:
        self._pairs("hex", values, placeholders, category)


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


def _rewriters(ph: Placeholders) -> dict[str, Callable[[re.Match[str]], str]]:
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

    return {
        "IPv4 address": lambda m: str(ph.ipv4(IPv4Address(m[0]))),
        "IPv6 address": lambda m: _spell6(ph.ipv6(IPv6Address(m[0])), m[0]),
        "MAC address": mac,
        "InfiniBand GUID": guid,
        "GPU UUID": lambda m: ph.gpu_uuid(m[0]),
        "home directory": home,
        "Hugging Face cache path": lambda m: f"models--{ph.name('Hugging Face org', m[1])}--",
    }


def _sub_flagged(d: Detector, fix: Callable[[re.Match[str]], str], text: str) -> str:
    return d.pattern.sub(lambda m: m[0] if d.ok(m) else fix(m), text)


def redact(rec: Recording, facts: Facts) -> Redacted:
    rec, left_out = _minimize(rec)
    ph = Placeholders("\n".join(_surfaces(rec)).lower())
    originals = Spellings(_harvest(rec, facts, ph))
    rewriters = _rewriters(ph)

    passes = [(d, rewriters[d.category]) for d in CAPTURE if d.category in rewriters]

    def plain_uuid(m: re.Match[str]) -> str:
        p = ph.uuid(m[0])
        return p.upper() if re.search("[A-F]", m[0]) else p

    def rewrite(text: str) -> str:
        text = originals.sub(text)
        for detector, fix in passes:
            text = _sub_flagged(detector, fix, text)
        return _UUID.sub(plain_uuid, text)

    def rewrite_doc(doc: Any) -> Any:
        if isinstance(doc, str):
            return rewrite(doc)
        if isinstance(doc, dict):
            return {rewrite(str(k)): rewrite_doc(v) for k, v in doc.items()}
        if isinstance(doc, list):
            return [rewrite_doc(v) for v in doc]
        return doc

    def rewrite_node(node: Node) -> Node:
        if isinstance(node, Link):
            return Link(rewrite(node.target))
        if isinstance(node, File) and (text := _text(node)) is not None:
            return File(rewrite(text).encode())
        return node

    tree = {rewrite(path): rewrite_node(node) for path, node in rec.tree.items()}
    nvml = rewrite_doc(rec.nvml)
    host = rewrite_doc(rec.host)
    meta = rewrite_doc(rec.meta)
    left = {**meta.get("left_out", {}), **left_out}
    counts = dict(sorted(ph.counts.items()))
    meta |= {"redacted": counts, "left_out": dict(sorted(left.items()))}
    return Redacted(Recording(rec.platform, meta, tree, nvml, host), counts, left, originals, rewrite)


def _categories(text: str, binary: bool, originals: Spellings) -> set[str]:
    found = {category for _, category in scan(text, CAPTURE, binary)}
    if any(not m[0].lower().startswith(_UUID_PLACEHOLDER) for m in _UUID.finditer(text)):
        found.add("UUID")
    return found | originals.categories_in(text)


def platform_doc(rec: Recording) -> dict[str, Any]:
    return {"platform": rec.platform, **rec.meta}


def leaks(rec: Recording, originals: Spellings) -> list[Leak]:
    out: list[Leak] = []
    clean: set[str] = set()
    for path in rec.tree:
        found = _categories(path, False, originals)
        out += [Leak("a path in root/", c) for c in sorted(found)]
        if not found:
            clean.add(path)
    for path, node in rec.tree.items():
        where = f"root{path}" if path in clean else "a node in root/ whose path leaks"
        if isinstance(node, Link):
            out += [
                Leak(f"the link target of {where}", c)
                for c in sorted(_categories(node.target, False, originals))
            ]
        elif isinstance(node, File):
            text, binary = text_of(node.data)
            found = _categories(text, binary, originals)
            if binary:
                found |= originals.categories_in_bytes(node.data)
            out += [Leak(where, c) for c in sorted(found)]
    for name, doc in (("nvml.json", rec.nvml), ("host.json", rec.host), ("platform.json", platform_doc(rec))):
        out += [Leak(name, c) for c in sorted(_categories(dumps(doc), False, originals))]
    return out
