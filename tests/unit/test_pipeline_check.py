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

    def fetch(symbols, target):
        calls.append(target)
        return DAILY if len(calls) >= 2 else stale
    first = pc.MarketData(stale, EXP, {})
    got = pc.wait_for_the_days_bar(list(DAILY), TARGET, first, options(), sleep=naps.append, fetch=fetch)
    assert got.daily is DAILY and calls == [TARGET, TARGET] and naps == [pc.TAPE_WAIT_S] * 2
    assert got.expiries is EXP and got.unreachable == ()
    # a tape that is already complete is not fetched again
    calls.clear(); naps.clear()
    done = pc.MarketData(DAILY, EXP, {})
    assert pc.wait_for_the_days_bar(list(DAILY), TARGET, done, options(), sleep=naps.append, fetch=fetch) is done
    assert calls == [] and naps == []
    # a re-fetch with no usable answer stops the wait: the session's bar is unverified
    calls.clear(); naps.clear()
    got = pc.wait_for_the_days_bar(list(DAILY), TARGET, first, options(), sleep=naps.append,
                                   fetch=lambda *a: None)
    assert got.daily is stale and got.unreachable == (pc.BARS,) and naps == [pc.TAPE_WAIT_S]


def test_a_tape_that_ends_early_says_so_in_the_detail():
    prev = lv.prev_session(TARGET)
    stale = {s: [b for b in rows if str(b.get("t", ""))[:10] < prev] for s, rows in DAILY.items()}
    got = run(daily=stale)
    tape = got["options.tape.SPY"]
    assert not tape.ok and tape.severity == "warn" and "the day's bar is not published yet" in tape.detail
    assert f"through {prev}" in tape.detail


# ---------------------------------------------------------------- market data that cannot be fetched
class Resp:
    def __init__(self, status: int, body: object, headers: dict | None = None) -> None:
        self.status_code, self.body, self.headers = status, body, headers or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise pc.requests.HTTPError(f"{self.status_code}", response=self)

    def json(self) -> object:
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


def market(url: str, params: dict) -> Resp:
    """The three Alpaca endpoints the job reads, answered from the fixtures."""
    if url.endswith("/v2/stocks/bars"):
        syms = params["symbols"].split(",")
        return Resp(200, {"bars": {s: DAILY[s] for s in syms if s in DAILY}, "next_page_token": None})
    if url.endswith("/v2/options/contracts"):
        return Resp(200, {"option_contracts": [{"expiration_date": d} for d in EXP.get(params["underlying_symbols"], [])]})
    if url.endswith("/v2/stocks/snapshots"):
        return Resp(200, {"SPY": {"latestTrade": {"p": 580.1}}})
    raise AssertionError(url)


class Get:
    """A fake requests.get: the first `failures` calls fail with `error` (an exception, or an HTTP status)."""

    def __init__(self, failures: int = 0, error: object = None) -> None:
        self.failures, self.error, self.calls = failures, error, []

    def __call__(self, url: str, params: dict, **kw: object) -> Resp:
        self.calls.append(url)
        if len(self.calls) <= self.failures:
            if isinstance(self.error, int):
                return Resp(self.error, {})
            raise self.error                                                    # type: ignore[misc]
        return market(url, params)


class FakeAlerts:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str, int]] = []
        self.days: list[str | None] = []

    def once_per_day(self, key: str, title: str, message: str, priority: int = 3, day: str | None = None) -> bool:
        self.sent.append((key, title, message, priority))
        self.days.append(day)
        return True


MACRO_HEADER = "date,time_et,type,severity,policy,source,quality\n"
EARNINGS_HEADER = "# a comment line, as in the real file\nsymbol,date,when,source,quality\n"


def macro_csv(last: dict[str, str] | None = None) -> str:
    """A macro calendar whose every recurring type ends on 2027-06-01, or on the date `last` gives it."""
    last = last or {}
    return MACRO_HEADER + "".join(f"{last.get(t, '2027-06-01')},08:30,{t},high,reduce,a named source,exact\n"
                                  for t in pc.ev.RECURRING_TYPES)


def earnings_csv(latest: dict[str, str] | None = None, names: list[str] | None = None) -> str:
    """An earnings file with one row per desk single name on 2026-10-01, or on the date `latest` gives it."""
    latest = latest or {}
    return EARNINGS_HEADER + "".join(f"{n},{latest.get(n, '2026-10-01')},amc,company press release,confirmed\n"
                                     for n in (names or pc.ev.desk_single_names()))


def calendars(tmp_path, macro: str | None = None, earnings: str | None = None) -> dict:
    (tmp_path / "macro.csv").write_text(macro_csv() if macro is None else macro)
    (tmp_path / "earnings.csv").write_text(earnings_csv() if earnings is None else earnings)
    return {"macro_path": tmp_path / "macro.csv", "earnings_path": tmp_path / "earnings.csv"}


def go(tmp_path, get, slot="pre-open", now=NOW_PRE, read=None, alerts=None, **cal):
    import json
    alerts, naps = alerts or FakeAlerts(), []
    editions = {"radar": radar(), "options": options()}
    code = pc.run(slot, now, get=get, sleep=naps.append, read=read or editions.get, alerts=alerts,
                  out=tmp_path / "out", **calendars(tmp_path, **cal))
    target = pc.target_session(slot, now)
    report = json.loads((tmp_path / "out" / f"{target}-{slot}.json").read_text())
    return code, report, alerts, naps


def test_market_data_unreachable_fails_the_run_and_pages_once(tmp_path):
    code, report, alerts, naps = go(tmp_path, Get(failures=99, error=pc.requests.ConnectionError("down")))
    by = {c["id"]: c for c in report["checks"]}
    assert code == 0                                              # a failed check is not a crash
    assert not by["data.reachable"]["ok"] and by["data.reachable"]["severity"] == "fail"
    assert report["fails"] >= 1 and report["unreachable"] == [pc.BARS, pc.LISTINGS, pc.SNAPSHOT]
    for dep in ("options.tape.SPY", "options.tape.AMZN", "focus.tradeable", "radar.close.SPY"):
        assert by[dep]["severity"] == "warn" and by[dep]["detail"].startswith("not verified"), dep
    assert by["data.snapshot"]["severity"] == "warn"
    assert len(alerts.sent) == 1
    key, title, message, prio = alerts.sent[0]
    assert key == "pipeline-check:pre-open" and prio == 4 and "data.reachable: 1 failed" in message
    assert "SPY" not in title + message and "AMZN" not in title + message
    # bars: one call and its retry; listings: two names in a row, each retried once, then no more; no snapshot
    assert naps == [pc.RETRY_WAIT_S] * 3


def test_a_transient_blip_is_retried_once_and_does_not_page(tmp_path):
    get = Get(failures=1, error=pc.requests.ConnectionError("blip"))
    code, report, alerts, naps = go(tmp_path, get)
    by = {c["id"]: c for c in report["checks"]}
    assert code == 0 and by["data.reachable"]["ok"] and report["fails"] == 0 and report["unreachable"] == []
    assert alerts.sent == [] and naps == [pc.RETRY_WAIT_S]
    assert get.calls[0] == get.calls[1]                           # the same call, tried again


def test_a_server_error_is_retried_and_a_refusal_is_not(tmp_path):
    _, report, alerts, naps = go(tmp_path, Get(failures=1, error=503))
    assert report["fails"] == 0 and alerts.sent == [] and naps == [pc.RETRY_WAIT_S]
    get = Get(failures=99, error=401)                             # bad keys do not mend in three seconds
    _, report, alerts, naps = go(tmp_path, get)
    assert report["unreachable"][:2] == [pc.BARS, pc.LISTINGS] and len(alerts.sent) == 1 and naps == []
    assert len(get.calls) == 1 + 3                                # bars once; each of the three names once, no retry


