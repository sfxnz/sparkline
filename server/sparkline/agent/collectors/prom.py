"""Prometheus text from a model server -> the canonical readings (LlmField). Pure: no IO and no clock.

FIELD_RULES is the only place that knows any server's metric names. A name is matched exactly after the
server's namespace ("vllm:", "trtllm_", "" for bare names), never by suffix, so
``cached_prompt_tokens_total`` cannot read as ``prompt_tokens_total``.
"""

from __future__ import annotations

import math
import re
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, NamedTuple

LabelSet = tuple[tuple[str, str], ...]


class Series(NamedTuple):
    name: str  # as exposed: "vllm:time_to_first_token_seconds_bucket"
    labels: LabelSet
    value: float


_LINE = re.compile(r"([A-Za-z_:][A-Za-z0-9_:]*)\s*(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?\s*$")
_LABEL = re.compile(r'\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?')
_ESCAPE = re.compile(r"\\(.)")
_UNESCAPED = {"n": "\n"}


def parse_exposition(text: str) -> dict[str, list[Series]]:
    """Prometheus text format 0.0.4 -> name -> series. Comments, malformed lines and non-finite values
    are skipped, so nothing downstream checks for NaN."""
    out: dict[str, list[Series]] = {}
    for line in text.splitlines():
        if not line or line[0] == "#":
            continue
        m = _LINE.match(line)
        if not m:
            continue
        name, raw_labels, raw_value = m.groups()
        try:
            value = float(raw_value)
        except ValueError:
            continue
        if not math.isfinite(value):
            continue
        labels = tuple(
            (k, _ESCAPE.sub(lambda e: _UNESCAPED.get(e.group(1), e.group(1)), v))
            for k, v in _LABEL.findall(raw_labels or "")
        )
        out.setdefault(name, []).append(Series(name, labels, value))
    return out


class Source(NamedTuple):
    suffix: str  # the metric name after the namespace
    where: LabelSet = ()  # only series carrying every one of these labels count


RuleKind = Literal["gauge", "rate", "quantile"]


@dataclass(frozen=True)
class Rule:
    field: str  # an LlmField
    kind: RuleKind
    sources: tuple[Source, ...]  # tried in order; the first one present wins, so mirrors never double count
    agg: Literal["sum", "max"] = "sum"  # across label sets (vLLM engine=, one KV pool per stream)
    scale: float = 1.0
    q: float = 0.0  # quantile rules only


def _named(*suffixes: str) -> tuple[Source, ...]:
    return tuple(Source(s) for s in suffixes)


FIELD_RULES: tuple[Rule, ...] = (
    Rule("running", "gauge", _named("num_requests_running", "num_running_reqs", "requests_processing")),
    Rule("waiting", "gauge", _named("num_requests_waiting", "num_queue_reqs", "requests_deferred")),
    Rule(
        "kv_cache_pct",
        "gauge",
        _named("kv_cache_usage_perc", "gpu_cache_usage_perc", "kv_cache_utilization", "token_usage"),
        agg="max",
        scale=100.0,  # each is a 0..1 fraction, "perc" in the name or not
    ),
    Rule(
        "gen_tps",
        "rate",
        # A counter that advances while tokens are produced comes first: one that counts a request's
        # tokens when it finishes reads 0 through a long generation and spikes at its end.
        (Source("scheduler_tokens_total", (("mode", "decode"),)),)
        + _named("generation_tokens_total", "tokens_predicted_total"),
    ),
    Rule("prompt_tps", "rate", _named("prompt_tokens_total")),
    Rule("preempt_per_s", "rate", _named("num_preemptions_total", "preemptions_total")),
    Rule("ttft_p50_s", "quantile", _named("time_to_first_token_seconds"), q=0.5),
    Rule("ttft_p95_s", "quantile", _named("time_to_first_token_seconds"), q=0.95),
    Rule("mem_bytes", "gauge", _named("gpu_memory_usage_bytes", "device_memory_bytes")),
)

KNOWN_NAMESPACES: dict[str, str] = {
    "vllm:": "vLLM",
    "sglang:": "SGLang",
    "llamacpp:": "llama.cpp",
    "trtllm_": "TensorRT-LLM",
}
SLEEP_GAUGES = ("engine_sleep_state", "engine_parked")
INFO_GAUGES = ("server_info", "build_info")
START_GAUGE = "process_start_time_seconds"


def _matching(series: Mapping[str, list[Series]], ns: str, rule: Rule) -> list[Series]:
    """The series of the rule's first source this exposition has under ``ns``."""
    tail = "_bucket" if rule.kind == "quantile" else ""
    for src in rule.sources:
        found = [s for s in series.get(ns + src.suffix + tail, ()) if set(src.where) <= set(s.labels)]
        if found:
            return found
    return []


def pick_namespace(series: Mapping[str, list[Series]]) -> str | None:
    """The namespace under which the most FIELD_RULES match: a colon prefix ("vllm:"), a first underscore
    token ("trtllm_") or "" (bare names). None when no rule matches under any: not a model server's
    exposition, which makes this the fingerprint too."""
    candidates = {""}
    for name in series:
        head, colon, _ = name.partition(":")
        candidates.add(head + colon if colon else name.partition("_")[0] + "_")
    best, best_rank = None, (0, False, 0)
    for ns in candidates:
        score = sum(1 for rule in FIELD_RULES if _matching(series, ns, rule))
        rank = (score, ns.endswith(":"), len(ns))
        if score and rank > best_rank:
            best, best_rank = ns, rank
    return best


