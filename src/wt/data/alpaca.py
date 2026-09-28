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


SIP_DELAY_MIN = 16      # the free plan refuses SIP newer than 15 minutes (HTTP 403, verified 2026-09-28); 1 min margin


def sip_safe_end(now: pd.Timestamp | None = None) -> str:
    """The latest request end the free plan accepts for SIP, as UTC ISO: now - SIP_DELAY_MIN.

    Use it instead of a date-only end: an end of today's US date counts as recent and is refused (403, verified
    2026-09-28), and a date computed from the local Sydney clock is often today's US date."""
    now = pd.Timestamp.now(tz="UTC") if now is None else pd.Timestamp(now).tz_convert("UTC")
    return (now - pd.Timedelta(minutes=SIP_DELAY_MIN)).strftime("%Y-%m-%dT%H:%M:%SZ")


class HybridFeed:
    """Wraps a client so that bars(feed="hybrid") returns the consolidated SIP tape for everything older than the
    free plan's delay and IEX for the most recent minutes (SPEC-0001 routine.data_live, K-31). IEX has no bars
    before 08:00 ET and few for small caps, so the SIP part carries almost all of the pre-market.

    Bars gain a `src` column ("sip" / "iex"). Volume in the IEX tail is IEX-only, so volume features over a window
    that reaches the last 16 minutes are understated (conservative). If SIP refuses the request (403), the whole
    window falls back to IEX. Every other call passes through to the wrapped client. `sip_through` holds the last
    cut-off used (UTC), for the stage log."""

    def __init__(self, client, delay_min: int = SIP_DELAY_MIN, now=None):
        self.client, self.delay = client, pd.Timedelta(minutes=delay_min)
        self.now = now or (lambda: pd.Timestamp.now(tz="UTC"))
        self.sip_through: pd.Timestamp | None = None

    def __getattr__(self, name):
        return getattr(self.client, name)

    def bars(self, symbols: Iterable[str], timeframe: str, start: str, end: str,
             feed: str = "sip", adjustment: str = "raw") -> pd.DataFrame:
        if feed != "hybrid":
            return self.client.bars(symbols, timeframe, start, end, feed=feed, adjustment=adjustment)
        symbols = list(symbols)
        s, e = pd.Timestamp(start), pd.Timestamp(end)
        cut = (self.now() - self.delay).floor("min")
        iso = lambda ts: ts.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
        parts = []
        if s < cut:
            try:
                parts.append(self.client.bars(symbols, timeframe, start, iso(min(e, cut)), feed="sip",
                                              adjustment=adjustment).assign(src="sip"))
            except requests.HTTPError as ex:
                if ex.response is None or ex.response.status_code != 403:
                    raise
                cut = s
        self.sip_through = min(e, cut) if s < cut else None
        if e > cut:
            parts.append(self.client.bars(symbols, timeframe, iso(max(s, cut)), end, feed="iex",
                                          adjustment=adjustment).assign(src="iex"))
        out = pd.concat([p for p in parts if len(p)], ignore_index=True) if any(len(p) for p in parts) else parts[0]
        # both ends are inclusive, so the bar starting at the cut-off can come back twice: keep the SIP one
        return out.drop_duplicates(["symbol", "t"], keep="first").sort_values(["symbol", "t"], ignore_index=True)
