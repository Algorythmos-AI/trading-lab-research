"""The input bundles of the Options desk's two-stage selection (DEC-0046), and the fetchers that save them.

    python -m wt.options.select_fetch stage1 --session <D> [--root <dir>] [--beside]
    python -m wt.options.select_fetch stage2 --pass A|B --stage1 <stage 1 output> [--root <dir>] [--beside]

Scoring never fetches: `wt.options.select` and `wt.options.select_stage2` read only a saved bundle, so a replay reads
the answers the night saw ("late and corrected prints can change a bar after the fact"). This module is the only part
of the selection that calls Alpaca. It runs nothing on a schedule: no job, timer or unit starts it (the owner
installs those later).

Every request goes through `AlpacaREST.get_response`, so the run-time feed guard (`wt.data.feeds.require_feed`) sees
it before it is sent; every market-data request names `feed=sip` (news and corporate actions take no feed). Every
answer is paged to its end (`next_page_token`). A 429 is honoured by waiting its `Retry-After` and asking again,
counted as a request, while the request budget and the time budget allow; a 429 without a readable `Retry-After`, or
one whose wait would pass the time budget, cuts the fetch short. A 401, a 403 or any other failure stops the fetch.
A failed, partial or cut-short fetch writes no bundle and exits with its code below.

Bundles are written under a git-ignored folder, `var/select/<session>/`, where `<session>` is the session being
selected for (Stage 1's next session, the session Stage 2 confirms): `stage1-bundle.json`, `stage2-A-bundle.json`,
`stage2-B-bundle.json`. A bundle is written atomically (a temporary file in the same folder, then a hard link) and
never over an existing one: a second run for the same pass is refused unless `--beside` is given, which writes
`<name>.2.json` (then `.3`, ...) beside it. A Stage 1 fetch is refused once a Stage 2 bundle exists for the session
("Stage 1 refuses to re-run for a session that already has a confirmation").

The Stage 1 bundle is the shape `wt.options.select.check_bundle` documents (split-adjusted SIP daily bars of the 260
sessions ending at D, and the two event files' rows). The Stage 2 bundle is the shape
`wt.options.select_stage2.check_bundle` documents. What it holds per name, and from which request:

| Part | Request | Feed | Window |
|---|---|---|---|
| `daily_raw` | `/v2/stocks/bars` 1Day, `adjustment=raw` | sip | the 5 sessions ending at the session before the confirmed one |
| `minute` | `/v2/stocks/bars` 1Min, `adjustment=raw` | sip | T - 15 min to T |
| `premarket[day]` | `/v2/stocks/bars` 5Min, `adjustment=split` | sip | 04:00 to T's time of day, the session and each of the 20 sessions before it (one request per day) |
| `snapshot` | `/v2/stocks/snapshots` | sip | latest quote, latest trade, previous daily bar, as given |
| `corporate_actions` | `/v1/corporate-actions` | none taken | actions dated on the session |
| `news_count` | `/v1beta1/news`, `include_content=false` | none taken | items from the last close to T: counted per name, every other field dropped in the fetcher |

and for the pass: `T`, `fetched_at`, the Stage 1 block's two hashes, every request with its feed, status, pages and
`X-RateLimit-Limit` (`plan_check` keeps the smallest, as read), the entitlement probe's result (`unknown`: the probe
is not built yet), the halt state (empty: no stream source is supplied, so every name's halt is unknown) and the
event files' rows. No headline, summary, author or link of any news item is stored or logged.

Calls per pass, each answer on one page: Stage 1, 1 (twelve names' 260 daily bars fit one 10,000-bar page). Stage 2,
26 plus one per further page of news: daily 1, minute 1, pre-market 21, snapshots 1, corporate actions 1, news 1 or
more. The budgets below are not numbers DEC-0046 gives (see the pull request's report).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from wt.data.feeds import FeedNotNamed
from wt.options import levels as lv
from wt.options import select as sel
from wt.options import select_stage2 as s2
from wt.risk import events as ev

DATA = "https://data.alpaca.markets"
FEED = "sip"
VAR_SELECT = s2.ROOT / "var" / "select"
EVENTS = s2.ROOT / "config" / "events"
DESK = s2.ROOT / "config" / "options_desk.yaml"
STAGE1_FILE = "stage1-bundle.json"

# Operational limits of the fetchers. DEC-0046 names "the request budget" without a number and gives no time budget
# for Stage 1; these are the fetchers' own, not selection rules. Stage 2's time budget is the record's: the fetch
# must end by the pass's publish-by time (08:56 for Pass A, 09:25 for Pass B).
STAGE1_REQUEST_BUDGET = 20
STAGE1_TIME_BUDGET_S = 540           # as the pipeline check's own budget (wt.options.pipeline_check)
STAGE2_REQUEST_BUDGET = 100
REQUEST_TIMEOUT_S = 60.0             # AlpacaREST's own per-request timeout
DAILY_RAW_SESSIONS = 5               # G1 needs only the session before; the four before it show a gap in the bars
MINUTE_WINDOW_S = 900                # the record's 15 minutes before T ("possibly halted"); G2's 120 s lies inside

# Exit codes of `main`.
EXIT_OK = 0             # the bundle is written
EXIT_FETCH = 1          # a request failed (transport, an unexpected status, an answer not in Alpaca's shape)
EXIT_AUTH = 2           # 401: the key pair was refused (revoked, or a paper-account reset)
EXIT_FORBIDDEN = 3      # 403: the data is not in the plan (SIP refused: the subscription lapsed)
EXIT_CUT_SHORT = 4      # the request budget, the time budget, or a rate-limit answer cut the fetch short
EXIT_EXISTS = 5         # a bundle for this pass already exists and --beside was not given
EXIT_TOO_EARLY = 6      # before T + 60 s (Stage 2), or before the session's close is final (Stage 1)
EXIT_INPUT = 7          # an input cannot be read: the Stage 1 output, the parameters, the event files, the keys,
                        # or the session lies outside the calendar
EXIT_WRITE = 8          # the bundle cannot be written
EXIT_USAGE = 9          # the command line is not one this command takes
EXIT_FEED = 10          # the feed guard refused a request (a defect: nothing was sent)
EXIT_CONFIRMED = 11     # Stage 1 for a session that already has a Stage 2 bundle


class FetchError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class Response(Protocol):
    status_code: int
    headers: Mapping[str, str]

    def json(self) -> Any: ...


class Client(Protocol):
    def get_response(self, url: str, params: dict[str, Any] | None = None, timeout: float = 60) -> Any: ...


def retry_after(headers: Mapping[str, str]) -> float | None:
    """`Retry-After` as seconds, when it is a plain number of seconds; None otherwise (an HTTP date is not read)."""
    v = headers.get("Retry-After")
    if v is None:
        return None
    try:
        x = float(v.strip())
    except ValueError:
        return None
    return x if 0 <= x < 86_400 else None


def rate_limit(headers: Mapping[str, str]) -> int | None:
    v = headers.get("X-RateLimit-Limit")
    try:
        return int(v.strip()) if v is not None else None
    except ValueError:
        return None


class Fetcher:
    """Pages, counts and times every request of one fetch."""

    def __init__(self, client: Client, *, max_requests: int, deadline: dt.datetime,
                 clock: Callable[[], dt.datetime], sleep: Callable[[float], None]) -> None:
        self.client, self.max, self.deadline, self.clock, self.sleep = client, max_requests, deadline, clock, sleep
        self.count = 0
        self.requests: list[dict[str, Any]] = []

    def _one(self, url: str, params: dict[str, Any]) -> tuple[Any, int | None]:
        while True:
            left = (self.deadline - self.clock()).total_seconds()
            if left <= 0:
                raise FetchError(EXIT_CUT_SHORT, "the time budget ran out")
            if self.count >= self.max:
                raise FetchError(EXIT_CUT_SHORT, f"the request budget ({self.max}) ran out")
            self.count += 1
            try:
                r = self.client.get_response(url, params, timeout=min(REQUEST_TIMEOUT_S, left))
            except FeedNotNamed as e:
                raise FetchError(EXIT_FEED, f"the feed guard refused a request: {e}") from None
            except Exception as e:                       # the transport (requests' errors), never its text
                raise FetchError(EXIT_FETCH, f"a request failed ({type(e).__name__})") from None
            headers = r.headers if isinstance(getattr(r, "headers", None), Mapping) else {}
            status = getattr(r, "status_code", None)
            if status == 429:
                wait = retry_after(headers)
                if wait is None:
                    raise FetchError(EXIT_CUT_SHORT, "a rate-limit answer (429) without a readable Retry-After")
                if (self.deadline - self.clock()).total_seconds() <= wait:
                    raise FetchError(EXIT_CUT_SHORT, "a rate-limit answer (429) asks to wait past the time budget")
                self.sleep(wait)
                continue
            if status == 401:
                raise FetchError(EXIT_AUTH, "401: the key pair was refused")
            if status == 403:
                raise FetchError(EXIT_FORBIDDEN, "403: the data is not in the plan (SIP refused)")
            if status != 200:
                raise FetchError(EXIT_FETCH, f"an answer with status {status}")
            try:
                body = r.json()
            except ValueError:
                raise FetchError(EXIT_FETCH, "an answer that is not JSON") from None
            return body, rate_limit(headers)

    def paged(self, what: str, day: str | None, path: str, params: dict[str, Any]) -> list[Mapping[str, Any]]:
        """Every page of one request, to its end."""
        pages: list[Mapping[str, Any]] = []
        limits: list[int] = []
        token: str | None = None
        while True:
            q = dict(params)
            if token is not None:
                q["page_token"] = token
            body, limit = self._one(DATA + path, q)
            if not isinstance(body, Mapping):
                raise FetchError(EXIT_FETCH, f"an answer to {path} that is not an object")
            pages.append(body)
            if limit is not None:
                limits.append(limit)
            nxt = body.get("next_page_token")
            if nxt is None or nxt == "":
                break
            if not isinstance(nxt, str) or nxt == token:
                raise FetchError(EXIT_FETCH, f"an answer to {path} with an unreadable page token")
            token = nxt
        self.requests.append({"what": what, "session": day, "path": path, "feed": params.get("feed"),
                              "status": 200, "pages": len(pages),
                              "x_ratelimit_limit": min(limits) if limits else None})
        return pages


# ---------------------------------------------------------------- answers

def _bars_of(pages: Sequence[Mapping[str, Any]], names: Sequence[str]) -> dict[str, list[Any]]:
    out: dict[str, list[Any]] = {n: [] for n in names}
    for body in pages:
        bars = body.get("bars")
        if bars is None:
            continue
        if not isinstance(bars, Mapping):
            raise FetchError(EXIT_FETCH, "a bars answer whose bars are not keyed by symbol")
        for sym, rows in bars.items():
            if sym not in out:
                continue
            if not isinstance(rows, list):
                raise FetchError(EXIT_FETCH, "a bars answer whose bars are not a list")
            out[sym].extend(rows)
    return out


ACTION_SYMBOL_KEYS = ("symbol", "old_symbol", "new_symbol", "source_symbol", "acquirer_symbol", "acquiree_symbol")


def _actions_of(pages: Sequence[Mapping[str, Any]], names: Sequence[str]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {n: [] for n in names}
    for body in pages:
        acts = body.get("corporate_actions")
        if acts is None:
            continue
        if not isinstance(acts, Mapping):
            raise FetchError(EXIT_FETCH, "a corporate-actions answer not keyed by type")
        for kind, items in acts.items():
            if not isinstance(items, list):
                raise FetchError(EXIT_FETCH, "a corporate-actions answer whose actions are not a list")
            for item in items:
                if not isinstance(item, Mapping):
                    raise FetchError(EXIT_FETCH, "a corporate action that is not an object")
                for sym in sorted({str(item.get(k)) for k in ACTION_SYMBOL_KEYS} & set(names)):
                    out[sym].append({**item, "type": kind})
    return out


def news_counts(pages: Sequence[Mapping[str, Any]], names: Sequence[str]) -> dict[str, int]:
    """The number of news items naming each desk name. Only the `symbols` list of an item is read; its headline and
    everything else are dropped here and never stored or logged."""
    out = dict.fromkeys(names, 0)
    for body in pages:
        items = body.get("news")
        if items is None:
            continue
        if not isinstance(items, list):
            raise FetchError(EXIT_FETCH, "a news answer whose items are not a list")
        for item in items:
            syms = item.get("symbols") if isinstance(item, Mapping) else None
            if not isinstance(syms, list):
                raise FetchError(EXIT_FETCH, "a news item without a symbols list")
            for s in set(syms) & set(names):
                out[str(s)] += 1
    return out


def read_rows(path: Path) -> list[dict[str, Any]]:
    """An event file's rows, as csv.DictReader gives them, comment lines skipped."""
    with path.open(newline="", encoding="utf-8") as f:
        return [dict(r) for r in csv.DictReader(line for line in f if not line.startswith("#"))]