def test_listings_unreachable_alone_still_fails_and_its_dependents_are_not_verified():
    got = run(expiries={}, unreachable=(pc.LISTINGS,))
    assert not got["data.reachable"].ok and got["data.reachable"].severity == "fail"
    assert "option listings" in got["data.reachable"].detail and "daily bars" not in got["data.reachable"].detail
    assert got["focus.tradeable"].severity == "warn" and got["focus.tradeable"].detail.startswith("not verified")
    assert got["options.levels.SPY"].ok                           # the bars answered: still checked


def test_reachable_data_that_says_little_is_judged_by_the_checks_not_as_unreachable():
    prev = lv.prev_session(TARGET)
    stale = {s: [b for b in rows if str(b.get("t", ""))[:10] < prev] for s, rows in DAILY.items()}
    got = run(daily=stale)
    assert got["data.reachable"].ok and got["options.tape.SPY"].severity == "warn"
    assert "not verified" not in got["options.tape.SPY"].detail


def test_after_close_a_lost_refetch_marks_the_bars_unreachable(tmp_path):
    now = dt.datetime(2026, 10, 19, 22, 30, tzinfo=dt.UTC)
    prev = lv.prev_session(TARGET)

    class Lagging(Get):
        def __call__(self, url, params, **kw):
            self.calls.append(url)
            if url.endswith("/v2/stocks/bars"):
                if sum(u.endswith("/v2/stocks/bars") for u in self.calls) > 1:
                    raise pc.requests.ConnectionError("down")
                return Resp(200, {"bars": {s: [b for b in DAILY[s] if b["t"][:10] < prev] for s in DAILY}})
            return market(url, params)
    _, report, alerts, naps = go(tmp_path, Lagging(), slot="after-close", now=now)
    assert pc.BARS in report["unreachable"] and len(alerts.sent) == 1
    assert naps == [pc.TAPE_WAIT_S, pc.RETRY_WAIT_S]


# ---------------------------------------------------------------- the page carries counts and families only
def _emitted_ids() -> list[str]:
    """Every check id (or id prefix) the module can emit, read from its source."""
    import re
    from pathlib import Path
    src = Path(pc.__file__).read_text()
    return sorted({m.rstrip(".") for m in re.findall(r'\badd\(f?"([a-z_.]+)', src)})


def _desk_names() -> list[str]:
    from pathlib import Path

    import yaml
    cfg = yaml.safe_load((Path(__file__).resolve().parents[2] / "config" / "options_desk.yaml").read_text())
    return [str(n) for n in cfg["names"]]


def test_every_check_id_belongs_to_a_named_family():
    ids = _emitted_ids()
    assert {pc.family(i) for i in ids} == set(pc.FAMILIES)       # nothing falls to "other", nothing listed unused
    assert pc.family("options.close.SPY") == "options.close" and pc.family("nonsense.x") == "other"


def test_the_page_never_carries_a_symbol_a_price_or_error_text():
    import random
    import re
    from collections import Counter
    names = _desk_names()
    assert len(names) >= 10
    kinds = list(pc.ev.RECURRING_TYPES) + ["fomc_emergency"]
    per_symbol = {"options.tape", "options.close", "options.levels", "options.listing", "focus.earnings",
                  "radar.close", "radar.premarket", "calendar.earnings"}
    ids = _emitted_ids()
    assert {"calendar.macro", "calendar.macro.rows", "calendar.earnings", "calendar.earnings.rows"} <= set(ids)
    every: list[pc.Check] = []
    for prefix in ids:
        fam = pc.family(prefix)
        suffixes = [""] + ((names if fam in per_symbol else kinds if fam == "calendar.macro" else [])
                           if prefix == fam else [])
        for suffix in suffixes:
            cid = f"{prefix}.{suffix}" if suffix else prefix
            sym = suffix or names[0]
            every.append(pc.Check(cid, "fail", False,
                                  f"{sym} edition 571.23 vs tape 571.20; PDH $572.10; ConnectionError: Max retries "
                                  f"exceeded with url /v2/stocks/bars?symbols={sym}; {sym}: latest row 2026-08-27, "
                                  f"86 days before the session; cpi: last row 2026-12-10; line 7: unreadable date"))
    assert {pc.family(c.id) for c in every} == set(pc.FAMILIES)
    noise = [pc.Check("options.close.SPY", "warn", False, "SPY 1.5"), pc.Check("options.levels.QQQ", "info", True, "ok")]
    fam_re = "|".join(re.escape(f) for f in (*pc.FAMILIES, "other"))
    body = re.compile(rf"^Session (\d{{4}}-\d{{2}}-\d{{2}}), (pre-open|after-close)\. "
                      rf"((?:(?:{fam_re}): \d+ failed)(?:; (?:{fam_re}): \d+ failed)*)\. The run's report has the detail\.$")
    rng = random.Random(20261111)
    combos = [[c] for c in every] + [every] + [rng.sample(every, rng.randint(1, len(every))) for _ in range(300)]
    for slot in pc.SLOTS:
        for fails in combos:
            title, message = pc.alert_text(slot, TARGET, [*fails, *noise])
            assert title == f"Pipeline check {slot}: {len(fails)} failed"
            m = body.match(message)
            assert m, message
            assert m.group(1) == TARGET and m.group(2) == slot
            got = {part.split(": ")[0]: int(part.split(": ")[1].split()[0]) for part in m.group(3).split("; ")}
            assert got == dict(Counter(pc.family(c.id) for c in fails))
            text = title + " " + message
            assert not any(re.search(rf"\b{re.escape(n)}\b", text) for n in names)
            assert not any(re.search(rf"\b{re.escape(k)}\b", text) for k in kinds)   # event types: report only
            assert not re.search(r"\d+\.\d+|\$", text)
            assert not re.search(r"(?i)error|retries|url|vs|tape |PDH", text)


def test_the_page_does_not_echo_an_odd_slot_or_date():
    title, message = pc.alert_text("SPY 571.23", "AMZN", [pc.Check("options.close.SPY", "fail", False, "x")])
    assert "SPY" not in title + message and "AMZN" not in title + message
    assert "unknown slot" in title and "unknown date" in message


# ---------------------------------------------------------------- the pre-open refresh: a warning, whatever its shape
def test_the_premarket_refresh_never_crashes_and_only_warns():
    o = options()
    del o["focus"]["premarket"]
    shapes = [o]
    for pre in (None, {"as_of": "2026-10-19T12:50:00Z"}, {"passes": [{"as_of": "2026-10-20T12:56:00Z"}]},
                "2026-10-20T12:50:00Z", [1, 2], {"as_of": 123}, {"as_of": "soon"}):
        x = options()
        x["focus"]["premarket"] = pre
        shapes.append(x)
    for x in shapes:
        got = run(options=x)
        c = got["focus.premarket"]
        assert not c.ok and c.severity == "warn", x["focus"].get("premarket")
        assert "dashboard's own watcher" in c.detail
        assert [i for i, k in got.items() if not k.ok and k.severity == "fail"] == []
    unknown = run(options=shapes[3])["focus.premarket"]
    assert "not checked here" in unknown.detail and "shape" in unknown.detail
    assert "not checked here" in run(options=shapes[0])["focus.premarket"].detail
    fresh = run()["focus.premarket"]                               # the shape of today, for today
    assert fresh.ok and "as_of 2026-10-20T12:50:00Z" in fresh.detail


def test_an_odd_focus_block_does_not_crash_the_check():
    for focus in ("AMZN", [1], {"items": "AMZN"}, {"items": [1, None, {"symbol": 5}]}):
        o = options()
        o["focus"] = focus
        got = run(options=o)
        assert not got["focus.present"].ok and got["focus.premarket"].severity == "warn"


