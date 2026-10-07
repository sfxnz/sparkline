"""Benchmark orchestration: catalog merge, run dispatch to agents, aggregation, cancel, baselines/regressions.

A ``BenchBackend`` talks to one node's bench runner: ``AgentBackend`` over HTTP to sparkline-agent, or the
demo simulation (demo_bench.DemoBench). Per-node ``NodeBenchState`` updates arrive from the agent stream
(``NodeSource.on_bench``), from the backend directly (demo), or from polling, and are folded into one
``BenchRun`` per run, persisted in SQLite and broadcast to browsers (<= 2/s, terminal always).
"""

from __future__ import annotations

import asyncio
import builtins
import contextlib
import csv
import io
import json
import logging
import re
import secrets
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx
from pydantic import ValidationError

from ..agent.bench.specs import REGISTRY as AGENT_REGISTRY
from ..common.schema import (
    BenchCreate,
    BenchResult,
    BenchRun,
    BenchSpec,
    BenchStartRequest,
    Event,
    NodeBenchState,
    NodeInfo,
    Problem,
)
from .bench_store import BenchStore
from .cluster import Cluster
from .nodes import AuthRejected, classify

log = logging.getLogger("sparkline.console.bench")

REGISTRY = [
    "gpu-matmul",
    "mem-bandwidth",
    "cpu-throughput",
    "nccl-allreduce",
    "rdma-bw-lat",
    "storage-fio",
    "llm-inference",
    "thermal-soak",
]
# One collective measured across the nodes: its results belong to the cluster (node_id None), not to rank 0.
CLUSTER_RESULTS = ("nccl-allreduce",)
TERMINAL = ("succeeded", "failed", "cancelled")
NCCL_PORT = 29620
READY_TIMEOUT_S = 30.0
CANCEL_TIMEOUT_S = 15.0
POLL_S = 5.0
TICK_S = 1.0
PERSIST_S = 10.0
BROADCAST_MIN_S = 0.5
CATALOG_TTL_S = 60.0
LOST_CANCEL_RETRY_S = 120.0
RECOVER_WAIT_S = 20.0
TELEMETRY_KEYS = ("util", "temp_c", "power_w", "sm_mhz", "throttle_mask")
TELEMETRY_MAX = 1800
LOG_TAIL = 60
_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


class BenchError(Exception):
    """A request the console refuses, with the HTTP status and a human Problem."""

    def __init__(self, status: int, problem: Problem):
        super().__init__(problem.message)
        self.status = status
        self.problem = problem


def canonical(params: dict[str, Any]) -> str:
    return json.dumps(params, sort_keys=True, separators=(",", ":"))


def new_run_id(now: float | None = None) -> str:
    """Short, lexicographically sortable by creation time: 9 base36 chars of ms + 3 random."""
    ms = int((time.time() if now is None else now) * 1000)
    s = ""
    while ms:
        ms, d = divmod(ms, 36)
        s = _B36[d] + s
    return s.rjust(9, "0") + "".join(secrets.choice(_B36) for _ in range(3))


def validate_params(spec: BenchSpec, params: dict[str, Any]) -> dict[str, Any]:
    """Check params against the spec (types, bounds, choices; unknown keys rejected) and fill defaults, so the
    same effective params always give the same params_key. Raises ValueError with a readable message."""
    known = {p.name: p for p in spec.params}
    unknown = sorted(set(params) - set(known))
    if unknown:
        raise ValueError(f"Unknown parameter(s) for {spec.id}: {', '.join(unknown)}")
    out: dict[str, Any] = {}
    for p in spec.params:
        v = params.get(p.name, p.default)
        where = f"{p.label} ({p.name})"
        if p.type == "int":
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            if isinstance(v, bool) or not isinstance(v, int):
                raise ValueError(f"{where} must be a whole number")
        elif p.type == "float":
            if isinstance(v, bool) or not isinstance(v, int | float):
                raise ValueError(f"{where} must be a number")
            v = float(v)
        elif p.type == "bool":
            if not isinstance(v, bool):
                raise ValueError(f"{where} must be true or false")
        elif p.type == "enum":
            if not isinstance(v, str) or v not in (p.choices or []):
                raise ValueError(f"{where} must be one of {', '.join(p.choices or [])}")
        elif p.type == "multi":
            choices = p.choices or []
            if not isinstance(v, list) or not v or any(x not in choices for x in v):
                raise ValueError(f"{where} must be a non-empty selection from {', '.join(choices)}")
            v = [c for c in choices if c in v]  # canonical order, no duplicates
        elif p.type == "string" and (not isinstance(v, str) or len(v) > 500):
            raise ValueError(f"{where} must be text of at most 500 characters")
        if p.type in ("int", "float"):
            if p.min is not None and v < p.min:
                raise ValueError(f"{where} must be at least {p.min:g}")
            if p.max is not None and v > p.max:
                raise ValueError(f"{where} must be at most {p.max:g}")
        out[p.name] = v
    return out


def rail_ip(info: NodeInfo | None, rail: str) -> str | None:
    """IPv4 of this node's ConnectX-7 rail ``rail`` ("A", "B"): by label ("... rail A"), else by position
    among addressed interconnect interfaces (NodeInfo.net lists rails A, B first)."""
    if info is None:
        return None
    ifaces = [n for n in info.net if n.role == "interconnect" and n.ipv4]
    for n in ifaces:
        m = re.search(r"rail ([A-Z])$", n.label)
        if m and m.group(1) == rail:
            return n.ipv4[0]
    idx = ord(rail[:1] or "A") - ord("A")
    return ifaces[idx].ipv4[0] if 0 <= idx < len(ifaces) else None


def unsupported(r: BenchResult) -> bool:
    """A precision the node cannot run: value 0 with extras.unsupported, not a measurement."""
    return r.extras.get("unsupported") is True


