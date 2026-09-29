"""Cache regular-session 1m bars for the ETF track (SPY, QQQ signals; SPYM/QQQM traded) by month."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from wt.core.config import DATA_DIR
from wt.data.alpaca import AlpacaREST
from wt.data.quality import dedupe

OUT = DATA_DIR / "minute_etf"


def build(symbols=("SPY", "QQQ"), start="2018-12-01", end="2026-09-25", out=None) -> None:
    a = AlpacaREST()
    out = out or OUT
    out.mkdir(parents=True, exist_ok=True)
    for m in pd.period_range(start, end, freq="M"):
        f = out / f"{m}.parquet"
        if f.exists():
            continue
        s, e = month_window(m, end)
        df = a.bars(list(symbols), "1Min", s, e, feed="sip")
        t = df.t.dt.tz_convert("America/New_York")
        df = df[(t.dt.time >= pd.Timestamp("09:30").time()) & (t.dt.time < pd.Timestamp("16:00").time())]
        df.to_parquet(f)
        print(m, len(df), flush=True)


def month_window(m: pd.Period, end: str) -> tuple[str, str]:
    """[start, end) of one month's request as RFC-3339 instants in New York time.

    The old code asked for "the 1st of next month" as a date. The API treats a date end as inclusive, so every file
    also held the next month's first session, and the next file held it again (audit R-C1). The end is now
    midnight ET at the start of the next month, capped at `end`, which is exclusive."""
    s = pd.Timestamp(m.start_time.date(), tz="America/New_York")
    e = min(pd.Timestamp((m.end_time + pd.Timedelta(days=1)).date(), tz="America/New_York"),
            pd.Timestamp(end, tz="America/New_York"))
    return s.isoformat(), (e - pd.Timedelta(seconds=1)).isoformat()


def load(symbol: str, src: Path | None = None) -> pd.DataFrame:
    """One symbol's regular-session 1m bars. Duplicated (symbol, t) rows are dropped, then uniqueness is asserted."""
    src = src or (OUT if symbol in ("SPY", "QQQ") else OUT.parent / "minute_etf2")
    df = pd.concat([pd.read_parquet(f) for f in sorted(src.glob("*.parquet"))], ignore_index=True)
    df = df[df.symbol == symbol]
    df = dedupe(df, ["symbol", "t"], what=f"etf minutes {symbol}").sort_values("t").reset_index(drop=True)
    df["date"] = df.t.dt.tz_convert("America/New_York").dt.date
    return df


if __name__ == "__main__":
    import sys as _s
    if "--round2" in _s.argv:
        build(("IWM", "DIA"), out=OUT.parent / "minute_etf2")
    else:
        build()
