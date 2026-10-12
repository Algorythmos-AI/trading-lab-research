"""The options live document (wt.options.live): read only, paper only, and nothing about the account but its
open option contracts."""
from __future__ import annotations

import argparse
import datetime as dt
import inspect
import json

import pytest
import requests

from wt.ops import publish, units
from wt.ops.schedule import JOBS
from wt.options import live

NOW = dt.datetime(2026, 10, 12, 16, 0, tzinfo=dt.UTC)
CLOCK = {"timestamp": "2026-10-12T12:00:00-04:00", "is_open": True, "next_open": "2026-10-13T09:30:00-04:00",
         "next_close": "2026-10-12T16:00:00-04:00"}


def option(symbol="SPY261023C00780000", qty="2", **over):
    return {"asset_class": "us_option", "symbol": symbol, "qty": qty, "side": "long", "avg_entry_price": "2.85",
            "current_price": "3.1", "market_value": "620", "unrealized_pl": "50", "asset_id": "x", "cost_basis": "570",
            **over}


class Reply:
    def __init__(self, status=200, body=None, text=None):
        self.status_code, self._body, self._text = status, body, text

    def json(self):
        if self._text is not None:
            raise ValueError("not json")
        return self._body


class Session:
    """Stands in for requests.Session: it answers GETs and has nothing else to call."""

    def __init__(self, *replies):
        self.replies, self.calls, self.params = list(replies), [], []

    def get(self, url, params=None, headers=None, timeout=None, allow_redirects=True):
        assert allow_redirects is False
        self.calls.append(url)
        self.params.append(params)
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def contract(strike="780", kind="call", oi="1825", expiry="2026-10-16", **over):
    occ = f"SPY{expiry[2:4]}{expiry[5:7]}{expiry[8:]}{kind[0].upper()}{int(float(strike) * 1000):08d}"
    return {"symbol": occ, "expiration_date": expiry, "strike_price": strike, "type": kind, "open_interest": oi,
            "open_interest_date": "2026-10-09", "size": "100", "style": "american", "id": "x", **over}


class Account:
    """Open interest is unavailable unless a test gives it closes and contracts."""

    def __init__(self, positions=None, clock=CLOCK, closes=None, contracts=None):
        self._p, self._c, self._closes, self._contracts, self.asked = positions, clock, closes, contracts, []

    def closes(self, symbols):
        if self._closes is None:
            raise live.BrokerFault("not-in-this-test")
        return self._closes

    def bars(self, symbols, timeframe, start, end):
        self.bar_calls = [*getattr(self, "bar_calls", []), (timeframe, start, end)]
        got = getattr(self, "_bars", None)
        if got is None:
            raise live.BrokerFault("no-bars-in-this-test")
        return got[timeframe]

    def contracts(self, symbol, lo, hi, first, last):
        self.asked.append((symbol, round(lo, 2), round(hi, 2), first, last))
        if isinstance(self._contracts, Exception):
            raise self._contracts
        return self._contracts or []

    def positions(self):
        if isinstance(self._p, Exception):
            raise self._p
        return self._p

    def clock(self):
        if isinstance(self._c, Exception):
            raise self._c
        return self._c


@pytest.fixture(autouse=True)
def _state(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "OUT", tmp_path / "options-live")
    monkeypatch.setattr(live.time, "sleep", lambda s: None)
    monkeypatch.setattr(publish, "read_health", lambda *a: (None, "not asked in this test"))
    for name in (live.KEY_ID_VAR, live.SECRET_VAR, "DASHBOARD_INGEST_URL", "DASHBOARD_INGEST_SECRET", "WT_ROLE",
                 "DASHBOARD_KEY_ID"):
        monkeypatch.delenv(name, raising=False)


def test_the_module_can_only_read_and_only_from_the_paper_host():
    src = inspect.getsource(live)
    assert live.PAPER_HOST == "https://paper-api.alpaca.markets"
    for word in (".post(", ".put(", ".patch(", ".delete(", "/v2/orders", "/v2/account", "TradingClient", "alpaca.markets"):
        assert word not in src.replace(live.PAPER_HOST, "").replace(live.DATA_HOST, ""), word
    assert "APCA_API_KEY_ID" not in src                    # never strategy B's account
    assert [n for n in vars(live.OptionsAccount) if not n.startswith("_")] == ["positions", "clock", "closes", "bars", "contracts"]
    assert live.DATA_HOST == "https://data.alpaca.markets"
    s = Session(Reply(200, []), Reply(200, CLOCK))
    acct = live.OptionsAccount("k", "s", s)
    acct.positions(), acct.clock()
    assert s.calls == [live.PAPER_HOST + "/v2/positions", live.PAPER_HOST + "/v2/clock"]


def test_rows_carry_the_contract_and_its_numbers_and_nothing_else():
    rows, left_out = live.position_rows([
        option(),
        option("NVDA261023P00230000", "-1", side="short", market_value="-290", unrealized_pl="-50"),
        option("IWM261023C00250000", "1", avg_entry_price=None, current_price="nan"),
        option("QQQ261023C00500000", "3", side="short"),                          # short, quantity sent unsigned
    ])
    assert left_out == []
    assert rows == [
        {"contract": "IWM261023C00250000", "qty": 1, "market_value": 620.0, "unrealized_pl": 50.0},
        {"contract": "NVDA261023P00230000", "qty": -1, "avg_price": 2.85, "price": 3.1, "market_value": -290.0,
         "unrealized_pl": -50.0},
        {"contract": "QQQ261023C00500000", "qty": -3, "avg_price": 2.85, "price": 3.1, "market_value": 620.0,
         "unrealized_pl": 50.0},
        {"contract": "SPY261023C00780000", "qty": 2, "avg_price": 2.85, "price": 3.1, "market_value": 620.0,
         "unrealized_pl": 50.0},
    ]


