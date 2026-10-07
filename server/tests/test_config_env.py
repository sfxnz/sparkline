"""SPARKLINE_* environment overrides for both CLIs. Precedence: CLI flag > env > file > default."""

from types import SimpleNamespace

import pytest

from sparkline.agent import main as agent_main
from sparkline.agent.config import load_config as load_agent
from sparkline.console import main as console_main
from sparkline.console.config import load_config as load_console


def test_agent_env_beats_file_and_flags_beat_env(tmp_path):
    p = tmp_path / "agent.toml"
    p.write_text(
        'node_id = "n1"\nbind = "10.0.0.1"\nport = 1111\ntoken = "file-0123456789a"\ndata_dir = "/file"\n'
    )
    env = {
        "SPARKLINE_AGENT_TOKEN": "envagent-0123456",
        "SPARKLINE_TOKEN": "env-console",  # agent token wins over it
        "SPARKLINE_BIND": "127.0.0.1",
        "SPARKLINE_PORT": "2222",
        "SPARKLINE_DATA_DIR": "/env",
    }
    cfg = load_agent(str(p), {}, env)
    assert (cfg.token, cfg.bind, cfg.port, cfg.data_dir) == ("envagent-0123456", "127.0.0.1", 2222, "/env")
    cfg = load_agent(
        str(p), {"port": 3333, "bind": None, "token": "flag-0123456789a", "data_dir": "/flag"}, env
    )
    assert (cfg.token, cfg.bind, cfg.port, cfg.data_dir) == ("flag-0123456789a", "127.0.0.1", 3333, "/flag")
    # SPARKLINE_TOKEN is the fallback; empty values count as unset; no env -> file values
    cfg = load_agent(
        str(p), {}, {"SPARKLINE_AGENT_TOKEN": "", "SPARKLINE_TOKEN": "t2-0123456789abc", "SPARKLINE_PORT": ""}
    )
    assert (cfg.token, cfg.port) == ("t2-0123456789abc", 1111)
    assert load_agent(str(p)).token == "file-0123456789a"
    with pytest.raises(ValueError, match="SPARKLINE_PORT"):
        load_agent(str(p), {}, {"SPARKLINE_PORT": "abc"})


def test_agent_config_path_from_env(tmp_path):
    p = tmp_path / "a.toml"
    p.write_text('node_id = "from-env-path"\n')
    assert load_agent(None, {}, {"SPARKLINE_CONFIG": str(p)}).node_id == "from-env-path"
    other = tmp_path / "b.toml"
    other.write_text('node_id = "from-flag"\n')
    assert load_agent(str(other), {}, {"SPARKLINE_CONFIG": str(p)}).node_id == "from-flag"
    with pytest.raises(OSError):
        load_agent(None, {}, {"SPARKLINE_CONFIG": str(tmp_path / "missing.toml")})


def test_console_env_beats_file(tmp_path):
    p = tmp_path / "console.toml"
    p.write_text(
        'bind = "10.0.0.1"\nport = 1111\ntoken = "file"\nagent_token = "file-a"\ndata_dir = "/file"\n'
    )
    env = {
        "SPARKLINE_TOKEN": "env-c",
        "SPARKLINE_AGENT_TOKEN": "env-a",
        "SPARKLINE_BIND": "127.0.0.1",
        "SPARKLINE_PORT": "2222",
        "SPARKLINE_DATA_DIR": "/env",
    }
    cfg = load_console(p, env)
    assert (cfg.token, cfg.agent_token, cfg.bind, cfg.port, str(cfg.data_dir)) == (
        "env-c",
        "env-a",
        "127.0.0.1",
        2222,
        "/env",
    )
    cfg = load_console(p, {"SPARKLINE_TOKEN": "", "SPARKLINE_PORT": ""})
    assert (cfg.token, cfg.port) == ("file", 1111)
    assert load_console(p).token == "file"
    assert load_console(None, {"SPARKLINE_CONFIG": str(p)}).token == "file"
    with pytest.raises(ValueError):
        load_console(p, {"SPARKLINE_PORT": "abc"})


