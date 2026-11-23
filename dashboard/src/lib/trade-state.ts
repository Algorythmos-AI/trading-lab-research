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
  type CheckResult,
  type Caution,
  deskCautions,
  entryChecks,
  FAIL_WITHIN_BARS,
  levelOf,
  MAX_BARS_TO_RETEST,
  midThird,
  RETEST_WITHIN_ATR,
  type Side,
  SWEEP_MIN_ATR,
  TRADE_STALE_MS,
} from "./entry-checks";
import type { SidePlan } from "./focus-plan";
import calendar from "./market-calendar.json";
import type { Tone } from "./labels";
import { closeMinute, type LiveQuote, nyClock, nyInstant, OPEN_MIN, type OptionsTicker, type TrailPoint } from "./options";
import { activeGuards, type GuardReason, guardLine, quoteGuards } from "./quote-guards";
import { TIME_STOP_MINUTES } from "./trade-rules";

// ---- constants ------------------------------------------------------------------------------------------------------
/** The bar the states are read on, in minutes (rule 2's 2-minute close; bars.minutes), the retest's window and its
 * touch band in 2-minute ATRs (setups.retest, DEC-0052). */
export { BAR_MINUTES, MAX_BARS_TO_RETEST, RETEST_WITHIN_ATR, TRADE_STALE_MS };
const BAR_MS = BAR_MINUTES * 60_000;
/** DEC-0052: a confirmed retest shows ENTER for this many 2-minute slots from its confirming close (the slot it opens
 * and the next): the owner's number (2026-11-17), not a clone parameter. */
export const RETEST_ENTER_SLOTS = 2;
/** The trail after target 1: the EMA of this many 2-minute closes (bars.ema_fast). */
export const EMA_FAST = 9;
/** First entries from 09:35 New York: the owner's rule (DEC-0043). 09:35 to 10:00 carries the desk's own "early"
 * caution (entry-checks' deskCautions); the clone's tested window still starts at 10:00. */
export const FIRST_ENTRY_MIN = 9 * 60 + 35;
/** No new entries from 11:30 to 13:00 New York (the owner's rule), New York minutes after midnight. On a half day the
 * session closes at 13:00 and the block does not apply (flat from 12:10 instead). */
export const LUNCH_FROM_MIN = 11 * 60 + 30;
export const LUNCH_TO_MIN = 13 * 60;
/** Flat by 15:10 New York. */
export const FLAT_MIN = 15 * 60 + 10;
/** On a half day, flat this many minutes before the 13:00 close: 12:10, the clone's `day.half_day.flatten`. */
export const HALF_DAY_FLAT_BEFORE_CLOSE = 50;
/** The browser's last answer from the feed is stale after this long. */
export const FEED_STALE_MS = 20_000;
/** The clone cautions shown on a row; the rest are counted. The desk's early caution is always shown besides. */
export const MAX_CAUTIONS_SHOWN = 2;
/** A bar whose end has passed is still forming until a later price arrives, or this long after its end: a trade
 * stamped inside it can still reach the page. */
export const CLOSE_GRACE_MS = 5_000;
/**
 * A bar the server read from Alpaca is taken as complete only this long after it ended: an upstream 2-minute bar may
 * not yet hold its last minute a few seconds after the slot. Until then the page's own bar for the slot is used, or
 * the slot is missing (a gap, never an entry).
 */
export const SERVER_SETTLE_MS = 60_000;
/** The desk's own number, not a clone parameter: an alternative trigger is shown for this many completed 2-minute
 * bars (6 minutes) after the bar that completed it, then dropped. */
export const ALT_LIVE_BARS = 3;
/** The desk's own number, not a clone parameter: an alternative trigger is dropped once the live price is more than
 * this many ATRs (the plan's) from its level. */
export const ALT_MAX_ATR = 1;

