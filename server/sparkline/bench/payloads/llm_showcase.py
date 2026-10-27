"""LLM showcase: concurrent prompt streams to watch, from an OpenAI-compatible endpoint (host Python, stdlib).

--streams short prompts (prose, structured output or both, from the catalogs below) go out at once, one
request each, released together. With --fill-to-max each prompt asks the model to keep writing and the
request sends ignore_eos, min_tokens = --max-tokens and no stop strings, so every stream decodes the full
length side by side and they end together; a stream whose request the server rejects for those fields
(HTTP 400) is sent once more without them. Requests and streams are llm_inference's: every 0.25 s a live
snapshot in its "llm-streams" shape (one level of N streams) shows each stream's prompt label, state, tokens,
decode tok/s so far and text tail, the sum of the decoding streams' rates and, from GET /metrics (vLLM,
SGLang), the server's own generation tok/s. The full answers go to detail.showcase when the run ends, also on
cancel.
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import socket
import statistics
import threading
import time
from typing import Any

from benchlib import detail, fail, live, log, on_sigterm, progress, result
from llm_inference import (
    GENERIC_OWNERS,
    HIST_MAX,
    LIVE_EVERY_S,
    LOCK,
    OPEN,
    RATE_MIN_S,
    STOP,
    Slot,
    connect,
    get_json,
    ms,
    one_request,
    pct,
    rnd,
    streams,
    tokens_of,
)

TEXT_PROMPTS = [
    "Write a short story about a DGX Spark that wakes at 3 a.m. to find its fans arguing about the weather.",
    "Explain to a curious ten-year-old how a GPU can do thousands of small sums at the same time.",
    "Describe a quiet night shift in a small inference lab, as told by the coffee machine.",
    "Write a letter from a tired KV cache to the engineer who keeps raising the context length.",
    "Write a travel guide to the inside of a computer, as if memory, caches and cores were cities.",
    "Tell the life story of the first token of an answer, from the prompt arriving to the stream starting.",
    "Write a radio weather forecast for a server room: heat fronts, cool breezes and a chance of throttling.",
    "Argue, politely, whether a model that answers fast or one that answers well makes the better colleague.",
]
STRUCTURAL_PROMPTS = [
    "Write a JSON inventory of a small home AI lab: every device, its memory, power draw and what it runs.",
    "Write SQL that creates tables for benchmark runs and results, then finds the fastest run per model.",
    "Write a YAML config for a made-up model server with ports, batching limits, logging and health checks.",
    "Write a Python dataclass for a GPU telemetry sample and a function that flags the overheating ones.",
    "Write a Markdown table comparing five made-up language models by size, speed, context and quirks.",
    "Write a Dockerfile and a docker-compose file that serve a model behind a small reverse proxy.",
    "Write a JSON Schema for a chat completion request, with a description for every property.",
    "Write a bash script that checks free memory, GPU temperature and disk space and prints one status line.",
]
FILL = " Keep writing until you reach the output limit: add detail, examples and new sections, never wrap up."
LABEL_MAX = 60  # characters of a stream's prompt in the snapshot
TEXT_PER_TOKEN = 16  # the detail keeps at most max_tokens x this many characters of answer (and reasoning)
DETAIL_MAX = 900_000  # bytes of compact JSON (the agent's hard limit for a run's detail is 1 MiB)
METRICS_EVERY_S = 0.4
METRICS_MAX = 8 * 2**20  # bytes of /metrics read
GENERATION_TOKENS = ("vllm:generation_tokens_total", "sglang:generation_tokens_total")


def prompts(kind: str, n: int) -> list[str]:
    """n prompts of a catalog, round and round; mixed alternates structural, text, structural ..."""
    if kind == "mixed":
        pools = (STRUCTURAL_PROMPTS, TEXT_PROMPTS)
        return [pools[i % 2][i // 2 % len(pools[i % 2])] for i in range(n)]
    pool = TEXT_PROMPTS if kind == "text" else STRUCTURAL_PROMPTS
    return [pool[i % len(pool)] for i in range(n)]


def label(prompt: str) -> str:
    s = " ".join(prompt.split())
    return s if len(s) <= LABEL_MAX else s[: LABEL_MAX - 1].rstrip() + "…"


def endpoint(base: str, wanted: str) -> tuple[str, str]:
    """The model to stream from (the first served one when none is given) and the engine, as llm_inference
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
    log(f"model {model}, engine {engine} (owned_by={owner!r}, server={headers.get('server')!r})")
    return model, engine.split("/")[0] or "unknown engine"


