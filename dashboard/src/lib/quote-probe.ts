// A log-only probe of Alpaca's raw stock snapshots, kept as temporary evidence for the board's bad-data guards: how
// often a real snapshot shows a shape the guards (quote-guards.ts) would pause on (high below low, an open outside the
// day's range, a last trade far from the prior close, a crossed quote) in normal conditions, and, counted apart, a
// last trade outside the day's high and low, which is not a guard.
//
// Pure and total: every input may be missing, null or of the wrong type, and nothing here throws on it; a field it
// cannot read is reported "absent" or "invalid". It returns enums, booleans, numbers (ages in seconds, which are
// SAFE times, and distances in basis points), symbols and short validated exchange and condition codes only: never a
// price, a level, an amount or free text. Nothing here reads the store, sends anything or changes what the page or the
// server's evaluator sees (desk-run.ts gathers it beside the evaluation; quote.ts hands it the raw answer).
//
// Field names are Alpaca's stock snapshot (v2/stocks/snapshots): `latestTrade` {t, x, p, s, c[], i, z},
// `latestQuote` {t, ax, ap, as, bx, bp, bs, c[], z} (a price of 0 means no active bid or ask), and the bars
// `minuteBar`, `dailyBar`, `prevDailyBar` {t, o, h, l, c, v, n, vw}, each bar stamped with its start (as bars.ts reads it).

import { isDataFeed } from "./feed-provenance";
import { addDays, nyNow, sessionOf } from "./market-calendar";
import { SETS_PRICE, type SetsPrice, setsPrice } from "./quote-conditions";
import { barChecks, outsideDayRange, PRESENCE, type Presence, PRIOR_CLOSE_LIMIT, priorMove, readBar, readStamp } from "./quote-guards";
import { quoteShape } from "./quote-shape";

// The definitions the board's guards use (quote-guards.ts, quote-shape.ts) are imported, not copied: a bar's and a
// time's validity, the day bar's two checks, the move from the prior close and the quote's shape.
export { PRESENCE, type Presence, PRIOR_CLOSE_LIMIT, priorMove };

export const PROBE_V = 1;
/** One minute bar's length. */
export const MINUTE_MS = 60_000;
/**
 * An age further than this from server time, either way, is not stored (the name is marked in `age_out_of_range`).
 * It applies to ages only: the time itself still gives its New York day, as quote.ts reads it.
 */
export const MAX_STAMP_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
/** The largest time a JavaScript Date holds; a server time beyond it is unusable. */
export const MAX_TIME_MS = 8.64e15;
/** A trade condition or exchange code as stored: 1 or 2 characters of A-Z, 0-9, space or "@". Anything else is dropped. */
export const CODE_RE = /^[A-Z0-9 @]{1,2}$/;
/** At most this many condition codes are kept per trade (Alpaca sends a handful). */
export const MAX_CODES = 8;
/** At most this many names are probed per answer (quote.ts' MAX_SYMBOLS). */
export const MAX_PROBED = 60;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export const MINUTE_STATES = ["absent", "invalid", "forming", "finished"] as const;
export type MinuteState = (typeof MINUTE_STATES)[number];
/** A New York day against the server's New York day. */
export const DAYS = ["today", "other", "unknown"] as const;
export type DayVsToday = (typeof DAYS)[number];
export const TRADE_VS_DAY = ["inside", "above-high", "below-low", "stale-day", "no-daily-bar", "no-trade"] as const;
export type TradeVsDay = (typeof TRADE_VS_DAY)[number];
export const PRIOR_MOVES = ["within", "at-limit", "beyond", "unknown"] as const;
export type PriorMove = (typeof PRIOR_MOVES)[number];
export const QUOTE_STATES = ["absent", "invalid", "empty", "one-sided", "crossed", "locked", "normal"] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];
export const SOURCES = ["fetched", "cached", "missing", "invalid"] as const;
export type ProbeSource = (typeof SOURCES)[number];
/**
 * A bar's New York day against the exchange calendar (market-calendar.ts): the server's day, the session before it,
 * an older day, a non-session day between the two, a day after today, or not readable. "unknown" when the calendar
 * does not cover the day.
 */
