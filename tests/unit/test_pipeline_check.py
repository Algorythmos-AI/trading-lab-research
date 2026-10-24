"""The pipeline check: the radar, the options edition and its focus names, each claim checked against the tape."""
from __future__ import annotations

import copy
import datetime as dt

from wt.options import levels as lv
from wt.options import pipeline_check as pc
from wt.options.intraday import daily_raw

NOW_PRE = dt.datetime(2026, 10, 20, 12, 55, tzinfo=dt.UTC)          # 08:55 New York, Tue 20 Oct
TARGET, PREV = "2026-10-20", "2026-10-19"


def bars(base: float) -> list[dict]:
    days, d = [], PREV
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    return [{"t": f"{x}T04:00:00Z", "o": base + i * 0.1, "h": base + 1 + i * 0.1, "l": base - 1 + i * 0.1,
             "c": base + 0.5 + i * 0.1, "v": 1e6} for i, x in enumerate(days)]


DAILY = {"SPY": bars(570), "AMZN": bars(250), "QQQ": bars(500)}


def ticker(sym: str) -> dict:
    loaded = lv.load_ibkr(daily_raw(DAILY[sym]))
    got = lv.levels_for(loaded.bars, TARGET)
    return {"symbol": sym, "last": {"close": loaded.bars[-1].c},
            "levels": [{"name": x.name, "price": round(x.price, 4)} for x in got["levels"]]}


def options() -> dict:
    return {"session": TARGET, "built_from": PREV, "tickers": [ticker("SPY"), ticker("AMZN")],
            "focus": {"picked_at": "2026-10-19T21:55:00Z", "premarket": {"as_of": "2026-10-20T12:50:00Z"},
                      "items": [{"symbol": "AMZN", "rank": 1}, {"symbol": "SPY", "rank": 2}]}}


def radar() -> dict:
    spy = lv.load_ibkr(daily_raw(DAILY["SPY"])).bars[-1].c
    return {"edition_date": TARGET, "as_of": "2026-10-20T10:51:00Z",
            "tickers": [{"symbol": "SPY", "price": round(spy, 2), "premarket_price": 580.0}]}


EXP = {"SPY": [TARGET, "2026-10-21"], "AMZN": ["2026-10-21", "2026-10-23"], "QQQ": [TARGET]}


def run(**kw) -> dict[str, pc.Check]:
    args = {"radar": radar(), "options": options(), "daily": DAILY, "expiries": EXP, "live": {"SPY": 580.1},
            "earnings": []} | kw
    return {c.id: c for c in pc.assess("pre-open", NOW_PRE, **args)}


def test_a_consistent_morning_passes_every_failing_check():
    got = run()
    assert [c.id for c in got.values() if not c.ok and c.severity == "fail"] == []
    assert got["options.levels.SPY"].ok and got["options.close.AMZN"].ok and got["radar.close.SPY"].ok
    assert got["focus.tradeable"].ok and "within 7 days" in got["focus.tradeable"].detail   # AMZN: Wednesday's (DEC-0034)


def test_a_wrong_level_a_wrong_close_and_a_stale_edition_fail():
    o = options()
    o["tickers"][0]["levels"][0]["price"] += 0.30
    o["tickers"][1]["last"]["close"] += 0.10
    o["session"] = "2026-10-19"
    got = run(options=o)
    assert not got["options.levels.SPY"].ok and "PDH" in got["options.levels.SPY"].detail
    assert not got["options.close.AMZN"].ok and not got["options.session"].ok


def test_the_radar_is_checked_for_its_date_age_close_and_overnight_move():
    r = radar()
    r["edition_date"], r["as_of"] = "2026-10-19", "2026-10-19T10:51:00Z"
    got = run(radar=r)
    assert not got["radar.date"].ok and not got["radar.fresh"].ok
    r = radar()
    r["tickers"][0]["price"] += 0.25
    got = run(radar=r, live={"SPY": 585.0})
    assert not got["radar.close.SPY"].ok and got["radar.close.SPY"].severity == "fail"
    assert not got["radar.premarket.SPY"].ok and got["radar.premarket.SPY"].severity == "warn"


def test_focus_refresh_earnings_and_missing_editions():
    o = options()
    o["focus"]["premarket"] = None
    got = run(options=o, earnings=[{"symbol": "AMZN", "date": PREV, "when": "amc"}])
    assert not got["focus.premarket"].ok and not got["focus.earnings.AMZN"].ok
    got = run(options=None, radar=None)
    assert not got["options.present"].ok and not got["radar.present"].ok


def test_after_close_checks_the_next_session_and_not_the_radar():
    now = dt.datetime(2026, 10, 19, 22, 30, tzinfo=dt.UTC)                  # 18:30 New York, Mon 19 Oct
    assert pc.target_session("after-close", now) == TARGET and pc.target_session("pre-open", NOW_PRE) == TARGET
    got = {c.id for c in pc.assess("after-close", now, radar(), options(), DAILY, EXP, {}, [])}
    assert not any(i.startswith("radar.") for i in got) and "focus.premarket" not in got


