"""The options live document: the open option positions of the paper account kept for manual option trades.

    python -m wt.options.live             read the account, build, validate, sign and send
    python -m wt.options.live --dry-run   read, build and validate only (writes var/options-live/outbox)
    python -m wt.options.live --verify    send, then read /api/health back

Read only, and paper only. The account is a second Alpaca PAPER account, named by the key pair APCA_OPTIONS_KEY_ID
and APCA_OPTIONS_SECRET_KEY. The owner places option trades in it by hand; strategy B's account, its virtual ledger
and its mandate check never see them. `OptionsAccount` can only GET, from the paper host named by a constant:
nothing in this module can place, change or cancel an order.

What leaves the host: one row per open option contract (the OCC symbol, the quantity, the broker's average price,
mark, market value and unrealised result), the market clock, and open interest by contract for the desk's names
(public market data, read with the same key pair). No account number, no balances, no buying power, no stock
positions, no orders.

Without the key pair the job does nothing and exits 0, so its unit can be installed before the account exists.
When the account cannot be read nothing is sent: an empty list would say "nothing is held", which is not known.
The desk greys the last document as it ages instead.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import requests

from wt.core.config import ROOT, STATE_DIR, load_yaml
from wt.ops import publish, safeio

SCHEMA_ID = "stocksdelta/options-live"
SCHEMA_VERSION = 1
SCHEMA_PATH = ROOT / "dashboard" / "src" / "lib" / "options-live.schema.json"
OUT = STATE_DIR / "options-live"
JOB = "options-live"

KEY_ID_VAR = "APCA_OPTIONS_KEY_ID"
SECRET_VAR = "APCA_OPTIONS_SECRET_KEY"
# The paper host, as a constant: a live key is refused here, and no setting can point this module anywhere else.
PAPER_HOST = "https://paper-api.alpaca.markets"
DATA_HOST = "https://data.alpaca.markets"          # market data: the stocks' last closes, to centre the strikes

# Open interest: the exchange reports it once a day, so it is read a few times a day and kept between runs.
OI_REFRESH_H = 6.0
OI_KEEP_H = 72.0                  # an older reading is dropped rather than shown as current
OI_DAYS = 35                      # expiries out to five weeks: the desk's same-day and swing trades
OI_STRIKE_BAND = 0.08             # strikes within 8% of the last close
OI_ROWS = 200                     # per name, the contracts with the most open interest
OI_PAGES = 4
OI_NAMES = 60
SYMBOL = re.compile(r"[A-Z][A-Z0-9.]{0,9}")

# A standard contract: root, yymmdd, C or P, strike in thousandths. An adjusted contract has a digit in its root
# and a deliverable that is not 100 shares, so the desk's arithmetic would be wrong for it: it is left out.
OCC = re.compile(r"[A-Z]{1,6}\d{6}[CP]\d{8}")
MAX_POSITIONS = 100
MAX_QTY = 9999
GET_TIMEOUT_S = (5.0, 10.0)        # connect, read: two reads of three tries each stay far inside the deadline
ISO_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})")
GET_TRIES = 3
PUBLISH_BUDGET_S = 150.0          # under the job's 4-minute deadline (wt.ops.schedule)
SEND_TRIES = 5


class BrokerFault(Exception):
    """The account could not be read. `code` is fixed text ("keys-rejected", "http-503"), never the response."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class OptionsAccount:
    """The paper account, read only: GET requests to the paper host and nothing else."""

    def __init__(self, key_id: str, secret: str, session: requests.Session | None = None) -> None:
        self._s = session or requests.Session()
        self._headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}

    def _get(self, path: str, params: dict[str, str] | None = None, host: str = PAPER_HOST) -> Any:
        last = "network"
        for i in range(GET_TRIES):
            try:
                # No redirects: a 30x would carry the key headers to whatever host it named.
                r = self._s.get(host + path, params=params, headers=self._headers, timeout=GET_TIMEOUT_S,
                                allow_redirects=False)
            except requests.RequestException as e:
                last = "network-" + e.__class__.__name__
            else:
                if r.status_code in (401, 403):
                    raise BrokerFault("keys-rejected")
                if r.status_code == 200:
                    try:
                        return r.json()
                    except ValueError:
                        raise BrokerFault("not-json") from None
                last = f"http-{r.status_code}"
                if r.status_code != 429 and r.status_code < 500:
                    raise BrokerFault(last)
            if i < GET_TRIES - 1:
                time.sleep(2 ** i)
        raise BrokerFault(last)

    def positions(self) -> list[Any]:
        got = self._get("/v2/positions")
        if not isinstance(got, list):
            raise BrokerFault("positions-not-a-list")
        return got

    def clock(self) -> dict[str, Any]:
        got = self._get("/v2/clock")
        if not isinstance(got, dict):
            raise BrokerFault("clock-not-an-object")
        return got

    def closes(self, symbols: list[str]) -> dict[str, float]:
        """Each stock's last daily close, for the names that have one."""
        got = self._get("/v2/stocks/snapshots", {"symbols": ",".join(symbols), "feed": "iex"}, DATA_HOST)
        out: dict[str, float] = {}
        for sym, snap in (got.items() if isinstance(got, dict) else ()):
            bars = [snap.get(k) for k in ("dailyBar", "prevDailyBar")] if isinstance(snap, dict) else []
            close = next((c for b in bars if isinstance(b, dict) and (c := _num(b.get("c"))) is not None and c > 0), None)
            if close is not None:
                out[str(sym)] = close
        return out

    def contracts(self, symbol: str, lo: float, hi: float, first: dt.date, last: dt.date) -> list[Any]:
        """The listed option contracts of one stock inside a strike band and a date range, a few pages at most."""
        params = {"underlying_symbols": symbol, "status": "active", "limit": "10000",
                  "strike_price_gte": f"{lo:.2f}", "strike_price_lte": f"{hi:.2f}",
                  "expiration_date_gte": first.isoformat(), "expiration_date_lte": last.isoformat()}
        out: list[Any] = []
        for _ in range(OI_PAGES):
            got = self._get("/v2/options/contracts", params)
            if not isinstance(got, dict) or not isinstance(got.get("option_contracts"), list):
                raise BrokerFault("contracts-not-a-list")
            out += got["option_contracts"]
            token = got.get("next_page_token")
            if not isinstance(token, str) or not token:
                break
            params = {**params, "page_token": token}
        return out


