from __future__ import annotations

import re
import subprocess
from collections.abc import Callable
from ipaddress import IPv4Address, IPv6Address, IPv6Network, ip_network
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]

NOT_SCANNED = {
    "server/tests/test_no_private_identifiers.py": "holds this guard's own real-looking test values",
}
LOCKFILES = {
    "server/requirements.lock": "generated; versions and hashes read as addresses, so only name checks run",
    "web/package-lock.json": "generated; versions and hashes read as addresses, so only name checks run",
}
LOCKFILE_CATEGORIES = {"home directory", "Tailscale hostname", "Hugging Face cache path"}
# Compressed bytes read as IPv6 often (17 hits in the 2.8 MB of screenshots); every other detector found none
# there or in 50 MB of random bytes.
BINARY_SKIPPED_CATEGORIES = {"IPv6 address"}
CACHE_DIRS = {".ruff_cache", ".mypy_cache", ".pytest_cache", "__pycache__", "node_modules", ".venv", "dist"}

_TEST = "test address in the LAN and bind checks, which need non-documentation addresses"
_RANGE_START = "first address of a special-purpose range, where code lists the ranges"
ADDRESSES_ALLOWED = {
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
    "10.0.0.0/32": _RANGE_START,
    "172.16.0.0/32": _RANGE_START,
    "192.168.0.0/32": _RANGE_START,
    "169.254.0.0/32": _RANGE_START,
    "100.64.0.0/32": _RANGE_START,
    "100.64.0.113/32": "GB10 recording placeholder, PR #67",
    "172.32.0.1/32": "public address just past 172.16.0.0/12, in boundary tests",
    "100.128.0.1/32": "public address just past 100.64.0.0/10, in boundary tests",
    "10.0.0.1/32": _TEST,
    "10.0.0.2/32": _TEST,
    "10.0.0.5/32": _TEST,
    "10.0.0.48/32": _TEST,
    "10.0.0.195/32": _TEST,
    "10.0.8.1/32": _TEST,
    "10.0.8.2/32": _TEST,
    "10.0.9.1/32": _TEST,
    "10.0.9.2/32": _TEST,
    "172.16.0.1/32": _TEST,
    "192.168.1.1/32": _TEST,
    "192.168.1.5/32": _TEST,
    "192.168.1.11/32": _TEST,
    "192.168.1.12/32": _TEST,
    "100.100.1.1/32": _TEST,
    "100.100.1.2/32": _TEST,
    "169.254.1.1/32": _TEST,
    "fd00::5/128": _TEST,
    "fc::1/128": "lookalike of the fc00::/7 ULA prefix, which LAN checks must refuse",
    "fe80::1/128": _TEST,
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
PLACEHOLDERS = (
    "RFC 5737 IPv4 (192.0.2.x, 198.51.100.x, 203.0.113.x), 2001:db8:: IPv6, 02:00:00:xx:xx:xx MACs, "
    "0200:0000:0000:xxxx GUIDs, GPU-00000000-0000-0000-0000-0000xxxxxxxx, no home directories, "
    "a public Hugging Face org"
)

_NETS = [ip_network(n) for n in ADDRESSES_ALLOWED]
_LINK_LOCAL = IPv6Network("fe80::/10")
_IPV4_COMPATIBLE = IPv6Network("::/96")


def _is_netmask(a: IPv4Address | IPv6Address) -> bool:
    return "01" not in f"{int(a):0{a.max_prefixlen}b}"


def _address_ok(a: IPv4Address | IPv6Address) -> bool:
    if any(a.version == n.version and a in n for n in _NETS) or _is_netmask(a):
        return True
    if isinstance(a, IPv6Address):
        if a.ipv4_mapped:
            return _address_ok(a.ipv4_mapped)
        if a in _IPV4_COMPATIBLE:
            return _address_ok(IPv4Address(a.packed[12:]))
        if a in _LINK_LOCAL:
            return _eui64_ok(a.packed[8:])
    return False


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


def _hex_ipv4_ok(h: str) -> bool:
    # Route tables and GID tails write IPv4 as 8 hex digits in either order.
    b = bytes.fromhex(h)
    return all(_address_ok(a) for a in (IPv4Address(b), IPv4Address(b[::-1])) if not a.is_global)


def _ipv6_ok(text: str) -> bool:
    try:
        return _address_ok(IPv6Address(text))
    except ValueError:
        return True


def _decimal_gid_ok(text: str) -> bool:
    parts = [int(p) for p in text.split(":")]
    return max(parts) > 255 or _address_ok(IPv6Address(bytes(parts)))


def _nccl_gid_ok(m: re.Match[str]) -> bool:
    return _address_ok(IPv6Address(int(m[1], 16).to_bytes(8, "little") + int(m[2], 16).to_bytes(8, "little")))


_H = "[0-9A-Fa-f]"
_OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
_ESCAPED_WHITESPACE = re.compile(r"\\[nrt]")
_IPV4 = rf"{_OCTET}(?:\.{_OCTET}){{3}}"


def _lone(body: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w:.-]){body}(?![\w:-]|\.\w)")


