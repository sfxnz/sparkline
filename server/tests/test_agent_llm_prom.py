"""Model-server expositions -> canonical readings.

acmeserve_metrics.txt is recorded from a live server. The vLLM, SGLang and llama.cpp files are written
from the metric names in each project's documentation and source, not recorded from a running server.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from sparkline.agent.collectors.prom import (
    FIELD_RULES,
    Scrape,
    Window,
    histogram_quantile,
    parse_exposition,
    pick_namespace,
    reduce_scrape,
)
from sparkline.common.schema import LLM_FIELDS

FIXTURES = Path(__file__).parent / "fixtures" / "agent" / "llm"
RECORDED = (FIXTURES / "acmeserve_metrics.txt").read_text()
FROM_DOCUMENTATION = {
    name: (FIXTURES / f"{name}_metrics.txt").read_text() for name in ("vllm", "sglang", "llamacpp")
}


def scrape(text: str, t: float = 0.0) -> Scrape:
    series = parse_exposition(text)
    ns = pick_namespace(series)
    assert ns is not None
    return reduce_scrape(series, ns, t)


def readings(*texts: str, every_s: float = 2.0) -> dict[str, float]:
    window = Window()
    for i, text in enumerate(texts):
        window.push(scrape(text, i * every_s))
    return window.derive()


def test_every_rule_writes_a_field_of_the_wire_vocabulary():
    assert {r.field for r in FIELD_RULES} == set(LLM_FIELDS) - {"up"}


def test_the_parser_reads_labels_escapes_and_timestamps_and_skips_what_is_not_a_sample():
    series = parse_exposition(
        "# HELP a_total help text\n"
        "# TYPE a_total counter\n"
        "a_total 3\n"
        'b{path="C:\\\\dir",quote="say \\"hi\\"",brace="}"} 2.5 1700000000000\n'
        'c_bucket{le="+Inf"} 7\n'
        "nan_gauge NaN\n"
        "inf_gauge +Inf\n"
        "not a sample line at all\n"
        "\n"
        "truncated{le=\n"
    )
    assert sorted(series) == ["a_total", "b", "c_bucket"]
    assert series["a_total"][0].value == 3
    assert dict(series["b"][0].labels) == {"path": "C:\\dir", "quote": 'say "hi"', "brace": "}"}
    assert series["b"][0].value == 2.5
    assert series["c_bucket"][0].labels == (("le", "+Inf"),)


@pytest.mark.parametrize(
    ("text", "namespace"),
    [
        (RECORDED, "acmeserve:"),
        (FROM_DOCUMENTATION["vllm"], "vllm:"),
        (FROM_DOCUMENTATION["sglang"], "sglang:"),
        (FROM_DOCUMENTATION["llamacpp"], "llamacpp:"),
        ("trtllm_num_requests_running 1\ntrtllm_kv_cache_utilization 0.5\n", "trtllm_"),
        ("num_requests_running 1\ngpu_cache_usage_perc 0.5\n", ""),
    ],
    ids=["recorded", "vllm", "sglang", "llamacpp", "tensorrt-llm", "bare-names"],
)
def test_the_namespace_is_the_prefix_under_which_the_rules_match(text, namespace):
    assert pick_namespace(parse_exposition(text)) == namespace


def test_an_exposition_that_is_not_a_model_servers_has_no_namespace():
    node_exporter = 'node_cpu_seconds_total{cpu="0"} 5\nprocess_start_time_seconds 1.7e9\nup 1\n'
    assert pick_namespace(parse_exposition(node_exporter)) is None
    assert pick_namespace(parse_exposition('{"gpuMemUsage": 12}')) is None
    assert pick_namespace({}) is None


def test_a_name_is_matched_whole_after_the_namespace_never_by_its_ending():
    lookalikes = "x:cached_prompt_tokens_total 9\nx:waiting_prompt_tokens 4\nx:my_num_requests_running 2\n"
    assert pick_namespace(parse_exposition(lookalikes)) is None


def test_the_recorded_server_reports_every_field_and_its_identity():
    s = scrape(RECORDED)
    assert s.present == frozenset(LLM_FIELDS) - {"up"}
    assert s.gauges == {"running": 0, "waiting": 0, "kv_cache_pct": 0, "mem_bytes": 108943095160}
    assert s.counters == {"gen_tps": 102577, "prompt_tps": 1243290, "preempt_per_s": 0}
    assert (s.info["version"], s.info["model"]) == ("1.2.5", "example-model")
    assert s.started_ts == 1794251153 and s.sleeping is False


def test_mirrored_series_count_once():
    doubled = RECORDED.replace("acmeserve:requests_running 0", "acmeserve:requests_running 4").replace(
        "acmeserve:num_requests_running 0", "acmeserve:num_requests_running 4"
    )
    assert scrape(doubled).gauges["running"] == 4


def test_generation_rate_reads_the_counter_that_moves_while_tokens_are_produced():
    live = 'acmeserve:scheduler_tokens_total{mode="decode"} 102577'
    mid_stream = RECORDED.replace(live, 'acmeserve:scheduler_tokens_total{mode="decode"} 102977')
    assert "acmeserve:generation_tokens_total 102834" in mid_stream  # counted only when a request ends
    assert readings(RECORDED, mid_stream)["gen_tps"] == 200.0


def test_generation_rate_falls_back_to_the_finished_request_counter():
    got = readings(
        FROM_DOCUMENTATION["vllm"],
        FROM_DOCUMENTATION["vllm"].replace('B"} 50000.0', 'B"} 50300.0'),
    )
    assert got["gen_tps"] == 150.0
    llama = FROM_DOCUMENTATION["llamacpp"]
    got = readings(llama, llama.replace("tokens_predicted_total 4096", "tokens_predicted_total 4179"))
    assert got["gen_tps"] == 41.5


def test_vllm_reads_every_field_but_memory_and_sums_label_sets():
    two_engines = FROM_DOCUMENTATION["vllm"] + (
        'vllm:num_requests_running{engine="1",model_name="Qwen/Qwen3-32B"} 2.0\n'
        'vllm:kv_cache_usage_perc{engine="1",model_name="Qwen/Qwen3-32B"} 0.07\n'
    )
    s = scrape(two_engines)
    assert s.present == frozenset(LLM_FIELDS) - {"up", "mem_bytes"}
    assert s.gauges == {"running": 5, "waiting": 1, "kv_cache_pct": pytest.approx(41.0)}
    assert s.started_ts == 1.7912e9 and s.sleeping is False


def test_vllm_is_asleep_when_its_awake_series_is_zero():
    asleep = (
        FROM_DOCUMENTATION["vllm"]
        .replace('sleep_state="awake"} 1.0', 'sleep_state="awake"} 0.0')
        .replace('sleep_state="weights_offloaded"} 0.0', 'sleep_state="weights_offloaded"} 1.0')
    )
    assert scrape(asleep).sleeping is True
    assert scrape(RECORDED.replace("acmeserve:engine_parked 0", "acmeserve:engine_parked 1")).sleeping


def test_sglang_reads_its_own_names_and_reports_no_memory_or_preemption():
    s = scrape(FROM_DOCUMENTATION["sglang"])
    assert s.present == frozenset(LLM_FIELDS) - {"up", "mem_bytes", "preempt_per_s"}
    assert s.gauges == {"running": 2, "waiting": 5, "kv_cache_pct": pytest.approx(28.0)}


def test_llamacpp_reports_no_kv_cache_first_token_time_or_memory():
    s = scrape(FROM_DOCUMENTATION["llamacpp"])
    assert s.present == {"running", "waiting", "gen_tps", "prompt_tps"}
    assert s.gauges == {"running": 1, "waiting": 0}


def test_one_scrape_gives_gauges_and_no_rate_or_quantile():
    assert readings(RECORDED) == {"running": 0, "waiting": 0, "kv_cache_pct": 0, "mem_bytes": 108943095160}


def test_an_idle_server_has_a_rate_of_zero_and_no_first_token_time():
    got = readings(RECORDED, RECORDED, RECORDED)
    assert (got["gen_tps"], got["prompt_tps"], got["preempt_per_s"]) == (0, 0, 0)
    assert "ttft_p50_s" not in got and "ttft_p95_s" not in got


def with_first_tokens(text: str, at_most_half_a_second: int, at_most_five: int) -> str:
    """The recorded exposition after more requests, by how long their first token took: 0.25 to 0.5 s and
    2.5 to 5 s."""
    out = []
    for line in text.splitlines():
        if line.startswith("acmeserve:time_to_first_token_seconds_bucket"):
            head, count = line.rsplit(" ", 1)
            le = float(head.split('le="')[1].split('"')[0])
            count = str(
                int(count) + (at_most_half_a_second if le >= 0.5 else 0) + (at_most_five if le >= 5 else 0)
            )
            line = f"{head} {count}"
        out.append(line)
    return "\n".join(out) + "\n"


def test_first_token_quantiles_come_from_the_requests_of_the_last_minute_only():
    got = readings(RECORDED, with_first_tokens(RECORDED, 90, 10))
    assert got["ttft_p50_s"] == pytest.approx(0.25 + 0.25 * 50 / 90, abs=1e-4)
    assert got["ttft_p95_s"] == pytest.approx(2.5 + 2.5 * 5 / 10, abs=1e-4)

    window = Window()
    window.push(scrape(RECORDED, 0.0))
    busy = with_first_tokens(RECORDED, 90, 10)
    window.push(scrape(busy, 2.0))
    window.push(scrape(busy, 70.0))
    assert "ttft_p50_s" not in window.derive()


def test_a_rate_covers_the_last_ten_seconds():
    def at(tokens: int) -> str:
        return RECORDED.replace(
            "acmeserve:prompt_tokens_total 1243290", f"acmeserve:prompt_tokens_total {tokens}"
        )

    window = Window()
    for t, tokens in ((0, 1_000_000), (2, 1_000_000), (20, 1_900_000), (22, 1_900_400), (30, 1_902_000)):
        window.push(scrape(at(tokens), float(t)))
    assert window.derive()["prompt_tps"] == 200.0


def test_a_restart_the_server_reports_clears_rates_for_one_poll():
    restarted = RECORDED.replace(
        "process_start_time_seconds 1794251153", "process_start_time_seconds 1794260000"
    )
    window = Window()
    window.push(scrape(RECORDED, 0.0))
    window.push(scrape(RECORDED, 2.0))
    assert "gen_tps" in window.derive()
    window.push(scrape(restarted, 4.0))
    assert "gen_tps" not in window.derive() and window.derive()["running"] == 0
    window.push(scrape(restarted, 6.0))
    assert window.derive()["gen_tps"] == 0


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("acmeserve:prompt_tokens_total 1243290", "acmeserve:prompt_tokens_total 12"),
        (
            'acmeserve:time_to_first_token_seconds_bucket{le="+Inf"} 257',
            'acmeserve:time_to_first_token_seconds_bucket{le="+Inf"} 3',
        ),
        (
            'acmeserve:time_to_first_token_seconds_bucket{le="0.25"} 55',
            'acmeserve:time_to_first_token_seconds_bucket{le="0.2"} 55',
        ),
    ],
    ids=["counter-went-down", "bucket-went-down", "bucket-bounds-changed"],
)
def test_a_restart_the_server_does_not_report_is_seen_in_its_counters(before, after):
    assert before in RECORDED
    reset = RECORDED.replace(before, after)
    window = Window()
    window.push(scrape(RECORDED, 0.0))
    window.push(scrape(RECORDED, 2.0))
    window.push(scrape(reset, 4.0))
    got = window.derive()
    assert not {"gen_tps", "prompt_tps", "ttft_p50_s"} & set(got)
    window.push(scrape(reset, 6.0))
    assert window.derive()["prompt_tps"] == 0


def test_pushing_a_scrape_that_is_not_newer_changes_nothing():
    window = Window()
    window.push(scrape(RECORDED, 0.0))
    window.push(scrape(RECORDED, 2.0))
    before = list(window.scrapes)
    window.push(scrape(RECORDED, 2.0))
    window.push(scrape(RECORDED, 1.0))
    assert list(window.scrapes) == before


def test_histogram_quantile_follows_prometheus():
    buckets = ((0.1, 0.0), (0.5, 10.0), (1.0, 30.0), (math.inf, 40.0))
    assert histogram_quantile(0.5, buckets) == pytest.approx(0.75)
    assert histogram_quantile(0.25, buckets) == pytest.approx(0.5)
    assert histogram_quantile(0.125, buckets) == pytest.approx(0.3)
    assert histogram_quantile(0.95, buckets) == 1.0  # the rank is in +Inf: the highest finite bound
    first_bucket_starts_at_zero = ((0.5, 4.0), (math.inf, 4.0))
    assert histogram_quantile(0.5, first_bucket_starts_at_zero) == pytest.approx(0.25)
    assert histogram_quantile(0.5, ((0.5, 0.0), (math.inf, 0.0))) is None
    assert histogram_quantile(0.5, ((math.inf, 9.0),)) is None
    assert histogram_quantile(0.5, ()) is None
