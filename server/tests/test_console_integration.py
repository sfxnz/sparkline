"""End-to-end: fake agents (uvicorn threads) <-> real console (uvicorn thread) over real sockets.

Ports: 29751 fake agent (good token), 29752 console, 29753 fake agent (other token), 29759 nothing listening,
29790 fake agent with a skewed clock, 29791 fake agent that says hello but never samples, 29792 TCP listener
that never answers (hung agent).
"""

from __future__ import annotations

import asyncio
import json
import socket
import sys
import time
from pathlib import Path

import httpx
import psutil
import pytest
from websockets.sync.client import connect as ws_connect

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "console"))
from fakeagent import ServerThread, make_fake_agent  # noqa: E402

from sparkline.common.schema import ClusterState, HistoryResponse  # noqa: E402
from sparkline.console.app import create_app  # noqa: E402
from sparkline.console.config import ConsoleConfig  # noqa: E402
from sparkline.console.hub import SAMPLE_QUEUE  # noqa: E402

AGENT_PORT, CONSOLE_PORT, BAD_AGENT_PORT, DEAD_PORT = 29751, 29752, 29753, 29759
SKEW_PORT, SILENT_PORT, HUNG_PORT = 29790, 29791, 29792
BROWSER = {"Authorization": "Bearer browser-tok"}
BASE = f"http://127.0.0.1:{CONSOLE_PORT}"


def wait_for(pred, timeout: float, what: str):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = pred()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    agent_app = make_fake_agent("agent-tok")
    agent = ServerThread(agent_app, AGENT_PORT).start()
    bad = ServerThread(make_fake_agent("some-other-token"), BAD_AGENT_PORT).start()
    skew_app = make_fake_agent("agent-tok")
    skew_app.state.ts_offset = -40.0  # agent clock 40 s behind the console's
    skew = ServerThread(skew_app, SKEW_PORT).start()
    silent_app = make_fake_agent("agent-tok")
    silent_app.state.paused = True
    silent = ServerThread(silent_app, SILENT_PORT).start()
    hung = socket.create_server(("127.0.0.1", HUNG_PORT))  # kernel accepts; nobody ever answers
    cfg = ConsoleConfig.model_validate(
        {
            "token": "browser-tok",
            "agent_token": "agent-tok",
            "nodes": [
                {"id": "n1", "url": f"http://127.0.0.1:{AGENT_PORT}"},
                {"id": "bad", "url": f"http://127.0.0.1:{BAD_AGENT_PORT}"},
                {"id": "ghost", "url": f"http://127.0.0.1:{DEAD_PORT}"},
                {"id": "skew", "url": f"http://127.0.0.1:{SKEW_PORT}"},
                {"id": "silent", "url": f"http://127.0.0.1:{SILENT_PORT}"},
                {"id": "hung", "url": f"http://127.0.0.1:{HUNG_PORT}"},
            ],
            "settings": {"stale_after_s": 0.6, "offline_after_s": 2.5},
            "web_dist": str(tmp_path_factory.mktemp("nodist")),
        }
    )
    app = create_app(cfg, tmp_path_factory.mktemp("data"))
    console = ServerThread(app, CONSOLE_PORT).start()
    http = httpx.Client(base_url=BASE, headers=BROWSER, timeout=10)
    env = {
        "agent": agent,
        "agent_app": agent_app,
        "skew_app": skew_app,
        "silent_app": silent_app,
        "console": console,
        "app": app,
        "http": http,
    }
    yield env
    http.close()
    console.stop()
    env["agent"].stop()
    bad.stop()
    skew.stop()
    silent.stop()
    hung.close()


def node(env, node_id: str) -> dict:
    state = ClusterState.model_validate(env["http"].get("/api/v1/cluster").json())
    return next(n for n in state.nodes if n.node_id == node_id).model_dump()