def _num(v: Any) -> float | None:
    """The broker sends numbers as decimal strings. None for anything that is not a finite number."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def position_rows(raw: list[Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """The broker's positions as the document's rows, and what was left out, as counted codes.

    Only standard option contracts are sent. A stock position (after an exercise or an assignment), an adjusted
    contract and a row that cannot be read are each counted, never sent."""
    rows: list[dict[str, Any]] = []
    left_out: Counter[str] = Counter()
    for p in raw:
        if not isinstance(p, dict):
            left_out["unreadable"] += 1
            continue
        if p.get("asset_class") != "us_option":
            left_out["not-an-option"] += 1
            continue
        symbol = p.get("symbol")
        qty = _num(p.get("qty"))
        if not isinstance(symbol, str) or not OCC.fullmatch(symbol):
            left_out["not-standard"] += 1
            continue
        if qty is None or qty != int(qty) or qty == 0 or abs(qty) > MAX_QTY:
            left_out["unreadable"] += 1
            continue
        q = int(qty)
        if p.get("side") == "short" and q > 0:
            q = -q
        row: dict[str, Any] = {"contract": symbol, "qty": q}
        for key, source, signed in (("avg_price", "avg_entry_price", False), ("price", "current_price", False),
                                    ("market_value", "market_value", True), ("unrealized_pl", "unrealized_pl", True)):
            v = _num(p.get(source))
            if v is not None and (signed or v >= 0):
                row[key] = round(v, 4)
        rows.append(row)
    rows.sort(key=lambda r: str(r["contract"]))
    if len(rows) > MAX_POSITIONS:
        left_out["over-the-limit"] += len(rows) - MAX_POSITIONS
        rows = rows[:MAX_POSITIONS]
    return rows, [f"{code}:{n}" for code, n in sorted(left_out.items())]


def oi_rows(raw: list[Any]) -> tuple[list[dict[str, Any]], str | None]:
    """One stock's contracts as open-interest rows, the largest first and at most OI_ROWS of them, with the date
    the exchange's figures are for. Only standard contracts that carry a figure."""
    rows: list[dict[str, Any]] = []
    dates: Counter[str] = Counter()
    for c in raw:
        if not isinstance(c, dict) or str(c.get("size")) != "100" or not OCC.fullmatch(str(c.get("symbol"))):
            continue
        oi, strike, expiry = _num(c.get("open_interest")), _num(c.get("strike_price")), c.get("expiration_date")
        if oi is None or oi < 0 or oi != int(oi) or strike is None or strike <= 0 or c.get("type") not in ("call", "put"):
            continue
        if not isinstance(expiry, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiry):
            continue
        rows.append({"expiry": expiry, "strike": strike, "kind": c["type"], "oi": int(oi)})
        if isinstance(d := c.get("open_interest_date"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            dates[d] += 1
    rows.sort(key=lambda r: (-int(r["oi"]), str(r["expiry"]), float(r["strike"]), str(r["kind"])))
    return rows[:OI_ROWS], (max(dates) if dates else None)


def desk_names() -> list[str]:
    """The desk's names from config/options_desk.yaml: well-formed symbols, no repeats."""
    names = load_yaml("options_desk.yaml").get("names") or []
    return list(dict.fromkeys(n for n in names if isinstance(n, str) and SYMBOL.fullmatch(n)))[:OI_NAMES]


def read_open_interest(account: OptionsAccount, names: list[str], today: dt.date) -> list[dict[str, Any]]:
    """Open interest for each name that has a last close and at least one contract with a figure."""
    closes = account.closes(names)
    out: list[dict[str, Any]] = []
    for name in names:
        close = closes.get(name)
        if close is None:
            continue
        raw = account.contracts(name, close * (1 - OI_STRIKE_BAND), close * (1 + OI_STRIKE_BAND), today,
                                today + dt.timedelta(days=OI_DAYS))
        rows, as_of = oi_rows(raw)
        if rows:
            out.append({"symbol": name, "as_of": as_of, "rows": rows})
    return out


def open_interest(account: OptionsAccount, now: dt.datetime, cache: Path) -> tuple[list[dict[str, Any]] | None, list[str]]:
    """(open interest, problems). Read again when the kept reading is older than OI_REFRESH_H; a failed read keeps
    the last one for up to OI_KEEP_H and says so. It never stops the positions from going out."""
    kept: dict[str, Any] = {}
    try:
        kept = json.loads(cache.read_text())
    except (OSError, ValueError):
        pass
    age_h = float("inf")
    try:
        age_h = (now - dt.datetime.fromisoformat(str(kept.get("read")))).total_seconds() / 3600
    except (TypeError, ValueError):
        kept = {}
    have = kept.get("open_interest") if isinstance(kept.get("open_interest"), list) and 0 <= age_h <= OI_KEEP_H else None
    if have is not None and age_h < OI_REFRESH_H:
        return have, []
    try:
        fresh = read_open_interest(account, desk_names(), now.astimezone(dt.UTC).date())
    except BrokerFault as e:
        return have, [f"open-interest-unavailable:{e.code}"[:200]]
    except Exception as e:  # noqa: BLE001 — open interest is an extra: no fault in it may stop the positions
        return have, [f"open-interest-failed:{e.__class__.__name__}"[:200]]
    try:
        safeio.atomic_write(cache, json.dumps({"read": now.isoformat(), "open_interest": fresh}), cache.parent)
    except OSError:
        pass
    return fresh, []


def market(clock: dict[str, Any] | None) -> dict[str, Any] | None:
    """The market clock as the broker gives it, or None when it could not be read."""
    if clock is None:
        return None

    def when(v: Any) -> str | None:
        return v if isinstance(v, str) and len(v) <= 40 and ISO_TIME.fullmatch(v) else None
    is_open = clock.get("is_open")
    return {"is_open": is_open if isinstance(is_open, bool) else None,
            "next_open": when(clock.get("next_open")), "next_close": when(clock.get("next_close"))}


def build(raw: list[Any], clock: dict[str, Any] | None, run_id: str, now: dt.datetime,
          problems: list[str] | None = None, oi: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    rows, left_out = position_rows(raw)
    return {"schema": SCHEMA_ID, "schema_version": SCHEMA_VERSION, "run_id": run_id,
            "as_of": now.isoformat(timespec="seconds"), "paper": True, "market": market(clock),
            "positions": rows, "open_interest": oi, "problems": [*(problems or []), *left_out][:24]}


def validate(doc: dict[str, Any], schema_path: Path = SCHEMA_PATH) -> list[str]:
    """The site's own contract, read from the checkout: what fails here would be refused there."""
    import jsonschema
    v = jsonschema.Draft7Validator(json.loads(schema_path.read_text()))
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.validator}" for e in v.iter_errors(doc)][:20]


def verify_stored(doc: dict[str, Any], url: str, bypass: str | None) -> tuple[bool, str]:
    """/api/health reports the stored document's run under `editions.options_live`."""
    h, why = publish.read_health(url, bypass)
    if h is None:
        return False, why
    editions = h.get("editions")
    mine = editions.get("options_live") if isinstance(editions, dict) else None
    got = mine.get("run_id") if isinstance(mine, dict) else None
    return got == doc["run_id"], f"health serves options-live run {got}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.options.live")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args(argv)
    from wt.ops.locks import job_lock
    with job_lock("publish-options-live") as got:        # no wait: the next run is minutes away
        if not got:
            print("another options-live publish is still running; not starting a second one")
            return 0
        return _publish(a)


def _failed(detail: str, now: dt.datetime) -> int:
    """One failed run is noise (the next is minutes away); the second in a row fails the job, which alerts."""
    st = publish.record_outcome(False, detail, now, OUT / "publish_state.json")
    return 0 if st["consecutive_failures"] < publish.ALERT_AFTER_FAILURES else 1


def _publish(a: argparse.Namespace, account: OptionsAccount | None = None) -> int:
    now = dt.datetime.now(dt.UTC).replace(microsecond=0)
    deadline = time.monotonic() + PUBLISH_BUDGET_S
    key_id, secret = os.environ.get(KEY_ID_VAR, "").strip(), os.environ.get(SECRET_VAR, "").strip()
    if account is None:
        if not key_id or not secret:
            print(f"{KEY_ID_VAR} / {SECRET_VAR} not set: the options paper account is not configured, nothing to do")
            return 0
        account = OptionsAccount(key_id, secret)
    try:
        raw = account.positions()
    except BrokerFault as e:
        print(f"the options paper account could not be read ({e.code}): not sending", file=sys.stderr)
        return _failed(f"broker {e.code}", now)
    problems: list[str] = []
    clock: dict[str, Any] | None = None
    try:
        clock = account.clock()
    except BrokerFault as e:
        problems.append(f"clock-unavailable:{e.code}"[:200])
    oi, oi_problems = open_interest(account, now, OUT / "open_interest.json")
    problems += oi_problems
    run_id = now.strftime("%Y%m%dT%H%M%SZ") + "-" + hashlib.sha1(os.urandom(8)).hexdigest()[:6]
    doc = build(raw, clock, run_id, now, problems, oi)
    if bad := validate(doc):
        print("options live document failed schema validation:\n  " + "\n  ".join(bad), file=sys.stderr)
        return 2
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    (OUT / "outbox").mkdir(parents=True, exist_ok=True)
    safeio.atomic_write(OUT / "outbox" / "document.json", body.decode(), OUT)
    # A count is all the log says about the account.
    print(f"options live {run_id}: {len(doc['positions'])} option positions, open interest for {len(oi or [])} names, "
          f"{len(body)} bytes")
    if a.dry_run:
        return 0
    url, ingest_secret = os.environ.get("DASHBOARD_INGEST_URL"), os.environ.get("DASHBOARD_INGEST_SECRET")
    if (why := publish.shadow_key_problem()) is not None:
        print(why, file=sys.stderr)
        return 2
    if not url or not ingest_secret:
        print("DASHBOARD_INGEST_URL / DASHBOARD_INGEST_SECRET not set: not sending")
        return 0
    bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    ok, detail = publish.send(body, url, ingest_secret, bypass, tries=SEND_TRIES, deadline=deadline)
    if not ok:
        print(f"sent: False ({publish.error_code(detail)})")
        return _failed(detail, now)
    publish.record_outcome(True, detail, now, OUT / "publish_state.json")
    print(f"sent: True ({detail})")
    if a.verify:
        good, why = verify_stored(doc, url, bypass)
        print(f"verify: {'ok' if good else 'FAILED'}: {why}")
        return 0 if good else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
