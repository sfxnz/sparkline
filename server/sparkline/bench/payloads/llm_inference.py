"""LLM inference benchmark against an OpenAI-compatible endpoint (host Python, stdlib only).

Streams /v1/chat/completions (or /v1/completions) with stream=true and measures per request: time to first
token (TTFT), prefill tok/s = prompt tokens / TTFT, decode tok/s = (completion tokens - 1) / (last token -
first token). Aggregate decode tok/s = all completion tokens / wall time. Token counts come from the server's
usage block when it sends one, otherwise from the number of streamed content chunks.

Requests run on stream slots: each of a level's streams sends its next request as soon as its previous one
ends (closed loop) until the level's requests are done; --sweep runs levels of 1, 2, 4 ... streams up to
--concurrency one after another. Every 0.25 s a live snapshot shows each stream's state, tokens, recent tok/s
and the tail of its text; each level's summary and request timeline go to the run's detail when it ends.
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import math
import socket
import statistics
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, cast
from urllib.parse import urlsplit

from benchlib import detail, fail, live, log, on_sigterm, progress, result

TEXT = (
    "the river carries light across the valley while engineers measure every quiet signal from the cluster "
    "and write careful notes about memory clocks heat and power before the evening shift begins"
)
WORDS = TEXT.split()
GENERIC_OWNERS = {"", "system", "openai", "organization-owner", "user", "owner"}
LIVE_EVERY_S = 0.25  # live snapshot interval (the agent publishes at most 2/s)
SLOT_RATE_S = 1.5  # a stream's tok/s: tokens over its last 1.5 s ...
RATE_MIN_S = 0.5  # ... once that spans 0.5 s (two tokens a few ms apart would make a bogus peak)
AGG_RATE_S = 2.0  # aggregate output tok/s window
HIST_MAX = 240  # tok_s_hist points, one per 0.5 s
TEXT_TAIL, THINK_TAIL = 280, 160  # characters of answer and reasoning text per stream in a snapshot
TIMELINE_ROWS = 256  # request records per level in the detail
LOCK = threading.Lock()  # slots and level counters; a worker holds it for a few assignments per chunk
STOP = threading.Event()  # set on SIGTERM: workers take no more requests and record nothing
OPEN: set[socket.socket] = set()  # sockets of requests in flight, shut down on SIGTERM so reads return


def http_error(status: int, body: bytes) -> str:
    """An endpoint's error, without echoing what it sent back: only an OpenAI-style error message is shown.
    Anything else (an HTML page, another service's data) stays out of the run record and the browser."""
    try:
        obj = json.loads(body)
    except ValueError:
        obj = None
    msg = None
    if isinstance(obj, dict):
        err = obj.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            msg = err["message"]
        elif obj.get("object") == "error" and isinstance(obj.get("message"), str):  # vLLM
            msg = obj["message"]
    return f"HTTP {status}: {msg[:200]}" if msg else f"HTTP {status} (not an OpenAI error; body not shown)"


def connect(base: str, timeout: float) -> tuple[http.client.HTTPConnection, str]:
    u = urlsplit(base)
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    return cls(cast(str, u.hostname), u.port, timeout=timeout), u.path.rstrip("/")


def get_json(base: str, path: str) -> tuple[dict, dict]:
    conn, prefix = connect(base, 10)
    try:
        conn.request("GET", prefix + path, headers={"Accept": "application/json"})
        r = conn.getresponse()
        body = r.read()
        if r.status != 200:
            raise OSError(f"GET {path} returned {http_error(r.status, body)}")
        return json.loads(body), {k.lower(): v for k, v in r.getheaders()}
    finally:
        conn.close()


def make_prompt(n_tokens: int, i: int) -> str:
    # ~1 token per common word; a unique prefix per request defeats prefix caching
    words = [WORDS[k % len(WORDS)] for k in range(max(1, n_tokens - 12))]
    return f"Request {i} {uuid.uuid4().hex[:8]}. Summarise this text: " + " ".join(words)


def levels(concurrency: int, sweep: bool) -> list[int]:
    """Streams per level, as sparkline.agent.bench.specs.levels: [concurrency], or when sweeping the powers of
    two below it and then concurrency itself."""
    out, k = [], 1
    while sweep and k < concurrency:
        out.append(k)
        k *= 2
    return [*out, concurrency]


def _str(v: Any) -> str:
    return v if isinstance(v, str) else ""


def one_request(
    base: str,
    api: str,
    model: str,
    prompt: str,
    max_tokens: int,
    live_usage: bool = False,
    slot: Slot | None = None,
) -> dict:
    conn, prefix = connect(base, 300)
    body: dict = {"model": model, "max_tokens": max_tokens, "stream": True, "temperature": 0}
    body["stream_options"] = {"include_usage": True}
    if live_usage:  # vLLM: usage in every chunk keeps live token counts exact when a chunk holds several
        body["stream_options"]["continuous_usage_stats"] = True
    if api == "chat":
        body["messages"] = [{"role": "user", "content": prompt}]
        path = "/v1/chat/completions"
    else:
        body["prompt"] = prompt
        path = "/v1/completions"
    out: dict[str, Any] = {
        "ttft": None,
        "first": None,
        "last": None,
        "eos": None,
        "chunks": 0,
        "usage": None,
        "error": None,
    }
    sock = None
    t0 = time.perf_counter()
    try:
        conn.connect()
        sock = conn.sock
        with LOCK:
            OPEN.add(sock)
        conn.request("POST", prefix + path, json.dumps(body), {"Content-Type": "application/json"})
        r = conn.getresponse()
        if r.status != 200:
            out["error"] = http_error(r.status, r.read(4096))
            return out
        while True:
            line = r.readline()
            if not line:
                break
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                break
            msg = json.loads(data)
            if msg.get("usage"):
                out["usage"] = msg["usage"]
            answer = thought = ""
            for ch in msg.get("choices") or []:
                d = ch.get("delta") or {}
                text = ch.get("text") or d.get("content") or d.get("reasoning_content") or d.get("reasoning")
                if text:
                    now = time.perf_counter()
                    if out["first"] is None:
                        out["first"] = now
                        out["ttft"] = now - t0
                    out["last"] = now
                    out["chunks"] += 1
                    answer += _str(ch.get("text") or d.get("content"))
                    thought += _str(d.get("reasoning_content") or d.get("reasoning"))
                elif ch.get("finish_reason") and out["first"] is not None:
                    # A stop token (EOS) streams as an empty chunk with the finish reason. usage counts it in
                    # completion_tokens, so with usage it is the last token (see tokens_of()).
                    out["eos"] = time.perf_counter()
            if slot is not None:
                usage = msg.get("usage")
                used = usage.get("completion_tokens") if live_usage and isinstance(usage, dict) else None
                slot.chunk(out, answer, thought, used)
        out["total"] = time.perf_counter() - t0
    except (OSError, ValueError, http.client.HTTPException) as e:
        out["error"] = f"{type(e).__name__}: {e}"
    finally:
        if sock is not None:
            with LOCK:
                OPEN.discard(sock)
        conn.close()
    return out


def pct(vals: list[float], q: float) -> float:
    """Nearest-rank percentile (p50 of [1, 2] is 1)."""
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, math.ceil(q / 100 * len(s)) - 1))]


