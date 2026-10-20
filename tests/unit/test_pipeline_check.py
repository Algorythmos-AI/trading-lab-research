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
    assert not got["focus.tradeable"].ok and got["focus.tradeable"].severity == "warn"     # only SPY expires today


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