def test_what_is_not_a_standard_option_contract_is_counted_and_never_sent():
    rows, left_out = live.position_rows([
        {"asset_class": "us_equity", "symbol": "SPY", "qty": "100"},          # stock, after an exercise
        option("NVDA1261218C00120000"),                                         # adjusted: not 100 shares
        option("spy261023c00780000"),
        option(qty="1.5"), option(qty="0"), option(qty="x"), option(qty="10000"), "torn", None,
    ])
    assert rows == []
    assert left_out == ["not-an-option:1", "not-standard:2", "unreadable:6"]
    many, left_out = live.position_rows([option(f"SPY261023C{n:08d}") for n in range(1000, 121000, 1000)])
    assert len(many) == live.MAX_POSITIONS and left_out == ["over-the-limit:20"]


def test_the_document_passes_the_sites_contract_and_names_nothing_about_the_account():
    doc = live.build([option(), {"asset_class": "us_equity", "symbol": "SPY", "qty": "100"}], CLOCK, "r1", NOW)
    assert live.validate(doc) == []
    assert doc["paper"] is True and doc["as_of"] == "2026-10-12T16:00:00+00:00"
    assert doc["market"] == {"is_open": True, "next_open": CLOCK["next_open"], "next_close": CLOCK["next_close"]}
    assert doc["problems"] == ["not-an-option:1"] and doc["open_interest"] is None
    text = json.dumps(doc)
    for word in ("asset_id", "cost_basis", "account", "equity", "buying_power", "cash"):
        assert word not in text, word
    assert live.validate(live.build([], None, "r2", NOW)) == []               # nothing held, clock unreadable
    assert live.build([], None, "r2", NOW)["market"] is None
    odd = live.market({"is_open": "yes", "next_open": "<b>soon</b>", "next_close": CLOCK["next_close"]})
    assert odd == {"is_open": None, "next_open": None, "next_close": CLOCK["next_close"]}
    assert live.validate({**doc, "paper": False}) and live.validate({**doc, "equity": 1.0})


@pytest.mark.parametrize("replies,code", [
    ([Reply(401)], "keys-rejected"),
    ([Reply(403)], "keys-rejected"),
    ([Reply(404)], "http-404"),
    ([Reply(302)], "http-302"),
    ([Reply(503), Reply(503), Reply(503)], "http-503"),
    ([requests.ConnectTimeout(), requests.ConnectTimeout(), requests.ConnectTimeout()], "network-ConnectTimeout"),
    ([Reply(200, text="<html>")], "not-json"),
    ([Reply(200, {"message": "x"})], "positions-not-a-list"),
])
def test_a_broker_fault_is_a_fixed_code_never_the_response(replies, code):
    with pytest.raises(live.BrokerFault) as e:
        live.OptionsAccount("k", "s", Session(*replies)).positions()
    assert e.value.code == code


def test_a_transient_fault_is_retried():
    s = Session(Reply(503), requests.ConnectionError(), Reply(200, [option()]))
    assert len(live.OptionsAccount("k", "s", s).positions()) == 1 and len(s.calls) == 3


def args(**kw):
    return argparse.Namespace(dry_run=False, verify=False, **kw)


def test_without_the_accounts_keys_the_job_does_nothing(capsys):
    assert live._publish(args()) == 0
    assert "not configured" in capsys.readouterr().out
    assert not (live.OUT / "outbox").exists()