def tokens_of(r: dict, prompt_tokens: int) -> tuple[Any, Any, float | None]:
    """A request's prompt and completion tokens (the server's usage, else --prompt-tokens and the number of
    text chunks) and its decode tok/s, None without at least two tokens over a time span."""
    usage = r["usage"] or {}
    p_tok = usage.get("prompt_tokens") or prompt_tokens
    c_tok = usage.get("completion_tokens") or r["chunks"]
    # usage counts a stop token that streams no text: then the decode span ends at its (empty) chunk
    last = r["eos"] if usage.get("completion_tokens") and r["eos"] else r["last"]
    if r["first"] is None or c_tok <= 1 or last <= r["first"]:
        return p_tok, c_tok, None
    return p_tok, c_tok, (c_tok - 1) / (last - r["first"])


def rnd(v: float | None, digits: int = 1) -> float | None:
    """Rounded for the live snapshot and detail, which never carry NaN or inf (None instead)."""
    return round(v, digits) if v is not None and math.isfinite(v) else None


def ms(seconds: float | None) -> float | None:
    return rnd(seconds * 1000) if seconds is not None else None


def streams(n: int) -> str:
    return f"{n} stream" if n == 1 else f"{n} streams"


class Slot:
    """One stream of a level: its worker writes it per chunk and the reporter reads it, both under LOCK."""

    def __init__(self, level: Level, index: int) -> None:
        self.level, self.index = level, index
        self.req = 0  # 1-based request number within the level; 0 = none yet
        self.state = "idle"  # idle | wait | decode | done | error
        self.tokens = self.n_first = 0  # tokens of the current request; at its first token
        self.sent: float | None = None
        self.first: float | None = None
        self.ended: float | None = None
        self.ttft: float | None = None
        self.final_tok_s: float | None = None
        self.text = self.think = ""  # tails of the current request's answer and reasoning
        self.chars = self.think_chars = 0  # all answer/reasoning characters of this slot so far (only grow)
        self.error: str | None = None

    def begin(self, req: int) -> None:
        """A new request on this slot (under LOCK): waiting for its first token."""
        self.req, self.state, self.sent = req, "wait", time.perf_counter()
        self.tokens = self.n_first = 0
        self.first = self.ended = self.ttft = self.final_tok_s = None
        self.text = self.think = ""
        self.error = None

    def chunk(self, out: dict, answer: str, thought: str, used: Any) -> None:
        """One streamed message: the token count (vLLM's per-chunk usage when it sends one, else text chunks),
        the switch to decoding at the first token of either kind (TTFT), and the text tails."""
        with LOCK:
            n = used if isinstance(used, int) else out["chunks"]
            if n > self.tokens:
                self.level.total += n - self.tokens
                self.tokens = n
            if self.first is None and out["first"] is not None:
                self.first, self.ttft, self.state = out["first"], out["ttft"], "decode"
                self.n_first = self.tokens
                self.level.ttfts.append(out["ttft"])
            if answer:
                self.text = (self.text + answer)[-TEXT_TAIL:]
                self.chars += len(answer)
            if thought:
                self.think = (self.think + thought)[-THINK_TAIL:]
                self.think_chars += len(thought)

    def finish(self, r: dict) -> None:
        """The request ended (under LOCK): done with its final token count and decode rate, or error."""
        self.ended = r["end"]
        if r["ok"]:
            self.state, self.tokens, self.final_tok_s = "done", r["tokens"], r["decode"]
        else:
            self.state, self.error = "error", (r["error"] or "no tokens streamed")[:200]

    def view(self, now: float) -> dict:
        """The snapshot entry, without the rates (the reporter fills those in)."""
        return {
            "slot": self.index,
            "req": self.req,
            "state": self.state,
            "tokens": self.tokens,
            "max": self.level.a.max_tokens,
            "ttft_ms": ms(self.ttft),
            "tok_s": None,
            "peak_tok_s": None,
            "elapsed_ms": ms((self.ended or now) - self.sent) if self.sent is not None else None,
            "text": self.text,
            "chars": self.chars,
            "think": self.think,
            "think_chars": self.think_chars,
            "error": self.error,
        }


