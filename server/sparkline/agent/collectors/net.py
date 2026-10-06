"""Network: interface roles/labels, ConnectX-7 counters, LAN via netdev counters.

RDMA traffic bypasses the kernel netdev counters (/proc/net/dev), so for an interface backed by an RDMA
device the throughput is netdev bytes (IP traffic) + RDMA port data (``counters/port_{rcv,xmit}_data``,
in 4-byte words). These are per PCIe function. On GB10 the two CX7 "rails" (e.g. enp1s0f1np1 and
enP2p1s0f1np1) are two functions of ONE physical port: the ethtool ``*_phy`` byte counters are identical
on both and would double count (verified: the per-function vport counters of the two rails sum to the PHY
total). The ethtool ioctl (SIOCETHTOOL, ETH_SS_STATS) supplies PHY discards / CRC errors; they too are per
physical port, so they are read only on the first function of each port (same phys_switch_id +
phys_port_name) to count each event once. Together with the RDMA error counters they are read every
SLOW_EVERY_S seconds because one GSTATS dump of ~2450 mlx5 stats costs ~1 ms of kernel CPU.
"""

from __future__ import annotations

import contextlib
import glob
import ipaddress
import logging
import os
import socket
import time

import psutil

from ...common.netutil import default_route_iface
from ...common.schema import NetIfInfo, NetSample
from ..ethtool import EthtoolStats
from . import counter_delta, read, read_once

log = logging.getLogger(__name__)

SLOW_EVERY_S = 10.0
RDMA_DATA = ("counters/port_rcv_data", "counters/port_xmit_data")  # 4-byte words
DROPS = ["rx_discards_phy", "tx_discards_phy"]
ERRORS = ["rx_crc_errors_phy"]
RDMA_ERRORS = [
    "counters/symbol_error",
    "counters/link_downed",
    "counters/port_rcv_errors",
    "counters/port_xmit_discards",
    "counters/local_link_integrity_errors",
    "hw_counters/out_of_sequence",
    "hw_counters/packet_seq_err",
    "hw_counters/local_ack_timeout_err",
]
VIRTUAL_PREFIXES = ("tailscale", "docker", "veth", "br-", "virbr")


def parse_net_dev(text: str) -> dict[str, dict[str, int]]:
    out = {}
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        v = [int(x) for x in rest.split()]
        out[name.strip()] = {
            "rx_bytes": v[0],
            "rx_errs": v[2],
            "rx_drop": v[3],
            "tx_bytes": v[8],
            "tx_errs": v[10],
            "tx_drop": v[11],
        }
    return out


def classify(name: str, rdma_ifs: set[str], default_if: str | None) -> str:
    if name in rdma_ifs:
        return "interconnect"
    if name == default_if:
        return "lan"
    if name.startswith(VIRTUAL_PREFIXES):
        return "virtual"
    if name.startswith("wl"):
        return "wireless"
    return "other"


def assign_labels(ifaces: list[tuple[str, str, bool, str]]) -> dict[str, str]:
    """ifaces: (name, role, up, sort_key). Up interconnects sorted by sort_key (PCI path) -> rail A, B..."""
    labels = {}
    rails = sorted((key, name) for name, role, up, key in ifaces if role == "interconnect" and up)
    for n, (_, name) in enumerate(rails):
        labels[name] = f"ConnectX-7 rail {chr(ord('A') + n)}"
    for name, role, _up, _ in ifaces:
        if name in labels:
            continue
        labels[name] = {"interconnect": "ConnectX-7 port (no cable)", "lan": "LAN"}.get(role, name)
    return labels


def find_peer(addrs: list[tuple[str, str]], peers: dict[str, str | list[str]]) -> str | None:
    """addrs: (ip, netmask). Returns the node_id of a configured peer with an IP on one of our subnets.

    A peer maps to one IP or a list (one per rail)."""
    for ip, mask in addrs:
        net = ipaddress.ip_network(f"{ip}/{mask}", strict=False)
        for node_id, peer_ips in peers.items():
            for peer_ip in [peer_ips] if isinstance(peer_ips, str) else peer_ips:
                try:
                    if ipaddress.ip_address(peer_ip) in net:
                        return node_id
                except ValueError:
                    continue
    return None


