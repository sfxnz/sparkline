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
        "from sparkline.console.demo import NODES, DemoModel\n"
        "for n in NODES: print(DemoModel(n, 0.0).info.agent_version)"
    )
    # The first sparkline dist-info on sys.path wins, and PYTHONPATH comes before site-packages.
    path = os.pathsep.join(filter(None, [str(tmp_path), os.environ.get("PYTHONPATH")]))
    env = {**os.environ, "PYTHONPATH": path}
    run = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True)
    reported = run.stdout.split()
    assert set(reported) == {"9.9.9"}, f"demo agents report {reported}, not 9.9.9"