class Level:
    """One concurrency level: a worker thread per slot takes the next request as soon as its last one ends;
    the main thread reports every LIVE_EVERY_S. Workers change only the counters marked theirs, under LOCK."""

    def __init__(
        self, a: argparse.Namespace, model: str, live_usage: bool, index: int, completed: list[dict]
    ) -> None:
        self.a, self.model, self.live_usage, self.index = a, model, live_usage, index
        self.sizes = levels(a.concurrency, a.sweep)
        self.counts = [max(a.requests, size) for size in self.sizes]  # every level gets a full wave at least
        self.size = self.sizes[index]
        self.completed = completed  # summaries of the finished levels, this one too once it ends
        self.prompts = [make_prompt(a.prompt_tokens, i) for i in range(self.counts[index])]
        self.slots = [Slot(self, i) for i in range(self.size)]
        self.records: list[dict] = [{} for _ in self.prompts]
        # the workers'
        self.next = self.done = self.failed = self.total = 0  # total: tokens streamed by every slot
        self.ttfts: list[float] = []
        self.running = self.size
        self.finished = threading.Event()
        # the reporter's
        self.t0 = 0.0
        self.windows: list[deque[tuple[float, int]]] = [deque() for _ in self.slots]
        self.window_req = [0] * self.size
        self.peak: list[float | None] = [None] * self.size
        self.agg: deque[tuple[float, int]] = deque()
        self.hist: list[float] = []
        self.ticks = 0
        self.reported: tuple[float, str] | None = None

    def run(self) -> float:
        """Every request of the level, reported as they stream; returns the level's wall time. On SIGTERM
        (SystemExit raised in here) the workers stop, their connections are shut so blocked reads return at
        once, and a last snapshot shows where every stream was."""
        self.t0 = time.perf_counter()
        self.report(self.t0)  # every stream idle
        threads = [threading.Thread(target=self.work, args=(s,), daemon=True) for s in self.slots]
        try:
            for t in threads:
                t.start()
            due = self.t0 + LIVE_EVERY_S
            while not self.finished.wait(max(0.0, due - time.perf_counter())):
                now = time.perf_counter()
                self.report(now)
                due = now + LIVE_EVERY_S
        except BaseException:
            STOP.set()
            with LOCK:
                socks = list(OPEN)
            for sock in socks:
                with contextlib.suppress(OSError):
                    sock.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(Exception):
                live(self.snapshot(time.perf_counter(), regular=False))
            raise
        return max(r["end"] for r in self.records) - self.t0

    def work(self, slot: Slot) -> None:
        a = self.a
        try:
            while not STOP.is_set():
                with LOCK:
                    i = self.next
                    if i >= len(self.prompts):
                        return
                    self.next += 1
                    slot.begin(i + 1)
                    sent = slot.sent
                try:
                    r = one_request(
                        a.base_url, a.api, self.model, self.prompts[i], a.max_tokens, self.live_usage, slot
                    )
                except Exception as e:  # a stream this code can't read fails its request, not the level
                    r = {"ttft": None, "first": None, "last": None, "eos": None, "chunks": 0, "usage": None}
                    r["error"] = f"{type(e).__name__}: {e}"
                end = time.perf_counter()
                if STOP.is_set():
                    return
                _, c_tok, decode = tokens_of(r, a.prompt_tokens)
                ok = r["error"] is None and r["ttft"] is not None
                r.update(slot=slot.index, req=i + 1, sent=sent, end=end, ok=ok, tokens=c_tok, decode=decode)
                with LOCK:
                    self.records[i] = r
                    self.done += 1
                    self.failed += not ok
                    slot.finish(r)
        finally:
            with LOCK:
                self.running -= 1
                if not self.running:
                    self.finished.set()

    def snapshot(self, now: float, regular: bool = True) -> dict:
        """The live picture (main thread only). Rates come from the token counts seen at each snapshot: a
        stream's over its last SLOT_RATE_S since its first token, the aggregate over the last AGG_RATE_S."""
        with LOCK:
            seen = [
                (s.req, s.state, s.tokens, s.n_first, s.first, s.final_tok_s, s.view(now)) for s in self.slots
            ]
            total, done, failed, ttfts = self.total, self.done, self.failed, list(self.ttfts)
        out = []
        for i, (req, state, tokens, n_first, first, final, entry) in enumerate(seen):
            win = self.windows[i]
            if req != self.window_req[i]:
                win.clear()
                self.window_req[i] = req
            rate = None
            if state == "decode" and first is not None:
                if not win:
                    win.append((first, n_first))
                win.append((now, tokens))
                while len(win) > 1 and win[1][0] <= now - SLOT_RATE_S:
                    win.popleft()
                span = now - win[0][0]
                if tokens >= 2 and span >= RATE_MIN_S:
                    rate = max(0, tokens - win[0][1]) / span
            elif state == "done":
                rate = final
            if rate is not None:
                self.peak[i] = max(rate, self.peak[i] or 0.0)
            entry["tok_s"], entry["peak_tok_s"] = rnd(rate), rnd(self.peak[i])
            out.append(entry)
        if not total:  # nothing yet: the window starts at the last snapshot before the first token
            self.agg.clear()
        self.agg.append((now, total))
        while len(self.agg) > 1 and self.agg[1][0] <= now - AGG_RATE_S:
            self.agg.popleft()
        t0, n0 = self.agg[0]
        agg = max(0, total - n0) / (now - t0) if total and now > t0 else None
        if regular:
            if self.ticks % 2 == 0:
                self.hist.append(rnd(agg) or 0.0)
                del self.hist[:-HIST_MAX]
            self.ticks += 1
        return {
            "kind": "llm-streams",
            "v": 1,
            "level": self.size,
            "levels": self.sizes,
            "level_index": self.index,
            "requests": len(self.prompts),
            "done": done,
            "failed": failed,
            "t": round(now - self.t0, 3),
            "tok_s": rnd(agg),
            "tok_s_hist": list(self.hist),
            "ttft_p50_ms": ms(pct(ttfts, 50)) if ttfts else None,
            "completed_levels": self.completed,
            "streams": out,
        }

    def report(self, now: float, regular: bool = True) -> None:
        snap = self.snapshot(now, regular)
        live(snap)
        phase = f"{streams(self.size)} · {snap['done']} of {snap['requests']} done"
        if self.a.sweep:
            phase = f"Level {self.index + 1} of {len(self.sizes)} · {phase}"
        p = round(0.05 + 0.95 * (sum(self.counts[: self.index]) + snap["done"]) / sum(self.counts), 4)
        if (p, phase) != self.reported:
            self.reported = (p, phase)
            progress(p, phase)


