"""deploy/install.sh agent --enable-tune installs the root helper behind one-click recommendations
(sparkline-tune.path, .service and -boot.service), and removes it again without the flag. Run with
--dry-run --destdir: no venv, no root, no systemd."""

from __future__ import annotations

import subprocess
from pathlib import Path

from test_install_helper import REPO, UNITS, install_sh

from sparkline import tune
from sparkline.agent import recommend

TUNE_UNITS = ("sparkline-tune.path", "sparkline-tune.service", "sparkline-tune-boot.service")


def test_enable_tune_installs_the_three_units_and_the_request_directory(tmp_path: Path) -> None:
    out = install_sh("agent", "--enable-tune", "--destdir", str(tmp_path), "--prefix", "/srv/sparkline")
    for unit in TUNE_UNITS:
        src, dst = UNITS / unit, tmp_path / "etc/systemd/system" / unit
        assert f"+ install {src} -> {dst} (mode 0644, /opt/sparkline -> /srv/sparkline)" in out
    assert f"+ install -d -m 0700 {tmp_path}/var/lib/sparkline-agent/tune-requests" in out
    for unit in ("sparkline-tune.path", "sparkline-tune-boot.service"):
        assert f"systemctl daemon-reload, enable and (re)start {unit}" in out


def test_enable_tune_says_plainly_what_it_allows_before_asking(tmp_path: Path) -> None:
    r = subprocess.run(
        [
            "bash",
            str(REPO / "deploy/install.sh"),
            "agent",
            "--enable-tune",
            "--dry-run",
            "--destdir",
            tmp_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    warning = " ".join(r.stderr.split())
    assert "--enable-tune installs a helper that runs as root on this machine" in warning
    assert "It can do three things and nothing else" in warning
    assert "Anyone who can sign in to the console, or who controls the agent process" in warning


def test_enable_tune_needs_a_yes_when_nobody_can_be_asked(tmp_path: Path) -> None:
    r = subprocess.run(
        ["bash", str(REPO / "deploy/install.sh"), "agent", "--enable-tune", "--destdir", str(tmp_path)],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )
    assert r.returncode == 1
    assert "Install the root helper and allow one-click settings? Re-run with --yes" in r.stderr
    assert list(tmp_path.iterdir()) == []


def test_an_agent_installed_without_the_flag_has_no_root_helper(tmp_path: Path) -> None:
    out = install_sh("agent", "--destdir", str(tmp_path))
    assert "no one-click settings (no --enable-tune)" in out
    assert "sparkline-tune" not in out and "tune-requests" not in out


def test_reinstalling_without_the_flag_undoes_the_settings_then_removes_the_helper(tmp_path: Path) -> None:
    units = tmp_path / "etc/systemd/system"
    units.mkdir(parents=True)
    (units / "sparkline-tune.path").write_text((UNITS / "sparkline-tune.path").read_text())
    out = install_sh("agent", "--destdir", str(tmp_path))
    steps = ["skipped (--destdir): /opt/sparkline/venv/bin/sparkline tune undo-all"]
    steps += [f"+ rm -f {units}/{unit}" for unit in TUNE_UNITS]
    steps += [f"+ rm -rf {tmp_path}/var/lib/sparkline-agent/tune-requests"]
    at = [out.index(step) for step in steps]
    assert at == sorted(at)


def test_only_an_agent_takes_the_flag(tmp_path: Path) -> None:
    for mode in (["console", "--nodes", "n1=http://192.0.2.11:9750"], ["uninstall"]):
        r = subprocess.run(
            ["bash", str(REPO / "deploy/install.sh"), *mode, "--enable-tune", "--dry-run"],
            capture_output=True,
            text=True,
        )
        assert r.returncode == 1 and "--enable-tune only applies to agent" in r.stderr
    out = install_sh("console", "--destdir", str(tmp_path), "--nodes", "n1=http://192.0.2.11:9750")
    assert "sparkline-tune" not in out


def test_uninstall_undoes_the_settings_and_removes_the_helper_and_its_pending_requests(
    tmp_path: Path,
) -> None:
    out = install_sh("uninstall", "--destdir", str(tmp_path))
    undo = out.index("skipped (--destdir): /opt/sparkline/venv/bin/sparkline tune undo-all")
    for unit in TUNE_UNITS:
        assert f"systemctl disable --now {unit}" in out
        assert out.index(f"+ rm -f {tmp_path}/etc/systemd/system/{unit}") > undo
    assert f"+ rm -rf {tmp_path}/var/lib/sparkline-agent/tune-requests" in out
    assert out.index(f"+ rm -rf {tmp_path}/opt/sparkline") > undo
    assert "/var/lib/sparkline-tune" not in out
    purged = install_sh("uninstall", "--purge", "--destdir", str(tmp_path))
    assert f"{tmp_path}/var/lib/sparkline-tune" in purged


def test_the_units_and_the_helper_agree_on_every_path(tmp_path: Path) -> None:
    path_unit = (UNITS / "sparkline-tune.path").read_text()
    service = (UNITS / "sparkline-tune.service").read_text()
    boot = (UNITS / "sparkline-tune-boot.service").read_text()
    assert f"DirectoryNotEmpty=/{tune.REQUEST_DIR}\n" in path_unit
    assert "Unit=sparkline-tune.service\n" in path_unit
    assert "ExecStart=/opt/sparkline/venv/bin/sparkline tune run-requests\n" in service
    assert f"ReadWritePaths=/{tune.REQUEST_DIR}\n" in service
    assert "ExecStart=/opt/sparkline/venv/bin/sparkline tune reapply\n" in boot
    assert f"ConditionDirectoryNotEmpty=/{tune.APPLIED}\n" in boot
    assert "After=nvidia-persistenced.service nv-cpu-governor.service\n" in boot
    assert "WantedBy=multi-user.target\n" in boot
    for unit in (service, boot):
        assert f"StateDirectory={tune.STATE.name}\n" in unit and tune.STATE.parent == Path("var/lib")
    assert "ReadWritePaths=/var/lib/sparkline-agent\n" in (UNITS / "sparkline-agent.service").read_text()


def test_the_agent_finds_the_request_directory_in_the_unit_that_ships(tmp_path: Path) -> None:
    installed = tmp_path / recommend.TUNE_PATH_UNIT
    installed.parent.mkdir(parents=True)
    installed.write_text((UNITS / "sparkline-tune.path").read_text())
    assert recommend.request_dir(tmp_path) == tmp_path / tune.REQUEST_DIR


def test_back_to_back_requests_never_hit_the_start_limit() -> None:
    unit = (UNITS / "sparkline-tune.service").read_text().split("[Service]")[0]
    assert "\nStartLimitIntervalSec=0\n" in unit


def test_the_sandbox_leaves_open_only_what_the_three_settings_need() -> None:
    for name in ("sparkline-tune.service", "sparkline-tune-boot.service"):
        lines = [
            line for line in (UNITS / name).read_text().splitlines() if line and not line.startswith("#")
        ]
        assert "NoNewPrivileges=yes" in lines and "ProtectSystem=strict" in lines, name
        assert "IPAddressDeny=any" in lines and "RestrictAddressFamilies=AF_UNIX" in lines, name
        # nvidia-smi opens /dev/nvidia*, and the CPU cap is a write under /sys
        assert not {"PrivateDevices=yes", "ProtectKernelTunables=yes", "ProtectClock=yes"} & set(lines), name
        caps = next(line for line in lines if line.startswith("CapabilityBoundingSet="))
        assert "CAP_SYS_ADMIN" in caps, name
