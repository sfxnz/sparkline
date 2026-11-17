"""What deploy/install.sh tells the person who ran it: the node a console shows when none is named. The real
installer runs into a stage (--destdir) from a stand-in checkout that has a built web app, with a stand-in
`uv` whose venv is this interpreter: no network, no root, no systemd."""

from __future__ import annotations

import os
import pty
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
AGENT = ("--bind", "127.0.0.1", "--port", "9829")
CONSOLE = ("--bind", "127.0.0.1", "--port", "9828")
OTHER_NODES = "n1=http://192.0.2.11:9750,node-two=http://192.0.2.12:9750"

FAKE_UV = f"""#!/bin/sh
# `uv venv ... DIR` makes DIR/bin/python run the interpreter of this test run. `uv pip ...` installs nothing.
[ "$1" = venv ] || exit 0
for venv; do :; done
mkdir -p "$venv/bin" "$venv/lib"
printf '#!/bin/sh\\nexec "{sys.executable}" "$@"\\n' > "$venv/bin/python"
chmod +x "$venv/bin/python"
"""


class Host:
    """One machine to install on: a checkout and an empty stage."""

    def __init__(self, tmp_path: Path) -> None:
        self.stage = tmp_path / "stage"
        self.checkout = tmp_path / "checkout"
        (self.checkout / "web/dist").mkdir(parents=True)
        (self.checkout / "web/dist/index.html").write_text("<!doctype html>")
        for part in ("deploy", "server"):
            (self.checkout / part).symlink_to(REPO / part)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        (bin_dir / "uv").write_text(FAKE_UV)
        (bin_dir / "uv").chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "PYTHON": sys.executable}
        self.env.pop("SPARKLINE_AGENT_TOKEN", None)

    def command(self, *args: str) -> list[str]:
        return ["bash", str(self.checkout / "deploy/install.sh"), *args, "--destdir", str(self.stage)]

    def install(self, *args: str, agent_token: str = "") -> str:
        """Standard output of an install whose output is piped, as under `| tee` or in CI."""
        env = {**self.env, "SPARKLINE_AGENT_TOKEN": agent_token}
        return subprocess.run(self.command(*args), env=env, capture_output=True, text=True, check=True).stdout

    def install_on_a_terminal(self, *args: str) -> str:
        """Standard output of an install whose output is an interactive terminal."""
        master, slave = pty.openpty()
        chunks = []
        with subprocess.Popen(
            self.command(*args),
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=slave,
            stderr=subprocess.DEVNULL,
        ) as proc:
            os.close(slave)
            while True:
                try:
                    data = os.read(master, 4096)
                except OSError:  # EIO: the installer has exited and closed the terminal
                    break
                if not data:
                    break
                chunks.append(data)
        os.close(master)
        assert proc.returncode == 0
        return b"".join(chunks).decode().replace("\r\n", "\n")

    def config(self, name: str) -> dict:
        with (self.stage / "etc/sparkline" / name).open("rb") as f:
            return tomllib.load(f)


@pytest.fixture
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def test_a_console_without_nodes_shows_the_agent_on_this_host(host: Host) -> None:
    host.install("agent", *AGENT)
    agent = host.config("agent.toml")
    out = host.install("console", *CONSOLE)
    console = host.config("console.toml")
    assert console["nodes"] == [{"id": agent["node_id"], "url": "http://127.0.0.1:9829"}]
    assert console["agent_token"] == agent["token"]
    assert (
        f"    no --nodes: showing the agent on this host, {agent['node_id']} at http://127.0.0.1:9829\n"
        in out
    )


def test_nodes_names_the_nodes_even_where_an_agent_is_installed(host: Host) -> None:
    host.install("agent", *AGENT)
    out = host.install("console", *CONSOLE, "--nodes", OTHER_NODES)
    assert host.config("console.toml")["nodes"] == [
        {"id": "n1", "url": "http://192.0.2.11:9750"},
        {"id": "node-two", "url": "http://192.0.2.12:9750"},
    ]
    assert "no --nodes" not in out


def test_a_console_with_no_agent_and_no_nodes_stops_first_and_names_both_ways_forward(host: Host) -> None:
    r = subprocess.run(host.command("console"), env=host.env, capture_output=True, text=True)
    script = host.checkout / "deploy/install.sh"
    assert r.returncode == 1
    assert "there is no agent on this host" in r.stderr
    assert f"  Install the agent here first:   {script} agent --destdir {host.stage}\n" in r.stderr
    assert f"  Or name the agents elsewhere:   {script} console --destdir {host.stage} --nodes " in r.stderr
    assert not host.stage.exists()