@dataclass
class Stats:
    """A level's measurements over its successful requests (the numbers its results report)."""

    ok: list[dict]
    errors: list[str]
    ttft: list[float] = field(default_factory=list)
    prefill: list[float] = field(default_factory=list)
    decode: list[float] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0


def level_stats(rs: list[dict], prompt_tokens: int) -> Stats:
    st = Stats([r for r in rs if r["ok"]], [r["error"] or "no tokens streamed" for r in rs if not r["ok"]])
    for r in st.ok:
        p_tok, c_tok, decode = tokens_of(r, prompt_tokens)
        st.ttft.append(r["ttft"])
        st.prefill.append(p_tok / r["ttft"])
        if decode is not None:
            st.decode.append(decode)
        st.prompt_tokens += p_tok
        st.completion_tokens += c_tok
    return st


def summary(size: int, n: int, st: Stats, wall: float) -> dict:
    """One level in the detail (and in the live snapshot's completed_levels), rounded for display: the numbers
    that are also results as the results round them, so the page shows one value for each."""
    ok, d = bool(st.ok), st.decode
    return {
        "level": size,
        "requests": n,
        "ok": len(st.ok),
        "failed": n - len(st.ok),
        "wall_s": rnd(wall, 3),
        "out_tok_s": rnd(st.completion_tokens / wall, 2) if ok else None,
        "decode_tok_s_p50": rnd(statistics.median(d), 2) if d else None,
        "decode_tok_s_p10": rnd(pct(d, 10)) if d else None,
        "itl_p50_ms": rnd(statistics.median(1000 / x for x in d)) if d else None,
        "ttft_p50_ms": ms(pct(st.ttft, 50)) if ok else None,
        "ttft_p95_ms": ms(pct(st.ttft, 95)) if ok else None,
        "prefill_tok_s_p50": rnd(statistics.median(st.prefill)) if ok else None,
        "prompt_tokens": st.prompt_tokens,
        "completion_tokens": st.completion_tokens,
    }