def test_connect_errors_isolated_and_mapped(env):
    n1 = wait_for(lambda: (n := node(env, "n1"))["status"] == "online" and n, 10, "n1 online")
    assert n1["info"]["hostname"] == "spark1" and n1["error"] is None
    bad = wait_for(lambda: (n := node(env, "bad"))["status"] == "error" and n, 10, "bad -> error")
    assert "token" in bad["error"]["cause"]
    assert "agent_token in /etc/sparkline/console.toml must match" in bad["error"]["fix"]
    ghost = wait_for(lambda: (n := node(env, "ghost"))["status"] == "offline" and n, 10, "ghost offline")
    assert ghost["error"]["message"] == "Agent unreachable on ghost"
    assert ghost["error"]["cause"] == f"Connection refused at 127.0.0.1:{DEAD_PORT}"
    assert "systemctl status sparkline-agent" in ghost["error"]["fix"]
    assert ghost["next_retry_ts"] is not None
    # retry endpoint works and the good node is unaffected by the two failing ones
    r = env["http"].post("/api/v1/nodes/ghost/retry")
    assert r.status_code == 200 and r.json()["node_id"] == "ghost"
    assert node(env, "n1")["status"] == "online"


def test_live_and_history_proxy(env):
    wait_for(lambda: node(env, "n1")["status"] == "online", 10, "n1 online")
    time.sleep(0.5)
    live = HistoryResponse.model_validate(env["http"].get("/api/v1/live?node=n1&seconds=60").json())
    assert live.resolution_s == 1 and len(live.ts) >= 2 and "gpu0.temp_c" in live.series
    r = env["http"].get("/api/v1/history", params={"node": "n1", "keys": "gpu0.util,mem.used"})
    assert r.status_code == 200, r.text
    assert set(HistoryResponse.model_validate(r.json()).series) == {"gpu0.util", "mem.used"}
    r = env["http"].request("DELETE", "/api/v1/history?node=n1", json={"confirm": "DELETE"})
    assert r.status_code == 200 and env["agent_app"].state.deleted == 1
    r = env["http"].request("DELETE", "/api/v1/history?node=n1", json={"confirm": "yes"})
    assert r.status_code == 422 and "problem" in r.json()


def test_disconnect_stale_offline_reconnect(env):
    wait_for(lambda: node(env, "n1")["status"] == "online", 10, "n1 online")
    # agent stops sending -> stale
    env["agent_app"].state.paused = True
    wait_for(lambda: node(env, "n1")["status"] == "stale", 3, "n1 stale")
    # agent process goes away -> offline with a Problem
    env["agent"].stop()
    n1 = wait_for(lambda: (n := node(env, "n1"))["status"] == "offline" and n, 5, "n1 offline")
    assert n1["error"]["message"] in ("Lost connection to agent on n1", "Agent unreachable on n1")
    # history proxy refuses with the node's problem while it is offline
    r = env["http"].get("/api/v1/history", params={"node": "n1", "keys": "gpu0.util"})
    assert r.status_code == 503
    assert r.json()["problem"]["message"] == n1["error"]["message"]
    # agent comes back -> backoff reconnect -> online
    env["agent_app"].state.paused = False
    env["agent"] = ServerThread(env["agent_app"], AGENT_PORT).start()
    wait_for(lambda: node(env, "n1")["status"] == "online", 20, "n1 back online")
    assert node(env, "n1")["error"] is None

    # a restart-length outage (< node_offline for_s) leaves no critical alert and no duplicate node events
    events = env["http"].get("/api/v1/events", params={"node": "n1"}).json()
    assert [e for e in events if e["rule_id"] == "node_offline" or e["kind"] == "node"] == []


def test_watchdog_offline_when_connected_but_silent(env):
    wait_for(lambda: node(env, "n1")["status"] == "online", 10, "n1 online")
    env["agent_app"].state.paused = True
    n1 = wait_for(lambda: (n := node(env, "n1"))["status"] == "offline" and n, 6, "n1 offline by watchdog")
    assert n1["error"]["message"] == "No data from n1"
    env["agent_app"].state.paused = False
    wait_for(lambda: node(env, "n1")["status"] == "online", 15, "n1 online again")


