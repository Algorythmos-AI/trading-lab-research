"""Point-in-time shares outstanding (float proxy) from SEC EDGAR XBRL frames.

dei:EntityCommonStockSharesOutstanding is reported on the filing cover page "as of" a date that is
within days of the filing, so a value is treated as KNOWN from (end + AVAIL_LAG_DAYS). This avoids the
look-ahead of using today's float for past dates. Shares outstanding >= float, so the proxy is
conservative for "low float" (true float is usually smaller).
"""
from __future__ import annotations

import re
import time

import pandas as pd
import requests

from wt.core.config import DATA_DIR  # noqa: E402

UA = {"User-Agent": "wt-research personal-trading-research-bot"}
AVAIL_LAG_DAYS = 5
OUT = DATA_DIR / "edgar" / "shares_outstanding.parquet"
MAP = DATA_DIR / "edgar" / "ticker_cik.parquet"


def _norm(name: str) -> str:
    name = (name or "").lower()
    name = re.sub(r"\b(inc|corp|corporation|co|company|ltd|limited|plc|holdings?|group|class [a-z]|common stock|ordinary shares?)\b", " ", name)
    return re.sub(r"[^a-z0-9]+", " ", name).strip()


def build(start_year: int = 2018) -> pd.DataFrame:
    rows = []
    now = pd.Timestamp.now()
    for y in range(start_year, now.year + 1):
        for q in range(1, 5):
            if pd.Timestamp(y, 3 * q, 1) > now:
                break
            url = f"https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY{y}Q{q}I.json"
            r = requests.get(url, headers=UA, timeout=60)
            time.sleep(0.2)  # SEC fair-access: <10 req/s
            if r.status_code != 200:
                continue
            for d in r.json()["data"]:
                rows.append({"cik": d["cik"], "entity": d["entityName"], "end": d["end"], "shares": d["val"]})
    df = pd.DataFrame(rows).drop_duplicates(["cik", "end"])
    df["end"] = pd.to_datetime(df["end"]).dt.date
    # The filing date would be the right known_from (audit), but a frames row carries no filing date (only accn, cik,
    # entityName, loc, end, val) and neither does this table; using it needs a new companyfacts download (`filed`).
    df["known_from"] = (pd.to_datetime(df["end"]) + pd.Timedelta(days=AVAIL_LAG_DAYS)).dt.date
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT)
    # ticker map: current SEC tickers + name match for delisted Alpaca assets
    t = requests.get("https://www.sec.gov/files/company_tickers.json", headers=UA, timeout=60).json()
    m = pd.DataFrame(t.values()).rename(columns={"cik_str": "cik", "title": "entity"})
    m["how"] = "sec_ticker"
    assets = pd.read_parquet(DATA_DIR / "daily" / "assets.parquet")
    by_name = {}
    for cik, ent in df[["cik", "entity"]].drop_duplicates().itertuples(index=False):
        by_name.setdefault(_norm(ent), cik)
    extra = []
    known = set(m.ticker)
    for sym, name in assets[["symbol", "name"]].itertuples(index=False):
        if sym not in known and _norm(name) in by_name:
            extra.append({"ticker": sym, "cik": by_name[_norm(name)], "entity": name, "how": "name_match"})
    m = pd.concat([m[["ticker", "cik", "entity", "how"]], pd.DataFrame(extra)], ignore_index=True)
    m.to_parquet(MAP)
    print(f"shares rows {len(df)}, ciks {df.cik.nunique()}; ticker map {len(m)} ({len(extra)} by name)")
    return df


class SharesOutstanding:
    """Lookup: latest shares outstanding KNOWN on a given date (None if unknown)."""

    def __init__(self):
        so = pd.read_parquet(OUT)
        self.map = dict(pd.read_parquet(MAP)[["ticker", "cik"]].itertuples(index=False))
        self.by_cik = {cik: g.sort_values("known_from")[["known_from", "shares"]].to_records(index=False)
                       for cik, g in so.groupby("cik")}

    def asof(self, ticker: str, date) -> float | None:
        cik = self.map.get(ticker)
        recs = self.by_cik.get(cik) if cik is not None else None
        if recs is None:
            return None
        val = None
        for known_from, shares in recs:
            if known_from <= date:
                val = float(shares)
            else:
                break
        return val


if __name__ == "__main__":
    build()
