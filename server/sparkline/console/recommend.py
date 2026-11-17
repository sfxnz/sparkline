"""Browser-facing recommendations API (/api/v1/recommendations): the catalog from this release, and what
every node says about each entry. A ``RecBackend`` talks to one node: ``AgentRecs`` over HTTP to
sparkline-agent, or ``DemoRecs``, the demo's simulated nodes.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Literal, Protocol, cast

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from ..agent.bench.specs import is_gb10
from ..agent.recommend import NOT_GB10, cannot_apply, cannot_undo, no_helper
from ..common.recommendations import BY_ID, CATALOG
from ..common.schema import NodeRecommendations, NodeRecState, Problem, RecommendationsView, TuneResult
from .cluster import Cluster
from .demo import DemoSource
from .nodes import AuthRejected, classify

Verb = Literal["apply", "undo"]


class RecError(Exception):
    """A request the console refuses or a node could not serve, with the HTTP status and a human Problem."""

    def __init__(self, status: int, problem: Problem):
        super().__init__(problem.message)
        self.status = status
        self.problem = problem


class RecBackend(Protocol):
    async def node(self, node: str) -> NodeRecommendations: ...
    async def change(self, node: str, rec_id: str, verb: Verb) -> None: ...


class RecAction(BaseModel):
    node: str
    confirm: bool = False  # must be true; the UI only sets it from the confirmation dialog


class AgentRecs:
    """sparkline-agent's /api/v1/recommendations endpoints."""

    def __init__(self, cluster: Cluster, agent_token: str, http: Callable[[], httpx.AsyncClient]):
        self.cluster = cluster
        self.token = agent_token
        self.http = http

    async def _req(self, node: str, method: str, path: str = "") -> httpx.Response:
        src = self.cluster.sources[node]
        try:
            r = await self.http().request(
                method,
                f"{src.url.rstrip('/')}/api/v1/recommendations{path}",
                headers={"Authorization": f"Bearer {self.token}"},
            )
        except Exception as e:  # noqa: BLE001
            raise RecError(503, classify(e, node, src.url)[1]) from None
        if r.status_code in (401, 403):
            raise RecError(502, classify(AuthRejected(r.status_code), node, src.url)[1])
        if r.status_code == 404:  # the console checks the id first, so this is a missing route
            raise RecError(
                502,
                Problem(
                    message=f"The agent on {node} is too old for recommendations",
                    cause="It has no /api/v1/recommendations: they arrived in Sparkline 0.3.0",
                    fix="Update the nodes: sudo sparkline update on the console host",
                ),
            )
        return r

    def _bad(self, node: str, what: str, r: httpx.Response) -> RecError:
        return RecError(
            502,
            Problem(
                message=f"Agent on {node} could not {what}",
                cause=f"HTTP {r.status_code}: {r.text[:200]}",
                fix=f"Check `journalctl -u sparkline-agent` on {node}",
            ),
        )

    async def node(self, node: str) -> NodeRecommendations:
        r = await self._req(node, "GET")
        if r.status_code != 200:
            raise self._bad(node, "report its settings", r)
        try:
            return NodeRecommendations.model_validate_json(r.content)
        except ValidationError as e:
            raise RecError(
                502,
                Problem(
                    message=f"Agent on {node} sent an invalid recommendations reply",
                    cause=str(e)[:200],
                    fix="Upgrade sparkline-agent and sparkline to the same release",
                ),
            ) from None

    async def change(self, node: str, rec_id: str, verb: Verb) -> None:
        r = await self._req(node, "POST", f"/{rec_id}/{verb}")
        if r.status_code == 202:
            return
        try:
            problem = Problem.model_validate(r.json()["problem"])
        except (ValueError, KeyError, TypeError, ValidationError):
            raise self._bad(node, f"{verb} the setting", r) from None
        # 409: not one-click, a benchmark is running, nothing to apply, or not Sparkline's to undo.
        # 501: the node has no root helper.
        raise RecError(r.status_code if r.status_code in (409, 501) else 502, problem)


# What a real probe reads, for each setting applied and not applied.
DEMO_DETAIL: dict[str, dict[bool, str]] = {
    "gpu-clock-cap": {
        True: "Capped at 2200 MHz by {by}",
        False: "No cap found: Sparkline has not applied one, and no active systemd unit runs nvidia-smi -lgc",
    },
    "cpu-pcore-cap": {
        True: "The performance cores (10 frequency policies) are capped at 3000 MHz",
        False: "The performance cores may run up to 3900 MHz",
    },
    "headless-boot": {
        True: "Boots without the desktop (multi-user.target). {desktop}",
        False: "Boots to the desktop (graphical.target). {desktop}",
    },
    "display-reserved-memory": {
        True: "Set to Auto: 512 MiB reserved",
        False: "Set to 2 GB: 2048 MiB reserved",
    },
}
# node -> the settings applied there when the demo starts, and whether Sparkline's helper applied them.
# spark1 has its GPU cap from its owner's own unit, as many machines do. A node not listed has none.
DEMO_APPLIED: dict[str, dict[str, bool]] = {
    "spark1": {"gpu-clock-cap": False},
    "spark2": {"cpu-pcore-cap": True, "headless-boot": True, "display-reserved-memory": False},
    "spark3": {"display-reserved-memory": False},
}
DEMO_NO_HELPER = "spark3"  # installed without --enable-tune: it shows the commands instead of a button
DEMO_UNIT = "nvidia-lock-clocks.service"
# Whether the desktop runs was decided when the node booted, so a click on headless-boot leaves it as it is.
# Keyed by whether the node booted without the desktop.
DEMO_DESKTOP = {True: "The desktop is not running now", False: "The desktop is running now"}
DEMO_MESSAGE = "Simulated: nothing was changed"


