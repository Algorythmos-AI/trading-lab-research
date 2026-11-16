"""The options clone's paper runner (DEC-0030): one same-day call or put at a time, by the owner's nine rules.

    python -m wt.live.runner_o          (the job `paper-o` starts it; MODE must be `paper`)

One session, from arm (09:25 New York) to the close. Every 10 seconds it reads the account, the stock bars and the
quotes of what it holds; it manages an open trade first and looks for an entry only on a 2-minute bar that has
just finished. Its own checks run while it trades: a failed check narrows what it may do (no new entries, exits
only, flatten) and pages, and never waits for an answer.

Records: the hash-chained journal `data/live/options_journal.jsonl` (arm, orders, fills, exits, trades, latches,
feed checks, pages) and one decision line per name per finished bar in `var/options/decisions/<date>.jsonl`.

Research arms (DEC-0041), only with `research_arms.enabled` in config/options_clone.yaml: each signal's decision line
gains an `arms` object (the tags of `setups.tag_decision`), and virtual trades (`wt.options.shadow`) go to their own
file `var/options/shadow/<date>.jsonl`. Every arm runs behind its own fault guard and after the control has decided;
nothing an arm reads or writes is read by the control, so its orders are the same with the arms on or off. With the
arms on, a poll's decision lines are written after the arms' work for that poll, so a runner killed during that work
loses that poll's lines (its orders, fills and journal are already written).
"""
from __future__ import annotations

import datetime as dt
import json
import statistics
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import requests

from wt.brokers.base import TransportError
from wt.core import ledger
from wt.core.config import CONFIG_DIR, DATA_DIR, ROOT, STATE_DIR, env, load_yaml
from wt.data.feeds import FeedNotNamed, require_feed
from wt.oms.options import OptionPlan, OptionsOMS, PlanStore, book
from wt.ops import hc, locks
from wt.ops import alerts as pg
from wt.ops.alerts import Alerts, Pager
from wt.options import chain, clone_site, regime, session, setups, shadow
from wt.options import levels as lv
from wt.options.intraday import daily_raw
from wt.options.regime import NEW_YORK
from wt.risk.options_guard import KINDS as LATCH_KINDS
from wt.risk.options_guard import Context, Latches, Limits, week_key

SIDES = ("call", "put")                    # what a page may say about a position (wt.ops.alerts)
FEED_UNFIT = ("quote age", "entry slippage")

OPT = STATE_DIR / "options"
JOURNAL = DATA_DIR / "live" / "options_journal.jsonl"
KILLS = (ROOT / "KILL", OPT / "KILL")
LOCK = "paper-o-runner"
ARM_AT = dt.time(9, 25)
EXPIRY_POLICIES = ("same_day", "nearest")      # config/options_clone.yaml names.expiry (DEC-0034)
# A 2-minute bar is judged once its second minute is in, or this long after its end when that minute never comes
# (IEX leaves out a minute with no trade there). A code constant, not a config number: it makes the clone read only
# finished bars, as DEC-0030 says it does, and leaves config/options_clone.yaml (and EXP-0029's config) as frozen.
LAST_MINUTE_GRACE = dt.timedelta(seconds=15)
# The order a refused signal's reason is chosen in: what closes entries for everyone, then the strategy's gates, then
# the contract. The decision log names the first that failed; `gates` keeps every one.
REASON_ORDER = ("kill", "latch", "off", "open-position", "loss-pause", "cooldown", "stalled", "event",
                "trend", "extension", "room", "reach", "shock", "contract")
REASON_CODE = {"off": "entries-off", "stalled": "stock-feed-stalled"}
CONNECT_TRIES, CONNECT_WAIT_S = 5, 60.0
DATA_HOST = "https://data.alpaca.markets"
PAPER_HOST = "https://paper-api.alpaca.markets"


# ---------------------------------------------------------------- the journal
def write(event: str, **kw: Any) -> bool:
    """Append to the clone's journal, hash-chained and fsynced. Never raises: a full disk must not stop a runner
    that holds a position."""
    rec = {"ts": dt.datetime.now(dt.UTC).isoformat(), "event": event, **kw}
    if (ident := kw.get("trade_id")) and "idem" not in rec:
        rec["idem"] = f"{ident}:{event}"
    try:
        line = ledger.append(JOURNAL, rec, fsync=True)
        ok = True
    except Exception as e:  # noqa: BLE001
        ok, line = False, f"JOURNAL WRITE FAILED ({e.__class__.__name__}): {json.dumps(rec, default=str)[:2000]}"
    try:
        print(line, flush=True)
    except (OSError, ValueError):
        pass
    return ok


def journaled_trades(path: Path = JOURNAL) -> set[str]:
    out: set[str] = set()
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("event") == "trade_closed" and r.get("trade_id"):
                    out.add(str(r["trade_id"]))
    except FileNotFoundError:
        pass
    return out


# ---------------------------------------------------------------- market data
class Feeds(Protocol):
    def minutes(self, symbols: Sequence[str], start: dt.datetime, end: dt.datetime) -> dict[str, list[dict[str, Any]]]: ...
    def daily(self, symbols: Sequence[str], start: dt.datetime, end: dt.datetime) -> dict[str, list[dict[str, Any]]]: ...
    def chain(self, root: str, expiry: dt.date) -> dict[str, Any]: ...
    def quotes(self, symbols: Sequence[str]) -> dict[str, Any]: ...
    def contracts(self, root: str, expiry: dt.date, last: dt.date | None = None) -> dict[str, float]: ...
    def focus(self) -> tuple[Mapping[str, Any] | None, str | None]: ...
    def edition(self) -> Mapping[str, Any] | None: ...


class AlpacaFeeds:
    """The broker's market data, GET only, with the trading account's key pair. Stock bars from IEX (real time on
    the free plan); option quotes from the configured feed (`indicative` free, `opra` with a subscription)."""

    def __init__(self, key_id: str, secret: str, option_feed: str, session_: requests.Session | None = None) -> None:
        self.s = session_ or requests.Session()
        self.h = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
        self.feed = option_feed

    def _get(self, url: str, params: dict[str, str]) -> Any:
        # A market-data request that names no feed is refused before it is sent (B9), as a TransportError: every
        # caller already treats that as a data read that failed (no levels, a stalled tape, no quote), so entries
        # stay off where they would for an unreachable feed and exits are still managed.
        try:
            require_feed(url, params)
        except FeedNotNamed:
            pg.say("options clone: a market-data request named no feed; refused before sending", err=True)
            raise TransportError("feed-not-named") from None
        r = self.s.get(url, params=params, headers=self.h, timeout=(5.0, 10.0), allow_redirects=False)
        if r.status_code != 200:
            raise TransportError(f"http-{r.status_code}")
        return r.json()

    def _paged(self, url: str, params: dict[str, str], key: str, pages: int = 12) -> Any:
        out: Any = None
        for _ in range(pages):
            got = self._get(url, params)
            part = got.get(key) if isinstance(got, dict) else None
            if isinstance(part, dict):
                out = out or {}
                for k, v in part.items():
                    if isinstance(v, list):
                        out.setdefault(k, []).extend(v)
                    else:
                        out[k] = v
            elif isinstance(part, list):
                out = (out or []) + part
            token = got.get("next_page_token") if isinstance(got, dict) else None
            if not token:
                return out if out is not None else {}
            params = {**params, "page_token": str(token)}
        raise TransportError("too-many-pages")

    @staticmethod
    def _z(t: dt.datetime) -> str:
        return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    def minutes(self, symbols: Sequence[str], start: dt.datetime, end: dt.datetime) -> dict[str, list[dict[str, Any]]]:
        p = {"symbols": ",".join(symbols), "timeframe": "1Min", "feed": "iex", "limit": "10000",
             "start": self._z(start), "end": self._z(end)}
        return dict(self._paged(f"{DATA_HOST}/v2/stocks/bars", p, "bars"))

    def daily(self, symbols: Sequence[str], start: dt.datetime, end: dt.datetime) -> dict[str, list[dict[str, Any]]]:
        p = {"symbols": ",".join(symbols), "timeframe": "1Day", "feed": "sip", "adjustment": "split",
             "limit": "10000", "start": self._z(start), "end": self._z(end)}
        return dict(self._paged(f"{DATA_HOST}/v2/stocks/bars", p, "bars"))

    def chain(self, root: str, expiry: dt.date) -> dict[str, Any]:
        p = {"feed": self.feed, "expiration_date": expiry.isoformat(), "limit": "1000"}
        return dict(self._paged(f"{DATA_HOST}/v1beta1/options/snapshots/{root}", p, "snapshots"))

    def quotes(self, symbols: Sequence[str]) -> dict[str, Any]:
        p = {"symbols": ",".join(symbols), "feed": self.feed}
        return dict(self._paged(f"{DATA_HOST}/v1beta1/options/snapshots", p, "snapshots"))

    def contracts(self, root: str, expiry: dt.date, last: dt.date | None = None) -> dict[str, float]:
        """Open interest per listed contract expiring on `expiry`, or from `expiry` to `last` when `last` is given."""
        p = {"underlying_symbols": root, "status": "active", "limit": "10000"}
        if last is None:
            p["expiration_date"] = expiry.isoformat()
        else:
            p |= {"expiration_date_gte": expiry.isoformat(), "expiration_date_lte": last.isoformat()}
        rows = self._paged(f"{PAPER_HOST}/v2/options/contracts", p, "option_contracts", pages=4)
        out: dict[str, float] = {}
        for r in rows if isinstance(rows, list) else []:
            try:
                out[str(r["symbol"])] = float(r.get("open_interest") or 0)
            except (KeyError, TypeError, ValueError):
                continue
        return out

    def focus(self) -> tuple[Mapping[str, Any] | None, str | None]:
        """The latest options edition's focus names, from the dashboard's signed route; (None, None) on any
        failure, and the runner then trades its fallback names."""
        return clone_site.read_focus(session_=self.s)

    def edition(self) -> Mapping[str, Any] | None:
        """The latest options edition from the site (DEC-0033: the levels the cards show), or None."""
        from wt.options.pipeline_check import read_edition
        return read_edition("options")


