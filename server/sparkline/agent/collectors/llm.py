"""Model servers listening on this node: which are up, what they serve, how fast and how backed up.

Two actors, each the only writer of one slot, so there is no lock:

- the poller thread owns every tracked server and all network IO, and publishes ``_snapshot``;
- the tick thread publishes ``_hints`` (which process holds which port) from the process list.

Both values are replaced whole and never mutated, so ``collect()`` reads a finished round and never waits
on a model server.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import traceback
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from ...common.schema import LoadedModel, ModelServerSample, ProcSample, ServerState, Unsupported
from ..config import Target
from ..sources import HTTP_TIMEOUT_S, Http, HttpReply, NotHttp, Sources
from . import Caps
from .llm_find import (
    NO_HINTS,
    Hints,
    Listener,
    ProcHint,
    candidates,
    hints_from_procs,
    parse_proc_net_tcp,
    published_ports,
)
from .procs import DOCKER_TTL_S, ProcsCollector
from .prom import KNOWN_NAMESPACES, Series, Window, parse_exposition, pick_namespace, reduce_scrape

log = logging.getLogger(__name__)

POLL_EVERY_S = 2.0
FIND_EVERY_S = 5.0
FORGET_AFTER_S = 600.0
IDENTIFY_TIMEOUTS_BEFORE_REJECT = 3
MODELS_MAX = 32
TEXT_MAX = 128

TRT_OWNERS = ("tensorrt", "trtllm")
PROMETHEUS_OWNERS = {"vllm": "vLLM", "sglang": "SGLang", "llamacpp": "llama.cpp", "nvidia": "NIM"}
NO_METRICS = {
    "SGLang": "SGLang serves metrics only when started with --enable-metrics",
    "llama.cpp": "llama.cpp serves metrics only when started with --metrics",
    "TensorRT-LLM": "TensorRT-LLM serves Prometheus metrics only with return_perf_metrics",
}
REFUSED = (401, 403)
# Completes "Its model list ..." or "Port N ...", keyed by whether the agent sent a key.
KEY_FIX = {
    False: "wants an API key. Set api_key under [[model_servers]] in agent.toml",
    True: "refused the API key it was sent. Correct api_key under [[model_servers]] in agent.toml",
}
HEALTH_PATH = "/health"
UP_STATES: tuple[ServerState, ...] = ("ready", "sleeping")


@dataclass(frozen=True)
class Identity:
    software: str | None
    models: tuple[LoadedModel, ...]
    metrics_path: str | None
    problem: str | None


@dataclass(frozen=True)
class Unread:
    """What a socket answered in place of a model server. Shown for a port under [[model_servers]] and
    for a port that held a model server before, which are the ports that have a card."""

    state: ServerState = "down"
    why: str | None = "did not answer as a model server"  # completes "Port N ..."
    settled: bool = True  # False: the answer can change, so the socket is asked again

    def shown(self, port: int) -> dict[str, Any]:
        problem = f"Port {port} {self.why}" if self.why else None
        return {"state": self.state, "values": {"up": 0.0}, "problem": problem}


NOT_A_MODEL_SERVER = Unread()
NOT_LISTENING = Unread(why="is not listening")
LOADING = Unread("loading", None, settled=False)


class Adapter(Protocol):
    name: str
    default_ports: frozenset[int]

    def identify(
        self, http: Http, at: Listener, hint: ProcHint | None, auth: Mapping[str, str]
    ) -> Identity | Unread:
        """Asked about a listening socket until an answer settles it. Raises what ``http`` raises."""
        ...

    def poll(
        self, http: Http, at: Listener, ident: Identity, window: Window, auth: Mapping[str, str], now: float
    ) -> ModelServerSample:
        """One poll, ``now`` in monotonic seconds. Raises OSError when the server does not answer."""
        ...


def _url(at: Listener, path: str) -> str:
    host = f"[{at.connect_host}]" if ":" in at.connect_host else at.connect_host
    return f"http://{host}:{at.port}{path}"


def _clean(text: object, drop: str = r"[^\x20-\x7e]") -> str:
    return re.sub(drop, "", str(text))[:TEXT_MAX]


def _listed(reply: HttpReply) -> tuple[str, tuple[LoadedModel, ...]] | None:
    try:
        data = json.loads(reply.body)["data"]
        entries = [m for m in data if isinstance(m["id"], str)][:MODELS_MAX]
    except (ValueError, TypeError, KeyError):
        return None
    models = []
    for m in entries:
        meta = m.get("meta") if isinstance(m.get("meta"), dict) else {}
        # llama.cpp: n_ctx is what one request can use, n_ctx_train what the model was trained with.
        sizes = (m.get("max_model_len"), m.get("context_length"), meta.get("n_ctx"), meta.get("n_ctx_train"))
        context = next((v for v in sizes if isinstance(v, int) and not isinstance(v, bool) and v > 0), None)
        name = m["id"].rstrip("/")
        name = os.path.basename(name) if name.startswith(("/", ".", "~")) else name
        models.append(LoadedModel(name=_clean(name), context_len=context))
    owner = _clean(entries[0].get("owned_by") or "", r"[^A-Za-z0-9_.-]")[:32] if entries else ""
    return owner, tuple(models)


def _series(reply: HttpReply) -> dict[str, list[Series]]:
    return parse_exposition(reply.body.decode(errors="replace")) if reply.status == 200 else {}


class PrometheusAdapter:
    name = "prometheus"
    default_ports = frozenset({8000, 8080, 9931, 30000})

    def identify(
        self, http: Http, at: Listener, hint: ProcHint | None, auth: Mapping[str, str]
    ) -> Identity | Unread:
        reply = http(_url(at, "/v1/models"), auth)
        if reply.status == 503:
            return LOADING
        locked = reply.status in REFUSED
        key_fix = KEY_FIX[bool(auth)]
        listed = None if locked else _listed(reply)
        if not locked and (reply.status != 200 or listed is None):
            return NOT_A_MODEL_SERVER
        owner, models = listed or ("", ())
        if (hint is not None and hint.trt) or any(t in owner.lower() for t in TRT_OWNERS):
            # TensorRT-LLM's default metrics path answers JSON that a read drains, so this branch is the
            # only one a TensorRT-LLM server takes and it asks for the Prometheus path alone.
            software: str | None = "TensorRT-LLM"
            paths: tuple[str, ...] = ("/prometheus/metrics",)
        else:
            software = next((n for key, n in PROMETHEUS_OWNERS.items() if key in owner.lower()), None)
            paths = ("/metrics", "/v1/metrics")
        metrics_locked = False
        for path in paths:
            got = http(_url(at, path), auth)
            metrics_locked |= got.status in REFUSED
            ns = pick_namespace(_series(got), need_proof=locked)
            if ns is not None:
                named = software or KNOWN_NAMESPACES.get(ns) or owner or ns.rstrip(":_") or None
                return Identity(named, models, path, f"Its model list {key_fix}" if locked else None)
        if software is None:
            # No metrics and no known owner. Ollama, LM Studio and mlx_lm answer /v1/models with the models
            # on disk, not the loaded ones, so they wait for adapters of their own.
            return Unread(why=key_fix) if locked or metrics_locked else NOT_A_MODEL_SERVER
        if metrics_locked:
            return Identity(software, models, None, f"Its metrics path {key_fix}")
        problem = NO_METRICS.get(software, f"{software} serves no metrics on this port")
        return Identity(software, models, None, problem)

    def poll(
        self, http: Http, at: Listener, ident: Identity, window: Window, auth: Mapping[str, str], now: float
    ) -> ModelServerSample:
        path = ident.metrics_path or HEALTH_PATH
        reply = http(_url(at, path), auth)
        state: ServerState = "loading" if reply.status == 503 else "ready"
        sample = ModelServerSample(
            port=at.port,
            adapter=self.name,
            software=ident.software,
            models=list(ident.models),
            state=state,
            values={"up": float(state in UP_STATES)},
            scraped_ts=time.time(),
            problem=ident.problem,
        )
        if ident.metrics_path is None or state == "loading":
            return sample
        series = _series(reply)
        ns = pick_namespace(series)
        if ns is None:
            problem = f"{path} answered HTTP {reply.status} with no metrics"
            return sample.model_copy(update={"problem": problem})
        scrape = reduce_scrape(series, ns, now)
        window.push(scrape)
        version = scrape.info.get("version")
        return sample.model_copy(
            update={
                "state": "sleeping" if scrape.sleeping else "ready",
                "prefix": ns[:TEXT_MAX],
                "version": _clean(version) if version else None,
                "values": {"up": 1.0, **window.derive()},
                "reports": sorted(scrape.present),
                "mem_source": "server" if "mem_bytes" in scrape.present else None,
                "started_ts": scrape.started_ts,
            }
        )


ADAPTERS: tuple[Adapter, ...] = (PrometheusAdapter(),)


@dataclass
class Tracked:
    at: Listener
    adapter: Adapter
    ident: Identity
    window: Window
    last: ModelServerSample
    down_since: float | None = None


def join(s: ModelServerSample, hints: Hints) -> ModelServerSample:
    hint = hints.by_port.get(s.port) or (hints.by_container.get(s.container) if s.container else None)
    if hint is None:
        return s
    update: dict[str, Any] = {"pid": hint.pid, "container": hint.container or s.container}
    if "mem_bytes" not in s.reports and hint.gpu_mem is not None:
        update |= {"values": {**s.values, "mem_bytes": float(hint.gpu_mem)}, "mem_source": "process"}
    return s.model_copy(update=update)


class ModelServerCollector:
    name = "llm"

    def __init__(
        self,
        src: Sources,
        procs: ProcsCollector | None,
        targets: Sequence[Target],
        discover: bool,
        adapters: tuple[Adapter, ...] = ADAPTERS,
    ) -> None:
        self._fs = src.fs
        self._docker = src.docker
        self._http = src.http
        self._procs = procs
        self._auth = {t.port: {"Authorization": f"Bearer {t.api_key}"} for t in targets if t.api_key}
        self._target_ports = frozenset(t.port for t in targets)
        self._discover = discover
        self._adapters = adapters
        self._default_ports = frozenset(p for a in adapters for p in a.default_ports)
        self._snapshot: tuple[ModelServerSample, ...] = ()
        self._hints = NO_HINTS
        self._rows: list[ProcSample] | None = None
        self._error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tracked: dict[int, Tracked] = {}
        self._unread: dict[tuple[int, int | None], Unread] = {}
        self._identify_timeouts: dict[tuple[int, int | None], int] = {}
        self._listening: dict[int, Listener] = {}
        self._published: dict[int, str] = {}
        self._found_at = self._docker_at = float("-inf")

    @property
    def _looks(self) -> bool:
        return self._discover or bool(self._target_ports)

    def caps(self) -> Caps:
        if self._looks:
            return {"llm": None}
        reason = "Model server discovery is off in agent.toml and no [[model_servers]] are listed"
        return {"llm": Unsupported(metric="llm", reason=reason, kind="agent")}

    def collect(self) -> dict[str, Any]:
        if not self._looks:
            return {"llm": None}
        rows = self._procs.rows if self._procs else None
        if rows is not None and rows is not self._rows:
            self._rows = rows
            self._hints = hints_from_procs(rows, self._procs.cmdlines if self._procs else {})
        hints = self._hints
        out: dict[str, Any] = {"llm": [join(s, hints) for s in self._snapshot]}
        if self._error:
            out["errors"] = {"llm": self._error}
        return out

    def start(self) -> None:
        if self._thread is None and self._looks:
            self._thread = threading.Thread(target=self._run, name="llm-poller", daemon=True)
            self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=HTTP_TIMEOUT_S + 1)

    def _run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.poll_round(started)
                self._error = None
            except Exception as e:
                self._error = f"{type(e).__name__} while polling model servers"
                where = "".join(traceback.format_tb(e.__traceback__))
                log.debug("model server poll failed: %s\n%s", type(e).__name__, where)
            self._stop.wait(max(0.0, POLL_EVERY_S - (time.monotonic() - started)))

    def poll_round(self, now: float) -> None:
        hints = self._hints
        if now - self._found_at >= FIND_EVERY_S:
            self._found_at = now
            self._find(now, hints)
        results = []
        for port, tr in sorted(self._tracked.items()):
            if self._listening.get(port) != tr.at:
                if unread := self._unread_at(port):
                    tr.last = tr.last.model_copy(update=unread.shown(port))
                else:
                    self._down(tr, f"The server on port {port} stopped listening")
            else:
                try:
                    auth = self._auth.get(port, {})
                    tr.last = tr.adapter.poll(self._http, tr.at, tr.ident, tr.window, auth, now)
                except TimeoutError:
                    self._down(tr, f"No answer within {HTTP_TIMEOUT_S:g} s")
                except OSError:
                    self._down(tr, "The connection failed")
                if container := self._published.get(port):
                    tr.last = tr.last.model_copy(update={"container": container})
            if tr.last.state != "down":
                tr.down_since = None
            elif tr.down_since is None:
                tr.down_since = now
            if (
                tr.down_since is not None
                and now - tr.down_since > FORGET_AFTER_S
                and port not in self._target_ports
            ):
                del self._tracked[port]
            else:
                results.append(tr.last)
        for port in self._target_ports - self._tracked.keys():
            unanswered = NOT_A_MODEL_SERVER if port in self._listening else NOT_LISTENING
            unread = self._unread_at(port) or unanswered
            results.append(ModelServerSample(port=port, adapter="", **unread.shown(port)))
        self._snapshot = tuple(sorted(results, key=lambda s: s.port))

    def _unread_at(self, port: int) -> Unread | None:
        at = self._listening.get(port)
        return self._unread.get((port, at.inode)) if at else None

    @staticmethod
    def _down(tr: Tracked, problem: str) -> None:
        tr.last = tr.last.model_copy(update={"state": "down", "values": {"up": 0.0}, "problem": problem})

    def _listeners(self) -> list[Listener] | None:
        tables = [self._fs.read_once(p) for p in ("/proc/net/tcp", "/proc/net/tcp6")]
        if tables[0] is None:
            return None
        return [li for text in tables if text for li in parse_proc_net_tcp(text)]

    def _find(self, now: float, hints: Hints) -> None:
        if self._discover and now - self._docker_at >= DOCKER_TTL_S:
            self._docker_at = now
            try:
                self._published = published_ports(self._docker("/containers/json"))
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
                self._published = {}
                log.debug("docker port lookup failed: %s", type(e).__name__)
        # A database started with --port, or published by its container, holds no GPU memory, so it is
        # never sent a request.
        gpu_containers = {name for name, hint in hints.by_container.items() if hint.gpu_mem}
        gpu_argv_ports = frozenset(port for port, hint in hints.by_port.items() if hint.gpu_mem)
        gpu_docker_ports = frozenset(p for p, name in self._published.items() if name in gpu_containers)
        found = candidates(
            self._listeners(),
            self._default_ports,
            gpu_argv_ports,
            gpu_docker_ports,
            self._target_ports,
            self._discover,
        )
        self._listening = {li.port: li for li in found}
        sockets = {(li.port, li.inode) for li in found}
        self._unread = {key: unread for key, unread in self._unread.items() if key in sockets}
        self._identify_timeouts = {key: n for key, n in self._identify_timeouts.items() if key in sockets}
        for at in found:
            tracked = self._tracked.get(at.port)
            unread = self._unread.get((at.port, at.inode))
            if (tracked is None or tracked.at != at) and not (unread and unread.settled):
                self._identify(at, hints.by_port.get(at.port))

    def _identify(self, at: Listener, hint: ProcHint | None) -> None:
        auth = self._auth.get(at.port, {})
        key = (at.port, at.inode)
        self._unread.pop(key, None)
        unread = NOT_A_MODEL_SERVER
        for adapter in self._adapters:
            try:
                got = adapter.identify(self._http, at, hint, auth)
            except NotHttp:
                break
            except TimeoutError:
                self._identify_timeouts[key] = self._identify_timeouts.get(key, 0) + 1
                if self._identify_timeouts[key] < IDENTIFY_TIMEOUTS_BEFORE_REJECT:
                    return
                break
            except OSError:
                # A port Docker publishes resets every connection until the server in its container
                # listens, so a failed connection settles nothing and the socket is asked again.
                self._identify_timeouts.pop(key, None)
                return
            if isinstance(got, Identity):
                first = ModelServerSample(
                    port=at.port, adapter=adapter.name, values={"up": 0.0}, state="down"
                )
                self._tracked[at.port] = Tracked(at, adapter, got, Window(), first)
                return
            unread = got
            if not unread.settled:
                self._identify_timeouts.pop(key, None)
                break
        self._unread[key] = unread