/** Whether the 11:30 to 13:00 block applies: not on a half day, which closes at 13:00. */
export function lunchBlock(halfDay: boolean): boolean {
  return !halfDay && closeMinute(halfDay) > LUNCH_TO_MIN;
}

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
  /** The start (ms) of the bar that completed it: tells one printing of the pattern from a later one. */
  at: number;
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
  /** Why the side is missed: target 1 reached after the break, the retest's window passed, or a confirmed retest's
   * ENTER slots passed (or the price ran past its confirming close: DEC-0052). */
  missedWhy: MissedWhy | null;
  /** The break the state comes from, as the bar's end (ms), when the page saw it. */
  brokeAt: number | null;
  alt: AltTrigger | null;
  /** ATRs from the live price to the level; null without a price or an ATR. */
  distAtr: number | null;
  /** DEC-0052, only where the line needs it: the retest's touch bar's close (from the touch on). */
  touchClose?: number;
  /** DEC-0052, on a confirmed retest only: the confirming bar's close, and its end (ms since the epoch). */
  confirmClose?: number;
  confirmAt?: number;
  /** DEC-0053, display only: the end (ms) of the bar whose close failed the side's break, on a side locked by it
   * (`plan_off`) or one whose lock has ended with no fresh break since (`watch`). Never written to a record. */
  failedAt?: number;
  /** DEC-0053, display only: when the running lock ends (ms), so a line can say it without the session's half-day flag. */
  lockEnd?: number;
  /** DEC-0053, display only: a retest confirmed, but the board's bars do not cover the session from its open, so a
   * failure may be unseen: get ready, never enter zone. Sets neither `gap` nor `brokeEarlier`. */
  lockUnseen?: boolean;
}

/**
 * DEC-0053: the end (ms) of the lock a failure sets, from the failing bar's end: on a full day 13:00 New York when the
 * bar ends at or before 13:00 (LUNCH_TO_MIN), else the flat time; on a half day the flat time (flatMinute). Null when
 * the time cannot be read.
 */
export function lockUntil(failedAt: number, halfDay: boolean): number | null {
  const day = nyClock(new Date(failedAt).toISOString())?.day ?? null;
  if (day === null) return null;
  if (!halfDay) {
    const lunchEnd = nyInstant(day, LUNCH_TO_MIN);
    if (lunchEnd !== null && failedAt <= lunchEnd) return lunchEnd;
  }
  return nyInstant(day, flatMinute(halfDay));
}

/** A failed break's lock (DEC-0053 section 1): the failed break's end, the failing bar's end and the lock's end. */
interface Lock {
  brokeAt: number;
  failedAt: number;
  until: number;
}

/**
 * DEC-0053 section 1, from the completed bars alone (oldest first). Walks every run of closes beyond the level from
 * the open. A run is a counted break when its first bar is not the session's first, the close before it is not
 * beyond and that bar ends exactly at its start (as `sideState`'s `ia`); one whose breaking bar ends at or before the
 * running lock's end is made inside the lock and is not counted. A counted break's run ended by a close at or through
 * the level is a failed break, and sets a lock from that bar's end (`lockUntil`). Returns the latest lock, and whether
 * the last run (the one `sideState` reads) was made inside it.
 */
function failedBreakLock(closed: readonly Bar2[], beyond: (x: number) => boolean, halfDay: boolean): { lock: Lock | null; lastInLock: boolean } {
  let lock: Lock | null = null;
  let run: { counted: boolean; inLock: boolean; brokeAt: number } | null = null;
  let lastInLock = false;
  for (let i = 0; i < closed.length; i++) {
    const b = closed[i]!;
    if (beyond(b.c)) {
      if (run !== null) continue;
      const p = i > 0 ? closed[i - 1]! : null;
      const counted: boolean = p !== null && !beyond(p.c) && p.end === b.start;
      const inLock: boolean = counted && lock !== null && b.end <= lock.until;
      run = { counted: counted && !inLock, inLock, brokeAt: b.end };
      lastInLock = inLock;
      continue;
    }
    if (run === null) continue;
    if (run.counted) {
      const until = lockUntil(b.end, halfDay);
      if (until !== null) lock = { brokeAt: run.brokeAt, failedAt: b.end, until };
    }
    run = null;
  }
  return { lock, lastInLock };
}

