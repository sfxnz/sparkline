"""Storage: /proc/diskstats (whole devices) and filesystem capacity via statvfs."""

from __future__ import annotations

import os
import re
import time

from ...common.metrics import mount_key
from ...common.schema import DiskInfo, DiskSample, FsSample
from . import counter_delta, read, read_once

WHOLE_DISK = re.compile(r"^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+)$")
REAL_FS = {"ext4", "xfs", "btrfs", "f2fs", "zfs"}
MOUNT_REFRESH_S = 60.0


def parse_diskstats(text: str) -> dict[str, tuple[int, int, int, int, int]]:
    """-> {dev: (reads, sectors_read, writes, sectors_written, io_ticks_ms)} for whole disks only."""
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) < 14 or not WHOLE_DISK.match(f[2]):
            continue
        out[f[2]] = (int(f[3]), int(f[5]), int(f[7]), int(f[9]), int(f[12]))
    return out


def disk_rates(
    prev: tuple[int, ...] | None, cur: tuple[int, ...], elapsed: float
) -> tuple[float, float, float, float, float]:
    """-> (read_bps, write_bps, read_iops, write_iops, busy_pct). Sectors are always 512 B in diskstats."""
    if prev is None or elapsed <= 0:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    d = [counter_delta(p, c) for p, c in zip(prev, cur, strict=True)]
    return (
        d[1] * 512 / elapsed,
        d[3] * 512 / elapsed,
        d[0] / elapsed,
        d[2] / elapsed,
        min(100.0, d[4] / (elapsed * 1000) * 100),
    )


def _unescape(s: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def parse_mounts(text: str) -> list[tuple[str, str]]:
    """-> [(device, mount)] for real local filesystems; skips /boot*, /snap*, and bind duplicates
    (the shortest mount path per device wins)."""
    best: dict[str, str] = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) < 3 or f[2] not in REAL_FS:
            continue
        dev, mnt = _unescape(f[0]), _unescape(f[1])
        if mnt.startswith(("/boot", "/snap")):
            continue
        if dev not in best or len(mnt) < len(best[dev]):
            best[dev] = mnt
    return sorted(((d, m) for d, m in best.items()), key=lambda x: x[1])


class StorageCollector:
    name = "storage"

    def __init__(self) -> None:
        self.disks = sorted(parse_diskstats(read("/proc/diskstats")))
        self._prev: dict[str, tuple] = {}
        self._prev_t: float | None = None
        self._mounts: list[tuple[str, str]] = []
        self._mounts_t = 0.0
        self._refresh_mounts()

    def _refresh_mounts(self) -> None:
        self._mounts = parse_mounts(read("/proc/self/mounts"))
        self._mounts_t = time.monotonic()

    def info(self) -> list[DiskInfo]:
        out = []
        for d in self.disks:
            size = read_once(f"/sys/block/{d}/size")
            mounts = [
                m
                for dev, m in self._mounts
                if dev.startswith("/dev/") and (dev[5:] == d or os.path.exists(f"/sys/block/{d}/{dev[5:]}"))
            ]
            out.append(
                DiskInfo(
                    name=d,
                    model=read_once(f"/sys/block/{d}/device/model"),
                    size_bytes=int(size) * 512 if size else None,
                    mounts=mounts,
                )
            )
        return out

    def collect(self) -> dict:
        now = time.monotonic()
        if now - self._mounts_t > MOUNT_REFRESH_S:
            self._refresh_mounts()
        cur = parse_diskstats(read("/proc/diskstats"))
        elapsed = now - self._prev_t if self._prev_t is not None else 0.0
        self._prev_t = now
        disks = []
        for d in self.disks:
            if d not in cur:
                continue
            r = disk_rates(self._prev.get(d), cur[d], elapsed)
            disks.append(
                DiskSample(
                    name=d, read_bps=r[0], write_bps=r[1], read_iops=r[2], write_iops=r[3], busy_pct=r[4]
                )
            )
        self._prev = cur
        fs = []
        for dev, mnt in self._mounts:
            try:
                st = os.statvfs(mnt)
            except OSError:
                continue
            total = st.f_blocks * st.f_frsize
            fs.append(
                FsSample(
                    mount=mnt,
                    key=mount_key(mnt),
                    device=dev,
                    total=total,
                    used=(st.f_blocks - st.f_bfree) * st.f_frsize,
                    free=st.f_bavail * st.f_frsize,
                )
            )
        return {"disk": disks, "fs": fs}
