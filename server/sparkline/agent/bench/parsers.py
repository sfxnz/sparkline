"""Parsers for payload JSON lines and the text/JSON output of perftest, fio and nccl-tests."""

from __future__ import annotations

import json
import re
from typing import Any

PAYLOAD_KEYS = ("progress", "result", "series", "gauge", "log", "ready", "error", "live", "detail")


def parse_json_line(line: str) -> dict[str, Any] | None:
    """A payload protocol message, or None for plain output (which goes to the log)."""
    s = line.strip()
    if not s.startswith("{"):
        return None
    try:
        msg = json.loads(s)
    except ValueError:
        return None
    if not isinstance(msg, dict) or not any(k in msg for k in PAYLOAD_KEYS):
        return None
    return msg


_NUM = r"[-+]?\d+(?:\.\d+)?"


def parse_perftest_bw(text: str) -> dict[str, float] | None:
    """ib_*_bw: the row under '#bytes #iterations BW peak[Gb/sec] BW average[Gb/sec] MsgRate[Mpps]'."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "#bytes" in line and "BW average" in line:
            gbits = "Gb/sec" in line
            for row in lines[i + 1 :]:
                cols = row.split()
                if len(cols) >= 4 and all(re.fullmatch(_NUM, c) for c in cols[:4]):
                    out = {
                        "bytes": float(cols[0]),
                        "iterations": float(cols[1]),
                        "peak": float(cols[2]),
                        "average": float(cols[3]),
                    }
                    if len(cols) >= 5 and re.fullmatch(_NUM, cols[4]):
                        out["msg_rate_mpps"] = float(cols[4])
                    if not gbits:  # MiB/s -> Gb/s
                        out["peak"] = out["peak"] * 2**20 * 8 / 1e9
                        out["average"] = out["average"] * 2**20 * 8 / 1e9
                    return out
            return None
    return None


def parse_perftest_lat(text: str) -> dict[str, float] | None:
    """ib_*_lat (iteration mode): t_min/t_max/t_typical/t_avg/t_stdev/99%/99.9% in usec."""
    names = {
        "t_min": "min",
        "t_max": "max",
        "t_typical": "typical",
        "t_avg": "avg",
        "t_stdev": "stdev",
        "99%": "p99",
        "99.9%": "p999",
    }
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "#bytes" in line and "t_" in line and "[usec]" in line:
            heads = re.findall(r"(#bytes|#iterations|t_\w+|99\.9%|99%)", line)
            for row in lines[i + 1 :]:
                cols = row.split()
                if len(cols) >= len(heads) and all(re.fullmatch(_NUM, c) for c in cols[: len(heads)]):
                    out: dict[str, float] = {}
                    for h, v in zip(heads, cols, strict=False):
                        key = {"#bytes": "bytes", "#iterations": "iterations"}.get(h) or names.get(h)
                        if key:
                            out[key] = float(v)
                    return out if "typical" in out or "avg" in out else None
            return None
    return None


def parse_fio_json(text: str) -> list[dict[str, Any]]:
    """fio --output-format=json -> one dict per job: name, rw, MB/s, IOPS, p99 latency (us)."""
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in fio output")
    data = json.loads(text[start:])
    out = []
    for job in data.get("jobs", []):
        for side in ("read", "write"):
            d = job.get(side) or {}
            if not d.get("io_bytes"):
                continue
            pct = (d.get("clat_ns") or {}).get("percentile") or {}
            p99 = pct.get("99.000000")
            out.append(
                {
                    "name": job.get("jobname"),
                    "side": side,
                    "mb_s": d.get("bw_bytes", d.get("bw", 0) * 1024) / 1e6,
                    "iops": float(d.get("iops", 0.0)),
                    "p99_us": p99 / 1000 if p99 is not None else None,
                    "runtime_ms": d.get("runtime"),
                }
            )
    return out


def parse_nccl_tests(text: str) -> list[dict[str, float]]:
    """nccl-tests *_perf table (out-of-place columns): size, count, time_us, algbw, busbw (GB/s).

    Column positions come from the '#  size  count  type  redop  [root]  time  algbw  busbw ...' header,
    which differs between nccl-tests versions.
    """
    t_idx = None
    rows = []
    for line in text.splitlines():
        if line.startswith("#"):
            heads = line.lstrip("#").split()
            if heads[:2] == ["size", "count"] and "time" in heads:
                t_idx = heads.index("time")
            continue
        cols = line.split()
        if t_idx is None or len(cols) < t_idx + 3 or not cols[0].isdigit():
            continue
        try:
            rows.append(
                {
                    "size": float(cols[0]),
                    "count": float(cols[1]),
                    "time_us": float(cols[t_idx]),
                    "algbw": float(cols[t_idx + 1]),
                    "busbw": float(cols[t_idx + 2]),
                }
            )
        except ValueError:
            continue
    return rows