def timeline(rs: list[dict], t0: float) -> dict:
    """Compact per-request records of a level, seconds since it started (the first TIMELINE_ROWS requests)."""
    rows = [
        [
            r["slot"],
            r["req"],
            rnd(r["sent"] - t0, 4),
            rnd(r["first"] - t0, 4) if r["first"] is not None else None,
            rnd(r["end"] - t0, 4),
            r["tokens"],
            1 if r["ok"] else 0,
        ]
        for r in rs[:TIMELINE_ROWS]
    ]
    cols = ["slot", "req", "sent", "first", "end", "tokens", "ok"]
    return {"cols": cols, "rows": rows, "truncated": len(rs) > TIMELINE_ROWS}


def single_results(ex: dict, st: Stats, wall: float) -> None:
    """A run at one concurrency: the same results as before sweeps existed, so its baselines still compare."""
    ttft, prefill, decode, total_out = st.ttft, st.prefill, st.decode, st.completion_tokens
    # Engine and model live in extras (the run view shows them once); headlines: decode, TTFT p50, prefill.
    head = {**ex, "headline": True}
    if decode:
        result(
            "decode_tok_s",
            "Decode tokens/s per request",
            round(statistics.median(decode), 2),
            "tok/s",
            **head,
        )
    result("ttft_p50_ms", "Time to first token p50", round(pct(ttft, 50) * 1000, 1), "ms", "lower", **head)
    result("prefill_tok_s", "Prefill tokens/s", round(statistics.median(prefill), 1), "tok/s", **head)
    result("ttft_p95_ms", "Time to first token p95", round(pct(ttft, 95) * 1000, 1), "ms", "lower", **ex)
    result("decode_tok_s_total", "Output tokens/s, all requests", round(total_out / wall, 2), "tok/s", **ex)


