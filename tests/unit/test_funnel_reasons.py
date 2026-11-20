"""The multi-day funnel tally (wt.analytics.funnel_reasons, scripts/funnel_reasons.py): it reads only what was known
at the 09:25 decision, it agrees with wt.scanner.explain, each split is its own bucket, and only counts come out."""
import datetime as dt
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
from test_frozen_golden import spec_cands

from wt.analytics import funnel_reasons as fr
from wt.scanner.explain import STEPS, explain, from_pool, pool_musts
from wt.specs.loader import load_spec

ROOT = Path(__file__).resolve().parents[2]
SPEC = load_spec("SPEC-0001")
spec_ = importlib.util.spec_from_file_location("funnel_reasons_script", ROOT / "scripts/funnel_reasons.py")
script = importlib.util.module_from_spec(spec_)
spec_.loader.exec_module(script)

OK = dict(price_0925=5.0, gap_pct=25.0, pm_volume=300_000.0, rvol_pm=6.0, float_shares=8e6,
          catalyst_status="qualifying", catalyst_category="fda_approval", catalyst_score=1.0, former_runner=False,
          chart_ok=True, pm_pattern=None, trend_ok=True, window_ok=True, pm_consolidation=True, suspect_split=False,
          hist_bars=300, headlines_n=2)
MISS = dict(catalyst_status="non_qualifying", catalyst_category="none", catalyst_score=0.0)
# Columns a pool also holds that the tally must never read: text, and anything a later change might add.
LATER = dict(date="2026-05-04", catalyst_headline="ZZTOP WINS APPROVAL", first_catalyst_at="2026-05-04T08:00:00Z",
             catalyst_type_v1="fda", pm_pattern_trigger=5.5, spread_pct=0.4, open_0930=5.6, R=1.5)


def frame(*rows, **extra):
    return pd.DataFrame([{**OK, **LATER, **extra, **r} for r in rows])


def test_only_columns_known_at_the_decision_are_read():
    # The set is spelled out here on purpose: adding a column to the tally has to be done twice, once knowingly.
    assert set(fr.USED_COLUMNS) == {
        "symbol", "price_0925", "gap_pct", "pm_volume", "rvol_pm", "float_shares", "catalyst_status",
        "catalyst_category", "catalyst_score", "former_runner", "chart_ok", "pm_pattern",
        "trend_ok", "window_ok", "pm_consolidation", "suspect_split", "hist_bars", "headlines_n"}
    assert len(set(fr.USED_COLUMNS)) == len(fr.USED_COLUMNS)
    touched: list[str] = []

    class Watched(pd.DataFrame):
        def __getitem__(self, key):
            touched.extend(key if isinstance(key, list) else [key])
            return pd.DataFrame(pd.DataFrame.__getitem__(self, key))      # a plain frame: the projection, nothing more

    full = frame(dict(symbol="AAAA"), dict(symbol="BBBB", headlines_n=0, **MISS),
                 dict(symbol="CCCC", float_shares=np.nan, chart_ok=False, trend_ok=False, hist_bars=50))
    seen = fr.session(Watched(full), SPEC)
    assert sorted(touched) == sorted(fr.USED_COLUMNS)                    # one projection, and it is the whole read
    garbled = full.copy()
    for c in LATER:
        garbled[c] = "garbage"
    garbled["close"] = 999.0
    assert fr.session(garbled, SPEC) == seen == fr.session(full[list(fr.USED_COLUMNS)], SPEC)
    assert seen["counts"]["kept"] == 3 and seen["counts"]["passed"] == 1


