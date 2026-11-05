from __future__ import annotations

import sqlite3

import pytest
from platforms import gb10_without

from sparkline.agent.config import AgentConfig
from sparkline.agent.info import Collectors
from sparkline.agent.sampler import Sampler
from sparkline.common.schema import AlertRule, ConsoleSettings, Event, Problem
from sparkline.console.alerts import DEFAULT_RULES, AlertEngine, validate_rules
from sparkline.console.cluster import Cluster
from sparkline.console.demo import DemoModel
from sparkline.console.demo_fleets import FLEETS
from sparkline.console.hub import Hub
from sparkline.console.store import Store

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


WS1 = FLEETS["mixed"]["ws1"](T0, 1.0)
WS1_QUIET_T = T0 + 300
COOL = (60.0, 60.0, 60.0, 60.0)


def ws1_sample(ts: float, temps: tuple[float, ...] = COOL, masks: tuple[int, ...] = (0, 0, 0, 0)):
    s = WS1.sample_at(ts)
    for g, temp, mask in zip(s.gpu, temps, masks, strict=True):
        g.temp_c, g.throttle_mask = temp, mask
    return s


def feed_ws1(engine, start: float, seconds: int, info=WS1.info, **kw) -> float:
    for i in range(seconds):
        engine.evaluate_sample("ws1", ws1_sample(start + i, **kw), info)
    return start + seconds


def fired(events: list[Event], kind: str = "alert") -> list[tuple[str | None, str | None, str]]:
    return [(e.rule_id, e.metric, e.title) for e in sorted(events, key=lambda e: e.id) if e.kind == kind]


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


def test_a_memory_collector_that_cannot_start_fires_no_memory_alert(eng, tmp_path):
    engine, sink = eng
    collectors = Collectors(AgentConfig(node_id="spark2"), gb10_without(tmp_path, "/proc/meminfo"))
    sampler = Sampler("spark2", collectors.ordered(), ring_seconds=10)
    for i in range(61):
        engine.evaluate_sample("spark2", sampler.tick().model_copy(update={"ts": T0 + i}))
    assert [e.rule_id for e in sink.events if e.rule_id.startswith("mem_")] == []


def test_per_core_clock_alert_text_carries_units(eng):
    engine, sink = eng
    rule = AlertRule(id="core_clock", name="Core clock", metric="cpu.core1.mhz", threshold=3000, for_s=2)
    engine.set_rules([rule], T0)
    for i, mhz in enumerate([3600, 3600, 3600, 2000]):
        s = sample(T0 + i)
        s.cpu.freq_mhz[1] = mhz
        engine.evaluate_sample("spark2", s)
    fired, recovered = sink.events
    assert fired.detail == "3.60 GHz for 2 s (threshold 3.00 GHz)"
    assert recovered.detail.startswith("Now 2.00 GHz · ")


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


def test_gpu_memory_values_read_in_gib_like_system_memory():
    from sparkline.console.alerts import fmt_value

    gib = 1 << 30
    assert fmt_value("mem.used", 12.5 * gib) == "12.5 GiB"
    assert fmt_value("gpu0.vram_used", 41.3 * gib) == "41.3 GiB"
    assert fmt_value("gpu1.shared_used", 2 * gib) == "2.0 GiB"
    assert fmt_value("gpu.mem_used", 161.5 * gib) == "161.5 GiB"


def test_the_default_temperature_rules_fire_for_gpu_3_alone_on_a_four_gpu_node_and_name_it(eng):
    engine, sink = eng
    t = feed_ws1(engine, WS1_QUIET_T, 31, temps=(60.0, 60.0, 60.0, 86.0))
    assert fired(sink.events) == [
        ("gpu_temp_critical", "gpu3.temp_c", "GPU temperature critical on ws1 · GPU 3"),
        ("gpu_temp_high", "gpu3.temp_c", "GPU temperature high on ws1 · GPU 3"),
    ]
    assert sink.events[0].detail == "86 °C for 10 s (threshold 85 °C)"
    one_gpu_now = WS1.info.model_copy(update={"gpus": WS1.info.gpus[:1]})
    feed_ws1(engine, t, 1, info=one_gpu_now)
    assert fired(sink.events, "recovered") == [
        ("gpu_temp_high", "gpu3.temp_c", "Resolved: GPU temperature high on ws1 · GPU 3"),
        ("gpu_temp_critical", "gpu3.temp_c", "Resolved: GPU temperature critical on ws1 · GPU 3"),
    ]


