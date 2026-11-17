"""Guards on the recommendations catalog: what must hold for every entry, whoever adds the next one."""

from __future__ import annotations

import re
from pathlib import Path

from sparkline.common.recommendations import BY_ID, CATALOG
from sparkline.common.schema import RecMeasurement, RecMetric, Recommendation
from sparkline.tune import REQUESTS, TUNES

REPO = Path(__file__).resolve().parents[2]


def test_ids_are_kebab_case_and_unique():
    ids = [r.id for r in CATALOG]
    assert all(re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", i) for i in ids), ids
    assert len(set(ids)) == len(ids) and list(BY_ID) == ids


def test_every_entry_cites_two_to_four_https_sources():
    for r in CATALOG:
        assert 2 <= len(r.sources) <= 4, r.id
        assert all(s.url.startswith("https://") and s.title for s in r.sources), r.id
        assert len({s.url for s in r.sources}) == len(r.sources), r.id


def test_every_entry_tells_the_reader_how_to_apply_and_undo_it_by_hand():
    for r in CATALOG:
        assert r.apply and r.undo and r.risks, r.id
        assert all(c.startswith(("sudo ", "printf ")) for c in r.apply + r.undo), r.id


def test_no_risk_points_at_another_place_on_the_page():
    # A risk is shown on the card, above the commands, and in the confirmation, below them.
    for r in CATALOG:
        for risk in r.risks:
            assert not re.search(r"\b(above|below)\b", risk), f"{r.id}: {risk}"


def test_every_entry_says_when_it_takes_effect():
    assert {r.id: r.takes_effect for r in CATALOG} == {
        "gpu-clock-cap": "now",
        "cpu-pcore-cap": "now",
        "headless-boot": "next-boot",
        "display-reserved-memory": "next-boot",
    }


def test_a_measured_entry_has_its_evidence_file():
    for r in CATALOG:
        if r.measurement is not None:
            assert r.measurement.doc == f"docs/recommendations/{r.id}.md"
            assert (REPO / r.measurement.doc).is_file(), f"{r.id}: no {r.measurement.doc}"


def test_verified_is_derived_from_the_measurement_and_cannot_be_typed():
    claim = CATALOG[0]
    assert claim.measurement is None and claim.model_dump()["verified"] is False
    typed = Recommendation.model_validate({**claim.model_dump(), "verified": True})
    assert typed.verified is False
    metric = RecMetric(label="Hottest zone", before=88.0, after=71.0, unit="°C")
    measurement = RecMeasurement(
        date="2026-11-20", machine="DGX Spark", method="m", results=[metric], doc="docs/x.md"
    )
    measured = claim.model_copy(update={"measurement": measurement})
    assert measured.model_dump()["verified"] is True


def test_every_one_click_entry_has_a_root_action_and_nothing_else_does():
    assert set(TUNES) == {r.id for r in CATALOG if r.one_click}
    assert set(REQUESTS) == {f"{i}.{verb}" for i in TUNES for verb in ("apply", "undo")}


def test_a_setting_that_a_reboot_forgets_is_reapplied_at_boot():
    assert {i for i, t in TUNES.items() if t.reapply_at_boot} == {
        r.id for r in CATALOG if r.one_click and r.persists == "until-reboot"
    }