def generation_tokens(base: str) -> float | None:
    """The server's generated tokens so far: the sum of its generation token counters in /metrics, else None
    (no /metrics, or none of those counters)."""
    conn, prefix = connect(base, 2)
    try:
        conn.request("GET", prefix + "/metrics")
        r = conn.getresponse()
        body = r.read(METRICS_MAX)
        if r.status != 200:
            return None
    except (OSError, http.client.HTTPException):
        return None
    finally:
        conn.close()
    total, seen = 0.0, False
    for line in body.decode("utf-8", "replace").splitlines():  # name{labels} value [timestamp]
        name = line.split("{", 1)[0].split(" ", 1)[0]
        if name in GENERATION_TOKENS:
            rest = line[line.rindex("}") + 1 :] if "}" in line else line[len(name) :]
            with contextlib.suppress(ValueError, IndexError):
                total, seen = total + float(rest.split()[0]), True
    return total if seen else None


class ServerRate:
    """The server's generation tok/s: the counters' rate over the last two polls of /metrics. A pair over 10 s
    apart, or one in which the counters did not grow (idle, or a restart), gives no sample."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.now: float | None = None  # the latest rate (under LOCK, as rates)
        self.rates: list[float] = []

    def run(self, done: threading.Event) -> None:
        last: tuple[float, float] | None = None
        while not done.is_set() and not STOP.is_set():
            v = generation_tokens(self.base)
            t = time.perf_counter()
            if v is None and last is None:
                return  # no /metrics, or no generation counter: stop polling
            if v is not None:
                if last is not None and 0 < t - last[0] < 10 and v > last[1]:
                    rate = (v - last[1]) / (t - last[0])
                    with LOCK:
                        self.now = rate
                        self.rates.append(rate)
                last = (t, v)
            done.wait(METRICS_EVERY_S)


def clip(have: str, more: str, cap: int) -> tuple[str, bool]:
    s = have + more
    return s[:cap], len(s) > cap


class Stream(Slot):
    """One stream: llm_inference's Slot (live view, tails, counters), its prompt, the time of its latest token
    and its whole answer and reasoning (up to max_tokens x TEXT_PER_TOKEN characters each) for the detail."""

    def __init__(self, show: Showcase, index: int, prompt: str, label: str) -> None:
        super().__init__(show, index)
        self.prompt, self.label = prompt, label
        self.last: float | None = None
        self.answer = self.reasoning = ""
        self.cut = False

    def chunk(self, out: dict, answer: str, thought: str, used: Any) -> None:
        super().chunk(out, answer, thought, used)
        cap = self.level.a.max_tokens * TEXT_PER_TOKEN
        with LOCK:
            self.last = out["last"]
            if answer:
                self.answer, cut = clip(self.answer, answer, cap)
                self.cut |= cut
            if thought:
                self.reasoning, cut = clip(self.reasoning, thought, cap)
                self.cut |= cut


class Showcase:
    """All streams of the run: a worker thread each, released together, one request each; the main thread
    reports every LIVE_EVERY_S. Workers change only the counters marked theirs, under LOCK."""

    def __init__(self, a: argparse.Namespace, model: str, live_usage: bool) -> None:
        self.a, self.model, self.live_usage = a, model, live_usage
        fill = FILL if a.fill_to_max else ""
        self.slots = [
            Stream(self, i, p + fill, label(p)) for i, p in enumerate(prompts(a.prompt_type, a.streams))
        ]
        think = {"enable_thinking": a.thinking, "thinking": a.thinking}
        self.extra = {"temperature": a.temperature, "chat_template_kwargs": think}
        self.fill = {"ignore_eos": True, "min_tokens": a.max_tokens, "stop": []} if a.fill_to_max else {}
        self.server = ServerRate(a.base_url)
        self.go, self.finished = threading.Event(), threading.Event()
        # the workers' (Slot.chunk counts total, all tokens streamed, and ttfts)
        self.records: list[dict] = [{} for _ in self.slots]
        self.done = self.failed = self.total = 0
        self.ttfts: list[float] = []
        self.dropped: str | None = None  # the server's error for the fill fields, once it rejected them
        self.running = len(self.slots)
        # the reporter's
        self.t0 = 0.0
        self.peak: list[float | None] = [None] * len(self.slots)
        self.hist: list[float] = []
        self.ticks = 0
        self.logged = False
        self.reported: tuple[float, str] | None = None

    def run(self) -> None:
        """Every stream, reported as they decode. On SIGTERM (SystemExit raised in here) the workers stop,
        their connections are shut so blocked reads return at once, and a last snapshot and the detail show
        where every stream was."""
        threads = [threading.Thread(target=self.work, args=(s,), daemon=True) for s in self.slots]
        poller = threading.Thread(target=self.server.run, args=(self.finished,), daemon=True)
        try:
            for t in threads:
                t.start()
            self.t0 = time.perf_counter()
            self.report(self.t0)  # every stream idle
            self.go.set()  # all requests go out now
            poller.start()
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
                detail(showcase=self.detail())
            raise

    def request(self, slot: Stream, extra: dict) -> dict:
        try:
            a = self.a
            return one_request(
                a.base_url, "chat", self.model, slot.prompt, a.max_tokens, self.live_usage, slot, extra
            )
        except Exception as e:  # a stream this code can't read fails, not the run
            r: dict[str, Any] = dict.fromkeys(("ttft", "first", "last", "eos", "usage"))
            r.update(chunks=0, error=f"{type(e).__name__}: {e}")
            return r

    def work(self, slot: Stream) -> None:
        try:
            self.go.wait()
            if STOP.is_set():
                return
            with LOCK:
                slot.begin(1)
            r = self.request(slot, {**self.extra, **self.fill})
            if self.fill and (r["error"] or "").startswith("HTTP 400") and not STOP.is_set():
                with LOCK:  # the server rejects ignore_eos, min_tokens or stop: once more without them
                    self.dropped = r["error"]
                    slot.begin(1)
                r = self.request(slot, self.extra)
            end = time.perf_counter()
            if STOP.is_set():
                return
            _, c_tok, decode = tokens_of(r, 0)
            ok = r["error"] is None and r["ttft"] is not None
            r.update(end=end, ok=ok, tokens=c_tok, decode=decode)
            with LOCK:
                self.records[slot.index] = r
                self.done += 1
                self.failed += not ok
                slot.finish(r)
        finally:
            with LOCK:
                self.running -= 1
                if not self.running:
                    self.finished.set()

    def snapshot(self, now: float, regular: bool = True) -> dict:
        """The live picture (main thread only): llm_inference's, with each stream's decode rate so far,
        (tokens - tokens at the first) / (latest token - first token), and as the aggregate the sum of the
        rates of the streams decoding."""
        with LOCK:
            seen = [
                (s.state, s.tokens, s.n_first, s.first, s.last, s.final_tok_s, s.view(now))
                for s in self.slots
            ]
            done, failed, ttfts, server = self.done, self.failed, list(self.ttfts), self.server.now
        out, decoding = [], []
        for i, (state, tokens, n_first, first, last, final, entry) in enumerate(seen):
            rate = None
            if state == "decode" and first is not None and last is not None:
                if last - first >= RATE_MIN_S and tokens > n_first:
                    rate = (tokens - n_first) / (last - first)
                    decoding.append(rate)
            elif state == "done":
                rate = final
            if rate is not None:
                self.peak[i] = max(rate, self.peak[i] or 0.0)
            entry["tok_s"], entry["peak_tok_s"] = rnd(rate), rnd(self.peak[i])
            entry["label"] = self.slots[i].label
            out.append(entry)
        agg = sum(decoding) if decoding else None
        if regular:
            if self.ticks % 2 == 0:
                self.hist.append(rnd(agg) or 0.0)
                del self.hist[:-HIST_MAX]
            self.ticks += 1
        n = len(self.slots)
        return {
            "kind": "llm-streams",
            "v": 1,
            "level": n,
            "levels": [n],
            "level_index": 0,
            "requests": n,
            "done": done,
            "failed": failed,
            "t": round(now - self.t0, 3),
            "tok_s": rnd(agg),
            "tok_s_hist": list(self.hist),
            "ttft_p50_ms": ms(pct(ttfts, 50)) if ttfts else None,
            "completed_levels": [],
            "showcase": True,
            "server_tok_s": rnd(server),
            "streams": out,
        }

    def report(self, now: float, regular: bool = True) -> None:
        snap = self.snapshot(now, regular)
        live(snap)
        with LOCK:
            total, dropped = self.total, self.dropped
        if dropped and not self.logged:
            self.logged = True
            log(f"The server rejected ignore_eos, min_tokens or stop ({dropped}); sent again without them")
        n, done = len(self.slots), snap["done"]
        p = round(0.05 + 0.95 * max(done / n, min(1.0, total / (n * self.a.max_tokens))), 2)
        phase = f"{streams(n)} · {done} of {n} done"
        if (p, phase) != self.reported:
            self.reported = (p, phase)
            progress(p, phase)

    def server_stats(self) -> dict | None:
        with LOCK:
            rates = list(self.server.rates)
        if not rates:
            return None
        return {"median": rnd(statistics.median(rates)), "max": rnd(max(rates)), "samples": len(rates)}

    def detail(self) -> dict:
        """detail.showcase: every stream's prompt and whole answer, under DETAIL_MAX bytes."""
        with LOCK:
            rows = [
                {
                    "slot": s.index,
                    "prompt": s.prompt,
                    "state": s.state if s.state in ("done", "error") else "stopped",
                    "text": s.answer,
                    "think": s.reasoning,
                    "tokens": s.tokens,
                    "ttft_ms": ms(s.ttft),
                    "decode_tok_s": rnd(s.final_tok_s),
                    "error": s.error,
                }
                for s in self.slots
            ]
            cut, dropped = any(s.cut for s in self.slots), self.dropped
        fill = {"requested": self.a.fill_to_max, "applied": self.a.fill_to_max and dropped is None}
        out = {"streams": rows, "server_tok_s": self.server_stats(), "fill_to_max": fill, "truncated": cut}
        return fit(out)


