// Flow measures for the Options page (B1): the session's VWAP per name, where a price sits against it, relative
// volume against a 20-session baseline, one bar's volume surge, and the stock's bid/ask spread. Data and arithmetic
// only: nothing here draws, alerts, or changes a trading rule, and nothing reads the engine's states.
//
// Pure: no I/O and no clock; the caller passes the instant. Browser-safe. Every input that is missing or unusable gives
// null with a reason, never a number. Volume comes from the board's own feed, SIP (DEC-0050); a baseline names its feed.
//
// Slots are 2-minute bars counted from 09:30 New York: slot k starts k x 2 minutes after the day's open instant, which
// nyInstant works out per New York day, so a session on either side of a clock change has its slot 0 at 09:30 New
// York. A full session has 195 slots; a half day (13:00 close) has 105. A bar counts as completed SERVER_SETTLE_MS
// after it ends (trade-state.ts): an upstream bar may not yet hold its last minute a few seconds after the slot.
//
// The clock is the server's, never the device's: a client builds its SlotClock from the /api/flow answer's `as_of`
// with slotClockFromAsOf. A device clock running ahead would count slots the answer's bars cannot hold yet.
import { addDays, nyNow, type SessionDay, sessionOf } from "./market-calendar";
import { SYMBOL_RE } from "./desk-eval";
import { nyInstant } from "./options";
import { BAR_MINUTES, FIRST_ENTRY_MIN, SERVER_SETTLE_MS } from "./trade-state";

/** One 2-minute slot, ms. */
export const SLOT_MS = BAR_MINUTES * 60_000;
/** Slots in a full session, 09:30 to 16:00 New York. */
export const FULL_SESSION_SLOTS = 195;
/** Full sessions a baseline is built from. */
export const BASELINE_SESSIONS = 20;
/** Fewer sessions than this for a name and its baseline is too thin to compare against. */
export const MIN_BASELINE_SESSIONS = 10;
/** The narrowest dead band around VWAP, basis points. */
export const VWAP_BAND_MIN_BPS = 3;
/**
 * The baseline document's version. 2 adds each name's per-slot median bar range (`range_median`), which DEC-0051's
 * shock gate reads; a stored version 1 still parses and simply has no ranges, so that gate reads "not available".
 */
export const BASELINE_V = 2;
/** On a half day, the last this many slots run into the closing auction and are not compared with ordinary volume. */
export const HALF_DAY_CLOSE_SLOTS = 5;

/** A 2-minute stock bar with its volume. Not the engine's Bar2, which carries prices only. Start and end in ms. */
export interface FlowBar {
  start: number;
  end: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Shares traded in the bar. */
  v: number;
  /** The bar's own volume-weighted price, when upstream gave one. */
  vw: number | null;
  /** Trades in the bar, when upstream gave a count. */
  n: number | null;
}

/** Per name: per-slot medians over the counted sessions, indexed by slot; `n` is how many sessions had bars for it. */
export interface NameStats {
  slot_median: number[];
  cum_median: number[];
  /**
   * The median 2-minute bar range (high − low) per slot, from the same sessions as `slot_median`: version 2 only.
   * Absent on a version 1 baseline, which then gives no range ratio ("no-range-baseline").
   */
  range_median?: number[];
  n: number;
}

/** flow/baseline/<for_session>.json: built before the open from the previous 20 full sessions' SIP bars. */
export interface Baseline {
  v: 1 | 2;
  for_session: string;
  built_at: string;
  feed: "sip";
  /** The sessions it was built from, oldest first. Half days are never among them. */
  sessions: string[];
  /** The names it was built for. A name added to the focus list after the build has none that day ("no-baseline"). */
  built_for: string[];
  names: Record<string, NameStats>;
}

/** What the per-name measures need from a baseline: the session it is for and one name's medians. */
export interface NameBaseline extends NameStats {
  for_session: string;
}

/** Why a volume measure has no value. */
export type FlowWhy = "closed" | "before-0935" | "thin-baseline" | "no-baseline" | "stale-baseline" | "half-day-close" | "no-bars" | "lagging";
export type VolumeRatio = { value: number; sessions: number } | { value: null; why: FlowWhy };

export type SpreadWhy = "one-sided" | "locked" | "crossed";
export type Spread = { bps: number } | { bps: null; why: SpreadWhy };

export type VwapSide = "above" | "below" | "at";