/** Why a side is missed (SideState.missedWhy). */
export type MissedWhy = "target" | "window" | "slot";

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
            best = { at: k, from: ia - 1, alt: { kind: "failed_break", side: altSide, level, stop, entry: closed[k]!.c, at: closed[k]!.start } };
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
        best = { at: k, from: k - 1, alt: { kind: "sweep_reclaim", side: altSide, level, stop: s > 0 ? sw.h : sw.l, entry: sw.c, at: sw.start } };
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
 *   or the retest touched and waits for its confirming close (`touchClose`), or the page is missing prices since the
 *   break (`gap`), or it broke before the page's bars;
 * - enter_zone (DEC-0052): the clone's retest (wt.options.setups.retest) completed on the page's bars: within
 *   MAX_BARS_TO_RETEST bars after the break bar, a bar's low comes within RETEST_WITHIN_ATR 2-minute ATRs of the level
 *   (the touch, the first such bar), and a later bar is the first after it to close above the touch bar's close (the
 *   confirming bar), at most MAX_BARS_TO_RETEST + 1 bars after the break bar. Each bar is read with the 2-minute ATR
 *   at its own close (atr2m of the bars up to it: the ATR the clone passes at that bar), and with no 2-minute ATR
 *   (`sweepAtr` null, or fewer than 15 bars) there is no touch. The break's first confirming bar governs: ENTER lasts
 *   RETEST_ENTER_SLOTS slots from its close (a later confirmation neither restarts nor extends them), while the price is above the level and has not run more than RETEST_WITHIN_ATR of those ATRs
 *   past the confirming close, nothing has reached target 1 since the break, every slot since the break is seen and
 *   the quote is fresh (back at the level with no close through it: get_ready, `confirmClose` kept). A confirming
 *   close inside the window keeps its slots past the window's end;
 * - missed: target 1 reached at any point after the break (a bar, the bar forming, the live price, or the quote's
 *   day high when the page's bars before the break do not show it), or the retest's window passed with no confirming
 *   close, or a confirmed retest's slots passed or the price ran past its confirming close (`slot`, for the rest of
 *   that break): don't chase;
 * - plan_off: after the break, a completed bar closes back at or below the level; and (DEC-0053) for the rest of the
 *   entry window after that failure (`failedBreakLock`: to 13:00 when the failing bar ends by 13:00 on a full day, else
 *   the flat time), whatever later bars do, on the failed break's `brokeAt` with `failedAt`;
 * - watch: none of these; or (DEC-0053) a lock has ended and the latest break was made inside it (`failedAt` kept,
 *   `brokeAt` null), until a fresh break.
 * DEC-0053: a confirmed retest on bars that do not cover the session from its open is get ready (`lockUnseen`), never
 * enter zone: a failure may be unseen. `halfDay` sets the lock's end.
 * The clone's invalidation_atr is not read: before an entry any close back through the level is plan off.
 */
