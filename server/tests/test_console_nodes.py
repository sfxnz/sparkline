from __future__ import annotations

import asyncio
import errno
import json
import re
import socket
import time
from pathlib import Path
from typing import cast

import httpx
import pytest

from sparkline.agent.app import create_app as create_agent_app
from sparkline.agent.sampler import Sampler
from sparkline.common.schema import ConsoleSettings, NodeInfo, NodeStatus, Sample
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
    assert st == "error" and "schema_version 2" in p.cause and "`sudo sparkline update`" in p.fix

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
        "If it does not stay up, read why: `journalctl -u sparkline-agent -n 50`."
    )
    # A node that has never answered may have no agent at all: the install command comes last.
    _, p = classify(refused, "spark2", URL, new=True)
    assert _commands(p.fix) == [
        "sudo systemctl start sparkline-agent",
        "journalctl -u sparkline-agent -n 50",
        "sudo ./install.sh agent",
    ]
    assert p.fix.endswith(
        " If the agent was never installed on spark2, install it from the Sparkline folder there: "
        "`sudo ./install.sh agent`."
    )


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


def test_every_fix_is_steps_that_end_with_a_full_stop_and_a_command_ends_its_step_after_a_colon():
    """One rule, so the web can show each step's words and put its command in a box of its own, once."""
    from websockets.exceptions import ConnectionClosedError, InvalidMessage
    from websockets.frames import Close

    class Response:
        status_code = 404

    refused = ConnectionRefusedError(errno.ECONNREFUSED, "refused")
    causes = [
        (refused, False),
        (refused, True),
        (AuthRejected(401), True),
        (AuthRejected(403), False),
        (type("InvalidStatus", (Exception,), {"response": Response()})(), True),
        (SchemaMismatch(2), False),
        (socket.gaierror(socket.EAI_NONAME, "Name or service not known"), True),
        (HandshakeTimeout(), True),
        (httpx.ReadTimeout("timed out"), False),
        (TimeoutError(), True),
        (httpx.ConnectTimeout("timed out"), False),
        (OSError(errno.EHOSTUNREACH, "No route to host"), True),
        (ConnectionClosedError(None, Close(1011, "keepalive ping timeout")), False),
        (InvalidMessage("did not receive a valid HTTP response"), True),
        (StreamClosed("code 1012"), False),
        (ValueError("boom"), True),
    ]
    messages = set()
    for exc, new in causes:
        _, p = classify(exc, "spark2", "http://spark2.lan:9750", new)
        messages.add(p.message)
        # A step ends at a full stop that a space or the end follows, outside backticks (web: fixSteps).
        steps = re.findall(r"(?:`[^`]*`|[^`.]|\.(?!\s|$))+\.?", p.fix)
        assert "".join(steps) == p.fix, p.fix
        for step in steps:
            assert step.endswith("."), (step, p.fix)
            commands = _commands(step)
            assert len(commands) <= 1, step
            if commands:
                assert step.endswith(f": `{commands[0]}`."), step
    assert len(messages) == 9  # every message classify() has
    _, timed_out = classify(TimeoutError(), "spark2", URL)
    assert _commands(timed_out.fix) == ["journalctl -u sparkline-agent -n 50"]


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


def test_a_node_is_retried_within_seconds_until_its_first_answer_and_backs_off_to_30_s_after(tmp_path):
    """Someone setting a node up is watching the page: starting its agent must show within about 5 s."""
    info = json.loads((Path(__file__).parent / "fixtures/console/node_info.json").read_text())
    sample = json.loads((Path(__file__).parent / "fixtures/console/sample.json").read_text())
    cluster = Cluster(Store(tmp_path / "c.sqlite"), Hub(), ConsoleSettings())
    src = NodeSource("n", URL, cluster)
    cluster.add_source(src)

    def waits(status: NodeStatus) -> list[float]:
        out = []
        for src._attempt in range(12):
            out.append(src.backoff_delay(status))
        return out

    never_answered = waits("offline")
    assert never_answered[0] <= 1.2 and max(never_answered) == 5.0, never_answered
    turned_away = waits("error")
    assert turned_away[0] <= 1.2 and max(turned_away) == 10.0, turned_away
    src.got_hello(NodeInfo.model_validate(info))
    src.got_sample(Sample.model_validate(sample))
    assert src.state.first_seen is not None
    for status in ("offline", "error"):
        answered_once = waits(status)
        assert answered_once[0] <= 1.2 and max(answered_once) == 30.0, answered_once


