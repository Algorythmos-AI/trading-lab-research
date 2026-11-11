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

    def once_per_day(self, key: str, title: str, message: str, priority: int = 3) -> bool:
        self.sent.append((key, title, message, priority))
        return True


def go(tmp_path, get, slot="pre-open", now=NOW_PRE, read=None):
    import json
    earnings = tmp_path / "earnings.csv"
    earnings.write_text("symbol,date,when\n")
    alerts, naps = FakeAlerts(), []
    editions = {"radar": radar(), "options": options()}
    code = pc.run(slot, now, get=get, sleep=naps.append, read=read or editions.get, alerts=alerts,
                  out=tmp_path / "out", earnings_path=earnings)
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
    by_family = {pc.family(i): i for i in _emitted_ids()}
    every: list[pc.Check] = []
    for fam, prefix in by_family.items():
        for sym in names:
            cid = f"{prefix}.{sym}" if prefix.count(".") == 1 and fam in {
                "options.tape", "options.close", "options.levels", "focus.earnings", "radar.close",
                "radar.premarket"} else prefix
            every.append(pc.Check(cid, "fail", False,
                                  f"{sym} edition 571.23 vs tape 571.20; PDH $572.10; ConnectionError: Max retries "
                                  f"exceeded with url /v2/stocks/bars?symbols={sym}"))
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
    with pytest.raises(FileNotFoundError):
        pc.run("pre-open", NOW_PRE, get=Get(), sleep=lambda s: None, read={"radar": radar(), "options": options()}.get,
               alerts=FakeAlerts(), out=tmp_path / "out", earnings_path=tmp_path / "missing.csv")


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
            earnings = tmp_path / "earnings.csv"
            earnings.write_text("symbol,date,when\n")
            alerts = FakeAlerts()
            pc.run(slot, now, get=Slow(), sleep=clock.sleep, read=read, alerts=alerts, out=tmp_path / "out",
                   earnings_path=earnings, clock=clock)
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
