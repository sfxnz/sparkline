from __future__ import annotations

import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

import httpx
import pytest

from sparkline import update
from sparkline.console.main import main as sparkline_main

API = "https://api.example.test/releases"
UNIT = "[Service]\nExecStart=/opt/sparkline/venv/bin/{} --config /etc/sparkline/x.toml\n"


def install(root: Path, *, console: bool = True, agent: bool = True, bench: bool = False, version="0.1.0"):
    units = root / "etc/systemd/system"
    units.mkdir(parents=True, exist_ok=True)
    if console:
        (units / "sparkline.service").write_text(UNIT.format("sparkline"))
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

    def __init__(self, log: Path, version: str = "0.1.1", members: dict[str, str] | None = None):
        self.version = version
        script = f'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> {log}\n'
        self.tar = tarball(members or {f"sparkline-{version}/deploy/install.sh": script})
        self.sums = f"{hashlib.sha256(self.tar).hexdigest()}  sparkline-{version}.tar.gz\n"
        self.requested: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requested.append(path)
        name = f"sparkline-{self.version}.tar.gz"
        if path == "/releases/latest":
            assets = [
                {"name": n, "browser_download_url": f"https://dl.example.test/{n}"}
                for n in (name, "SHA256SUMS")
            ]
            return httpx.Response(200, json={"tag_name": f"v{self.version}", "assets": assets})
        if path == f"/{name}":
            return httpx.Response(200, content=self.tar)
        if path == "/SHA256SUMS":
            return httpx.Response(200, text=self.sums)
        return httpx.Response(404)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


@pytest.fixture
def as_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.geteuid", lambda: 0)


def run(root: Path, gh: FakeGitHub, *argv: str) -> int:
    env = {"SPARKLINE_UPDATE_ROOT": str(root), "SPARKLINE_RELEASES_API": API}
    return update.main(list(argv), env, gh.client())


def calls(log: Path) -> list[str]:
    return log.read_text().splitlines() if log.exists() else []


def test_an_up_to_date_host_downloads_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root, version="0.1.1")
    gh = FakeGitHub(log)
    assert run(root, gh) == 0
    assert "Sparkline 0.1.1 is up to date." in capsys.readouterr().out
    assert gh.requested == ["/releases/latest"]
    assert calls(log) == []


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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("os.geteuid", lambda: 1000)
    monkeypatch.setattr("sys.stdin", io.StringIO())
    root, log = tmp_path / "root", tmp_path / "install.log"
    install(root)
    gh = FakeGitHub(log)
    assert run(root, gh, "--yes") == 1
    assert "Run: sudo sparkline update" in capsys.readouterr().err
    assert gh.requested == ["/releases/latest"]


def test_non_root_on_a_terminal_reruns_the_venv_script_under_sudo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Tty(io.StringIO):
        def isatty(self) -> bool:
            return True

    def execvp(file: str, args: list[str]) -> None:
        raise SystemExit(args)

    monkeypatch.setattr("os.geteuid", lambda: 1000)
    monkeypatch.setattr("sys.stdin", Tty())
    monkeypatch.setattr("os.execvp", execvp)
    root = tmp_path / "root"
    install(root)
    with pytest.raises(SystemExit) as exec:
        run(root, FakeGitHub(tmp_path / "install.log"), "--yes")
    assert exec.value.code == ["sudo", str(Path(sys.executable).with_name("sparkline")), "update", "--yes"]


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
