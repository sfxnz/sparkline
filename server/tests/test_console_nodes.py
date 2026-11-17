from __future__ import annotations

import asyncio
import errno
import json
import re
import socket
import time
from pathlib import Path

import httpx

from sparkline.common.schema import ConsoleSettings, NodeInfo
from sparkline.console.cluster import Cluster
from sparkline.console.hub import Hub
from sparkline.console.nodes import (
    AuthRejected,
    HandshakeTimeout,
    NodeSource,
    SchemaMismatch,
    StreamClosed,
    classify,
)
from sparkline.console.store import Store

URL = "http://198.51.100.195:9750"


def test_problem_mapping():
    st, p = classify(ConnectionRefusedError(errno.ECONNREFUSED, "refused"), "spark2", URL)
    assert (st, p.message, p.cause) == (
        "offline",
        "Agent unreachable on spark2",
        "Connection refused at 198.51.100.195:9750",
    )
    assert p.fix.startswith("Start the agent on spark2: `sudo systemctl start sparkline-agent`.")

    st, p = classify(TimeoutError(), "spark2", URL)
    assert st == "offline" and "timed out" in p.cause and "firewall" in p.fix
    st, p = classify(OSError(errno.EHOSTUNREACH, "No route to host"), "spark2", URL)
    assert st == "offline" and "no route to host" in p.cause

    st, p = classify(AuthRejected(401), "spark2", URL)
    assert st == "error" and "token mismatch" in p.cause
    assert p.message == "Agent on spark2 rejected the console’s token"

    st, p = classify(SchemaMismatch(2), "spark2", URL)
    assert st == "error" and "schema_version 2" in p.cause and "Upgrade" in p.fix

    st, p = classify(
        socket.gaierror(socket.EAI_NONAME, "Name or service not known"), "spark2", "http://spark2.lan:9750"
    )
    assert st == "offline" and p.message == "Cannot resolve spark2.lan"

    st, p = classify(StreamClosed("code 1012"), "spark2", URL)
    assert st == "offline" and p.message == "Lost connection to agent on spark2"

    from websockets.exceptions import ConnectionClosedError, InvalidMessage
    from websockets.frames import Close

    ping = ConnectionClosedError(None, Close(1011, "keepalive ping timeout"))  # as seen live
    st, p = classify(ping, "spark2", URL)
    assert st == "offline" and p.message == "Agent on spark2 stopped responding" and "keepalive" in p.cause
    st, p = classify(InvalidMessage("did not receive a valid HTTP response"), "spark2", URL)
    assert st == "offline" and p.message == "Agent on spark2 is not answering"

    # TCP accepted but no answer = hung agent, not a network problem; httpx timeouts are mapped too
    for exc in (HandshakeTimeout(), httpx.ReadTimeout("timed out")):
        st, p = classify(exc, "spark2", URL)
        assert (st, p.message) == ("offline", "Agent on spark2 is not answering"), exc
        assert "accepted the connection" in p.cause and "journalctl -u sparkline-agent" in p.fix
    st, p = classify(httpx.ConnectTimeout("timed out"), "spark2", URL)
    assert p.message == "Agent unreachable on spark2" and "firewall" in p.fix

    st, p = classify(ValueError("boom"), "spark2", URL)
    assert st == "error" and p.cause == "ValueError: boom"


def _commands(fix: str) -> list[str]:
    """What the web shows with a copy button: the backtick spans of several words."""
    return [span for span in re.findall("`([^`]*)`", fix) if " " in span]


def test_a_refused_agent_is_told_what_to_run_not_what_to_look_at():
    refused = ConnectionRefusedError(errno.ECONNREFUSED, "refused")
    _, p = classify(refused, "spark2", URL)
    assert p.fix == (
        "Start the agent on spark2: `sudo systemctl start sparkline-agent`. "
        "If it does not stay up, `journalctl -u sparkline-agent -n 50` says why."
    )
    # A node that has never answered may have no agent at all: the install command comes last.
    _, p = classify(refused, "spark2", URL, new=True)
    assert _commands(p.fix) == [
        "sudo systemctl start sparkline-agent",
        "journalctl -u sparkline-agent -n 50",
        "sudo ./install.sh agent",
    ]
    assert "If the agent was never installed on spark2, run `sudo ./install.sh agent`" in p.fix


def test_a_rejected_token_says_how_to_compare_the_tokens_and_what_to_restart():
    for status in (401, 403):
        _, p = classify(AuthRejected(status), "spark2", URL)
        assert _commands(p.fix) == [
            "sudo grep token /etc/sparkline/*.toml",
            "sudo systemctl restart sparkline",
            "sudo systemctl restart sparkline-agent",
        ]
        for name in ("agent_token", "/etc/sparkline/console.toml", "token", "/etc/sparkline/agent.toml"):
            assert f"`{name}`" in p.fix, name
        assert "then restart its service" in p.fix


def test_every_fix_that_edits_the_console_config_says_to_restart_the_console():
    """The console reads console.toml once, at start: an edit alone changes nothing."""

    class Response:
        status_code = 404

    wrong_url = type("InvalidStatus", (Exception,), {"response": Response()})()
    unresolved = socket.gaierror(socket.EAI_NONAME, "Name or service not known")
    for exc in (AuthRejected(403), wrong_url, unresolved):
        _, p = classify(exc, "spark2", "http://spark2.lan:9750")
        assert "`/etc/sparkline/console.toml`" in p.fix, p.fix
        assert "`sudo systemctl restart sparkline`" in p.fix, p.fix


async def test_only_a_node_that_has_never_answered_is_told_how_to_install_the_agent(tmp_path):
    class Refusing(NodeSource):
        async def session(self) -> None:
            raise ConnectionRefusedError(errno.ECONNREFUSED, "refused")

    cluster = Cluster(Store(tmp_path / "c.sqlite"), Hub(), ConsoleSettings())
    fixes = {}
    for name, first_seen in (("new", None), ("known", 1.0)):
        src = Refusing(name, URL, cluster)
        src.state.first_seen = first_seen
        task = asyncio.create_task(src.run())
        try:
            while src.state.error is None:
                await asyncio.sleep(0.01)
        finally:
            task.cancel()
        fixes[name] = src.state.error.fix
    assert "sudo ./install.sh agent" in fixes["new"]
    assert "install" not in fixes["known"] and fixes["known"].startswith("Start the agent on known")


def test_stale_threshold_respects_the_agent_interval(tmp_path):
    """At the agent's max interval (5 s) a normal 5.x s gap is not 'stale' under the 5 s default."""
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    cluster = Cluster(Store(tmp_path / "c.sqlite"), Hub(), ConsoleSettings())
    src = NodeSource("n", URL, cluster)
    src.got_hello(NodeInfo.model_validate(dict(info, sample_interval_ms=5000)))
    src.set_status("online", None, None)
    now = time.time()
    src.connected_at, src.state.last_sample_ts = now - 60, now - 5.6
    cluster._check(src, now)
    assert src.state.status == "online"
    cluster._check(src, now + 6)  # 11.6 s > 2 intervals + 1 s
    assert src.state.status == "stale"
