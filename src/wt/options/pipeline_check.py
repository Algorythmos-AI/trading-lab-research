"""The pipeline check: radar, the options edition and its focus names, verified against the market's own data.

    python -m wt.options.pipeline_check pre-open      (job pipeline-check, 08:55 New York: after the focus refresh,
    python -m wt.options.pipeline_check after-close    before the clone arms; and 18:30, after the evening edition)

The radar and the options edition are built in the cloud from IBKR; the options clone trades from them. Nothing
checked their claims. This reads both back from the site (signed GET /api/editions/<kind>), recomputes what they
claim from the consolidated tape (closes, the day, week and month levels, the moving averages) and the broker's
option listings (same-day expiries), and writes one report per run to var/pipeline-check/. A failed check pages the
owner once a day per run with the check ids. It reads only; it never changes an edition or trades.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any
from zoneinfo import ZoneInfo

import requests

from wt.core.config import STATE_DIR
from wt.ops import publish
from wt.options import levels as lv
from wt.options.intraday import daily_raw

NEW_YORK = ZoneInfo("America/New_York")
OUT = STATE_DIR / "pipeline-check"
LEVEL_NAMES = ("PDH", "PDL", "PWH", "PWL", "PMH", "PML", "MA20", "MA50")
CLOSE_TOL = 0.02          # dollars: the same close on two feeds
LEVEL_TOL = 0.05          # dollars: the same level computed twice
PREMARKET_DRIFT_PCT = 0.5  # a pre-market price older than this far from now is reported as moved
RADAR_MAX_AGE_H = 6.0
DATA = "https://data.alpaca.markets"
PAPER = "https://paper-api.alpaca.markets"


@dataclass(frozen=True)
class Check:
    id: str                 # e.g. options.levels.SPY
    severity: str           # fail | warn | info
    ok: bool
    detail: str


def edition_signature(secret: str, kind: str, ts: int) -> str:
    return publish.sign(f"GET /api/editions/{kind}".encode(), secret, ts)


def read_edition(kind: str, env: Mapping[str, str] | None = None, session_: requests.Session | None = None,
                 now: Callable[[], float] = time.time) -> dict[str, Any] | None:
    """The latest stored edition of `kind` from the site, or None."""
    e = os.environ if env is None else env
    ingest, secret = e.get("DASHBOARD_INGEST_URL", ""), e.get("DASHBOARD_INGEST_SECRET")
    url = re.sub(r"/api/ingest/?$", f"/api/editions/{kind}", ingest)
    if not secret or url == ingest:
        return None
    ts = int(now())
    headers = {"x-wt-timestamp": str(ts), "x-wt-signature": edition_signature(secret, kind, ts)}
    if kid := e.get("DASHBOARD_KEY_ID"):
        headers["x-wt-key-id"] = kid
    if bypass := e.get("VERCEL_AUTOMATION_BYPASS_SECRET"):
        headers["x-vercel-protection-bypass"] = bypass
    try:
        r = (session_ or requests).get(url, headers=headers, timeout=(5.0, 15.0), allow_redirects=False)
        body = r.json() if r.status_code == 200 else None
    except (requests.RequestException, ValueError):
        return None
    ed = body.get("edition") if isinstance(body, dict) else None
    return ed if isinstance(ed, dict) else None


def target_session(slot: str, now: dt.datetime) -> str:
    """The session the editions should be for: today before the open, the next session after the close."""
    today = now.astimezone(NEW_YORK).date().isoformat()
    if slot == "pre-open":
        return today if lv.is_session(today) else lv.next_session(today)
    return lv.next_session(today)


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def assess(slot: str, now: dt.datetime, radar: Mapping[str, Any] | None, options: Mapping[str, Any] | None,
           daily: Mapping[str, Sequence[Mapping[str, Any]]], expiries: Mapping[str, Sequence[str]],
           live: Mapping[str, float], earnings: Sequence[Mapping[str, Any]]) -> list[Check]:
    """Every check for one run. Pure: the editions and the market data come in, the checks go out.

    `daily`: each symbol's consolidated-tape daily bars, split-adjusted, up to the last finished session.
    `expiries`: each symbol's listed expiry dates in the coming week. `live`: the latest price per symbol (pre-open)."""
    out: list[Check] = []
    target = target_session(slot, now)
    prev = lv.prev_session(target)

    def add(cid: str, ok: bool, detail: str, sev: str = "fail") -> None:
        out.append(Check(cid, sev if not ok else "info", ok, detail))

    # ---- the options edition
    if not options:
        add("options.present", False, "no options edition on the site")
    else:
        add("options.session", options.get("session") == target, f"edition session {options.get('session')}, want {target}")
        add("options.built_from", options.get("built_from") == prev,
            f"built from {options.get('built_from')}, want {prev}")
        tickers = options.get("tickers")
        rows = tickers if isinstance(tickers, list) else list(tickers.values()) if isinstance(tickers, dict) else []
        for t in rows:
            sym = str(t.get("symbol"))
            bars = [b for b in daily.get(sym, []) if isinstance(b, Mapping)]
            loaded = lv.load_ibkr(daily_raw(bars))
            if loaded.problems or not loaded.bars or loaded.bars[-1].d != prev:
                add(f"options.tape.{sym}", False, f"no clean tape through {prev} to check against", "warn")
                continue
            close = _num((t.get("last") or {}).get("close"))
            tape_close = loaded.bars[-1].c
            add(f"options.close.{sym}", close is not None and abs(close - tape_close) <= CLOSE_TOL,
                f"edition {close} vs tape {round(tape_close, 2)}")
            try:
                mine = {x.name: x.price for x in lv.levels_for(loaded.bars, target)["levels"]}
            except ValueError as e:
                add(f"options.levels.{sym}", False, f"levels not computable: {e}", "warn")
                continue
            theirs = {str(x.get("name")): _num(x.get("price")) for x in t.get("levels") or [] if isinstance(x, Mapping)}
            off = [f"{n} {theirs.get(n)} vs {round(mine[n], 2)}" for n in LEVEL_NAMES
                   if n in mine and (theirs.get(n) is None or abs((theirs.get(n) or 0) - mine[n]) > LEVEL_TOL)]
            add(f"options.levels.{sym}", not off, "; ".join(off) or "all levels agree")
        # ---- its focus names
        focus = options.get("focus") or {}
        items = [i for i in focus.get("items") or [] if isinstance(i, Mapping) and isinstance(i.get("symbol"), str)]
        add("focus.present", bool(items), f"{len(items)} focus names")
        if slot == "pre-open":
            pre = focus.get("premarket") or {}
            at = str(pre.get("as_of") or "")
            add("focus.premarket", at[:10] == target, f"pre-open refresh as_of {at or 'missing'}", "warn")
        tradeable = [str(i["symbol"]) for i in items if target in expiries.get(str(i["symbol"]), ())]
        add("focus.tradeable", len(tradeable) >= 2,
            f"{len(tradeable)} of {len(items)} focus names have a contract expiring {target}: {', '.join(tradeable) or 'none'}"
            " (the clone tops up with SPY and QQQ)", "warn")
        for i in items:
            sym = str(i["symbol"])
            hit = [r for r in earnings if str(r.get("symbol", "")).upper() == sym and (
                str(r.get("date")) == target or (str(r.get("date")) == prev and str(r.get("when")) == "amc"))]
            if hit:
                add(f"focus.earnings.{sym}", False, f"{sym} reports {hit[0].get('date')} {hit[0].get('when')}: the clone skips it",
                    "warn")
    # ---- the radar (built once, before the open)
    if slot == "pre-open":
        if not radar:
            add("radar.present", False, "no radar edition on the site")
        else:
            add("radar.date", radar.get("edition_date") == target, f"radar for {radar.get('edition_date')}, want {target}")
            try:
                built = dt.datetime.fromisoformat(str(radar.get("as_of")).replace("Z", "+00:00"))
                age = (now - built).total_seconds() / 3600
                add("radar.fresh", age <= RADAR_MAX_AGE_H, f"built {age:.1f} h ago")
            except ValueError:
                add("radar.fresh", False, "no readable as_of")
            for t in radar.get("tickers") or []:
                if not isinstance(t, Mapping):
                    continue
                sym = str(t.get("symbol"))
                bars = [b for b in daily.get(sym, []) if isinstance(b, Mapping)]
                if not bars:
                    continue
                loaded = lv.load_ibkr(daily_raw(bars))
                if not loaded.bars or loaded.bars[-1].d != prev:
                    continue
                price = _num(t.get("price"))
                add(f"radar.close.{sym}", price is not None and abs(price - loaded.bars[-1].c) <= CLOSE_TOL,
                    f"radar {price} vs tape close {round(loaded.bars[-1].c, 2)}")
                pm, now_px = _num(t.get("premarket_price")), live.get(sym)
                if pm is not None and now_px:
                    drift = abs(now_px - pm) / pm * 100
                    add(f"radar.premarket.{sym}", drift <= PREMARKET_DRIFT_PCT,
                        f"radar pre-market {pm} vs now {round(now_px, 2)} ({drift:.2f}%): moved since the radar", "warn")
    return out


