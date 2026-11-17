"""The agent's read-only probes: is each recommendation already applied on this node? Each probe reads a
staged root and a fake systemctl, never the machine the tests run on."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sparkline import tune
from sparkline.agent import recommend
from sparkline.agent.recommend import Host
from sparkline.common.recommendations import CATALOG
from sparkline.common.schema import NodeRecState, Sample

UNITS = Path("etc/systemd/system")
LOCK_UNIT = """\
[Unit]
Description=Lock the GPU clocks
After=nvidia-persistenced.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/nvidia-smi -lgc 0,2200
ExecStop=/usr/bin/nvidia-smi -rgc

[Install]
WantedBy=multi-user.target
"""
DISPLAY_2GB = bytes.fromhex("06 00 00 00 03 00 08 00 00")
DISPLAY_AUTO = bytes.fromhex("06 00 00 00 00 00 02 00 00")
NO_ROOT = pytest.mark.skipif(os.geteuid() == 0, reason="root reads a file whatever its mode")


class Machine:
    """A staged DGX Spark with nothing applied: it boots to the desktop, and no display manager is running."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.clock: float | None = 2411.0
        self.gb10 = True
        self.systemctl: dict[tuple[str, ...], str | None] = {
            ("get-default",): "graphical.target",
            ("is-active", "display-manager.service"): "inactive",
        }
        (root / UNITS).mkdir(parents=True)
        for policy, top in (("policy0", 2808000), ("policy5", 3900000), ("policy15", 3900000)):
            self.cpu(policy, top, top)
        self.file(recommend.DISPLAY_STATUS, DISPLAY_2GB)

    def file(self, rel: Path, content: bytes | str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode() if isinstance(content, str) else content)
        return path

    def cpu(self, policy: str, top: int, limit: int) -> None:
        self.file(tune.CPUFREQ / policy / "cpuinfo_max_freq", f"{top}\n")
        self.file(tune.CPUFREQ / policy / "scaling_max_freq", f"{limit}\n")

    def unit(self, name: str, text: str = LOCK_UNIT, state: str | None = "active") -> Path:
        self.systemctl[("is-active", name)] = state
        return self.file(UNITS / name, text)

    def record(self, rec_id: str) -> None:
        self.file(tune.APPLIED / rec_id, b"")

    def run(self, argv: list[str]) -> str | None:
        assert argv[0] == "/usr/bin/systemctl"
        return self.systemctl.get(tuple(argv[1:]))

    def state(self, rec_id: str) -> NodeRecState:
        host = Host(self.root, self.gb10, lambda: self.clock, self.run)
        items = {i.id: i for i in recommend.node_recommendations(host, "n1").items}
        return items[rec_id]

    def read(self, rec_id: str) -> tuple[str, str, bool]:
        s = self.state(rec_id)
        return s.state, s.detail, s.managed


@pytest.fixture
def m(tmp_path: Path) -> Machine:
    return Machine(tmp_path / "root")


def test_every_recommendation_has_a_probe_and_is_reported_in_catalog_order(m: Machine) -> None:
    ids = [r.id for r in CATALOG]
    assert list(recommend.PROBES) == ids
    host = Host(m.root, True, lambda: None, m.run)
    assert [i.id for i in recommend.node_recommendations(host, "n1").items] == ids


def test_a_node_without_a_gb10_reports_every_setting_as_not_applicable(m: Machine) -> None:
    m.gb10 = False
    m.record("gpu-clock-cap")
    for rec in CATALOG:
        assert m.read(rec.id) == (
            "not-applicable",
            "This setting is for the DGX Spark, and this node has no GB10",
            False,
        )


# --- gpu-clock-cap ----------------------------------------------------------------------------------------


def test_gpu_cap_not_applied_says_what_was_looked_for(m: Machine) -> None:
    state, detail, managed = m.read("gpu-clock-cap")
    assert (state, managed) == ("not-applied", False)
    assert detail.startswith("No cap found: Sparkline has not applied one, and no active systemd unit")


def test_gpu_cap_applied_by_sparkline_is_sparklines_to_undo(m: Machine) -> None:
    m.record("gpu-clock-cap")
    m.clock = 2177.0
    assert m.read("gpu-clock-cap") == ("applied", "Capped at 2200 MHz by Sparkline", True)


