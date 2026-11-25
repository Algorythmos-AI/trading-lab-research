"""The options lab's tape status on the Paper page (DEC-0060, DEC-0067): EXP-0052's counting rules read from the
manifests, counts only, valid against the dashboard's schema, and sent as version 1 without it to a site that does
not take it yet. Synthetic manifests only."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from wt.core.config import ROOT
from wt.options import lab_tape_status as L
from wt.options import paper_site

SCHEMA = json.loads((ROOT / "dashboard/src/lib/paper-options.schema.json").read_text())
# shaped like the two real sessions: 2026-11-19 (v1 recorder) and 2026-11-20 (v2, tick 0 skipped)
V1 = {"session": "2026-11-19", "focus_session": "2026-11-19", "recorded": True, "coverage": 0.999868, "ticks_run": 4679,
      "restarts": 0, "stopped": None, "tier1_final": 345, "tier2_final": 4371, "clock_offset_ms": 0.001,
      "opening_complete": True, "after_close": {"prints": {"prints": 1420803, "failed": 0},
                                                "open_interest": {"contracts": 4716, "failed": 0}}}
V2 = {"session": "2026-11-20", "focus_session": "2026-11-20", "recorder": 2, "recorded": True, "coverage": 0.999821,
      "coverage_fresh": 0.999821, "coverage_fresh_strict": 0.999821, "stale_ticks": 0, "longest_stale_s": 0.0,
      "stale_ticks_by_name": {}, "ticks_down": 1, "restarts": 0, "stopped": None, "tier1_final": 388,
      "tier2_final": 3006, "tier1_crossed_share": 0.002383, "clock_offset_ms": -0.007, "clock_offset_ms_end": 0.005,
      "opening_complete": True, "after_close": {"prints": {"prints": 2447263, "failed": 0},
                                                "open_interest": {"contracts": 3394, "null_open_interest": 895}}}


def tape(root: Path, docs: list[dict[str, Any]], archived: tuple[str, ...] = ()) -> Path:
    for d in docs:
        (root / d["session"]).mkdir(parents=True)
        (root / d["session"] / "manifest.json").write_text(json.dumps(d))
    (root / "receipts").mkdir(parents=True, exist_ok=True)
    for a in archived:
        (root / "receipts" / f"{a}.json").write_text('{"verified": true}')
    return root


def valid(lab: dict[str, Any]) -> None:
    """The block against the dashboard schema's own `lab` property."""
    jsonschema.Draft7Validator({**SCHEMA, "$ref": "#/properties/lab"}).validate(lab)


def test_the_two_real_sessions_read_as_they_should(tmp_path: Path) -> None:
    lab = L.block(root=tape(tmp_path, [V1, V2], archived=()))
    assert lab is not None
    v1, v2 = lab["sessions"]
    assert v1["why_not"] == ["v1"] and not v1["counts"] and not v1["shadow"] and v1["coverage_fresh"] is None
    assert v2["counts"] and v2["shadow"] and v2["partial"] and v2["why_not"] == []          # tick 0 skipped: partial
    assert v2["oi_null_share"] == round(895 / 3394, 4) and v2["prints"] == 2447263 and v2["after_close_ok"]
    assert (lab["shadow_done"], lab["shadow_needed"], lab["counted"], lab["recorded"], lab["archived"]) == (1, 5, 0, 2, 0)
    valid(lab)


@pytest.mark.parametrize("change,why", [
    ({"coverage_fresh_strict": 0.98}, ["fresh_coverage"]),
    ({"longest_stale_s": 301.0}, ["stale_run"]),
    ({"longest_stale_s": 300.0}, []),
    ({"longest_stale_s": None}, ["stale_run"]),
    ({"longest_stale_s": "150"}, ["stale_run"]),
    ({"clock_offset_ms_end": -251.0}, ["clock"]),
    ({"clock_offset_ms_end": None}, ["clock"]),
    ({"tier1_crossed_share": 0.0051}, ["crossed"]),
    ({"tier1_crossed_share": 0.005}, []),
    ({"tier1_crossed_share": None}, ["crossed"]),
    ({"tier1_crossed_share": 0}, []),
    ({"opening_complete": False}, ["opening"]),
    ({"focus_session": "2026-11-19"}, ["no_focus"]),
    ({"recorder": None}, ["v1"]),
])
def test_each_counting_rule_is_checked_on_its_own(change: dict[str, Any], why: list[str]) -> None:
    assert L.why_not({**V2, **change}) == why


