"""Level 1 + Time & Sales proxies (SPEC-0001 TAP-01..06; owner clarification C10). DESCRIPTIVE ONLY: these features
are recorded on every trade and analysed afterwards. None of them decides a trade in round 3.

Inputs are SIP trades (t, price, size) and NBBO quotes (t, bid, ask, bid size, ask size) around a trigger time.
Trade side uses the quote rule: at or above the prevailing ask = buy, at or below the bid = sell. Trades inside
the spread use the tick rule (up-tick = buy).

Features (60 s before the trigger, 30 s after the entry):
  tape_speed_ratio         trades/s in the 60 s before the trigger vs the prior 5 minutes         (TAP-01)
  buy_initiated_share      buy-classified volume / total volume, 60 s before the trigger          (TAP-02)
  green_print_surge        buy volume at/through the level in the 60 s before, vs prior 5-min rate (TAP-03)
  price_per_1k_shares      price change per 1,000 buy shares in the 60 s before (low = absorption) (TAP-03)
  ask_size_depletion       ask size at the level at the start of the 60 s vs just before the break (TAP-03)
  bid_stepups              count of NBBO bid increases in the 60 s before                          (TAP-04)
  post_entry_freeze        trades/s in the 30 s after entry / trades/s in the 60 s before          (TAP-05)
10-second bars (TAP-06): OHLCV from trades for a descriptive micro-pullback entry comparison.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def classify_sides(trades: pd.DataFrame, quotes: pd.DataFrame) -> np.ndarray:
    """+1 buy / -1 sell / 0 unknown per trade (quote rule, then tick rule). trades: t, price, size;
    quotes: t, bid, ask. Both sorted by t."""
    if trades.empty:
        return np.array([], int)
    tq = pd.merge_asof(trades.sort_values("t"), quotes.sort_values("t")[["t", "bid", "ask"]], on="t", direction="backward")
    p, b, a = tq.price.to_numpy(float), tq.bid.to_numpy(float), tq.ask.to_numpy(float)
    side = np.zeros(len(p), int)
    side[(~np.isnan(a)) & (p >= a - 1e-9)] = 1
    side[(~np.isnan(b)) & (p <= b + 1e-9)] = -1
    diff = np.r_[0.0, np.diff(p)]
    last = 0
    for i in range(len(p)):                                  # tick rule for trades inside the spread
        if side[i] == 0:
            if diff[i] > 0:
                last = 1
            elif diff[i] < 0:
                last = -1
            side[i] = last
    return side


def features(trades: pd.DataFrame, quotes: pd.DataFrame, trigger_time: pd.Timestamp, level: float,
             entry_time: pd.Timestamp | None = None) -> dict:
    """Descriptive tape/Level-1 features around one trigger (see module docstring). Missing data -> NaN."""
    nan = float("nan")
    out = {k: nan for k in ("tape_speed_ratio", "buy_initiated_share", "green_print_surge", "price_per_1k_shares",
                            "ask_size_depletion", "bid_stepups", "post_entry_freeze")}
    if trades.empty:
        return out
    tr = trades.sort_values("t").reset_index(drop=True)
    tr["side"] = classify_sides(tr, quotes) if not quotes.empty else 0
    w60 = tr[(tr.t >= trigger_time - pd.Timedelta(seconds=60)) & (tr.t < trigger_time)]
    w5m = tr[(tr.t >= trigger_time - pd.Timedelta(minutes=6)) & (tr.t < trigger_time - pd.Timedelta(seconds=60))]
    r60 = len(w60) / 60.0
    r5m = len(w5m) / 300.0
    out["tape_speed_ratio"] = r60 / r5m if r5m > 0 else nan
    vol = w60["size"].sum()
    buy = w60.loc[w60.side == 1, "size"].sum()
    out["buy_initiated_share"] = buy / vol if vol > 0 else nan
    near = lambda df: df[(df.side == 1) & (df.price >= level - 0.02)]  # noqa: E731 — green prints at/through the level
    g60, g5m = near(w60)["size"].sum() / 60.0, near(w5m)["size"].sum() / 300.0
    out["green_print_surge"] = g60 / g5m if g5m > 0 else (np.inf if g60 > 0 else nan)
    if buy > 0 and len(w60) > 1:
        out["price_per_1k_shares"] = float((w60.price.iloc[-1] - w60.price.iloc[0]) / (buy / 1000.0))
    if not quotes.empty:
        q = quotes.sort_values("t")
        q60 = q[(q.t >= trigger_time - pd.Timedelta(seconds=60)) & (q.t < trigger_time)]
        at_level = q60[(q60.ask >= level - 0.005) & (q60.ask <= level + 0.015)]
        if len(at_level) >= 2 and at_level.ask_size.iloc[0] > 0:
            out["ask_size_depletion"] = float(1 - at_level.ask_size.iloc[-1] / at_level.ask_size.iloc[0])
        out["bid_stepups"] = float((np.diff(q60.bid.to_numpy(float)) > 0).sum()) if len(q60) > 1 else 0.0
    if entry_time is not None:
        after = tr[(tr.t >= entry_time) & (tr.t < entry_time + pd.Timedelta(seconds=30))]
        out["post_entry_freeze"] = (len(after) / 30.0) / r60 if r60 > 0 else nan
    return out


def ten_second_bars(trades: pd.DataFrame) -> pd.DataFrame:
    """TAP-06: 10-second OHLCV bars from trades (t, price, size). Empty 10-second intervals are omitted."""
    if trades.empty:
        return pd.DataFrame(columns=["t", "o", "h", "l", "c", "v"])
    tr = trades.sort_values("t")
    g = tr.groupby(tr.t.dt.floor("10s"))
    return pd.DataFrame({"o": g.price.first(), "h": g.price.max(), "l": g.price.min(), "c": g.price.last(),
                         "v": g["size"].sum()}).reset_index().rename(columns={"t": "t"})


def fetch_window(client, symbol: str, start: pd.Timestamp, end: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    """SIP trades (t, price, size) and NBBO quotes (t, bid, ask, bid_size, ask_size) for one symbol, all pages."""
    def pull(kind: str):
        rows, token = [], None
        params = {"symbols": symbol, "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "feed": "sip", "limit": 10000}
        while True:
            if token:
                params["page_token"] = token
            j = client.get(f"https://data.alpaca.markets/v2/stocks/{kind}", params)
            rows += (j.get(kind) or {}).get(symbol) or []
            token = j.get("next_page_token")
            if not token:
                return rows
    tr = pd.DataFrame(pull("trades"))
    q = pd.DataFrame(pull("quotes"))
    trades = (pd.DataFrame({"t": pd.to_datetime(tr.t, utc=True), "price": tr.p.astype(float), "size": tr.s.astype(float)})
              if len(tr) else pd.DataFrame(columns=["t", "price", "size"]))
    quotes = (pd.DataFrame({"t": pd.to_datetime(q.t, utc=True), "bid": q.bp.astype(float), "ask": q.ap.astype(float),
                            "bid_size": q.bs.astype(float), "ask_size": q["as"].astype(float)})
              if len(q) else pd.DataFrame(columns=["t", "bid", "ask", "bid_size", "ask_size"]))
    return trades, quotes


def trade_tags(client, symbol: str, entry_time: pd.Timestamp, level: float, stop: float, ten_second: bool = False) -> dict:
    """Descriptive tags for one real trade: tape features around the fill minute. With `ten_second`, also the
    10-second view: seconds from the fill minute's start to the first 10-second bar trading through the level, and
    the lowest price in the 30 s after that break, in R."""
    t0 = pd.Timestamp(entry_time)
    trades, quotes = fetch_window(client, symbol, t0 - pd.Timedelta(minutes=6), t0 + pd.Timedelta(minutes=3))
    tags = features(trades, quotes, trigger_time=t0, level=level, entry_time=t0 + pd.Timedelta(seconds=30))
    if ten_second and len(trades):
        b10 = ten_second_bars(trades[(trades.t >= t0) & (trades.t < t0 + pd.Timedelta(minutes=2))])
        hit = b10[b10.h >= level]
        if len(hit):
            tb = hit.t.iloc[0]
            tags["tenS_break_seconds"] = float((tb - t0).total_seconds())
            after = trades[(trades.t >= tb) & (trades.t < tb + pd.Timedelta(seconds=30))]
            r = level - stop
            tags["tenS_first30s_low_R"] = float((after.price.min() - level) / r) if len(after) and r > 0 else float("nan")
    return tags
