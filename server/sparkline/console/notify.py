"""Outbound alert notifications: alerts and recoveries, sent to the ``[[notify]]`` channels in console.toml.

Public API: ``NotifyConfig``, ``Notifier`` (``publish``, ``start``, ``stop``, ``status``, ``test``),
``NotifierStopped``, ``Clock``, and the ``KINDS`` and ``FAILURES`` tables.

Each channel has one worker task that owns its mailbox, its pacing and its last result, so a channel that is
down never delays another and nothing needs a lock. A worker sends everything waiting as one message: eight
GPUs crossing a threshold in one tick are one message, and a channel that is down collects a bounded digest.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from ..common.schema import (
    ChannelKind,
    Event,
    NotifyChannelStatus,
    NotifyDelivery,
    NotifyFailure,
    Problem,
    Severity,
)
from .egress import Egress, EgressError, Endpoint

log = logging.getLogger("sparkline.console.notify")

SEVERITY_RANK: dict[Severity, int] = {"info": 0, "warning": 1, "critical": 2}
MIN_INTERVAL_S = 1.0  # between sends on one channel: Slack's documented limit, safe for the other kinds
MAX_PENDING = 50  # notices kept per channel. Later ones are counted and sent as "and N more"
BACKOFF_S = (5.0, 15.0, 60.0, 300.0)  # after the 1st, 2nd, 3rd, then every later failure in a row
BACKOFF_JITTER = 0.2
RATE_LIMIT_DEFAULT_S = 30.0  # a 429 with no usable Retry-After
STOP_GRACE_S = 5.0
LATE_S = 60.0  # a notice sent later than this after its event says when the event happened


@dataclass(frozen=True)
class Notice:
    """One alert or recovery. ``severity`` is the alert's, also on a recovery, whose own Event is always
    "info"."""

    status: Literal["firing", "resolved"]
    severity: Severity
    event: Event


@dataclass(frozen=True)
class Message:
    """What one request carries: every notice that was waiting, or a test."""

    notices: tuple[Notice, ...] = ()
    more: int = 0  # notices that arrived after the mailbox was full
    test: str | None = None  # the sentence a "Send test" message says


_MARKER: dict[Severity, str] = {"critical": "Critical", "warning": "Warning", "info": "Info"}


def _late(ts: float, now: float) -> str:
    age = now - ts
    if age <= LATE_S:
        return ""
    ago = f"{age / 60:.0f} min" if age < 7200 else f"{age / 3600:.0f} h"
    return f" ({time.strftime('%H:%M', time.localtime(ts))}, {ago} ago)"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def compose_text(msg: Message, now: float, limit: int) -> tuple[str, str]:
    """(title, body) for the kinds that send text. The body is cut on a line boundary to ``limit``
    characters and then ends in "… and N more"."""
    if msg.test is not None:
        return "Sparkline test", msg.test
    if len(msg.notices) == 1 and not msg.more:
        ev = msg.notices[0].event
        return ev.title, (ev.detail + _late(ev.ts, now))[:limit]
    firing = sum(n.status == "firing" for n in msg.notices)
    resolved = len(msg.notices) - firing
    counts = [_plural(firing, "alert")] if firing else []
    if resolved:
        counts.append(f"{resolved} resolved")
    title = ", ".join(counts)
    lines = [
        # A recovery's title already starts with "Resolved: ".
        f"{'' if n.status == 'resolved' else _MARKER[n.severity] + ': '}{n.event.title}: {n.event.detail}"
        f"{_late(n.event.ts, now)}"
        for n in msg.notices
    ]
    for kept in range(len(lines), -1, -1):
        hidden = msg.more + len(lines) - kept
        body = "\n".join(lines[:kept] + ([f"… and {hidden} more"] if hidden else []))
        if len(body) <= limit:
            break
    return title, body


def _top_firing(msg: Message) -> Severity | None:
    firing = [n.severity for n in msg.notices if n.status == "firing"]
    if not firing:
        return None
    return max(firing, key=lambda severity: SEVERITY_RANK[severity])


_NTFY_PRIORITY: dict[Severity | None, int] = {"critical": 5, "warning": 4, "info": 3, None: 3}
_NTFY_TAG: dict[Severity | None, str] = {
    "critical": "rotating_light",
    "warning": "warning",
    "info": "information_source",
    None: "white_check_mark",
}


def _ntfy(msg: Message, now: float) -> dict[str, object]:
    # ntfy's JSON publish: unlike the Title header it takes "°" and "·" as they are. ntfy caps a message at
    # 4096 bytes, which 2000 characters stay under even at two bytes each.
    title, body = compose_text(msg, now, 2000)
    top = _top_firing(msg)
    return {"title": title, "message": body, "priority": _NTFY_PRIORITY[top], "tags": [_NTFY_TAG[top]]}


_DISCORD_MARKUP = re.compile(r"[\\*_~`|\[\]<>#]")


def _discord_escape(text: str) -> str:
    return _DISCORD_MARKUP.sub(r"\\\g<0>", text)


def _whole_escapes(text: str) -> str:
    """``text`` without the backslash that a cut left at its end with no character to escape."""
    trailing = len(text) - len(text.rstrip("\\"))
    return text[:-1] if trailing % 2 else text


def _discord(msg: Message, now: float) -> dict[str, object]:
    # A title or a detail can hold text an agent chose (an interface name), so Discord must show it as
    # written: a masked link [text](url) hides where it leads. Escaped before composing, so the limits
    # count what is sent. 2 + 150 + 3 + 1800 characters stay under Discord's 2000.
    plain = tuple(
        replace(
            n,
            event=n.event.model_copy(
                update={"title": _discord_escape(n.event.title), "detail": _discord_escape(n.event.detail)}
            ),
        )
        for n in msg.notices
    )
    title, body = compose_text(replace(msg, notices=plain), now, 1800)
    return {
        "content": f"**{_whole_escapes(title[:150])}**\n{_whole_escapes(body)}",
        "username": "Sparkline",
        "allowed_mentions": {"parse": []},  # a node or rule named "@everyone" pings nobody
    }


def _slack_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _slack(msg: Message, now: float) -> dict[str, object]:
    title, body = compose_text(msg, now, 3000)
    return {"text": f"*{_slack_escape(title)}*\n{_slack_escape(body)}"}


def _webhook(msg: Message, now: float) -> dict[str, object]:
    title, text = compose_text(msg, now, 4000)
    return {
        "source": "sparkline",
        "version": 1,
        "test": msg.test is not None,
        "title": title,
        "text": text,
        "more": msg.more,
        # Always a list, so a Home Assistant template can index into it. "severity" is the alert's.
        "notices": [
            {
                **n.event.model_dump(mode="json", exclude={"resolved_ts", "acked"}),
                "status": n.status,
                "severity": n.severity,
            }
            for n in msg.notices
        ],
    }


@dataclass(frozen=True)
class KindSpec:
    label: str
    takes_token: bool  # False: the webhook URL is the whole secret
    render: Callable[[Message, float], dict[str, object]]  # (message, now) -> JSON body. Sees no secret
    topic_in_path: bool = False  # the URL's last segment is a topic that the service wants in the JSON body


KINDS: dict[ChannelKind, KindSpec] = {
    "ntfy": KindSpec("ntfy", takes_token=True, render=_ntfy, topic_in_path=True),
    "discord": KindSpec("Discord", takes_token=False, render=_discord),
    "slack": KindSpec("Slack", takes_token=False, render=_slack),
    "webhook": KindSpec("Webhook", takes_token=True, render=_webhook),
}


class NotifyConfig(BaseModel):
    """One ``[[notify]]`` table. ``url`` and ``token`` are secrets: only ``egress.py`` unwraps them."""

    # Without hide_input_in_errors pydantic prints input_value=<the url> into the error that main.py writes
    # to stderr, which is the journal.
    model_config = ConfigDict(frozen=True, extra="forbid", hide_input_in_errors=True)

    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")  # appears in the test route's path
    kind: ChannelKind
    url: SecretStr
    token: SecretStr | None = None  # sent as Authorization: Bearer
    min_severity: Severity = "warning"
    send_resolved: bool = True

    @field_validator("token", mode="before")
    @classmethod
    def _empty_is_unset(cls, v: object) -> object:
        return None if v == "" else v

    @model_validator(mode="after")
    def _check(self) -> Self:
        spec = KINDS[self.kind]
        try:
            if self.token is not None and not spec.takes_token:
                raise ValueError(f"a {spec.label} channel takes no token, its url is the secret")
            self.endpoint()
        except ValueError as e:
            raise ValueError(f"notify {self.name!r}: {e}") from None
        return self

    def endpoint(self) -> Endpoint:
        return Endpoint.parse(self.url, self.token, topic_in_path=KINDS[self.kind].topic_in_path)

    def wants(self, severity: Severity, resolved: bool) -> bool:
        """``severity`` is the alert's, also for its recovery, so a channel that skipped an alert skips its
        recovery too."""
        return SEVERITY_RANK[severity] >= SEVERITY_RANK[self.min_severity] and (
            self.send_resolved or not resolved
        )


@dataclass(frozen=True)
class FailureSpec:
    then: Literal["retry", "wait", "drop"]  # what happens to the notices that were in the message
    cause: str  # {host} and {status} are filled in
    fix: str  # {name} is filled in


_RETRIED = "Waiting alerts are sent again automatically."
_EDIT = "in [[notify]] {name!r} in console.toml, then restart the console"

FAILURES: dict[NotifyFailure, FailureSpec] = {
    "dns": FailureSpec("retry", "{host} did not resolve.", f"Check the host name {_EDIT}. {_RETRIED}"),
    "connect": FailureSpec(
        "retry",
        "{host} refused the connection or could not be reached.",
        f"Check that the service is up and reachable from the console host. {_RETRIED}",
    ),
    "tls": FailureSpec(
        "retry",
        "The certificate of {host} did not verify.",
        f"Check the host name and the service's certificate. {_RETRIED}",
    ),
    "timeout": FailureSpec("retry", "{host} did not answer in time.", _RETRIED),
    "server_error": FailureSpec("retry", "HTTP {status} from {host}.", f"The service is failing. {_RETRIED}"),
    "rate_limited": FailureSpec(
        "wait",
        "HTTP 429 from {host}.",
        "Sparkline waits as long as the service asks, then sends what is waiting.",
    ),
    "rejected": FailureSpec(
        "drop",
        "HTTP {status} from {host}.",
        f"The webhook was probably deleted, or the token is wrong. Put a working url {_EDIT}.",
    ),
    "redirect": FailureSpec(
        "drop",
        "{host} answered with a redirect, and Sparkline never follows one.",
        f"Put the final url {_EDIT}.",
    ),
    "address_refused": FailureSpec(
        "drop",
        "{host} resolves to an address this url may not reach: http:// reaches private addresses only.",
        "Use https://, or a host on your LAN.",
    ),
}


def classify(status: int) -> NotifyFailure | None:
    """The failure an HTTP answer means, or None for a delivery."""
    if 200 <= status < 300:
        return None
    if status == 429:
        return "rate_limited"
    return "server_error" if status >= 500 else "rejected"


def problem_for(name: str, host: str, failure: NotifyFailure, status: int | None) -> Problem:
    """Built only from the table, the channel name, the shown host and the status code."""
    spec = FAILURES[failure]
    return Problem(
        message=f"Could not send to {name!r}",
        cause=spec.cause.format(host=host, status=status),
        fix=spec.fix.format(name=name),
    )


class Clock:
    """Wall time and waiting. One object, so a test can step both."""

    def now(self) -> float:
        return time.time()

    async def wait(self, wake: asyncio.Event, until: float | None) -> None:
        """Returns when ``wake`` is set or the time reaches ``until``."""
        timeout = None if until is None else max(0.0, until - self.now())
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(wake.wait(), timeout)


class NotifierStopped(Exception):
    pass


# (rule_id, node_id, metric): the AlertEngine's own state key
AlertKey = tuple[str | None, str | None, str | None]
Hold = Literal["interval", "backoff", "rate_limited"]


class _Worker:
    """The only writer of one channel's state. Everything here runs on the event loop: ``offer`` appends and
    wakes, the task does the rest.

    ``hold`` is why the worker may not send yet, and until when:
        interval      it sent less than MIN_INTERVAL_S ago
        backoff       a send failed in a way that may pass. A test skips this wait
        rate_limited  the service answered 429. Nothing skips this wait
    """

    def __init__(self, cfg: NotifyConfig, host: str, egress: Egress, clock: Clock):
        self.cfg = cfg
        self.host = host
        self.egress = egress
        self.clock = clock
        self.mailbox: list[Notice] = []
        self.more = 0
        self.tests: list[asyncio.Future[NotifyDelivery]] = []
        self.failures = 0
        self.hold: tuple[Hold, float] | None = None
        self.last: NotifyDelivery | None = None
        self.wake = asyncio.Event()
        self.closing = False

    def offer(self, n: Notice) -> None:
        if len(self.mailbox) < MAX_PENDING:
            self.mailbox.append(n)
        else:
            self.more += 1
        self.wake.set()

    @property
    def pending(self) -> int:
        return len(self.mailbox) + self.more

    async def run(self) -> None:
        while True:
            self.wake.clear()
            now = self.clock.now()
            held = self.hold if self.hold and now < self.hold[1] else None
            # A test passes a batch only while a backoff or a rate limit holds that batch back. Otherwise
            # the batch goes first, so tests asked for in a loop cannot keep an alert waiting.
            if self.tests and (not self.mailbox or (held is not None and held[0] != "interval")):
                if held and held[0] == "rate_limited":
                    self._answer_tests(self._delivery(True, 0, "rate_limited", 429))
                elif held and held[0] == "interval":
                    await self.clock.wait(self.wake, held[1])
                else:
                    await self._send_test()
            elif not self.mailbox:
                if self.closing:
                    return
                await self.clock.wait(self.wake, None)
            elif held and not (self.closing and held[0] == "backoff"):
                if self.closing and held[0] == "rate_limited":
                    return
                await self.clock.wait(self.wake, held[1])
            else:
                await self._send_batch()
                if self.closing:
                    return

    async def _send_batch(self) -> None:
        # The notices stay in the mailbox while they are in flight, so they still count as pending and a
        # cancelled send loses none.
        taken, more = len(self.mailbox), self.more
        delivery, retry_after = await self._attempt(Message(tuple(self.mailbox), more))
        then = FAILURES[delivery.failure].then if delivery.failure else None
        if then is None or then == "drop":
            del self.mailbox[:taken]
            self.more -= more
        if then == "drop":
            log.warning(
                "notify %r: dropped %s, sending again cannot work",
                self.cfg.name,
                _plural(taken + more, "notice"),
            )
        self._settle(delivery, retry_after, test=False)

    async def _send_test(self) -> None:
        text = (
            f"Notifications to {self.cfg.name!r} work. "
            f"Alerts at {self.cfg.min_severity} and above are sent here."
        )
        delivery, retry_after = await self._attempt(Message(test=text))
        self._settle(delivery, retry_after, test=True)
        self._answer_tests(delivery)

    def _answer_tests(self, delivery: NotifyDelivery) -> None:
        waiting, self.tests = self.tests, []
        for t in waiting:
            if not t.done():
                t.set_result(delivery)

    async def _attempt(self, msg: Message) -> tuple[NotifyDelivery, float | None]:
        failure: NotifyFailure | None
        status = retry_after = None
        try:
            reply = await self.egress.post(KINDS[self.cfg.kind].render(msg, self.clock.now()))
        except EgressError as e:
            failure = e.failure
        except Exception as e:  # noqa: BLE001
            # The type only: the text of an unknown exception may hold the request URL.
            log.error("notify %r: unexpected %s", self.cfg.name, type(e).__name__)
            failure = "connect"
        else:
            status, retry_after = reply.status, reply.retry_after_s
            failure = classify(status)
        delivery = self._delivery(msg.test is not None, len(msg.notices), failure, status)
        what = "test" if delivery.test else _plural(delivery.notices + msg.more, "notice")
        if failure is None:
            log.info("notify %r: sent %s", self.cfg.name, what)
        else:
            answer = f" (HTTP {status})" if status else ""
            log.warning("notify %r: %s not sent: %s%s", self.cfg.name, what, failure, answer)
        return delivery, retry_after

    def _delivery(
        self, test: bool, notices: int, failure: NotifyFailure | None, status: int | None
    ) -> NotifyDelivery:
        self.last = NotifyDelivery(
            ts=self.clock.now(),
            ok=failure is None,
            test=test,
            notices=notices,
            failure=failure,
            http_status=status,
            problem=problem_for(self.cfg.name, self.host, failure, status) if failure else None,
        )
        return self.last

    def _settle(self, delivery: NotifyDelivery, retry_after: float | None, *, test: bool) -> None:
        """Set the hold that follows an attempt."""
        now = delivery.ts
        then = FAILURES[delivery.failure].then if delivery.failure else None
        if then == "wait":
            self.hold = ("rate_limited", now + (retry_after or RATE_LIMIT_DEFAULT_S))
        elif then == "retry" and not test:
            step = BACKOFF_S[min(self.failures, len(BACKOFF_S) - 1)]
            self.failures += 1
            self.hold = ("backoff", now + step * random.uniform(1 - BACKOFF_JITTER, 1 + BACKOFF_JITTER))
        elif then is None or self.hold is None or self.hold[1] < now + MIN_INTERVAL_S:
            # A delivery ends any backoff, so what is waiting goes out next. A failed test leaves it alone.
            if then is None:
                self.failures = 0
            self.hold = ("interval", now + MIN_INTERVAL_S)

    def status(self) -> NotifyChannelStatus:
        hold = self.hold if self.pending and self.hold and self.hold[0] != "interval" else None
        return NotifyChannelStatus(
            name=self.cfg.name,
            kind=self.cfg.kind,
            host=self.host,
            min_severity=self.cfg.min_severity,
            send_resolved=self.cfg.send_resolved,
            pending=self.pending,
            retry_at=hold[1] if hold and hold[1] > self.clock.now() else None,
            last=self.last,
        )


class Notifier:
    """Turns alert and recovery Events into messages on the channels from console.toml.

    With no channel it builds nothing: no Egress, no task, no socket.
    """

    def __init__(
        self,
        configs: Sequence[NotifyConfig],
        *,
        egress: Callable[[Endpoint], Egress] = Egress,
        clock: Clock | None = None,
    ):
        clock = clock or Clock()
        self._workers: dict[str, _Worker] = {}
        for c in configs:
            endpoint = c.endpoint()
            self._workers[c.name] = _Worker(c, endpoint.display_host, egress(endpoint), clock)
        # The severity of each alert seen firing: a recovery Event does not carry it.
        self._firing: dict[AlertKey, Severity] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._stopped = False

    def publish(self, ev: Event) -> None:
        """Called by Cluster.add_event for every event, on the sample path: it only appends to mailboxes.

        A recovery whose alert this run never saw fire (the console restarted) is not sent.
        """
        if self._stopped or not self._workers:
            return
        key = (ev.rule_id, ev.node_id, ev.metric)
        if ev.kind == "alert":
            self._firing[key] = ev.severity
            notice = Notice("firing", ev.severity, ev)
        elif ev.kind == "recovered" and key in self._firing:
            notice = Notice("resolved", self._firing.pop(key), ev)
        else:
            return
        for w in self._workers.values():
            if w.cfg.wants(notice.severity, notice.status == "resolved"):
                w.offer(notice)

    def start(self) -> None:
        if not self._tasks and not self._stopped:
            self._tasks = {
                name: asyncio.create_task(w.run(), name=f"notify:{name}") for name, w in self._workers.items()
            }

    async def stop(self, grace_s: float = STOP_GRACE_S) -> None:
        """Each channel makes at most one more attempt (none while rate limited), all within ``grace_s``.
        Nothing is kept for the next start: the alert engine starts empty and fires again whatever still
        holds, so a stored queue would deliver stale duplicates."""
        if self._stopped:
            return
        self._stopped = True
        for w in self._workers.values():
            w.closing = True
            w.wake.set()
        if self._tasks:
            _, late = await asyncio.wait(self._tasks.values(), timeout=grace_s)
            for t in late:
                t.cancel()
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        for name, w in self._workers.items():
            for waiting in w.tests:
                if not waiting.done():
                    waiting.set_exception(NotifierStopped())
            if w.pending:
                log.warning("notify %r: %d notifications not sent before shutdown", name, w.pending)
            await w.egress.aclose()

    def status(self) -> list[NotifyChannelStatus]:
        return [w.status() for w in self._workers.values()]

    async def test(self, name: str) -> NotifyChannelStatus:
        """Send a test on the channel now and return its row, with the outcome in ``last``. A failed delivery
        is an outcome, not an error. KeyError for an unknown name, NotifierStopped when not running or when
        the channel's worker has ended."""
        w = self._workers[name]
        if self._stopped or not self._tasks:
            raise NotifierStopped
        done: asyncio.Future[NotifyDelivery] = asyncio.get_running_loop().create_future()
        w.tests.append(done)
        w.wake.set()
        either: list[asyncio.Future[Any]] = [done, self._tasks[name]]
        await asyncio.wait(either, return_when=asyncio.FIRST_COMPLETED)
        if not done.done():  # the worker ended, so nothing will answer
            done.cancel()
            raise NotifierStopped
        return w.status().model_copy(update={"last": done.result()})