def test_an_unreadable_account_sends_nothing_and_fails_on_the_second_run_in_a_row(monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(publish, "send", lambda *a, **k: sent.append(a) or (True, "HTTP 200"))
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    broken = Account(live.BrokerFault("keys-rejected"))
    assert live._publish(args(), broken) == 0                # the first is noise
    assert live._publish(args(), broken) == 1                # the second alerts
    assert sent == [] and "keys-rejected" in capsys.readouterr().err
    assert live._publish(args(), Account([option()])) == 0   # and a good run clears the count
    assert len(sent) == 1
    assert live._publish(args(), broken) == 0


def test_a_run_sends_the_signed_document_and_logs_only_a_count(monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(publish, "send", lambda body, url, secret, bypass, **k: sent.append((body, url)) or (True, "HTTP 200"))
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    assert live._publish(args(), Account([option()], live.BrokerFault("http-503"))) == 0
    doc = json.loads(sent[0][0])
    assert live.validate(doc) == [] and doc["market"] is None
    assert doc["problems"] == ["clock-unavailable:http-503", "open-interest-unavailable:not-in-this-test"]
    assert json.loads((live.OUT / "outbox" / "document.json").read_text()) == doc
    out = capsys.readouterr().out
    assert "1 option positions" in out and "SPY" not in out and "market_value" not in out


def test_a_dry_run_and_a_host_with_no_ingest_settings_send_nothing(monkeypatch):
    monkeypatch.setattr(publish, "send", lambda *a, **k: pytest.fail("sent"))
    assert live._publish(argparse.Namespace(dry_run=True, verify=False), Account([option()])) == 0
    assert live._publish(args(), Account([option()])) == 0
    monkeypatch.setenv("WT_ROLE", "shadow")                  # a shadow host without its own key never sends
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    assert live._publish(args(), Account([option()])) == 2


def test_the_job_is_an_interval_job_that_never_gates_a_deploy_and_needs_no_preflight():
    j = JOBS["options-live"]
    assert j.command == ("-m", "wt.options.live") and j.mode == "backtest"
    assert not j.trading and not j.preflight and j.interval_s == 900 and j.desk == "stocks"
    assert live.PUBLISH_BUDGET_S < j.deadline_min * 60 < j.runtime_max_h * 3600
    t = units.timer(j)
    assert "OnCalendar=Mon..Fri 09..16:04/5:00 America/New_York" in t and "OnCalendar=*:04/15:00 UTC" in t
    assert "MemoryMax=512M" in units.service(j, __import__("pathlib").Path("/r")).splitlines()


def test_the_accounts_keys_are_scrubbed_and_prompted_hidden_and_optional():
    from wt.ops import safeio
    assert {live.KEY_ID_VAR, live.SECRET_VAR} <= set(safeio.SECRET_KEYS)
    text = (live.ROOT / "deploy/oci/bin/wt-set-secrets").read_text()
    assert f'"{live.KEY_ID_VAR}||1|0"' in text and f'"{live.SECRET_VAR}||1|0"' in text


def test_open_interest_rows_are_standard_contracts_with_a_figure_largest_first():
    rows, as_of = live.oi_rows([
        contract("780", "call", "1825"), contract("775", "put", "9000"), contract("785", "call", "0"),
        contract("790", "call", None), contract("790", "put", "12.5"), contract("795", "call", "-3"),
        contract("800", "call", "50", size="10"), contract("805", "call", "50", symbol="SPY1261016C00805000"),
        contract("810", "call", "50", type="straddle"), contract("0", "call", "50"), "torn",
    ])
    assert rows == [
        {"expiry": "2026-10-16", "strike": 775.0, "kind": "put", "oi": 9000},
        {"expiry": "2026-10-16", "strike": 780.0, "kind": "call", "oi": 1825},
        {"expiry": "2026-10-16", "strike": 785.0, "kind": "call", "oi": 0},
    ]
    assert as_of == "2026-10-09"
    many, _ = live.oi_rows([contract(str(700 + i), "call", str(i)) for i in range(300)])
    assert len(many) == live.OI_ROWS and many[0]["oi"] == 299
    assert live.oi_rows([]) == ([], None)


FAR = float("inf")


def test_open_interest_is_read_inside_a_strike_band_and_one_names_fault_costs_that_name_only(monkeypatch):
    acct = Account(closes={"SPY": 780.0, "QQQ": 500.0}, contracts=[contract()])
    got, missed = live.read_open_interest(acct, ["SPY", "NOCLOSE", "QQQ"], dt.date(2026, 10, 12), FAR)
    assert list(got) == ["SPY", "QQQ"] and missed == 1 and got["SPY"]["as_of"] == "2026-10-09"
    assert acct.asked[0] == ("SPY", 717.6, 842.4, dt.date(2026, 10, 12), dt.date(2026, 11, 16))
    assert live.validate(live.build([], CLOCK, "r", NOW, oi=list(got.values()))) == []

    class OneBad(Account):
        def contracts(self, symbol, *a):
            if symbol == "QQQ":
                raise live.BrokerFault("http-503")
            return [contract()]
    got, missed = live.read_open_interest(OneBad(closes={"SPY": 1.0, "QQQ": 1.0, "IWM": 1.0}), ["SPY", "QQQ", "IWM"],
                                          dt.date(2026, 10, 12), FAR)
    assert list(got) == ["SPY", "IWM"] and missed == 1
    # Out of time: it stops asking and hands back what it has.
    late = Account(closes={"SPY": 1.0, "QQQ": 1.0}, contracts=[contract()])
    assert live.read_open_interest(late, ["SPY", "QQQ"], dt.date(2026, 10, 12), 0.0) == ({}, 2) and late.asked == []


def test_open_interest_is_kept_between_runs_and_a_failed_read_never_stops_the_positions(tmp_path, monkeypatch):
    cache = tmp_path / "oi.json"
    monkeypatch.setattr(live, "desk_names", lambda: ["SPY", "QQQ"])
    good = Account(closes={"SPY": 780.0, "QQQ": 500.0}, contracts=[contract()])
    first, problems = live.open_interest(good, NOW, cache, FAR)
    assert problems == [] and [o["symbol"] for o in first] == ["SPY", "QQQ"]
    # Within six hours the kept reading is used and the broker is not asked again.
    again, problems = live.open_interest(Account(), NOW + dt.timedelta(hours=5), cache, FAR)
    assert again == first and problems == []
    # After that a failed read keeps the last reading and says so, and is not tried again for half an hour.
    stale, problems = live.open_interest(Account(), NOW + dt.timedelta(hours=7), cache, FAR)
    assert stale == first and problems == ["open-interest-unavailable:not-in-this-test"]
    quiet = Account(closes={"SPY": 780.0}, contracts=[contract()])
    assert live.open_interest(quiet, NOW + dt.timedelta(hours=7, minutes=10), cache, FAR) == (first, ["open-interest-stale"])
    assert quiet.asked == []
    # A partial read replaces the names it got and keeps the others' last figures; it is retried, not kept six hours.
    part = Account(closes={"SPY": 780.0}, contracts=[contract(oi="7")])
    mixed, problems = live.open_interest(part, NOW + dt.timedelta(hours=8), cache, FAR)
    assert problems == ["open-interest-partial:1"] and mixed[0]["rows"][0]["oi"] == 7 and mixed[1] == first[1]
    retry = Account(closes={"SPY": 780.0, "QQQ": 500.0}, contracts=[contract()])
    assert live.open_interest(retry, NOW + dt.timedelta(hours=9), cache, FAR)[1] == [] and len(retry.asked) == 2
    # After three days without a read the old figures are dropped.
    gone, problems = live.open_interest(Account(), NOW + dt.timedelta(hours=9 + 80), cache, FAR)
    assert gone is None and problems == ["open-interest-unavailable:not-in-this-test"]


@pytest.mark.parametrize("text", ["{torn", "[1, 2]", '"a string"', '{"read": 5, "open_interest": "x"}',
                                  '{"read": "2026-10-12T15:00:00+00:00", "open_interest": [{"symbol": "spy", "rows": []}]}'])
def test_a_bad_kept_reading_is_ignored_and_any_fault_while_reading_leaves_the_run_going(tmp_path, monkeypatch, text):
    cache = tmp_path / "oi.json"
    cache.write_text(text)
    monkeypatch.setattr(live, "desk_names", lambda: ["SPY"])
    assert live.open_interest(Account(closes=RuntimeError), NOW, cache, FAR)[0] is None
    cache.write_text(text)

    class Boom(Account):
        def closes(self, symbols):
            raise RuntimeError("boom")
    assert live.open_interest(Boom(), NOW, cache, FAR) == (None, ["open-interest-failed:RuntimeError"])
    cache.write_text(text)
    ok, problems = live.open_interest(Account(closes={"SPY": 780.0}, contracts=[contract()]), NOW, cache, FAR)
    assert problems == [] and ok[0]["symbol"] == "SPY"


def test_the_desks_names_are_well_formed_and_the_contract_request_stays_on_the_paper_host():
    names = live.desk_names()
    assert 1 <= len(names) <= live.OI_NAMES and len(set(names)) == len(names) and "SPY" in names
    s = Session(Reply(200, {"SPY": {"dailyBar": {"c": 780.0}}, "X": {"prevDailyBar": {"c": "12.5"}}, "Y": {}}),
                Reply(200, {"option_contracts": [contract()], "next_page_token": "t"}),
                Reply(200, {"option_contracts": [contract("781")], "next_page_token": None}))
    acct = live.OptionsAccount("k", "s", s)
    assert acct.closes(["SPY", "X", "Y"]) == {"SPY": 780.0, "X": 12.5}
    assert len(acct.contracts("SPY", 717.6, 842.4, dt.date(2026, 10, 12), dt.date(2026, 11, 16))) == 2
    assert s.calls == [live.DATA_HOST + "/v2/stocks/snapshots", live.PAPER_HOST + "/v2/options/contracts",
                       live.PAPER_HOST + "/v2/options/contracts"]
    assert s.params[1]["strike_price_gte"] == "717.60" and s.params[2]["page_token"] == "t"
    with pytest.raises(live.BrokerFault):
        live.OptionsAccount("k", "s", Session(Reply(200, []))).contracts("SPY", 1, 2, dt.date(2026, 10, 12), dt.date(2026, 10, 13))


# ---- where the rules stand during the session

from test_options_levels import sessions  # noqa: E402  (conftest puts tests/unit on the path)

from wt.options import intraday  # noqa: E402
from wt.options import levels as lv  # noqa: E402

SESSION = "2026-10-12"                    # a Monday; the flat history below ends on the Friday before


def daily(px=100.0, rng=1.0, end="2026-10-09", n=40):
    """Quiet identical days as the feed sends them: prior high 100.5, prior low 99.5, ATR 1."""
    return [{"t": f"{d}T04:00:00Z", "o": px, "h": px + rng / 2, "l": px - rng / 2, "c": px, "v": 1e6} for d in sessions(end, n)]


def half(hhmm, o, h, low, c, day=SESSION):
    at = dt.datetime.fromisoformat(f"{day}T{hhmm}").replace(tzinfo=intraday.NEW_YORK).astimezone(dt.UTC)
    return {"t": at.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": o, "h": h, "l": low, "c": c}


def ny(hhmm, day=SESSION):
    return dt.datetime.fromisoformat(f"{day}T{hhmm}").replace(tzinfo=intraday.NEW_YORK).astimezone(dt.UTC)


BREAK = [half("09:30", 100, 100.4, 99.9, 100.3), half("10:00", 100.3, 100.6, 100.2, 100.5), half("10:30", 100.5, 101.0, 100.4, 100.9),
         half("11:00", 100.9, 101.2, 100.8, 101.1), half("11:30", 101.1, 102.3, 101.0, 102.2)]


def test_the_sessions_hours_are_cut_as_the_broker_cuts_them_and_only_finished_ones_count():
    assert [(a.strftime("%H:%M"), b.strftime("%H:%M")) for a, b in intraday.slots(SESSION)][:2] == [("09:30", "10:00"), ("10:00", "11:00")]
    assert len(intraday.slots(SESSION)) == 7 and len(intraday.slots("2026-11-27")) == 4      # a half day ends at 13:00
    assert intraday.hourly_bars(BREAK, SESSION, ny("09:59")) == []
    one = intraday.hourly_bars(BREAK, SESSION, ny("10:00"))
    assert [(b.d, b.o, b.h, b.l, b.c) for b in one] == [("2026-10-12T09:30", 100, 100.4, 99.9, 100.3)]
    two = intraday.hourly_bars(BREAK, SESSION, ny("11:59"))
    assert [(b.d, b.o, b.h, b.l, b.c) for b in two][1] == ("2026-10-12T10:00", 100.3, 101.0, 100.2, 100.9)   # two halves, one hour
    assert len(intraday.hourly_bars(BREAK, SESSION, ny("12:00"))) == 3
    odd = [*BREAK, {"t": "not a time", "o": 1, "h": 1, "l": 1, "c": 1}, half("12:00", 0, 0, 0, 0), half("09:30", 1, 1, 1, 1, day="2026-10-09")]
    assert len(intraday.hourly_bars(odd, SESSION, ny("16:00"))) == 3                          # an hour with no real bar is left out


def test_a_rule_is_waiting_until_its_hourly_close_then_open_then_scored():
    levels = lv.levels_for(lv.load_ibkr(intraday.daily_raw(daily())).bars, SESSION)
    state = lambda hhmm, complete=False: {s["rule"]: s for s in intraday.rule_states(                    # noqa: E731
        intraday.hourly_bars(BREAK, SESSION, ny(hhmm)), levels, complete)}
    assert all(s["state"] == "waiting" for s in state("10:59").values())
    # The 10:00 to 11:00 hour closes at 100.9, above the prior high of 100.5: seen as soon as that hour is in.
    got = state("11:00")["brk_PDH_close"]
    assert got == {"rule": "brk_PDH_close", "state": "open", "bar": "11:00", "side": "call", "r": 0.0}
    assert [s["rule"] for s in intraday.rule_states([], levels, False)] == ["brk_PDH_close", "reclaim_PDL_close", "brk_PDL_close", "reject_PDH_close"]
    # An hour later the target (two risks of 0.6 above 100.9) has been reached.
    assert state("12:00")["brk_PDH_close"] == {"rule": "brk_PDH_close", "state": "target", "bar": "11:00", "side": "call", "r": 2.0}
    # With the session over and no target, an open trade is closed at the last bar, as the after-close run scores it.
    quiet = [*BREAK[:3], half("11:00", 100.9, 101.0, 100.8, 100.95)]
    ended = {s["rule"]: s for s in intraday.rule_states(intraday.hourly_bars(quiet, SESSION, ny("16:00")), levels, True)}
    assert ended["brk_PDH_close"]["state"] == "closed" and ended["brk_PDH_close"]["r"] == pytest.approx(0.05 / 0.6, abs=1e-3)
    live_now = {s["rule"]: s for s in intraday.rule_states(intraday.hourly_bars(quiet, SESSION, ny("12:00")), levels, False)}
    assert live_now["brk_PDH_close"]["state"] == "open"


def rule_account(parts=BREAK, names=("SPY", "QQQ")):
    acct = Account([option()])
    acct._bars = {"1Day": {n: daily() for n in names}, "30Min": {"SPY": parts}}
    return acct


def test_the_rules_block_is_built_from_two_requests_and_the_site_accepts_it():
    acct = rule_account()
    block, problems = live.rules_block(acct, ["SPY", "QQQ", "GONE"], ny("11:16"))
    assert problems == ["rules-skipped:1"]                                   # a name with no daily bars is counted, not sent
    assert [c[0] for c in acct.bar_calls] == ["1Day", "30Min"]
    assert acct.bar_calls[1][2] == ny("11:00")                               # sixteen minutes behind the clock
    assert (block["session"], block["delay_min"], block["provisional"], block["complete"]) == (SESSION, 16, True, False)
    spy, qqq = block["names"]
    assert spy["bars"] == 2 and {s["rule"]: s["state"] for s in spy["states"]}["brk_PDH_close"] == "open"
    assert qqq["bars"] == 0 and all(s == {"rule": s["rule"], "state": "waiting"} for s in qqq["states"])
    doc = live.build([option()], CLOCK, "r1", ny("11:16"), rules=block)
    assert live.validate(doc) == [] and doc["schema_version"] == 2
    assert "rules" not in live.build([option()], CLOCK, "r1", ny("11:16")) and live.build([], None, "r", NOW)["schema_version"] == 1
    # Before the first hour is in there is nothing to ask the feed for; after the close the block says it is complete.
    early = rule_account()
    assert live.rules_block(early, ["SPY"], ny("09:40"))[0]["names"][0]["bars"] == 0 and [c[0] for c in early.bar_calls] == ["1Day"]
    assert live.rules_block(rule_account(), ["SPY"], ny("16:16"))[0]["complete"] is True
    assert live.rules_block(rule_account(), ["SPY"], ny("11:16", day="2026-10-10")) == (None, [])     # a Saturday
    odd = rule_account()
    odd._bars["1Day"]["QQQ"] = [*daily()[:-1], {"t": "2026-10-09T04:00:00Z", "o": None, "h": 1, "l": 1, "c": 1}, "torn"]
    odd._bars["30Min"]["SPY"] = [*BREAK, dict(BREAK[1]), {**BREAK[1], "c": 100.55}]      # the same half-hour three times
    block, problems = live.rules_block(odd, ["SPY", "QQQ"], ny("11:16"))
    assert [n["symbol"] for n in block["names"]] == ["SPY"] and problems == ["rules-skipped:1"]   # QQQ's bad bar costs QQQ
    stale = rule_account()
    stale._bars["1Day"]["SPY"] = daily(end="2026-10-08")                      # yesterday's bar has not arrived
    assert live.rules_block(stale, ["SPY"], ny("11:16")) == (
        {"session": SESSION, "as_of": ny("11:00").isoformat(timespec="seconds"), "delay_min": 16, "provisional": True,
         "complete": False, "names": []}, ["rules-skipped:1"])


def test_a_trigger_is_announced_once_a_session_by_name_and_rule_and_never_with_a_price(tmp_path, capsys, monkeypatch):
    block, _ = live.rules_block(rule_account(), ["SPY"], ny("11:16"))
    seen = tmp_path / "seen.json"
    fresh = live.new_triggers(block, seen)
    assert fresh == [("SPY", "brk_PDH_close", "11:00")]
    assert live.new_triggers(block, seen) == []                               # five minutes later: already said
    later, _ = live.rules_block(rule_account(), ["SPY"], ny("12:16"))
    assert live.new_triggers(later, seen) == []                               # its outcome is not a new trigger
    assert live.new_triggers({**block, "session": "2026-10-13"}, seen) == fresh   # a new session starts again
    assert live.new_triggers(None, seen) == []
    seen.write_text(json.dumps({"session": SESSION, "keys": None}))            # a damaged file is an empty one
    assert live.new_triggers(block, seen) == fresh
    sent = []
    import wt.ops.alerts as alerts_mod
    monkeypatch.setattr(alerts_mod.Alerts, "fire", lambda self, key, title, message, priority=4, tags=(): sent.append((key, title, message, priority)) or True)
    monkeypatch.setattr(alerts_mod.Alerts, "__init__", lambda self, *a, **k: None)
    live.announce(fresh, "log", {"brk_PDH_close": "Hourly close above yesterday's high"}, SESSION)
    assert sent == [] and "rule triggered: SPY brk_PDH_close at the 11:00 ET hourly close" in capsys.readouterr().out
    live.announce(fresh, "phone", {"brk_PDH_close": "Hourly close above yesterday's high"}, SESSION)
    (key, title, message, priority), = sent
    assert key == f"options:rule:SPY:brk_PDH_close:{SESSION}" and title == "SPY: Hourly close above yesterday's high" and priority == 3
    assert "not a signal to trade" in message and not any(ch.isdigit() for ch in message.replace("11:00", "").replace("15 minutes", ""))


def test_rule_states_are_sent_only_to_a_dashboard_that_accepts_them_and_never_stop_the_positions(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(live, "desk_names", lambda: ["SPY"])
    monkeypatch.setattr(live, "load_yaml", lambda name: {"names": ["SPY"], "rule_alerts": "log"})      # not the owner's switch
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    sent = []
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: sent.append(json.loads(body)) or (True, "HTTP 200"))

    class Now(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return ny("11:16")
    monkeypatch.setattr(live.dt, "datetime", Now)
    asked = []

    def health(accepts):
        return lambda *a: asked.append(1) or ({"editions": {"options_live": {"accepts": accepts}}}, "")
    monkeypatch.setattr(publish, "read_health", health(1))
    assert live._publish(args(), rule_account()) == 0
    assert sent[-1]["schema_version"] == 1 and "rules" not in sent[-1]          # an older dashboard gets what it takes
    assert live._publish(args(), rule_account()) == 0 and len(asked) == 1        # and is not asked again within the hour
    (live.OUT / "site_accepts.json").unlink()
    monkeypatch.setattr(publish, "read_health", health(2))
    assert live._publish(args(), rule_account()) == 0
    assert sent[-1]["schema_version"] == 2 and sent[-1]["rules"]["names"][0]["symbol"] == "SPY" and live.validate(sent[-1]) == []
    assert "rule triggered: SPY brk_PDH_close" in capsys.readouterr().out
    assert live._publish(args(), rule_account()) == 0 and "rule triggered" not in capsys.readouterr().out
    # The bars cannot be read: the positions go out as before, and the document says why the rules are missing.
    assert live._publish(args(), Account([option()])) == 0
    assert "rules" not in sent[-1] and sent[-1]["schema_version"] == 1 and "rules-unavailable:no-bars-in-this-test" in sent[-1]["problems"]
    assert len(sent[-1]["positions"]) == 1
    # The dashboard said it takes version 2 and then refuses the document whole (a rollback inside the hour): the
    # positions go again as version 1, the answer is forgotten, and nothing is announced for what was not stored.
    replies = iter([(False, 'HTTP 422: {"errors":["/rules: key is not allowed"]}'), (True, "HTTP 200")])
    bodies = []
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: bodies.append(json.loads(body)) or next(replies))
    (live.OUT / "rules_seen.json").unlink()
    assert live._publish(args(), rule_account()) == 0
    assert [b["schema_version"] for b in bodies] == [2, 1] and "rules-refused" in bodies[1]["problems"] and len(bodies[1]["positions"]) == 1
    assert json.loads((live.OUT / "site_accepts.json").read_text())["accepts"] == 1 and "rule triggered" not in capsys.readouterr().out
    (live.OUT / "site_accepts.json").unlink()                 # the hour passes; the dashboard (this test's) says 2 again
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: sent.append(json.loads(body)) or (True, "HTTP 200"))
    # A block the site's schema would refuse never leaves: the positions go without it.
    real = live.rules_block
    monkeypatch.setattr(live, "rules_block", lambda *a: ({**real(*a)[0], "provisional": False}, []))
    assert live._publish(args(), rule_account()) == 0
    assert "rules" not in sent[-1] and "rules-invalid" in sent[-1]["problems"] and len(sent[-1]["positions"]) == 1
    monkeypatch.setattr(live, "rules_block", real)
    # Switched off in the desk's config: not worked out, and the dashboard is not asked.
    (live.OUT / "site_accepts.json").unlink()
    monkeypatch.setattr(live, "load_yaml", lambda name: {"names": ["SPY"], "rule_alerts": "off"})
    monkeypatch.setattr(publish, "read_health", lambda *a: pytest.fail("asked with the switch off"))
    assert live._publish(args(), rule_account()) == 0 and "rules" not in sent[-1]


def test_hourly_bars_cover_the_last_sessions_cut_as_the_rules_cut_them_and_the_site_accepts_them():
    friday = [half(h, 99, 99.6, 98.9, 99.5, day="2026-10-09") for h in ("09:30", "10:00", "10:30", "15:00", "15:30")]
    acct = Account([])
    acct._bars = {"30Min": {"SPY": [*friday, *BREAK, "not a bar"], "QQQ": []}}
    got = live.hourly_block(acct, ["SPY", "QQQ"], ny("11:16"))
    assert [n["symbol"] for n in got] == ["SPY"]                       # a name with no bars is left out
    bars = got[0]["bars"]
    # Friday's three hours with trades in them, then Monday's first two; 11:00 is not finished at 11:16 less the delay.
    assert [b["t"] for b in bars] == ["2026-10-09T09:30", "2026-10-09T10:00", "2026-10-09T15:00", "2026-10-12T09:30", "2026-10-12T10:00"]
    assert bars[-1] == {"t": "2026-10-12T10:00", "o": 100.3, "h": 101.0, "l": 100.2, "c": 100.9}
    (timeframe, start, end), = acct.bar_calls                            # one request, from the fifth session back
    assert timeframe == "30Min" and start == ny("09:30", day="2026-10-06") and end == ny("11:00")
    doc = live.build([], CLOCK, "20261012T151600Z-abc123", ny("11:16"), hourly=got)
    assert doc["schema_version"] == 3 and "rules" not in doc and live.validate(doc) == []
    assert live.build([], CLOCK, "r", ny("11:16"), hourly=[])["schema_version"] == 1          # nothing to send is not a version
    # A weekend reads the sessions that ended on Friday; a date past the engine's calendar reads nothing.
    sunday = dt.datetime(2026, 10, 11, 22, 0, tzinfo=dt.UTC)
    assert [b["t"][:10] for b in live.hourly_block(acct, ["SPY"], sunday)[0]["bars"]] == ["2026-10-09"] * 3
    assert live.hourly_block(acct, ["SPY"], dt.datetime(2099, 1, 5, 15, 0, tzinfo=dt.UTC)) == []


def test_hourly_bars_go_only_to_a_dashboard_that_takes_them_and_never_stop_the_positions(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(live, "desk_names", lambda: ["SPY"])
    desk = {"names": ["SPY"], "rule_alerts": "log", "hourly_bars": True}
    monkeypatch.setattr(live, "load_yaml", lambda name: desk)
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    sent = []
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: sent.append(json.loads(body)) or (True, "HTTP 200"))

    class Now(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return ny("11:16")
    monkeypatch.setattr(live.dt, "datetime", Now)

    def health(accepts):
        (live.OUT / "site_accepts.json").unlink(missing_ok=True)
        monkeypatch.setattr(publish, "read_health", lambda *a: ({"editions": {"options_live": {"accepts": accepts}}}, ""))
    health(2)
    assert live._publish(args(), rule_account()) == 0
    assert sent[-1]["schema_version"] == 2 and "hourly" not in sent[-1]           # a dashboard on version 2 gets version 2
    health(3)
    assert live._publish(args(), rule_account()) == 0
    assert sent[-1]["schema_version"] == 3 and sent[-1]["hourly"][0]["symbol"] == "SPY" and "rules" in sent[-1]
    assert live.validate(sent[-1]) == [] and "hourly bars for 1 names" in capsys.readouterr().out
    # Switched off, or not in the desk's file at all: not read and not sent.
    desk["hourly_bars"] = False
    assert live._publish(args(), rule_account()) == 0 and "hourly" not in sent[-1] and sent[-1]["schema_version"] == 2
    del desk["hourly_bars"]
    assert live._publish(args(), rule_account()) == 0 and "hourly" not in sent[-1]
    # Rule states off and hourly bars on: version 3 without rules.
    desk.update(rule_alerts="off", hourly_bars=True)
    assert live._publish(args(), rule_account()) == 0
    assert sent[-1]["schema_version"] == 3 and "rules" not in sent[-1] and live.validate(sent[-1]) == []
    desk["rule_alerts"] = "log"
    # A fault while reading them, or bars the site's schema would refuse, cost the bars and nothing else.
    real = live.hourly_block
    monkeypatch.setattr(live, "hourly_block", lambda *a: (_ for _ in ()).throw(KeyError("x")))
    assert live._publish(args(), rule_account()) == 0
    assert "hourly" not in sent[-1] and "hourly-failed:KeyError" in sent[-1]["problems"] and "rules" in sent[-1]
    monkeypatch.setattr(live, "hourly_block", lambda *a: [{"symbol": "SPY", "bars": [{"t": "soon", "o": 1, "h": 1, "l": 1, "c": 1}]}])
    assert live._publish(args(), rule_account()) == 0
    assert "hourly" not in sent[-1] and "hourly-invalid" in sent[-1]["problems"] and sent[-1]["schema_version"] == 2
    monkeypatch.setattr(live, "hourly_block", real)
    # The dashboard refuses the document whole after saying it takes version 3: the positions go again as version 1.
    replies = iter([(False, 'HTTP 422: {"errors":["/hourly: key is not allowed"]}'), (True, "HTTP 200")])
    bodies = []
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: bodies.append(json.loads(body)) or next(replies))
    assert live._publish(args(), rule_account()) == 0
    # Refused with both extras: the bars are dropped first and the rule states kept; what was stored is remembered,
    # so the next run sends version 2 straight away and does not ask the dashboard again.
    assert [b["schema_version"] for b in bodies] == [3, 2] and bodies[1]["problems"][-1] == "hourly-refused" and "rules" in bodies[1]
    assert json.loads((live.OUT / "site_accepts.json").read_text())["accepts"] == 2
    monkeypatch.setattr(publish, "read_health", lambda *a: pytest.fail("asked again inside the hour"))
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: sent.append(json.loads(body)) or (True, "HTTP 200"))
    acct = rule_account()
    assert live._publish(args(), acct) == 0 and sent[-1]["schema_version"] == 2
    assert [c[0] for c in acct.bar_calls] == ["1Day", "30Min"]                    # the rules' two requests, no third
    # Refused at every step: the positions go as version 1.
    health(3)
    replies = iter([(False, "HTTP 422: x"), (False, "HTTP 422: x"), (True, "HTTP 200")])
    bodies.clear()
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: bodies.append(json.loads(body)) or next(replies))
    assert live._publish(args(), rule_account()) == 0
    assert [b["schema_version"] for b in bodies] == [3, 2, 1] and {"rules-refused", "hourly-refused"} <= set(bodies[2]["problems"])
    assert json.loads((live.OUT / "site_accepts.json").read_text())["accepts"] == 1 and len(bodies[2]["positions"]) == 1
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: sent.append(json.loads(body)) or (True, "HTTP 200"))
    # A fault in the rule states is theirs: the bars still go.
    health(3)
    real_rules = live.rules_block
    monkeypatch.setattr(live, "rules_block", lambda *a: ({**real_rules(*a)[0], "provisional": False}, []))
    assert live._publish(args(), rule_account()) == 0
    assert "rules" not in sent[-1] and "hourly" in sent[-1] and sent[-1]["problems"][-1] == "rules-invalid" and "hourly-invalid" not in sent[-1]["problems"]
    monkeypatch.setattr(live, "rules_block", real_rules)
    # A price that is not a number is no bar, and one that slips through never stops the positions.
    wild = [half("09:30", 100, float("inf"), 99.9, 100.3), half("10:00", 100.3, 100.6, 100.2, 100.5)]
    assert [b["t"] for b in live.hourly_block(rule_account(parts=wild), ["SPY"], ny("11:16"))[0]["bars"]] == ["2026-10-12T10:00"]
    monkeypatch.setattr(live, "hourly_block", lambda *a: [{"symbol": "SPY", "bars": [{"t": "2026-10-12T09:30", "o": 1.0, "h": float("nan"), "l": 1.0, "c": 1.0}]}])
    assert live._publish(args(), rule_account()) == 0
    assert "hourly" not in sent[-1] and len(sent[-1]["positions"]) == 1 and {"extras-unreadable", "hourly-invalid"} & set(sent[-1]["problems"])


