"""What the collector publishes about the funnel: near misses and a failed scan from the dry run ("as seen"), and
the newest funnel of record from the forward test. Counts, tickers, prices and closed codes; nothing else."""
import datetime as dt
import json

from test_publish import NOW, sanitizer

from wt.ops import status
from wt.ops.publish import build, validate


def ctx(tmp_path):
    return status.Ctx(cfg={}, root=tmp_path, deployed=tmp_path, org=tmp_path, old=tmp_path, out=tmp_path,
                      now=dt.datetime(2026, 10, 9, tzinfo=dt.UTC))


def stage(folder, name, **body):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps(body))


REACHED = [{"symbol": "NEAR", "price": 4.126, "reached": "kept", "reasons": ["catalyst_excluded:buyout_offer"]},
           {"symbol": "ALSO", "price": 9.5, "reached": "kept", "reasons": ["float"]},
           {"symbol": "TWO", "price": 3.0, "reached": "kept", "reasons": ["float", "rvol"]},        # failed two: not near
           {"symbol": "TIER", "price": 5.0, "reached": "tier1", "reasons": ["chart:trend"]},       # passed the filters
           {"symbol": "PICK", "price": 6.0, "reached": "primary", "reasons": []}, "junk"]


def test_near_misses_are_names_that_failed_exactly_one_filter(tmp_path):
    day = tmp_path / "var" / "routine" / "2026-10-09"
    stage(day, "0800_tier1", stage="tier1", as_of_et="08:00", stats={"universe": 4300, "kept": 5}, reached=REACHED[:1], tier1=[])
    stage(day, "0915_tickets", stage="tickets", as_of_et="09:15", stats={"universe": 4300, "kept": 5}, reached=REACHED, tier1=[])
    stage(day, "1131_signals", tier2=[], signals=[])
    out = status.src_routine(ctx(tmp_path))
    assert out["near"] == {"total": 2, "rows": [{"symbol": "NEAR", "price": 4.13, "reason": "catalyst_excluded"},
                                                {"symbol": "ALSO", "price": 9.5, "reason": "float"}]}
    assert [s["scan_failed"] for s in out["stages"]] == [False, False, None]          # the signals file is not a scan
    snap = build({"meta": {}, "ops": {"routine": out}}, {}, sanitizer(), "run-1", NOW)
    assert validate(snap) == [] and snap["ops"]["routine"]["near"] == out["near"]
    assert "buyout" not in json.dumps(snap)                                            # the category never leaves the host


def test_the_list_is_capped_and_a_stage_without_a_record_publishes_none(tmp_path):
    many = [{"symbol": f"S{i:03d}", "price": 5.0, "reached": "kept", "reasons": ["gap"]} for i in range(45)]
    got = status.near_misses(many)
    assert got["total"] == 45 and len(got["rows"]) == status.NEAR_MAX and got["rows"][0]["symbol"] == "S000"
    assert status.near_misses(None) is None and status.near_misses([]) == {"total": 0, "rows": []}
    day = tmp_path / "var" / "routine" / "2026-10-09"
    stage(day, "0800_tier1", stage="tier1", as_of_et="08:00", stats={"universe": 0}, scan_failed="the universe is empty", tier1=[])
    out = status.src_routine(ctx(tmp_path))
    assert out["near"] is None and out["stages"][0]["scan_failed"] is True


def test_the_newest_funnel_of_record_is_published_in_counts(tmp_path):
    fwd = tmp_path / "var" / "forward"
    (fwd / "funnel").mkdir(parents=True)
    (fwd / "forward_trades.jsonl").write_text("")
    part = {"pool": {"universe": 4335, "kept": 6, "notes": []}, "pool_rows": 6, "names": 2, "git_sha": "abc",
            "funnel": {"n_kept": 6, "n_passed": 2, "n_tier1": 2, "n_tier2": 1, "drop_float": 3, "x": 1.5},
            "trials": {"GG-1": {"candidates": 1, "admitted": 1}}}
    (fwd / "funnel" / "2026-10-08.json").write_text(json.dumps({"session": "2026-10-08", "parts": {"set_F": part}}))
    (fwd / "funnel" / "2026-10-09.json").write_text(json.dumps({"session": "2026-10-09", "parts": {"REV-1": {"candidates": 0}}}))
    out = status.src_forward(ctx(tmp_path))
    assert out["funnel"] == {"session": "2026-10-08", "pool": {"universe": 4335, "kept": 6},      # the newest with Set F
                             "counts": {"n_kept": 6, "n_passed": 2, "n_tier1": 2, "n_tier2": 1, "drop_float": 3}}
    snap = build({"meta": {}, "ops": {"forward": out}}, {}, sanitizer(), "run-1", NOW)
    assert validate(snap) == [] and snap["ops"]["forward"]["funnel"] == out["funnel"]
    assert status.forward_funnel(None) is None and status.forward_funnel({"parts": {}}) is None
