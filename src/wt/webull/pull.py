"""Read the owner's Webull account into the state directory (ADR 0011). Runs as `wt-webull`, never as `wt`.

    python -m wt.webull.pull [--state DIR] [--creds FILE]

systemd (deploy/oci/systemd/wt-webull-pull.service) passes the key as a credential ($CREDENTIALS_DIRECTORY/webull)
and the state directory as $STATE_DIRECTORY (/var/lib/wt-webull). What it writes, group-readable for the publisher:

    out/orders/YYYY-MM-DD.json   the order groups placed that UTC day, as Webull returned them
    out/history.json             how far back the order files are complete: {"from", "through", "complete"}
    out/working.json             the days whose file holds an order still working when it was last read
    out/account.jsonl            one balance reading per line (AUD and USD rows; no account id)
    out/positions.json           the positions Webull reports now, for the publisher's reconcile
    out/status.json              when this ran and how it ended (below)

status.json: {"at", "ok", "state", "since", "last_ok", "reason", "kind", "unknown_status"}. `state` is "ok",
"failing" or "approval"; `since` is when it entered that state; `reason` is an exception's class name or
"HTTP <status>" (never a header, a body or a URL); `kind` is "transient" (the network, a timeout, HTTP 5xx or 429:
the next read may not meet it), "error" (Webull refused, or no usable credential) or "bug" (anything else); and
`unknown_status` counts the orders read whose status is none this module knows. How it ends, and who pages:
  * ok, failing: exit 0. The job never pages through OnFailure for these, so a network outage does not page every
    2 minutes. The publisher (OnSuccess, the next unit) pages once when the state changes, once more if it is still
    failing after 30 minutes, and once when it works again (wt.webull.publish, "Alarms").
  * a new token waits for the owner's approval: exit 3 (EXIT_APPROVAL), which pages through OnFailure, once per
    token asked for. Until it is approved, or 6 hours pass, later runs exit 0 with state "approval".
  * anything else (a bug, a changed answer, a full disk): state "failing", kind "bug", exit 0, paged the same way.
  A pull that stops running at all is caught by the watch in the dashboard job (wt.webull.publish.watch).

The token (token.json) stays 0600, readable by this user only. Log lines carry counts and outcomes only: no
symbol, price, account id, key or token. In the session it refreshes today and yesterday; after 16:30 New York it
refreshes the last four days and has a longer budget for the one-time backfill of the history since HISTORY_FROM.
Webull files an order under the day it was placed, so a fill days later lands in an old day's file: every run also
reads again each older day that held a working order when it was last read (working.json), within the same budget.
The backfill (about 1,100 days at one call a second) is longer than one evening's budget: it keeps its place in
history.json and goes on from there the next run, so the first one may take two evening runs.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from wt.webull.client import (Credentials, NeedsApproval, ReadOnlyClient, StillWaiting, TokenStore, Transient,
                              WebullError)

ET = ZoneInfo("America/New_York")
HISTORY_FROM = dt.date(2023, 11, 1)        # the account's first order (journal history_from, Nov 2023)
PAGE_CAP = 100                             # Webull returns at most 100 order groups per call
EXIT_APPROVAL = 3                          # the owner must approve a token in the Webull app (pages through OnFailure)
STATES = ("ok", "failing", "approval")
SNAPSHOT_EVERY_S = 25 * 60
# An order in any other status (submitted, partly filled, pending a cancel ...) may still fill: its day is read again.
TERMINAL = frozenset({"FILLED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "FAILED"})
# Statuses seen as working; any other (or none) is still treated by `working`, and counted in status.json.
KNOWN_WORKING = frozenset({"SUBMITTED", "PENDING", "PARTIAL_FILLED", "PARTIALLY_FILLED", "WORKING", "PENDING_CANCEL",
                           "NEW", "ACCEPTED"})


def log(msg: str) -> None:
    print(f"{dt.datetime.now(dt.UTC):%Y-%m-%dT%H:%M:%SZ} webull-pull {msg}", flush=True)


def write_json(path: Path, data: Any) -> None:
    """Atomic, 0640: the publisher (group wt) reads it, nobody else."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def utc_day(d: dt.date) -> tuple[dt.datetime, dt.datetime]:
    a = dt.datetime.combine(d, dt.time(), dt.UTC)
    return a, a + dt.timedelta(days=1)


