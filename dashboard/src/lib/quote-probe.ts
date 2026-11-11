// A log-only probe of Alpaca's raw stock snapshots, kept as temporary evidence for the board's bad-data guards: how
// often a real snapshot shows a shape the guards would pause on (high below low, an open outside the day's range, a
// last trade outside the day's high and low or far from the prior close, a crossed quote) in normal conditions.
//
// Pure and total: every input may be missing, null or of the wrong type, and nothing here throws on it; a field it
// cannot read is reported "absent" or "invalid". It returns enums, booleans, whole and decimal numbers (ages in
// seconds, distances in basis points), symbols and short validated exchange and condition codes only: never a price,
// a level, an amount or free text. Nothing here reads the store, sends anything or changes what the page or the
// server's evaluator sees (desk-run.ts gathers it beside the evaluation; quote.ts hands it the raw answer).
//
// Field names are Alpaca's stock snapshot (v2/stocks/snapshots): `latestTrade` {t, x, p, s, c[], i, z},
// `latestQuote` {t, ax, ap, as, bx, bp, bs, c[], z} (a price of 0 means no active bid or ask), and the bars
// `minuteBar`, `dailyBar`, `prevDailyBar` {t, o, h, l, c, v, n, vw}, each bar stamped with its start (as bars.ts reads it).

export const PROBE_V = 1;
/** One minute bar's length. */
export const MINUTE_MS = 60_000;
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
export const DAILY_DAYS = ["same", "other", "unknown"] as const;
export type DailyDay = (typeof DAILY_DAYS)[number];
export const TRADE_VS_DAY = ["inside", "above-high", "below-low", "other-day", "no-daily-bar", "no-trade"] as const;
export type TradeVsDay = (typeof TRADE_VS_DAY)[number];
export const PRIOR_MOVES = ["within", "at-limit", "beyond", "unknown"] as const;
export type PriorMove = (typeof PRIOR_MOVES)[number];
export const QUOTE_STATES = ["absent", "invalid", "empty", "one-sided", "crossed", "locked", "normal"] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];
export const SOURCES = ["fetched", "cached", "missing"] as const;
export type ProbeSource = (typeof SOURCES)[number];

/** One name's facts from one fetched snapshot. */
export interface NameFacts {
  symbol: string;
  source: "fetched";
  trade: Presence;
  /** Server time minus the trade's time, whole seconds (negative when the trade is stamped after server time). */
  trade_age_s: number | null;
  /** The trade's exchange code, when it is a safe short code. */
  trade_x: string | null;
  /** The trade's condition codes that are safe short codes, in Alpaca's order, at most MAX_CODES. */
  trade_c: string[];
  /** Condition entries dropped (not a safe short code, or past MAX_CODES); -1 when `c` is present but not an array. */
  trade_c_dropped: number;
  minute: MinuteState;
  /** Server time minus the minute bar's start, whole seconds: below 60 it is still forming. */
  minute_age_s: number | null;
  daily: Presence;
  /** The daily bar's New York date against the trade's. */
  daily_day: DailyDay;
  high_below_low: boolean | null;
  open_outside: boolean | null;
  trade_vs_day: TradeVsDay;
  /** How far outside the day's range the trade is, in basis points of the side it crossed; null when inside or unknown. */
  trade_outside_bps: number | null;
  prev: Presence;
  prior_move: PriorMove;
  /** |trade - prior close| / prior close, in basis points; null when unknown. */
  prior_move_bps: number | null;
  quote: QuoteState;
  /** (ask - bid) / mid in basis points, negative when crossed; null unless both sides are there. */
  spread_bps: number | null;
  /** Server time minus the quote's time, whole seconds; null when it has none. */
  quote_age_s: number | null;
}

/** A name the answer did not fetch (served from quote.ts' 1.5 s cache) or fetched with no snapshot at all. */
export interface NameSkipped {
  symbol: string;
  source: "cached" | "missing";
}

export type NameProbe = NameFacts | NameSkipped;