async def test_a_new_node_that_rejects_the_token_is_tried_again_later_than_one_that_does_not_answer(tmp_path):
    class Refusing(NodeSource):
        async def session(self) -> None:
            raise ConnectionRefusedError(errno.ECONNREFUSED, "refused")

    class Rejecting(NodeSource):
        async def session(self) -> None:
            raise AuthRejected(403)

    cluster = Cluster(Store(tmp_path / "c.sqlite"), Hub(), ConsoleSettings())
    for source, wait in ((Refusing, 5.0), (Rejecting, 10.0)):
        src = source("n", URL, cluster)
        src._attempt = 8  # well into its retries
        task = asyncio.create_task(src.run())
        try:
            while src.state.next_retry_ts is None:
                await asyncio.sleep(0.01)
        finally:
            task.cancel()
        assert src.state.next_retry_ts - time.time() == pytest.approx(wait, abs=0.5), source.__name__


async def test_retry_now_is_one_try_at_once_and_does_not_restart_the_doubling(tmp_path):
    tries: list[float] = []

    class Rejecting(NodeSource):
        async def session(self) -> None:
            tries.append(time.time())
            raise AuthRejected(403)

    async def waiting_after(n: int) -> None:
        while len(tries) < n or (src.state.next_retry_ts or 0) <= time.time():
            await asyncio.sleep(0.01)

    src = Rejecting("n", URL, Cluster(Store(tmp_path / "c.sqlite"), Hub(), ConsoleSettings()))
    src._attempt = 8  # well into its retries
    task = asyncio.create_task(src.run())
    try:
        await asyncio.wait_for(waiting_after(1), 2)
        src.retry_now()
        assert src.state.next_retry_ts is None  # the card has nothing to count down to: it is trying
        await asyncio.wait_for(waiting_after(2), 2)
    finally:
        task.cancel()
    assert len(tries) == 2
    assert src.state.next_retry_ts - time.time() == pytest.approx(10.0, abs=0.5)


async def test_a_console_with_the_wrong_token_never_spends_the_agents_last_wrong_try(tmp_path, monkeypatch):
    """The agent counts wrong tokens per client IP and, once it holds FAIL_LIMIT of the last minute, turns
    the next request away before it looks at its token: a corrected token is refused too. Here the agent's
    own app answers a console that has the wrong token for ten minutes, while "Retry" is pressed twice a
    second. Whenever the token is corrected, the agent accepts it, and each try starts when the node's state
    said it would."""
    info = NodeInfo.model_validate_json(
        (Path(__file__).parent / "fixtures/console/node_info.json").read_text()
    )
    app = create_agent_app(cast(Sampler, None), lambda: info, "the-agent-token", manage_sampler=False)
    agent = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent")
    start = now = 1000.0
    monkeypatch.setattr(time, "time", lambda: now)
    answers: list[int] = []
    right_token: list[int] = []
    late: list[float] = []
    over = asyncio.Event()

    async def ask(token: str) -> int:
        return (await agent.get("/api/v1/info", headers={"Authorization": f"Bearer {token}"})).status_code

    class WrongToken(NodeSource):
        async def session(self) -> None:
            if now - start > 600:
                over.set()
                await asyncio.Event().wait()
            if self.state.next_retry_ts is not None:
                late.append(now - self.state.next_retry_ts)
            answers.append(await ask("not-the-agent-token"))
            right_token.append(await ask("the-agent-token"))
            raise AuthRejected(answers[-1])

    async def time_passes(waiting, timeout: float) -> None:
        nonlocal now
        waiting.close()
        step = min(timeout, 0.5)
        now += step
        if step == timeout:
            raise TimeoutError
        src.retry_now()

    src = WrongToken("n", URL, Cluster(Store(tmp_path / "c.sqlite"), Hub(), ConsoleSettings()))
    monkeypatch.setattr(asyncio, "wait_for", time_passes)
    task = asyncio.create_task(src.run())
    try:
        await over.wait()
    finally:
        task.cancel()
        await agent.aclose()
    assert set(right_token) == {200}, right_token  # asked after every try, as a corrected console would
    assert set(answers) == {401}  # each one a check of the token, none the agent's "too many"
    assert len(answers) > 80  # the console still uses the tries it has: 9 in a minute and a second
    assert max(map(abs, late)) < 1e-6  # each try started when the state said it would


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
