"""`sparkline update`: update the console and the agent that deploy/install.sh installed on this host to the
latest GitHub release, by running that release's own installer in the same mode and prefix."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

RELEASES_API = "https://api.github.com/repos/sfxnz/sparkline/releases"
UNIT_DIR = Path("etc/systemd/system")
BENCHMARKS_DROPIN = UNIT_DIR / "sparkline-agent.service.d/10-benchmarks.conf"

Mode = Literal["console", "agent"]
# install.sh modes in the order an update runs them: the console before the agents (docs/RELEASING.md).
UNITS: dict[Mode, str] = {"console": "sparkline.service", "agent": "sparkline-agent.service"}

Version = tuple[int, int, int]

NOT_INSTALLED = """\
no Sparkline installed by install.sh on this host (no sparkline.service or sparkline-agent.service in \
/etc/systemd/system). To update another kind of install:
  Docker Compose:  git pull, then docker compose -f deploy/docker-compose.yml up -d --build
  Docker image:    run the new version's tag, ghcr.io/sfxnz/sparkline:X.Y.Z
  Source checkout: git pull, then (cd web && npm ci && npm run build) and run ./install.sh again"""


class UpdateError(Exception):
    pass


@dataclass(frozen=True)
class Component:
    """One part of Sparkline that install.sh put on this host."""

    mode: Mode
    prefix: Path
    version: Version | None  # None: no sparkline dist-info in the prefix's venv
    benchmarks: bool = False


@dataclass(frozen=True)
class Release:
    version: Version
    tarball_url: str
    sums_url: str

    @property
    def tarball(self) -> str:
        return f"sparkline-{show(self.version)}.tar.gz"


def parse_version(text: str) -> Version | None:
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", text)
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def show(version: Version | None) -> str:
    return ".".join(map(str, version)) if version else "unknown version"


def describe(c: Component) -> str:
    return f"{c.mode} {show(c.version)} in {c.prefix}" + (", benchmarks on" if c.benchmarks else "")


def detect(root: Path) -> list[Component]:
    """What install.sh installed under root, console first. Each prefix comes from its unit's ExecStart."""
    found = []
    for mode, unit in UNITS.items():
        path = root / UNIT_DIR / unit
        if not path.is_file():
            continue
        m = re.search(r"^ExecStart=(/\S+)/venv/bin/\S+", path.read_text(), re.MULTILINE)
        if not m:
            raise UpdateError(f"{path} has no ExecStart=<prefix>/venv/bin/...: install.sh did not write it")
        prefix = Path(m[1])
        bench = mode == "agent" and (root / BENCHMARKS_DROPIN).is_file()
        found.append(Component(mode, prefix, installed_version(root / prefix.relative_to("/")), bench))
    return found


def installed_version(prefix: Path) -> Version | None:
    infos = prefix.glob("venv/lib/python3*/site-packages/sparkline-*.dist-info")
    versions = [parse_version(i.name.removeprefix("sparkline-").removesuffix(".dist-info")) for i in infos]
    return max((v for v in versions if v), default=None)


def trusted_asset(url: str, api: str) -> bool:
    """On GitHub over https, or on the fake API's own origin when SPARKLINE_RELEASES_API points at one."""
    u = httpx.URL(url)
    if u.scheme == "https" and (u.host == "github.com" or u.host.endswith(".githubusercontent.com")):
        return True
    a = httpx.URL(api)
    return api != RELEASES_API and (u.scheme, u.host, u.port) == (a.scheme, a.host, a.port)


