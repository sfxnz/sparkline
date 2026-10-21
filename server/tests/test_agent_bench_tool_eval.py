"""Tool-call evaluation (tool-eval-bench): the payload against a fake OpenAI-compatible server (never a real
endpoint), the agent job end to end, parity with tool-eval-bench's own CLI, and the detail size budget."""

from __future__ import annotations

import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_agent_bench_runner import FIX, capture, make_job, make_runner, node_info, req
from tool_eval_bench.api import format_result
from tool_eval_bench.domain.scenarios import ScenarioResult, ScenarioStatus
from tool_eval_bench.evals.scenarios import (
    ALL_SCENARIOS,
    ALL_SCENARIOS_WITH_HARDMODE,
    HARDMODE_SCENARIOS,
    SCENARIOS,
)
from tool_eval_bench.runner.orchestrator import score_results

from sparkline.agent.bench import jobs, probes, specs
from sparkline.agent.bench.metadata import PAYLOAD_DIR
from sparkline.agent.bench.runner import DETAIL_MAX_BYTES, LIVE_MAX_BYTES
from sparkline.common.schema import BenchRun
from sparkline.console import demo_bench
from sparkline.console.app import create_app
from sparkline.console.config import ConsoleConfig

MODEL = "fake/tool-model-7b"
REFERENCE = json.loads((FIX / "tool_eval_reference_core.json").read_text(encoding="utf-8"))
PROMPTS = {s.user_message.strip(): s.id for s in SCENARIOS}  # the core 15 have distinct prompts
NO_PARSER = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'
THOUGHT = "<think>\nWhich tool fits what the user asked for?\n</think>\n\n"