def apply_baseline(
    results: list[BenchResult], base_results: list[BenchResult], pct: float
) -> list[tuple[BenchResult, float]]:
    """Fill baseline/regression on ``results`` (matched by metric + node). Returns [(regressed result, signed
    change vs baseline)]. A regression is worse than the baseline by more than ``pct`` %, where worse
    respects ``better``. Results that are themselves percentages (unit "%") change in percentage points
    instead: 0.5 % -> 1 % throttled is +0.5 points, not +100 %, and a 0 % baseline still compares."""

    def key(r: BenchResult) -> tuple:
        # A CPU smoke run never compares with a GPU measurement, nor fio with the built-in storage runner.
        return (r.metric, r.node_id, r.extras.get("smoke") is True, r.extras.get("method"))

    base = {key(r): r.value for r in base_results if not unsupported(r)}
    out = []
    for r in results:
        b = base.get(key(r))
        if b is None or unsupported(r):
            continue
        r.baseline = b
        points = r.unit == "%"
        change = r.value - b if points else (r.value - b) / abs(b) * 100 if b else 0.0
        worse = -change if r.better == "higher" else change
        r.regression = (points or bool(b)) and worse > pct
        if r.regression:
            out.append((r, change))
    return out


def merge_description(bench_id: str, by_node: dict[str, str]) -> str | None:
    """One description for the merged catalog: each agent appends its own note ("fio is not installed, so the
    built-in runner is used") to the registry text; name the nodes it applies to instead of "this node".
    None when an agent's text does not start with this console's registry text (another release)."""
    bench = AGENT_REGISTRY.get(bench_id)
    if bench is None or not all(d.startswith(bench.description) for d in by_node.values()):
        return None
    notes: dict[str, list[str]] = {}
    for node, d in by_node.items():
        if note := d[len(bench.description) :].strip():
            notes.setdefault(note, []).append(node)
    return " ".join([bench.description, *(f"{', '.join(ns)}: {n}" for n, ns in notes.items())])


def fmt_num(v: float) -> str:
    a = abs(v)
    if a >= 1000:
        return f"{v:,.0f}"
    if a >= 100:
        return f"{v:.0f}"
    if a >= 10:
        return f"{v:.1f}"
    return f"{v:.2f}"


def regression_title(node: str | None, r: BenchResult, change: float) -> str:
    sign = "−" if change < 0 else "+"
    unit = "%" if r.unit == "%" else f" {r.unit}" if r.unit else ""
    delta = f"{sign}{abs(change):.1f} points" if r.unit == "%" else f"{sign}{abs(change):.1f}%"
    return (
        f"Benchmark regression on {node or 'cluster'}: {r.label} {fmt_num(r.value)}{unit} "
        f"vs baseline {fmt_num(r.baseline or 0)}{unit if r.unit == '%' else ''} ({delta})"
    )


def threshold_text(r: BenchResult, pct: float) -> str:
    """The regression threshold as it applies to ``r``: "5%", or "5 percentage points" for a % result."""
    return f"{pct:g} percentage points" if r.unit == "%" else f"{pct:g}%"


def _dur(s: float) -> str:
    s = max(0.0, s)
    if s < 90:
        return f"{s:.0f} s"
    return f"{int(s // 60)} min {int(s % 60):02d} s"


def _halve(values: list[float], bitmask: bool) -> list[float]:
    """Downsample by 2: mean of pairs (OR of pairs for bitmasks); a trailing odd point is kept."""
    out = []
    for i in range(0, len(values) - 1, 2):
        a, b = values[i], values[i + 1]
        out.append(float(int(a) | int(b)) if bitmask else (a + b) / 2)
    if len(values) % 2:
        out.append(values[-1])
    return out