@pytest.fixture
def no_server(monkeypatch):
    """Run a CLI's main() up to uvicorn.run and capture what it would serve."""
    seen: dict = {}

    def run(app, host, port, **_kw):
        seen.update(app=app, host=host, port=port)

    for mod in (agent_main, console_main):
        monkeypatch.setattr(mod.uvicorn, "run", run)
    for name in ("CONFIG", "TOKEN", "AGENT_TOKEN", "BIND", "PORT", "DATA_DIR"):
        monkeypatch.delenv(f"SPARKLINE_{name}", raising=False)
    return seen


def test_console_cli_precedence(tmp_path, monkeypatch, no_server):
    captured: dict = {}

    def fake_app(cfg, data_dir, **_kw):
        captured.update(cfg=cfg, data_dir=data_dir)
        return SimpleNamespace(state=SimpleNamespace())

    monkeypatch.setattr(console_main, "create_app", fake_app)
    monkeypatch.setattr(console_main, "lock_data_dir", lambda d: -1)
    p = tmp_path / "console.toml"
    p.write_text(f'port = 1111\nbind = "10.0.0.1"\ndata_dir = "{tmp_path / "file-data"}"\n')
    monkeypatch.setenv("SPARKLINE_CONFIG", str(p))
    monkeypatch.setenv("SPARKLINE_BIND", "127.0.0.1")
    monkeypatch.setenv("SPARKLINE_PORT", "2222")
    monkeypatch.setenv("SPARKLINE_DATA_DIR", str(tmp_path / "env-data"))
    monkeypatch.setenv("SPARKLINE_TOKEN", "c")
    monkeypatch.setenv("SPARKLINE_AGENT_TOKEN", "a")
    with pytest.raises(SystemExit, match="2"):  # tokens from env, but no [[nodes]] in the file
        console_main.main([])
    console_main.main(["--demo"])
    assert (no_server["host"], no_server["port"]) == ("127.0.0.1", 2222)
    assert captured["cfg"].token == "c" and captured["data_dir"] == tmp_path / "env-data" / "demo"
    console_main.main(["--demo", "--port", "3333", "--data-dir", str(tmp_path / "flag-data")])
    assert no_server["port"] == 3333 and captured["data_dir"] == tmp_path / "flag-data" / "demo"


def test_agent_cli_precedence(tmp_path, monkeypatch, no_server):
    captured: dict = {}

    class Fake:
        def __init__(self, *a, **kw):
            pass

        def ordered(self):
            return []

        def publish(self, msg):
            pass

        def node_info(self, cfg):
            captured["cfg"] = cfg
            return SimpleNamespace(agent_version="test")

    for name in ("Collectors", "Sampler", "Store", "BenchRunner"):
        monkeypatch.setattr(agent_main, name, type(name, (Fake,), {}))
    monkeypatch.setattr(agent_main, "create_app", lambda *a, **kw: "app")
    monkeypatch.setenv("SPARKLINE_BIND", "127.0.0.1")
    monkeypatch.setenv("SPARKLINE_PORT", "2222")
    monkeypatch.setenv("SPARKLINE_DATA_DIR", str(tmp_path / "env-data"))
    monkeypatch.setenv("SPARKLINE_AGENT_TOKEN", "envtoken-0123456")
    assert agent_main.main([]) == 0
    assert (no_server["host"], no_server["port"]) == ("127.0.0.1", 2222)
    assert (
        captured["cfg"].data_dir == str(tmp_path / "env-data") and captured["cfg"].token == "envtoken-0123456"
    )
    assert agent_main.main(["--port", "3333", "--data-dir", str(tmp_path / "flag")]) == 0
    assert no_server["port"] == 3333 and captured["cfg"].data_dir == str(tmp_path / "flag")