# ---------------------------------------------------------------- the research arms' stamps (DEC-0041)
def release_commit(root: Path = ROOT) -> str:
    """The commit the running checkout is at, or `unknown`: which release wrote an arm's record."""
    import subprocess
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                             timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    sha = out.stdout.strip()
    return sha if out.returncode == 0 and len(sha) == 40 else "unknown"


def control_config_hash(cfg: Mapping[str, Any]) -> str:
    """A hash of the control's configuration: config/options_clone.yaml as loaded, without the `research_arms`
    block, so that turning the arms on is not a change of EXP-0029's config and any other change is."""
    import hashlib
    body = json.dumps({k: v for k, v in cfg.items() if k != "research_arms"}, sort_keys=True, default=str)
    return hashlib.sha256(body.encode()).hexdigest()[:16]


# ---------------------------------------------------------------- the runner
@dataclass
class Name:
    root: str
    marks: list[setups.Mark]
    oi: dict[str, float]                        # open interest of the contracts of `expiry`
    expiry: dt.date | None = None               # the expiry it trades today (DEC-0034); None: the session's
    last_bar: str = ""                          # the end (HH:MM) of the last finished bar looked at
    last_close: float | None = None             # that bar's close when it was looked at (a later change is logged)
    revised: str = ""                           # the end (HH:MM) of the last bar whose close was logged as revised
    cooldown_until: dt.datetime | None = None
    research: dict[str, float] = field(default_factory=dict)   # DEC-0041 level codes, tagging only (never marks)


@dataclass
class ArmsBar:
    """One name's finished bar as the arms see it, after the control has decided on it (DEC-0041)."""
    rec: dict[str, Any]                                   # the control's decision line, written as it is
    to_tag: list[tuple[dict[str, Any], setups.Signal, chain.Choice]] = field(default_factory=list)
    tids: dict[int, str] = field(default_factory=dict)
    root: str = ""
    nm: Name | None = None
    two: Sequence[regime.Bar] = ()
    tape: regime.Tape | None = None
    near: Sequence[setups.Mark] = ()
    quotes: list[chain.Quote] | None = None              # the chain the control read on this bar, if it read one