def _asleep(s: Series) -> bool:
    # vLLM writes one series per sleep_state label and marks the engine awake with awake = 1.
    return s.value == 0 if ("sleep_state", "awake") in s.labels else s.value > 0


Buckets = tuple[tuple[float, float], ...]  # (le, cumulative count), ascending, +Inf last


def _buckets(found: list[Series]) -> Buckets | None:
    by_le: dict[float, float] = {}
    for s in found:
        try:
            le = float(dict(s.labels)["le"])
        except (KeyError, ValueError):
            continue
        by_le[le] = by_le.get(le, 0.0) + s.value
    return tuple(sorted(by_le.items())) if math.inf in by_le else None


@dataclass(frozen=True)
class Scrape:
    """One poll, reduced to what the rules need."""

    t: float  # monotonic seconds
    epoch: tuple[object, ...]  # (process start time, server_info instance): a change means a restart
    gauges: Mapping[str, float]  # field -> aggregated value, scaled
    counters: Mapping[str, float]  # field -> summed counter
    histograms: Mapping[str, Buckets]  # field -> buckets summed across label sets
    present: frozenset[str]  # fields this exposition has a source for
    info: Mapping[str, str]  # labels of the server's *_info gauge: version, model, instance
    sleeping: bool
    started_ts: float | None


def reduce_scrape(series: Mapping[str, list[Series]], ns: str, t: float) -> Scrape:
    gauges: dict[str, float] = {}
    counters: dict[str, float] = {}
    histograms: dict[str, Buckets] = {}
    present = set()
    for rule in FIELD_RULES:
        found = _matching(series, ns, rule)
        if not found:
            continue
        present.add(rule.field)
        values = [s.value for s in found]
        if rule.kind == "gauge":
            gauges[rule.field] = (max(values) if rule.agg == "max" else sum(values)) * rule.scale
        elif rule.kind == "rate":
            counters[rule.field] = sum(values)
        elif buckets := _buckets(found):
            histograms[rule.field] = buckets

    def first(name: str) -> Series | None:
        return next(iter(series.get(ns + name) or series.get(name) or ()), None)

    info = next((dict(s.labels) for name in INFO_GAUGES if (s := first(name))), {})
    start = first(START_GAUGE)
    started_ts = start.value if start else None
    return Scrape(
        t=t,
        epoch=(started_ts, info.get("instance")),
        gauges=gauges,
        counters=counters,
        histograms=histograms,
        present=frozenset(present),
        info=info,
        sleeping=any(_asleep(s) for name in SLEEP_GAUGES for s in series.get(ns + name, ())),
        started_ts=started_ts,
    )


RATE_WINDOW_S = 10.0
QUANTILE_WINDOW_S = 60.0


def _went_down(new: Scrape, old: Scrape) -> bool:
    if any(new.counters[f] < old.counters[f] for f in new.counters.keys() & old.counters.keys()):
        return True
    for f in new.histograms.keys() & old.histograms.keys():
        a, b = new.histograms[f], old.histograms[f]
        if [le for le, _ in a] != [le for le, _ in b] or any(x[1] < y[1] for x, y in zip(a, b, strict=True)):
            return True
    return False


@dataclass
class Window:
    """The recent scrapes of one server, all from one server process. A restart empties it, so a rate
    or a quantile is missing for one poll and never negative or inflated."""

    scrapes: deque[Scrape] = field(default_factory=deque)

    def push(self, s: Scrape) -> None:
        if self.scrapes:
            last = self.scrapes[-1]
            if s.t <= last.t:
                return
            if s.epoch != last.epoch or _went_down(s, last):
                self.scrapes.clear()
        self.scrapes.append(s)
        while self.scrapes[0].t < s.t - QUANTILE_WINDOW_S:
            self.scrapes.popleft()

    def derive(self) -> dict[str, float]:
        """field -> reading. A field with nothing to say now is left out: a rate with one scrape in its
        window, a quantile when no request landed in the last minute."""
        if not self.scrapes:
            return {}
        new = self.scrapes[-1]
        out = dict(new.gauges)
        rate_base = next(s for s in self.scrapes if s.t >= new.t - RATE_WINDOW_S)
        if rate_base.t < new.t:
            for f, count in new.counters.items():
                if f in rate_base.counters:
                    out[f] = round((count - rate_base.counters[f]) / (new.t - rate_base.t), 3)
        old = self.scrapes[0]
        for rule in FIELD_RULES:
            if rule.kind == "quantile" and rule.field in new.histograms and rule.field in old.histograms:
                delta = tuple(
                    (le, n - m)
                    for (le, n), (_, m) in zip(
                        new.histograms[rule.field], old.histograms[rule.field], strict=True
                    )
                )
                if (v := histogram_quantile(rule.q, delta)) is not None:
                    out[rule.field] = round(v, 4)
        return out


def histogram_quantile(q: float, buckets: Buckets) -> float | None:
    """Prometheus's histogram_quantile on cumulative buckets: None with no observation; linear inside the
    bucket holding rank q * total, from 0 for the first; the highest finite bound for a rank in +Inf."""
    total = buckets[-1][1] if buckets else 0.0
    if total <= 0 or len(buckets) < 2:
        return None
    rank = q * total
    lower, below = 0.0, 0.0
    for le, count in buckets[:-1]:
        if count >= rank:
            return lower + (le - lower) * (rank - below) / (count - below) if count > below else le
        lower, below = le, count
    return buckets[-2][0]
