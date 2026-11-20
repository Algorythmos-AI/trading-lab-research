"""The lab's one-off probe (DEC-0060 "Order of the work" 2; EXP-0041 `probe`), run once by the owner on the host.

    python -m wt.lab.probe [--names NVDA,AMD] [--out var/lab/probe.json]

It answers, before any recorder is built:
- which key pairs on the host reach the OPRA option feed, and the request limit Alpaca reports for each
  (`X-RateLimit-Limit`); keys are never printed or written;
- whether one chain request can cover an expiry and strike range, how many pages and how long they take;
- how many contracts each focus name has in tier 1 and tier 2 (wt.lab.tiers), and how long one tier-1 sweep takes;
- free disk on the filesystem that holds the lab's state.

Only the focus names of the dashboard's latest edition are probed (DEC-0060 section 1, DEC-0051 section 5.1): that
edition must be for the next session (today's before the close), and `--names` may only narrow it. No focus list
means no probe. Tiers are judged as of the edition's session. Data requests only, every one naming its feed; no order
path, no account read. The result holds counts, times and statuses only (SAFE): no name, price or quote.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import shutil
import sys
import time
import zoneinfo
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
import yaml

from wt.core.config import CONFIG_DIR, STATE_DIR
from wt.data.feeds import require_feed
from wt.lab import focus, tiers
from wt.options.chain import parse_occ

DATA_HOST = "https://data.alpaca.markets"
NY = zoneinfo.ZoneInfo("America/New_York")
PAIRS = ("APCA_CLONE", "APCA_OPTIONS", "APCA_API")
BATCH = 100                                   # symbols per snapshots request (Alpaca's cap)
WORKERS = 4
TIMEOUT_S = {"chain": 10.0, "sweep": 3.0, "other": 5.0}
MAX_PAGES = 50
PASS = {"rate_limit_per_min_at_least": 1000, "tier1_sweep_seconds_at_most": 5.0, "free_disk_gb_at_least": 19}
OUT = STATE_DIR / "lab" / "probe.json"


@dataclass(frozen=True)
class Answer:
    status: int
    headers: Mapping[str, str]                # lower-case names
    body: Any
    seconds: float


Get = Callable[[str, Mapping[str, str], Mapping[str, str], float], Answer]


# Every URL the lab may call: market data, and the contract listing (for open interest) on the paper trading host.
# Anything else, an account, an order, a position, any other host, is refused before it is sent (DEC-0060 section 2.6).
ALLOWED = (("https://data.alpaca.markets", "/v2/stocks/snapshots", False),
           ("https://data.alpaca.markets", "/v1beta1/options/snapshots", True),     # and /<root>: a chain
           ("https://data.alpaca.markets", "/v1beta1/options/trades", False),
           ("https://paper-api.alpaca.markets", "/v2/options/contracts", False))


def allowed(url: str) -> bool:
    for host, path, sub in ALLOWED:
        if not url.startswith(host + "/"):
            continue
        rest = url[len(host):].split("?", 1)[0]
        if rest == path:
            return True
        if sub and rest.startswith(path + "/") and rest[len(path) + 1:].isalnum() and rest[len(path) + 1:].isupper():
            return True
    return False


def check_url(url: str) -> None:
    if not allowed(url):
        raise PermissionError(f"the lab may not call {url.split('?', 1)[0]}")


def http_get(session: requests.Session) -> Get:
    def get(url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
        check_url(url)
        require_feed(url, params)
        t = time.monotonic()
        try:
            r = session.get(url, params=dict(params), headers=dict(headers), timeout=timeout)
        except requests.RequestException as e:
            return Answer(0, {}, {"error": e.__class__.__name__}, time.monotonic() - t)
        try:
            body = r.json()
        except ValueError:
            body = None
        return Answer(r.status_code, {k.lower(): v for k, v in r.headers.items()}, body, time.monotonic() - t)
    return get


def pair_headers(env: Mapping[str, str], prefix: str) -> dict[str, str] | None:
    key, secret = env.get(f"{prefix}_KEY_ID"), env.get(f"{prefix}_SECRET_KEY")
    if not key or not secret:
        return None
    return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}


def _int(v: object) -> int | None:
    try:
        return int(str(v))
    except (TypeError, ValueError):
        return None


def check_pairs(get: Get, env: Mapping[str, str]) -> dict[str, dict[str, Any]]:
    """Each key pair's answer to one small OPRA chain request: status and the limits Alpaca reports."""
    out: dict[str, dict[str, Any]] = {}
    for prefix in PAIRS:
        h = pair_headers(env, prefix)
        if h is None:
            out[prefix] = {"present": False}
            continue
        a = get(f"{DATA_HOST}/v1beta1/options/snapshots/SPY", {"feed": "opra", "limit": "1"}, h, TIMEOUT_S["other"])
        hl = {k.lower(): v for k, v in a.headers.items()}
        out[prefix] = {"present": True, "status": a.status, "seconds": round(a.seconds, 3),
                       "rate_limit": _int(hl.get("x-ratelimit-limit")),
                       "remaining": _int(hl.get("x-ratelimit-remaining"))}
    return out