def test_a_node_that_lists_several_gpus_names_the_gpu_while_a_failed_backend_leaves_one_in_the_sample(eng):
    engine, sink = eng
    for i in range(11):
        s = ws1_sample(WS1_QUIET_T + i, temps=(86.0, 60.0, 60.0, 60.0))
        engine.evaluate_sample("ws1", s.model_copy(update={"gpu": s.gpu[:1]}), WS1.info)
    assert fired(sink.events) == [
        ("gpu_temp_critical", "gpu0.temp_c", "GPU temperature critical on ws1 · GPU 0"),
    ]


def test_two_hot_gpus_give_two_events(eng):
    engine, sink = eng
    feed_ws1(engine, WS1_QUIET_T, 11, temps=(60.0, 88.0, 60.0, 87.0))
    assert fired(sink.events) == [
        ("gpu_temp_critical", "gpu1.temp_c", "GPU temperature critical on ws1 · GPU 1"),
        ("gpu_temp_critical", "gpu3.temp_c", "GPU temperature critical on ws1 · GPU 3"),
    ]


def test_throttle_rules_accept_globs_and_one_with_no_metric_watches_every_gpu(eng):
    engine, sink = eng
    feed_ws1(engine, WS1_QUIET_T, 11, masks=(0, 0, 0x20, 0))
    (ev,) = [e for e in sink.events if e.rule_id == "gpu_throttle"]
    assert (ev.metric, ev.title, ev.detail) == (
        "gpu2.throttle_mask",
        "GPU throttling on ws1 · GPU 2",
        "Thermal limit for 10 s",
    )
    no_metric = AlertRule(id="any", name="Clock limit", kind="throttle", threshold=0x20, for_s=0)
    engine.set_rules([no_metric], WS1_QUIET_T)
    feed_ws1(engine, WS1_QUIET_T + 20, 1, masks=(0x20, 0, 0x20, 0))
    assert fired([e for e in sink.events if e.rule_id == "any"]) == [
        ("any", "gpu0.throttle_mask", "Clock limit on ws1 · GPU 0"),
        ("any", "gpu2.throttle_mask", "Clock limit on ws1 · GPU 2"),
    ]


def test_a_glob_rule_fires_once_for_one_hot_gpu_although_the_node_total_matches_it_too(eng):
    engine, sink = eng
    engine.set_rules(
        [
            AlertRule(id="any_gpu", name="Any GPU hot", metric="gpu*.temp_c", threshold=85, for_s=0),
            AlertRule(id="any_temp", name="Anything hot", metric="*.temp_c", threshold=85, for_s=0),
        ],
        T0,
    )
    feed_ws1(engine, WS1_QUIET_T, 1, temps=(60.0, 60.0, 60.0, 90.0))
    feed(engine, T0, 1, temp=90.0)
    assert fired(sink.events) == [
        ("any_gpu", "gpu3.temp_c", "Any GPU hot on ws1 · GPU 3"),
        ("any_temp", "gpu3.temp_c", "Anything hot on ws1 · GPU 3"),
        ("any_gpu", "gpu0.temp_c", "Any GPU hot on spark2"),
        ("any_temp", "gpu0.temp_c", "Anything hot on spark2"),
    ]


def test_a_rule_naming_the_node_total_fires_on_the_total_and_so_does_a_glob_over_totals_only(eng):
    engine, sink = eng
    engine.set_rules(
        [
            AlertRule(id="total", name="Hottest GPU", metric="gpu.temp_c", threshold=85, for_s=0),
            AlertRule(id="totals", name="Node GPU temperature", metric="gpu.temp*", threshold=85, for_s=0),
        ],
        T0,
    )
    feed_ws1(engine, WS1_QUIET_T, 1, temps=(60.0, 60.0, 60.0, 90.0))
    assert fired(sink.events) == [
        ("total", "gpu.temp_c", "Hottest GPU on ws1"),
        ("totals", "gpu.temp_c", "Node GPU temperature on ws1"),
    ]


