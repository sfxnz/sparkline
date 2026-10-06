"""Read NIC statistics via the SIOCETHTOOL ioctl in pure Python (no root needed for ETH_SS_STATS).

Equivalent to ``ethtool -S <if>``. Used for ConnectX-7 PHY counters because RDMA traffic bypasses the netdev
counters in /sys/class/net/*/statistics.
"""

from __future__ import annotations

import ctypes
import fcntl
import socket
import struct

SIOCETHTOOL = 0x8946
ETHTOOL_GSTRINGS = 0x1B
ETHTOOL_GSTATS = 0x1D
ETHTOOL_GSSET_INFO = 0x37
ETH_SS_STATS = 1
ETH_GSTRING_LEN = 32
_HEADROOM = 256  # extra slots so an older kernel that ignores our count cannot overrun the buffer


def parse_gstrings(buf: bytes | bytearray, n: int, offset: int = 12) -> list[str]:
    """Names from an ethtool_gstrings payload (n fixed-width NUL-padded strings after a 12-byte header)."""
    out = []
    for i in range(n):
        raw = buf[offset + i * ETH_GSTRING_LEN : offset + (i + 1) * ETH_GSTRING_LEN]
        out.append(raw.split(b"\0", 1)[0].decode(errors="replace"))
    return out


class EthtoolStats:
    """Reads selected ETH_SS_STATS counters of one interface. The name->index map is cached and rebuilt
    if the driver's stat count changes."""

    def __init__(self, ifname: str, wanted: list[str]) -> None:
        self.ifname = ifname
        self.wanted = wanted
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._build_index()

    def close(self) -> None:
        self._sock.close()

    def _ifreq(self, buf: bytearray) -> bytes:
        """struct ifreq {char name[16]; void *data;} pointing at buf (which must then not be resized)."""
        addr = ctypes.addressof((ctypes.c_char * len(buf)).from_buffer(buf))
        return struct.pack("16sP", self.ifname.encode(), addr).ljust(40, b"\0")

    def _ioctl(self, buf: bytearray, ifreq: bytes | None = None) -> None:
        fcntl.ioctl(self._sock.fileno(), SIOCETHTOOL, ifreq or self._ifreq(buf))

    def _count(self) -> int:
        buf = bytearray(struct.pack("=IIQI", ETHTOOL_GSSET_INFO, 0, 1 << ETH_SS_STATS, 0))
        self._ioctl(buf)
        _, _, mask, n = struct.unpack("=IIQI", buf)
        if not mask & (1 << ETH_SS_STATS):
            raise OSError(f"{self.ifname}: driver exposes no ETH_SS_STATS")
        return n

    def _build_index(self) -> None:
        n = self._count()
        buf = bytearray(struct.pack("=III", ETHTOOL_GSTRINGS, ETH_SS_STATS, n)) + bytearray(
            (n + _HEADROOM) * ETH_GSTRING_LEN
        )
        self._ioctl(buf)
        n = struct.unpack_from("=I", buf, 8)[0]
        names = parse_gstrings(buf, n)
        idx = {name: i for i, name in enumerate(names)}
        missing = [w for w in self.wanted if w not in idx]
        if missing:
            raise OSError(f"{self.ifname}: ethtool stats missing {', '.join(missing)}")
        self.n = n
        self.index = {w: idx[w] for w in self.wanted}
        self._buf = bytearray(8 + (n + _HEADROOM) * 8)
        self._buf_ifreq = self._ifreq(self._buf)  # reused every read (avoids per-call ctypes work)

    def read(self) -> dict[str, int]:
        for _ in range(2):
            buf = self._buf
            struct.pack_into("=II", buf, 0, ETHTOOL_GSTATS, self.n)
            self._ioctl(buf, self._buf_ifreq)
            # Recent kernels return n_stats=0 (no data) when our count no longer matches the driver's.
            if struct.unpack_from("=I", buf, 4)[0] == self.n:
                break
            self._build_index()
        else:
            raise OSError(f"{self.ifname}: ethtool stat count keeps changing")
        return {w: struct.unpack_from("=Q", buf, 8 + i * 8)[0] for w, i in self.index.items()}
