"""SQLite persistence for benchmark runs and baselines (tables in the console's console.sqlite)."""

from __future__ import annotations

import builtins
import json
import sqlite3
import time

from ..common.schema import BenchRun

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bench_runs (
  id TEXT PRIMARY KEY, bench_id TEXT NOT NULL, status TEXT NOT NULL, created_ts REAL NOT NULL,
  nodes TEXT NOT NULL, params_key TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bench_runs_created ON bench_runs(created_ts);
CREATE TABLE IF NOT EXISTS bench_baselines (
  bench_id TEXT NOT NULL, params_key TEXT NOT NULL, run_id TEXT NOT NULL, set_ts REAL NOT NULL,
  PRIMARY KEY (bench_id, params_key));
"""


class BenchStore:
    def __init__(self, db: sqlite3.Connection):
        self.db = db
        self.db.executescript(_SCHEMA)

    # -- runs -------------------------------------------------------------------------------------
    def save(self, run: BenchRun) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO bench_runs VALUES (?,?,?,?,?,?,?)",
            (
                run.id,
                run.bench_id,
                run.status,
                run.created_ts,
                json.dumps(run.nodes),
                run.params_key,
                run.model_dump_json(exclude={"baseline_for"}),
            ),
        )

    def _load(self, data: str) -> BenchRun:
        run = BenchRun.model_validate_json(data)
        run.baseline_for = self.baseline_id(run.bench_id, run.params_key) == run.id
        return run

    def get(self, run_id: str) -> BenchRun | None:
        row = self.db.execute("SELECT data FROM bench_runs WHERE id=?", (run_id,)).fetchone()
        return self._load(row[0]) if row else None

    def list(
        self,
        bench_id: str | None = None,
        node: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[BenchRun]:
        where, args = [], []
        if bench_id:
            where.append("bench_id = ?")
            args.append(bench_id)
        if status:
            where.append("status = ?")
            args.append(status)
        if node:
            where.append("EXISTS (SELECT 1 FROM json_each(bench_runs.nodes) WHERE value = ?)")
            args.append(node)
        sql = "SELECT data FROM bench_runs"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_ts DESC, id DESC LIMIT ?"
        return [self._load(r[0]) for r in self.db.execute(sql, [*args, limit]).fetchall()]

    def unfinished(self) -> builtins.list[BenchRun]:
        rows = self.db.execute(
            "SELECT data FROM bench_runs WHERE status IN ('queued','running') ORDER BY created_ts"
        ).fetchall()
        return [self._load(r[0]) for r in rows]

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM bench_runs").fetchone()[0]

    def delete(self, run_id: str) -> None:
        self.db.execute("DELETE FROM bench_runs WHERE id=?", (run_id,))
        self.db.execute("DELETE FROM bench_baselines WHERE run_id=?", (run_id,))

    def clear(self) -> None:
        self.db.execute("DELETE FROM bench_runs")
        self.db.execute("DELETE FROM bench_baselines")

    # -- baselines --------------------------------------------------------------------------------
    def baseline_id(self, bench_id: str, params_key: str) -> str | None:
        row = self.db.execute(
            "SELECT run_id FROM bench_baselines WHERE bench_id=? AND params_key=?", (bench_id, params_key)
        ).fetchone()
        return row[0] if row else None

    def set_baseline(self, bench_id: str, params_key: str, run_id: str, ts: float | None = None) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO bench_baselines VALUES (?,?,?,?)",
            (bench_id, params_key, run_id, time.time() if ts is None else ts),
        )
