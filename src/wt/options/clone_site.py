"""The options clone and the dashboard (DEC-0030): the focus names in, the clone's document out.

In: `read_focus` asks the dashboard's signed `GET /api/focus` for the latest options edition's "Today's focus"
names. Any failure is (None, None), and the runner then trades its fallback names.

Out: `build` turns the runner's state into `stocksdelta/options-clone` v1, SAFE data only (AGENTS.md): counts, ids,
statuses, codes, dates and statistics. No balance, no free text, and no setup name: a trade carries its hypothesis
id. `Publisher` sends the newest document from a thread of its own, so a slow site never holds up a poll.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import statistics
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

import requests

from wt.core.config import ROOT
from wt.oms.options import DONE, trade_row
from wt.ops import publish
from wt.options import review

SCHEMA_ID = "stocksdelta/options-clone"
SCHEMA_VERSION = 1
SCHEMA_PATH = ROOT / "dashboard" / "src" / "lib" / "options-clone.schema.json"
FOCUS_PATH = "/api/focus"
HYP = {"retest": "HYP-0029", "rejection": "HYP-0030"}
SEND_TRIES = 2

_CODE = re.compile(r"^[a-z0-9_-]{1,32}$")
_SYMBOL = re.compile(r"^[A-Z][A-Z.]{0,9}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BIAS = ("breakout", "support", "range")


# ---------------------------------------------------------------- in: the focus names
def focus_url(ingest_url: str) -> str | None:
    out = re.sub(r"/api/ingest/?$", FOCUS_PATH, ingest_url)
    return out if out != ingest_url else None


def focus_signature(secret: str, ts: int) -> str:
    """The route signs no body: the method and path stand in for it, so a signature is good for this route only."""
    return publish.sign(f"GET {FOCUS_PATH}".encode(), secret, ts)


def read_focus(env: Mapping[str, str] | None = None, session_: requests.Session | None = None,
               now: Callable[[], float] = time.time) -> tuple[dict[str, Any] | None, str | None]:
    """({"items": [{symbol, rank, bias}]}, the edition's session) from the dashboard, or (None, None)."""
    e = os.environ if env is None else env
    ingest, secret = e.get("DASHBOARD_INGEST_URL"), e.get("DASHBOARD_INGEST_SECRET")
    url = focus_url(ingest) if ingest else None
    if not url or not secret:
        return None, None
    ts = int(now())
    headers = {"x-wt-timestamp": str(ts), "x-wt-signature": focus_signature(secret, ts)}
    if kid := e.get("DASHBOARD_KEY_ID"):
        headers["x-wt-key-id"] = kid
    if bypass := e.get("VERCEL_AUTOMATION_BYPASS_SECRET"):
        headers["x-vercel-protection-bypass"] = bypass
    try:
        r = (session_ or requests).get(url, headers=headers, timeout=(5.0, 10.0), allow_redirects=False)
        if r.status_code != 200:
            return None, None
        body = r.json()
    except (requests.RequestException, ValueError):
        return None, None
    if not isinstance(body, dict):
        return None, None
    session, items = body.get("session"), body.get("items")
    if not isinstance(session, str) or not _DATE.match(session) or not isinstance(items, list):
        return None, None
    clean = []
    for i in items:
        if not isinstance(i, dict) or not isinstance(i.get("symbol"), str) or not _SYMBOL.match(i["symbol"]):
            continue
        rank = i.get("rank")
        clean.append({"symbol": i["symbol"], "rank": rank if isinstance(rank, int) and not isinstance(rank, bool) else 99,
                      "bias": i.get("bias") if i.get("bias") in _BIAS else None})
    return {"items": clean}, session


# ---------------------------------------------------------------- out: the clone's document
def _code(v: Any) -> str | None:
    s = str(v) if v not in (None, "") else None
    return s if s is None or _CODE.match(s) else "other"


def _num(v: Any, nd: int = 4) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return round(x, nd) if x == x and abs(x) != float("inf") else None


def _median(xs: Iterable[float], nd: int = 2) -> float | None:
    v = list(xs)
    return round(float(statistics.median(v)), nd) if v else None


def read_decisions(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    out.append(rec)
    except OSError:
        pass
    return out


def _figures(name: str, f: Mapping[str, Any]) -> dict[str, Any]:
    ci = [f.get("ci_session"), f.get("ci_trade")]
    return {
        "hyp": HYP.get(name, "all"), "trades": int(f.get("trades", 0)), "sessions": int(f.get("sessions", 0)),
        "unresolved": int(f.get("unresolved", 0)), "win_rate": _num(f.get("win_rate")), "mean_rop": _num(f.get("mean_rop")),
        "ci_session": [_num(x) for x in ci[0]] if ci[0] else None, "ci_trade": [_num(x) for x in ci[1]] if ci[1] else None,
        "first_half_mean": _num(f.get("first_half_mean")), "second_half_mean": _num(f.get("second_half_mean")),
        "profit_factor": _num(f.get("profit_factor")), "expectancy_usd": _num(f.get("expectancy_usd"), 2),
        "total_usd": _num(f.get("total_usd"), 2), "max_drawdown_usd": _num(f.get("max_drawdown_usd"), 2),
        "longest_losing_streak": int(f.get("longest_losing_streak", 0)), "mfe_captured": _num(f.get("mfe_captured")),
        "exits": {c: int(n) for k, n in (f.get("exits") or {}).items() if (c := _code(k)) is not None},
        "verdict": f.get("verdict") if f.get("verdict") in ("none", "falsified", "passes") else "none",
    }


def build(r: Any, now: dt.datetime, run_id: str, final: bool = False) -> dict[str, Any]:
    """The document for one moment of a runner (wt.live.runner_o.Runner)."""
    today = r.today()
    day_pnl, _, _ = r.pnl_view()
    since = now - dt.timedelta(minutes=10)
    stops = [p.broker_stop for p in r.plans if p.broker_stop in ("accepted", "refused")]
    slips = [(p.fill - p.quoted_ask) / p.quoted_ask * 100 for p in today if p.fill is not None and p.quoted_ask]
    done = [trade_row(p, r.fee) for p in r.plans if p.state in DONE and p.fill is not None]
    gates = review.day_line(read_decisions(r.state / "decisions" / f"{r.session}.jsonl"))
    latch = r.latches.active(r.day)
    return {
        "schema": SCHEMA_ID, "schema_version": SCHEMA_VERSION, "run_id": run_id, "as_of": now.astimezone(dt.UTC).isoformat(),
        "paper": True, "final": final, "session": r.session,
        "names": sorted(r.names), "names_source": getattr(r, "names_source", None),
        "entries": {"used": sum(p.fill is not None for p in today), "max": int(r.lim.max_entries_per_day)},
        "day_pnl": {"usd": round(day_pnl, 2), "limit_usd": float(r.lim.day_loss_latch)},
        "latch": latch if latch in ("day", "week", "drawdown") else None,
        "off": sorted({c for k in r.off if (c := _code(k)) is not None}),
        "feed_unfit": "feed" in r.off,
        "flatten_required": bool(r.paged_critical or "position-at-arm" in r.off),
        "broker_stop": "refused" if "refused" in stops else ("accepted" if stops else None),
        "quote_age_median_s": _median(a for t, a in r.quote_ages if t >= since),
        "slippage_median_pct": _median(slips[-10:]),
        "trades": [{"trade_id": p.trade_id, "hyp": HYP.get(review.trial_of(p.setup, p.symbol, p.date), "other"),
                    "side": p.side, "contract": p.symbol,
                    "state": p.state, "fill": _num(p.fill), "exit_fill": _num(p.exit_fill),
                    "exit_reason": _code(p.exit_reason), "rop": p.return_on_premium(r.fee)}
                   for p in sorted(today, key=lambda q: q.trade_id) if p.state not in ("new", "cancelled", "rejected")],
        "gates": [{"symbol": root, "bars": n["bars"], "setups": n["setups"], "entered": n["entered"],
                   "refused_by": {c: v for g, v in sorted(n["refused_by"].items()) if (c := _code(g)) is not None}}
                  for root, n in sorted(gates.items()) if _SYMBOL.match(root)],
        "setups": [_figures(name, f) for name, f in review.review(done).items()],
    }


def body(doc: Mapping[str, Any]) -> bytes:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def validate(doc: Mapping[str, Any], schema_path: Path = SCHEMA_PATH) -> list[str]:
    """The site's own contract, read from the checkout: what fails here would be refused there."""
    import jsonschema
    v = jsonschema.Draft7Validator(json.loads(schema_path.read_text()))
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.validator}" for e in v.iter_errors(doc)][:20]


class Publisher:
    """Sends the newest document from a thread of its own. Latest wins: a document still waiting when a newer one
    arrives is dropped. It writes nothing anywhere; `sent` and `failed` are read at the close."""

    def __init__(self, send: Callable[[bytes], tuple[bool, str]]) -> None:
        self._send = send
        self._cv = threading.Condition()
        self._next: bytes | None = None
        self._closed = False
        self.sent = self.failed = 0
        self.last = ""
        self._t = threading.Thread(target=self._loop, name="options-clone-publish", daemon=True)
        self._t.start()

    def post(self, data: bytes) -> None:
        with self._cv:
            self._next = data
            self._cv.notify()

    def _loop(self) -> None:
        while True:
            with self._cv:
                while self._next is None and not self._closed:
                    self._cv.wait()
                if self._next is None:
                    return
                data, self._next = self._next, None
            try:
                ok, detail = self._send(data)
            except Exception as e:  # noqa: BLE001 — a fault here must never reach the runner
                ok, detail = False, e.__class__.__name__
            self.last = publish.error_code(detail) if not ok else "ok"
            if ok:
                self.sent += 1
            else:
                self.failed += 1

    def close(self, timeout_s: float = 30.0) -> None:
        """Sends what is waiting, then stops, within `timeout_s`."""
        with self._cv:
            self._closed = True
            self._cv.notify()
        self._t.join(timeout_s)


def publisher_from_env(env: Mapping[str, str] | None = None) -> Publisher | None:
    """None when this host may not publish (no URL or secret, or a shadow host without its own key)."""
    e = os.environ if env is None else env
    url, secret = e.get("DASHBOARD_INGEST_URL"), e.get("DASHBOARD_INGEST_SECRET")
    if not url or not secret or publish.shadow_key_problem(dict(e)) is not None:
        return None
    bypass = e.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    return Publisher(lambda data: publish.send(data, url, secret, bypass, tries=SEND_TRIES, key_id=e.get("DASHBOARD_KEY_ID")))
