"""Day-level admission (RSK-01..07): settled cash, 3-loser and -2R day stops, attempt chains, priority."""
import pandas as pd

from wt.backtest.portfolio import Candidate, admit_day


class T:                                    # minimal Trade stand-in
    def __init__(self, entry_time, exit_time, qty, entry):
        self.entry_time, self.qty, self.entry = entry_time, qty, entry
        self.exits = [(exit_time, entry, qty, "x")]


def ts(m):
    return pd.Timestamp("2024-03-01 14:30", tz="UTC") + pd.Timedelta(minutes=m)


def cand(chain, t_in, t_out, r, qty=40, px=5.0, attempt=1, priority=5):
    def resim(cash, qty=qty, px=px):
        q = min(qty, int(cash // px))
        return (T(ts(t_in), ts(t_out), q, px), r) if q >= 1 else (None, None)
    return Candidate(chain, attempt, priority, ts(t_in), resim)


def test_cash_is_not_reused_the_same_day():
    res = admit_day([cand("A", 1, 3, 1.0, qty=100), cand("B", 5, 6, 1.0, qty=100)], equity=600)
    assert [c.chain for c, _, _ in res.admitted] == ["A", "B"]
    assert res.admitted[1][1].qty == 20                                 # 600 - 500 = 100 left -> 20 shares
    res2 = admit_day([cand("A", 1, 3, 1.0, qty=120), cand("B", 5, 6, 1.0)], equity=600)
    assert [(c.chain, r) for c, r in res2.skipped] == [("B", "unfunded")]


def test_three_consecutive_losers_stop_the_day():
    cs = [cand(s, i * 10, i * 10 + 5, -1.0 if i < 3 else 2.0, qty=10) for i, s in enumerate("ABCD")]
    res = admit_day(cs, equity=10_000, max_daily_loss_R=99)
    assert [c.chain for c, _, _ in res.admitted] == ["A", "B", "C"]
    assert res.skipped[0][1] == "day_stop_consecutive_losers"


def test_minus_2R_day_stop_counts_only_exited_trades():
    a, b = cand("A", 0, 5, -1.2, qty=10), cand("B", 2, 8, -1.0, qty=10)
    d = cand("D", 6, 20, 1.0, qty=10)                                    # enters while B is still open: only A counts
    c = cand("C", 10, 12, 1.0, qty=10)                                   # by 10:40 A and B have exited: -2.2R
    res = admit_day([a, b, c, d], equity=10_000, max_consecutive_losers=99)
    assert [x.chain for x, _, _ in res.admitted] == ["A", "B", "D"]
    assert res.skipped == [(c, "day_stop_loss_R")]


def test_second_attempt_needs_the_first():
    res = admit_day([cand("A", 0, 5, 1.0, qty=200), cand("A", 10, 15, 1.0, attempt=2)], equity=100)
    assert [x.attempt for x, _, _ in res.admitted] == [1] and res.skipped[-1][1] == "unfunded"
    res = admit_day([cand("A", 0, 5, 1.0, qty=200, px=500.0), cand("A", 10, 15, 1.0, attempt=2)], equity=100)
    assert [r for _, r in res.skipped] == ["unfunded", "earlier_attempt_not_admitted"]


def test_primary_is_funded_first_on_coincident_entries():
    res = admit_day([cand("X", 1, 3, 1.0, qty=100, priority=3), cand("P", 1, 3, 1.0, qty=100, priority=0)], equity=600)
    assert res.admitted[0][0].chain == "P" and res.admitted[0][1].qty == 100 and res.admitted[1][1].qty == 20