@pytest.mark.parametrize("info", [MODEL.info, None], ids=["with node info", "before the hello"])
def test_on_a_one_gpu_node_the_default_gpu_rules_read_exactly_as_before(eng, info):
    engine, sink = eng
    for i in range(11):
        engine.evaluate_sample("spark2", sample(T0 + i, temp=86.0, mask=0x20), info)
    engine.evaluate_sample("spark2", sample(T0 + 11), info)
    events = [e for e in sink.events if e.rule_id and e.rule_id.startswith("gpu_")]
    assert [(e.metric, e.title, e.detail) for e in events] == [
        ("gpu0.temp_c", "GPU temperature critical on spark2", "86 °C for 10 s (threshold 85 °C)"),
        ("gpu0.throttle_mask", "GPU throttling on spark2", "Thermal limit for 10 s"),
        (
            "gpu0.temp_c",
            "Resolved: GPU temperature critical on spark2",
            "Now 60 °C · cleared after 1 s · was critical",
        ),
        (
            "gpu0.throttle_mask",
            "Resolved: GPU throttling on spark2",
            "No longer throttling · cleared after 1 s · was warning",
        ),
    ]


GPU0_METRICS = {
    "gpu_temp_high": "gpu0.temp_c",
    "gpu_temp_critical": "gpu0.temp_c",
    "gpu_throttle": "gpu0.throttle_mask",
    "gpu_power_cap": "gpu0.throttle_mask",
}


def saved(tmp_path, rules: list[dict]) -> Cluster:
    store = Store(tmp_path / "console.sqlite")
    store.kv_set("alert_rules", rules)
    return Cluster(store, Hub(), ConsoleSettings())


def test_saved_copies_of_the_gpu0_defaults_load_watching_every_gpu_and_still_fire(tmp_path):
    rules = [{**r.model_dump(), "metric": GPU0_METRICS.get(r.id, r.metric)} for r in DEFAULT_RULES]
    next(r for r in rules if r["id"] == "gpu_temp_high")["threshold"] = 75.0
    cluster = saved(tmp_path, rules)

    loaded = {r.id: r for r in cluster.alerts.rules}
    assert {i: loaded[i].metric for i in GPU0_METRICS} == {
        "gpu_temp_high": "gpu*.temp_c",
        "gpu_temp_critical": "gpu*.temp_c",
        "gpu_throttle": "gpu*.throttle_mask",
        "gpu_power_cap": "gpu*.throttle_mask",
    }
    assert [r.model_dump() for r in cluster.alerts.rules] == [
        {**raw, "metric": loaded[raw["id"]].metric} for raw in rules
    ], "every other field stays as saved"
    for i in range(31):
        cluster.alerts.evaluate_sample("spark2", sample(T0 + i, temp=86.0), MODEL.info)
        cluster.alerts.evaluate_sample(
            "ws1", ws1_sample(WS1_QUIET_T + i, temps=(60.0, 60.0, 60.0, 86.0)), WS1.info
        )
    assert fired(cluster.store.list_events()) == [
        ("gpu_temp_critical", "gpu0.temp_c", "GPU temperature critical on spark2"),
        ("gpu_temp_critical", "gpu3.temp_c", "GPU temperature critical on ws1 · GPU 3"),
        ("gpu_temp_high", "gpu0.temp_c", "GPU temperature high on spark2"),
        ("gpu_temp_high", "gpu3.temp_c", "GPU temperature high on ws1 · GPU 3"),
    ]


def test_a_saved_rule_the_user_pointed_at_gpu0_under_its_own_id_still_watches_gpu_0_only(tmp_path):
    mine = AlertRule(id="gpu0_hot", name="GPU 0 hot", metric="gpu0.temp_c", threshold=85, for_s=0)
    cluster = saved(tmp_path, [mine.model_dump()])
    assert cluster.alerts.rules == [mine]
    cluster.alerts.evaluate_sample("ws1", ws1_sample(WS1_QUIET_T, temps=(60.0, 60.0, 60.0, 90.0)), WS1.info)
    assert cluster.store.list_events() == []
    cluster.alerts.evaluate_sample(
        "ws1", ws1_sample(WS1_QUIET_T + 1, temps=(90.0, 60.0, 60.0, 90.0)), WS1.info
    )
    assert fired(cluster.store.list_events()) == [("gpu0_hot", "gpu0.temp_c", "GPU 0 hot on ws1 · GPU 0")]


