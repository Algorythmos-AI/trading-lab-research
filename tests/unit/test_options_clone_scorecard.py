"""The options clone's trade-quality scorecard (wt.options.scorecard) and its place in the nightly review."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest
import yaml
import test_options_clone_session as S
from test_options_clone_session import world  # noqa: F401

from wt.options import scorecard, session
from wt.options.regime import NEW_YORK

ROOT = Path(__file__).resolve().parents[2]
CFG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
DAY = "2026-11-18"


def at(hhmm: str, s: int = 0) -> dt.datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return dt.datetime(2026, 11, 18, h, m, s, tzinfo=NEW_YORK)


def plan(n: int = 1, **kw) -> dict:
    return {"trade_id": f"{DAY}-O-{n}", "date": DAY, "root": "SPY", "side": "call", "setup": "retest",
            "signal_bar": "10:26", "state": "closed", "fill": 1.02, "quoted_ask": 1.00, "quote_age_s": 1.5,
            "filled_at": at("10:26", 40).isoformat(), "exit_reason": "target", **kw}


def journal(n: int = 1, **sent) -> list[dict]:
    tid = f"{DAY}-O-{n}"
    return [{"event": "armed", "feed": "opra"},
            {"event": "names", "source": "focus", "names": ["SPY"]},
            {"event": "entry_sent", "trade_id": tid, "quoted_ask": 1.00, "quoted_bid": 0.96, "quote_age_s": 1.5,
             **sent},
            {"event": "filled", "trade_id": tid, "fill": 1.02, "quoted_ask": 1.00, "slippage_pct": 2.0},
            {"event": "trade_closed", "trade_id": tid, "rop": 0.5, "exit_reason": "target"}]


def decisions(bars: list[str], entered_at: str | None = "10:26") -> list[dict]:
    out = []
    for b in bars:
        if b == entered_at:
            out.append({"root": "SPY", "bar": b, "action": "entered", "signals": [
                {"setup": "retest", "side": "call", "reason": None,
                 "contract": {"expiry": DAY, "modelled": False, "delta": 0.41}}]})
        else:
            out.append({"root": "SPY", "bar": b, "action": "no-setup", "signals": []})
    return out


BARS = scorecard.expected_bars(at("10:00"), at("14:30"), 2)


def test_the_entry_window_bars_leave_out_the_last_entry_bar():
    assert BARS[0] == "10:00" and BARS[-1] == "14:28" and len(BARS) == 135
    half = session.clock("2026-11-27", CFG["day"])                                     # the day after Thanksgiving
    assert half.half_day and scorecard.expected_bars(half.first_entry, half.last_entry, 2)[-1] == "11:28"


def test_a_trade_line_reads_the_quote_the_fill_and_the_exit():
    (t,) = scorecard.scorecard(DAY, journal(), decisions(BARS), [plan()], BARS, 25)["trades"]
    assert t["bar_final"] is True and t["feed"] == "opra" and t["delta"] == 0.41 and t["modelled"] is False
    assert t["quote_age_s"] == 1.5
    assert t["spread_pct"] == pytest.approx(4 / 0.98, abs=0.01)                         # 0.04 on a 0.98 mid
    assert t["fill_vs_ask_pct"] == 2.0
    assert t["fill_vs_mid_pct"] == pytest.approx(0.04 / 0.98 * 100, abs=0.01)
    assert t["signal_to_fill_min"] == pytest.approx(40 / 60, abs=0.01)
    assert t["exit_reason"] == "target" and t["rop"] == 0.5 and t["r"] == 2.0           # +50% on a 25% stop
    assert t["missing"] == []


def test_a_bar_the_feed_changed_after_it_was_judged_is_not_final():
    j = journal() + [{"event": "bar_revised", "root": "SPY", "bar": "10:26", "judged": 1.0, "now": 1.1}]
    (t,) = scorecard.scorecard(DAY, j, decisions(BARS), [plan()], BARS, 25)["trades"]
    assert t["bar_final"] is False
    other = journal() + [{"event": "bar_revised", "root": "QQQ", "bar": "10:26"}]
    assert scorecard.scorecard(DAY, other, decisions(BARS), [plan()], BARS, 25)["trades"][0]["bar_final"] is True


def test_an_entry_row_from_before_the_bid_was_logged_names_what_is_missing():
    j = journal()
    del j[2]["quoted_bid"]
    (t,) = scorecard.scorecard(DAY, j, decisions(BARS), [plan()], BARS, 25)["trades"]
    assert t["spread_pct"] is None and t["fill_vs_mid_pct"] is None and t["fill_vs_ask_pct"] == 2.0
    assert t["missing"] == ["spread_pct", "fill_vs_mid_pct"]


def test_an_entry_that_never_filled_is_scored_without_fill_figures():
    p = plan(state="cancelled", fill=None, filled_at="", exit_reason="")
    j = journal()[:3]
    (t,) = scorecard.scorecard(DAY, j, decisions(BARS), [p], BARS, 25)["trades"]
    assert t["state"] == "cancelled" and t["fill_vs_ask_pct"] is None and t["r"] is None
    assert t["missing"] == []                                    # nothing a cancelled entry could have logged


def test_rejected_plans_and_other_sessions_are_left_out():
    rej = plan(2, state="rejected", fill=None)
    old = {**plan(3), "date": "2026-11-17", "trade_id": "2026-11-17-O-1"}
    got = scorecard.scorecard(DAY, journal(), decisions(BARS), [plan(), rej, old], BARS, 25)["trades"]
    assert [t["trade_id"] for t in got] == [f"{DAY}-O-1"]


def test_trades_are_in_number_order():
    ps = [plan(10), plan(2)]
    got = scorecard.scorecard(DAY, journal(2) + journal(10), decisions(BARS), ps, BARS, 25)["trades"]
    assert [t["trade_id"] for t in got] == [f"{DAY}-O-2", f"{DAY}-O-10"]


def test_a_day_with_no_entry_and_a_line_for_every_bar_is_quiet():
    d = scorecard.day_health(journal()[:2], decisions(BARS, entered_at=None), BARS)
    assert d["verdict"] == "quiet" and d["entries"] == 0 and d["bars_missing"] == {} and d["names"] == ["SPY"]
    assert d["names_source"] == "focus" and d["bars_expected"] == 135


def test_a_day_with_bars_that_have_no_line_has_gaps():
    gone = set(BARS[30:40])
    d = scorecard.day_health(journal()[:2], decisions([b for b in BARS if b not in gone], None), BARS)
    assert d["verdict"] == "gaps" and d["bars_missing"] == {"SPY": 10} and d["first_missing"]["SPY"] == BARS[30:35]


def test_a_name_on_the_list_with_no_line_at_all_is_a_gap():
    j = [{"event": "names", "source": "fallback", "names": ["QQQ", "SPY"]}]
    d = scorecard.day_health(j, decisions(BARS, None), BARS)
    assert d["verdict"] == "gaps" and d["bars_missing"] == {"QQQ": 135} and d["names_source"] == "fallback"


def test_a_day_with_no_names_and_no_lines_is_not_quiet():
    assert scorecard.day_health([], [], BARS)["verdict"] == "gaps"


def test_the_day_counts_refusals_revisions_retries_and_log_faults():
    dec = decisions(BARS, None)
    dec[5]["signals"] = [{"reason": "trend"}, {"reason": "trend"}, {"already": True, "reason": "x"}]
    dec[6]["signals"] = [{"log_fault": "KeyError"}]
    j = journal()[:2] + [{"event": "bar_revised"}, {"event": "feed_unfit", "why": "q"}]
    d = scorecard.day_health(j, dec, BARS)
    assert d["refused_for"] == {"trend": 2} and d["log_fault"] == 1
    assert (d["bar_revised"], d["feed_unfit"]) == (1, 1)


def test_a_filled_plan_whose_entered_line_was_lost_still_makes_the_day_traded():
    dec = decisions(BARS, None)                          # a restart wrote the bar again as already-acted
    got = scorecard.scorecard(DAY, journal(), dec, [plan()], BARS, 25)
    assert got["day"]["verdict"] == "traded" and got["day"]["entries"] == 1


def test_a_market_holiday_is_no_session_not_gaps():
    got = scorecard.scorecard("2026-11-26", [], [], [], BARS, 25, market_open=False)
    assert got["day"]["verdict"] == "no-session" and got["day"]["bars_missing"] == {}


def test_odd_plan_files_and_bar_times_do_not_raise():
    got = scorecard.scorecard(DAY, journal(), decisions(BARS), [[1, 2], plan(signal_bar="25:70")], BARS, 25)
    (t,) = got["trades"]
    assert t["signal_to_fill_min"] is None and "signal_to_fill_min" in t["missing"]


def test_entered_decisions_make_the_day_traded():
    assert scorecard.day_health(journal(), decisions(BARS), BARS)["verdict"] == "traded"


# ---------------------------------------------------------------- the nightly review
def review_script():
    spec = importlib.util.spec_from_file_location("ocr", ROOT / "scripts" / "options_clone_review.py")
    r = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(r)
    return r


def test_the_nightly_review_writes_the_quality_block(tmp_path, capsys):
    r = review_script()
    ts = f"{DAY}T15:30:00+00:00"
    j = tmp_path / "j.jsonl"
    j.write_text("".join(json.dumps({"ts": ts, **x}) + "\n" for x in journal()))
    (tmp_path / "decisions").mkdir()
    (tmp_path / "decisions" / f"{DAY}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in decisions(BARS)))
    (tmp_path / "plans").mkdir()
    (tmp_path / "plans" / f"plan_{DAY}-O-1.json").write_text(json.dumps(plan()))
    (tmp_path / "plans" / "plan_broken.json").write_text("{")                     # one bad file never stops it
    doc = r.build(DAY, j, tmp_path)
    assert doc["quality"]["day"]["verdict"] == "traded"
    (t,) = doc["quality"]["trades"]
    assert t["r"] == 2.0 and t["feed"] == "opra" and t["delta"] == 0.41 and t["missing"] == []
    assert doc["quality"]["day"]["bars_missing"] == {} and doc["quality"]["day"]["names_source"] == "focus"


def test_the_runner_logs_the_entry_bid_and_the_feed_it_uses(world):  # noqa: F811
    w = world
    w["m"].feed = "opra"                                     # the feed the runner was handed, not the config's
    r = w["make"]()
    w["m"].now = S.at("09:25")
    assert r.arm()
    S.run_until(r, w["m"], w["b"], S.at("10:27"))
    (armed,) = [x for x in w["rows"] if x["event"] == "armed"]
    (sent,) = [x for x in w["rows"] if x["event"] == "entry_sent"]
    assert armed["feed"] == "opra"
    assert sent["quoted_bid"] is not None and sent["quoted_bid"] <= sent["quoted_ask"]


def test_the_nightly_review_on_a_holiday_says_no_session(tmp_path):
    r = review_script()
    doc = r.build("2026-11-26", tmp_path / "none.jsonl", tmp_path)                  # Thanksgiving
    assert doc["quality"]["day"]["verdict"] == "no-session"


def test_a_scorecard_fault_never_costs_the_review_its_figures(tmp_path):
    r = review_script()
    doc = r.build(DAY, tmp_path / "none.jsonl", tmp_path, cfg={"day": {}})          # a config the clock cannot read
    assert doc["quality"]["error"] == "KeyError" and "setups" in doc and "names" in doc


def test_a_real_runner_day_scores_complete(world, tmp_path):  # noqa: F811
    """The session tests' scripted day, end to end: the runner's own journal, decision file and plan file."""
    w = world
    r = w["make"]()
    w["m"].now = S.at("09:25")
    assert r.arm()
    S.run_until(r, w["m"], w["b"], S.at("15:25"))
    day = S.DAY.isoformat()
    lines = [json.loads(x) for x in (w["tmp"] / "options" / "decisions" / f"{day}.jsonl").read_text().splitlines()]
    plans = [json.loads(f.read_text()) for f in sorted((w["tmp"] / "options" / "plans").glob("plan_*.json"))]
    ck = session.clock(day, S.CFG["day"])
    bars = scorecard.expected_bars(ck.first_entry, ck.last_entry, 2)
    got = scorecard.scorecard(day, w["rows"], lines, plans, bars, float(S.CFG["exits"]["premium_stop_pct"]))
    assert got["day"]["verdict"] == "traded" and got["day"]["bars_missing"] == {}
    (t,) = got["trades"]
    assert t["missing"] == [] and t["bar_final"] is True and t["delta"] is not None and t["r"] is not None
