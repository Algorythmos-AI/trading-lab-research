"""Stage 2 of the Options desk's selection (wt.options.select_stage2, DEC-0046 section 5).

Every bar, quote and Stage 1 block here is synthetic and hand-built. No real market data, no result, ledger or
journal is read; nothing is scored on real data. The thresholds below are TEST-ONLY values, chosen only to put each
measured value clearly on one side of a limit: DEC-0046 sets no threshold, and these are not proposals for one.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import random
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.options import levels as lv
from wt.options import select as sel
from wt.options import select_stage2 as s2

ROOT = Path(__file__).resolve().parents[2]
P, PSHA = s2.load_params()
S1_SHA = "0" * 64
S, D = "2026-11-12", "2026-11-11"          # a Thursday and the Wednesday before it; EST (after 2026-11-01)
NAMES = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "PLTR", "AVGO", "AMD"]
# TEST-ONLY thresholds (not DEC-0046's, which sets none): spread 40 bp, gap fail 2.0 ATR, gap caution 0.75 ATR,
# relative volume 4.0; and test-only values for the two numbers the record does not give.
TEST_ONLY = s2.Thresholds(spread_limit_bps=40.0, gap_fail_atr=2.0, gap_caution_atr=0.75, relative_volume_limit=4.0,
                          quote_max_age_s=30.0, halt_max_age_s=30.0)
NONE = s2.Thresholds()
SEC = dt.timedelta(seconds=1)
MIN = dt.timedelta(minutes=1)


# ---------------------------------------------------------------- builders

def z(t: dt.datetime) -> str:
    return s2.iso(t)


def midnight(day: str) -> dt.datetime:
    return s2.ny_time(day, (0, 0))


def bar(t: dt.datetime, c: float, v: float = 100.0) -> dict[str, Any]:
    return {"t": z(t), "o": c, "h": c + 0.1, "l": c - 0.1, "c": c, "v": v, "n": 1, "vw": c}


def back(day: str, n: int) -> list[str]:
    out = [day]
    while len(out) < n:
        out.append(lv.prev_session(out[-1]))
    return out


def stage1_doc(session: str = S, ranks: dict[str, int] | None = None, eligible: set[str] | None = None,
               picks: list[str] | None = None, atr: float = 2.0) -> dict[str, Any]:
    d = lv.prev_session(session)
    order = sorted(NAMES, key=lambda s: (ranks or {}).get(s, NAMES.index(s) + 1))
    rank = {s: i + 1 for i, s in enumerate(order)}
    elig = set(NAMES) if eligible is None else eligible
    chosen = picks if picks is not None else [s for s in order if s in elig][:4]
    rows = [{"symbol": s, "data_valid": True, "reason": None, "final_rank": rank[s], "eligible": s in elig,
             "eligibility": "eligible" if s in elig else "earnings_gap", "picked": s in chosen, "cautions": [],
             "shown": {"atr14": atr, "close": 100.0}} for s in order]
    return {"schema": sel.OUTPUT_SCHEMA, "version": sel.OUTPUT_VERSION, "session": d, "next_session": session,
            "params_sha": S1_SHA, "picker_ref": "s1-test", "bundle_sha": "1" * 64, "status": "ok",
            "counts": {"names": 12}, "picks": chosen, "selection_note": None, "market_notes": [],
            "unreadable_event_rows": {"earnings_rows": 0, "macro_rows": 0}, "names": rows}


def name_data(session: str, T: dt.datetime, prior: float = 100.0, ref: float = 100.5,
              pm_volume: float = 10.0) -> dict[str, Any]:
    prev = lv.prev_session(session)
    hm = (T.astimezone(s2.NY).hour, T.astimezone(s2.NY).minute)
    daily = [bar(midnight(d), prior) for d in back(prev, 5)[::-1]]
    minute = [bar(T - (15 - i) * MIN, ref) for i in range(15)]           # the last one ends exactly at T
    pm: dict[str, list[dict[str, Any]]] = {}
    for day in [session] + back(prev, 20):
        start, end = s2.ny_time(day, (4, 0)), s2.ny_time(day, hm)
        rows, t = [], start
        while t + 5 * MIN <= end:
            rows.append(bar(t, ref, v=pm_volume))
            t += 5 * MIN
        pm[day] = rows
    snap = {"latestQuote": {"bp": ref - 0.1, "bs": 2, "ap": ref + 0.1, "as": 3, "t": z(T - 5 * SEC)},
            "latestTrade": {"p": ref, "s": 100, "t": z(T - 10 * SEC)}, "prevDailyBar": bar(midnight(prev), prior)}
    return {"daily_raw": daily, "minute": minute, "premarket": pm, "snapshot": snap, "corporate_actions": [],
            "news_count": 2}


def bundle_for(stage1: dict[str, Any], pass_id: str = "A", session: str = S) -> dict[str, Any]:
    T = s2.pass_time(session, pass_id, P)
    reqs = [{"what": w, "session": None, "path": p, "feed": f, "status": 200, "pages": 1,
             "x_ratelimit_limit": 10000 if f else None}
            for w, p, f in (("daily_raw", "/v2/stocks/bars", "sip"), ("minute", "/v2/stocks/bars", "sip"),
                            ("premarket", "/v2/stocks/bars", "sip"), ("snapshots", "/v2/stocks/snapshots", "sip"),
                            ("corporate_actions", "/v1/corporate-actions", None), ("news", "/v1beta1/news", None))]
    return {"schema": s2.BUNDLE_SCHEMA, "version": s2.BUNDLE_VERSION, "session": session, "pass": pass_id,
            "T": z(T), "fetched_at": z(T + 61 * SEC), "stage1_sha": s2.stage1_sha(stage1),
            "stage1_doc_sha": s2.stage1_doc_sha(stage1), "names": list(NAMES), "requests": reqs,
            "plan_check": {"x_ratelimit_limit": 10000},
            "entitlement": {"state": "passed", "source": "synthetic", "checked_at": z(T)},
            "halt": {}, "fetch": {"complete": True, "cut_short": None},
            "data": {n: name_data(session, T) for n in NAMES}, "earnings_rows": [], "macro_rows": []}


_BASE: dict[tuple[str, str], tuple[dict[str, Any], dict[str, Any]]] = {}


def fresh(pass_id: str = "A", session: str = S, **s1: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    key = (pass_id, session)
    if s1:
        st = stage1_doc(session, **s1)
        return st, bundle_for(st, pass_id, session)
    if key not in _BASE:
        st = stage1_doc(session)
        _BASE[key] = (st, bundle_for(st, pass_id, session))
    st, b = _BASE[key]
    return copy.deepcopy(st), copy.deepcopy(b)


def reseal(stage1: dict[str, Any], b: dict[str, Any]) -> None:
    b["stage1_sha"], b["stage1_doc_sha"] = s2.stage1_sha(stage1), s2.stage1_doc_sha(stage1)


Mut = Callable[[dict[str, Any], dict[str, Any]], None]


def run(mut: Mut | None = None, th: s2.Thresholds = TEST_ONLY, pass_id: str = "A", session: str = S,
        pass_a: Any = None, **s1: Any) -> dict[str, Any]:
    st, b = fresh(pass_id, session, **s1)
    if mut is not None:
        mut(st, b)
        reseal(st, b)
    return s2.confirm(st, b, pass_id, P, th, sha=PSHA, pass_a=pass_a)


def row(out: dict[str, Any], sym: str) -> dict[str, Any]:
    return next(r for r in out["names"] if r["symbol"] == sym)


def T_A(session: str = S) -> dt.datetime:
    return s2.pass_time(session, "A", P)


def er(sym: str, date: str, when: str) -> dict[str, str]:
    return {"symbol": sym, "date": date, "when": when, "source": "synthetic", "quality": "confirmed"}


def mr(date: str, kind: str = "cpi", severity: str = "high") -> dict[str, str]:
    return {"date": date, "time_et": "08:30", "type": kind, "severity": severity, "policy": "reduce",
            "source": "synthetic", "quality": "exact"}


def data(b: dict[str, Any], sym: str = "AAPL") -> dict[str, Any]:
    d: dict[str, Any] = b["data"][sym]
    return d


# ---------------------------------------------------------------- parameters

def test_parameters_load_and_their_hash_is_recorded():
    out = run()
    assert out["stage2_params_sha"] == PSHA and len(PSHA) == 64
    assert P.pass_at == {"A": (8, 50), "B": (9, 20)} and P.publish_by == {"A": (8, 56), "B": (9, 25)}
    assert (P.fetch_delay_s, P.ref_bar_s, P.ref_max_age_s, P.premarket_from, P.premarket_bar_s) == (60, 60, 120,
                                                                                                    (4, 0), 300)
    assert (P.baseline_sessions, P.baseline_min, P.no_trade_s, P.reserves_from_rank, P.reserves_max) == (20, 10, 900,
                                                                                                        5, 2)


def _cfg() -> dict[str, Any]:
    cfg: dict[str, Any] = yaml.safe_load(s2.CONFIG_PATH.read_text())
    return cfg


@pytest.mark.parametrize("change", [
    lambda c: c["reference_bar"].__setitem__("max_age_s", 120.0),          # the same value as a float
    lambda c: c.__setitem__("extra", 1),
    lambda c: c["rules"].reverse(),
    lambda c: c["rules"][1]["checks"].pop(),
    lambda c: c.__setitem__("thresholds", {"spread_limit_bps": 25}),        # a value is never written here
    lambda c: c["passes"]["A"].__setitem__("at", "9:50"),
    lambda c: c["possibly_halted"].__setitem__("normally_trades_premarket", "baseline"),
    lambda c: c.__setitem__("degraded", "half"),
    lambda c: c["baseline"].__setitem__("min_sessions", 21),
])
def test_the_loader_refuses_what_the_code_does_not_implement(change):
    cfg = _cfg()
    change(cfg)
    with pytest.raises(s2.ParamsError):
        s2.params_from_mapping(cfg)


def test_the_stage1_parameters_are_untouched():
    """Stage 2 has its own file; Stage 1's file and the hash DEC-0046 names are unchanged."""
    _, sha = sel.load_params()
    assert sha == "08617613bced71e4c7b7b022ca1cc34070d885d5eae17c438f39e80284e88e23"


