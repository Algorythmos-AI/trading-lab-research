"""The pipeline check: radar, the options edition and its focus names, verified against the market's own data.

    python -m wt.options.pipeline_check pre-open      (job pipeline-check, 08:55 New York: after the focus refresh,
    python -m wt.options.pipeline_check after-close    before the clone arms; and 18:30, after the evening edition)

The radar and the options edition are built in the cloud from IBKR; the options clone trades from them. Nothing
checked their claims. This reads both back from the site (signed GET /api/editions/<kind>), recomputes what they
claim from the consolidated tape (closes, the day, week and month levels, the moving averages) and the broker's
option listings (the expiries the clone may trade), and writes one report per run to var/pipeline-check/. A failed
check pages the owner once a day per run with counts per check family only (ntfy is a public topic: no symbol, price
or level is ever in the page; the report has the detail). Market data that cannot be fetched is itself a failed
check (`data.reachable`): the editions are then unverified, which is when the owner most needs to know. A failed
check exits 0; only a crash of the job itself exits non-zero (the job runner then pings healthchecks' /fail). It
reads only; it never changes an edition or trades.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, NamedTuple
from zoneinfo import ZoneInfo

import requests

from wt.core.config import STATE_DIR
from wt.ops import publish
from wt.options import levels as lv
from wt.options import session
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


# Every check's family: its id without a symbol. The page names only these (alert_text); a test keeps every id the
# module can emit inside one of them.
FAMILIES = ("data.reachable", "data.snapshot",
            "options.present", "options.session", "options.built_from", "options.tape", "options.close",
            "options.levels", "options.listing",
            "focus.present", "focus.premarket", "focus.tradeable", "focus.earnings",
            "radar.present", "radar.date", "radar.fresh", "radar.close", "radar.premarket")
SLOTS = ("pre-open", "after-close")


def family(check_id: str) -> str:
    """A check id's family (`options.close.SPY` -> `options.close`); `other` for an id outside FAMILIES."""
    fam = ".".join(check_id.split(".")[:2])
    return fam if fam in FAMILIES else "other"


def alert_text(slot: str, session_date: str, checks: Sequence[Check]) -> tuple[str, str]:
    """The ntfy title and message for a run's failed checks. ntfy.sh is a public topic whose name is the only secret,
    so the text is built only from fixed words, the slot, the session date and counts per family: never a check's
    id (ids carry symbols), its detail (prices, levels, error text) or anything read from an edition."""
    fails = [c for c in checks if not c.ok and c.severity == "fail"]
    counts = Counter(family(c.id) for c in fails)
    order = {f: i for i, f in enumerate((*FAMILIES, "other"))}
    slot_s = slot if slot in SLOTS else "unknown slot"
    date_s = session_date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", session_date) else "unknown date"
    parts = [f"{fam}: {n} failed" for fam, n in sorted(counts.items(), key=lambda kv: order[kv[0]])]
    title = f"Pipeline check {slot_s}: {len(fails)} failed"
    message = f"Session {date_s}, {slot_s}. {'; '.join(parts) or 'nothing failed'}. The run's report has the detail."
    return title, message


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


TOP_UP = ("SPY", "QQQ")   # config/options_clone.yaml names.top_up (DEC-0032)
MIN_NAMES = 2             # names.min_names: the clone's top-up target. Shared with the clone; not this check's bar
# focus.tradeable's own bar: how many focus names need a contract the clone may trade. One is a legitimate night (the
# clone tops up with SPY and QQQ to MIN_NAMES, DEC-0032); none still warns. Separate from MIN_NAMES on purpose.
FOCUS_TRADEABLE_MIN = 1
MAX_NAMES = 6             # names.max_names
EXPIRY = "nearest"        # names.expiry (DEC-0034): `same_day`, or `nearest` within WITHIN_DAYS calendar days
WITHIN_DAYS = 7           # names.nearest_within_days


def tradeable(sym: str, target: str, expiries: Mapping[str, Sequence[str]], policy: str = EXPIRY) -> bool:
    """Whether `sym` has an expiry the clone may trade on `target`: that day's, or under `nearest` any listed one
    (`expiries` holds only those up to WITHIN_DAYS ahead)."""
    listed = expiries.get(sym, ())
    return target in listed if policy == "same_day" else any(str(e) >= target for e in listed)


