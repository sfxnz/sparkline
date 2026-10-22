"""Bind-address safety shared by sparkline-agent and sparkline.

Public API: ``resolve_bind(bind, allow_public) -> str`` and ``is_private(ip)``.
"""

from __future__ import annotations

import ipaddress
import socket
import time

import psutil

_PRIVATE_NETS = [
    ipaddress.ip_network(n)
    for n in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",  # RFC1918
        "100.64.0.0/10",  # CGNAT (Tailscale)
        "127.0.0.0/8",
        "169.254.0.0/16",  # loopback, link-local
        "::1/128",
        "fe80::/10",
        "fc00::/7",  # IPv6 loopback, link-local, ULA
    )
]


def is_private(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return any(addr.version == n.version and addr in n for n in _PRIVATE_NETS)


def default_route_iface(route_text: str | None = None) -> str | None:
    """Interface of the lowest-metric IPv4 default route (from /proc/net/route)."""
    if route_text is None:
        try:
            with open("/proc/net/route") as f:
                route_text = f.read()
        except OSError:
            return None
    best: tuple[int, str] | None = None
    for line in route_text.splitlines()[1:]:
        cols = line.split()
        if len(cols) < 8 or cols[1] != "00000000" or cols[7] != "00000000":
            continue
        metric = int(cols[6])
        if best is None or metric < best[0]:
            best = (metric, cols[0])
    return best[1] if best else None


def iface_ipv4(name: str) -> list[str]:
    return [a.address for a in psutil.net_if_addrs().get(name, []) if a.family == socket.AF_INET]


def resolve_bind(bind: str, allow_public: bool = False, auto_wait_s: float = 120.0) -> str:
    """Turn a configured bind value into a concrete IP, refusing unsafe binds.

    "auto" -> IPv4 of the default-route interface, waiting up to ``auto_wait_s`` for it to appear (at boot
    network-online.target can be reached by other links before the LAN has its route). 0.0.0.0/:: and
    public addresses are refused unless ``allow_public``. Raises ValueError with an actionable message.
    """
    bind = bind.strip()
    if bind == "auto":
        deadline = time.monotonic() + auto_wait_s
        while True:
            iface = default_route_iface()
            ips = iface_ipv4(iface) if iface else []
            if ips or time.monotonic() >= deadline:
                break
            time.sleep(1)
        if not ips:
            raise ValueError(
                'bind = "auto" could not find an IPv4 address on the default-route interface'
                f" ({iface or 'no default route'}) after {auto_wait_s:g} s. Set bind to an explicit LAN IP."
            )
        ip = ips[0]
    else:
        try:
            ip = str(ipaddress.ip_address(bind))
        except ValueError:
            try:
                ip = socket.gethostbyname(bind)
            except OSError as e:
                raise ValueError(f"bind address {bind!r} is not an IP and does not resolve: {e}") from None
    if ipaddress.ip_address(ip).is_unspecified:
        if not allow_public:
            raise ValueError(
                f"Refusing to bind {ip} (all interfaces, including any public ones). Use a LAN IP or "
                '"auto", or pass --allow-public if you really mean it.'
            )
        return ip
    if not is_private(ip) and not allow_public:
        raise ValueError(
            f"Refusing to bind public address {ip}. Sparkline is LAN-only; use a private address "
            "(RFC1918, 100.64/10, loopback, link-local) or pass --allow-public."
        )
    return ip