@pytest.mark.parametrize("field,why", [("longest_stale_s", ["stale_run"]), ("tier1_crossed_share", ["crossed"]),
                                       ("coverage_fresh_strict", ["fresh_coverage"]), ("clock_offset_ms", ["clock"])])
def test_a_rule_whose_field_is_missing_fails(field: str, why: list[str]) -> None:
    """EXP-0052 counts a session only when each value is within its limit: one the manifest lacks is not."""
    assert L.why_not({k: v for k, v in V2.items() if k != field}) == why


def test_shadow_then_counted_and_what_is_left_out(tmp_path: Path) -> None:
    days = [f"2026-11-{d}" for d in (20, 23, 24, 25, 27, 30)] + ["2026-12-01"]
    docs = [{**V2, "session": d, "focus_session": d, "ticks_down": 0} for d in days]
    docs[-1] = {**docs[-1], "coverage_fresh_strict": 0.5, "stopped": "off switch"}
    root = tape(tmp_path, docs, archived=tuple(days[:3]))
    (root / "2026-12-02").mkdir()                                          # unfinished: no manifest, not listed
    (root / "2026-12-02" / "state.json").write_text("{}")
    lab = L.block(root=root)
    assert lab is not None and [s["shadow"] for s in lab["sessions"]] == [True] * 5 + [False, False]
    assert lab["counted"] == 1 and lab["archived"] == 3 and lab["sessions"][-1]["stopped"] == "off_switch"
    assert "2026-12-02" not in [s["date"] for s in lab["sessions"]]
    valid(lab)
    text = json.dumps(lab)
    assert "AAA" not in text and "symbol" not in text                       # counts only: no name, no contract


def test_no_tape_no_block(tmp_path: Path) -> None:
    assert L.block(root=tmp_path / "none") is None and L.block(root=tmp_path) is None


def test_the_paper_document_carries_it_and_a_version_1_site_gets_it_without(tmp_path: Path) -> None:
    tape(tmp_path / "tape", [V1, V2])
    doc = paper_site.build(paper_site.dt.datetime(2026, 11, 21, tzinfo=paper_site.dt.UTC), "r", tmp_path / "j.jsonl",
                           tmp_path / "state", {"costs": {"fee_per_contract_each_way": 0.65}},
                           {"WT_LAB_TAPE": str(tmp_path / "tape")})
    assert doc["schema_version"] == 6 and len(doc["lab"]["sessions"]) == 2 and paper_site.validate(doc) == []
    old = paper_site.as_version(doc, 1)
    assert old["schema_version"] == 1 and "lab" not in old and paper_site.validate(old) == []
    assert paper_site.as_version(doc, 6) == doc


def test_the_stale_split_and_tier1_nulls_reach_the_line_and_a_version_5_site_gets_them_without(tmp_path: Path) -> None:
    new = {**V2, "session": "2026-11-24", "focus_session": "2026-11-24", "stale_ticks_slow_start": 0,
           "stale_ticks_mid_session": 9,
           "after_close": {"open_interest": {"contracts": 2648, "null_open_interest": 713, "contracts_tier1": 400,
                                             "null_open_interest_tier1": 20}}}
    tape(tmp_path / "tape", [V2, new])
    lab = L.block(root=tmp_path / "tape")
    assert lab is not None
    before, after = lab["sessions"]
    assert (before["stale_slow_start"], before["stale_mid_session"], before["oi_null_share_tier1"]) == (None, None, None)
    assert (after["stale_slow_start"], after["stale_mid_session"], after["oi_null_share_tier1"]) == (0, 9, 0.05)
    valid(lab)
    doc = paper_site.build(paper_site.dt.datetime(2026, 11, 25, tzinfo=paper_site.dt.UTC), "r", tmp_path / "j.jsonl",
                           tmp_path / "state", {"costs": {"fee_per_contract_each_way": 0.65}},
                           {"WT_LAB_TAPE": str(tmp_path / "tape")})
    five = paper_site.as_version(doc, 5)
    assert five["schema_version"] == 5
    assert not any(k in s for s in five["lab"]["sessions"] for k in paper_site.LAB_SESSION_V6_KEYS)
    assert [{k: v for k, v in s.items() if k not in paper_site.LAB_SESSION_V6_KEYS} for s in doc["lab"]["sessions"]] \
        == five["lab"]["sessions"]
    old = json.loads(json.dumps(SCHEMA))                        # the version 5 schema as the site had it
    old["properties"]["schema_version"]["enum"] = [1, 2, 3, 4, 5]
    for k in paper_site.LAB_SESSION_V6_KEYS:
        del old["definitions"]["lab_session"]["properties"][k]
    assert list(jsonschema.Draft7Validator(old).iter_errors(five)) == []


