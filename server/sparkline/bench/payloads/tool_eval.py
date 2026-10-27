"""Tool-calling evaluation of an OpenAI-compatible endpoint with tool-eval-bench (host Python).

tool-eval-bench (SeraphimSerapis, MIT; pinned in requirements.lock) runs in this process through its library
API with upstream's defaults (temperature 0, 120 s per request, 8 turns, one scenario at a time, no seed
unless --seed, the backend detected as its CLI does) and persist=False, so scores and the config fingerprint
match its CLI for the same server and settings. --trials K runs the same request K times in a row, as its CLI
does, and adds upstream's trial statistics (aggregate_trials): the headline score is then the mean. First,
one streamed request offering a trivial tool checks that the server accepts tool calls at all: vLLM started
without a tool parser answers HTTP 400, which tool-eval-bench counts as a server error and leaves out of the
score, so a broken setup would otherwise read as a good score over a handful of scenarios.

Every scenario start and result replaces the live snapshot (the scenario board); every result adds a detail
record "te:<id>" with the trace cut to 4,000 characters, replaced by each trial, with the scenario's points in
every trial so far. At the end come detail "tool_eval" (the summary and upstream's result envelope of the last
trial without traces, plus the trial statistics) and the results. A trial in which no scenario could be
graded fails the run; one with exclusions succeeds and reports the share graded with its score. SIGTERM
cancels the run at once (exit 143).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import http.client
import json
import math
import signal
import sys
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from benchlib import detail, fail, live, log, on_sigterm, progress, result
from llm_inference import GENERIC_OWNERS, connect, get_json, http_error
from tool_eval_bench import __version__
from tool_eval_bench.api import run_benchmark
from tool_eval_bench.cli.helpers import trial_safety_warnings
from tool_eval_bench.cli.run_io import aggregate_trials
from tool_eval_bench.domain.scenarios import (
    CATEGORY_LABELS,
    ScenarioDefinition,
    ScenarioResult,
    rating_for_score,
)
from tool_eval_bench.evals import scenarios as registry
from tool_eval_bench.runner.orchestrator import score_results

SUITES = {
    "core": registry.SCENARIOS,
    "standard": registry.ALL_SCENARIOS,
    "hard": registry.HARDMODE_SCENARIOS,
    "all": registry.ALL_SCENARIOS_WITH_HARDMODE,
}
PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}
NO_PARSER_HINTS = ("auto-tool-choice", "tool-call-parser", "tool choice", "tool_choice")
THINK_WARNING = (
    "Reasoning text arrives inside the answer. Start the server with a reasoning parser "
    "(vLLM `--reasoning-parser`) or scores drop."
)
TRACE_CHARS = 4000  # of each scenario's trace in its record (head and tail)
TOOL_CALLS = 32  # listed per scenario record
RECORDS_BUDGET = 640_000  # compact JSON of all scenario records together, split evenly between them
DETAIL_BUDGET = 1_000_000  # all of detail; the agent drops detail updates past 1 MiB (and lines past 1 MiB)


class NothingGraded(Exception):
    """A trial in which every scenario timed out or hit a connection or server error."""


def clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def cut(text: str, n: int) -> str:
    """At most n characters of text, as its head and tail around a marker (the verdict is at the end)."""
    if len(text) <= n:
        return text
    half = n // 2
    return f"{text[:half]}\n… {len(text) - 2 * half} chars omitted …\n{text[len(text) - half :]}"


def size(value: Any) -> int:
    """Length of the compact JSON, as the agent measures live and detail."""
    return len(json.dumps(value, separators=(",", ":")))


def finite(value: Any) -> Any:
    """A JSON-safe copy: NaN and infinities become null."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [finite(v) for v in value]
    return value


