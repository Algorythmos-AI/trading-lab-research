// A log-only probe of Alpaca's raw stock snapshots, kept as temporary evidence for the board's bad-data guards: how
// often a real snapshot shows a shape the guards would pause on (high below low, an open outside the day's range, a
// last trade outside the day's high and low or far from the prior close, a crossed quote) in normal conditions.
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

export const PROBE_V = 1;
/** One minute bar's length. */
export const MINUTE_MS = 60_000;
/** A time further than this from server time, either way, is unreadable (as is one before 1970, e.g. Go's zero time). */
export const MAX_STAMP_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
/** The move from the prior close the guard would pause beyond (more than 25%; exactly 25% is "at-limit"). */
export const PRIOR_CLOSE_LIMIT = 0.25;
/** A relative tolerance for "exactly at the limit", so a float's last bit cannot move a boundary case. */
const AT_LIMIT_TOL = 1e-9;
/** A trade condition or exchange code as stored: 1 or 2 characters of A-Z, 0-9, space or "@". Anything else is dropped. */
export const CODE_RE = /^[A-Z0-9 @]{1,2}$/;
/** At most this many condition codes are kept per trade (Alpaca sends a handful). */
export const MAX_CODES = 8;
/** At most this many names are probed per answer (quote.ts' MAX_SYMBOLS). */
export const MAX_PROBED = 60;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export const PRESENCE = ["ok", "absent", "invalid"] as const;
export type Presence = (typeof PRESENCE)[number];
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
/** The run's phase by New York time and the exchange calendar (half days included). */
export const PHASES = ["pre-open", "regular", "after-close", "closed", "unknown"] as const;
export type Phase = (typeof PHASES)[number];
/** What the last trade's conditions say about the last price, strictest first (see TRADE_CLASS_ORDER). */
export const TRADE_CLASSES = ["other-non-updating", "odd-lot", "derivatively-priced", "extended-hours", "unknown", "regular"] as const;
export type TradeClass = (typeof TRADE_CLASSES)[number];

/** One name's facts from one fetched snapshot. */
export interface NameFacts {
  symbol: string;
  source: "fetched";
  /** "invalid" for a price that is not positive or a time that is unreadable (MAX_STAMP_SKEW_MS, before 1970). */
  trade: Presence;
  /** The trade's New York day against the server's. */
  trade_day: DayVsToday;
  /** Server time minus the trade's time, in seconds floored to one decimal (negative when stamped ahead of server time). */
  trade_age_s: number | null;
  /** The trade's exchange code, when it is a safe short code. */
  trade_x: string | null;
  /** The trade's condition codes that are safe short codes, in Alpaca's order, at most MAX_CODES. */
  trade_c: string[];
  /** What those codes say about the last price (tradeClass). */
  trade_class: TradeClass;
  /** Condition entries dropped (not a safe short code, or past MAX_CODES); -1 when `c` is present but not an array. */
  trade_c_dropped: number;
  minute: MinuteState;
  /** Server time minus the minute bar's start, seconds floored to one decimal: below 60 it is still forming. */
  minute_age_s: number | null;
  /**
   * The last trade's age minus the finished minute bar's end age, seconds floored to one decimal (the bar's end minus
   * the trade's time): negative when the trade printed after that bar ended. Null unless both are readable and the
   * bar has finished.
   */
  trade_vs_minute_s: number | null;
  daily: Presence;
  /**
   * The daily bar's New York day against the server's: the page's own test (quote.ts' `day`, the New York day of
   * `dailyBar.t`, against today), so the probe counts what the page's guard would see.
   */
  daily_day: DayVsToday;
  /** The daily bar's and the prior daily bar's New York days against the calendar: before 09:30, is dailyBar still yesterday's? */
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

/**
 * A time as Alpaca sends it, against server time `now`: "absent" when missing or null; "invalid" when not a string,
 * unparseable, before 1970, or further than MAX_STAMP_SKEW_MS from `now` (not checked when `now` is unusable).
 */
function stamp(v: unknown, now: number): { state: Presence; t: number | null } {
  if (v === undefined || v === null) return { state: "absent", t: null };
  if (typeof v !== "string") return { state: "invalid", t: null };
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < 0) return { state: "invalid", t: null };
  if (Number.isFinite(now) && Math.abs(now - t) > MAX_STAMP_SKEW_MS) return { state: "invalid", t: null };
  return { state: "ok", t };
}

