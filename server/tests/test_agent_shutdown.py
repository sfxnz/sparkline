from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
from netports import free_ports

TESTS = Path(__file__).parent


def _alive(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return False
    return stat.rsplit(")", 1)[1].split()[0] != "Z"


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT], ids=["SIGTERM", "SIGINT"])
def test_a_stop_signal_closes_every_gpu_backend_once_and_its_child_process_is_gone(sig, tmp_path):
    (port,) = free_ports(1)
    toml = tmp_path / "agent.toml"
    toml.write_text(
        f'node_id = "shutdown-test"\nbind = "127.0.0.1"\nport = {port}\n'
        f'token = "{"t" * 24}"\ndata_dir = "{tmp_path / "data"}"\n'
    )
    out = tmp_path / "agent.log"
    with out.open("wb") as log_file:
        agent = subprocess.Popen(
            [sys.executable, str(TESTS / "agent_with_child_backend.py"), str(toml), str(tmp_path)],
            env={**os.environ, "PYTHONPATH": str(TESTS)},
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1).close()
                break
            except OSError:
                assert agent.poll() is None and time.monotonic() < deadline, out.read_text()
                time.sleep(0.1)
        child = int((tmp_path / "child.pid").read_text())
        assert _alive(child)

        agent.send_signal(sig)
        agent.wait(30)

        log = out.read_text()
        closed = (tmp_path / "closed").read_text().split() if (tmp_path / "closed").exists() else []
        assert closed == ["child"], f"close() ran {len(closed)} times\n{log}"
        assert not _alive(child), "the backend's child process outlived the agent"
    finally:
        if agent.poll() is None:
            agent.kill()
            agent.wait()
        pid = tmp_path / "child.pid"
        if pid.exists() and _alive(int(pid.read_text())):
            os.kill(int(pid.read_text()), signal.SIGKILL)


def test_a_startup_failure_after_the_collectors_are_built_still_closes_them(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from sparkline.agent import main as agent_main

    closed: list[bool] = []

    class Collectors:
        def __init__(self, *_a: object) -> None:
            pass

        def node_info(self, _cfg: object) -> SimpleNamespace:
            return SimpleNamespace(agent_version="test")

        def ordered(self) -> list:
            return []

        def close(self) -> None:
            closed.append(True)

    def store(path: str) -> None:
        raise PermissionError(13, "Permission denied", path)

    monkeypatch.setattr(agent_main, "Collectors", Collectors)
    monkeypatch.setattr(agent_main, "Store", store)
    monkeypatch.setattr(agent_main, "live", lambda: None)
    for name in ("CONFIG", "TOKEN", "AGENT_TOKEN", "BIND", "PORT", "DATA_DIR"):
        monkeypatch.delenv(f"SPARKLINE_{name}", raising=False)
    with pytest.raises(PermissionError):
        agent_main.main(["--bind", "127.0.0.1", "--data-dir", str(tmp_path / "data")])
    assert closed == [True]
