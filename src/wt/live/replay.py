"""Session replay: drive a paper runner's real loop from recorded market data, with fills taken from the bars.

Three pieces, each a test double for one thing a live session reads or talks to:

  ReplayClock    `now` and `sleep` for the runner; each sleep moves time forward and tells the broker which minute
                 bars have closed since.
  ReplayREST     the market-data client. It serves the recorded 1-minute bars and quotes "as of now": a bar is
                 visible once its minute has ended, a quote once its timestamp has passed. Nothing later leaks.
  BarFillBroker  a SimBroker whose resting orders fill from each closed bar by the backtest engine's rules
                 (wt.backtest.engine.simulate), so a replayed session and a simulated trade can be compared.

Fill rules (prices before slippage; `slip` is per share, against the order):
  buy stop-limit    triggers when bar.high >= stop. A bar that opens above the limit does not fill (the collar); a
                    triggered order then rests as a limit and fills when a later bar trades at or under it.
                    Fill = min(max(stop, open) + slip, limit).
  sell stop         fills when bar.low <= stop, at min(stop, open) - slip. On the bar its entry filled, a stop at or
                    above that bar's low fills at stop - slip (the engine's "stop first" on the entry bar).
  sell limit        fills when bar.high >= limit ("touch") or >= limit + tick ("through"), at max(limit, open).
  buy limit         fills when bar.low <= limit, at min(limit, open).
  market            fills at the open of the first bar after it was placed, +/- slip.
An order is eligible from the bar in progress when it was placed. A buy fills at most `volume_frac` of the bar's
volume; the rest keeps working.

Marketable orders do not wait for a bar when the tape has a quote no older than `quote_fill_age_s`: a market sell,
or a sell limit at or under the bid, fills at once at the bid (less slippage for a market order); a market buy, or a
buy limit at or over the ask, fills at the ask. That is what a broker does with them, and a runner that waits ten
seconds for its exit would otherwise never see one fill. With no fresh quote the bar rules above apply.

Nothing here imports a real broker or sends a request: it is for tests and for replays of recorded sessions.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from wt.brokers.base import BrokerClock
from wt.brokers.sim import SimBroker
from wt.core.clock import ET
from wt.core.types import Order
from wt.data.feeds import require_feed

MINUTE = dt.timedelta(minutes=1)
TARGET_FILLS = ("touch", "through")


def _utc(t: Any) -> pd.Timestamp:
    ts = pd.Timestamp(t)
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


@dataclass
class Tape:
    """One or more sessions of recorded data. bars[symbol]: columns t (bar start, UTC), o, h, l, c, v, one row per
    minute that printed. quotes[symbol]: columns t (UTC), bp, ap; optional."""
    bars: dict[str, pd.DataFrame]
    quotes: dict[str, pd.DataFrame] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for book in (self.bars, self.quotes):
            for sym, df in list(book.items()):
                d = df.copy()
                d["t"] = pd.to_datetime(d["t"], utc=True)
                d = d.sort_values("t").drop_duplicates("t").reset_index(drop=True)
                book[sym] = d

    def closed_bars(self, symbol: str, start: Any, now: Any) -> pd.DataFrame:
        """Bars that started at or after `start` and whose minute has ended by `now`."""
        df = self.bars.get(symbol)
        if df is None or not len(df):
            return pd.DataFrame(columns=["t", "o", "h", "l", "c", "v"])
        s, n = _utc(start), _utc(now)
        return df[(df.t >= s) & (df.t + MINUTE <= n)].reset_index(drop=True)

    def quote_at(self, symbol: str, now: Any) -> tuple[float, float, pd.Timestamp] | None:
        """The last recorded quote at or before `now`, or None (no recorded quote is no quote: never made up)."""
        df = self.quotes.get(symbol)
        if df is None or not len(df):
            return None
        seen = df[df.t <= _utc(now)]
        if not len(seen):
            return None
        q = seen.iloc[-1]
        return float(q.bp), float(q.ap), pd.Timestamp(q.t)


class ReplayClock:
    """`now` and `sleep` for a runner. Each sleep advances time (at least half a second, so a zero sleep cannot
    spin for ever) and then runs the hooks with the new time: the broker's bar fills first, then any test hook."""

    def __init__(self, start: dt.datetime, crash_at: dt.datetime | None = None) -> None:
        if start.tzinfo is None:
            raise ValueError("the replay clock needs a timezone-aware start")
        self.t = start
        self.crash_at = crash_at
        self.hooks: list[Callable[[dt.datetime], None]] = []

    def now(self) -> dt.datetime:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += dt.timedelta(seconds=max(float(seconds), 0.5))
        if self.crash_at is not None and self.t >= self.crash_at:
            raise ReplayCrash(f"replayed crash at {self.t.isoformat()}")
        for hook in self.hooks:
            hook(self.t)