export const SESSION_DAYS = ["today", "previous-session", "older", "off-session", "future", "absent", "invalid", "unknown"] as const;
export type SessionDayVs = (typeof SESSION_DAYS)[number];
/**
 * The run's phase by New York time and the exchange calendar (half days included). The server check writes its record
 * only in the regular session (and at most a moment after the close), so on that record this is "regular" in
 * practice and cannot answer what a snapshot looks like before 09:30; it is kept to catch a run outside the session.
 */
export const PHASES = ["pre-open", "regular", "after-close", "closed", "unknown"] as const;
export type Phase = (typeof PHASES)[number];
/** The ages that can be out of range (MAX_STAMP_SKEW_MS). */
export const AGED = ["trade", "quote", "minute"] as const;
export type Aged = (typeof AGED)[number];

/** One name's facts from one fetched snapshot. */
export interface NameFacts {
  symbol: string;
  source: "fetched";
  /** "invalid" for a price that is not positive or a time that is unparseable or before 1970 (Go's zero time). */
  trade: Presence;
  /** The trade's New York day against the server's. */
  trade_day: DayVsToday;
  /**
   * Server time minus the trade's time, in seconds floored to one decimal (negative when stamped ahead of server time);
   * null, with "trade" in `age_out_of_range`, beyond MAX_STAMP_SKEW_MS.
   */
  trade_age_s: number | null;
  /** The trade's exchange code, when it is a safe short code. */
  trade_x: string | null;
  /** The trade's condition codes that are safe short codes, in Alpaca's order, at most MAX_CODES. */
  trade_c: string[];
  /**
   * Whether this trade sets a minute bar's, and a daily bar's, price, from Alpaca's condition table
   * (quote-conditions.ts setsPrice): the strictest rule across its codes on its tape (`z`).
   */
  trade_sets_minute_price: SetsPrice;
  trade_sets_daily_price: SetsPrice;
  /** An odd lot (code I); extended hours (T or U). */
  trade_odd_lot: boolean;
  trade_extended_hours: boolean;
  /** Condition entries dropped (not a safe short code, or past MAX_CODES); -1 when `c` is present but not an array. */
  trade_c_dropped: number;
  minute: MinuteState;
  /** Server time minus the minute bar's start, seconds floored to one decimal: below 60 it is still forming. */
  minute_age_s: number | null;
  /**
   * The last trade's age minus the finished minute bar's end age (the bar's end minus the trade's time), in seconds
   * truncated toward zero to one decimal, so a trade 1 ms after the bar's end reads 0, not -0.1: negative when the
   * trade printed after that bar ended. Null unless both are readable and the bar has finished.
   */
  trade_vs_minute_s: number | null;
  daily: Presence;
  /**
   * The daily bar's New York day against the server's: the page's own test (quote.ts' `day`, the New York day of
   * `dailyBar.t`, against today), so the probe counts what the page's guard would see.
   */
  daily_day: DayVsToday;
  /**
   * The daily bar's and the prior daily bar's New York days against the calendar. On the server check's record (written
   * only in session) they catch a wrong-day bar in session; they cannot say what dailyBar is before 09:30.
   */
  daily_session: SessionDayVs;
  prev_session: SessionDayVs;
  high_below_low: boolean | null;
  open_outside: boolean | null;
  /** Compared only when the daily bar and the trade are both today's; otherwise "stale-day". */
  trade_vs_day: TradeVsDay;
  /** How far outside the day's range the trade is, in basis points of the side it crossed; null when inside or unknown. */
  trade_outside_bps: number | null;
  prev: Presence;
  prior_move: PriorMove;
  /** |trade - prior close| / prior close, in basis points; null when unknown. */
  prior_move_bps: number | null;
  quote: QuoteState;
  /** The quote's time: an unreadable one gives no age. */
  quote_time: Presence;
  /** (ask - bid) / mid in basis points, negative when crossed; null unless both sides are there. */
  spread_bps: number | null;
  /** Server time minus the quote's time, seconds floored to one decimal; null without a readable time. */
  quote_age_s: number | null;
  /** The ages left null because their time is more than MAX_STAMP_SKEW_MS from server time. */
  age_out_of_range: Aged[];
}