# ---------------------------------------------------------------- the run
def _alpaca_get(url: str, params: dict[str, str]) -> Any:
    h = {"APCA-API-KEY-ID": os.environ.get("APCA_API_KEY_ID", ""), "APCA-API-SECRET-KEY": os.environ.get("APCA_API_SECRET_KEY", "")}
    r = requests.get(url, params=params, headers=h, timeout=(5.0, 20.0), allow_redirects=False)
    r.raise_for_status()
    return r.json()


def market_data(symbols: Sequence[str], target: str, slot: str) -> tuple[dict[str, list[Any]], dict[str, list[str]], dict[str, float]]:
    prev = dt.date.fromisoformat(lv.prev_session(target))
    daily: dict[str, list[Any]] = {}
    params = {"symbols": ",".join(symbols), "timeframe": "1Day", "feed": "sip", "adjustment": "split", "limit": "10000",
              "start": (prev - dt.timedelta(days=420)).isoformat(), "end": f"{prev.isoformat()}T23:59:00Z"}
    for _ in range(30):
        j = _alpaca_get(f"{DATA}/v2/stocks/bars", params)
        for s, rows in (j.get("bars") or {}).items():
            daily.setdefault(s, []).extend(rows)
        if not j.get("next_page_token"):
            break
        params["page_token"] = j["next_page_token"]
    expiries: dict[str, list[str]] = {}
    week_end = (dt.date.fromisoformat(target) + dt.timedelta(days=6)).isoformat()
    for s in symbols:
        try:
            j = _alpaca_get(f"{PAPER}/v2/options/contracts", {"underlying_symbols": s, "expiration_date_gte": target,
                                                                 "expiration_date_lte": week_end, "limit": "10000"})
            expiries[s] = sorted({c["expiration_date"] for c in j.get("option_contracts", [])})
        except (requests.RequestException, KeyError, ValueError):
            expiries[s] = []
    live: dict[str, float] = {}
    if slot == "pre-open":
        try:
            j = _alpaca_get(f"{DATA}/v2/stocks/snapshots", {"symbols": ",".join(symbols), "feed": "iex"})
            for s, snap in j.items():
                p = _num(((snap or {}).get("latestTrade") or {}).get("p"))
                if p:
                    live[s] = p
        except (requests.RequestException, ValueError, AttributeError):
            pass
    return daily, expiries, live