# ---------------------------------------------------------------- focus.tradeable: one name is a legitimate night
def test_focus_tradeable_warns_on_none_and_passes_on_one_or_more():
    o = options()                                                  # AMZN (within 7 days) and SPY (same day)
    assert run(options=o)["focus.tradeable"].ok
    o["focus"]["items"] = [{"symbol": "AMZN", "rank": 1}]
    one = run(options=o)["focus.tradeable"]
    assert one.ok and one.detail.startswith("1 of 1")
    none = run(options=o, expiries=dict(EXP, AMZN=[]))["focus.tradeable"]
    assert not none.ok and none.severity == "warn" and none.detail.startswith("0 of 1")
    assert pc.FOCUS_TRADEABLE_MIN == 1 and pc.MIN_NAMES == 2       # the clone's top-up target is untouched


# ---------------------------------------------------------------- a crash of the job is not a failed check
def test_a_crash_of_the_job_is_not_swallowed(tmp_path):
    import pytest

    def broken(kind):
        raise RuntimeError("the reader broke")
    with pytest.raises(RuntimeError):
        go(tmp_path, Get(), read=broken)
    # a missing calendar file is a failed check with a page, not a crash (calendar.earnings below)
    code = pc.run("pre-open", NOW_PRE, get=Get(), sleep=lambda s: None,
                  read={"radar": radar(), "options": options()}.get, alerts=FakeAlerts(), out=tmp_path / "out",
                  earnings_path=tmp_path / "missing.csv", macro_path=tmp_path / "missing-macro.csv")
    assert code == 0