def endpoint_model(base: str, wanted: str) -> tuple[str, str]:
    """The model to test (the first served one when none is given) and the engine label, as llm_inference
    reports them."""
    try:
        models, headers = get_json(base, "/v1/models")
    except (OSError, ValueError, http.client.HTTPException) as e:
        fail(
            "LLM endpoint unreachable",
            f"{base}/v1/models: {e}",
            "Check that the server is running and serves the OpenAI API at that address",
        )
    entries = models.get("data") or []
    model = wanted or (entries[0]["id"] if entries else "")
    if not model:
        fail("No model to test", "/v1/models listed no models and none was given", "Set the model parameter")
    owner = next((m.get("owned_by", "") for m in entries if m.get("id") == model), "")
    engine = owner if owner.lower() not in GENERIC_OWNERS else headers.get("server", "")
    return model, engine.split("/")[0] or "unknown engine"


def thinks(text: str) -> bool:
    """Reasoning tags in the answer: the model's template opens with <think>, or puts it in the prompt."""
    return "<think>" in text or "</think>" in text


def plain_answer(body: bytes) -> str:
    """The answer of a chat completion sent as one JSON body (a server that ignores stream=true), else ""."""
    try:
        content = json.loads(body)["choices"][0]["message"]["content"]
    except (ValueError, LookupError, TypeError):
        return ""
    return content if isinstance(content, str) else ""


def check_tool_calling(base: str, model: str, thinking: bool) -> bool:
    """One streamed request offering a trivial tool with tool_choice "auto", read until the reply shows how
    the server answers. Fails the run when tool calls are rejected; returns whether reasoning text arrived
    inside the answer (a thinking model served without a reasoning parser), streamed or in one JSON body."""
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": "What is the weather in Paris right now?"}],
        "tools": [PROBE_TOOL],
        "tool_choice": "auto",
        "max_tokens": 1024,  # room for a thinking model to reach its answer; reading stops long before
        "temperature": 0,
        "stream": True,
    }
    if not thinking:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    conn, prefix = connect(base, 120)
    text = ""
    try:
        conn.request(
            "POST", prefix + "/v1/chat/completions", json.dumps(body), {"Content-Type": "application/json"}
        )
        r = conn.getresponse()
        if r.status != 200:
            err = http_error(r.status, r.read(4096))
            if r.status == 400 and any(h in err.lower() for h in NO_PARSER_HINTS):
                fail(
                    "The endpoint doesn't accept tool calls",
                    "vLLM was started without automatic tool choice, so every tool-calling request is "
                    "rejected (HTTP 400).",
                    "Restart vLLM with `--enable-auto-tool-choice --tool-call-parser <parser for your "
                    "model>`.",
                )
            fail(
                "The endpoint rejected a tool-calling request",
                err,
                "Check the model name and the server logs",
            )
        deadline = time.monotonic() + 60
        events, plain = 0, b""  # SSE events; the other lines, the whole answer when stream=true is ignored
        while time.monotonic() < deadline and len(text) < 2000 and not thinks(text):
            line = r.readline()
            if not line:
                break
            line = line.strip()
            if not line.startswith(b"data:"):
                plain += line
                continue
            events += 1
            data = line[5:].strip()
            if data == b"[DONE]":
                break
            for ch in json.loads(data).get("choices") or []:
                delta = ch.get("delta") or {}
                if delta.get("tool_calls"):  # the model called the tool: its text before that has been read
                    return thinks(text)
                text += delta.get("content") or ""
        if not events:
            text = plain_answer(plain)
    # AttributeError, TypeError: a reply not in OpenAI's streaming format (tool-eval-bench can't read it)
    except (OSError, ValueError, AttributeError, TypeError, http.client.HTTPException) as e:
        fail(
            "Couldn't check tool calling",
            f"{base}/v1/chat/completions: {type(e).__name__}: {e}",
            "Check that the server is running and serves the OpenAI API at that address",
        )
    finally:
        conn.close()
    return thinks(text)


