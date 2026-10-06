"""Alert engine: evaluates rules against every flattened sample and node status changes."""

from __future__ import annotations

import fnmatch
from collections.abc import Callable
from dataclasses import dataclass

from ..common.metrics import flatten
from ..common.schema import AlertRule, Event, NodeInfo, NodeStatus, Problem, Sample
from ..common.throttle import decode

GIB = 1 << 30
DEFAULT_RULES: list[AlertRule] = [
    AlertRule(id="gpu_temp_high", name="GPU temperature high", metric="gpu0.temp_c", threshold=80, for_s=30),
    AlertRule(
        id="gpu_temp_critical",
        name="GPU temperature critical",
        metric="gpu0.temp_c",
        threshold=85,
        for_s=10,
        severity="critical",
    ),
    # For kind="throttle", threshold is the bitmask of NVML clocks-event reasons to watch.
    AlertRule(
        id="gpu_throttle",
        name="GPU throttling",
        kind="throttle",
        metric="gpu0.throttle_mask",
        threshold=0x8 | 0x20 | 0x40 | 0x80,
        for_s=10,
    ),
    AlertRule(
        id="gpu_power_cap",
        name="Power capping",
        kind="throttle",
        metric="gpu0.throttle_mask",
        threshold=0x4,
        for_s=10,
        severity="info",
        enabled=False,
    ),
    AlertRule(
        id="mem_available_low",
        name="Memory running low",
        metric="mem.available",
        op="<",
        threshold=8 * GIB,
        for_s=30,
    ),
    AlertRule(id="mem_pressure", name="Memory pressure", metric="mem.psi_full", threshold=10, for_s=30),
    # for_s rides out a routine agent restart (one reconnect cycle) without a critical alert
    AlertRule(id="node_offline", name="Node offline", kind="node_offline", for_s=15, severity="critical"),
    AlertRule(id="link_down", name="Interconnect link down", kind="link_down", for_s=5),
    AlertRule(id="disk_full", name="Disk almost full", metric="fs.root.used_pct", threshold=90, for_s=60),
    AlertRule(
        id="nvme_temp_high",
        name="NVMe temperature high",
        metric="temp.nvme.composite",
        threshold=70,
        for_s=60,
    ),
]


def validate_rules(rules: list[AlertRule]) -> None:
    """Raise ValueError with a human-readable message for an invalid rule set."""
    seen: set[str] = set()
    for r in rules:
        if not r.id.strip():
            raise ValueError("Every rule needs an id")
        if r.id in seen:
            raise ValueError(f"Duplicate rule id {r.id!r}")
        seen.add(r.id)
        if r.for_s < 0:
            raise ValueError(f"Rule {r.id!r}: for_s must be >= 0")
        if r.kind == "threshold" and (not r.metric or r.threshold is None):
            raise ValueError(f"Rule {r.id!r}: threshold rules need a metric and a threshold")
        if r.kind == "throttle" and (r.threshold is None or int(r.threshold) <= 0):
            raise ValueError(f"Rule {r.id!r}: throttle rules need a non-zero bitmask in threshold")


def _bitrate(bytes_per_s: float) -> str:
    bits = bytes_per_s * 8
    for unit, scale in (("Gb/s", 1e9), ("Mb/s", 1e6), ("kb/s", 1e3)):
        if bits >= scale:
            return f"{bits / scale:.3g} {unit}"
    return f"{bits:.0f} b/s"


def fmt_value(key: str, v: float) -> str:
    """A metric value with its unit, as the rule editor shows it (web/src/views/alerts/rules.ts unitFor)."""
    if key.endswith("temp_c") or key.startswith("temp."):
        return f"{v:.0f} °C"
    if key.startswith("mem.") and not key.startswith("mem.psi") and not key.endswith("_pct"):
        return f"{v / GIB:.1f} GiB"
    if key.endswith(("_pct", ".util")) or ".psi" in key:
        return f"{v:.1f} %"
    if key.endswith("power_w"):
        return f"{v:.1f} W"
    if key.endswith("_mhz"):
        return f"{v / 1000:.2f} GHz" if v >= 1000 else f"{v:.0f} MHz"
    if key.endswith("_bps") and key.startswith("disk."):
        return f"{v / 1e6:.3g} MB/s"
    if key.endswith("_bps"):
        return _bitrate(v)
    return f"{v:g}"


def _sentence(titles: list[str]) -> str:
    """["Thermal limit", "Overheating"] -> "Thermal limit and overheating" (a phrase, not a list)."""
    words = [t if i == 0 else t[:1].lower() + t[1:] for i, t in enumerate(titles)]
    if len(words) <= 1:
        return "".join(words) or "Clock limit"
    return f"{', '.join(words[:-1])} and {words[-1]}"


def _dur(s: float) -> str:
    return f"{s:.0f} s" if s < 120 else f"{s / 60:.0f} min"


@dataclass
class _State:
    start: float | None = None  # first ts of the current breach
    active: Event | None = None  # fired alert event (with id)