class ReplayCrash(BaseException):
    """The replayed process dies here. A BaseException, so a runner's `except Exception` cannot swallow it."""


class ReplayREST:
    """The slice of wt.data.alpaca.AlpacaREST a paper runner uses, answered from a Tape as of the clock.

    `sessions` maps each date to its (open, close) wall times in New York, e.g. {date: ("09:30", "16:00")}; a half
    day carries its early close. Every stock-data request must name its feed, as the real client requires."""

    def __init__(self, clock: ReplayClock, tape: Tape, sessions: Mapping[dt.date, tuple[str, str]]) -> None:
        self.clock, self.tape, self.sessions = clock, tape, dict(sessions)
        self.calls: list[str] = []

    def calendar(self, start: str, end: str) -> pd.DataFrame:
        s, e = dt.date.fromisoformat(str(start)[:10]), dt.date.fromisoformat(str(end)[:10])
        days = [d for d in sorted(self.sessions) if s <= d <= e]
        return pd.DataFrame({"date": days, "open": [self.sessions[d][0] for d in days],
                             "close": [self.sessions[d][1] for d in days]})

    def assets(self, status: str) -> list[dict[str, Any]]:
        """Every symbol on the tape, as an active tradable asset."""
        return [{"symbol": s, "tradable": True, "status": status} for s in sorted(self.tape.bars)]

    def bars(self, symbols: list[str] | str, tf: str, start: Any, end: Any, feed: str | None = None,
             adjustment: str = "raw") -> pd.DataFrame:
        """Historical bars for a closed window (the prior sessions a runner reads at arming). Never past the clock.
        "1Day" bars are the tape's regular-session minutes summed by day, for whole sessions before today only: a
        day that is still trading has no daily bar here. The tape is on one share basis, so `adjustment` is accepted
        and changes nothing."""
        if tf not in ("1Min", "1Day"):
            raise ValueError(f"the replay tape holds 1-minute bars only, not {tf!r}")
        require_feed("https://data.alpaca.markets/v2/stocks/bars", {"feed": feed} if feed else {})
        syms = [symbols] if isinstance(symbols, str) else list(symbols)
        until = min(_utc(end) + MINUTE, _utc(self.clock.now()))
        out = []
        for sym in syms:
            df = self.tape.closed_bars(sym, start, until)
            if tf == "1Day":
                df = self._daily(df)
            if len(syms) > 1:
                df = df.assign(symbol=sym)
            out.append(df)
        return pd.concat(out, ignore_index=True) if out else pd.DataFrame()

    def _daily(self, minutes: pd.DataFrame) -> pd.DataFrame:
        today = self.clock.now().astimezone(ET).date()
        rows = []
        if len(minutes):
            local = minutes.t.dt.tz_convert(ET)
            for day, g in minutes.groupby(local.dt.date):
                o, c = self._bounds(day) if day in self.sessions else (None, None)
                if o is None or day >= today:
                    continue
                g = g[(g.t >= _utc(o)) & (g.t < _utc(c))]
                if len(g):
                    rows.append({"t": _utc(dt.datetime.combine(day, dt.time(0), tzinfo=ET)), "o": float(g.o.iloc[0]),
                                 "h": float(g.h.max()), "l": float(g.l.min()), "c": float(g.c.iloc[-1]),
                                 "v": float(g.v.sum())})
        return pd.DataFrame(rows, columns=["t", "o", "h", "l", "c", "v"])

    def _bounds(self, day: dt.date) -> tuple[dt.datetime, dt.datetime]:
        o, c = self.sessions[day]
        return (dt.datetime.combine(day, dt.time.fromisoformat(o), tzinfo=ET),
                dt.datetime.combine(day, dt.time.fromisoformat(c), tzinfo=ET))

    def _snapshot(self, sym: str, now: dt.datetime) -> dict[str, Any] | None:
        """What the feed's snapshot would say at `now`, from bars whose minute has ended: today's session so far as
        the daily bar, and the last closed bar's close as the last trade. Before the first closed bar of the day
        there is no bar of today, and the symbol is left out (the real feed shows the previous day's bar then)."""
        day = now.astimezone(ET).date()
        if day not in self.sessions:
            return None
        o, c = self._bounds(day)
        df = self.tape.closed_bars(sym, o, min(_utc(now), _utc(c)))
        if not len(df):
            return None
        last = df.iloc[-1]
        return {"dailyBar": {"t": _utc(dt.datetime.combine(day, dt.time(0), tzinfo=ET)).isoformat(),
                             "o": float(df.o.iloc[0]), "h": float(df.h.max()), "l": float(df.l.min()),
                             "c": float(last.c), "v": float(df.v.sum())},
                "latestTrade": {"t": (pd.Timestamp(last.t) + MINUTE).isoformat(), "p": float(last.c)}}

    def get(self, url: str, params: Mapping[str, Any]) -> dict[str, Any]:
        require_feed(url, params)
        self.calls.append(url)
        syms = [s for s in str(params.get("symbols", "")).split(",") if s]
        now = self.clock.now()
        if url.endswith("/v2/stocks/quotes/latest"):
            quotes = {}
            for sym in syms:
                q = self.tape.quote_at(sym, now)
                if q is not None:
                    quotes[sym] = {"bp": q[0], "ap": q[1], "t": q[2].isoformat()}
            return {"quotes": quotes}
        if url.endswith("/v2/stocks/snapshots"):
            snaps = {sym: self._snapshot(sym, now) for sym in syms}
            return {sym: s for sym, s in snaps.items() if s is not None}
        if url.endswith("/v2/stocks/bars"):
            if params.get("timeframe") != "1Min":
                raise ValueError("the replay tape holds 1-minute bars only")
            bars = {}
            for sym in syms:
                df = self.tape.closed_bars(sym, params["start"], now)
                bars[sym] = [{"t": pd.Timestamp(r.t).isoformat(), "o": float(r.o), "h": float(r.h), "l": float(r.l),
                              "c": float(r.c), "v": float(r.v)} for r in df.itertuples()]
            return {"bars": bars}
        raise ValueError(f"the replay client does not serve {url}")


