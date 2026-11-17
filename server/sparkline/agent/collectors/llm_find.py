"""Which listening sockets on this node may be asked whether they are a model server, and which process
each one belongs to. Pure: text and rows in, candidates and hints out."""

from __future__ import annotations

import ipaddress
import re
import sys
from collections.abc import Mapping, Sequence
from typing import NamedTuple

from ...common.schema import ProcSample
from .procs import container_names


class Listener(NamedTuple):
    host: str  # the address to connect to: the bound one, or loopback for a socket bound to every address
    port: int
    inode: int | None  # identifies this listening socket, so a restarted server reads as a new one


def _connect_host(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str:
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is None:
            return "::1" if ip.is_unspecified else str(ip)
        ip = ip.ipv4_mapped
    return "127.0.0.1" if ip.is_unspecified else str(ip)


def parse_proc_net_tcp(text: str) -> list[Listener]:
    """/proc/net/tcp or tcp6 rows in state 0A (LISTEN). Any user may read them, and they name every
    listener, while a socket's pid is hidden from an unprivileged agent."""
    out = []
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) < 10 or f[3] != "0A":
            continue
        try:
            raw, _, port = f[1].rpartition(":")
            # The kernel prints each 32-bit word of the address in host byte order.
            words = [int(raw[i : i + 8], 16).to_bytes(4, sys.byteorder) for i in range(0, len(raw), 8)]
            host = _connect_host(ipaddress.ip_address(b"".join(words)))
            out.append(Listener(host, int(port, 16), int(f[9])))
        except ValueError:
            continue
    return out


class ProcHint(NamedTuple):
    pid: int
    container: str | None
    gpu_mem: int | None  # of the process, or of every process in its container
    trt: bool  # its arguments name trtllm-serve


class Hints(NamedTuple):
    by_port: Mapping[int, ProcHint]
    by_container: Mapping[str, ProcHint]


NO_HINTS = Hints({}, {})
_PORT_ARG = re.compile(r"(?:^|\s)--port(?:=|\s+)(\d{1,5})(?=\s|$)")
_TRT_ARG = re.compile(r"(?:^|[\s/])trtllm-serve(?=\s|$)")


def hints_from_procs(rows: Sequence[ProcSample], cmdlines: Mapping[int, str]) -> Hints:
    """``cmdlines`` holds each row's whole command line: a server's ``--port`` often sits past the cut of
    ``ProcSample.cmdline``, behind a long model path. Of two rows naming one port (tensor-parallel ranks),
    the one holding more GPU memory is the server."""
    in_container: dict[str, list[ProcSample]] = {}
    for r in rows:
        if r.container:
            in_container.setdefault(r.container, []).append(r)

    def hint(r: ProcSample) -> ProcHint:
        group = in_container.get(r.container or "", [r])
        held = [g.gpu_mem for g in group if g.gpu_mem is not None]
        trt = any(_TRT_ARG.search(cmdlines.get(g.pid, g.cmdline)) for g in group)
        return ProcHint(r.pid, r.container, sum(held) if held else None, trt)

    by_port: dict[int, ProcHint] = {}
    by_container: dict[str, ProcHint] = {}
    for r in sorted(rows, key=lambda r: -(r.gpu_mem or 0)):
        if m := _PORT_ARG.search(cmdlines.get(r.pid, r.cmdline)):
            by_port.setdefault(int(m.group(1)), hint(r))
        if r.container:
            by_container.setdefault(r.container, hint(r))
    return Hints(by_port, by_container)


def published_ports(containers: list[dict]) -> dict[int, str]:
    """Docker /containers/json -> published TCP port -> container name, as process rows name it."""
    names = container_names(containers)
    out: dict[int, str] = {}
    for c in containers:
        for p in c.get("Ports") or []:
            if p.get("Type") == "tcp" and isinstance(p.get("PublicPort"), int):
                out.setdefault(p["PublicPort"], names[c["Id"]])
    return out


def candidates(
    listeners: list[Listener] | None,  # None: this platform has no listen table to read
    default_ports: frozenset[int],
    argv_ports: frozenset[int],
    docker_ports: frozenset[int],
    target_ports: frozenset[int],
    discover: bool,
) -> list[Listener]:
    """The sockets worth one identification request, one per port. A port is a candidate only when
    something names it (a server's default port, a ``--port`` argument, a Docker published port, or
    agent.toml) and it is listening. Every host is loopback or an address this node listens on, so a
    request can only reach this node. With no listen table, a refused connection is the answer."""
    if listeners is None:
        ports = target_ports | (default_ports | argv_ports if discover else frozenset())
        return [Listener("127.0.0.1", p, None) for p in sorted(ports)]
    named = target_ports | (default_ports | argv_ports | docker_ports if discover else frozenset())
    best: dict[int, Listener] = {}
    for found in sorted(listeners, key=lambda li: (":" in li.host, li.host != "127.0.0.1")):
        if found.port in named:
            best.setdefault(found.port, found)
    return [best[p] for p in sorted(best)]