def read_window(c: ReadOnlyClient, aid: str, a: dt.datetime, b: dt.datetime) -> list[dict[str, Any]]:
    """Every order group placed in [a, b): a full answer is read again in 10-minute, then 1-minute slices."""
    rows = c.order_history(aid, a, b)
    if len(rows) < PAGE_CAP:
        return rows
    step = dt.timedelta(minutes=10) if b - a > dt.timedelta(minutes=10) else dt.timedelta(minutes=1)
    if b - a <= step:
        log("warn: a one-minute slice still holds 100 orders; some may be missing")
        return rows
    out: list[dict[str, Any]] = []
    t = a
    while t < b:
        out += read_window(c, aid, t, min(t + step, b))
        t += step
    return out


def _filled(o: dict[str, Any]) -> float:
    try:
        return float(o.get("filled_quantity") or 0)
    except (TypeError, ValueError):
        return 0.0


def merge_day(old: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What a day's file holds after a read: Webull's new answer, except that no order is ever dropped and an order
    only gains fills. A short or empty answer (a 200 with less in it) must not erase fills already read."""
    before = {str(o.get("order_id")): o for g in old for o in g.get("orders") or [] if isinstance(o, dict)}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for g in new:
        orders = []
        for o in g.get("orders") or []:
            oid = str(o.get("order_id"))
            prev = before.get(oid)
            orders.append(prev if prev is not None and _filled(prev) > _filled(o) else o)
            seen.add(oid)
        out.append({**g, "orders": orders})
    for g in old:
        left = [o for o in g.get("orders") or [] if isinstance(o, dict) and str(o.get("order_id")) not in seen]
        if left:
            out.append({**g, "orders": left})
            seen |= {str(o.get("order_id")) for o in left}
    return out


def save_day(c: ReadOnlyClient, aid: str, out: Path, d: dt.date, stats: dict[str, int] | None = None) -> int:
    path = out / "orders" / f"{d.isoformat()}.json"
    old = read_json(path, [])
    groups = merge_day([g for g in old if isinstance(g, dict)] if isinstance(old, list) else [],
                       read_window(c, aid, *utc_day(d)))
    seen: dict[tuple[Any, ...], dict[str, Any]] = {}
    for g in groups:
        seen[(g.get("client_order_id"),) + tuple(o.get("order_id") for o in g.get("orders") or [])] = g
    write_json(path, list(seen.values()))
    orders = [o for g in seen.values() for o in g.get("orders") or []]
    mark_working(out, d, any(working(o) for o in orders))
    if stats is not None:
        stats["unknown_status"] = stats.get("unknown_status", 0) + sum(
            1 for o in orders if str(o.get("status") or "").upper() not in TERMINAL | KNOWN_WORKING)
    return len(seen)


def working(order: dict[str, Any]) -> bool:
    """Whether an order may still fill: any status but a final one; with no status, while it has filled less than
    its quantity (a quantity it does not give: not working, and counted in status.json as an unknown status)."""
    status = str(order.get("status") or "").upper()
    if status:
        return status not in TERMINAL
    qty = next((order[k] for k in ("total_quantity", "quantity", "qty") if order.get(k) not in (None, "")), None)
    try:
        return qty is not None and _filled(order) < float(qty)
    except (TypeError, ValueError):
        return False


def working_days(out: Path) -> list[dt.date]:
    days = read_json(out / "working.json", [])
    out_: list[dt.date] = []
    for d in days if isinstance(days, list) else []:
        try:
            out_.append(dt.date.fromisoformat(str(d)))
        except ValueError:
            continue
    return sorted(set(out_))


def mark_working(out: Path, d: dt.date, on: bool) -> None:
    days = set(working_days(out))
    if (d in days) != on:
        days = days | {d} if on else days - {d}
        write_json(out / "working.json", sorted(x.isoformat() for x in days))


def month_end(d: dt.date) -> dt.date:
    return (d.replace(day=1) + dt.timedelta(days=32)).replace(day=1)


def backfill(c: ReadOnlyClient, aid: str, out: Path, upto: dt.date, deadline: float,
             clock: Callable[[], float], stats: dict[str, int] | None = None) -> dict[str, Any]:
    """Fill the order files from HISTORY_FROM up to (not including) `upto`, as far as the budget allows."""
    h = read_json(out / "history.json", {})
    start = dt.date.fromisoformat(h["through"]) + dt.timedelta(days=1) if h.get("through") else HISTORY_FROM
    days = 0

    def mark(through: dt.date) -> None:
        write_json(out / "history.json", {"from": HISTORY_FROM.isoformat(), "through": through.isoformat(),
                                          "complete": through >= upto - dt.timedelta(days=1)})

    while start < upto and clock() < deadline:
        nxt = min(month_end(start), upto)
        if start.day == 1 or start == HISTORY_FROM:          # one probe skips a month with no orders
            if not c.order_history(aid, utc_day(start)[0], utc_day(nxt)[0]):
                mark(nxt - dt.timedelta(days=1))
                start = nxt
                continue
        while start < nxt and clock() < deadline:
            save_day(c, aid, out, start, stats)
            mark(start)
            days += 1
            start += dt.timedelta(days=1)
    through = start - dt.timedelta(days=1)
    if through >= HISTORY_FROM:
        mark(through)
    done = through >= upto - dt.timedelta(days=1)
    if days:
        log(f"backfill: {days} days read, complete={done}")
    return {"from": HISTORY_FROM.isoformat(), "through": through.isoformat(), "complete": done}


def snapshot(c: ReadOnlyClient, aid: str, out: Path, now: dt.datetime) -> bool:
    """One balance reading, at most every SNAPSHOT_EVERY_S. Only the totals and the per-currency rows are kept."""
    path = out / "account.jsonl"
    data = path.read_bytes() if path.exists() else b""
    last = last_reading(data)
    if last and (now - dt.datetime.fromisoformat(last["at"].replace("Z", "+00:00"))).total_seconds() < SNAPSHOT_EVERY_S:
        return False
    r = c.balance(aid)
    def f(x: Any) -> float:
        return float(x or 0)
    by = {row.get("currency"): row for row in r.get("account_currency_assets") or [] if isinstance(row, dict)}
    row = {"at": now.isoformat().replace("+00:00", "Z"), "currency": "AUD",
           "cash": round(f(r.get("total_cash_balance")), 2), "market_value": round(f(r.get("total_market_value")), 2),
           "unrealized": round(f(r.get("total_unrealized_profit_loss")), 2),
           "aud_cash": round(f(by.get("AUD", {}).get("cash_balance")), 2),
           "usd_cash": round(f(by.get("USD", {}).get("cash_balance")), 2),
           "usd_market_value": round(f(by.get("USD", {}).get("market_value")), 2)}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
    with os.fdopen(fd, "a") as fh:            # a torn last line is ended first, so it never swallows this one
        fh.write(("" if not data or data.endswith(b"\n") else "\n") + json.dumps(row, separators=(",", ":")) + "\n")
    return True


def last_reading(data: bytes) -> dict[str, Any] | None:
    """The newest whole reading in account.jsonl. A line cut short by a crash (the last one, as a rule) is passed
    over, as wt.core.ledger does: the reading before it counts, and the next append starts on a line of its own."""
    for line in reversed(data.split(b"\n")):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and isinstance(row.get("at"), str):
            try:
                dt.datetime.fromisoformat(row["at"].replace("Z", "+00:00"))
            except ValueError:
                continue
            return row
    return None


def run(c: ReadOnlyClient, out: Path, now: dt.datetime, clock: Callable[[], float] = time.time) -> dict[str, Any]:
    evening = now.astimezone(ET).time() >= dt.time(16, 30) or now.astimezone(ET).weekday() >= 5
    refresh = 4 if evening else 2
    budget = 900.0 if evening else 45.0
    started = clock()
    accts = c.accounts()
    if not accts:
        raise WebullError(200, "NO_ACCOUNT")
    aid = str(accts[0]["account_id"])
    today = now.astimezone(dt.UTC).date()
    n = 0
    stats: dict[str, int] = {"unknown_status": 0}
    for k in range(refresh):
        n += save_day(c, aid, out, today - dt.timedelta(days=k), stats)
    older = [d for d in working_days(out) if HISTORY_FROM <= d < today - dt.timedelta(days=refresh - 1)]
    reread = 0
    for d in older:                            # oldest first; what the budget leaves is read on the next run
        if clock() >= started + budget:
            break
        save_day(c, aid, out, d, stats)
        reread += 1
    if older:
        log(f"working orders: {reread} of {len(older)} older day(s) read again")
    h = backfill(c, aid, out, today - dt.timedelta(days=refresh - 1), started + budget, clock, stats)
    snap = snapshot(c, aid, out, now)
    pos = c.positions(aid)
    write_json(out / "positions.json", {"at": now.isoformat().replace("+00:00", "Z"), "positions": pos})
    log(f"ok: {n} order groups in the last {refresh} days, history complete={h['complete']}, "
        f"snapshot={'taken' if snap else 'skipped'}, {len(pos)} positions")
    return {"groups": n, "complete": h["complete"], **stats}


def iso(t: dt.datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


def set_status(out: Path, now: dt.datetime, state: str, reason: str = "", kind: str = "",
               **extra: Any) -> dict[str, Any]:
    """Write status.json for this run and return the previous one. `since` carries over while the state holds."""
    prev = read_json(out / "status.json", {})
    prev = prev if isinstance(prev, dict) else {}
    at = iso(now)
    same = prev.get("state") == state and isinstance(prev.get("since"), str)
    doc: dict[str, Any] = {"at": at, "ok": state == "ok", "state": state, "since": prev["since"] if same else at,
                           "last_ok": at if state == "ok" else prev.get("last_ok")}
    if reason:
        doc["reason"], doc["kind"] = reason, kind
    if state == "approval" and prev.get("state") == "approval" and "approval_paged" in prev:
        doc["approval_paged"] = prev["approval_paged"]
    doc.update(extra)
    write_json(out / "status.json", doc)
    return prev


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.webull.pull")
    ap.add_argument("--state", type=Path, default=Path(os.environ.get("STATE_DIRECTORY", "/var/lib/wt-webull")))
    ap.add_argument("--creds", type=Path,
                    default=Path(os.environ.get("CREDENTIALS_DIRECTORY", "/nonexistent")) / "webull")
    a = ap.parse_args(argv)
    os.umask(0o027)
    out = a.state / "out"
    now = dt.datetime.now(dt.UTC).replace(microsecond=0)
    try:
        creds = Credentials.from_file(a.creds)
    except (OSError, ValueError) as e:
        log(f"stop: no usable credential ({e.__class__.__name__}); run sudo wt-set-webull-secret")
        _status_quietly(out, now, "failing", "no usable credential", "error")
        return 0
    client = ReadOnlyClient(creds, TokenStore(a.state / "token.json"), log=log)
    try:
        result = run(client, out, now)
    except Transient as e:
        log(f"transient: {e.reason}; the next run reads again")
        set_status(out, now, "failing", e.reason, "transient")
        return 0
    except StillWaiting as e:            # paged when the token was asked for; every 2 minutes would be noise
        log(f"waiting for the owner: {e}")
        set_status(out, now, "approval", "approval", "approval")
        return 0
    except NeedsApproval as e:
        prev = set_status(out, now, "approval", "approval", "approval", approval_paged=e.created)
        if e.created and prev.get("state") == "approval" and prev.get("approval_paged") == e.created:
            log(f"still needs the owner: {e}; already paged for this token")
            return 0
        log(f"needs the owner: {e}. Open the Webull app: Menu > Messages > OpenAPI Notifications")
        return EXIT_APPROVAL
    except WebullError as e:
        log(f"error: {e}")
        set_status(out, now, "failing", f"HTTP {e.status}{f' {e.code}' if e.code else ''}", "error")
        return 0
    except Exception as e:  # noqa: BLE001 - a bug or a changed answer: paged once by state, not every 2 minutes
        log(f"bug: {type(e).__name__}")              # the class only: its text may hold what Webull answered
        _status_quietly(out, now, "failing", type(e).__name__, "bug")
        return 0
    set_status(out, now, "ok", unknown_status=int(result.get("unknown_status") or 0))
    return 0


def _status_quietly(out: Path, now: dt.datetime, state: str, reason: str, kind: str) -> None:
    try:
        set_status(out, now, state, reason, kind)
    except OSError as e:                              # a full disk: the job still ends 0, and the watch sees no read
        log(f"could not write status.json ({type(e).__name__})")


if __name__ == "__main__":
    sys.exit(main())
