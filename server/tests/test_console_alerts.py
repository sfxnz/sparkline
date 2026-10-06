from __future__ import annotations

import pytest

from sparkline.common.schema import AlertRule, Event, Problem
from sparkline.console.alerts import DEFAULT_RULES, AlertEngine, validate_rules
from sparkline.console.demo import DemoModel

T0 = 1_791_280_000.0


class Sink:
    def __init__(self):
        self.events: list[Event] = []
        self.resolved: dict[int, float] = {}

    def add(self, ev: Event) -> Event:
        ev = ev.model_copy(update={"id": len(self.events) + 1})
        self.events.append(ev)
        return ev

    def resolve(self, ev: Event, ts: float) -> None:
        self.resolved[ev.id] = ts

    def kinds(self, rule_id: str) -> list[str]:
        return [e.kind for e in self.events if e.rule_id == rule_id]


@pytest.fixture
def eng():
    sink = Sink()
    return AlertEngine(list(DEFAULT_RULES), sink.add, sink.resolve), sink


MODEL = DemoModel("spark2", T0)  # spark2: no scripted thermal episode


def sample(ts: float, temp: float = 60.0, mask: int = 0, rdma: str = "ACTIVE", avail: int | None = None):
    s = MODEL.sample_at(ts)
    s.gpu[0].temp_c = temp
    s.gpu[0].throttle_mask = mask
    s.net[0].rdma_state = rdma
    if avail is not None:
        s.mem.available = avail
    return s


def feed(engine, start: float, seconds: int, **kw) -> float:
    for i in range(seconds):
        engine.evaluate_sample("spark2", sample(start + i, **kw))
    return start + seconds


def test_fires_once_after_for_s_and_recovers_with_hysteresis(eng):
    engine, sink = eng
    t = feed(engine, T0, 10, temp=86.0)  # 0..9 s above 85: not yet 10 s
    assert sink.kinds("gpu_temp_critical") == []
    t = feed(engine, t, 15, temp=86.0)
    fired = [e for e in sink.events if e.rule_id == "gpu_temp_critical"]
    assert len(fired) == 1, "no duplicate while the breach continues"
    ev = fired[0]
    assert ev.severity == "critical" and ev.title == "GPU temperature critical on spark2"
    assert ev.detail == "86 °C for 10 s (threshold 85 °C)" and ev.ts == T0 + 10
    # inside the hysteresis band (85 - 2% = 83.3): still active
    t = feed(engine, t, 5, temp=84.0)
    assert sink.kinds("gpu_temp_critical") == ["alert"]
    t = feed(engine, t, 1, temp=83.0)
    assert sink.kinds("gpu_temp_critical") == ["alert", "recovered"]
    assert sink.resolved[ev.id] == t - 1
    rec = sink.events[-1]
    assert rec.title == "Resolved: GPU temperature critical on spark2"
    assert rec.detail.startswith("Now 83 °C · cleared after") and rec.detail.endswith("was critical")


def test_short_breach_does_not_fire(eng):
    engine, sink = eng
    t = feed(engine, T0, 9, temp=90.0)
    t = feed(engine, t, 1, temp=70.0)
    feed(engine, t, 9, temp=90.0)
    assert sink.kinds("gpu_temp_critical") == []


def test_throttle_rule_and_power_cap_disabled(eng):
    engine, sink = eng
    t = feed(engine, T0, 30, mask=0x4)  # power cap only: default rule is disabled
    assert sink.kinds("gpu_power_cap") == [] and sink.kinds("gpu_throttle") == []
    t = feed(engine, t, 11, mask=0x4 | 0x20)
    ev = next(e for e in sink.events if e.rule_id == "gpu_throttle")
    assert ev.detail == "Thermal limit for 10 s" and ev.severity == "warning"
    feed(engine, t, 1, mask=0x4)
    assert sink.kinds("gpu_throttle") == ["alert", "recovered"]


def test_memory_below_threshold(eng):
    engine, sink = eng
    feed(engine, T0, 31, avail=6 * 2**30)
    ev = next(e for e in sink.events if e.rule_id == "mem_available_low")
    assert ev.detail == "6.0 GiB for 30 s (threshold 8.0 GiB)"