def parse_rdma_state(text: str) -> str:
    """'4: ACTIVE' -> 'ACTIVE'."""
    return text.partition(":")[2].strip() or text.strip()


def phy_port(name: str) -> str:
    """Physical port identity: PCI functions of one NIC port share phys_switch_id + phys_port_name."""
    sw = read_once(f"/sys/class/net/{name}/phys_switch_id")
    port = read_once(f"/sys/class/net/{name}/phys_port_name")
    return f"{sw}/{port}" if sw and port else name


def phy_owners(funcs: list[tuple[str, str, str]]) -> set[str]:
    """funcs: (sort_key, physical port, name). -> the first function (PCI path order) of each physical port,
    which alone reports the port-wide ethtool *_phy counters."""
    owner: dict[str, str] = {}
    for _key, port, name in sorted(funcs):
        owner.setdefault(port, name)
    return set(owner.values())


def rdma_map() -> dict[str, str]:
    """netdev name -> RDMA device name."""
    out = {}
    for p in glob.glob("/sys/class/infiniband/*/device/net/*"):
        parts = p.split("/")
        out[parts[-1]] = parts[4]
    return out


class _If:
    def __init__(self, info: NetIfInfo) -> None:
        self.info = info
        self.name = info.name
        self.eth: EthtoolStats | None = None
        self.rdma_base: str | None = None  # .../ports/1/ when RDMA data counters are readable
        self.prev: dict[str, float] = {}
        self.prev_t: float | None = None
        self.slow_prev: dict[str, float] = {}
        self.slow_t = -SLOW_EVERY_S
        self.speed: int | None = None  # re-read only when the link comes up (mlx5 speed reads are costly)