def test_no_threshold_has_a_default():
    assert all(v is None for v in s2.Thresholds().as_dict().values())
    cfg = _cfg()
    assert cfg["thresholds"] == list(s2.THRESHOLD_KEYS) and cfg["missing_numbers"] == list(s2.MISSING_NUMBER_KEYS)
    assert s2.thresholds_from_mapping(None) == s2.Thresholds()
    for bad in ({"spread_limit_bps": 0}, {"gap_fail_atr": -1.0}, {"other": 1.0}, {"rvol": True},
                {"gap_fail_atr": 0.5, "gap_caution_atr": 0.8}):
        with pytest.raises(s2.ParamsError):
            s2.thresholds_from_mapping(bad)


# ---------------------------------------------------------------- time

@pytest.mark.parametrize("session,pass_id,utc", [
    ("2026-11-12", "A", "2026-11-12T13:50:00Z"), ("2026-11-12", "B", "2026-11-12T14:20:00Z"),
    ("2026-03-06", "A", "2026-03-06T13:50:00Z"), ("2026-03-09", "A", "2026-03-09T12:50:00Z"),   # March change
    ("2026-10-30", "A", "2026-10-30T12:50:00Z"), ("2026-11-02", "A", "2026-11-02T13:50:00Z"),   # November change
])
def test_the_pass_time_comes_from_the_session_and_the_zone(session, pass_id, utc):
    assert z(s2.pass_time(session, pass_id, P)) == utc


def test_four_am_new_york_in_utc_on_both_sides_of_each_clock_change():
    assert z(s2.ny_time("2026-03-06", (4, 0))) == "2026-03-06T09:00:00Z"
    assert z(s2.ny_time("2026-03-09", (4, 0))) == "2026-03-09T08:00:00Z"
    assert z(s2.ny_time("2026-10-30", (4, 0))) == "2026-10-30T08:00:00Z"
    assert z(s2.ny_time("2026-11-02", (4, 0))) == "2026-11-02T09:00:00Z"


def test_the_baseline_window_across_the_march_change_uses_each_days_own_offset():
    """Session 2026-03-09 (EDT): its baseline includes 2026-03-06 (EST). A bar at 08:00Z is 04:00 on the 9th and
    03:00 on the 6th: inside one window, outside the other."""
    b9 = s2.parse_bars([bar(dt.datetime(2026, 3, 9, 8, 0, tzinfo=s2.UTC), 1.0)])
    b6 = s2.parse_bars([bar(dt.datetime(2026, 3, 6, 8, 0, tzinfo=s2.UTC), 1.0)])
    assert b9 is not None and b6 is not None
    assert len(s2.premarket_window(b9, "2026-03-09", (8, 50), P)) == 1
    assert s2.premarket_window(b6, "2026-03-06", (8, 50), P) == []
    out = run(session="2026-03-09")                      # the whole pass on the day after the change
    assert row(out, "AAPL")["relative_volume"]["baseline_sessions"] == 20
    assert row(out, "AAPL")["status"] == "confirmed"


def test_both_clock_change_weeks_confirm_a_clean_name():
    for session in ("2026-03-09", "2026-11-02", "2026-03-06", "2026-10-30"):
        out = run(session=session)
        assert row(out, "MSFT")["status"] == "confirmed", session
        assert row(out, "MSFT")["relative_volume"]["value"] == 1.0


def test_parse_ts_reads_alpacas_nanoseconds():
    t = s2.parse_ts("2026-11-12T13:49:55.123456789Z")
    assert t is not None and t.microsecond == 123456 and t.tzinfo is not None
    assert s2.parse_ts("2026-11-12 13:49:55Z") is None and s2.parse_ts(None) is None


# ---------------------------------------------------------------- a clean pass