const age = (t: number | null, now: number) => (t === null || !Number.isFinite(now) ? null : ageSeconds(now - t));
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

type Bar = { t: number; o: number; h: number; l: number; c: number };
/** A bar is "ok" with a readable start and positive o, h, l, c; "absent" when missing or null; "invalid" otherwise. */
function bar(v: unknown, now: number): { presence: Presence; bar: Bar | null; t: number | null } {
  if (v === undefined || v === null) return { presence: "absent", bar: null, t: null };
  if (!isObj(v)) return { presence: "invalid", bar: null, t: null };
  const s = stamp(v.t, now);
  if (s.t === null || !isPos(v.o) || !isPos(v.h) || !isPos(v.l) || !isPos(v.c)) return { presence: "invalid", bar: null, t: s.t };
  return { presence: "ok", bar: { t: s.t, o: v.o, h: v.h, l: v.l, c: v.c }, t: s.t };
}

// Alpaca's market-data FAQ, "How are bars aggregated" (docs.alpaca.markets/docs/market-data-faq, read 2026-11-12):
// minute and daily bars are built from trades, a trade with several conditions takes the strictest rule, and its
// condition table says which codes do not update open/close (the last price) or high/low:
//  * I (odd lot), and C, H, M, N, Q, R, U, V, W, 7, and B on tapes A and B (average price): never update the price;
//    M and Q do not even update volume;
//  * G, P, Z: not on minute bars, and on daily bars only as a bar's first trade; 9 (corrected consolidated close): not
//    on minute bars; so none of them sets the last price as it moves;
//  * 4 (derivatively priced): not on minute bars; on daily bars high/low, and open/close only as the first trade;
//  * T (extended hours): updates minute bars, not daily bars; U as above;
//  * blank, @, A, D, E, F, K, L, O, X, Y, 5, 6, and B on tape C (bunched): update everything.
// G, P and 9 are not on the list the probe was specified with; the FAQ's table puts them with the non-updating codes,
// so they are counted there. A code outside the table is "unknown".
const ODD_LOT = new Set(["I"]);
const EXTENDED = new Set(["T", "U"]);
const DERIVED = new Set(["4"]);
const NON_UPDATING = new Set(["7", "9", "C", "G", "H", "M", "N", "P", "Q", "R", "V", "W", "Z"]);
const REGULAR = new Set([" ", "@", "A", "D", "E", "F", "K", "L", "O", "X", "Y", "5", "6"]);
/** Strictest first: a trade takes the first class any of its codes falls in. */
export const TRADE_CLASS_ORDER = TRADE_CLASSES;

/**
 * The last trade's class from its condition codes and its tape (`z`), strictest first. "unknown" when there is no
 * code to read (none sent, or every one dropped as unsafe) or a code is outside the FAQ's table and nothing stricter
 * is there; a dropped code also makes an otherwise regular trade "unknown", since it could be anything.
 */
export function tradeClass(codesIn: readonly string[], dropped: number, tape: unknown): TradeClass {
  const found = new Set<TradeClass>();
  for (const c of codesIn) {
    if (ODD_LOT.has(c)) found.add("odd-lot");
    else if (EXTENDED.has(c)) found.add("extended-hours");
    else if (DERIVED.has(c)) found.add("derivatively-priced");
    else if (NON_UPDATING.has(c)) found.add("other-non-updating");
    else if (c === "B") found.add(tape === "C" ? "regular" : tape === "A" || tape === "B" ? "other-non-updating" : "unknown");
    else if (REGULAR.has(c)) found.add("regular");
    else found.add("unknown");
  }
  if (dropped !== 0 || codesIn.length === 0) found.add("unknown");
  for (const k of TRADE_CLASS_ORDER) if (found.has(k)) return k;
  return "unknown";
}

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
  if (!Number.isFinite(now)) return "unknown";
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