def test_a_crash_exits_the_process_non_zero(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    code = ("from wt.options import pipeline_check as pc\n"
            "def boom(*a, **k):\n    raise RuntimeError('boom')\n"
            "pc.run = boom\nraise SystemExit(pc.main(['pre-open']))\n")
    env = {**os.environ, "PYTHONPATH": str(root / "src"), "WT_STATE": str(tmp_path)}
    r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "RuntimeError" in r.stderr


# ---------------------------------------------------------------- one name's listing is not the whole source
class OneBadListing(Get):
    """Every endpoint answers, except the option listing of `bad`, which answers with `resp`."""

    def __init__(self, bad: str, resp: Resp) -> None:
        super().__init__()
        self.bad, self.resp = bad, resp

    def __call__(self, url, params, **kw):
        self.calls.append(url)
        if url.endswith("/v2/options/contracts") and params["underlying_symbols"] == self.bad:
            return self.resp
        return market(url, params)


def test_one_names_listing_error_does_not_page_as_unreachable(tmp_path):
    import json
    bad_json = json.JSONDecodeError("no", "x", 0)
    for resp in (Resp(422, {}), Resp(200, {"option_contracts": [{"strike_price": "1"}]}),
                 Resp(200, pc.requests.JSONDecodeError(bad_json.msg, bad_json.doc, bad_json.pos))):
        code, report, alerts, naps = go(tmp_path, OneBadListing("QQQ", resp))
        by = {c["id"]: c for c in report["checks"]}
        assert by["data.reachable"]["ok"] and report["unreachable"] == [] and alerts.sent == [] and naps == []
        assert list(report["unlisted"]) == ["QQQ"]
        assert by["options.listing.QQQ"]["severity"] == "warn" and "not verified" in by["options.listing.QQQ"]["detail"]
        assert "options.listing.SPY" not in by and "options.listing.AMZN" not in by
        assert by["focus.tradeable"]["ok"] and by["options.close.SPY"]["ok"] and by["options.levels.AMZN"]["ok"]


def test_the_other_names_keep_their_severity_and_an_unlisted_name_may_still_fail():
    o = options()
    o["tickers"][1]["levels"][0]["price"] += 0.30                 # AMZN, a name the clone trades
    o["tickers"][0]["last"]["close"] += 0.10                      # SPY
    got = run(options=o, expiries={k: v for k, v in EXP.items() if k != "AMZN"} | {"AMZN": []},
              unlisted={"AMZN": "HTTPError 422"})
    assert got["options.close.SPY"].severity == "fail"
    assert got["options.levels.AMZN"].severity == "fail"          # unknown listing: judged as if it may be traded
    assert got["options.listing.AMZN"].severity == "warn" and "HTTPError 422" in got["options.listing.AMZN"].detail
    assert got["data.reachable"].ok and "1 not verified" in got["focus.tradeable"].detail


class Listings(Get):
    """The listings endpoint answers per name from `plan` (a status, an exception, or absent: the fixture)."""

    def __init__(self, plan: dict) -> None:
        super().__init__()
        self.plan, self.asked = plan, []

    def __call__(self, url, params, **kw):
        self.calls.append(url)
        if "contracts" in url:
            sym = params["underlying_symbols"]
            self.asked.append(sym)
            how = self.plan.get(sym)
            if isinstance(how, Exception):
                raise how
            if isinstance(how, int):
                return Resp(how, {})
        return market(url, params)


def test_every_name_failing_makes_the_listings_unreachable():
    exp, bad, cut = pc.fetch_listings(["SPY", "QQQ"], TARGET, Listings({"SPY": 422, "QQQ": 404}), lambda s: None)
    assert exp is None and bad == {} and not cut


def test_one_names_lasting_5xx_does_not_page():
    down = pc.requests.ConnectionError("down")
    get, naps = Listings({"QQQ": 503}), []
    exp, bad, cut = pc.fetch_listings(["AMZN", "QQQ", "SPY"], TARGET, get, naps.append)
    assert exp is not None and bad == {"QQQ": "HTTPError 503"} and exp["SPY"] == EXP["SPY"] and not cut
    assert get.asked == ["AMZN", "QQQ", "QQQ", "SPY"] and naps == [pc.RETRY_WAIT_S]
    md = pc.market_data(["AMZN", "QQQ", "SPY"], TARGET, "pre-open", Listings({"QQQ": down}), lambda s: None)
    assert md.unreachable == () and dict(md.unlisted) == {"QQQ": "ConnectionError"}


def test_two_names_in_a_row_failing_transiently_make_the_listings_unreachable():
    down = pc.requests.ConnectionError("down")
    get = Listings({"AMZN": down, "QQQ": 503})
    exp, bad, cut = pc.fetch_listings(["AMZN", "QQQ", "SPY"], TARGET, get, lambda s: None)
    assert exp is None and "SPY" not in get.asked                  # later names are not asked
    md = pc.market_data(["AMZN", "QQQ", "SPY"], TARGET, "pre-open", Listings({"AMZN": down, "QQQ": down}),
                        lambda s: None)
    assert md.unreachable == (pc.LISTINGS,) and md.expiries == {} and md.unlisted == ()


def test_a_failure_either_side_of_a_good_answer_is_not_unreachable():
    down = pc.requests.ConnectionError("down")
    exp, bad, _ = pc.fetch_listings(["AMZN", "QQQ", "SPY"], TARGET, Listings({"AMZN": down, "SPY": down}),
                                    lambda s: None)
    assert exp is not None and set(bad) == {"AMZN", "SPY"} and exp["QQQ"] == EXP["QQQ"]


def test_the_budget_running_out_keeps_the_listings_already_fetched():
    clock = FakeClock()

    class Slow(Listings):
        def __call__(self, url, params, **kw):
            clock.t += 100.0
            return super().__call__(url, params, **kw)
    budget = pc.Budget(150.0, clock)                              # one call's worst case fits; after it, not another
    exp, bad, cut = pc.fetch_listings(["AMZN", "QQQ", "SPY"], TARGET, Slow({}), clock.sleep, budget)
    assert cut and exp is not None and exp["AMZN"] == EXP["AMZN"] and bad == {"QQQ": "budget", "SPY": "budget"}
    got = run(expiries=exp, unlisted=bad, cut=(pc.LISTINGS,))
    assert got["data.reachable"].ok and "cut short by the run's time budget" in got["data.reachable"].detail
    assert got["options.listing.SPY"].severity == "warn" and "(budget)" in got["options.listing.SPY"].detail
    # nothing fetched before the budget ran out: unreachable
    exp, bad, cut = pc.fetch_listings(["AMZN"], TARGET, Slow({}), clock.sleep, pc.Budget(10.0, clock))
    assert exp is None and cut


def test_a_wait_cut_short_by_the_budget_says_so():
    prev = lv.prev_session(TARGET)
    stale = {s: [b for b in rows if str(b.get("t", ""))[:10] < prev] for s, rows in DAILY.items()}
    clock = FakeClock()
    md = pc.wait_for_the_days_bar(list(DAILY), TARGET, pc.MarketData(stale, EXP, {}), options(), clock.sleep,
                                  fetch=lambda *a: stale, budget=pc.Budget(100.0, clock))
    assert md.cut == (pc.TAPE_WAIT,) and clock.t == 0.0           # no round started
    now = dt.datetime(2026, 10, 19, 22, 30, tzinfo=dt.UTC)
    got = {c.id: c for c in pc.assess("after-close", now, radar(), options(), stale, EXP, {}, [], cut=md.cut)}
    assert "cut short by the time budget" in got["options.tape.SPY"].detail
    assert "cut short by the run's time budget" in got["data.reachable"].detail


# ---------------------------------------------------------------- bar pages are followed to the end
class Paged(Get):
    """The bars endpoint answers `per_page` bars a page, across the names in order, with a next_page_token until
    the end (or forever, with `endless`)."""

    def __init__(self, daily: dict, per_page: int, endless: bool = False) -> None:
        super().__init__()
        self.rows = [(s, b) for s in sorted(daily) for b in daily[s]]
        self.per_page, self.endless = per_page, endless

    def __call__(self, url, params, **kw):
        self.calls.append(url)
        assert url.endswith("/v2/stocks/bars")
        start = int(params.get("page_token") or 0)
        page = self.rows[start:start + self.per_page]
        out: dict = {}
        for s, b in page:
            out.setdefault(s, []).append(b)
        more = self.endless or start + self.per_page < len(self.rows)
        return Resp(200, {"bars": out, "next_page_token": str(start + self.per_page) if more else None})


def test_four_pages_for_more_than_a_hundred_names_are_all_read():
    many = {f"N{i:03d}": DAILY["SPY"] for i in range(110)}         # 110 x 80 bars
    get = Paged(many, 10000 // 4 + 1)                              # four pages
    got = pc.fetch_bars(sorted(many), TARGET, get, lambda s: None)
    assert got is not None and len(get.calls) == 4 and {k: len(v) for k, v in got.items()} == {k: 80 for k in many}


def test_short_pages_with_a_token_are_followed():
    get = Paged(DAILY, 25)                                         # far below the limit, yet more to come
    got = pc.fetch_bars(sorted(DAILY), TARGET, get, lambda s: None)
    assert got is not None and {k: len(v) for k, v in got.items()} == {k: len(v) for k, v in DAILY.items()}
    assert len(get.calls) == -(-sum(len(v) for v in DAILY.values()) // 25) > 1


def test_the_page_safety_cap_stops_an_endless_answer():
    get = Paged(DAILY, 1, endless=True)
    assert pc.fetch_bars(sorted(DAILY), TARGET, get, lambda s: None) is None
    assert len(get.calls) == pc.BAR_PAGES == 30


# ---------------------------------------------------------------- transient errors and Retry-After
def test_a_connection_dropped_mid_body_is_retried():
    for err in (pc.requests.exceptions.ChunkedEncodingError("cut"), pc.requests.exceptions.ContentDecodingError("gz")):
        naps = []
        assert pc.fetch_bars(["SPY"], TARGET, Get(failures=1, error=err), naps.append) is not None
        assert naps == [pc.RETRY_WAIT_S]


def test_a_429_honours_retry_after_capped():
    for header, want in (({"Retry-After": "7"}, 7.0), ({"Retry-After": "600"}, pc.RETRY_AFTER_MAX_S),
                         ({}, pc.RETRY_WAIT_S), ({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, pc.RETRY_WAIT_S),
                         ({"Retry-After": "\u00b2"}, pc.RETRY_WAIT_S), ({"Retry-After": "\u0663"}, pc.RETRY_WAIT_S)):
        class Busy(Get):
            def __call__(self, url, params, header=header, **kw):
                self.calls.append(url)
                return Resp(429, {}, header) if len(self.calls) == 1 else market(url, params)
        naps = []
        assert pc.fetch_bars(["SPY"], TARGET, Busy(), naps.append) is not None and naps == [want]


# ---------------------------------------------------------------- the run fits in the job's deadline
class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


def test_the_budget_fits_the_jobs_deadline_with_margin():
    from wt.ops.schedule import JOBS
    deadline = JOBS["pipeline-check"].deadline_min * 60
    assert pc.RUN_BUDGET_S <= deadline - 60                       # a minute for start-up and the checks themselves
    assert pc.EDITIONS_WORST_S + pc.CALL_WORST_S <= pc.RUN_BUDGET_S
    # with the reads and first fetch quick, as on a normal evening, both rounds of the after-close wait still fit
    assert 2 * (pc.TAPE_WAIT_S + pc.CALL_WORST_S) <= pc.RUN_BUDGET_S - 30


def test_edition_call_timeouts_match_the_bound():
    seen = []

    class S:
        def get(self, url, **kw):
            seen.append(kw["timeout"])
            raise pc.requests.ConnectionError("x")
    env = {"DASHBOARD_INGEST_URL": "https://example.test/api/ingest", "DASHBOARD_INGEST_SECRET": "s"}
    assert pc.read_edition("radar", env=env, session_=S(), now=lambda: 1.0) is None
    assert sum(seen[0]) == pc.EDITION_CALL_S


def test_the_worst_run_stays_inside_the_budget_for_each_slot(tmp_path):
    """Every call takes its full timeouts and then fails transiently, or crawls to a success; many names; the site
    down. No slot may run past RUN_BUDGET_S."""
    many = {f"N{i}": {"symbol": f"N{i}"} for i in range(60)}
    for slot, now in (("pre-open", NOW_PRE), ("after-close", dt.datetime(2026, 10, 19, 22, 30, tzinfo=dt.UTC))):
        for fail in (True, False):
            clock = FakeClock()

            def read(kind, clock=clock):
                clock.t += pc.EDITION_CALL_S
                return None if kind == "radar" else {**options(), "tickers": [*options()["tickers"], *many.values()]}

            class Slow(Get):
                def __call__(self, url, params, clock=clock, fail=fail, **kw):
                    self.calls.append(url)
                    clock.t += pc.CONNECT_S + pc.READ_S
                    if fail:
                        raise pc.requests.Timeout("slow")
                    if url.endswith("/v2/stocks/bars"):            # never the day's bar: the wait runs every round
                        return Resp(200, {"bars": {s: DAILY[s][:-1] for s in DAILY}})
                    return market(url, params) if "contracts" not in url or params["underlying_symbols"] in EXP \
                        else Resp(200, {"option_contracts": []})
            alerts = FakeAlerts()
            pc.run(slot, now, get=Slow(), sleep=clock.sleep, read=read, alerts=alerts, out=tmp_path / "out",
                   clock=clock, **calendars(tmp_path))
            assert clock.t <= pc.RUN_BUDGET_S, (slot, fail, clock.t)
            import json
            report = json.loads((tmp_path / "out" / f"{pc.target_session(slot, now)}-{slot}.json").read_text())
            by = {c["id"]: c for c in report["checks"]}
            if fail:                                               # every call times out: unreachable, and a page
                assert not by["data.reachable"]["ok"] and pc.BARS in report["unreachable"] and len(alerts.sent) == 1
            else:                                                  # slow but healthy: no page for the data
                assert by["data.reachable"]["ok"] and not {pc.BARS, pc.LISTINGS} & set(report["unreachable"])
                assert report["cut_short_by_budget"] and "cut short" in by["data.reachable"]["detail"]
                assert any(v == "budget" for v in report["unlisted"].values())
                assert all(by[f"options.listing.{s}"]["severity"] == "warn"
                           for s, v in report["unlisted"].items() if v == "budget")


# ---------------------------------------------------------------- the hand-kept event calendars
DAY = dt.date(2026, 11, 11)                                        # a Wednesday session
NAMES = ["AVGO", "AMD", "TSLA"]
CAL = pc.CALENDAR_ALERT_KEY


def ahead(days: int) -> str:
    return (DAY + dt.timedelta(days=days)).isoformat()


def judge(tmp_path, macro: str | None = None, earnings: str | None = None, names=NAMES,
          day: str = DAY.isoformat(), through: str = "2027-12-31") -> dict[str, pc.Check]:
    paths = calendars(tmp_path, macro=macro, earnings=earnings if earnings is not None else earnings_csv(
        {n: ahead(-19) for n in NAMES}, NAMES))
    m, e = pc.read_calendars(**paths)
    return {c.id: c for c in pc.assess_calendars(day, m, e, names, through)}


def failing(got: dict[str, pc.Check]) -> list[str]:
    return sorted(i for i, c in got.items() if not c.ok and c.severity == "fail")


def cal_sent(alerts: FakeAlerts) -> list[tuple[str, str, str, int]]:
    return [x for x in alerts.sent if x[0].startswith(CAL)]


def test_the_calendar_thresholds_are_named_and_ordered():
    assert (pc.MACRO_WARN_DAYS, pc.MACRO_FAIL_DAYS) == (45, 35)
    assert (pc.EARNINGS_WARN_DAYS, pc.EARNINGS_FAIL_DAYS) == (75, 85)
    assert (pc.SESSIONS_WARN_DAYS, pc.SESSIONS_FAIL_DAYS) == (90, 45)
    assert pc.EARNINGS_WARN_DAYS == pc.ev.EARNINGS_MAX_AGE_DAYS        # the CI warning's horizon
    # the page comes before the paper runner refuses to arm (coverage_ok: a row 30 days ahead)
    assert pc.MACRO_FAIL_DAYS > 30 and pc.MACRO_WARN_DAYS > pc.MACRO_FAIL_DAYS
    # a typo far ahead is malformed, and the bound sits well past the fail horizons
    assert (pc.ev.EARNINGS_MAX_AHEAD_DAYS, pc.ev.MACRO_MAX_AHEAD_DAYS) == (120, 3 * 365)


def test_the_index_names_are_the_clones():
    from pathlib import Path

    import yaml
    cfg = yaml.safe_load((Path(__file__).resolve().parents[2] / "config" / "options_clone.yaml").read_text())
    assert list(pc.INDEX_NAMES) == cfg["contract"]["index_names"]


def test_macro_all_covered_is_ok(tmp_path):
    got = judge(tmp_path, macro_csv({t: ahead(200) for t in pc.ev.RECURRING_TYPES}))
    macro = {i: c for i, c in got.items() if i.startswith("calendar.macro")}
    assert set(macro) == {f"calendar.macro.{t}" for t in pc.ev.RECURRING_TYPES}
    assert all(c.ok and c.severity == "info" for c in macro.values())
    assert "last row " + ahead(200) in got["calendar.macro.cpi"].detail


def test_macro_warns_inside_45_days_and_fails_inside_35_with_exact_boundaries(tmp_path):
    def cpi(days: int) -> pc.Check:
        return judge(tmp_path, macro_csv({"cpi": ahead(days)}))["calendar.macro.cpi"]
    assert cpi(45).ok                                               # exactly 45 days ahead: covered
    assert not cpi(44).ok and cpi(44).severity == "warn" and "44 days after" in cpi(44).detail
    assert cpi(35).severity == "warn"                               # exactly 35: still only a warning
    assert not cpi(34).ok and cpi(34).severity == "fail"
    assert cpi(-3).severity == "fail" and "-3 days after" in cpi(-3).detail      # already run out
    got = judge(tmp_path, macro_csv({"nfp": ahead(20)}))
    assert failing(got) == ["calendar.macro.nfp"] and got["calendar.macro.cpi"].ok


def test_a_macro_type_with_no_rows_fails(tmp_path):
    text = macro_csv().replace("2027-06-01,08:30,quad_witching,high,reduce,a named source,exact\n", "")
    assert "quad_witching" not in text
    got = judge(tmp_path, text)
    assert failing(got) == ["calendar.macro.quad_witching"]
    assert "no row" in got["calendar.macro.quad_witching"].detail


def test_the_one_off_macro_type_is_ignored(tmp_path):
    text = macro_csv() + f"{ahead(1)},10:00,fomc_emergency,high,skip,federalreserve.gov,exact\n"
    got = judge(tmp_path, text)
    assert failing(got) == [] and not any("fomc_emergency" in i for i in got)
    # and a later one-off row does not cover a recurring type that has run out
    text = macro_csv({"cpi": ahead(10)}) + f"{ahead(400)},10:00,fomc_emergency,high,skip,federalreserve.gov,exact\n"
    assert failing(judge(tmp_path, text)) == ["calendar.macro.cpi"]


def test_earnings_fresh_is_ok_and_a_future_row_is_fresh(tmp_path):
    got = judge(tmp_path, earnings=earnings_csv({"AVGO": ahead(28), "AMD": ahead(-8), "TSLA": ahead(-21)}, NAMES))
    assert all(got[f"calendar.earnings.{n}"].ok for n in NAMES)
    assert "28 days after" in got["calendar.earnings.AVGO"].detail and "8 days before" in got["calendar.earnings.AMD"].detail


def test_earnings_warns_past_75_days_and_fails_past_85_with_exact_boundaries(tmp_path):
    def amd(age: int) -> pc.Check:
        return judge(tmp_path, earnings=earnings_csv({"AMD": ahead(-age)}, NAMES))["calendar.earnings.AMD"]
    assert amd(75).ok
    assert not amd(76).ok and amd(76).severity == "warn" and "76 days before" in amd(76).detail
    assert amd(85).severity == "warn"
    assert not amd(86).ok and amd(86).severity == "fail"
    assert amd(200).severity == "fail"
    # the latest of a name's rows counts
    text = earnings_csv({n: ahead(-19) for n in NAMES}, NAMES) + f"AMD,{ahead(-200)},amc,old release,confirmed\n"
    assert judge(tmp_path, earnings=text)["calendar.earnings.AMD"].ok


def test_a_desk_name_with_no_earnings_row_fails(tmp_path):
    got = judge(tmp_path, earnings=earnings_csv({}, ["AVGO", "TSLA"]))
    assert failing(got) == ["calendar.earnings.AMD"] and "no row" in got["calendar.earnings.AMD"].detail


def test_an_index_name_is_never_required_an_earnings_row(tmp_path):
    assert pc.ev.single_names(["SPY", "QQQ", "AVGO"], ["SPY", "QQQ"]) == ["AVGO"]
    desk = pc.desk_names()
    assert desk is not None and "SPY" not in desk and "QQQ" not in desk and "AVGO" in desk
    got = judge(tmp_path, earnings=earnings_csv({}, desk), names=desk)       # no row for SPY or QQQ
    assert failing(got) == [] and "calendar.earnings.SPY" not in got and "calendar.earnings.QQQ" not in got


def test_the_desk_names_that_cannot_be_read_fail_rather_than_pass(tmp_path):
    got = judge(tmp_path, names=None)
    assert failing(got) == ["calendar.earnings"] and "cannot be read" in got["calendar.earnings"].detail


def test_an_unreadable_or_odd_calendar_file_fails_with_its_reason(tmp_path):
    m, e = pc.read_calendars(tmp_path / "nope.csv", tmp_path / "nope2.csv")
    got = {c.id: c for c in pc.assess_calendars(DAY.isoformat(), m, e, NAMES)}
    assert failing(got) == ["calendar.earnings", "calendar.macro"]
    assert "config/events/macro_events.csv cannot be read (FileNotFoundError)" in got["calendar.macro"].detail
    (tmp_path / "dir.csv").mkdir()
    (tmp_path / "latin.csv").write_bytes(b"date,type\n\xff\xfe\n")
    (tmp_path / "header.csv").write_text("day,kind\n2027-01-01,cpi\n")
    for path, why in ((tmp_path / "dir.csv", "cannot be read"), (tmp_path / "latin.csv", "UnicodeDecodeError"),
                      (tmp_path / "header.csv", "has no column date")):
        cal = pc.read_calendar(path, "x.csv", pc.ev.MACRO_COLUMNS, comments=False)
        assert cal.error and why in cal.error and cal.rows == (), path
        got = {c.id: c for c in pc.assess_calendars(DAY.isoformat(), cal, cal, NAMES)}
        assert failing(got) == ["calendar.earnings", "calendar.macro"]


NO_DATE = "date not exactly YYYY-MM-DD"


def test_a_malformed_row_fails_and_is_named_by_line(tmp_path):
    text = macro_csv() + "2027-13-01,08:30,cpi,high,reduce,bls.gov,exact\n# a comment is not a macro row\n"
    got = judge(tmp_path, text)
    rows = got["calendar.macro.rows"]
    assert not rows.ok and rows.severity == "fail"
    assert "2 malformed rows" in rows.detail and f"line 7: {NO_DATE}" in rows.detail and "line 8" in rows.detail
    assert got["calendar.macro.cpi"].ok                            # the good rows are still judged
    text = earnings_csv({n: ahead(-19) for n in ("AMD", "TSLA")}, ["AMD", "TSLA"]) + \
        f"AVGO,{ahead(28)},pm,company press release,confirmed\n"
    got = judge(tmp_path, earnings=text)
    assert failing(got) == ["calendar.earnings.AVGO", "calendar.earnings.rows"]
    assert "line 5: unknown when" in got["calendar.earnings.rows"].detail    # two comment/header lines, then rows
    assert "no row" in got["calendar.earnings.AVGO"].detail        # its only row does not count


def test_a_date_the_clone_would_not_match_is_malformed_and_never_counts_as_fresh(tmp_path):
    """The clone compares raw strings (session.event_block): a padded or basic-form date never matches there."""
    stale = earnings_csv({"NVDA": ahead(-100)}, ["NVDA"])          # NVDA's only well-formed row: stale
    for bad in (f" {ahead(10)}", f"{ahead(10)} ", ahead(10).replace("-", "")):
        got = judge(tmp_path, earnings=stale + f"NVDA,{bad},amc,company press release,confirmed\n", names=["NVDA"])
        assert failing(got) == ["calendar.earnings.NVDA", "calendar.earnings.rows"], bad
        assert NO_DATE in got["calendar.earnings.rows"].detail
    for bad in (" NVDA", "nvda"):
        got = judge(tmp_path, earnings=stale + f"{bad},{ahead(10)},amc,company press release,confirmed\n",
                    names=["NVDA"])
        assert failing(got) == ["calendar.earnings.NVDA", "calendar.earnings.rows"], bad
    for bad in (f" {ahead(200)}", ahead(200).replace("-", "")):                  # the same for a macro date
        got = judge(tmp_path, macro_csv({"cpi": ahead(10)}) + f"{bad},08:30,cpi,high,reduce,bls.gov,exact\n")
        assert failing(got) == ["calendar.macro.cpi", "calendar.macro.rows"], bad
        assert NO_DATE in got["calendar.macro.rows"].detail


def test_a_date_far_ahead_is_a_typo_and_does_not_hide_a_stale_name(tmp_path):
    base = earnings_csv({"NVDA": ahead(-100)}, ["NVDA"])
    edge = judge(tmp_path, earnings=base + f"NVDA,{ahead(120)},amc,company press release,confirmed\n", names=["NVDA"])
    assert failing(edge) == []                                    # exactly 120 days ahead: a real row
    got = judge(tmp_path, earnings=base + f"NVDA,{ahead(121)},amc,company press release,confirmed\n", names=["NVDA"])
    assert failing(got) == ["calendar.earnings.NVDA", "calendar.earnings.rows"]
    assert "date more than 120 days ahead" in got["calendar.earnings.rows"].detail
    years = pc.ev.MACRO_MAX_AHEAD_DAYS
    edge = judge(tmp_path, macro_csv({"cpi": ahead(10)}) + f"{ahead(years)},08:30,cpi,high,reduce,bls.gov,exact\n")
    assert failing(edge) == []
    got = judge(tmp_path, macro_csv({"cpi": ahead(10)}) + f"{ahead(years + 1)},08:30,cpi,high,reduce,bls.gov,exact\n")
    assert failing(got) == ["calendar.macro.cpi", "calendar.macro.rows"]


def test_every_row_the_check_calls_well_formed_is_one_the_clone_matches_on_its_date():
    """For the repository's real CSVs: a row the check counts is a row the clone's event_block acts on."""
    from pathlib import Path

    import yaml
    from wt.options import session
    cfg = yaml.safe_load((Path(__file__).resolve().parents[2] / "config" / "options_clone.yaml").read_text())
    gates, index = cfg["gates"], cfg["contract"]["index_names"]
    m, e = pc.read_calendars()
    good_e = [r for _, r in e.rows if pc.ev.earnings_row_problem(r, DAY) is None]
    assert good_e and len(good_e) == len(e.rows)
    for r in good_e:
        if r["symbol"] in index:
            continue
        on = dt.datetime.combine(dt.date.fromisoformat(r["date"]), dt.time(10, 0), pc.NEW_YORK)
        assert session.event_block(on, r["symbol"], [], [r], gates, index) == "earnings", r
    good_m = [r for _, r in m.rows if pc.ev.macro_row_problem(r, DAY) is None]
    assert good_m and len(good_m) == len(m.rows)
    for r in good_m:
        h, mi = (int(x) for x in r["time_et"].split(":"))
        on = dt.datetime.combine(dt.date.fromisoformat(r["date"]), dt.time(h, mi), pc.NEW_YORK)
        got = session.event_block(on, "SPY", [r], [], gates, index)
        if r["policy"] in ("skip", "blackout_window"):
            assert got is not None and got.endswith(r["type"]), r
        assert str(r["date"]) == on.date().isoformat()            # the comparison event_block makes


def test_the_exchange_calendar_end_warns_at_90_days_and_fails_at_45(tmp_path):
    def sessions(through: str) -> pc.Check:
        return judge(tmp_path, macro_csv(), through=through)["calendar.sessions"]
    assert sessions(ahead(90)).ok
    assert sessions(ahead(89)).severity == "warn" and "89 days after" in sessions(ahead(89)).detail
    assert sessions(ahead(45)).severity == "warn"
    assert sessions(ahead(44)).severity == "fail"
    m, e = pc.read_calendars()
    real = {c.id: c for c in pc.assess_calendars(DAY.isoformat(), m, e, NAMES)}["calendar.sessions"]
    assert real.ok and pc.lv.CALENDAR_THROUGH in real.detail


def test_the_repositorys_calendars_today_are_ok():
    m, e = pc.read_calendars()
    got = pc.assess_calendars("2026-11-11", m, e, pc.desk_names())
    assert got and [c for c in got if not c.ok] == []
    assert {c.id for c in got} >= {f"calendar.macro.{t}" for t in pc.ev.RECURRING_TYPES} | {"calendar.sessions"}


def test_the_calendar_key_names_the_failing_families_only_and_sets_the_priority():
    def f(cid: str, sev: str = "fail") -> pc.Check:
        return pc.Check(cid, sev, False, "AVGO cpi 2026-01-01")
    assert pc.calendar_alert([f("calendar.macro.cpi", "warn"), f("options.close.SPY")]) is None
    assert pc.calendar_alert([f("calendar.macro.cpi"), f("calendar.macro.nfp")]) == (f"{CAL}:macro", 3)
    assert pc.calendar_alert([f("calendar.earnings.AVGO"), f("calendar.macro.rows")]) == (f"{CAL}:earnings+macro", 3)
    assert pc.calendar_alert([f("calendar.earnings"), f("calendar.macro.cpi")]) == (f"{CAL}:earnings-file+macro", 4)
    assert pc.calendar_alert([f("calendar.macro")]) == (f"{CAL}:macro-file", 4)
    assert pc.calendar_alert([f("calendar.sessions")]) == (f"{CAL}:sessions", 3)
    key, _ = pc.calendar_alert([f(f"calendar.earnings.{n}") for n in _desk_names()]
                               + [f(f"calendar.macro.{t}") for t in pc.ev.RECURRING_TYPES])
    assert not any(n in key for n in _desk_names()) and not any(t in key for t in pc.ev.RECURRING_TYPES)


def test_the_calendars_run_and_page_when_market_data_is_unreachable(tmp_path):
    stale = macro_csv({"cpi": "2026-11-01"})                       # before the session: run out
    code, report, alerts, _ = go(tmp_path, Get(failures=99, error=pc.requests.ConnectionError("down")), macro=stale,
                                 earnings=earnings_csv({"AVGO": "2026-01-02"}))
    by = {c["id"]: c for c in report["checks"]}
    assert code == 0 and not by["data.reachable"]["ok"]
    assert by["calendar.macro.cpi"]["severity"] == "fail" and by["calendar.earnings.AVGO"]["severity"] == "fail"
    assert "cpi: last row 2026-11-01" in by["calendar.macro.cpi"]["detail"]          # the detail is in the report
    keys = [k for k, *_ in alerts.sent]
    assert keys == [f"{CAL}:earnings+macro", "pipeline-check:pre-open"]              # the calendars first
    (_, cal_title, cal_msg, prio), (_, _, slot_msg, _) = alerts.sent
    assert "calendar" not in slot_msg and "data.reachable: 1 failed" in slot_msg
    assert cal_msg == "Session 2026-10-20, pre-open. calendar.macro: 1 failed; calendar.earnings: 1 failed. " \
                      "The run's report has the detail."
    assert prio == 3 and alerts.days == ["2026-10-20", None]
    assert "AVGO" not in cal_title + cal_msg and "cpi" not in cal_title + cal_msg


def test_a_stale_calendar_does_not_trip_data_reachable_or_the_slots_page(tmp_path):
    _, report, alerts, _ = go(tmp_path, Get(), macro=macro_csv({"nfp": "2026-11-20"}))
    by = {c["id"]: c for c in report["checks"]}
    assert by["data.reachable"]["ok"] and report["fails"] == 1 and by["calendar.macro.nfp"]["severity"] == "fail"
    assert [k for k, *_ in alerts.sent] == [f"{CAL}:macro"]


def test_the_calendars_need_no_time_from_the_budget(tmp_path):
    ticks = iter([0.0])

    def spent() -> float:                                          # the budget is gone after its first reading
        return next(ticks, 1e9)
    alerts = FakeAlerts()
    pc.run("pre-open", NOW_PRE, get=Get(), sleep=lambda s: None, read={"radar": radar(), "options": options()}.get,
           alerts=alerts, out=tmp_path / "out", clock=spent,
           **calendars(tmp_path, macro=macro_csv({"cpi": "2026-11-01"})))
    import json
    report = json.loads((tmp_path / "out" / f"{TARGET}-pre-open.json").read_text())
    by = {c["id"]: c for c in report["checks"]}
    assert by["calendar.macro.cpi"]["severity"] == "fail" and [k for k, *_ in cal_sent(alerts)] == [f"{CAL}:macro"]


def test_the_calendar_page_is_sent_before_the_rest_of_the_run_can_fail(tmp_path):
    import pytest
    alerts = FakeAlerts()

    def broken(kind):
        assert [k for k, *_ in alerts.sent] == [f"{CAL}:macro"]  # already sent when the editions are read
        raise RuntimeError("the reader broke")
    with pytest.raises(RuntimeError):
        go(tmp_path, Get(), read=broken, alerts=alerts, macro=macro_csv({"cpi": "2026-11-01"}))
    assert [k for k, *_ in alerts.sent] == [f"{CAL}:macro"]


def test_a_missing_calendar_file_pages_at_priority_4_and_running_short_at_3(tmp_path):
    alerts = FakeAlerts()
    code = pc.run("pre-open", NOW_PRE, get=Get(), sleep=lambda s: None,
                  read={"radar": radar(), "options": options()}.get, alerts=alerts, out=tmp_path / "out",
                  earnings_path=tmp_path / "missing.csv", macro_path=calendars(tmp_path)["macro_path"])
    assert code == 0                                              # a failed check, not a crash (the runbook's rule)
    assert cal_sent(alerts) == [(f"{CAL}:earnings-file", "Pipeline check pre-open: 1 failed",
                                 "Session 2026-10-20, pre-open. calendar.earnings: 1 failed. "
                                 "The run's report has the detail.", 4)]
    _, _, alerts, _ = go(tmp_path, Get(), earnings=earnings_csv({"AVGO": "2026-01-02"}))
    assert [(k, p) for k, _, _, p in cal_sent(alerts)] == [(f"{CAL}:earnings", 3)]


class Recording:
    """The real Alerts' once-per-day state under a fixed clock; nothing is sent."""

    def __init__(self, root, monkeypatch, at: dt.datetime) -> None:
        from wt.ops import alerts as alerts_mod
        monkeypatch.setattr(alerts_mod, "_now", lambda: at)       # its state is pruned against its own clock
        outer = self

        class _A(alerts_mod.Alerts):
            def notify(self, title, message, priority=3, tags=()):
                if "calendar." in message:                     # the slot's own page (the fixtures are a
                    outer.got.append((title, message))         # morning's editions) is another key
                return True
        self.alerts = _A(root=root, topic="")
        self.got: list[tuple[str, str]] = []


EVENING = dt.datetime(2026, 10, 20, 22, 30, tzinfo=dt.UTC)          # 18:30 New York, the same day as NOW_PRE


def test_an_unchanged_stale_calendar_pages_once_a_new_york_day_across_both_slots(tmp_path, monkeypatch):
    rec = Recording(tmp_path / "alerts", monkeypatch, NOW_PRE)
    stale = {"macro": macro_csv({"cpi": "2026-11-01"})}
    next_morning = dt.datetime(2026, 10, 21, 12, 55, tzinfo=dt.UTC)
    for slot, now in (("pre-open", NOW_PRE), ("after-close", EVENING)):
        (tmp_path / slot).mkdir()
        go(tmp_path / slot, Get(), slot=slot, now=now, alerts=rec.alerts, **stale)
    assert len(rec.got) == 1 and "calendar.macro: 1 failed" in rec.got[0][1]
    (tmp_path / "next").mkdir()
    go(tmp_path / "next", Get(), now=next_morning, alerts=rec.alerts, **stale)
    assert len(rec.got) == 2                                       # a new New York day: one more
    state = (tmp_path / "alerts" / "state.json").read_text()
    assert f"{CAL}:macro:2026-10-20" in state and f"{CAL}:macro:2026-10-21" in state


def test_a_family_that_starts_failing_in_the_evening_pages_that_evening(tmp_path, monkeypatch):
    rec = Recording(tmp_path / "alerts", monkeypatch, NOW_PRE)
    macro = macro_csv({"cpi": "2026-11-01"})
    (tmp_path / "am").mkdir()
    go(tmp_path / "am", Get(), now=NOW_PRE, alerts=rec.alerts, macro=macro)
    (tmp_path / "pm").mkdir()
    go(tmp_path / "pm", Get(), slot="after-close", now=EVENING, alerts=rec.alerts, macro=macro,
       earnings=earnings_csv({"AVGO": "2026-01-02"}))
    assert [m for _, m in rec.got] == [
        "Session 2026-10-20, pre-open. calendar.macro: 1 failed. The run's report has the detail.",
        "Session 2026-10-21, after-close. calendar.macro: 1 failed; calendar.earnings: 1 failed. "
        "The run's report has the detail."]
    (tmp_path / "pm2").mkdir()                                     # the same set again that day: no third page
    go(tmp_path / "pm2", Get(), slot="after-close", now=EVENING, alerts=rec.alerts, macro=macro,
       earnings=earnings_csv({"AVGO": "2026-01-02"}))
    assert len(rec.got) == 2


def test_an_unreadable_calendar_pages_counts_only_and_keeps_the_detail_in_the_report(tmp_path):
    bad = earnings_csv() + "AVGO,2027-02-30,amc,company press release,confirmed\n"
    _, report, alerts, _ = go(tmp_path, Get(), macro="date,type\n", earnings=bad)
    by = {c["id"]: c for c in report["checks"]}
    assert "has no column time_et" in by["calendar.macro"]["detail"]
    assert NO_DATE in by["calendar.earnings.rows"]["detail"]
    [(key, title, message, prio)] = alerts.sent
    assert key == f"{CAL}:earnings+macro-file" and prio == 4
    assert message == "Session 2026-10-20, pre-open. calendar.macro: 1 failed; calendar.earnings: 1 failed. " \
                      "The run's report has the detail."
    assert not any(n in title + message + key for n in _desk_names())


def test_focus_earnings_reads_the_rows_exactly_as_the_clone_does(tmp_path):
    # A row the check calls malformed (`AMC`) still blocks the clone that day: focus.earnings still says so, while
    # calendar.earnings.rows fails on it.
    from wt.options import session
    row = {"symbol": "AMZN", "date": PREV, "when": "AMC", "source": "company press release", "quality": "confirmed"}
    during = dt.datetime.combine(dt.date.fromisoformat(TARGET), dt.time(10, 0), pc.NEW_YORK)
    assert session.event_block(during, "AMZN", [], [row], {}, pc.INDEX_NAMES) is None     # amc is case-sensitive
    row_today = {**row, "date": TARGET}
    assert session.event_block(during, "AMZN", [], [row_today], {}, pc.INDEX_NAMES) == "earnings"
    _, report, _, _ = go(tmp_path, Get(), earnings=earnings_csv() + f"AMZN,{TARGET},AMC,company press release,confirmed\n")
    by = {c["id"]: c for c in report["checks"]}
    assert "calendar.earnings.rows" in by and by["focus.earnings.AMZN"]["severity"] == "warn"
    assert "the clone skips it" in by["focus.earnings.AMZN"]["detail"]
    # and a row the clone does not match leaves focus.earnings silent, as the clone trades it
    _, report, _, _ = go(tmp_path, Get(), earnings=earnings_csv() + f"AMZN, {TARGET},amc,company press release,confirmed\n")
    ids = {c["id"] for c in report["checks"]}
    assert "calendar.earnings.rows" in ids and "focus.earnings.AMZN" not in ids



# ---------------------------------------------------------------- a market-data request refused for naming no feed
def test_a_refused_request_is_unusable_market_data_it_fails_the_check_pages_and_exits_0(tmp_path, monkeypatch, capsys):
    """_alpaca_get calls require_feed before anything is sent. Here it refuses every request (a future bug in it):
    FeedNotNamed is a ValueError, one of _UNUSABLE, so the run takes the path of any answer that will not mend (a 401):
    no retry, the sources unreachable, `data.reachable` failed, the same one page, exit 0 (the module's rule: a failed
    check exits 0, only a crash of the job exits non-zero)."""
    for d in ("rejected", "refused"):
        (tmp_path / d).mkdir()
    rejected_get = Get(failures=99, error=401)
    _, rejected, rejected_alerts, _ = go(tmp_path / "rejected", rejected_get)
    assert len(rejected_get.calls) == 1 + 3 and "named no feed" not in capsys.readouterr().err

    def refuse(url, params):
        raise pc.FeedNotNamed("no feed")
    monkeypatch.setattr(pc, "require_feed", refuse)
    get = Get()
    code, report, alerts, naps = go(tmp_path / "refused", get)
    by = {c["id"]: c for c in report["checks"]}
    assert code == 0 and naps == [] and get.calls == []                          # nothing sent, nothing retried
    assert not by["data.reachable"]["ok"] and by["data.reachable"]["severity"] == "fail"
    assert report["unreachable"] == [pc.BARS, pc.LISTINGS, pc.SNAPSHOT] and report["unlisted"] == {}
    (key, title, message, prio), = alerts.sent
    assert key == "pipeline-check:pre-open" and prio == 4 and "data.reachable: 1 failed" in message
    assert [(c["id"], c["ok"], c["severity"]) for c in report["checks"]] == \
        [(c["id"], c["ok"], c["severity"]) for c in rejected["checks"]]
    assert alerts.sent == rejected_alerts.sent
    err = capsys.readouterr().err
    assert "pipeline check: a market-data request named no feed" in err
    assert f"market data unavailable ({pc.BARS}): FeedNotNamed" in err


class BarsRejected(Get):
    """The bars answer 401; the listings and the snapshot are answered."""

    def __call__(self, url: str, params: dict, **kw: object) -> Resp:
        self.calls.append(url)
        return Resp(401, {}) if url.endswith("/v2/stocks/bars") else market(url, params)


def test_a_refused_data_request_with_the_listings_answered_judges_and_pages_as_a_401_on_the_bars(
        tmp_path, monkeypatch, capsys):
    """The realistic case: the guard can only refuse a data-host request, never the paper host's listings. The bars
    are unreachable, the listings fine, `data.reachable` fails, the snapshot (same host as the bars) is skipped,
    exit 0, the same checks and page as a 401 on the bars alone."""
    for d in ("rejected", "refused"):
        (tmp_path / d).mkdir()
    rejected_get = BarsRejected()
    _, rejected, rejected_alerts, _ = go(tmp_path / "rejected", rejected_get)
    assert rejected["unreachable"] == [pc.BARS, pc.SNAPSHOT]
    capsys.readouterr()
    real = pc.require_feed

    def refuse_data(url, params):
        real(url, params)
        if str(url).startswith(pc.DATA):
            raise pc.FeedNotNamed("no feed")
    monkeypatch.setattr(pc, "require_feed", refuse_data)
    get = Get()
    code, report, alerts, naps = go(tmp_path / "refused", get)
    by = {c["id"]: c for c in report["checks"]}
    assert code == 0 and naps == []
    assert get.calls and all(u.startswith(pc.PAPER) for u in get.calls)          # only the listings went out
    assert get.calls == [u for u in rejected_get.calls if u.startswith(pc.PAPER)]
    assert report["unreachable"] == [pc.BARS, pc.SNAPSHOT] and report["unlisted"] == {}
    assert not by["data.reachable"]["ok"] and by["data.reachable"]["severity"] == "fail"
    assert [(c["id"], c["ok"], c["severity"]) for c in report["checks"]] == \
        [(c["id"], c["ok"], c["severity"]) for c in rejected["checks"]]
    (key, _, message, prio), = alerts.sent
    assert alerts.sent == rejected_alerts.sent and key == "pipeline-check:pre-open" and prio == 4
    assert "data.reachable: 1 failed" in message
    assert "pipeline check: a market-data request named no feed" in capsys.readouterr().err
