"""Performance analytics (wt.analytics.performance): hand-computed values and small-sample honesty."""
import pytest

from wt.analytics import performance as perf


def t(r, day="2026-10-01", **kw):
    return {"event": "trade_closed", "R": r, "day": day, "trade_id": f"{day}-{r}", **kw}


def test_hand_computed_small_sample_suppresses_ci_pf_and_sharpe():
    trades = [t(2.0), t(-1.0), t(1.0), t(-1.0, exit_price_estimated=True), t(0.5, origin="orphan")]
    s = perf.stats(trades, sessions=40)
    assert s["n"] == 3 and s["excluded_estimated"] == 1
    assert s["win_rate"] == pytest.approx(2 / 3, abs=1e-4)
    assert s["avg_win_r"] == 1.5 and s["avg_loss_r"] == -1.0 and s["expectancy_r"] == pytest.approx(0.6667, abs=1e-4)
    assert s["sample_ok"] is False and s["ci_low"] is None and s["profit_factor"] is None and s["sharpe"] is None


def test_enough_trades_gives_a_stable_ci_pf_and_sharpe():
    trades = [t(1.0 if i % 3 else -1.0, day=f"2026-{10 + i // 28:02d}-{i % 28 + 1:02d}") for i in range(30)]
    a, b = perf.stats(trades, sessions=45), perf.stats(trades, sessions=45)
    assert a["sample_ok"] and a == b                                    # seeded from the data: no jitter
    assert a["ci_low"] < a["expectancy_r"] < a["ci_high"]
    assert a["profit_factor"] == pytest.approx(20 / 10)
    assert a["sharpe"] is not None


def test_no_losses_is_flagged_not_infinite():
    s = perf.stats([t(1.0, day=f"2026-10-{i + 1:02d}") for i in range(20)], sessions=10)
    assert s["profit_factor"] is None and s["pf_no_losses"] is True and s["sharpe"] is None


def test_curve_uses_the_virtual_account_and_tracks_drawdowns():
    trades = [t(1.0, virtual={"equity": 606.0}), t(-2.0, virtual={"equity": 594.0}), t(0.5, virtual={"equity": 597.0})]
    c = perf.curve(trades)
    assert [p["equity_pct"] for p in c] == [1.0, -1.0, -0.5]
    assert [p["cum_r"] for p in c] == [1.0, -1.0, -0.5]
    assert c[1]["dd_pct"] == pytest.approx(-1.98, abs=0.01) and c[1]["dd_r"] == -2.0
    assert perf.max_drawdown(c) == (c[1]["dd_pct"], -2.0)


def test_curve_is_thinned_but_keeps_its_ends():
    trades = [t(0.1, day=f"d{i}") for i in range(1000)]
    c = perf.curve(trades, max_points=100)
    assert len(c) == 100 and c[-1]["cum_r"] == pytest.approx(100.0)


def test_histogram_bins():
    h = perf.histogram([t(-5), t(-1), t(0.2), t(1.5), t(9)])
    assert sum(b["count"] for b in h) == 5 and h[0] == {"bin": "< -3", "count": 1} and h[-1]["count"] == 1



def test_a_zero_r_trade_is_breakeven_not_a_loss():
    s = perf.stats([t(1.0), t(0.0), t(-1.0)])
    assert s["win_rate"] == pytest.approx(1 / 3, abs=1e-4) and s["avg_loss_r"] == -1.0


def test_sharpe_counts_only_clean_sessions_and_drops_estimated_days():
    days = [f"2026-{10 + i // 28:02d}-{i % 28 + 1:02d}" for i in range(30)]
    trades = [t(2.0 if i % 2 else -1.0, day=d) for i, d in enumerate(days)]
    base = perf.stats(trades, session_days=set(days))
    padded = perf.stats(trades, session_days=set(days) | {f"2026-12-{i + 1:02d}" for i in range(20)})
    assert base["sharpe"] > padded["sharpe"]                        # idle clean sessions dilute it, KILL days don't
    assert perf.daily_series(trades + [t(0.5, day="2026-12-30", exit_price_estimated=True)],
                             set(days) | {"2026-12-30"}) == perf.daily_series(trades, set(days))
    assert perf.stats(trades, session_days=set(days[:10]))["sharpe"] is None        # under 30 sessions


def test_the_worst_drawdown_is_measured_before_thinning():
    trades = [t(0.1, day=f"d{i}") for i in range(400)] + [t(-8.0, day="trough")] + \
        [t(0.1, day=f"e{i}") for i in range(400)]
    full = perf.curve(trades, max_points=10**9)
    assert perf.max_drawdown(full)[1] == pytest.approx(-8.0)
    assert len(perf.thin(full)) == 400