def desk_names(path: Path = DESK) -> list[str]:
    import yaml
    names = yaml.safe_load(path.read_text(encoding="utf-8"))["names"]
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError("options_desk.yaml names is not a list of symbols")
    return [str(n) for n in names]


# ---------------------------------------------------------------- Stage 1

def fetch_stage1(client: Client, session: str, names: Sequence[str], *, min_bars: int,
                 earnings_rows: list[Any], macro_rows: list[Any], clock: Callable[[], dt.datetime],
                 sleep: Callable[[float], None], max_requests: int = STAGE1_REQUEST_BUDGET,
                 time_budget_s: float = STAGE1_TIME_BUDGET_S) -> dict[str, Any]:
    """The Stage 1 bundle for the finished session `session` (D): the split-adjusted SIP daily bars of the
    `min_bars` sessions ending at D for every name. Refused before D's close is final."""
    start = clock()
    if start < lv.close_final_utc(session).replace(tzinfo=s2.UTC):
        raise FetchError(EXIT_TOO_EARLY, f"the close of {session} is not final yet")
    first = sel.session_window(session, min_bars)[0]
    f = Fetcher(client, max_requests=max_requests, deadline=start + dt.timedelta(seconds=time_budget_s),
                clock=clock, sleep=sleep)
    syms = sorted(names)
    pages = f.paged("daily", None, "/v2/stocks/bars", {"symbols": ",".join(syms), "timeframe": "1Day",
                                                       "start": first, "end": session, "adjustment": "split",
                                                       "feed": "sip", "limit": 10000})
    raw = _bars_of(pages, syms)
    bars: dict[str, list[dict[str, Any]]] = {}
    for sym in syms:
        rows = []
        for r in raw[sym]:
            t = s2.parse_ts(r.get("t")) if isinstance(r, Mapping) else None
            if not isinstance(r, Mapping):
                rows.append({"d": "?", "o": None, "h": None, "l": None, "c": None, "v": None})
                continue
            rows.append({"d": s2.ny_date(t) if t is not None else str(r.get("t")),
                         **{k: r.get(k) for k in ("o", "h", "l", "c", "v")}})
        bars[sym] = rows                         # a row that cannot be read is that name's bad_bar in Stage 1
    doc = {"schema": sel.BUNDLE_SCHEMA, "version": sel.BUNDLE_VERSION, "session": session,
           "adjustment": sel.BUNDLE_ADJUSTMENT, "names": list(names), "bars": bars,
           "earnings_rows": earnings_rows, "macro_rows": macro_rows}
    sel.check_bundle(doc)
    return doc


