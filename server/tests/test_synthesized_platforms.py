from __future__ import annotations

import json

from synthesized_platforms import COMMAND, OUT, PLATFORMS, build, read_tree


def test_synthesized_platforms_match_their_generator():
    built = build()
    drifted = sorted(name for name in PLATFORMS if read_tree(OUT / name) != built[name])
    assert not drifted, (
        f"Synthesized platforms drifted from their generator: {drifted}. Run `cd server && {COMMAND}`"
    )


def test_a_synthesized_platform_says_so_and_names_its_sources_and_assumptions():
    for name, tree in build().items():
        meta = json.loads(str(tree["platform.json"]))
        assert meta["synthesized"] is True, name
        assert meta["sources"] and all(url.startswith("https://") for url in meta["sources"]), name
        assert meta["assumed"], name