def best_pair(pairs: Mapping[str, Mapping[str, Any]]) -> str | None:
    """The pair with the highest reported limit (ties: the order of PAIRS). Every pair on the host also serves a
    runner, so the probe's few requests share that account's limit; the recorder's own budget is set from this."""
    ok = [(p, v) for p, v in pairs.items() if v.get("status") == 200]
    return max(ok, key=lambda pv: (pv[1].get("rate_limit") or 0, -PAIRS.index(pv[0])))[0] if ok else None


def stock_mids(get: Get, h: Mapping[str, str], names: Sequence[str]) -> tuple[dict[str, float], int]:
    a = get(f"{DATA_HOST}/v2/stocks/snapshots", {"symbols": ",".join(names), "feed": "sip"}, h, TIMEOUT_S["other"])
    out: dict[str, float] = {}
    if a.status != 200 or not isinstance(a.body, dict):
        return out, a.status
    for name, snap in a.body.items():
        if not isinstance(snap, dict):
            continue
        q0, t0 = snap.get("latestQuote"), snap.get("latestTrade")
        q: dict[str, Any] = q0 if isinstance(q0, dict) else {}
        t: dict[str, Any] = t0 if isinstance(t0, dict) else {}
        bp, ap = q.get("bp"), q.get("ap")
        if isinstance(bp, (int, float)) and isinstance(ap, (int, float)) and 0 < bp <= ap:
            out[str(name)] = (bp + ap) / 2
        elif isinstance(t.get("p"), (int, float)) and t["p"] > 0:
            out[str(name)] = float(t["p"])
    return out, a.status


def chain(get: Get, h: Mapping[str, str], root: str, mid: float, day: dt.date,
          rules: tiers.Rules = tiers.RULES) -> dict[str, Any]:
    """One name's chain inside tier 2's ranges, paged: page count, seconds, and the ask of each contract."""
    p = {"feed": "opra", "limit": "1000",
         "expiration_date_gte": day.isoformat(),
         "expiration_date_lte": (day + dt.timedelta(days=rules.t2_max_days)).isoformat(),
         "strike_price_gte": f"{mid * (1 - rules.t2_strike_pct / 100):.2f}",
         "strike_price_lte": f"{mid * (1 + rules.t2_strike_pct / 100):.2f}"}
    asks: dict[str, float | None] = {}
    pages, seconds, status, token = 0, 0.0, 0, None
    while pages < MAX_PAGES:
        a = get(f"{DATA_HOST}/v1beta1/options/snapshots/{root}", {**p, **({"page_token": token} if token else {})},
                h, TIMEOUT_S["chain"])
        pages, seconds, status = pages + 1, seconds + a.seconds, a.status
        if a.status != 200 or not isinstance(a.body, dict):
            break
        snaps = a.body.get("snapshots")
        for sym, snap in (snaps.items() if isinstance(snaps, dict) else []):
            q = snap.get("latestQuote") if isinstance(snap, dict) else None
            ap = q.get("ap") if isinstance(q, dict) else None
            asks[str(sym)] = float(ap) if isinstance(ap, (int, float)) else None
        token = a.body.get("next_page_token")
        if not token:
            break
    else:
        status = -1                                   # ran out of pages: not a usable answer
    return {"status": status, "pages": pages, "seconds": round(seconds, 3), "asks": asks}