def eligible(options: Mapping[str, Any] | None, target: str, expiries: Mapping[str, Sequence[str]],
             max_names: int = MAX_NAMES, policy: str = EXPIRY) -> set[str]:
    """The names the clone can trade on `target`, chosen as its runner chooses them: `wt.options.session.names` (the
    focus names by rank, upper-cased, de-duplicated, capped at `max_names`, or the fallback without a focus for that
    session), kept when it has an expiry the policy allows (DEC-0034), then topped up in order from SPY and QQQ to
    two (DEC-0032).
    Only a difference on one of these fails; elsewhere it warns."""
    focus = (options or {}).get("focus") if options else None
    wanted, _ = session.names(focus, (options or {}).get("session"), target, list(TOP_UP), max_names)
    out = [s for s in wanted if tradeable(s, target, expiries, policy)]
    for sym in TOP_UP:
        if len(out) >= MIN_NAMES:
            break
        if sym not in out and tradeable(sym, target, expiries, policy):
            out.append(sym)
    return set(out)


# The market-data sources a run reads (Alpaca): the consolidated daily bars, the broker's option listings, and the
# pre-market snapshot (pre-open only). These words are the only ones `data.reachable` puts in its detail.
BARS, LISTINGS, SNAPSHOT = "daily bars", "option listings", "pre-market prices"
NOT_HERE = ("a warning only: the pre-open refresh passes are due after this 08:55 run, and the dashboard's own "
            "watcher pages on them")


def premarket_refresh(pre: Any, target: str) -> tuple[bool, str]:
    """focus.premarket: whether the focus block's pre-open refresh is for `target`, and why.

    Always a warning, never a page, by design: the pre-market publication is moving to two passes due at 08:56 and
    09:25 New York, both after this job's 08:55 run, and a dashboard-side watcher owns alerting on them. Paging
    here would be a false alarm every morning. Any shape this check does not know (absent, not a mapping, a newer
    block without a readable `as_of`) is reported as "not checked here" and never raises."""
    if pre is None:
        return False, f"no pre-open refresh in the edition yet; not checked here ({NOT_HERE})"
    at = pre.get("as_of") if isinstance(pre, Mapping) else None
    if not isinstance(at, str) or not re.match(r"\d{4}-\d{2}-\d{2}", at):
        return False, f"pre-open refresh in a shape this check does not read; not checked here ({NOT_HERE})"
    return at[:10] == target, f"pre-open refresh as_of {at} ({NOT_HERE})"


