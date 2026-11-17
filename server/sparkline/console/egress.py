"""How the console sends alert notifications to hosts outside its agents, and the only code that unwraps a
channel secret.

Public API: ``Endpoint.parse``, ``address_allowed``, ``Egress.post``, ``Egress.aclose``, ``EgressError``.

``Egress`` calls ``httpx.AsyncHTTPTransport`` directly and never an httpx client: the client logs every
request URL at INFO (a Discord or Slack URL is its own credential), follows redirects when asked, and reads
proxies from the environment, which would connect somewhere other than the checked address.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
import socket
import ssl
import time
from collections.abc import Awaitable, Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from importlib.metadata import version as pkg_version
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr

from ..common.netutil import is_private
from ..common.schema import NotifyFailure

Scheme = Literal["http", "https"]
Address = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], Awaitable[list[str]]]  # (host, port) -> IP literals in resolver order

TOTAL_TIMEOUT_S = 10.0  # resolve + connect + TLS + request + response head, over every address tried
CONNECT_TIMEOUT_S = 5.0
MAX_ADDRESSES = 3  # AAAA records with no IPv6 route are common, so a failed connect tries the next address
RETRY_AFTER_MIN_S = 1.0
RETRY_AFTER_MAX_S = 900.0
USER_AGENT = f"sparkline/{pkg_version('sparkline')}"

# At DEBUG httpcore logs every response header, and a redirect's Location can repeat the channel url. So
# while a send is in flight, nothing httpcore reads from the service is logged. Its connection lines (the
# address and the TLS name) still are.
_sending: ContextVar[bool] = ContextVar("sparkline_egress_sending", default=False)


class _NoServiceAnswers(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not _sending.get()


for _logger in ("httpcore.http11", "httpcore.http2"):
    logging.getLogger(_logger).addFilter(_NoServiceAnswers())

_HOSTNAME = re.compile(r"[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*\.?")
_TOPIC = re.compile(r"[-_A-Za-z0-9]{1,64}")


def _literal(host: str) -> Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def address_allowed(scheme: Scheme, ip: Address) -> bool:
    """http:// reaches private addresses only. https:// reaches any unicast address: verifying the
    certificate against the configured name is what makes a public or rebound address safe there."""
    if ip.is_unspecified or ip.is_multicast:
        return False
    return scheme == "https" or is_private(str(ip))


@dataclass(frozen=True)
class Endpoint:
    """Where one channel's requests go, and the credentials that go with them. ``scheme``, ``host`` and
    ``port`` are safe to show. The rest is secret and prints as ``**********``."""

    scheme: Scheme
    host: str  # lowercase ASCII name, or an IP literal without brackets
    port: int
    path: SecretStr  # path and query, starting with "/"
    topic: SecretStr | None = None  # sent in the JSON body instead of the path (ntfy)
    bearer: SecretStr | None = None

    @classmethod
    def parse(
        cls, url: SecretStr, token: SecretStr | None = None, *, topic_in_path: bool = False
    ) -> Endpoint:
        """Raises ValueError naming the broken rule, never any part of ``url`` or ``token``."""
        try:
            parts = urlsplit(url.get_secret_value().strip())
            port = parts.port
        except ValueError:
            raise ValueError("url is not a valid URL") from None
        scheme: Scheme
        if parts.scheme == "https":
            scheme = "https"
        elif parts.scheme == "http":
            scheme = "http"
        else:
            raise ValueError("url must start with https:// or http://")
        if parts.username is not None or parts.password is not None:
            raise ValueError("url must not hold a user name or password; put the credential in token")
        if parts.fragment:
            raise ValueError("url must not hold a # fragment")
        host = (parts.hostname or "").lower()
        ip = _literal(host)
        if ip is None and not _HOSTNAME.fullmatch(host):
            raise ValueError("url needs a host name in ASCII, or an IP address")
        if ip is not None and not address_allowed(scheme, ip):
            if scheme == "http":
                raise ValueError("http:// is allowed only to a private address; use https://")
            raise ValueError("url must name an address a server can have")
        path, topic = parts.path or "/", None
        if topic_in_path:
            parent, _, last = path.rpartition("/")
            if parts.query or not _TOPIC.fullmatch(last):
                raise ValueError("url must end in the topic name, such as https://ntfy.sh/<topic>")
            path, topic = f"{parent}/", SecretStr(last)
        elif parts.query:
            path = f"{path}?{parts.query}"
        return cls(scheme, host, port or (443 if scheme == "https" else 80), SecretStr(path), topic, token)

    @property
    def display_host(self) -> str:
        """``discord.com``, or ``homeassistant.local:8123`` when the port is not the scheme's default."""
        host = f"[{self.host}]" if ":" in self.host else self.host
        return host if self.port == (443 if self.scheme == "https" else 80) else f"{host}:{self.port}"


