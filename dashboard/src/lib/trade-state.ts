// The "Trade now" decision engine for the Options desk: one state, one sentence and one next action per focus name,
// worked out from the focus plan's levels and the live prices the page polls. Advisory and read-only: nothing here
// places an order, and the 9 rules are unchanged.
//
// Pure: no I/O and no clock. The caller passes `now`, and every `now` here is the feed's (server) clock: the browser's
// clock shifted by the feed's offset (`serverNow`), never the browser's own. Times are New York through options.ts
// (nyClock, nyInstant, OPEN_MIN, closeMinute), so the daylight-saving changes need nothing here.
//
// A break counts only on a completed 2-minute close beyond the level, the focus card's own rule: a single print never
// moves the state. The page can only build bars from the prices it has seen, so for anything it did not see (before
// it opened, or a 2-minute slot with no price) it reads the quote's day high and low, and it never says enter zone:
// when in doubt the state is get ready, "confirm on your chart" (`brokeEarlier`, `gap`).
import {
  BAR_MINUTES,
  type CheckInput,
  type Caution,
  entryChecks,
  FAIL_WITHIN_BARS,
  levelOf,
  MAX_BARS_TO_RETEST,
  midThird,
  type Side,
  SWEEP_MIN_ATR,
  TRADE_STALE_MS,
} from "./entry-checks";
import type { SidePlan } from "./focus-plan";
import type { Tone } from "./labels";
import { closeMinute, type LiveQuote, nyClock, nyInstant, OPEN_MIN, type OptionsTicker, type TrailPoint } from "./options";
import { TIME_STOP_MINUTES } from "./trade-rules";

// ---- constants ------------------------------------------------------------------------------------------------------
/** The bar the states are read on, in minutes (rule 2's 2-minute close; bars.minutes), and the retest's window. */
export { BAR_MINUTES, MAX_BARS_TO_RETEST, TRADE_STALE_MS };
const BAR_MS = BAR_MINUTES * 60_000;
/** A dip comes back to the level when its low is within this share of the ATR of it (the focus card's STOP_ATR band). */
export const RETEST_ATR = 0.1;
/** The trail after target 1: the EMA of this many 2-minute closes (bars.ema_fast). */
export const EMA_FAST = 9;
/** First entries from 10:00 New York. */
export const FIRST_ENTRY_MIN = 10 * 60;
/** Flat by 15:10 New York. */
export const FLAT_MIN = 15 * 60 + 10;
/** On a half day, flat this many minutes before the 13:00 close: 12:10, the clone's `day.half_day.flatten`. */
export const HALF_DAY_FLAT_BEFORE_CLOSE = 50;
/** The browser's last answer from the feed is stale after this long. */
export const FEED_STALE_MS = 20_000;
/** Cautions shown on a row; the rest are counted. */
export const MAX_CAUTIONS_SHOWN = 2;
/** A bar whose end has passed is still forming until a later price arrives, or this long after its end: a trade
 * stamped inside it can still reach the page. */
export const CLOSE_GRACE_MS = 5_000;
/** The desk's own number, not a clone parameter: an alternative trigger is shown for this many completed 2-minute
 * bars (6 minutes) after the bar that completed it, then dropped. */
export const ALT_LIVE_BARS = 3;
/** The desk's own number, not a clone parameter: an alternative trigger is dropped once the live price is more than
 * this many ATRs (the plan's) from its level. */
export const ALT_MAX_ATR = 1;

/** The minute (New York) to be flat by, and after which no new entry is suggested. */
export function flatMinute(halfDay: boolean): number {
  return halfDay ? closeMinute(true) - HALF_DAY_FLAT_BEFORE_CLOSE : FLAT_MIN;
}

/**
 * The feed's (server) clock now: the browser's clock shifted by the server-minus-browser offset seen when the feed
 * last answered (`asOf`, the server's time of that answer; `receivedAt`, the browser's). The browser's clock when
 * either is unknown. Every `now` passed to this module is this.
 */
export function serverNow(asOf: string | null, receivedAt: number | null, browserNowMs: number): Date {
  const srv = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(srv) || receivedAt === null || !Number.isFinite(receivedAt)) return new Date(browserNowMs);
  return new Date(browserNowMs + (srv - receivedAt));
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const p2 = (v: number) => v.toFixed(2);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const slotOf = (ms: number) => Math.floor(ms / BAR_MS) * BAR_MS;