def assess(slot: str, now: dt.datetime, radar: Mapping[str, Any] | None, options: Mapping[str, Any] | None,
           daily: Mapping[str, Sequence[Mapping[str, Any]]], expiries: Mapping[str, Sequence[str]],
           live: Mapping[str, float], earnings: Sequence[Mapping[str, Any]],
           unreachable: Sequence[str] = (), unlisted: Mapping[str, str] | None = None) -> list[Check]:
    """Every check for one run. Pure: the editions and the market data come in, the checks go out.

    `daily`: each symbol's consolidated-tape daily bars, split-adjusted, up to the last finished session.
    `expiries`: each symbol's listed expiry dates from `target` to WITHIN_DAYS later. `live`: the latest price per
    symbol (pre-open). `unreachable`: the market-data sources (BARS, LISTINGS, SNAPSHOT) that gave no usable answer.
    A source that answered and says something (an empty tape, no contract) is judged by the checks themselves; one
    that did not answer fails `data.reachable` (BARS, LISTINGS) and the checks that depend on it warn "not verified".
    `unlisted`: names whose own option listing was unusable while the others answered (symbol -> a SAFE reason).
    Each gets an `options.listing.<SYM>` warning ("not verified"), never a page; whether the clone may trade it is
    unknown, so its close and levels are judged as if it may (a mismatch on it still fails), and it does not count
    as tradeable in focus.tradeable."""
    out: list[Check] = []
    target = target_session(slot, now)
    prev = lv.prev_session(target)

    def add(cid: str, ok: bool, detail: str, sev: str = "fail") -> None:
        out.append(Check(cid, sev if not ok else "info", ok, detail))

    no_bars, no_listings = BARS in unreachable, LISTINGS in unreachable
    blind = [s for s in (BARS, LISTINGS) if s in unreachable]
    add("data.reachable", not blind, f"unreachable: {', '.join(blind)}; the editions are not verified" if blind
        else "daily bars and option listings fetched")
    if slot == "pre-open" and SNAPSHOT in unreachable:
        add("data.snapshot", False, "pre-market prices unreachable: the radar's overnight move is not checked", "warn")
    unlisted = dict(unlisted or {})
    for sym, why in sorted(unlisted.items()):
        add(f"options.listing.{sym}", False, f"not verified: this name's option listing was not usable ({why})", "warn")
    # The names the clone may trade: as listed, and as if every unlisted name had a contract (the union of both, so
    # an unknown listing never turns a mismatch on a name the clone may trade into a mere warning).
    tradeable_names = eligible(options, target, expiries)
    if unlisted:
        tradeable_names |= eligible(options, target, {**expiries, **{s: [target] for s in unlisted}})

    def sev(sym: str) -> str:
        return "fail" if sym in tradeable_names else "warn"

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
            if not isinstance(t, Mapping):
                continue
            sym = str(t.get("symbol"))
            if no_bars:
                add(f"options.tape.{sym}", False, "not verified: the daily bars were unreachable", "warn")
                continue
            bars = [b for b in daily.get(sym, []) if isinstance(b, Mapping)]
            loaded = lv.load_ibkr(daily_raw(bars))
            if loaded.problems or not loaded.bars or loaded.bars[-1].d != prev:
                ends = loaded.bars[-1].d if loaded.bars else "nowhere"
                why = ("; ".join(loaded.problems[:3]) if loaded.problems else
                       f"the tape ends {ends}, the day's bar is not published yet" if ends < prev else
                       f"the tape ends {ends}")
                add(f"options.tape.{sym}", False, f"no clean tape through {prev}: {why}", "warn")
                continue
            close = _num((t.get("last") or {}).get("close"))
            tape_close = loaded.bars[-1].c
            add(f"options.close.{sym}", close is not None and abs(close - tape_close) <= CLOSE_TOL,
                f"edition {close} vs tape {round(tape_close, 2)}", sev(sym))
            try:
                mine = {x.name: x.price for x in lv.levels_for(loaded.bars, target)["levels"]}
            except ValueError as e:
                add(f"options.levels.{sym}", False, f"levels not computable: {e}", "warn")
                continue
            theirs = {str(x.get("name")): _num(x.get("price")) for x in t.get("levels") or [] if isinstance(x, Mapping)}
            off = [f"{n} {theirs.get(n)} vs {round(mine[n], 2)}" for n in LEVEL_NAMES
                   if n in mine and (theirs.get(n) is None or abs((theirs.get(n) or 0) - mine[n]) > LEVEL_TOL)]
            add(f"options.levels.{sym}", not off, "; ".join(off) or "all levels agree", sev(sym))
        # ---- its focus names
        focus = options.get("focus")
        focus = focus if isinstance(focus, Mapping) else {}
        raw_items = focus.get("items")
        items = [i for i in (raw_items if isinstance(raw_items, list) else [])
                 if isinstance(i, Mapping) and isinstance(i.get("symbol"), str)]
        add("focus.present", bool(items), f"{len(items)} focus names")
        if slot == "pre-open":
            fresh, why = premarket_refresh(focus.get("premarket"), target)
            add("focus.premarket", fresh, why, "warn")          # a warning by design: see premarket_refresh
        can = [str(i["symbol"]) for i in items if tradeable(str(i["symbol"]), target, expiries)]
        unknown = sum(1 for i in items if str(i["symbol"]) in unlisted)
        what = f"expiring {target}" if EXPIRY == "same_day" else f"expiring within {WITHIN_DAYS} days of {target}"
        if no_listings:
            add("focus.tradeable", False, "not verified: the option listings were unreachable", "warn")
        else:
            add("focus.tradeable", len(can) >= FOCUS_TRADEABLE_MIN,
                f"{len(can)} of {len(items)} focus names have a contract {what}: {', '.join(can) or 'none'}"
                " (the clone tops up with SPY and QQQ)" + (f"; {unknown} not verified" if unknown else ""), "warn")
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
            dated = radar.get("edition_date") == target
            add("radar.date", dated, f"radar for {radar.get('edition_date')}, want {target}")
            try:
                built = dt.datetime.fromisoformat(str(radar.get("as_of")).replace("Z", "+00:00"))
                age = (now - built).total_seconds() / 3600
                add("radar.fresh", age <= RADAR_MAX_AGE_H, f"built {age:.1f} h ago")
            except ValueError:
                add("radar.fresh", False, "no readable as_of")
            for t in (radar.get("tickers") or []) if dated else []:     # yesterday's prices are not today's claims
                if not isinstance(t, Mapping):
                    continue
                sym = str(t.get("symbol"))
                if no_bars:
                    add(f"radar.close.{sym}", False, "not verified: the daily bars were unreachable", "warn")
                    continue
                bars = [b for b in daily.get(sym, []) if isinstance(b, Mapping)]
                if not bars:
                    continue
                loaded = lv.load_ibkr(daily_raw(bars))
                if not loaded.bars or loaded.bars[-1].d != prev:
                    continue
                price = _num(t.get("price"))
                add(f"radar.close.{sym}", price is not None and abs(price - loaded.bars[-1].c) <= CLOSE_TOL,
                    f"radar {price} vs tape close {round(loaded.bars[-1].c, 2)}", sev(sym))
                pm, now_px = _num(t.get("premarket_price")), live.get(sym)
                if pm is not None and now_px:
                    drift = abs(now_px - pm) / pm * 100
                    add(f"radar.premarket.{sym}", drift <= PREMARKET_DRIFT_PCT,
                        f"radar pre-market {pm} vs now {round(now_px, 2)} ({drift:.2f}%): moved since the radar", "warn")
    return out


