"""Browser-facing benchmark API (/api/v1/bench/...): see PLAN.md wire table."""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Path, Query, Response
from pydantic import BaseModel, Field

from ..common.schema import BenchCreate, BenchRun, BenchSpec, Problem, RunStatus
from .bench import BenchError, BenchManager, runs_csv

RunId = Annotated[str, Path(pattern=r"^[0-9a-z]{1,40}$")]


class BaselineBody(BaseModel):
    run_id: str = Field(pattern=r"^[0-9a-z]{1,40}$")


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80]


def bench_router(mgr: BenchManager, dependencies: list) -> APIRouter:
    r = APIRouter(prefix="/api/v1/bench", dependencies=dependencies)

    @r.get("/catalog")
    async def catalog() -> list[BenchSpec]:
        return await mgr.catalog()

    @r.get("/runs")
    async def list_runs(
        bench_id: str | None = None,
        node: str | None = None,
        status: RunStatus | None = None,
        limit: Annotated[int, Query(ge=1, le=500)] = 50,
    ) -> list[BenchRun]:
        return mgr.list(bench_id, node, status, limit)

    @r.post("/runs", status_code=201)
    async def create(body: BenchCreate) -> BenchRun:
        return await mgr.create(body)

    @r.get("/runs/{run_id}")
    async def get_run(run_id: RunId) -> BenchRun:
        return mgr.get(run_id)

    @r.post("/runs/{run_id}/cancel", status_code=202)
    async def cancel(run_id: RunId) -> BenchRun:
        return await mgr.cancel(run_id)

    @r.delete("/runs/{run_id}")
    async def delete(run_id: RunId) -> dict:
        mgr.delete(run_id)
        return {"ok": True}

    @r.get("/runs/{run_id}/export")
    async def export(run_id: RunId, format: Literal["json", "csv"] = "json") -> Response:
        run = mgr.get(run_id)
        name = f"sparkline-{_safe(run.bench_id)}-{_safe(run.id)}.{format}"
        headers = {"Content-Disposition": f'attachment; filename="{name}"'}
        if format == "csv":
            return Response(runs_csv([run]), media_type="text/csv; charset=utf-8", headers=headers)
        return Response(run.model_dump_json(indent=2), media_type="application/json", headers=headers)

    @r.put("/baselines/{bench_id}")
    async def set_baseline(
        bench_id: Annotated[str, Path(pattern=r"^[a-z0-9-]{1,64}$")], body: BaselineBody
    ) -> BenchRun:
        return mgr.set_baseline(bench_id, body.run_id)

    @r.get("/compare")
    async def compare(ids: str) -> dict[str, Any]:
        id_list = [i for i in ids.split(",") if i]
        if not 1 <= len(id_list) <= 10 or len(set(id_list)) != len(id_list):
            raise BenchError(
                400,
                Problem(
                    message="Pick 1 to 10 different runs to compare",
                    cause=f"{len(id_list)} run ids given",
                    fix="Select the runs again",
                ),
            )
        return mgr.compare(id_list)

    return r