class NetCollector:
    name = "net"

    def __init__(
        self, peers: dict[str, str | list[str]] | None = None, include_virtual: bool = False
    ) -> None:
        peers = peers or {}
        rmap = rdma_map()
        default_if = default_route_iface()
        addrs = psutil.net_if_addrs()
        names = sorted(n for n in os.listdir("/sys/class/net") if n != "lo")
        raw = []
        for n in names:
            role = classify(n, set(rmap), default_if)
            up = read_once(f"/sys/class/net/{n}/operstate") == "up"
            key = (
                os.path.realpath(f"/sys/class/net/{n}/device")
                if os.path.exists(f"/sys/class/net/{n}/device")
                else n
            )
            raw.append((n, role, up, key))
        labels = assign_labels(raw)
        self.ifaces: list[_If] = []
        self.info: list[NetIfInfo] = []
        owners = phy_owners([(key, phy_port(n), n) for n, role, _up, key in raw if role == "interconnect"])
        for n, role, _up, _ in raw:
            v4 = [(a.address, a.netmask) for a in addrs.get(n, []) if a.family == socket.AF_INET]
            mac = next((a.address for a in addrs.get(n, []) if a.family == psutil.AF_LINK), None)
            info = NetIfInfo(
                name=n,
                role=role,
                label=labels[n],
                mac=mac,
                ipv4=[ip for ip, _ in v4],
                speed_mbps=self._speed(n),
                rdma_device=rmap.get(n),
                peer=find_peer(v4, peers) if v4 else None,
            )
            i = _If(info)
            if role == "interconnect":
                self._setup_hw_counters(i, n in owners)
            self.info.append(info)
            if include_virtual or role not in ("virtual", "wireless"):
                self.ifaces.append(i)

    @staticmethod
    def _setup_hw_counters(i: _If, phy_owner: bool) -> None:
        if i.info.rdma_device:
            base = f"/sys/class/infiniband/{i.info.rdma_device}/ports/1/"
            try:
                for c in RDMA_DATA:
                    int(read(base + c))
                i.rdma_base = base
                i.info.counter_source = "netdev_rdma"
            except (OSError, ValueError) as e:
                log.warning("%s: RDMA data counters unreadable (%s); RDMA traffic will be missed", i.name, e)
        if not phy_owner:  # another function of this physical port already reports the PHY counters
            return
        try:
            i.eth = EthtoolStats(i.name, DROPS + ERRORS)
            i.eth.read()
        except OSError as e:
            log.warning("%s: ethtool PHY counters unavailable (%s)", i.name, e)
            i.eth = None

    @staticmethod
    def _speed(name: str) -> int | None:
        try:
            v = int(read(f"/sys/class/net/{name}/speed"))
        except (OSError, ValueError):
            return None
        return v if v > 0 else None

    def collect(self) -> dict:
        netdev = parse_net_dev(read("/proc/net/dev"))
        out = []
        for i in self.ifaces:
            try:
                out.append(self._sample(i, netdev))
            except (OSError, ValueError) as e:  # one unreadable interface (mlx5 reset) never hides the rest
                log.debug("%s: %s", i.name, e)
                i.prev, i.prev_t, i.speed = {}, None, None
                out.append(NetSample(name=i.name, up=False, rx_bps=0.0, tx_bps=0.0))
        return {"net": out}

    def _sample(self, i: _If, netdev: dict[str, dict[str, int]]) -> NetSample:
        try:
            up = read(f"/sys/class/net/{i.name}/operstate").strip() == "up"
        except OSError:
            up = False
        rdma_state = rdma_rate = None
        base = f"/sys/class/infiniband/{i.info.rdma_device}/ports/1/" if i.info.rdma_device else None
        if base:
            rdma_state = parse_rdma_state(read(base + "state"))
            rdma_rate = read(base + "rate").strip() if rdma_state == "ACTIVE" else None
        if not up:  # no cable / link down: skip counter reads; restart rates from 0 when it comes back
            i.prev, i.prev_t, i.speed = {}, None, None
            return NetSample(name=i.name, up=False, rx_bps=0.0, tx_bps=0.0, rdma_state=rdma_state)
        if i.prev_t is None:
            i.speed = self._speed(i.name)
        now = time.monotonic()
        elapsed = now - i.prev_t if i.prev_t is not None else 0.0
        i.prev_t = now
        cur = self._counters(i, netdev)
        d = {k: counter_delta(i.prev.get(k), v) for k, v in cur.items()}
        i.prev = cur
        errors, drops = d["errors"], d["drops"]
        if (i.eth or i.rdma_base) and now - i.slow_t >= SLOW_EVERY_S:
            i.slow_t = now
            slow = self._slow_counters(i)
            errors += sum(counter_delta(i.slow_prev.get(k), v) for k, v in slow.items() if k != "drops")
            drops += counter_delta(i.slow_prev.get("drops"), slow["drops"]) if "drops" in slow else 0
            i.slow_prev = slow
        return NetSample(
            name=i.name,
            up=True,
            speed_mbps=i.speed,
            rx_bps=d["rx"] / elapsed if elapsed > 0 else 0.0,
            tx_bps=d["tx"] / elapsed if elapsed > 0 else 0.0,
            errors=errors,
            drops=drops,
            rdma_state=rdma_state,
            rdma_rate=rdma_rate,
        )

    @staticmethod
    def _counters(i: _If, netdev: dict[str, dict[str, int]]) -> dict[str, float]:
        """Every tick: netdev bytes/errors/drops, plus RDMA port data for RDMA-backed interfaces."""
        d = netdev.get(i.name, {})
        cur: dict[str, float] = {
            "rx": d.get("rx_bytes", 0),
            "tx": d.get("tx_bytes", 0),
            "drops": d.get("rx_drop", 0) + d.get("tx_drop", 0),
            "errors": d.get("rx_errs", 0) + d.get("tx_errs", 0),
        }
        if i.rdma_base:
            cur["rx"] += 4 * int(read(i.rdma_base + RDMA_DATA[0]))
            cur["tx"] += 4 * int(read(i.rdma_base + RDMA_DATA[1]))
        return cur

    @staticmethod
    def _slow_counters(i: _If) -> dict[str, float]:
        """Every SLOW_EVERY_S: ethtool PHY discards / CRC errors and RDMA error counters."""
        out: dict[str, float] = {}
        if i.eth is not None:
            s = i.eth.read()
            out["drops"] = sum(s[k] for k in DROPS)
            out["phy_errors"] = sum(s[k] for k in ERRORS)
        if i.info.rdma_device:
            base = f"/sys/class/infiniband/{i.info.rdma_device}/ports/1/"
            total = 0
            for c in RDMA_ERRORS:
                with contextlib.suppress(OSError, ValueError):
                    total += int(read(base + c))
            out["rdma_errors"] = total
        return out