def test_gpu_cap_applied_by_another_unit_names_the_unit_and_is_not_sparklines_to_undo(m: Machine) -> None:
    m.unit("nvidia-lock-clocks.service")
    m.clock = 2190.0
    assert m.read("gpu-clock-cap") == ("applied", "Capped at 2200 MHz by nvidia-lock-clocks.service", False)


@pytest.mark.parametrize(
    ("exec_start", "detail"),
    [
        ("/usr/bin/nvidia-smi --lock-gpu-clocks=300,2000", "Capped at 2000 MHz by cap.service"),
        ("/usr/bin/nvidia-smi --lock-gpu-clocks 200,2150", "Capped at 2150 MHz by cap.service"),
        ("-/usr/bin/nvidia-smi -i 0 -lgc 0,1800", "Capped at 1800 MHz by cap.service"),
        (
            "/usr/bin/nvidia-smi -lgc 0,${GPU_MAX_MHZ}",
            "Capped by cap.service, which takes the limit from a variable",
        ),
    ],
)
def test_gpu_cap_is_read_from_every_way_a_unit_can_write_it(m: Machine, exec_start: str, detail: str) -> None:
    m.unit("cap.service", f"[Service]\nExecStart=/usr/bin/nvidia-smi -pm 1\nExecStart={exec_start}\n")
    m.clock = None
    assert m.read("gpu-clock-cap") == ("applied", detail, False)


@pytest.mark.parametrize(
    "unit",
    [
        "[Service]\nExecStart=/usr/bin/nvidia-smi -pm 1\nExecStop=/usr/bin/nvidia-smi -lgc 0,2200\n",
        "[Service]\nExecStart=/usr/bin/echo nvidia-smi -lgc 0,2200\n",
        "[Service]\nExecStart=/usr/bin/nvidia-smi -rgc\n",
        "[Service]\n# ExecStart=/usr/bin/nvidia-smi -lgc 0,2200\nExecStart=/bin/true 'unbalanced\n",
    ],
)
def test_a_unit_that_does_not_lock_the_clocks_at_start_is_not_a_cap(m: Machine, unit: str) -> None:
    m.unit("other.service", unit)
    assert m.read("gpu-clock-cap")[0] == "not-applied"


def test_a_cap_unit_that_is_not_active_is_not_a_cap(m: Machine) -> None:
    m.unit("nvidia-lock-clocks.service", state="inactive")
    assert m.read("gpu-clock-cap")[0] == "not-applied"


@pytest.mark.parametrize("by", ["Sparkline", "nvidia-lock-clocks.service"])
def test_a_clock_reading_well_above_the_cap_contradicts_it(m: Machine, by: str) -> None:
    if by == "Sparkline":
        m.record("gpu-clock-cap")
    else:
        m.unit(by)
    m.clock = 2411.0
    assert m.read("gpu-clock-cap") == (
        "not-applied",
        f"{by} set a cap of 2200 MHz, but the GPU clock reads 2411 MHz: the cap is not in effect",
        False,
    )
    m.clock = 2233.0  # within the margin of a clock step
    assert m.read("gpu-clock-cap")[0] == "applied"
    m.clock = None  # no clock reading: nothing contradicts the record
    assert m.read("gpu-clock-cap")[0] == "applied"


def test_gpu_cap_is_unknown_when_systemd_does_not_say_whether_the_unit_is_active(m: Machine) -> None:
    m.unit("nvidia-lock-clocks.service", state=None)
    assert m.read("gpu-clock-cap") == (
        "unknown",
        "systemctl is-active nvidia-lock-clocks.service gave no answer",
        False,
    )


@NO_ROOT
def test_gpu_cap_is_unknown_when_a_unit_file_cannot_be_read(m: Machine) -> None:
    m.unit("private.service").chmod(0)
    assert m.read("gpu-clock-cap") == (
        "unknown",
        "Cannot read /etc/systemd/system/private.service: Permission denied",
        False,
    )


def test_a_dangling_unit_link_is_skipped(m: Machine) -> None:
    (m.root / UNITS / "gone.service").symlink_to(m.root / "lib/systemd/system/gone.service")
    m.unit("nvidia-lock-clocks.service")
    m.clock = 2177.0
    assert m.read("gpu-clock-cap")[0] == "applied"