def sweep_results(good: list[tuple[dict, Stats, float]]) -> None:
    """A sweep: each level with results under its own names (_c{streams}). Headlines: the peak output tok/s,
    per-request decode at the first level and TTFT p50 at the last."""
    out = [round(st.completion_tokens / wall, 2) for _, st, wall in good]
    peak = out.index(max(out))
    first = next((ex["level"] for ex, st, _ in good if st.decode), None)
    last = good[-1][0]["level"]
    result("peak_output_tok_s", "Peak output tokens/s", out[peak], "tok/s", **good[peak][0], headline=True)
    for (ex, st, _), out_tok_s in zip(good, out, strict=True):
        size, at, head = ex["level"], streams(ex["level"]), {**ex, "headline": True}
        result(f"decode_tok_s_total_c{size}", f"Output tokens/s · {at}", out_tok_s, "tok/s", **ex)
        if st.decode:
            decode = round(statistics.median(st.decode), 2)
            label = f"Decode tokens/s per request · {at}"
            result(f"decode_tok_s_c{size}", label, decode, "tok/s", **(head if size == first else ex))
        p50, p95 = round(pct(st.ttft, 50) * 1000, 1), round(pct(st.ttft, 95) * 1000, 1)
        label = f"Time to first token p50 · {at}"
        result(f"ttft_p50_ms_c{size}", label, p50, "ms", "lower", **(head if size == last else ex))
        result(f"ttft_p95_ms_c{size}", f"Time to first token p95 · {at}", p95, "ms", "lower", **ex)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", default="")
    ap.add_argument("--api", choices=["chat", "completions"], default="chat")
    ap.add_argument("--prompt-tokens", type=int, default=512)
    ap.add_argument("--max-tokens", type=int, default=128)
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--requests", type=int, default=8)
    ap.add_argument("--sweep", action="store_true")
    a = ap.parse_args()
    on_sigterm()
    progress(0.0, "Querying /v1/models")
    try:
        models, headers = get_json(a.base_url, "/v1/models")
    except (OSError, ValueError, http.client.HTTPException) as e:
        fail(
            "LLM endpoint unreachable",
            f"{a.base_url}/v1/models: {e}",
            "Check that the server is running and serves the OpenAI API at that address",
        )
    entries = models.get("data") or []
    model = a.model or (entries[0]["id"] if entries else "")
    if not model:
        fail("No model to test", "/v1/models listed no models and none was given", "Set the model parameter")
    owner = next((m.get("owned_by", "") for m in entries if m.get("id") == model), "")
    engine = owner if owner.lower() not in GENERIC_OWNERS else headers.get("server", "")
    engine = engine.split("/")[0] or "unknown engine"
    log(f"model {model}, engine {engine} (owned_by={owner!r}, server={headers.get('server')!r})")
    summaries: list[dict] = []
    timelines: dict[str, dict] = {}
    measured: list[tuple[int, int, Stats, float]] = []
    for k in range(len(levels(a.concurrency, a.sweep))):
        lv = Level(a, model, engine.lower() == "vllm", k, summaries)
        wall = lv.run()
        st = level_stats(lv.records, a.prompt_tokens)
        summaries.append(summary(lv.size, len(lv.records), st, wall))
        timelines[str(lv.size)] = timeline(lv.records, lv.t0)
        lv.report(time.perf_counter(), regular=False)  # every stream finished, the level summarised
        detail(llm={"levels": summaries, "timeline": timelines})
        where = f"{streams(lv.size)}: " if a.sweep else ""
        for err in st.errors[:3]:
            log(f"{where}request failed: {err}")
        if a.sweep and not st.ok:
            log(f"{where}every request failed, so this level has no results")
        measured.append((lv.size, len(lv.records), st, wall))
    if not any(st.ok for *_, st, _ in measured):
        errors = [e for *_, st, _ in measured for e in st.errors]
        fail(
            "Every request failed",
            errors[0] if errors else "no output",
            "Check the model name and server logs",
        )

    def extras(size: int, n: int, st: Stats) -> dict:
        usage0 = st.ok[0]["usage"] or {}
        return {
            "engine": engine,
            "model": model,
            "requests": n,
            "failed": len(st.errors),
            "concurrency": size,
            "prompt_tokens": usage0.get("prompt_tokens") or a.prompt_tokens,
            "prompt_tokens_source": "usage" if usage0.get("prompt_tokens") else "estimate",
            "max_tokens": a.max_tokens,
            "api": a.api,
        }

    if a.sweep:
        good = [(size, n, st, wall) for size, n, st, wall in measured if st.ok]
        sweep_results(
            [({**extras(size, n, st), "level": size, "sweep": True}, st, w) for size, n, st, w in good]
        )
    else:
        size, n, st, wall = measured[0]
        single_results(extras(size, n, st), st, wall)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