def test_a_clean_name_is_confirmed_with_every_value_shown():
    r = row(run(), "AAPL")
    assert r["status"] == "confirmed" and r["rule"] == 5 and r["reasons"] == []
    assert r["prior_close"]["raw"] == 100.0 and r["prior_close"]["date"] == D
    assert r["prior_close"]["snapshot_cross_check"]["agrees"] is True
    assert r["reference"]["kind"] == "bar" and r["reference"]["price"] == 100.5 and r["reference"]["bar_age_s"] == 0
    assert r["gap"] == {"pct": pytest.approx(0.005), "atr": pytest.approx(0.25), "atr14": 2.0}
    assert r["premarket"]["volume"] == 58 * 10.0 and r["premarket"]["bars"] == 58       # 04:00 to 08:45 starts
    assert r["relative_volume"]["value"] == 1.0
    assert r["halt"]["state"] == "unknown" and r["position"] == "not_available" and r["news_count"] == 2
    assert r["last_trade"]["evidence_only"] is True and r["last_trade"]["age_s"] == 10


def test_every_name_appears_and_the_stage1_block_is_re_emitted_unchanged():
    st, b = fresh()
    out = s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)
    assert out["stage1"] == st and [r["symbol"] for r in out["names"]] == sorted(NAMES)
    assert out["stage1_sha"] == s2.stage1_sha(st) and out["as_of"] == "2026-11-12T13:50:00Z"


# ---------------------------------------------------------------- G1 prior close

def test_g1_the_prior_close_is_the_last_raw_bar_before_the_session():
    def mut(st, b):
        data(b)["daily_raw"][-1]["c"] = 99.5
        data(b)["daily_raw"][-2]["c"] = 50.0
    r = row(run(mut), "AAPL")
    assert r["prior_close"]["raw"] == 99.5 and r["prior_close"]["date"] == D
    assert r["prior_close"]["snapshot_cross_check"]["agrees"] is False      # a cross-check only
    assert r["status"] == "confirmed"


def test_g1_a_missing_bar_for_the_session_before_is_stale_data():
    r = row(run(lambda st, b: data(b)["daily_raw"].pop()), "AAPL")
    assert r["status"] == "not_confirmed" and "stale_prior_close" in r["reasons"]
    assert r["prior_close"]["date"] == lv.prev_session(D)


def test_g1_no_daily_bar_at_all():
    r = row(run(lambda st, b: data(b).__setitem__("daily_raw", [])), "AAPL")
    assert r["status"] == "not_confirmed" and r["prior_close"]["raw"] is None and r["gap"]["pct"] is None


def test_the_day_after_a_holiday_reads_the_session_before_the_holiday():
    """2026-11-27, the Friday after Thanksgiving (2026-11-26, closed), is also a half day: its pre-market hours are
    the same, so the window is 04:00 to 08:50 as on any day."""
    out = run(session="2026-11-27")
    r = row(out, "AAPL")
    assert r["prior_close"]["date"] == "2026-11-25" and r["prior_close"]["expected_date"] == "2026-11-25"
    assert r["premarket"]["bars"] == 58 and r["status"] == "confirmed"


def test_g1_a_bar_dated_on_the_session_itself_is_not_the_prior_close():
    def mut(st, b):
        data(b)["daily_raw"].append(bar(midnight(S), 500.0))
    r = row(run(mut), "AAPL")
    assert r["prior_close"]["raw"] == 100.0


# ---------------------------------------------------------------- corporate actions

def test_a_split_ex_date_is_not_confirmed_and_never_scaled():
    def mut(st, b):
        data(b)["corporate_actions"] = [{"type": "forward_splits", "symbol": "AAPL", "ex_date": S, "old_rate": 1,
                                          "new_rate": 4}]
        data(b)["minute"][-1]["c"] = 25.2
    r = row(run(mut), "AAPL")
    assert r["status"] == "not_confirmed" and "split_ex_date" in r["reasons"]
    assert r["prior_close"]["adjusted"] == 25.0 and r["prior_close"]["adjustment"] == "split"
    assert r["prior_close"]["close_adjusted"] is True
    assert r["gap"]["pct"] == pytest.approx(0.008) and r["gap"]["atr"] is None     # ATR14 is in pre-split units


def test_an_ex_dividend_day_uses_the_raw_close_and_is_a_caution():
    def mut(st, b):
        data(b)["corporate_actions"] = [{"type": "cash_dividends", "symbol": "AAPL", "ex_date": S, "rate": 0.25}]
    r = row(run(mut), "AAPL")
    assert r["status"] == "caution" and r["cautions"] == ["close_adjusted"]
    assert r["prior_close"]["adjustment"] == "dividend_not_defined" and r["prior_close"]["adjusted"] is None
    assert r["gap"]["pct"] == pytest.approx(0.005)


def test_another_action_on_the_session_is_not_confirmed_and_one_on_another_day_is_ignored():
    r = row(run(lambda st, b: data(b).__setitem__("corporate_actions", [
        {"type": "spin_offs", "source_symbol": "AAPL", "ex_date": S}])), "AAPL")
    assert r["status"] == "not_confirmed" and "corporate_action_not_handled" in r["reasons"]
    r = row(run(lambda st, b: data(b).__setitem__("corporate_actions", [
        {"type": "forward_splits", "symbol": "AAPL", "ex_date": "2026-11-13", "old_rate": 1, "new_rate": 2}])), "AAPL")
    assert r["status"] == "confirmed"


# ---------------------------------------------------------------- G2 reference price

def _minute_ending(b: dict[str, Any], age_s: int, c: float = 100.5) -> None:
    end = T_A() - age_s * SEC
    data(b)["minute"] = [bar(end - MIN, c)]


def test_g2_a_bar_that_ended_exactly_120_s_before_t_is_the_reference():
    r = row(run(lambda st, b: _minute_ending(b, 120)), "AAPL")
    assert r["reference"]["kind"] == "bar" and r["reference"]["bar_age_s"] == 120


def test_g2_a_bar_one_second_older_falls_to_the_midpoint():
    r = row(run(lambda st, b: _minute_ending(b, 121)), "AAPL")
    assert r["reference"]["kind"] == "mid" and r["reference"]["price"] == pytest.approx(100.5)
    assert r["status"] == "confirmed"                  # the quote is 5 s old, within the test-only age limit


def test_g2_a_bar_still_forming_at_t_is_not_finished():
    def mut(st, b):
        data(b)["minute"] = [bar(T_A() - 30 * SEC, 120.0)]      # starts 30 s before T, ends 30 s after
        data(b)["snapshot"]["latestQuote"]["bs"] = 0
    r = row(run(mut), "AAPL")
    assert r["reference"]["kind"] is None and r["status"] == "not_confirmed" and "no_reference_price" in r["reasons"]


