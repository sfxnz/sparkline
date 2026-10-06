"""Auth, origin checks, static serving, settings/rules/events endpoints (TestClient, no nodes)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from sparkline.common.schema import Event
from sparkline.console.app import create_app
from sparkline.console.config import ConsoleConfig

TOKEN = "s3cret-browser-token"
SAME = {"Origin": "http://testserver"}


def make(tmp_path, demo=False, token=TOKEN, dist=None):
    cfg = ConsoleConfig(token=token, agent_token="a", web_dist=dist or tmp_path / "missing-dist")
    return create_app(cfg, tmp_path / "data", demo=demo)


@pytest.fixture
def client(tmp_path):
    with TestClient(make(tmp_path)) as c:
        yield c


def bearer(token=TOKEN):
    return {"Authorization": f"Bearer {token}"}


def test_everything_but_healthz_and_login_needs_auth(client):
    assert client.get("/healthz").status_code == 200
    for method, path in [
        ("GET", "/api/v1/cluster"),
        ("GET", "/api/v1/auth/me"),
        ("GET", "/api/v1/events"),
        ("GET", "/api/v1/settings"),
        ("GET", "/api/v1/alerts/rules"),
        ("GET", "/api/v1/live?node=x"),
        ("POST", "/api/v1/nodes/x/retry"),
    ]:
        r = client.request(method, path)
        assert r.status_code == 401, path
        assert r.json()["problem"]["message"] == "Sign in required"


def test_bearer(client):
    assert client.get("/api/v1/cluster", headers=bearer()).status_code == 200
    assert client.get("/api/v1/cluster", headers=bearer("wrong")).status_code == 401


def test_login_cookie_logout_and_sessions_survive_restart(tmp_path):
    with TestClient(make(tmp_path)) as c:
        r = c.post("/api/v1/auth/login", json={"token": "nope"})
        assert r.status_code == 401 and r.json()["problem"]["message"] == "Wrong token"
        r = c.post("/api/v1/auth/login", json={"token": TOKEN})
        assert r.status_code == 200
        cookie = r.headers["set-cookie"]
        assert "sparkline_session=" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
        assert "Path=/" in cookie and "Secure" not in cookie  # plain http
        assert c.get("/api/v1/auth/me").json() == {
            "authenticated": True,
            "auth_required": True,
            "demo": False,
        }
        sid = c.cookies["sparkline_session"]
    with TestClient(make(tmp_path)) as c2:  # restart: session persisted in SQLite
        c2.cookies.set("sparkline_session", sid)
        assert c2.get("/api/v1/auth/me").status_code == 200
        assert c2.post("/api/v1/auth/logout").status_code == 200
        c2.cookies.set("sparkline_session", sid)
        assert c2.get("/api/v1/auth/me").status_code == 401


def test_secure_cookie_on_https(tmp_path):
    with TestClient(make(tmp_path), base_url="https://testserver") as c:
        r = c.post("/api/v1/auth/login", json={"token": TOKEN})
        assert "Secure" in r.headers["set-cookie"]


def test_login_rate_limit(client):
    codes = [client.post("/api/v1/auth/login", json={"token": "x"}).status_code for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429
    assert client.post("/api/v1/auth/login", json={"token": TOKEN}).status_code == 429


def test_wrong_bearer_tokens_share_the_login_limit(client):
    codes = [client.get("/api/v1/cluster", headers=bearer("guess")).status_code for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429
    assert client.get("/api/v1/cluster", headers=bearer()).status_code == 429  # even the right one, for now
    # the stream refuses too (without checking the token) while the limit holds
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/api/v1/stream", headers=bearer()) as ws,
    ):
        ws.receive_text()


def test_logout_closes_that_sessions_live_stream(client):
    assert client.post("/api/v1/auth/login", json={"token": TOKEN}).status_code == 200
    with client.websocket_connect("/api/v1/stream") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        assert client.post("/api/v1/auth/logout").status_code == 200
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_text()
        assert e.value.code == 1008


def test_cross_site_origin_rejected_for_state_changes(client):
    r = client.post("/api/v1/auth/login", json={"token": TOKEN}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    r = client.put("/api/v1/settings", json={}, headers={**bearer(), "Origin": "http://evil.example"})
    assert r.status_code == 403 and r.json()["problem"]["message"] == "Cross-site request blocked"
    assert client.put("/api/v1/settings", json={}, headers={**bearer(), **SAME}).status_code == 200
    # safe methods are not origin-checked
    assert (
        client.get("/api/v1/settings", headers={**bearer(), "Origin": "http://evil.example"}).status_code
        == 200
    )


def test_demo_without_token_disables_auth(tmp_path):
    with TestClient(make(tmp_path, demo=True, token="")) as c:
        state = c.get("/api/v1/cluster").json()
        assert state["demo"] is True and [n["node_id"] for n in state["nodes"]] == [
            "spark1",
            "spark2",
            "spark3",
        ]
        assert c.get("/api/v1/auth/me").json()["auth_required"] is False


def test_settings_validation_and_persistence(tmp_path):
    with TestClient(make(tmp_path)) as c:
        s = c.get("/api/v1/settings", headers=bearer()).json()
        assert s["stale_after_s"] == 5.0
        bad = c.put("/api/v1/settings", json={**s, "offline_after_s": 1}, headers=bearer())
        assert bad.status_code == 422 and "stale_after_s" in bad.json()["problem"]["cause"]
        assert (
            c.put("/api/v1/settings", json={**s, "energy_rate_per_kwh": "x"}, headers=bearer()).status_code
            == 422
        )
        assert (
            c.put("/api/v1/settings", json={**s, "energy_rate_per_kwh": 0.31}, headers=bearer()).status_code
            == 200
        )
    with TestClient(make(tmp_path)) as c:
        assert c.get("/api/v1/settings", headers=bearer()).json()["energy_rate_per_kwh"] == 0.31


def test_rules_put_validates_and_persists(tmp_path):
    with TestClient(make(tmp_path)) as c:
        rules = c.get("/api/v1/alerts/rules", headers=bearer()).json()
        assert {r["id"] for r in rules} >= {"gpu_temp_high", "node_offline", "gpu_power_cap"}
        r = c.put("/api/v1/alerts/rules", json=rules + [rules[0]], headers=bearer())
        assert r.status_code == 422 and "Duplicate" in r.json()["problem"]["cause"]
        r = c.put(
            "/api/v1/alerts/rules", json=[{"id": "x", "name": "X", "kind": "threshold"}], headers=bearer()
        )
        assert r.status_code == 422
        rules[0]["threshold"] = 77
        assert c.put("/api/v1/alerts/rules", json=rules, headers=bearer()).status_code == 200
    with TestClient(make(tmp_path)) as c:
        assert c.get("/api/v1/alerts/rules", headers=bearer()).json()[0]["threshold"] == 77


def test_events_filter_and_ack(client):
    cluster = client.app.state.cluster
    for i, (node, sev) in enumerate([("spark1", "warning"), ("spark2", "critical"), ("spark1", "info")]):
        cluster.add_event(
            Event(id=0, ts=1000.0 + i, node_id=node, severity=sev, kind="alert", title="t", detail="d")
        )
    ev = client.get("/api/v1/events", headers=bearer()).json()
    assert [e["ts"] for e in ev] == [1002.0, 1001.0, 1000.0]
    assert len(client.get("/api/v1/events?node=spark1", headers=bearer()).json()) == 2
    assert len(client.get("/api/v1/events?severity=critical", headers=bearer()).json()) == 1
    assert len(client.get("/api/v1/events?since=1001&limit=1", headers=bearer()).json()) == 1
    assert client.get("/api/v1/events?severity=bogus", headers=bearer()).status_code == 422
    r = client.post(f"/api/v1/events/{ev[0]['id']}/ack", headers=bearer())
    assert r.status_code == 200 and r.json()["acked"] is True
    assert client.post("/api/v1/events/9999/ack", headers=bearer()).status_code == 404


def test_unknown_node_is_a_problem(client):
    r = client.get("/api/v1/history?node=nope", headers=bearer())
    assert r.status_code == 404 and "console.toml" in r.json()["problem"]["fix"]


# -- static ---------------------------------------------------------------------------------------------


@pytest.fixture
def dist(tmp_path):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<html>app</html>")
    (d / "assets" / "index-abc123.js").write_text("console.log(1)")
    (d / "favicon.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("TOP SECRET")
    return d


def test_static_spa_fallback_and_cache_headers(tmp_path, dist):
    with TestClient(make(tmp_path, dist=dist)) as c:
        r = c.get("/")
        assert r.text == "<html>app</html>" and r.headers["cache-control"] == "no-cache"
        r = c.get("/node/spark1")  # client-side route
        assert r.text == "<html>app</html>" and r.headers["cache-control"] == "no-cache"
        r = c.get("/assets/index-abc123.js")
        assert r.text == "console.log(1)" and "immutable" in r.headers["cache-control"]
        assert c.get("/favicon.svg").headers["cache-control"] == "no-cache"
        assert c.get("/assets/gone-123.js").status_code == 404
        r = c.get("/api/v1/unknown")
        assert r.status_code == 404 and "problem" in r.json()


def test_static_assets_are_gzipped_for_clients_that_accept_it(tmp_path, dist):
    import gzip

    (dist / "assets" / "big-1.js").write_text("const x = 1;\n" * 2000)
    with TestClient(make(tmp_path, dist=dist)) as c:
        raw = c.get("/assets/big-1.js", headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in raw.headers and raw.text.startswith("const x")
        r = c.get("/assets/big-1.js", headers={"Accept-Encoding": "gzip, br"})
        assert r.headers["content-encoding"] == "gzip" and r.headers["vary"] == "Accept-Encoding"
        assert r.text == raw.text  # the client decodes it
        assert int(r.headers["content-length"]) < len(gzip.compress(raw.content)) + 64 < len(raw.content)
        assert "immutable" in r.headers["cache-control"]
        assert r.headers["content-type"].startswith(("application/javascript", "text/javascript"))


def test_static_traversal_blocked(tmp_path, dist):
    with TestClient(make(tmp_path, dist=dist)) as c:
        for path in [
            "/../secret.txt",
            "/..%2fsecret.txt",
            "/%2e%2e/secret.txt",
            "/assets/..%2f..%2fsecret.txt",
            "/%2e%2e%2f%2e%2e%2fetc/passwd",
        ]:
            r = c.get(path)
            assert "TOP SECRET" not in r.text and "root:" not in r.text, path


def test_frontend_not_built_page(client):
    r = client.get("/")
    assert (
        r.status_code == 200
        and "Frontend not built" in r.text
        and "npm ci &amp;&amp; npm run build" in r.text
    )


def test_settings_change_is_broadcast_to_open_streams(client):
    with client.websocket_connect("/api/v1/stream", headers={**bearer(), **SAME}) as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        s = client.get("/api/v1/settings", headers=bearer()).json()
        assert (
            client.put(
                "/api/v1/settings", json={**s, "energy_rate_per_kwh": 0.42}, headers=bearer()
            ).status_code
            == 200
        )
        msg = json.loads(ws.receive_text())
        while msg["type"] == "ping":
            msg = json.loads(ws.receive_text())
        assert msg == {"type": "settings", "settings": {**s, "energy_rate_per_kwh": 0.42}}


def test_new_stream_gets_latest_sample_with_last_process_list(tmp_path):
    from types import SimpleNamespace

    from sparkline.console.demo import DemoModel

    m = DemoModel("spark1", 1_791_000_000.0)
    with_procs = m.sample_at(1_791_000_000.0, 1, procs=True)
    without = m.sample_at(1_791_000_001.0, 2, procs=False)
    with TestClient(make(tmp_path)) as c:
        cluster = c.app.state.cluster
        cluster.sources = {
            "spark1": SimpleNamespace(ring=[with_procs, without]),
            "spark2": SimpleNamespace(ring=[]),
        }
        (latest,) = cluster.latest_samples()
        assert latest.ts == without.ts and latest.procs == with_procs.procs


def test_data_dir_lock_refuses_a_second_console(tmp_path):
    import os

    from sparkline.console.main import lock_data_dir

    fd = lock_data_dir(tmp_path / "data")
    try:
        with pytest.raises(OSError, match="already in use"):
            lock_data_dir(tmp_path / "data")
    finally:
        os.close(fd)
    os.close(lock_data_dir(tmp_path / "data"))  # free again once the first one exits
