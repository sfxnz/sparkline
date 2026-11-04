from __future__ import annotations

import ipaddress
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCOPE = (
    "server/tests/fixtures/",
    "web/src/test/fixtures/",
    ":(glob)server/sparkline/console/demo*.py",
    "README.md",
    "DEV.md",
    "docs/",
)

LOOPBACK_AND_UNSPECIFIED = ("127.0.0.0/8", "0.0.0.0/32")
RFC5737_DOC_NETS = ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
DOCKER_DEFAULT_BRIDGE = ("172.17.0.1/32",)
TAILSCALE_PLACEHOLDERS = ("100.64.0.0/24",)  # CGNAT (RFC 6598) has no documentation range
IPV4_ALLOWED = [
    ipaddress.ip_network(n)
    for n in LOOPBACK_AND_UNSPECIFIED + RFC5737_DOC_NETS + DOCKER_DEFAULT_BRIDGE + TAILSCALE_PLACEHOLDERS
]
LAN_DOC_EXAMPLES = {"192.168.1.11", "192.168.1.12", "10.0.8.2", "10.0.9.2"}
PUBLIC_HF_ORGS = {"deepseek-ai", "meta-llama", "mistralai", "nvidia", "Qwen", "turboderp"}
PLACEHOLDERS = (
    "RFC 5737 IPv4 (192.0.2.x, 198.51.100.x, 203.0.113.x), 02:00:00:xx:xx:xx MACs, "
    "0200:0000:0000:xxxx GUIDs, no /home/<name>/ paths, a public Hugging Face org"
)

OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
IPV4 = re.compile(rf"(?<![\d.]){OCTET}(?:\.{OCTET}){{3}}(?![\d]|\.\d)")
MAC = re.compile(r"(?<![\w:])(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}(?![\w:])")
GUID = re.compile(r"(?<![\w:])[0-9A-Fa-f]{4}(?::[0-9A-Fa-f]{4}){3}(?![\w:])")
HOME = re.compile(r"/home/[\w.-]+/")
HF_CACHE = re.compile(r"models--([\w.-]+?)--")


def _is_netmask(addr: ipaddress.IPv4Address) -> bool:
    return "01" not in f"{int(addr):032b}"


def _ipv4_ok(text: str) -> bool:
    addr = ipaddress.IPv4Address(text)
    return text in LAN_DOC_EXAMPLES or any(addr in n for n in IPV4_ALLOWED) or _is_netmask(addr)


def _mac_ok(text: str) -> bool:
    mac = text.lower()
    return mac.startswith("02:00:00:") or mac in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff")


def _guid_ok(text: str) -> bool:
    return text.lower().startswith("0200:0000:0000:") or text == "0000:0000:0000:0000"


def findings(path: str, text: str) -> list[str]:
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        bad = ["IPv4 address" for m in IPV4.findall(line) if not _ipv4_ok(m)]
        bad += ["MAC address" for m in MAC.findall(line) if not _mac_ok(m)]
        bad += ["InfiniBand GUID" for m in GUID.findall(line) if not _guid_ok(m)]
        bad += ["home directory" for _ in HOME.findall(line)]
        bad += ["Hugging Face cache path" for org in HF_CACHE.findall(line) if org not in PUBLIC_HF_ORGS]
        out += [f"{path}:{n}: {b}" for b in bad]
    return out


def tracked_text_files() -> dict[str, str]:
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", *SCOPE], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode()
    files = {}
    for rel in filter(None, listed.split("\0")):
        p = ROOT / rel
        if p.is_symlink() or not p.is_file():
            continue
        try:
            files[rel] = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    return files


def test_scope_covers_the_demo_docs_and_fixtures():
    files = tracked_text_files()
    for rel in (
        "README.md",
        "docs/REVIEW.md",
        "server/sparkline/console/demo.py",
        "server/tests/fixtures/agent/cmdline_exl3",
        "web/src/test/fixtures/sample.json",
    ):
        assert rel in files


def test_no_real_identifiers_in_docs_demo_or_fixtures():
    found = [f for rel, text in sorted(tracked_text_files().items()) for f in findings(rel, text)]
    assert not found, f"Use placeholders ({PLACEHOLDERS}):\n" + "\n".join(found)


def test_findings_flag_real_looking_values_and_pass_placeholders():
    real = (
        "lan 10.1.2.3\nmac 4c:aa:bb:cc:dd:ee\nguid 1234:5678:9abc:def0\n"
        "/home/alice/x\n/root/.cache/huggingface/hub/models--alice--M/snapshots/a\n"
    )
    assert [f.split(": ", 1)[1] for f in findings("f", real)] == [
        "IPv4 address",
        "MAC address",
        "InfiniBand GUID",
        "home directory",
        "Hugging Face cache path",
    ]
    placeholders = (
        "198.51.100.48 203.0.113.1 192.0.2.1 127.0.0.1 172.17.0.1 100.64.0.113 255.255.255.0 192.168.1.11\n"
        "02:00:00:00:00:01 00:00:00:00:00:00 0200:0000:0000:0001 fe80:0000:0000:0000:0000:00ff:fe00:0006\n"
        "models--turboderp--DeepSeek-V4.1-Flash-EXL3 driver 13.580.173.02 0000:01:00.0\n"
    )
    assert findings("f", placeholders) == []