def sweep(get: Get, h: Mapping[str, str], symbols: Sequence[str]) -> dict[str, Any]:
    """One tier-1 sweep as the recorder will make it: batches of 100, a few at a time."""
    batches = [list(symbols[i:i + BATCH]) for i in range(0, len(symbols), BATCH)]
    t = time.monotonic()
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        answers = list(pool.map(lambda b: get(f"{DATA_HOST}/v1beta1/options/snapshots",
                                              {"symbols": ",".join(b), "feed": "opra"}, h, TIMEOUT_S["sweep"]),
                                batches))
    return {"requests": len(batches), "seconds": round(time.monotonic() - t, 3),
            "failed": sum(a.status != 200 for a in answers),
            "bytes": sum(len(json.dumps(a.body)) for a in answers if a.status == 200)}


def run(get: Get, env: Mapping[str, str], names: Sequence[str], day: dt.date, now: dt.datetime,
        disk_free_gb: float, cal: Sequence[str] | None = None) -> dict[str, Any]:
    """Probe `names` (already checked against the focus list), judging tiers as of session `day`."""
    days = cal if cal is not None else tiers.sessions()
    pairs = check_pairs(get, env)
    use = best_pair(pairs)
    out: dict[str, Any] = {"v": 1, "ran_at": now.astimezone(dt.UTC).isoformat(timespec="seconds"),
                           "session": day.isoformat(), "names_source": "focus", "names": len(names), "pairs": pairs,
                           "pair_used": use, "free_disk_gb": round(disk_free_gb, 1)}
    per_name: dict[str, Any] = {}
    tier1: list[str] = []
    tier2_total, sweep_bytes = 0, 0
    sw: dict[str, Any] = {"requests": 0, "seconds": 0.0, "failed": 0, "bytes": 0}
    stock_status = None
    if use is not None and names:
        h = pair_headers(env, use) or {}
        mids, stock_status = stock_mids(get, h, names)
        for i, name in enumerate(names):
            label = f"name_{i + 1}"                       # counts only; the name itself is not written
            mid = mids.get(name)
            if mid is None:
                per_name[label] = {"stock_quote": False}
                continue
            c = chain(get, h, name, mid, day)
            t1 = [(s, occ.strike) for s, ask in c["asks"].items()
                  if tiers.tier(s, ask, mid, day, cal=days) == 1 and (occ := parse_occ(s)) is not None]
            kept = tiers.cap_tier1(t1, mid)
            # Over-cap tier-1 contracts are "every other contract" and so tier 2 (they are within 14 days and 8%).
            t2 = sum(1 for s, ask in c["asks"].items() if tiers.tier(s, ask, mid, day, cal=days) == 2) + len(t1) - len(kept)
            tier1 += kept
            tier2_total += t2
            per_name[label] = {"stock_quote": True, "chain_status": c["status"], "chain_pages": c["pages"],
                               "chain_seconds": c["seconds"], "in_range": len(c["asks"]),
                               "tier1": len(kept), "tier1_over_cap": len(t1) - len(kept), "tier2": t2}
        sw = sweep(get, h, tier1)
        sweep_bytes = sw["bytes"]
    out["stock_status"] = stock_status
    out["tier1_sweep"] = {k: v for k, v in sw.items() if k != "bytes"}
    out["per_name"] = per_name
    out["tier1_total"], out["tier2_total"] = len(tier1), tier2_total
    # An upper bound before change-only rows and compression: every tier-1 contract written at every 5-second sample.
    out["tier1_raw_mb_per_session_upper"] = round(sweep_bytes * (6.5 * 3600 / 5) / 1e6, 1)
    limit = (pairs.get(use or "", {}) or {}).get("rate_limit")
    measured = bool(names) and use is not None and len(per_name) == len(names) and all(
        v.get("stock_quote") and v.get("chain_status") == 200 for v in per_name.values())
    out["pass"] = {
        "session_known": day.isoformat() in days,
        "every_name_measured": measured,
        "rate_limit": limit is not None and limit >= PASS["rate_limit_per_min_at_least"],
        "tier1_sweep": measured and len(tier1) > 0 and sw["requests"] > 0 and sw["failed"] == 0
        and sw["seconds"] <= PASS["tier1_sweep_seconds_at_most"],
        "free_disk": disk_free_gb >= PASS["free_disk_gb_at_least"],
    }
    out["passed"] = all(out["pass"].values())
    return out