def test_link_down_only_after_link_was_up(eng):
    engine, sink = eng
    info = MODEL.info
    # spare ports (never up) never alert; rail A goes down after having been ACTIVE
    t = T0
    for i in range(3):
        engine.evaluate_sample("spark2", sample(t + i), info)
    for i in range(3, 10):
        engine.evaluate_sample("spark2", sample(t + i, rdma="DOWN"), info)
    downs = [e for e in sink.events if e.rule_id == "link_down" and e.kind == "alert"]
    assert len(downs) == 1 and downs[0].metric == "enp1s0f1np1" and "RDMA DOWN" in downs[0].detail
    engine.evaluate_sample("spark2", sample(t + 11), info)
    assert sink.kinds("link_down") == ["alert", "recovered"]


def test_link_down_alerts_after_console_restart(eng):
    """A cabled rail (IP/peer in NodeInfo) that is already down when the engine starts still alerts."""
    engine, sink = eng
    for i in range(10):
        engine.evaluate_sample("spark2", sample(T0 + i, rdma="DOWN"), MODEL.info)
    downs = [e for e in sink.events if e.rule_id == "link_down" and e.kind == "alert"]
    assert [e.metric for e in downs] == ["enp1s0f1np1"]  # spare ports (no IP, no peer) stay quiet


def test_node_offline(eng):
    engine, sink = eng
    p = Problem(message="Agent unreachable on spark2", cause="Connection refused at 10.0.0.2:9750", fix="x")
    engine.evaluate_status("spark2", "online", None, T0)
    for i in range(1, 15):  # a restart-length blip (< for_s) does not alert
        engine.evaluate_status("spark2", "offline", p, T0 + i)
    assert sink.kinds("node_offline") == []
    engine.evaluate_status("spark2", "offline", p, T0 + 16)
    assert sink.kinds("node_offline") == ["alert"]
    assert sink.events[0].severity == "critical" and "Connection refused" in sink.events[0].detail
    engine.evaluate_status("spark2", "online", None, T0 + 30)
    assert sink.kinds("node_offline") == ["alert", "recovered"]


def test_changing_a_rule_resolves_its_active_alert(eng):
    engine, sink = eng
    feed(engine, T0, 11, temp=90.0)
    active = next(e for e in sink.events if e.rule_id == "gpu_temp_critical")
    rules = [r for r in engine.rules if r.id != "gpu_temp_critical"]
    engine.set_rules(rules, T0 + 20)
    assert sink.resolved[active.id] == T0 + 20


def test_validate_rules():
    validate_rules(DEFAULT_RULES)
    with pytest.raises(ValueError, match="Duplicate"):
        validate_rules([DEFAULT_RULES[0], DEFAULT_RULES[0]])
    with pytest.raises(ValueError, match="metric and a threshold"):
        validate_rules([AlertRule(id="x", name="x", kind="threshold", metric=None, threshold=1)])
    with pytest.raises(ValueError, match="bitmask"):
        validate_rules([AlertRule(id="x", name="x", kind="throttle", threshold=0)])
    with pytest.raises(ValueError, match="for_s"):
        validate_rules([AlertRule(id="x", name="x", metric="gpu0.util", threshold=1, for_s=-1)])


def test_wildcard_metric(eng):
    engine, sink = eng
    engine.set_rules(
        [AlertRule(id="fs", name="Disk almost full", metric="fs.*.used_pct", threshold=50, for_s=0)], T0
    )
    engine.evaluate_sample("spark2", sample(T0))
    assert [e.metric for e in sink.events] == ["fs.root.used_pct"]  # boot_efi is <1% used


def test_values_carry_units_and_throttle_reasons_read_as_a_phrase():
    from sparkline.console.alerts import _sentence, fmt_value

    assert fmt_value("gpu0.power_w", 45.3) == "45.3 W"
    assert fmt_value("gpu0.sm_mhz", 1450) == "1.45 GHz" and fmt_value("gpu0.sm_mhz", 208) == "208 MHz"
    assert fmt_value("net.enp1s0f1np1.rx_bps", 2.5e9 / 8) == "2.5 Gb/s"
    assert fmt_value("disk.nvme0n1.read_bps", 412e6) == "412 MB/s"
    assert fmt_value("gpu0.temp_c", 86.4) == "86 °C"
    assert _sentence(["Thermal limit", "Overheating"]) == "Thermal limit and overheating"
    three = _sentence(["Power cap", "Thermal limit", "Overheating"])
    assert three == "Power cap, thermal limit and overheating"
