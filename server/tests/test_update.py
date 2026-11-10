from __future__ import annotations

import hashlib
import io
import json
import sys
import tarfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
import pytest

from sparkline import update
from sparkline.console.main import main as sparkline_main

API = "https://api.example.test/releases"
GITHUB_ASSETS = "https://github.com/sfxnz/sparkline/releases/download/v0.1.1"
UNIT = "[Service]\nExecStart=/opt/sparkline/venv/bin/{} --config /etc/sparkline/x.toml\n"
AGENT_TOKEN = "agent-token-0123456789"


def install(
    root: Path,
    *,
    console: bool = True,
    agent: bool = True,
    bench: bool = False,
    version="0.1.0",
    nodes: list[str] = (),
    agent_token: str = AGENT_TOKEN,
):
    units = root / "etc/systemd/system"
    units.mkdir(parents=True, exist_ok=True)
    if console:
        (units / "sparkline.service").write_text(UNIT.format("sparkline"))
        entries = "".join(f'[[nodes]]\nid = "{n}"\nurl = "{node_url(n)}/"\n' for n in nodes)
        (root / "etc/sparkline").mkdir(parents=True, exist_ok=True)
        (root / "etc/sparkline/console.toml").write_text(f'agent_token = "{agent_token}"\n{entries}')
    if agent:
        (units / "sparkline-agent.service").write_text(UNIT.format("sparkline-agent"))
    if bench:
        (units / "sparkline-agent.service.d").mkdir()
        (units / "sparkline-agent.service.d/10-benchmarks.conf").write_text("[Service]\n")
    site = root / "opt/sparkline/venv/lib/python3.12/site-packages"
    (site / f"sparkline-{version}.dist-info").mkdir(parents=True)


def tarball(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in members.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FakeGitHub:
    """GitHub's latest-release API and its two assets, served from memory."""

    def __init__(
        self,
        log: Path,
        version: str = "0.1.1",
        members: dict[str, str] | None = None,
        asset_base: str = "https://api.example.test/download",
    ):
        self.version = version
        self.asset_base = asset_base
        script = f'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> {log}\n'
        self.tar = tarball(members or {f"sparkline-{version}/deploy/install.sh": script})
        self.sums = f"{hashlib.sha256(self.tar).hexdigest()}  sparkline-{version}.tar.gz\n"
        self.requested: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requested.append(path)
        name = f"sparkline-{self.version}.tar.gz"
        if path.endswith("/releases/latest"):
            assets = [
                {"name": n, "browser_download_url": f"{self.asset_base}/{n}"} for n in (name, "SHA256SUMS")
            ]
            return httpx.Response(200, json={"tag_name": f"v{self.version}", "assets": assets})
        if path.endswith(f"/{name}"):
            return httpx.Response(200, content=self.tar)
        if path.endswith("/SHA256SUMS"):
            return httpx.Response(200, text=self.sums)
        return httpx.Response(404)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


@pytest.fixture
def as_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.geteuid", lambda: 0)


def run(root: Path, gh: FakeGitHub, *argv: str, agents: FakeAgents | None = None, **env: str) -> int:
    env = {"SPARKLINE_UPDATE_ROOT": str(root), "SPARKLINE_RELEASES_API": API, **env}
    return update.main(list(argv), env, gh.client(), (agents or FakeAgents("0.1.1", {})).client())


def calls(log: Path) -> list[str]:
    return log.read_text().splitlines() if log.exists() else []


def test_an_up_to_date_host_downloads_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.1")
    gh = FakeGitHub(log)
    assert run(root, gh) == 0
    assert "Sparkline 0.1.1 is up to date on this host." in capsys.readouterr().out
    assert gh.requested == ["/releases/latest"]
    assert calls(log) == []


def test_the_highest_of_several_installed_versions_counts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.0")
    (root / "opt/sparkline/venv/lib/python3.12/site-packages/sparkline-0.1.1.dist-info").mkdir()
    assert run(root, FakeGitHub(log)) == 0
    assert "Sparkline 0.1.1 is up to date on this host." in capsys.readouterr().out


def test_reinstall_reruns_every_installer_on_an_up_to_date_host(tmp_path: Path, as_root: None) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.1")
    assert run(root, FakeGitHub(log), "--reinstall", "--yes") == 0
    assert [line.split()[0] for line in calls(log)] == ["console", "agent"]


@pytest.mark.parametrize(("installed", "latest"), [("0.1.0", "0.1.1"), ("0.1.9", "0.1.10")])
def test_newer_release_runs_the_console_installer_then_the_agent_one_keeping_benchmarks(
    tmp_path: Path, as_root: None, installed: str, latest: str
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, bench=True, version=installed)
    assert run(root, FakeGitHub(log, latest), "--yes") == 0
    assert calls(log) == [
        f"console --yes --prefix /opt/sparkline --destdir {root}",
        f"agent --yes --prefix /opt/sparkline --enable-benchmarks --destdir {root}",
    ]


def test_agent_only_host_without_benchmarks_stays_monitor_only(tmp_path: Path, as_root: None) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, console=False)
    assert run(root, FakeGitHub(log), "--yes") == 0
    assert calls(log) == [f"agent --yes --prefix /opt/sparkline --destdir {root}"]


