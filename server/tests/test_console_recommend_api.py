"""The console's recommendations API end to end: fake agents (uvicorn threads) <-> real console over real
sockets, and the demo's simulated nodes.

Nodes: n1 answers, old is an agent that predates recommendations, ghost has nothing listening.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "console"))
from fakeagent import ServerThread, make_fake_agent, recs_defaults  # noqa: E402
from netports import free_ports  # noqa: E402

from sparkline.common.recommendations import CATALOG  # noqa: E402
from sparkline.common.schema import RecommendationsView  # noqa: E402
from sparkline.console.app import create_app  # noqa: E402
from sparkline.console.config import ConsoleConfig  # noqa: E402

N1, OLD, GHOST, CONSOLE = free_ports(4)
BROWSER = {"Authorization": "Bearer browser-tok"}
ONE_CLICK = "cpu-pcore-cap"


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
    apps = {"n1": make_fake_agent("agent-tok"), "old": make_fake_agent("agent-tok")}
    threads = [ServerThread(apps["n1"], N1).start(), ServerThread(apps["old"], OLD).start()]
    tmp = tmp_path_factory.mktemp("recs")
    cfg = ConsoleConfig.model_validate(
        {
            "token": "browser-tok",
            "agent_token": "agent-tok",
            "nodes": [
                {"id": n, "url": f"http://127.0.0.1:{p}"}
                for n, p in (("n1", N1), ("old", OLD), ("ghost", GHOST))
            ],
            "web_dist": str(tmp / "nodist"),
        }
    )
    console = ServerThread(create_app(cfg, tmp / "data"), CONSOLE).start()
    http = httpx.Client(base_url=f"http://127.0.0.1:{CONSOLE}", headers=BROWSER, timeout=15)

    def settled() -> bool:
        status = {n["node_id"]: n["status"] for n in http.get("/api/v1/cluster").json()["nodes"]}
        return status == {"n1": "online", "old": "online", "ghost": "offline"}

    wait_for(settled, 10, "n1 and old online, ghost offline")
    yield {"apps": apps, "http": http}
    http.close()
    console.stop()
    for t in threads:
        t.stop()


@pytest.fixture(autouse=True)
def reset_agents(env):
    for name, a in env["apps"].items():
        a.state.recs = recs_defaults()
        a.state.rec_requests.clear()
        if name == "old":
            a.state.recs["reply"] = None
    yield


def act(env, verb: str = "apply", rec_id: str = ONE_CLICK, node: str = "n1", **body) -> httpx.Response:
    return env["http"].post(f"/api/v1/recommendations/{rec_id}/{verb}", json={"node": node, **body})


def requests(env) -> list[str]:
    return [r for a in env["apps"].values() for r in a.state.rec_requests]


def test_the_view_holds_the_catalog_and_each_nodes_answer_or_why_it_has_none(env):
    r = env["http"].get("/api/v1/recommendations")
    assert r.status_code == 200, r.text
    view = RecommendationsView.model_validate(r.json())
    assert view.catalog == CATALOG
    assert [c["verified"] for c in r.json()["catalog"]] == [False] * len(CATALOG)
    assert list(view.nodes) == ["n1", "old", "ghost"]
    n1 = view.nodes["n1"]
    assert n1 is not None and n1.one_click is None
    assert [(i.id, i.state, i.managed) for i in n1.items] == [
        ("gpu-clock-cap", "applied", False),
        ("cpu-pcore-cap", "not-applied", False),
    ]
    assert view.nodes["old"] is None and view.nodes["ghost"] is None
    assert set(view.problems) == {"old", "ghost"}
    assert view.problems["old"].message == "The agent on old is too old for recommendations"
    assert "sudo sparkline update" in view.problems["old"].fix
    assert view.problems["ghost"].message == "Agent unreachable on ghost"


def test_a_reply_the_console_cannot_read_is_a_problem_for_that_node_only(env):
    env["apps"]["n1"].state.recs["reply"] = {"one_click": None, "items": [{"id": "gpu-clock-cap"}]}
    view = env["http"].get("/api/v1/recommendations").json()
    assert view["nodes"]["n1"] is None
    assert view["problems"]["n1"]["message"] == "Agent on n1 sent an invalid recommendations reply"
    assert len(view["catalog"]) == len(CATALOG)


def test_the_nodes_are_asked_at_once(env):
    for a in env["apps"].values():
        a.state.recs["delay"] = 0.6
    started = time.monotonic()
    assert env["http"].get("/api/v1/recommendations").status_code == 200
    assert time.monotonic() - started < 1.1  # two nodes answering one after the other would take 1.2 s


def test_every_route_needs_a_signed_in_browser_and_changes_need_its_own_origin(env):
    body = {"node": "n1", "confirm": True}
    with httpx.Client(base_url=f"http://127.0.0.1:{CONSOLE}") as anonymous:
        assert anonymous.get("/api/v1/recommendations").status_code == 401
        for verb in ("apply", "undo"):
            assert anonymous.post(f"/api/v1/recommendations/{ONE_CLICK}/{verb}", json=body).status_code == 401
    evil = {"Origin": "http://evil.example"}
    r = env["http"].post(f"/api/v1/recommendations/{ONE_CLICK}/apply", json=body, headers=evil)
    assert r.status_code == 403 and r.json()["problem"]["message"] == "Cross-site request blocked"
    assert requests(env) == []


@pytest.mark.parametrize("verb", ["apply", "undo"])
def test_a_confirmed_change_reaches_the_nodes_agent(env, verb):
    r = act(env, verb, confirm=True)
    assert (r.status_code, r.json()) == (202, {"ok": True}), r.text
    assert requests(env) == [f"{ONE_CLICK}.{verb}"]


@pytest.mark.parametrize("confirm", [False, None, "no", "yes", "true", 1, 1.0, [True], {"confirm": True}])
def test_only_json_true_confirms_a_change(env, confirm):
    for body in ({"confirm": confirm}, {}):
        r = act(env, **body)
        assert r.status_code == 400, r.text
        assert r.json()["problem"]["message"] == "Confirmation required"
    assert requests(env) == []


def test_a_change_without_a_node_is_refused(env):
    r = env["http"].post(f"/api/v1/recommendations/{ONE_CLICK}/apply", json={"confirm": True})
    assert r.status_code == 422 and requests(env) == []


def test_unknown_recommendations_and_nodes_are_404_before_any_agent_is_asked(env):
    r = act(env, rec_id="drop-caches", confirm=True)
    assert r.status_code == 404 and r.json()["problem"]["message"] == "No recommendation 'drop-caches'"
    r = act(env, node="nope", confirm=True)
    assert r.status_code == 404 and r.json()["problem"]["message"] == "Unknown node 'nope'"
    assert env["http"].post(f"/api/v1/recommendations/{ONE_CLICK}/reapply", json={}).status_code in (404, 405)
    assert requests(env) == []


def test_a_setting_that_is_not_one_click_is_refused_by_the_console(env):
    r = act(env, rec_id="display-reserved-memory", confirm=True)
    assert r.status_code == 409
    assert r.json()["problem"]["message"] == "Set Display Reserved Memory to Auto is not a one-click setting"
    assert requests(env) == []


@pytest.mark.parametrize(("agent", "console"), [(409, 409), (501, 501), (500, 502)])
def test_the_agents_refusal_reaches_the_browser_with_its_reason(env, agent, console):
    env["apps"]["n1"].state.recs["reject"] = agent
    r = act(env, confirm=True)
    assert r.status_code == console
    assert r.json()["problem"] == {"message": "Refused", "cause": f"{ONE_CLICK} apply", "fix": "Fix it"}


def test_a_node_too_old_or_unreachable_cannot_be_changed(env):
    r = act(env, node="old", confirm=True)
    assert r.status_code == 502
    assert r.json()["problem"]["message"] == "The agent on old is too old for recommendations"
    r = act(env, node="ghost", confirm=True)
    assert r.status_code == 503 and r.json()["problem"]["message"] == "Agent unreachable on ghost"


# --- demo ---------------------------------------------------------------------------------------------


@pytest.fixture
def demo(tmp_path):
    cfg = ConsoleConfig(web_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg, tmp_path / "data", demo=True, fleet="mixed")) as c:
        yield c


def states(c: TestClient, node: str) -> dict[str, tuple[str, bool]]:
    view = RecommendationsView.model_validate(c.get("/api/v1/recommendations").json())
    recs = view.nodes[node]
    assert recs is not None, view.problems
    return {i.id: (i.state, i.managed) for i in recs.items}


def test_demo_nodes_differ_and_the_workstation_is_not_applicable(demo):
    view = RecommendationsView.model_validate(demo.get("/api/v1/recommendations").json())
    assert view.catalog == CATALOG and list(view.nodes) == ["spark1", "spark2", "spark3", "ws1"]
    assert view.problems == {}
    spark = {n: states(demo, n) for n in ("spark1", "spark2", "spark3")}
    assert spark["spark1"] != spark["spark2"] != spark["spark3"] != spark["spark1"]
    assert spark["spark1"]["gpu-clock-cap"] == ("applied", False)  # by the owner's own unit
    assert spark["spark2"]["cpu-pcore-cap"] == ("applied", True)
    assert set(states(demo, "ws1").values()) == {("not-applicable", False)}
    helpers = {n: recs.one_click for n, recs in view.nodes.items() if recs is not None}
    assert [n for n, problem in helpers.items() if problem is not None] == ["spark3"]
    foreign = next(i for i in view.nodes["spark1"].items if i.id == "gpu-clock-cap")
    assert foreign.detail == "Capped at 2200 MHz by nvidia-lock-clocks.service" and foreign.last is None


def test_demo_apply_and_undo_flip_the_state_in_memory(demo):
    assert states(demo, "spark1")[ONE_CLICK] == ("not-applied", False)
    body = {"node": "spark1", "confirm": True}
    assert demo.post(f"/api/v1/recommendations/{ONE_CLICK}/apply", json=body).status_code == 202
    assert states(demo, "spark1")[ONE_CLICK] == ("applied", True)
    assert states(demo, "spark2")["gpu-clock-cap"] == ("not-applied", False)  # other nodes are untouched
    view = demo.get("/api/v1/recommendations").json()
    last = next(i for i in view["nodes"]["spark1"]["items"] if i["id"] == ONE_CLICK)["last"]
    assert (last["action"], last["ok"]) == ("apply", True)
    assert demo.post(f"/api/v1/recommendations/{ONE_CLICK}/undo", json=body).status_code == 202
    assert states(demo, "spark1")[ONE_CLICK] == ("not-applied", False)


def test_demo_takes_apply_only_where_recommended_and_undo_only_for_what_sparkline_applied(demo):
    before = {n: states(demo, n) for n in ("spark1", "spark2", "ws1")}

    def refused(node: str, rec_id: str, verb: str) -> str:
        r = demo.post(f"/api/v1/recommendations/{rec_id}/{verb}", json={"node": node, "confirm": True})
        assert r.status_code == 409, r.text
        return r.json()["problem"]["message"]

    cap = "Cap the GPU clock at 2200 MHz"
    assert refused("spark1", "gpu-clock-cap", "undo") == f"{cap} on spark1 is not Sparkline's to undo"
    assert refused("spark1", "gpu-clock-cap", "apply") == f"{cap} is already applied on spark1"
    assert refused("spark2", ONE_CLICK, "apply").endswith("is already applied on spark2")
    assert refused("spark2", "gpu-clock-cap", "undo").endswith("is not Sparkline's to undo")
    assert refused("ws1", ONE_CLICK, "undo").endswith("is not Sparkline's to undo")
    assert {n: states(demo, n) for n in before} == before


def test_demo_boot_target_changes_at_a_click_and_the_desktop_only_at_a_restart(demo):
    def detail(node: str) -> str:
        view = RecommendationsView.model_validate(demo.get("/api/v1/recommendations").json())
        recs = view.nodes[node]
        assert recs is not None
        return next(i.detail for i in recs.items if i.id == "headless-boot")

    def click(node: str, verb: str) -> None:
        body = {"node": node, "confirm": True}
        assert demo.post(f"/api/v1/recommendations/headless-boot/{verb}", json=body).status_code == 202

    assert detail("spark1") == "Boots to the desktop (graphical.target). The desktop is running now"
    click("spark1", "apply")  # no restart since: the desktop that was running still is
    assert detail("spark1") == "Boots without the desktop (multi-user.target). The desktop is running now"
    assert detail("spark2") == "Boots without the desktop (multi-user.target). The desktop is not running now"
    click("spark2", "undo")
    assert detail("spark2") == "Boots to the desktop (graphical.target). The desktop is not running now"


def test_demo_refuses_what_a_real_fleet_would(demo):
    r = demo.post(f"/api/v1/recommendations/{ONE_CLICK}/apply", json={"node": "spark3", "confirm": True})
    assert r.status_code == 501
    assert "Keep --enable-benchmarks if the node runs benchmarks" in r.json()["problem"]["fix"]
    r = demo.post(f"/api/v1/recommendations/{ONE_CLICK}/apply", json={"node": "ws1", "confirm": True})
    assert r.status_code == 409 and r.json()["problem"]["message"].endswith("does not apply to ws1")
    r = demo.post(f"/api/v1/recommendations/{ONE_CLICK}/apply", json={"node": "spark1"})
    assert r.status_code == 400 and r.json()["problem"]["message"] == "Confirmation required"
    r = demo.post(
        "/api/v1/recommendations/display-reserved-memory/apply", json={"node": "spark1", "confirm": True}
    )
    assert r.status_code == 409
    assert states(demo, "spark1")[ONE_CLICK] == ("not-applied", False)