class AlertEngine:
    def __init__(
        self, rules: list[AlertRule], add: Callable[[Event], Event], resolve: Callable[[Event, float], None]
    ):
        """``add`` persists+broadcasts an event and returns it with an id; ``resolve`` marks one resolved."""
        self.rules = rules
        self._add = add
        self._resolve = resolve
        self._st: dict[tuple[str, str, str], _State] = {}
        self._link_seen: set[tuple[str, str]] = set()  # (node, iface) seen up+ACTIVE

    def set_rules(self, rules: list[AlertRule], now: float) -> None:
        new = {r.id: r for r in rules}
        old = {r.id: r for r in self.rules}
        for key in list(self._st):
            rid = key[0]
            if new.get(rid) != old.get(rid):
                st = self._st.pop(key)
                if st.active:
                    self._resolve(st.active, now)
        self.rules = rules

    def _applies(self, r: AlertRule, node: str) -> bool:
        return r.enabled and (r.nodes is None or node in r.nodes)

    def evaluate_sample(self, node: str, s: Sample, info: NodeInfo | None = None) -> None:
        flat = flatten(s)
        for r in self.rules:
            if not self._applies(r, node):
                continue
            if r.kind == "threshold" and r.metric and r.threshold is not None:
                keys = fnmatch.filter(flat, r.metric) if "*" in r.metric else [r.metric]
                margin = abs(r.threshold) * 0.02 or 1.0
                for key in keys:
                    v = flat.get(key)
                    if v is None:
                        continue  # metric absent this tick (collector error): keep state
                    if r.op == ">":
                        breach, clear = v > r.threshold, v < r.threshold - margin
                    else:
                        breach, clear = v < r.threshold, v > r.threshold + margin
                    self._step(r, node, key, v, breach, clear, s.ts)
            elif r.kind == "throttle" and r.threshold:
                key = r.metric or "gpu0.throttle_mask"
                v = flat.get(key)
                if v is None:
                    continue
                hit = int(v) & int(r.threshold)
                self._step(r, node, key, v, bool(hit), not hit, s.ts)
            elif r.kind == "link_down":
                inter = {n.name for n in info.net if n.role == "interconnect"} if info else None
                # cabled (IP or peer configured) = expected up, even if it was already down when we started
                cabled = (
                    {n.name for n in info.net if n.role == "interconnect" and (n.ipv4 or n.peer)}
                    if info
                    else set()
                )
                for n in s.net:
                    if inter is not None and n.name not in inter:
                        continue
                    if inter is None and n.rdma_state is None:
                        continue
                    good = n.up and n.rdma_state in (None, "ACTIVE")
                    if good:
                        self._link_seen.add((node, n.name))
                    was_up = n.name in cabled or (node, n.name) in self._link_seen
                    self._step(
                        r,
                        node,
                        n.name,
                        0.0 if not good else 1.0,
                        was_up and not good,
                        good,
                        s.ts,
                        detail=f"{n.name}: link {'up' if n.up else 'down'}, RDMA {n.rdma_state or '-'}",
                    )

    def evaluate_status(self, node: str, status: NodeStatus, problem: Problem | None, now: float) -> None:
        for r in self.rules:
            if r.kind == "node_offline" and self._applies(r, node):
                detail = f"{problem.message}. {problem.cause}" if problem else f"{node} is {status}"
                self._step(
                    r, node, "", 0.0, status in ("offline", "error"), status == "online", now, detail=detail
                )

    def _step(
        self,
        r: AlertRule,
        node: str,
        key: str,
        v: float,
        breach: bool,
        clear: bool,
        ts: float,
        detail: str | None = None,
    ) -> None:
        st = self._st.setdefault((r.id, node, key), _State())
        if st.active is None:
            if not breach:
                st.start = None
                return
            if st.start is None:
                st.start = ts
            if ts - st.start >= r.for_s:
                st.active = self._add(
                    Event(
                        id=0,
                        ts=ts,
                        node_id=node,
                        severity=r.severity,
                        kind="alert",
                        rule_id=r.id,
                        title=f"{r.name} on {node}",
                        detail=detail or self._detail(r, key, v),
                        metric=key or None,
                        value=v if r.kind in ("threshold", "throttle") else None,
                    )
                )
        elif clear:
            ev, st.active, st.start = st.active, None, None
            self._resolve(ev, ts)
            if r.kind in ("threshold",):
                now_txt = f"Now {fmt_value(key, v)}"
            elif r.kind == "throttle":
                now_txt = "No longer throttling"
            else:
                now_txt = detail or "Back to normal"
            self._add(
                Event(
                    id=0,
                    ts=ts,
                    node_id=node,
                    severity="info",
                    kind="recovered",
                    rule_id=r.id,
                    title=f"Resolved: {r.name} on {node}",
                    detail=f"{now_txt} · cleared after {_dur(ts - ev.ts)} · was {ev.severity}",
                    metric=key or None,
                    value=v if r.kind == "threshold" else None,
                )
            )

    def _detail(self, r: AlertRule, key: str, v: float) -> str:
        if r.kind == "throttle":
            titles = [x["title"] for x in decode(int(v) & int(r.threshold or 0))]
            return f"{_sentence(titles)} for {_dur(r.for_s)}"
        assert r.threshold is not None
        return f"{fmt_value(key, v)} for {_dur(r.for_s)} (threshold {fmt_value(key, r.threshold)})"