/** The calendar a measure reads sessions from: the exchange calendar file unless a test passes another. */
export interface FlowCalendar {
  sessionOf(day: string): SessionDay;
}
export const MARKET_CALENDAR: FlowCalendar = { sessionOf };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
/** A ratio as returned: a finite number, or null with the reason given. */
const ratio = (value: number, sessions: number, why: FlowWhy): VolumeRatio => (Number.isFinite(value) ? { value, sessions } : { value: null, why });

// ---- slots ----------------------------------------------------------------------------------------------------------

/** A New York day's regular session as instants and its slot count; null when the market does not open that day. */
export interface SessionSlots {
  day: string;
  open: number;
  close: number;
  halfDay: boolean;
  slots: number;
}

export function sessionSlots(day: string, calendar: FlowCalendar = MARKET_CALENDAR): SessionSlots | null {
  const s = calendar.sessionOf(day);
  if ((s.kind !== "open" && s.kind !== "half") || s.open === null || s.close === null) return null;
  const open = nyInstant(day, s.open);
  const close = nyInstant(day, s.close);
  if (open === null || close === null || close <= open) return null;
  return { day, open, close, halfDay: s.kind === "half", slots: Math.floor((close - open) / SLOT_MS) };
}

/** The slot a bar starting at `start` fills on that session, or null when it is off the grid or outside the session. */
export function slotIndex(start: number, s: SessionSlots): number | null {
  if (!isNum(start)) return null;
  const off = start - s.open;
  if (off < 0 || off % SLOT_MS !== 0) return null;
  const k = off / SLOT_MS;
  return k < s.slots ? k : null;
}

/** Today's session at `now`, and how many of its slots have completed (settled) by then. */
export interface SlotClock extends SessionSlots {
  now: number;
  completed: number;
}

/** The clock for `now` (ms): null on a day the market does not open. Before the open no slot has completed. */
export function slotClock(now: number, calendar: FlowCalendar = MARKET_CALENDAR): SlotClock | null {
  if (!isNum(now)) return null;
  const s = sessionSlots(nyNow(new Date(now)).day, calendar);
  if (!s) return null;
  const done = Math.floor((now - SERVER_SETTLE_MS - s.open) / SLOT_MS);
  return { ...s, now, completed: Math.max(0, Math.min(s.slots, done)) };
}

/** The clock of a /api/flow answer: built from its `as_of` (the server's time), never from the device's clock. */
export function slotClockFromAsOf(asOf: string | null | undefined, calendar: FlowCalendar = MARKET_CALENDAR): SlotClock | null {
  return typeof asOf === "string" ? slotClock(Date.parse(asOf), calendar) : null;
}

/** Today's completed bars, one per slot (the last one given wins), oldest first. The forming bar is never among them. */
export function completedBars(bars: readonly FlowBar[], clock: SlotClock): { slot: number; bar: FlowBar }[] {
  const bySlot = new Map<number, FlowBar>();
  for (const b of bars) {
    const k = slotIndex(b.start, clock);
    if (k === null || k >= clock.completed || !isNum(b.v) || b.v < 0) continue;
    bySlot.set(k, b);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([slot, bar]) => ({ slot, bar }));
}

// ---- VWAP -----------------------------------------------------------------------------------------------------------

/**
 * Σ(vw × v) ÷ Σv over today's completed bars from 09:30 New York. A bar with no volume is skipped; a bar that traded
 * but has no usable vw makes the whole VWAP null, never a partial one. Null when nothing is left, or off a session day.
 */
export function sessionVwap(bars: readonly FlowBar[], clock: SlotClock | null): number | null {
  if (!clock) return null;
  let pv = 0;
  let v = 0;
  for (const { bar } of completedBars(bars, clock)) {
    if (!isPos(bar.v)) continue;
    if (!isPos(bar.vw)) return null;
    pv += bar.vw * bar.v;
    v += bar.v;
  }
  const out = v > 0 ? pv / v : NaN;
  return Number.isFinite(out) ? out : null;
}

/**
 * Where a price sits against VWAP. "at" inside a dead band of the larger of the spread and VWAP_BAND_MIN_BPS basis
 * points of VWAP, edges included. Null when the price or VWAP is missing; a missing spread leaves the 3 bp band.
 */