# ---------------------------------------------------------------- the run
Get = Callable[..., Any]  # requests.get's shape (tests pass a fake)
Sleep = Callable[[float], None]
Clock = Callable[[], float]

# The run's time, bounded from these constants (the job's deadline is 10 minutes, src/wt/ops/schedule.py).
CONNECT_S, READ_S = 5.0, 20.0          # each Alpaca call's connect and read timeouts
EDITION_CALL_S = 5.0 + 15.0            # read_edition's own timeouts (shared with the clone, not changed here)
RETRY_WAIT_S = 3.0                     # one short retry per call: a blip does not page, and a dead feed costs one wait
RETRY_AFTER_MAX_S = 10.0               # a 429's Retry-After is honoured up to this
CALL_WORST_S = 2 * (CONNECT_S + READ_S) + max(RETRY_WAIT_S, RETRY_AFTER_MAX_S)   # one call and its retry
EDITIONS_WORST_S = 2 * (2 * EDITION_CALL_S + RETRY_WAIT_S)   # two kinds, each read twice
BAR_PAGES = 3                          # pages of daily bars; 30,000 bars is about 100 names
RUN_BUDGET_S = 540.0                   # no call or wait starts unless its worst case ends inside this
TAPE_TRIES, TAPE_WAIT_S = 3, 180.0     # after the close the day's daily bar can lag the check by minutes


class OutOfTime(requests.Timeout):
    """A call not started because its worst case would end past the run's budget: treated like a timeout."""


class Budget:
    """The run's wall-clock budget, from its start. `fits(s)`: whether something taking at most `s` ends inside it."""

    def __init__(self, seconds: float = RUN_BUDGET_S, clock: Clock = time.monotonic) -> None:
        self.clock, self.end = clock, clock() + seconds

    def fits(self, s: float) -> bool:
        return self.clock() + s <= self.end


def _transient(e: requests.RequestException) -> bool:
    """Worth one more try: no connection, a timeout, a connection dropped mid-body, or the server's own trouble
    (5xx, 429). A 4xx (bad keys, a bad request) or an unreadable body will not mend in seconds."""
    if isinstance(e, requests.HTTPError):
        code = e.response.status_code if e.response is not None else 0
        return code >= 500 or code == 429
    return isinstance(e, requests.ConnectionError | requests.Timeout | requests.exceptions.ChunkedEncodingError
                      | requests.exceptions.ContentDecodingError)


