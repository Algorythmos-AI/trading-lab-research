// The "Trade now" decision engine for the Options desk: one state, one sentence and one next action per focus name,
// worked out from the focus plan's levels and the live prices the page polls. Advisory and read-only: nothing here
// places an order, and the 9 rules are unchanged.
//
// Pure: no I/O and no clock. The caller passes `now`. Times are New York through options.ts (nyClock, nyInstant,
// OPEN_MIN, closeMinute), so the daylight-saving changes need nothing here.
//
// A break counts only on a completed 2-minute close beyond the level, the focus card's own rule: a single print never
// moves the state. The page can only build bars from the prices it has seen since it opened, so for anything earlier
// it reads the quote's day high and low and says so (`brokeEarlier`, `since`).
import {
  type CheckInput,
  type Caution,
  entryChecks,
  FAIL_WITHIN_BARS,
  levelOf,
  midThird,
  type Side,
  SWEEP_MIN_ATR,
} from "./entry-checks";
import type { SidePlan } from "./focus-plan";
import type { Tone } from "./labels";
import { closeMinute, type LiveQuote, nyClock, nyInstant, OPEN_MIN, type OptionsTicker, type TrailPoint } from "./options";
import { TIME_STOP_MINUTES } from "./trade-rules";

// ---- constants ------------------------------------------------------------------------------------------------------
/** The bar the states are read on, in minutes (rule 2's 2-minute close). */
export const BAR_MINUTES = 2;
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
/** The quote's last trade is stale after this long. */
export const TRADE_STALE_MS = 120_000;
/** Cautions shown on a row; the rest are counted. */
export const MAX_CAUTIONS_SHOWN = 2;

/** The minute (New York) to be flat by, and after which no new entry is suggested. */
export function flatMinute(halfDay: boolean): number {
  return halfDay ? closeMinute(true) - HALF_DAY_FLAT_BEFORE_CLOSE : FLAT_MIN;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const p2 = (v: number) => v.toFixed(2);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

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
  /** Completed bars (end <= now), oldest first. */
  closed: Bar2[];
  /** The bar still forming, if the page has a price in it. */
  partial: Bar2 | null;
  /** The first price the page saw (ms): there are no bars before it ("since you opened the page"). */
  since: number | null;
}

/**
 * 2-minute bars from the polled price trail, aligned to :00, :02, ... New York (the New York offset is whole hours,
 * so the epoch's 2-minute grid is New York's). Only prices inside the regular session of their own day are used. The
 * quote's own trade is added when it is newer than the trail. A 2-minute slot with no price has no bar.
 */
export function bars2m(trail: readonly TrailPoint[], quote: LiveQuote | null | undefined, now: Date, halfDay = false): Bars2m {
  const pts = trail.filter((x) => isNum(x.at) && isNum(x.p) && x.p > 0).map((x) => ({ at: x.at, p: x.p }));
  const qa = quote ? Date.parse(quote.at) : NaN;
  if (quote && Number.isFinite(qa) && isNum(quote.price) && (pts.length === 0 || qa > pts[pts.length - 1]!.at)) pts.push({ at: qa, p: quote.price });
  pts.sort((a, b) => a.at - b.at);
  const t = now.getTime();
  const inSession = (at: number) => {
    const c = nyClock(new Date(at).toISOString());
    if (!c) return false;
    const open = nyInstant(c.day, OPEN_MIN);
    const close = nyInstant(c.day, closeMinute(halfDay));
    return open !== null && close !== null && at >= open && at < close && at <= t;
  };
  const used = pts.filter((x) => inSession(x.at));
  const bars: Bar2[] = [];
  for (const x of used) {
    const start = Math.floor(x.at / BAR_MS) * BAR_MS;
    const last = bars[bars.length - 1];
    if (last && last.start === start) {
      last.h = Math.max(last.h, x.p);
      last.l = Math.min(last.l, x.p);
      last.c = x.p;
    } else bars.push({ start, end: start + BAR_MS, o: x.p, h: x.p, l: x.p, c: x.p });
  }
  const closed = bars.filter((b) => b.end <= t);
  const open = bars.filter((b) => b.end > t);
  return { closed, partial: open[open.length - 1] ?? null, since: used[0]?.at ?? null };
}