def restart(cluster: Cluster) -> Cluster:
    return Cluster(cluster.store, Hub(), ConsoleSettings())


def edited(rules: list[AlertRule], rule_id: str, **fields) -> list[AlertRule]:
    return [r.model_copy(update=fields) if r.id == rule_id else r for r in rules]


def test_a_default_rule_the_user_points_at_gpu_0_still_watches_gpu_0_only_after_restarts(tmp_path):
    cluster = Cluster(Store(tmp_path / "console.sqlite"), Hub(), ConsoleSettings())
    mine = edited(
        edited(DEFAULT_RULES, "gpu_temp_high", metric="gpu0.temp_c"),
        "gpu_throttle",
        metric="gpu0.throttle_mask",
    )
    cluster.update_rules(mine)
    cluster = restart(restart(cluster))
    assert cluster.alerts.rules == mine
    for i in range(31):
        s = ws1_sample(WS1_QUIET_T + i, temps=(60.0, 60.0, 60.0, 82.0), masks=(0, 0, 0, 0x20))
        cluster.alerts.evaluate_sample("ws1", s, WS1.info)
    assert fired(cluster.store.list_events()) == []
    for i in range(31, 62):
        s = ws1_sample(WS1_QUIET_T + i, temps=(82.0, 60.0, 60.0, 60.0), masks=(0x20, 0, 0, 0))
        cluster.alerts.evaluate_sample("ws1", s, WS1.info)
    assert fired(cluster.store.list_events()) == [
        ("gpu_throttle", "gpu0.throttle_mask", "GPU throttling on ws1 · GPU 0"),
        ("gpu_temp_high", "gpu0.temp_c", "GPU temperature high on ws1 · GPU 0"),
    ]


def test_defaults_the_user_never_touched_still_watch_every_gpu_after_a_save_and_a_restart(tmp_path):
    cluster = Cluster(Store(tmp_path / "console.sqlite"), Hub(), ConsoleSettings())
    mine = edited(DEFAULT_RULES, "mem_pressure", threshold=20.0)
    cluster.update_rules(mine)
    assert restart(cluster).alerts.rules == mine


def test_an_older_console_reads_each_saved_throttle_default_as_a_key_it_can_watch(tmp_path):
    cluster = Cluster(Store(tmp_path / "console.sqlite"), Hub(), ConsoleSettings())
    cluster.update_rules(DEFAULT_RULES)
    stored = {r["id"]: r["metric"] for r in cluster.store.kv_get("alert_rules")}
    assert {i: stored[i] for i in GPU0_METRICS} == {
        "gpu_temp_high": "gpu*.temp_c",
        "gpu_temp_critical": "gpu*.temp_c",
        "gpu_throttle": "gpu0.throttle_mask",
        "gpu_power_cap": "gpu0.throttle_mask",
    }
    assert {r.id: r.metric for r in cluster.alerts.rules if r.kind == "throttle"} == {
        "gpu_throttle": "gpu*.throttle_mask",
        "gpu_power_cap": "gpu*.throttle_mask",
    }


def test_rules_an_older_console_saved_after_a_downgrade_keep_this_consoles_choices_and_the_older_edits(
    tmp_path,
):
    cluster = Cluster(Store(tmp_path / "console.sqlite"), Hub(), ConsoleSettings())
    cluster.update_rules(edited(DEFAULT_RULES, "gpu_temp_high", metric="gpu0.temp_c"))
    older = cluster.store.kv_get("alert_rules")
    for r in older:
        if r["id"] == "mem_pressure":
            r["threshold"] = 20.0
        if r["id"] == "gpu_temp_critical":
            r["metric"] = "gpu0.temp_c"
    cluster.store.kv_set("alert_rules", older)

    loaded = {r.id: r for r in restart(cluster).alerts.rules}
    assert {i: loaded[i].metric for i in GPU0_METRICS} == {
        "gpu_temp_high": "gpu0.temp_c",
        "gpu_temp_critical": "gpu0.temp_c",
        "gpu_throttle": "gpu*.throttle_mask",
        "gpu_power_cap": "gpu*.throttle_mask",
    }
    assert loaded["mem_pressure"].threshold == 20.0


