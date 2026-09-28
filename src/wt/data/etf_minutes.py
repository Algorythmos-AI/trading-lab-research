"""Cache regular-session 1m bars for the ETF track (SPY, QQQ signals; SPYM/QQQM traded) by month."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402

OUT = DATA_DIR / "minute_etf"


def build(symbols=("SPY", "QQQ"), start="2018-12-01", end="2026-09-25", out=None) -> None:
    a = AlpacaREST()
    out = out or OUT
    out.mkdir(parents=True, exist_ok=True)
    for m in pd.period_range(start, end, freq="M"):
        f = out / f"{m}.parquet"
        if f.exists():
            continue
        s, e = m.start_time.strftime("%Y-%m-%d"), (m.end_time + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        if pd.Timestamp(e) > pd.Timestamp(end):
            e = end
        df = a.bars(list(symbols), "1Min", s, e, feed="sip")
        t = df.t.dt.tz_convert("America/New_York")
        df = df[(t.dt.time >= pd.Timestamp("09:30").time()) & (t.dt.time < pd.Timestamp("16:00").time())]
        df.to_parquet(f)
        print(m, len(df), flush=True)


def load(symbol: str) -> pd.DataFrame:
    src = OUT if symbol in ("SPY", "QQQ") else OUT.parent / "minute_etf2"
    df = pd.concat([pd.read_parquet(f) for f in sorted(src.glob("*.parquet"))], ignore_index=True)
    df = df[df.symbol == symbol].sort_values("t").reset_index(drop=True)
    df["date"] = df.t.dt.tz_convert("America/New_York").dt.date
    return df


if __name__ == "__main__":
    import sys as _s
    if "--round2" in _s.argv:
        build(("IWM", "DIA"), out=OUT.parent / "minute_etf2")
    else:
        build()