export function vwapSide(price: number | null, vwap: number | null, spreadBps: number | null): VwapSide | null {
  if (!isPos(price) || !isPos(vwap)) return null;
  const band = Math.max(isNum(spreadBps) && spreadBps > 0 ? spreadBps : 0, VWAP_BAND_MIN_BPS);
  // Compared as |p - vwap| x 10,000 against band x vwap, so whole numbers on the band's edge compare exactly.
  if (Math.abs(price - vwap) * 10_000 <= band * vwap) return "at";
  return price > vwap ? "above" : "below";
}

// ---- spread ---------------------------------------------------------------------------------------------------------

/** (ask - bid) ÷ mid × 10,000. Null with a reason for a one-sided, locked or crossed quote: never averaged, never negative. */
export function spreadBps(bid: number | null, ask: number | null): Spread {
  if (!isPos(bid) || !isPos(ask)) return { bps: null, why: "one-sided" };
  if (ask === bid) return { bps: null, why: "locked" };
  if (ask < bid) return { bps: null, why: "crossed" };
  const bps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
  return Number.isFinite(bps) ? { bps } : { bps: null, why: "one-sided" };
}

// ---- volume against the baseline --------------------------------------------------------------------------------------

/** One name's view of a baseline (or of the route's answer, which carries the same fields); null when it has none. */
export function nameBaseline(b: { for_session: string; names: Readonly<Record<string, NameStats>> } | null | undefined, symbol: string): NameBaseline | null {
  if (!b || !Object.hasOwn(b.names, symbol)) return null;
  const s = b.names[symbol]!;
  const out: NameBaseline = { for_session: b.for_session, slot_median: s.slot_median, cum_median: s.cum_median, n: s.n };
  if (s.range_median) out.range_median = s.range_median;
  return out;
}

/** The reasons shared by both ratios, in order: the hour, then the baseline. Null when they may go on. */
function gate(base: NameBaseline | null, clock: SlotClock | null): FlowWhy | null {
  if (!clock) return "closed";
  const first = nyInstant(clock.day, FIRST_ENTRY_MIN);
  if (first === null || clock.now < first) return "before-0935";
  if (!base) return "no-baseline";
  if (base.for_session !== clock.day) return "stale-baseline";
  if (!Number.isInteger(base.n) || base.n < MIN_BASELINE_SESSIONS) return "thin-baseline";
  return null;
}

/** On a half day, a slot in the last HALF_DAY_CLOSE_SLOTS runs into the closing auction. */
const nearHalfDayClose = (clock: SlotClock, k: number) => clock.halfDay && k >= clock.slots - HALF_DAY_CLOSE_SLOTS;

/**
 * Today's volume up to the last completed slot ÷ the baseline's median cumulative volume to the same slot. No value
 * off a session day, before 09:35 New York, with fewer than MIN_BASELINE_SESSIONS sessions behind the name, with a
 * baseline for another session, in a half day's last slots, or with no completed bar today. The bar for the last
 * completed slot must be there ("lagging" otherwise): bars that lag the clock would read the ratio low. An earlier
 * slot with no bar counts as no trades. A baseline with no volume at that slot has nothing to compare against.
 */
export function relativeVolume(todayBars: readonly FlowBar[], base: NameBaseline | null, clock: SlotClock | null): VolumeRatio {
  const why = gate(base, clock);
  if (why) return { value: null, why };
  const k = clock!.completed - 1;
  if (nearHalfDayClose(clock!, k)) return { value: null, why: "half-day-close" };
  const cum = base!.cum_median[k];
  if (!isPos(cum)) return { value: null, why: "no-baseline" };
  const done = completedBars(todayBars, clock!);
  if (done.length === 0) return { value: null, why: "no-bars" };
  if (done[done.length - 1]!.slot !== k) return { value: null, why: "lagging" };
  const v = done.reduce((s, x) => s + x.bar.v, 0);
  return ratio(v / cum, base!.n, "no-baseline");
}

/**
 * One completed bar's volume ÷ the baseline's median for its slot. The same reasons as relativeVolume, except
 * "lagging": the bar is named, so a missing later bar does not change its ratio.
 */
export function barSurge(bar: FlowBar | null | undefined, base: NameBaseline | null, clock: SlotClock | null): VolumeRatio {
  const why = gate(base, clock);
  if (why) return { value: null, why };
  const k = bar ? slotIndex(bar.start, clock!) : null;
  if (!bar || k === null || k >= clock!.completed || !isNum(bar.v) || bar.v < 0) return { value: null, why: "no-bars" };
  if (nearHalfDayClose(clock!, k)) return { value: null, why: "half-day-close" };
  const med = base!.slot_median[k];
  if (!isPos(med)) return { value: null, why: "no-baseline" };
  return ratio(bar.v / med, base!.n, "no-baseline");
}