@pytest.mark.parametrize("side", ["bs", "as", "bp", "ap"])
def test_g2_a_zero_price_or_size_on_one_side_is_one_sided_no_midpoint(side):
    def mut(st, b):
        _minute_ending(b, 300)
        data(b)["snapshot"]["latestQuote"][side] = 0
    r = row(run(mut), "AAPL")
    assert r["quote"]["state"] == "one_sided" and r["quote"]["spread_bps"] is None
    assert r["status"] == "not_confirmed" and "no_reference_price" in r["reasons"]


def test_g2_a_crossed_quote_gives_no_midpoint_and_no_spread():
    def mut(st, b):
        _minute_ending(b, 300)
        data(b)["snapshot"]["latestQuote"].update({"bp": 100.6, "ap": 100.4})
    r = row(run(mut), "AAPL")
    assert r["quote"]["state"] == "crossed" and r["quote"]["spread_bps"] is None
    assert r["checks"]["spread_above_limit"] is False and "no_reference_price" in r["reasons"]


def test_g2_a_crossed_quote_beside_a_fresh_bar_does_not_disqualify():
    r = row(run(lambda st, b: data(b)["snapshot"]["latestQuote"].update({"bp": 100.6, "ap": 100.4})), "AAPL")
    assert r["reference"]["kind"] == "bar" and r["status"] == "confirmed"


def test_g2_a_midpoint_needs_the_spread_within_the_limit():
    def mut(st, b):
        _minute_ending(b, 300)
        data(b)["snapshot"]["latestQuote"].update({"bp": 100.0, "ap": 101.0})      # about 99.5 bp, over 40
    r = row(run(mut), "AAPL")
    assert r["reference"]["kind"] is None and r["status"] == "not_confirmed"


def test_g2_the_midpoints_age_needs_a_number_the_record_does_not_give():
    th = s2.Thresholds(**{**TEST_ONLY.as_dict(), "quote_max_age_s": None})
    r = row(run(lambda st, b: _minute_ending(b, 300), th=th), "AAPL")
    assert r["reference"]["kind"] == "mid" and r["status"] == "unclassified"
    assert r["unclassified_by"] == ["quote_max_age_s"] and r["quote"]["age_s"] == 5
    th2 = s2.Thresholds(**{**TEST_ONLY.as_dict(), "quote_max_age_s": 4.0})
    r = row(run(lambda st, b: _minute_ending(b, 300), th=th2), "AAPL")
    assert r["status"] == "not_confirmed" and r["reasons"] == ["stale_quote"]


def test_g2_the_raw_last_trade_is_evidence_only():
    def mut(st, b):
        data(b)["snapshot"]["latestTrade"]["p"] = 180.0
    r = row(run(mut), "AAPL")
    assert r["last_trade"]["price"] == 180.0 and r["reference"]["price"] == 100.5 and r["status"] == "confirmed"


# ---------------------------------------------------------------- G4, G5, G6

def test_g4_a_bar_ending_exactly_at_t_counts_and_one_starting_before_four_does_not():
    def mut(st, b):
        pm = data(b)["premarket"][S]
        pm.append(bar(s2.ny_time(S, (3, 55)), 100.5, v=1000.0))         # starts before 04:00
        pm.append(bar(s2.ny_time(S, (8, 50)), 100.5, v=1000.0))         # starts at T: still forming
    r = row(run(mut), "AAPL")
    assert r["premarket"]["bars"] == 58 and r["premarket"]["volume"] == 580.0
    last = s2.parse_bars([bar(s2.ny_time(S, (8, 45)), 1.0)])
    assert last is not None and len(s2.premarket_window(last, S, (8, 50), P)) == 1


def test_g4_a_missing_bar_is_zero_volume():
    def mut(st, b):
        del data(b)["premarket"][S][10:20]
    r = row(run(mut), "AAPL")
    assert r["premarket"]["volume"] == 480.0 and r["relative_volume"]["value"] == pytest.approx(480 / 580)


def _baseline(b: dict[str, Any], keep: int) -> None:
    pm = data(b)["premarket"]
    for day in back(lv.prev_session(S), 20)[keep:]:
        del pm[day]


def test_g5_exactly_10_complete_sessions_is_available_and_9_is_not():
    r = row(run(lambda st, b: _baseline(b, 10)), "AAPL")
    assert r["relative_volume"]["available"] is True and r["relative_volume"]["baseline_sessions"] == 10
    r = row(run(lambda st, b: _baseline(b, 9)), "AAPL")
    assert r["relative_volume"] == {"value": None, "available": False, "baseline_sessions": 9,
                                    "baseline_median": 580.0}
    assert r["checks"]["relative_volume_at_or_above_limit"] is False and r["status"] == "confirmed"   # neutral


def test_g5_the_limit_is_at_or_above():
    def at(x: float) -> Mut:
        def mut(st, b):
            for row_ in data(b)["premarket"][S]:
                row_["v"] = 10.0 * x
        return mut
    assert row(run(at(4.0)), "AAPL")["status"] == "caution"
    assert row(run(at(4.0)), "AAPL")["cautions"] == ["relative_volume_at_or_above_limit"]
    assert row(run(at(3.5)), "AAPL")["status"] == "confirmed"


def test_g5_a_zero_median_is_not_available():
    assert s2.relative_volume(10.0, [0.0] * 20, 10) is None
    assert s2.relative_volume(10.0, [5.0] * 10, 10) == 2.0
    assert s2.relative_volume(10.0, [5.0] * 9, 10) is None


def test_g6_premarket_high_and_low_come_from_the_five_minute_bars():
    def mut(st, b):
        data(b)["premarket"][S][3].update({"h": 104.0})
        data(b)["premarket"][S][5].update({"l": 97.0})
        data(b)["snapshot"]["dailyBar"] = bar(midnight(S), 100.0)     # never read for the pre-market range
    r = row(run(mut), "AAPL")
    assert r["premarket"]["high"] == 104.0 and r["premarket"]["low"] == 97.0


CARD = {"ceiling": 101.0, "floor": 99.0, "upper_target1": 101.5, "lower_target1": 98.5}


@pytest.mark.parametrize("price,pos,side,status", [
    (101.6, "past_upper_target1", "upper", "caution"), (101.2, "above_ceiling", None, "caution"),
    (101.0, "between", None, "confirmed"), (100.0, "between", None, "confirmed"),
    (99.0, "between", None, "confirmed"), (98.8, "below_floor", None, "caution"),
    (98.4, "past_lower_target1", "lower", "caution")])
def test_g6_position_against_the_cards_levels(price, pos, side, status):
    def mut(st, b):
        next(r for r in st["names"] if r["symbol"] == "AAPL")["card"] = dict(CARD)
        data(b)["minute"][-1]["c"] = price
    r = row(run(mut), "AAPL")
    assert (r["position"], r["side_missed"], r["status"]) == (pos, side, status)


def test_g6_without_card_fields_position_is_not_available_never_guessed():
    r = row(run(lambda st, b: data(b)["minute"][-1].update({"c": 150.0})), "AAPL")
    assert r["position"] == "not_available" and r["checks"]["beyond_ceiling_or_floor"] is False


# ---------------------------------------------------------------- halt