DETECTORS: list[tuple[str, re.Pattern[str], Callable[[re.Match[str]], bool]]] = [
    ("IPv4 address", re.compile(rf"(?<![\d.]){_IPV4}(?!\d|\.\d)"), lambda m: _address_ok(IPv4Address(m[0]))),
    ("IPv4 address (hex)", _lone(rf"({_H}{{4}}):?({_H}{{4}})"), lambda m: _hex_ipv4_ok(m[1] + m[2])),
    ("IPv6 address", _lone(rf"(?:{_H}{{0,4}}:){{2,7}}(?:{_IPV4}|{_H}{{1,4}})?"), lambda m: _ipv6_ok(m[0])),
    ("RoCE GID", _lone(r"(?:\d{1,3}:){15}\d{1,3}"), lambda m: _decimal_gid_ok(m[0])),
    ("RoCE GID", re.compile(rf"GID \d+ \(({_H}{{1,16}})/({_H}{{1,16}})\)"), _nccl_gid_ok),
    (
        "MAC address",
        _lone(rf"{_H}{{2}}([:-]){_H}{{2}}(?:\1{_H}{{2}}){{4}}"),
        lambda m: _mac_ok(bytes.fromhex(re.sub("[:-]", "", m[0]))),
    ),
    ("MAC address", _lone(rf"{_H}{{12}}"), lambda m: _bare_hex_ok(m[0])),
    (
        "InfiniBand GUID",
        _lone(rf"{_H}{{4}}(?::{_H}{{4}}){{3}}"),
        lambda m: _eui64_ok(bytes.fromhex(m[0].replace(":", ""))),
    ),
    ("InfiniBand GUID", _lone(rf"(?:0x)?({_H}{{16}})"), lambda m: _bare_hex_ok(m[1])),
    # NCCL's topology dump drops a GUID's leading zeros; the bare check above takes the 16-digit ones.
    (
        "InfiniBand GUID",
        re.compile(rf"NET/\d+-\d+ \(\d+/({_H}{{1,15}})/"),
        lambda m: _bare_hex_ok(m[1].zfill(16)),
    ),
    (
        "GPU UUID",
        re.compile(rf"\b(?:GPU|MIG)-{_H}{{8}}(?:-{_H}{{4}}){{3}}-{_H}{{12}}\b"),
        lambda m: m[0].lower().startswith(tuple(GPU_UUIDS_ALLOWED)),
    ),
    ("home directory", re.compile(r"(?<![\w.])/(?:home|Users)/[\w.-]+"), lambda m: False),
    ("Tailscale hostname", re.compile(r"\b[\w-]+\.ts\.net\b"), lambda m: False),
    ("Hugging Face cache path", re.compile(r"models--([\w.-]+?)--"), lambda m: m[1] in PUBLIC_HF_ORGS),
]


