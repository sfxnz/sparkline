"""Collectors. Each module keeps pure parsing functions (unit-tested on fixtures) separate from IO.

A collector object exposes ``name`` and ``collect() -> dict`` whose keys are ``Sample`` field names.
"""

from __future__ import annotations

import os

_fds: dict[str, int] = {}


def read(path: str) -> str:
    """Read a /proc or /sys file, keeping its fd open between calls (pread at offset 0 re-generates it)."""
    fd = _fds.get(path)
    if fd is None:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        _fds[path] = fd
    try:
        chunks = []
        off = 0
        while True:
            b = os.pread(fd, 65536, off)
            chunks.append(b)
            if len(b) < 65536:
                break
            off += len(b)
        return b"".join(chunks).decode(errors="replace")
    except OSError:
        os.close(fd)
        del _fds[path]
        raise


def read_once(path: str) -> str | None:
    """Plain read for static files; None if missing/unreadable."""
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def counter_delta(prev: float | None, cur: float) -> float:
    """Delta of a monotonic counter; 0 on first read or counter reset."""
    if prev is None or cur < prev:
        return 0.0
    return cur - prev


def parse_psi(text: str) -> dict[str, float]:
    """/proc/pressure/* -> {"some": avg10, "full": avg10}."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        for kv in parts[1:]:
            if kv.startswith("avg10="):
                out[parts[0]] = float(kv[6:])
    return out