/**
 * A name with no facts: served from quote.ts' 1.5 s cache ("cached"), left out of Alpaca's answer ("missing"), or
 * answered with something that is not a snapshot object at all, an array or a primitive ("invalid").
 */
export interface NameSkipped {
  symbol: string;
  source: "cached" | "missing" | "invalid";
}

export type NameProbe = NameFacts | NameSkipped;

/** What one run stores beside its record (desk-run.ts `probe`). */
export interface ProbeRecord {
  v: typeof PROBE_V;
  /** The run's phase at the snapshot's server time. */
  phase: Phase;
  /** Alpaca's X-RateLimit-Limit and X-RateLimit-Remaining on the snapshot response; null when absent or unreadable. */
  rate_limit: number | null;
  rate_remaining: number | null;
  names: NameProbe[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
/** One decimal place, so the stored numbers stay short. */
const r1 = (x: number) => Math.round(x * 10) / 10;
/** An age in seconds, floored to one decimal for every age alike: 59.999 s is 59.9, never 60. */
export const ageSeconds = (ms: number) => Math.floor(ms / 100) / 10;

const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const nyDay = (t: number) => NY_DAY_FMT.format(new Date(t));

const stamp = readStamp;

/** A usable server time: finite and within what a Date holds; NaN otherwise. */
const usableNow = (now: unknown): number => (isNum(now) && Math.abs(now) <= MAX_TIME_MS ? now : Number.NaN);

/** Server time minus `t` in seconds, or null: without a time, without a server time, or (marked) beyond MAX_STAMP_SKEW_MS. */
function ageOf(t: number | null, now: number, which: Aged, out: Aged[]): number | null {
  if (t === null || !Number.isFinite(now)) return null;
  if (Math.abs(now - t) > MAX_STAMP_SKEW_MS) {
    out.push(which);
    return null;
  }
  return ageSeconds(now - t);
}
/** The New York day of `t` against the server's: quote.ts' own test (its `day` is nyDay(dailyBar.t)). */
const dayVsToday = (t: number | null, now: number): DayVsToday => (t === null || !Number.isFinite(now) ? "unknown" : nyDay(t) === nyDay(now) ? "today" : "other");

/** A short code as stored, or null. */
export function safeCode(v: unknown): string | null {
  return typeof v === "string" && CODE_RE.test(v) ? v : null;
}

function codes(v: unknown): { kept: string[]; dropped: number } {
  if (v === undefined || v === null) return { kept: [], dropped: 0 };
  if (!Array.isArray(v)) return { kept: [], dropped: -1 };
  const kept: string[] = [];
  let dropped = 0;
  for (const c of v) {
    const s = safeCode(c);
    if (s !== null && kept.length < MAX_CODES) kept.push(s);
    else dropped++;
  }
  return { kept, dropped };
}

const bar = readBar;

const isSessionDay = (day: string) => {
  const k = sessionOf(day).kind;
  return k === "open" || k === "half";
};

/** The last session before `day` by the calendar, or null when the calendar does not reach it. */
export function previousSession(day: string): string | null {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(day, -i);
    if (sessionOf(d).kind === "out_of_range") return null;
    if (isSessionDay(d)) return d;
  }
  return null;
}

/** A bar's day (from a readable stamp) against the server's New York day and the session before it. */
function sessionDay(presence: "absent" | "readable" | "invalid", t: number | null, now: number): SessionDayVs {
  if (presence === "absent") return "absent";
  if (presence === "invalid" || t === null) return "invalid";
  if (!Number.isFinite(now)) return "unknown";
  const today = nyDay(now);
  const day = nyDay(t);
  if (day === today) return "today";
  if (day > today) return "future";
  const prev = previousSession(today);
  if (prev === null) return "unknown";
  return day === prev ? "previous-session" : day < prev ? "older" : "off-session";
}

/** The phase at `now` by New York time and the calendar. */
export function phaseAt(now: number): Phase {
  if (!Number.isFinite(usableNow(now))) return "unknown";
  const { day, minute } = nyNow(new Date(now));
  const s = sessionOf(day);
  if (s.kind === "out_of_range") return "unknown";
  if ((s.kind !== "open" && s.kind !== "half") || s.open === null || s.close === null) return "closed";
  return minute < s.open ? "pre-open" : minute < s.close ? "regular" : "after-close";
}

/** A rate-limit header's value: a whole number of 0 or more, else null. */
export function rateHeader(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v.trim())) return null;
  return Number(v.trim());
}

