"""`sparkline tune`, the root helper behind one-click recommendations, against a staged root and a fake
command runner. Nothing here runs a privileged command or touches the machine."""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

from sparkline import tune
from sparkline.console.main import main as sparkline_main

LOCK = ["/usr/bin/nvidia-smi", "-lgc", "0,2200"]
RESET = ["/usr/bin/nvidia-smi", "-rgc"]


class Runner:
    """Stands in for run_command: records every argv, and fails the ones whose program is in `broken`."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.broken: set[str] = set()

    def __call__(self, argv: list[str]) -> None:
        self.calls.append(argv)
        if argv[0] in self.broken:
            raise tune.TuneError(f"{argv[0]} failed with exit 1: no such device")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """A machine with one efficiency policy (2808 MHz) and two performance policies (3900 MHz)."""
    root = tmp_path / "root"
    (root / tune.REQUEST_DIR).mkdir(parents=True)
    for policy, top in (("policy0", 2808000), ("policy5", 3900000), ("policy15", 3900000)):
        d = root / tune.CPUFREQ / policy
        d.mkdir(parents=True)
        (d / "cpuinfo_max_freq").write_text(f"{top}\n")
        (d / "scaling_max_freq").write_text(f"{top}\n")
    return root


@pytest.fixture
def run() -> Runner:
    return Runner()


def ask(root: Path, name: str) -> Path:
    request = root / tune.REQUEST_DIR / name
    request.touch()
    return request


def result(root: Path, rec_id: str) -> dict:
    return json.loads((root / tune.RESULTS / f"{rec_id}.json").read_text())


def recorded(root: Path) -> list[str]:
    applied = root / tune.APPLIED
    return sorted(p.name for p in applied.iterdir()) if applied.is_dir() else []


def max_freq(root: Path) -> dict[str, int]:
    policies = sorted((root / tune.CPUFREQ).iterdir())
    return {p.name: int((p / "scaling_max_freq").read_text()) for p in policies}


def test_apply_runs_the_fixed_command_records_it_and_leaves_a_result_the_agent_can_read(
    root: Path, run: Runner
) -> None:
    request = ask(root, "gpu-clock-cap.apply")
    before = time.time()
    assert tune.run_requests(root, run) == 0
    assert run.calls == [LOCK]
    assert not request.exists()
    assert recorded(root) == ["gpu-clock-cap"]
    r = result(root, "gpu-clock-cap")
    assert (r["action"], r["ok"], r["message"]) == ("apply", True, "GPU clock capped at 2200 MHz")
    assert before <= r["ts"] <= time.time()
    assert stat.S_IMODE((root / tune.RESULTS / "gpu-clock-cap.json").stat().st_mode) == 0o644


def test_undo_runs_the_fixed_command_and_drops_the_record(root: Path, run: Runner) -> None:
    ask(root, "gpu-clock-cap.apply")
    tune.run_requests(root, run)
    ask(root, "gpu-clock-cap.undo")
    assert tune.run_requests(root, run) == 0
    assert run.calls == [LOCK, RESET]
    assert recorded(root) == []
    assert result(root, "gpu-clock-cap")["action"] == "undo"


def test_the_cpu_cap_lowers_only_the_policies_faster_than_it_and_undo_restores_their_maximum(
    root: Path, run: Runner
) -> None:
    ask(root, "cpu-pcore-cap.apply")
    assert tune.run_requests(root, run) == 0
    assert max_freq(root) == {"policy0": 2808000, "policy15": 3000000, "policy5": 3000000}
    assert result(root, "cpu-pcore-cap")["message"] == "2 CPU frequency policies capped at 3000 MHz"
    ask(root, "cpu-pcore-cap.undo")
    assert tune.run_requests(root, run) == 0
    assert max_freq(root) == {"policy0": 2808000, "policy15": 3900000, "policy5": 3900000}
    assert run.calls == [] and recorded(root) == []


def test_the_cpu_cap_fails_plainly_on_a_machine_with_no_core_above_it(root: Path, run: Runner) -> None:
    for policy in ("policy5", "policy15"):
        (root / tune.CPUFREQ / policy / "cpuinfo_max_freq").write_text("2808000\n")
    ask(root, "cpu-pcore-cap.apply")
    assert tune.run_requests(root, run) == 1
    r = result(root, "cpu-pcore-cap")
    assert (r["ok"], r["message"]) == (False, "no CPU core on this machine runs above 3000 MHz")
    assert recorded(root) == []


def test_the_boot_target_is_set_through_systemctl(root: Path, run: Runner) -> None:
    ask(root, "headless-boot.apply")
    tune.run_requests(root, run)
    ask(root, "headless-boot.undo")
    tune.run_requests(root, run)
    assert run.calls == [
        ["/usr/bin/systemctl", "set-default", "multi-user.target"],
        ["/usr/bin/systemctl", "set-default", "graphical.target"],
    ]


def test_a_failed_command_is_reported_and_not_recorded_as_applied(root: Path, run: Runner) -> None:
    run.broken = {"/usr/bin/nvidia-smi"}
    request = ask(root, "gpu-clock-cap.apply")
    assert tune.run_requests(root, run) == 1
    r = result(root, "gpu-clock-cap")
    assert (r["action"], r["ok"]) == ("apply", False)
    assert r["message"] == "/usr/bin/nvidia-smi failed with exit 1: no such device"
    assert recorded(root) == [] and not request.exists()


def test_a_failed_undo_keeps_the_record_so_the_setting_stays_sparklines(root: Path, run: Runner) -> None:
    ask(root, "gpu-clock-cap.apply")
    tune.run_requests(root, run)
    run.broken = {"/usr/bin/nvidia-smi"}
    ask(root, "gpu-clock-cap.undo")
    assert tune.run_requests(root, run) == 1
    assert recorded(root) == ["gpu-clock-cap"] and result(root, "gpu-clock-cap")["ok"] is False


def test_the_same_request_twice_converges(root: Path, run: Runner) -> None:
    for name in ("cpu-pcore-cap.apply", "cpu-pcore-cap.apply", "gpu-clock-cap.undo", "gpu-clock-cap.undo"):
        ask(root, name)
        assert tune.run_requests(root, run) == 0
    assert max_freq(root) == {"policy0": 2808000, "policy15": 3000000, "policy5": 3000000}
    assert recorded(root) == ["cpu-pcore-cap"]
    assert run.calls == [RESET, RESET]


def test_several_requests_are_all_taken_in_one_run_and_an_empty_directory_is_a_quiet_success(
    root: Path, run: Runner
) -> None:
    ask(root, "gpu-clock-cap.apply")
    ask(root, "headless-boot.apply")
    assert tune.run_requests(root, run) == 0
    assert recorded(root) == ["gpu-clock-cap", "headless-boot"]
    assert list((root / tune.REQUEST_DIR).iterdir()) == []
    run.calls.clear()
    assert tune.run_requests(root, run) == 0 and run.calls == []


def test_a_result_replaces_the_old_file_whole_and_leaves_no_temporary_file(root: Path, run: Runner) -> None:
    ask(root, "gpu-clock-cap.apply")
    tune.run_requests(root, run)
    old = root / tune.RESULTS / "gpu-clock-cap.json"
    reader = old.open()  # an agent that opened the file before the next result
    ask(root, "gpu-clock-cap.undo")
    tune.run_requests(root, run)
    assert json.load(reader)["action"] == "apply"
    assert result(root, "gpu-clock-cap")["action"] == "undo"
    assert [p.name for p in (root / tune.RESULTS).iterdir()] == ["gpu-clock-cap.json"]


# --- what a request cannot do ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "drop-caches.apply",  # unknown id
        "display-reserved-memory.apply",  # in the catalog, but not a one-click setting
        "gpu-clock-cap.reapply",  # unknown verb
        "gpu-clock-cap.apply.bak",
        "gpu-clock-cap",
        "GPU-CLOCK-CAP.apply",
        ".gpu-clock-cap.apply",
        "gpu-clock-cap.apply ",
        "gpu-clock-cap.apply;reboot",
        "$(reboot).apply",
    ],
)
def test_a_name_outside_the_table_is_removed_and_runs_nothing(root: Path, run: Runner, name: str) -> None:
    request = ask(root, name)
    assert tune.run_requests(root, run) == 0
    assert not request.exists()
    assert run.calls == [] and recorded(root) == [] and not (root / tune.RESULTS).exists()


def test_what_a_request_file_holds_is_never_read(root: Path, run: Runner) -> None:
    request = ask(root, "gpu-clock-cap.apply")
    request.write_text("-lgc 0,9999; reboot")
    request.chmod(0)  # opening it would fail
    assert tune.run_requests(root, run) == 0
    assert run.calls == [LOCK]


def test_a_link_named_like_a_request_is_removed_unfollowed_and_runs_nothing(
    root: Path, run: Runner, tmp_path: Path
) -> None:
    target = tmp_path / "shadow"
    target.write_text("secret")
    link = root / tune.REQUEST_DIR / "gpu-clock-cap.apply"
    link.symlink_to(target)
    assert tune.run_requests(root, run) == 0
    assert not link.is_symlink() and target.read_text() == "secret"
    assert run.calls == [] and recorded(root) == []


def test_a_directory_named_like_a_request_is_removed_and_runs_nothing(
    root: Path, run: Runner, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("kept")
    directory = root / tune.REQUEST_DIR / "gpu-clock-cap.apply"
    directory.mkdir()
    (directory / "cpu-pcore-cap.apply").touch()  # a request one level down: its name has a separator
    (directory / "out").symlink_to(outside)
    assert tune.run_requests(root, run) == 0
    assert list((root / tune.REQUEST_DIR).iterdir()) == []
    assert (outside / "keep").read_text() == "kept"
    assert run.calls == [] and recorded(root) == []


def test_a_request_directory_swapped_for_a_link_is_left_alone(
    root: Path, run: Runner, tmp_path: Path
) -> None:
    elsewhere = tmp_path / "etc"
    elsewhere.mkdir()
    (elsewhere / "gpu-clock-cap.apply").touch()
    (elsewhere / "passwd").write_text("root:x:0:0")
    (root / tune.REQUEST_DIR).rmdir()
    (root / tune.REQUEST_DIR).symlink_to(elsewhere)
    assert tune.run_requests(root, run) == 1
    assert sorted(p.name for p in elsewhere.iterdir()) == ["gpu-clock-cap.apply", "passwd"]
    assert run.calls == []


def test_every_command_in_the_table_is_an_absolute_path_with_fixed_arguments(root: Path, run: Runner) -> None:
    for name in tune.REQUESTS:
        ask(root, name)
    tune.run_requests(root, run)
    assert sorted(run.calls) == sorted(
        [
            LOCK,
            RESET,
            ["/usr/bin/systemctl", "set-default", "multi-user.target"],
            ["/usr/bin/systemctl", "set-default", "graphical.target"],
        ]
    )
    assert all(argv[0].startswith("/") for argv in run.calls)


# --- run_command: how a fixed command is started -------------------------------------------------------


@pytest.fixture
def program(tmp_path: Path) -> Path:
    """A program that writes down the arguments and environment it was started with."""
    program, seen = tmp_path / "program", tmp_path / "seen.json"
    program.write_text(
        f"#!{sys.executable}\nimport json, os, sys\n"
        f"json.dump({{'argv': sys.argv[1:], 'env': dict(os.environ)}}, open({str(seen)!r}, 'w'))\n"
        "sys.exit(int(os.environ.get('LC_ALL') != 'C'))\n"
    )
    program.chmod(0o755)
    return program


def test_a_command_gets_no_shell_and_none_of_the_callers_environment(
    program: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LD_PRELOAD", "/tmp/evil.so")
    monkeypatch.setenv("PYTHONPATH", "/tmp/evil")
    tune.run_command([str(program), "0,2200; touch pwned", "$HOME"])
    seen = json.loads((tmp_path / "seen.json").read_text())
    assert seen["argv"] == ["0,2200; touch pwned", "$HOME"]
    assert seen["env"]["PATH"] == "/usr/sbin:/usr/bin:/sbin:/bin"
    assert not {"LD_PRELOAD", "PYTHONPATH", "HOME", "USER"} & set(seen["env"])


def test_a_command_that_fails_hangs_or_is_missing_raises_with_the_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    failing = tmp_path / "failing"
    failing.write_text("#!/bin/sh\necho 'Insufficient Permissions' >&2\nexit 4\n")
    failing.chmod(0o755)
    with pytest.raises(tune.TuneError, match="failed with exit 4: Insufficient Permissions"):
        tune.run_command([str(failing)])
    with pytest.raises(tune.TuneError, match="cannot run"):
        tune.run_command([str(tmp_path / "missing")])
    hanging = tmp_path / "hanging"
    hanging.write_text("#!/bin/sh\nexec sleep 30\n")
    hanging.chmod(0o755)
    monkeypatch.setattr(tune, "TIMEOUT_S", 0.2)
    started = time.monotonic()
    with pytest.raises(tune.TuneError, match="did not finish within"):
        tune.run_command([str(hanging)])
    assert time.monotonic() - started < 5


# --- at boot, and when the helper is removed -------------------------------------------------------------


def record(root: Path, *ids: str) -> None:
    (root / tune.APPLIED).mkdir(parents=True, exist_ok=True)
    for rec_id in ids:
        (root / tune.APPLIED / rec_id).touch()


def test_reapply_applies_exactly_the_recorded_settings_a_reboot_forgets(root: Path, run: Runner) -> None:
    record(root, "gpu-clock-cap", "headless-boot", "fan-floor")  # the last is not in this release's table
    assert tune.reapply(root, run) == 0
    assert run.calls == [LOCK]
    assert max_freq(root)["policy5"] == 3900000  # the CPU cap was never recorded
    assert result(root, "gpu-clock-cap")["action"] == "reapply"
    assert recorded(root) == ["fan-floor", "gpu-clock-cap", "headless-boot"]


def test_reapply_with_nothing_recorded_does_nothing(root: Path, run: Runner) -> None:
    assert tune.reapply(root, run) == 0
    assert run.calls == [] and not (root / tune.STATE).exists()


def test_a_reapply_that_fails_says_so_in_its_result_and_exit_status(root: Path, run: Runner) -> None:
    record(root, "gpu-clock-cap", "cpu-pcore-cap")
    run.broken = {"/usr/bin/nvidia-smi"}
    assert tune.reapply(root, run) == 1
    assert result(root, "gpu-clock-cap")["ok"] is False
    assert result(root, "cpu-pcore-cap")["ok"] is True and max_freq(root)["policy5"] == 3000000


def test_undo_all_undoes_every_recorded_setting(root: Path, run: Runner) -> None:
    for name in ("gpu-clock-cap.apply", "cpu-pcore-cap.apply", "headless-boot.apply"):
        ask(root, name)
    tune.run_requests(root, run)
    run.calls.clear()
    assert tune.undo_all(root, run) == 0
    assert run.calls == [RESET, ["/usr/bin/systemctl", "set-default", "graphical.target"]]
    assert max_freq(root)["policy5"] == 3900000 and recorded(root) == []


# --- the command line ------------------------------------------------------------------------------------


def test_sparkline_tune_is_a_subcommand(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit:
        sparkline_main(["tune", "--help"])
    assert exit.value.code == 0
    assert "run-requests" in capsys.readouterr().out


def test_the_command_line_works_on_the_staged_root_it_is_given(root: Path) -> None:
    ask(root, "cpu-pcore-cap.apply")
    assert tune.main(["run-requests"], {"SPARKLINE_UPDATE_ROOT": str(root)}) == 0
    assert max_freq(root)["policy5"] == 3000000
    assert tune.main(["reapply"], {"SPARKLINE_UPDATE_ROOT": str(root)}) == 0
    assert tune.main(["undo-all"], {"SPARKLINE_UPDATE_ROOT": str(root)}) == 0
    assert max_freq(root)["policy5"] == 3900000


def test_on_the_real_root_it_refuses_to_run_without_root(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    monkeypatch.setattr(tune, "COMMANDS", {"run-requests": lambda root: pytest.fail("ran")})
    assert tune.main(["run-requests"], {}) == 1
    assert "needs root" in capsys.readouterr().err