def test_the_signature_matches_the_site():
    assert pc.edition_signature("edition-test-secret", "radar", 1760284800) == "sha256=ddff8b93300e0eb8db538fcbd86c4bc20037231a912b632f3063006d5be516bc"   # pinned in edition-route.test.ts
    assert pc.edition_signature("s", "radar", 1) != pc.edition_signature("s", "options", 1)
    assert copy.deepcopy(radar()) == radar()


def test_a_difference_outside_todays_names_warns_and_a_stale_radar_skips_its_closes():
    o = options()
    o["tickers"].append(ticker("QQQ"))
    o["tickers"][2]["symbol"] = "QQQ"
    o["focus"]["items"] = [{"symbol": "SPY", "rank": 1}]
    o["tickers"][1]["levels"][0]["price"] += 0.30               # AMZN, not a name the clone may trade today
    got = run(options=o)
    assert not got["options.levels.AMZN"].ok and got["options.levels.AMZN"].severity == "warn"
    r = radar()
    r["edition_date"] = "2026-10-19"
    r["tickers"][0]["price"] += 5
    got = run(radar=r)
    assert not got["radar.date"].ok and "radar.close.SPY" not in got


def test_only_names_the_clone_can_trade_today_can_fail():
    o = options()                                                 # focus AMZN (no same-day expiry) and SPY
    assert pc.eligible(o, TARGET, EXP, policy="same_day") == {"SPY", "QQQ"}   # DEC-0032: AMZN dropped, QQQ added
    assert pc.eligible(o, TARGET, EXP) == {"AMZN", "SPY"}         # DEC-0034: AMZN trades its nearest expiry
    o["tickers"][1]["levels"][0]["price"] += 0.30                 # AMZN, a name the clone trades today
    got = run(options=o)
    assert not got["options.levels.AMZN"].ok and got["options.levels.AMZN"].severity == "fail"
    none = dict(EXP, AMZN=[])
    assert pc.eligible(o, TARGET, none) == {"SPY", "QQQ"}         # no expiry within the window: dropped, topped up
    got = run(options=o, expiries=none)
    assert not got["options.levels.AMZN"].ok and got["options.levels.AMZN"].severity == "warn"


def test_the_check_tops_up_exactly_as_the_clone_does():
    from pathlib import Path

    import yaml
    cfg = yaml.safe_load((Path(__file__).resolve().parents[2] / "config" / "options_clone.yaml").read_text())["names"]
    assert list(pc.TOP_UP) == cfg["top_up"] == cfg["fallback"] and pc.MIN_NAMES == cfg["min_names"]
    assert pc.MAX_NAMES == cfg["max_names"]
    assert pc.EXPIRY == cfg["expiry"] and pc.WITHIN_DAYS == cfg["nearest_within_days"]


def test_eligibility_ranks_dedupes_and_caps_like_the_runner():
    o = options()
    o["focus"]["items"] = [{"symbol": "spy", "rank": 1}, {"symbol": "SPY", "rank": 2}]       # one name, twice
    assert pc.eligible(o, TARGET, EXP) == {"SPY", "QQQ"}                                     # still tops up QQQ
    many = [{"symbol": s, "rank": i + 1} for i, s in enumerate(("A", "B", "C", "D", "E", "F", "AMZN"))]
    o["focus"]["items"] = many
    exp = dict(EXP, AMZN=[TARGET])
    assert "AMZN" not in pc.eligible(o, TARGET, exp)                                         # seventh: beyond the cap


def test_after_the_close_the_check_waits_for_the_days_bar_before_judging_the_tape():
    """The consolidated daily bar can lag the 18:30 check; a tradeable name's tape is re-fetched a few times."""
    prev = lv.prev_session(TARGET)
    stale = {s: [b for b in rows if str(b.get("t", ""))[:10] < prev] for s, rows in DAILY.items()}
    calls, naps = [], []

    def fetch(symbols, target, slot):
        calls.append(slot)
        return (DAILY if len(calls) >= 2 else stale), EXP, {}
    got = pc.wait_for_the_days_bar(list(DAILY), TARGET, stale, EXP, options(), sleep=naps.append, fetch=fetch)
    assert got is DAILY and calls == ["after-close", "after-close"] and naps == [pc.TAPE_WAIT_S] * 2
    # a tape that is already complete is not fetched again
    calls.clear(); naps.clear()
    assert pc.wait_for_the_days_bar(list(DAILY), TARGET, DAILY, EXP, options(), sleep=naps.append, fetch=fetch) is DAILY
    assert calls == [] and naps == []


def test_a_tape_that_ends_early_says_so_in_the_detail():
    prev = lv.prev_session(TARGET)
    stale = {s: [b for b in rows if str(b.get("t", ""))[:10] < prev] for s, rows in DAILY.items()}
    got = run(daily=stale)
    tape = got["options.tape.SPY"]
    assert not tape.ok and tape.severity == "warn" and "the day's bar is not published yet" in tape.detail
    assert f"through {prev}" in tape.detail