def test_halt_is_unknown_without_a_stream_source():
    r = row(run(), "NVDA")
    assert r["halt"] == {"state": "unknown", "reported": None, "source": None, "age_s": None, "possibly_halted": False}


def test_possibly_halted_no_trade_in_15_minutes_and_a_one_sided_quote():
    def mut(st, b):
        data(b, "NVDA")["minute"] = [bar(T_A() - 16 * MIN, 100.5)]
        data(b, "NVDA")["snapshot"]["latestTrade"]["t"] = z(T_A() - 16 * MIN)
        data(b, "NVDA")["snapshot"]["latestQuote"]["as"] = 0
    r = row(run(mut), "NVDA")
    assert r["halt"]["possibly_halted"] is True and r["checks"]["possibly_halted"] is True
    assert r["status"] == "not_confirmed"              # with no trade there is no reference price either


def test_a_trade_inside_15_minutes_is_not_possibly_halted():
    def mut(st, b):
        data(b, "NVDA")["minute"] = [bar(T_A() - 15 * MIN, 100.5)]   # starts exactly 15 minutes before T
        data(b, "NVDA")["snapshot"]["latestQuote"]["as"] = 0
    assert row(run(mut), "NVDA")["halt"]["possibly_halted"] is False


def _halt(state: str, age_s: int) -> Mut:
    def mut(st, b):
        b["halt"]["NVDA"] = {"state": state, "source": "synthetic-stream", "as_of": z(T_A() - age_s * SEC)}
    return mut


def test_a_fresh_halt_no_longer_qualifies():
    r = row(run(_halt("halted", 10)), "NVDA")
    assert r["status"] == "no_longer_qualifies" and r["rule"] == 1 and r["reasons"] == ["halted"]
    assert r["halt"]["state"] == "halted" and r["halt"]["age_s"] == 10


def test_a_stale_halt_is_unknown_and_its_freshness_needs_a_number_the_record_does_not_give():
    r = row(run(_halt("halted", 31)), "NVDA")
    assert r["halt"]["state"] == "unknown" and r["status"] == "confirmed"
    th = s2.Thresholds(**{**TEST_ONLY.as_dict(), "halt_max_age_s": None})
    r = row(run(_halt("halted", 1), th=th), "NVDA")
    assert r["status"] == "unclassified" and r["unclassified_by"] == ["halt_max_age_s"]
    assert row(run(_halt("not_halted", 1)), "NVDA")["halt"]["state"] == "not_halted"


# ---------------------------------------------------------------- events

@pytest.mark.parametrize("date,when,status", [
    (D, "amc", "no_longer_qualifies"), (S, "bmo", "no_longer_qualifies"),
    (S, "during", "caution"), (S, "amc", "caution"), (D, "bmo", "confirmed"), ("2026-11-13", "bmo", "confirmed")])
def test_earnings_released_since_stage1_and_earnings_today(date, when, status):
    r = row(run(lambda st, b: b["earnings_rows"].append(er("AAPL", date, when))), "AAPL")
    assert r["status"] == status


def test_earnings_released_on_a_day_between_the_sessions():
    """Stage 1 on Friday 2026-11-06 selects for Monday 2026-11-09: a report on the Saturday is released since."""
    out = run(lambda st, b: b["earnings_rows"].append(er("AAPL", "2026-11-07", "bmo")), session="2026-11-09")
    assert row(out, "AAPL")["status"] == "no_longer_qualifies"


def test_an_unreadable_earnings_row_naming_a_desk_name_is_a_caution_and_counted():
    def mut(st, b):
        b["earnings_rows"].append({"symbol": "AAPL", "date": "2026-13-01", "when": "bmo", "source": "x",
                                   "quality": "confirmed"})
    out = run(mut)
    assert row(out, "AAPL")["cautions"] == ["earnings_row_unreadable"]
    assert out["unreadable_event_rows"] == {"earnings_rows": 1, "macro_rows": 0}


def test_a_macro_event_today_is_a_caution_for_every_name():
    out = run(lambda st, b: b["macro_rows"].extend([mr(S, "fomc_minutes", "medium"), mr("2026-11-13")]))
    assert all(r["status"] == "caution" and r["events"]["macro_today"] == ["fomc_minutes"] for r in out["names"])


def test_news_is_a_count_and_not_available_is_neutral():
    assert row(run(lambda st, b: data(b).__setitem__("news_count", None)), "AAPL")["status"] == "confirmed"
    assert row(run(lambda st, b: data(b).__setitem__("news_count", 40)), "AAPL")["news_count"] == 40


# ---------------------------------------------------------------- the status table, row by row

def _quote(**q: Any) -> Mut:
    def mut(st, b):
        data(b)["snapshot"]["latestQuote"].update(q)
    return mut


def _gap(atr_units: float) -> Mut:
    def mut(st, b):
        data(b, "NVDA")["minute"][-1]["c"] = 100.0 + 2.0 * atr_units        # ATR14 2.0, prior close 100.0
    return mut


def _both(*ms: Mut) -> Mut:
    def mut(st, b):
        for m in ms:
            m(st, b)
    return mut


TABLE = [
    # (what, mutation, status, rule, reason)
    ("rule 1: halted", _halt("halted", 0), "no_longer_qualifies", 1, "halted"),
    ("rule 1: earnings released", lambda st, b: b["earnings_rows"].append(er("NVDA", S, "bmo")),
     "no_longer_qualifies", 1, "earnings_released"),
    ("rule 2: entitlement", lambda st, b: b["entitlement"].update({"state": "unknown"}), "not_confirmed", 2,
     "entitlement_not_passed"),
    ("rule 2: feed", lambda st, b: b["requests"][0].update({"feed": "iex"}), "not_confirmed", 2, "feed_not_named"),
    ("rule 2: cut short", lambda st, b: b["fetch"].update({"cut_short": "rate_limit"}), "not_confirmed", 2,
     "fetch_cut_short"),
    ("rule 2: no reference", lambda st, b: (data(b, "NVDA").__setitem__("minute", []),
                                            data(b, "NVDA")["snapshot"]["latestQuote"].update({"bs": 0})),
     "not_confirmed", 2, "no_reference_price"),
    ("rule 2: stale data", lambda st, b: data(b, "NVDA")["daily_raw"].pop(), "not_confirmed", 2,
     "stale_prior_close"),
    ("rule 3: spread", lambda st, b: data(b, "NVDA")["snapshot"]["latestQuote"].update({"bp": 100.0, "ap": 101.0}),
     "no_longer_qualifies", 3, "spread_above_limit"),
    ("rule 3: gap at the fail limit", lambda st, b: data(b, "NVDA")["minute"][-1].update({"c": 104.0}),
     "no_longer_qualifies", 3, "gap_at_or_above_fail_limit"),
    ("rule 3: gap below the fail limit", lambda st, b: data(b, "NVDA")["minute"][-1].update({"c": 103.5}),
     "caution", 4, "gap_at_or_above_caution_limit"),
    ("rule 4: gap at the caution limit", lambda st, b: data(b, "NVDA")["minute"][-1].update({"c": 101.5}),
     "caution", 4, "gap_at_or_above_caution_limit"),
    ("rule 4: earnings today", lambda st, b: b["earnings_rows"].append(er("NVDA", S, "amc")), "caution", 4,
     "earnings_today"),
    ("rule 4: macro today", lambda st, b: b["macro_rows"].append(mr(S)), "caution", 4, "macro_event_today"),
    ("rule 5: confirmed", lambda st, b: None, "confirmed", 5, None),
    ("rule 5: gap just below the caution limit", lambda st, b: data(b, "NVDA")["minute"][-1].update({"c": 101.25}),
     "confirmed", 5, None),
]


