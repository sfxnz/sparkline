"""Whether each recommendation is already applied on this node: one read-only probe per catalog id.

A probe runs with the agent's own rights and changes nothing. It reads files under a root (so a test can
stage a machine), asks systemctl a fixed question, or takes the GPU clock the sampler last read. A probe
that cannot read what it needs says so ("unknown", with the reason): it never guesses.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from ..common.recommendations import CATALOG, CPU_PCORE_CAP_MHZ, GPU_CLOCK_CAP_MHZ
from ..common.schema import NodeRecommendations, NodeRecState, Problem, RecState, Sample, TuneResult
from ..tune import APPLIED, CPUFREQ, RESULTS

UNIT_DIR = Path("etc/systemd/system")
TUNE_PATH_UNIT = UNIT_DIR / "sparkline-tune.path"
SYSTEMCTL = "/usr/bin/systemctl"
# NVIDIA's EFI variable: four attribute bytes, the option, then the reserved size in MiB (little-endian).
DISPLAY_STATUS = Path("sys/firmware/efi/efivars/NvidiaDispFrmStatus-284e19b9-235f-4aab-ae4c-190456d1bd76")
DISPLAY_OPTIONS = {0: "Auto", 1: "0.5 GB", 2: "1 GB", 3: "2 GB", 5: "4 GB"}
DISPLAY_SMALL = (0, 1)  # Auto, or the fixed 0.5 GB that Auto picks without a display
# A capped clock sits on a step just under the cap (2177 or 2190 MHz for 2200). Uncapped under load it
# reads 2400 MHz and more.
CLOCK_MARGIN_MHZ = 50
NOT_GB10 = "This setting is for the DGX Spark, and this node has no GB10"

Reading = tuple[RecState, str]  # the state, and what the probe read


class Unreadable(Exception):
    """Something a probe needs could not be read. The message is the reason, shown to the reader."""


def run_readonly(argv: list[str]) -> str | None:
    """What a fixed read-only command printed, or None if it did not run or printed nothing."""
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None


def gpu_clock(sample: Sample | None) -> float | None:
    """The fastest GPU clock in the sampler's last sample, in MHz."""
    return max((g.sm_mhz for g in sample.gpu if g.sm_mhz is not None), default=None) if sample else None


@dataclass(frozen=True)
class Host:
    """What a probe may look at."""

    root: Path
    gb10: bool
    gpu_clock_mhz: Callable[[], float | None]
    run: Callable[[list[str]], str | None] = run_readonly

    def read(self, rel: Path) -> bytes | None:
        """A file's content, or None if there is no such file."""
        try:
            return (self.root / rel).read_bytes()
        except FileNotFoundError:
            return None
        except OSError as e:
            raise Unreadable(f"Cannot read /{rel}: {e.strerror}") from None

    def number(self, rel: Path) -> int:
        try:
            return int(self.read(rel) or b"")
        except ValueError:
            raise Unreadable(f"/{rel} holds no number") from None

    def names(self, rel: Path) -> list[str]:
        """The entries of a directory, or none if there is no such directory."""
        try:
            return sorted(os.listdir(self.root / rel))
        except FileNotFoundError:
            return []
        except OSError as e:
            raise Unreadable(f"Cannot list /{rel}: {e.strerror}") from None

    def systemctl(self, *args: str) -> str:
        out = self.run([SYSTEMCTL, *args])
        if out is None:
            raise Unreadable(f"systemctl {' '.join(args)} gave no answer")
        return out

    def recorded(self, rec_id: str) -> bool:
        """Whether Sparkline's helper applied this setting and has not undone it."""
        return (self.root / APPLIED / rec_id).exists()


def clock_lock(command: str) -> str | None:
    """The value an ExecStart= command line passes to nvidia-smi -lgc (such as "0,2200"), or None if the
    command does not lock the GPU clocks."""
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if not argv or Path(argv[0].lstrip("-@+!:")).name != "nvidia-smi":
        return None
    for i, arg in enumerate(argv):
        flag, _, value = arg.partition("=")
        if flag in ("-lgc", "--lock-gpu-clocks"):
            return value or "".join(argv[i + 1 : i + 2])
    return None


def foreign_clock_cap(h: Host) -> tuple[str, int | None] | None:
    """An active unit in /etc/systemd/system that locks the GPU clocks: its name and its maximum in MHz
    (None if the unit takes it from a variable)."""
    for name in h.names(UNIT_DIR):
        if not name.endswith(".service"):
            continue
        unit = (h.read(UNIT_DIR / name) or b"").decode(errors="replace")
        locks = [v for line in re.findall(r"^ExecStart=(.*)$", unit, re.MULTILINE) if (v := clock_lock(line))]
        if locks and h.systemctl("is-active", name) == "active":
            m = re.fullmatch(r"(?:\d+,)?(\d+)", locks[-1])
            return name, int(m[1]) if m else None
    return None


