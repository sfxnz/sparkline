"""Detectors for identifiers that must not reach a public place: real IP and MAC addresses, NIC GUIDs, GPU
UUIDs, home directories, Tailscale hostnames and private Hugging Face orgs.

The repository's privacy guard (tests/test_no_private_identifiers.py) runs them over every tracked file, and
sparkline-capture runs them over a recording before it writes it.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv6Address, IPv6Network, ip_network

PLACEHOLDER_ADDRESSES = {
    "127.0.0.0/8": "IPv4 loopback",
    "0.0.0.0/8": "'this network' (RFC 1122), never a host's address",
    "192.0.2.0/24": "RFC 5737 TEST-NET-1, the rail B placeholder",
    "198.51.100.0/24": "RFC 5737 TEST-NET-2, the LAN placeholder",
    "203.0.113.0/24": "RFC 5737 TEST-NET-3, the rail A placeholder",
    "2001:db8::/32": "RFC 3849 IPv6 documentation range",
    "172.17.0.0/32": "Docker's default bridge network, the same on every Docker host",
    "172.17.0.1/32": "Docker's default bridge gateway, the same on every Docker host",
    "172.17.0.2/32": "first container on Docker's default bridge, the same on every Docker host",
    "100.100.100.100/32": "Tailscale's MagicDNS resolver, the same on every tailnet",
    "169.254.169.254/32": "cloud metadata service, an endpoint the agent must refuse",
    "8.8.8.8/32": "Google public DNS, the example public address",
    "1.1.1.1/32": "Cloudflare public DNS, the example public address",
    "2001:4860::1/128": "in Google's IPv6 prefix, the example public IPv6 address",
}
MACS_ALLOWED = {
    "02:00:00:": "placeholder prefix, locally administered so no vendor uses it",
    "00:00:00:00:00:00": "no address",
    "ff:ff:ff:ff:ff:ff": "broadcast",
}
GUIDS_ALLOWED = {
    "0200:0000:0000:": "placeholder prefix, locally administered so no vendor uses it",
    "0000:0000:0000:0000": "no GUID",
}
GPU_UUIDS_ALLOWED = {
    "gpu-00000000-0000-0000-0000-0000": "placeholder, only the last eight digits vary",
}
PUBLIC_HF_ORGS = {"deepseek-ai", "meta-llama", "mistralai", "nvidia", "Qwen", "turboderp"}
# Compressed bytes read as IPv6 often (17 hits in the 2.8 MB of screenshots); every other detector found none
# there or in 50 MB of random bytes.
BINARY_SKIPPED_CATEGORIES = {"IPv6 address"}

_LINK_LOCAL = IPv6Network("fe80::/10")
_IPV4_COMPATIBLE = IPv6Network("::/96")

Address = IPv4Address | IPv6Address


@dataclass(frozen=True)
class Detector:
    category: str
    pattern: re.Pattern[str]
    ok: Callable[[re.Match[str]], bool]


def _is_netmask(a: Address) -> bool:
    return "01" not in f"{int(a):0{a.max_prefixlen}b}"


def _mac_ok(b: bytes) -> bool:
    return ":".join(f"{x:02x}" for x in b).startswith(tuple(MACS_ALLOWED))


def _is_modified_eui64(b: bytes) -> bool:
    # ff:fe in the middle marks a MAC with its U/L bit flipped (RFC 4291 modified EUI-64)
    return b[3:5] == b"\xff\xfe"


def _vendor_unicast(b: bytes) -> bool:
    return b[0] & 0b11 == 0


def _eui64_ok(b: bytes) -> bool:
    if _is_modified_eui64(b):
        return _mac_ok(bytes([b[0] ^ 2]) + b[1:3] + b[5:])
    return ":".join(b[i : i + 2].hex() for i in range(0, 8, 2)).startswith(tuple(GUIDS_ALLOWED))


def _hex_bytes_ok(b: bytes) -> bool:
    if not (_vendor_unicast(b) or _is_modified_eui64(b)):
        return True
    return _mac_ok(b) if len(b) == 6 else _eui64_ok(b)


def _bare_hex_ok(h: str) -> bool:
    # NCCL and sysfs phys_switch_id print a GUID as %lx of a little-endian integer, so check both byte orders.
    b = bytes.fromhex(h)
    return h.isdigit() or (_hex_bytes_ok(b) and _hex_bytes_ok(b[::-1]))


_H = "[0-9A-Fa-f]"
_OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
_ESCAPED_WHITESPACE = re.compile(r"\\[nrt]")
_IPV4 = rf"{_OCTET}(?:\.{_OCTET}){{3}}"


def _lone(body: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w:.-]){body}(?![\w:-]|\.\w)")


def detectors(allowed: Mapping[str, str]) -> list[Detector]:
    """The detector table, with the address checks accepting the networks in ``allowed``."""
    nets = [ip_network(n) for n in allowed]

    def address_ok(a: Address) -> bool:
        if any(a.version == n.version and a in n for n in nets) or _is_netmask(a):
            return True
        if isinstance(a, IPv6Address):
            if a.ipv4_mapped:
                return address_ok(a.ipv4_mapped)
            if a in _IPV4_COMPATIBLE:
                return address_ok(IPv4Address(a.packed[12:]))
            if a in _LINK_LOCAL:
                return _eui64_ok(a.packed[8:])
        return False

    def hex_ipv4_ok(h: str) -> bool:
        # Route tables and GID tails write IPv4 as 8 hex digits in either order.
        b = bytes.fromhex(h)
        return all(address_ok(a) for a in (IPv4Address(b), IPv4Address(b[::-1])) if not a.is_global)

    def ipv6_ok(text: str) -> bool:
        try:
            return address_ok(IPv6Address(text))
        except ValueError:
            return True

    def decimal_gid_ok(text: str) -> bool:
        parts = [int(p) for p in text.split(":")]
        return max(parts) > 255 or address_ok(IPv6Address(bytes(parts)))

    def nccl_gid_ok(m: re.Match[str]) -> bool:
        return address_ok(
            IPv6Address(int(m[1], 16).to_bytes(8, "little") + int(m[2], 16).to_bytes(8, "little"))
        )

    return [
        Detector(
            "IPv4 address",
            re.compile(rf"(?<![\d.]){_IPV4}(?!\d|\.\d)"),
            lambda m: address_ok(IPv4Address(m[0])),
        ),
        Detector(
            "IPv4 address (hex)",
            _lone(rf"({_H}{{4}}):?({_H}{{4}})"),
            lambda m: hex_ipv4_ok(m[1] + m[2]),
        ),
        Detector(
            "IPv6 address",
            _lone(rf"(?:{_H}{{0,4}}:){{2,7}}(?:{_IPV4}|{_H}{{1,4}})?"),
            lambda m: ipv6_ok(m[0]),
        ),
        Detector("RoCE GID", _lone(r"(?:\d{1,3}:){15}\d{1,3}"), lambda m: decimal_gid_ok(m[0])),
        Detector("RoCE GID", re.compile(rf"GID \d+ \(({_H}{{1,16}})/({_H}{{1,16}})\)"), nccl_gid_ok),
        Detector(
            "MAC address",
            _lone(rf"{_H}{{2}}([:-]){_H}{{2}}(?:\1{_H}{{2}}){{4}}"),
            lambda m: _mac_ok(bytes.fromhex(re.sub("[:-]", "", m[0]))),
        ),
        Detector("MAC address", _lone(rf"{_H}{{12}}"), lambda m: _bare_hex_ok(m[0])),
        Detector(
            "InfiniBand GUID",
            _lone(rf"{_H}{{4}}(?::{_H}{{4}}){{3}}"),
            lambda m: _eui64_ok(bytes.fromhex(m[0].replace(":", ""))),
        ),
        Detector(
            "InfiniBand GUID",
            re.compile(rf"(?<![\w:-])(?:0x)?({_H}{{16}})(?![\w:-]|\.\w)"),
            lambda m: _bare_hex_ok(m[1]),
        ),
        # NCCL's topology dump drops a GUID's leading zeros; the bare check above takes the 16-digit ones.
        Detector(
            "InfiniBand GUID",
            re.compile(rf"NET/\d+-\d+ \(\d+/({_H}{{1,15}})/"),
            lambda m: _bare_hex_ok(m[1].zfill(16)),
        ),
        Detector(
            "GPU UUID",
            re.compile(rf"\b(?:GPU|MIG)-{_H}{{8}}(?:-{_H}{{4}}){{3}}-{_H}{{12}}\b"),
            lambda m: m[0].lower().startswith(tuple(GPU_UUIDS_ALLOWED)),
        ),
        Detector("home directory", re.compile(r"(?<![\w.])/(?:home|Users)/[\w.-]+"), lambda m: False),
        Detector("Tailscale hostname", re.compile(r"\b[\w-]+\.ts\.net\b"), lambda m: False),
        Detector(
            "Hugging Face cache path", re.compile(r"models--([\w.-]+?)--"), lambda m: m[1] in PUBLIC_HF_ORGS
        ),
    ]


CAPTURE = detectors(PLACEHOLDER_ADDRESSES)


def scan(text: str, table: list[Detector], binary: bool = False) -> list[tuple[int, str]]:
    """(line number, category) of every flagged match."""
    active = [d for d in table if not (binary and d.category in BINARY_SKIPPED_CATEGORIES)]
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        line = _ESCAPED_WHITESPACE.sub(" ", line)
        out += [(n, d.category) for d in active for m in d.pattern.finditer(line) if not d.ok(m)]
    return out


def text_of(data: bytes) -> tuple[str, bool]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "\n".join(r.decode("ascii") for r in re.findall(rb"[\x20-\x7e]{4,}", data)), True
    return text.replace("\0", "\n"), False  # /proc/<pid>/cmdline and environ dumps separate with NUL