@pytest.mark.parametrize("what,mut,status,rule,reason", TABLE, ids=[t[0] for t in TABLE])
def test_the_status_table_row_by_row(what, mut, status, rule, reason):
    r = row(run(mut), "NVDA")
    assert (r["status"], r["rule"]) == (status, rule), what
    if reason is not None:
        assert reason in r["reasons"]


def test_ordering_a_halted_name_with_a_wide_spread_is_rule_1():
    r = row(run(_both(_halt("halted", 0), lambda st, b: data(b, "NVDA")["snapshot"]["latestQuote"].update(
        {"bp": 90.0, "ap": 110.0}))), "NVDA")
    assert (r["status"], r["rule"]) == ("no_longer_qualifies", 1) and r["checks"]["spread_above_limit"] is True


def test_ordering_no_reference_price_and_a_huge_gap_is_not_confirmed():
    """The last bar is 10 minutes old and 30 ATR away; the quote is one-sided: no reference, so no gap is taken."""
    def mut(st, b):
        data(b, "NVDA")["minute"] = [bar(T_A() - 11 * MIN, 160.0)]
        data(b, "NVDA")["snapshot"]["latestQuote"]["bs"] = 0
    r = row(run(mut), "NVDA")
    assert (r["status"], r["rule"]) == ("not_confirmed", 2) and r["gap"]["atr"] is None


def test_ordering_a_gap_over_both_limits_is_rule_3():
    r = row(run(_gap(5.0)), "NVDA")
    assert (r["status"], r["rule"]) == ("no_longer_qualifies", 3)
    assert r["checks"]["gap_at_or_above_caution_limit"] is True


def test_ordering_entitlement_before_spread_and_gap():
    r = row(run(_both(lambda st, b: b["entitlement"].update({"state": "failed"}), _gap(5.0))), "NVDA")
    assert (r["status"], r["rule"]) == ("not_confirmed", 2)


def test_ordering_a_caution_never_hides_a_rule_3_fail():
    r = row(run(_both(lambda st, b: b["macro_rows"].append(mr(S)), _gap(-2.0))), "NVDA")
    assert (r["status"], r["rule"]) == ("no_longer_qualifies", 3)


def test_a_negative_gap_counts_by_its_size():
    assert row(run(_gap(-0.75)), "NVDA")["status"] == "caution"


# ---------------------------------------------------------------- thresholds absent

def test_without_thresholds_rules_that_need_one_are_unclassified_with_the_measured_value():
    out = run(th=NONE)
    for r in out["names"]:
        assert r["status"] == "unclassified" and r["rule"] == 3
        assert r["unclassified_by"] == ["gap_fail_atr", "spread_limit_bps"]
        assert r["gap"]["atr"] == pytest.approx(0.25) and r["quote"]["spread_bps"] == pytest.approx(19.900497512)
        assert r["relative_volume"]["value"] == 1.0
    assert out["thresholds_set"] is False and out["reserves"] == [] and out["reserve_note"] == "No reserve qualifies"


def test_without_thresholds_the_rules_that_need_none_still_apply():
    out = run(_both(_halt("halted", 0), lambda st, b: data(b, "AAPL")["daily_raw"].pop(),
                    lambda st, b: data(b, "MSFT")["corporate_actions"].append(
                        {"type": "forward_splits", "symbol": "MSFT", "ex_date": S, "old_rate": 1, "new_rate": 2}),
                    lambda st, b: b["earnings_rows"].append(er("TSLA", D, "amc"))),
              th=s2.Thresholds(halt_max_age_s=30.0))
    assert row(out, "NVDA")["status"] == "no_longer_qualifies"
    assert row(out, "TSLA")["status"] == "no_longer_qualifies"
    assert row(out, "AAPL")["status"] == "not_confirmed" and row(out, "MSFT")["status"] == "not_confirmed"
    assert row(out, "AMD")["status"] == "unclassified"


def test_without_thresholds_a_midpoint_reference_is_unclassified():
    r = row(run(lambda st, b: _minute_ending(b, 300), th=NONE), "AAPL")
    assert r["status"] == "unclassified" and r["rule"] == 2 and r["unclassified_by"] == ["spread_limit_bps"]


# ---------------------------------------------------------------- degraded

def _unconfirm(n: int) -> Mut:
    def mut(st, b):
        for s in NAMES[:n]:
            data(b, s)["daily_raw"].pop()
    return mut


def test_more_than_half_not_confirmed_is_degraded():
    assert run(_unconfirm(7))["degraded"] is True
    assert run(_unconfirm(6))["degraded"] is False
    assert run(lambda st, b: b["entitlement"].update({"state": "unknown"}))["degraded"] is True


# ---------------------------------------------------------------- reserves

def _block(*syms: str) -> Mut:
    def mut(st, b):
        for s in syms:
            data(b, s)["daily_raw"].pop()
    return mut


def test_reserves_zero_one_two_and_three_candidates():
    # Stage 1 order is NAMES: ranks 1-4 are picks, 5.. are SPY's position onwards: NVDA (5), AMZN (6), GOOGL (7) ...
    later = NAMES[4:]
    assert [x["symbol"] for x in run()["reserves"]] == ["NVDA", "AMZN"]                       # many, up to two
    assert [x["symbol"] for x in run(_block(*later[:1]))["reserves"]] == ["AMZN", "GOOGL"]
    assert [x["symbol"] for x in run(_block(*later[2:]))["reserves"]] == ["NVDA", "AMZN"]      # exactly two
    out = run(_block(*later[1:]))
    assert [x["symbol"] for x in out["reserves"]] == ["NVDA"] and out["reserve_note"] is None   # one
    out = run(_block(*later))
    assert out["reserves"] == [] and out["reserve_note"] == "No reserve qualifies"              # zero
    out = run(_block(*later[3:]))
    assert [x["symbol"] for x in out["reserves"]] == ["NVDA", "AMZN"]                         # three: first two


def test_reserves_are_eligible_ranked_fifth_or_lower_and_never_picks():
    out = run(eligible=set(NAMES) - {"NVDA", "MSFT"})
    # MSFT (rank 4) is ineligible, so the picks are ranks 1, 2, 3 and 6 (AMZN); NVDA (5) is ineligible
    assert out["stage1"]["picks"] == ["SPY", "QQQ", "AAPL", "AMZN"]
    assert [x["symbol"] for x in out["reserves"]] == ["GOOGL", "META"]
    assert all(x["symbol"] not in out["stage1"]["picks"] for x in out["reserves"])