export function sideState(
  plan: SidePlan | null,
  atr: number | null | undefined,
  bars: Bars2m,
  quote: LiveQuote | null | undefined,
  now: Date,
  sweepAtr: number | null = null,
  halfDay = false,
): SideState {
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
  const missed = (why: MissedWhy, brokeAt: number | null = null, brokeEarlier = false, extra: Partial<SideState> = {}) =>
    out("missed", { missedWhy: why, brokeAt, brokeEarlier, ...extra });

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
  // DEC-0053: a failed break locks the side for the rest of its entry window. While the lock runs the side is plan off
  // on the failed break, whatever later bars do; once it has ended, a break made inside it is ignored (watch) until a
  // fresh counted break, which arms as below. The failed break itself, once its lock has ended, reads as before.
  const { lock, lastInLock } = failedBreakLock(closed, beyond, halfDay);
  if (lock && t < lock.until) return out("plan_off", { brokeAt: lock.brokeAt, failedAt: lock.failedAt, lockEnd: lock.until });
  if (lock && lastInLock && ia >= 0) return out("watch", { failedAt: lock.failedAt });
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
  // DEC-0052: the clone's retest (setups.retest) on the page's bars. Bar k confirms when, read with the 2-minute ATR at
  // k's close (atr2m of the bars up to k, as the clone's Tape.atr), the first bar after the break bar to come within
  // RETEST_WITHIN_ATR of those ATRs of the level is at most MAX_BARS_TO_RETEST bars after it, and k is the first bar
  // after that touch to close beyond the touch bar's close; k at most MAX_BARS_TO_RETEST + 1 bars after the break bar.
  // Every close from the break on is beyond the level here (plan off above). The FIRST confirming bar governs the break
  // (each bar read with its own ATR, so it never moves as bars are added): its two slots, then missed for the rest of the
  // break, even when a later bar, read with a larger ATR, would confirm again (DEC-0052 section 2).
  const has2m = isNum(sweepAtr) && sweepAtr > 0;
  const atrAt = (k: number) => atr2m(closed.slice(0, k + 1));
  const near = (b: Bar2, a2: number) => (s > 0 ? b.l - L : L - b.h) <= RETEST_WITHIN_ATR * a2;
  const touchFor = (before: number, a2: number) => {
    for (let j = ia + 1; j < before; j++) if (near(closed[j]!, a2)) return j - ia <= MAX_BARS_TO_RETEST ? j : -1;
    return -1;
  };
  const awayFrom = (j: number, upTo: number) => {
    for (let m = j + 1; m <= upTo; m++) if ((closed[m]!.c - closed[j]!.c) * s > 0) return m;
    return -1;
  };
  const last = closed.length - 1;
  let conf: { k: number; touch: number; a2: number } | null = null;
  for (let k = ia + 2; has2m && k <= Math.min(last, ia + MAX_BARS_TO_RETEST + 1) && conf === null; k++) {
    const a2 = atrAt(k);
    if (a2 === null || !(a2 > 0)) continue;
    const j = touchFor(k, a2);
    if (j >= 0 && awayFrom(j, k) === k) conf = { k, touch: j, a2 };
  }
  if (conf) {
    const cb = closed[conf.k]!;
    const keep: Partial<SideState> = { touchClose: closed[conf.touch]!.c, confirmClose: cb.c, confirmAt: cb.end };
    // ENTER for the slot the confirming close opens and the next; then missed, don't chase
    if (t >= cb.end + RETEST_ENTER_SLOTS * BAR_MS) return missed("slot", brokeAt, false, keep);
    if (!coveredSince(bars, brk.start)) return out("get_ready", { brokeAt, gap: true });
    // past the confirming close by more than RETEST_WITHIN_ATR of its ATRs at any point since it: a chase
    const since = [...closed.slice(conf.k + 1), ...(bars.partial && bars.partial.start >= cb.end ? [bars.partial] : [])];
    const ran = (x: number | null | undefined) => isNum(x) && (x - cb.c) * s > RETEST_WITHIN_ATR * conf.a2;
    if (ran(reach(since, s)) || ran(price)) return missed("slot", brokeAt, false, keep);
    if (price === null) return out("get_ready", { brokeAt });
    // back at the level, no close through it yet: still the confirmed retest, wait for the price
    if (!beyond(price)) return out("get_ready", { brokeAt, ...keep });
    // DEC-0053: without the session from its open a failure may be unseen, so a confirmed retest is never an entry
    const day = nyClock(now.toISOString())?.day ?? null;
    const open = day !== null ? nyInstant(day, OPEN_MIN) : null;
    if (!bars.complete || open === null || !coveredSince(bars, open)) return out("get_ready", { brokeAt, lockUnseen: true, ...keep });
    return out("enter_zone", { brokeAt, ...keep });
  }
  // setups.retest's window: the bar forming now at most MAX_BARS_TO_RETEST + 1 bars after the break bar. The window's
  // last bar can still confirm while it is the bar forming (its end passed, not yet complete), so it waits for it.
  const lastWindowBar = brk.start + (MAX_BARS_TO_RETEST + 1) * BAR_MS;
  const lastStillForming = bars.partial !== null && bars.partial.start >= brk.end && bars.partial.start <= lastWindowBar;
  if ((slotOf(t) - brk.start) / BAR_MS > MAX_BARS_TO_RETEST + 1 && !lastStillForming) return missed("window", brokeAt);
  if (!coveredSince(bars, brk.start)) return out("get_ready", { brokeAt, gap: true });
  // touched with the 2-minute ATR now, not yet confirmed, and the next bar can still confirm it
  if (has2m && last >= ia + 1 && last + 1 <= ia + MAX_BARS_TO_RETEST + 1) {
    const a2 = atrAt(last);
    const j = a2 !== null && a2 > 0 ? touchFor(last + 1, a2) : -1;
    if (j >= 0 && awayFrom(j, last) < 0) return out("get_ready", { brokeAt, touchClose: closed[j]!.c });
  }
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
  /** Why the row says no trade, on a no-trade row only: the page tells a closed window from a quiet range by this. */
  why?: NoTradeWhy;
  /** The bad-data guards that paused the row (quote-guards.ts), on a row a switched-on guard paused only. */
  guards?: GuardReason[];
  /** DEC-0072: the row is paused because its symbol is not one of the desk's names; on such a row only. */
  offDesk?: true;
}

/**
 * Why a row says no trade: the session closed (or the next not begun), the opening range, the lunch block, after the
 * flat time, the day's limit, the middle of yesterday's range, or no plan for the name.
 */
