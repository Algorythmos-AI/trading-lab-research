"""The paper options history for the dashboard (DEC-0057): built from the clone's journal, its plan files and the
arms' shadow files, checked against the dashboard's own schema, and sent only when it should be. No network."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from wt.ops import publish
from wt.options import clone_site, live, paper_site, review

NOW = dt.datetime(2026, 11, 20, 20, 10, tzinfo=dt.UTC)
CFG = {"costs": {"fee_per_contract_each_way": 0.03}}
ENV = {"DASHBOARD_INGEST_URL": "https://lab.example/api/ingest", "DASHBOARD_INGEST_SECRET": "s", "DASHBOARD_KEY_ID": "gcp-use1",
       "APCA_CLONE_KEY_ID": "k", "APCA_CLONE_SECRET_KEY": "x"}


def closed(tid: str, fill: float = 2.0, exit_fill: float | None = 2.5, setup: str = "retest", state: str = "closed",
           symbol: str = "SPY261118C00581000", **kw: Any) -> dict[str, Any]:
    pnl = None if exit_fill is None else round((exit_fill - fill) * 100 - 0.06, 2)
    return {"ts": f"{tid[:10]}T19:00:00+00:00", "event": "trade_closed", "trade_id": tid, "setup": setup, "root": "SPY",
            "side": "call", "symbol": symbol, "state": state, "fill": fill, "exit_fill": exit_fill,
            "exit_reason": "target" if exit_fill else "", "pnl": pnl, "rop": None if pnl is None else round(pnl / (fill * 100 + 0.03), 4),
            "best_bid": 2.8, "worst_bid": 1.9, "broker_stop": "accepted", "counts": state == "closed", **kw}


def plan(state: Path, tid: str, **kw: Any) -> None:
    (state / "plans").mkdir(parents=True, exist_ok=True)
    body = {"trade_id": tid, "setup": "retest", "filled_at": f"{tid[:10]} 15:02:11.250000+00:00",
            "exit_at": f"{tid[:10]}T15:31:40+00:00", "quoted_ask": 2.0, "quote_age_s": 1.4, "notes": [["free text stays here"]], **kw}
    (state / "plans" / f"plan_{tid}.json").write_text(json.dumps(body))


def write(path: Path, rows: list[dict[str, Any]]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def build(tmp_path: Path, rows: list[dict[str, Any]], env: dict[str, str] | None = None) -> dict[str, Any]:
    journal = write(tmp_path / "journal.jsonl", rows)
    return paper_site.build(NOW, "run-1", journal, tmp_path / "state", CFG, ENV if env is None else env)


def test_a_closed_trade_carries_its_fills_times_result_and_ids_and_no_setup_name(tmp_path: Path) -> None:
    plan(tmp_path / "state", "2026-11-18-O-1")
    doc = build(tmp_path, [{"ts": "2026-11-18T15:02:00+00:00", "event": "entry_sent", "trade_id": "2026-11-18-O-1", "quoted_ask": 9.9},
                           closed("2026-11-18-O-1")])
    assert paper_site.validate(doc) == []
    (t,) = doc["clone"]["trades"]
    assert t == {"trade_id": "2026-11-18-O-1", "session": "2026-11-18", "hyp": "HYP-0029", "window": "no_oi", "side": "call",
                 "contract": "SPY261118C00581000", "qty": 1, "opened_at": "2026-11-18T15:02:11+00:00",
                 "closed_at": "2026-11-18T15:31:40+00:00", "timed_by": "plan", "fill": 2.0, "exit_fill": 2.5, "exit_reason": "target",
                 "pnl_usd": 49.94, "rop": 0.2497, "quoted_ask": 2.0, "quote_age_s": 1.4, "best_bid": 2.8, "worst_bid": 1.9,
                 "state": "closed", "counts": True}
    text = json.dumps(doc)
    assert "retest" not in text and "setup" not in text and "free text" not in text and "broker_stop" not in text
    assert doc["clone"]["own_account"] is True and doc["clone"]["fee_per_contract"] == 0.03 and doc["paper"] is True
    assert "manual" not in doc and "arms" not in doc


def test_the_hypothesis_follows_the_setup_and_the_expiry_and_the_window_follows_the_session(tmp_path: Path) -> None:
    rows = [closed("2026-10-28-O-1", symbol="SPY261028C00581000"), closed("2026-11-03-O-1", setup="rejection", symbol="SPY261103P00581000", side="put"),
            closed("2026-11-10-O-1", symbol="NVDA261113C00185000"), closed("2026-11-18-O-1", setup="something new")]
    for r in rows:
        plan(tmp_path / "state", r["trade_id"])
    got = {t["trade_id"]: (t["hyp"], t["window"]) for t in build(tmp_path, rows)["clone"]["trades"]}
    assert got == {"2026-10-28-O-1": ("HYP-0029", "old"), "2026-11-03-O-1": ("HYP-0030", "cap15"),
                   "2026-11-10-O-1": ("HYP-0031", "spread5"), "2026-11-18-O-1": ("other", "no_oi")}
    # Every window the review knows, oldest first, so a later rule change needs nothing here.
    sent = build(tmp_path, rows)["clone"]["windows"]
    assert {w["id"] for w in sent} == set(review.WINDOWS) and [w["id"] for w in sent][:4] == ["old", "cap15", "spread5", "no_oi"]
    assert sent[0]["from"] is None and [w["from"] for w in sent[1:]] == sorted(w["from"] for w in sent[1:])
    assert all(paper_site.window_of(since) == name for name, (since, _until) in review.WINDOWS.items() if since)


def test_a_trade_without_its_plan_file_is_timed_from_the_journal_and_says_so(tmp_path: Path) -> None:
    doc = build(tmp_path, [{"ts": "2026-11-18T15:02:30+00:00", "event": "filled", "trade_id": "2026-11-18-O-1", "fill": 2.0},
                           closed("2026-11-18-O-1")])
    (t,) = doc["clone"]["trades"]
    assert (t["opened_at"], t["closed_at"], t["timed_by"], t["counts"]) == \
        ("2026-11-18T15:02:30+00:00", "2026-11-18T19:00:00+00:00", "journal", True)
    assert t["quoted_ask"] is None and paper_site.validate(doc) == []
    # With no time for the entry at all it is listed and counted nowhere, never given a made-up time.
    (u,) = build(tmp_path, [closed("2026-11-18-O-2")])["clone"]["trades"]
    assert u["opened_at"] is None and u["counts"] is False


def test_an_unsettled_trade_is_sent_with_what_is_known_and_never_counted(tmp_path: Path) -> None:
    plan(tmp_path / "state", "2026-11-18-O-1", exit_at="")
    doc = build(tmp_path, [closed("2026-11-18-O-1", exit_fill=None, state="unresolved")])
    (t,) = doc["clone"]["trades"]
    assert (t["state"], t["counts"], t["exit_fill"], t["pnl_usd"], t["rop"], t["closed_at"], t["exit_reason"]) == \
        ("unresolved", False, None, None, None, None, None)
    assert t["fill"] == 2.0 and t["opened_at"] == "2026-11-18T15:02:11+00:00" and paper_site.validate(doc) == []


def test_the_last_row_of_a_trade_wins_and_what_cannot_be_named_is_left_out(tmp_path: Path) -> None:
    rows = [closed("2026-11-18-O-1", exit_fill=2.1), closed("2026-11-18-O-1", exit_fill=2.6),
            closed("2026-11-18-O-2", symbol="SPY 581 call"), closed("not-an-id"), {"event": "trade_closed"},
            closed("2026-11-18-O-3", exit_reason="sold because the chart looked weak"),
            closed("2026-11-18-O-10"), closed("2026-11-18-O-9")]
    for tid in ("2026-11-18-O-1", "2026-11-18-O-3", "2026-11-18-O-9", "2026-11-18-O-10"):
        plan(tmp_path / "state", tid)
    journal = write(tmp_path / "journal.jsonl", rows)
    with journal.open("a") as fh:
        fh.write('{"event": "trade_closed", "trade_id": "2026-11-18-O-4", torn\n[1, 2]\n')
    doc = paper_site.build(NOW, "run-1", journal, tmp_path / "state", CFG, ENV)
    trades = doc["clone"]["trades"]
    assert [t["trade_id"] for t in trades] == ["2026-11-18-O-1", "2026-11-18-O-3", "2026-11-18-O-9", "2026-11-18-O-10"]
    assert trades[0]["exit_fill"] == 2.6 and trades[1]["exit_reason"] == "other"
    assert "chart looked weak" not in json.dumps(doc) and paper_site.validate(doc) == []


def test_the_newest_trades_are_kept_when_the_list_is_over_the_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paper_site, "MAX_TRADES", 3)
    doc = build(tmp_path, [closed(f"2026-11-18-O-{n}") for n in range(1, 6)])
    assert doc["clone"]["truncated"] == 2
    assert [t["trade_id"] for t in doc["clone"]["trades"]] == ["2026-11-18-O-3", "2026-11-18-O-4", "2026-11-18-O-5"]


def test_the_clones_old_fills_in_the_hand_account_are_left_out_whatever_its_keys_say(tmp_path: Path) -> None:
    # 2026-11-18: the clone had traded in the hand-placed account before it had keys of its own, and those trades were
    # sent a second time as hand-placed, because only a clone still sharing the account was left out.
    theirs, mine = "SPY261118C00581000", "NVDA261127P00185000"
    plan(tmp_path / "state", "2026-11-18-O-1", symbol=theirs)
    acts = [{"id": f"a{n}", "type": "FILL", "at": f"2026-11-18T15:0{n}:00+00:00", "symbol": sym, "side": side, "qty": 1.0, "price": px}
            for n, (sym, side, px) in enumerate([(theirs, "buy", 2.0), (theirs, "sell", 2.5), (mine, "buy", 1.0), (mine, "sell", 1.5)])]
    journal = write(tmp_path / "journal.jsonl", [closed("2026-11-18-O-1")])
    for env in (ENV, {"APCA_OPTIONS_KEY_ID": "k", "APCA_OPTIONS_SECRET_KEY": "x"}, {}):
        doc = paper_site.build(NOW, "run-1", journal, tmp_path / "state", CFG, env, acts)
        assert [t["contract"] for t in doc["manual"]["trades"]] == [mine] and doc["manual"]["excluded_clone_fills"] == 2
        assert paper_site.validate(doc) == []
    # A trade whose plan file is gone is still the clone's: its journal row names the contract.
    (tmp_path / "state" / "plans" / "plan_2026-11-18-O-1.json").unlink()
    doc = paper_site.build(NOW, "run-1", journal, tmp_path / "state", CFG, ENV, acts)
    assert [t["contract"] for t in doc["manual"]["trades"]] == [mine] and doc["manual"]["excluded_clone_fills"] == 2


def test_the_account_is_the_clones_own_shared_or_unknown(tmp_path: Path) -> None:
    assert build(tmp_path, [], {"APCA_OPTIONS_KEY_ID": "k", "APCA_OPTIONS_SECRET_KEY": "x"})["clone"]["own_account"] is False
    assert build(tmp_path, [], {})["clone"]["own_account"] is None
    assert build(tmp_path, [])["clone"]["trades"] == [] and paper_site.validate(build(tmp_path, [])) == []


def test_the_counted_trades_and_their_total_are_the_reviews_own(tmp_path: Path) -> None:
    """The page checks its clone total against the clone's own document (`setups`, the `all` row): both must count
    the same trades and add up the same dollars from one journal."""
    rows = [closed("2026-11-18-O-1", exit_fill=2.5), closed("2026-11-18-O-2", exit_fill=1.5, setup="rejection"),
            closed("2026-11-19-O-1", exit_fill=2.2, symbol="NVDA261120C00185000"), closed("2026-11-19-O-2", exit_fill=None, state="unresolved")]
    for r in rows:
        plan(tmp_path / "state", r["trade_id"])
    mine = [t for t in build(tmp_path, rows)["clone"]["trades"] if t["counts"]]
    theirs = review.review(rows)["all"]
    assert len(mine) == theirs["trades"] == 3
    assert round(sum(t["pnl_usd"] for t in mine), 2) == theirs["total_usd"]
    assert clone_site.HYP["retest"] == paper_site.HYP["retest"] and clone_site.HYP["rejection"] == paper_site.HYP["rejection"]


def virtual(vid: str, arm: str, setup: str, event: str = "closed", **kw: Any) -> dict[str, Any]:
    return {"ts": "2026-11-12T16:00:00+00:00", "event": event, "arm": arm, "vid": vid, "root": "SPY", "symbol": "SPY261112C00581000",
            "side": "call", "setup": setup, "level": "a level name", "state": "closed", "fill": 1.0, "filled_at": "2026-11-12T15:00:00+00:00",
            "exit_fill": 1.3, "exit_at": "2026-11-12T15:40:00+00:00", "exit_reason": "target", "rop": 0.29, "release": "abc", **kw}


def test_the_arms_closed_virtual_trades_go_out_by_hypothesis_with_hashed_ids(tmp_path: Path) -> None:
    shadow = tmp_path / "state" / "shadow"
    write(shadow / "2026-11-12.jsonl", [
        virtual("2026-11-12-O-1:runner", "runner", "retest", event="filled", exit_fill=None),
        virtual("2026-11-12-O-1:runner", "runner", "retest"),
        virtual("2026-11-12-O-2:runner", "runner", "rejection"),
        virtual("2026-11-12-trap-SPY-10:42-call-a level name", "trap", "trap"),
        virtual("2026-11-12-reclaim_fast-SPY-11:02-call-x", "reclaim_fast", "reclaim_fast", exit_fill=None),   # never closed with a price
        virtual("2026-11-12-other", "an arm nobody registered", "retest"),
        {"ts": "2026-11-12T16:00:00+00:00", "event": "levels", "note": "not a trade"}])
    write(shadow / "notes.jsonl", [virtual("x", "trap", "trap")])                                             # not a session's file
    doc = build(tmp_path, [])
    assert paper_site.validate(doc) == []
    assert [(a["hyp"], len(a["trades"])) for a in doc["arms"]] == [("HYP-0044", 1), ("HYP-0045", 1), ("HYP-0046", 1)]
    t = doc["arms"][0]["trades"][0]
    assert t["pnl_usd"] == 29.94 and t["rop"] == round(29.94 / 100.03, 4) and t["session"] == "2026-11-12"
    assert t["opened_at"] == "2026-11-12T15:00:00+00:00" and t["closed_at"] == "2026-11-12T15:40:00+00:00"
    text = json.dumps(doc["arms"])
    for word in ("trap", "reclaim", "runner", "retest", "rejection", "level name", "release"):
        assert word not in text
    assert all(x["vid"].startswith("2026-11-12-V") for a in doc["arms"] for x in a["trades"])


def test_every_document_the_builder_can_make_passes_the_dashboards_schema_and_a_fault_in_it_is_caught(tmp_path: Path) -> None:
    doc = build(tmp_path, [closed("2026-11-18-O-1")])
    assert paper_site.validate(doc) == []
    assert paper_site.validate({**doc, "paper": False}) != []
    assert paper_site.validate({**doc, "equity": 1}) != []
    bad = json.loads(json.dumps(doc))
    bad["clone"]["trades"][0]["setup"] = "retest"
    assert paper_site.validate(bad) != []
    assert json.loads(paper_site.body(doc))["schema"] == "stocksdelta/paper-options"


@pytest.fixture
def sends(monkeypatch: pytest.MonkeyPatch) -> list[bytes]:
    out: list[bytes] = []

    def send(data: bytes, url: str, secret: str, bypass: str | None, tries: int = 3, deadline: float | None = None,
             key_id: str | None = None) -> tuple[bool, str]:
        out.append(data)
        return True, "HTTP 200"
    monkeypatch.setattr(publish, "send", send)
    monkeypatch.setattr(publish, "read_health", lambda url, bypass: ({"editions": {"paper_options": {"accepts": 1}}}, ""))
    return out


def run(tmp_path: Path, now: dt.datetime = NOW, env: dict[str, str] | None = None, dry_run: bool = False) -> int:
    journal = tmp_path / "journal.jsonl"
    if not journal.exists():
        write(journal, [closed("2026-11-18-O-1")])
        plan(tmp_path / "state", "2026-11-18-O-1")
        plan(tmp_path / "state", "2026-11-18-O-2")
    return paper_site.run(now, dry_run, ENV if env is None else env, journal, tmp_path / "state", tmp_path / "out", CFG)


def test_a_run_sends_once_then_only_when_the_trades_change_or_half_a_day_has_passed(tmp_path: Path, sends: list[bytes],
                                                                                       capsys: pytest.CaptureFixture[str]) -> None:
    assert run(tmp_path) == 0 and len(sends) == 1
    assert json.loads(sends[0])["clone"]["trades"][0]["trade_id"] == "2026-11-18-O-1"
    assert "1 clone trades (1 counted)" in capsys.readouterr().out
    assert run(tmp_path, NOW + dt.timedelta(minutes=5)) == 0 and len(sends) == 1                      # unchanged
    with (tmp_path / "journal.jsonl").open("a") as fh:
        fh.write(json.dumps(closed("2026-11-18-O-2")) + "\n")
    assert run(tmp_path, NOW + dt.timedelta(minutes=10)) == 0 and len(sends) == 2                     # a new trade
    assert run(tmp_path, NOW + dt.timedelta(hours=11)) == 0 and len(sends) == 2
    assert run(tmp_path, NOW + dt.timedelta(hours=13)) == 0 and len(sends) == 3                       # the heartbeat
    assert json.loads((tmp_path / "out" / "document.json").read_text())["schema_version"] == 1


def test_nothing_is_sent_on_a_dry_run_without_settings_from_a_shadow_host_or_to_a_site_that_does_not_take_it(
        tmp_path: Path, sends: list[bytes], monkeypatch: pytest.MonkeyPatch) -> None:
    assert run(tmp_path, dry_run=True) == 0
    assert run(tmp_path, env={}) == 0
    assert run(tmp_path, env={**ENV, "WT_ROLE": "shadow", "DASHBOARD_KEY_ID": ""}) == 0
    monkeypatch.setattr(publish, "read_health", lambda url, bypass: ({"editions": {"options_live": {"accepts": 3}}}, ""))
    assert run(tmp_path) == 0
    monkeypatch.setattr(publish, "read_health", lambda url, bypass: (None, "health unreadable"))
    assert run(tmp_path) == 0
    assert sends == []
    assert not (tmp_path / "out" / "site_accepts.json").exists()      # "no" is not remembered: asked again next run


def test_a_refused_send_is_a_failed_run_and_is_tried_again_and_a_fault_never_raises(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(publish, "read_health", lambda url, bypass: ({"editions": {"paper_options": {"accepts": 1}}}, ""))
    calls: list[int] = []

    def refuse(*a: Any, **kw: Any) -> tuple[bool, str]:
        calls.append(1)
        return False, "HTTP 422: {\"errors\": [\"/clone/trades/0/hyp\"]}"
    monkeypatch.setattr(publish, "send", refuse)
    assert run(tmp_path) == 1 and run(tmp_path, NOW + dt.timedelta(minutes=5)) == 1 and len(calls) == 2
    assert "/clone/trades" not in capsys.readouterr().err                                     # a code, never the body

    def boom(*a: Any, **kw: Any) -> dict[str, Any]:
        raise RuntimeError("a secret-looking message")
    monkeypatch.setattr(paper_site, "build", boom)
    assert run(tmp_path) == 2
    err = capsys.readouterr().err
    assert "RuntimeError" in err and "secret-looking" not in err


def test_a_document_that_fails_the_schema_is_never_sent(tmp_path: Path, sends: list[bytes], monkeypatch: pytest.MonkeyPatch) -> None:
    real = paper_site.build
    monkeypatch.setattr(paper_site, "build", lambda *a, **kw: {**real(*a, **kw), "equity": 100_000})
    assert run(tmp_path) == 2 and sends == []
    assert not (tmp_path / "out" / "document.json").exists()


def test_the_history_rides_the_options_live_job_and_cannot_change_its_result(monkeypatch: pytest.MonkeyPatch) -> None:
    ran: list[bool] = []
    monkeypatch.setattr(live, "_publish", lambda a: 7)

    def history(now: Any = None, dry_run: bool = False, **kw: Any) -> int:
        ran.append(dry_run)
        raise RuntimeError("no fault here may reach the positions job")
    monkeypatch.setattr(paper_site, "run", history)
    assert live.main(["--dry-run"]) == 7 and ran == [True]


def test_the_module_reads_files_only_and_imports_no_order_path() -> None:
    src = Path(paper_site.__file__).read_text()
    for word in ("wt.oms", "wt.brokers", "wt.live", "TradingClient", "alpaca", "submit", ".place(", "requests"):
        assert word not in src.replace("wt.brokers.alpaca_options_paper.keys", ""), word
