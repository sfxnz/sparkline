"""The console's outbound door: URL rules, address pinning, the http:// rule, redirects, and that no
channel secret reaches a repr, an exception or a log (httpx.MockTransport and a fake resolver, no network)."""

from __future__ import annotations

import ipaddress
import json
import logging
import ssl
import traceback

import httpx
import pytest
from pydantic import SecretStr

from sparkline.console.egress import Egress, EgressError, Endpoint, Reply, address_allowed

CANARY = "s3cr3t-canary"
PRIVATE, PRIVATE_2, PUBLIC, PUBLIC_V6 = "10.0.0.1", "192.168.1.5", "203.0.113.7", "2001:db8::7"


def endpoint(url: str, token: str | None = None, **kw) -> Endpoint:
    return Endpoint.parse(SecretStr(url), SecretStr(token) if token else None, **kw)


def resolver(*answers: list[str]):
    """Answers in turn, repeating the last one."""
    left = list(answers)

    async def resolve(host: str, port: int) -> list[str]:
        resolve.asked.append((host, port))
        return left.pop(0) if len(left) > 1 else left[0]

    resolve.asked = []
    return resolve


def recorder(status: int = 204, headers: dict[str, str] | None = None):
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, headers=headers)

    return httpx.MockTransport(handle), seen


def failing(exc: Exception, then: int = 204):
    """Raises ``exc`` for the first request, then answers."""
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            raise exc
        return httpx.Response(then)

    return httpx.MockTransport(handle), seen


async def failure_of(egress: Egress) -> str:
    with pytest.raises(EgressError) as e:
        await egress.post({"x": 1})
    return e.value.failure


async def test_the_request_goes_to_the_resolved_address_with_the_name_in_host_and_sni():
    transport, seen = recorder()
    resolve = resolver([PUBLIC])
    egress = Egress(endpoint("https://hooks.example/services/a/b?c=d"), resolver=resolve, transport=transport)
    assert await egress.post({"text": "é"}) == Reply(204, None)
    (request,) = seen
    assert str(request.url) == f"https://{PUBLIC}/services/a/b?c=d"
    assert request.headers["host"] == "hooks.example"
    assert request.extensions["sni_hostname"] == "hooks.example"
    assert request.method == "POST" and request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {"text": "é"}
    assert "authorization" not in request.headers
    assert resolve.asked == [("hooks.example", 443)]


async def test_a_port_that_is_not_the_default_is_kept_in_the_url_and_in_host():
    transport, seen = recorder()
    egress = Egress(
        endpoint("http://ha.example:8123/api/webhook/x"), resolver=resolver([PRIVATE]), transport=transport
    )
    await egress.post({})
    assert str(seen[0].url) == f"http://{PRIVATE}:8123/api/webhook/x"
    assert seen[0].headers["host"] == "ha.example:8123"
    assert "sni_hostname" not in seen[0].extensions


async def test_the_token_is_sent_as_a_bearer_and_the_topic_in_the_body():
    transport, seen = recorder(200)
    egress = Egress(
        endpoint("https://ntfy.example/sub/alerts", "tk_1", topic_in_path=True),
        resolver=resolver([PUBLIC]),
        transport=transport,
    )
    await egress.post({"title": "t"})
    assert str(seen[0].url) == f"https://{PUBLIC}/sub/"
    assert seen[0].headers["authorization"] == "Bearer tk_1"
    assert json.loads(seen[0].content) == {"title": "t", "topic": "alerts"}


async def test_an_ip_literal_is_used_as_written_and_never_resolved():
    transport, seen = recorder()
    resolve = resolver([PUBLIC])
    egress = Egress(endpoint("http://[fd00::5]:8080/hook"), resolver=resolve, transport=transport)
    await egress.post({})
    assert str(seen[0].url) == "http://[fd00::5]:8080/hook" and seen[0].headers["host"] == "[fd00::5]:8080"
    assert resolve.asked == []


@pytest.mark.parametrize(
    "answer",
    [[PUBLIC], [PRIVATE, PUBLIC], [PUBLIC, PRIVATE], [PRIVATE, PUBLIC_V6], ["0.0.0.0"], ["224.0.0.1"]],
)
async def test_http_is_refused_unless_every_resolved_address_is_private(answer):
    transport, seen = recorder()
    egress = Egress(endpoint("http://ha.example/hook"), resolver=resolver(answer), transport=transport)
    assert await failure_of(egress) == "address_refused"
    assert seen == []


async def test_http_is_refused_when_a_name_rebinds_from_private_to_public():
    transport, seen = recorder()
    egress = Egress(
        endpoint("http://ha.example/hook"), resolver=resolver([PRIVATE], [PUBLIC]), transport=transport
    )
    await egress.post({})
    assert await failure_of(egress) == "address_refused"
    assert [r.url.host for r in seen] == [PRIVATE]