def test_bars_are_read_to_the_last_page_and_a_reply_cut_short_is_a_fault_not_a_shorter_answer():
    # The feed pages by name: a reader that stops early loses whole names (seen live: seven of ten).
    pages = [Reply(200, {"bars": {"AAPL": [1, 2], "META": [3]}, "next_page_token": "a"}),
             Reply(200, {"bars": {"META": [4], "QQQ": [5]}, "next_page_token": "b"}),
             Reply(200, {"bars": {"SPY": [6]}, "next_page_token": "c"}),
             Reply(200, {"bars": {"TSLA": [7]}, "next_page_token": None})]
    session = Session(*pages)
    acct = live.OptionsAccount("k", "s", session=session)
    got = acct.bars(["AAPL", "META", "QQQ", "SPY", "TSLA"], "30Min", ny("09:30"), ny("11:00"))
    assert got == {"AAPL": [1, 2], "META": [3, 4], "QQQ": [5], "SPY": [6], "TSLA": [7]}
    endless = Session(*[Reply(200, {"bars": {"AAPL": [1]}, "next_page_token": "more"}) for _ in range(live.BAR_PAGES)])
    with pytest.raises(live.BrokerFault, match="bars-truncated"):
        live.OptionsAccount("k", "s", session=endless).bars(["AAPL"], "30Min", ny("09:30"), ny("11:00"))