export type NoTradeWhy = "closed" | "opening" | "lunch" | "late" | "day_limit" | "range_middle" | "no_plan";

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
  /**
   * The bad-data guards switched on (desk-guards.ts). Missing or empty: no guard is read at all, and the row is exactly
   * what it was before the guards existed.
   */
  guardsOn?: readonly GuardReason[];
  /**
   * The snapshot quote the guards read, when it is not `quote`: the server evaluator's `quote` is built from its bars
   * (desk-eval's settledQuote), so it passes the snapshot itself, the one the page's quote route also reads. Missing:
   * `quote` (the page). Null: no snapshot, and no guard can trip.
   */
  guardQuote?: LiveQuote | null;
}

const altLine = (x: AltTrigger) =>
  x.kind === "failed_break"
    ? `Failed break: ${x.side} ${x.side === "put" ? "under" : "over"} ${p2(x.level)}, stop ${x.side === "put" ? "above" : "below"} ${p2(x.stop)} (push ${x.side === "put" ? "high" : "low"}) · testing`
    : `Sweep and reclaim: ${x.side} ${x.side === "call" ? "above" : "below"} ${p2(x.level)}, stop ${x.side === "call" ? "below" : "above"} ${p2(x.stop)} (sweep ${x.side === "call" ? "low" : "high"}) · testing`;

/** The New York HH:MM of an instant (ms), "?" when it cannot be read. */
const hhmmAt = (ms: number) => {
  const c = nyClock(new Date(ms).toISOString());
  return c ? hhmm(c.minutes) : "?";
};

/** True when the side is locked by a failed break (DEC-0053): plan off with the failure's time. */
const isLocked = (x: SideState) => x.state === "plan_off" && x.failedAt !== undefined;

/** DEC-0053 section 2: "Failed at <time>: no <call|put> until <the lock's end>". */
function lockLine(x: SideState, halfDay: boolean): string {
  const until = x.lockEnd ?? (x.failedAt !== undefined ? lockUntil(x.failedAt, halfDay) : null);
  return `Failed at ${x.failedAt !== undefined ? hhmmAt(x.failedAt) : "?"}: no ${x.side} until ${until !== null ? hhmmAt(until) : "?"}`;
}

/** The locks on a name's sides, the earlier failure first (DEC-0053 section 2). */
export const locksOf = (sides: readonly SideState[], halfDay: boolean) =>
  sides
    .filter(isLocked)
    .sort((a, b) => a.failedAt! - b.failedAt!)
    .map((x) => lockLine(x, halfDay));

function sideLine(x: SideState, plan: SidePlan, halfDay = false): string {
  const L = p2(plan.level);
  const up = plan.side === "call";
  const over = up ? "above" : "below";
  const back = up ? "Fell back below" : "Rose back above";
  switch (x.state) {
    case "enter_zone": {
      const limit = plan.entry !== null ? ` limit ~${p2(plan.entry)}` : "";
      const stop = plan.stop !== null ? ` · stop ${p2(plan.stop)} / −25%` : "";
      const target = plan.target1 !== null ? ` · target ${p2(plan.target1)}` : "";
      const c = x.confirmClose;
      const risk = c !== undefined ? retestRisk(c, plan.side, plan.entry, plan.stop) : null;
      return `Retest confirmed ${c !== undefined ? `at ${p2(c)}` : `${over} ${L}`}: ${plan.side}${limit}${stop}${target}${risk ? ` · ${risk}` : ""}`;
    }
    case "get_ready":
      if (x.lockUnseen) return `Confirm on your chart: the board has not seen the session from its open${x.confirmClose !== undefined ? ` (retest confirmed at ${p2(x.confirmClose)})` : ""}`;
      if (x.brokeEarlier) return `Broke ${over} ${L} before you opened the page: confirm the hold on your chart`;
      if (x.gap) return `Broke ${over} ${L}, but the page missed prices since: confirm on your chart`;
      if (x.waitingClose) return `${up ? "Above" : "Below"} ${L}: wait for a 2-min close ${over} it`;
      if (x.confirmClose !== undefined) return `Retest confirmed at ${p2(x.confirmClose)}: price back at ${L}, wait`;
      if (x.touchClose !== undefined) return `Retest touched: wait for a 2-minute close ${over} ${p2(x.touchClose)}`;
      if (x.brokeAt !== null) return `Broke ${over} ${L}: wait for a dip that holds it`;
      return `Back at ${L}: wait for the 2-min close`;
    case "plan_off":
      // DEC-0053: a locked side says its lock; an alternative trigger's line comes first
      if (isLocked(x)) return x.alt ? `${altLine(x.alt)} · ${lockLine(x, halfDay)}` : lockLine(x, halfDay);
      return `${back} ${L}: ${plan.side} plan off${x.alt ? ` · ${altLine(x.alt)}` : ""}`;
    case "missed":
      if (x.missedWhy === "window") return `Retest window at ${L} passed: don't chase`;
      if (x.missedWhy === "slot") return `Retest confirmed at ${confirmHhmm(x)}: missed, don't chase`;
      return plan.target1 !== null ? `Already past target 1 (${p2(plan.target1)}): don't chase` : `Ran ${over} ${L}: don't chase`;
    default:
      return x.alt ? altLine(x.alt) : `${up ? "Calls above" : "Puts below"} ${L}`;
  }
}