def findings(path: str, text: str, binary: bool = False) -> list[str]:
    detectors = [
        d
        for d in DETECTORS
        if (path not in LOCKFILES or d[0] in LOCKFILE_CATEGORIES)
        and not (binary and d[0] in BINARY_SKIPPED_CATEGORIES)
    ]
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        line = _ESCAPED_WHITESPACE.sub(" ", line)
        where = path if binary else f"{path}:{n}"
        out += [f"{where}: {cat}" for cat, rx, ok in detectors for m in rx.finditer(line) if not ok(m)]
    return out


def text_of(data: bytes) -> tuple[str, bool]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "\n".join(r.decode("ascii") for r in re.findall(rb"[\x20-\x7e]{4,}", data)), True
    return text.replace("\0", "\n"), False  # /proc/<pid>/cmdline and environ dumps separate with NUL


def tracked_cache_findings(paths: list[str]) -> list[str]:
    # Tool caches hold absolute paths of the machine that wrote them.
    tagged = {PurePosixPath(p).parent for p in paths if PurePosixPath(p).name == "CACHEDIR.TAG"}

    def cached(d: PurePosixPath) -> bool:
        return d.name in CACHE_DIRS or d.name.endswith(".egg-info") or d in tagged

    return [f"{p}: tracked cache" for p in paths if any(map(cached, list(PurePosixPath(p).parents)[:-1]))]


def tracked_paths() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode()
    return list(filter(None, listed.split("\0")))


def tracked_files() -> dict[str, tuple[str, bool]]:
    return {
        rel: text_of((ROOT / rel).read_bytes())
        for rel in tracked_paths()
        if rel not in NOT_SCANNED and not (ROOT / rel).is_symlink() and (ROOT / rel).is_file()
    }


def test_scope_is_every_tracked_file():
    files = tracked_files()
    for rel in (
        "README.md",
        "DISCOVERY.md",
        "install.sh",
        "server/sparkline/console/demo.py",
        "server/tests/test_agent_bind.py",
        "server/tests/fixtures/agent/net_sysfs.json",
        "server/tests/fixtures/agent/cmdline_exl3",
        "web/src/test/fixtures/sample.json",
        "web/package-lock.json",
    ):
        assert rel in files
    assert files["docs/screenshots/overview-dark.png"][1]


def test_no_real_identifiers_in_tracked_files():
    found = [
        f for rel, (text, binary) in sorted(tracked_files().items()) for f in findings(rel, text, binary)
    ]
    assert not found, f"Use placeholders ({PLACEHOLDERS}):\n" + "\n".join(found)