def test_a_reserve_is_only_confirmed_never_caution():
    out = run(lambda st, b: b["earnings_rows"].append(er("NVDA", S, "during")))
    assert [x["symbol"] for x in out["reserves"]] == ["AMZN", "GOOGL"]


# ---------------------------------------------------------------- passes

def _pass_a(mut: Mut | None = None) -> dict[str, Any]:
    return run(mut, pass_id="A")


def test_pass_b_reports_what_changed_since_pass_a():
    a = _pass_a(_block("AMZN"))                                 # A: reserves NVDA, GOOGL
    def mut(st, b):
        data(b, "NVDA")["daily_raw"].pop()                      # B: NVDA drops out, AMZN comes back
        data(b, "AAPL")["premarket"][S][2]["h"] = 140.0
        data(b, "AAPL")["premarket"][S][2]["l"] = 60.0
    out = run(mut, pass_id="B", pass_a=a)
    ch = out["changes_since_pass_a"]
    assert {"symbol": "NVDA", "pass_a": "confirmed", "pass_b": "not_confirmed"} in ch["status"]
    assert {"symbol": "AMZN", "pass_a": "not_confirmed", "pass_b": "confirmed"} in ch["status"]
    assert ch["reserves_appeared"] == ["AMZN"] and ch["reserves_disappeared"] == ["NVDA"]
    assert [x["changed_since_pass_a"] for x in out["reserves"]] == ["appeared", None]       # AMZN, GOOGL
    assert ch["premarket_widened"][0]["symbol"] == "AAPL"
    assert ch["premarket_widened"][0]["high"][1] == 140.0 and ch["premarket_widened"][0]["low"][1] == 60.0
    assert out["as_of"] == "2026-11-12T14:20:00Z"


def test_pass_b_without_pass_a_reports_no_changes():
    assert run(pass_id="B")["changes_since_pass_a"] is None


def test_a_late_pass_a_never_replaces_pass_b():
    a, b = _pass_a(), run(pass_id="B")
    assert s2.supersedes(b, a) is True
    assert s2.supersedes(a, b) is False                          # A handed in after B is older by its as_of
    assert s2.supersedes(a, None) is True and s2.supersedes(b, b) is False


def test_pass_a_from_another_stage1_or_changed_or_not_older_is_refused():
    a = _pass_a()
    other = copy.deepcopy(a)
    other["stage1"]["picks"] = ["QQQ"]
    other["stage1_sha"], other["stage1_doc_sha"] = s2.stage1_sha(other["stage1"]), s2.stage1_doc_sha(other["stage1"])
    with pytest.raises(s2.PassAError, match="another Stage 1"):
        run(pass_id="B", pass_a=other)
    changed = copy.deepcopy(a)
    changed["stage1"]["session"] = "2026-11-10"
    with pytest.raises(s2.PassAError, match="changed"):
        run(pass_id="B", pass_a=changed)
    late = copy.deepcopy(a)
    late["as_of"] = "2026-11-12T14:20:00Z"
    with pytest.raises(s2.PassAError, match="not older"):
        run(pass_id="B", pass_a=late)
    with pytest.raises(s2.PassAError):
        run(pass_id="B", pass_a=run(pass_id="B"))               # a Pass B is not a Pass A
    with pytest.raises(s2.PassAError):
        run(pass_id="A", pass_a=a)


# ---------------------------------------------------------------- the Stage 1 block

def test_a_stage1_block_changed_by_one_character_is_refused():
    st, b = fresh()
    st["picker_ref"] = "s1-tesu"                              # one character, outside the items and the ranking
    with pytest.raises(s2.Stage1Error, match="changed"):
        s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)
    st, b = fresh()
    st["names"][0]["symbol"] = "SPZ"
    with pytest.raises(s2.Stage1Error):
        s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)


def test_a_stage1_block_for_another_session_is_refused():
    st, b = fresh()
    st["next_session"] = "2026-11-13"
    reseal(st, b)
    with pytest.raises(s2.Stage1Error, match="selects for"):
        s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)


def test_the_stage1_hash_covers_items_ranking_and_params_sha():
    st = stage1_doc()
    h = s2.stage1_sha(st)
    for k, v in (("picks", ["SPY"]), ("params_sha", "2" * 64)):
        assert s2.stage1_sha({**st, k: v}) != h
    ranking = copy.deepcopy(st)
    ranking["names"][3]["final_rank"] = 99
    assert s2.stage1_sha(ranking) != h
    assert s2.stage1_sha({**st, "picker_ref": "x"}) == h and s2.stage1_doc_sha({**st, "picker_ref": "x"}) != \
        s2.stage1_doc_sha(st)


# ---------------------------------------------------------------- the bundle

@pytest.mark.parametrize("change,match", [
    (lambda b: b.__setitem__("T", "2026-11-12T13:51:00Z"), "T is not"),
    (lambda b: b.__setitem__("fetched_at", "2026-11-12T13:50:59Z"), "fetched before"),
    (lambda b: b.__setitem__("pass", "B"), "for Pass B"),
    (lambda b: b.__setitem__("extra", 1), "exactly the keys"),
    (lambda b: b["data"]["AAPL"].__setitem__("minute", [{"t": "x", "c": float("nan")}]), "NaN"),
    (lambda b: b["entitlement"].__setitem__("state", "ok"), "entitlement"),
    (lambda b: b["halt"].__setitem__("AAPL", {"state": "paused", "source": "x"}), "halt"),
    (lambda b: b.__setitem__("session", "2026-11-14"), "session"),
])
def test_a_bundle_not_in_the_documented_shape_is_refused(change, match):
    st, b = fresh()
    change(b)
    with pytest.raises(s2.BundleError, match=match):
        s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)


def test_a_session_outside_the_calendar_is_refused():
    st, b = fresh()
    b["session"] = "2030-01-02"
    with pytest.raises(sel.CalendarError):
        s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)


