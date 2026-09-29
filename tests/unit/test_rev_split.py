"""H-REV: REV-1 warms up on prior-session bars rescaled to day d's share basis, so a 10:1 forward split between p and
d does not make d look oversold."""
import datetime as dt
import importlib.util
import sys
from pathlib import Path

import pandas as pd
from spec_bars import minute_bars

from wt.data.corpactions import SplitFactors

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
_spec = importlib.util.spec_from_file_location("r3_intraday", ROOT / "scripts/r3_intraday.py")
ri = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ri)

D, P = dt.date(2024, 3, 1), dt.date(2024, 2, 29)


def prev_rows(px):
    """A quiet prior session: closes cycle px, px + 1%, px + 2% (raw, before the split)."""
    return [(px * (1 + 0.01 * (i % 3)),) * 4 + (20_000,) for i in range(390)]


def today_rows():
    """Three red 5-minute buckets making new lows (a flush on the post-split basis), then a bounce."""
    rows, px = [], 50.10
    for b in range(3):
        for m in range(5):
            lo = 49.40 if (b, m) == (2, 2) else px - 0.02
            rows.append((px, px + 0.01, lo, px - 0.01, 40_000))
            px -= 0.01
    rows += [(49.96, 50.30, 49.95, 50.20, 40_000)] + [(50.2, 50.3, 50.1, 50.2, 40_000)] * 200
    return rows


class Client:
    def bars(self, symbols, timeframe, start, end, feed="sip"):
        day = pd.Timestamp(start).tz_convert("America/New_York").date()
        b = minute_bars(prev_rows(500.0), day=str(P)) if day == P else minute_bars(today_rows(), day=str(D))
        return b.assign(symbol=symbols[0])


def run(monkeypatch, splits):
    import wt.signals.spec_setups as ss
    monkeypatch.setattr(ss, "curve_at", lambda m, curve=None: 0.5)
    monkeypatch.setattr(ri, "adv", lambda daily, splits, s, d, n: 8_000_000.0 if n == 5 else 1_000_000.0)
    monkeypatch.setattr(ri, "volume_curve", lambda: None)
    return ri.rev_day(Client(), D, P, None, splits, lambda s, t: 0.01, "16:00", {}, ["SPLT"])


def test_a_forward_split_between_p_and_d_does_not_look_oversold(monkeypatch):
    raw_view = SplitFactors(pd.DataFrame(columns=["symbol", "date", "f"]))          # what the old code saw
    _, signalled = run(monkeypatch, raw_view)
    assert signalled == {"SPLT"}                          # $500 -> $50 unadjusted: a fake 90% crash signals

    split = SplitFactors(pd.DataFrame({"symbol": "SPLT", "date": [dt.date(2024, 1, 2), D], "f": [10.0, 1.0]}))
    cands, signalled = run(monkeypatch, split)
    assert signalled == set() and cands == []             # on d's basis the prior session is a quiet $50-51


def test_asof_basis_rescales_prices_and_volume():
    b = minute_bars(prev_rows(500.0)[:3], day=str(P))
    out = ri.asof_basis(b, 0.1)
    assert abs(out.c.iloc[0] - 50.0) < 1e-9 and abs(out.v.iloc[0] - 200_000) < 1e-6
    assert ri.asof_basis(b, 1.0) is b
