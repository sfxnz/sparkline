"""What deploy/install.sh tells the person who ran it: the node a console shows when none is named, and how
each install ends. The real installer runs into a stage (--destdir) from a stand-in checkout that has a built
web app, with a stand-in `uv` whose venv is this interpreter: no network, no root, no systemd."""

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


def ending(out: str) -> list[str]:
    """The summary: every line after the last `==>` heading."""
    return out.rstrip("\n").rpartition("\n==> ")[2].split("\n")[1:]


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
    assert ending(out)[:2] == [
        "    Nodes:          n1        http://192.0.2.11:9750",
        "                    node-two  http://192.0.2.12:9750",
    ]


def test_a_console_with_no_agent_and_no_nodes_stops_first_and_names_both_ways_forward(host: Host) -> None:
    r = subprocess.run(host.command("console"), env=host.env, capture_output=True, text=True)
    script = host.checkout / "deploy/install.sh"
    assert r.returncode == 1
    assert "there is no agent on this host" in r.stderr
    assert f"  Install the agent here first:   {script} agent --destdir {host.stage}\n" in r.stderr
    assert f"  Or name the agents elsewhere:   {script} console --destdir {host.stage} --nodes " in r.stderr
    assert not host.stage.exists()


def test_the_first_agent_ends_with_the_console_command_then_the_other_nodes(host: Host) -> None:
    out = host.install("agent", *AGENT)
    lines = ending(out)
    node = host.config("agent.toml")["node_id"]
    console = f"{host.checkout / 'deploy/install.sh'} console --destdir {host.stage}"
    assert lines[0] == "    Listening on:  http://127.0.0.1:9829"
    following = lines.index("    Next: install the console on this host. It finds this agent by itself.")
    assert lines[following + 1 : following + 3] == [f"      {console}", ""]
    others = lines.index(
        "    More than one Spark? Install the agent on the others before the console, with this"
    )
    assert others == following + 3
    token = lines.index("      Agent token:  not printed, because this output is not a terminal. To read it:")
    assert lines[token + 1] == f"                    sudo grep ^token {host.stage}/etc/sparkline/agent.toml"
    assert lines[-1] == f"      {console} --nodes {node}=http://127.0.0.1:9829,<id>=<URL>"


def test_an_agent_given_the_token_ends_with_its_pair_for_the_console(host: Host) -> None:
    out = host.install("agent", *AGENT, agent_token="t" * 43)
    node = host.config("agent.toml")["node_id"]
    assert "    Next: add this node to the console.\n" in out
    assert f"        {node}=http://127.0.0.1:9829\n" in out
    assert f'        id = "{node}"\n        url = "http://127.0.0.1:9829"\n' in out
    assert "install the console on this host" not in out and "Agent token" not in out


def test_an_agent_where_a_console_is_installed_ends_without_the_console_command(host: Host) -> None:
    host.install("console", *CONSOLE, "--nodes", OTHER_NODES)
    out = host.install("agent", *AGENT)
    assert f"    Next: make sure the console on this host knows this node. In {host.stage}" in out
    assert "install.sh console" not in out


def test_no_next_steps_leaves_only_the_facts(host: Host) -> None:
    lines = ending(host.install("agent", *AGENT, "--no-next-steps"))
    assert [line.split(":")[0] for line in lines] == ["    Listening on", "    Benchmarks"]


def test_on_a_terminal_the_console_ends_with_a_sign_in_link(host: Host) -> None:
    host.install("agent", *AGENT)
    node = host.config("agent.toml")["node_id"]
    out = host.install_on_a_terminal("console", *CONSOLE)
    console = host.config("console.toml")
    assert ending(out)[:3] == [
        f"    Nodes:          {node}  http://127.0.0.1:9829",
        "    Console:        http://127.0.0.1:9828",
        f"    Console token:  {console['token']}",
    ]
    assert ending(out)[-4:] == [
        "    Next: open this link to sign in. It carries the console token, so keep it private.",
        f"      http://127.0.0.1:9828/login#token={console['token']}",
        "    On another device, open the console address above and type the console token.",
        f"    You should see {node}, live.",
    ]
    assert console["agent_token"] not in out  # the nodes already have it: nothing to copy


def test_off_a_terminal_the_console_prints_no_token_and_says_where_it_is(host: Host) -> None:
    host.install("agent", *AGENT)
    node = host.config("agent.toml")["node_id"]
    out = host.install("console", *CONSOLE)
    console = host.config("console.toml")
    assert console["token"] not in out and console["agent_token"] not in out
    assert "/login" not in out
    lines = ending(out)
    token = lines.index("    Console token:  not printed, because this output is not a terminal. To read it:")
    assert lines[token + 1] == f"                    sudo grep ^token {host.stage}/etc/sparkline/console.toml"
    assert ending(out)[-2:] == [
        "    Next: open http://127.0.0.1:9828 and sign in with the console token.",
        f"    You should see {node}, live.",
    ]


def test_an_agent_token_the_console_made_up_is_shown_to_copy_to_the_nodes(host: Host) -> None:
    out = host.install_on_a_terminal("console", *CONSOLE, "--nodes", OTHER_NODES)
    console = host.config("console.toml")
    lines = ending(out)
    assert f"      Agent token:  {console['agent_token']}" in lines
    before_sign_in = lines.index(
        "    Before you sign in: the agents refuse this console until they share its agent token."
    )
    assert before_sign_in < lines.index(f"      http://127.0.0.1:9828/login#token={console['token']}")
    assert lines[-1] == "    You should see your 2 nodes, live."
    rerun = host.install_on_a_terminal("console")
    assert console["token"] not in rerun and console["agent_token"] not in rerun


def test_a_rerun_on_an_existing_install_stays_short(host: Host) -> None:
    host.install("agent", *AGENT)
    host.install("console", *CONSOLE)
    assert ending(host.install_on_a_terminal("agent")) == [
        "    Listening on:  http://127.0.0.1:9829",
        "    Benchmarks:    off (monitor-only). Re-run with --enable-benchmarks to allow them.",
    ]
    rerun = host.install_on_a_terminal("console")
    assert ending(rerun) == [
        "    Console:        http://127.0.0.1:9828",
        "    Sign in:        with the console token, which is unchanged "
        f"(sudo grep ^token {host.stage}/etc/sparkline/console.toml)",
    ]
    assert host.config("console.toml")["token"] not in rerun


def test_a_dry_run_shows_the_node_and_no_token_and_says_how_to_apply_it(host: Host) -> None:
    host.install("agent", *AGENT)
    agent = host.config("agent.toml")
    out = host.install_on_a_terminal("console", *CONSOLE, "--dry-run")
    assert f'        | id = "{agent["node_id"]}"\n        | url = "http://127.0.0.1:9829"\n' in out
    assert agent["token"] not in out
    assert ending(out) == ["    To apply it, run the same command without --dry-run."]
    assert not (host.stage / "etc/sparkline/console.toml").exists()