def test_the_gpu_clock_is_the_fastest_in_the_last_sample() -> None:
    doc = json.loads((Path(__file__).parent / "fixtures/console/sample.json").read_text())
    sample = Sample.model_validate(doc)
    assert recommend.gpu_clock(sample) == 2890.0
    assert recommend.gpu_clock(sample.model_copy(update={"gpu": []})) is None
    assert recommend.gpu_clock(None) is None


# --- cpu-pcore-cap ----------------------------------------------------------------------------------------


def test_cpu_cap_not_applied(m: Machine) -> None:
    assert m.read("cpu-pcore-cap") == ("not-applied", "The performance cores may run up to 3900 MHz", False)


def test_cpu_cap_half_applied_is_not_applied(m: Machine) -> None:
    m.cpu("policy5", 3900000, 3000000)
    assert m.read("cpu-pcore-cap")[0] == "not-applied"


@pytest.mark.parametrize(("limit", "by_sparkline"), [(3000000, True), (3000000, False), (2600000, False)])
def test_cpu_cap_applied_by_sparkline_or_by_other_means(m: Machine, limit: int, by_sparkline: bool) -> None:
    for policy in ("policy5", "policy15"):
        m.cpu(policy, 3900000, limit)
    if by_sparkline:
        m.record("cpu-pcore-cap")
    assert m.read("cpu-pcore-cap") == (
        "applied",
        f"The performance cores (2 frequency policies) are capped at {limit // 1000} MHz",
        by_sparkline,
    )


def test_cpu_cap_does_not_apply_to_a_machine_with_no_core_above_it(m: Machine, tmp_path: Path) -> None:
    for policy in ("policy5", "policy15"):
        m.cpu(policy, 2808000, 2808000)
    assert m.read("cpu-pcore-cap") == (
        "not-applicable",
        "No CPU core on this machine runs above 3000 MHz",
        False,
    )
    bare = Machine(tmp_path / "no-cpufreq")
    for policy in (bare.root / tune.CPUFREQ).iterdir():
        for f in policy.iterdir():
            f.unlink()
        policy.rmdir()
    assert bare.read("cpu-pcore-cap")[0] == "not-applicable"


def test_cpu_cap_is_unknown_when_a_policy_has_no_readable_limit(m: Machine) -> None:
    (m.root / tune.CPUFREQ / "policy5/scaling_max_freq").unlink()
    assert m.read("cpu-pcore-cap") == (
        "unknown",
        "/sys/devices/system/cpu/cpufreq/policy5/scaling_max_freq holds no number",
        False,
    )


@NO_ROOT
def test_cpu_cap_is_unknown_when_cpufreq_cannot_be_read(m: Machine) -> None:
    (m.root / tune.CPUFREQ / "policy5/cpuinfo_max_freq").chmod(0)
    assert m.read("cpu-pcore-cap") == (
        "unknown",
        "Cannot read /sys/devices/system/cpu/cpufreq/policy5/cpuinfo_max_freq: Permission denied",
        False,
    )


# --- headless-boot ----------------------------------------------------------------------------------------


def test_headless_boot_not_applied_says_what_boots_and_what_runs_now(m: Machine) -> None:
    assert m.read("headless-boot") == (
        "not-applied",
        "Boots to the desktop (graphical.target). The desktop is not running now",
        False,
    )
    m.systemctl[("is-active", "display-manager.service")] = "active"
    assert m.read("headless-boot")[1] == "Boots to the desktop (graphical.target). The desktop is running now"


@pytest.mark.parametrize("by_sparkline", [True, False])
def test_headless_boot_applied_before_the_reboot_that_stops_the_desktop(
    m: Machine, by_sparkline: bool
) -> None:
    m.systemctl[("get-default",)] = "multi-user.target"
    m.systemctl[("is-active", "display-manager.service")] = "active"
    if by_sparkline:
        m.record("headless-boot")
    assert m.read("headless-boot") == (
        "applied",
        "Boots without the desktop (multi-user.target). The desktop is running now",
        by_sparkline,
    )


def test_headless_boot_is_decided_by_the_boot_target_even_when_the_desktop_cannot_be_asked(
    m: Machine,
) -> None:
    m.systemctl[("get-default",)] = "multi-user.target"
    del m.systemctl[("is-active", "display-manager.service")]
    assert m.read("headless-boot") == (
        "applied",
        "Boots without the desktop (multi-user.target). Whether the desktop is running now could not be read",
        False,
    )


