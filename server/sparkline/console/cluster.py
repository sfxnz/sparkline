"""Cluster: owns node sources, the stale/offline watchdog, alert engine, events and browser fan-out."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from importlib.metadata import version as pkg_version

from ..common.schema import AlertRule, ClusterState, ConsoleSettings, Event, NodeState, Problem, Sample
from .alerts import DEFAULT_RULES, AlertEngine
from .hub import Hub
from .nodes import NodeSource
from .store import Store

log = logging.getLogger("sparkline.console.cluster")
PING_S = 15.0
SESSION_CHECK_S = 60.0
VERSION = pkg_version("sparkline")


class Cluster:
    def __init__(self, store: Store, hub: Hub, default_settings: ConsoleSettings, demo: bool = False):
        self.store = store
        self.hub = hub
        self.demo = demo
        saved = store.kv_get("settings")
        self.settings = ConsoleSettings.model_validate(saved) if saved else default_settings
        saved_rules = store.kv_get("alert_rules")
        rules = (
            [AlertRule.model_validate(r) for r in saved_rules] if saved_rules is not None else DEFAULT_RULES
        )
        self.alerts = AlertEngine(rules, self.add_event, self.resolve_event)
        self.sources: dict[str, NodeSource] = {}
        self._tasks: list[asyncio.Task] = []

    def add_source(self, src: NodeSource) -> None:
        self.sources[src.node_id] = src

    # -- lifecycle ----------------------------------------------------------------------------------
    async def start(self) -> None:
        self.store.resolve_open_alerts(time.time())
        self.store.prune()
        self._tasks = [asyncio.create_task(s.run(), name=f"node:{s.node_id}") for s in self.sources.values()]
        self._tasks += [asyncio.create_task(self._watchdog()), asyncio.create_task(self._housekeeping())]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    # -- state --------------------------------------------------------------------------------------
    def cluster_state(self) -> ClusterState:
        return ClusterState(
            nodes=[s.state for s in self.sources.values()],
            settings=self.settings,
            demo=self.demo,
            version=VERSION,
            server_time=time.time(),
        )

    def update_settings(self, s: ConsoleSettings) -> None:
        self.store.kv_set("settings", s.model_dump())
        self.settings = s

    def update_rules(self, rules: list[AlertRule]) -> None:
        self.store.kv_set("alert_rules", [r.model_dump() for r in rules])
        self.alerts.set_rules(rules, time.time())

    # -- events -------------------------------------------------------------------------------------
    def add_event(self, ev: Event) -> Event:
        ev = self.store.add_event(ev)
        self.hub.broadcast({"type": "event", "event": ev.model_dump(mode="json")})
        return ev

    def resolve_event(self, ev: Event, ts: float) -> None:
        updated = self.store.update_event(ev.id, resolved_ts=ts)
        if updated:
            self.hub.broadcast({"type": "event", "event": updated.model_dump(mode="json")})

    def ack_event(self, event_id: int) -> Event | None:
        ev = self.store.update_event(event_id, acked=1)
        if ev:
            self.hub.broadcast({"type": "event", "event": ev.model_dump(mode="json")})
        return ev

    # -- Listener (called by node sources) ----------------------------------------------------------
    def on_hello(self, src: NodeSource) -> None:
        self.hub.broadcast({"type": "node_status", "node": src.state.model_dump(mode="json")})

    def on_sample(self, src: NodeSource, s: Sample) -> None:
        if self.hub.clients:
            self.hub.broadcast_text(
                f'{{"type":"sample","node_id":{json.dumps(src.node_id)},"sample":{s.model_dump_json()}}}',
                droppable=True,
            )
        try:
            self.alerts.evaluate_sample(src.node_id, s, src.state.info)
        except Exception:
            log.exception("alert evaluation failed for %s", src.node_id)

    def on_status(self, src: NodeSource, old: NodeState) -> None:
        new = src.state
        self.hub.broadcast({"type": "node_status", "node": new.model_dump(mode="json")})
        if new.status == old.status:
            return
        try:  # outages are recorded by the node_offline alert (one alert + one recovery), not separate events
            self.alerts.evaluate_status(src.node_id, new.status, new.error, time.time())
        except Exception:
            log.exception("status handling failed for %s", src.node_id)

    # -- background loops ---------------------------------------------------------------------------
    async def _watchdog(self) -> None:
        last_ping = last_session_check = time.time()
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            for src in list(self.sources.values()):
                try:
                    self._check(src, now)
                except Exception:
                    log.exception("watchdog failed for %s", src.node_id)
            if now - last_ping >= PING_S:
                last_ping = now
                self.hub.broadcast({"type": "ping", "ts": now}, droppable=True)
            if now - last_session_check >= SESSION_CHECK_S:  # expired sign-ins stop streaming
                last_session_check = now
                for c in list(self.hub.clients):
                    if c.session and not self.store.session_valid(c.session):
                        c.kick()

    def _check(self, src: NodeSource, now: float) -> None:
        st = src.state
        if src.connected_at is not None:
            # never flag a gap the agent's own interval explains (interval_ms may be up to 5000)
            floor = 2 * (st.info.sample_interval_ms if st.info else 1000) / 1000 + 1
            age = now - max(src.connected_at, st.last_sample_ts or 0.0)
            if age > max(self.settings.offline_after_s, floor):
                src.force_reconnect(
                    "offline",
                    Problem(
                        message=f"No data from {src.node_id}",
                        cause=f"Connected, but the agent sent no samples for {age:.0f} s",
                        fix=(
                            f"Check `journalctl -u sparkline-agent` on {src.node_id}; the console reconnects "
                            "automatically"
                        ),
                    ),
                )
            elif age > max(self.settings.stale_after_s, floor) and st.status == "online":
                src.set_status("stale", None, None)
        self.alerts.evaluate_status(src.node_id, src.state.status, src.state.error, now)

    async def _housekeeping(self) -> None:
        while True:
            await asyncio.sleep(3600)
            try:
                self.store.prune()
            except Exception:
                log.exception("prune failed")