def latest_release(client: httpx.Client, api: str) -> Release:
    try:
        r = client.get(f"{api}/latest", headers={"Accept": "application/vnd.github+json"})
        if r.status_code == 404:
            raise UpdateError("no Sparkline release is published yet")
        r.raise_for_status()
        data = r.json()
        tag = str(data["tag_name"])
        assets = {str(a["name"]): str(a["browser_download_url"]) for a in data.get("assets", [])}
    except httpx.HTTPError as e:
        raise UpdateError(f"cannot read the latest release from {api}: {e}") from None
    except (ValueError, KeyError, TypeError) as e:
        raise UpdateError(f"unexpected answer from {api}/latest: {e!r}") from None
    version = parse_version(tag)
    if version is None:
        raise UpdateError(f"the latest release has the tag {tag!r}, not vX.Y.Z")
    tarball = f"sparkline-{show(version)}.tar.gz"
    if tarball not in assets or "SHA256SUMS" not in assets:
        raise UpdateError(
            f"release {tag} has no {tarball} and SHA256SUMS yet. The release job may still be running: "
            "try again in a few minutes"
        )
    for name in (tarball, "SHA256SUMS"):
        if not trusted_asset(assets[name], api):
            raise UpdateError(
                f"release {tag} has {name} at {assets[name]}, not an https URL on github.com: nothing was "
                "changed"
            )
    return Release(version, assets[tarball], assets["SHA256SUMS"])


def plan(
    installed: list[Component], release: Release, root: Path, dry_run: bool, reinstall: bool
) -> list[list[str]]:
    """install.sh arguments for each component to update, console first."""
    steps = []
    for c in installed:
        if not reinstall and c.version is not None and c.version >= release.version:
            continue
        args = [c.mode, "--yes", "--prefix", str(c.prefix)]
        if c.benchmarks:  # without it, install.sh agent removes the benchmarks drop-in
            args.append("--enable-benchmarks")
        if root != Path("/"):
            args += ["--destdir", str(root)]
        if dry_run:
            args.append("--dry-run")
        steps.append(args)
    return steps