def run(slot: str, now: dt.datetime | None = None) -> int:
    import csv
    from wt.core.config import CONFIG_DIR
    from wt.ops.alerts import Alerts
    now = now or dt.datetime.now(dt.UTC)
    target = target_session(slot, now)
    radar, options = read_edition("radar"), read_edition("options")
    symbols = sorted({str(t.get("symbol")) for t in ((options or {}).get("tickers") or []) if isinstance(t, Mapping)}
                     | {str(t.get("symbol")) for t in ((radar or {}).get("tickers") or []) if isinstance(t, Mapping)}
                     | {"SPY", "QQQ"})
    try:
        daily, expiries, live = market_data(symbols, target, slot)
    except requests.RequestException as e:
        daily, expiries, live = {}, {}, {}
        print(f"market data unavailable: {e.__class__.__name__}", file=sys.stderr)
    with open(CONFIG_DIR / "events" / "earnings.csv") as fh:
        earnings = list(csv.DictReader(line for line in fh if not line.startswith("#")))
    checks = assess(slot, now, radar, options, daily, expiries, live, earnings)
    fails = [c for c in checks if not c.ok and c.severity == "fail"]
    warns = [c for c in checks if not c.ok and c.severity == "warn"]
    report = {"slot": slot, "session": target, "checked_at": now.isoformat(), "fails": len(fails), "warns": len(warns),
              "checks": [asdict(c) for c in checks]}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{target}-{slot}.json").write_text(json.dumps(report, indent=1))
    for c in checks:
        if not c.ok:
            print(f"{c.severity.upper()} {c.id}: {c.detail}")
    print(f"pipeline check {slot} for {target}: {len(checks)} checks, {len(fails)} failed, {len(warns)} warnings")
    if fails:
        Alerts().once_per_day(f"pipeline-check:{slot}", f"Pipeline check {slot}: {len(fails)} failed",
                              ", ".join(c.id for c in fails)[:300], 4)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slot", choices=("pre-open", "after-close"), nargs="?")
    a = ap.parse_args(argv)
    slot = a.slot or ("pre-open" if dt.datetime.now(NEW_YORK).hour < 12 else "after-close")
    return run(slot)


if __name__ == "__main__":
    raise SystemExit(main())