function quoteFacts(v: unknown, now: number, aged: Aged[]): Pick<NameFacts, "quote" | "quote_time" | "spread_bps" | "quote_age_s"> {
  if (v === undefined || v === null) return { quote: "absent", quote_time: "absent", spread_bps: null, quote_age_s: null };
  // Not an object at all: the quote and its time are both unreadable.
  if (!isObj(v)) return { quote: "invalid", quote_time: "invalid", spread_bps: null, quote_age_s: null };
  const s = stamp(v.t);
  const base = { quote_time: s.state, quote_age_s: ageOf(s.t, now, "quote", aged) };
  // The shape and spread are quote-shape.ts': a price or size of 0 is no active side, a missing size leaves the side to
  // its price, and anything else that is not a number of 0 or more makes the quote unreadable.
  const { shape, spread_bps } = quoteShape(v.bp, v.ap, v.bs, v.as);
  return { quote: shape, spread_bps, ...base };
}

/**
 * One name's facts from Alpaca's raw snapshot `raw` at the server's time `now` (ms). Never throws: a missing or
 * malformed part is reported "absent" or "invalid" and the facts that depend on it are null or "unknown".
 */
export function probeSnapshot(symbol: string, raw: unknown, now: number): NameProbe {
  if (raw === undefined || raw === null) return { symbol, source: "missing" };
  if (!isObj(raw)) return { symbol, source: "invalid" };
  const snap = raw;
  const serverNow = usableNow(now);
  const aged: Aged[] = [];

  // The last trade.
  const tr = snap.latestTrade;
  let trade: Presence = "absent";
  let price: number | null = null;
  let tradeAt: number | null = null;
  if (tr !== undefined && tr !== null) {
    const s = isObj(tr) ? stamp(tr.t) : null;
    if (isObj(tr) && isPos(tr.p) && s && s.t !== null) {
      trade = "ok";
      price = tr.p;
      tradeAt = s.t;
    } else trade = "invalid";
  }
  const trObj = isObj(tr) ? tr : {};
  const c = codes(trObj.c);
  const trade_day = dayVsToday(tradeAt, serverNow);

  // The forming (or last finished) minute.
  const mb = bar(snap.minuteBar);
  const minuteMs = mb.bar && Number.isFinite(serverNow) ? serverNow - mb.bar.t : null;
  // A bar whose minute ends exactly at server time has finished. Its state is read from the raw difference; only its
  // stored age is limited to MAX_STAMP_SKEW_MS.
  const minute: MinuteState = mb.presence !== "ok" ? mb.presence : minuteMs === null ? "invalid" : minuteMs >= MINUTE_MS ? "finished" : "forming";
  const tradeVsMinute = minute === "finished" && mb.bar && tradeAt !== null ? Math.trunc((mb.bar.t + MINUTE_MS - tradeAt) / 100) / 10 || 0 : null;

  // The day's bar. Its day is read from its stamp alone, as quote.ts' `day` is, even when its prices are unusable.
  const db = bar(snap.dailyBar);
  const d = db.bar;
  const daily_day = dayVsToday(db.t, serverNow);
  let trade_vs_day: TradeVsDay;
  let outside: number | null = null;
  if (price === null) trade_vs_day = "no-trade";
  else if (!d) trade_vs_day = "no-daily-bar";
  // Yesterday's bar with yesterday's last trade (an illiquid name early in the session, or pre-market) is not a trade
  // outside today's range: it is counted apart, so it cannot inflate the counts the guards are set from.
  else if (daily_day !== "today" || trade_day !== "today") trade_vs_day = "stale-day";
  else {
    // quote-guards' outsideDayRange: the bad-print guard's own test of the same thing.
    const side = outsideDayRange(price, d);
    trade_vs_day = side ?? "inside";
    if (side === "above-high") outside = r1(((price - d.h) / d.h) * 10_000);
    else if (side === "below-low") outside = r1(((d.l - price) / d.l) * 10_000);
  }

  // The prior session's close.
  const pb = bar(snap.prevDailyBar);
  const sess = (b: { presence: Presence; t: number | null }) => sessionDay(b.presence === "absent" ? "absent" : b.t === null ? "invalid" : "readable", b.t, serverNow);
  const pm = price !== null && pb.bar ? priorMove(price, pb.bar.c) : null;

  const trade_age_s = ageOf(tradeAt, serverNow, "trade", aged);
  const minute_age_s = mb.bar ? ageOf(mb.bar.t, serverNow, "minute", aged) : null;
  const q = quoteFacts(snap.latestQuote, serverNow, aged);
  const hasTrade = trade !== "absent";
  return {
    symbol,
    source: "fetched",
    trade,
    trade_day,
    trade_age_s,
    trade_x: safeCode(trObj.x),
    trade_c: c.kept,
    trade_c_dropped: c.dropped,
    trade_sets_minute_price: hasTrade ? setsPrice(c.kept, c.dropped, trObj.z, "minute") : "unknown",
    trade_sets_daily_price: hasTrade ? setsPrice(c.kept, c.dropped, trObj.z, "daily") : "unknown",
    trade_odd_lot: c.kept.includes("I"),
    trade_extended_hours: c.kept.includes("T") || c.kept.includes("U"),
    minute,
    minute_age_s,
    trade_vs_minute_s: tradeVsMinute,
    daily: db.presence,
    daily_day,
    daily_session: sess(db),
    prev_session: sess(pb),
    high_below_low: d ? barChecks(d).high_below_low : null,
    open_outside: d ? barChecks(d).open_outside : null,
    trade_vs_day,
    trade_outside_bps: outside,
    prev: pb.presence,
    prior_move: pm ? pm.move : "unknown",
    prior_move_bps: pm ? pm.bps : null,
    ...q,
    age_out_of_range: aged,
  };
}