/** Why a bar's range has no ratio: the volume reasons, or a baseline with no ranges (a version 1 document). */
export type RangeWhy = FlowWhy | "no-range-baseline";
export type RangeRatio = { value: number; sessions: number } | { value: null; why: RangeWhy };

/**
 * One completed bar's range (high − low) ÷ the baseline's median range for its slot. The same reasons as barSurge,
 * plus "no-range-baseline" when the baseline holds no ranges; a slot median range of zero gives no ratio either.
 */
export function barRange(bar: FlowBar | null | undefined, base: NameBaseline | null, clock: SlotClock | null): RangeRatio {
  const why = gate(base, clock);
  if (why) return { value: null, why };
  if (!base!.range_median) return { value: null, why: "no-range-baseline" };
  const k = bar ? slotIndex(bar.start, clock!) : null;
  if (!bar || k === null || k >= clock!.completed || !isPos(bar.h) || !isPos(bar.l) || bar.h < bar.l) return { value: null, why: "no-bars" };
  if (nearHalfDayClose(clock!, k)) return { value: null, why: "half-day-close" };
  const med = base!.range_median[k];
  if (!isPos(med)) return { value: null, why: "no-range-baseline" };
  const value = (bar.h - bar.l) / med;
  return Number.isFinite(value) ? { value, sessions: base!.n } : { value: null, why: "no-range-baseline" };
}

// ---- building a baseline --------------------------------------------------------------------------------------------

/**
 * The BASELINE_SESSIONS full sessions before `forSession`, oldest first. Half days, holidays and weekends are passed
 * over. Null when the calendar file does not reach back that far.
 */
