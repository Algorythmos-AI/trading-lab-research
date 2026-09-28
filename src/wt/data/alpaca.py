"""Alpaca market-data REST client: rate-limited, retrying, cached to parquet.

Free plan facts (verified 2026-09-27, see research/decisions/DEC-0003):
  * SIP historical bars back to 2016; the most recent 15 minutes are not permitted.
  * IEX historical bars start mid-2020.
  * News (Benzinga) available back to at least 2019.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Iterable

import pandas as pd
import requests

from wt.core.config import env

DATA = "https://data.alpaca.markets"
TRADING = "https://paper-api.alpaca.markets"


class RateLimiter:
    def __init__(self, per_minute: int = 180):
        self.per_minute = per_minute
        self.calls: deque[float] = deque()

    def wait(self) -> None:
        now = time.monotonic()
        while self.calls and now - self.calls[0] > 60:
            self.calls.popleft()
        if len(self.calls) >= self.per_minute:
            time.sleep(60 - (now - self.calls[0]) + 0.05)
        self.calls.append(time.monotonic())


class SharedRateLimiter:
    """Cross-process cap (plan D6): every process using the same file shares one 60-second window of call
    timestamps, guarded by an exclusive file lock. The process also keeps its own per-minute cap."""

    def __init__(self, path, global_per_minute: int = 180, own_per_minute: int = 180):
        from pathlib import Path
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.cap = global_per_minute
        self.own = RateLimiter(own_per_minute)

    def wait(self) -> None:
        import fcntl
        import json
        self.own.wait()
        while True:
            with open(self.path, "a+") as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                f.seek(0)
                try:
                    calls = json.loads(f.read() or "[]")
                except ValueError:
                    calls = []
                now = time.time()
                calls = [t for t in calls if now - t < 60]
                if len(calls) < self.cap:
                    calls.append(now)
                    f.seek(0)
                    f.truncate()
                    f.write(json.dumps(calls))
                    return
                sleep_for = 60 - (now - calls[0]) + 0.05
            time.sleep(max(0.05, sleep_for))


class AlpacaREST:
    def __init__(self, per_minute: int = 180, shared: bool = False, global_per_minute: int = 180):
        """shared=True joins the cross-process limiter (data/.alpaca_rate.json). Research and routine jobs opt in;
        the default keeps the paper runner's existing per-process limiter unchanged."""
        self.s = requests.Session()
        self.s.headers.update({"APCA-API-KEY-ID": env("APCA_API_KEY_ID"),
                               "APCA-API-SECRET-KEY": env("APCA_API_SECRET_KEY")})
        if shared:
            from wt.core.config import DATA_DIR
            self.rl = SharedRateLimiter(DATA_DIR / ".alpaca_rate.json", global_per_minute, per_minute)
        else:
            self.rl = RateLimiter(per_minute)

    def get(self, url: str, params: dict | None = None, tries: int = 8) -> dict | list:
        for attempt in range(tries):
            self.rl.wait()
            try:
                r = self.s.get(url, params=params, timeout=60)
            except requests.RequestException:
                time.sleep(min(60, 2 ** attempt))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                ra = r.headers.get("Retry-After")
                time.sleep(float(ra) if ra and ra.replace(".", "").isdigit() else min(60, 2 ** attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"GET failed after {tries} tries: {url} {params}")

    # ---- reference data -------------------------------------------------
    def assets(self, status: str) -> list[dict]:
        return self.get(f"{TRADING}/v2/assets", {"status": status, "asset_class": "us_equity"})

    def calendar(self, start: str, end: str) -> pd.DataFrame:
        df = pd.DataFrame(self.get(f"{TRADING}/v2/calendar", {"start": start, "end": end}))
        df["date"] = pd.to_datetime(df["date"]).dt.date
        return df

    # ---- bars -----------------------------------------------------------
    def bars(self, symbols: Iterable[str], timeframe: str, start: str, end: str,
             feed: str = "sip", adjustment: str = "raw") -> pd.DataFrame:
        """Multi-symbol bars, all pages. Returns columns: symbol,t,o,h,l,c,v,n,vw (t = bar START, UTC)."""
        symbols = list(symbols)
        out: list[dict] = []
        for i in range(0, len(symbols), 200):
            params = {"symbols": ",".join(symbols[i:i + 200]), "timeframe": timeframe, "start": start,
                      "end": end, "feed": feed, "adjustment": adjustment, "limit": 10000}
            token = None
            while True:
                if token:
                    params["page_token"] = token
                j = self.get(f"{DATA}/v2/stocks/bars", params)
                for sym, rows in (j.get("bars") or {}).items():
                    for r in rows:
                        r["symbol"] = sym
                        out.append(r)
                token = j.get("next_page_token")
                if not token:
                    break
        if not out:
            return pd.DataFrame(columns=["symbol", "t", "o", "h", "l", "c", "v", "n", "vw"])
        df = pd.DataFrame(out)
        df["t"] = pd.to_datetime(df["t"], utc=True)
        return df[["symbol", "t", "o", "h", "l", "c", "v", "n", "vw"]]

    # ---- news -----------------------------------------------------------
    def news(self, symbols: Iterable[str], start: str, end: str) -> list[dict]:
        symbols = list(symbols)
        out: list[dict] = []
        for i in range(0, len(symbols), 50):
            params = {"symbols": ",".join(symbols[i:i + 50]), "start": start, "end": end,
                      "limit": 50, "include_content": "false", "sort": "asc"}
            token = None
            while True:
                if token:
                    params["page_token"] = token
                j = self.get(f"{DATA}/v1beta1/news", params)
                out.extend(j.get("news", []))
                token = j.get("next_page_token")
                if not token:
                    break
        return out
