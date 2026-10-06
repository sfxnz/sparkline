from __future__ import annotations

import errno
import json
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

URL = "http://10.20.20.195:9750"


def test_problem_mapping():
    st, p = classify(ConnectionRefusedError(errno.ECONNREFUSED, "refused"), "spark2", URL)
    assert (st, p.message, p.cause) == (
        "offline",
        "Agent unreachable on spark2",
        "Connection refused at 10.20.20.195:9750",
    )
    assert p.fix == "Check `systemctl status sparkline-agent` on spark2"

    st, p = classify(TimeoutError(), "spark2", URL)
    assert st == "offline" and "timed out" in p.cause and "firewall" in p.fix
    st, p = classify(OSError(errno.EHOSTUNREACH, "No route to host"), "spark2", URL)
    assert st == "offline" and "no route to host" in p.cause

    st, p = classify(AuthRejected(401), "spark2", URL)
    assert st == "error" and "token mismatch" in p.cause
    assert p.fix == (
        "agent_token in /etc/sparkline/console.toml must match token in /etc/sparkline/agent.toml on spark2"
    )

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