def test_dry_run_passes_dry_run_to_the_installers_without_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("os.geteuid", lambda: 1000)
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    assert run(root, FakeGitHub(log), "--dry-run") == 0
    assert [line.split()[0] for line in calls(log)] == ["console", "agent"]
    assert all(line.endswith("--dry-run") for line in calls(log))


def test_check_reports_versions_and_changes_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, bench=True)
    gh = FakeGitHub(log)
    assert run(root, gh, "--check") == 0
    out = capsys.readouterr().out
    assert "Installed: console 0.1.0 in /opt/sparkline" in out
    assert "Installed: agent 0.1.0 in /opt/sparkline, benchmarks on" in out
    assert "Latest release: 0.1.1" in out
    assert gh.requested == ["/releases/latest"]


def test_checksum_mismatch_refuses_before_running_anything(
    tmp_path: Path, as_root: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    gh = FakeGitHub(log)
    gh.sums = f"{'0' * 64}  sparkline-0.1.1.tar.gz\n"
    assert run(root, gh, "--yes") == 1
    assert "does not match its SHA256SUMS" in capsys.readouterr().err
    assert calls(log) == []


def test_tarball_path_traversal_is_refused(
    tmp_path: Path, as_root: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    escape = "../../../escaped.sh"
    gh = FakeGitHub(log, members={escape: "pwned", "sparkline-0.1.1/deploy/install.sh": "exit 0"})
    assert run(root, gh, "--yes") == 1
    assert "cannot unpack sparkline-0.1.1.tar.gz" in capsys.readouterr().err
    assert calls(log) == []
    assert not list(tmp_path.rglob("escaped.sh"))


def test_failed_installer_says_what_was_and_was_not_updated(
    tmp_path: Path, as_root: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    script = f'printf "%s\\n" "$*" >> {log}\nexit 3\n'
    gh = FakeGitHub(log, members={"sparkline-0.1.1/deploy/install.sh": script})
    assert run(root, gh, "--yes") == 1
    err = capsys.readouterr().err
    assert "install.sh console failed with exit 3" in err
    assert "Updated: nothing. Not attempted: agent." in err
    assert "Fix the cause and run: sudo sparkline update --reinstall" in err
    assert [line.split()[0] for line in calls(log)] == ["console"]


def test_host_without_install_sh_units_explains_the_other_ways(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    gh = FakeGitHub(tmp_path / "install.log")
    assert run(tmp_path / "root", gh) == 1
    err = capsys.readouterr().err
    assert "no Sparkline installed by install.sh on this host" in err
    assert "docker compose" in err and "git pull" in err
    assert gh.requested == []


def test_non_root_without_a_terminal_is_told_to_use_sudo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host_install: None, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("os.geteuid", lambda: 1000)
    monkeypatch.setattr("sys.stdin", io.StringIO())
    gh = FakeGitHub(tmp_path / "install.log", asset_base=GITHUB_ASSETS)
    assert update.main(["--yes"], {}, gh.client()) == 1
    assert "Run: sudo sparkline update --yes\n" in capsys.readouterr().err
    assert gh.requested == ["/repos/sfxnz/sparkline/releases/latest"]


def test_a_check_without_root_names_the_check_in_its_sudo_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, host_install: None, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("os.geteuid", lambda: 1000)
    monkeypatch.setattr("sys.stdin", io.StringIO())
    gh = FakeGitHub(tmp_path / "install.log", asset_base=GITHUB_ASSETS)
    assert update.main(["--check"], {}, gh.client()) == 1
    assert "Run: sudo sparkline update --check\n" in capsys.readouterr().err


class Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


@pytest.fixture
def user_on_a_terminal(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """A non-root user at a terminal. Returns the argv of every exec, which raises SystemExit instead."""
    execs: list[list[str]] = []

    def execvp(file: str, args: list[str]) -> None:
        execs.append(args)
        raise SystemExit(0)

    monkeypatch.setattr("os.geteuid", lambda: 1000)
    monkeypatch.setattr("sys.stdin", Tty())
    monkeypatch.setattr("os.execvp", execvp)
    return execs


@pytest.fixture
def host_install(monkeypatch: pytest.MonkeyPatch) -> None:
    """A console and an agent 0.1.0 under the real root, without reading this machine's /etc/systemd or
    /etc/sparkline."""
    found = [update.Component(m, Path("/opt/sparkline"), (0, 1, 0)) for m in ("console", "agent")]
    monkeypatch.setattr(update, "detect", lambda root: found if root == Path("/") else [])
    monkeypatch.setattr(update, "node_targets", lambda root, env: ([], AGENT_TOKEN))


def test_non_root_on_a_terminal_reruns_the_venv_script_under_sudo(
    tmp_path: Path, user_on_a_terminal: list[list[str]], host_install: None
) -> None:
    gh = FakeGitHub(tmp_path / "install.log", asset_base=GITHUB_ASSETS)
    with pytest.raises(SystemExit):
        update.main(["--yes"], {}, gh.client())
    script = str(Path(sys.executable).with_name("sparkline"))
    assert user_on_a_terminal == [["sudo", script, "update", "--yes"]]


def test_staged_root_installs_as_the_user_without_sudo(
    tmp_path: Path, user_on_a_terminal: list[list[str]]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    assert run(root, FakeGitHub(log), "--yes") == 0
    assert user_on_a_terminal == []
    assert all(line.endswith(f"--destdir {root}") for line in calls(log))
    assert len(calls(log)) == 2


def test_fake_releases_api_is_never_carried_into_sudo(
    tmp_path: Path,
    user_on_a_terminal: list[list[str]],
    host_install: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    log = tmp_path / "install.log"
    assert update.main(["--yes"], {"SPARKLINE_RELEASES_API": API}, FakeGitHub(log).client()) == 1
    assert user_on_a_terminal == []
    assert "run sparkline update as root with SPARKLINE_RELEASES_API set" in capsys.readouterr().err
    assert calls(log) == []


def test_empty_update_root_means_the_real_root(tmp_path: Path, as_root: None, host_install: None) -> None:
    log = tmp_path / "install.log"
    env = {"SPARKLINE_UPDATE_ROOT": "", "SPARKLINE_RELEASES_API": API}
    assert update.main(["--dry-run"], env, FakeGitHub(log).client()) == 0
    assert calls(log) == [
        "console --yes --prefix /opt/sparkline --dry-run",
        "agent --yes --prefix /opt/sparkline --dry-run",
    ]


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/sfxnz/sparkline/releases/download/v0.1.1",
        "https://github.com.example.test/download",
        "https://evilgithubusercontent.com/download",
        "https://api.example.test.other.test/download",
    ],
)
def test_assets_off_github_or_the_fake_api_host_are_refused(
    tmp_path: Path, as_root: None, url: str, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    gh = FakeGitHub(log, asset_base=url)
    assert run(root, gh, "--yes") == 1
    assert "not an https URL on github.com" in capsys.readouterr().err
    assert gh.requested == ["/releases/latest"]


@pytest.mark.parametrize(
    "url",
    [GITHUB_ASSETS, "https://objects.githubusercontent.com/download"],
)
def test_assets_on_github_are_downloaded(tmp_path: Path, as_root: None, url: str) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    env = {"SPARKLINE_UPDATE_ROOT": str(root)}
    assert update.main(["--yes"], env, FakeGitHub(log, asset_base=url).client()) == 0
    assert len(calls(log)) == 2


def test_errors_follow_the_output_before_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, as_root: None
) -> None:
    """stdout to a pipe is block-buffered, stderr is not: unflushed lines would land after the error."""
    terminal: list[str] = []

    class Piped(io.StringIO):
        pending: list[str]

        def write(self, s: str) -> int:
            self.pending.append(s)
            return len(s)

        def flush(self) -> None:
            terminal.extend(self.pending)
            self.pending.clear()

    class Unbuffered(io.StringIO):
        def write(self, s: str) -> int:
            terminal.append(s)
            return len(s)

    monkeypatch.setattr("sys.stdin", io.StringIO())
    piped = Piped()
    piped.pending = []
    monkeypatch.setattr("sys.stdout", piped)
    monkeypatch.setattr("sys.stderr", Unbuffered())
    root = tmp_path / "root"
    install(root)
    assert run(root, FakeGitHub(tmp_path / "install.log")) == 1
    piped.flush()
    text = "".join(terminal)
    assert text.index("Latest release: 0.1.1") < text.index("Re-run with --yes")


def test_release_without_assets_yet_says_so(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = tmp_path / "root"
    install(root)
    latest = json.dumps({"tag_name": "v0.1.1", "assets": []})
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=latest)))
    env = {"SPARKLINE_UPDATE_ROOT": str(root), "SPARKLINE_RELEASES_API": API}
    assert update.main([], env, client) == 1
    assert "has no sparkline-0.1.1.tar.gz and SHA256SUMS yet" in capsys.readouterr().err


def test_sparkline_update_is_a_subcommand(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit:
        sparkline_main(["update", "--help"])
    assert exit.value.code == 0
    assert "--check" in capsys.readouterr().out


def test_sparkline_help_says_update_reaches_every_node_from_the_console_host(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit):
        sparkline_main(["--help"])
    epilog = " ".join(capsys.readouterr().out.split())
    assert "on the console host, every node in /etc/sparkline/console.toml" in epilog


# --- the nodes in the console's config ----------------------------------------------------------------


HERE = "here"  # the console host's own agent, listed in [[nodes]] by a local address


def node_url(node_id: str) -> str:
    if node_id == HERE:
        return "http://127.0.0.1:9750"
    return f"http://192.0.2.{ord(node_id[0]) - ord('a') + 10}:9750"


Behaviour = Literal["updates", "busy", "no_endpoint", "no_helper", "down", "stuck", "this_host"]


@dataclass
class FakeNode:
    version: str
    behaviour: Behaviour = "updates"
    asked: int = 0
    accepted: bool = False  # answered 202
    restarts: int = 0  # this_host: reads refused once this host's agent installer ran, while it restarts


class FakeAgents:
    """Agents that answer GET /api/v1/info and POST /api/v1/update. An "updates" node reports the latest
    version only once every node that will be asked has been asked, so waiting on one node before asking
    the next times out."""

    def __init__(self, latest: str, nodes: dict[str, FakeNode], log: Path | None = None):
        self.latest = latest
        self.nodes = {node_url(n): node for n, node in nodes.items()}
        self.log = log
        self.installs_before_first_ask: list[str] | None = None
        self.lock = threading.Lock()

    def everyone_asked(self) -> bool:
        return all(
            n.accepted for n in self.nodes.values() if n.behaviour == "updates" and n.version != self.latest
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        node = self.nodes[f"{request.url.scheme}://{request.url.host}:{request.url.port}"]
        if node.behaviour == "down":
            raise httpx.ConnectError("Connection refused", request=request)
        if request.headers.get("authorization") != f"Bearer {AGENT_TOKEN}":
            return httpx.Response(401)
        if node.behaviour == "this_host" and any(c.startswith("agent ") for c in calls(self.log)):
            if node.restarts:
                node.restarts -= 1
                raise httpx.ConnectError("Connection refused", request=request)
            node.version = self.latest
        with self.lock:
            if request.method == "POST" and request.url.path == "/api/v1/update":
                if self.installs_before_first_ask is None and self.log is not None:
                    self.installs_before_first_ask = calls(self.log)
                node.asked += 1
                status = {"busy": 409, "no_endpoint": 404, "no_helper": 501}.get(node.behaviour, 202)
                node.accepted = status == 202
                return httpx.Response(status)
            if request.url.path == "/api/v1/info":
                if node.behaviour == "updates" and node.accepted and self.everyone_asked():
                    node.version = self.latest
                return httpx.Response(200, json={"agent_version": node.version})
        return httpx.Response(404)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))

    def asked(self) -> dict[str, int]:
        return {url: n.asked for url, n in self.nodes.items()}


@pytest.fixture
def fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "POLL_S", 0.01)
    monkeypatch.setattr(update, "NODE_TIMEOUT_S", 1.0)


def node_lines(out: str) -> dict[str, tuple[str, str]]:
    """The last per-node line printed for each node: {id: (outcome, detail)}."""
    lines = [line.split(None, 2) for line in out.splitlines() if line.startswith("  ")]
    return {parts[0]: (parts[1], parts[2] if len(parts) > 2 else "") for parts in lines}


def test_console_host_updates_itself_then_asks_every_node_at_once(
    tmp_path: Path, as_root: None, fast: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=["a", "b", "c"])
    agents = FakeAgents("0.1.1", {n: FakeNode("0.1.0") for n in "abc"}, log)
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 0
    assert agents.installs_before_first_ask == [
        f"console --yes --prefix /opt/sparkline --destdir {root}",
        f"agent --yes --prefix /opt/sparkline --destdir {root}",
    ]
    assert set(agents.asked().values()) == {1}
    out = capsys.readouterr().out
    assert node_lines(out) == {n: ("updated", "0.1.0 -> 0.1.1") for n in "abc"}
    assert "All 3 nodes run 0.1.1." in out


def test_a_rerun_asks_only_the_nodes_still_behind(
    tmp_path: Path, as_root: None, fast: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.1", nodes=["a", "b"])
    agents = FakeAgents("0.1.1", {"a": FakeNode("0.1.0", "busy"), "b": FakeNode("0.1.0")})
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 1
    assert node_lines(capsys.readouterr().out)["b"] == ("updated", "0.1.0 -> 0.1.1")
    agents.nodes[node_url("a")].behaviour = "updates"
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 0
    assert node_lines(capsys.readouterr().out) == {
        "a": ("updated", "0.1.0 -> 0.1.1"),
        "b": ("up_to_date", "0.1.1"),
    }
    assert agents.asked() == {node_url("a"): 2, node_url("b"): 1}
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 0
    assert agents.asked() == {node_url("a"): 2, node_url("b"): 1}
    assert calls(log) == []


def test_each_node_gets_one_line_and_any_node_left_behind_fails_the_run(
    tmp_path: Path, as_root: None, fast: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    nodes = {
        "a": FakeNode("0.1.2"),
        "b": FakeNode("0.1.1"),
        "c": FakeNode("0.1.1", "busy"),
        "d": FakeNode("0.1.1", "no_endpoint"),
        "e": FakeNode("0.1.0", "no_endpoint"),
        "f": FakeNode("0.1.1", "no_helper"),
        "g": FakeNode("0.1.1", "down"),
        "h": FakeNode("0.1.1", "stuck"),
    }
    install(root, version="0.1.2", nodes=list(nodes))
    assert run(root, FakeGitHub(log, "0.1.2"), "--yes", agents=FakeAgents("0.1.2", nodes)) == 1
    captured = capsys.readouterr()
    lines = node_lines(captured.out)
    assert {n: outcome for n, (outcome, _) in lines.items()} == {
        "a": "up_to_date",
        "b": "updated",
        "c": "busy",
        "d": "needs_manual_update",
        "e": "needs_manual_update",
        "f": "needs_manual_update",
        "g": "unreachable",
        "h": "timed_out",
    }
    assert lines["d"][1].endswith("Run once on d: sudo sparkline update")
    assert "Run once on e, from a checkout of the latest release: sudo ./install.sh agent" in lines["e"][1]
    assert "has no sparkline-update.path" in lines["f"][1]
    assert lines["h"][1].startswith("still 0.1.1 after 1 s")
    assert "6 of 8 nodes are not at 0.1.2" in captured.out.split("Result:")[1]


def test_check_lists_this_host_and_every_node_and_asks_none(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.1", nodes=["a", "b", "c"])
    agents = FakeAgents(
        "0.1.1", {"a": FakeNode("0.1.1"), "b": FakeNode("0.1.0"), "c": FakeNode("0.1.0", "down")}
    )
    assert run(root, FakeGitHub(log), "--check", agents=agents) == 0
    out = capsys.readouterr().out
    assert "Sparkline 0.1.1 is up to date on this host." in out
    lines = node_lines(out)
    assert lines["a"] == ("up_to_date", "0.1.1")
    assert lines["b"] == ("update_available", "0.1.0, latest 0.1.1")
    assert lines["c"][0] == "unreachable"
    assert "Run: sudo sparkline update" in out
    assert set(agents.asked().values()) == {0}


def test_dry_run_lists_the_nodes_it_would_ask_and_asks_none(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=["a", "b"])
    agents = FakeAgents("0.1.1", {"a": FakeNode("0.1.1"), "b": FakeNode("0.1.0")})
    assert run(root, FakeGitHub(log), "--dry-run", agents=agents) == 0
    assert "Dry run: would ask 1 of 2 nodes to update (b)." in capsys.readouterr().out
    assert all(line.endswith("--dry-run") for line in calls(log)) and len(calls(log)) == 2
    assert set(agents.asked().values()) == {0}


def test_this_host_updates_only_this_host(tmp_path: Path, as_root: None) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=["a"])
    agents = FakeAgents("0.1.1", {"a": FakeNode("0.1.0", "down")})
    assert run(root, FakeGitHub(log), "--yes", "--this-host", agents=agents) == 0
    assert [line.split()[0] for line in calls(log)] == ["console", "agent"]


def test_the_agent_token_comes_from_the_console_config_and_its_env_override(
    tmp_path: Path, as_root: None, fast: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.1", nodes=["a"], agent_token="not-the-agents-token")
    agents = FakeAgents("0.1.1", {"a": FakeNode("0.1.0")})
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 1
    outcome, detail = node_lines(capsys.readouterr().out)["a"]
    assert outcome == "error" and "agent_token does not match" in detail
    assert run(root, FakeGitHub(log), "--yes", agents=agents, SPARKLINE_AGENT_TOKEN=AGENT_TOKEN) == 0


def test_a_console_without_a_readable_node_list_changes_nothing(
    tmp_path: Path, as_root: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    (root / "etc/sparkline/console.toml").unlink()
    assert run(root, FakeGitHub(log), "--yes") == 1
    err = capsys.readouterr().err
    assert "cannot read the nodes from" in err
    assert "sudo sparkline update --this-host updates only this host" in err
    assert calls(log) == []


def test_this_hosts_own_agent_is_updated_by_this_host_and_never_asked(
    tmp_path: Path, as_root: None, fast: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=[HERE, "b"])
    agents = FakeAgents("0.1.1", {HERE: FakeNode("0.1.0", "this_host"), "b": FakeNode("0.1.0")}, log)
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 0
    assert agents.asked() == {node_url(HERE): 0, node_url("b"): 1}
    out = capsys.readouterr().out
    assert "Asking b to update to 0.1.1" in out
    assert node_lines(out.split("Result:")[1]) == {
        HERE: ("updated", "0.1.0 -> 0.1.1 (this host)"),
        "b": ("updated", "0.1.0 -> 0.1.1"),
    }
    assert "All 2 nodes run 0.1.1." in out


def test_this_hosts_own_agent_is_left_out_of_the_question(
    tmp_path: Path, as_root: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=[HERE, "b"])
    agents = FakeAgents("0.1.1", {HERE: FakeNode("0.1.0", "this_host"), "b": FakeNode("0.1.0")}, log)
    questions: list[str] = []
    monkeypatch.setattr("sys.stdin", Tty())
    monkeypatch.setattr("builtins.input", lambda q: questions.append(q) or "n")
    assert run(root, FakeGitHub(log), agents=agents) == 1
    assert questions == [
        "Update the console and the agent, then 1 node (b) to 0.1.1 and restart them? [y/N] "
    ]


def test_dry_run_leaves_this_hosts_own_agent_out_of_the_nodes_to_ask(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=[HERE, "b"])
    agents = FakeAgents("0.1.1", {HERE: FakeNode("0.1.0", "this_host"), "b": FakeNode("0.1.0")}, log)
    assert run(root, FakeGitHub(log), "--dry-run", agents=agents) == 0
    assert "Dry run: would ask 1 of 2 nodes to update (b)." in capsys.readouterr().out
    assert set(agents.asked().values()) == {0}


def test_this_hosts_own_agent_restarting_after_its_update_is_waited_for(
    tmp_path: Path, as_root: None, fast: None, capsys: pytest.CaptureFixture[str]
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, nodes=[HERE])
    agents = FakeAgents("0.1.1", {HERE: FakeNode("0.1.0", "this_host", restarts=3)}, log)
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 0
    assert node_lines(capsys.readouterr().out.split("Result:")[1]) == {
        HERE: ("updated", "0.1.0 -> 0.1.1 (this host)")
    }


def test_a_local_node_is_asked_when_this_host_runs_no_agent(
    tmp_path: Path, as_root: None, fast: None
) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, agent=False, nodes=[HERE])
    agents = FakeAgents("0.1.1", {HERE: FakeNode("0.1.0")}, log)
    assert run(root, FakeGitHub(log), "--yes", agents=agents) == 0
    assert agents.asked() == {node_url(HERE): 1}