@dataclass
class Fill:
    t: pd.Timestamp                # the start of the bar that filled it, or the time of a fill against the quote
    client_order_id: str
    symbol: str
    side: str
    qty: int
    price: float
    rule: str                      # which fill rule applied


class BarFillBroker(SimBroker):
    """SimBroker that fills resting orders from closed minute bars (rules in the module docstring)."""

    def __init__(self, clock: ReplayClock, tape: Tape, sessions: Mapping[dt.date, tuple[str, str]],
                 cash: float = 25_000.0, slip: float = 0.01, volume_frac: float = 0.10,
                 target_fill: str = "touch", tick: float = 0.01, quote_fill_age_s: float = 60.0) -> None:
        super().__init__(cash)
        if target_fill not in TARGET_FILLS:
            raise ValueError(f"target_fill must be one of {TARGET_FILLS}, got {target_fill!r}")
        self._rc, self.tape, self.sessions = clock, tape, dict(sessions)
        self.slip, self.volume_frac, self.through, self.tick = slip, volume_frac, target_fill == "through", tick
        self.quote_fill_age_s = quote_fill_age_s
        self.fills: list[Fill] = []
        self.placed_at: dict[str, pd.Timestamp] = {}
        self._triggered: set[str] = set()
        self._done_through: dict[str, pd.Timestamp] = {}       # per symbol: start of the last bar already applied
        self._entry_bar: dict[str, Any] = {}                   # per symbol: the bar a buy filled on, until the next bar
        self.clock_fn = self._clock
        clock.hooks.insert(0, self.advance)

    # --- the broker's own clock follows the replay clock -------------------------------------------------------
    def _bounds(self, day: dt.date) -> tuple[dt.datetime, dt.datetime]:
        o, c = self.sessions[day]
        return (dt.datetime.combine(day, dt.time.fromisoformat(o), tzinfo=ET),
                dt.datetime.combine(day, dt.time.fromisoformat(c), tzinfo=ET))

    def _clock(self) -> BrokerClock:
        now = self._rc.now()
        today = now.astimezone(ET).date()
        days = sorted(self.sessions)
        is_open, nxt_open, nxt_close = False, None, None
        for d in days:
            o, c = self._bounds(d)
            if d == today and o <= now < c:
                is_open = True
            if nxt_open is None and o > now:
                nxt_open = o
            if nxt_close is None and c > now:
                nxt_close = c
        last_o, last_c = self._bounds(days[-1])
        return BrokerClock(timestamp=now, is_open=is_open,
                           next_open=nxt_open or last_o + dt.timedelta(days=1),
                           next_close=nxt_close or last_c + dt.timedelta(days=1))

    # --- placing ------------------------------------------------------------------------------------------------
    def place(self, order: Order) -> Order:
        try:
            return super().place(order)
        finally:                               # a lost response raises after the order exists: it is resting too
            if order.client_order_id in self.orders and order.client_order_id not in self.placed_at:
                self._on_placed(order.client_order_id)

    def _on_placed(self, cid: str) -> None:
        o = self.orders[cid]
        now = _utc(self._rc.now())
        self.placed_at[cid] = now
        left = o.qty - o.filled_qty
        bar = self._entry_bar.get(o.symbol)
        if bar is not None and o.side == "sell" and o.type == "stop" and o.stop_price is not None \
                and float(bar.l) <= o.stop_price:
            self._fill(o, pd.Timestamp(bar.t), o.stop_price - self.slip, left, "stop_on_entry_bar")
            return
        q = self.tape.quote_at(o.symbol, now)
        if q is None or (now - q[2]).total_seconds() > self.quote_fill_age_s:
            return
        bid, ask = q[0], q[1]
        held = self.pos[o.symbol].qty if o.symbol in self.pos else 0
        if o.side == "sell" and held > 0:
            if o.type == "market":
                self._fill(o, now, bid - self.slip, left, "market_at_bid")
            elif o.type == "limit" and o.limit_price is not None and o.limit_price <= bid + 1e-9:
                self._fill(o, now, bid, left, "marketable_limit")
        elif o.side == "buy":
            if o.type == "market":
                self._fill(o, now, ask + self.slip, left, "market_at_ask")
            elif o.type == "limit" and o.limit_price is not None and o.limit_price >= ask - 1e-9:
                self._fill(o, now, ask, left, "marketable_limit")

    def advance(self, now: dt.datetime) -> None:
        """Apply every bar that has closed since the last call, oldest first, across all symbols."""
        pending: list[tuple[pd.Timestamp, str, Any]] = []
        for sym in {o.symbol for o in self.orders.values()} | set(self._entry_bar):
            df = self.tape.bars.get(sym)
            if df is None or not len(df):
                continue
            after = self._done_through.get(sym)
            new = df[df.t + MINUTE <= _utc(now)]
            if after is not None:
                new = new[new.t > after]
            for bar in new.itertuples():
                pending.append((pd.Timestamp(bar.t), sym, bar))
        for t, sym, bar in sorted(pending, key=lambda x: (x[0], x[1])):
            self._entry_bar.pop(sym, None)
            self._apply(sym, bar)
            self._done_through[sym] = t

    def _apply(self, sym: str, bar: Any) -> None:
        t = pd.Timestamp(bar.t)
        live = [o for o in self.orders.values()
                if o.symbol == sym and not o.status.terminal and t + MINUTE > self.placed_at[o.client_order_id]]
        # sells before buys, stops before limits: the engine's pessimistic order on one bar
        rank = {("sell", "stop"): 0, ("sell", "stop_limit"): 0, ("sell", "market"): 1, ("sell", "limit"): 2}
        for o in sorted(live, key=lambda x: rank.get((x.side, x.type), 3)):
            if o.status.terminal:
                continue
            left = o.qty - o.filled_qty
            if o.side == "sell":
                held = self.pos[sym].qty if sym in self.pos else 0
                if o.type == "market" and t >= self.placed_at[o.client_order_id]:
                    self._fill(o, t, float(bar.o) - self.slip, left, "market", bar)
                elif o.type in ("stop", "stop_limit") and o.stop_price is not None and float(bar.l) <= o.stop_price:
                    self._fill(o, t, min(o.stop_price, float(bar.o)) - self.slip, left, "stop", bar)
                elif o.type == "limit" and o.limit_price is not None and held > 0 and \
                        float(bar.h) >= o.limit_price + (self.tick if self.through else 0.0) - 1e-9:
                    self._fill(o, t, max(o.limit_price, float(bar.o)), left, "limit", bar)
                continue
            cap = int(float(bar.v) * self.volume_frac)
            qty = min(left, cap)
            if o.type == "market":
                if t >= self.placed_at[o.client_order_id] and qty >= 1:
                    self._fill(o, t, float(bar.o) + self.slip, qty, "market", bar)
            elif o.type == "limit" and o.limit_price is not None:
                if float(bar.l) <= o.limit_price and qty >= 1:
                    self._fill(o, t, min(o.limit_price, float(bar.o)), qty, "limit", bar)
            elif o.type in ("stop", "stop_limit") and o.stop_price is not None:
                limit = o.limit_price if o.type == "stop_limit" and o.limit_price is not None else float("inf")
                cid = o.client_order_id
                if cid in self._triggered:                     # resting as a limit after an earlier trigger
                    if float(bar.l) <= limit and qty >= 1:
                        self._fill(o, t, min(limit, float(bar.o)), qty, "stop_limit_resting", bar)
                elif float(bar.h) >= o.stop_price:
                    self._triggered.add(cid)
                    if float(bar.o) <= limit + 1e-9 and qty >= 1:
                        self._fill(o, t, min(max(o.stop_price, float(bar.o)) + self.slip, limit), qty, "stop_limit", bar)

    def _fill(self, o: Order, t: pd.Timestamp, price: float, qty: int, rule: str, bar: Any = None) -> None:
        if qty < 1:
            return
        price = round(price, 4)
        self.fill(o.client_order_id, price, qty)
        self.fills.append(Fill(pd.Timestamp(t), o.client_order_id, o.symbol, o.side, qty, price, rule))
        if o.side == "buy" and bar is not None:
            self._entry_bar[o.symbol] = bar