/** Exponential average seeded with the simple mean of the first `n` values (regime.ema); null with fewer than `n`. */
export function ema(values: readonly number[], n: number): number | null {
  if (n < 1 || values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (const x of values.slice(n)) e = x * k + e * (1 - k);
  return e;
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
  /** The quote's day high (or low) crossed the level, but the page has no bars for it. */
  brokeEarlier: boolean;
  /** No completed close beyond the level yet; the live price is beyond it. */
  waitingClose: boolean;
  /** The break the state comes from, as the bar's end (ms), when the page saw it. */
  brokeAt: number | null;
  alt: AltTrigger | null;
  /** ATRs from the live price to the level; null without a price or an ATR. */
  distAtr: number | null;
}

/** The furthest price reached (highest for a call, lowest for a put) over some bars. */
const reach = (bars: readonly Bar2[], s: 1 | -1) => (bars.length ? (s > 0 ? Math.max(...bars.map((b) => b.h)) : Math.min(...bars.map((b) => b.l))) : null);

/**
 * The live alternative triggers at a level, the opposite side to the plan there. Mirrors the clone's two shadow arms
 * (HYP-0046 failed break, HYP-0047 sweep and reclaim), with the page's bars instead of the session's:
 * - failed break: bar A closes beyond the level with the close before it not beyond; within FAIL_WITHIN_BARS bars
 *   after A, a bar is the first to close back inside (strictly). Entry: that close; stop: the extreme from A on.
 * - sweep and reclaim: the bar before closed at or inside the level; one bar reaches at least SWEEP_MIN_ATR ATRs
 *   past it and closes at or inside it. Entry: that close; stop: that bar's extreme.
 * Either stays live until a later completed close goes back past the level. The latest one wins.
 */
export function altAt(level: number, planSide: Side, closed: readonly Bar2[], atr: number | null): AltTrigger | null {
  const s = planSide === "call" ? 1 : -1; // the side of the level the plan breaks to
  const altSide: Side = planSide === "call" ? "put" : "call";
  const beyond = (x: number) => (x - level) * s > 0;
  const inside = (x: number) => (x - level) * s < 0;
  let best: { at: number; alt: AltTrigger } | null = null;
  const last = closed.length - 1;
  for (let k = 1; k <= last; k++) {
    // failed break completed by bar k
    if (inside(closed[k]!.c)) {
      for (let ia = k - 1; ia >= Math.max(k - FAIL_WITHIN_BARS, 1); ia--) {
        if (beyond(closed[ia]!.c) && !beyond(closed[ia - 1]!.c)) {
          if (!closed.slice(ia + 1, k).some((b) => inside(b.c))) {
            const span = closed.slice(ia, k + 1);
            const stop = s > 0 ? Math.max(...span.map((b) => b.h)) : Math.min(...span.map((b) => b.l));
            best = { at: k, alt: { kind: "failed_break", side: altSide, level, stop, entry: closed[k]!.c } };
          }
          break;
        }
      }
    }
    // sweep and reclaim completed by bar k
    if (atr !== null && atr > 0) {
      const pre = closed[k - 1]!;
      const sw = closed[k]!;
      const far = s > 0 ? sw.h - level : level - sw.l;
      if (!beyond(pre.c) && far >= SWEEP_MIN_ATR * atr && !beyond(sw.c))
        best = { at: k, alt: { kind: "sweep_reclaim", side: altSide, level, stop: s > 0 ? sw.h : sw.l, entry: sw.c } };
    }
  }
  if (!best) return null;
  // ended by a later completed close back past the level
  if (closed.slice(best.at + 1).some((b) => beyond(b.c))) return null;
  return best.alt;
}

/**
 * One side's state from its focus plan (call: break up through the ceiling; put: down through the floor), the ATR,
 * the page's 2-minute bars and the quote. Call side (the put is the mirror):
 * - break: a completed bar closes above the level (the close before it, or the bar's own open, not above);
 * - get_ready: the price is above the level with no completed close above yet, or it broke and waits for the dip;
 * - enter_zone: after the break, a later bar's low comes within RETEST_ATR ATRs of the level (or through it) and
 *   closes above; it stays while the price is at or above the level and below target 1;
 * - missed: target 1 reached after the break without that dip, or after it: don't chase;
 * - plan_off: after the break, a completed bar closes back at or below the level;
 * - watch: none of these.
 */
export function sideState(plan: SidePlan | null, atr: number | null | undefined, bars: Bars2m, quote: LiveQuote | null | undefined, now: Date, sweepAtr: number | null = null): SideState {
  const side: Side = plan?.side ?? "call";
  const a = isNum(atr) && atr > 0 ? atr : null;
  const base = { side, brokeEarlier: false, waitingClose: false, brokeAt: null, alt: null, distAtr: null };
  if (!plan) return { ...base, state: "no_trade", level: null };
  const L = plan.level;
  const s = plan.side === "call" ? 1 : -1;
  const beyond = (x: number) => (x - L) * s > 0;
  const price = quote && isNum(quote.price) ? quote.price : null;
  const distAtr = price !== null && a ? Math.abs(price - L) / a : null;
  const closed = bars.closed.filter((b) => b.end <= now.getTime());
  // The sweep is measured in the 2-minute bars' own ATR, as the clone measures it; without one it is not looked for.
  const alt = altAt(L, plan.side, closed, isNum(sweepAtr) && sweepAtr > 0 ? sweepAtr : null);
  const t1 = plan.target1;
  const pastT1 = (x: number | null) => x !== null && t1 !== null && (x - t1) * s >= 0;
  const out = (state: SideStateName, extra: Partial<SideState> = {}): SideState => ({ ...base, state, level: L, alt, distAtr, ...extra });

  // the most recent break the page saw
  let ia = -1;
  for (let i = closed.length - 1; i >= 0; i--) {
    const prev = i > 0 ? closed[i - 1]!.c : closed[i]!.o;
    if (beyond(closed[i]!.c) && !beyond(prev)) {
      ia = i;
      break;
    }
  }
  // the page opened with the price already beyond (its first bar opened beyond): the break came before it
  const openedBeyond = closed.length > 0 && beyond(closed[0]!.o) && closed.every((b) => beyond(b.c));
  const dayExtreme = quote ? (s > 0 ? quote.high : quote.low) : null;
  const dayCrossed = isNum(dayExtreme) && beyond(dayExtreme);
  const seen = [...closed, ...(bars.partial ? [bars.partial] : [])];
  const seenBeyond = seen.some((b) => beyond(s > 0 ? b.h : b.l)) || (price !== null && beyond(price));

  if (ia < 0) {
    if (openedBeyond || (dayCrossed && !seenBeyond)) {
      // Broke before the page's bars: never claim a dip from bars the page does not have.
      if (price !== null && beyond(price)) return out(pastT1(dayExtreme ?? null) ? "missed" : "get_ready", { brokeEarlier: true });
      return out("watch", { brokeEarlier: true });
    }
    if (price !== null && beyond(price)) return out("get_ready", { waitingClose: true });
    return out("watch");
  }

  const brokeAt = closed[ia]!.end;
  const after = closed.slice(ia + 1);
  if (after.some((b) => !beyond(b.c))) return out("plan_off", { brokeAt });
  const live = [...after, ...(bars.partial ? [bars.partial] : [])];
  const near = a !== null ? RETEST_ATR * a : null;
  const touch = near === null ? -1 : after.findIndex((b) => (s > 0 ? b.l - L : L - b.h) <= near);
  if (touch < 0) {
    const far = reach([closed[ia]!, ...live], s);
    if (pastT1(far) || pastT1(price)) return out("missed", { brokeAt });
    return out("get_ready", { brokeAt });
  }
  // target 1 reached before the dip: missed
  if (pastT1(reach([closed[ia]!, ...after.slice(0, touch)], s))) return out("missed", { brokeAt });
  if (price === null) return out("get_ready", { brokeAt });
  if (pastT1(price)) return out("missed", { brokeAt });
  if ((price - L) * s >= 0) return out("enter_zone", { brokeAt });
  return out("get_ready", { brokeAt, waitingClose: false });
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
  /** Browser time (ms) of the feed's last answer. */
  receivedAt: number | null;
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
      if (x.waitingClose) return `${up ? "Above" : "Below"} ${L}: wait for a 2-min close ${over} it`;
      if (x.brokeAt !== null) return `Broke ${over} ${L}: wait for a dip that holds it`;
      return `Back at ${L}: wait for the 2-min close`;
    case "plan_off":
      return `${back} ${L}: ${plan.side} plan off${x.alt ? ` · ${altLine(x.alt)}` : ""}`;
    case "missed":
      return plan.target1 !== null ? `Already past target 1 (${p2(plan.target1)}): don't chase` : `Ran ${over} ${L}: don't chase`;
    default:
      return x.alt ? altLine(x.alt) : `${up ? "Calls above" : "Puts below"} ${L}`;
  }
}