/** What one run stores beside its record (desk-run.ts `probe`). */
export interface ProbeRecord {
  v: typeof PROBE_V;
  names: NameProbe[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
/** One decimal place, so the stored numbers stay short. */
const r1 = (x: number) => Math.round(x * 10) / 10;
const secs = (ms: number) => Math.round(ms / 1000);

const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
function instant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const nyDay = (t: number) => NY_DAY_FMT.format(new Date(t));

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
function bar(v: unknown): { presence: Presence; bar: Bar | null } {
  if (v === undefined || v === null) return { presence: "absent", bar: null };
  if (!isObj(v)) return { presence: "invalid", bar: null };
  const t = instant(v.t);
  if (t === null || !isPos(v.o) || !isPos(v.h) || !isPos(v.l) || !isPos(v.c)) return { presence: "invalid", bar: null };
  return { presence: "ok", bar: { t, o: v.o, h: v.h, l: v.l, c: v.c } };
}

/** The move from the prior close against PRIOR_CLOSE_LIMIT: exactly 25% (within a float's tolerance) is "at-limit". */
export function priorMove(price: number, prior: number): { move: Exclude<PriorMove, "unknown">; bps: number } {
  const dist = Math.abs(price - prior);
  const limit = prior * PRIOR_CLOSE_LIMIT;
  const move = Math.abs(dist - limit) <= prior * AT_LIMIT_TOL ? "at-limit" : dist > limit ? "beyond" : "within";
  return { move, bps: r1((dist / prior) * 10_000) };
}

function quoteFacts(v: unknown, now: number): { quote: QuoteState; spread_bps: number | null; quote_age_s: number | null } {
  if (v === undefined || v === null) return { quote: "absent", spread_bps: null, quote_age_s: null };
  if (!isObj(v)) return { quote: "invalid", spread_bps: null, quote_age_s: null };
  const t = instant(v.t);
  const age = t === null || !Number.isFinite(now) ? null : secs(now - t);
  const { bp, ap } = v;
  // 0 is Alpaca's "no active side"; anything that is not a number of 0 or more is unreadable.
  if (!isNum(bp) || !isNum(ap) || bp < 0 || ap < 0) return { quote: "invalid", spread_bps: null, quote_age_s: age };
  if (bp === 0 && ap === 0) return { quote: "empty", spread_bps: null, quote_age_s: age };
  if (bp === 0 || ap === 0) return { quote: "one-sided", spread_bps: null, quote_age_s: age };
  const spread = r1(((ap - bp) / ((ap + bp) / 2)) * 10_000);
  return { quote: bp > ap ? "crossed" : bp === ap ? "locked" : "normal", spread_bps: spread, quote_age_s: age };
}

/**
 * One name's facts from Alpaca's raw snapshot `raw` at the server's time `now` (ms). Never throws: a missing or
 * malformed part is reported "absent" or "invalid" and the facts that depend on it are null or "unknown".
 */
export function probeSnapshot(symbol: string, raw: unknown, now: number): NameProbe {
  if (raw === undefined || raw === null) return { symbol, source: "missing" };
  const snap = isObj(raw) ? raw : {};
  const serverNow = isNum(now) ? now : Number.NaN;

  // The last trade.
  const tr = snap.latestTrade;
  let trade: Presence = "absent";
  let price: number | null = null;
  let tradeAt: number | null = null;
  if (tr !== undefined && tr !== null) {
    if (isObj(tr) && isPos(tr.p) && instant(tr.t) !== null) {
      trade = "ok";
      price = tr.p;
      tradeAt = instant(tr.t);
    } else trade = "invalid";
  }
  const trObj = isObj(tr) ? tr : {};
  const c = codes(trObj.c);

  // The forming (or last finished) minute.
  const mb = bar(snap.minuteBar);
  const minuteAge = mb.bar && Number.isFinite(serverNow) ? serverNow - mb.bar.t : null;
  // A bar whose minute ends exactly at server time has finished.
  const minute: MinuteState = mb.presence !== "ok" ? mb.presence : minuteAge === null ? "invalid" : minuteAge >= MINUTE_MS ? "finished" : "forming";

  // The day's bar.
  const db = bar(snap.dailyBar);
  const d = db.bar;
  const daily_day: DailyDay = d && tradeAt !== null ? (nyDay(d.t) === nyDay(tradeAt) ? "same" : "other") : "unknown";
  let trade_vs_day: TradeVsDay;
  let outside: number | null = null;
  if (price === null) trade_vs_day = "no-trade";
  else if (!d) trade_vs_day = "no-daily-bar";
  else if (daily_day !== "same") trade_vs_day = "other-day";
  else if (price > d.h) {
    trade_vs_day = "above-high";
    outside = r1(((price - d.h) / d.h) * 10_000);
  } else if (price < d.l) {
    trade_vs_day = "below-low";
    outside = r1(((d.l - price) / d.l) * 10_000);
  } else trade_vs_day = "inside";

  // The prior session's close.
  const pb = bar(snap.prevDailyBar);
  const pm = price !== null && pb.bar ? priorMove(price, pb.bar.c) : null;

  const q = quoteFacts(snap.latestQuote, serverNow);
  return {
    symbol,
    source: "fetched",
    trade,
    trade_age_s: tradeAt !== null && Number.isFinite(serverNow) ? secs(serverNow - tradeAt) : null,
    trade_x: safeCode(trObj.x),
    trade_c: c.kept,
    trade_c_dropped: c.dropped,
    minute,
    minute_age_s: minuteAge === null ? null : secs(minuteAge),
    daily: db.presence,
    daily_day,
    high_below_low: d ? d.h < d.l : null,
    open_outside: d ? d.o < d.l || d.o > d.h : null,
    trade_vs_day,
    trade_outside_bps: outside,
    prev: pb.presence,
    prior_move: pm ? pm.move : "unknown",
    prior_move_bps: pm ? pm.bps : null,
    quote: q.quote,
    spread_bps: q.spread_bps,
    quote_age_s: q.quote_age_s,
  };
}

/** What quote.ts hands over for one upstream call: the raw snapshot per name it fetched, and the server time it used. */
export interface RawSnapshots {
  /** The names this call fetched; any other name asked for was served from the cache. */
  fetched: Readonly<Record<string, unknown>>;
  at: number;
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
  return { v: PROBE_V, names };
}

// ---- the reader -------------------------------------------------------------------------------------------------------

/** The enum facts counted per value. */
const ENUM_FACTS = {
  source: SOURCES,
  trade: PRESENCE,
  minute: MINUTE_STATES,
  daily: PRESENCE,
  daily_day: DAILY_DAYS,
  trade_vs_day: TRADE_VS_DAY,
  prev: PRESENCE,
  prior_move: PRIOR_MOVES,
  quote: QUOTE_STATES,
} as const;
type EnumFact = keyof typeof ENUM_FACTS;
/** The yes/no facts, counted as "yes", "no" or "unknown". */
const BOOL_FACTS = ["high_below_low", "open_outside"] as const;
/** The numbers whose largest value is kept (the worst seen). */
const MAX_FACTS = ["trade_outside_bps", "prior_move_bps", "spread_bps", "trade_age_s", "quote_age_s", "minute_age_s"] as const;
type MaxFact = (typeof MAX_FACTS)[number];

export interface FactCounts {
  /** Probed names in the records (every source). */
  samples: number;
  /** Per fact, the count per value; a stored value that is not one of the fact's words counts as "invalid-record". */
  counts: Record<EnumFact | (typeof BOOL_FACTS)[number], Record<string, number>>;
  /** The worst (largest) value of each number seen; for spread_bps also the smallest (the most crossed). */
  max: Record<MaxFact, number | null>;
  min_spread_bps: number | null;
  /** Trade condition codes and exchange codes seen, with their counts. */
  conditions: Record<string, number>;
  exchanges: Record<string, number>;
  /** Fetched samples with at least one condition code dropped (unsafe, too many, or not an array). */
  conditions_dropped: number;
}

export interface ProbeSummary {
  /** Records read, those carrying a probe, and those without (written before the probe, or no answer in that run). */
  records: number;
  with_probe: number;
  without_probe: number;
  total: FactCounts;
  by_symbol: Record<string, FactCounts>;
}

function emptyCounts(): FactCounts {
  const counts = {} as FactCounts["counts"];
  for (const f of Object.keys(ENUM_FACTS) as EnumFact[]) counts[f] = Object.fromEntries(ENUM_FACTS[f].map((v) => [v, 0]));
  for (const f of BOOL_FACTS) counts[f] = { yes: 0, no: 0, unknown: 0 };
  const max = Object.fromEntries(MAX_FACTS.map((f) => [f, null])) as FactCounts["max"];
  return { samples: 0, counts, max, min_spread_bps: null, conditions: {}, exchanges: {}, conditions_dropped: 0 };
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
  for (const f of MAX_FACTS) {
    const v = n[f];
    if (isNum(v)) c.max[f] = c.max[f] === null ? v : Math.max(c.max[f], v);
  }
  if (isNum(n.spread_bps)) c.min_spread_bps = c.min_spread_bps === null ? n.spread_bps : Math.min(c.min_spread_bps, n.spread_bps);
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
  const out: ProbeSummary = { records: 0, with_probe: 0, without_probe: 0, total: emptyCounts(), by_symbol: {} };
  for (const r of records) {
    out.records++;
    const p = isObj(r) ? r.probe : undefined;
    if (!isObj(p) || p.v !== PROBE_V || !Array.isArray(p.names)) {
      out.without_probe++;
      continue;
    }
    out.with_probe++;
    for (const n of p.names) {
      if (!isObj(n) || typeof n.symbol !== "string" || !SYMBOL_RE.test(n.symbol)) continue;
      add(out.total, n);
      add((out.by_symbol[n.symbol] ??= emptyCounts()), n);
    }
  }
  return out;
}