def test_headless_boot_is_unknown_without_a_boot_target_or_with_another_one(m: Machine) -> None:
    m.systemctl[("get-default",)] = "rescue.target"
    assert m.read("headless-boot") == (
        "unknown",
        "Boots to rescue.target, which is neither graphical.target nor multi-user.target",
        False,
    )
    del m.systemctl[("get-default",)]
    assert m.read("headless-boot") == ("unknown", "systemctl get-default gave no answer", False)


# --- display-reserved-memory ------------------------------------------------------------------------------


def test_display_memory_at_the_default_is_not_applied(m: Machine) -> None:
    assert m.read("display-reserved-memory") == ("not-applied", "Set to 2 GB: 2048 MiB reserved", False)


@pytest.mark.parametrize(
    ("status", "detail"),
    [
        (DISPLAY_AUTO, "Set to Auto: 512 MiB reserved"),
        (bytes.fromhex("06 00 00 00 00 00 08 00 00"), "Set to Auto: 2048 MiB reserved"),  # a display at boot
        (bytes.fromhex("06 00 00 00 01 00 02 00 00"), "Set to 0.5 GB: 512 MiB reserved"),
    ],
)
def test_display_memory_set_to_auto_or_the_smallest_size_is_applied(
    m: Machine, status: bytes, detail: str
) -> None:
    m.file(recommend.DISPLAY_STATUS, status)
    assert m.read("display-reserved-memory") == ("applied", detail, False)


def test_display_memory_does_not_apply_to_firmware_without_the_setting(m: Machine) -> None:
    (m.root / recommend.DISPLAY_STATUS).unlink()
    state, detail, _ = m.read("display-reserved-memory")
    assert state == "not-applicable" and detail.startswith("This firmware has no Display Reserved Memory")


@pytest.mark.parametrize(
    "status", [b"", bytes.fromhex("06 00 00 00 03"), bytes.fromhex("06 00 00 00 09 00 08 00 00")]
)
def test_display_memory_is_unknown_when_the_variable_is_not_what_nvidia_documents(
    m: Machine, status: bytes
) -> None:
    m.file(recommend.DISPLAY_STATUS, status)
    state, detail, _ = m.read("display-reserved-memory")
    assert state == "unknown" and "holds a value this release does not know" in detail


@NO_ROOT
def test_display_memory_is_unknown_when_the_variable_cannot_be_read(m: Machine) -> None:
    (m.root / recommend.DISPLAY_STATUS).chmod(0)
    state, detail, _ = m.read("display-reserved-memory")
    assert state == "unknown" and detail.endswith("Permission denied")


# --- what the helper did last, and whether the node takes clicks ------------------------------------------


def test_the_helpers_last_result_is_reported_and_a_damaged_one_is_not(m: Machine) -> None:
    assert m.state("gpu-clock-cap").last is None
    result = {"action": "apply", "ts": 1763400000.0, "ok": False, "message": "nvidia-smi failed with exit 4"}
    m.file(tune.RESULTS / "gpu-clock-cap.json", json.dumps(result))
    last = m.state("gpu-clock-cap").last
    assert last is not None and last.model_dump() == result
    assert m.state("cpu-pcore-cap").last is None
    m.file(tune.RESULTS / "gpu-clock-cap.json", '{"action": "apply"')
    assert m.state("gpu-clock-cap").last is None


def test_a_node_takes_clicks_only_with_the_path_unit_installed(m: Machine) -> None:
    host = Host(m.root, True, lambda: None, m.run)
    problem = recommend.node_recommendations(host, "n1").one_click
    assert problem is not None and problem.message == "n1 does not take one-click settings"
    assert "--enable-tune added to the flags it was installed with" in problem.fix
    # install.sh turns off what it is not given: the fix must not be a command line that drops a flag
    assert "Keep --enable-benchmarks if the node runs benchmarks" in problem.fix
    assert "install.sh agent --enable-tune" not in problem.fix
    m.file(recommend.TUNE_PATH_UNIT, "[Path]\nDirectoryNotEmpty=/var/lib/sparkline-agent/tune-requests\n")
    assert recommend.node_recommendations(host, "n1").one_click is None
    assert recommend.request_dir(m.root) == m.root / tune.REQUEST_DIR
    m.file(recommend.TUNE_PATH_UNIT, "[Path]\n")
    assert recommend.node_recommendations(host, "n1").one_click is not None