/**
 * DEC-0052's risk line beside a confirmed retest's ENTER: how far the confirming close is past the card's entry, and
 * the distance from it to the card's stop against the card's own entry-to-stop distance, to the cent. Wording only:
 * the card's entry, stop and target 1 are unchanged. Null without the card's entry or stop. A confirming close short
 * of the card's entry (between the level and it) says "short of", never "past".
 */
export function retestRisk(confirmClose: number, side: Side, entry: number | null, stop: number | null): string | null {
  if (!isNum(confirmClose) || !isNum(entry) || !isNum(stop)) return null;
  const past = (confirmClose - entry) * (side === "call" ? 1 : -1) >= 0 ? "past" : "short of";
  return `${p2(confirmClose)} is $${p2(Math.abs(confirmClose - entry))} ${past} the card entry; to the stop $${p2(Math.abs(confirmClose - stop))}, not $${p2(Math.abs(entry - stop))}`;
}

/** The confirming close's time, HH:MM New York (DEC-0052's missed line). */
const confirmHhmm = (x: SideState) => {
  const c = x.confirmAt !== undefined ? nyClock(new Date(x.confirmAt).toISOString()) : null;
  return c ? hhmm(c.minutes) : "?";
};

const dist = (x: SideState) => (x.distAtr !== null ? ` (${x.distAtr.toFixed(1)} ATR)` : "");

/**
 * The one row for a focus name. `n.now` is the feed's (server) clock. In order: a stale feed in the session pauses
 * it, and so does a switched-on bad-data guard that trips (quote-guards.ts); before 09:35 (FIRST_ENTRY_MIN), from 11:30 to 13:00 on a full day, from the flat time (15:10, or 50 minutes before a half day's 13:00 close: 12:10) or with the
 * day's limit used it is no trade; with the price in the
 * middle third of yesterday's range and nothing broken, no trade; otherwise the more urgent side: enter zone, then a
 * live alternative trigger, get ready, watch, plan off and missed. A side locked by a failed break (DEC-0053) is said
 * on the row whichever side it leads with: "Failed at <time>: no <side> until <time>", the earlier failure first, after
 * the locked side's alternative trigger when it has one.
 */
/** DEC-0072: the desk's names, the only ones the board may act on (market-calendar.json `options_names`). */
const DESK_NAMES: ReadonlySet<string> = new Set((calendar.options_names as string[]).map((x) => x.toUpperCase()));
const OFF_DESK_LINE = "Not one of the desk's names: its earnings and expiry facts are not on file";