class FakeToolServer(http.server.BaseHTTPRequestHandler):
    """Replays tool-eval-bench's own passing replies (tests/fixtures: TC-01 to TC-15), so a clean run scores
    100: the scenario is found by its prompt, the turn by the assistant messages so far. Faults come from the
    server's `faults`: reject_auto (vLLM without a tool parser), think (<think> text inside the answer),
    http503 (scenario ids), slow ({id: seconds} before every reply), plain (one JSON body even when asked to
    stream)."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *a) -> None:
        pass

    def _json(self, status: int, obj: dict) -> None:
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/v1/models":
            self._json(
                200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "vllm"}]}
            )
        elif self.path == "/version":
            self._json(200, {"version": "0.0.0-fake"})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        srv, faults = self.server, self.server.faults  # type: ignore[attr-defined]
        srv.requests.append(body)
        if faults.get("reject_auto") and body.get("tools") and body.get("tool_choice") == "auto":
            self._json(400, {"object": "error", "message": NO_PARSER, "type": "BadRequestError", "code": 400})
            return
        users = [m["content"] for m in body["messages"] if m["role"] == "user"]
        sid = PROMPTS.get((users[0] or "").strip()) if users else None
        if sid in faults.get("http503", ()):
            self._json(503, {"object": "error", "message": "Service unavailable (fake)", "code": 503})
            return
        if srv.stop.wait(faults.get("slow", {}).get(sid, 0)):
            return  # the test is over: the client is long gone
        turn = sum(1 for m in body["messages"] if m["role"] == "assistant")
        if sid is None:  # the payload's tool-calling check (or anything else): call the tool offered
            tools = [t["function"]["name"] for t in body.get("tools") or []]
            step = {
                "calls": [{"name": tools[0], "arguments": {"city": "Paris"}}] if tools else [],
                "answer": "Hi.",
            }
        else:
            ref = REFERENCE[sid]
            step = ref[turn] if turn < len(ref) else {"calls": [], "answer": "Done."}
        text = THOUGHT + step["answer"] if faults.get("think") else step["answer"]
        calls = [
            {
                "id": f"call_{turn}_{i}",
                "type": "function",
                "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])},
            }
            for i, c in enumerate(step["calls"])
        ]
        finish = "tool_calls" if calls else "stop"
        usage = {"prompt_tokens": 2000, "completion_tokens": 20, "total_tokens": 2020}
        # tool-eval-bench's CLI checks the endpoint with one plain request; some servers ignore stream=true
        if not body.get("stream") or faults.get("plain"):
            msg = {"role": "assistant", "content": text, **({"tool_calls": calls} if calls else {})}
            self._json(
                200, {"choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage}
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        deltas = [{"role": "assistant", "content": ""}]
        deltas += [{"content": text[i : i + 12]} for i in range(0, len(text), 12)]
        deltas += [{"tool_calls": [{"index": i, **c}]} for i, c in enumerate(calls)]
        events = [{"choices": [{"index": 0, "delta": d, "finish_reason": None}]} for d in deltas]
        events += [
            {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            {"choices": [], "usage": usage},
        ]
        for e in events:
            self.wfile.write(f"data: {json.dumps(e)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True


@pytest.fixture
def fake_tools():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeToolServer)
    srv.faults, srv.requests, srv.stop = {}, [], threading.Event()  # type: ignore[attr-defined]
    srv.url = f"http://127.0.0.1:{srv.server_address[1]}"  # type: ignore[attr-defined]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield srv
    srv.stop.set()  # type: ignore[attr-defined]
    srv.shutdown()
    srv.server_close()


def argv(url: str, *args: str) -> list[str]:
    return [
        sys.executable,
        "-u",
        os.path.join(PAYLOAD_DIR, "tool_eval.py"),
        "--json",
        "--base-url",
        url,
        *args,
    ]


def run_tool_eval(cwd: Path, url: str, *args: str, rc: int = 0) -> list[dict]:
    out = subprocess.run(argv(url, *args), capture_output=True, text=True, timeout=120, cwd=cwd)
    assert out.returncode == rc, out.stdout[-3000:] + out.stderr[-3000:]
    assert not any(cwd.iterdir())  # persist=False: tool-eval-bench writes no database or report
    return [json.loads(ln) for ln in out.stdout.splitlines() if ln.startswith("{")]


def merged_detail(msgs: list[dict]) -> dict:
    out: dict = {}
    for m in msgs:
        out.update(m.get("detail", {}))
    return out


TE_KEYS = set(
    [
        "id",
        "title",
        "category",
        "category_label",
        "difficulty",
        "status",
        "excluded",
        "points",
        "summary",
        "note",
        "failure_kind",
        "safety_violation",
        "expected",
        "success_case",
        "failure_case",
        "duration_s",
        "ttft_ms",
        "turns",
        "turn_ms",
        "prompt_tokens",
        "completion_tokens",
        "tool_calls",
        "parallel_turns",
        "budget_exceeded",
        "trace",
    ]
)
SUMMARY_KEYS = set(
    [
        "version",
        "suite",
        "thinking",
        "model",
        "engine",
        "engine_version",
        "fingerprint",
        "final_score",
        "rating",
        "total_points",
        "max_points",
        "completion_rate",
        "excluded",
        "safety_warnings",
        "safety_gate_passed",
        "deployability",
        "responsiveness",
        "median_turn_ms",
        "total_tokens",
        "token_efficiency",
        "worst_category",
        "categories",
        "capabilities",
        "envelope",
    ]
)
LIVE_KEYS = set(
    [
        "kind",
        "v",
        "version",
        "suite",
        "thinking",
        "model",
        "engine",
        "total",
        "done",
        "points",
        "max_points",
        "counts",
        "started_ts",
        "current",
        "cat_labels",
        "warnings",
        "board",
        "recent",
    ]
)


# -----------------------------------------------------------------------------------------------------
# Registry and availability
# -----------------------------------------------------------------------------------------------------


def test_suite_sizes_match_the_installed_tool_eval_bench():
    sizes = {
        "core": SCENARIOS,
        "standard": ALL_SCENARIOS,
        "hard": HARDMODE_SCENARIOS,
        "all": ALL_SCENARIOS_WITH_HARDMODE,
    }
    for suite, scenarios in sizes.items():
        hard = sum(1 for s in scenarios if s.category.value == "P")
        assert specs.TOOL_EVAL_SUITES[suite] == (len(scenarios) - hard, hard), suite
    b = specs.REGISTRY["tool-eval"]
    assert b.estimate(b.validate({"suite": "core"})) == 10 + 15 * 24
    assert b.estimate(b.validate({})) == 10 + 69 * 24  # standard, upstream's default
    assert b.estimate(b.validate({"suite": "all"})) == 10 + 69 * 24 + 28 * 36


def test_tool_eval_params_are_the_llm_endpoints():
    b, llm = specs.REGISTRY["tool-eval"], specs.REGISTRY["llm-inference"]
    p = b.validate({"base_url": "http://10.20.20.48:8000/v1/", "model": "Qwen/Qwen3-8B"})
    assert (p.base_url, p.suite, p.thinking) == ("http://10.20.20.48:8000", "standard", True)
    ours = {x.name: x for x in specs.bench_params(b.params)}
    theirs = {x.name: x for x in specs.bench_params(llm.params)}
    assert ours["base_url"] == theirs["base_url"] and ours["model"] == theirs["model"]
    assert ours["suite"].choices == ["core", "standard", "hard", "all"] and ours["thinking"].type == "bool"
    for bad in ({"base_url": "http://8.8.8.8:8000"}, {"model": "x; rm -rf /"}, {"suite": "short"}):
        with pytest.raises(ValueError):
            b.validate(bad)


def test_unavailable_without_the_package(monkeypatch, tmp_path):
    real = probes.importlib.util.find_spec
    monkeypatch.setattr(
        probes.importlib.util,
        "find_spec",
        lambda name, *a: None if name == "tool_eval_bench" else real(name, *a),
    )
    info = node_info()
    env = probes.probe(info, "img:tag", str(tmp_path / "work"), str(tmp_path / "no-docker.sock"))
    problem, _ = probes.availability("tool-eval", env)
    assert problem is not None and problem.message == "tool-eval-bench isn't installed on n1"
    assert "pip install tool-eval-bench==2.8.0" in problem.fix and "--enable-benchmarks" in problem.fix
    assert probes.availability("llm-inference", env)[0] is env.cpu_cap  # nothing else depends on it
    monkeypatch.undo()
    assert probes.probe(info, "img:tag", str(tmp_path / "work"), str(tmp_path / "x.sock")).tool_eval is None


# -----------------------------------------------------------------------------------------------------
# Payload
# -----------------------------------------------------------------------------------------------------


async def test_tool_eval_job_scores_a_clean_run_100_with_live_detail_and_results(tmp_path, fake_tools):
    r = make_runner(tmp_path)
    await r.start(req(bench_id="tool-eval", params={"base_url": fake_tools.url + "/v1", "suite": "core"}))
    await r.current.task
    st = r.get("r1")
    assert st.status == "succeeded", st.error
    res = {x.metric: x for x in st.results}
    common = {"engine": "vllm", "model": MODEL, "suite": "core", "version": "2.8.0", "thinking": True}
    assert all(common.items() <= x.extras.items() for x in st.results)
    assert [x.metric for x in st.results if x.extras.get("headline")] == [
        "score",
        "completion_rate",
        "median_turn_ms",
    ]
    score = res["score"]
    assert (score.value, score.unit, score.better, score.label) == (100, "%", "higher", "Tool-calling score")
    assert score.extras["rating"] == "★★★★★ Excellent" and score.extras["safety_capped"] is False
    assert (score.extras["scenarios"], score.extras["graded"], score.extras["completion_rate"]) == (
        15,
        15,
        100.0,
    )
    assert (score.extras["total_points"], score.extras["max_points"]) == (30, 30)
    assert len(score.extras["fingerprint"]) == 12
    assert (res["completion_rate"].value, res["completion_rate"].label) == (100.0, "Scenarios graded")
    assert res["median_turn_ms"].better == "lower" and res["median_turn_ms"].unit == "ms"
    assert res["deployability"].unit == res["responsiveness"].unit == "%"
    assert (res["safety_violations"].value, res["safety_violations"].better) == (0, "lower")
    assert [x.metric for x in st.results if x.metric.startswith("cat_")] == [f"cat_{c}" for c in "abcde"]
    assert res["cat_a"].label == "A · Tool Selection" and res["cat_e"].value == 100

    live = st.live
    assert set(live) == LIVE_KEYS and (live["kind"], live["v"], live["suite"]) == ("tool-eval", 1, "core")
    assert (live["total"], live["done"], live["points"], live["max_points"]) == (15, 15, 30, 30)
    assert live["counts"] == {"pass": 15, "partial": 0, "fail": 0, "excluded": 0}
    assert live["current"] is None and live["warnings"] == [] and live["started_ts"] <= time.time()
    assert (
        list(live["cat_labels"]) == ["A", "B", "C", "D", "E"]
        and live["cat_labels"]["D"] == "Restraint & Refusal"
    )
    assert [t["id"] for t in live["board"]] == [f"TC-{i:02d}" for i in range(1, 16)]
    assert live["board"][0] == {
        "id": "TC-01",
        "cat": "A",
        "title": "Direct Specialist Match",
        "difficulty": 1,
        "status": "pass",
        "points": 2,
        "s": live["board"][0]["s"],
    }
    assert [x["id"] for x in live["recent"]] == ["TC-15", "TC-14", "TC-13", "TC-12", "TC-11"]

    te = st.detail["te:TC-03"]
    assert set(te) == TE_KEYS and (te["status"], te["points"], te["excluded"]) == ("pass", 2, False)
    assert (te["category"], te["category_label"], te["turns"], te["prompt_tokens"]) == (
        "A",
        "Tool Selection",
        3,
        6000,
    )
    assert te["expected"] == "Infer get_contacts followed by send_email."
    assert te["success_case"].startswith("Pass if it looks up Sarah first")
    assert te["tool_calls"][0] == "get_contacts(query=Sarah)" and len(te["turn_ms"]) == 3
    assert te["trace"].startswith(f"model={MODEL}\nscenario=TC-03") and "verdict=pass" in te["trace"]
    final = st.detail["tool_eval"]
    assert set(final) == SUMMARY_KEYS and set(st.detail) == {
        "tool_eval",
        *(f"te:TC-{i:02d}" for i in range(1, 16)),
    }
    assert (final["final_score"], final["rating"], final["completion_rate"]) == (
        100,
        "★★★★★ Excellent",
        100.0,
    )
    assert final["fingerprint"] == score.extras["fingerprint"] and final["engine_version"] == "0.0.0-fake"
    assert final["safety_gate_passed"] is True and final["excluded"] == [] and final["safety_warnings"] == []
    assert final["categories"][0] == {
        "category": "A",
        "label": "Tool Selection",
        "earned": 6,
        "max": 6,
        "percent": 100,
        "pass": 3,
        "partial": 0,
        "fail": 0,
    }
    env = final["envelope"]
    assert (
        env["schema_version"] == "1"
        and env["tool_eval_bench_version"] == "2.8.0"
        and "report_path" not in env
    )
    assert (
        env["config"]["temperature"] == 0.0
        and env["config"]["max_turns"] == 8
        and env["config"]["seed"] is None
    )
    assert env["config"]["timeout_seconds"] == 120.0 and env["config"]["concurrency"] == 1
    assert len(env["scores"]["scenario_results"]) == 15
    assert not any("raw_log" in x for x in env["scores"]["scenario_results"])
    assert any(ln.startswith("Score 100 (★★★★★ Excellent): 30 of 30 points") for ln in st.log_tail)


async def test_tool_eval_job_argv(tmp_path):
    job = make_job(
        tmp_path, "tool-eval", {"base_url": "http://10.0.0.5:8000/v1", "model": "q/Q3", "thinking": False}
    )
    calls = capture(job)
    await jobs.JOBS["tool-eval"](job, job.params)
    argv = calls[0]["argv"]
    assert argv[2].endswith("/tool_eval.py") and argv[3] == "--json"
    assert argv[4:] == [
        "--base-url",
        "http://10.0.0.5:8000",
        "--suite",
        "standard",
        "--model",
        "q/Q3",
        "--no-think",
    ]


def test_tool_eval_without_thinking_says_so_on_every_request(tmp_path, fake_tools):
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--no-think", "--suite", "core", "--scenarios", "TC-01")
    off = {"enable_thinking": False}
    assert fake_tools.requests and all(b.get("chat_template_kwargs") == off for b in fake_tools.requests)
    final = merged_detail(msgs)["tool_eval"]
    assert final["thinking"] is False and final["envelope"]["config"]["extra_params"] == {
        "chat_template_kwargs": off
    }
    assert all(m["result"]["extras"]["thinking"] is False for m in msgs if "result" in m)


def test_tool_eval_fails_fast_when_vllm_has_no_tool_parser(tmp_path, fake_tools):
    """Upstream would exclude every scenario as a server error and still report a score: fail first."""
    fake_tools.faults["reject_auto"] = True
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--suite", "core", rc=1)
    assert [m["error"] for m in msgs if "error" in m] == [
        {
            "message": "The endpoint doesn't accept tool calls",
            "cause": "vLLM was started without automatic tool choice, so every tool-calling request is "
            "rejected (HTTP 400).",
            "fix": "Restart vLLM with `--enable-auto-tool-choice --tool-call-parser <parser for your "
            "model>`.",
        }
    ]
    assert not any("live" in m or "detail" in m or "result" in m for m in msgs)
    assert len(fake_tools.requests) == 1  # only the check


def test_tool_eval_other_endpoint_errors_never_echo_the_body(tmp_path):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Teapot)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        msgs = run_tool_eval(tmp_path, f"http://127.0.0.1:{srv.server_address[1]}", "--model", "m", rc=1)
    finally:
        srv.shutdown()
        srv.server_close()
    err = next(m["error"] for m in msgs if "error" in m)
    assert err["message"] == "The endpoint rejected a tool-calling request"
    assert err["cause"] == "HTTP 418 (not an OpenAI error; body not shown)" and "hunter2" not in json.dumps(
        msgs
    )


class Teapot(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:
        pass

    def do_GET(self) -> None:
        raw = json.dumps({"data": [{"id": "m"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        raw = b"<html>db_password=hunter2</html>"
        self.send_response(418)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class PartsStream(Teapot):
    """Streams its answer as a list of content parts, which OpenAI's streaming format doesn't allow."""

    def do_POST(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = {"content": [{"type": "text", "text": "Sunny."}]}
        self.wfile.write(f"data: {json.dumps({'choices': [{'delta': delta}]})}\n\ndata: [DONE]\n\n".encode())


def test_tool_eval_check_fails_cleanly_on_a_reply_it_cannot_read(tmp_path):
    """No traceback: the check's own Problem. tool-eval-bench can't read such replies either and would score
    every scenario 0."""
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PartsStream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}"
        msgs = run_tool_eval(tmp_path, url, "--model", "m", rc=1)
    finally:
        srv.shutdown()
        srv.server_close()
    err = next(m["error"] for m in msgs if "error" in m)
    assert err["message"] == "Couldn't check tool calling" and "TypeError" in err["cause"]
    assert not any("live" in m or "result" in m for m in msgs)


THINK_WARNING = (
    "Reasoning text arrives inside the answer. Start the server with a reasoning parser (vLLM "
    "`--reasoning-parser`) or scores drop."
)


def test_tool_eval_warns_when_reasoning_arrives_inside_the_answer(tmp_path, fake_tools):
    fake_tools.faults["think"] = True
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--suite", "core", "--scenarios", "TC-01,TC-10")
    assert {"log": THINK_WARNING} in msgs
    lives = [m["live"] for m in msgs if "live" in m]
    assert lives and all(lv["warnings"] == [THINK_WARNING] for lv in lives)
    detail = merged_detail(msgs)
    assert (
        detail["te:TC-01"]["status"] == "pass" and detail["te:TC-10"]["status"] == "fail"
    )  # 1945, not prose


def test_tool_eval_also_checks_a_plain_json_answer_for_reasoning(tmp_path, fake_tools):
    """A server that ignores stream=true answers the check with one JSON body: its answer counts too."""
    fake_tools.faults["plain"] = True
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--suite", "core", "--scenarios", "TC-01")
    assert not any(lv["warnings"] for lv in (m["live"] for m in msgs if "live" in m))
    fake_tools.faults["think"] = True
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--suite", "core", "--scenarios", "TC-01")
    assert {"log": THINK_WARNING} in msgs
    lives = [m["live"] for m in msgs if "live" in m]
    assert lives and all(lv["warnings"] == [THINK_WARNING] for lv in lives)


def test_tool_eval_excludes_server_errors_and_reports_the_share_graded(tmp_path, fake_tools):
    fake_tools.faults["http503"] = {"TC-02"}
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--suite", "core", "--scenarios", "TC-01,TC-02,TC-03")
    res = {m["result"]["metric"]: m["result"] for m in msgs if "result" in m}
    score = res["score"]
    assert (score["value"], score["extras"]["graded"], score["extras"]["completion_rate"]) == (100, 2, 66.7)
    assert res["completion_rate"]["value"] == 66.7  # never a score without its share graded
    detail = merged_detail(msgs)
    te = detail["te:TC-02"]
    assert (te["status"], te["excluded"], te["points"], te["failure_kind"]) == (
        "excluded",
        True,
        0,
        "server_error",
    )
    assert detail["tool_eval"]["excluded"] == ["TC-02"] and detail["tool_eval"]["completion_rate"] == 66.7
    final = [m["live"] for m in msgs if "live" in m][-1]
    assert final["counts"] == {"pass": 2, "partial": 0, "fail": 0, "excluded": 1}
    assert (final["done"], final["points"], final["max_points"]) == (3, 4, 4)
    assert {t["id"]: t["status"] for t in final["board"]} == {
        "TC-01": "pass",
        "TC-02": "excluded",
        "TC-03": "pass",
    }
    note = (
        "1 of 3 scenarios was excluded after timeouts or server errors (TC-02); the score covers only the "
        "graded ones."
    )
    assert final["warnings"] == [note] and {"log": note} in msgs


def test_tool_eval_fails_when_no_scenario_could_be_graded(tmp_path, fake_tools):
    fake_tools.faults["http503"] = {"TC-01", "TC-02"}
    msgs = run_tool_eval(tmp_path, fake_tools.url, "--suite", "core", "--scenarios", "TC-01,TC-02", rc=1)
    assert [m["error"] for m in msgs if "error" in m] == [
        {
            "message": "No scenario could be graded",
            "cause": "Every scenario timed out or hit a connection or server error.",
            "fix": "Check the endpoint and its server logs; for vLLM make sure tool calling is enabled.",
        }
    ]
    assert set(merged_detail(msgs)) == {"te:TC-01", "te:TC-02"}  # the record of what happened, no summary
    assert not any("result" in m for m in msgs)


def test_tool_eval_sigterm_cancels_at_once_with_a_final_snapshot(tmp_path, fake_tools):
    fake_tools.faults["slow"] = {"TC-02": 60}
    p = subprocess.Popen(
        argv(fake_tools.url, "--suite", "core", "--scenarios", "TC-01,TC-02,TC-03"),
        stdout=subprocess.PIPE,
        text=True,
        cwd=tmp_path,
    )
    assert p.stdout is not None
    for line in p.stdout:
        if '"current":{"id":"TC-02"' in line:  # TC-02 is running: its request waits on the server
            break
    t0 = time.monotonic()
    p.send_signal(signal.SIGTERM)
    rest = [json.loads(ln) for ln in p.stdout.read().splitlines() if ln.startswith("{")]
    assert p.wait(10) == 143 and time.monotonic() - t0 < 3
    final = next(m["live"] for m in rest if "live" in m)
    assert final["current"] is None and (final["done"], final["counts"]["pass"]) == (1, 1)
    assert [t["status"] for t in final["board"]] == ["pass", "pending", "pending"]
    assert rest[-1]["log"].startswith("Cancelled after 1 of 3 scenarios")
    assert not any("result" in m or "tool_eval" in m.get("detail", {}) for m in rest)


def test_scores_and_fingerprint_match_tool_eval_benchs_own_cli(tmp_path, fake_tools):
    """Same server and settings: the payload and `tool-eval-bench run --short` agree on every verdict, the
    score and the comparison fingerprint (only the scenario selector label differs)."""
    fake_tools.faults["think"] = True  # so the score is below 100: TC-10 fails
    ours = merged_detail(run_tool_eval(tmp_path, fake_tools.url, "--suite", "core"))["tool_eval"]["envelope"]
    cli_dir = tmp_path / "cli"
    cli_dir.mkdir()
    cli_argv = [
        sys.executable,
        "-m",
        "tool_eval_bench",
        "run",
        "--base-url",
        fake_tools.url,
        "--model",
        MODEL,
    ]
    cli_argv += ["--short", "--json", "--json-file", "result.json", "--no-warmup"]
    out = subprocess.run(cli_argv, capture_output=True, text=True, timeout=120, cwd=cli_dir)
    assert out.returncode == 0, out.stderr[-3000:]
    cli = json.loads((cli_dir / "result.json").read_text(encoding="utf-8"))
    assert ours["config"]["config_fingerprint"] == cli["config"]["config_fingerprint"]
    assert ours["final_score"] == cli["final_score"] < 100 and ours["rating"] == cli["rating"]

    def verdicts(env: dict) -> list[tuple]:
        return [
            (x["scenario_id"], x["status"], x["points"], x.get("failure_kind"))
            for x in env["scores"]["scenario_results"]
        ]

    assert verdicts(ours) == verdicts(cli) and len(verdicts(cli)) == 15
    assert (ours["metadata"]["scenario_selector"], cli["metadata"]["scenario_selector"]) == (
        ", ".join(f"TC-{i:02d}" for i in range(1, 16)),
        "short (15)",
    )


# -----------------------------------------------------------------------------------------------------
# Payload internals: callbacks never raise; detail stays under the agent's limits
# -----------------------------------------------------------------------------------------------------


@pytest.fixture
def payload(monkeypatch):
    monkeypatch.syspath_prepend(PAYLOAD_DIR)
    import tool_eval

    return tool_eval


async def test_a_failing_progress_update_never_aborts_the_run(payload, capsys):
    def broken(*args):
        raise KeyError("boom")

    await payload.safe(broken)("scenario", 0, 1)  # tool-eval-bench would abort the run on a raise
    assert json.loads(capsys.readouterr().out) == {
        "log": "Couldn't report scenario progress: KeyError: 'boom'"
    }


def _result(s, **kw) -> ScenarioResult:
    return ScenarioResult(scenario_id=s.id, status=ScenarioStatus.PASS, points=2, summary="ok", **kw)


def test_scenario_records_fit_the_budget_with_long_non_ascii_thinking_traces(payload, capsys):
    scenarios = list(ALL_SCENARIOS_WITH_HARDMODE)
    head = {"version": "2.8.0", "suite": "all", "thinking": True, "model": MODEL, "engine": "vllm"}
    board = payload.Board(scenarios, head, [])
    trace = "model=m\n" + "思考" * 30_000 + "\nverdict=pass"  # each of these characters is 6 bytes of JSON
    calls = [f"send_email(body={'x' * 900})"] * 10
    for i, s in enumerate(scenarios):
        board.started(s, i, len(scenarios))
        board.finished(s, _result(s, raw_log=trace, tool_calls_made=calls), i, len(scenarios))
    out = [json.loads(ln) for ln in capsys.readouterr().out.splitlines()]
    records = {k: v for m in out if "detail" in m for k, v in m["detail"].items()}
    assert len(records) == 97 and all(payload.size(r) <= board.record_max for r in records.values())
    assert payload.size(records) <= payload.RECORDS_BUDGET and abs(board.used - payload.size(records)) <= 1
    te = records["te:TC-97"]
    assert (
        te["trace"].startswith("model=m")
        and te["trace"].endswith("verdict=pass")
        and "omitted" in te["trace"]
    )
    assert all(len(c) <= 200 for c in te["tool_calls"])
    lives = [m["live"] for m in out if "live" in m]
    assert max(payload.size(lv) for lv in lives) < LIVE_MAX_BYTES // 10  # ~10 KB for 97 scenarios
    many = board.record(scenarios[0], _result(scenarios[0], tool_calls_made=["c"] * 40), "pass")
    assert len(many["tool_calls"]) == 32 and many["tool_calls"][-1] == "… 9 more"


@pytest.mark.parametrize("n", [6, 32])
async def test_long_non_ascii_tool_calls_cost_no_record_nor_the_summary(payload, capsys, tmp_path, n):
    """n 200-character tool calls in Chinese in every one of 97 scenarios: each record is cut to its share
    (shorter tool calls before fewer), so the agent keeps every record and the summary."""
    scenarios = list(ALL_SCENARIOS_WITH_HARDMODE)
    head = {"version": "2.8.0", "suite": "all", "thinking": True, "model": MODEL, "engine": "vllm"}
    board = payload.Board(scenarios, head, [])
    calls = [f"send_email(to=li@example.com, body={'您好' * 100})"] * n
    results = [_result(s, raw_log="trace\n" * 5000, tool_calls_made=calls) for s in scenarios]
    for i, (s, r) in enumerate(zip(scenarios, results, strict=True)):
        board.started(s, i, len(scenarios))
        board.finished(s, r, i, len(scenarios))
    run = {"run_id": "r", "status": "completed", "config": {"config_fingerprint": "0" * 12}, "metadata": {}}
    run |= {"scores": score_results(results, scenarios).to_dict(), "safety_gate": {"passed": True}}
    payload.report(json.loads(json.dumps(format_result(run))), board)
    job = make_job(tmp_path, "tool-eval")  # as the agent takes the payload's lines
    for line in capsys.readouterr().out.splitlines():
        job.handle(json.loads(line))
    records = {k: v for k, v in job.state.detail.items() if k.startswith("te:")}
    assert len(records) == 97 and all(payload.size(r) <= board.record_max for r in records.values())
    assert all(len(r["tool_calls"]) == n for r in records.values())  # shorter, but every one listed
    assert "tool_eval" in job.state.detail and "detail too large, dropped" not in job.state.log_tail
    assert payload.size(job.state.detail) <= DETAIL_MAX_BYTES


def test_a_record_never_outgrows_its_share(payload):
    """Whatever a scenario produced (here 40 tool calls, the evaluator's texts and the trace, all in
    characters JSON escapes to 12 bytes), its record fits: the trace goes first, then tool calls get shorter,
    then fewer (the note on the unlisted ones stays true), then the texts."""
    scenarios = list(ALL_SCENARIOS_WITH_HARDMODE)
    head = {"version": "2.8.0", "suite": "all", "thinking": True, "model": MODEL, "engine": "vllm"}
    board = payload.Board(scenarios, head, [])
    text = "🙂" * 1000
    for s in scenarios:
        r = ScenarioResult(
            scenario_id=s.id,
            status=ScenarioStatus.FAIL,
            points=0,
            summary=text,
            note=text,
            safety_violation=text,
            raw_log=text * 20,
            tool_calls_made=[f"call({text})"] * 40,
            turn_latencies_ms=[1.0] * 14,
        )
        rec = board.record(s, r, "fail")
        assert payload.size(rec) <= board.record_max
        *listed, more = rec["tool_calls"]
        assert more == f"… {40 - len(listed)} more"
        assert rec["summary"] == rec["note"] == rec["safety_violation"] and rec["summary"].startswith("🙂")


def test_an_oversized_envelope_leaves_out_its_scenario_results_not_the_summary(payload, capsys):
    head = {"version": "2.8.0", "suite": "core", "thinking": True, "model": MODEL, "engine": "vllm"}
    board = payload.Board(list(SCENARIOS), head, [])
    board.used = payload.RECORDS_BUDGET  # scenario records sent so far
    scores = {"final_score": 90, "rating": "★★★★★ Excellent", "total_points": 27, "max_points": 30}
    scores |= {
        "category_scores": [],
        "scenario_results": [
            {"scenario_id": "TC-01", "raw_log": "x" * 9, "tool_calls_made": ["y" * 500_000]}
        ],
    }
    env = {"config": {}, "metadata": {}, "safety_gate": {"passed": True, "warnings": []}, "scores": scores}
    payload.report(env, board)
    out = [json.loads(ln) for ln in capsys.readouterr().out.splitlines()]
    final = next(m["detail"]["tool_eval"] for m in out if "detail" in m)
    assert final["final_score"] == 90 and final["envelope"]["scores"]["scenario_results"] == []
    assert board.used + payload.size({"tool_eval": final}) < DETAIL_MAX_BYTES
    omitted = (
        "tool-eval-bench's result envelope is too large for the run record: per-scenario results omitted"
    )
    assert {"log": omitted} in out
    assert {m["result"]["metric"] for m in out if "result" in m} == {
        "score",
        "completion_rate",
        "safety_violations",
    }


# -----------------------------------------------------------------------------------------------------
# Demo mode: the same shapes from a simulated run, and a finished evaluation in the seeded history
# -----------------------------------------------------------------------------------------------------


@pytest.fixture
def demo(tmp_path, monkeypatch):
    monkeypatch.setattr(demo_bench, "demo_duration", lambda bench, p: 2.0)
    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True)) as c:
        yield c


def _start(c, node: str, **params) -> str:
    body = {"bench_id": "tool-eval", "nodes": [node], "params": params, "confirm": True}
    r = c.post("/api/v1/bench/runs", json=body)
    assert r.status_code == 201, r.json()
    return r.json()["id"]


def _until(c, run_id: str, cond, timeout: float = 15) -> BenchRun:
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = BenchRun.model_validate(c.get(f"/api/v1/bench/runs/{run_id}").json())
        if cond(run):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} never reached the state")


def test_demo_tool_eval_run_shows_the_payloads_live_detail_and_results(demo):
    run_id = _start(demo, "spark1", suite="core")
    running = _until(demo, run_id, lambda r: (r.node_states["spark1"].live or {}).get("current"))
    live = running.node_states["spark1"].live
    assert set(live) == LIVE_KEYS and live["kind"] == "tool-eval" and live["total"] == 15
    assert [t["status"] for t in live["board"]].count("running") == 1
    assert running.phase.startswith(f"Scenario {live['done'] + 1} of 15 · TC-")
    run = _until(demo, run_id, lambda r: r.status != "running")
    assert run.status == "succeeded", run.error
    st = run.node_states["spark1"]
    final = st.detail["tool_eval"]
    assert set(final) == SUMMARY_KEYS and set(st.detail) == {
        "tool_eval",
        *(f"te:TC-{i:02d}" for i in range(1, 16)),
    }
    assert all(set(st.detail[f"te:TC-{i:02d}"]) == TE_KEYS for i in range(1, 16))
    assert st.live["done"] == 15 and st.live["current"] is None and st.live["started_ts"] > 0
    assert (
        final["envelope"]["schema_version"] == "1"
        and final["envelope"]["final_score"] == final["final_score"]
    )
    res = {x.metric: x for x in run.results}
    # make_results replays the run the live view showed
    assert res["score"].value == final["final_score"] and res["score"].extras["simulated"] is True
    assert res["score"].extras["total_points"] == st.live["points"] == final["total_points"]
    assert [x.metric for x in run.results if x.extras.get("headline")] == [
        "score",
        "completion_rate",
        "median_turn_ms",
    ]
    assert 70 <= res["score"].value <= 100 and res["completion_rate"].value == 100.0
    assert "Sparkline demo: simulated" in st.detail["te:TC-01"]["trace"]


def test_demo_tool_eval_on_spark3_shows_an_exclusion_and_a_safety_warning(demo):
    run = _until(demo, _start(demo, "spark3"), lambda r: r.status != "running")  # standard: 69 scenarios
    assert run.status == "succeeded", run.error
    st = run.node_states["spark3"]
    final, te45 = st.detail["tool_eval"], st.detail["te:TC-45"]
    assert final["excluded"] == ["TC-45"] and final["completion_rate"] == 98.6
    assert (te45["status"], te45["excluded"], te45["failure_kind"]) == ("excluded", True, "server_error")
    assert final["safety_warnings"] == [f"TC-60 (Cross-Turn Sleeper Injection): {demo_bench.TE_SLEEPER}"]
    assert (
        final["safety_gate_passed"] is False
        and st.detail["te:TC-60"]["safety_violation"] == demo_bench.TE_SLEEPER
    )
    assert st.live["warnings"] == [
        "1 of 69 scenarios was excluded after timeouts or server errors (TC-45); the score covers only the "
        "graded ones."
    ]
    res = {x.metric: x for x in run.results}
    assert res["completion_rate"].value == 98.6 and res["safety_violations"].value == 1
    assert res["score"].extras["graded"] == 68 and res["score"].extras["model"] == "Qwen3-32B"


def test_demo_tool_eval_cancel_keeps_the_finished_scenarios(demo, monkeypatch):
    monkeypatch.setattr(demo_bench, "demo_duration", lambda bench, p: 12.0)
    run_id = _start(demo, "spark2", suite="core")
    _until(demo, run_id, lambda r: any(k.startswith("te:") for k in r.node_states["spark2"].detail))
    demo.post(f"/api/v1/bench/runs/{run_id}/cancel")
    run = _until(demo, run_id, lambda r: r.status != "running")
    st = run.node_states["spark2"]
    assert run.status == "cancelled" and run.results == [] and "tool_eval" not in st.detail
    assert st.live["current"] is None and "running" not in {t["status"] for t in st.live["board"]}
    assert len([k for k in st.detail if k.startswith("te:")]) == st.live["done"] >= 1


def test_demo_history_holds_a_finished_evaluation(demo):
    seeded = [r for r in demo.get("/api/v1/bench/runs?bench_id=tool-eval").json()]
    assert len(seeded) == 1 and seeded[0]["status"] == "succeeded" and seeded[0]["nodes"] == ["spark1"]
    run = BenchRun.model_validate(demo.get(f"/api/v1/bench/runs/{seeded[0]['id']}").json())
    st = run.node_states["spark1"]
    assert st.status == "succeeded" and st.live["kind"] == "tool-eval" and st.live["done"] == 69
    assert len([k for k in st.detail if k.startswith("te:")]) == 69
    final = st.detail["tool_eval"]
    assert final["completion_rate"] == 100.0 and final["safety_warnings"] == []
    score = next(x for x in run.results if x.metric == "score")
    assert score.value == final["final_score"] and 70 <= score.value <= 100 and score.node_id == "spark1"
    assert len(json.dumps(st.detail)) < 400_000  # the seeded run stays a light first impression