@dataclass
class Runner:
    day: dt.date
    cfg: Mapping[str, Any]
    lim: Limits
    feeds: Feeds
    broker: Any
    now: Callable[[], dt.datetime]
    sleep: Callable[[float], None]
    pager: Any
    write: Callable[..., bool] = write
    state: Path = OPT
    kills: tuple[Path, ...] = KILLS
    macro: Sequence[Mapping[str, Any]] = ()
    earnings: Sequence[Mapping[str, Any]] = ()
    exits_only: str | None = None
    names: dict[str, Name] = field(default_factory=dict)
    plans: list[OptionPlan] = field(default_factory=list)
    journaled: set[str] = field(default_factory=set)
    account_holds: set[str] = field(default_factory=set)
    off: dict[str, str] = field(default_factory=dict)     # why entries are off for the rest of the session
    quote_ages: list[tuple[dt.datetime, float]] = field(default_factory=list)
    exit_tries: dict[str, list[dt.datetime]] = field(default_factory=dict)
    mark_seen: dict[str, tuple[float, dt.datetime]] = field(default_factory=dict)
    broker_faults: int = 0
    broker_down_since: dt.datetime | None = None
    last_bid: dict[str, float] = field(default_factory=dict)
    paged_exit: set[str] = field(default_factory=set)
    verified: bool = False
    sending: str = ""                                      # the plan whose entry is leaving now (not "unknown")
    paged_critical: bool = False
    names_source: str | None = None                       # focus | fallback
    publisher: Any = None                                  # clone_site.Publisher, or None: nothing is published
    doc_fault: str = ""

    def __post_init__(self) -> None:
        self.session = self.day.isoformat()
        self.ck = session.clock(self.session, self.cfg["day"])
        self.store = PlanStore(self.state / "plans")
        self.latches = Latches(self.state / "latches")
        self.fee = float(self.cfg["costs"]["fee_per_contract_each_way"])
        self.oms = OptionsOMS(self.broker, self.store, self.lim, self.context, self.now, self.sleep)
        self.policy = str(self.cfg["names"].get("expiry", "same_day"))
        if self.policy not in EXPIRY_POLICIES:
            raise ValueError(f"names.expiry: {self.policy!r} is not one of {EXPIRY_POLICIES}")
        self.arms_cfg: Mapping[str, Any] = {}
        self.shadow: shadow.Shadow | None = None
        self.leader_cache: dict[tuple[str, str], regime.Tape | None] = {}
        self.gap_logged: set[str] = set()
        self.stamp: dict[str, str] = {}
        self.quote_bid: dict[str, tuple[float, float, dt.datetime]] = {}   # symbol -> this poll's fresh quote bid
        self.arms_setup()

    # ---- helpers -----------------------------------------------------------------------------
    def today(self) -> list[OptionPlan]:
        return [p for p in self.plans if p.date == self.session]

    def page(self, key: str, title: str, msg: str, prio: int = 4) -> None:
        self.pager.fire(f"options-clone:{key}", title, msg, prio)
        self.write("page", key=key, title=title)

    def decision(self, rec: dict[str, Any]) -> None:
        p = self.state / "decisions" / f"{self.session}.jsonl"
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "a") as fh:
                fh.write(json.dumps(rec, default=str) + "\n")
        except OSError:
            pass

    def killed(self) -> bool:
        return any(k.exists() for k in self.kills)

    def pnl_view(self) -> tuple[float, float, float]:
        """(today's dollars incl. the open trade's mark, this week's, the distance from the high-water mark)."""
        closed = sorted((p for p in self.plans if p.state == "closed" and p.pnl(self.fee) is not None),
                        key=lambda p: p.exit_at)
        open_now = sum((self.last_bid[p.trade_id] - p.fill) * 100 - self.fee
                       for p in self.plans if p.state in ("open", "exiting") and p.fill is not None
                       and p.trade_id in self.last_bid)
        day = sum(p.pnl(self.fee) or 0.0 for p in closed if p.date == self.session) + open_now
        wk = week_key(self.day)
        week = sum(p.pnl(self.fee) or 0.0 for p in closed if week_key(dt.date.fromisoformat(p.date)) == wk) + open_now
        cum, peak = 0.0, 0.0
        for p in closed:
            cum += p.pnl(self.fee) or 0.0
            peak = max(peak, cum)
        return day, week, cum + open_now - peak

    def losing_streak(self) -> tuple[int, dt.datetime | None]:
        done = sorted((p for p in self.today() if p.state == "closed"), key=lambda p: p.exit_at)
        n, last = 0, None
        for p in reversed(done):
            if (p.pnl(self.fee) or 0.0) < 0:
                n += 1
                last = last or dt.datetime.fromisoformat(p.exit_at)
            else:
                break
        return n, last

    def context(self) -> Context:
        today = self.today()
        filled = [p for p in today if p.fill is not None]
        attempts: dict[str, int] = {}
        for p in filled:
            attempts[p.root] = attempts.get(p.root, 0) + 1
        return Context(
            now=self.now(), names_today=set(self.names), entries_today=len(filled), attempts=attempts,
            orders_today=sum(p.seq for p in today), open_positions=sum(p.state in ("open", "exiting") for p in self.plans),
            unknown_outstanding=any(p.state == "entering" and p.trade_id != self.sending for p in self.plans),
            account_holds=set(self.account_holds),
            own_qty={p.symbol: p.own_qty for p in self.plans if p.active},
            kill=self.killed(), latched=self.latches.active(self.day),
            entries_off="; ".join(sorted(set(self.off.values()))) or None,
            market_open=self.ck.open <= self.now() < self.ck.close, last_entry=self.ck.last_entry)

    # ---- arm ---------------------------------------------------------------------------------
    def arm(self) -> bool:
        """Reconcile, book anything finished, choose today's names, mark their levels. False: no entries today
        (exits are still managed by `step`)."""
        try:
            self.plans = self.store.load_all()
        except (OSError, ValueError, TypeError) as e:
            self.off["plans"] = "plans unreadable"
            self.page("plans-unreadable", "Options clone: plan files unreadable", pg.exc_name(e), 5)
            return False
        self.journaled = journaled_trades()
        for p in self.plans:
            if not p.recorded and book(p, self.journaled, self.write, self.fee):
                p.recorded = True
                self.store.save(p)
        if self.exits_only:
            self.off["exits-only"] = self.exits_only
        if str(self.cfg.get("orders")) != "paper":
            self.off["orders"] = f"orders: {self.cfg.get('orders')}"
        level = getattr(self.broker, "options_level", lambda: None)()
        if level is not None and level < int(self.cfg["account"]["min_options_level"]):
            self.off["level"] = f"options level {level}"
            self.page("options-level", "Options clone: account cannot buy options",
                      f"Options level {pg.count(level)}; buying calls and puts needs 2.", 5)
        try:
            rep = self.oms.reconcile(self.plans)
            self.account_holds = {x.symbol for x in self.broker.positions() if x.qty}
        except TransportError as e:
            self.off["broker"] = "broker unreachable at arm"
            # The detail goes to the job's log, never to the page (the topic is public).
            pg.say(f"broker unreachable at arm: {e.__class__.__name__}: {str(e)[:300]}", err=True)
            self.page("broker", "Options clone: broker unreachable at arm",
                      f"{pg.exc_name(e)}; entries are off today. The clone's log has the detail.", 4)
            return False
        own = getattr(self.broker, "own_account", False)
        stock = [s for s in self.account_holds if chain.parse_occ(s) is None]
        if stock or (own and rep["unknown_positions"]):
            self.off["position-at-arm"] = "a position no plan knows"
            self.page("flatten-required", "Options clone: a position no plan knows",
                      "Entries are off today. See docs/runbooks/options-clone.md.", 5)
        self.prepare()
        self.arms_guard("restore", self.arms_restore)
        self.write("armed", session=self.session, names=sorted(self.names), off=sorted(self.off),
                   own_account=own, options_level=level, plans_open=[p.trade_id for p in self.plans if p.active],
                   orders=self.cfg.get("orders"), feed=self.cfg["feeds"]["option"])
        hc.ping_async("wt-paper-o-armed", "", f"names {len(self.names)}")
        self.publish()
        return not self.off

    def expiry_for(self, root: str) -> tuple[dt.date | None, dict[str, float]]:
        """The expiry `root` trades today and its contracts' open interest, or (None, {}) if it has none (DEC-0034).
        Today's when one is listed; under `nearest`, otherwise the first listed within `names.nearest_within_days`."""
        oi = self.feeds.contracts(root, self.day)
        if oi:
            return self.day, oi
        if self.policy != "nearest":
            return None, {}
        last = self.day + dt.timedelta(days=int(self.cfg["names"]["nearest_within_days"]))
        listed = self.feeds.contracts(root, self.day + dt.timedelta(days=1), last)
        by_expiry: dict[dt.date, dict[str, float]] = {}
        for sym, n in listed.items():
            c = chain.parse_occ(sym)
            if c is not None and c.root == root and self.day < c.expiry <= last:
                by_expiry.setdefault(c.expiry, {})[sym] = n
        if not by_expiry:
            return None, {}
        first = min(by_expiry)
        return first, by_expiry[first]

    def prepare(self) -> None:
        """Today's names: the focus names that can be traded today (an expiry under `names.expiry`, readable levels),
        topped up from `names.top_up` in order until at least `names.min_names` can be traded (DEC-0032, DEC-0034)."""
        focus, edition = self.feeds.focus()
        cfg_n = self.cfg["names"]
        cap = int(cfg_n["max_names"])
        wanted, source = session.names(focus, edition, self.session, cfg_n["fallback"], cap)
        top_up = [r for r in cfg_n.get("top_up", []) if r not in wanted]
        start = dt.datetime.combine(self.day - dt.timedelta(days=420), dt.time(0), dt.UTC)
        end = dt.datetime.combine(self.day, dt.time(0), dt.UTC) - dt.timedelta(seconds=1)
        every = list(dict.fromkeys([*wanted, *top_up]))
        try:
            daily = self.feeds.daily(every, start, end)
            pre_start = dt.datetime.combine(self.day, dt.time(4, 0), NEW_YORK)
            pre = self.feeds.minutes(every, pre_start, min(self.now(), self.ck.open))
        except (TransportError, requests.RequestException) as e:
            self.off["levels"] = "levels unavailable"
            self.page("levels", "Options clone: no levels today", pg.exc_name(e), 4)
            return
        dropped: dict[str, str] = {}
        ed = self.feeds.edition() if hasattr(self.feeds, "edition") else None
        from_edition = {str(x.get("symbol")): x for x in (ed or {}).get("tickers") or [] if isinstance(x, Mapping)} \
            if isinstance(ed, Mapping) and ed.get("session") == self.session else {}
        level_source: dict[str, str] = {}
        level_diffs: dict[str, list[str]] = {}
        expiries: dict[str, str] = {}

        def add(root: str) -> bool:
            try:
                expiry, oi = self.expiry_for(root)
                if expiry is None:
                    dropped[root] = "no same-day expiry" if self.policy == "same_day" else \
                        f"no expiry within {cfg_n['nearest_within_days']} days"
                    return False
                loaded = lv.load_ibkr(daily_raw([b for b in daily.get(root, []) if isinstance(b, dict)]))
                if loaded.problems or not loaded.bars:
                    dropped[root] = "daily bars"
                    return False
                own = lv.levels_for(loaded.bars, self.session)
                theirs = session.levelset_from_edition(from_edition[root]) if root in from_edition else None
                levels = theirs or own
                level_source[root] = "edition" if theirs else "tape"
                if theirs:                                   # the cross-check DEC-0033 asks for, journaled
                    mine = {x.name: x.price for x in own["levels"]}
                    level_diffs[root] = [f"{x.name} {round(x.price, 2)} vs {round(mine[x.name], 2)}"
                                         for x in theirs["levels"] if x.name in self.cfg["levels"]["names"]
                                         and x.name in mine and abs(x.price - mine[x.name]) > 0.05]
                pm = session.premarket_range(pre.get(root, []), self.day) if self.cfg["levels"].get("premarket") else None
                marks = session.marks(levels, self.cfg["levels"]["names"], self.cfg["levels"]["strong"], pm)
                self.names[root] = Name(root, marks, oi, expiry)
                if self.arms_cfg:
                    self.arms_guard("levels", self.arms_levels, root, loaded.bars)
                expiries[root] = expiry.isoformat()
                return True
            except (ValueError, TypeError, KeyError, TransportError, requests.RequestException) as e:
                dropped[root] = e.__class__.__name__
                return False

        for root in wanted:
            add(root)
        topped: list[str] = []
        for root in top_up:
            if len(self.names) >= min(int(cfg_n.get("min_names", 0)), cap):
                break
            if add(root):
                topped.append(root)
        if topped:
            source = f"{source}+top-up"
        self.names_source = source
        self.write("names", source=source, names=sorted(self.names), dropped=dropped, topped_up=topped,
                   policy=self.policy, expiries=expiries,
                   level_source=level_source, level_diffs={k: v for k, v in level_diffs.items() if v})
        if not self.names:
            self.off["names"] = "no name to trade"
        if self.arms_cfg and self.names:
            found = {r: n.research for r, n in sorted(self.names.items())}
            self.arms_guard("levels", self.arms_write, [{"ts": self.now().isoformat(), "event": "levels",
                                                         "levels": found}])

    # ---- one poll ----------------------------------------------------------------------------
    def step(self) -> None:
        now = self.now()
        try:
            self.account_holds = {x.symbol for x in self.broker.positions() if x.qty}
            marks = self.broker.marks() if hasattr(self.broker, "marks") else {}
            if self.broker_down_since is not None:
                self.write("broker_back")
            self.broker_faults, self.broker_down_since = 0, None
        except TransportError:
            self.broker_faults += 1
            self.broker_down_since = self.broker_down_since or now
            if self.broker_faults == 3:
                self.page("broker", "Options clone: broker unreachable", "Three polls in a row.", 4)
            if any(p.state in ("open", "exiting") for p in self.plans) and now - self.broker_down_since > dt.timedelta(minutes=5):
                self.critical("broker unreachable for five minutes with a position open")
            return
        for sym, px in marks.items():
            if self.mark_seen.get(sym, (None, now))[0] != px:
                self.mark_seen[sym] = (px, now)
        bars, tapes, stalled = self.read_tape(now)
        for p in [p for p in self.plans if p.active]:
            self.manage(p, now, bars, tapes, stalled, marks)
        day_pnl, week_pnl, from_peak = self.pnl_view()
        latched = self.latches.check(self.day, now, self.lim, day_pnl, week_pnl, from_peak)
        if latched and "latch" not in self.off:
            self.off["latch"] = f"{latched} latch"
            self.write("latched", kind=latched, day=round(day_pnl, 2), week=round(week_pnl, 2),
                       from_peak=round(from_peak, 2))
            self.pager.once_per_day(f"options-clone:latched-{latched}", "Options clone latched",
                                    f"The {pg.word(latched, LATCH_KINDS, 'loss')} loss latch is on; no new entries.", 4)
            self.publish()
        if now >= self.ck.verify_flat and not self.verified:
            self.verify(now)
        if now >= self.ck.critical:
            held = [p for p in self.plans if p.state in ("open", "exiting")]
            if held:
                self.critical(f"{pg.count(len(held))} position still open at {pg.hhmm(self.ck.critical)}")
        if self.ck.first_entry <= now <= self.ck.last_entry:
            self.look_for_entries(now, bars, tapes, stalled)
        if self.shadow is not None:                      # last: the control has managed and entered for this poll
            self.arms_guard("step", self.arms_step, now, bars, tapes)

    def critical(self, why: str) -> None:
        if not self.paged_critical:
            self.paged_critical = True
            self.page("flatten-required", "Options clone: FLATTEN REQUIRED", why + ". Close it by hand in Alpaca.", 5)
            self.publish()

    def read_tape(self, now: dt.datetime) -> tuple[dict[str, list[regime.Bar]], dict[str, regime.Tape], set[str]]:
        roots = sorted(set(self.names) | {"SPY"})
        bars: dict[str, list[regime.Bar]] = {}
        tapes: dict[str, regime.Tape] = {}
        stalled: set[str] = set()
        if now < self.ck.open:
            return bars, tapes, stalled
        try:
            rows = self.feeds.minutes(roots, self.ck.open, now)
        except (TransportError, requests.RequestException):
            return bars, tapes, set(roots)
        b = self.cfg["bars"]
        stall = dt.timedelta(seconds=float(self.cfg["feeds"]["bar_stall_s"]))
        for root in roots:
            ms = regime.minute_bars(rows.get(root, []), self.day)
            if not ms or now - ms[-1].end > stall:
                stalled.add(root)
            two = regime.resample(ms, int(b["minutes"]), now, LAST_MINUTE_GRACE)
            bars[root] = two
            t = regime.read(two, int(b["atr_period"]), int(b["ema_fast"]), int(b["ema_slow"]),
                            float(self.cfg["gates"]["shock_bar_atr"]))
            if t is not None:
                tapes[root] = t
        return bars, tapes, stalled

    # ---- managing a trade --------------------------------------------------------------------
    def manage(self, p: OptionPlan, now: dt.datetime, bars: Mapping[str, list[regime.Bar]],
               tapes: Mapping[str, regime.Tape], stalled: set[str], marks: Mapping[str, float]) -> None:
        try:
            if p.state == "entering":
                self.oms.sync_entry(p)
                if p.state == "entering" and now >= self.entry_deadline(p):
                    self.oms.expire_entry(p)
                if p.state == "open":
                    self.on_fill(p)
                elif p.state in ("cancelled", "rejected"):
                    self.write("entry_unfilled", trade_id=p.trade_id, state=p.state)
                    self.publish()
                return
            self.oms.sync_open(p)
            if p.state == "closed":
                self.finish(p)
                return
            if p.fill is None:
                return
            if not p.protect_id and p.state == "open":
                self.oms.protect(p, float(self.cfg["exits"]["premium_stop_pct"]), float(self.cfg["exits"]["target_pct"]),
                                 self.try_broker_stop())
            bid, age = self.bid(p, now, marks)
            if bid is not None:
                self.last_bid[p.trade_id] = bid
                p.best_bid = max(p.best_bid or bid, bid)
                p.worst_bid = min(p.worst_bid if p.worst_bid is not None else bid, bid)
                if not p.breakeven and p.best_bid >= p.fill * (1 + float(self.cfg["exits"]["breakeven_after_pct"]) / 100):
                    p.breakeven = True
                    self.write("breakeven", trade_id=p.trade_id)
                self.store.save(p)
            reason = self.exit_reason(p, now, bid, age, bars.get(p.root, []), tapes.get(p.root), p.root in stalled)
            if reason or p.state == "exiting":
                self.exit(p, reason or p.exit_reason or "retry", now)
        except TransportError as e:
            self.write("manage_fault", trade_id=p.trade_id, error=str(e)[:80])

    def entry_deadline(self, p: OptionPlan) -> dt.datetime:
        h, m = (int(x) for x in p.signal_bar.split(":"))
        ttl = int(self.cfg["order"]["entry_ttl_bars"]) * int(self.cfg["bars"]["minutes"])
        return dt.datetime.combine(self.day, dt.time(h, m), NEW_YORK) + dt.timedelta(minutes=ttl)

    def try_broker_stop(self) -> bool:
        if str(self.cfg["exits"].get("broker_stop")) != "try":
            return False
        return not any(q.broker_stop == "refused" for q in self.plans)

    def on_fill(self, p: OptionPlan) -> None:
        slip = None if not p.quoted_ask or p.fill is None else round((p.fill - p.quoted_ask) / p.quoted_ask * 100, 2)
        self.write("filled", trade_id=p.trade_id, symbol=p.symbol, setup=p.setup, side=p.side, fill=p.fill,
                   quoted_ask=p.quoted_ask, slippage_pct=slip)
        self.pager.fire(f"options-clone:entry-{p.trade_id}", "Options clone entered",
                        f"A paper {pg.word(p.side, SIDES, 'option')} entry filled. The clone journal's filled "
                        "record and the plan file have the name, the setup and the level.", 3)
        if self.shadow is not None and p.fill is not None:
            self.arms_guard("runner", self.arms_runner, p)
        if p.fill is not None and p.fill > float(self.cfg["contract"]["max_ask"]) + 1e-9:
            self.off["fill-over-cap"] = "a fill above the premium cap"
            self.exit(p, "operational", self.now())
        self.check_feed_fit()
        self.publish()

    def bid(self, p: OptionPlan, now: dt.datetime, marks: Mapping[str, float]) -> tuple[float | None, float | None]:
        """The price a seller gets now, and its age in seconds: the live quote's bid when fresh, else the broker's
        mark when it moved recently."""
        try:
            raw = self.feeds.quotes([p.symbol])
        except (TransportError, requests.RequestException):
            raw = {}
        q = next(iter(chain.parse_snapshots(raw)), None)
        age = q.age_s(now) if q is not None else None
        if q is not None and q.bid is not None and age is not None:
            self.quote_ages.append((now, age))
            if age <= float(self.cfg["feeds"]["quote_stale_flat_s"]):
                self.quote_bid[p.symbol] = (q.bid, age, now)       # read by the runner arm only (HYP-0044)
                return q.bid, age
        seen = self.mark_seen.get(p.symbol)
        if seen is not None:
            m_age = (now - seen[1]).total_seconds()
            return seen[0], m_age if age is None else min(age, m_age)
        return (q.bid if q is not None else None), age

    def exit_reason(self, p: OptionPlan, now: dt.datetime, bid: float | None, age: float | None,
                    bars: Sequence[regime.Bar], tape: regime.Tape | None, stalled: bool) -> str | None:
        """The first exit rule that applies, in the registered order (DEC-0030; plan Part 2)."""
        ex = self.cfg["exits"]
        if now >= self.ck.flatten:
            return "flatten"
        day_pnl, _, _ = self.pnl_view()
        if day_pnl <= -self.lim.day_loss_latch:
            return "day-loss"
        if bid is None or age is None or age > float(self.cfg["feeds"]["blind_exit_s"]):
            return "blind"
        if stalled:
            return "stock-feed-stalled"
        s = 1 if p.side == "call" else -1
        filled_at = dt.datetime.fromisoformat(p.filled_at)
        last = next((b for b in reversed(bars) if b.end > filled_at), None)
        if last is not None and (last.c - p.invalidation) * s < 0:
            return "chart"
        assert p.fill is not None
        stop = p.fill if p.breakeven else p.fill * (1 - float(ex["premium_stop_pct"]) / 100)
        if bid <= stop + 1e-9:
            return "breakeven" if p.breakeven else "premium"
        if now - filled_at >= dt.timedelta(minutes=float(ex["time_stop_min"])) and bid <= p.fill + 1e-9:
            return "time"
        if ex.get("take_profit_at_next_level") and p.next_level is not None and tape is not None \
                and (tape.close - p.next_level) * s >= 0:
            return "next-level"
        if p.protect_kind != "target" and bid >= p.fill * (1 + float(ex["target_pct"]) / 100) - 1e-9:
            return "target"
        return None

    def exit(self, p: OptionPlan, reason: str, now: dt.datetime) -> None:
        tries = self.exit_tries.setdefault(p.trade_id, [])
        tries.append(now)
        done = self.oms.exit_now(p, reason)
        if done:
            self.finish(p)
            return
        if p.trade_id not in self.paged_exit and (len(tries) >= 3 or now - tries[0] >= dt.timedelta(seconds=60)):
            self.paged_exit.add(p.trade_id)
            self.oms.note(p, "exit-failed-paged")
            self.page("exit-failed", "Options clone: an exit has not filled",
                      f"A paper {pg.word(p.side, SIDES, 'option')} exit: {pg.count(len(tries))} tries since "
                      f"{pg.hhmm(tries[0])}. The clone's plan file names the position.", 4)

    def finish(self, p: OptionPlan) -> None:
        if book(p, self.journaled, self.write, self.fee):     # first: the pages below point at this record
            p.recorded = True
            self.store.save(p)
        if p.state == "unresolved":
            self.page("lot-taken-by-hand", "Options clone: a lot was sold by hand",
                      "The account holds less of one name than the clone bought. Booked as unresolved; the clone "
                      "journal's trade_closed record and its plan file name it.", 4)
        if self.shadow is not None:
            self.arms_guard("control-closed", self.arms_control_closed, p)
        rop = p.return_on_premium(self.fee)
        self.pager.fire(f"options-clone:exit-{p.trade_id}", "Options clone exited",
                        f"A paper {pg.word(p.side, SIDES, 'option')} position closed"
                        + ("" if rop is None else f", {pg.ratio(rop, '+.0%')} on premium")
                        + ". The clone journal's trade_closed record has the name and the reason.", 3)
        if p.state == "closed" and (p.pnl(self.fee) or 0.0) < 0 and p.root in self.names:
            self.names[p.root].cooldown_until = self.now() + dt.timedelta(
                minutes=float(self.cfg["day"]["name_cooldown_after_loss_min"]))
        self.publish()

    def verify(self, now: dt.datetime) -> None:
        self.verified = True
        own = {p.symbol for p in self.plans if p.state in ("open", "exiting", "entering")}
        held = own & self.account_holds
        self.write("verify_flat", flat=not own, own_open=sorted(own), held=sorted(held))
        if own:
            self.page("not-flat", "Options clone NOT FLAT", f"{pg.count(len(own))} open at {pg.hhmm(now)}; retrying.", 5)

    def check_feed_fit(self) -> None:
        now = self.now()
        recent = [a for t, a in self.quote_ages if now - t <= dt.timedelta(minutes=10)]
        slips = [(p.fill - p.quoted_ask) / p.quoted_ask * 100 for p in self.today()
                 if p.fill is not None and p.quoted_ask][-10:]
        f = self.cfg["feeds"]
        why, what, value = None, "", 0.0
        if len(recent) >= 5 and statistics.median(recent) > float(f["unfit_median_quote_age_s"]):
            what, value = "quote age", statistics.median(recent)
            why = f"median quote age {value:.1f}s"
        elif len(slips) >= 3 and statistics.median(slips) > float(f["unfit_median_slippage_pct"]):
            what, value = "entry slippage", statistics.median(slips)
            why = f"median entry slippage {value:.1f}%"
        if why and "feed" not in self.off:
            self.off["feed"] = "feed-unfit"
            self.write("feed_unfit", why=why)
            self.pager.once_per_day("options-clone:feed-unfit", "Options clone: feed unfit, entries off",
                                    f"Median {pg.word(what, FEED_UNFIT, 'feed measure')} "
                                    f"{pg.ratio(value, '.1f')}{'%' if what == 'entry slippage' else ' s'}.", 4)
            self.publish()

    # ---- entries -----------------------------------------------------------------------------
    def look_for_entries(self, now: dt.datetime, bars: Mapping[str, list[regime.Bar]],
                         tapes: Mapping[str, regime.Tape], stalled: set[str]) -> None:
        self.check_feed_fit()
        streak, last_loss = self.losing_streak()
        dcfg = self.cfg["day"]
        if streak >= int(dcfg["done_after_losses"]):
            self.off.setdefault("losses", f"{streak} losses in a row")
        paused = streak >= int(dcfg["loss_pause_after"]) and last_loss is not None \
            and now < last_loss + dt.timedelta(minutes=float(dcfg["loss_pause_min"]))
        late = now.astimezone(NEW_YORK).strftime("%H:%M") >= str(self.cfg["contract"]["late_from"])
        queue: list[ArmsBar] = []                       # with the arms on: each bar's line, written once all are done
        try:
            self.entries(now, bars, tapes, stalled, streak, last_loss, paused, late, queue)
        finally:
            if queue:
                self.arms_flush(queue, now, tapes, late)

    def note_revised(self, nm: Name, two: Sequence[regime.Bar]) -> None:
        """Journal once when the bar last looked at now has another close: the feed changed a bar after the clone
        judged it. Only the last bar judged and only its close are compared, inside the entry window, so a count of
        zero means none was seen, not that none happened."""
        if not nm.last_bar or nm.last_close is None or nm.revised == nm.last_bar:
            return
        for b in reversed(two):
            end = b.end.strftime("%H:%M")
            if end == nm.last_bar:
                if b.c != nm.last_close:
                    nm.revised = end
                    self.write("bar_revised", root=nm.root, bar=end, judged=nm.last_close, now=b.c)
                return
            if end < nm.last_bar:
                return

    def entries(self, now: dt.datetime, bars: Mapping[str, list[regime.Bar]], tapes: Mapping[str, regime.Tape],
                stalled: set[str], streak: int, last_loss: dt.datetime | None, paused: bool, late: bool,
                queue: list[ArmsBar]) -> None:
        """The control's look at each name's new bar. With the arms on, each decision line is handed to `queue`
        instead of written, so every arm's work (and its network calls) runs after every order of this poll."""
        for root, nm in sorted(self.names.items()):
            two = bars.get(root, [])
            self.note_revised(nm, two)
            if not two or two[-1].end.strftime("%H:%M") == nm.last_bar:
                continue
            nm.last_bar = two[-1].end.strftime("%H:%M")
            nm.last_close = two[-1].c
            tape = tapes.get(root)
            rec: dict[str, Any] = {"bar": nm.last_bar, "root": root, "word": tape.word if tape else None}
            blocks = {k: v for k, v in {
                "off": "; ".join(sorted(set(self.off.values()))) or None,
                "kill": "KILL" if self.killed() else None,
                "latch": self.latches.active(self.day),
                "open-position": "open" if any(p.active for p in self.plans) else None,
                "loss-pause": "paused" if paused else None,
                "cooldown": "cooldown" if nm.cooldown_until and now < nm.cooldown_until else None,
                "stalled": "stalled" if root in stalled else None,
                "event": session.event_block(now, root, self.macro, self.earnings, self.cfg["gates"],
                                             self.cfg["contract"]["index_names"]),
            }.items() if v}
            if tape is None or tape.atr is None or tape.atr <= 0:
                rec["action"] = "warming-up"
                if self.arms_cfg:
                    queue.append(ArmsBar(rec))
                else:
                    self.decision(rec)
                continue
            near = setups.near_level(tape.close, nm.marks, tape.atr, float(self.cfg["levels"]["tolerance_atr"]))
            sigs = setups.retest(two, near, tape.atr, self.cfg["setups"]["retest"]) + \
                setups.rejection(two, near, self.cfg["setups"]["rejection"])
            rec["signals"] = []
            to_tag: list[tuple[dict[str, Any], setups.Signal, chain.Choice]] = []
            tids: dict[int, str] = {}                  # id(one) -> the trade it opened, for the tags' join
            seen_quotes: list[chain.Quote] | None = None
            entered = refused = False
            acted = {(q.root, q.signal_bar, q.setup, q.side) for q in self.today()}
            for sig in sigs:
                if entered:
                    break
                if (root, sig.bar_end, sig.setup, sig.side) in acted:      # a restart sees the same bar again
                    rec.setdefault("signals", []).append({"setup": sig.setup, "side": sig.side, "already": True})
                    continue
                iv = None
                chain_ok = True
                try:
                    raw = self.feeds.chain(root, nm.expiry or self.day)
                    quotes = chain.with_model(chain.parse_snapshots(raw), tape.close, now)
                    seen_quotes = quotes
                    atm = min((q for q in quotes if q.contract.side == sig.side and q.iv),
                              key=lambda q: abs(q.contract.strike - tape.close), default=None)
                    iv = atm.iv if atm else None
                except (TransportError, requests.RequestException):
                    quotes, chain_ok = [], False
                g = setups.gate(sig, tape, tapes.get("SPY"), nm.marks,
                                session.remaining_move(tape.close, iv, now, self.ck), self.cfg["gates"])
                for k, v in blocks.items():
                    g.add(k, False, v)
                choice = chain.pick(quotes, root, sig.side, nm.expiry or self.day, tape.close, now,
                                    {**self.cfg["contract"], "quote_stale_flat_s": self.cfg["feeds"]["quote_stale_flat_s"]},
                                    nm.oi, self.account_holds, late)
                g.add("contract", choice.quote is not None, choice.reasons)
                one: dict[str, Any] = {"setup": sig.setup, "side": sig.side, "level": sig.level.name,
                                       "entry": sig.entry, "gates": g.as_json(),
                                       **self.logged_refusal(g, sig, nm, choice, chain_ok, streak, last_loss)}
                to_tag.append((one, sig, choice))
                rec["signals"].append(one)
                q = choice.quote
                if not g.ok or q is None or q.ask is None:
                    continue
                ask: float = q.ask
                age = q.age_s(now)
                if age is not None:
                    self.quote_ages.append((now, age))
                nxt = setups.next_level(sig.side, sig.entry, nm.marks, sig.level.price)
                n = len(self.today()) + 1
                p = OptionPlan(f"{self.session}-O-{n}", self.session, root, q.contract.symbol, sig.side, sig.setup,
                               sig.level.name, sig.level.price, sig.invalidation, nxt.price if nxt else None,
                               chain.entry_limit(ask, float(self.cfg["order"]["entry_buffer_pct"]),
                                                 float(self.cfg["contract"]["max_ask"])),
                               ask, age, sig.bar_end)
                self.plans.append(p)
                tids[id(one)] = p.trade_id
                self.sending = p.trade_id
                try:
                    self.oms.enter(p)
                finally:
                    self.sending = ""
                self.write("entry_sent", trade_id=p.trade_id, symbol=p.symbol, setup=p.setup, side=p.side,
                           level=p.level, limit=p.limit, quoted_ask=p.quoted_ask, quote_age_s=age, state=p.state)
                if p.state == "rejected" and self.oms.refused is not None:   # the guard or the broker said no
                    why = dict(self.oms.refused)
                    by, code = why.pop("by"), why.pop("code")
                    one |= {"reason": code if by == "broker" else f"guard-{code}", "failed": [by], "why": why}
                    refused = True
                if p.state == "open":
                    self.on_fill(p)
                entered = True
            rec["action"] = ("entry-refused" if refused else "entered") if entered else \
                ("signal-refused" if sigs else "no-setup")
            if self.arms_cfg:
                queue.append(ArmsBar(rec, to_tag, tids, root, nm, two, tape, near, seen_quotes))
            else:
                self.decision(rec)

    def logged_refusal(self, *a: Any) -> dict[str, Any]:
        try:
            return self.refusal(*a)
        except Exception as e:  # noqa: BLE001 — the decision log must never cost a trade
            return {"log_fault": e.__class__.__name__}          # no `reason`: the review counts it unlogged

    def refusal(self, g: setups.Gates, sig: setups.Signal, nm: Name, choice: chain.Choice, chain_ok: bool,
                streak: int, last_loss: dt.datetime | None) -> dict[str, Any]:
        """The decision log's account of one signal: the contract it would have bought (its expiry and whether its
        greeks were modelled), and when refused, the first gate that refused it (REASON_ORDER) as a code, every gate
        that refused it, and the numbers against the first. Logging only: nothing here decides anything."""
        contract = chain.contract_detail(choice.quote) if choice.quote is not None else \
            {k: choice.miss[k] for k in ("expiry", "modelled", "delta")} if choice.miss is not None else \
            {"expiry": (nm.expiry or self.day).isoformat(), "modelled": None, "delta": None}
        out: dict[str, Any] = {"contract": contract, "reason": None, "failed": [], "why": {}}
        failed = [k for k in REASON_ORDER if k in g.checks and not g.checks[k][0]]
        failed += [k for k in g.failed if k not in failed]
        if not failed:
            return out
        first = failed[0]
        value = g.checks[first][1]
        gc = self.cfg["gates"]
        why: dict[str, Any] = {}
        code = REASON_CODE.get(first, first)
        if first == "latch":
            why = {"kind": value}
        elif first == "off":
            why = {"codes": sorted(self.off)}
        elif first == "open-position":
            why = {"open": sum(p.active for p in self.plans), "max": self.lim.max_open_positions}
        elif first == "loss-pause" and last_loss is not None:
            until = last_loss + dt.timedelta(minutes=float(self.cfg["day"]["loss_pause_min"]))
            why = {"losses": streak, "until": until.astimezone(NEW_YORK).strftime("%H:%M")}
        elif first == "cooldown" and nm.cooldown_until is not None:
            why = {"until": nm.cooldown_until.astimezone(NEW_YORK).strftime("%H:%M")}
        elif first == "stalled":
            why = {"max_s": float(self.cfg["feeds"]["bar_stall_s"])}
        elif first == "event":
            why = {"event": value}
        elif first == "trend":
            why = dict(value) if isinstance(value, Mapping) else {}
        elif first == "extension":
            why = {"atr": value, "max": float(gc["max_extension_atr"])}
        elif first == "room":
            why = {"multiple": value.get("multiple") if isinstance(value, Mapping) else None,
                   "min": float(gc["min_room_multiple"])}
        elif first == "reach":
            nxt = setups.next_level(sig.side, sig.entry, nm.marks, sig.level.price)
            why = {"distance": None if nxt is None else round(abs(nxt.price - sig.entry), 4), "remaining_move": value}
        elif first == "shock":
            why = {"word": value}
        elif first == "contract":
            if not chain_ok:
                code = "chain-unavailable"
            elif choice.miss is not None:
                code = str(choice.miss["reason"])
                why = {k: v for k, v in choice.miss.items() if k not in ("reason", "expiry", "modelled", "delta")}
                if code == "delta-below-floor":
                    why["delta"] = choice.miss.get("delta")
            else:
                code = next(iter(choice.reasons), "no-contract-of-the-expiry")
            why["candidates"] = sum(choice.reasons.values()) if choice.miss is not None else 0
        out |= {"reason": code, "failed": failed, "why": why}
        return out

    # ---- the research arms (DEC-0041) ----------------------------------------------------------
    # Each runs under `arms_guard`, after the control has managed and entered for the poll, reads what the control
    # already read where it can (fetching only what it lacks), and writes only to the shadow file or the `arms` key of
    # a decision line. A fault in an arm is written to the shadow file and costs the control nothing.
    def arms_guard(self, what: str, fn: Callable[..., Any], *args: Any) -> Any:
        try:
            return fn(*args)
        except Exception as e:  # noqa: BLE001 — a research arm must never cost a trade
            try:
                self.arms_write([{"ts": self.now().isoformat(), "event": "fault", "arm": what,
                                  "error": f"{e.__class__.__name__}: {str(e)[:120]}"}])
            except Exception:  # noqa: BLE001
                pass
            return None

    def arms_setup(self) -> None:
        """The arms' state, or none at all: a block that cannot be read is a fault, never a stopped runner."""
        ra = self.cfg.get("research_arms") or {}
        self.arms_cfg = {}
        self.shadow = None
        self.leader_cache = {}
        self.gap_logged = set()
        self.stamp = {}
        if not (isinstance(ra, Mapping) and ra.get("enabled") is True):
            return
        try:
            self.stamp = {"release": release_commit(), "config": control_config_hash(self.cfg)}
            for key in ("iv_cap_index", "iv_cap_single", "early_from", "early_before", "late_to"):
                ra["tags"][key]                                  # noqa: B018 (a missing key is a fault here)
            self.shadow = shadow.Shadow(self.session, ra, self.cfg["exits"], self.fee, self.ck.flatten)
            self.arms_cfg = ra
        except Exception as e:  # noqa: BLE001
            self.arms_cfg, self.shadow = {}, None
            try:
                self.arms_write([{"ts": self.now().isoformat(), "event": "fault", "arm": "setup",
                                  "error": f"{e.__class__.__name__}: {str(e)[:120]}"}], force=True)
            except Exception:  # noqa: BLE001
                pass

    def arms_path(self) -> Path:
        return self.state / "shadow" / f"{self.session}.jsonl"

    def arms_write(self, records: Sequence[Mapping[str, Any]], force: bool = False) -> None:
        """Append to the shadow file, each record stamped with the release and the control's config hash (DEC-0041
        points 5 and 6: an arm's window, and its end if EXP-0029's config changes)."""
        if not records or not (self.arms_cfg or force):
            return
        p = self.arms_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as fh:
            for r in records:
                fh.write(json.dumps({**r, **self.stamp}, default=str) + "\n")

    def arms_restore(self) -> None:
        if self.shadow is None or not self.arms_path().exists():
            return
        rows = []
        for line in self.arms_path().read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        self.shadow.restore(rows)

    def arms_levels(self, root: str, daily: Sequence[lv.Bar]) -> None:
        """The DEC-0041 level codes known before the open, kept on the name for the tags and the shadow file. The
        overnight fetch has its own guard: without it the codes from the daily bars still stand."""
        prev = dt.date.fromisoformat(lv.prev_session(self.session))
        overnight = None
        try:
            start = dt.datetime.combine(prev, dt.time(16, 0), NEW_YORK)
            rows = self.feeds.minutes([root], start, min(self.now(), self.ck.open)).get(root, [])
            overnight = session.overnight_range(rows, self.day, prev)
        except Exception as e:  # noqa: BLE001
            self.arms_write([{"ts": self.now().isoformat(), "event": "fault", "arm": "overnight", "root": root,
                              "error": e.__class__.__name__}])
        events = [str(e.get("date")) for e in self.macro if str(e.get("severity", "")) == "high"]
        self.names[root].research = session.research_levels(daily, self.session, events, overnight)

    def arms_gap(self, root: str, nm: Name, two: Sequence[regime.Bar]) -> None:
        """GAPH / GAPL once the session's first bar has given the open; written once per name."""
        if root in self.gap_logged or not two:
            return
        self.gap_logged.add(root)
        by = {m.name: m.price for m in nm.marks}
        if "PDH" not in by or "PDL" not in by:
            return
        gap = lv.gap_levels(two[0].o, by["PDH"], by["PDL"])
        nm.research.update(gap)
        self.arms_write([{"ts": self.now().isoformat(), "event": "levels", "root": root, "open": two[0].o,
                          "gap": gap}])

    def arms_runner(self, p: OptionPlan) -> None:
        assert self.shadow is not None and p.fill is not None
        self.arms_write(self.shadow.open_runner(p.trade_id, p.root, p.symbol, p.side, p.setup, p.level, p.level_price,
                                                p.invalidation, p.next_level, p.signal_bar, p.fill, p.filled_at,
                                                self.now()))

    def arms_control_closed(self, p: OptionPlan) -> None:
        assert self.shadow is not None
        self.arms_write(self.shadow.control_closed(p.trade_id, p.exit_reason, p.exit_fill, self.now()))

    def leader_tape(self, leader: str, bar_end: dt.datetime) -> regime.Tape | None:
        """The leader's tape (SMH for QQQ) at the close of the bar ending `bar_end`, read with the clone's numbers."""
        key = (leader, bar_end.isoformat())
        if key not in self.leader_cache:
            rows = self.feeds.minutes([leader], self.ck.open, bar_end).get(leader, [])
            two = [x for x in regime.resample(regime.minute_bars(rows, self.day), int(self.cfg["bars"]["minutes"]),
                                              bar_end) if x.end <= bar_end]
            b = self.cfg["bars"]
            t = regime.read(two, int(b["atr_period"]), int(b["ema_fast"]), int(b["ema_slow"]),
                            float(self.cfg["gates"]["shock_bar_atr"]))
            self.leader_cache[key] = t if two and two[-1].end == bar_end else None
        return self.leader_cache[key]

    def arms_flush(self, queue: Sequence[ArmsBar], now: dt.datetime, tapes: Mapping[str, regime.Tape],
                   late: bool) -> None:
        """After the control's last order of the poll: each queued line gets its tags and is written, in the order
        the control made them; then the gap codes and the trap and fast-reclaim signals of each bar."""
        for b in queue:
            if b.nm is not None and b.tape is not None:
                for one, sig, choice in b.to_tag:
                    tags = self.arms_guard("tags", self.arms_tags, sig, b.two, b.nm, b.tape, choice, b.root,
                                           b.tids.get(id(one)))
                    one["arms"] = tags if tags is not None else {"fault": True, **self.stamp}
            self.decision(b.rec)
        for b in queue:
            if b.nm is None or b.tape is None:
                continue
            self.arms_guard("gap", self.arms_gap, b.root, b.nm, b.two)
            if self.shadow is not None:
                self.arms_guard("signals", self.arms_signals, now, b, tapes, late)

    def arms_tags(self, sig: setups.Signal, two: Sequence[regime.Bar], nm: Name, tape: regime.Tape,
                  choice: chain.Choice, root: str, trade_id: str | None) -> dict[str, Any]:
        tc = self.arms_cfg["tags"]
        leaders = {str(k): str(v) for k, v in (tc.get("leaders") or {}).items()}
        lead, lead_fault = None, None
        if root in leaders:
            try:
                lead = self.leader_tape(leaders[root], two[-1].end)
            except Exception as e:  # noqa: BLE001 — no leader tape: that tag alone is unknown (HYP-0038)
                lead_fault = e.__class__.__name__
        sw = (nm.research["SWH"], nm.research["SWL"]) if "SWH" in nm.research and "SWL" in nm.research else None
        q = choice.quote
        out = setups.tag_decision(sig, two, nm.marks, root=root, word=tape.word, five=sw, leader=lead,
                                  leader_names=list(leaders), iv=None if q is None else q.iv,
                                  iv_modelled=None if q is None else q.modelled, half_day=self.ck.half_day,
                                  cfg={**tc, "index_names": self.cfg["contract"]["index_names"]})
        if lead_fault:
            out["leader_fault"] = lead_fault
        return {**out, "trade_id": trade_id, **self.stamp}

    def arms_signals(self, now: dt.datetime, b: ArmsBar, tapes: Mapping[str, regime.Tape], late: bool) -> None:
        """The trap and fast-reclaim signals of one bar, gated as the control gates its own (setups.gate, the event
        blocks, the contract), but never the account's latches, pauses or position count (HYP-0046/47). The chain
        is the one the control read on this bar when it read one."""
        sh, nm, tape, root = self.shadow, b.nm, b.tape, b.root
        assert sh is not None and nm is not None and tape is not None and tape.atr is not None
        arms = self.arms_cfg["shadow"]
        sigs = setups.trap(b.two, b.near, arms["trap"]) + \
            setups.reclaim_fast(b.two, b.near, tape.atr, arms["reclaim_fast"])
        sigs = [x for x in sigs if x.setup in sh.enabled]
        fresh = [x for x in sigs if shadow.vid_of(self.session, x.setup, root, x.bar_end, x.side, x.level.name)
                 not in sh.seen]                                   # a restart sees the same bar again
        if not fresh:
            return
        quotes, chain_ok = b.quotes, True
        if quotes is None:
            try:
                raw = self.feeds.chain(root, nm.expiry or self.day)
                quotes = chain.with_model(chain.parse_snapshots(raw), tape.close, now)
            except Exception:  # noqa: BLE001
                quotes, chain_ok = [], False
        event = session.event_block(now, root, self.macro, self.earnings, self.cfg["gates"],
                                    self.cfg["contract"]["index_names"])
        out: list[dict[str, Any]] = []
        for sig in fresh:
            if not chain_ok:
                out += sh.signal(sig.setup, self.arms_virtual(sig, root, nm, "", None), False, {"entry": sig.entry}, now,
                                 refuse="chain-unavailable")
                continue
            atm = min((q for q in quotes if q.contract.side == sig.side and q.iv),
                      key=lambda q: abs(q.contract.strike - tape.close), default=None)
            g = setups.gate(sig, tape, tapes.get("SPY"), nm.marks,
                            session.remaining_move(tape.close, atm.iv if atm else None, now, self.ck),
                            self.cfg["gates"])
            if event:
                g.add("event", False, event)
            choice = chain.pick(quotes, root, sig.side, nm.expiry or self.day, tape.close, now,
                                {**self.cfg["contract"], "quote_stale_flat_s": self.cfg["feeds"]["quote_stale_flat_s"]},
                                nm.oi, self.account_holds, late)
            g.add("contract", choice.quote is not None, choice.reasons)
            q = choice.quote
            limit = None if q is None or q.ask is None else chain.entry_limit(
                q.ask, float(self.cfg["order"]["entry_buffer_pct"]), float(self.cfg["contract"]["max_ask"]))
            out += sh.signal(sig.setup, self.arms_virtual(sig, root, nm, q.contract.symbol if q is not None else "",
                                                          limit), g.ok,
                             {"gates": g.as_json(), "entry": sig.entry, "quoted_ask": None if q is None else q.ask}, now)
        self.arms_write(out)

    def arms_virtual(self, sig: setups.Signal, root: str, nm: Name, symbol: str,
                     limit: float | None) -> shadow.Virtual:
        """A trap or reclaim signal as a virtual entry: the control's next level, and its entry deadline (the end of
        the next 2-minute bar)."""
        nxt = setups.next_level(sig.side, sig.entry, nm.marks, sig.level.price)
        h, m = (int(x) for x in sig.bar_end.split(":"))
        ttl = int(self.cfg["order"]["entry_ttl_bars"]) * int(self.cfg["bars"]["minutes"])
        deadline = dt.datetime.combine(self.day, dt.time(h, m), NEW_YORK) + dt.timedelta(minutes=ttl)
        return shadow.Virtual(sig.setup, shadow.vid_of(self.session, sig.setup, root, sig.bar_end, sig.side,
                                                       sig.level.name), root, symbol, sig.side, sig.setup,
                              sig.level.name, sig.level.price, sig.invalidation, nxt.price if nxt else None,
                              sig.bar_end, limit=limit, deadline=deadline.isoformat())

    def arms_step(self, now: dt.datetime, bars: Mapping[str, list[regime.Bar]],
                  tapes: Mapping[str, regime.Tape]) -> None:
        """The virtual book after the poll. A runner on the contract the control holds reuses the quote bid `manage`
        read this poll, only when that bid came from a fresh quote (never a broker mark or an older bid); every other
        contract is quoted here. A contract with no fresh quote has no bid this poll: no breakeven, no stop."""
        sh = self.shadow
        assert sh is not None
        stale = float(self.cfg["feeds"]["quote_stale_flat_s"])
        quotes: dict[str, tuple[float | None, float | None]] = {}
        need: list[str] = []
        for v in sh.trades:
            if v.state not in ("pending", "open"):
                continue
            seen = self.quote_bid.get(v.symbol)
            if v.state == "open" and seen is not None and seen[2] == now and seen[1] <= stale:
                quotes[v.symbol] = (seen[0], None)
            else:
                need.append(v.symbol)
        if need:
            for q in chain.parse_snapshots(self.feeds.quotes(sorted(set(need)))):
                age = q.age_s(now)
                if age is not None and age <= stale:
                    quotes[q.contract.symbol] = (q.bid, q.ask)
        self.arms_write(sh.step(now, quotes, bars, tapes))

    # ---- the dashboard -----------------------------------------------------------------------
    def publish(self, final: bool = False) -> None:
        """Hand the clone's document (stocksdelta/options-clone) to the publisher. Never raises; a document that
        cannot be built or fails the site's schema is journaled once per kind of fault and not sent."""
        if self.publisher is None:
            return
        now = self.now()
        try:
            doc = clone_site.build(self, now, f"options-clone-{self.session}-{now.astimezone(dt.UTC):%H%M%S%f}", final)
            bad = clone_site.validate(doc)
            if bad:
                raise ValueError(bad[0].split(":")[0] or "doc")
            self.publisher.post(clone_site.body(doc))
        except Exception as e:  # noqa: BLE001 — the dashboard must never cost a trade
            fault = f"{e.__class__.__name__}: {str(e)[:60]}"
            if fault != self.doc_fault:
                self.doc_fault = fault
                self.write("clone_doc_unsent", error=fault)

    # ---- the session -------------------------------------------------------------------------
    def done(self) -> bool:
        now = self.now()
        return now >= self.ck.close + dt.timedelta(minutes=5) or (
            now >= self.ck.verify_flat and not any(p.active for p in self.plans))


