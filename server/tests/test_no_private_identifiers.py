from __future__ import annotations

import subprocess
from pathlib import Path, PurePosixPath

from sparkline.common.identifiers import PLACEHOLDER_ADDRESSES, detectors, scan, text_of

ROOT = Path(__file__).resolve().parents[2]

NOT_SCANNED = {
    "server/tests/test_no_private_identifiers.py": "holds this guard's own real-looking test values",
}
LOCKFILES = {
    "server/requirements.lock": "generated; versions and hashes read as addresses, so only name checks run",
    "web/package-lock.json": "generated; versions and hashes read as addresses, so only name checks run",
}
LOCKFILE_CATEGORIES = {"home directory", "Tailscale hostname", "Hugging Face cache path"}
CACHE_DIRS = {".ruff_cache", ".mypy_cache", ".pytest_cache", "__pycache__", "node_modules", ".venv", "dist"}

_TEST = "test address in the LAN and bind checks, which need non-documentation addresses"
_RANGE_START = "first address of a special-purpose range, where code lists the ranges"
CODE_ONLY_ADDRESSES = {
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
PLACEHOLDERS = (
    "RFC 5737 IPv4 (192.0.2.x, 198.51.100.x, 203.0.113.x), 2001:db8:: IPv6, 02:00:00:xx:xx:xx MACs, "
    "0200:0000:0000:xxxx GUIDs, GPU-00000000-0000-0000-0000-0000xxxxxxxx, no home directories, "
    "a public Hugging Face org"
)
DETECTORS = detectors({**PLACEHOLDER_ADDRESSES, **CODE_ONLY_ADDRESSES})


def findings(path: str, text: str, binary: bool = False) -> list[str]:
    table = [d for d in DETECTORS if path not in LOCKFILES or d.category in LOCKFILE_CATEGORIES]
    return [f"{path if binary else f'{path}:{n}'}: {cat}" for n, cat in scan(text, table, binary)]


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
    "mac after an accented letter é4caabbccddee": "MAC address",
    "mac before an accented letter 4c:aa:bb:cc:dd:eeé": "MAC address",
    "guid after an accented letter ü0x4caabb0300ccddee": "InfiniBand GUID",
    "uuid after an accented letter éGPU-6a1b2c3d-1234-5678-9abc-def012345678": "GPU UUID",
    "lan after a digit of another script \u066310.1.2.3": "IPv4 address",
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
