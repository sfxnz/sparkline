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
from ..sources import HTTP_TIMEOUT_S, Http, HttpReply, Sources
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
FORGET_AFTER_S = 600.0  # a discovered server that stays down this long leaves the list
MODELS_MAX = 32
TEXT_MAX = 128

TRT_OWNERS = ("tensorrt", "trtllm")
PROMETHEUS_OWNERS = {"vllm": "vLLM", "sglang": "SGLang", "llamacpp": "llama.cpp", "nvidia": "NIM"}
NO_METRICS = {
    "SGLang": "SGLang serves metrics only when started with --enable-metrics",
    "llama.cpp": "llama.cpp serves metrics only when started with --metrics",
    "TensorRT-LLM": "TensorRT-LLM serves Prometheus metrics only with return_perf_metrics",
}
NEEDS_KEY = "It wants an API key to list its models. Set api_key under [[model_servers]] in agent.toml"
HEALTH_PATH = "/health"
UP_STATES: tuple[ServerState, ...] = ("ready", "sleeping")


@dataclass(frozen=True)
class Identity:
    """What one identification learned. Fixed for the life of a listening socket."""

    software: str | None
    models: tuple[LoadedModel, ...]
    metrics_path: str | None  # None: it serves no Prometheus text; state and models still show
    problem: str | None  # why readings are missing, phrased as the fix


class Adapter(Protocol):
    name: str
    default_ports: frozenset[int]

    def identify(
        self, http: Http, at: Listener, hint: ProcHint | None, auth: Mapping[str, str]
    ) -> Identity | None:
        """Asked once per listening socket. None: not this adapter's server. Raises OSError when the
        socket gave no answer to decide on (a server still loading), and is asked again later."""
        ...

    def poll(
        self, http: Http, at: Listener, ident: Identity, window: Window, auth: Mapping[str, str], now: float
    ) -> ModelServerSample:
        """One poll, ``now`` in monotonic seconds. Raises OSError when the server does not answer."""
        ...


def _url(at: Listener, path: str) -> str:
    host = f"[{at.host}]" if ":" in at.host else at.host
    return f"http://{host}:{at.port}{path}"


def _clean(text: object, drop: str = r"[^\x20-\x7e]") -> str:
    return re.sub(drop, "", str(text))[:TEXT_MAX]


def _listed(reply: HttpReply) -> tuple[str, tuple[LoadedModel, ...]] | None:
    """An OpenAI-style model list -> (owned_by, models). None: the reply is not one. Every string in it
    is the server's own and goes to every console session, so it is cut and stripped here."""
    try:
        data = json.loads(reply.body)["data"]
        entries = [m for m in data if isinstance(m["id"], str)][:MODELS_MAX]
    except (ValueError, TypeError, KeyError):
        return None
    models = []
    for m in entries:
        meta = m.get("meta") if isinstance(m.get("meta"), dict) else {}
        sizes = (m.get("max_model_len"), m.get("context_length"), meta.get("n_ctx_train"))
        context = next((v for v in sizes if isinstance(v, int) and not isinstance(v, bool) and v > 0), None)
        name = m["id"].rstrip("/")
        name = os.path.basename(name) if name.startswith(("/", ".", "~")) else name
        models.append(LoadedModel(name=_clean(name), context_len=context))
    owner = _clean(entries[0].get("owned_by") or "", r"[^A-Za-z0-9_.-]")[:32] if entries else ""
    return owner, tuple(models)


def _series(reply: HttpReply) -> dict[str, list[Series]]:
    return parse_exposition(reply.body.decode(errors="replace")) if reply.status == 200 else {}


