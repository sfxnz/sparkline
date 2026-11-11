"""`sparkline update`: update the console and the agent that deploy/install.sh installed on this host to the
latest GitHub release, by running that release's own installer in the same mode and prefix. On the console
host it then asks every node in the console's config to do the same, through each agent's
POST /api/v1/update."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shlex
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from collections.abc import Collection, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal

import httpx

from .console.config import load_config as load_console_config

RELEASES_API = "https://api.github.com/repos/sfxnz/sparkline/releases"
UNIT_DIR = Path("etc/systemd/system")
BENCHMARKS_DROPIN = UNIT_DIR / "sparkline-agent.service.d/10-benchmarks.conf"
CONSOLE_CONFIG = Path("etc/sparkline/console.toml")
NODE_TIMEOUT_S = 600.0  # a node downloads the release and rebuilds its venv, then restarts its agent
POLL_S = 2.0
FIRST_WITH_UPDATE = (0, 1, 1)  # the first release that has `sparkline update`

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


@dataclass(frozen=True)
class NodeTarget:
    """One [[nodes]] entry of the console's config: an agent to update."""

    id: str
    url: str


class Outcome(StrEnum):
    UP_TO_DATE = "up_to_date"
    UPDATE_AVAILABLE = "update_available"  # --check and --dry-run: the node was not asked
    UPDATED = "updated"
    BUSY = "busy"  # a benchmark is running there
    NEEDS_MANUAL_UPDATE = "needs_manual_update"  # its agent cannot update itself: someone must log in once
    UNREACHABLE = "unreachable"
    TIMED_OUT = "timed_out"
    ERROR = "error"


@dataclass(frozen=True)
class NodeResult:
    node: NodeTarget
    outcome: Outcome
    detail: str

    @property
    def current(self) -> bool:
        return self.outcome in (Outcome.UP_TO_DATE, Outcome.UPDATED)


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


def node_targets(root: Path, env: Mapping[str, str]) -> tuple[list[NodeTarget], str]:
    """The console's [[nodes]] and agent token, read with the console's own loader and env overrides."""
    path = root / CONSOLE_CONFIG
    try:
        cfg = load_console_config(path, env)
    except (OSError, ValueError) as e:
        raise UpdateError(
            f"cannot read the nodes from {path}: {e}. "
            "sudo sparkline update --this-host updates only this host"
        ) from None
    return [NodeTarget(n.id, n.url.rstrip("/")) for n in cfg.nodes], cfg.agent_token


def agent_version(client: httpx.Client, node: NodeTarget, headers: dict[str, str]) -> Version | None:
    r = client.get(f"{node.url}/api/v1/info", headers=headers)
    r.raise_for_status()
    return parse_version(str(r.json()["agent_version"]))


def manual_update(node: NodeTarget, version: Version | None) -> str:
    if version is not None and version >= FIRST_WITH_UPDATE:
        return (
            f"agent {show(version)} cannot be updated remotely. Run once on {node.id}: sudo sparkline update"
        )
    return (
        f"agent {show(version)} cannot be updated remotely. Run once on {node.id}, from a checkout of the "
        "latest release: sudo ./install.sh agent (add --enable-benchmarks if it runs benchmarks)"
    )


def update_node(
    client: httpx.Client, node: NodeTarget, headers: dict[str, str], latest: Version, ask: bool
) -> NodeResult:
    """Read the node's version and, if it is behind and ask is set, ask it to update and wait until it is."""
    try:
        before = agent_version(client, node, headers)
    except httpx.TransportError as e:
        return NodeResult(node, Outcome.UNREACHABLE, f"{node.url}: {e}")
    except httpx.HTTPStatusError as e:
        hint = (
            ": the console's agent_token does not match this node's token"
            if e.response.status_code == 401
            else ""
        )
        return NodeResult(node, Outcome.ERROR, f"HTTP {e.response.status_code} from {e.request.url}{hint}")
    except (ValueError, KeyError) as e:
        return NodeResult(node, Outcome.ERROR, f"unexpected answer from {node.url}/api/v1/info: {e!r}")
    if before is not None and before >= latest:
        return NodeResult(node, Outcome.UP_TO_DATE, show(before))
    if not ask:
        return NodeResult(node, Outcome.UPDATE_AVAILABLE, f"{show(before)}, latest {show(latest)}")
    try:
        r = client.post(f"{node.url}/api/v1/update", headers=headers)
    except httpx.TransportError as e:
        return NodeResult(node, Outcome.UNREACHABLE, f"{node.url}: {e}")
    if r.status_code == 409:
        return NodeResult(
            node,
            Outcome.BUSY,
            f"{show(before)}: a benchmark is running. Run sudo sparkline update when it ends",
        )
    if r.status_code == 404:  # an agent older than POST /api/v1/update
        return NodeResult(node, Outcome.NEEDS_MANUAL_UPDATE, manual_update(node, before))
    if r.status_code == 501:
        return NodeResult(
            node,
            Outcome.NEEDS_MANUAL_UPDATE,
            f"agent {show(before)} has no sparkline-update.path: update {node.id} the way it was installed, "
            "or reinstall it with install.sh agent",
        )
    if r.status_code != 202:
        return NodeResult(node, Outcome.ERROR, f"HTTP {r.status_code} from POST {node.url}/api/v1/update")
    return wait_until_current(client, node, headers, latest, before, "sparkline-update")