def download(client: httpx.Client, url: str, dest: Path) -> None:
    try:
        with client.stream("GET", url) as r:
            r.raise_for_status()
            with dest.open("wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
    except httpx.HTTPError as e:
        raise UpdateError(f"cannot download {url}: {e}") from None


def verify(tarball: Path, sums: str) -> None:
    expected = [
        parts[0]
        for parts in map(str.split, sums.splitlines())
        if len(parts) == 2 and parts[1].lstrip("*") == tarball.name
    ]
    if not expected:
        raise UpdateError(f"SHA256SUMS has no line for {tarball.name}: nothing was changed")
    with tarball.open("rb") as f:
        actual = hashlib.file_digest(f, "sha256").hexdigest()
    if actual != expected[0].lower():
        raise UpdateError(
            f"{tarball.name} does not match its SHA256SUMS (got {actual}, expected {expected[0]}). The "
            "download is corrupt or was tampered with: nothing was changed"
        )


def extract(tarball: Path, dest: Path, release: Release) -> Path:
    try:
        with tarfile.open(tarball) as tar:
            tar.extractall(dest, filter="data")  # refuses absolute paths, "..", and links out of dest
    except (tarfile.TarError, OSError) as e:
        raise UpdateError(f"cannot unpack {tarball.name}: {e}. Nothing was changed") from None
    tree = dest / f"sparkline-{show(release.version)}"
    if not (tree / "deploy/install.sh").is_file():
        raise UpdateError(f"{tarball.name} has no sparkline-{show(release.version)}/deploy/install.sh")
    return tree


def run_installers(tree: Path, steps: list[list[str]]) -> None:
    for i, args in enumerate(steps):
        print(f"\n==> sparkline update: install.sh {' '.join(args)}", flush=True)
        code = subprocess.run(["bash", str(tree / "deploy/install.sh"), *args]).returncode
        if code:
            done = ", ".join(s[0] for s in steps[:i]) or "nothing"
            left = ", ".join(s[0] for s in steps[i + 1 :]) or "nothing"
            raise UpdateError(
                f"install.sh {args[0]} failed with exit {code} (its output is above). Updated: {done}. "
                f"Not attempted: {left}. Fix the cause and run: sudo sparkline update --reinstall"
            )


def ensure_root(argv: list[str], api: str) -> None:
    if os.geteuid() == 0:
        return
    if api != RELEASES_API:
        raise UpdateError(
            "updating needs root, and sudo drops SPARKLINE_RELEASES_API: run sparkline update as root with "
            "SPARKLINE_RELEASES_API set"
        )
    if sys.stdin.isatty():
        sys.stdout.flush()
        print("sparkline update needs root: running it again with sudo", file=sys.stderr, flush=True)
        # The venv's own script, not `python -m`, which would import from the working directory as root.
        script = Path(sys.executable).with_name("sparkline")
        os.execvp("sudo", ["sudo", str(script), "update", *argv])
    raise UpdateError("updating needs root. Run: sudo sparkline update")


def confirm(question: str) -> None:
    if not sys.stdin.isatty():
        raise UpdateError(f"{question} Re-run with --yes to confirm non-interactively.")
    if input(f"{question} [y/N] ").strip().lower() not in ("y", "yes"):
        raise UpdateError("cancelled: nothing was changed")


def update(args: argparse.Namespace, argv: list[str], root: Path, api: str, client: httpx.Client) -> int:
    installed = detect(root)
    if not installed:
        raise UpdateError(NOT_INSTALLED)
    release = latest_release(client, api)
    steps = plan(installed, release, root, args.dry_run, args.reinstall)
    for c in installed:
        print(f"Installed: {describe(c)}")
    if not steps:
        print(f"Sparkline {show(release.version)} is up to date.")
        return 0
    print(f"Latest release: {show(release.version)}")
    if args.check:
        print("Run: sudo sparkline update")
        return 0
    if not args.dry_run:
        if root == Path("/"):  # a staged root goes to install.sh --destdir, which needs no root
            ensure_root(argv, api)
        if not args.yes:
            parts = " and the ".join(s[0] for s in steps)
            confirm(f"Update the {parts} to {show(release.version)} and restart them?")
    with tempfile.TemporaryDirectory(prefix="sparkline-update-") as tmp:
        tarball = Path(tmp) / release.tarball
        print(f"Downloading {release.tarball}", flush=True)
        download(client, release.tarball_url, tarball)
        sums = Path(tmp) / "SHA256SUMS"
        download(client, release.sums_url, sums)
        verify(tarball, sums.read_text())
        print(f"Checksum OK: {release.tarball} matches SHA256SUMS", flush=True)
        tree = extract(tarball, Path(tmp) / "tree", release)
        run_installers(tree, steps)
    if args.dry_run:
        print(f"\nDry run: the {release.tarball} installers ran with --dry-run. Nothing was changed.")
    else:
        print(f"\nSparkline updated to {show(release.version)}.")
    return 0


def main(argv: list[str], env: Mapping[str, str] = os.environ, client: httpx.Client | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="sparkline update",
        description="Update the Sparkline console and agent installed on this host by install.sh to the "
        "latest release. Config and data are kept. Run it on the console host first, then on each node.",
    )
    p.add_argument("--check", action="store_true", help="compare with the latest release, change nothing")
    p.add_argument(
        "--dry-run", action="store_true", help="download and verify, then run the installers with --dry-run"
    )
    p.add_argument(
        "--reinstall",
        action="store_true",
        help="run the latest release's installer for every component, even one already at that version",
    )
    p.add_argument("-y", "--yes", action="store_true", help="don't ask for confirmation")
    args = p.parse_args(argv)
    # Test seams: a staged root (passed to install.sh as --destdir) and a local fake of the GitHub API.
    root = Path(env.get("SPARKLINE_UPDATE_ROOT") or "/")
    api = (env.get("SPARKLINE_RELEASES_API") or RELEASES_API).rstrip("/")
    try:
        with client or httpx.Client(follow_redirects=True, timeout=30) as c:
            return update(args, argv, root, api, c)
    except UpdateError as e:
        sys.stdout.flush()
        print(f"sparkline update: {e}", file=sys.stderr)
        return 1
