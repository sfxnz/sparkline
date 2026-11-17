"""The agent's recommendation routes: what this node reports, and the request it leaves for its root helper
(sparkline-tune.path) on apply and undo."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_agent_bench_api import AUTH, TOKEN, poll
from test_agent_bench_runner import FAKE_DOCKER, fake, node_info

from sparkline import tune
from sparkline.agent import recommend
from sparkline.agent.app import create_app
from sparkline.agent.bench import probes
from sparkline.agent.bench.runner import BenchRunner
from sparkline.agent.sampler import Sampler
from sparkline.common.recommendations import CATALOG
from sparkline.common.schema import NodeRecommendations

ROUTES = [
    ("GET", "/api/v1/recommendations"),
    ("POST", "/api/v1/recommendations/gpu-clock-cap/apply"),
    ("POST", "/api/v1/recommendations/gpu-clock-cap/undo"),
]


def helper_installed(root: Path) -> Path:
    unit = root / recommend.TUNE_PATH_UNIT
    unit.parent.mkdir(parents=True)
    unit.write_text("[Path]\nDirectoryNotEmpty=/var/lib/sparkline-agent/tune-requests\n")
    requests = root / tune.REQUEST_DIR
    requests.mkdir(parents=True)
    return requests


LOCK_UNIT = "nvidia-lock-clocks.service"  # the owner's own cap, once a test writes the unit file


def systemctl(argv: list[str]) -> str | None:
    if argv[1:] == ["get-default"]:
        return "graphical.target"
    return "active" if argv[1:] == ["is-active", LOCK_UNIT] else "inactive"


def lock_unit(root: Path) -> None:
    unit = "[Service]\nExecStart=/usr/bin/nvidia-smi -lgc 0,2200\n"
    (root / recommend.UNIT_DIR / LOCK_UNIT).write_text(unit)


def record(root: Path, rec_id: str) -> None:
    """What the root helper leaves after it applied a setting."""
    (root / tune.APPLIED).mkdir(parents=True, exist_ok=True)
    (root / tune.APPLIED / rec_id).touch()


def agent(tmp_path: Path, root: Path, token: str = TOKEN, gb10: bool = True) -> TestClient:
    sampler = Sampler("n1", [], 1000)
    runner = BenchRunner(
        "n1",
        node_info,
        lambda: None,
        sampler.publish,
        "img:tag",
        str(tmp_path / "work"),
        jobs={"cpu-throughput": fake("hang")},
        probe=lambda: probes.Env(),
        kill_grace_s=0.5,
        docker=str(FAKE_DOCKER),
    )
    machine = recommend.Host(root, gb10, lambda: None, systemctl)
    app = create_app(sampler, node_info, token, False, runner, machine=machine)
    return TestClient(app, base_url="http://127.0.0.1:29973")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    root.mkdir()
    return root


def test_every_route_needs_the_agent_token(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    with agent(tmp_path, root) as c:
        for method, path in ROUTES:
            assert c.request(method, path).status_code == 401, path
            wrong = {"Authorization": "Bearer wrong-token"}
            assert c.request(method, path, headers=wrong).status_code == 401, path
    assert list(requests.iterdir()) == []


def test_a_tokenless_agent_refuses_rebinding_and_browsers(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    rebind = {"Host": "rebind.attacker.example:29973"}
    browser = {"Origin": "http://127.0.0.1:29973"}
    with agent(tmp_path, root, token="") as c:
        for method, path in ROUTES:
            assert c.request(method, path, headers=rebind).status_code == 403, path
            assert c.request(method, path, headers=browser).status_code == 403, path
        assert list(requests.iterdir()) == []
        assert c.get("/api/v1/recommendations").status_code == 200


def test_the_node_reports_every_recommendation_and_that_it_takes_clicks(tmp_path: Path, root: Path) -> None:
    with agent(tmp_path, root) as c:
        r = c.get("/api/v1/recommendations", headers=AUTH)
        assert r.status_code == 200, r.text
        recs = NodeRecommendations.model_validate(r.json())
        assert [i.id for i in recs.items] == [rec.id for rec in CATALOG]
        assert recs.one_click is not None and recs.one_click.cause.endswith(
            "sparkline-tune.path is not installed"
        )
        boot = next(i for i in recs.items if i.id == "headless-boot")
        assert (boot.state, boot.managed, boot.last) == ("not-applied", False, None)
        helper_installed(root)
        assert c.get("/api/v1/recommendations", headers=AUTH).json()["one_click"] is None


@pytest.mark.parametrize("verb", ["apply", "undo"])
def test_a_request_is_one_empty_file_named_after_the_setting_and_repeats_collapse(
    tmp_path: Path, root: Path, verb: str
) -> None:
    requests = helper_installed(root)
    if verb == "undo":
        record(root, "headless-boot")
    with agent(tmp_path, root) as c:
        for _ in range(3):
            r = c.post(f"/api/v1/recommendations/headless-boot/{verb}", headers=AUTH, json={"x": "ignored"})
            assert (r.status_code, r.json()) == (202, {"ok": True}), r.text
    assert [p.name for p in requests.iterdir()] == [f"headless-boot.{verb}"]
    assert (requests / f"headless-boot.{verb}").read_bytes() == b""


@pytest.mark.parametrize(
    "rec_id", ["drop-caches", "gpu-clock-cap.apply", "..", "%2e%2e%2fx", "GPU-CLOCK-CAP"]
)
def test_an_unknown_recommendation_is_404_and_leaves_no_request(
    tmp_path: Path, root: Path, rec_id: str
) -> None:
    requests = helper_installed(root)
    with agent(tmp_path, root) as c:
        for verb in ("apply", "undo"):
            assert c.post(f"/api/v1/recommendations/{rec_id}/{verb}", headers=AUTH).status_code == 404
        assert c.post("/api/v1/recommendations/gpu-clock-cap/reapply", headers=AUTH).status_code == 404
    assert list(requests.iterdir()) == [] and sorted(p.name for p in root.iterdir()) == ["etc", "var"]


def test_a_setting_that_is_not_one_click_is_refused(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/display-reserved-memory/apply", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["problem"]["message"] == "Set Display Reserved Memory to Auto is not a one-click setting"
    assert list(requests.iterdir()) == []


def test_apply_is_refused_unless_the_node_reports_the_setting_as_not_applied(
    tmp_path: Path, root: Path
) -> None:
    requests = helper_installed(root)
    lock_unit(root)
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/gpu-clock-cap/apply", headers=AUTH)  # over another unit's cap
        assert r.status_code == 409, r.text
        assert r.json()["problem"] == {
            "message": "Cap the GPU clock at 2200 MHz is already applied on n1",
            "cause": f"Capped at 2200 MHz by {LOCK_UNIT}",
            "fix": "There is nothing to apply. Reload the page if it still offers Apply",
        }
        r = c.post("/api/v1/recommendations/cpu-pcore-cap/apply", headers=AUTH)  # this root has no cpufreq
        assert r.status_code == 409, r.text
        assert r.json()["problem"]["message"] == "Cap the performance cores at 3000 MHz does not apply to n1"
        assert r.json()["problem"]["cause"] == "No CPU core on this machine runs above 3000 MHz"
    assert list(requests.iterdir()) == []


def test_a_node_without_a_gb10_takes_no_setting(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    with agent(tmp_path, root, gb10=False) as c:
        r = c.post("/api/v1/recommendations/headless-boot/apply", headers=AUTH)
    assert r.status_code == 409, r.text
    assert r.json()["problem"]["message"] == "Boot without the desktop does not apply to n1"
    assert r.json()["problem"]["cause"] == recommend.NOT_GB10
    assert list(requests.iterdir()) == []


def test_a_setting_the_node_cannot_read_is_not_applied_blind(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    (root / recommend.UNIT_DIR / "cap.service").mkdir()  # not a file: the check for a cap cannot read it
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/gpu-clock-cap/apply", headers=AUTH)
    assert r.status_code == 409, r.text
    problem = r.json()["problem"]
    assert problem["message"] == "Cap the GPU clock at 2200 MHz cannot be applied on n1 yet"
    assert problem["cause"].startswith("Cannot read /etc/systemd/system/cap.service")
    assert list(requests.iterdir()) == []


def test_undo_is_refused_for_a_setting_sparkline_did_not_apply(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    lock_unit(root)
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/gpu-clock-cap/undo", headers=AUTH)  # the owner's unit set it
        assert r.status_code == 409, r.text
        assert r.json()["problem"] == {
            "message": "Cap the GPU clock at 2200 MHz on n1 is not Sparkline's to undo",
            "cause": "Sparkline has no record of applying it (/var/lib/sparkline-tune/applied/gpu-clock-cap)",
            "fix": "Undo it where it was set. Sparkline undoes only what it applied",
        }
        assert c.post("/api/v1/recommendations/headless-boot/undo", headers=AUTH).status_code == 409
        assert list(requests.iterdir()) == []
        # Recorded, and set back by hand since (the boot target is graphical): Undo still clears the record.
        record(root, "headless-boot")
        assert c.post("/api/v1/recommendations/headless-boot/undo", headers=AUTH).status_code == 202
    assert [p.name for p in requests.iterdir()] == ["headless-boot.undo"]


def test_a_setting_sparkline_applied_is_undone_and_not_applied_twice(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    record(root, "gpu-clock-cap")
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/gpu-clock-cap/apply", headers=AUTH)
        assert r.status_code == 409 and r.json()["problem"]["cause"] == "Capped at 2200 MHz by Sparkline"
        assert c.post("/api/v1/recommendations/gpu-clock-cap/undo", headers=AUTH).status_code == 202
    assert [p.name for p in requests.iterdir()] == ["gpu-clock-cap.undo"]


def test_without_the_root_helper_the_node_says_how_to_install_it(tmp_path: Path, root: Path) -> None:
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/gpu-clock-cap/apply", headers=AUTH)
    assert r.status_code == 501
    problem = r.json()["problem"]
    assert problem["message"] == "n1 does not take one-click settings"
    assert "--enable-tune added to the flags it was installed with" in problem["fix"]


def test_a_running_benchmark_refuses_a_change_until_it_ends(tmp_path: Path, root: Path) -> None:
    requests = helper_installed(root)
    with agent(tmp_path, root) as c:
        body = {"run_id": "r1", "bench_id": "cpu-throughput", "params": {"seconds_per_test": 1}}
        assert c.post("/api/v1/bench/runs", json=body, headers=AUTH).status_code == 202
        for verb in ("apply", "undo"):
            r = c.post(f"/api/v1/recommendations/gpu-clock-cap/{verb}", headers=AUTH)
            assert r.status_code == 409
            assert r.json()["problem"]["message"] == "A benchmark is running on n1"
        assert list(requests.iterdir()) == []
        c.post("/api/v1/bench/runs/r1/cancel", headers=AUTH)
        poll(c, "r1", "cancelled")
        assert c.post("/api/v1/recommendations/gpu-clock-cap/apply", headers=AUTH).status_code == 202
    assert [p.name for p in requests.iterdir()] == ["gpu-clock-cap.apply"]


def test_a_request_directory_that_is_gone_is_an_error_not_a_silent_success(
    tmp_path: Path, root: Path
) -> None:
    helper_installed(root).rmdir()
    with agent(tmp_path, root) as c:
        r = c.post("/api/v1/recommendations/gpu-clock-cap/apply", headers=AUTH)
    assert r.status_code == 500 and r.json()["problem"]["message"] == "Cannot write the request"


def test_an_agent_built_without_a_machine_has_no_recommendation_routes(tmp_path: Path) -> None:
    app = create_app(Sampler("n1", [], 1000), node_info, TOKEN, False)
    with TestClient(app) as c:
        assert c.get("/api/v1/recommendations", headers=AUTH).status_code == 404
