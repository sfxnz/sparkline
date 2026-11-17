"""Outbound alert notifications: the ``[[notify]]`` channels from console.toml.

Public API: ``NotifyConfig`` and ``KINDS``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from ..common.schema import ChannelKind, Severity
from .egress import Endpoint

SEVERITY_RANK: dict[Severity, int] = {"info": 0, "warning": 1, "critical": 2}


@dataclass(frozen=True)
class KindSpec:
    label: str
    takes_token: bool  # False: the webhook URL is the whole secret
    topic_in_path: bool = False  # the URL's last segment is a topic that the service wants in the JSON body


KINDS: dict[ChannelKind, KindSpec] = {
    "ntfy": KindSpec("ntfy", takes_token=True, topic_in_path=True),
    "discord": KindSpec("Discord", takes_token=False),
    "slack": KindSpec("Slack", takes_token=False),
    "webhook": KindSpec("Webhook", takes_token=True),
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
