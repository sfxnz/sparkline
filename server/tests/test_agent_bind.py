import pytest

from sparkline.agent.config import load_config
from sparkline.common import netutil
from sparkline.common.netutil import is_private, resolve_bind


def test_is_private():
    for ip in (
        "10.20.20.48",
        "172.16.0.1",
        "192.168.1.1",
        "100.100.1.1",
        "127.0.0.1",
        "169.254.1.1",
        "::1",
    ):
        assert is_private(ip), ip
    for ip in ("8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:4860::1"):
        assert not is_private(ip), ip


def test_resolve_bind_rules():
    assert resolve_bind("127.0.0.1") == "127.0.0.1"
    assert resolve_bind("10.100.8.1") == "10.100.8.1"
    with pytest.raises(ValueError, match="all interfaces"):
        resolve_bind("0.0.0.0")
    with pytest.raises(ValueError, match="public"):
        resolve_bind("8.8.8.8")
    assert resolve_bind("0.0.0.0", allow_public=True) == "0.0.0.0"
    assert resolve_bind("8.8.8.8", allow_public=True) == "8.8.8.8"
    assert resolve_bind("localhost") == "127.0.0.1"
    with pytest.raises(ValueError, match="does not resolve"):
        resolve_bind("no-such-host.invalid")


def test_resolve_bind_auto(monkeypatch):
    monkeypatch.setattr(netutil, "default_route_iface", lambda: "enP7s7")
    monkeypatch.setattr(netutil, "iface_ipv4", lambda name: ["10.20.20.48"])
    assert resolve_bind("auto") == "10.20.20.48"
    monkeypatch.setattr(netutil, "iface_ipv4", lambda name: ["203.0.113.5"])  # public LAN IP: refused
    with pytest.raises(ValueError, match="public"):
        resolve_bind("auto")
    monkeypatch.setattr(netutil, "default_route_iface", lambda: None)
    with pytest.raises(ValueError, match="no default route"):
        resolve_bind("auto")


def test_config_file_and_overrides(tmp_path):
    p = tmp_path / "agent.toml"
    p.write_text('node_id = "n1"\nport = 1234\ntoken = "t"\n[peers]\nspark2 = "10.100.8.2"\n')
    cfg = load_config(str(p), {"port": 29750, "bind": None})
    assert (cfg.node_id, cfg.port, cfg.token, cfg.bind) == ("n1", 29750, "t", "auto")
    assert cfg.peers == {"spark2": "10.100.8.2"} and cfg.interval_ms == 1000
    p.write_text("prot = 1\n")
    with pytest.raises(ValueError, match="unknown config keys"):
        load_config(str(p))
    p.write_text("")
    with pytest.raises(ValueError, match="250 and 5000"):
        load_config(str(p), {"interval_ms": 100})