def gpu_clock_cap(h: Host) -> Reading:
    """The driver has no field that reports the cap. Two things show it: Sparkline's own record, or an
    active unit that sets one. A clock reading well above the cap contradicts both."""
    found = ("Sparkline", GPU_CLOCK_CAP_MHZ) if h.recorded("gpu-clock-cap") else foreign_clock_cap(h)
    if found is None:
        return "not-applied", (
            "No cap found: Sparkline has not applied one, and no active systemd unit runs nvidia-smi -lgc. "
            "A cap typed by hand cannot be seen, because the driver does not report it"
        )
    by, cap = found
    if cap is None:
        return "applied", f"Capped by {by}, which takes the limit from a variable"
    clock = h.gpu_clock_mhz()
    if clock is not None and clock > cap + CLOCK_MARGIN_MHZ:
        return "not-applied", (
            f"{by} set a cap of {cap} MHz, but the GPU clock reads {clock:.0f} MHz: the cap is not in effect"
        )
    return "applied", f"Capped at {cap} MHz by {by}"


def cpu_pcore_cap(h: Host) -> Reading:
    limits = []  # the current limit of every policy whose cores can run above the cap, in kHz
    for name in h.names(CPUFREQ):
        if (
            name.startswith("policy")
            and h.number(CPUFREQ / name / "cpuinfo_max_freq") > CPU_PCORE_CAP_MHZ * 1000
        ):
            limits.append(h.number(CPUFREQ / name / "scaling_max_freq"))
    if not limits:
        return "not-applicable", f"No CPU core on this machine runs above {CPU_PCORE_CAP_MHZ} MHz"
    highest = max(limits) // 1000
    if highest > CPU_PCORE_CAP_MHZ:
        return "not-applied", f"The performance cores may run up to {highest} MHz"
    return "applied", f"The performance cores ({len(limits)} frequency policies) are capped at {highest} MHz"


def headless_boot(h: Host) -> Reading:
    """The default target says what the next boot does. Whether a desktop runs now is a second fact."""
    default = h.systemctl("get-default")
    desktop = h.run([SYSTEMCTL, "is-active", "display-manager.service"])
    now = {
        None: "Whether the desktop is running now could not be read",
        "active": "The desktop is running now",
    }.get(desktop, "The desktop is not running now")
    if default == "multi-user.target":
        return "applied", f"Boots without the desktop (multi-user.target). {now}"
    if default == "graphical.target":
        return "not-applied", f"Boots to the desktop (graphical.target). {now}"
    return "unknown", f"Boots to {default}, which is neither graphical.target nor multi-user.target"


def display_reserved_memory(h: Host) -> Reading:
    status = h.read(DISPLAY_STATUS)
    if status is None:
        return "not-applicable", (
            "This firmware has no Display Reserved Memory setting. It came with firmware OTA2610, and some "
            "makers' firmware leaves it out"
        )
    if len(status) < 9 or status[4] not in DISPLAY_OPTIONS:
        return "unknown", f"/{DISPLAY_STATUS} holds a value this release does not know: {status.hex(' ')}"
    reserved = int.from_bytes(status[5:9], "little")
    state: RecState = "applied" if status[4] in DISPLAY_SMALL else "not-applied"
    return state, f"Set to {DISPLAY_OPTIONS[status[4]]}: {reserved} MiB reserved"


Probe = Callable[[Host], Reading]
PROBES: dict[str, Probe] = {
    "gpu-clock-cap": gpu_clock_cap,
    "cpu-pcore-cap": cpu_pcore_cap,
    "headless-boot": headless_boot,
    "display-reserved-memory": display_reserved_memory,
}


def request_dir(root: Path) -> Path | None:
    """The directory where an empty file starts sparkline-tune.service as root: the DirectoryNotEmpty= of
    the path unit that install.sh agent --enable-tune installed under root, or None without that unit."""
    try:
        unit = (root / TUNE_PATH_UNIT).read_text()
    except FileNotFoundError:
        return None
    m = re.search(r"^DirectoryNotEmpty=(/\S+)$", unit, re.MULTILINE)
    return root / m[1].lstrip("/") if m else None


def no_helper(node_id: str) -> Problem:
    """install.sh turns off what it is not given, so the fix names no command line: one copied from here
    would drop --enable-benchmarks."""
    return Problem(
        message=f"{node_id} does not take one-click settings",
        cause=f"/{TUNE_PATH_UNIT} is not installed",
        fix=(
            f"Run install.sh agent again on {node_id} with --enable-tune added to the flags it was installed "
            "with. Keep --enable-benchmarks if the node runs benchmarks: the installer turns off what is "
            "left out. Or type the commands"
        ),
    )


def last_result(root: Path, rec_id: str) -> TuneResult | None:
    try:
        return TuneResult.model_validate_json((root / RESULTS / f"{rec_id}.json").read_bytes())
    except (OSError, ValidationError):
        return None


def read(h: Host, rec_id: str) -> Reading:
    if not h.gb10:
        return "not-applicable", NOT_GB10
    try:
        return PROBES[rec_id](h)
    except Unreadable as e:
        return "unknown", str(e)


def node_recommendations(h: Host, node_id: str) -> NodeRecommendations:
    items = []
    for rec in CATALOG:
        state, detail = read(h, rec.id)
        managed = state == "applied" and h.recorded(rec.id)
        items.append(
            NodeRecState(
                id=rec.id, state=state, detail=detail, managed=managed, last=last_result(h.root, rec.id)
            )
        )
    return NodeRecommendations(one_click=None if request_dir(h.root) else no_helper(node_id), items=items)
