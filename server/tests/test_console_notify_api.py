"""The notification routes and the alert path end to end: TestClient, a real Egress, a sink on loopback."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from netports import free_ports

from sparkline.common.schema import Event
from sparkline.console.app import create_app
from sparkline.console.config import ConsoleConfig
from sparkline.console.notify import NotifyConfig

TOKEN = "s3cret-browser-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
CANARY = "s3cr3t-canary"
CHANNELS = "/api/v1/notify/channels"


@pytest.fixture
def sink():
    """A loopback HTTP server that records every POST and answers 204."""
    seen: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["content-length"]))
            seen.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    server.seen = seen
    yield server
    server.shutdown()
    server.server_close()


def make(tmp_path, *channels: NotifyConfig):
    cfg = ConsoleConfig(
        token=TOKEN, agent_token="a", web_dist=tmp_path / "missing-dist", notify=list(channels)
    )
    return create_app(cfg, tmp_path / "data")


def hook(sink, name: str = "home", **kw) -> NotifyConfig:
    url = f"http://127.0.0.1:{sink.server_port}/api/webhook/{CANARY}"
    return NotifyConfig(name=name, kind="webhook", url=url, **kw)


def until(done, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not done():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def test_both_routes_need_a_sign_in_and_the_test_route_refuses_another_origin(tmp_path, sink):
    with TestClient(make(tmp_path, hook(sink))) as c:
        for method, path in [("GET", CHANNELS), ("POST", f"{CHANNELS}/home/test")]:
            r = c.request(method, path)
            assert r.status_code == 401 and r.json()["problem"]["message"] == "Sign in required", path
            assert c.request(method, path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        r = c.post(f"{CHANNELS}/home/test", headers={**AUTH, "Origin": "http://evil.example"})
        assert r.status_code == 403 and r.json()["problem"]["message"] == "Cross-site request blocked"
        assert sink.seen == []


def test_no_notify_table_lists_no_channel(tmp_path):
    with TestClient(make(tmp_path)) as c:
        assert c.get(CHANNELS, headers=AUTH).json() == []
        assert c.post(f"{CHANNELS}/home/test", headers=AUTH).status_code == 404


def test_channels_are_listed_in_config_order_without_their_url_or_token(tmp_path, sink):
    phone = NotifyConfig(
        name="phone", kind="ntfy", url=f"https://ntfy.example/{CANARY}", token=CANARY, min_severity="critical"
    )
    with TestClient(make(tmp_path, phone, hook(sink, send_resolved=False))) as c:
        r = c.get(CHANNELS, headers=AUTH)
        assert r.status_code == 200 and CANARY not in r.text
        assert r.json() == [
            {
                "name": "phone",
                "kind": "ntfy",
                "host": "ntfy.example",
                "min_severity": "critical",
                "send_resolved": True,
                "pending": 0,
                "retry_at": None,
                "last": None,
            },
            {
                "name": "home",
                "kind": "webhook",
                "host": f"127.0.0.1:{sink.server_port}",
                "min_severity": "warning",
                "send_resolved": False,
                "pending": 0,
                "retry_at": None,
                "last": None,
            },
        ]


def test_send_test_delivers_to_the_channel_and_returns_its_row(tmp_path, sink):
    with TestClient(make(tmp_path, hook(sink, token="tk_1"))) as c:
        r = c.post(f"{CHANNELS}/home/test", headers=AUTH)
        assert r.status_code == 200 and CANARY not in r.text
        row = r.json()
        assert (row["name"], row["last"]["ok"], row["last"]["test"], row["last"]["problem"]) == (
            "home",
            True,
            True,
            None,
        )
        (request,) = sink.seen
        assert request["path"] == f"/api/webhook/{CANARY}"
        assert request["headers"]["Host"] == f"127.0.0.1:{sink.server_port}"
        assert request["headers"]["Authorization"] == "Bearer tk_1"
        assert request["body"]["test"] is True and request["body"]["source"] == "sparkline"
        assert c.get(CHANNELS, headers=AUTH).json()[0]["last"] == row["last"]


def test_a_test_that_cannot_be_delivered_is_a_200_with_the_problem_in_the_row(tmp_path):
    (closed,) = free_ports(1)
    down = NotifyConfig(name="down", kind="webhook", url=f"http://127.0.0.1:{closed}/{CANARY}", token=CANARY)
    with TestClient(make(tmp_path, down)) as c:
        r = c.post(f"{CHANNELS}/down/test", headers=AUTH)
        assert r.status_code == 200 and CANARY not in r.text
        last = r.json()["last"]
        assert (last["ok"], last["test"], last["failure"], last["http_status"]) == (
            False,
            True,
            "connect",
            None,
        )
        assert last["problem"]["message"] == "Could not send to 'down'"
        assert (
            last["problem"]["cause"] == f"127.0.0.1:{closed} refused the connection or could not be reached."
        )


def test_an_unknown_channel_is_a_404_problem(tmp_path, sink):
    with TestClient(make(tmp_path, hook(sink))) as c:
        r = c.post(f"{CHANNELS}/nope/test", headers=AUTH)
        assert r.status_code == 404 and r.json()["problem"]["message"] == "No notification channel 'nope'"
        assert sink.seen == []


def test_an_alert_and_its_recovery_reach_the_channel(tmp_path, sink):
    app = make(tmp_path, hook(sink))
    fired = Event(
        id=0,
        ts=time.time(),
        node_id="spark1",
        severity="critical",
        kind="alert",
        rule_id="gpu_temp_critical",
        title="GPU temperature critical on spark1",
        detail="96 °C for 10 s (threshold 95 °C)",
        metric="gpu0.temp_c",
        value=96.0,
    )
    cleared = fired.model_copy(
        update={
            "severity": "info",
            "kind": "recovered",
            "title": f"Resolved: {fired.title}",
            "detail": "Now 71 °C",
        }
    )
    with TestClient(app) as c:
        c.portal.call(app.state.cluster.add_event, fired)
        until(lambda: len(sink.seen) == 1)
        c.portal.call(app.state.cluster.add_event, cleared)
        until(lambda: len(sink.seen) == 2)
        notices = [r["body"]["notices"][0] for r in sink.seen]
        assert [(n["status"], n["severity"], n["title"]) for n in notices] == [
            ("firing", "critical", "GPU temperature critical on spark1"),
            ("resolved", "critical", "Resolved: GPU temperature critical on spark1"),
        ]
        assert sink.seen[0]["body"]["text"] == "96 °C for 10 s (threshold 95 °C)"
        last = c.get(CHANNELS, headers=AUTH).json()[0]["last"]
        assert (last["ok"], last["test"], last["notices"]) == (True, False, 1)
