"""Paper-only lock (M1), pre-trade guard (M3) and virtual-account hardening (C1, C4, M2)."""
from __future__ import annotations

import datetime as dt
import json

import pytest

from wt.core.safety import PaperOnlyError, assert_paper, env_violations, paper_violations
from wt.core.types import Order
from wt.risk.pretrade import Context, Limits, PreTradeGuard, load_limits
from wt.risk.virtual_account import StateError, VirtualAccount, reset_latch

PAPER = "https://paper-api.alpaca.markets"
OK_ENV = {"MODE": "paper", "LIVE_TRADING_ENABLED": "false", "APCA_API_BASE_URL": PAPER}


# ---- paper-only lock ----------------------------------------------------------------------------------------------

def test_paper_lock_accepts_only_a_fully_paper_setup():
    assert paper_violations(PAPER, "PA3ABCDEFG", OK_ENV) == []


@pytest.mark.parametrize("env, url, acct, why", [
    ({**OK_ENV, "MODE": "backtest"}, PAPER, "PA3ABCDEFG", "MODE"),
    ({**OK_ENV, "LIVE_TRADING_ENABLED": "true"}, PAPER, "PA3ABCDEFG", "LIVE_TRADING_ENABLED"),
    ({**OK_ENV, "APCA_API_BASE_URL": "https://api.alpaca.markets"}, PAPER, "PA3ABCDEFG", "APCA_API_BASE_URL"),
    (OK_ENV, "https://api.alpaca.markets", "PA3ABCDEFG", "paper endpoint"),
    (OK_ENV, PAPER, "3ABCDEFG", "not a paper account"),
])
def test_paper_lock_refuses_anything_live(env, url, acct, why):
    v = paper_violations(url, acct, env)
    assert any(why in x for x in v), v


def test_assert_paper_raises(monkeypatch):
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "1")
    with pytest.raises(PaperOnlyError):
        assert_paper(PAPER, "PA1")
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "false")
    assert env_violations() == [] or all("APCA" in x for x in env_violations())


# ---- pre-trade guard ----------------------------------------------------------------------------------------------

NOW = dt.datetime(2026, 9, 30, 10, 30, tzinfo=dt.UTC)
L = Limits(allowlist=frozenset({"QQQM"}), max_qty=10, max_notional=2000, max_entries_per_day=1, max_orders_per_day=20)


def ctx(**kw) -> Context:
    base = dict(now=NOW, position_qty=0, open_orders=[], kill=False, latched=False,
                session_open=NOW.replace(hour=9), session_close=NOW.replace(hour=16), entries_today=0, orders_today=0,
                quote=(250.0, 250.02, NOW), environ={"MODE": "paper"})
    return Context(**{**base, **kw})


def entry(qty=2, sym="QQQM", limit=250.2):
    return Order("wt-B-1", sym, "buy", qty, "stop_limit", limit_price=limit, stop_price=250.0)


def failed(r) -> set[str]:
    return {c.name for c in r.failed}


def test_guard_passes_a_normal_entry():
    r = PreTradeGuard(L).evaluate(entry(), ctx(), protective=False)
    assert r.ok, r.summary()


@pytest.mark.parametrize("order, c, name", [
    (entry(sym="TSLA"), {}, "symbol allowlist"),
    (entry(qty=11), {}, "hard quantity cap"),
    (entry(qty=9, limit=250.2), {}, "hard notional cap"),
    (entry(), {"kill": True}, "kill switch off"),
    (entry(), {"latched": True}, "loss latch clear"),
    (entry(), {"now": NOW.replace(hour=17)}, "market open"),
    (entry(), {"entries_today": 1}, "entries per day"),
    (entry(), {"orders_today": 20}, "orders per day"),
    (entry(), {"position_qty": 2}, "flat before entry"),
    (entry(), {"environ": {"MODE": "backtest"}}, "paper lock"),
])
def test_guard_blocks_unsafe_entries(order, c, name):
    assert name in failed(PreTradeGuard(L).evaluate(order, ctx(**c), protective=False))