def test_a_broken_tape_never_stops_the_paper_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(env: Any = None, root: Any = None) -> Any:
        raise OSError("disk")
    monkeypatch.setattr(L, "block", boom)
    doc = paper_site.build(paper_site.dt.datetime(2026, 11, 21, tzinfo=paper_site.dt.UTC), "r", tmp_path / "j.jsonl",
                           tmp_path / "state", {"costs": {"fee_per_contract_each_way": 0.65}}, {})
    assert "lab" not in doc and paper_site.validate(doc) == []


def test_upload_delay_and_rate_limit_headroom_are_shown(tmp_path: Path) -> None:
    new = {**V2, "session": "2026-11-23", "focus_session": "2026-11-23", "close": "2026-11-23T21:00:00+00:00",
           "rate_limit_min_remaining_share": 0.4125, "rate_limit_low_readings": 0, "rate_limit_429": 2,
           "budget_refused_batches": 3}
    root = tape(tmp_path, [V2, new, {**new, "session": "2026-11-27", "focus_session": "2026-11-27",
                                     "close": "2026-11-27T18:00:00+00:00"}])          # a half day closes at 13:00
    (root / "receipts" / "2026-11-20.json").write_text(       # before the manifest had `close`: 16:00 New York;
        '{"verified": true, "uploaded_at": "2026-11-22T05:01:50+00:00"}')        # before the bucket existed: not late
    (root / "receipts" / "2026-11-23.json").write_text('{"verified": true, "uploaded_at": "2026-11-23T22:51:00+00:00"}')
    (root / "receipts" / "2026-11-27.json").write_text('{"verified": false, "uploaded_at": "2026-11-27T19:00:00+00:00"}')
    lab = L.block(root=root)
    assert lab is not None
    old, mon, half = lab["sessions"]
    assert old["upload_after_close_min"] == 1921.8 and not old["upload_late"] and old["rate_limit_min_share"] is None
    assert old["rate_limit_429"] is None and old["budget_refused"] is None              # not saved by that recorder
    assert mon["upload_after_close_min"] == 111.0 and mon["upload_late"] and lab["uploads_late"] == 1
    assert (mon["rate_limit_min_share"], mon["rate_limit_low"], mon["rate_limit_429"], mon["budget_refused"]) == (
        0.4125, 0, 2, 3)
    assert half["upload_after_close_min"] is None and not half["upload_late"] and not half["archived"]
    valid(lab)



def test_a_version_2_site_gets_the_lab_block_without_the_version_3_keys(tmp_path: Path) -> None:
    new = {**V2, "session": "2026-11-23", "focus_session": "2026-11-23", "close": "2026-11-23T21:00:00+00:00",
           "rate_limit_min_remaining_share": 0.5, "rate_limit_low_readings": 0, "rate_limit_429": 0,
           "budget_refused_batches": 0}
    tape(tmp_path / "tape", [V2, new], archived=("2026-11-23",))
    doc = paper_site.build(paper_site.dt.datetime(2026, 11, 24, tzinfo=paper_site.dt.UTC), "r", tmp_path / "j.jsonl",
                           tmp_path / "state", {"costs": {"fee_per_contract_each_way": 0.65}},
                           {"WT_LAB_TAPE": str(tmp_path / "tape")})
    two = paper_site.as_version(doc, 2)
    assert two["schema_version"] == 2 and len(two["lab"]["sessions"]) == 2
    # the version 2 schema as the site had it: these keys absent, everything else unchanged (additionalProperties off)
    old = json.loads(json.dumps(SCHEMA))
    old["properties"]["schema_version"]["enum"] = [1, 2]
    lab = [x for x in old["properties"]["lab"]["oneOf"] if x.get("type") == "object"][0]
    for k in paper_site.LAB_V3_KEYS:
        del lab["properties"][k]
    for k in paper_site.LAB_SESSION_V3_KEYS:
        del old["definitions"]["lab_session"]["properties"][k]
    assert list(jsonschema.Draft7Validator(old).iter_errors(two)) == []
    assert list(jsonschema.Draft7Validator(old).iter_errors({**doc, "schema_version": 2}))      # unstripped: refused