@dataclass(frozen=True)
class Reply:
    """The service answered. The body is never read, so nothing the remote wrote can reach a log or the UI."""

    status: int
    retry_after_s: float | None


class EgressError(Exception):
    """The service gave no usable answer. Carries one word from a closed set, so a stray ``log.exception``
    cannot print a URL."""

    def __init__(self, failure: NotifyFailure):
        super().__init__(failure)
        self.failure = failure


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    if value.strip().isdigit():
        seconds = float(value)
    else:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError):
            return None
    return min(max(seconds, RETRY_AFTER_MIN_S), RETRY_AFTER_MAX_S)


def _is_tls(exc: BaseException | None) -> bool:
    while exc is not None:
        if isinstance(exc, ssl.SSLError):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


async def _getaddrinfo(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


class Egress:
    """Sends to one ``Endpoint``. Every send resolves the name again, checks every address it resolved to,
    and connects to a checked address by IP with the name in ``Host`` and in the TLS handshake. Connections
    are never kept, so no send can ride on an address checked earlier."""

    def __init__(
        self,
        endpoint: Endpoint,
        *,
        resolver: Resolver = _getaddrinfo,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.endpoint = endpoint
        self._resolve = resolver
        self._transport = transport or httpx.AsyncHTTPTransport(
            retries=0, limits=httpx.Limits(max_keepalive_connections=0)
        )

    async def post(self, body: Mapping[str, object]) -> Reply:
        """POST ``body`` as JSON. Returns any 2xx, 4xx or 5xx answer. Raises EgressError for a 3xx, which is
        never followed, and for everything that is not an HTTP answer."""
        try:
            async with asyncio.timeout(TOTAL_TIMEOUT_S):
                return await self._post(body)
        except TimeoutError:
            raise EgressError("timeout") from None

    async def _post(self, body: Mapping[str, object]) -> Reply:
        to = self.endpoint
        literal = _literal(to.host)
        if literal is not None:
            ips = [literal]
        else:
            try:
                ips = [ipaddress.ip_address(a) for a in await self._resolve(to.host, to.port)]
            except OSError:
                raise EgressError("dns") from None
            if not ips:
                raise EgressError("dns")
        # all(), not any(): a name that answers with one refused address is refused whole, so a rebinding
        # answer cannot hide a public address behind a private one.
        if not all(address_allowed(to.scheme, ip) for ip in ips):
            raise EgressError("address_refused")
        if to.topic is not None:
            body = {**body, "topic": to.topic.get_secret_value()}
        headers = {"Host": to.display_host, "Content-Type": "application/json", "User-Agent": USER_AGENT}
        if to.bearer is not None:
            headers["Authorization"] = f"Bearer {to.bearer.get_secret_value()}"
        extensions: dict[str, object] = {
            "timeout": {
                "connect": CONNECT_TIMEOUT_S,
                "read": TOTAL_TIMEOUT_S,
                "write": TOTAL_TIMEOUT_S,
                "pool": CONNECT_TIMEOUT_S,
            }
        }
        if to.scheme == "https" and literal is None:
            extensions["sni_hostname"] = to.host
        failure: NotifyFailure = "connect"
        for ip in ips[:MAX_ADDRESSES]:
            request = httpx.Request(
                "POST",
                httpx.URL(
                    scheme=to.scheme, host=str(ip), port=to.port, raw_path=to.path.get_secret_value().encode()
                ),
                headers=headers,
                content=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(),
                extensions=extensions,
            )
            sending = _sending.set(True)
            try:
                response = await self._transport.handle_async_request(request)
                await response.aclose()
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                if _is_tls(e):
                    raise EgressError("tls") from None
                failure = "timeout" if isinstance(e, httpx.ConnectTimeout) else "connect"
                continue
            except httpx.TimeoutException:
                raise EgressError("timeout") from None
            except httpx.HTTPError:
                raise EgressError("connect") from None
            finally:
                _sending.reset(sending)
            if 300 <= response.status_code < 400:
                raise EgressError("redirect")
            return Reply(response.status_code, _retry_after(response.headers.get("retry-after")))
        raise EgressError(failure)

    async def aclose(self) -> None:
        await self._transport.aclose()
