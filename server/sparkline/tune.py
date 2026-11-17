"""`sparkline tune`: the root helper behind one-click recommendations.

The agent cannot change the machine. To apply or undo a setting it leaves an empty file named `<id>.apply`
or `<id>.undo` in its request directory; sparkline-tune.path then starts `sparkline tune run-requests` as
root. The file's name is the only input, and it only selects a row of TUNES: every command and every value
is fixed here, in the release. Results go to a root-owned directory the agent can read.

`sparkline tune reapply` runs at boot (sparkline-tune-boot.service) for the settings the kernel or the
driver forgets. `sparkline tune undo-all` is run by install.sh before it removes the helper.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from .common.recommendations import CPU_PCORE_CAP_MHZ, GPU_CLOCK_CAP_MHZ

REQUEST_DIR = Path("var/lib/sparkline-agent/tune-requests")  # the DirectoryNotEmpty= of sparkline-tune.path
STATE = Path("var/lib/sparkline-tune")
RESULTS = STATE / "results"  # <id>.json: what the helper did last, for the agent to read
APPLIED = STATE / "applied"  # <id>: Sparkline applied this setting and has not undone it
CPUFREQ = Path("sys/devices/system/cpu/cpufreq")
NVIDIA_SMI = "/usr/bin/nvidia-smi"
SYSTEMCTL = "/usr/bin/systemctl"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}  # nothing is inherited
TIMEOUT_S = 30.0

Run = Callable[[list[str]], None]
Action = Callable[[Path, Run], str]  # (root, run) -> what it did. Sets a target state: safe to repeat


class TuneError(Exception):
    pass


def run_command(argv: list[str]) -> None:
    try:
        r = subprocess.run(
            argv,
            env=ENV,
            cwd="/",
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise TuneError(f"{' '.join(argv)} did not finish within {TIMEOUT_S:.0f} s") from None
    except OSError as e:
        raise TuneError(f"cannot run {argv[0]}: {e}") from None
    if r.returncode:
        said = (r.stderr or r.stdout).strip()[-300:]
        raise TuneError(f"{' '.join(argv)} failed with exit {r.returncode}: {said}")


def cap_gpu_clock(_root: Path, run: Run) -> str:
    run([NVIDIA_SMI, "-lgc", f"0,{GPU_CLOCK_CAP_MHZ}"])
    return f"GPU clock capped at {GPU_CLOCK_CAP_MHZ} MHz"


def reset_gpu_clock(_root: Path, run: Run) -> str:
    run([NVIDIA_SMI, "-rgc"])
    return "GPU clock cap removed"


def fast_policies(root: Path) -> list[tuple[Path, int]]:
    """The cpufreq policies whose cores can run above the cap, each with its hardware maximum in kHz."""
    found = []
    for policy in sorted((root / CPUFREQ).glob("policy*")):
        top = int((policy / "cpuinfo_max_freq").read_text())
        if top > CPU_PCORE_CAP_MHZ * 1000:
            found.append((policy, top))
    if not found:
        raise TuneError(f"no CPU core on this machine runs above {CPU_PCORE_CAP_MHZ} MHz")
    return found


def cap_pcores(root: Path, _run: Run) -> str:
    policies = fast_policies(root)
    for policy, _ in policies:
        (policy / "scaling_max_freq").write_text(str(CPU_PCORE_CAP_MHZ * 1000))
    return f"{len(policies)} CPU frequency policies capped at {CPU_PCORE_CAP_MHZ} MHz"


def uncap_pcores(root: Path, _run: Run) -> str:
    policies = fast_policies(root)
    for policy, top in policies:
        (policy / "scaling_max_freq").write_text(str(top))
    return f"{len(policies)} CPU frequency policies back at their hardware maximum"


def boot_headless(_root: Path, run: Run) -> str:
    run([SYSTEMCTL, "set-default", "multi-user.target"])
    return "Default boot target set to multi-user.target, from the next boot"


def boot_desktop(_root: Path, run: Run) -> str:
    run([SYSTEMCTL, "set-default", "graphical.target"])
    return "Default boot target set to graphical.target, from the next boot"


@dataclass(frozen=True)
class Tune:
    apply: Action
    undo: Action
    reapply_at_boot: bool  # the kernel or the driver forgets it at a reboot


TUNES: dict[str, Tune] = {
    "gpu-clock-cap": Tune(cap_gpu_clock, reset_gpu_clock, reapply_at_boot=True),
    "cpu-pcore-cap": Tune(cap_pcores, uncap_pcores, reapply_at_boot=True),
    "headless-boot": Tune(boot_headless, boot_desktop, reapply_at_boot=False),
}
# Every file name that is a request. A name is looked up here whole, never parsed.
REQUESTS: dict[str, tuple[str, str]] = {f"{i}.{verb}": (i, verb) for i in TUNES for verb in ("apply", "undo")}


def log(message: str) -> None:
    print(f"sparkline tune: {message}", file=sys.stderr, flush=True)


def write_result(root: Path, rec_id: str, result: dict) -> None:
    """Whole or not at all: the agent may read the file at any moment."""
    results = root / RESULTS
    results.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=results, prefix=f".{rec_id}.")
    with os.fdopen(fd, "w") as f:
        json.dump(result, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, results / f"{rec_id}.json")


def perform(root: Path, rec_id: str, verb: str, run: Run) -> bool:
    """Carry out one row of TUNES ("apply", "undo", or "reapply" at boot) and record the outcome."""
    tune = TUNES[rec_id]
    try:
        message, ok = (tune.undo if verb == "undo" else tune.apply)(root, run), True
    except (TuneError, OSError, ValueError) as e:
        message, ok = str(e), False
    record = root / APPLIED / rec_id
    if ok and verb == "undo":
        record.unlink(missing_ok=True)
    elif ok:
        record.parent.mkdir(parents=True, exist_ok=True)
        record.touch()
    write_result(root, rec_id, {"action": verb, "ts": time.time(), "ok": ok, "message": message})
    log(f"{rec_id} {verb}: {'ok' if ok else 'FAILED'}: {message}")
    return ok


def take(directory: int, name: str) -> bool:
    """Remove one entry of the request directory by name, without opening or following it. True if it was
    a plain file, the only kind that is a request."""
    kind = os.lstat(name, dir_fd=directory).st_mode
    if stat.S_ISDIR(kind):
        shutil.rmtree(name, dir_fd=directory)  # left there, it would start this helper again for ever
        return False
    os.unlink(name, dir_fd=directory)
    return stat.S_ISREG(kind)


def run_requests(root: Path, run: Run = run_command) -> int:
    """Empty the request directory, then carry out the requests that are in the table."""
    path = root / REQUEST_DIR
    try:  # O_NOFOLLOW: the agent's user owns the parent, and could put a link to another directory here
        directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as e:
        log(f"cannot open {path} as a directory: {e}")
        return 1
    requests = []
    try:
        for name in sorted(os.listdir(directory)):
            try:
                plain = take(directory, name)
            except OSError as e:
                log(f"cannot remove {name!r}: {e}")
                continue
            if plain and name in REQUESTS:
                requests.append(REQUESTS[name])
            else:
                log(f"ignored {name!r}: not a request")
    finally:
        os.close(directory)
    return int(not all([perform(root, rec_id, verb, run) for rec_id, verb in requests]))


def recorded(root: Path) -> list[str]:
    """The settings Sparkline applied, as far as this release's table knows them."""
    try:
        names = sorted(os.listdir(root / APPLIED))
    except FileNotFoundError:
        return []
    for name in names:
        if name not in TUNES:
            log(f"ignored the record {name!r}: not a setting of this release")
    return [n for n in names if n in TUNES]