def wait_until_current(
    client: httpx.Client,
    node: NodeTarget,
    headers: dict[str, str],
    latest: Version,
    before: Version | None,
    unit: str,
) -> NodeResult:
    now = before
    deadline = time.monotonic() + NODE_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_S)
        try:
            now = agent_version(client, node, headers)
        except (httpx.HTTPError, ValueError, KeyError):
            continue  # its agent restarts at the end of the update
        if now is not None and now >= latest:
            return NodeResult(node, Outcome.UPDATED, f"{show(before)} -> {show(now)}")
    return NodeResult(
        node,
        Outcome.TIMED_OUT,
        f"still {show(now)} after {NODE_TIMEOUT_S:.0f} s. On {node.id}: journalctl -u {unit}",
    )


def update_nodes(
    client: httpx.Client,
    nodes: list[NodeTarget],
    token: str,
    latest: Version,
    ask: bool,
    updated_here: Mapping[NodeTarget, Version | None] | None = None,
) -> list[NodeResult]:
    """All nodes at once, so a cluster takes as long as its slowest node. A node in updated_here is this
    host's own agent, which this host's update already installed: it is only waited for, from the version
    given."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    here = updated_here or {}

    def one(n: NodeTarget) -> NodeResult:
        if n in here:
            return wait_until_current(client, n, headers, latest, here[n], "sparkline-agent")
        return update_node(client, n, headers, latest, ask)

    with ThreadPoolExecutor(max_workers=max(1, len(nodes))) as pool:
        return list(pool.map(one, nodes))


def on_this_host(url: str) -> bool:
    """Whether the URL's host is an address of this host: only a local address can be bound."""
    try:
        addresses = socket.getaddrinfo(httpx.URL(url).host, None, proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError, httpx.InvalidURL):
        return False
    for family, kind, proto, _, address in addresses:
        try:
            with socket.socket(family, kind, proto) as s:
                s.bind((address[0], 0, *address[2:]))
        except OSError:
            continue
        return True
    return False


def print_nodes(results: list[NodeResult], here: Collection[NodeTarget] = ()) -> None:
    width = max((len(r.node.id) for r in results), default=0)
    for r in results:
        mark = " (this host)" if r.node in here else ""
        print(f"  {r.node.id:<{width}}  {r.outcome:<19}  {r.detail}{mark}")


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
    raise UpdateError(f"updating needs root. Run: {shlex.join(['sudo', 'sparkline', 'update', *argv])}")


def confirm(question: str) -> None:
    if not sys.stdin.isatty():
        raise UpdateError(f"{question} Re-run with --yes to confirm non-interactively.")
    if input(f"{question} [y/N] ").strip().lower() not in ("y", "yes"):
        raise UpdateError("cancelled: nothing was changed")


