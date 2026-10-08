"""Strategy B is one rule read in three places: the backtest, the nightly forward test and the paper runner.

These tests hold the three together where they agree and write down, as assertions, the two places where they do
not. Nothing here changes a result: a difference that matters is for a decision record, not for a test to hide.
"""
import datetime as dt
import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from test_setups_causal import synth

from wt.live import runner_b
from wt.signals import setups

ROOT = Path(__file__).resolve().parents[2]
D = dt.date(2026, 3, 2)
SESSIONS = [d.date() for d in pd.bdate_range(end=D, periods=21)]            # 20 prior sessions and D


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ft = load("forward_test")


def day_bars(d: dt.date, n: int = 390) -> pd.DataFrame:
    rng = np.random.default_rng(d.toordinal())
    c = 500 * (1 + np.cumsum(rng.normal(0, 0.0004, n)))
    t = pd.date_range(pd.Timestamp(f"{d} 09:30", tz="America/New_York").tz_convert("UTC"), periods=n, freq="1min")
    return pd.DataFrame({"t": t, "o": np.r_[c[0], c[:-1]], "h": c + 0.05, "l": c - 0.05, "c": c, "v": 1e5})


class Client:
    """Minute bars by session; `short` sessions return a stub of 30 bars, as a half-loaded day does."""

    def __init__(self, short: tuple[dt.date, ...] = ()):
        self.short = set(short)

    def bars(self, symbols, tf, start, end, feed="sip") -> pd.DataFrame:
        d = pd.Timestamp(start).tz_convert("America/New_York").date()
        return day_bars(d, 30 if d in self.short else 390)


def backtest_inputs(client: Client, d: dt.date) -> tuple[float, float]:
    """Sigma and the prior close as scripts/g1_etf.py and scripts/holdout_b.py compute them: a 14-day rolling mean
    over the days that have more than 60 bars, shifted one day. A copy, because those scripts run on import."""
    days = [x for x in SESSIONS if x <= d]
    by_day = {x: client.bars(["QQQ"], "1Min", f"{x} 09:30-05:00", None) for x in days}
    absmove = pd.Series({x: float(np.mean(np.abs(g.c.iloc[29::30].to_numpy() / g.o.iloc[0] - 1)))
                         for x, g in by_day.items() if len(g) > 60})
    return float(absmove.rolling(14).mean().shift(1)[d]), float(by_day[days[days.index(d) - 1]].c.iloc[-1])


def forward_inputs(client: Client, d: dt.date, monkeypatch) -> tuple[float, float]:
    seen = {}

    def capture(bars, sigma, prev_close, **kw):
        seen.update(sigma=sigma, prev_close=prev_close)
    monkeypatch.setattr(ft.setups, "b_intraday_momentum", capture)
    assert ft.run_B(client, d, SESSIONS) == []
    return seen["sigma"], seen["prev_close"]


def test_the_three_readings_agree_when_every_prior_session_is_whole(monkeypatch):
    c = Client()
    live = runner_b.LiveData(c).sigma_and_prev_close(D, SESSIONS)
    assert live == pytest.approx(forward_inputs(c, D, monkeypatch), rel=0, abs=0)       # the same arithmetic, exactly
    assert live == pytest.approx(backtest_inputs(c, D), rel=1e-12)
    assert 0.0005 < live[0] < 0.02


def test_a_short_prior_session_is_where_the_backtest_and_the_desk_part(monkeypatch):
    """Known difference, recorded: the desk averages the valid sessions among the last 14 (13 here); the backtest
    averages the last 14 valid days, reaching one day further back. The prior close differs too when the short
    session is yesterday. Whether to align them is a decision, since either changes a registered calculation."""
    c = Client(short=(SESSIONS[-5],))
    live = runner_b.LiveData(c).sigma_and_prev_close(D, SESSIONS)
    assert live == forward_inputs(c, D, monkeypatch)                                # desk and forward still agree
    back = backtest_inputs(c, D)
    assert live[1] == back[1] and live[0] != pytest.approx(back[0], rel=1e-9)
    valid = [x for x in SESSIONS[:-1] if x != SESSIONS[-5]]
    per_day = [float(np.mean(np.abs(day_bars(x).c.iloc[29::30].to_numpy() / day_bars(x).o.iloc[0] - 1))) for x in valid]
    assert live[0] == pytest.approx(np.mean(per_day[-13:])) and back[0] == pytest.approx(np.mean(per_day[-14:]))


def test_the_runner_sees_a_signal_on_the_bar_it_closes_and_the_backtest_one_bar_later():
    hits = 0
    for seed in range(40):
        b = synth(seed=seed)
        full = setups.b_intraday_momentum(b, 0.002, 9.95)
        if full is None:
            continue
        hits += 1
        i = full.bar_index
        live = setups.b_intraday_momentum(b.iloc[: i + 1].reset_index(drop=True), 0.002, 9.95, include_last=True)
        assert live is not None and (live.bar_index, live.trigger, live.stop) == (i, full.trigger, full.stop)
        assert setups.b_intraday_momentum(b.iloc[: i + 1].reset_index(drop=True), 0.002, 9.95) is None   # a backtest waits
        assert setups.b_intraday_momentum(b.iloc[:i].reset_index(drop=True), 0.002, 9.95, include_last=True) is None
        nxt = setups.b_intraday_momentum(b.iloc[: i + 2].reset_index(drop=True), 0.002, 9.95)
        assert nxt is not None and (nxt.bar_index, nxt.trigger, nxt.stop) == (i, full.trigger, full.stop)
    assert hits >= 5


def test_only_the_first_qualifying_mark_of_a_session_is_ever_a_signal():
    """Recorded behaviour, not a judgement: the rule returns the first half-hour mark that qualifies, so a later
    mark is never returned once an earlier one has qualified. The runner acts only on the newest bar, so a first
    mark that was blocked or missed is the session's only chance."""
    n = 120
    c = np.where(np.arange(n) >= 28, 503.0, 500.5)                              # above the boundary from 09:58 on
    b = pd.DataFrame({"t": pd.date_range("2026-03-02 14:30", periods=n, freq="1min", tz="UTC"),
                      "o": c, "h": c + 0.1, "l": c - 0.1, "c": c, "v": 1e4})
    for upto in (30, 60, 90, 120):
        s = setups.b_intraday_momentum(b.iloc[:upto].reset_index(drop=True), 0.004, 500.0, include_last=True)
        assert s is not None and s.bar_index == 29                              # always the 09:59 bar, never a later mark