/** The move from the prior close against PRIOR_CLOSE_LIMIT: exactly 25% (within a float's tolerance) is "at-limit". */
export function priorMove(price: number, prior: number): { move: Exclude<PriorMove, "unknown">; bps: number } {
  const dist = Math.abs(price - prior);
  const limit = prior * PRIOR_CLOSE_LIMIT;
  const move = Math.abs(dist - limit) <= prior * AT_LIMIT_TOL ? "at-limit" : dist > limit ? "beyond" : "within";
  return { move, bps: r1((dist / prior) * 10_000) };
}

function quoteFacts(v: unknown, now: number): Pick<NameFacts, "quote" | "quote_time" | "spread_bps" | "quote_age_s"> {
  if (v === undefined || v === null) return { quote: "absent", quote_time: "absent", spread_bps: null, quote_age_s: null };
  if (!isObj(v)) return { quote: "invalid", quote_time: "absent", spread_bps: null, quote_age_s: null };
  const s = stamp(v.t, now);
  const base = { quote_time: s.state, quote_age_s: age(s.t, now) };
  const { bp, ap, bs, as: asz } = v;
  // A price of 0 is Alpaca's "no active side"; anything that is not a number of 0 or more is unreadable. A size of 0
  // (sizes are in shares) is no active side too; a size that is sent but not a number of 0 or more is unreadable,
  // and a missing size leaves the side to its price.
  const sizeOk = (z: unknown) => z === undefined || (isNum(z) && z >= 0);
  if (!isNum(bp) || !isNum(ap) || bp < 0 || ap < 0 || !sizeOk(bs) || !sizeOk(asz)) return { quote: "invalid", spread_bps: null, ...base };
  const bid = bp > 0 && bs !== 0;
  const ask = ap > 0 && asz !== 0;
  if (!bid && !ask) return { quote: "empty", spread_bps: null, ...base };
  if (!bid || !ask) return { quote: "one-sided", spread_bps: null, ...base };
  const spread = r1(((ap - bp) / ((ap + bp) / 2)) * 10_000);
  return { quote: bp > ap ? "crossed" : bp === ap ? "locked" : "normal", spread_bps: spread, ...base };
}

/**
 * One name's facts from Alpaca's raw snapshot `raw` at the server's time `now` (ms). Never throws: a missing or
 * malformed part is reported "absent" or "invalid" and the facts that depend on it are null or "unknown".
 */
