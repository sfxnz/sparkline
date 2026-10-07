"""Free TCP ports for tests that run real servers: fixed port numbers collide when two test runs (or anything
else on the machine) use them at once."""

from __future__ import annotations

import socket


def free_ports(n: int) -> list[int]:
    """``n`` distinct loopback ports the kernel just handed out (all held open until every one is chosen)."""
    socks = [socket.create_server(("127.0.0.1", 0)) for _ in range(n)]
    try:
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()
