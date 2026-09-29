"""Point-in-time equity universe from daily bars (active + inactive listed symbols).

Known limitation (DEC-0003): Alpaca's inactive-asset list is incomplete (e.g. TWTR, SIVB, BBBY, FRC are
absent although their bars exist), so some delisted names are missing -> residual survivorship bias,
which flatters long-momentum results. Reported in every G1 report.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402

LISTED = {"NASDAQ", "NYSE", "AMEX"}
FUND_RX = re.compile(r"\b(ETF|ETN|Funds?|Index|Shares|Trust|Notes?|Warrants?|Rights?|Units?|Preferred|Depositary|Acquisition Corp)\b", re.I)
DAILY = DATA_DIR / "daily" / "equities_daily.parquet"
ASSETS = DATA_DIR / "daily" / "assets.parquet"


def build_assets(a: AlpacaREST) -> pd.DataFrame:
    rows = []
    for status in ("active", "inactive"):
        for x in a.assets(status):
            if x["exchange"] in LISTED:
                rows.append({"symbol": x["symbol"], "name": x["name"], "exchange": x["exchange"], "status": status,
                             "is_fund_like": bool(FUND_RX.search(x["name"] or "")),
                             "has_dot": "." in x["symbol"] or "/" in x["symbol"]})
    df = pd.DataFrame(rows).drop_duplicates("symbol")
    ASSETS.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ASSETS)
    return df


def build_daily(start: str = "2018-06-01", end: str | None = None) -> None:
    a = AlpacaREST()
    assets = build_assets(a)
    warrant_like = assets.symbol.str.len().ge(5) & assets.symbol.str[-1].isin(list("WRU"))
    clean = assets.symbol.str.fullmatch(r"[A-Z]{1,5}")
    syms = assets[clean & ~assets.is_fund_like & ~assets.has_dot & ~warrant_like].symbol.tolist()
    syms += ["SPY", "QQQ", "SPYM", "QQQM", "IWM"]  # ETF track + regime inputs
    # free plan forbids SIP data from the last 15 min; an end *date* of today counts as recent
    end = end or (pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=16)).strftime("%Y-%m-%dT%H:%M:%SZ")
    chunk_dir = DAILY.parent / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for i in range(0, len(syms), 200):
        f = chunk_dir / f"chunk_{i:05d}.parquet"
        if f.exists():          # resumable
            continue
        batch = syms[i:i + 200]
        try:
            df = a.bars(batch, "1Day", start, end, feed="sip", adjustment="raw")
        except Exception as e:  # isolate bad symbols: retry one by one
            print(f"  chunk {i} failed ({e.__class__.__name__}); retrying per symbol", flush=True)
            dfs = []
            for s_ in batch:
                try:
                    dfs.append(a.bars([s_], "1Day", start, end, feed="sip", adjustment="raw"))
                except Exception:
                    print(f"    skip {s_}", flush=True)
            df = pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()
        df.to_parquet(f)
        print(f"  {min(i + 200, len(syms))}/{len(syms)} symbols", flush=True)
    daily = load_daily()
    print(f"saved chunks in {chunk_dir}: {len(daily)} rows, {daily.symbol.nunique()} symbols (no merged copy: disk-light)")


def load_daily() -> pd.DataFrame:
    """Read the chunked daily store (no merged duplicate is written, to save disk)."""
    chunk_dir = DAILY.parent / "chunks"
    cols = ["symbol", "t", "o", "h", "l", "c", "v", "n", "vw"]
    files = sorted(chunk_dir.glob("chunk_*.parquet"))
    daily = pd.concat([pd.read_parquet(f, columns=cols).assign(_base=not f.name.startswith("chunk_zupd_")) for f in files],
                      ignore_index=True)
    daily["date"] = daily["t"].dt.tz_convert("America/New_York").dt.date
    # A nightly update chunk (chunk_zupd_<date>) can repeat a session that a base chunk also holds. Keep one row
    # per symbol-day and let the base chunk win: a base rebuild is the corrected copy, while an update chunk was
    # fetched minutes after that session's close (audit: update chunks overrode later rebuilds). Among update
    # chunks the later file wins (the sort is stable; chunks are read in name order).
    daily = daily.sort_values("_base", kind="stable").drop_duplicates(["symbol", "date"], keep="last")
    return daily.drop(columns=["t", "_base"]).sort_values(["symbol", "date"], ignore_index=True)


if __name__ == "__main__":
    build_daily()