def update(
    args: argparse.Namespace,
    argv: list[str],
    root: Path,
    api: str,
    env: Mapping[str, str],
    client: httpx.Client,
    agents: httpx.Client,
) -> int:
    installed = detect(root)
    if not installed:
        raise UpdateError(NOT_INSTALLED)
    release = latest_release(client, api)
    steps = plan(installed, release, root, args.dry_run, args.reinstall)
    fleet = not args.this_host and any(c.mode == "console" for c in installed)
    nodes: list[NodeTarget] = []
    here: set[NodeTarget] = set()  # this host's own agent, which this host's update installs
    token = ""
    if fleet:
        if root == Path("/"):  # the agent token is in a root-only file
            ensure_root(argv, api)
        nodes, token = node_targets(root, env)
        if any(c.mode == "agent" for c in installed):
            here = {n for n in nodes if on_this_host(n.url)}
    for c in installed:
        print(f"Installed: {describe(c)}")
    if steps:
        print(f"Latest release: {show(release.version)}")
    else:
        print(f"Sparkline {show(release.version)} is up to date on this host.")
    before = update_nodes(agents, nodes, token, release.version, ask=False) if nodes else []
    if fleet:
        print(f"Nodes in /{CONSOLE_CONFIG}:" if nodes else f"No [[nodes]] in /{CONSOLE_CONFIG}.")
        print_nodes(before, here)
    behind = [r.node for r in before if not r.current]
    asking = [n for n in behind if n not in here]
    if not steps and not asking:
        return 0
    if args.check:
        print("Run: sudo sparkline update")
        return 0
    if not args.dry_run:
        if root == Path("/"):  # a staged root goes to install.sh --destdir, which needs no root
            ensure_root(argv, api)
        if not args.yes:
            parts = [" and the ".join(s[0] for s in steps)] if steps else []
            if asking:
                parts.append(
                    f"{len(asking)} node{'s' * (len(asking) > 1)} ({', '.join(n.id for n in asking)})"
                )
            confirm(f"Update the {', then '.join(parts)} to {show(release.version)} and restart them?")
    if steps:
        update_this_host(args, release, steps, client)
    ids = ", ".join(n.id for n in asking)
    if args.dry_run:
        if asking:
            print(f"Dry run: would ask {len(asking)} of {len(nodes)} nodes to update ({ids}).")
        return 0
    agent_before = next((c.version for c in installed if c.mode == "agent"), None)
    updated_here = (
        {n: agent_before for n in behind if n in here} if any(s[0] == "agent" for s in steps) else {}
    )
    if not asking and not updated_here:
        return 0
    wait = f"Waiting up to {NODE_TIMEOUT_S / 60:.0f} minutes"
    if asking:
        print(f"\nAsking {ids} to update to {show(release.version)}, all at once. {wait}.", flush=True)
    else:
        print(f"\n{wait} for this host's agent to report {show(release.version)}.", flush=True)
    done = update_nodes(agents, asking + list(updated_here), token, release.version, True, updated_here)
    finished = {r.node: r for r in done}
    results = [finished.get(r.node, r) for r in before]
    print("Result:")
    print_nodes(results, here)
    failed = [r for r in results if not r.current]
    if failed:
        print(
            f"{len(failed)} of {len(results)} nodes are not at {show(release.version)}: see above. "
            "Run sudo sparkline update again once fixed; nodes already up to date are skipped."
        )
        return 1
    print(f"All {len(results)} nodes run {show(release.version)}.")
    return 0


def update_this_host(
    args: argparse.Namespace, release: Release, steps: list[list[str]], client: httpx.Client
) -> None:
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
        print(f"\nSparkline updated to {show(release.version)} on this host.", flush=True)


def main(
    argv: list[str],
    env: Mapping[str, str] = os.environ,
    client: httpx.Client | None = None,
    agents: httpx.Client | None = None,
) -> int:
    p = argparse.ArgumentParser(
        prog="sparkline update",
        description="Update Sparkline to the latest release. On the console host it updates this host (the "
        "console, then its agent), then every node in /etc/sparkline/console.toml, all at once. On any other "
        "host it updates only that host. Config and data are kept.",
    )
    p.add_argument(
        "--check", action="store_true", help="compare this host and every node with the latest release"
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="download and verify, run this host's installers with --dry-run, list the nodes it would ask",
    )
    p.add_argument(
        "--reinstall",
        action="store_true",
        help="run the latest release's installer for every component, even one already at that version",
    )
    p.add_argument("--this-host", action="store_true", help="update only this host, not the nodes")
    p.add_argument("-y", "--yes", action="store_true", help="don't ask for confirmation")
    args = p.parse_args(argv)
    # Test seams: a staged root (passed to install.sh as --destdir) and a local fake of the GitHub API.
    root = Path(env.get("SPARKLINE_UPDATE_ROOT") or "/")
    api = (env.get("SPARKLINE_RELEASES_API") or RELEASES_API).rstrip("/")
    try:
        with (
            client or httpx.Client(follow_redirects=True, timeout=30) as c,
            agents or httpx.Client(timeout=10) as a,
        ):
            return update(args, argv, root, api, env, c, a)
    except UpdateError as e:
        sys.stdout.flush()
        print(f"sparkline update: {e}", file=sys.stderr)
        return 1