def started_with_rule_metrics(tmp_path, row: object) -> Cluster:
    store = Store(tmp_path / "console.sqlite")
    store.kv_set(
        "alert_rules", [{**r.model_dump(), "metric": GPU0_METRICS.get(r.id, r.metric)} for r in DEFAULT_RULES]
    )
    store.kv_set("alert_rule_metrics", row)
    return Cluster(store, Hub(), ConsoleSettings())


@pytest.mark.parametrize("row", [["gpu_temp_high", "gpu_throttle"], "gpu_temp_high=gpu0.temp_c", 7])
def test_a_rule_metrics_row_that_is_not_an_object_loads_the_saved_rules_as_if_it_were_absent(tmp_path, row):
    assert started_with_rule_metrics(tmp_path, row).alerts.rules == DEFAULT_RULES


def test_a_rule_metrics_entry_that_is_not_a_metric_loads_its_rule_as_if_it_had_none(tmp_path):
    row = {"gpu_temp_high": 5, "gpu_throttle": ["gpu*.throttle_mask"], "gpu_temp_critical": "gpu0.temp_c"}
    assert started_with_rule_metrics(tmp_path, row).alerts.rules == edited(
        DEFAULT_RULES, "gpu_temp_critical", metric="gpu0.temp_c"
    )


def test_a_rule_save_that_fails_part_way_leaves_the_saved_rules_as_they_were(tmp_path):
    cluster = Cluster(Store(tmp_path / "console.sqlite"), Hub(), ConsoleSettings())
    mine = edited(DEFAULT_RULES, "gpu_throttle", metric="gpu0.throttle_mask")
    cluster.update_rules(mine)
    metrics_before = cluster.store.kv_get("alert_rule_metrics")
    cluster.store.db.execute(
        "CREATE TRIGGER disk_full BEFORE INSERT ON kv WHEN NEW.key='alert_rules' "
        "BEGIN SELECT RAISE(ABORT,'disk full'); END"
    )
    with pytest.raises(sqlite3.Error, match="disk full"):
        cluster.update_rules(DEFAULT_RULES)
    assert cluster.store.kv_get("alert_rule_metrics") == metrics_before
    assert restart(cluster).alerts.rules == mine


@pytest.mark.parametrize("key", ["settings", "alert_rules", "alert_rule_metrics", "session_token_fp"])
def test_a_stored_row_that_is_not_json_starts_the_console_as_if_the_row_were_absent(tmp_path, caplog, key):
    store = Store(tmp_path / "console.sqlite")
    store.kv_set("alert_rules", [r.model_dump() for r in DEFAULT_RULES])
    store.db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, "{not json"))
    cluster = Cluster(store, Hub(), ConsoleSettings(stale_after_s=7))
    assert cluster.settings == ConsoleSettings(stale_after_s=7)
    assert cluster.alerts.rules == DEFAULT_RULES
    assert store.bind_sessions_to_token("t") is False
    assert f"Ignoring the stored {key!r} row: it is not valid JSON" in caplog.text


@pytest.mark.parametrize(
    ("key", "row"),
    [("settings", {"stale_after_s": "soon"}), ("alert_rules", [{"id": "x"}]), ("alert_rules", 7)],
)
def test_a_stored_row_of_the_wrong_shape_starts_the_console_as_if_the_row_were_absent(
    tmp_path, caplog, key, row
):
    store = Store(tmp_path / "console.sqlite")
    store.kv_set(key, row)
    cluster = Cluster(store, Hub(), ConsoleSettings(stale_after_s=7))
    assert cluster.settings == ConsoleSettings(stale_after_s=7)
    assert cluster.alerts.rules == DEFAULT_RULES
    assert f"Ignoring the stored {key!r} row" in caplog.text


