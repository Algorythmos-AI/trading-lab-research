"""Gap Hunter: did an entry order expire although the tape reached it? Counts only, one line a session.

Each Gap Hunter entry is a buy stop-limit (`wt.oms.manager`): a trade at or over `trigger` turns it into a limit buy
at `limit`, which may then fill at any price at or under the limit. The desk cancels it at its expiry. An order the
desk cancelled for expiry (`why: expired`) with nothing filled is put in one of three classes, from the consolidated
tape's trades (SIP, DEC-0064) between the moment it was placed and the moment the broker confirmed the cancel (the
first `entry_cancelled` row whose state is no longer `entry_working`; an unconfirmed cancel leaves the order resting):

  not_reached   no trade at or over the trigger while it rested: the rule's ordinary miss
  over_limit    the tape reached the trigger, but every trade from then on was over the limit: a gap through the band
  in_band       at or after the first trigger trade, a trade at or under the limit came while it rested: the order
                could have filled and did not. Look at that order (broker record, journal, trade conditions)

Entries cancelled for any other reason (withdrawn, replaced, window closed, ...) are counted as `other_cancel` and not
judged.

`in_band` is a flag for a person, not a verdict: a trade condition the broker ignores (an odd lot, a late report) can
make it, and so can a queue that the limit price did not reach. The exit code is 1 when any order is `in_band`.

It reads the journal (data/live/smallcap_journal.jsonl) for the order rows and the market-data API for trades in each
order's own window, so it runs where the keys are. It places nothing and reads nothing after an order's window: no
fill price, no exit, no result. A line carries a date and counts: no symbol, no price (DEC-0076 is counts only).

Usage (on the host, as wt, from the live checkout):
  PYTHONPATH=src .venv/bin/python scripts/gap_expiry_audit.py 2026-11-27 [2026-11-30]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

CLASSES = ("not_reached", "over_limit", "in_band")
WORKING = "entry_working"             # an entry the broker has not confirmed cancelled is still resting
TRADE_PAGES = 50                      # trade pages per order window; a window that needs more is reported, not guessed


@dataclass(frozen=True)
class Expired:
    """One entry order that was cancelled with nothing filled."""
    day: str
    trade_id: str
    symbol: str
    trigger: float
    limit: float
    placed: dt.datetime
    ended: dt.datetime


def _ts(v: Any) -> dt.datetime:
    t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def _prices(r: dict[str, Any]) -> tuple[float, float] | None:
    """The order's trigger and limit: the row's own keys, else its `detail` note (["entry_placed", trigger, limit,
    qty]), which every placed entry carries."""
    trig, lim = r.get("trigger"), r.get("limit")
    if trig is None:
        for d in r.get("detail") or []:
            if isinstance(d, list) and len(d) >= 3 and d[0] == "entry_placed":
                trig, lim = d[1], d[2]
    try:
        return float(trig), float(lim)          # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def expired_orders(rows: Iterable[dict[str, Any]], days: set[str]) -> tuple[list[Expired], dict[str, dict[str, int]]]:
    """The expired, unfilled entries of the given sessions, and per session how many entries were placed and how many
    were cancelled, unfilled, for another reason. The window ends at the confirmed cancel; an entry with no confirmed
    cancel row (still resting, or the journal cut short) is not judged."""
    placed: dict[str, dict[str, Any]] = {}
    why_of: dict[str, str] = {}                 # the reason on the entry's first cancel row
    tally: dict[str, dict[str, int]] = {d: {"placed": 0, "other_cancel": 0} for d in days}
    out: list[Expired] = []
    for r in rows:
        ev, tid = r.get("event"), r.get("trade_id")
        if not tid or str(tid)[:10] not in days:
            continue
        tid = str(tid)
        if ev == "entry_placed":
            placed[tid] = r
            tally[tid[:10]]["placed"] += 1
        elif ev == "entry_cancelled" and tid in placed:
            why_of.setdefault(tid, str(r.get("why") or ""))
            if r.get("filled"):
                placed.pop(tid)                 # it filled (in part): a trade, not a miss
                continue
            if r.get("state") == WORKING:
                continue                        # the broker has not confirmed the cancel: it is still resting
            p = placed.pop(tid)
            if why_of[tid] != "expired":
                tally[tid[:10]]["other_cancel"] += 1
                continue
            px = _prices(p)
            if px is None or not p.get("symbol"):
                continue
            out.append(Expired(tid[:10], tid, str(p["symbol"]), px[0], px[1], _ts(p["ts"]), _ts(r["ts"])))
    return out, tally


def classify(trades: Iterable[tuple[dt.datetime, float]], o: Expired) -> str:
    """not_reached, over_limit or in_band, from the trades inside [placed, ended)."""
    inside = sorted((t, p) for t, p in trades if o.placed <= t < o.ended)
    first = next((t for t, p in inside if p >= o.trigger - 1e-9), None)
    if first is None:
        return "not_reached"
    if any(t >= first and p <= o.limit + 1e-9 for t, p in inside):     # once triggered it is a limit buy
        return "in_band"
    return "over_limit"


def session_lines(orders: list[Expired], tally: dict[str, dict[str, int]],
                  trades_of: Callable[[Expired], list[tuple[dt.datetime, float]]]) -> list[dict[str, Any]]:
    """One line a session: a date and counts only."""
    lines: dict[str, dict[str, Any]] = {d: {"date": d, "placed": t["placed"], "other_cancel": t["other_cancel"],
                                            "expired": 0, **{c: 0 for c in CLASSES}} for d, t in tally.items()}
    for o in orders:
        line = lines[o.day]
        line["expired"] += 1
        line[classify(trades_of(o), o)] += 1
    return [lines[d] for d in sorted(lines)]


def sip_trades(a: Any, o: Expired) -> list[tuple[dt.datetime, float]]:
    """The consolidated tape's trades in the order's window, every page (wt.data.alpaca.AlpacaREST.get)."""
    from wt.data.alpaca import DATA
    params: dict[str, Any] = {"symbols": o.symbol, "feed": "sip", "limit": 10000,
                              "start": o.placed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                              "end": o.ended.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    out: list[tuple[dt.datetime, float]] = []
    for _ in range(TRADE_PAGES):
        j = a.get(f"{DATA}/v2/stocks/trades", params)
        for t in ((j.get("trades") or {}).get(o.symbol) or []):
            out.append((_ts(t["t"]), float(t["p"])))
        token = j.get("next_page_token")
        if not token:
            return out
        params["page_token"] = token
    raise RuntimeError("trades: more pages than the cap")


def main(start: str, end: str) -> int:
    from wt.data.alpaca import AlpacaREST
    from wt.live import runner_s
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    days = {str(s + dt.timedelta(days=i)) for i in range((e - s).days + 1)}
    orders, tally = expired_orders(runner_s.journal_rows(), days)
    tally = {d: t for d, t in tally.items() if t["placed"]}
    a = AlpacaREST(per_minute=150, shared=True)
    lines = session_lines(orders, tally, lambda o: sip_trades(a, o))
    for line in lines:
        print(json.dumps(line), flush=True)
    total = {c: sum(x[c] for x in lines) for c in ("placed", "other_cancel", "expired", *CLASSES)}
    print(json.dumps({"sessions": len(lines), **total}))
    return 1 if total["in_band"] else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("start")
    ap.add_argument("end", nargs="?")
    args = ap.parse_args()
    sys.exit(main(args.start, args.end or args.start))