export function nameState(n: NameInput): NameState {
  const call = sideState(n.call, n.atr, n.bars, n.quote, n.now, n.sweepAtr ?? null, n.halfDay);
  const put = sideState(n.put, n.atr, n.bars, n.quote, n.now, n.sweepAtr ?? null, n.halfDay);
  const plans = { call: n.call, put: n.put };
  const t = n.now.getTime();
  const clock = nyClock(n.now.toISOString());
  const minute = clock && clock.day === n.session ? clock.minutes : null;
  const flat = flatMinute(n.halfDay);
  const inSession = minute !== null && minute >= OPEN_MIN && minute < closeMinute(n.halfDay);
  const q = n.quote && n.quote.day === n.session ? n.quote : null;
  const triggers = [n.put, n.call].filter((x): x is SidePlan => x !== null).map((x) => p2(x.level));
  const row = (state: NameStateName, line: string, pick: SideState | null, rankExtra = 0, why?: NoTradeWhy): NameState => {
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
    const active = pick && state !== "paused" && state !== "no_trade";
    const clone: CheckResult = active ? entryChecks(checkIn, pick.alt && pick.state !== "enter_zone" && pick.state !== "get_ready" ? pick.alt.side : pick.side) : { cautions: [], unknown: [] };
    // The desk's own caution (09:35 to 10:00) goes after the clone-mirroring checks, computed apart from them.
    // The desk's own caution (09:35 to 10:00) comes after the clone-mirroring checks and is never cut by the cap.
    const desk = active ? deskCautions(n.now, n.halfDay, FIRST_ENTRY_MIN) : [];
    const checks: CheckResult = { ...clone, cautions: [...clone.cautions.slice(0, MAX_CAUTIONS_SHOWN), ...desk] };
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
      cautions: checks.cautions,
      moreCautions: Math.max(0, clone.cautions.length - MAX_CAUTIONS_SHOWN),
      unknown: checks.unknown,
      rank: (pick ? sideRank(pick) : STATE_RANK[state]) * 1000 + rankExtra,
      call,
      put,
      ...(why ? { why } : {}),
    };
  };

  // 0. DEC-0072: a name that is not one of the desk's (the calendar's options_names, built from
  // config/options_desk.yaml) is paused, always and first: its earnings and expiry facts are not on file, so no state
  // that could suggest an entry is ever reached for it. No switch turns this off.
  if (!DESK_NAMES.has(n.symbol.toUpperCase())) return { ...row("paused", OFF_DESK_LINE, null), offDesk: true };
  // 1. a stale feed in the session
  if (inSession) {
    const feedAge = n.receivedAt !== null ? t - n.receivedAt : Infinity;
    const tradeAge = q ? t - Date.parse(q.at) : Infinity;
    if (!q || feedAge > FEED_STALE_MS || !(tradeAge <= TRADE_STALE_MS)) {
      const age = feedAge > FEED_STALE_MS ? feedAge : tradeAge;
      const line = Number.isFinite(age) ? `No new price for ${Math.round(age / 1000)} s: check your platform` : "No price yet: check your platform";
      return row("paused", line, null);
    }
    // 1b. a switched-on bad-data guard: a check of the data's validity like the stale one, so it sits with it, after it
    // (a stale or missing price says so first) and before the clock gates and every state that could suggest an entry.
    if (n.guardsOn && n.guardsOn.length > 0) {
      const gq = n.guardQuote === undefined ? q : n.guardQuote && n.guardQuote.day === n.session ? n.guardQuote : null;
      const tripped = activeGuards(quoteGuards(gq, { today: n.session, now: t }), n.guardsOn);
      if (tripped.length > 0) return { ...row("paused", guardLine(tripped), null), guards: tripped };
    }
  }
  // 2. the clock and the day's limit
  const opening = `Opening range forming: first entries from ${hhmm(FIRST_ENTRY_MIN)}`;
  if (minute === null) return row("no_trade", clock && clock.day < n.session ? `Next session: first entries from ${hhmm(FIRST_ENTRY_MIN)}` : "Session closed", null, 0, "closed");
  if (minute >= closeMinute(n.halfDay)) return row("no_trade", "Session closed", null, 0, "closed");
  if (minute < FIRST_ENTRY_MIN) return row("no_trade", opening, null, 0, "opening");
  if (lunchBlock(n.halfDay) && minute >= LUNCH_FROM_MIN && minute < LUNCH_TO_MIN)
    return row("no_trade", `No new entries ${hhmm(LUNCH_FROM_MIN)}–${hhmm(LUNCH_TO_MIN)} New York: next entries from ${hhmm(LUNCH_TO_MIN)}`, null, 0, "lunch");
  if (minute >= flat) return row("no_trade", `After ${hhmm(flat)}: no new entries, be flat`, null, 0, "late");
  if (n.dayLimitUsed) return row("no_trade", "Day limit reached: no more trades today", null, 0, "day_limit");

  // 3. the middle of yesterday's range with nothing broken
  const pdh = levelOf(n.ticker, "PDH");
  const pdl = levelOf(n.ticker, "PDL");
  const quiet = (x: SideState) => (x.state === "watch" || x.state === "no_trade") && !x.brokeEarlier && !x.alt;
  if (q && pdh !== null && pdl !== null && midThird(q.price, pdh, pdl) && quiet(call) && quiet(put))
    return row("no_trade", `In the middle of yesterday's range: wait for ${triggers.join(" or ")}`, null, 0, "range_middle");

  // 4. the more urgent side
  const sides = [call, put].filter((x) => plans[x.side] !== null);
  if (sides.length === 0) return row("no_trade", "No plan for this name today", null, 0, "no_plan");
  const pick = [...sides].sort((x, y) => sideRank(x) - sideRank(y) || (x.distAtr ?? Infinity) - (y.distAtr ?? Infinity))[0]!;
  const tenths = pick.distAtr !== null ? Math.min(999, Math.round(pick.distAtr * 10)) : 999;
  // DEC-0053: a locked side's lock is said on the row whichever side it leads with, the earlier failure first
  const locks = locksOf(sides, n.halfDay);
  if (pick.state === "watch" && !pick.alt) {
    const line = [
      ...locks,
      ...sides
        .filter((x) => !isLocked(x) && (x.state === "watch" || x.state === "plan_off" || x.state === "missed"))
        .map((x) => {
          const plan = plans[x.side]!;
          const who = plan.side === "call" ? "Calls" : "Puts";
          if (x.state === "missed" && x.missedWhy === "window") return `${who}: retest window at ${p2(plan.level)} passed, don't chase`;
          if (x.state === "missed" && x.missedWhy === "slot") return `${who}: retest confirmed at ${confirmHhmm(x)}, missed, don't chase`;
          if (x.state === "missed") return `${who} past target 1${plan.target1 !== null ? ` (${p2(plan.target1)})` : ""}: don't chase`;
          return `${sideLine({ ...x, state: "watch", alt: null }, plan, n.halfDay)}${dist(x)}`; // a side whose plan is off waits for a new break
        }),
    ].join(" · ");
    return row("watch", line, pick, tenths);
  }
  // a locked side leading the row: its alternative trigger's line (if any), then every lock
  if (isLocked(pick)) {
    // DEC-0053 section 2: the lock is said beside the other side's line, never in place of it
    const others = sides.filter((x) => x !== pick && !isLocked(x) && x.state !== "no_trade").map((x) => `${sideLine(x, plans[x.side]!, n.halfDay)}${dist(x)}`);
    return row(pick.state, [...(pick.alt ? [altLine(pick.alt)] : []), ...locks, ...others].join(" · "), pick, tenths);
  }
  return row(pick.state, [sideLine(pick, plans[pick.side]!, n.halfDay), ...locks].join(" · "), pick, tenths);
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
 * The session's 2-minute bars from the server (`/api/bars`) joined to the page's own (bars2m of the price trail).
 * `fetchedAt` is when the server read its bars upstream (ms, the server's clock): a server bar counts only if it had
 * ended at least SERVER_SETTLE_MS before that, so a bar still forming (or not yet holding its last minute upstream)
 * when the server read it is never taken as a completed close. Null (unknown) uses no server bar. The server wins every slot it has a completed bar for: it saw
 * every print since 09:30, the page only the ones it polled. The trail fills every other slot (a hole inside the
 * server's range, the slots after its last one) and supplies the bar still forming. `since` is the earlier of the two
 * first bars, so a page that has the server's bars from the open reads as having seen the whole session. `missing`
 * holds the slots from `since` with no bar in either: those between the bars, and the trail's own after its last bar.
 */
export function mergeBars(serverBars: readonly Bar2[], trail: Bars2m, fetchedAt: number | null): Bars2m {
  if (fetchedAt === null || !isNum(fetchedAt)) return trail;
  const cut = fetchedAt - SERVER_SETTLE_MS;
  const bySlot = new Map<number, Bar2>();
  for (const b of serverBars)
    if (isNum(b.start) && isNum(b.end) && isNum(b.o) && isNum(b.h) && isNum(b.l) && isNum(b.c) && b.end <= cut) bySlot.set(b.start, { ...b });
  if (bySlot.size === 0) return trail;
  const serverFirst = Math.min(...bySlot.keys());
  for (const b of trail.closed) if (!bySlot.has(b.start)) bySlot.set(b.start, { ...b });
  const closed = [...bySlot.values()].sort((a, b) => a.start - b.start);
  const lastClosed = closed[closed.length - 1]!.start;
  const partial = trail.partial && trail.partial.start > lastClosed ? { ...trail.partial } : null;
  const since = Math.min(serverFirst, ...(isNum(trail.since) ? [trail.since] : []));
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