REAL_LOOKING = {
    "lan 10.1.2.3": "IPv4 address",
    "cgnat 100.64.0.77": "IPv4 address",
    "route enp1s0\t0201A8C0\t00000000": "IPv4 address (hex)",
    "route big-endian C0A80102": "IPv4 address (hex)",
    "gid tail 0a01:0203": "IPv4 address (hex)",
    "mapped ::ffff:0a01:0203": "IPv6 address",
    "gid 0000:0000:0000:0000:0000:ffff:c0a8:0102": "IPv6 address",
    "link-local fe80::4eaa:bbff:fecc:ddee": "IPv6 address",
    "gid fe80:0000:0000:0000:4eaa:bbff:fecc:ddee": "IPv6 address",
    "ula fd7a:115c:a1e0::1234:5678": "IPv6 address",
    "global 2a01:4f8::1": "IPv6 address",
    "perftest GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:01:02:03": "RoCE GID",
    "nccl GID 3 (0/302010AFFFF0000)": "RoCE GID",
    "mac 4c:aa:bb:cc:dd:ee": "MAC address",
    "mac 4C-AA-BB-CC-DD-EE": "MAC address",
    "mac 4caabbccddee": "MAC address",
    "interface id 4eaabbfffeccddee": "InfiniBand GUID",
    "docker 172.17.0.5": "IPv4 address",
    "guid 1234:5678:9abc:def0": "InfiniBand GUID",
    "guid 0x4caabb0300ccddee": "InfiniBand GUID",
    "nccl NET/0-0 (0/5634120003bbaa4c/1/25.000000)": "InfiniBand GUID",
    'phys_switch_id "5734120003bbaa4c/p1"': "InfiniBand GUID",
    "nccl NET/0-1 (0/34120003bbaa4c/1/25.000000)": "InfiniBand GUID",
    "mac reversed eeddccbbaa4c": "MAC address",
    "uuid GPU-6a1b2c3d-1234-5678-9abc-def012345678": "GPU UUID",
    "home /home/alice/x": "home directory",
    "home /home/alice": "home directory",
    "home /Users/alice": "home directory",
    "tailnet spark1.tail1234ab.ts.net": "Tailscale hostname",
    "/root/.cache/huggingface/hub/models--alice--M/snapshots/a": "Hugging Face cache path",
}
PLACEHOLDER_LINES = (
    "198.51.100.48 203.0.113.1 192.0.2.1 127.0.0.1 172.17.0.2 255.255.255.0 192.168.1.11 0.100.51.198",
    "02:00:00:00:00:01 02-00-00-00-00-01 00:00:00:00:00:00 0200:0000:0000:0001 0x0200000000000001",
    "fe80:0000:0000:0000:0000:00ff:fe00:0006 fe80::ff:fe00:6 ::ffff:203.0.113.1 2001:db8::1 [::1]:8000",
    "GID: 00:00:00:00:00:00:00:00:00:00:255:255:203:00:113:01 GID 3 (0/17100CBFFFF0000)",
    "enP7s7\\t006433C6\\t026433C6\\t0001\\t00FFFFFF GPU-00000000-0000-0000-0000-000000000001",
    "models--turboderp--DeepSeek-V4.1-Flash-EXL3 driver 13.580.173.02 0000:01:00.0 12:34:56 a::before",
    "counter 146032115322 hash 91e83f4571bb 12add3861cfd 0123456789abcdef x[::2] /home/<name>/ $HOME",
    "NET/0-0 (0/c100000000000002/1/25.000000) NET/0-1 (0/100000000000002/1/25.000000)",
)


def test_each_real_looking_form_is_flagged_by_category_only():
    for line, category in REAL_LOOKING.items():
        assert findings("f", line) == [f"f:1: {category}"], line


def test_nul_separated_text_is_scanned_by_line():
    cmdline, binary = text_of(b"python3\0-m\0server\0--host\x0010.1.2.3\0")
    assert not binary and findings("f", cmdline) == ["f:5: IPv4 address"]


def test_binary_is_scanned_by_printable_runs_without_ipv6():
    blob = (
        b"\x89PNG\r\n\x1a\n\x00\xff/home/someone/projects/x\x00\x9cbox.tail1234ab.ts.net\xfe"
        b"\x01lan 10.1.2.3\x02/ho\x03ab::cd:ef\x04"
    )
    text, binary = text_of(blob)
    assert binary
    assert findings("f", text, binary) == ["f: home directory", "f: Tailscale hostname", "f: IPv4 address"]


def test_tracked_cache_and_build_output_is_flagged_by_path_only():
    flagged = [
        "server/.ruff_cache/0.17.3/1234567890",
        "server/.ruff_cache/CACHEDIR.TAG",
        ".mypy_cache/3.12/x.json",
        "server/.pytest_cache/v/cache/nodeids",
        "server/sparkline/__pycache__/m.cpython-312.pyc",
        "web/node_modules/react/index.js",
        ".venv/bin/python",
        "web/dist/index.html",
        "server/sparkline.egg-info/PKG-INFO",
        "out/tagged/sub/blob",
    ]
    kept = ["server/sparkline/console/dist.py", "docs/dist.md", "server/sparkline/egg-info.py"]
    assert tracked_cache_findings([*flagged, "out/tagged/CACHEDIR.TAG", *kept]) == [
        f"{p}: tracked cache" for p in [*flagged, "out/tagged/CACHEDIR.TAG"]
    ]


def test_no_tracked_caches_or_build_output():
    found = tracked_cache_findings(tracked_paths())
    assert not found, "Untrack these and gitignore them:\n" + "\n".join(found)


def test_placeholders_and_lookalikes_pass():
    for line in PLACEHOLDER_LINES:
        assert findings("f", line) == [], line
