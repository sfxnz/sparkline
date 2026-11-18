"""The notification routes and the alert path end to end: TestClient, a real Egress, a sink on loopback."""

from __future__ import annotations

import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from netports import free_ports

from sparkline.common.schema import Event
from sparkline.console.app import create_app
from sparkline.console.config import ConsoleConfig, NodeConfig
from sparkline.console.demo import DemoModel
from sparkline.console.nodes import NodeSource, classify
from sparkline.console.notify import NotifyConfig
from sparkline.console.store import Store

TOKEN = "s3cret-browser-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
CANARY = "s3cr3t-canary"
CHANNELS = "/api/v1/notify/channels"
RULES = "/api/v1/alerts/rules"


@pytest.fixture
def sink():
    seen: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["content-length"]))
            seen.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
            self.send_response(server.status)
            self.send_header("Location", f"https://elsewhere.example/api/webhook/{CANARY}/")
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.status = 204
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


def hook(sink, name: str = "relay", **kw) -> NotifyConfig:
    url = f"http://127.0.0.1:{sink.server_port}/api/webhook/{CANARY}"
    return NotifyConfig(name=name, kind="webhook", url=url, **kw)


def until(done, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not done():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def test_both_routes_need_a_sign_in_and_the_test_route_refuses_another_origin(tmp_path, sink):
    with TestClient(make(tmp_path, hook(sink))) as c:
        for method, path in [("GET", CHANNELS), ("POST", f"{CHANNELS}/relay/test")]:
            r = c.request(method, path)
            assert r.status_code == 401 and r.json()["problem"]["message"] == "Sign in required", path
            assert c.request(method, path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        r = c.post(f"{CHANNELS}/relay/test", headers={**AUTH, "Origin": "http://evil.example"})
        assert r.status_code == 403 and r.json()["problem"]["message"] == "Cross-site request blocked"
        assert sink.seen == []


def test_no_notify_table_lists_no_channel(tmp_path):
    with TestClient(make(tmp_path)) as c:
        assert c.get(CHANNELS, headers=AUTH).json() == []
        assert c.post(f"{CHANNELS}/relay/test", headers=AUTH).status_code == 404


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
                "name": "relay",
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
        r = c.post(f"{CHANNELS}/relay/test", headers=AUTH)
        assert r.status_code == 200 and CANARY not in r.text
        row = r.json()
        assert (row["name"], row["last"]["ok"], row["last"]["test"], row["last"]["problem"]) == (
            "relay",
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


def test_a_redirect_that_repeats_the_url_is_not_followed_and_not_logged_even_at_debug(tmp_path, sink, caplog):
    caplog.set_level(logging.DEBUG)
    sink.status = 302
    with TestClient(make(tmp_path, hook(sink, token=CANARY))) as c:
        r = c.post(f"{CHANNELS}/relay/test", headers=AUTH)
        assert r.status_code == 200 and CANARY not in r.text
        last = r.json()["last"]
        assert (last["ok"], last["failure"]) == (False, "redirect")
        assert "never follows" in last["problem"]["cause"]
    assert len(sink.seen) == 1
    assert "connect_tcp.started host='127.0.0.1'" in caplog.text
    assert "notify 'relay': test not sent: redirect" in caplog.text
    assert CANARY not in caplog.text


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


def test_disabling_a_rule_whose_alert_is_firing_tells_the_channel_the_alert_ended(tmp_path, sink):
    app = make(tmp_path, hook(sink))
    with TestClient(app) as c:
        alerts, now = app.state.cluster.alerts, time.time()
        c.portal.call(alerts.evaluate_status, "spark1", "offline", None, now - 20)
        c.portal.call(alerts.evaluate_status, "spark1", "offline", None, now)
        until(lambda: len(sink.seen) == 1)
        rules = c.get(RULES, headers=AUTH).json()
        disabled = [{**r, "enabled": r["enabled"] and r["id"] != "node_offline"} for r in rules]
        assert c.put(RULES, json=disabled, headers=AUTH).status_code == 200
        until(lambda: len(sink.seen) == 2)
        notices = [r["body"]["notices"][0] for r in sink.seen]
        assert [(n["status"], n["severity"], n["title"]) for n in notices] == [
            ("firing", "critical", "Node offline on spark1"),
            ("resolved", "critical", "Resolved: Node offline on spark1"),
        ]
        assert sink.seen[1]["body"]["text"] == "Closed because its rule was changed · was critical"


def test_a_node_that_never_answered_raises_no_offline_alert_and_the_same_node_does_once_it_has(
    tmp_path, sink
):
    app = make(tmp_path, hook(sink))
    with TestClient(app) as c:
        rules = c.get(RULES, headers=AUTH).json()
        at_once = [{**r, "for_s": 0} if r["id"] == "node_offline" else r for r in rules]
        assert c.put(RULES, json=at_once, headers=AUTH).status_code == 200
        cluster = app.state.cluster
        src = NodeSource("spark1", "http://127.0.0.1:1", cluster)  # driven by hand: its loop never runs
        c.portal.call(cluster.add_source, src)
        refused = classify(ConnectionRefusedError(), "spark1", src.url)

        def node() -> dict:
            return c.get("/api/v1/cluster", headers=AUTH).json()["nodes"][0]

        c.portal.call(src.set_status, *refused, None)
        time.sleep(1.5)  # more than one pass of the watchdog, which evaluates every node each second
        assert (node()["status"], node()["first_seen"]) == ("offline", None)
        assert c.get("/api/v1/events", headers=AUTH).json() == [] and sink.seen == []

        before = time.time()
        c.portal.call(src.got_sample, DemoModel("spark1", before).sample_at(before))
        assert node()["status"] == "online" and before <= node()["first_seen"] <= time.time()
        c.portal.call(src.set_status, *refused, None)
        until(lambda: len(sink.seen) == 1)
        [notice] = sink.seen[0]["body"]["notices"]
        assert (notice["status"], notice["title"]) == ("firing", "Node offline on spark1")
        [event] = c.get("/api/v1/events", headers=AUTH).json()
        assert (event["kind"], event["rule_id"], event["node_id"]) == ("alert", "node_offline", "spark1")


# -- a restart with an alert open ---------------------------------------------------------------------

(NO_AGENT,) = free_ports(1)
HOT = {
    "id": "gpu_hot",
    "name": "GPU hot",
    "metric": "gpu0.temp_c",
    "threshold": 85,
    "for_s": 0,
    "severity": "critical",
}
FIRING = ("firing", "critical", "GPU hot on spark1")
RESOLVED = ("resolved", "critical", "Resolved: GPU hot on spark1")


def console(tmp_path, sink, nodes: tuple[str, ...] = ("spark1",)) -> TestClient:
    """A console on one data directory, so entering it again is a restart."""
    cfg = ConsoleConfig(
        token=TOKEN,
        agent_token="a",
        web_dist=tmp_path / "missing-dist",
        notify=[hook(sink)],
        nodes=[NodeConfig(id=n, url=f"http://127.0.0.1:{NO_AGENT}") for n in nodes],
    )
    return TestClient(create_app(cfg, tmp_path / "data"))


def spark1_reads(c: TestClient, temp: float) -> None:
    now = time.time()
    s = DemoModel("spark1", now).sample_at(now)
    s.gpu[0].temp_c = temp
    c.portal.call(c.app.state.cluster.alerts.evaluate_sample, "spark1", s)


def stopped_with_the_alert_open(tmp_path, sink) -> None:
    with console(tmp_path, sink) as c:
        assert c.put(RULES, json=[HOT], headers=AUTH).status_code == 200
        spark1_reads(c, 90)
        until(lambda: len(sink.seen) == 1)


def heard(sink) -> list[tuple[str, str, str]]:
    return [(n["status"], n["severity"], n["title"]) for r in sink.seen for n in r["body"]["notices"]]


def heard_after_everything_waiting_was_sent(c: TestClient, sink) -> list[tuple[str, str, str]]:
    # A test goes out after the notices that wait, so its answer means the channel has nothing left to say.
    assert c.post(f"{CHANNELS}/relay/test", headers=AUTH).json()["last"]["ok"]
    return heard(sink)


def timeline(c: TestClient) -> list[tuple[str, str, bool]]:
    events = reversed(c.get("/api/v1/events", headers=AUTH).json())
    return [(e["kind"], e["title"], e["resolved_ts"] is None) for e in events]


def test_an_alert_that_ended_while_the_console_was_down_is_resolved_on_the_channel_once(tmp_path, sink):
    stopped_with_the_alert_open(tmp_path, sink)
    with console(tmp_path, sink) as c:
        spark1_reads(c, 60)
        until(lambda: len(sink.seen) == 2)
        assert heard(sink) == [FIRING, RESOLVED]
        assert sink.seen[1]["body"]["text"].startswith("Now 60 °C · cleared after ")
        assert timeline(c) == [
            ("alert", "GPU hot on spark1", False),
            ("recovered", "Resolved: GPU hot on spark1", True),
        ]
    with console(tmp_path, sink) as c:
        spark1_reads(c, 60)
        assert heard_after_everything_waiting_was_sent(c, sink) == [FIRING, RESOLVED]


def test_an_alert_left_open_is_not_resolved_before_its_node_reports_a_clear_reading(tmp_path, sink):
    stopped_with_the_alert_open(tmp_path, sink)
    for _restart in range(2):
        with console(tmp_path, sink) as c:
            assert heard_after_everything_waiting_was_sent(c, sink) == [FIRING]
            assert timeline(c) == [("alert", "GPU hot on spark1", True)]
    with console(tmp_path, sink) as c:
        spark1_reads(c, 84)  # under the threshold, inside the margin a recovery must pass
        assert heard_after_everything_waiting_was_sent(c, sink) == [FIRING]
        assert timeline(c) == [("alert", "GPU hot on spark1", True)]


def test_an_alert_that_still_holds_after_a_restart_fires_again_and_is_resolved_once(tmp_path, sink):
    stopped_with_the_alert_open(tmp_path, sink)
    with console(tmp_path, sink) as c:
        spark1_reads(c, 90)
        until(lambda: len(sink.seen) == 2)
        assert timeline(c) == [("alert", "GPU hot on spark1", False), ("alert", "GPU hot on spark1", True)]
        spark1_reads(c, 60)
        assert heard_after_everything_waiting_was_sent(c, sink) == [FIRING, FIRING, RESOLVED]


def rule_deleted(tmp_path) -> tuple[str, ...]:
    store = Store(tmp_path / "data" / "console.sqlite")
    store.kv_set_atomically({"alert_rules": [], "alert_rule_metrics": {}})
    store.close()
    return ("spark1",)


def node_removed(tmp_path) -> tuple[str, ...]:
    return ()


@pytest.mark.parametrize(
    ("change", "why"),
    [(rule_deleted, "its rule was removed"), (node_removed, "spark1 is no longer monitored")],
)
def test_an_alert_that_nothing_evaluates_after_the_restart_is_resolved_with_the_reason(
    tmp_path, sink, change, why
):
    stopped_with_the_alert_open(tmp_path, sink)
    with console(tmp_path, sink, nodes=change(tmp_path)) as c:
        until(lambda: len(sink.seen) == 2)
        assert heard(sink) == [FIRING, RESOLVED]
        assert sink.seen[1]["body"]["text"] == f"Closed because {why} · was critical"
        assert timeline(c)[0] == ("alert", "GPU hot on spark1", False)
