"""After the close (DEC-0060 section 2.4): the day's option trade prints for the tier-1 contracts, and the open
interest of every recorded contract, written into the session folder before its manifest.

Alpaca's option trades endpoint (`/v1beta1/options/trades`) takes no feed: its prints are OPRA's. Open interest comes
from the trading API's contract listing (`/v2/options/contracts`), the only place Alpaca gives it; it is read for the
recorded contracts' names only and never touches an account. Both stop at a hard deadline; what is not fetched by
then is written down as a gap.
"""
from __future__ import annotations

import datetime as dt
import time
from collections.abc import Mapping, Sequence
from typing import Any

from wt.lab.probe import DATA_HOST, Answer, Get
from wt.lab.tape import PartWriter, _cnt, _num, _str

PAPER_HOST = "https://paper-api.alpaca.markets"
BATCH = 100
PAGE = "10000"
MAX_PAGES = 400


def _z(t: dt.datetime) -> str:
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def prints(get: Get, headers: Mapping[str, str], symbols: Sequence[str], start: dt.datetime, end: dt.datetime,
           out: PartWriter, gap: PartWriter, deadline: float, timeout: float = 10.0) -> dict[str, int]:
    """Every print of `symbols` between `start` and `end`, paged; counts of prints, requests and failed batches."""
    syms = sorted(set(symbols))
    counts = {"prints": 0, "requests": 0, "failed": 0, "not_reached": 0}
    for i in range(0, len(syms), BATCH):
        batch = syms[i:i + BATCH]
        token: str | None = None
        for _ in range(MAX_PAGES):
            if time.monotonic() > deadline:
                counts["not_reached"] += 1
                gap.add({"recv_ns": time.time_ns(), "tick": -1, "stream": "print", "reason": "deadline"})
                return counts
            params = {"symbols": ",".join(batch), "start": _z(start), "end": _z(end), "limit": PAGE,
                      **({"page_token": token} if token else {})}
            a: Answer = get(f"{DATA_HOST}/v1beta1/options/trades", params, headers, timeout)
            counts["requests"] += 1
            body = a.body if a.status == 200 and isinstance(a.body, dict) else None
            trades = body.get("trades") if body else None
            if not isinstance(trades, Mapping):
                counts["failed"] += 1
                gap.add({"recv_ns": time.time_ns(), "tick": -1, "stream": "print", "reason": f"status {a.status}"})
                break
            recv = time.time_ns()
            for sym, rows in trades.items():
                for r in rows if isinstance(rows, list) else []:
                    if not isinstance(r, Mapping):
                        continue
                    c = r.get("c")
                    out.add({"recv_ns": recv, "symbol": str(sym), "ts": _str(r.get("t")), "price": _num(r.get("p")),
                             "size": _cnt(r.get("s")), "exchange": _str(r.get("x")),
                             "conditions": c if isinstance(c, str) else ",".join(str(x) for x in c)
                             if isinstance(c, list) else None})
                    counts["prints"] += 1
            nxt = body.get("next_page_token") if body else None
            token = nxt if isinstance(nxt, str) and nxt else None
            if token is None:
                break
        else:
            gap.add({"recv_ns": time.time_ns(), "tick": -1, "stream": "print", "reason": "page limit"})
    return counts


def open_interest(get: Get, headers: Mapping[str, str], roots: Sequence[str], first: dt.date, last: dt.date,
                  keep: set[str], out: PartWriter, gap: PartWriter, deadline: float,
                  timeout: float = 10.0) -> dict[str, int]:
    """The listed open interest of the recorded contracts (`keep`), by root and expiry span."""
    counts = {"contracts": 0, "requests": 0, "failed": 0}
    for root in sorted(set(roots)):
        token: str | None = None
        for _ in range(20):
            if time.monotonic() > deadline:
                gap.add({"recv_ns": time.time_ns(), "tick": -1, "stream": "open_interest", "reason": "deadline"})
                return counts
            params = {"underlying_symbols": root, "status": "active", "limit": PAGE,
                      "expiration_date_gte": first.isoformat(), "expiration_date_lte": last.isoformat(),
                      **({"page_token": token} if token else {})}
            a = get(f"{PAPER_HOST}/v2/options/contracts", params, headers, timeout)
            counts["requests"] += 1
            body = a.body if a.status == 200 and isinstance(a.body, dict) else None
            rows = body.get("option_contracts") if body else None
            if not isinstance(rows, list):
                counts["failed"] += 1
                gap.add({"recv_ns": time.time_ns(), "tick": -1, "stream": "open_interest",
                         "reason": f"status {a.status} {root}"})
                break
            recv = time.time_ns()
            for r in rows:
                if isinstance(r, Mapping) and r.get("symbol") in keep:
                    out.add({"recv_ns": recv, "symbol": str(r["symbol"]), "open_interest": _cnt(_as_num(r.get("open_interest"))),
                             "open_interest_date": _str(r.get("open_interest_date")),
                             "close_price": _num(_as_num(r.get("close_price")))})
                    counts["contracts"] += 1
            nxt = body.get("next_page_token") if body else None
            token = nxt if isinstance(nxt, str) and nxt else None
            if token is None:
                break
    return counts


def _as_num(v: Any) -> Any:
    """The contracts endpoint sends numbers as strings."""
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return v