UNREADABLE_ROWS = [
    ("settings", "{not json"),
    ("settings", '{"stale_after_s": "soon"}'),
    ("settings", '["x"]'),
    ("alert_rules", "{not json"),
    ("alert_rules", "7"),
    ("alert_rules", '[{"id": "x"}]'),
    ("alert_rule_metrics", "{not json"),
    ("alert_rule_metrics", '["gpu_temp_high"]'),
    ("alert_rule_metrics", '{"gpu_temp_high": 7, "gpu_temp_critical": "gpu0.temp_c"}'),
]


def stored_text(store: Store, key: str) -> str | None:
    row = store.db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def side_rows(store: Store, key: str) -> dict[str, str]:
    rows = store.db.execute("SELECT key, value FROM kv").fetchall()
    return {k: v for k, v in rows if k.startswith(f"{key}.unreadable")}


def started_with_text(tmp_path, key: str, text: str) -> Cluster:
    store = Store(tmp_path / "console.sqlite")
    store.kv_set("alert_rules", [r.model_dump() for r in DEFAULT_RULES])
    store.db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, text))
    return Cluster(store, Hub(), ConsoleSettings())


@pytest.mark.parametrize(("key", "text"), UNREADABLE_ROWS)
def test_a_stored_row_this_console_cannot_read_is_copied_to_a_side_key_and_the_log_names_it(
    tmp_path, caplog, key, text
):
    cluster = started_with_text(tmp_path, key, text)
    [(side, kept)] = side_rows(cluster.store, key).items()
    assert kept == text
    assert [r.levelname for r in caplog.records if f"{side!r}" in r.getMessage()] == ["WARNING"]


@pytest.mark.parametrize(("key", "text"), UNREADABLE_ROWS)
def test_saves_and_restarts_after_an_unreadable_row_keep_its_text_on_the_side_key(tmp_path, key, text):
    cluster = started_with_text(tmp_path, key, text)
    cluster.update_settings(ConsoleSettings(stale_after_s=9))
    cluster.update_rules(edited(DEFAULT_RULES, "mem_pressure", threshold=20.0))
    cluster = restart(cluster)
    assert stored_text(cluster.store, key) != text
    assert list(side_rows(cluster.store, key).values()) == [text]


def test_each_unreadable_text_keeps_its_own_side_row_after_this_console_saves_over_it(tmp_path):
    first, later = '{"v2": "rules a newer console saved"}', '{"v2": "rules it saved later"}'
    cluster = started_with_text(tmp_path, "alert_rules", first)
    cluster.update_rules(edited(DEFAULT_RULES, "mem_pressure", threshold=20.0))
    cluster.store.db.execute("INSERT OR REPLACE INTO kv VALUES ('alert_rules', ?)", (later,))
    cluster = restart(cluster)
    assert sorted(side_rows(cluster.store, "alert_rules").values()) == sorted([first, later])


def test_the_same_unreadable_text_on_two_starts_keeps_one_side_row(tmp_path):
    started_with_text(tmp_path, "alert_rules", "7")
    cluster = started_with_text(tmp_path, "alert_rules", "7")
    assert list(side_rows(cluster.store, "alert_rules").values()) == ["7"]


def test_rows_this_console_can_read_get_no_side_key_and_no_warning(tmp_path, caplog):
    cluster = Cluster(Store(tmp_path / "console.sqlite"), Hub(), ConsoleSettings())
    cluster.update_settings(ConsoleSettings(stale_after_s=9))
    cluster.update_rules(edited(DEFAULT_RULES, "gpu_temp_high", metric="gpu0.temp_c"))
    cluster = restart(cluster)
    assert cluster.settings == ConsoleSettings(stale_after_s=9)
    assert cluster.store.db.execute("SELECT key FROM kv WHERE key LIKE '%.unreadable%'").fetchall() == []
    assert [r for r in caplog.records if r.levelname == "WARNING"] == []


def test_an_empty_stored_settings_row_starts_the_console_on_its_configured_settings(tmp_path, caplog):
    store = Store(tmp_path / "console.sqlite")
    store.kv_set("settings", {})
    cluster = Cluster(store, Hub(), ConsoleSettings(stale_after_s=7))
    assert cluster.settings == ConsoleSettings(stale_after_s=7)
    assert side_rows(store, "settings") == {}
    assert [r for r in caplog.records if r.levelname == "WARNING"] == []