def desk_names(path: Path = CONFIG_DIR / "options_desk.yaml") -> set[str]:
    names = (yaml.safe_load(path.read_text()) or {}).get("names") or []
    return {str(n) for n in names}


def probe_session(today: dt.date, after_close: bool, cal: Sequence[str]) -> str | None:
    """The session the latest edition must be for: today's before its close, otherwise the next one."""
    t = today.isoformat()
    later = [s for s in cal if s > t]
    if t in cal and not after_close:
        return t
    return later[0] if later else None


def choose_names(f: focus.Focus | None, asked: Sequence[str] | None, want_session: str | None,
                 desk: set[str]) -> tuple[list[str], str | None]:
    """(names, refusal). Only the edition's focus names, from the desk's list; `asked` may only narrow them."""
    if f is None or not f.names:
        return [], "no focus list"
    if want_session is None or f.session != want_session:
        return [], "the focus list is not for the session being probed"
    names = [n for n in f.names if n in desk]
    if asked:
        extra = [n for n in asked if n not in names]
        if extra:
            return [], "--names may only narrow the focus list"
        names = [n for n in names if n in asked]
    return (names, None) if names else ([], "no focus name on the desk's list")


def write(path: Path, result: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(result, indent=2) + "\n")
    os.replace(tmp, path)


def main(argv: Sequence[str] | None = None, get: Get | None = None, now: dt.datetime | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--names", help="comma-separated symbols, a subset of the focus list")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    env = dict(os.environ)
    when = now or dt.datetime.now(dt.UTC)
    local = when.astimezone(NY)
    try:
        cal = tiers.sessions()
    except (OSError, ValueError, KeyError) as e:
        write(args.out, {"v": 1, "passed": False, "refused": f"market calendar unreadable: {e.__class__.__name__}"})
        return 1
    want = probe_session(local.date(), local.time() >= dt.time(16, 0), cal)
    asked = [n.strip().upper() for n in args.names.split(",") if n.strip()] if args.names else None
    names, refused = choose_names(focus.read(env), asked, want, desk_names())
    if refused:
        write(args.out, {"v": 1, "ran_at": when.isoformat(timespec="seconds"), "passed": False, "refused": refused})
        print(f"refused: {refused}")
        return 1
    free = shutil.disk_usage(args.out.parent if args.out.parent.exists() else STATE_DIR.parent).free / 1e9
    if get is None:
        with requests.Session() as s:
            result = run(http_get(s), env, names, dt.date.fromisoformat(str(want)), when, free, cal)
    else:
        result = run(get, env, names, dt.date.fromisoformat(str(want)), when, free, cal)
    write(args.out, result)
    print(json.dumps({k: result[k] for k in ("session", "pair_used", "tier1_total", "tier2_total", "free_disk_gb",
                                              "pass", "passed")}, indent=2))
    print(f"written: {args.out}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