class Board:
    """The run as tool-eval-bench reports it: the live snapshot, and the detail records sent so far."""

    def __init__(
        self, scenarios: list[ScenarioDefinition], head: dict[str, Any], warnings: list[str]
    ) -> None:
        self.total = len(scenarios)
        self.trials = head["trials"]
        self.head = {"kind": "tool-eval", "v": 1, **head, "total": self.total}
        cats = {s.category for s in scenarios}
        self.cat_labels = {c.value: label for c, label in CATEGORY_LABELS.items() if c in cats}
        self.tiles: dict[str, dict[str, Any]] = {
            s.id: {
                "id": s.id,
                "cat": s.category.value,
                "title": s.title,
                "difficulty": s.difficulty,
                "status": "pending",
                "points": None,
                "s": None,
                "history": [],  # points in each trial it finished, None when excluded
            }
            for s in scenarios
        }
        self.counts = {"pass": 0, "partial": 0, "fail": 0, "excluded": 0}
        self.done = self.points = self.max_points = 0  # of the trial running now
        self.trial = 1
        self.trial_scores: list[dict[str, Any]] = []
        self.started_ts: float | None = None
        self.current: dict[str, Any] | None = None
        self.recent: deque[dict[str, Any]] = deque(maxlen=5)
        self.warnings = warnings
        self.record_max = max(4000, min(16000, RECORDS_BUDGET // max(1, self.total)))
        self.used = 0  # compact JSON of the detail sent so far
        self.sizes: dict[str, int] = {}  # of each record, which later trials replace

    def snapshot(self) -> dict[str, Any]:
        return {
            **self.head,
            "trial": self.trial,
            "trial_scores": self.trial_scores,
            "done": self.done,
            "points": self.points,
            "max_points": self.max_points,
            "counts": self.counts,
            "started_ts": self.started_ts,
            "current": self.current,
            "cat_labels": self.cat_labels,
            "warnings": self.warnings,
            "board": list(self.tiles.values()),
            "recent": list(self.recent),
        }

    def fraction(self) -> float:
        return 0.05 + 0.93 * ((self.trial - 1) * self.total + self.done) / (self.total * self.trials)

    def next_trial(self) -> None:
        """Every tile pending again, its history kept; the counts start over."""
        self.trial += 1
        for tile in self.tiles.values():
            tile.update(status="pending", points=None, s=None)
        self.counts = dict.fromkeys(self.counts, 0)
        self.done = self.points = self.max_points = 0

    def trial_finished(self, env: dict[str, Any]) -> None:
        s = env["scores"]
        self.trial_scores.append(
            {
                "trial": self.trial,
                "score": s["final_score"],
                "rating": s["rating"],
                "points": s["total_points"],
                "max_points": s["max_points"],
                "excluded": len(s.get("excluded_scenarios", [])),
            }
        )
        live(finite(self.snapshot()))

    def started(self, s: ScenarioDefinition, index: int, total: int) -> None:
        now = round(time.time(), 3)
        if self.started_ts is None:
            self.started_ts = now
        self.tiles[s.id]["status"] = "running"
        self.current = {
            "id": s.id,
            "title": s.title,
            "category": s.category.value,
            "difficulty": s.difficulty,
            "expected": s.description,
            "started_ts": now,
        }
        trial = f"Trial {self.trial} of {self.trials} · " if self.trials > 1 else ""
        progress(self.fraction(), f"{trial}Scenario {index + 1} of {total} · {s.id} {s.title}")
        live(finite(self.snapshot()))

    def finished(self, s: ScenarioDefinition, r: ScenarioResult, index: int, total: int) -> None:
        status = "excluded" if r.is_infrastructure_failure else r.status.value
        self.done += 1
        self.counts[status] += 1
        if status != "excluded":
            self.points += r.points
            self.max_points += 2
        tile = self.tiles[s.id]
        tile["history"].append(None if status == "excluded" else r.points)
        tile.update(status=status, points=r.points, s=round(r.duration_seconds, 1))
        self.current = None
        self.recent.appendleft(
            {
                "id": s.id,
                "status": status,
                "points": r.points,
                "summary": clip(r.summary, 200),
                "trial": self.trial,
            }
        )
        key, rec = f"te:{s.id}", self.record(s, r, status)
        n = len(key) + 4 + size(rec)
        self.used += n - self.sizes.get(key, 0)
        self.sizes[key] = n
        detail(**{key: rec})
        live(finite(self.snapshot()))
        progress(self.fraction())

    def record(self, s: ScenarioDefinition, r: ScenarioResult, status: str) -> dict[str, Any]:
        """The scenario's detail record, cut until it fits its share of the budget whatever the scenario
        produced (non-ASCII text grows up to twelvefold as JSON escapes): the trace first (head and tail),
        then each tool call, then how many tool calls are listed, and last the evaluator's texts."""
        shown = registry.ALL_DISPLAY_DETAILS.get(s.id)
        calls = r.tool_calls_made
        keep = len(calls) if len(calls) <= TOOL_CALLS else TOOL_CALLS - 1
        rec = finite(
            {
                "id": s.id,
                "title": s.title,
                "category": s.category.value,
                "category_label": CATEGORY_LABELS[s.category],
                "difficulty": s.difficulty,
                "status": status,
                "excluded": status == "excluded",
                "points": r.points,
                "summary": "",
                "note": None,
                "failure_kind": r.failure_kind,
                "safety_violation": None,
                "expected": s.description,
                "success_case": shown.success_case if shown else None,
                "failure_case": shown.failure_case if shown else None,
                "duration_s": round(r.duration_seconds, 1),
                "ttft_ms": None if r.ttft_ms is None else round(r.ttft_ms, 1),
                "turns": r.turn_count,
                "turn_ms": [round(t, 1) for t in r.turn_latencies_ms],
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "tool_calls": [],
                "parallel_turns": r.parallel_tool_turns,
                "budget_exceeded": r.turn_budget_exceeded,
                "history": list(self.tiles[s.id]["history"]),
                "trace": "",
            }
        )
        traces = [TRACE_CHARS >> i for i in range(TRACE_CHARS.bit_length() + 1)]  # 4000, 2000 ... 1, 0
        cuts = [(n, 200, keep, 1000) for n in traces]  # (trace, chars per tool call, tool calls, text chars)
        cuts += [(0, n, keep, 1000) for n in (100, 50, 20)]
        cuts += [(0, 20, n, 1000) for n in reversed(range(keep))]
        cuts += [(0, 20, 0, n) for n in (200, 50)]  # the fixed part is < 1 KB: this always fits
        for trace, width, listed, text in cuts:
            rec["trace"] = cut(r.raw_log, trace)
            rec["tool_calls"] = [clip(c, width) for c in calls[:listed]]
            if listed < len(calls):
                rec["tool_calls"].append(f"… {len(calls) - listed} more")
            rec["summary"] = clip(r.summary, text)
            rec["note"] = None if r.note is None else clip(r.note, text)
            rec["safety_violation"] = None if r.safety_violation is None else clip(r.safety_violation, text)
            if size(rec) <= self.record_max:
                break
        return rec

    def stop(self) -> None:
        """Cancelled: the scenario that was running never finished."""
        if self.current:
            self.tiles[self.current["id"]]["status"] = "pending"
        self.current = None


def safe(update: Callable[..., None]) -> Callable[..., Awaitable[None]]:
    """tool-eval-bench aborts the whole run when a callback raises: a failed update is logged, not raised."""

    async def callback(*args: Any) -> None:
        try:
            update(*args)
        except Exception as e:
            with contextlib.suppress(Exception):
                log(f"Couldn't report scenario progress: {type(e).__name__}: {e}")

    return callback


def trial_stats(
    envs: list[dict[str, Any]], scenarios: list[ScenarioDefinition], board: Board
) -> dict[str, Any] | None:
    """The trials together, as upstream's CLI aggregates them (None for one trial). Adds upstream's
    statistics, the union of every trial's safety warnings and the trial count to the last trial's envelope,
    as its `--json --trials` output does."""
    if len(envs) < 2:
        return None
    defs = {s.id: s for s in scenarios}
    summaries = []
    for e in envs:  # each trial scored as the CLI scores it (_score_stored_trial)
        results = [ScenarioResult.from_dict(x) for x in e["scores"]["scenario_results"]]
        summaries.append(score_results(results, [defs[r.scenario_id] for r in results], alpha=0.7))
    agg = finite(json.loads(json.dumps(aggregate_trials(summaries))))  # the CI as a list
    warnings = trial_safety_warnings(envs)
    last = envs[-1]
    last["trial_statistics"] = agg
    last["safety_warnings"] = warnings
    last["safety_gate"] = {"passed": not warnings, "warnings": warnings}
    last["metadata"]["trials"] = len(envs)
    scores = [e["scores"]["final_score"] for e in envs]
    ratings = [e["scores"]["rating"] for e in envs]
    per = agg["per_scenario"]
    graded = sum(
        len(e["scores"]["scenario_results"]) - len(e["scores"].get("excluded_scenarios", [])) for e in envs
    )
    return {
        "scores": scores,
        "ratings": ratings,
        "mean": agg["final_score_mean"],
        "stddev": agg["final_score_stddev"],
        "median": agg["final_score_median"],
        "ci95": agg["final_score_ci95"],
        "min": min(scores),
        "max": max(scores),
        # the rating of the mean, capped when any trial's was (a safety-critical category below the gate)
        "rating": rating_for_score(
            round(agg["final_score_mean"]), safety_capped=any("(safety-capped)" in r for r in ratings)
        ),
        "pass_at_k": agg["pass_at_k"],
        "pass_hat_k": agg["pass_hat_k"],
        "reliability_gap": agg["reliability_gap"],
        "flaky": [k for k, v in per.items() if v["pass_at_k"] and not v["pass_hat_k"]],
        "never": [k for k, v in per.items() if not v["pass_at_k"]],
        "per_category": agg["per_category"],
        "per_scenario": per,
        "graded": graded,
        "completion_rate": round(100 * graded / (board.total * len(envs)), 1),
        "safety_warnings": warnings,
    }


def summary(env: dict[str, Any], board: Board, stats: dict[str, Any] | None) -> dict[str, Any]:
    """detail.tool_eval: the scores the web shows (the last trial's), the trial statistics, plus upstream's
    envelope without the traces."""
    s = env["scores"]
    for x in s["scenario_results"]:
        x.pop("raw_log", None)
    return {
        **{k: board.head[k] for k in ("version", "suite", "thinking", "model", "engine", "trials", "seed")},
        "engine_version": env["metadata"].get("engine_version"),
        "fingerprint": env["config"].get("config_fingerprint"),
        "final_score": s["final_score"],
        "rating": s["rating"],
        "total_points": s["total_points"],
        "max_points": s["max_points"],
        "completion_rate": s.get("completion_rate", 100.0),
        "excluded": s.get("excluded_scenarios", []),
        "safety_warnings": s.get("safety_warnings", []),
        "safety_gate_passed": env["safety_gate"]["passed"],
        "deployability": s.get("deployability"),
        "responsiveness": s.get("responsiveness"),
        "median_turn_ms": s.get("median_turn_ms"),
        "total_tokens": s.get("total_tokens", 0),
        "token_efficiency": s.get("token_efficiency"),
        "worst_category": s.get("worst_category"),
        "categories": [
            {
                "category": c["category"],
                "label": c["label"],
                "earned": c["earned"],
                "max": c["max"],
                "percent": c["percent"],
                "pass": c["pass_count"],
                "partial": c["partial_count"],
                "fail": c["fail_count"],
            }
            for c in s["category_scores"]
        ],
        "capabilities": [
            {k: c[k] for k in ("capability", "label", "earned", "max", "percent")}
            for c in s.get("capability_scores", [])
        ],
        "trial_stats": stats,
        "envelope": env,
    }


def report(envs: list[dict[str, Any]], board: Board, stats: dict[str, Any] | None) -> None:
    """detail.tool_eval and the results of a run that graded at least one scenario in every trial. With
    several trials the results are their mean (the score's spread in its extras), plus Pass@k and Pass^k."""
    env = envs[-1]
    final = summary(env, board, stats)
    if board.used + size(final) > DETAIL_BUDGET:
        env["scores"]["scenario_results"] = []  # each scenario's record has them too
        log("tool-eval-bench's result envelope is too large for the run record: per-scenario results omitted")
    detail(tool_eval=final)
    common = {k: board.head[k] for k in ("engine", "model", "suite", "version", "thinking", "trials", "seed")}
    head = {**common, "headline": True}
    if stats is None:
        rating, completion = final["rating"], final["completion_rate"]
        result(
            "score",
            "Tool-calling score",
            final["final_score"],
            "%",
            **head,
            whole=True,  # a whole number by definition: the web prints "89%", not "89.0%"
            rating=rating,
            scenarios=board.total,
            graded=board.total - board.counts["excluded"],
            completion_rate=completion,
            fingerprint=final["fingerprint"],
            safety_capped="(safety-capped)" in rating,
            total_points=final["total_points"],
            max_points=final["max_points"],
        )
    else:
        rating, completion = stats["rating"], stats["completion_rate"]
        result(
            "score",
            "Tool-calling score",
            stats["mean"],
            "%",
            **head,
            rating=rating,
            stddev=stats["stddev"],
            ci95_low=stats["ci95"][0],
            ci95_high=stats["ci95"][1],
            median=stats["median"],
            min=stats["min"],
            max=stats["max"],
            scenarios=board.total,
            graded=stats["graded"],  # scenario runs graded over all trials
            completion_rate=completion,
            fingerprint=final["fingerprint"],
            safety_capped="(safety-capped)" in rating,
        )
        result("score_stddev", "Score spread (σ)", stats["stddev"], "pts", "lower", **head)
        result("pass_at_k", f"Pass@{board.trials}", stats["pass_at_k"], "%", **head)
        result("pass_hat_k", f"Pass^{board.trials}", stats["pass_hat_k"], "%", **head)
    result("completion_rate", "Scenarios graded", completion, "%", **head)

    def mean(key: str) -> float | None:
        """The trials' mean of a score that is None when it can't be computed."""
        values = [e["scores"].get(key) for e in envs]
        if None in values:
            return None
        return values[0] if len(values) == 1 else round(sum(values) / len(values), 1)

    median_turn = mean("median_turn_ms")
    if median_turn is not None:
        result("median_turn_ms", "Median turn latency", median_turn, "ms", "lower", **head)
    for key, label in (("deployability", "Deployability"), ("responsiveness", "Responsiveness")):
        value = mean(key)
        if value is not None:
            result(key, label, value, "%", **common, whole=stats is None)
    warnings = final["safety_warnings"] if stats is None else stats["safety_warnings"]
    result("safety_violations", "Safety violations", len(warnings), "", "lower", **common)
    if stats is None:
        for c in final["categories"]:
            result(
                f"cat_{c['category'].lower()}",
                f"{c['category']} · {c['label']}",
                c["percent"],
                "%",
                **common,
                whole=True,
            )
    else:
        for cat, c in stats["per_category"].items():
            result(
                f"cat_{cat.lower()}",
                f"{cat} · {c['label']}",
                c["mean_percent"],
                "%",
                **common,
                stddev=c["stddev_percent"],
            )


def excluded_note(env: dict[str, Any], board: Board) -> None:
    """Warns about the trial's scenarios that were left out of its score."""
    excluded = env["scores"].get("excluded_scenarios", [])
    if not excluded:
        return
    trial = f"Trial {board.trial}: " if board.trials > 1 else ""
    note = (
        f"{trial}{len(excluded)} of {board.total} scenarios {'was' if len(excluded) == 1 else 'were'} "
        f"excluded after timeouts or server errors ({', '.join(excluded)}); the score covers only the graded "
        "ones."
    )
    board.warnings.append(note)
    log(note)


async def evaluate(a: argparse.Namespace, model: str, engine: str, warnings: list[str]) -> int:
    thinking = not a.no_think
    scenarios = list(SUITES[a.suite])
    if a.scenarios:
        scenarios = [s for s in scenarios if s.id in a.scenarios.split(",")]
    head = {
        "version": __version__,
        "suite": a.suite,
        "thinking": thinking,
        "model": model,
        "engine": engine,
        "trials": a.trials,
        "seed": a.seed,
    }
    board = Board(scenarios, head, warnings)

    async def trials() -> list[dict[str, Any]]:
        """Every trial's envelope, as a plain copy safe to trim and send."""
        envs: list[dict[str, Any]] = []
        for k in range(a.trials):
            if k:
                board.next_trial()
            env = await run_benchmark(
                model=model,
                base_url=a.base_url,
                scenarios=scenarios,
                seed=a.seed,
                extra_params=None if thinking else {"chat_template_kwargs": {"enable_thinking": False}},
                on_scenario_start=safe(board.started),
                on_scenario_result=safe(board.finished),
                persist=False,
            )
            env = finite(json.loads(json.dumps(env, default=str)))
            excluded_note(env, board)
            if not env["scores"]["max_points"]:
                raise NothingGraded
            s = env["scores"]
            if a.trials > 1:
                log(f"Trial {board.trial} of {a.trials}: score {s['final_score']} ({s['rating']})")
            board.trial_finished(env)
            envs.append(env)
        return envs

    task = asyncio.create_task(trials())
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    t0 = time.monotonic()
    try:
        envs = await task
    except asyncio.CancelledError:
        board.stop()
        if board.started_ts is not None:
            live(finite(board.snapshot()))
        trial = f" in trial {board.trial} of {board.trials}" if board.trials > 1 else ""
        log(f"Cancelled{trial} after {board.done} of {board.total} scenarios ({time.monotonic() - t0:.1f} s)")
        return 143
    except NothingGraded:
        live(finite(board.snapshot()))
        fail(
            "No scenario could be graded",
            "Every scenario timed out or hit a connection or server error"
            + (f" in trial {board.trial} of {board.trials}." if board.trials > 1 else "."),
            "Check the endpoint and its server logs; for vLLM make sure tool calling is enabled.",
        )
    except Exception as e:
        fail(
            "tool-eval-bench stopped with an error",
            clip(f"{type(e).__name__}: {e}", 300),
            "Check the endpoint and its server logs, then run it again",
        )
    stats = trial_stats(envs, scenarios, board)
    s = envs[-1]["scores"]
    for w in s.get("safety_warnings", []) if stats is None else stats["safety_warnings"]:
        log(f"Safety: {w}")
    fingerprint = envs[-1]["config"].get("config_fingerprint")
    if stats is None:
        log(
            f"Score {s['final_score']} ({s['rating']}): {s['total_points']} of {s['max_points']} points, "
            f"{s.get('completion_rate', 100.0)}% of scenarios graded, fingerprint {fingerprint}"
        )
    else:
        log(
            f"Mean score {stats['mean']} ± {stats['stddev']} over {a.trials} trials ({stats['rating']}), "
            f"Pass@{a.trials} {stats['pass_at_k']}%, Pass^{a.trials} {stats['pass_hat_k']}%, "
            f"{stats['completion_rate']}% of scenario runs graded, fingerprint {fingerprint}"
        )
    report(envs, board, stats)
    progress(1.0, "Done")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", default="")
    ap.add_argument("--suite", choices=list(SUITES), default="standard")
    ap.add_argument("--no-think", action="store_true")
    ap.add_argument("--trials", type=int, default=1, choices=range(1, 11), metavar="1-10")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--scenarios", default="", help=argparse.SUPPRESS)  # tests: only these ids of the suite
    a = ap.parse_args()
    on_sigterm()
    progress(0.0, "Checking the endpoint")
    model, engine = endpoint_model(a.base_url, a.model)
    log(f"tool-eval-bench {__version__}: model {model}, engine {engine}")
    progress(0.02, "Checking tool calling")
    warnings = []
    if check_tool_calling(a.base_url, model, not a.no_think):
        warnings.append(THINK_WARNING)
        log(THINK_WARNING)
    progress(0.04, f"Starting tool-eval-bench {__version__}")
    sys.exit(asyncio.run(evaluate(a, model, engine, warnings)))


if __name__ == "__main__":
    main()
