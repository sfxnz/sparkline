"""[[notify]] tables in console.toml: what loads, what is refused, and that a refusal never prints a
channel url or token."""

from __future__ import annotations

import json
import re

import pytest

from sparkline.console import main as console_main
from sparkline.console.config import load_config

CANARY = "s3cr3t-canary"


def table(name="ops", kind="slack", url=f"https://hooks.example/services/{CANARY}", **extra) -> str:
    rows = {"name": name, "kind": kind, "url": url, **extra}
    return "[[notify]]\n" + "".join(f"{k} = {json.dumps(v)}\n" for k, v in rows.items() if v is not None)


@pytest.fixture
def load(tmp_path):
    def load(text: str):
        p = tmp_path / "console.toml"
        p.write_text(text)
        return load_config(p)

    return load


def test_no_notify_table_means_no_channels(load):
    assert load("").notify == []


def test_each_kind_loads_with_its_defaults_and_options(load):
    cfg = load(
        table("phone", "ntfy", "https://ntfy.example/alerts", token="tk_1", min_severity="critical")
        + table("team", "discord", "https://discord.com/api/webhooks/1/abc", send_resolved=False)
        + table("ops", "slack", "https://hooks.slack.com/services/T/B/x", token="")
        + table("home", "webhook", "http://192.168.1.5:8123/api/webhook/x")
    )
    assert [(c.name, c.kind, c.min_severity, c.send_resolved) for c in cfg.notify] == [
        ("phone", "ntfy", "critical", True),
        ("team", "discord", "warning", False),
        ("ops", "slack", "warning", True),
        ("home", "webhook", "warning", True),
    ]
    assert [c.endpoint().display_host for c in cfg.notify] == [
        "ntfy.example",
        "discord.com",
        "hooks.slack.com",
        "192.168.1.5:8123",
    ]
    assert cfg.notify[2].token is None


BAD_TABLES = {
    "a misspelt scheme": (table(url=f"htps://hooks.example/{CANARY}"), "notify 'ops': url must start with"),
    "http to a public address": (
        table("home", "webhook", f"http://203.0.113.7/{CANARY}"),
        "notify 'home': http:// is allowed only to a private address",
    ),
    "a token on a kind whose url is the secret": (
        table(kind="discord", token=CANARY),
        "notify 'ops': a Discord channel takes no token",
    ),
    "an ntfy url with no topic": (
        table("phone", "ntfy", f"https://ntfy.example/{CANARY}/", token=CANARY),
        "notify 'phone': url must end in the topic name",
    ),
    "credentials in the url": (
        table(url=f"https://u:{CANARY}@hooks.example/x"),
        "put the credential in token",
    ),
    "the same name twice": (table() + table(), "notify 'ops' appears twice"),
    "an unknown kind": (table(kind=CANARY), "notify.0.kind"),
    "a name that cannot be a path segment": (table(name=f"a/{CANARY}"), "notify.0.name"),
    "an unknown severity": (table(min_severity=CANARY), "notify.0.min_severity"),
    "a url that is not a string": (table(url=5, token=CANARY), "notify.0.url"),
    "no url": (table(url=None, token=CANARY), "notify.0.url\n  Field required"),
    "an unknown key": (
        table(urls=f"https://hooks.example/{CANARY}"),
        "unknown config keys in .*: notify.0.urls$",
    ),
    "notify written as one table": (
        table().replace("[[notify]]", "[notify]"),
        "notify\n  Input should be a valid list",
    ),
    "an unterminated string": (table().replace('"\n', "\n"), "at line"),
}


@pytest.mark.parametrize("case", BAD_TABLES)
def test_a_bad_table_fails_the_load_naming_the_rule_and_never_the_secret(load, case):
    text, rule = BAD_TABLES[case]
    assert CANARY in text
    with pytest.raises(ValueError, match=rule) as e:
        load(text)
    assert CANARY not in str(e.value) and CANARY not in repr(e.value)


def test_the_console_refuses_to_start_on_a_bad_table_and_prints_no_secret(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("SPARKLINE_CONFIG", raising=False)
    p = tmp_path / "console.toml"
    p.write_text(table("home", "webhook", f"http://203.0.113.7/{CANARY}", token=CANARY))
    with pytest.raises(SystemExit, match="2"):
        console_main.main(["--demo", "--config", str(p)])
    err = capsys.readouterr().err
    assert re.search(r"cannot load config: .*notify 'home': http:// is allowed only to a private", err, re.S)
    assert CANARY not in err


def test_a_loaded_channel_never_prints_its_secrets(load):
    cfg = load(table(token=CANARY, kind="webhook"))
    shown = [repr(cfg), str(cfg), cfg.model_dump_json(), repr(cfg.notify[0].endpoint())]
    assert CANARY not in "\n".join(shown)