export function probeSnapshot(symbol: string, raw: unknown, now: number): NameProbe {
  if (raw === undefined || raw === null) return { symbol, source: "missing" };
  if (!isObj(raw)) return { symbol, source: "invalid" };
  const snap = raw;
  const serverNow = isNum(now) ? now : Number.NaN;

  // The last trade.
  const tr = snap.latestTrade;
  let trade: Presence = "absent";
  let price: number | null = null;
  let tradeAt: number | null = null;
  if (tr !== undefined && tr !== null) {
    const s = isObj(tr) ? stamp(tr.t, serverNow) : null;
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
  const mb = bar(snap.minuteBar, serverNow);
  const minuteAge = mb.bar && Number.isFinite(serverNow) ? serverNow - mb.bar.t : null;
  // A bar whose minute ends exactly at server time has finished.
  const minute: MinuteState = mb.presence !== "ok" ? mb.presence : minuteAge === null ? "invalid" : minuteAge >= MINUTE_MS ? "finished" : "forming";
  const tradeVsMinute = minute === "finished" && mb.bar && tradeAt !== null ? ageSeconds(mb.bar.t + MINUTE_MS - tradeAt) : null;

  // The day's bar. Its day is read from its stamp alone, as quote.ts' `day` is, even when its prices are unusable.
  const db = bar(snap.dailyBar, serverNow);
  const d = db.bar;
  const daily_day = dayVsToday(db.t, serverNow);
  let trade_vs_day: TradeVsDay;
  let outside: number | null = null;
  if (price === null) trade_vs_day = "no-trade";
  else if (!d) trade_vs_day = "no-daily-bar";
  // Yesterday's bar with yesterday's last trade (an illiquid name early in the session, or pre-market) is not a trade
  // outside today's range: it is counted apart, so it cannot inflate the counts the guards are set from.
  else if (daily_day !== "today" || trade_day !== "today") trade_vs_day = "stale-day";
  else if (price > d.h) {
    trade_vs_day = "above-high";
    outside = r1(((price - d.h) / d.h) * 10_000);
  } else if (price < d.l) {
    trade_vs_day = "below-low";
    outside = r1(((d.l - price) / d.l) * 10_000);
  } else trade_vs_day = "inside";

  // The prior session's close.
  const pb = bar(snap.prevDailyBar, serverNow);
  const sess = (b: { presence: Presence; t: number | null }) => sessionDay(b.presence === "absent" ? "absent" : b.t === null ? "invalid" : "readable", b.t, serverNow);
  const pm = price !== null && pb.bar ? priorMove(price, pb.bar.c) : null;

  return {
    symbol,
    source: "fetched",
    trade,
    trade_day,
    trade_age_s: age(tradeAt, serverNow),
    trade_x: safeCode(trObj.x),
    trade_c: c.kept,
    trade_c_dropped: c.dropped,
    trade_class: trade === "absent" ? "unknown" : tradeClass(c.kept, c.dropped, trObj.z),
    minute,
    minute_age_s: minuteAge === null ? null : ageSeconds(minuteAge),
    trade_vs_minute_s: tradeVsMinute,
    daily: db.presence,
    daily_day,
    daily_session: sess(db),
    prev_session: sess(pb),
    high_below_low: d ? d.h < d.l : null,
    open_outside: d ? d.o < d.l || d.o > d.h : null,
    trade_vs_day,
    trade_outside_bps: outside,
    prev: pb.presence,
    prior_move: pm ? pm.move : "unknown",
    prior_move_bps: pm ? pm.bps : null,
    ...quoteFacts(snap.latestQuote, serverNow),
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
  const names: NameProbe[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (typeof s !== "string" || !SYMBOL_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    if (names.length >= MAX_PROBED) break;
    names.push(Object.hasOwn(raw.fetched, s) ? probeSnapshot(s, raw.fetched[s], raw.at) : { symbol: s, source: "cached" });
  }
  return { v: PROBE_V, phase: phaseAt(raw.at), rate_limit: rateHeader(raw.rate?.limit), rate_remaining: rateHeader(raw.rate?.remaining), names };
}

// ---- the reader -------------------------------------------------------------------------------------------------------

/** The enum facts counted per value. */
const ENUM_FACTS = {
  source: SOURCES,
  trade: PRESENCE,
  trade_day: DAYS,
  trade_class: TRADE_CLASSES,
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
const BOOL_FACTS = ["high_below_low", "open_outside"] as const;

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
/** For the move from the prior close, whose guard is at 2500 bps (25%). */
export const PRIOR_BUCKETS = [
  ["0-100", 0],
  ["100-500", 100],
  ["500-1000", 500],
  ["1000-2500", 1000],
  ["2500+", 2500],
] as const;
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
function addNum(s: NumStats, v: number, b: Buckets): void {
  s.n++;
  s.min = s.min === null ? v : Math.min(s.min, v);
  s.max = s.max === null ? v : Math.max(s.max, v);
  s.buckets[bucketOf(v, b)] = (s.buckets[bucketOf(v, b)] ?? 0) + 1;
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
  return { samples: 0, counts, numbers, conditions: {}, exchanges: {}, conditions_dropped: 0 };
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
    if (isNum(v)) addNum(c.numbers[f]!, v, b);
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
