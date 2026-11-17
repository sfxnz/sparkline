"""Notifier: which channel hears what, one message per batch, pacing and retry, what each kind sends, the
bounded shutdown, and that no channel secret leaves through a status, a Problem or a log (a stepped clock and
a scripted egress, no network and no real waiting)."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import get_args

import httpx
import pytest

from sparkline.common.schema import ChannelKind, Event, NotifyFailure
from sparkline.console import notify
from sparkline.console.egress import Egress, EgressError, Reply
from sparkline.console.notify import (
    FAILURES,
    KINDS,
    Clock,
    Message,
    Notice,
    Notifier,
    NotifierStopped,
    NotifyConfig,
)

T0 = 1_700_000_000.0
CANARY = "s3cr3t-canary"
URLS = {
    "ntfy": "https://ntfy.example/alerts",
    "discord": "https://discord.com/api/webhooks/1/abc",
    "slack": "https://hooks.slack.com/services/T/B/x",
    "webhook": "http://192.168.1.5:8123/api/webhook/x",
}


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


class SteppedClock(Clock):
    def __init__(self) -> None:
        self.t = T0
        self.timers: list[tuple[float, asyncio.Event]] = []

    def now(self) -> float:
        return self.t

    async def wait(self, wake: asyncio.Event, until: float | None) -> None:
        if until is not None and until <= self.t:
            return
        timer = asyncio.Event()
        if until is not None:
            self.timers.append((until, timer))
        racers = [asyncio.ensure_future(wake.wait()), asyncio.ensure_future(timer.wait())]
        try:
            await asyncio.wait(racers, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for r in racers:
                r.cancel()

    async def advance(self, seconds: float) -> None:
        self.t += seconds
        for until, timer in self.timers:
            if until <= self.t:
                timer.set()
        self.timers = [(until, timer) for until, timer in self.timers if until > self.t]
        await settle()


class ScriptedEgress:
    """Answers from ``script`` in turn, then 204. An exception is raised, an Event is waited on."""

    def __init__(self, script: list) -> None:
        self.script = script
        self.bodies: list[dict] = []
        self.closed = False

    async def post(self, body: dict) -> Reply:
        self.bodies.append(json.loads(json.dumps(body)))
        step = self.script.pop(0) if self.script else Reply(204, None)
        if isinstance(step, Exception):
            raise step
        if isinstance(step, asyncio.Event):
            await step.wait()
            return Reply(204, None)
        return step

    async def aclose(self) -> None:
        self.closed = True


def channel(name: str = "ops", kind: str = "webhook", **kw) -> NotifyConfig:
    return NotifyConfig(name=name, kind=kind, url=URLS[kind], **kw)


class Rig:
    def __init__(self, *configs: NotifyConfig, **scripts: list) -> None:
        self.clock = SteppedClock()
        self.egress = {c.name: ScriptedEgress(scripts.get(c.name, [])) for c in configs}
        made = iter(self.egress.values())
        self.notifier = Notifier(configs, egress=lambda endpoint: next(made), clock=self.clock)

    def bodies(self, name: str = "ops") -> list[dict]:
        return self.egress[name].bodies

    def status(self, name: str = "ops"):
        return next(s for s in self.notifier.status() if s.name == name)


@pytest.fixture
async def rig():
    rigs: list[Rig] = []

    async def make(*configs: NotifyConfig, **scripts: list) -> Rig:
        r = Rig(*configs, **scripts)
        rigs.append(r)
        r.notifier.start()
        await settle()
        return r

    yield make
    for r in rigs:
        await r.notifier.stop(grace_s=0)


def alert(rule: str = "gpu_temp_high", severity: str = "warning", node: str = "spark1", **kw) -> Event:
    fields = {
        "id": 1,
        "ts": T0,
        "node_id": node,
        "severity": severity,
        "kind": "alert",
        "rule_id": rule,
        "title": f"GPU temperature high on {node}",
        "detail": "87 °C for 10 s (threshold 85 °C)",
        "metric": "gpu0.temp_c",
        "value": 87.0,
    }
    return Event(**{**fields, **kw})


def recovery(of: Event, **kw) -> Event:
    fields = {
        "id": of.id + 1,
        "ts": of.ts,
        "severity": "info",
        "kind": "recovered",
        "title": f"Resolved: {of.title}",
        "detail": f"Now 71 °C · cleared after 3 min · was {of.severity}",
        "value": 71.0,
    }
    return of.model_copy(update={**fields, **kw})


def heard(body: dict) -> list[tuple[str, str, str]]:
    return [(n["status"], n["severity"], n["rule_id"]) for n in body["notices"]]


# -- routing ------------------------------------------------------------------------------------------


async def test_a_channel_hears_alerts_at_its_severity_and_above_and_a_recovery_follows_its_alert(rig):
    r = await rig(
        channel("all", min_severity="info"),
        channel("warn"),
        channel("crit", min_severity="critical"),
        channel("quiet", min_severity="warning", send_resolved=False),
    )
    info, warning = alert("fs_full", "info"), alert("gpu_temp_high", "warning")
    critical = alert("gpu_temp_critical", "critical")
    for ev in (info, warning, critical):
        r.notifier.publish(ev)
    await settle()
    await r.clock.advance(5)
    for ev in (info, warning, critical):
        r.notifier.publish(recovery(ev))
    await settle()
    fired = [("firing", "info", "fs_full"), ("firing", "warning", "gpu_temp_high")]
    fired.append(("firing", "critical", "gpu_temp_critical"))
    cleared = [("resolved", severity, rule) for _, severity, rule in fired]
    assert [heard(b) for b in r.bodies("all")] == [fired, cleared]
    assert [heard(b) for b in r.bodies("warn")] == [fired[1:], cleared[1:]]
    assert [heard(b) for b in r.bodies("crit")] == [fired[2:], cleared[2:]]
    assert [heard(b) for b in r.bodies("quiet")] == [fired[1:]]


async def test_alerts_on_two_gpus_of_one_rule_pair_with_their_own_recoveries(rig):
    r = await rig(channel(min_severity="critical"))
    gpu0 = alert("gpu_temp", "critical", metric="gpu0.temp_c")
    gpu1 = alert("gpu_temp", "warning", metric="gpu1.temp_c")
    r.notifier.publish(gpu0)
    r.notifier.publish(gpu1)
    r.notifier.publish(recovery(gpu1))
    r.notifier.publish(recovery(gpu0))
    await settle()
    assert [(n["status"], n["metric"]) for n in r.bodies()[0]["notices"]] == [
        ("firing", "gpu0.temp_c"),
        ("resolved", "gpu0.temp_c"),
    ]


async def test_only_alerts_and_recoveries_seen_firing_are_sent(rig):
    r = await rig(channel(min_severity="info"))
    r.notifier.publish(recovery(alert()))
    for kind in ("node", "bench", "system"):
        r.notifier.publish(alert(kind=kind))
    await settle()
    assert r.bodies() == []
    r.notifier.publish(alert())
    r.notifier.publish(recovery(alert()))
    r.notifier.publish(recovery(alert()))
    await settle()
    assert [heard(b) for b in r.bodies()] == [
        [("firing", "warning", "gpu_temp_high"), ("resolved", "warning", "gpu_temp_high")]
    ]


async def test_no_channel_builds_no_egress_and_sends_nothing():
    made: list[object] = []
    notifier = Notifier([], egress=made.append)
    notifier.start()
    notifier.publish(alert())
    await settle()
    assert made == [] and notifier.status() == []
    await notifier.stop()


# -- batching -----------------------------------------------------------------------------------------


async def test_everything_waiting_goes_out_as_one_message(rig):
    r = await rig(channel())
    for gpu in range(8):
        r.notifier.publish(
            alert(metric=f"gpu{gpu}.temp_c", title=f"GPU temperature high on spark1 · GPU {gpu}")
        )
    await settle()
    (body,) = r.bodies()
    assert len(body["notices"]) == 8 and body["title"] == "8 alerts" and body["more"] == 0
    assert body["text"].count("\n") == 7


async def test_sends_on_one_channel_are_at_least_a_second_apart(rig):
    r = await rig(channel())
    r.notifier.publish(alert(metric="gpu0.temp_c"))
    await settle()
    r.notifier.publish(alert(metric="gpu1.temp_c"))
    r.notifier.publish(alert(metric="gpu2.temp_c"))
    await r.clock.advance(0.9)
    assert len(r.bodies()) == 1 and r.status().pending == 2 and r.status().retry_at is None
    await r.clock.advance(0.2)
    assert [len(b["notices"]) for b in r.bodies()] == [1, 2] and r.status().pending == 0


async def test_past_fifty_waiting_notices_the_rest_are_counted_and_announced(rig):
    r = await rig(channel(), channel("team", "discord"))
    for n in range(57):
        r.notifier.publish(alert(metric=f"m{n}", title=f"Alert {n}", detail="x" * 40))
    assert r.status().pending == 57
    await settle()
    (digest,) = r.bodies()
    assert len(digest["notices"]) == 50 and digest["more"] == 7
    assert digest["title"] == "50 alerts" and digest["text"].endswith("\n… and 7 more")
    assert r.status().pending == 0

    content = r.bodies("team")[0]["content"]
    assert len(content) <= 2000
    shown = content.count("\nWarning: ")
    hidden = int(re.search(r"\n… and (\d+) more$", content)[1])
    assert shown < 50 and shown + hidden == 57


# -- retry and pacing ---------------------------------------------------------------------------------


async def test_a_429_keeps_the_notices_and_waits_as_long_as_the_service_asks(rig):
    r = await rig(channel(), ops=[Reply(429, 3.0)])
    r.notifier.publish(alert(metric="gpu0.temp_c"))
    await settle()
    st = r.status()
    assert (st.pending, st.retry_at) == (1, T0 + 3.0)
    assert (st.last.ok, st.last.failure, st.last.http_status) == (False, "rate_limited", 429)
    r.notifier.publish(alert(metric="gpu1.temp_c"))
    await r.clock.advance(2.9)
    assert len(r.bodies()) == 1
    await r.clock.advance(0.2)
    assert [len(b["notices"]) for b in r.bodies()] == [1, 2]
    st = r.status()
    assert (st.pending, st.retry_at, st.last.ok, st.last.notices) == (0, None, True, 2)


async def test_a_429_with_no_retry_after_waits_thirty_seconds(rig):
    r = await rig(channel(), ops=[Reply(429, None)])
    r.notifier.publish(alert())
    await settle()
    await r.clock.advance(29.9)
    assert len(r.bodies()) == 1
    await r.clock.advance(0.2)
    assert len(r.bodies()) == 2


@pytest.mark.parametrize(
    "transient",
    [Reply(500, None), Reply(503, None), *(EgressError(f) for f in ("connect", "dns", "tls", "timeout"))],
)
async def test_a_failure_that_may_pass_keeps_the_notices_and_backs_off_in_steps(rig, transient):
    r = await rig(channel(), ops=[transient, transient, transient])
    r.notifier.publish(alert())
    await settle()
    assert len(r.bodies()) == 1 and r.status().pending == 1 and not r.status().last.ok
    for sends, step in enumerate([5, 15, 60], start=1):
        await r.clock.advance(step * 0.79)
        assert len(r.bodies()) == sends
        await r.clock.advance(step * 0.42)
        assert len(r.bodies()) == sends + 1
    st = r.status()
    assert (st.pending, st.retry_at, st.last.ok) == (0, None, True)
    assert all(heard(b) == [("firing", "warning", "gpu_temp_high")] for b in r.bodies())


async def test_backoff_starts_over_after_a_delivery(rig):
    r = await rig(channel(), ops=[Reply(500, None), Reply(500, None), Reply(204, None), Reply(500, None)])
    r.notifier.publish(alert())
    await settle()
    await r.clock.advance(6.1)
    await r.clock.advance(18.1)
    assert len(r.bodies()) == 3 and r.status().last.ok
    r.notifier.publish(alert(metric="gpu1.temp_c"))
    await r.clock.advance(1.1)
    assert len(r.bodies()) == 4 and r.status().pending == 1
    await r.clock.advance(6.1)
    assert len(r.bodies()) == 5 and r.status().pending == 0


@pytest.mark.parametrize(
    ("answer", "failure", "status"),
    [
        (Reply(404, None), "rejected", 404),
        (Reply(401, None), "rejected", 401),
        (EgressError("redirect"), "redirect", None),
        (EgressError("address_refused"), "address_refused", None),
    ],
)
async def test_a_failure_that_cannot_pass_drops_the_notices(rig, answer, failure, status):
    r = await rig(channel(), ops=[answer])
    r.notifier.publish(alert())
    await settle()
    st = r.status()
    assert (st.pending, st.retry_at) == (0, None)
    assert (st.last.ok, st.last.failure, st.last.http_status, st.last.notices) == (False, failure, status, 1)
    await r.clock.advance(3600)
    assert len(r.bodies()) == 1
    r.notifier.publish(alert(metric="gpu1.temp_c"))
    await settle()
    assert len(r.bodies()) == 2 and r.status().last.ok


async def test_an_unknown_error_is_retried_and_only_its_type_is_logged(rig, caplog):
    r = await rig(channel(), ops=[RuntimeError(f"https://hooks.example/{CANARY}")])
    r.notifier.publish(alert())
    await settle()
    assert (r.status().pending, r.status().last.failure) == (1, "connect")
    assert "RuntimeError" in caplog.text and CANARY not in caplog.text


async def test_a_channel_that_hangs_does_not_delay_another(rig):
    r = await rig(channel("stuck"), channel("ops"), stuck=[asyncio.Event()])
    r.notifier.publish(alert())
    await settle()
    assert len(r.bodies("ops")) == 1 and r.status("ops").last.ok
    assert r.status("stuck").pending == 1 and r.status("stuck").last is None


# -- send test ----------------------------------------------------------------------------------------


async def test_a_test_is_sent_now_whatever_the_channel_severity_and_reports_in_the_row(rig):
    r = await rig(channel("phone", "ntfy", min_severity="critical"))
    st = await r.notifier.test("phone")
    assert (st.name, st.kind, st.host, st.min_severity, st.send_resolved) == (
        "phone",
        "ntfy",
        "ntfy.example",
        "critical",
        True,
    )
    assert (st.last.ok, st.last.test, st.last.notices, st.last.failure, st.last.problem) == (
        True,
        True,
        0,
        None,
        None,
    )
    (body,) = r.bodies("phone")
    assert body["title"] == "Sparkline test" and "'phone'" in body["message"]


async def test_a_failed_test_is_an_outcome_with_a_problem_and_is_not_retried(rig):
    r = await rig(channel("team", "discord"), team=[Reply(404, None)])
    st = await r.notifier.test("team")
    assert (st.last.ok, st.last.test, st.last.failure, st.last.http_status) == (False, True, "rejected", 404)
    assert st.last.problem.message == "Could not send to 'team'"
    assert st.last.problem.cause == "HTTP 404 from discord.com."
    assert "[[notify]] 'team'" in st.last.problem.fix
    await r.clock.advance(3600)
    assert len(r.bodies("team")) == 1 and st.pending == 0


async def test_a_test_skips_backoff_and_a_delivered_test_releases_what_is_waiting(rig):
    r = await rig(channel(), ops=[Reply(500, None), Reply(500, None)])
    r.notifier.publish(alert())
    await settle()
    await r.clock.advance(6.1)
    assert len(r.bodies()) == 2 and r.status().pending == 1
    st = await r.notifier.test("ops")
    assert st.last.ok and st.last.test and st.pending == 1
    await r.clock.advance(1.1)
    assert [len(b["notices"]) for b in r.bodies()] == [1, 1, 0, 1] and r.status().pending == 0


async def test_a_failed_test_leaves_the_backoff_as_it_was(rig):
    r = await rig(channel(), ops=[Reply(500, None), EgressError("connect")])
    r.notifier.publish(alert())
    await settle()
    retry_at = r.status().retry_at
    st = await r.notifier.test("ops")
    assert not st.last.ok and st.retry_at == retry_at
    await r.clock.advance(6.1)
    assert len(r.bodies()) == 3 and r.status().pending == 0


async def test_a_test_never_jumps_a_rate_limit(rig):
    r = await rig(channel(), ops=[Reply(429, 60.0)])
    r.notifier.publish(alert())
    await settle()
    st = await r.notifier.test("ops")
    assert (st.last.ok, st.last.test, st.last.failure) == (False, True, "rate_limited")
    assert len(r.bodies()) == 1 and st.pending == 1 and st.retry_at == T0 + 60.0


async def test_a_test_that_is_rate_limited_holds_the_channel_too(rig):
    r = await rig(channel(), ops=[Reply(429, 60.0)])
    assert (await r.notifier.test("ops")).last.failure == "rate_limited"
    r.notifier.publish(alert())
    await settle()
    await r.clock.advance(59)
    assert len(r.bodies()) == 1
    await r.clock.advance(1.1)
    assert len(r.bodies()) == 2


async def test_one_send_answers_every_click_that_was_waiting(rig):
    r = await rig(channel())
    rows = await asyncio.gather(*(r.notifier.test("ops") for _ in range(3)))
    assert len(r.bodies()) == 1 and all(row.last.ok and row.last.test for row in rows)


async def test_an_alert_that_is_waiting_goes_out_before_the_next_test(rig):
    r = await rig(channel())
    await r.notifier.test("ops")
    r.notifier.publish(alert())
    clicks = []
    for _ in range(3):
        clicks.append(asyncio.ensure_future(r.notifier.test("ops")))
        await settle()
        await r.clock.advance(1.1)
    assert [len(b["notices"]) for b in r.bodies()] == [0, 1, 0, 0] and r.status().pending == 0
    assert all(row.last.ok and row.last.test for row in await asyncio.gather(*clicks))


async def test_a_test_of_an_unknown_channel_or_a_stopped_notifier_raises(rig):
    r = await rig(channel())
    with pytest.raises(KeyError):
        await r.notifier.test("nope")
    await r.notifier.stop()
    with pytest.raises(NotifierStopped):
        await r.notifier.test("ops")
    with pytest.raises(NotifierStopped):
        await Notifier([channel()], egress=lambda endpoint: ScriptedEgress([])).test("ops")


# -- shutdown -----------------------------------------------------------------------------------------


async def test_stop_tries_once_more_what_is_backing_off_then_closes(rig):
    r = await rig(channel(), ops=[Reply(500, None)])
    r.notifier.publish(alert())
    await settle()
    assert r.status().pending == 1
    await r.notifier.stop()
    assert len(r.bodies()) == 2 and r.status().pending == 0 and r.egress["ops"].closed
    r.notifier.publish(alert(metric="gpu1.temp_c"))
    await settle()
    assert len(r.bodies()) == 2 and r.status().pending == 0
    await r.notifier.stop()


async def test_stop_does_not_send_into_a_rate_limit(rig, caplog):
    r = await rig(channel(), ops=[Reply(429, 60.0)])
    r.notifier.publish(alert())
    await settle()
    await r.notifier.stop()
    assert len(r.bodies()) == 1
    assert "notify 'ops': 1 notifications not sent before shutdown" in caplog.text


async def test_stop_returns_within_its_grace_when_a_channel_hangs(rig, caplog):
    r = await rig(channel("stuck"), channel("ops"), stuck=[asyncio.Event()])
    r.notifier.publish(alert())
    await settle()
    waiting = asyncio.ensure_future(r.notifier.test("stuck"))
    await settle()
    await asyncio.wait_for(r.notifier.stop(grace_s=0.05), 2)
    assert "notify 'stuck': 1 notifications not sent before shutdown" in caplog.text
    assert r.egress["stuck"].closed and r.egress["ops"].closed
    with pytest.raises(NotifierStopped):
        await waiting


# -- what each kind sends -----------------------------------------------------------------------------

HIGH = alert()
CRITICAL = alert(
    "gpu_temp_critical",
    "critical",
    title="GPU temperature critical on spark1 · GPU 1",
    detail="96 °C for 10 s (threshold 95 °C)",
    metric="gpu1.temp_c",
)
ONE = Message((Notice("firing", "warning", HIGH),))
CLEARED = Message((Notice("resolved", "warning", recovery(HIGH)),))
DIGEST = Message((Notice("firing", "critical", CRITICAL), Notice("resolved", "warning", recovery(HIGH))))
DIGEST_TEXT = (
    "Critical: GPU temperature critical on spark1 · GPU 1: 96 °C for 10 s (threshold 95 °C)\n"
    "Resolved: GPU temperature high on spark1: Now 71 °C · cleared after 3 min · was warning"
)
TEST = Message(test="Notifications to 'ops' work.")


def render(kind: str, msg: Message, now: float = T0) -> dict:
    return KINDS[kind].render(msg, now)


def test_ntfy_sends_title_message_priority_and_tag_and_leaves_the_topic_to_egress():
    assert render("ntfy", ONE) == {
        "title": "GPU temperature high on spark1",
        "message": "87 °C for 10 s (threshold 85 °C)",
        "priority": 4,
        "tags": ["warning"],
    }
    assert render("ntfy", DIGEST) == {
        "title": "1 alert, 1 resolved",
        "message": DIGEST_TEXT,
        "priority": 5,
        "tags": ["rotating_light"],
    }
    assert render("ntfy", CLEARED) == {
        "title": "Resolved: GPU temperature high on spark1",
        "message": "Now 71 °C · cleared after 3 min · was warning",
        "priority": 3,
        "tags": ["white_check_mark"],
    }
    assert render("ntfy", TEST)["title"] == "Sparkline test"
    assert render("ntfy", TEST)["message"] == "Notifications to 'ops' work."


def test_discord_sends_content_that_can_ping_nobody():
    assert render("discord", ONE) == {
        "content": "**GPU temperature high on spark1**\n87 °C for 10 s (threshold 85 °C)",
        "username": "Sparkline",
        "allowed_mentions": {"parse": []},
    }
    assert render("discord", DIGEST)["content"] == f"**1 alert, 1 resolved**\n{DIGEST_TEXT}"
    assert render("discord", TEST)["content"] == "**Sparkline test**\nNotifications to 'ops' work."


@pytest.mark.parametrize(
    ("raw", "sent"),
    [
        ("[Click to re-auth](https://evil.example/x)", r"\[Click to re-auth\](https://evil.example/x)"),
        ("**bold** _i_ ~~s~~ `code` ||spoiler||", r"\*\*bold\*\* \_i\_ \~\~s\~\~ \`code\` \|\|spoiler\|\|"),
        ("<@&123> <#5> <https://evil.example>", r"\<@&123\> \<\#5\> \<https://evil.example\>"),
        ("# heading", r"\# heading"),
        ("> quote", r"\> quote"),
        ("ends in \\", "ends in \\\\"),
    ],
)
def test_discord_shows_markup_in_a_title_or_a_detail_as_plain_text(raw, sent):
    one = Message((Notice("firing", "warning", alert(title=raw, detail=raw)),))
    assert render("discord", one)["content"] == f"**{sent}**\n{sent}"
    two, line = Message(one.notices * 2), f"Warning: {sent}: {sent}"
    assert render("discord", two)["content"] == f"**2 alerts**\n{line}\n{line}"


def test_discord_cuts_after_escaping_and_never_between_a_backslash_and_its_character():
    long = "a" + "*" * 2000
    one = Message((Notice("firing", "warning", alert(title=long, detail=long)),))
    assert render("discord", one)["content"] == "**a" + r"\*" * 74 + "**\na" + r"\*" * 899
    many = Message((Notice("firing", "warning", alert(detail="_" * 100)),) * 30)
    line = "Warning: GPU temperature high on spark1: " + r"\_" * 100
    content = render("discord", many)["content"]
    assert content == "\n".join(["**30 alerts**", *[line] * 7, "… and 23 more"]) and len(content) <= 2000


def test_slack_sends_text_with_its_three_characters_escaped():
    assert render("slack", ONE) == {
        "text": "*GPU temperature high on spark1*\n87 °C for 10 s (threshold 85 °C)"
    }
    odd = Message((Notice("firing", "warning", alert(title="<!channel> a&b", detail="x > y")),))
    assert render("slack", odd) == {"text": "*&lt;!channel&gt; a&amp;b*\nx &gt; y"}


def test_webhook_sends_a_versioned_shape_with_every_notice_and_the_alert_severity():
    assert render("webhook", DIGEST) == {
        "source": "sparkline",
        "version": 1,
        "test": False,
        "title": "1 alert, 1 resolved",
        "text": DIGEST_TEXT,
        "more": 0,
        "notices": [
            {
                "id": 1,
                "ts": T0,
                "node_id": "spark1",
                "kind": "alert",
                "rule_id": "gpu_temp_critical",
                "title": "GPU temperature critical on spark1 · GPU 1",
                "detail": "96 °C for 10 s (threshold 95 °C)",
                "metric": "gpu1.temp_c",
                "value": 87.0,
                "status": "firing",
                "severity": "critical",
            },
            {
                "id": 2,
                "ts": T0,
                "node_id": "spark1",
                "kind": "recovered",
                "rule_id": "gpu_temp_high",
                "title": "Resolved: GPU temperature high on spark1",
                "detail": "Now 71 °C · cleared after 3 min · was warning",
                "metric": "gpu0.temp_c",
                "value": 71.0,
                "status": "resolved",
                "severity": "warning",
            },
        ],
    }
    test = render("webhook", TEST)
    assert (test["test"], test["notices"], test["title"]) == (True, [], "Sparkline test")


def test_a_notice_sent_late_says_when_its_event_happened():
    assert render("slack", ONE, T0 + 60)["text"].endswith("(threshold 85 °C)")
    late = render("slack", ONE, T0 + 7 * 60)["text"]
    assert re.search(r"\(threshold 85 °C\) \(\d\d:\d\d, 7 min ago\)$", late)
    assert re.search(r"\(\d\d:\d\d, 3 h ago\)\n", render("slack", DIGEST, T0 + 3 * 3600)["text"])


def test_every_kind_and_every_failure_has_its_row():
    assert set(KINDS) == set(get_args(ChannelKind))
    assert set(FAILURES) == set(get_args(NotifyFailure))
    for failure in FAILURES:
        p = notify.problem_for("ops", "hooks.example", failure, 418)
        assert p.message and p.cause and p.fix and "{" not in p.cause + p.fix


# -- secrets ------------------------------------------------------------------------------------------


async def test_no_channel_secret_leaves_through_a_status_a_problem_or_a_log(caplog):
    caplog.set_level(logging.DEBUG)
    answers = [204, 404, 302, 429, 500, httpx.ConnectError(f"refused https://hooks.example/{CANARY}"), 204]

    def handle(request: httpx.Request) -> httpx.Response:
        step = answers.pop(0) if answers else 204
        if isinstance(step, Exception):
            raise step
        return httpx.Response(step, headers={"Location": f"/{CANARY}", "Retry-After": "1"}, text=CANARY)

    async def resolve(host: str, port: int) -> list[str]:
        return ["203.0.113.7"]

    configs = [
        NotifyConfig(
            name="hook", kind="webhook", url=f"https://hooks.example/{CANARY}?k={CANARY}", token=CANARY
        ),
        NotifyConfig(name="phone", kind="ntfy", url=f"https://ntfy.example/{CANARY}", token=CANARY),
    ]
    clock = SteppedClock()
    notifier = Notifier(
        configs,
        egress=lambda endpoint: Egress(endpoint, resolver=resolve, transport=httpx.MockTransport(handle)),
        clock=clock,
    )
    notifier.start()
    shown: list[str] = [repr(configs)]
    failures: set[str | None] = set()

    def look(rows: list) -> None:
        shown.extend(row.model_dump_json() for row in rows)
        failures.update(row.last.failure for row in rows if row.last)

    for n in range(8):
        notifier.publish(alert(metric=f"m{n}"))
        await settle()
        look(notifier.status())
        await clock.advance(400)
        look(notifier.status())
        tests = [asyncio.ensure_future(notifier.test(name)) for name in ("hook", "phone")]
        await clock.advance(2)
        look(await asyncio.gather(*tests))
    await notifier.stop()
    assert failures >= {None, "rejected", "redirect", "rate_limited", "server_error", "connect"}
    assert CANARY not in "\n".join(shown)
    assert CANARY not in caplog.text
    assert "notify 'hook'" in caplog.text
