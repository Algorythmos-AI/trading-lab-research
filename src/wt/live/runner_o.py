"""The options clone's paper runner (DEC-0030): one same-day call or put at a time, by the owner's nine rules.

    python -m wt.live.runner_o          (the job `paper-o` starts it; MODE must be `paper`)

One session, from arm (09:25 New York) to the close. Every 10 seconds it reads the account, the stock bars and the
quotes of what it holds; it manages an open trade first and looks for an entry only on a 2-minute bar that has
just finished. Its own checks run while it trades: a failed check narrows what it may do (no new entries, exits
only, flatten) and pages, and never waits for an answer.

Records: the hash-chained journal `data/live/options_journal.jsonl` (arm, orders, fills, exits, trades, latches,
feed checks, pages) and one decision line per name per finished bar in `var/options/decisions/<date>.jsonl`.
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
from wt.oms.options import OptionPlan, OptionsOMS, PlanStore, book
from wt.ops import hc, locks
from wt.ops.alerts import Alerts, Pager
from wt.options import chain, regime, session, setups
from wt.options import levels as lv
from wt.options.intraday import daily_raw
from wt.options.regime import NEW_YORK
from wt.risk.options_guard import Context, Latches, Limits, week_key

OPT = STATE_DIR / "options"
JOURNAL = DATA_DIR / "live" / "options_journal.jsonl"
KILLS = (ROOT / "KILL", OPT / "KILL")
LOCK = "paper-o-runner"
ARM_AT = dt.time(9, 25)
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
    def contracts(self, root: str, expiry: dt.date) -> dict[str, float]: ...
    def focus(self) -> tuple[Mapping[str, Any] | None, str | None]: ...


class AlpacaFeeds:
    """The broker's market data, GET only, with the trading account's key pair. Stock bars from IEX (real time on
    the free plan); option quotes from the configured feed (`indicative` free, `opra` with a subscription)."""

    def __init__(self, key_id: str, secret: str, option_feed: str, session_: requests.Session | None = None) -> None:
        self.s = session_ or requests.Session()
        self.h = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
        self.feed = option_feed

    def _get(self, url: str, params: dict[str, str]) -> Any:
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

    def contracts(self, root: str, expiry: dt.date) -> dict[str, float]:
        p = {"underlying_symbols": root, "expiration_date": expiry.isoformat(), "status": "active", "limit": "10000"}
        rows = self._paged(f"{PAPER_HOST}/v2/options/contracts", p, "option_contracts", pages=4)
        out: dict[str, float] = {}
        for r in rows if isinstance(rows, list) else []:
            try:
                out[str(r["symbol"])] = float(r.get("open_interest") or 0)
            except (KeyError, TypeError, ValueError):
                continue
        return out

    def focus(self) -> tuple[Mapping[str, Any] | None, str | None]:
        return None, None                       # the dashboard's focus route arrives with the next pull request


# ---------------------------------------------------------------- the runner
@dataclass
class Name:
    root: str
    marks: list[setups.Mark]
    oi: dict[str, float]
    last_bar: str = ""                          # the end (HH:MM) of the last finished bar looked at
    cooldown_until: dt.datetime | None = None


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

    def __post_init__(self) -> None:
        self.session = self.day.isoformat()
        self.ck = session.clock(self.session, self.cfg["day"])
        self.store = PlanStore(self.state / "plans")
        self.latches = Latches(self.state / "latches")
        self.fee = float(self.cfg["costs"]["fee_per_contract_each_way"])
        self.oms = OptionsOMS(self.broker, self.store, self.lim, self.context, self.now, self.sleep)

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
            self.page("plans-unreadable", "Options clone: plan files unreadable", e.__class__.__name__, 5)
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
                      f"Options level {level}; buying calls and puts needs 2.", 5)
        try:
            rep = self.oms.reconcile(self.plans)
            self.account_holds = {x.symbol for x in self.broker.positions() if x.qty}
        except TransportError as e:
            self.off["broker"] = "broker unreachable at arm"
            self.page("broker", "Options clone: broker unreachable at arm", str(e)[:80], 4)
            return False
        own = getattr(self.broker, "own_account", False)
        stock = [s for s in self.account_holds if chain.parse_occ(s) is None]
        if stock or (own and rep["unknown_positions"]):
            self.off["position-at-arm"] = "a position no plan knows"
            self.page("flatten-required", "Options clone: a position no plan knows",
                      "Entries are off today. See docs/runbooks/options-clone.md.", 5)
        self.prepare()
        self.write("armed", session=self.session, names=sorted(self.names), off=sorted(self.off),
                   own_account=own, options_level=level, plans_open=[p.trade_id for p in self.plans if p.active],
                   orders=self.cfg.get("orders"), feed=self.cfg["feeds"]["option"])
        hc.ping_async("wt-paper-o-armed", "", f"names {len(self.names)}")
        return not self.off

    def prepare(self) -> None:
        focus, edition = self.feeds.focus()
        cfg_n = self.cfg["names"]
        wanted, source = session.names(focus, edition, self.session, cfg_n["fallback"], int(cfg_n["max_names"]))
        start = dt.datetime.combine(self.day - dt.timedelta(days=420), dt.time(0), dt.UTC)
        end = dt.datetime.combine(self.day, dt.time(0), dt.UTC) - dt.timedelta(seconds=1)
        try:
            daily = self.feeds.daily(wanted, start, end)
            pre_start = dt.datetime.combine(self.day, dt.time(4, 0), NEW_YORK)
            pre = self.feeds.minutes(wanted, pre_start, min(self.now(), self.ck.open))
        except (TransportError, requests.RequestException) as e:
            self.off["levels"] = "levels unavailable"
            self.page("levels", "Options clone: no levels today", e.__class__.__name__, 4)
            return
        dropped: dict[str, str] = {}
        for root in wanted:
            try:
                if cfg_n.get("same_day_expiry_only", True):
                    oi = self.feeds.contracts(root, self.day)
                    if not oi:
                        dropped[root] = "no same-day expiry"
                        continue
                loaded = lv.load_ibkr(daily_raw([b for b in daily.get(root, []) if isinstance(b, dict)]))
                if loaded.problems or not loaded.bars:
                    dropped[root] = "daily bars"
                    continue
                levels = lv.levels_for(loaded.bars, self.session)
                pm = session.premarket_range(pre.get(root, []), self.day) if self.cfg["levels"].get("premarket") else None
                marks = session.marks(levels, self.cfg["levels"]["names"], self.cfg["levels"]["strong"], pm)
                self.names[root] = Name(root, marks, oi)
            except (ValueError, TypeError, KeyError, TransportError, requests.RequestException) as e:
                dropped[root] = e.__class__.__name__
        self.write("names", source=source, names=sorted(self.names), dropped=dropped)
        if not self.names:
            self.off["names"] = "no name to trade"

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
                                    f"The {latched} loss latch is on; no new entries.", 4)
        if now >= self.ck.verify_flat and not self.verified:
            self.verify(now)
        if now >= self.ck.critical:
            held = [p for p in self.plans if p.state in ("open", "exiting")]
            if held:
                self.critical(f"{len(held)} position still open at {self.ck.critical:%H:%M}")
        if self.ck.first_entry <= now <= self.ck.last_entry:
            self.look_for_entries(now, bars, tapes, stalled)

    def critical(self, why: str) -> None:
        if not self.paged_critical:
            self.paged_critical = True
            self.page("flatten-required", "Options clone: FLATTEN REQUIRED", why + ". Close it by hand in Alpaca.", 5)

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
            two = regime.resample(ms, int(b["minutes"]), now)
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
                        f"{p.root} {p.side}, {p.setup} at {p.level}", 3)
        if p.fill is not None and p.fill > float(self.cfg["contract"]["max_ask"]) + 1e-9:
            self.off["fill-over-cap"] = "a fill above the premium cap"
            self.exit(p, "operational", self.now())
        self.check_feed_fit()

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
                      f"{p.root} {p.side}: {len(tries)} tries since {tries[0]:%H:%M:%S}.", 4)

    def finish(self, p: OptionPlan) -> None:
        if p.state == "unresolved":
            self.page("lot-taken-by-hand", "Options clone: a lot was sold by hand",
                      f"{p.root}: the account holds less than the clone bought. Booked as unresolved.", 4)
        if book(p, self.journaled, self.write, self.fee):
            p.recorded = True
            self.store.save(p)
        rop = p.return_on_premium(self.fee)
        self.pager.fire(f"options-clone:exit-{p.trade_id}", "Options clone exited",
                        f"{p.root} {p.side}: {p.exit_reason}" + ("" if rop is None else f", {rop:+.0%} on premium"), 3)
        if p.state == "closed" and (p.pnl(self.fee) or 0.0) < 0 and p.root in self.names:
            self.names[p.root].cooldown_until = self.now() + dt.timedelta(
                minutes=float(self.cfg["day"]["name_cooldown_after_loss_min"]))

    def verify(self, now: dt.datetime) -> None:
        self.verified = True
        own = {p.symbol for p in self.plans if p.state in ("open", "exiting", "entering")}
        held = own & self.account_holds
        self.write("verify_flat", flat=not own, own_open=sorted(own), held=sorted(held))
        if own:
            self.page("not-flat", "Options clone NOT FLAT", f"{len(own)} open at {now:%H:%M}; retrying.", 5)

    def check_feed_fit(self) -> None:
        now = self.now()
        recent = [a for t, a in self.quote_ages if now - t <= dt.timedelta(minutes=10)]
        slips = [(p.fill - p.quoted_ask) / p.quoted_ask * 100 for p in self.today()
                 if p.fill is not None and p.quoted_ask][-10:]
        f = self.cfg["feeds"]
        why = None
        if len(recent) >= 5 and statistics.median(recent) > float(f["unfit_median_quote_age_s"]):
            why = f"median quote age {statistics.median(recent):.1f}s"
        elif len(slips) >= 3 and statistics.median(slips) > float(f["unfit_median_slippage_pct"]):
            why = f"median entry slippage {statistics.median(slips):.1f}%"
        if why and "feed" not in self.off:
            self.off["feed"] = "feed-unfit"
            self.write("feed_unfit", why=why)
            self.pager.once_per_day("options-clone:feed-unfit", "Options clone: feed unfit, entries off", why, 4)

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
        for root, nm in sorted(self.names.items()):
            two = bars.get(root, [])
            if not two or two[-1].end.strftime("%H:%M") == nm.last_bar:
                continue
            nm.last_bar = two[-1].end.strftime("%H:%M")
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
                self.decision(rec)
                continue
            near = setups.near_level(tape.close, nm.marks, tape.atr, float(self.cfg["levels"]["tolerance_atr"]))
            sigs = setups.retest(two, near, tape.atr, self.cfg["setups"]["retest"]) + \
                setups.rejection(two, near, self.cfg["setups"]["rejection"])
            rec["signals"] = []
            entered = False
            acted = {(q.root, q.signal_bar, q.setup, q.side) for q in self.today()}
            for sig in sigs:
                if entered:
                    break
                if (root, sig.bar_end, sig.setup, sig.side) in acted:      # a restart sees the same bar again
                    rec.setdefault("signals", []).append({"setup": sig.setup, "side": sig.side, "already": True})
                    continue
                iv = None
                try:
                    raw = self.feeds.chain(root, self.day)
                    quotes = chain.parse_snapshots(raw)
                    atm = min((q for q in quotes if q.contract.side == sig.side and q.iv),
                              key=lambda q: abs(q.contract.strike - tape.close), default=None)
                    iv = atm.iv if atm else None
                except (TransportError, requests.RequestException):
                    quotes = []
                g = setups.gate(sig, tape, tapes.get("SPY"), nm.marks,
                                session.remaining_move(tape.close, iv, now, self.ck), self.cfg["gates"])
                for k, v in blocks.items():
                    g.add(k, False, v)
                choice = chain.pick(quotes, root, sig.side, self.day, tape.close, now,
                                    {**self.cfg["contract"], "quote_stale_flat_s": self.cfg["feeds"]["quote_stale_flat_s"]},
                                    nm.oi, self.account_holds, late)
                g.add("contract", choice.quote is not None, choice.reasons)
                rec["signals"].append({"setup": sig.setup, "side": sig.side, "level": sig.level.name,
                                       "entry": sig.entry, "gates": g.as_json()})
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
                self.sending = p.trade_id
                try:
                    self.oms.enter(p)
                finally:
                    self.sending = ""
                self.write("entry_sent", trade_id=p.trade_id, symbol=p.symbol, setup=p.setup, side=p.side,
                           level=p.level, limit=p.limit, quoted_ask=p.quoted_ask, quote_age_s=age, state=p.state)
                if p.state == "open":
                    self.on_fill(p)
                entered = True
            rec["action"] = "entered" if entered else ("signal-refused" if sigs else "no-setup")
            self.decision(rec)

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
                   exits_only="exits-only launch" if env("WT_EXITS_ONLY", "") == "1" else None)
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