def test_it_agrees_with_explain_and_the_catalyst_split_adds_up():
    cands = spec_cands()
    pool = pd.DataFrame([{
        "symbol": c.symbol, "price_0925": c.price, "gap_pct": c.gap_pct, "pm_volume": c.pm_volume, "rvol_pm": c.rvol_pm,
        "float_shares": c.float_shares, "catalyst_status": c.catalyst_status, "catalyst_category": c.catalyst_category,
        "catalyst_score": c.catalyst_score, "former_runner": c.former_runner, "chart_ok": c.chart_ok,
        "pm_pattern": "flag" if c.pm_pattern else None, "trend_ok": c.chart_ok, "window_ok": True,
        "pm_consolidation": True, "suspect_split": False, "hist_bars": 150 if i % 2 else 300,
        "headlines_n": 0 if c.catalyst_status == "non_qualifying" and i % 8 == 3 else 1} for i, c in enumerate(cands)])
    e = explain(from_pool(pool), SPEC, pool_musts(pool))
    s = fr.session(pool, SPEC)
    f = s["failed_by_reason"]
    assert s["counts"] == e.counts and list(s["counts"]) == list(STEPS)
    assert f["catalyst_no_headline"] + f["catalyst_none_qualifying"] == e.failed_by_reason["catalyst_missing"]
    assert f["catalyst_no_headline"] > 0 and f["catalyst_none_qualifying"] > 0 and f["catalyst_headlines_unknown"] == 0
    for k in ("price", "gap", "float", "float_unknown", "pm_volume", "rvol", "catalyst_excluded"):
        assert f[k] == e.failed_by_reason.get(k, 0) and s["sole_reason"][k] == e.sole_reason.get(k, 0)
    assert (s["sole_reason"]["catalyst_no_headline"] + s["sole_reason"]["catalyst_none_qualifying"]
            == e.sole_reason.get("catalyst_missing", 0))
    assert {k: v for k, v in s["chart_fail"].items() if v} == e.chart_fail and s["chart_fail"]["history"] > 0
    assert s["has_tier2"] is True and s["data_gap"] is False
    assert "catalyst_missing" not in f and json.loads(json.dumps(s)) == s


def test_float_unknown_is_not_float_too_large():
    s = fr.session(frame(dict(symbol="NONE", float_shares=np.nan), dict(symbol="BIG", float_shares=9e9),
                         dict(symbol="BOTH", float_shares=None, rvol_pm=0.1), dict(symbol="FINE")), SPEC)
    assert (s["failed_by_reason"]["float_unknown"], s["failed_by_reason"]["float"]) == (2, 1)
    assert (s["sole_reason"]["float_unknown"], s["sole_reason"]["float"], s["sole_reason"]["rvol"]) == (1, 1, 0)
    assert s["counts"]["kept"] == 4 and s["counts"]["passed"] == 1


def test_the_catalyst_has_three_buckets_and_no_category():
    s = fr.session(frame(dict(symbol="QUIET", headlines_n=0, **MISS), dict(symbol="NOISY", headlines_n=3, **MISS),
                         dict(symbol="NOISY2", headlines_n=1, **MISS),
                         dict(symbol="BARRED", catalyst_status="excluded", catalyst_category="buyout_offer"),
                         dict(symbol="FINE")), SPEC)
    f = s["failed_by_reason"]
    assert (f["catalyst_no_headline"], f["catalyst_none_qualifying"], f["catalyst_excluded"]) == (1, 2, 1)
    assert s["sole_reason"]["catalyst_no_headline"] == 1 and s["kept_no_headline"] == 1 and s["data_gap"] is False
    text = json.dumps(s)
    assert "buyout" not in text and "fda" not in text and "QUIET" not in text and ":" not in "".join(f)
    # a pool with no headline count cannot be split, and says so instead of guessing a bucket
    blind = fr.session(frame(dict(symbol="QUIET", **MISS)).drop(columns=["headlines_n"]), SPEC)
    assert blind["failed_by_reason"]["catalyst_headlines_unknown"] == 1 and blind["headlines_known"] is False
    assert blind["data_gap"] is False


def test_chart_musts_tell_short_history_from_trend():
    bad = dict(chart_ok=False)
    s = fr.session(frame(
        dict(symbol="NEW", trend_ok=False, hist_bars=40, **bad), dict(symbol="EDGE", trend_ok=False, hist_bars=199, **bad),
        dict(symbol="DOWN", trend_ok=False, hist_bars=200, window_ok=False, pm_consolidation=False, **bad),
        dict(symbol="SPLIT", suspect_split=True, **bad), dict(symbol="FINE")), SPEC)
    assert s["chart_fail"] == {"history": 2, "trend": 1, "window": 1, "pm_consolidation": 1, "suspect_split": 1,
                               "unknown": 0}
    assert s["counts"]["tier1"] == 5 and s["counts"]["chart_ok"] == 1 and s["has_tier2"] is True