class PrometheusAdapter:
    """Servers that speak the OpenAI API and expose Prometheus text: vLLM, SGLang, llama.cpp, NIM,
    TensorRT-LLM, and any server that uses the same metric names under its own prefix."""

    name = "prometheus"
    default_ports = frozenset({8000, 8080, 9931, 30000})

    def identify(
        self, http: Http, at: Listener, hint: ProcHint | None, auth: Mapping[str, str]
    ) -> Identity | None:
        reply = http(_url(at, "/v1/models"), auth)
        if reply.status == 503:
            raise ConnectionError("still loading")
        locked = reply.status in (401, 403)
        listed = None if locked else _listed(reply)
        if not locked and (reply.status != 200 or listed is None):
            return None
        owner, models = listed or ("", ())
        if (hint is not None and hint.trt) or any(t in owner.lower() for t in TRT_OWNERS):
            # TensorRT-LLM's default metrics path answers JSON that a read drains, so this branch is the
            # only one a TensorRT-LLM server takes and it asks for the Prometheus path alone.
            software: str | None = "TensorRT-LLM"
            paths: tuple[str, ...] = ("/prometheus/metrics",)
        else:
            software = next((n for key, n in PROMETHEUS_OWNERS.items() if key in owner.lower()), None)
            paths = ("/metrics", "/v1/metrics")
        for path in paths:
            got = http(_url(at, path), auth)
            ns = pick_namespace(_series(got))
            if ns is not None:
                named = software or KNOWN_NAMESPACES.get(ns) or owner or ns.rstrip(":_") or None
                return Identity(named, models, path, NEEDS_KEY if locked else None)
        if software is None:
            # No metrics and no known owner. Ollama, LM Studio and mlx_lm answer /v1/models with the models
            # on disk, not the loaded ones, so they wait for adapters of their own.
            return None
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


ADAPTERS: tuple[Adapter, ...] = (PrometheusAdapter(),)  # in order: the first to claim a socket keeps it


@dataclass
class Tracked:
    """One server. Only the poller thread touches it."""

    at: Listener
    adapter: Adapter
    ident: Identity
    window: Window
    last: ModelServerSample
    down_since: float | None = None  # monotonic


def join(s: ModelServerSample, hints: Hints) -> ModelServerSample:
    """The server with the process that holds its port: from ``--port`` in a command line, else from the
    container Docker publishes the port for. A server that reports no memory of its own gets the GPU
    memory of that process. With no match the pid stays unknown."""
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
        self._rows: list[ProcSample] | None = None  # the process rows _hints was built from
        self._error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tracked: dict[int, Tracked] = {}
        self._rejected: set[tuple[int, int | None]] = set()  # sockets that answered and are no model server
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
                # The class and where it was raised, never the message: it could quote a request header.
                self._error = f"{type(e).__name__} while polling model servers"
                where = "".join(traceback.format_tb(e.__traceback__))
                log.debug("model server poll failed: %s\n%s", type(e).__name__, where)
            self._stop.wait(max(0.0, POLL_EVERY_S - (time.monotonic() - started)))

    def poll_round(self, now: float) -> None:
        """One round of the poller, ``now`` in monotonic seconds: look for new servers when that is due,
        poll each tracked one, publish the result."""
        hints = self._hints
        if now - self._found_at >= FIND_EVERY_S:
            self._found_at = now
            self._find(now, hints)
        results = []
        for port, tr in sorted(self._tracked.items()):
            if self._listening.get(port) != tr.at:
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
            why = "did not answer as a model server" if port in self._listening else "is not listening"
            problem = f"Port {port} {why}"
            results.append(
                ModelServerSample(port=port, adapter="", state="down", values={"up": 0.0}, problem=problem)
            )
        self._snapshot = tuple(sorted(results, key=lambda s: s.port))

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
        found = candidates(
            self._listeners(),
            self._default_ports,
            frozenset(hints.by_port),
            frozenset(self._published),
            self._target_ports,
            self._discover,
        )
        self._listening = {li.port: li for li in found}
        self._rejected &= {(li.port, li.inode) for li in found}
        for at in found:
            tracked = self._tracked.get(at.port)
            if (tracked is None or tracked.at != at) and (at.port, at.inode) not in self._rejected:
                self._identify(at, hints.by_port.get(at.port))

    def _identify(self, at: Listener, hint: ProcHint | None) -> None:
        auth = self._auth.get(at.port, {})
        for adapter in self._adapters:
            try:
                ident = adapter.identify(self._http, at, hint, auth)
            except OSError:
                return  # no answer to decide on: asked again on the next look
            if ident is not None:
                first = ModelServerSample(
                    port=at.port, adapter=adapter.name, values={"up": 0.0}, state="down"
                )
                self._tracked[at.port] = Tracked(at, adapter, ident, Window(), first)
                return
        self._rejected.add((at.port, at.inode))
