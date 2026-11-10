"""deploy/install.sh installs and removes the root update helper (sparkline-update.path/.service) with the
agent. Run with --dry-run --destdir: no venv, no root, no systemd."""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
UNITS = REPO / "deploy/systemd"


def install_sh(*args: str) -> str:
    r = subprocess.run(
        ["bash", str(REPO / "deploy/install.sh"), *args, "--dry-run", "--yes"],
        capture_output=True,
        text=True,
        check=True,
    )
    return r.stdout


def test_agent_install_puts_the_helper_units_under_the_prefix(tmp_path: Path) -> None:
    out = install_sh("agent", "--destdir", str(tmp_path), "--prefix", "/srv/sparkline")
    for unit in ("sparkline-update.service", "sparkline-update.path"):
        src, dst = UNITS / unit, tmp_path / "etc/systemd/system" / unit
        assert f"+ install {src} -> {dst} (mode 0644, /opt/sparkline -> /srv/sparkline)" in out
    assert "systemctl daemon-reload, enable and (re)start sparkline-update.path" in out


def test_console_install_has_no_helper(tmp_path: Path) -> None:
    out = install_sh("console", "--destdir", str(tmp_path), "--nodes", "n1=http://192.0.2.11:9750")
    assert "sparkline-update" not in out


def test_uninstall_stops_and_removes_the_helper(tmp_path: Path) -> None:
    out = install_sh("uninstall", "--destdir", str(tmp_path))
    for unit in ("sparkline-update.path", "sparkline-update.service"):
        assert f"systemctl disable --now {unit}" in out
        assert f"+ rm -f {tmp_path}/etc/systemd/system/{unit}" in out


def test_the_service_clears_the_request_the_path_unit_watches_and_never_fans_out() -> None:
    path_unit = (UNITS / "sparkline-update.path").read_text()
    service = (UNITS / "sparkline-update.service").read_text()
    request = "/var/lib/sparkline-agent/update-request"
    assert f"PathExists={request}\n" in path_unit
    assert f"ExecStartPre=/bin/rm -f {request}\n" in service
    assert "ExecStart=/opt/sparkline/venv/bin/sparkline update --yes --this-host\n" in service
    assert "ReadWritePaths=/var/lib/sparkline-agent\n" in (UNITS / "sparkline-agent.service").read_text()


def test_back_to_back_requests_never_hit_the_start_limit() -> None:
    unit = (UNITS / "sparkline-update.service").read_text().split("[Service]")[0]
    assert "\nStartLimitIntervalSec=0\n" in unit


def test_uninstall_drops_a_pending_update_request(tmp_path: Path) -> None:
    out = install_sh("uninstall", "--destdir", str(tmp_path))
    assert f"+ rm -f {tmp_path}/var/lib/sparkline-agent/update-request" in out