def runs_csv(runs: list[BenchRun]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["run_id", "bench_id", "node_id", "metric", "label", "value", "unit", "better", "baseline"]
    w.writerow([*cols, "regression", "started", "finished", "driver", "cuda", "suite_git"])

    def iso(ts: float | None) -> str:
        return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds") if ts else ""

    for run in runs:
        nodes_meta = run.metadata.get("nodes") or {}
        for r in run.results:
            meta = nodes_meta.get(r.node_id) or {}
            w.writerow(
                [
                    run.id,
                    run.bench_id,
                    r.node_id or "",
                    r.metric,
                    r.label,
                    r.value,
                    r.unit,
                    r.better,
                    "" if r.baseline is None else r.baseline,
                    "true" if r.regression else "false",
                    iso(run.started_ts),
                    iso(run.finished_ts),
                    meta.get("driver", ""),
                    meta.get("cuda", ""),
                    meta.get("suite_git", meta.get("git", "")),
                ]
            )
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------------------------------------

StateCallback = Callable[[str, NodeBenchState], None]


class BenchBackend(Protocol):
    def bind(self, on_state: StateCallback) -> None: ...
    async def open(self) -> None: ...
    async def close(self) -> None: ...
    async def catalog(self, node: str) -> list[BenchSpec]: ...
    async def start(self, node: str, req: BenchStartRequest) -> NodeBenchState: ...
    async def get(self, node: str, run_id: str) -> NodeBenchState | None: ...
    async def cancel(self, node: str, run_id: str) -> None: ...


def _agent_problem(r: httpx.Response) -> Problem | None:
    try:
        return Problem.model_validate(r.json()["problem"])
    except (ValueError, KeyError, TypeError, ValidationError):
        return None


class AgentBackend:
    """sparkline-agent's /api/v1/bench endpoints. State updates also arrive on the agent stream, routed by
    NodeSource.on_bench (wired up by BenchManager)."""

    def __init__(self, cluster: Cluster, agent_token: str):
        self.cluster = cluster
        self.token = agent_token
        self.http: httpx.AsyncClient | None = None

    def bind(self, on_state: StateCallback) -> None:
        pass

    async def open(self) -> None:
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0))

    async def close(self) -> None:
        if self.http:
            await self.http.aclose()

    async def _req(self, node: str, method: str, path: str, body: dict | None = None) -> httpx.Response:
        src = self.cluster.sources[node]
        assert self.http is not None
        try:
            r = await self.http.request(
                method,
                f"{src.url.rstrip('/')}/api/v1/bench{path}",
                json=body,
                headers={"Authorization": f"Bearer {self.token}"},
            )
        except Exception as e:  # noqa: BLE001
            raise BenchError(503, classify(e, node, src.url)[1]) from None
        if r.status_code in (401, 403):
            raise BenchError(502, classify(AuthRejected(r.status_code), node, src.url)[1])
        return r

    def _bad(self, node: str, what: str, r: httpx.Response) -> BenchError:
        return BenchError(
            502,
            _agent_problem(r)
            or Problem(
                message=f"Agent on {node} could not {what}",
                cause=f"HTTP {r.status_code}: {r.text[:200]}",
                fix=f"Check `journalctl -u sparkline-agent` on {node}",
            ),
        )

    def _parse(self, node: str, fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except (ValidationError, ValueError, TypeError) as e:
            raise BenchError(
                502,
                Problem(
                    message=f"Agent on {node} sent an invalid benchmark reply",
                    cause=str(e)[:200],
                    fix="Upgrade sparkline-agent and sparkline to the same release",
                ),
            ) from None

    async def catalog(self, node: str) -> list[BenchSpec]:
        r = await self._req(node, "GET", "/catalog")
        if r.status_code != 200:
            raise self._bad(node, "list its benchmarks", r)
        return self._parse(node, lambda: [BenchSpec.model_validate(x) for x in r.json()])

    async def start(self, node: str, req: BenchStartRequest) -> NodeBenchState:
        r = await self._req(node, "POST", "/runs", req.model_dump())
        if r.status_code in (200, 201, 202):
            return self._parse(node, lambda: NodeBenchState.model_validate(r.json()))
        if r.status_code == 409:
            raise BenchError(
                409,
                _agent_problem(r)
                or Problem(
                    message=f"A benchmark is already running on {node}",
                    cause="The agent runs one benchmark at a time",
                    fix="Wait for it to finish, or cancel it",
                ),
            )
        if r.status_code == 422:
            raise BenchError(
                400,
                _agent_problem(r)
                or Problem(
                    message="Invalid benchmark parameters",
                    cause=r.text[:200],
                    fix="Correct the parameters and try again",
                ),
            )
        raise self._bad(node, "start the benchmark", r)

    async def get(self, node: str, run_id: str) -> NodeBenchState | None:
        r = await self._req(node, "GET", f"/runs/{run_id}")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._bad(node, "report the benchmark state", r)
        return self._parse(node, lambda: NodeBenchState.model_validate(r.json()))

    async def cancel(self, node: str, run_id: str) -> None:
        r = await self._req(node, "POST", f"/runs/{run_id}/cancel")
        if r.status_code not in (200, 202, 404):
            raise self._bad(node, "cancel the benchmark", r)


# ---------------------------------------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------------------------------------


@dataclass
class _Active:
    run: BenchRun
    name: str
    requests: dict[str, BenchStartRequest] = field(default_factory=dict)
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    cancel_ts: float | None = None  # cancellation sent (user cancel or failure cascade)
    user_cancel: bool = False
    notes: list[str] = field(default_factory=list)
    tele_last: dict[str, float] = field(default_factory=dict)
    tele_prev: dict[str, dict[str, float]] = field(default_factory=dict)
    last_broadcast: float = 0.0
    flush: asyncio.TimerHandle | None = None
    last_persist: float = 0.0


class BenchManager:
    def __init__(self, cluster: Cluster, store: BenchStore, backend: BenchBackend):
        self.cluster = cluster
        self.store = store
        self.backend = backend
        self.active: dict[str, _Active] = {}
        self._recovering: set[str] = set()  # nodes of runs being recovered after a restart
        self._catalog: dict[str, tuple[float, float | None, list[BenchSpec]]] = {}
        self._tasks: set[asyncio.Task] = set()
        backend.bind(self.on_node_state)
        for src in cluster.sources.values():
            src.on_bench = self.on_node_state

    # -- lifecycle --------------------------------------------------------------------------------
    async def start(self) -> None:
        await self.backend.open()
        for run in self.store.unfinished():
            self._recovering.update(run.nodes)
            self._spawn(self._recover(run))

    async def stop(self) -> None:
        tasks = [*self._tasks, *(a.task for a in self.active.values() if a.task)]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        for a in self.active.values():  # still running on the agents: recovered on the next start
            self.store.save(a.run)
        await self.backend.close()

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._task_done)
        return t

    def _task_done(self, t: asyncio.Task) -> None:
        self._tasks.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.error("benchmark task failed", exc_info=t.exception())

    # -- catalog ----------------------------------------------------------------------------------
    async def _node_catalog(self, node: str) -> tuple[list[BenchSpec], Problem | None]:
        src = self.cluster.sources[node]
        cached = self._catalog.get(node)
        specs = cached[2] if cached else []
        st = src.state
        if st.status in ("offline", "error") or src.connected_at is None:
            e = st.error
            return specs, Problem(
                message=f"{node} is {st.status if st.status != 'connecting' else 'not connected yet'}",
                cause=f"{e.message}: {e.cause}" if e else "The console has no connection to its agent",
                fix=e.fix if e else "Wait for the console to connect, or press Retry on the node",
            )
        if cached and time.time() - cached[0] < CATALOG_TTL_S and cached[1] == src.connected_at:
            return specs, None
        try:
            fresh = await self.backend.catalog(node)
        except BenchError as e:
            return specs, e.problem
        self._catalog[node] = (time.time(), src.connected_at, fresh)
        return fresh, None

    async def catalog(self) -> list[BenchSpec]:
        nodes = list(self.cluster.sources)
        got = await asyncio.gather(*(self._node_catalog(n) for n in nodes))
        merged: dict[str, BenchSpec] = {}
        for specs, _ in got:
            for s in specs:
                if s.id not in merged:
                    merged[s.id] = s.model_copy(deep=True, update={"availability": {}})
                    if s.min_nodes <= 1:  # per-node benchmark: the console runs it on any number of nodes
                        merged[s.id].max_nodes = None
        for spec in merged.values():
            descriptions: dict[str, str] = {}
            for node, (specs, problem) in zip(nodes, got, strict=True):
                mine = next((s for s in specs if s.id == spec.id), None)
                spec.availability[node] = problem or self._availability(node, spec, mine)
                if mine is not None:
                    descriptions[node] = mine.description
            spec.description = merge_description(spec.id, descriptions) or spec.description
        order = {b: i for i, b in enumerate(REGISTRY)}
        return sorted(merged.values(), key=lambda s: (order.get(s.id, len(order)), s.id))

    def _availability(self, node: str, spec: BenchSpec, mine: BenchSpec | None) -> Problem | None:
        if mine is None:
            return Problem(
                message=f"{spec.name} is not offered by {node}",
                cause=f"The agent on {node} does not list this benchmark",
                fix=f"Upgrade sparkline-agent on {node} to the console's release",
            )
        av = mine.availability
        p = av[node] if node in av else (next(iter(av.values())) if len(av) == 1 else None)
        if p is None and spec.min_nodes >= 2 and rail_ip(self.cluster.sources[node].state.info, "A") is None:
            p = Problem(
                message=f"{node} has no ConnectX-7 peer",
                cause="None of its ConnectX-7 interfaces has an IPv4 address: it cannot reach another Spark",
                fix=f"Cable {node}'s ConnectX-7 port to another Spark and give the rails addresses",
            )
        return p

    # -- create / dispatch ------------------------------------------------------------------------
    def _busy(self, node: str) -> BenchRun | None:
        return next((a.run for a in self.active.values() if node in a.run.nodes), None)

    async def create(self, body: BenchCreate) -> BenchRun:
        if not body.confirm:
            raise BenchError(
                400,
                Problem(
                    message="Confirmation required",
                    cause="Benchmarks start only after the confirmation step (confirm must be true)",
                    fix="Review the duration and impact, then confirm the run",
                ),
            )
        specs = await self.catalog()
        spec = next((s for s in specs if s.id == body.bench_id), None)
        if spec is None:
            raise BenchError(
                404,
                Problem(
                    message=f"Unknown benchmark {body.bench_id!r}",
                    cause="No connected agent offers it",
                    fix=f"Choose one of: {', '.join(REGISTRY)}",
                ),
            )
        nodes = body.nodes
        bad = [n for n in nodes if n not in self.cluster.sources]
        if bad or len(set(nodes)) != len(nodes) or not nodes:
            raise BenchError(
                400,
                Problem(
                    message="Invalid node selection",
                    cause=f"Unknown node(s): {', '.join(bad)}" if bad else "Nodes must be listed once each",
                    fix="Pick nodes from the cluster",
                ),
            )
        if len(nodes) < spec.min_nodes or (spec.max_nodes is not None and len(nodes) > spec.max_nodes):
            want = (
                f"exactly {spec.min_nodes}"
                if spec.max_nodes == spec.min_nodes
                else f"{spec.min_nodes}–{spec.max_nodes or 'any'}"
            )
            raise BenchError(
                400,
                Problem(
                    message=f"{spec.name} needs {want} node(s)",
                    cause=f"{len(nodes)} selected",
                    fix=f"Select {want} node(s)",
                ),
            )
        for n in nodes:
            if (p := spec.availability.get(n)) is not None:
                raise BenchError(400, p)
        for n in nodes:
            other = self._busy(n)
            if other is not None or n in self._recovering:
                raise BenchError(
                    409,
                    Problem(
                        message=f"A benchmark is already running on {n}",
                        cause=f"Run {other.id} ({other.bench_id})" if other else "A run is being recovered",
                        fix="Wait for it to finish, or cancel it",
                    ),
                )
        try:
            params = validate_params(spec, body.params)
        except ValueError as e:
            raise BenchError(
                400,
                Problem(message="Invalid benchmark parameters", cause=str(e), fix="Correct it and try again"),
            ) from None
        now = time.time()
        run_id = new_run_id(now)
        while run_id in self.active or self.store.get(run_id) is not None:  # same ms + same suffix
            run_id = new_run_id(now)
        run = BenchRun(
            id=run_id,
            bench_id=spec.id,
            params=params,
            nodes=list(nodes),
            status="queued",
            created_ts=now,
            phase="Starting",
            params_key=canonical(params),
            metadata={"bench_name": spec.name},
        )
        act = _Active(run=run, name=spec.name, last_broadcast=now)  # nothing goes out while dispatching
        self.active[run.id] = act  # reserves the nodes while dispatching
        try:
            await self._dispatch(act)
        except BaseException:
            self.active.pop(run.id, None)
            raise
        if run.id not in self.active:  # finished while dispatching
            return run
        run.status = "running"
        run.started_ts = time.time()
        self._persist(act)
        self._event(run, f"Benchmark started: {spec.name} on {', '.join(nodes)}", self._params_text(run))
        self._changed(act)
        act.task = self._spawn(self._supervise(act))
        return run

    def _info(self, node: str) -> NodeInfo | None:
        return self.cluster.sources[node].state.info

    def _no_rail(self, node: str, rail: str) -> BenchError:
        return BenchError(
            400,
            Problem(
                message=f"{node} has no address on ConnectX-7 rail {rail}",
                cause=f"No interconnect interface labelled rail {rail} with an IPv4 address in its NodeInfo",
                fix=f"Check the CX7 link on {node} (`ip -br addr`), or pick the other rail",
            ),
        )

    async def _dispatch(self, act: _Active) -> None:
        run = act.run
        base: dict[str, Any] = {"run_id": run.id, "bench_id": run.bench_id, "params": run.params}
        if run.bench_id == "rdma-bw-lat":
            client, server = run.nodes
            rail = str(run.params.get("rail", "A"))
            ip = rail_ip(self._info(server), rail)
            if ip is None:
                raise self._no_rail(server, rail)
            act.requests = {
                server: BenchStartRequest(**base, role="server", peer_node=client),
                client: BenchStartRequest(**base, role="client", peer_node=server, peer_ip=ip),
            }
            await self._start_node(act, server)  # the client starts once the server is ready (supervisor)
            return
        if run.bench_id == "nccl-allreduce":
            r0, r1 = run.nodes
            ip = rail_ip(self._info(r0), "A")
            if ip is None:
                raise self._no_rail(r0, "A")
            act.requests = {
                n: BenchStartRequest(
                    **base,
                    role="rank",
                    rank=i,
                    world_size=2,
                    peer_node=run.nodes[1 - i],
                    peer_ip=ip,
                    peer_port=NCCL_PORT,
                )
                for i, n in enumerate(run.nodes)
            }
        else:
            act.requests = {n: BenchStartRequest(**base, role="single") for n in run.nodes}
        out = await asyncio.gather(*(self._start_node(act, n) for n in run.nodes), return_exceptions=True)
        errors = [e for e in out if isinstance(e, BaseException)]
        if errors:
            started = [n for n, e in zip(run.nodes, out, strict=True) if not isinstance(e, BaseException)]
            for n in started:
                self._spawn(self._cancel_one(n, run.id, quiet=True))
            raise errors[0]

    async def _start_node(self, act: _Active, node: str) -> None:
        st = await self.backend.start(node, act.requests[node])
        if act.cancel_ts is not None or act.run.id not in self.active:  # cancelled/failed meanwhile
            self._spawn(self._cancel_one(node, act.run.id, quiet=True))
        self.on_node_state(node, st)

    # -- state updates ----------------------------------------------------------------------------
    def on_node_state(self, node: str, st: NodeBenchState) -> None:
        act = self.active.get(st.run_id)
        if act is None or node not in act.run.nodes:
            return
        cur = act.run.node_states.get(node)
        if cur is not None and cur.status in TERMINAL:
            return
        st = st.model_copy(update={"node_id": node})
        act.run.node_states[node] = st
        if st.ready and act.requests.get(node) and act.requests[node].role == "server":
            act.ready.set()
        self._recompute(act)

    def _node_terminal(
        self, act: _Active, node: str, status: str, problem: Problem | None, phase: str = ""
    ) -> None:
        cur = act.run.node_states.get(node)
        if cur is not None and cur.status in TERMINAL:
            return
        req = act.requests.get(node)
        base = cur or NodeBenchState(
            run_id=act.run.id,
            bench_id=act.run.bench_id,
            node_id=node,
            role=req.role if req else "single",
            status="queued",
        )
        act.run.node_states[node] = base.model_copy(
            update={
                "status": status,
                "error": problem or base.error,
                "finished_ts": time.time(),
                "phase": phase or base.phase,
            }
        )
        self._recompute(act)

    def _recompute(self, act: _Active) -> None:
        run = act.run
        if run.id not in self.active:
            return
        states = [run.node_states.get(n) for n in run.nodes]
        run.progress = round(sum(s.progress if s else 0.0 for s in states) / len(states), 4)
        failed = [s for s in states if s and s.status == "failed"]
        if failed and run.error is None:
            s = failed[0]
            run.error = s.error or Problem(
                message=f"{act.name} failed on {s.node_id}",
                cause="The agent reported a failure without details",
                fix=f"Check `journalctl -u sparkline-agent` on {s.node_id}",
            )
        if failed and act.cancel_ts is None:
            self._cancel_nodes(act)  # may finish the run (nodes that never started)
            if run.id in self.active:
                self._recompute(act)
            return
        if all(s is not None and s.status in TERMINAL for s in states):
            self._finalize(act)
            return
        run.phase = "Cancelling" if act.user_cancel else self._phase(act)
        self._changed(act)

    def _phase(self, act: _Active) -> str:
        run = act.run
        live = [
            (n, s)
            for n in run.nodes
            if (s := run.node_states.get(n)) is not None and s.status not in TERMINAL and s.phase
        ]
        if not live:
            return run.phase or "Starting"
        if run.bench_id in ("rdma-bw-lat", "nccl-allreduce") or len(run.nodes) == 1:
            n, s = next(((n, s) for n, s in live if n == run.nodes[0]), live[0])  # client / rank 0
            return s.phase
        if len({s.phase for _, s in live}) == 1:
            return live[0][1].phase
        n, s = min(live, key=lambda x: x[1].progress)  # the slowest node bounds the run
        return f"{n}: {s.phase}"

    def _cancel_nodes(self, act: _Active) -> None:
        act.cancel_ts = time.time()
        for n in act.run.nodes:
            st = act.run.node_states.get(n)
            if st is None:  # never started (rdma client waiting for its server)
                self._node_terminal(act, n, "cancelled", None, "Not started")
                if act.run.id not in self.active:
                    return
            elif st.status not in TERMINAL:
                self._spawn(self._cancel_one(n, act.run.id))

    async def _cancel_one(self, node: str, run_id: str, quiet: bool = False) -> None:
        try:
            await self.backend.cancel(node, run_id)
            if not quiet and run_id in self.active:
                st = await self.backend.get(node, run_id)
                if st is not None:
                    self.on_node_state(node, st)
        except BenchError as e:
            log.info("cancel of %s on %s failed: %s", run_id, node, e.problem.cause)

    async def _cancel_lost(self, node: str, run_id: str) -> None:
        """Best effort: the run may still be running on a node we lost; ask it to stop once reachable."""
        deadline = time.time() + LOST_CANCEL_RETRY_S
        while time.time() < deadline:
            try:
                await self.backend.cancel(node, run_id)
                return
            except BenchError:
                await asyncio.sleep(POLL_S)

    # -- supervisor -------------------------------------------------------------------------------
    async def _supervise(self, act: _Active) -> None:
        run = act.run
        try:
            self._record_telemetry(act, time.time())
            if run.bench_id == "rdma-bw-lat":
                await self._start_rdma_client(act)
            last_poll = time.time()
            while run.id in self.active:
                await asyncio.sleep(TICK_S)
                now = time.time()
                self._record_telemetry(act, now)
                self._check_lost(act)
                if run.id not in self.active:
                    break
                if now - last_poll >= (TICK_S if act.cancel_ts else POLL_S):
                    last_poll = now
                    await self._poll(act)
                if act.cancel_ts and now - act.cancel_ts > CANCEL_TIMEOUT_S and run.id in self.active:
                    for n in run.nodes:
                        st = run.node_states.get(n)
                        if st is None or st.status not in TERMINAL:
                            act.notes.append(
                                f"{n} did not confirm cancellation within {CANCEL_TIMEOUT_S:.0f} s"
                            )
                    for n in list(run.nodes):
                        if run.id in self.active:
                            self._node_terminal(act, n, "cancelled", None, "Cancelled")
                if run.id in self.active and now - act.last_persist >= PERSIST_S:
                    self._persist(act)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("benchmark supervisor failed for %s", run.id)
            if run.id in self.active:
                for n in run.nodes:
                    if run.id in self.active:
                        self._node_terminal(
                            act,
                            n,
                            "failed",
                            Problem(
                                message="The console lost track of the run",
                                cause="Internal error in the benchmark supervisor",
                                fix="See the sparkline log, then run the benchmark again",
                            ),
                        )

    async def _start_rdma_client(self, act: _Active) -> None:
        run = act.run
        client, server = run.nodes
        if client in run.node_states:  # recovered after a console restart: already started
            return
        deadline = time.time() + READY_TIMEOUT_S
        while True:
            if run.id not in self.active or act.cancel_ts is not None:
                return
            st = run.node_states.get(server)
            if st is not None and st.ready:
                break
            if st is not None and st.status in TERMINAL:
                if run.id in self.active:  # ended without failing, before its client could start
                    self._node_terminal(
                        act,
                        client,
                        "failed",
                        Problem(
                            message=f"RDMA server on {server} stopped before the client started",
                            cause=f"ib_write_bw on {server} ended ({st.status}) without accepting a client",
                            fix="Run the benchmark again",
                        ),
                    )
                return
            if time.time() > deadline:
                self._node_terminal(
                    act,
                    server,
                    "failed",
                    Problem(
                        message=f"RDMA server on {server} did not become ready",
                        cause=f"No ready signal within {READY_TIMEOUT_S:.0f} s of starting ib_write_bw",
                        fix=f"Check perftest on {server} (`ib_write_bw -d rocep1s0f1`) and "
                        f"`journalctl -u sparkline-agent`",
                    ),
                )
                return
            try:
                await asyncio.wait_for(act.ready.wait(), 1.0)
            except TimeoutError:
                with contextlib.suppress(BenchError):
                    if (got := await self.backend.get(server, run.id)) is not None:
                        self.on_node_state(server, got)
        try:
            await self._start_node(act, client)
        except BenchError as e:
            self._node_terminal(act, client, "failed", e.problem)

    def _check_lost(self, act: _Active) -> None:
        for n in act.run.nodes:
            st = act.run.node_states.get(n)
            if st is None or st.status in TERMINAL:
                continue
            src = self.cluster.sources[n]
            if src.state.status in ("offline", "error"):
                e = src.state.error
                self._spawn(self._cancel_lost(n, act.run.id))
                self._node_terminal(
                    act,
                    n,
                    "failed",
                    Problem(
                        message=f"Lost contact with {n} during the run",
                        cause=f"{e.message}: {e.cause}" if e else f"{n} went {src.state.status}",
                        fix=(
                            f"Check `systemctl status sparkline-agent` on {n}. The console asks it to stop "
                            "the benchmark once it is reachable again"
                        ),
                    ),
                )
                if act.run.id not in self.active:
                    return

    async def _poll(self, act: _Active) -> None:
        for n in list(act.run.nodes):
            st = act.run.node_states.get(n)
            if st is None or st.status in TERMINAL or act.run.id not in self.active:
                continue
            try:
                got = await self.backend.get(n, act.run.id)
            except BenchError:
                continue  # connection problems are handled by _check_lost
            if got is None:
                self._node_terminal(
                    act,
                    n,
                    "failed",
                    Problem(
                        message=f"Lost contact with {n} during the run",
                        cause=f"The agent on {n} no longer knows run {act.run.id} (it may have restarted)",
                        fix="Run the benchmark again",
                    ),
                )
            else:
                self.on_node_state(n, got)

    def _record_telemetry(self, act: _Active, now: float) -> None:
        run = act.run
        for n in run.nodes:
            src = self.cluster.sources.get(n)
            if src is None or not src.ring:
                continue
            s = src.ring[-1]
            if s.ts <= act.tele_last.get(n, 0.0) or now - s.ts > 5:
                continue
            act.tele_last[n] = s.ts
            g = s.gpu[0] if s.gpu else None
            prev = act.tele_prev.setdefault(n, {})
            pre = f"telemetry.{n}."
            run.series.setdefault(pre + "ts", []).append(round(s.ts, 3))
            for key in TELEMETRY_KEYS:
                v = getattr(g, key, None) if g is not None else None
                v = prev.get(key, 0.0) if v is None else float(v)  # series hold floats: carry forward
                prev[key] = v
                run.series.setdefault(pre + key, []).append(v)
            if len(run.series[pre + "ts"]) > TELEMETRY_MAX:  # same length as _halve: ceil(n / 2)
                run.series[pre + "ts"] = run.series[pre + "ts"][::2]
                for key in TELEMETRY_KEYS:
                    run.series[pre + key] = _halve(run.series[pre + key], key == "throttle_mask")

    # -- finish -----------------------------------------------------------------------------------
    def _finalize(self, act: _Active) -> None:
        run = act.run
        self._record_telemetry(act, time.time())
        self.active.pop(run.id, None)
        if act.flush:
            act.flush.cancel()
        states = {n: run.node_states[n] for n in run.nodes}
        statuses = [s.status for s in states.values()]
        if "failed" in statuses:
            run.status = "failed"
        elif all(s == "succeeded" for s in statuses):
            run.status = "succeeded"
        else:
            run.status = "cancelled"
        run.finished_ts = time.time()
        results, logs = [], []
        for n, st in states.items():
            owner = None if run.bench_id in CLUSTER_RESULTS else n
            results += [r.model_copy(update={"node_id": owner}) for r in st.results]
            for k, v in st.series.items():
                run.series[f"{n}.{k}"] = v
            logs += [f"[{n}] {line}" for line in st.log_tail[-LOG_TAIL // max(1, len(states)) :]]
        run.results = results if run.status == "succeeded" else []  # partial results are discarded
        run.metadata["nodes"] = {n: st.metadata for n, st in states.items()}
        run.log_tail = (logs + [f"[console] {x}" for x in act.notes])[-LOG_TAIL:]
        if run.status == "succeeded":
            run.progress = 1.0
            run.phase = "Done"
        else:
            run.phase = "Failed" if run.status == "failed" else "Cancelled"
        regressions = self._compare_baseline(run) if run.status == "succeeded" else []
        self.store.save(run)
        self._broadcast(act, full=True)
        where = ", ".join(run.nodes)
        took = _dur(run.finished_ts - (run.started_ts or run.created_ts))
        if run.status == "succeeded":
            extra = f" · {len(regressions)} regression(s)" if regressions else ""
            self._event(
                run, f"Benchmark finished: {act.name} on {where}", f"{len(results)} results in {took}{extra}"
            )
        elif run.status == "failed":
            e = run.error
            self._event(
                run,
                f"Benchmark failed: {act.name} on {where}",
                f"{e.message}. {e.cause}" if e else f"Failed after {took}",
            )
        else:
            self._event(
                run, f"Benchmark cancelled: {act.name} on {where}", "; ".join([f"After {took}", *act.notes])
            )
        for r, change in regressions:
            self.cluster.add_event(
                Event(
                    id=0,
                    ts=time.time(),
                    node_id=r.node_id,
                    severity="warning",
                    kind="bench",
                    title=regression_title(r.node_id, r, change),
                    detail=(
                        f"{act.name} run {run.id} is more than "
                        f"{threshold_text(r, self.cluster.settings.regression_pct)} worse than baseline run "
                        f"{run.baseline_run_id}"
                    ),
                    metric=r.metric,
                    value=r.value,
                )
            )

    def _compare_baseline(self, run: BenchRun) -> list[tuple[BenchResult, float]]:
        base_id = self.store.baseline_id(run.bench_id, run.params_key)
        if not base_id or base_id == run.id:
            return []
        base = self.store.get(base_id)
        if base is None or base.status != "succeeded" or base.params_key != run.params_key:
            return []
        run.baseline_run_id = base_id
        pct = self.cluster.settings.regression_pct
        run.metadata["regression_pct"] = pct  # the threshold the flags were set with (settings may change)
        return apply_baseline(run.results, base.results, pct)

    # -- recovery after a console restart ---------------------------------------------------------
    async def _recover(self, run: BenchRun) -> None:
        try:
            states: dict[str, NodeBenchState | None] = {}
            deadline = time.time() + RECOVER_WAIT_S
            for n in run.nodes:
                src = self.cluster.sources.get(n)
                while src is not None and src.connected_at is None and time.time() < deadline:
                    await asyncio.sleep(0.5)
                st = None
                if src is not None and src.connected_at is not None:
                    with contextlib.suppress(BenchError):
                        st = await self.backend.get(n, run.id)
                states[n] = st
            known = {n: st for n, st in states.items() if st is not None}
            if len(known) == len(run.nodes):
                act = _Active(run=run, name=str(run.metadata.get("bench_name") or run.bench_id))
                run.node_states = dict(known)
                self.active[run.id] = act
                self._recompute(act)
                if run.id in self.active:
                    act.task = self._spawn(self._supervise(act))
                return
            for n, st in known.items():
                if st.status not in TERMINAL:
                    self._spawn(self._cancel_one(n, run.id, quiet=True))
            lost = [n for n in run.nodes if n not in known]
            run.status = "failed"
            run.finished_ts = time.time()
            run.phase = "Failed"
            run.error = Problem(
                message="Console restarted during the run",
                cause=f"The console stopped while the run was in progress, and {', '.join(lost)} no longer "
                "report it",
                fix="Run the benchmark again",
            )
            self.store.save(run)
            self.cluster.hub.broadcast({"type": "bench", "run": run.model_dump(mode="json")})
            self._event(
                run, f"Benchmark failed: {run.metadata.get('bench_name') or run.bench_id}", run.error.message
            )
        finally:
            for n in run.nodes:
                self._recovering.discard(n)

    # -- persistence / fan-out --------------------------------------------------------------------
    def _persist(self, act: _Active) -> None:
        act.last_persist = time.time()
        self.store.save(act.run)

    def _changed(self, act: _Active) -> None:
        since = time.time() - act.last_broadcast
        if since >= BROADCAST_MIN_S:
            self._broadcast(act)
        elif act.flush is None:
            act.flush = asyncio.get_running_loop().call_later(BROADCAST_MIN_S - since, self._flush, act)

    def _flush(self, act: _Active) -> None:
        act.flush = None
        if act.run.id in self.active:
            self._broadcast(act)

    def _broadcast(self, act: _Active, full: bool = False) -> None:
        """Live updates leave out the recorded telemetry (browsers have the live samples); the terminal one
        carries everything."""
        act.last_broadcast = time.time()
        run = act.run
        if not full:
            series = {k: v for k, v in run.series.items() if not k.startswith("telemetry.")}
            run = run.model_copy(update={"series": series})
        self.cluster.hub.broadcast({"type": "bench", "run": run.model_dump(mode="json")})

    def _event(self, run: BenchRun, title: str, detail: str) -> None:
        self.cluster.add_event(
            Event(
                id=0,
                ts=time.time(),
                node_id=run.nodes[0] if len(run.nodes) == 1 else None,
                severity="info",
                kind="bench",
                title=title,
                detail=detail[:500],
            )
        )

    @staticmethod
    def _params_text(run: BenchRun) -> str:
        parts = []
        for k, v in run.params.items():
            parts.append(f"{k}={'+'.join(map(str, v)) if isinstance(v, list) else v}")
        return ", ".join(parts) or "default parameters"

    # -- queries for the API ----------------------------------------------------------------------
    def get(self, run_id: str) -> BenchRun:
        act = self.active.get(run_id)
        if act is not None:
            return act.run.model_copy()
        run = self.store.get(run_id)
        if run is None:
            raise BenchError(
                404,
                Problem(message=f"No benchmark run {run_id}", cause="It may have been deleted", fix=""),
            )
        return run

    def list(self, bench_id: str | None, node: str | None, status: str | None, limit: int) -> list[BenchRun]:
        out = []
        for run in self.store.list(bench_id, node, status, limit):
            if run.id in self.active:
                run = self.active[run.id].run
            series = {k: v for k, v in run.series.items() if not k.startswith("telemetry.")}
            out.append(run.model_copy(update={"node_states": {}, "series": series}))
        return out

    async def cancel(self, run_id: str) -> BenchRun:
        act = self.active.get(run_id)
        if act is None:
            return self.get(run_id)  # 404, or already finished: nothing to do
        if not act.user_cancel:
            act.user_cancel = True
            act.notes.append("Cancelled by user")
            if act.cancel_ts is None:
                self._cancel_nodes(act)
            if run_id in self.active:
                act.run.phase = "Cancelling"
                self._changed(act)
        return self.get(run_id)

    def delete(self, run_id: str) -> None:
        if run_id in self.active or self.get(run_id).status in ("queued", "running"):
            raise BenchError(
                409,
                Problem(
                    message="This run is still in progress",
                    cause="Running benchmarks cannot be deleted",
                    fix="Cancel it first, then delete it",
                ),
            )
        self.store.delete(run_id)

    def set_baseline(self, bench_id: str, run_id: str) -> BenchRun:
        run = self.get(run_id)
        if run.bench_id != bench_id:
            raise BenchError(
                400,
                Problem(
                    message="Run belongs to a different benchmark",
                    cause=f"Run {run_id} is {run.bench_id}, not {bench_id}",
                    fix=f"Pick a {bench_id} run",
                ),
            )
        if run.status != "succeeded":
            raise BenchError(
                400,
                Problem(
                    message="Only a successful run can be a baseline",
                    cause=f"Run {run_id} is {run.status}",
                    fix="Pick a run that succeeded",
                ),
            )
        prev = self.store.baseline_id(bench_id, run.params_key)
        self.store.set_baseline(bench_id, run.params_key, run.id)
        run.baseline_for = True
        name = run.metadata.get("bench_name") or bench_id
        self.cluster.add_event(
            Event(
                id=0,
                ts=time.time(),
                node_id=run.nodes[0] if len(run.nodes) == 1 else None,
                severity="info",
                kind="bench",
                title=f"Baseline set: {name}",
                detail=(
                    f"Run {run.id} on {', '.join(run.nodes)} is the baseline for {self._params_text(run)}; "
                    f"later runs with these parameters are flagged when more than "
                    f"{self.cluster.settings.regression_pct:g}% worse"
                ),
            )
        )
        if prev and prev != run.id and (old := self.store.get(prev)) is not None:
            self.cluster.hub.broadcast({"type": "bench", "run": old.model_dump(mode="json")})
        self.cluster.hub.broadcast({"type": "bench", "run": run.model_dump(mode="json")})
        return run

    def compare(self, ids: builtins.list[str]) -> dict[str, Any]:
        runs = [self.get(i) for i in ids]
        metrics: dict[tuple[str, str | None], dict[str, Any]] = {}
        for run in runs:
            for r in run.results:
                m = metrics.setdefault(
                    (r.metric, r.node_id),
                    {
                        "metric": r.metric,
                        "label": r.label,
                        "unit": r.unit,
                        "better": r.better,
                        "node_id": r.node_id,
                        "values": {},
                    },
                )
                m["values"][run.id] = None if unsupported(r) else r.value
        return {"runs": [r.model_dump(mode="json") for r in runs], "metrics": list(metrics.values())}
