"""The hand-placed paper account's closed option trades (DEC-0057): read only, matched first in, first out, and sent
without anything that names the account. No network."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from wt.options import live, paper_manual, paper_site

NOW = dt.datetime(2026, 11, 20, 20, 10, tzinfo=dt.UTC)
C = "QQQ261120C00600000"
P = "NVDA261127P00185000"
CFG = {"costs": {"fee_per_contract_each_way": 0.03}}


def fill(n: int, side: str, qty: float, price: float, symbol: str = C, at: str = "2026-11-18T15:00:00Z", **kw: Any) -> dict[str, Any]:
    return {"activity_type": "FILL", "id": f"202611180000000{n:02d}::id-{n}", "transaction_time": at, "symbol": symbol, "side": side,
            "qty": str(qty), "price": str(price), "order_id": "an-order-id", "cum_qty": "9", "leaves_qty": "0", "type": "fill", **kw}


def event(n: int, kind: str, symbol: str = C, date: str = "2026-11-20") -> dict[str, Any]:
    return {"activity_type": kind, "id": f"202611200000000{n:02d}::ev-{n}", "date": date, "symbol": symbol, "qty": "-1",
            "net_amount": "0", "cusip": "x"}


def trips(raw: list[dict[str, Any]], clone: set[tuple[str, str]] | None = None) -> dict[str, Any]:
    return paper_manual.round_trips(paper_manual.clean(raw), clone or ())


def test_a_buy_then_a_sell_is_one_long_trade_with_its_result() -> None:
    got = trips([fill(1, "buy", 2, 1.50), fill(2, "sell", 2, 2.10, at="2026-11-18T15:40:00Z")])
    (t,) = got["trades"]
    assert {k: t[k] for k in t if k != "id"} == {
        "contract": C, "side": "long", "qty": 2.0, "opened_at": "2026-11-18T15:00:00+00:00", "closed_at": "2026-11-18T15:40:00+00:00",
        "entry": 1.5, "exit": 2.1, "pnl_usd": 120.0, "close": "order"}
    assert t["id"].startswith("m-") and "id-1" not in t["id"]
    assert got["gaps"] == [] and got["truncated"] == 0 and got["excluded_clone_fills"] == 0 and got["history_from"] == "2026-11-18"


def test_fills_are_matched_first_in_first_out_across_partial_fills_and_what_is_open_is_no_trade() -> None:
    got = trips([fill(1, "buy", 1, 1.00, at="2026-11-18T15:00:00Z"), fill(2, "buy", 2, 2.00, at="2026-11-18T15:05:00Z"),
                 fill(3, "sell", 2, 3.00, at="2026-11-18T15:30:00Z"), fill(4, "buy", 5, 9.00, symbol=P)])
    assert [(t["qty"], t["entry"], t["exit"], t["pnl_usd"]) for t in got["trades"]] == [(1.0, 1.0, 3.0, 200.0), (1.0, 2.0, 3.0, 100.0)]
    assert len({t["id"] for t in got["trades"]}) == 2
    # One contract of the second buy, and the whole NVDA position, are still open: in no trade.
    assert sum(t["qty"] for t in got["trades"]) == 2.0 and all(t["contract"] == C for t in got["trades"])


def test_a_contract_sold_first_is_a_short_trade_and_a_flip_closes_then_opens() -> None:
    got = trips([fill(1, "sell_short", 1, 2.00), fill(2, "buy", 3, 1.50, at="2026-11-18T15:10:00Z"),
                 fill(3, "sell", 2, 1.80, at="2026-11-18T15:20:00Z")])
    assert [(t["side"], t["qty"], t["pnl_usd"]) for t in got["trades"]] == [("short", 1.0, 50.0), ("long", 2.0, 60.0)]


def test_an_expiry_closes_what_is_open_at_zero_and_an_exercise_or_assignment_books_nothing() -> None:
    got = trips([fill(1, "buy", 2, 1.25), event(2, "OPEXP"), fill(3, "buy", 1, 3.00, symbol=P), event(4, "OPXRC", symbol=P),
                 event(5, "OPASN", symbol="SPY261120P00580000"), event(6, "OPEXP")])
    (t,) = got["trades"]
    assert (t["close"], t["exit"], t["pnl_usd"], t["qty"]) == ("expired", 0.0, -250.0, 2.0)
    assert t["closed_at"] == "2026-11-20T21:00:00+00:00"                       # 16:00 in New York on the expiry's day
    assert got["gaps"] == [{"date": "2026-11-20", "contract": P}]             # nothing was open in the assigned SPY contract
    short = trips([fill(1, "sell_short", 1, 0.80), event(2, "OPEXP")])["trades"][0]
    assert (short["side"], short["pnl_usd"]) == ("short", 80.0)


def test_what_is_not_an_option_fill_is_left_out_and_nothing_of_the_account_is_kept() -> None:
    raw = [fill(1, "buy", 10, 500.0, symbol="QQQ"), fill(2, "buy", 1, 1.0), fill(3, "sell", 1, 1.2, at="2026-11-18T16:00:00Z"),
           {"activity_type": "DIV", "id": "d1", "date": "2026-11-18", "symbol": C, "net_amount": "5"},
           fill(4, "buy", 0, 1.0), fill(5, "hold", 1, 1.0), fill(6, "buy", 1, "n/a"), {"id": 7}, None, "text",
           {**fill(8, "buy", 1, 1.0), "transaction_time": "yesterday"}, {**fill(9, "buy", 1, 1.0), "id": "an id with spaces"}]
    kept = paper_manual.clean(raw)
    assert [a["id"][-4:] for a in kept] == ["id-1", "id-2", "id-3"]
    assert set(kept[1]) == {"id", "type", "at", "symbol", "side", "qty", "price"}
    assert "order" not in json.dumps(kept) and "cum_qty" not in json.dumps(kept)
    got = paper_manual.round_trips(kept)
    assert len(got["trades"]) == 1 and got["_other"] == 1


def test_the_clones_fills_in_a_shared_account_are_left_out_by_contract_and_day() -> None:
    raw = [fill(1, "buy", 1, 1.0), fill(2, "sell", 1, 1.5, at="2026-11-18T15:30:00Z"),
           fill(3, "buy", 1, 2.0, symbol=P), fill(4, "sell", 1, 2.5, symbol=P, at="2026-11-18T15:30:00Z"),
           fill(5, "buy", 1, 1.0, at="2026-11-19T15:00:00Z"), fill(6, "sell", 1, 1.1, at="2026-11-19T15:30:00Z")]
    plans = {"2026-11-18-O-1": {"symbol": C}, "not-a-trade-id": {"symbol": P}, "2026-11-18-O-2": {"symbol": "junk"}}
    assert paper_manual.clone_days(plans) == {(C, "2026-11-18")}
    got = paper_manual.block(paper_manual.clean(raw), True, plans)
    assert got["excluded_clone_fills"] == 2 and [(t["contract"], t["pnl_usd"]) for t in got["trades"]] == [(P, 50.0), (C, 10.0)]
    assert "_other" not in got
    own = paper_manual.block(paper_manual.clean(raw), False, plans)
    assert own["excluded_clone_fills"] == 0 and len(own["trades"]) == 3


def test_the_newest_trades_are_kept_over_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paper_manual, "MAX_TRADES", 2)
    raw = [f for n in range(4) for f in (fill(2 * n, "buy", 1, 1.0, at=f"2026-11-18T15:0{n}:00Z"), fill(2 * n + 1, "sell", 1, 1.0 + n, at=f"2026-11-18T15:0{n}:30Z"))]
    got = trips(raw)
    assert got["truncated"] == 2 and [t["exit"] for t in got["trades"]] == [3.0, 4.0]


class Account:
    def __init__(self, pages: list[list[dict[str, Any]]]) -> None:
        self.pages, self.calls = pages, []

    def activities(self, after: str, page_token: str | None = None) -> list[Any]:
        self.calls.append((after, page_token))
        return self.pages[len(self.calls) - 1] if len(self.calls) <= len(self.pages) else []


def test_a_first_read_pages_through_the_history_and_the_next_asks_only_for_what_is_newer(tmp_path: Path) -> None:
    full = [fill(n, "buy" if n % 2 else "sell", 1, 1.0, at=f"2026-11-18T15:{n:02d}:00Z") for n in range(1, 60)]
    page1 = [*full, *[{"activity_type": "FILL", "id": f"pad-{i}"} for i in range(41)]]        # 100 rows, the last 41 unreadable
    acct = Account([page1, [fill(70, "sell", 1, 2.0, at="2026-11-19T15:00:00Z")]])
    rows = paper_manual.refresh(acct, tmp_path / "a.json", NOW)
    assert len(rows) == 60 and [c[1] for c in acct.calls] == [None, "pad-40"]
    assert acct.calls[0][0] == "2024-11-20T20:10:00Z"                                         # the first read starts two years back
    again = Account([[fill(71, "buy", 1, 2.0, at="2026-11-20T15:00:00Z")]])
    rows = paper_manual.refresh(again, tmp_path / "a.json", NOW)
    assert len(rows) == 61 and again.calls == [("2026-11-18T15:00:00Z", None)]                # a day before the newest it had
    assert rows == sorted(rows, key=lambda a: a["at"]) and "order_id" not in (tmp_path / "a.json").read_text()


def test_a_run_reads_a_bounded_number_of_pages_and_a_fault_leaves_the_cache_as_it_was(tmp_path: Path) -> None:
    acct = Account([[fill(100 * k + n, "buy", 1, 1.0) for n in range(100)] for k in range(50)])
    paper_manual.refresh(acct, tmp_path / "a.json", NOW, max_pages=3)
    assert len(acct.calls) == 3
    # An account that answers a page token with the same page again is not asked a third time.
    same = Account([[fill(n, "buy", 1, 1.0) for n in range(100)]] * 50)
    paper_manual.refresh(same, tmp_path / "same.json", NOW)
    assert len(same.calls) == 2
    before = (tmp_path / "a.json").read_text()

    class Down:
        def activities(self, after: str, page_token: str | None = None) -> list[Any]:
            raise live.BrokerFault("http-500")
    with pytest.raises(live.BrokerFault):
        paper_manual.refresh(Down(), tmp_path / "a.json", NOW)
    assert (tmp_path / "a.json").read_text() == before
    (tmp_path / "bad.json").write_text("{not json")
    assert paper_manual.refresh(Account([[]]), tmp_path / "bad.json", NOW) == []


def test_a_refused_activity_filter_is_asked_again_without_it_and_only_that_fault_is() -> None:
    # 2026-11-18: every request was refused with HTTP 422, so the hand-placed history never arrived. The likely cause
    # is a type name the account does not know (OPXRC). The names are now the API's own, and a refused filter is
    # not the end.
    assert live.ACTIVITY_TYPES == "FILL,OPEXP,OPASN,OPEXC"
    seen: list[dict[str, str]] = []

    class Resp:
        def __init__(self, status: int) -> None:
            self.status_code = status

        def json(self) -> Any:
            return [fill(1, "buy", 1, 1.0), {"id": "d1", "activity_type": "DIV", "symbol": "SPY", "date": "2026-11-18"}]

    class Session:
        def __init__(self, refuse: int) -> None:
            self.refuse = refuse

        def get(self, url: str, **kw: Any) -> Resp:
            seen.append(dict(kw["params"]))
            return Resp(self.refuse if "activity_types" in kw["params"] else 200)
    acct = live.OptionsAccount("k", "s", Session(422))   # type: ignore[arg-type]
    got = acct.activities("2026-11-01T00:00:00Z")
    assert ["activity_types" in p for p in seen] == [True, False]
    assert seen[1] == {"after": "2026-11-01T00:00:00Z", "direction": "asc", "page_size": "100"}
    # What comes back unfiltered is reduced to the types the reader knows.
    assert [a["type"] for a in paper_manual.clean(got)] == ["FILL"]
    # The next page of the same run does not try the refused filter again.
    acct.activities("2026-11-01T00:00:00Z", "tok")
    assert seen[2] == {"after": "2026-11-01T00:00:00Z", "direction": "asc", "page_size": "100", "page_token": "tok"}
    # Any other refusal is the fault it always was: no second request.
    seen.clear()
    with pytest.raises(live.BrokerFault, match="http-400"):
        live.OptionsAccount("k", "s", Session(400)).activities("2026-11-01T00:00:00Z")   # type: ignore[arg-type]
    assert len(seen) == 1
    with pytest.raises(live.BrokerFault, match="keys-rejected"):
        live.OptionsAccount("k", "s", Session(401)).activities("2026-11-01T00:00:00Z")   # type: ignore[arg-type]


def test_an_exercise_is_read_under_either_of_its_two_names() -> None:
    for name in ("OPEXC", "OPXRC"):
        got = trips([fill(1, "buy", 1, 3.00, symbol=P), event(2, name, symbol=P)])
        assert got["trades"] == [] and got["gaps"] == [{"date": "2026-11-20", "contract": P}], name


def test_the_account_call_is_a_get_on_the_paper_host_for_fills_and_option_events_only() -> None:
    seen: list[dict[str, Any]] = []

    class Resp:
        status_code = 200

        def json(self) -> Any:
            return [fill(1, "buy", 1, 1.0)]

    class Session:
        def get(self, url: str, **kw: Any) -> Resp:
            seen.append({"url": url, **kw})
            return Resp()
    got = live.OptionsAccount("k", "s", Session()).activities("2026-11-01T00:00:00Z", "tok")   # type: ignore[arg-type]
    assert len(got) == 1 and seen[0]["url"] == "https://paper-api.alpaca.markets/v2/account/activities"
    assert seen[0]["params"] == {"activity_types": "FILL,OPEXP,OPASN,OPEXC", "after": "2026-11-01T00:00:00Z", "direction": "asc",
                                 "page_size": "100", "page_token": "tok"}
    assert seen[0]["allow_redirects"] is False
    src = Path(paper_manual.__file__).read_text()
    for word in ("requests", "wt.oms", "wt.brokers", ".post(", ".place(", "submit", "order_id", "client_order_id"):
        assert word not in src, word


def test_the_history_document_carries_the_manual_block_and_passes_the_dashboards_schema(tmp_path: Path) -> None:
    acts = paper_manual.clean([fill(1, "buy", 2, 1.50), fill(2, "sell", 1, 2.10, at="2026-11-18T15:40:00Z"), event(3, "OPEXP"),
                               fill(4, "buy", 1, 3.0, symbol=P), event(5, "OPASN", symbol=P)])
    (tmp_path / "j.jsonl").write_text("")
    env = {"APCA_CLONE_KEY_ID": "k", "APCA_CLONE_SECRET_KEY": "x"}
    doc = paper_site.build(NOW, "run-1", tmp_path / "j.jsonl", tmp_path / "state", CFG, env, acts)
    assert paper_site.validate(doc) == []
    m = doc["manual"]
    assert [(t["close"], t["pnl_usd"]) for t in m["trades"]] == [("order", 60.0), ("expired", -150.0)]
    assert m["gaps"] == [{"date": "2026-11-20", "contract": P}] and m["history_from"] == "2026-11-18"
    text = json.dumps(doc)
    assert "an-order-id" not in text and "id-1" not in text and "cusip" not in text
    assert "manual" not in paper_site.build(NOW, "run-2", tmp_path / "j.jsonl", tmp_path / "state", CFG, env)
    empty = paper_site.build(NOW, "run-3", tmp_path / "j.jsonl", tmp_path / "state", CFG, env, [])
    assert empty["manual"]["trades"] == [] and empty["manual"]["history_from"] is None and paper_site.validate(empty) == []


def test_the_job_hands_the_activities_to_the_history_and_goes_on_without_them(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                                              capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(live, "OUT", tmp_path)
    monkeypatch.delenv(live.KEY_ID_VAR, raising=False)
    assert live._manual_history() is None                                                    # no keys: nothing to read
    assert [a["symbol"] for a in live._manual_history(Account([[fill(1, "buy", 1, 1.0)]])) or []] == [C]

    class Down:
        def activities(self, after: str, page_token: str | None = None) -> list[Any]:
            raise live.BrokerFault("keys-rejected")
    assert live._manual_history(Down()) is None                                              # type: ignore[arg-type]
    assert "keys-rejected" in capsys.readouterr().err
    got: list[Any] = []
    monkeypatch.setattr(live, "_publish", lambda a: 0)
    monkeypatch.setattr(live, "_manual_history", lambda: [{"id": "x"}])
    monkeypatch.setattr(paper_site, "run", lambda **kw: got.append(kw) or 0)
    assert live.main([]) == 0 and got == [{"dry_run": False, "manual": [{"id": "x"}]}]