def test_browser_stream_and_slow_client_is_bounded(env):
    hub = env["app"].state.hub
    with ws_connect(f"ws://127.0.0.1:{CONSOLE_PORT}/api/v1/stream", additional_headers=BROWSER) as ws:
        hello = json.loads(ws.recv(timeout=5))
        assert hello["type"] == "hello" and len(hello["cluster"]["nodes"]) == 6
        msg = json.loads(ws.recv(timeout=5))
        assert msg["type"] in ("sample", "node_status", "event", "ping")
        client = wait_for(lambda: next(iter(hub.clients), None), 5, "hub client")
        # now stop reading and flood: ~160 MB of samples would accumulate if the queue were unbounded
        big = json.dumps({"type": "sample", "node_id": "n1", "sample": {"pad": "x" * 8000}})
        rss0 = psutil.Process().memory_info().rss

        async def flood() -> None:
            for i in range(20000):
                hub.broadcast_text(big, droppable=True)
                if i % 1000 == 0:
                    hub.broadcast({"type": "event", "event": {"id": i}})
                    await asyncio.sleep(0)

        env["console"].call(flood())
        growth = psutil.Process().memory_info().rss - rss0
        assert len(client.samples) <= SAMPLE_QUEUE
        assert client.dropped > 15000
        assert growth < 60 * 1024 * 1024, f"RSS grew {growth / 1e6:.0f} MB"
        # events are never dropped: everything not yet sent is still queued
        assert len(client.priority) <= 20 and not client.overflowed


def test_ws_requires_auth_and_same_origin(env):
    with pytest.raises(Exception):  # noqa: B017 - handshake rejected
        ws_connect(f"ws://127.0.0.1:{CONSOLE_PORT}/api/v1/stream").recv(timeout=2)
    with pytest.raises(Exception):  # noqa: B017
        ws_connect(
            f"ws://127.0.0.1:{CONSOLE_PORT}/api/v1/stream",
            additional_headers={**BROWSER, "Origin": "http://evil.example"},
        ).recv(timeout=2)


def test_watchdog_uses_console_clock_not_agent_clock(env):
    """Agent ts 40 s behind: stays online (no offline/online storm). Ahead and stalled: stale quickly."""
    wait_for(lambda: node(env, "skew")["status"] == "online", 10, "skew online")
    deadline = time.time() + 4  # > offline_after_s (2.5 s)
    while time.time() < deadline:
        assert node(env, "skew")["status"] == "online"
        time.sleep(0.2)
    assert env["http"].get("/api/v1/events", params={"node": "skew"}).json() == []
    env["skew_app"].state.ts_offset = 60.0  # now ahead, and stalled: stale on the console's clock
    env["skew_app"].state.paused = True
    try:
        t = time.time()
        wait_for(lambda: node(env, "skew")["status"] == "stale", 4, "skew stale")
        assert time.time() - t < 3
    finally:
        env["skew_app"].state.paused = False


def test_hello_but_no_samples_goes_offline_and_keeps_retrying(env):
    st = wait_for(lambda: (n := node(env, "silent"))["status"] == "offline" and n, 8, "silent offline")
    assert st["error"]["message"] == "No data from silent"
    assert "sent no samples" in st["error"]["cause"]
    # and keeps reconnecting (with backoff) instead of sitting in offline forever after the first retry
    wait_for(lambda: env["silent_app"].state.connections >= 3, 20, "silent reconnected twice")


def test_hung_agent_is_not_reported_as_network_problem(env):
    st = wait_for(lambda: (n := node(env, "hung"))["status"] == "offline" and n, 15, "hung offline")
    assert st["error"]["message"] == "Agent on hung is not answering"
    assert "accepted the connection but did not answer" in st["error"]["cause"]