# ---------------------------------------------------------------- Stage 2

def last_close_utc(day: str) -> dt.datetime:
    """The exchange's close of `day`: 16:00 New York, 13:00 on a half day (levels.HALF_DAYS)."""
    return s2.ny_time(day, (13, 0) if day in lv.HALF_DAYS else (16, 0))


def fetch_stage2(client: Client, stage1: Mapping[str, Any], pass_id: str, p: s2.Params, *,
                 earnings_rows: list[Any], macro_rows: list[Any], clock: Callable[[], dt.datetime],
                 sleep: Callable[[float], None], max_requests: int = STAGE2_REQUEST_BUDGET) -> dict[str, Any]:
    """The Stage 2 bundle for one pass on the session Stage 1 selected for. Refused before T + 60 s; cut short at the
    pass's publish-by time."""
    session = str(stage1.get("next_session"))
    s2.check_stage1(stage1, session)
    T = s2.pass_time(session, pass_id, p)
    start = clock()
    if start < T + dt.timedelta(seconds=p.fetch_delay_s):
        raise FetchError(EXIT_TOO_EARLY, f"Pass {pass_id} fetches at {s2.iso(T + dt.timedelta(seconds=p.fetch_delay_s))}"
                                         " or later")
    deadline = s2.ny_time(session, p.publish_by[pass_id])
    f = Fetcher(client, max_requests=max_requests, deadline=deadline, clock=clock, sleep=sleep)
    names = sorted(str(r["symbol"]) for r in stage1["names"])
    syms = ",".join(names)
    prev = lv.prev_session(session)
    days = [prev]
    while len(days) < max(p.baseline_sessions, DAILY_RAW_SESSIONS):
        days.append(lv.prev_session(days[-1]))
    daily = _bars_of(f.paged("daily_raw", None, "/v2/stocks/bars", {
        "symbols": syms, "timeframe": "1Day", "start": days[DAILY_RAW_SESSIONS - 1], "end": prev,
        "adjustment": "raw", "feed": "sip", "limit": 10000}), names)
    minute = _bars_of(f.paged("minute", None, "/v2/stocks/bars", {
        "symbols": syms, "timeframe": "1Min", "start": s2.iso(T - dt.timedelta(seconds=MINUTE_WINDOW_S)),
        "end": s2.iso(T), "adjustment": "raw", "feed": "sip", "limit": 10000}), names)
    premarket: dict[str, dict[str, list[Any]]] = {n: {} for n in names}
    for day in [session] + days[:p.baseline_sessions]:
        got = _bars_of(f.paged("premarket", day, "/v2/stocks/bars", {
            "symbols": syms, "timeframe": "5Min", "start": s2.iso(s2.ny_time(day, p.premarket_from)),
            "end": s2.iso(s2.ny_time(day, p.pass_at[pass_id])), "adjustment": "split", "feed": "sip",
            "limit": 10000}), names)
        for n in names:
            premarket[n][day] = got[n]
    snaps: dict[str, Any] = {}
    for body in f.paged("snapshots", None, "/v2/stocks/snapshots", {"symbols": syms, "feed": "sip"}):
        for sym, snap in body.items():
            if sym in names:
                if snap is not None and not isinstance(snap, Mapping):
                    raise FetchError(EXIT_FETCH, "a snapshot that is not an object")
                snaps[sym] = snap
    actions = _actions_of(f.paged("corporate_actions", None, "/v1/corporate-actions", {
        "symbols": syms, "start": session, "end": session, "limit": 1000}), names)
    news = news_counts(f.paged("news", None, "/v1beta1/news", {
        "symbols": syms, "start": s2.iso(last_close_utc(prev)), "end": s2.iso(T), "limit": 50,
        "include_content": "false", "sort": "asc"}), names)
    limits = [r["x_ratelimit_limit"] for r in f.requests
              if r["what"] in s2.DATA_REQUESTS and r["x_ratelimit_limit"] is not None]
    return {
        "schema": s2.BUNDLE_SCHEMA, "version": s2.BUNDLE_VERSION, "session": session, "pass": pass_id,
        "T": s2.iso(T), "fetched_at": s2.iso(start),
        "stage1_sha": s2.stage1_sha(stage1), "stage1_doc_sha": s2.stage1_doc_sha(stage1),
        "names": names, "requests": f.requests,
        "plan_check": {"x_ratelimit_limit": min(limits) if limits else None},
        "entitlement": {"state": "unknown", "source": None, "checked_at": None},
        "halt": {},
        "fetch": {"complete": True, "cut_short": None},
        "data": {n: {"daily_raw": daily[n], "minute": minute[n], "premarket": premarket[n],
                     "snapshot": snaps.get(n), "corporate_actions": actions[n], "news_count": news[n]}
                 for n in names},
        "earnings_rows": earnings_rows, "macro_rows": macro_rows,
    }