def reapply(root: Path, run: Run = run_command) -> int:
    ids = [i for i in recorded(root) if TUNES[i].reapply_at_boot]
    return int(not all([perform(root, i, "reapply", run) for i in ids]))


def undo_all(root: Path, run: Run = run_command) -> int:
    return int(not all([perform(root, i, "undo", run) for i in recorded(root)]))


COMMANDS: dict[str, Callable[[Path], int]] = {
    "run-requests": run_requests,
    "reapply": reapply,
    "undo-all": undo_all,
}


def main(argv: list[str], env: Mapping[str, str] = os.environ) -> int:
    p = argparse.ArgumentParser(
        prog="sparkline tune",
        description="Root helper for the settings on the console's Recommendations tab. systemd runs it "
        "(sparkline-tune.service, sparkline-tune-boot.service); there is nothing here to run by hand.",
    )
    p.add_argument(
        "command",
        choices=list(COMMANDS),
        help="run-requests: carry out what the agent asked for. reapply: at boot, apply again the settings "
        "a reboot forgets. undo-all: undo every setting Sparkline applied",
    )
    args = p.parse_args(argv)
    root = Path(env.get("SPARKLINE_UPDATE_ROOT") or "/")  # test seam: a staged root, as for sparkline update
    if root == Path("/") and os.geteuid() != 0:
        log("needs root: it is started by systemd, not by hand")
        return 1
    return COMMANDS[args.command](root)
