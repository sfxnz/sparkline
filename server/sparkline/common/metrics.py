"""Flatten a Sample into scalar metric keys (see PLAN.md "Flattened metric keys").

Used by agent rollups/history, console alert evaluation and the console live buffer. ``None`` values are
omitted so unsupported metrics never masquerade as 0.
"""

from __future__ import annotations

from .schema import Sample

# Keys whose rollup keeps the last value in a bucket instead of the average (monotonic counters).
COUNTER_KEYS_SUFFIX = (".energy_j",)
# Keys whose rollup keeps the bitwise OR of values in a bucket.
BITMASK_KEYS_SUFFIX = (".throttle_mask",)


def mount_key(mount: str) -> str:
    """'/' -> 'root', '/data/models' -> 'data_models'."""
    stripped = mount.strip("/")
    return "root" if not stripped else stripped.replace("/", "_")


def flatten(s: Sample) -> dict[str, float]:
    out: dict[str, float] = {}

    def put(key: str, value: float | int | None) -> None:
        if value is not None:
            out[key] = float(value)

    for g in s.gpu:
        p = f"gpu{g.index}."
        put(p + "util", g.util)
        put(p + "sm_mhz", g.sm_mhz)
        put(p + "temp_c", g.temp_c)
        put(p + "power_w", g.power_w)
        put(p + "energy_j", g.energy_j)
        put(p + "throttle_mask", g.throttle_mask)
        put(p + "power_capped_pct", g.power_capped_pct)
        put(p + "thermal_capped_pct", g.thermal_capped_pct)

    m = s.mem
    for name in ("used", "available", "gpu", "anon", "cache", "shmem", "kernel", "other", "swap_used"):
        put(f"mem.{name}", getattr(m, name))
    put("mem.psi_some", m.psi_some)
    put("mem.psi_full", m.psi_full)
    if m.total:
        put("mem.used_pct", 100.0 * m.used / m.total)

    c = s.cpu
    put("cpu.util", c.util)
    put("cpu.perf_util", c.perf_util)
    put("cpu.eff_util", c.eff_util)
    put("cpu.load1", c.load1)
    put("cpu.psi_some", c.psi_some)
    for i, u in enumerate(c.per_core):
        put(f"cpu.core{i}.util", u)
    for i, f in enumerate(c.freq_mhz):
        put(f"cpu.core{i}.mhz", f)

    for n in s.net:
        p = f"net.{n.name}."
        put(p + "rx_bps", n.rx_bps)
        put(p + "tx_bps", n.tx_bps)
        put(p + "errors", n.errors)
        put(p + "drops", n.drops)
        put(p + "up", 1.0 if n.up else 0.0)

    for d in s.disk:
        p = f"disk.{d.name}."
        put(p + "read_bps", d.read_bps)
        put(p + "write_bps", d.write_bps)
        put(p + "read_iops", d.read_iops)
        put(p + "write_iops", d.write_iops)
        put(p + "busy_pct", d.busy_pct)

    for f in s.fs:
        put(f"fs.{f.key}.used", f.used)
        if f.used + f.free:  # like df: free is what non-root can still use, so reserved blocks count as used
            put(f"fs.{f.key}.used_pct", 100.0 * f.used / (f.used + f.free))

    for t in s.temps:
        put(f"temp.{t.id}", t.c)

    return out