def _retry_wait(e: requests.RequestException) -> float:
    """RETRY_WAIT_S, or a 429's Retry-After (whole seconds) capped at RETRY_AFTER_MAX_S."""
    resp = e.response if isinstance(e, requests.HTTPError) else None
    if resp is not None and resp.status_code == 429:
        raw = str((getattr(resp, "headers", None) or {}).get("Retry-After") or "").strip()
        if raw.isdigit():
            return min(float(raw), RETRY_AFTER_MAX_S)
    return RETRY_WAIT_S


def _alpaca_get(url: str, params: dict[str, str], get: Get = requests.get, sleep: Sleep = time.sleep,
                budget: Budget | None = None) -> Any:
    """One Alpaca GET, tried at most twice: a transient failure is retried once (RETRY_WAIT_S, or a 429's capped
    Retry-After), anything else and a second failure raise. Not started at all (OutOfTime) when the call and its
    retry, at worst CALL_WORST_S, would end past the run's budget."""
    if budget is not None and not budget.fits(CALL_WORST_S):
        raise OutOfTime("the run's time budget is spent")
    h = {"APCA-API-KEY-ID": os.environ.get("APCA_API_KEY_ID", ""), "APCA-API-SECRET-KEY": os.environ.get("APCA_API_SECRET_KEY", "")}
    try:
        r = get(url, params=params, headers=h, timeout=(CONNECT_S, READ_S), allow_redirects=False)
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        if not _transient(e):
            raise
        wait = _retry_wait(e)
    sleep(wait)
    r = get(url, params=params, headers=h, timeout=(CONNECT_S, READ_S), allow_redirects=False)
    r.raise_for_status()
    return r.json()


class MarketData(NamedTuple):
    daily: dict[str, list[Any]]
    expiries: dict[str, list[str]]
    live: dict[str, float]
    unreachable: tuple[str, ...] = ()     # BARS, LISTINGS, SNAPSHOT: the sources that gave no usable answer
    unlisted: tuple[tuple[str, str], ...] = ()   # (symbol, why): one name's listing unusable, the others fine


# A source's answer that is not usable: no connection, an HTTP error, a timeout (requests.RequestException, which
# includes an unreadable JSON body), or JSON of the wrong shape.
_UNUSABLE = (requests.RequestException, AttributeError, KeyError, TypeError, ValueError)


def _why(e: BaseException) -> str:
    """A SAFE reason for the report: the error's class, and an HTTP status when there is one."""
    resp = e.response if isinstance(e, requests.HTTPError) else None
    return f"{e.__class__.__name__} {resp.status_code}" if resp is not None else e.__class__.__name__


def fetch_bars(symbols: Sequence[str], target: str, get: Get = requests.get, sleep: Sleep = time.sleep,
               budget: Budget | None = None) -> dict[str, list[Any]] | None:
    """The daily bars for `symbols` up to the session before `target`, or None when they gave no usable answer
    (after the one retry), or did not fit in BAR_PAGES pages."""
    prev = dt.date.fromisoformat(lv.prev_session(target))
    daily: dict[str, list[Any]] = {}
    params = {"symbols": ",".join(symbols), "timeframe": "1Day", "feed": "sip", "adjustment": "split", "limit": "10000",
              "start": (prev - dt.timedelta(days=420)).isoformat(), "end": f"{prev.isoformat()}T23:59:00Z"}
    try:
        for _ in range(BAR_PAGES):
            j = _alpaca_get(f"{DATA}/v2/stocks/bars", params, get, sleep, budget)
            for s, rows in (j.get("bars") or {}).items():
                daily.setdefault(s, []).extend(rows)
            if not j.get("next_page_token"):
                return daily
            params["page_token"] = j["next_page_token"]
        raise ValueError(f"more than {BAR_PAGES} pages of daily bars")
    except _UNUSABLE as e:
        print(f"market data unavailable ({BARS}): {_why(e)}", file=sys.stderr)
        return None