def load_events() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    import csv

    def rows(path: Path) -> list[dict[str, Any]]:
        try:
            with open(path) as fh:
                return list(csv.DictReader(line for line in fh if not line.startswith("#")))
        except OSError:
            return []
    return rows(CONFIG_DIR / "events" / "macro_events.csv"), rows(CONFIG_DIR / "events" / "earnings.csv")


def run(day: dt.date | None = None) -> int:
    """The production session. Exits 0 on a day with no session; non-zero only when it could not run."""
    from wt.brokers.alpaca_options_paper import AlpacaOptionsPaperBroker, keys
    if env("MODE", "backtest") != "paper":
        raise SystemExit("runner_o refuses to start: MODE must be 'paper'")
    now = dt.datetime.now(NEW_YORK)
    day = day or now.date()
    if not lv.is_session(day.isoformat()):
        write("no_session", session=day.isoformat())
        return 0
    k = keys()
    if k is None:
        write("not_configured")
        print("options clone: no paper account keys; nothing to do")
        return 0
    cfg = load_yaml("options_clone.yaml")
    lim = Limits.from_risk(load_yaml("risk.yaml"))
    pager = Pager(Alerts() if str(cfg.get("alerts")) == "phone" else None)
    with locks.job_lock(LOCK, wait_s=10.0) as got:
        if not got:
            print("another options clone runner holds the lock", file=sys.stderr)
            return 3
        arm_at = dt.datetime.combine(day, ARM_AT, NEW_YORK)
        while (left := (arm_at - dt.datetime.now(NEW_YORK)).total_seconds()) > 0:
            time.sleep(min(60.0, left))
        broker = None
        for attempt in range(CONNECT_TRIES):
            try:
                broker = AlpacaOptionsPaperBroker(k[0], k[1], k[2])
                break
            except Exception as e:  # noqa: BLE001 — the paper lock re-raises below
                from wt.core.safety import PaperOnlyError
                if isinstance(e, PaperOnlyError):
                    raise
                write("broker_connect_failed", attempt=attempt + 1, error=e.__class__.__name__)
                time.sleep(CONNECT_WAIT_S)
        if broker is None:
            pager.fire("options-clone:broker", "Options clone could not connect", "Five tries failed.", 5)
            pager.close()
            return 2
        macro, earnings = load_events()
        r = Runner(day, cfg, lim, AlpacaFeeds(k[0], k[1], "opra" if (OPT / "switches" / "opra").exists()
                                              else str(cfg["feeds"]["option"])),
                   broker, lambda: dt.datetime.now(NEW_YORK), time.sleep, pager, macro=macro, earnings=earnings,
                   exits_only="exits-only launch" if env("WT_EXITS_ONLY", "") == "1" else None,
                   publisher=clone_site.publisher_from_env())
        r.arm()
        poll = float(cfg["feeds"]["poll_s"])
        while not r.done():
            started = time.monotonic()
            try:
                r.step()
            except Exception as e:  # noqa: BLE001 — one bad poll must never end a session holding a position
                write("loop_error", error=f"{e.__class__.__name__}: {str(e)[:160]}")
            time.sleep(max(0.5, poll - (time.monotonic() - started)))
        day_pnl, _, _ = r.pnl_view()
        write("session_end", trades=sum(p.fill is not None for p in r.today()), day=round(day_pnl, 2),
              open=[p.trade_id for p in r.plans if p.active])
        r.publish(final=True)
        if r.publisher is not None:
            r.publisher.close(30.0)
            write("clone_doc", sent=r.publisher.sent, failed=r.publisher.failed, last=r.publisher.last)
        hc.ping_async("wt-paper-o-armed", "", "session end")
        pager.close()
    return 0


def reset_latch(kind: str, reason: str) -> int:
    """OWNER: remove a loss latch (make reset-options-latch KIND=week REASON="..."). Refused while a session runs."""
    if locks.is_held(LOCK):
        print("refused: the options clone is running; reset the latch after the close", file=sys.stderr)
        return 1
    p = OPT / "latches" / kind
    if kind not in ("day", "week", "drawdown") or not reason.strip():
        print("usage: reset-latch day|week|drawdown REASON", file=sys.stderr)
        return 2
    if not p.exists():
        print(f"no {kind} latch")
        return 0
    p.unlink()
    write("latch_reset", kind=kind, reason=reason[:200])
    print(f"{kind} latch removed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "reset-latch":
        raise SystemExit(reset_latch(sys.argv[2] if len(sys.argv) > 2 else "", " ".join(sys.argv[3:])))
    raise SystemExit(run())