# ---------------------------------------------------------------- writing

def stage2_file(pass_id: str) -> str:
    return f"stage2-{pass_id}-bundle.json"


def write_bundle(folder: Path, name: str, doc: Mapping[str, Any], *, beside: bool) -> Path:
    """Write `doc` as `folder/name`, atomically and never over an existing file. With `beside`, an existing bundle
    is kept and this one is written as `<stem>.2.json`, `.3`, and so on."""
    text = sel.dumps(doc)
    stem = name[:-len(".json")]
    n = 1
    while True:
        path = folder / (name if n == 1 else f"{stem}.{n}.json")
        try:
            s2.write_new(path, text)
            return path
        except FileExistsError:
            if not beside:
                raise
            n += 1


# ---------------------------------------------------------------- command line

class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:
        print(f"select_fetch: usage: {message}", file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def _client() -> Client:
    from wt.data.alpaca import AlpacaREST
    return AlpacaREST(shared=True)


def _now() -> dt.datetime:
    return dt.datetime.now(s2.UTC)


def main(argv: list[str] | None = None, *, client: Callable[[], Client] = _client,
         clock: Callable[[], dt.datetime] = _now, sleep: Callable[[float], None] | None = None) -> int:
    """Exit codes: EXIT_OK and the EXIT_ codes above. Each failure prints one line, never a traceback, and writes no
    bundle."""
    import time
    ap = _Parser(prog="python -m wt.options.select_fetch", description="Options desk selection: save an input bundle")
    sub = ap.add_subparsers(dest="cmd", required=True, parser_class=_Parser)
    a1 = sub.add_parser("stage1", help="the after-close bundle for the finished session D")
    a1.add_argument("--session", required=True)
    a1.add_argument("--root", type=Path, default=VAR_SELECT)
    a1.add_argument("--beside", action="store_true")
    a2 = sub.add_parser("stage2", help="one pre-market pass's bundle")
    a2.add_argument("--pass", dest="pass_id", choices=s2.PASSES, required=True)
    a2.add_argument("--stage1", type=Path, required=True)
    a2.add_argument("--root", type=Path, default=VAR_SELECT)
    a2.add_argument("--beside", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else EXIT_USAGE
    pause = sleep or time.sleep
    try:
        earnings = read_rows(EVENTS / "earnings.csv")
        macro = read_rows(EVENTS / "macro_events.csv")
        if a.cmd == "stage1":
            folder, name, doc = _stage1(a, client, clock, pause, earnings, macro)
        else:
            folder, name, doc = _stage2(a, client, clock, pause, earnings, macro)
    except FetchError as e:
        print(f"select_fetch: {e}", file=sys.stderr)
        return e.code
    except (sel.ParamsError, s2.ParamsError, sel.CalendarError, s2.Stage1Error, sel.BundleError) as e:
        print(f"select_fetch: input: {e}", file=sys.stderr)
        return EXIT_INPUT
    except (KeyError, OSError, UnicodeDecodeError, ValueError) as e:
        print(f"select_fetch: input: cannot be read ({type(e).__name__})", file=sys.stderr)
        return EXIT_INPUT
    try:
        path = write_bundle(folder, name, doc, beside=a.beside)
    except FileExistsError:
        print("select_fetch: a bundle for this pass exists: never written over", file=sys.stderr)
        return EXIT_EXISTS
    except OSError as e:
        print(f"select_fetch: cannot write the bundle ({type(e).__name__})", file=sys.stderr)
        return EXIT_WRITE
    print(f"select_fetch {a.cmd} {doc['session']}: bundle written ({path.name}), {len(doc['names'])} names")
    return EXIT_OK


def _stage1(a: argparse.Namespace, client: Callable[[], Client], clock: Callable[[], dt.datetime],
            pause: Callable[[float], None], earnings: list[Any],
            macro: list[Any]) -> tuple[Path, str, dict[str, Any]]:
    if ev.exact_date(a.session) is None or not lv.is_session(a.session):
        raise FetchError(EXIT_INPUT, f"{a.session} is not a session date")
    p1, _ = sel.load_params()
    sel.check_calendar(a.session, p1)
    folder: Path = a.root / lv.next_session(a.session)
    if any(folder.glob("stage2-*-bundle*.json")):
        raise FetchError(EXIT_CONFIRMED, "a Stage 2 bundle exists for this session: Stage 1 is not re-run")
    if (folder / STAGE1_FILE).exists() and not a.beside:
        raise FetchError(EXIT_EXISTS, "a Stage 1 bundle exists for this session: never written over")
    doc = fetch_stage1(client(), a.session, desk_names(), min_bars=p1.min_bars, earnings_rows=earnings,
                       macro_rows=macro, clock=clock, sleep=pause)
    return folder, STAGE1_FILE, doc


def _stage2(a: argparse.Namespace, client: Callable[[], Client], clock: Callable[[], dt.datetime],
            pause: Callable[[float], None], earnings: list[Any],
            macro: list[Any]) -> tuple[Path, str, dict[str, Any]]:
    p, _ = s2.load_params()
    stage1 = json.loads(a.stage1.read_text(encoding="utf-8"))
    session = str(stage1.get("next_session")) if isinstance(stage1, Mapping) else ""
    if ev.exact_date(session) is None:
        raise FetchError(EXIT_INPUT, "the Stage 1 output names no next session")
    if session < sel.CALENDAR_FROM or session > lv.CALENDAR_THROUGH:
        raise FetchError(EXIT_INPUT, f"{session} is outside the session calendar")
    folder: Path = a.root / session
    if (folder / stage2_file(a.pass_id)).exists() and not a.beside:
        raise FetchError(EXIT_EXISTS, f"a Pass {a.pass_id} bundle exists for {session}: never written over")
    doc = fetch_stage2(client(), stage1, a.pass_id, p, earnings_rows=earnings, macro_rows=macro, clock=clock,
                       sleep=pause)
    return folder, stage2_file(a.pass_id), doc


if __name__ == "__main__":
    raise SystemExit(main())