async def test_every_send_resolves_again_and_goes_to_the_new_address():
    transport, seen = recorder()
    egress = Egress(
        endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC], [PRIVATE]), transport=transport
    )
    await egress.post({})
    await egress.post({})
    assert [r.url.host for r in seen] == [PUBLIC, PRIVATE]


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_a_redirect_is_a_failure_and_is_never_followed(status):
    transport, seen = recorder(status, {"Location": "https://elsewhere.example/x"})
    egress = Egress(endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC]), transport=transport)
    assert await failure_of(egress) == "redirect"
    assert len(seen) == 1


@pytest.mark.parametrize("status", [200, 204, 400, 404, 429, 500, 503])
async def test_any_other_answer_is_returned_for_the_caller_to_classify(status):
    transport, _ = recorder(status)
    egress = Egress(endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC]), transport=transport)
    assert (await egress.post({})).status == status


@pytest.mark.parametrize(
    ("header", "seconds"), [("3", 3.0), ("0", 1.0), ("86400", 900.0), ("soon", None), ("-5", None)]
)
async def test_retry_after_is_read_in_seconds_and_clamped(header, seconds):
    transport, _ = recorder(429, {"Retry-After": header})
    egress = Egress(endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC]), transport=transport)
    assert (await egress.post({})).retry_after_s == seconds


async def test_retry_after_as_a_date_in_the_past_waits_the_minimum():
    transport, _ = recorder(429, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"})
    egress = Egress(endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC]), transport=transport)
    assert (await egress.post({})).retry_after_s == 1.0


async def test_a_failed_connect_tries_the_next_checked_address():
    transport, seen = failing(httpx.ConnectError("no route"))
    egress = Egress(
        endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC_V6, PUBLIC]), transport=transport
    )
    assert (await egress.post({})).status == 204
    assert [r.url.host for r in seen] == [PUBLIC_V6, PUBLIC]


async def test_at_most_three_addresses_are_tried():
    seen: list[httpx.Request] = []

    def refuse(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        raise httpx.ConnectError("refused")

    answer = [f"203.0.113.{n}" for n in range(1, 6)]
    egress = Egress(
        endpoint("https://hooks.example/x"), resolver=resolver(answer), transport=httpx.MockTransport(refuse)
    )
    assert await failure_of(egress) == "connect"
    assert [r.url.host for r in seen] == answer[:3]


def tls_failure() -> httpx.ConnectError:
    try:
        try:
            raise ssl.SSLCertVerificationError("certificate verify failed")
        except ssl.SSLError as e:
            raise httpx.ConnectError(str(e)) from e
    except httpx.ConnectError as wrapped:
        return wrapped


@pytest.mark.parametrize(
    ("exc", "failure"),
    [
        (tls_failure(), "tls"),
        (httpx.ConnectTimeout("slow"), "timeout"),
        (httpx.ReadTimeout("slow"), "timeout"),
        (httpx.ReadError("reset"), "connect"),
        (httpx.RemoteProtocolError("garbage"), "connect"),
    ],
)
async def test_transport_errors_map_to_the_closed_vocabulary(exc, failure):
    transport, _ = failing(exc, then=500)
    egress = Egress(endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC]), transport=transport)
    assert await failure_of(egress) == failure


async def test_a_request_that_may_have_been_sent_is_not_repeated_on_another_address():
    transport, seen = failing(httpx.ReadError("reset"))
    egress = Egress(
        endpoint("https://hooks.example/x"), resolver=resolver([PUBLIC, PUBLIC_V6]), transport=transport
    )
    assert await failure_of(egress) == "connect"
    assert len(seen) == 1


async def test_a_name_that_does_not_resolve_is_a_dns_failure():
    async def nxdomain(host: str, port: int) -> list[str]:
        raise OSError("Name or service not known")

    async def empty(host: str, port: int) -> list[str]:
        return []

    for resolve in (nxdomain, empty):
        egress = Egress(endpoint("https://hooks.example/x"), resolver=resolve, transport=recorder()[0])
        assert await failure_of(egress) == "dns"


async def test_a_send_that_outlasts_the_total_budget_is_a_timeout(monkeypatch):
    import asyncio

    from sparkline.console import egress as module

    async def never(host: str, port: int) -> list[str]:
        await asyncio.Event().wait()
        return []

    monkeypatch.setattr(module, "TOTAL_TIMEOUT_S", 0.01)
    egress = Egress(endpoint("https://hooks.example/x"), resolver=never, transport=recorder()[0])
    assert await failure_of(egress) == "timeout"


@pytest.mark.parametrize(
    ("scheme", "ip", "allowed"),
    [
        ("http", PRIVATE, True),
        ("http", "127.0.0.1", True),
        ("http", "::1", True),
        ("http", "fd00::5", True),
        ("http", PUBLIC, False),
        ("http", PUBLIC_V6, False),
        ("https", PUBLIC, True),
        ("https", PUBLIC_V6, True),
        ("https", PRIVATE, True),
        ("https", "0.0.0.0", False),
        ("https", "::", False),
        ("https", "224.0.0.1", False),
        ("https", "ff02::1", False),
    ],
)
def test_address_policy(scheme, ip, allowed):
    assert address_allowed(scheme, ipaddress.ip_address(ip)) is allowed