// ---- 2-minute bars --------------------------------------------------------------------------------------------------
export interface Bar2 {
  /** Start and end, ms since the epoch. */
  start: number;
  end: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Bars2m {
  /** Completed bars, oldest first: ended by `now`, and a later price has arrived or CLOSE_GRACE_MS have passed. */
  closed: Bar2[];
  /** The bar still forming (or ended but not yet completed), if the page has a price in it. */
  partial: Bar2 | null;
  /** The start of the page's first bar today (ms, on the 2-minute grid): there are no bars before it. */
  since: number | null;
  /** True when the first bar starts at the session's open (09:30 New York): the page saw the whole session. */
  complete: boolean;
  /** The starts (ms) of the 2-minute slots from `since` up to `now` with no bar: the page saw no price in them. */
  missing: number[];
  /** `missing.length`. */
  gaps: number;
}

const NO_BARS = (): Bars2m => ({ closed: [], partial: null, since: null, complete: false, missing: [], gaps: 0 });

/**
 * 2-minute bars from the polled price trail, aligned to :00, :02, ... New York (the New York offset is whole hours,
 * so the epoch's 2-minute grid is New York's). Only prices inside the regular session of the New York day of `now`
 * are used (and none when `session` is given and is another day). The quote's own trade is added when it is newer
 * than the trail. A 2-minute slot with no price has no bar, and is counted in `missing`. `now` is the feed's clock.
 */
export function bars2m(
  trail: readonly TrailPoint[],
  quote: LiveQuote | null | undefined,
  now: Date,
  halfDay = false,
  session: string | null = null,
): Bars2m {
  const t = now.getTime();
  const day = nyClock(now.toISOString())?.day ?? null;
  if (day === null || (session !== null && session !== day)) return NO_BARS();
  const open = nyInstant(day, OPEN_MIN);
  const close = nyInstant(day, closeMinute(halfDay));
  if (open === null || close === null) return NO_BARS();
  const inSession = (at: number) => at >= open && at < close && at <= t;
  const pts = trail.filter((x) => isNum(x.at) && isNum(x.p) && x.p > 0 && inSession(x.at)).map((x) => ({ at: x.at, p: x.p }));
  pts.sort((a, b) => a.at - b.at);
  const qa = quote ? Date.parse(quote.at) : NaN;
  if (quote && Number.isFinite(qa) && isNum(quote.price) && quote.price > 0 && inSession(qa) && (pts.length === 0 || qa > pts[pts.length - 1]!.at))
    pts.push({ at: qa, p: quote.price });
  const bars: Bar2[] = [];
  for (const x of pts) {
    const start = slotOf(x.at);
    const last = bars[bars.length - 1];
    if (last && last.start === start) {
      last.h = Math.max(last.h, x.p);
      last.l = Math.min(last.l, x.p);
      last.c = x.p;
    } else bars.push({ start, end: start + BAR_MS, o: x.p, h: x.p, l: x.p, c: x.p });
  }
  if (bars.length === 0) return NO_BARS();
  // Completed: ended, and a later price exists (it is in a later bar) or the grace has passed. Only the last can wait.
  const lastBar = bars[bars.length - 1]!;
  const lastDone = lastBar.end <= t && t >= lastBar.end + CLOSE_GRACE_MS;
  const closed = lastDone ? bars : bars.slice(0, -1);
  const since = bars[0]!.start;
  const have = new Set(bars.map((b) => b.start));
  const missing: number[] = [];
  for (let s0 = since; s0 + BAR_MS <= Math.min(t, close); s0 += BAR_MS) {
    if (have.has(s0)) continue;
    // a slot after the last bar counts once its grace has passed (a late-stamped trade could still land in it)
    if (s0 < lastBar.start || t >= s0 + BAR_MS + CLOSE_GRACE_MS) missing.push(s0);
  }
  return { closed, partial: lastDone ? null : lastBar, since, complete: since <= open, missing, gaps: missing.length };
}

/** True when the page has a bar in every 2-minute slot from the one holding `ms` up to now (`bars2m`'s `now`). */
export function coveredSince(bars: Bars2m, ms: number): boolean {
  const from = slotOf(ms);
  return bars.since !== null && bars.since <= from && !bars.missing.some((m) => m >= from);
}

/** Exponential average seeded with the simple mean of the first `n` values (regime.ema); null with fewer than `n`. */
export function ema(values: readonly number[], n: number): number | null {
  if (n < 1 || values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (const x of values.slice(n)) e = x * k + e * (1 - k);
  return e;
}

/** The quote when it is today's (the New York day of `now`) with a price and a trade no older than TRADE_STALE_MS. */
function freshQuote(quote: LiveQuote | null | undefined, now: Date): LiveQuote | null {
  if (!quote || !isNum(quote.price)) return null;
  const at = Date.parse(quote.at);
  const day = nyClock(now.toISOString())?.day ?? null;
  return day !== null && quote.day === day && Number.isFinite(at) && now.getTime() - at <= TRADE_STALE_MS ? quote : null;
}

// ---- one side -------------------------------------------------------------------------------------------------------
export type SideStateName = "no_trade" | "watch" | "get_ready" | "enter_zone" | "plan_off" | "missed";

/** A trigger the plan does not take but the study is testing, live only after its pattern has printed. */
export interface AltTrigger {
  kind: "failed_break" | "sweep_reclaim";
  side: Side;
  level: number;
  /** A 2-minute close beyond this ends it: the push's high (or low), or the sweep's low (or high). */
  stop: number;
  /** The close of the bar that completed it. */
  entry: number;
}

export interface SideState {
  side: Side;
  state: SideStateName;
  level: number | null;
  /** The quote's day high (or low) crossed the level, but the page has no bars for it (or no close before them). */
  brokeEarlier: boolean;
  /** No completed close beyond the level yet; the live price is beyond it. */
  waitingClose: boolean;
  /** A 2-minute slot from the break bar to now has no price: no entry is read across it. */
  gap: boolean;
  /** Why the side is missed: target 1 reached after the break, or the retest's window passed. */
  missedWhy: "target" | "window" | null;
  /** The break the state comes from, as the bar's end (ms), when the page saw it. */
  brokeAt: number | null;
  alt: AltTrigger | null;
  /** ATRs from the live price to the level; null without a price or an ATR. */
  distAtr: number | null;
}

/** The furthest price reached (highest for a call, lowest for a put) over some bars. */
const reach = (bars: readonly Bar2[], s: 1 | -1) => (bars.length ? (s > 0 ? Math.max(...bars.map((b) => b.h)) : Math.min(...bars.map((b) => b.l))) : null);

/** What an alternative trigger needs to be live now: the feed's clock (ms), the live price, the plan's ATR and the
 * page's missing slots (`Bars2m.missing`). */
export interface AltLive {
  now: number;
  price: number | null;
  planAtr: number | null;
  missing: readonly number[];
}

/**
 * The alternative triggers at a level, the opposite side to the plan there. Mirrors the clone's two shadow arms
 * (HYP-0046 failed break, HYP-0047 sweep and reclaim), with the page's bars instead of the session's:
 * - failed break: bar A closes beyond the level with the close before it not beyond; within FAIL_WITHIN_BARS bars
 *   after A, a bar is the first to close back inside (strictly). Entry: that close; stop: the extreme from A on.
 * - sweep and reclaim: the bar before closed at or inside the level; one bar reaches at least SWEEP_MIN_ATR ATRs
 *   past it and closes at or inside it. Entry: that close; stop: that bar's extreme.
 * A pattern is read only on bars with no missing slot between them. A later completed close back past the level ends
 * it. The latest one wins. With `live`, it is also live only for ALT_LIVE_BARS bars after the bar that completed it,
 * with no slot missing since the pattern began, while the live price has not reached its stop and is within
 * ALT_MAX_ATR plan ATRs of the level (no price or no ATR: none). `live.now` is the feed's clock.
 */
export function altAt(level: number, planSide: Side, closed: readonly Bar2[], atr: number | null, live: AltLive | null = null): AltTrigger | null {
  const s = planSide === "call" ? 1 : -1; // the side of the level the plan breaks to
  const altSide: Side = planSide === "call" ? "put" : "call";
  const beyond = (x: number) => (x - level) * s > 0;
  const inside = (x: number) => (x - level) * s < 0;
  const joined = (i: number, j: number) => {
    for (let m = i + 1; m <= j; m++) if (closed[m]!.start !== closed[m - 1]!.end) return false;
    return true;
  };
  let best: { at: number; from: number; alt: AltTrigger } | null = null;
  const last = closed.length - 1;
  for (let k = 1; k <= last; k++) {
    // failed break completed by bar k
    if (inside(closed[k]!.c)) {
      for (let ia = k - 1; ia >= Math.max(k - FAIL_WITHIN_BARS, 1); ia--) {
        if (beyond(closed[ia]!.c) && !beyond(closed[ia - 1]!.c)) {
          if (joined(ia - 1, k) && !closed.slice(ia + 1, k).some((b) => inside(b.c))) {
            const span = closed.slice(ia, k + 1);
            const stop = s > 0 ? Math.max(...span.map((b) => b.h)) : Math.min(...span.map((b) => b.l));
            best = { at: k, from: ia - 1, alt: { kind: "failed_break", side: altSide, level, stop, entry: closed[k]!.c } };
          }
          break;
        }
      }
    }
    // sweep and reclaim completed by bar k
    if (atr !== null && atr > 0 && joined(k - 1, k)) {
      const pre = closed[k - 1]!;
      const sw = closed[k]!;
      const far = s > 0 ? sw.h - level : level - sw.l;
      if (!beyond(pre.c) && far >= SWEEP_MIN_ATR * atr && !beyond(sw.c))
        best = { at: k, from: k - 1, alt: { kind: "sweep_reclaim", side: altSide, level, stop: s > 0 ? sw.h : sw.l, entry: sw.c } };
    }
  }
  if (!best) return null;
  // ended by a later completed close back past the level
  if (closed.slice(best.at + 1).some((b) => beyond(b.c))) return null;
  if (!live) return best.alt;
  const from = closed[best.from]!.start;
  if (live.missing.some((m) => m >= from)) return null;
  if (live.now >= closed[best.at]!.end + ALT_LIVE_BARS * BAR_MS) return null;
  if (live.price === null || live.planAtr === null || !(live.planAtr > 0)) return null;
  const d = best.alt.side === "call" ? 1 : -1;
  if ((live.price - best.alt.stop) * d <= 0) return null; // reached the stop
  if (Math.abs(live.price - level) > ALT_MAX_ATR * live.planAtr) return null;
  return best.alt;
}

/**
 * One side's state from its focus plan (call: break up through the ceiling; put: down through the floor), the ATR,
 * the page's 2-minute bars and the quote. `now` is the feed's clock. Call side (the put is the mirror):
 * - break: a completed bar closes above the level with the close before it known and not above (the bar before it
 *   with no slot between; for the page's first bar, only when the page has the session from its open, against the
 *   open). A close above with no known close before it is a break the page did not see (`brokeEarlier`);
 * - get_ready: the price is above the level with no completed close above yet, or it broke and waits for the dip,
 *   or the page is missing prices since the break (`gap`), or it broke before the page's bars;
 * - enter_zone: after the break, within MAX_BARS_TO_RETEST bars, a bar's low comes within RETEST_ATR ATRs of the
 *   level (or through it) and closes above; it stays while the price is at or above the level, nothing has reached
 *   target 1 since the break, and the bar forming is at most MAX_BARS_TO_RETEST + 1 bars after the break
 *   (setups.retest's window), with every slot since the break seen and a fresh quote;
 * - missed: target 1 reached at any point after the break (a bar, the bar forming, the live price, or the quote's
 *   day high when the page's bars before the break do not show it), or the retest's window passed: don't chase;
 * - plan_off: after the break, a completed bar closes back at or below the level;
 * - watch: none of these.
 */
export function sideState(plan: SidePlan | null, atr: number | null | undefined, bars: Bars2m, quote: LiveQuote | null | undefined, now: Date, sweepAtr: number | null = null): SideState {
  const side: Side = plan?.side ?? "call";
  const a = isNum(atr) && atr > 0 ? atr : null;
  const base = { side, brokeEarlier: false, waitingClose: false, gap: false, missedWhy: null, brokeAt: null, alt: null, distAtr: null };
  if (!plan) return { ...base, state: "no_trade", level: null };
  const L = plan.level;
  const s = plan.side === "call" ? 1 : -1;
  const beyond = (x: number) => (x - L) * s > 0;
  const t = now.getTime();
  const q = freshQuote(quote, now);
  const price = q ? q.price : null;
  const distAtr = price !== null && a ? Math.abs(price - L) / a : null;
  const closed = bars.closed.filter((b) => b.end <= t);
  // The sweep is measured in the 2-minute bars' own ATR, as the clone measures it; without one it is not looked for.
  const alt = altAt(L, plan.side, closed, isNum(sweepAtr) && sweepAtr > 0 ? sweepAtr : null, { now: t, price, planAtr: a, missing: bars.missing });
  const t1 = plan.target1;
  const pastT1 = (x: number | null | undefined) => isNum(x) && t1 !== null && (x - t1) * s >= 0;
  const out = (state: SideStateName, extra: Partial<SideState> = {}): SideState => ({ ...base, state, level: L, alt, distAtr, ...extra });
  const missed = (why: "target" | "window", brokeAt: number | null = null, brokeEarlier = false) => out("missed", { missedWhy: why, brokeAt, brokeEarlier });

  // the most recent break with a known close before it; `unknownAt`: a close beyond whose close before is unknown
  let ia = -1;
  let unknownAt = -1;
  for (let i = closed.length - 1; i >= 0; i--) {
    const b = closed[i]!;
    if (!beyond(b.c)) continue;
    if (i === 0) {
      // Python's retest never breaks on the session's first bar (it needs the close before it); the page does
      // likewise, and with bars missing before it the break is unknown.
      if (!bars.complete) unknownAt = 0;
      break;
    }
    const p = closed[i - 1]!;
    if (!beyond(p.c)) {
      if (p.end === b.start) ia = i;
      else unknownAt = i; // the break is in a slot the page has no price for
      break;
    }
    // the close before is beyond too: the break is earlier (a slot missing between them is read as a gap below)
  }
  const dayExtreme = q ? (s > 0 ? q.high : q.low) : null;
  const dayCrossed = isNum(dayExtreme) && beyond(dayExtreme);
  const seen = [...closed, ...(bars.partial ? [bars.partial] : [])];
  const seenBeyond = seen.some((b) => beyond(s > 0 ? b.h : b.l)) || (price !== null && beyond(price));

  if (ia < 0) {
    const allBeyondFrom = (i: number) => closed.slice(i).every((b) => beyond(b.c));
    const openedBeyond = closed.length > 0 && beyond(closed[0]!.o) && allBeyondFrom(0);
    if ((unknownAt >= 0 && allBeyondFrom(unknownAt)) || openedBeyond || (dayCrossed && !seenBeyond)) {
      // Broke where the page has no bars: never claim a dip from bars the page does not have.
      if (price !== null && beyond(price)) return pastT1(dayExtreme) || pastT1(reach(seen, s)) ? missed("target", null, true) : out("get_ready", { brokeEarlier: true });
      return out("watch", { brokeEarlier: true });
    }
    if (price !== null && beyond(price)) return out("get_ready", { waitingClose: true });
    return out("watch");
  }

  const brk = closed[ia]!;
  const brokeAt = brk.end;
  const after = closed.slice(ia + 1);
  if (after.some((b) => !beyond(b.c))) return out("plan_off", { brokeAt });
  // target 1 at any point since the break: the bars, the bar forming, the live price
  const forming = bars.partial && bars.partial.start >= brk.end ? [bars.partial] : [];
  if (pastT1(reach([brk, ...after, ...forming], s)) || pastT1(price)) return missed("target", brokeAt);
  // the day's extreme past target 1 is missed unless the page's bars show it came before the break
  if (isNum(dayExtreme) && pastT1(dayExtreme)) {
    const pre = reach(closed.slice(0, ia), s);
    if (!(pre !== null && (pre - dayExtreme) * s >= 0)) return missed("target", brokeAt);
  }
  // setups.retest's window: the bar forming now at most MAX_BARS_TO_RETEST + 1 bars after the break bar
  if ((slotOf(t) - brk.start) / BAR_MS > MAX_BARS_TO_RETEST + 1) return missed("window", brokeAt);
  if (!coveredSince(bars, brk.start)) return out("get_ready", { brokeAt, gap: true });
  const near = a !== null ? RETEST_ATR * a : null;
  const touch = near === null ? -1 : after.findIndex((b) => (s > 0 ? b.l - L : L - b.h) <= near);
  if (touch < 0 || price === null) return out("get_ready", { brokeAt });
  if ((price - L) * s >= 0) return out("enter_zone", { brokeAt });
  return out("get_ready", { brokeAt });
}

// ---- one name -------------------------------------------------------------------------------------------------------
export type NameStateName = SideStateName | "paused";

export interface NameState {
  symbol: string;
  state: NameStateName;
  tone: Tone;
  side?: Side;
  /** One sentence, exact prices to 2 decimals and ATR distances to 1. */
  line: string;
  plan: { level: number | null; entry: number | null; stop: number | null; target1: number | null; target2: number | null } | null;
  alt: AltTrigger | null;
  brokeEarlier: boolean;
  cautions: Caution[];
  /** Cautions beyond the ones shown. */
  moreCautions: number;
  unknown: string[];
  /** Lower first: the board's order. */
  rank: number;
  call: SideState;
  put: SideState;
}

export const STATE_TONE: Record<NameStateName, Tone> = {
  no_trade: "neutral",
  watch: "info",
  get_ready: "warn",
  enter_zone: "good",
  plan_off: "bad",
  missed: "neutral",
  paused: "neutral",
};

/** The board's order of states, most urgent first. A side with a live alternative trigger sits at 1. */
const STATE_RANK: Record<NameStateName, number> = {
  enter_zone: 0,
  get_ready: 2,
  watch: 3,
  plan_off: 4,
  missed: 5,
  no_trade: 6,
  paused: 7,
};
const sideRank = (x: SideState) => (x.alt && (x.state === "plan_off" || x.state === "watch" || x.state === "missed") ? 1 : STATE_RANK[x.state]);

export interface NameInput {
  symbol: string;
  /** The edition's session (New York date). */
  session: string;
  call: SidePlan | null;
  put: SidePlan | null;
  /** The plan's ATR (the focus item's), the unit of every distance. */
  atr: number | null | undefined;
  /** The ATR of the session's 2-minute bars, for the sweep; null leaves the sweep out. */
  sweepAtr?: number | null;
  /** The edition's ticker, for yesterday's range and the cautions. */
  ticker: Pick<OptionsTicker, "levels" | "bars" | "expected_move">;
  bars: Bars2m;
  quote: LiveQuote | null | undefined;
  leaderQuote?: LiveQuote | null;
  /** The feed's (server) clock (ms) of its last answer: the same clock as `now`. */
  receivedAt: number | null;
  /** The feed's (server) clock (`serverNow`). */
  now: Date;
  halfDay: boolean;
  /** Rule 7 or 8 has ended the day. */
  dayLimitUsed: boolean;
  wonToday: boolean | null;
}

const altLine = (x: AltTrigger) =>
  x.kind === "failed_break"
    ? `Failed break: ${x.side} ${x.side === "put" ? "under" : "over"} ${p2(x.level)}, stop ${x.side === "put" ? "above" : "below"} ${p2(x.stop)} (push ${x.side === "put" ? "high" : "low"}) · testing`
    : `Sweep and reclaim: ${x.side} ${x.side === "call" ? "above" : "below"} ${p2(x.level)}, stop ${x.side === "call" ? "below" : "above"} ${p2(x.stop)} (sweep ${x.side === "call" ? "low" : "high"}) · testing`;

function sideLine(x: SideState, plan: SidePlan): string {
  const L = p2(plan.level);
  const up = plan.side === "call";
  const over = up ? "above" : "below";
  const back = up ? "Fell back below" : "Rose back above";
  switch (x.state) {
    case "enter_zone": {
      const limit = plan.entry !== null ? ` limit ~${p2(plan.entry)}` : "";
      const stop = plan.stop !== null ? ` · stop ${p2(plan.stop)} / −25%` : "";
      const target = plan.target1 !== null ? ` · target ${p2(plan.target1)}` : "";
      return `Retest holding ${L}: ${plan.side}${limit}${stop}${target}`;
    }
    case "get_ready":
      if (x.brokeEarlier) return `Broke ${over} ${L} before you opened the page: confirm the hold on your chart`;
      if (x.gap) return `Broke ${over} ${L}, but the page missed prices since: confirm on your chart`;
      if (x.waitingClose) return `${up ? "Above" : "Below"} ${L}: wait for a 2-min close ${over} it`;
      if (x.brokeAt !== null) return `Broke ${over} ${L}: wait for a dip that holds it`;
      return `Back at ${L}: wait for the 2-min close`;
    case "plan_off":
      return `${back} ${L}: ${plan.side} plan off${x.alt ? ` · ${altLine(x.alt)}` : ""}`;
    case "missed":
      if (x.missedWhy === "window") return `Retest window at ${L} passed: don't chase`;
      return plan.target1 !== null ? `Already past target 1 (${p2(plan.target1)}): don't chase` : `Ran ${over} ${L}: don't chase`;
    default:
      return x.alt ? altLine(x.alt) : `${up ? "Calls above" : "Puts below"} ${L}`;
  }
}

const dist = (x: SideState) => (x.distAtr !== null ? ` (${x.distAtr.toFixed(1)} ATR)` : "");

/**
 * The one row for a focus name. `n.now` is the feed's (server) clock. In order: a stale feed in the session pauses
 * it; before 10:00, from the flat time (15:10, or 50 minutes before a half day's 13:00 close: 12:10) or with the
 * day's limit used it is no trade; with the price in the
 * middle third of yesterday's range and nothing broken, no trade; otherwise the more urgent side: enter zone, then a
 * live alternative trigger, get ready, watch, plan off and missed.
 */
export function nameState(n: NameInput): NameState {
  const call = sideState(n.call, n.atr, n.bars, n.quote, n.now, n.sweepAtr ?? null);
  const put = sideState(n.put, n.atr, n.bars, n.quote, n.now, n.sweepAtr ?? null);
  const plans = { call: n.call, put: n.put };
  const t = n.now.getTime();
  const clock = nyClock(n.now.toISOString());
  const minute = clock && clock.day === n.session ? clock.minutes : null;
  const flat = flatMinute(n.halfDay);
  const inSession = minute !== null && minute >= OPEN_MIN && minute < closeMinute(n.halfDay);
  const q = n.quote && n.quote.day === n.session ? n.quote : null;
  const triggers = [n.put, n.call].filter((x): x is SidePlan => x !== null).map((x) => p2(x.level));
  const row = (state: NameStateName, line: string, pick: SideState | null, rankExtra = 0): NameState => {
    const plan = pick ? plans[pick.side] : null;
    const checkIn: CheckInput = {
      symbol: n.symbol,
      ticker: n.ticker,
      session: n.session,
      quote: n.quote,
      leaderQuote: n.leaderQuote ?? null,
      bars: n.bars.closed,
      since: n.bars.since,
      gaps: n.bars.gaps,
      halfDay: n.halfDay,
      now: n.now,
      wonToday: n.wonToday,
    };
    const checks = pick && state !== "paused" && state !== "no_trade" ? entryChecks(checkIn, pick.alt && pick.state !== "enter_zone" && pick.state !== "get_ready" ? pick.alt.side : pick.side) : { cautions: [], unknown: [] };
    return {
      symbol: n.symbol,
      state,
      tone: STATE_TONE[state],
      ...(pick ? { side: pick.side } : {}),
      line,
      plan: plan
        ? { level: plan.level, entry: plan.entry, stop: plan.stop, target1: plan.target1, target2: plan.target2?.price ?? null }
        : null,
      alt: pick?.alt ?? null,
      brokeEarlier: pick?.brokeEarlier ?? false,
      cautions: checks.cautions.slice(0, MAX_CAUTIONS_SHOWN),
      moreCautions: Math.max(0, checks.cautions.length - MAX_CAUTIONS_SHOWN),
      unknown: checks.unknown,
      rank: (pick ? sideRank(pick) : STATE_RANK[state]) * 1000 + rankExtra,
      call,
      put,
    };
  };

  // 1. a stale feed in the session
  if (inSession) {
    const feedAge = n.receivedAt !== null ? t - n.receivedAt : Infinity;
    const tradeAge = q ? t - Date.parse(q.at) : Infinity;
    if (!q || feedAge > FEED_STALE_MS || !(tradeAge <= TRADE_STALE_MS)) {
      const age = feedAge > FEED_STALE_MS ? feedAge : tradeAge;
      const line = Number.isFinite(age) ? `No new price for ${Math.round(age / 1000)} s: check your platform` : "No price yet: check your platform";
      return row("paused", line, null);
    }
  }
  // 2. the clock and the day's limit
  const opening = `Opening range forming: first entries from ${hhmm(FIRST_ENTRY_MIN)}`;
  if (minute === null) return row("no_trade", clock && clock.day < n.session ? `Next session: first entries from ${hhmm(FIRST_ENTRY_MIN)}` : "Session closed", null);
  if (minute >= closeMinute(n.halfDay)) return row("no_trade", "Session closed", null);
  if (minute < FIRST_ENTRY_MIN) return row("no_trade", opening, null);
  if (minute >= flat) return row("no_trade", `After ${hhmm(flat)}: no new entries, be flat`, null);
  if (n.dayLimitUsed) return row("no_trade", "Day limit reached: no more trades today", null);

  // 3. the middle of yesterday's range with nothing broken
  const pdh = levelOf(n.ticker, "PDH");
  const pdl = levelOf(n.ticker, "PDL");
  const quiet = (x: SideState) => (x.state === "watch" || x.state === "no_trade") && !x.brokeEarlier && !x.alt;
  if (q && pdh !== null && pdl !== null && midThird(q.price, pdh, pdl) && quiet(call) && quiet(put))
    return row("no_trade", `In the middle of yesterday's range: wait for ${triggers.join(" or ")}`, null);

  // 4. the more urgent side
  const sides = [call, put].filter((x) => plans[x.side] !== null);
  if (sides.length === 0) return row("no_trade", "No plan for this name today", null);
  const pick = [...sides].sort((x, y) => sideRank(x) - sideRank(y) || (x.distAtr ?? Infinity) - (y.distAtr ?? Infinity))[0]!;
  const tenths = pick.distAtr !== null ? Math.min(999, Math.round(pick.distAtr * 10)) : 999;
  if (pick.state === "watch" && !pick.alt) {
    const line = sides
      .filter((x) => x.state === "watch" || x.state === "plan_off" || x.state === "missed")
      .map((x) => {
        const plan = plans[x.side]!;
        const who = plan.side === "call" ? "Calls" : "Puts";
        if (x.state === "missed" && x.missedWhy === "window") return `${who}: retest window at ${p2(plan.level)} passed, don't chase`;
        if (x.state === "missed") return `${who} past target 1${plan.target1 !== null ? ` (${p2(plan.target1)})` : ""}: don't chase`;
        return `${sideLine({ ...x, state: "watch", alt: null }, plan)}${dist(x)}`; // a side whose plan is off waits for a new break
      })
      .join(" · ");
    return row("watch", line, pick, tenths);
  }
  return row(pick.state, sideLine(pick, plans[pick.side]!), pick, tenths);
}

// ---- managing an open trade -----------------------------------------------------------------------------------------
export interface Entry {
  side: Side;
  /** The underlying's price at the fill. */
  price: number;
  /** The fill's time, ISO 8601. */
  at: string;
  source: "journal" | "manual";
}

export interface Manage {
  line: string;
  tone: Tone;
  /** The stop on the underlying now: the plan's, or the entry once target 1 has been hit. */
  stop: number | null;
  target1: number | null;
  /** The trail level (EMA9 of the 2-minute closes) once target 1 has been hit. */
  trail: number | null;
  /** Seconds left before rule 6's check; 0 once due and judged not working (or due with no price yet to judge it);
   * null once it no longer applies (judged working, target 1 hit, or no fill time). */
  notWorkingSecLeft: number | null;
  /** Minutes to the flat time (never below 0). */
  minToFlat: number | null;
}

/**
 * The Manage card's one instruction, the most urgent first: a completed 2-minute close beyond the stop, a close
 * beyond the trail after target 1, the flat time, target 1 just hit (sell half, stop to the entry), rule 6 (5 minutes
 * in and the underlying not past the entry), then the trail or the plan to hold. `now` is the feed's (server) clock.
 *
 * Only prices after the fill count for target 1 and the stop: the bars that start at or after the end of the fill's
 * own 2-minute bar, that bar's prices after the fill when `trail` (the page's polled prices) is given, and the live
 * quote when its trade is after the fill. Rule 6 is judged once, on the first price at or after the fill plus 5
 * minutes: not past the entry, and its exit stands until a later instruction overrides it; past it, it is satisfied
 * and not shown again. An unreadable fill time is managed on the owner's chart.
 */
export function manage(
  entry: Entry,
  plan: SidePlan | null,
  bars: Bars2m,
  quote: LiveQuote | null | undefined,
  now: Date,
  halfDay: boolean,
  trail: readonly TrailPoint[] | null = null,
): Manage {
  const s = entry.side === "call" ? 1 : -1;
  const t = now.getTime();
  const at = Date.parse(entry.at);
  const t1 = plan?.target1 ?? null;
  const clock = nyClock(now.toISOString());
  const flat = flatMinute(halfDay);
  const minToFlat = clock ? Math.max(0, flat - clock.minutes) : null;
  if (!Number.isFinite(at))
    return { line: "Fill time unknown: manage this one on your chart", tone: "warn", stop: plan?.stop ?? null, target1: t1, trail: null, notWorkingSecLeft: null, minToFlat };

  const qAt = quote ? Date.parse(quote.at) : NaN;
  const qPoint = quote && isNum(quote.price) && Number.isFinite(qAt) && qAt <= t ? { at: qAt, p: quote.price } : null;
  const price = qPoint && qPoint.at >= at ? qPoint.p : null;
  const fillEnd = slotOf(at) + BAR_MS;
  const closedNow = bars.closed.filter((b) => b.end <= t);
  const since = closedNow.filter((b) => b.start >= fillEnd);
  const forming = bars.partial && bars.partial.start >= fillEnd ? [bars.partial] : [];
  const live = [...since, ...forming];
  const reached = (x: number) => t1 !== null && (x - t1) * s >= 0;
  // target 1: in the fill's own bar after the fill (from the trail), a bar after it, or the live price
  const inFillBar = (trail ?? []).some((x) => isNum(x.at) && isNum(x.p) && x.at > at && x.at < fillEnd && x.at <= t && reached(x.p));
  const hitIdx = t1 === null ? -1 : live.findIndex((b) => reached(s > 0 ? b.h : b.l));
  const hit = t1 !== null && (inFillBar || hitIdx >= 0 || (price !== null && reached(price)));
  const stop = hit ? entry.price : (plan?.stop ?? null);
  // Closes that printed after the fill: the fill's own bar closes after it, so its close counts for the stop (only
  // its high and low are cut, above).
  const closesAfterFill = closedNow.filter((b) => b.end > at);
  const closesAfterHit = !hit ? [] : inFillBar ? closesAfterFill : hitIdx >= 0 ? since.slice(hitIdx + 1) : [];
  const trailRaw = hit ? ema(closedNow.map((b) => b.c), EMA_FAST) : null;
  const trailLevel = trailRaw !== null ? Math.round(trailRaw * 100) / 100 : null;

  // rule 6: the first price at or after the fill plus 5 minutes (a bar's open, a trail point or the quote)
  const due = at + TIME_STOP_MINUTES * 60_000;
  const firsts = [
    ...[...closedNow, ...(bars.partial ? [bars.partial] : [])].filter((b) => b.start >= due).map((b) => ({ at: b.start, p: b.o })),
    ...(trail ?? []).filter((x) => isNum(x.at) && isNum(x.p) && x.at >= due && x.at <= t),
    ...(qPoint && qPoint.at >= due ? [qPoint] : []),
  ].sort((x, y) => x.at - y.at);
  const judged = firsts[0]?.p ?? null;
  const notWorkingSecLeft = hit ? null : t < due ? Math.ceil((due - t) / 1000) : judged !== null && (judged - entry.price) * s > 0 ? null : 0;
  const base = { stop, target1: t1, trail: trailLevel, notWorkingSecLeft, minToFlat };
  const word = s > 0 ? "Below" : "Above";

  // the plan's stop until target 1, the entry after it; any completed close beyond it since then ends the trade
  const stopped = stop !== null && (hit ? closesAfterHit : closesAfterFill).some((b) => (b.c - stop) * s < 0);
  if (stopped) return { ...base, line: `${word} the stop ${p2(stop)}: exit`, tone: "bad" };
  if (hit && trailLevel !== null && closesAfterHit.length > 0) {
    const lc = closesAfterHit[closesAfterHit.length - 1]!;
    if ((lc.c - trailLevel) * s < 0) return { ...base, line: `${s > 0 ? "Under" : "Over"} the trail ${p2(trailLevel)}: exit`, tone: "bad" };
  }
  if (minToFlat !== null && clock && clock.minutes >= flat) return { ...base, line: `${hhmm(flat)}: flat`, tone: "bad" };
  if (hit && closesAfterHit.length === 0) return { ...base, line: `Target 1 hit: sell half, stop to ${p2(entry.price)}`, tone: "good" };
  if (notWorkingSecLeft === 0 && judged === null) return { ...base, line: `${TIME_STOP_MINUTES} min up: confirm on your chart it is working`, tone: "warn" };
  if (notWorkingSecLeft === 0) return { ...base, line: `${TIME_STOP_MINUTES} min, not working: exit`, tone: "bad" };
  if (hit && trailLevel !== null) return { ...base, line: `Trail ${p2(trailLevel)}: exit on a 2-min close ${s > 0 ? "under" : "over"} it`, tone: "info" };
  if (hit) return { ...base, line: `Stop at ${p2(entry.price)}: trail starts after ${EMA_FAST} bars`, tone: "info" };
  const parts = [stop !== null ? `stop ${p2(stop)}` : null, t1 !== null ? `target 1 ${p2(t1)}` : null].filter(Boolean);
  return { ...base, line: parts.length ? `Holding: ${parts.join(" · ")}` : "Holding: confirm the stop on your chart", tone: "info" };
}

// ---- the session's bars from the server -----------------------------------------------------------------------------
/**
 * The session's 2-minute bars from the server (`/api/bars`, completed bars only) joined to the page's own (bars2m of
 * the price trail). The server wins every slot it has: it saw every print since 09:30, the page only the ones it
 * polled. The trail supplies the slots after the server's last one and the bar still forming. `since` is the earlier
 * of the two first bars, so a page that has the server's bars from the open reads as having seen the whole session.
 * `missing` holds the slots from `since` with no bar in either: those between the bars, and the trail's own after its
 * last bar.
 */
export function mergeBars(serverClosed: readonly Bar2[], trail: Bars2m): Bars2m {
  const server = serverClosed
    .filter((b) => isNum(b.start) && isNum(b.end) && isNum(b.o) && isNum(b.h) && isNum(b.l) && isNum(b.c))
    .map((b) => ({ ...b }))
    .sort((a, b) => a.start - b.start);
  if (server.length === 0) return trail;
  const lastStart = server[server.length - 1]!.start;
  const closed = [...server, ...trail.closed.filter((b) => b.start > lastStart).map((b) => ({ ...b }))];
  const partial = trail.partial && trail.partial.start > lastStart ? { ...trail.partial } : null;
  const since = Math.min(server[0]!.start, ...(isNum(trail.since) ? [trail.since] : []));
  const have = new Set([...closed.map((b) => b.start), ...(partial ? [partial.start] : [])]);
  const last = Math.max(...have);
  const missing: number[] = [];
  for (let s0 = since; s0 < last; s0 += BAR_MS) if (!have.has(s0)) missing.push(s0);
  for (const m of trail.missing) if (m > last && !have.has(m)) missing.push(m);
  const day = nyClock(new Date(since).toISOString())?.day;
  const open = day ? nyInstant(day, OPEN_MIN) : null;
  return { closed, partial, since, complete: open !== null && since <= open, missing, gaps: missing.length };
}

/**
 * The average true range of the last `n` completed 2-minute bars, as the clone reads it (wt.options.regime.atr: the
 * plain mean of the true ranges, each against the bar before). Null with fewer than `n + 1` bars. The sweep's unit.
 */
export function atr2m(closed: readonly Bar2[], n = 14): number | null {
  if (n < 1 || closed.length < n + 1) return null;
  const tail = closed.slice(-n - 1);
  let sum = 0;
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1]!;
    const b = tail[i]!;
    sum += Math.max(b.h - b.l, Math.abs(b.h - a.c), Math.abs(b.l - a.c));
  }
  return sum / n;
}
