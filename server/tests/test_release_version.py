import json
import re
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