def fetch_listings(symbols: Sequence[str], target: str, get: Get = requests.get, sleep: Sleep = time.sleep,
                   budget: Budget | None = None) -> tuple[dict[str, list[str]] | None, dict[str, str]]:
    """Each symbol's listed expiries from `target` to WITHIN_DAYS later, and the symbols whose own listing was not
    usable (symbol -> a SAFE reason). Per symbol:
      * a usable answer: its expiries (none listed is an answer: []);
      * a non-transient error of that symbol alone (a 4xx, unreadable JSON, a contract row without a date): [] for
        it, named in the second map, and the next symbol is asked;
      * a transient failure that survives its retry (or a budget spent): the host is down. None: the listings are
        unreachable, and no further symbol is asked.
    When every symbol failed on its own, the listings are unreachable too (None)."""
    week_end = (dt.date.fromisoformat(target) + dt.timedelta(days=WITHIN_DAYS)).isoformat()
    expiries: dict[str, list[str]] = {}
    bad: dict[str, str] = {}
    for s in symbols:
        try:
            j = _alpaca_get(f"{PAPER}/v2/options/contracts", {"underlying_symbols": s, "expiration_date_gte": target,
                                                                 "expiration_date_lte": week_end, "limit": "10000"},
                            get, sleep, budget)
            expiries[s] = sorted({str(c["expiration_date"]) for c in j.get("option_contracts") or []})
        except _UNUSABLE as e:
            if isinstance(e, requests.RequestException) and _transient(e):
                print(f"market data unavailable ({LISTINGS}): {_why(e)}", file=sys.stderr)
                return None, {}
            expiries[s], bad[s] = [], _why(e)
    if symbols and len(bad) == len(symbols):
        print(f"market data unavailable ({LISTINGS}): every name failed", file=sys.stderr)
        return None, {}
    return expiries, bad


def fetch_snapshot(symbols: Sequence[str], get: Get = requests.get, sleep: Sleep = time.sleep,
                   budget: Budget | None = None) -> dict[str, float] | None:
    """The latest trade price per symbol, or None when the snapshot gave no usable answer."""
    try:
        j = _alpaca_get(f"{DATA}/v2/stocks/snapshots", {"symbols": ",".join(symbols), "feed": "iex"}, get, sleep, budget)
        live: dict[str, float] = {}
        for s, snap in j.items():
            p = _num(((snap or {}).get("latestTrade") or {}).get("p"))
            if p:
                live[s] = p
        return live
    except _UNUSABLE as e:
        print(f"market data unavailable ({SNAPSHOT}): {_why(e)}", file=sys.stderr)
        return None


def market_data(symbols: Sequence[str], target: str, slot: str, get: Get = requests.get,
                sleep: Sleep = time.sleep, budget: Budget | None = None) -> MarketData:
    """The daily bars, option listings and (pre-open) latest prices for `symbols`. A source with no usable answer
    is named in `unreachable` and left empty: nothing is judged on half an answer. One name's own listing error
    is not the source's: it is named in `unlisted` and the other names are checked as usual."""
    unreachable: list[str] = []
    daily = fetch_bars(symbols, target, get, sleep, budget)
    if daily is None:
        daily = {}
        unreachable.append(BARS)
    expiries, bad = fetch_listings(symbols, target, get, sleep, budget)
    if expiries is None:
        expiries = {}
        unreachable.append(LISTINGS)
    live: dict[str, float] = {}
    if slot == "pre-open":
        got = None if BARS in unreachable else fetch_snapshot(symbols, get, sleep, budget)   # same host as the bars
        if got is None:
            unreachable.append(SNAPSHOT)
        else:
            live = got
    return MarketData(daily, expiries, live, tuple(unreachable), tuple(sorted(bad.items())))


def last_bar_date(bars: Sequence[Mapping[str, Any]]) -> str:
    """The date of the newest daily bar, as the loader keys it, or "" without one."""
    loaded = lv.load_ibkr(daily_raw([b for b in bars if isinstance(b, Mapping)]))
    return loaded.bars[-1].d if loaded.bars else ""


def wait_for_the_days_bar(symbols: Sequence[str], target: str, md: MarketData, options: Mapping[str, Any] | None,
                          sleep: Sleep = time.sleep,
                          fetch: Callable[[Sequence[str], str], dict[str, list[Any]] | None] = fetch_bars,
                          budget: Budget | None = None) -> MarketData:
    """After the close the consolidated daily bar of the session just finished can arrive after the check starts.
    While a name the clone can trade still lacks it, fetch the bars again (only the bars) a few times before judging
    the tape; the names that never get it are reported with the date their tape ends. A round starts only when its
    wait and one call fit in the run's budget. A re-fetch with no usable answer stops the wait and marks the bars
    unreachable: the session's bar could not be verified."""
    if BARS in md.unreachable:
        return md
    prev = lv.prev_session(target)
    wanted = [s for s in eligible(options, target, md.expiries) if s in symbols] or list(symbols)
    for _ in range(TAPE_TRIES - 1):
        if all(last_bar_date(md.daily.get(s, [])) >= prev for s in wanted):
            return md
        if budget is not None and not budget.fits(TAPE_WAIT_S + CALL_WORST_S):
            return md
        sleep(TAPE_WAIT_S)
        again = fetch(symbols, target)
        if again is None:
            return md._replace(unreachable=(*md.unreachable, BARS))
        md = md._replace(daily=again)
    return md