def test_protective_orders_ignore_kill_latch_and_hours_but_never_oversell():
    stop = Order("wt-B-2", "QQQM", "sell", 2, "stop", stop_price=249.0, tif="gtc")
    g = PreTradeGuard(L)
    assert g.evaluate(stop, ctx(position_qty=2, kill=True, latched=True, now=NOW.replace(hour=20)), True).ok
    assert "sell within long position" in failed(g.evaluate(stop, ctx(position_qty=1), True))
    resting = Order("wt-B-3", "QQQM", "sell", 2, "stop", stop_price=249.0)
    assert "sell within long position" in failed(g.evaluate(stop, ctx(position_qty=2, open_orders=[resting]), True))


def test_execution_checks_warn_but_never_block_b():
    stale = ctx(quote=(250.0, 251.0, NOW - dt.timedelta(seconds=30)))
    r = PreTradeGuard(L).evaluate(entry(limit=252.0), stale, protective=False)
    assert r.ok and {w.split(":")[0] for w in r.summary()["warnings"]} == {"quote age", "spread", "price collar"}


def test_committed_risk_limits_load():
    lim = load_limits("B")
    assert lim.allowlist == frozenset({"QQQM"}) and lim.max_entries_per_day == 1


# ---- virtual account --------------------------------------------------------------------------------------------

D = dt.date(2026, 9, 30)


def test_round_trip_is_booked_once_and_counted_at_entry(tmp_path):
    va = VirtualAccount()
    assert va.count_entry(D, "t1") and not va.count_entry(D, "t1")
    assert va.record_round_trip(D, D + dt.timedelta(days=1), 500.0, 498.0, trade_id="t1")
    assert not va.record_round_trip(D, D + dt.timedelta(days=1), 500.0, 498.0, trade_id="t1")
    assert va.trades_by_day[D.isoformat()] == 1 and va.equity == 598.0


def test_latch_survives_deleting_or_tampering_with_the_file(tmp_path):
    p = tmp_path / "va.json"
    va = VirtualAccount()
    va.record_round_trip(D, D + dt.timedelta(days=1), 500.0, 480.0, trade_id="t1")      # -20 > 2%
    assert va.latched
    va.save(p)
    assert (tmp_path / "va.json.latch").exists()
    raw = json.loads(p.read_text())
    raw["latched"] = False
    p.write_text(json.dumps(raw))
    with pytest.raises(StateError, match="sentinel"):
        VirtualAccount.load(p)
    p.unlink()
    with pytest.raises(StateError, match="missing"):
        VirtualAccount.load(p)


def test_corrupt_state_refuses_to_arm(tmp_path):
    p = tmp_path / "va.json"
    p.write_text("{not json")
    with pytest.raises(StateError, match="unreadable"):
        VirtualAccount.load(p)


def test_reset_latch_needs_a_reason_and_keeps_history(tmp_path):
    p = tmp_path / "va.json"
    va = VirtualAccount()
    va.latch("daily loss limit -2%")
    va.save(p)
    with pytest.raises(ValueError):
        reset_latch(p, "  ")
    after = reset_latch(p, "reviewed the gap-through; resuming")
    assert not after.latched and after.latch_history[-1]["reason"] == "daily loss limit -2%"
    assert not (tmp_path / "va.json.latch").exists() and not VirtualAccount.load(p).latched


def test_old_state_files_still_load(tmp_path):
    p = tmp_path / "va.json"
    p.write_text(json.dumps({"start_equity": 600.0, "equity": 600.0, "settled_cash": 600.0, "unsettled": [],
                             "high_water": 600.0, "latched": False, "latch_reason": "", "day_pnl": {},
                             "trades_by_day": {}}))
    assert VirtualAccount.load(p).counted_entries == []