const dist = (x: SideState) => (x.distAtr !== null ? ` (${x.distAtr.toFixed(1)} ATR)` : "");

/**
 * The one row for a focus name. In order: a stale feed in the session pauses it; before 10:00, from the flat time
 * (15:10, or 20 minutes before a half day's close) or with the day's limit used it is no trade; with the price in the
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
        if (x.state === "missed")
          return `${plan.side === "call" ? "Calls" : "Puts"} past target 1${plan.target1 !== null ? ` (${p2(plan.target1)})` : ""}: don't chase`;
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
  /** Seconds left before rule 6's check; 0 once due and not working; null once it no longer applies. */
  notWorkingSecLeft: number | null;
  /** Minutes to the flat time (never below 0). */
  minToFlat: number | null;
}

/**
 * The Manage card's one instruction, the most urgent first: a completed 2-minute close beyond the stop, a close
 * beyond the trail after target 1, the flat time, target 1 just hit (sell half, stop to the entry), rule 6 (5 minutes
 * in and the underlying not past the entry), then the trail or the plan to hold.
 */
export function manage(entry: Entry, plan: SidePlan | null, bars: Bars2m, quote: LiveQuote | null | undefined, now: Date, halfDay: boolean): Manage {
  const s = entry.side === "call" ? 1 : -1;
  const t = now.getTime();
  const at = Date.parse(entry.at);
  const price = quote && isNum(quote.price) ? quote.price : null;
  const t1 = plan?.target1 ?? null;
  const since = bars.closed.filter((b) => b.end > at && b.end <= t);
  const live = [...since, ...(bars.partial && bars.partial.end > at ? [bars.partial] : [])];
  // target 1: the first bar (or the live price) that reached it
  const hitIdx = t1 === null ? -1 : live.findIndex((b) => ((s > 0 ? b.h : b.l) - t1) * s >= 0);
  const hit = t1 !== null && (hitIdx >= 0 || (price !== null && (price - t1) * s >= 0));
  const stop = hit ? entry.price : (plan?.stop ?? null);
  const closesAfterHit = hit && hitIdx >= 0 ? since.slice(hitIdx + 1) : [];
  const trailRaw = hit ? ema(bars.closed.filter((b) => b.end <= t).map((b) => b.c), EMA_FAST) : null;
  const trail = trailRaw !== null ? Math.round(trailRaw * 100) / 100 : null;

  const clock = nyClock(now.toISOString());
  const flat = flatMinute(halfDay);
  const minToFlat = clock ? Math.max(0, flat - clock.minutes) : null;
  const elapsed = Number.isFinite(at) ? (t - at) / 1000 : null;
  const working = price !== null && (price - entry.price) * s > 0;
  const windowS = TIME_STOP_MINUTES * 60;
  const notWorkingSecLeft = hit || elapsed === null ? null : elapsed < windowS ? Math.ceil(windowS - elapsed) : working ? null : 0;
  const base = { stop, target1: t1, trail, notWorkingSecLeft, minToFlat };
  const word = s > 0 ? "Below" : "Above";

  // the plan's stop until target 1, the entry after it; any completed close beyond it since then ends the trade
  const stopped = stop !== null && (hit ? closesAfterHit : since).some((b) => (b.c - stop) * s < 0);
  if (stopped) return { ...base, line: `${word} the stop ${p2(stop)}: exit`, tone: "bad" };
  if (hit && trail !== null && closesAfterHit.length > 0) {
    const lc = closesAfterHit[closesAfterHit.length - 1]!;
    if ((lc.c - trail) * s < 0) return { ...base, line: `${s > 0 ? "Under" : "Over"} the trail ${p2(trail)}: exit`, tone: "bad" };
  }
  if (minToFlat !== null && clock && clock.minutes >= flat) return { ...base, line: `${hhmm(flat)}: flat`, tone: "bad" };
  if (hit && closesAfterHit.length === 0) return { ...base, line: `Target 1 hit: sell half, stop to ${p2(entry.price)}`, tone: "good" };
  if (notWorkingSecLeft === 0) return { ...base, line: `${TIME_STOP_MINUTES} min, not working: exit`, tone: "bad" };
  if (hit && trail !== null) return { ...base, line: `Trail ${p2(trail)}: exit on a 2-min close ${s > 0 ? "under" : "over"} it`, tone: "info" };
  if (hit) return { ...base, line: `Stop at ${p2(entry.price)}: trail starts after ${EMA_FAST} bars`, tone: "info" };
  const parts = [stop !== null ? `stop ${p2(stop)}` : null, t1 !== null ? `target 1 ${p2(t1)}` : null].filter(Boolean);
  return { ...base, line: parts.length ? `Holding: ${parts.join(" · ")}` : "Holding: confirm the stop on your chart", tone: "info" };
}