def test_a_names_unreadable_data_is_its_own_bad_data():
    out = run(lambda st, b: data(b)["minute"].append({"t": "nope", "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}))
    assert row(out, "AAPL")["status"] == "not_confirmed" and row(out, "AAPL")["bad_data"] == ["minute"]
    assert row(out, "MSFT")["status"] == "confirmed"


def test_a_name_missing_from_the_data_is_not_confirmed():
    r = row(run(lambda st, b: b["data"].pop("PLTR")), "PLTR")
    assert r["status"] == "not_confirmed" and "bad_data" in r["reasons"]


def test_an_internal_error_in_one_name_never_stops_the_others(monkeypatch):
    real = s2.assess

    def boom(sym, *a, **k):
        if sym == "META":
            raise ZeroDivisionError("secret detail")
        return real(sym, *a, **k)
    monkeypatch.setattr(s2, "assess", boom)
    out = run()
    r = row(out, "META")
    assert out["status"] == "internal_error" and r["status"] == "not_confirmed" and r["reasons"] == ["internal_error"]
    assert r["error_class"] == "ZeroDivisionError" and "secret" not in s2.dumps(out)
    assert row(out, "AAPL")["status"] == "confirmed"


def test_the_benchmark_names_are_confirmed_like_any_other():
    out = run()
    assert row(out, "SPY")["status"] == "confirmed" and row(out, "QQQ")["status"] == "confirmed"


# ---------------------------------------------------------------- determinism

def _shuffled(b: dict[str, Any], seed: int) -> dict[str, Any]:
    rnd = random.Random(seed)

    def mix(x: Any) -> Any:
        if isinstance(x, dict):
            keys = list(x)
            rnd.shuffle(keys)
            return {k: mix(x[k]) for k in keys}
        if isinstance(x, list):
            return [mix(v) for v in x]
        return x
    out: dict[str, Any] = mix(b)
    rnd.shuffle(out["names"])
    rnd.shuffle(out["requests"])
    for d in out["data"].values():
        rnd.shuffle(d["daily_raw"])
        rnd.shuffle(d["minute"])
        for v in d["premarket"].values():
            rnd.shuffle(v)
    return out


def test_shuffled_inputs_give_byte_identical_output():
    st, b = fresh()
    b["earnings_rows"] = [er("AAPL", S, "amc"), er("MSFT", "2026-11-20", "bmo")]
    b["macro_rows"] = [mr("2026-11-20"), mr("2026-11-21", "nfp")]
    reseal(st, b)
    one = s2.dumps(s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA))
    for seed in (1, 2, 3):
        sb = _shuffled(b, seed)
        rnd = random.Random(seed)
        rnd.shuffle(sb["earnings_rows"])
        rnd.shuffle(sb["macro_rows"])
        assert s2.dumps(s2.confirm(st, sb, "A", P, TEST_ONLY, sha=PSHA)) == one
    assert s2.dumps(s2.confirm(st, b, "A", P, TEST_ONLY, sha=PSHA)) == one


def test_the_bundle_hash_names_the_content():
    st, b = fresh()
    h = s2.bundle_sha(b)
    assert s2.bundle_sha(_shuffled(b, 9)) == h
    data(b)["minute"][0]["v"] = 101.0
    assert s2.bundle_sha(b) != h


# ---------------------------------------------------------------- the command

def _files(tmp_path: Path, mut: Mut | None = None, pass_id: str = "A") -> tuple[Path, Path]:
    st, b = fresh(pass_id)
    if mut is not None:
        mut(st, b)
        reseal(st, b)
    s1p, bp = tmp_path / "s1.json", tmp_path / f"b{pass_id}.json"
    s1p.write_text(json.dumps(st))
    bp.write_text(json.dumps(b))
    return s1p, bp


def test_the_command_writes_once_and_never_over(tmp_path, capsys):
    s1p, bp = _files(tmp_path)
    th = tmp_path / "th.json"
    th.write_text(json.dumps({k: v for k, v in TEST_ONLY.as_dict().items()}))
    out = tmp_path / "a.json"
    args = ["--pass", "A", "--stage1", str(s1p), "--bundle", str(bp), "--thresholds", str(th), "--out", str(out)]
    assert s2.main(args) == s2.EXIT_OK
    first = out.read_text()
    assert json.loads(first)["counts"]["confirmed"] == 12
    assert s2.main(args) == s2.EXIT_WRITE and out.read_text() == first
    err = capsys.readouterr().err
    assert len(err.strip().splitlines()) == 1 and "Traceback" not in err


def test_the_command_without_thresholds_and_a_degraded_pass_exit_flagged(tmp_path):
    s1p, bp = _files(tmp_path, lambda st, b: b["entitlement"].update({"state": "unknown"}))
    assert s2.main(["--pass", "A", "--stage1", str(s1p), "--bundle", str(bp), "--out", str(tmp_path / "o.json")]) \
        == s2.EXIT_FLAGGED


def test_the_command_pass_b_reads_pass_a(tmp_path):
    s1p, ba = _files(tmp_path)
    _, bb = _files(tmp_path, pass_id="B")
    th = tmp_path / "th.yaml"
    th.write_text(yaml.safe_dump(TEST_ONLY.as_dict()))
    oa, ob = tmp_path / "oa.json", tmp_path / "ob.json"
    assert s2.main(["--pass", "A", "--stage1", str(s1p), "--bundle", str(ba), "--thresholds", str(th),
                    "--out", str(oa)]) == 0
    assert s2.main(["--pass", "B", "--stage1", str(s1p), "--bundle", str(bb), "--pass-a", str(oa),
                    "--thresholds", str(th), "--out", str(ob)]) == 0
    assert json.loads(ob.read_text())["changes_since_pass_a"]["status"] == []
    assert s2.main(["--pass", "B", "--stage1", str(s1p), "--bundle", str(bb), "--pass-a", str(ob),
                    "--out", str(tmp_path / "x.json")]) == s2.EXIT_PASS_A


@pytest.mark.parametrize("case,code", [
    ("bad bundle", s2.EXIT_BUNDLE), ("bad params", s2.EXIT_PARAMS), ("bad thresholds", s2.EXIT_PARAMS),
    ("usage", s2.EXIT_USAGE), ("pass a with pass a", s2.EXIT_USAGE), ("stage1 changed", s2.EXIT_STAGE1),
    ("stage1 unreadable", s2.EXIT_STAGE1), ("calendar", s2.EXIT_CALENDAR), ("unwritable", s2.EXIT_WRITE)])
def test_the_commands_exit_codes(tmp_path, capsys, case, code):
    s1p, bp = _files(tmp_path)
    out = tmp_path / "o.json"
    args = ["--pass", "A", "--stage1", str(s1p), "--bundle", str(bp), "--out", str(out)]
    if case == "bad bundle":
        bp.write_text("{")
    elif case == "bad params":
        bad = tmp_path / "p.yaml"
        bad.write_text("version: 2\n")
        args += ["--params", str(bad)]
    elif case == "bad thresholds":
        bad = tmp_path / "t.yaml"
        bad.write_text("spread_limit_bps: -1\n")
        args += ["--thresholds", str(bad)]
    elif case == "usage":
        args = ["--pass", "C"]
    elif case == "pass a with pass a":
        args += ["--pass-a", str(bp)]
    elif case == "stage1 changed":
        s1p.write_text(s1p.read_text().replace('"s1-test"', '"s1-tesu"'))
    elif case == "stage1 unreadable":
        s1p.write_text("[")
    elif case == "calendar":
        doc = json.loads(bp.read_text())
        doc["session"] = "2031-01-02"
        bp.write_text(json.dumps(doc))
    elif case == "unwritable":
        args[-1] = str(s1p / "o.json")                          # under a file: no folder can be made
    assert s2.main(args) == code
    assert not out.exists()
    err = capsys.readouterr().err
    assert len(err.strip().splitlines()) == 1 and "Traceback" not in err