def fit(d: dict) -> dict:
    """The longest texts cut (from their end) to one length, 10 % less each time, until the detail fits."""
    texts = [(s, k, s[k]) for s in d["streams"] for k in ("text", "think")]
    cap = max((len(t) for *_, t in texts), default=0)
    while cap and len(json.dumps(d, separators=(",", ":"))) > DETAIL_MAX:
        cap = int(cap * 0.9)
        for s, k, t in texts:
            if len(t) > cap:
                s[k], d["truncated"] = t[:cap], True
    return d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", default="")
    ap.add_argument("--streams", type=int, default=4)
    ap.add_argument("--prompt-type", choices=["text", "structural", "mixed"], default="text")
    ap.add_argument("--max-tokens", type=int, default=512)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--fill-to-max", action="store_true")
    ap.add_argument("--thinking", action="store_true")
    a = ap.parse_args()
    on_sigterm()
    progress(0.0, "Querying /v1/models")
    model, engine = endpoint(a.base_url, a.model)
    show = Showcase(a, model, engine.lower() == "vllm")
    show.run()
    show.report(time.perf_counter(), regular=False)  # every stream finished
    final = show.detail()
    detail(showcase=final)
    ok = [r for r in show.records if r.get("ok")]
    errors = [r["error"] or "no tokens streamed" for r in show.records if r and not r["ok"]]
    for err in errors[:3]:
        log(f"stream failed: {err}")
    if not ok:
        fail(
            "Every stream failed",
            errors[0] if errors else "no output",
            "Check the model name and server logs",
        )
    ex = {
        "engine": engine,
        "model": model,
        "streams": a.streams,
        "prompt_type": a.prompt_type,
        "max_tokens": a.max_tokens,
        "fill_to_max": final["fill_to_max"]["applied"],
        "temperature": a.temperature,
        "thinking": a.thinking,
        "failed": len(errors),
    }
    head = {**ex, "headline": True}
    wall = max(r["end"] for r in ok) - show.t0
    out = sum(r["tokens"] for r in ok)
    result("output_tok_s", "Output tokens/s, all streams", round(out / wall, 2), "tok/s", **head)
    decode = [r["decode"] for r in ok if r["decode"] is not None]
    if decode:
        result(
            "decode_tok_s", "Decode tokens/s per stream", round(statistics.median(decode), 2), "tok/s", **head
        )
    ttft = round(pct([r["ttft"] for r in ok], 50) * 1000, 1)
    result("ttft_p50_ms", "Time to first token p50", ttft, "ms", "lower", **head)
    server = final["server_tok_s"]
    if server:
        name = "Server generation tokens/s (median)"
        result("server_tok_s_median", name, server["median"], "tok/s", **ex)
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
