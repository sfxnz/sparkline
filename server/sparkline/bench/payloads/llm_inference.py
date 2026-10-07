"""LLM inference benchmark against an OpenAI-compatible endpoint (host Python, stdlib only).

Streams /v1/chat/completions (or /v1/completions) with stream=true and measures per request: time to first
token (TTFT), prefill tok/s = prompt tokens / TTFT, decode tok/s = (completion tokens - 1) / (last token -
first token). Aggregate decode tok/s = all completion tokens / wall time. Token counts come from the server's
usage block when it sends one, otherwise from the number of streamed content chunks.
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import statistics
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast
from urllib.parse import urlsplit

from benchlib import fail, log, on_sigterm, progress, result

TEXT = (
    "the river carries light across the valley while engineers measure every quiet signal from the cluster "
    "and write careful notes about memory clocks heat and power before the evening shift begins"
)
WORDS = TEXT.split()
GENERIC_OWNERS = {"", "system", "openai", "organization-owner", "user", "owner"}


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


def one_request(base: str, api: str, model: str, prompt: str, max_tokens: int) -> dict:
    conn, prefix = connect(base, 300)
    body: dict = {"model": model, "max_tokens": max_tokens, "stream": True, "temperature": 0}
    body["stream_options"] = {"include_usage": True}
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
    t0 = time.perf_counter()
    try:
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
                elif ch.get("finish_reason") and out["first"] is not None:
                    # A stop token (EOS) streams as an empty chunk with the finish reason. usage counts it in
                    # completion_tokens, so with usage it is the last token (see decode in main()).
                    out["eos"] = time.perf_counter()
        out["total"] = time.perf_counter() - t0
    except (OSError, ValueError, http.client.HTTPException) as e:
        out["error"] = f"{type(e).__name__}: {e}"
    finally:
        conn.close()
    return out


def pct(vals: list[float], q: float) -> float:
    """Nearest-rank percentile (p50 of [1, 2] is 1)."""
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, math.ceil(q / 100 * len(s)) - 1))]


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
    prompts = [make_prompt(a.prompt_tokens, i) for i in range(a.requests)]
    done = [0]

    def run(i: int) -> dict:
        r = one_request(a.base_url, a.api, model, prompts[i], a.max_tokens)
        done[0] += 1
        progress(0.05 + 0.95 * done[0] / a.requests, f"Request {done[0]}/{a.requests}")
        return r

    progress(0.05, f"{a.requests} requests, {a.concurrency} at a time")
    t0 = time.perf_counter()
    with ThreadPoolExecutor(a.concurrency) as pool:
        rs = list(pool.map(run, range(a.requests)))
    wall = time.perf_counter() - t0
    ok = [r for r in rs if r["error"] is None and r["ttft"] is not None]
    errors = [r["error"] or "no tokens streamed" for r in rs if r not in ok]
    for err in errors[:3]:
        log(f"request failed: {err}")
    if not ok:
        fail(
            "Every request failed",
            errors[0] if errors else "no output",
            "Check the model name and server logs",
        )
    ttft = [r["ttft"] for r in ok]
    prefill, decode, total_out = [], [], 0
    for r in ok:
        usage = r["usage"] or {}
        p_tok = usage.get("prompt_tokens") or a.prompt_tokens
        c_tok = usage.get("completion_tokens") or r["chunks"]
        # usage counts a stop token that streams no text: then the decode span ends at its (empty) chunk
        last = r["eos"] if usage.get("completion_tokens") and r["eos"] else r["last"]
        total_out += c_tok
        prefill.append(p_tok / r["ttft"])
        if c_tok > 1 and last > r["first"]:
            decode.append((c_tok - 1) / (last - r["first"]))
    usage0 = ok[0]["usage"] or {}
    ex = {
        "engine": engine,
        "model": model,
        "requests": a.requests,
        "failed": len(errors),
        "concurrency": a.concurrency,
        "prompt_tokens": usage0.get("prompt_tokens") or a.prompt_tokens,
        "prompt_tokens_source": "usage" if usage0.get("prompt_tokens") else "estimate",
        "max_tokens": a.max_tokens,
        "api": a.api,
    }
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
    progress(1.0, "Done")


if __name__ == "__main__":
    main()
