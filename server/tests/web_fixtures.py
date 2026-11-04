"""Per-platform NodeInfo + Sample fixtures for the web view tests, built from the mixed demo fleet.

`python tests/web_fixtures.py` (from server/) rewrites web/src/test/fixtures/platforms/<platform>/;
test_web_fixtures.py fails when the committed files drift from what build() returns.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from sparkline.console.demo_fleets import FLEETS

OUT = Path(__file__).resolve().parents[2] / "web" / "src" / "test" / "fixtures" / "platforms"
COMMAND = "python tests/web_fixtures.py"
T = 1_791_288_000.5
T0 = T - 30
PLATFORMS = {  # platform -> (node in the mixed fleet, notes)
    "gb10": (
        "spark1",
        "NodeInfo mirrors what a real spark1 agent (GB10) reports; ids such as MACs and the GPU UUID are "
        "synthesized, and the sample is simulated by the demo.",
    ),
    "workstation": (
        "ws1",
        "Synthesized: 4x NVIDIA RTX 6000 Ada Generation per the NVIDIA datasheet and "
        "https://lenovopress.lenovo.com/LP1940, with a Threadripper PRO 7975WX. Clocks, thresholds, curves, "
        "disks, NICs and versions have no primary source (server/sparkline/console/demo_workstation.py).",
    ),
}


def _json(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def build() -> dict[str, str]:
    """Path relative to OUT -> file text, at the fixed instant T in UTC."""
    tz = os.environ.get("TZ")
    os.environ["TZ"] = "UTC"
    time.tzset()
    try:
        out = {}
        for platform, (node, notes) in PLATFORMS.items():
            model = FLEETS["mixed"][node](T0, 1.0)
            sample = model.sample_at(T, procs=True)
            sample.procs_ts = T  # as DemoSource stamps a tick that refreshed the process list
            meta = {"node": node, "generated_by": COMMAND, "synthesized": True, "notes": notes}
            out[f"{platform}/info.json"] = _json(model.info.model_dump(mode="json"))
            out[f"{platform}/sample.json"] = _json(sample.model_dump(mode="json"))
            out[f"{platform}/meta.json"] = _json(meta)
        return out
    finally:
        if tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = tz
        time.tzset()


if __name__ == "__main__":
    for rel, text in build().items():
        path = OUT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        print(f"wrote {path}")
