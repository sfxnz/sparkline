from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from sparkline.agent.sources import Sources, recorded

PLATFORMS = Path(__file__).parent / "fixtures" / "platforms"
GB10 = PLATFORMS / "gb10"


def gb10(**changes: Any) -> Sources:
    return replace(recorded(GB10), **changes)