def test_a_session_with_no_headline_anywhere_is_a_data_gap_and_an_empty_one_is_not():
    gap = fr.session(frame(dict(symbol="AAAA", **MISS), dict(symbol="BBBB", **MISS), headlines_n=0), SPEC)
    assert gap["data_gap"] is True and gap["has_tier2"] is False and gap["kept_no_headline"] == 2
    empty = fr.session(pd.DataFrame({"date": [], "symbol": []}), SPEC)
    assert empty["data_gap"] is False and empty["counts"] == dict.fromkeys(STEPS, 0)
    live = fr.session(frame(dict(symbol="AAAA"), dict(symbol="BBBB", headlines_n=0, **MISS)), SPEC)
    t = fr.total({"2026-04-27": gap, "2026-04-28": gap, "2026-04-29": live, "2026-04-30": empty})
    assert (t["sessions"], t["sessions_empty"], t["sessions_with_tier2"], t["sessions_data_gap"]) == (4, 1, 1, 2)
    assert (t["data_gap_before_news_start"], t["data_gap_on_or_after_news_start"]) == (1, 1)
    assert (t["first"], t["last"], t["news_start"]) == ("2026-04-27", "2026-04-30", "2026-04-28")
    assert t["all"]["sessions"] == 4 and t["excluding_data_gap"]["sessions"] == 2
    assert t["all"]["failed_by_reason"]["catalyst_no_headline"] == 5
    assert t["excluding_data_gap"]["failed_by_reason"]["catalyst_no_headline"] == 1
    assert t["all"]["counts"]["kept"] == 6 and t["excluding_data_gap"]["counts"] == live["counts"]
    assert fr.total({})["sessions"] == 0 and fr.total({})["all"]["counts"] == dict.fromkeys(STEPS, 0)


def test_a_pool_without_the_funnel_columns_is_refused():
    try:
        fr.session(frame(dict(symbol="AAAA")).drop(columns=["rvol_pm"]), SPEC)
    except ValueError as e:
        assert "rvol_pm" in str(e)
        return
    raise AssertionError("a pool the funnel cannot read must raise")


def leaves(x):
    if isinstance(x, dict):
        for v in x.values():
            yield from leaves(v)
    elif isinstance(x, list):
        for v in x:
            yield from leaves(v)
    else:
        yield x


def is_date(x) -> bool:
    try:
        dt.date.fromisoformat(x)
    except (TypeError, ValueError):
        return False
    return True


def test_the_script_reads_a_span_and_writes_counts_only(tmp_path, capsys):
    pools = tmp_path / "candidates"
    pools.mkdir()
    frame(dict(symbol="ZZTOP", headlines_n=0, **MISS)).to_parquet(pools / "2026-04-24.parquet")  # a data-gap session
    frame(dict(symbol="ZZTOP"), dict(symbol="QQXYZ", catalyst_status="excluded", catalyst_category="buyout_offer"),
          dict(symbol="NOFLT", float_shares=np.nan)).to_parquet(pools / "2026-05-04.parquet")
    pd.DataFrame({"date": [], "symbol": []}).to_parquet(pools / "2026-05-05.parquet")            # nothing kept
    frame(dict(symbol="DUPE"), dict(symbol="DUPE")).to_parquet(pools / "2026-05-06.parquet")     # explain refuses it
    frame(dict(symbol="LATE")).to_parquet(pools / "2026-06-01.parquet")                          # outside the span
    (pools / "notes.parquet").write_bytes(b"x")
    out = tmp_path / "out" / "tally.json"
    doc = script.main(["2026-04-01", "2026-05-31", "--out", str(out)], pool_dir=pools)
    printed = capsys.readouterr().out
    saved = json.loads(out.read_text())
    assert saved == doc and set(doc) == {"tool", "spec", "start", "end", "pool_files", "unreadable", "total", "sessions"}
    assert doc["pool_files"] == 4 and doc["unreadable"] == ["2026-05-06"]
    assert sorted(doc["sessions"]) == ["2026-04-24", "2026-05-04", "2026-05-05"]
    t = doc["total"]
    assert (t["sessions"], t["sessions_data_gap"], t["sessions_empty"], t["sessions_with_tier2"]) == (3, 1, 1, 1)
    assert t["all"]["failed_by_reason"]["float_unknown"] == 1 and t["all"]["failed_by_reason"]["catalyst_excluded"] == 1
    assert "DATA GAP, not a finding: 1 session(s)" in printed and "float_unknown" in printed
    for text in (printed.replace(str(out), ""), out.read_text()):
        assert not any(w in text for w in ("ZZTOP", "QQXYZ", "NOFLT", "DUPE", "buyout", "fda", "APPROVAL", "5.6"))
    # every value is a count, a flag, a date or one of two fixed labels: no price, no R, no name
    for v in leaves(saved):
        assert type(v) in (int, bool) or v is None or v in ("funnel_reasons", "SPEC-0001") or is_date(v), v


def test_the_script_loads_only_the_tally_columns(tmp_path):
    path = tmp_path / "2026-05-04.parquet"
    frame(dict(symbol="AAAA")).to_parquet(path)
    assert set(script.read_pool(path).columns) == set(fr.USED_COLUMNS)
    pd.DataFrame({"date": [], "symbol": []}).to_parquet(path)
    assert list(script.read_pool(path).columns) == ["symbol"]