def _read_twice(read: Callable[[str], dict[str, Any] | None], kind: str, sleep: Sleep) -> dict[str, Any] | None:
    """read_edition answers None both for no edition and for a site it could not reach. Read once more after a short
    wait, so a blip does not page as a missing edition. (read_edition is shared with the clone and stays as it is.)"""
    got = read(kind)
    if got is None:
        sleep(RETRY_WAIT_S)
        got = read(kind)
    return got


def run(slot: str, now: dt.datetime | None = None, *, get: Get = requests.get, sleep: Sleep = time.sleep,
        read: Callable[[str], dict[str, Any] | None] = read_edition, alerts: Any = None, out: Path | None = None,
        earnings_path: Path | None = None, clock: Clock = time.monotonic) -> int:
    """One run. Returns 0 whether or not a check failed: a failed check pages through ntfy, and the report says
    which. An exception of the job itself is deliberately not caught: the process exits non-zero and the job runner
    pings healthchecks' /fail and alerts "pipeline-check failed" (docs/runbooks/dead-man-switches.md)."""
    import csv
    from wt.core.config import CONFIG_DIR
    from wt.ops.alerts import Alerts
    budget = Budget(RUN_BUDGET_S, clock)
    now = now or dt.datetime.now(dt.UTC)
    target = target_session(slot, now)
    radar, options = _read_twice(read, "radar", sleep), _read_twice(read, "options", sleep)
    symbols = sorted({str(t.get("symbol")) for t in ((options or {}).get("tickers") or []) if isinstance(t, Mapping)}
                     | {str(t.get("symbol")) for t in ((radar or {}).get("tickers") or []) if isinstance(t, Mapping)}
                     | {"SPY", "QQQ"})

    def bars(syms: Sequence[str], tgt: str) -> dict[str, list[Any]] | None:
        return fetch_bars(syms, tgt, get, sleep, budget)
    md = market_data(symbols, target, slot, get, sleep, budget)
    if slot == "after-close":
        md = wait_for_the_days_bar(symbols, target, md, options, sleep, bars, budget)
    with open(earnings_path or CONFIG_DIR / "events" / "earnings.csv") as fh:
        earnings = list(csv.DictReader(line for line in fh if not line.startswith("#")))
    checks = assess(slot, now, radar, options, md.daily, md.expiries, md.live, earnings, md.unreachable,
                    dict(md.unlisted))
    fails = [c for c in checks if not c.ok and c.severity == "fail"]
    warns = [c for c in checks if not c.ok and c.severity == "warn"]
    report = {"slot": slot, "session": target, "checked_at": now.isoformat(), "fails": len(fails), "warns": len(warns),
              "unreachable": list(md.unreachable), "unlisted": dict(md.unlisted), "checks": [asdict(c) for c in checks]}
    dest = out or OUT
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{target}-{slot}.json").write_text(json.dumps(report, indent=1))
    for c in checks:
        if not c.ok:
            print(f"{c.severity.upper()} {c.id}: {c.detail}")
    print(f"pipeline check {slot} for {target}: {len(checks)} checks, {len(fails)} failed, {len(warns)} warnings")
    if fails:
        title, message = alert_text(slot, target, checks)
        (alerts if alerts is not None else Alerts()).once_per_day(f"pipeline-check:{slot}", title, message, 4)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slot", choices=("pre-open", "after-close"), nargs="?")
    a = ap.parse_args(argv)
    slot = a.slot or ("pre-open" if dt.datetime.now(NEW_YORK).hour < 12 else "after-close")
    return run(slot)


if __name__ == "__main__":
    raise SystemExit(main())
