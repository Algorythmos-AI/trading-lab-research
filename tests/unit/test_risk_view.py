"""wt.analytics.risk_view: the published limits match the code that enforces them, and usage is computed right."""
import datetime as dt

from wt.analytics import risk_view as rv
from wt.live import runner_b
from wt.risk.virtual_account import VirtualAccount

D = dt.date(2026, 10, 1)


def _latches_at(loss_frac: float, kind: str) -> str:
    va = VirtualAccount()
    if kind == "day":
        va.day_pnl[D.isoformat()] = -loss_frac * va.equity
    elif kind == "week":
        for i in range(4):   # spread over 4 days so no single day trips the daily latch first
            va.day_pnl[(D - dt.timedelta(days=i)).isoformat()] = -loss_frac * va.equity / 4
    else:
        va.high_water, va.equity = va.equity, va.equity * (1 - loss_frac)
    va.check_limits(D)
    return va.latch_reason


def test_declared_loss_latches_match_the_virtual_account():
    for kind, pct in (("day", rv.DAY_LOSS_PCT), ("week", rv.WEEK_LOSS_PCT), ("dd", rv.DRAWDOWN_PCT)):
        assert _latches_at(pct / 100 * 1.001, kind), f"{kind}: should latch at {pct}%"
        assert not _latches_at(pct / 100 * 0.98, kind), f"{kind}: should not latch below {pct}%"


def test_declared_risk_per_trade_matches_the_runner():
    assert rv.RISK_PER_TRADE_PCT == runner_b.RISK_PCT


def test_view_reports_usage_and_states(tmp_path):
    acct = {"equity": 600.0, "high_water": 612.0, "latched": False, "day_pnl": {D.isoformat(): -7.2,
            (D - dt.timedelta(days=3)).isoformat(): -6.0, (D - dt.timedelta(days=9)).isoformat(): -50.0},
            "trades_by_day": {D.isoformat(): 1}, "latch_history": [{"at": "2026-09-01T00:00:00+00:00"}]}
    v = rv.view(D, acct, kill=True)
    rows = {r["id"]: r for r in v["limits"]}
    assert rows["day_loss"]["used"] == "-1.20%" and rows["day_loss"]["used_pct"] == 60.0
    assert rows["day_loss"]["state"] == "warn"
    assert rows["week_loss"]["used_pct"] == 55.0                    # the 9-day-old loss is outside the week
    assert rows["drawdown"]["used"] == "-1.96%" and rows["drawdown"]["state"] == "ok"
    assert rows["entries_per_day"]["used"] == "1" and rows["entries_per_day"]["state"] == "at_limit"
    assert rows["allowlist"]["limit"] == "QQQM" and len(rows["max_qty"]["source_sha"]) == 12
    assert v["controls"] == {"kill": True, "latched": False, "latch_reason": None, "latch_resets": 1,
                             "last_reset": "2026-09-01T00:00:00+00:00", "entries_allowed": False}


def test_view_without_an_account_is_unknown_not_zero():
    v = rv.view(D, None, kill=False)
    rows = {r["id"]: r for r in v["limits"]}
    assert rows["day_loss"]["used"] is None and rows["day_loss"]["state"] == "n/a"
    assert v["controls"]["latched"] is None and v["used_today"]["entries"] is None


def test_gains_use_none_of_a_loss_limit():
    v = rv.view(D, {"equity": 600.0, "high_water": 600.0, "day_pnl": {D.isoformat(): 30.0}}, kill=False)
    assert {r["id"]: r for r in v["limits"]}["day_loss"]["used_pct"] == 0.0



def test_a_latch_sentinel_is_reported_latched_even_if_the_account_says_not(tmp_path):
    (tmp_path / "va.json.latch").write_text("daily loss limit -2%")
    v = rv.view(D, {"equity": 600.0, "high_water": 600.0, "latched": False}, kill=False, va_path=tmp_path / "va.json")
    assert v["controls"]["latched"] is True and v["controls"]["entries_allowed"] is False
    assert v["controls"]["latch_reason"] == "latch sentinel present"


def test_a_broken_risk_yaml_still_gives_a_view(tmp_path):
    bad = tmp_path / "risk.yaml"
    bad.write_text("B: [unclosed")
    rows = {r["id"]: r for r in rv.view(D, None, kill=False, risk_yaml=bad)["limits"]}
    assert rows["max_qty"]["limit"] == "?" and rows["day_loss"]["limit"] == "-2% of equity"
