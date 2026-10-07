"""SQLite persistence for the console: sessions, key/value settings + alert rules, events."""

from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from ..common.schema import Event

SESSION_TTL_S = 30 * 86400
EVENT_RETENTION_S = 30 * 86400

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, node_id TEXT, severity TEXT NOT NULL,
  kind TEXT NOT NULL, rule_id TEXT, title TEXT NOT NULL, detail TEXT NOT NULL, metric TEXT, value REAL,
  resolved_ts REAL, acked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
"""

_EVENT_COLS = (
    "id",
    "ts",
    "node_id",
    "severity",
    "kind",
    "rule_id",
    "title",
    "detail",
    "metric",
    "value",
    "resolved_ts",
    "acked",
)


def _hash(session_id: str) -> str:
    return hashlib.sha256(session_id.encode()).hexdigest()


class Store:
    def __init__(self, path: Path | str):
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")  # durable with WAL; FULL fsyncs every event on the loop
        self.db.executescript(_SCHEMA)

    def close(self) -> None:
        self.db.close()

    # -- sessions ---------------------------------------------------------------------------------
    def create_session(self) -> str:
        sid = secrets.token_urlsafe(32)
        now = time.time()
        self.db.execute("INSERT INTO sessions VALUES (?,?,?)", (_hash(sid), now, now + SESSION_TTL_S))
        return sid

    def session_valid(self, sid: str) -> bool:
        row = self.db.execute("SELECT expires FROM sessions WHERE id_hash=?", (_hash(sid),)).fetchone()
        return bool(row) and row[0] > time.time()

    def delete_session(self, sid: str) -> None:
        self.db.execute("DELETE FROM sessions WHERE id_hash=?", (_hash(sid),))

    def bind_sessions_to_token(self, token: str) -> bool:
        """Sessions belong to the token that issued them: when the configured token changes (a leaked token
        was replaced), every existing session is deleted. Returns True when sessions were cleared."""
        fp = hashlib.sha256(b"sparkline-session-token\0" + token.encode()).hexdigest()
        old = self.kv_get("session_token_fp")
        if old == fp:
            return False
        self.db.execute("DELETE FROM sessions")
        self.kv_set("session_token_fp", fp)
        return old is not None

    # -- kv -------------------------------------------------------------------------------------
    def kv_get(self, key: str) -> Any | None:
        row = self.db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def kv_set(self, key: str, value: Any) -> None:
        self.db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, json.dumps(value)))

    # -- events -----------------------------------------------------------------------------------
    def add_event(self, ev: Event) -> Event:
        d = ev.model_dump(exclude={"id"})
        cur = self.db.execute(
            f"INSERT INTO events ({','.join(_EVENT_COLS[1:])}) VALUES ({','.join('?' * 11)})",
            [d[c] for c in _EVENT_COLS[1:]],
        )
        return ev.model_copy(update={"id": cur.lastrowid})

    def get_event(self, event_id: int) -> Event | None:
        row = self.db.execute(
            f"SELECT {','.join(_EVENT_COLS)} FROM events WHERE id=?", (event_id,)
        ).fetchone()
        return Event(**dict(zip(_EVENT_COLS, row, strict=True))) if row else None

    def update_event(self, event_id: int, **fields: Any) -> Event | None:
        sets = ",".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE events SET {sets} WHERE id=?", [*fields.values(), event_id])
        return self.get_event(event_id)

    def list_events(
        self,
        since: float | None = None,
        limit: int = 200,
        node: str | None = None,
        severity: str | None = None,
    ) -> list[Event]:
        where: list[str] = []
        args: list[object] = []
        if since is not None:
            where.append("ts >= ?")
            args.append(since)
        if node:
            where.append("node_id = ?")
            args.append(node)
        if severity:
            where.append("severity = ?")
            args.append(severity)
        sql = f"SELECT {','.join(_EVENT_COLS)} FROM events"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY ts DESC, id DESC LIMIT ?"
        rows = self.db.execute(sql, [*args, limit]).fetchall()
        return [Event(**dict(zip(_EVENT_COLS, r, strict=True))) for r in rows]

    def prune(self) -> None:
        now = time.time()
        self.db.execute("DELETE FROM events WHERE ts < ?", (now - EVENT_RETENTION_S,))
        self.db.execute("DELETE FROM sessions WHERE expires < ?", (now,))

    def resolve_open_alerts(self, ts: float) -> None:
        """Alerts left open by a previous run cannot be tracked any more; close them."""
        self.db.execute("UPDATE events SET resolved_ts=? WHERE kind='alert' AND resolved_ts IS NULL", (ts,))