export function baselineSessions(forSession: string, calendar: FlowCalendar = MARKET_CALENDAR, count = BASELINE_SESSIONS): string[] | null {
  const out: string[] = [];
  let day = forSession;
  // A month and a half of days always holds 20 sessions; the bound only stops a broken calendar looping.
  for (let i = 0; i < count * 3 && out.length < count; i++) {
    day = addDays(day, -1);
    const s = calendar.sessionOf(day);
    if (s.kind === "out_of_range") return null;
    if (s.kind === "open") out.push(day);
  }
  return out.length === count ? out.reverse() : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The baseline for `forSession` from 2-minute bars keyed by session day, then by name. Each of the previous 20 full
 * sessions is read; a slot with no bar counts as zero volume and a zero range (high − low), and a session with no bar
 * at all for a name is not counted in that name's `n`. Ranges are built from the same sessions in the same way as
 * the volumes (DEC-0051 section 2.4). Names are every name present under any of those sessions (an empty list counts as
 * present with no bars), and `builtFor` when given (a name in it with no bars gets n 0). `built_for` records them.
 * Null when the calendar cannot give the 20 sessions.
 */
export function buildBaseline(
  barsBySessionByName: Readonly<Record<string, Readonly<Record<string, readonly FlowBar[]>>>>,
  forSession: string,
  calendar: FlowCalendar = MARKET_CALENDAR,
  builtAt: string = new Date(0).toISOString(),
  builtFor: readonly string[] = [],
): Baseline | null {
  const sessions = baselineSessions(forSession, calendar);
  if (!sessions) return null;
  const names = new Set<string>(builtFor);
  for (const day of sessions) for (const sym of Object.keys(barsBySessionByName[day] ?? {})) names.add(sym);
  const out: Record<string, NameStats> = {};
  for (const sym of [...names].sort()) {
    const perSession: number[][] = [];
    const perRange: number[][] = [];
    for (const day of sessions) {
      const s = sessionSlots(day, calendar);
      const bars = barsBySessionByName[day]?.[sym];
      if (!s || !bars) continue;
      const vol = new Array<number>(s.slots).fill(0);
      const rng = new Array<number>(s.slots).fill(0);
      let any = false;
      for (const b of bars) {
        const k = slotIndex(b.start, s);
        if (k === null || !isNum(b.v) || b.v < 0) continue;
        vol[k] = b.v;
        // A bar whose high and low cannot be read keeps a zero range: never a made-up one.
        rng[k] = isNum(b.h) && isNum(b.l) && b.h >= b.l ? b.h - b.l : 0;
        any = true;
      }
      if (any) {
        perSession.push(vol);
        perRange.push(rng);
      }
    }
    if (perSession.length === 0) {
      out[sym] = { slot_median: [], cum_median: [], range_median: [], n: 0 };
      continue;
    }
    const cums = perSession.map((vol) => {
      let run = 0;
      return vol.map((x) => (run += x));
    });
    const slots = Math.min(...perSession.map((v) => v.length));
    const slot_median: number[] = [];
    const cum_median: number[] = [];
    const range_median: number[] = [];
    for (let k = 0; k < slots; k++) {
      slot_median.push(median(perSession.map((v) => v[k]!)));
      cum_median.push(median(cums.map((v) => v[k]!)));
      // Kept to 4 decimals (a hundredth of a cent): the shock gate compares in whole ten-thousandths of a dollar.
      range_median.push(Math.round(median(perRange.map((v) => v[k]!)) * 10_000) / 10_000);
    }
    out[sym] = { slot_median, cum_median, range_median, n: perSession.length };
  }
  return { v: BASELINE_V, for_session: forSession, built_at: builtAt, feed: "sip", sessions, built_for: [...names].sort(), names: out };
}

// ---- reading ----------------------------------------------------------------------------------------------------------

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD, not just its shape. */
const isDay = (v: unknown): v is string => typeof v === "string" && DAY_RE.test(v) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const nums = (v: unknown): v is number[] => Array.isArray(v) && v.length <= FULL_SESSION_SLOTS && v.every((x) => isNum(x) && x >= 0);
const rising = (xs: readonly number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

/**
 * A stored baseline, checked field by field; null when anything is off: another version or feed, a date that is not
 * one, more than BASELINE_SESSIONS sessions, a name that is not a ticker, an `n` above the session count, medians of
 * unequal length, a negative or non-finite value, or a cumulative median that falls. Version 2 needs every name's
 * `range_median`, as long as its other medians; version 1 may not carry one. Never a version 1 read as having ranges.
 */
export function parseBaseline(text: string): Baseline | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const b = rec(v);
  if (!b || (b.v !== 1 && b.v !== 2) || b.feed !== "sip" || !isDay(b.for_session) || typeof b.built_at !== "string") return null;
  if (!Array.isArray(b.sessions) || b.sessions.length > BASELINE_SESSIONS || !b.sessions.every(isDay)) return null;
  if (!Array.isArray(b.built_for) || !b.built_for.every((x) => typeof x === "string" && SYMBOL_RE.test(x))) return null;
  const names = rec(b.names);
  if (!names) return null;
  const out: Record<string, NameStats> = {};
  for (const [sym, raw] of Object.entries(names)) {
    const s = rec(raw);
    if (!SYMBOL_RE.test(sym) || !s || !nums(s.slot_median) || !nums(s.cum_median)) return null;
    if (s.slot_median.length !== s.cum_median.length || !rising(s.cum_median)) return null;
    if (!Number.isInteger(s.n) || (s.n as number) < 0 || (s.n as number) > b.sessions.length) return null;
    if (b.v === 1) {
      if (Object.hasOwn(s, "range_median")) return null;
      out[sym] = { slot_median: s.slot_median, cum_median: s.cum_median, n: s.n as number };
      continue;
    }
    if (!nums(s.range_median) || s.range_median.length !== s.slot_median.length) return null;
    out[sym] = { slot_median: s.slot_median, cum_median: s.cum_median, range_median: s.range_median, n: s.n as number };
  }
  return { v: b.v, for_session: b.for_session, built_at: b.built_at, feed: "sip", sessions: b.sessions as string[], built_for: b.built_for as string[], names: out };
}

/** One Alpaca bar as a FlowBar, or null when its start, a price or its volume cannot be read. vw and n may be absent. */
export function flowBarOf(raw: unknown): FlowBar | null {
  const b = rec(raw);
  const start = typeof b?.t === "string" ? Date.parse(b.t) : NaN;
  if (!b || !Number.isFinite(start)) return null;
  const { o, h, l, c, v } = b;
  if (!isPos(o) || !isPos(h) || !isPos(l) || !isPos(c) || !isNum(v) || v < 0) return null;
  return { start, end: start + SLOT_MS, o, h, l, c, v, vw: isPos(b.vw) ? b.vw : null, n: isNum(b.n) && b.n >= 0 ? b.n : null };
}
