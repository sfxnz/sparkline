import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def versions() -> dict[str, str]:
    project = tomllib.loads((ROOT / "server/pyproject.toml").read_text())["project"]
    lock = json.loads((ROOT / "web/package-lock.json").read_text())
    return {
        "server/pyproject.toml": project["version"],
        "web/package.json": json.loads((ROOT / "web/package.json").read_text())["version"],
        "web/package-lock.json": lock["version"],
        'web/package-lock.json packages[""]': lock["packages"][""]["version"],
    }


def test_console_agent_and_web_share_one_version() -> None:
    found = versions()
    assert len(set(found.values())) == 1, f"versions differ, bump them together (docs/RELEASING.md): {found}"


def test_changelog_has_a_section_for_the_version() -> None:
    version = versions()["server/pyproject.toml"]
    sections = re.findall(r"^## \[([^\]]+)\]", (ROOT / "CHANGELOG.md").read_text(), re.MULTILINE)
    assert version in sections, f"CHANGELOG.md has no '## [{version}]' (docs/RELEASING.md): {sections}"


def test_demo_agents_report_the_installed_version(tmp_path: Path) -> None:
    dist = tmp_path / "sparkline-9.9.9.dist-info"
    dist.mkdir()
    (dist / "METADATA").write_text("Metadata-Version: 2.1\nName: sparkline\nVersion: 9.9.9\n")
    code = (
        "from sparkline.console.demo_fleets import FLEETS\n"
        "for make in FLEETS['mixed'].values(): print(make(0.0, 1.0).info.agent_version)"
    )
    # The first sparkline dist-info on sys.path wins, and PYTHONPATH comes before site-packages.
    path = os.pathsep.join(filter(None, [str(tmp_path), os.environ.get("PYTHONPATH")]))
    env = {**os.environ, "PYTHONPATH": path}
    run = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True)
    reported = run.stdout.split()
    assert set(reported) == {"9.9.9"}, f"demo agents report {reported}, not 9.9.9"


NOTES = ROOT / "deploy/release-notes.sh"
CHANGELOG = """# Changelog

## [Unreleased]

## [0.2.0] - unreleased

- Not out yet.

## [0.1.1] - 2026-11-06

### Fixed

- A 100% fix (#90).

## [0.1.0] - 2026-11-01

- The first release.

[Unreleased]: https://github.com/sfxnz/sparkline/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sfxnz/sparkline/releases/tag/v0.1.1
"""


def release_notes(version: str, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(CHANGELOG)
    return subprocess.run(["bash", str(NOTES), version, str(changelog)], capture_output=True, text=True)


def test_release_notes_are_the_versions_changelog_section(tmp_path: Path) -> None:
    run = release_notes("0.1.1", tmp_path)
    assert (run.returncode, run.stdout) == (0, "### Fixed\n\n- A 100% fix (#90).\n"), run.stderr


def test_release_notes_stop_before_the_link_references(tmp_path: Path) -> None:
    run = release_notes("0.1.0", tmp_path)
    assert (run.returncode, run.stdout) == (0, "- The first release.\n"), run.stderr


def test_release_notes_refuse_a_version_still_dated_unreleased(tmp_path: Path) -> None:
    run = release_notes("0.2.0", tmp_path)
    assert run.returncode != 0 and run.stdout == "" and "unreleased" in run.stderr


def test_release_notes_refuse_a_version_the_changelog_lacks(tmp_path: Path) -> None:
    run = release_notes("0.3.0", tmp_path)
    assert run.returncode != 0 and run.stdout == "" and "0.3.0" in run.stderr