@pytest.mark.parametrize(
    ("url", "kw", "rule"),
    [
        (f"ftp://hooks.example/{CANARY}", {}, "https:// or http://"),
        (f"hooks.example/{CANARY}", {}, "https:// or http://"),
        (f"https://user:{CANARY}@hooks.example/x", {}, "user name or password"),
        (f"https://hooks.example/x#{CANARY}", {}, "fragment"),
        (f"https:///{CANARY}", {}, "host name"),
        (f"https://hööks.example/{CANARY}", {}, "host name"),
        (f"https://hooks example/{CANARY}", {}, "host name"),
        (f"https://hooks.example:99999/{CANARY}", {}, "not a valid URL"),
        (f"https://[::1/{CANARY}", {}, "not a valid URL"),
        (f"http://{PUBLIC}/{CANARY}", {}, "private address"),
        (f"http://[{PUBLIC_V6}]/{CANARY}", {}, "private address"),
        (f"https://0.0.0.0/{CANARY}", {}, "address a server can have"),
        (f"https://ntfy.example/{CANARY}/", {"topic_in_path": True}, "topic name"),
        (f"https://ntfy.example/{CANARY}?x=1", {"topic_in_path": True}, "topic name"),
        (f"https://ntfy.example/{CANARY}.{CANARY}", {"topic_in_path": True}, "topic name"),
        ("https://ntfy.example", {"topic_in_path": True}, "topic name"),
    ],
)
def test_a_url_that_breaks_a_rule_is_refused_without_echoing_it(url, kw, rule):
    with pytest.raises(ValueError, match=rule) as e:
        endpoint(url, CANARY, **kw)
    assert CANARY not in str(e.value) and CANARY not in repr(e.value)
    assert CANARY not in "".join(traceback.format_exception(e.value))


@pytest.mark.parametrize(
    ("url", "shown"),
    [
        ("https://discord.com/api/webhooks/1/abc", ("https", "discord.com", 443, "discord.com")),
        ("HTTPS://Hooks.Example:8443/x", ("https", "hooks.example", 8443, "hooks.example:8443")),
        (
            "http://homeassistant.local:8123/api/webhook/x",
            ("http", "homeassistant.local", 8123, "homeassistant.local:8123"),
        ),
        (f"http://{PRIVATE_2}/x", ("http", PRIVATE_2, 80, PRIVATE_2)),
        ("http://[::1]:8080/x", ("http", "::1", 8080, "[::1]:8080")),
        (f"https://{PUBLIC}/x", ("https", PUBLIC, 443, PUBLIC)),
    ],
)
def test_a_valid_url_parses_to_its_shown_parts(url, shown):
    e = endpoint(url)
    assert (e.scheme, e.host, e.port, e.display_host) == shown


async def test_no_secret_reaches_a_repr_an_exception_or_a_log(caplog):
    caplog.set_level(logging.DEBUG)
    urls = [
        (f"https://hooks.example/services/{CANARY}?k={CANARY}", {}),
        (f"https://ntfy.example/{CANARY}", {"topic_in_path": True}),
    ]
    shown: list[str] = []
    for url, kw in urls:
        target = endpoint(url, CANARY, **kw)
        shown += [repr(target), str(target), repr(Egress(target, transport=recorder()[0]).endpoint)]
        outcomes = [
            (resolver([PUBLIC]), recorder(204)[0]),
            (resolver([PUBLIC]), recorder(302, {"Location": f"https://elsewhere.example/{CANARY}"})[0]),
            (resolver([PUBLIC]), recorder(404)[0]),
            (resolver([PUBLIC]), failing(httpx.ConnectError(f"refused {CANARY}"), then=500)[0]),
            (resolver([PUBLIC]), failing(tls_failure())[0]),
            (resolver([PUBLIC]), failing(httpx.ReadTimeout(CANARY))[0]),
            (resolver([]), recorder()[0]),
        ]
        for resolve, transport in outcomes:
            try:
                shown.append(repr(await Egress(target, resolver=resolve, transport=transport).post({"a": 1})))
            except EgressError as e:
                shown += [str(e), repr(e), "".join(traceback.format_exception(e))]
    assert len(shown) > 12
    assert CANARY not in "\n".join(shown)
    assert CANARY not in caplog.text


async def test_the_secret_is_sent_where_the_service_expects_it():
    transport, seen = recorder()
    target = endpoint(f"https://hooks.example/services/{CANARY}", CANARY)
    await Egress(target, resolver=resolver([PUBLIC]), transport=transport).post({})
    assert seen[0].url.path == f"/services/{CANARY}"
    assert seen[0].headers["authorization"] == f"Bearer {CANARY}"