/** What quote.ts hands over for one upstream call: the raw snapshot per name it fetched, and the server time it used. */
export interface RawSnapshots {
  /** The names this call fetched; any other name asked for was served from the cache. */
  fetched: Readonly<Record<string, unknown>>;
  at: number;
  /** The response's X-RateLimit-Limit and X-RateLimit-Remaining as sent (strings), or null without them. */
  rate?: { limit: string | null; remaining: string | null };
}

/**
 * The facts for `symbols` (valid symbols only, at most MAX_PROBED, each once) from one upstream answer, or null when
 * no answer was handed over (every name came from the cache, or the snapshot read failed before any answer).
 */
export function probeSnapshots(symbols: readonly string[], raw: RawSnapshots | null): ProbeRecord | null {
  if (!raw || !isObj(raw.fetched)) return null;
  // A server time a Date cannot hold: nothing can be judged, so every fetched name is recorded as invalid.
  const timeOk = Number.isFinite(usableNow(raw.at));
  const names: NameProbe[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (typeof s !== "string" || !SYMBOL_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    if (names.length >= MAX_PROBED) break;
    if (!Object.hasOwn(raw.fetched, s)) names.push({ symbol: s, source: "cached" });
    else names.push(timeOk ? probeSnapshot(s, raw.fetched[s], raw.at) : { symbol: s, source: "invalid" });
  }
  return { v: PROBE_V, phase: phaseAt(raw.at), rate_limit: rateHeader(raw.rate?.limit), rate_remaining: rateHeader(raw.rate?.remaining), names };
}

// ---- the reader -------------------------------------------------------------------------------------------------------

/** The enum facts counted per value. */
const ENUM_FACTS = {
  source: SOURCES,
  trade: PRESENCE,
  trade_day: DAYS,
  trade_sets_minute_price: SETS_PRICE,
  trade_sets_daily_price: SETS_PRICE,
  minute: MINUTE_STATES,
  daily: PRESENCE,
  daily_day: DAYS,
  daily_session: SESSION_DAYS,
  prev_session: SESSION_DAYS,
  trade_vs_day: TRADE_VS_DAY,
  prev: PRESENCE,
  prior_move: PRIOR_MOVES,
  quote: QUOTE_STATES,
  quote_time: PRESENCE,
} as const;
type EnumFact = keyof typeof ENUM_FACTS;
/** The yes/no facts, counted as "yes", "no" or "unknown". */
const BOOL_FACTS = ["high_below_low", "open_outside", "trade_odd_lot", "trade_extended_hours"] as const;

/**
 * Fixed buckets per number, chosen for the guards: each is [lower, upper) and the last is open. A value below the
 * first bound (a negative age is clock skew; a negative spread is a crossed quote) is "negative".
 */
export const AGE_BUCKETS = [
  ["0-5", 0],
  ["5-20", 5],
  ["20-120", 20],
  ["120+", 120],
] as const;
export const BPS_BUCKETS = [
  ["0-10", 0],
  ["10-50", 10],
  ["50-250", 50],
  ["250+", 250],
] as const;
/**
 * For the move from the prior close, whose guard is at 2500 bps (25%). The last two buckets come from the name's own
 * `prior_move`, not from the rounded number: "at-limit" is exactly 25% and "beyond-2500" is more, so a move "within"
 * the rule that rounds to 2500.0 bps stays in "1000-2500" (priorBucket).
 */
export const PRIOR_BUCKETS = [
  ["0-100", 0],
  ["100-500", 100],
  ["500-1000", 500],
  ["1000-2500", 1000],
  ["at-limit", Number.POSITIVE_INFINITY],
  ["beyond-2500", Number.POSITIVE_INFINITY],
] as const;

/** The prior-move bucket: by the name's `prior_move` at and past the limit, by its value below it. */
export function priorBucket(v: number, move: unknown): string {
  if (move === "at-limit") return "at-limit";
  if (move === "beyond") return "beyond-2500";
  if (move !== "within" && v >= 2500) return "beyond-2500";
  return bucketOf(v, PRIOR_BUCKETS.slice(0, 4));
}
type Buckets = readonly (readonly [string, number])[];
export const NUM_FACTS: Record<string, Buckets> = {
  trade_age_s: AGE_BUCKETS,
  quote_age_s: AGE_BUCKETS,
  minute_age_s: AGE_BUCKETS,
  trade_vs_minute_s: AGE_BUCKETS,
  trade_outside_bps: BPS_BUCKETS,
  spread_bps: BPS_BUCKETS,
  prior_move_bps: PRIOR_BUCKETS,
};

export interface NumStats {
  /** Values seen, the smallest and the largest, and the count per bucket ("negative" first). */
  n: number;
  min: number | null;
  max: number | null;
  buckets: Record<string, number>;
}

/** The bucket a value falls in. */
export function bucketOf(v: number, buckets: Buckets): string {
  if (v < buckets[0]![1]) return "negative";
  let name = buckets[0]![0];
  for (const [b, lo] of buckets) if (v >= lo) name = b;
  return name;
}

export interface FactCounts {
  /** Probed names in the records (every source). */
  samples: number;
  /** Per fact, the count per value; a stored value that is not one of the fact's words counts as "invalid-record". */
  counts: Record<EnumFact | (typeof BOOL_FACTS)[number], Record<string, number>>;
  /** Per number: how many, the smallest, the largest and the fixed buckets, so one bad value cannot hide the rest. */
  numbers: Record<string, NumStats>;
  /** Trade condition codes and exchange codes seen, with their counts. */
  conditions: Record<string, number>;
  exchanges: Record<string, number>;
  /** Fetched samples with at least one condition code dropped (unsafe, too many, or not an array). */
  conditions_dropped: number;
  /** Ages left out as beyond MAX_STAMP_SKEW_MS, per age. */
  ages_out_of_range: Record<string, number>;
  /**
   * The guard's question, as a first-class count: the trade against the day's range (`trade_vs_day`) crossed with
   * whether that trade sets the daily bar's price (`trade_sets_daily_price`). "How often is a trade that does set the
   * daily high/low outside the daily range" is `above-high` and `below-low` under `yes` and `first-only`.
   */
  day_range_by_daily_price: Record<string, Record<string, number>>;
}

/** For the snapshot call's remaining requests in the rate-limit window (200 a minute on the free plan). */
export const REMAINING_BUCKETS = [
  ["0-10", 0],
  ["10-50", 10],
  ["50-100", 50],
  ["100+", 100],
] as const;

/** One feed's counts: never pooled with another feed's. */
export interface FeedGroup {
  /** Records of this feed carrying a probe. */
  records: number;
  /** Runs per phase, and the rate-limit headers seen (the limit's values counted; the remaining as a number). */
  phase: Record<string, number>;
  rate_limit: Record<string, number>;
  rate_remaining: NumStats;
  total: FactCounts;
  by_symbol: Record<string, FactCounts>;
}

/** The record's `feed` as grouped: "iex" or "sip", and "unknown" for a record without a readable one. */
export const FEED_GROUPS = ["iex", "sip", "unknown"] as const;

export interface ProbeSummary {
  /** Records read, those carrying a probe, and those without (written before the probe, or no answer in that run). */
  records: number;
  with_probe: number;
  without_probe: number;
  /** Per feed the snapshot was requested from (the record's `feed`), so IEX and SIP days are never pooled. */
  by_feed: Record<(typeof FEED_GROUPS)[number], FeedGroup>;
}

const emptyNum = (b: Buckets): NumStats => ({ n: 0, min: null, max: null, buckets: Object.fromEntries([["negative", 0], ...b.map(([name]) => [name, 0])]) });
function addNum(s: NumStats, v: number, b: Buckets, bucket: string = bucketOf(v, b)): void {
  s.n++;
  s.min = s.min === null ? v : Math.min(s.min, v);
  s.max = s.max === null ? v : Math.max(s.max, v);
  s.buckets[bucket] = (s.buckets[bucket] ?? 0) + 1;
}
const emptyGroup = (): FeedGroup => ({
  records: 0,
  phase: Object.fromEntries(PHASES.map((p) => [p, 0])),
  rate_limit: {},
  rate_remaining: emptyNum(REMAINING_BUCKETS),
  total: emptyCounts(),
  by_symbol: {},
});

function emptyCounts(): FactCounts {
  const counts = {} as FactCounts["counts"];
  for (const f of Object.keys(ENUM_FACTS) as EnumFact[]) counts[f] = Object.fromEntries(ENUM_FACTS[f].map((v) => [v, 0]));
  for (const f of BOOL_FACTS) counts[f] = { yes: 0, no: 0, unknown: 0 };
  const numbers: Record<string, NumStats> = {};
  for (const [f, b] of Object.entries(NUM_FACTS)) numbers[f] = emptyNum(b);
  const cross = Object.fromEntries(TRADE_VS_DAY.map((v) => [v, Object.fromEntries(SETS_PRICE.map((p) => [p, 0]))]));
  return { samples: 0, counts, numbers, conditions: {}, exchanges: {}, conditions_dropped: 0, ages_out_of_range: Object.fromEntries(AGED.map((a) => [a, 0])), day_range_by_daily_price: cross };
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

function add(c: FactCounts, n: Record<string, unknown>): void {
  c.samples++;
  for (const f of Object.keys(ENUM_FACTS) as EnumFact[]) {
    const v = n[f];
    const words = ENUM_FACTS[f] as readonly string[];
    if (typeof v === "string" && words.includes(v)) bump(c.counts[f], v);
    else if (n.source === "fetched" || f === "source") bump(c.counts[f], "invalid-record");
  }
  if (n.source !== "fetched") return;
  for (const f of BOOL_FACTS) bump(c.counts[f], n[f] === true ? "yes" : n[f] === false ? "no" : "unknown");
  for (const [f, b] of Object.entries(NUM_FACTS)) {
    const v = n[f];
    if (isNum(v)) addNum(c.numbers[f]!, v, b, f === "prior_move_bps" ? priorBucket(v, n.prior_move) : undefined);
  }
  if (Array.isArray(n.age_out_of_range)) for (const a of n.age_out_of_range) if ((AGED as readonly unknown[]).includes(a)) bump(c.ages_out_of_range, a as string);
  const vs = typeof n.trade_vs_day === "string" && (TRADE_VS_DAY as readonly string[]).includes(n.trade_vs_day) ? n.trade_vs_day : null;
  if (vs) {
    const sets = typeof n.trade_sets_daily_price === "string" && (SETS_PRICE as readonly string[]).includes(n.trade_sets_daily_price) ? n.trade_sets_daily_price : "unknown";
    bump(c.day_range_by_daily_price[vs]!, sets);
  }
  if (Array.isArray(n.trade_c)) for (const code of n.trade_c) if (safeCode(code) !== null) bump(c.conditions, code as string);
  const x = safeCode(n.trade_x);
  if (x !== null) bump(c.exchanges, x);
  if (isNum(n.trade_c_dropped) && n.trade_c_dropped !== 0) c.conditions_dropped++;
}

/**
 * A session's (or several sessions') stored records -> counts per fact, per name and in total. Pure and lenient:
 * anything that is not a record with a version-1 probe is counted as without one, and a name entry that is not
 * readable is skipped; nothing throws.
 */
export function summariseProbe(records: readonly unknown[]): ProbeSummary {
  const out: ProbeSummary = { records: 0, with_probe: 0, without_probe: 0, by_feed: { iex: emptyGroup(), sip: emptyGroup(), unknown: emptyGroup() } };
  for (const r of records) {
    out.records++;
    const p = isObj(r) ? r.probe : undefined;
    if (!isObj(p) || p.v !== PROBE_V || !Array.isArray(p.names)) {
      out.without_probe++;
      continue;
    }
    out.with_probe++;
    const g = out.by_feed[isObj(r) && isDataFeed(r.feed) ? r.feed : "unknown"];
    g.records++;
    bump(g.phase, typeof p.phase === "string" && (PHASES as readonly string[]).includes(p.phase) ? p.phase : "invalid-record");
    if (isNum(p.rate_limit) && Number.isInteger(p.rate_limit) && p.rate_limit >= 0) bump(g.rate_limit, String(p.rate_limit));
    if (isNum(p.rate_remaining)) addNum(g.rate_remaining, p.rate_remaining, REMAINING_BUCKETS);
    for (const n of p.names) {
      if (!isObj(n) || typeof n.symbol !== "string" || !SYMBOL_RE.test(n.symbol)) continue;
      add(g.total, n);
      add((g.by_symbol[n.symbol] ??= emptyCounts()), n);
    }
  }
  return out;
}