class DemoRecs:
    """Simulated nodes. Apply and undo flip the state in memory; nothing is changed anywhere."""

    def __init__(self, cluster: Cluster) -> None:
        self.cluster = cluster
        self.states: dict[str, dict[str, NodeRecState]] = {}

    def _state(
        self, node: str, rec_id: str, applied: bool, managed: bool, last: TuneResult | None
    ) -> NodeRecState:
        detail = DEMO_DETAIL[rec_id][applied].format(
            by="Sparkline" if managed else DEMO_UNIT,
            desktop=DEMO_DESKTOP["headless-boot" in DEMO_APPLIED.get(node, {})],
        )
        state: Literal["applied", "not-applied"] = "applied" if applied else "not-applied"
        return NodeRecState(id=rec_id, state=state, detail=detail, managed=managed, last=last)

    def _seed(self, node: str) -> dict[str, NodeRecState]:
        if not is_gb10(cast(DemoSource, self.cluster.sources[node]).model.info):
            return {
                r.id: NodeRecState(id=r.id, state="not-applicable", detail=NOT_GB10, managed=False)
                for r in CATALOG
            }
        applied = DEMO_APPLIED.get(node, {})
        earlier = TuneResult(action="apply", ts=time.time() - 86400, ok=True, message=DEMO_MESSAGE)
        items = {}
        for r in CATALOG:
            managed = applied.get(r.id, False)
            items[r.id] = self._state(node, r.id, r.id in applied, managed, earlier if managed else None)
        return items

    def _items(self, node: str) -> dict[str, NodeRecState]:
        if node not in self.states:
            self.states[node] = self._seed(node)
        return self.states[node]

    async def node(self, node: str) -> NodeRecommendations:
        return NodeRecommendations(
            one_click=no_helper(node) if node == DEMO_NO_HELPER else None,
            items=list(self._items(node).values()),
        )

    async def change(self, node: str, rec_id: str, verb: Verb) -> None:
        if node == DEMO_NO_HELPER:
            raise RecError(501, no_helper(node))
        items = self._items(node)
        was, rec = items[rec_id], BY_ID[rec_id]
        if verb == "apply":  # the two rules a node's agent holds a caller to
            refusal = cannot_apply(rec, node, was.state, was.detail)
        else:
            refusal = None if was.managed else cannot_undo(rec, node)
        if refusal is not None:
            raise RecError(409, refusal)
        done = TuneResult(action=verb, ts=time.time(), ok=True, message=DEMO_MESSAGE)
        items[rec_id] = self._state(node, rec_id, verb == "apply", verb == "apply", done)


def recommend_router(cluster: Cluster, backend: RecBackend, dependencies: list) -> APIRouter:
    r = APIRouter(prefix="/api/v1/recommendations", dependencies=dependencies)

    def unreachable(node: str) -> Problem | None:
        """Set while the console has no connection to the node: asking it would only wait for a timeout."""
        state = cluster.sources[node].state
        if state.status not in ("offline", "error"):
            return None
        return state.error or Problem(
            message=f"{node} is {state.status}",
            cause="The agent is not connected",
            fix="Wait for the console to reconnect, or press Retry",
        )

    async def one(node: str) -> NodeRecommendations | Problem:
        try:
            return unreachable(node) or await backend.node(node)
        except RecError as e:
            return e.problem

    @r.get("")
    async def view() -> RecommendationsView:
        """Every node is asked at once, so the answer takes as long as the slowest node."""
        nodes = list(cluster.sources)
        answers = dict(zip(nodes, await asyncio.gather(*map(one, nodes)), strict=True))
        return RecommendationsView(
            catalog=CATALOG,
            nodes={n: a if isinstance(a, NodeRecommendations) else None for n, a in answers.items()},
            problems={n: a for n, a in answers.items() if isinstance(a, Problem)},
        )

    async def change(rec_id: str, verb: Verb, body: RecAction) -> None:
        rec = BY_ID.get(rec_id)
        if rec is None:
            raise RecError(404, Problem(message=f"No recommendation {rec_id!r}", cause="", fix=""))
        if body.node not in cluster.sources:
            raise RecError(
                404,
                Problem(
                    message=f"Unknown node {body.node!r}",
                    cause="This node is not in the console configuration",
                    fix="Add it under [[nodes]] in /etc/sparkline/console.toml",
                ),
            )
        if not body.confirm:
            raise RecError(
                400,
                Problem(
                    message="Confirmation required",
                    cause="A setting changes only after the confirmation step (confirm must be true)",
                    fix="Review what it changes, then confirm",
                ),
            )
        if not rec.one_click:
            raise RecError(
                409,
                Problem(
                    message=f"{rec.title} is not a one-click setting",
                    cause="It takes steps that Sparkline does not run: a firmware change or a reboot",
                    fix=f"Type the commands shown for it on {body.node}",
                ),
            )
        if (problem := unreachable(body.node)) is not None:
            raise RecError(503, problem)
        await backend.change(body.node, rec.id, verb)

    async def answer(rec_id: str, verb: Verb, body: RecAction) -> dict | JSONResponse:
        try:
            await change(rec_id, verb, body)
        except RecError as e:
            return JSONResponse({"problem": e.problem.model_dump()}, status_code=e.status)
        return {"ok": True}

    @r.post("/{rec_id}/apply", status_code=202, response_model=None)
    async def apply(rec_id: str, body: RecAction) -> dict | JSONResponse:
        return await answer(rec_id, "apply", body)

    @r.post("/{rec_id}/undo", status_code=202, response_model=None)
    async def undo(rec_id: str, body: RecAction) -> dict | JSONResponse:
        return await answer(rec_id, "undo", body)

    return r
