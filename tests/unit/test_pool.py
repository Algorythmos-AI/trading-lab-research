"""Causal candidate pool (POOL-01..04) with a fake data client, offline."""
import datetime as dt

import numpy as np
import pandas as pd

from wt.data.corpactions import SplitFactors
from wt.scanner.pool import DailyIndex, PoolConfig, build_day

D, P = dt.date(2024, 3, 1), dt.date(2024, 2, 29)
ET = "America/New_York"


def ts(day, hhmm):
    return pd.Timestamp(f"{day} {hhmm}", tz=ET).tz_convert("UTC")


def daily_rows():
    rows = []
    for s, px in (("GAPR", 4.0), ("FLAT", 10.0), ("SPLT", 0.30), ("PENY", 0.50)):
        for i in range(260):
            day = P - dt.timedelta(days=259 - i)
            c = px * (1 + 0.002 * i) if s != "SPLT" else px
            rows.append({"symbol": s, "date": day, "o": c, "h": c * 1.01, "l": c * 0.99, "c": c, "v": 1e6})
    return pd.DataFrame(rows)


class FakeClient:
    def __init__(self):
        self.calls = []

    def bars(self, symbols, timeframe, start, end, feed="sip", adjustment="raw"):
        self.calls.append((tuple(symbols), start, end))
        out = []
        prices = {"GAPR": 4.0 * 1.52 * 1.20, "FLAT": 10.0 * 1.52 * 1.01, "SPLT": 3.30, "PENY": 0.55}
        t0, t1 = pd.Timestamp(start), pd.Timestamp(end)
        for s in symbols:
            px = prices.get(s)
            if px is None:
                continue
            for t in pd.date_range(max(t0, ts(D, "04:00")), t1, freq="1min"):
                late = t >= ts(D, "09:25")                                # a print AFTER the snapshot: must be ignored
                c = px * (3.0 if late else 1.0)
                out.append({"symbol": s, "t": t, "o": c, "h": c * 1.002, "l": c * 0.998, "c": c, "v": 2000, "n": 1, "vw": c})
        return pd.DataFrame(out, columns=["symbol", "t", "o", "h", "l", "c", "v", "n", "vw"])

    def news(self, symbols, start, end):
        return [{"symbols": ["GAPR"], "headline": "Gapr Receives FDA Approval For Lead Drug", "created_at": "2024-03-01T12:00:00Z"}]


class FakeCache:
    def __init__(self):
        self.rows = []

    def missing(self, symbols, dates):
        have = {(r["symbol"], r["date"]) for r in self.rows}
        return [(s, d) for s in symbols for d in dates if (s, d) not in have]

    def add(self, rows):
        self.rows += rows

    def get(self, symbols, dates):
        df = pd.DataFrame(self.rows)
        return df[df.symbol.isin(symbols) & df.date.isin(dates)] if len(df) else df


class FakeShares:
    def asof(self, s, d):
        return {"GAPR": 8e6, "FLAT": 30e6}.get(s)


def split_factors():
    rows = [{"symbol": "SPLT", "date": P, "f": 0.1}, {"symbol": "SPLT", "date": D, "f": 1.0}]
    return SplitFactors(pd.DataFrame(rows))


def test_pool_is_causal_split_aware_and_complete():
    daily = DailyIndex(daily_rows())
    cfg = PoolConfig()
    sessions = [P - dt.timedelta(days=k) for k in range(25, 0, -1)] + [P]
    cands, pmb, st = build_day(D, P, FakeClient(), daily, {"GAPR", "FLAT", "SPLT", "PENY"}, SplitFactors(pd.DataFrame(columns=["symbol", "date", "f"])),
                               FakeCache(), FakeShares(), sessions, cfg, split_refresh=lambda syms: split_factors())
    got = cands.set_index("symbol")
    assert "PENY" not in got.index                                   # $0.55 is outside the $1-30 band
    assert "FLAT" not in got.index                                   # +1.1% gap: below the 4% pool floor
    assert st.split_checked == 1                                     # SPLT's raw +1000% triggered the split check
    s = got.loc["SPLT"]                                              # 1:10 reverse split: prior close 0.30 -> 3.00
    assert abs(s.prev_close_adj - 3.00) < 1e-9 and abs(s.gap_pct - 10.0) < 1e-9
    g = got.loc["GAPR"]
    prev = daily.on(P).c["GAPR"]
    assert abs(g.price_0925 - 4.0 * 1.52 * 1.20) < 1e-9               # the 09:25 price ignores the 3x prints after 09:25
    assert abs(g.gap_pct - 100 * (g.price_0925 / prev - 1)) < 1e-9
    assert g.catalyst_status == "qualifying" and g.catalyst_category == "fda_approval"
    assert g.float_shares == 8e6 and bool(g.trend_ok)
    assert pmb.t.max() < ts(D, "09:25")                                # saved pre-market bars end before 09:25
