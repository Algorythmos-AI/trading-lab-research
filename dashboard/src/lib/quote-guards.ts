// The board's bad-data guards (the plan's L3): four checks on one name's normalised snapshot quote (quote.ts), each
// a reason for the board to read "paused: check your platform" instead of a state. Pure and total: no I/O, no clock of
// its own (the caller passes the session's day and its clock), nothing here throws.
//
// The definitions are the log-only snapshot probe's (quote-probe.ts), which imports them from here, so the probe's
// counts are counts of exactly these checks:
//  * bar-high-below-low: the day's bar reads a high below its low;
//  * bar-open-outside-range: the day's bar reads an open below its low or above its high;
//  * print-far-outside-day-range: a bad print. The last trade is BOTH more than PRIOR_CLOSE_LIMIT (25%) from the prior
//    session's close AND outside today's day bar (above its high or below its low), with today's bar and today's trade.
//    Exactly 25% (within a float's tolerance) is "at-limit", not far: the probe's `at-limit` bucket. Neither condition
//    alone trips it: a real gap of more than 25% (earnings), or a split day read against an unadjusted prior close,
//    leaves the price inside the day's own range; and a trade outside the day's range alone happens in normal trading,
//    since the day's bar leaves out extended-hours and volume-only prints. Not a halt or price-band rule;
//  * quote-crossed: both sides of the quote are active and the bid is above the ask (quote-shape.ts), on a quote that is
//    fresh by the trade's own rule (stamped no more than TRADE_STALE_MS before the clock). A locked quote (bid = ask)
//    is not crossed; a zero price or size on one side reads one-sided, not crossed; a stale or timeless quote never
//    trips it.
//
// A guard needs its inputs present and valid, as the probe reads them; missing or unreadable inputs never trip one.
// Whether a guard pauses the board is the owner's switch (desk-guards.ts); every switch is off until he turns it on.
import { TRADE_STALE_MS } from "./entry-checks";
import { quoteShape } from "./quote-shape";

/** The guard reasons, in the order the board names them. */
export const GUARD_REASONS = ["bar-high-below-low", "bar-open-outside-range", "print-far-outside-day-range", "quote-crossed"] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

/** The page's plain words for each reason, in "Suspect data, <words>: check your platform". */
export const GUARD_WORDS: Record<GuardReason, string> = {
  "bar-high-below-low": "the day's high reads below its low",
  "bar-open-outside-range": "the day's open reads outside its high and low",
  "print-far-outside-day-range": "the price is more than 25% from the prior close and outside the day's range",
  "quote-crossed": "the bid is above the ask",
};

/** The move from the prior close the guard pauses beyond (more than 25%; exactly 25% is "at-limit"). */
export const PRIOR_CLOSE_LIMIT = 0.25;
/** A relative tolerance for "exactly at the limit", so a float's last bit cannot move a boundary case. */
export const AT_LIMIT_TOL = 1e-9;

export const PRESENCE = ["ok", "absent", "invalid"] as const;
export type Presence = (typeof PRESENCE)[number];

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;

/**
 * A time as Alpaca sends it: "absent" when missing or null; "invalid" when not a string, unparseable or before 1970
 * (Go's zero time `0001-01-01T00:00:00Z`). Any other parseable time is read, however old.
 */
export function readStamp(v: unknown): { state: Presence; t: number | null } {
  if (v === undefined || v === null) return { state: "absent", t: null };
  if (typeof v !== "string") return { state: "invalid", t: null };
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < 0) return { state: "invalid", t: null };
  return { state: "ok", t };
}

export type RawBar = { t: number; o: number; h: number; l: number; c: number };
/** A bar is "ok" with a readable start and positive o, h, l, c; "absent" when missing or null; "invalid" otherwise. */
export function readBar(v: unknown): { presence: Presence; bar: RawBar | null; t: number | null } {
  if (v === undefined || v === null) return { presence: "absent", bar: null, t: null };
  if (!isObj(v)) return { presence: "invalid", bar: null, t: null };
  const s = readStamp(v.t);
  if (s.t === null || !isPos(v.o) || !isPos(v.h) || !isPos(v.l) || !isPos(v.c)) return { presence: "invalid", bar: null, t: s.t };
  return { presence: "ok", bar: { t: s.t, o: v.o, h: v.h, l: v.l, c: v.c }, t: s.t };
}

/** The day bar's two checks, on a bar `readBar` read as "ok". */
export function barChecks(b: { o: number; h: number; l: number }): { high_below_low: boolean; open_outside: boolean } {
  return { high_below_low: b.h < b.l, open_outside: b.o < b.l || b.o > b.h };
}

/** Where a price sits against a day bar's high and low: above it, below it, or (null) inside it, edges included. */
export function outsideDayRange(price: number, b: { h: number; l: number }): "above-high" | "below-low" | null {
  return price > b.h ? "above-high" : price < b.l ? "below-low" : null;
}

const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The move from the prior close against PRIOR_CLOSE_LIMIT: exactly 25% (within a float's tolerance) is "at-limit". */
export function priorMove(price: number, prior: number): { move: "within" | "at-limit" | "beyond"; bps: number } {
  const dist = Math.abs(price - prior);
  const limit = prior * PRIOR_CLOSE_LIMIT;
  const move = Math.abs(dist - limit) <= prior * AT_LIMIT_TOL ? "at-limit" : dist > limit ? "beyond" : "within";
  return { move, bps: Math.round((dist / prior) * 10_000 * 10) / 10 };
}

/**
 * What quote.ts' normalise adds to a quote for the guards, all optional (a quote built elsewhere, a fixture, an older
 * cached answer has none, and then no guard can trip):
 * - `bar_ok` / `prev_bar_ok`: the day's bar and the prior day's bar as `readBar` reads them are "ok", so `open`,
 *   `high`, `low` and `prev_close` are those bars' own positive prices;
 * - the quote's two sides (`latestQuote` bp, ap, bs, as) and its time, present only when `quoteShape` can read them
 *   (not "invalid"): a size Alpaca left out stays out.
 */
export interface SnapshotQuoteFields {
  bar_ok?: boolean;
  prev_bar_ok?: boolean;
  bid?: number;
  ask?: number;
  bid_size?: number;
  ask_size?: number;
  /** When the quote was stamped, ISO 8601; only when readable. */
  quote_at?: string;
}

/** What the guards read of a normalised quote. */
export interface GuardQuote extends SnapshotQuoteFields {
  /** The day bar's New York day (quote.ts' `day`). */
  day?: string | null;
  price: number;
  at: string;
  open: number | null;
  high: number | null;
  low: number | null;
  prev_close: number | null;
}

/** What a guard reads beside the quote: the session's New York day and the clock (ms) it is judged at. */
export interface GuardContext {
  today: string;
  now: number;
}

/**
 * The last trade is more than 25% from the prior close (the prior-close fact alone, recorded in observe mode beside
 * the guard): a positive price with a trade time from 1970 on, and a readable prior bar (`prev_bar_ok`).
 */
export function farFromPriorClose(q: GuardQuote | null | undefined): boolean {
  if (!q || !isObj(q)) return false;
  return q.prev_bar_ok === true && isPos(q.prev_close) && isPos(q.price) && readStamp(q.at).state === "ok" && priorMove(q.price, q.prev_close).move === "beyond";
}

/**
 * The guard reasons that apply to one name's quote, in GUARD_REASONS order; [] for no quote. Each guard reads only
 * inputs the probe would read as present and valid:
 * - the two bar guards need `bar_ok` (the day's bar readable, its prices positive);
 * - the bad-print guard needs `farFromPriorClose`, `bar_ok`, the day bar's day and the trade's New York day both
 *   `ctx.today`, and the price outside the bar's high and low;
 * - the crossed-quote guard needs both sides (`bid`, `ask`) as normalise keeps them and a `quote_at` no more than
 *   TRADE_STALE_MS before `ctx.now`.
 * Without `ctx` the last two cannot trip.
 */
export function quoteGuards(q: GuardQuote | null | undefined, ctx: GuardContext | null): GuardReason[] {
  if (!q || !isObj(q)) return [];
  const out: GuardReason[] = [];
  const barOk = q.bar_ok === true && isPos(q.open) && isPos(q.high) && isPos(q.low);
  if (barOk) {
    const b = barChecks({ o: q.open!, h: q.high!, l: q.low! });
    if (b.high_below_low) out.push("bar-high-below-low");
    if (b.open_outside) out.push("bar-open-outside-range");
  }
  if (ctx && barOk && q.day === ctx.today && farFromPriorClose(q)) {
    const t = readStamp(q.at).t!;
    if (NY_DAY_FMT.format(new Date(t)) === ctx.today && outsideDayRange(q.price, { h: q.high!, l: q.low! }) !== null) out.push("print-far-outside-day-range");
  }
  if (ctx && q.bid !== undefined && q.ask !== undefined) {
    const qt = readStamp(q.quote_at).t;
    if (qt !== null && ctx.now - qt <= TRADE_STALE_MS && quoteShape(q.bid, q.ask, q.bid_size, q.ask_size).shape === "crossed") out.push("quote-crossed");
  }
  return out;
}

/** The reasons that pause the board: those that apply and whose switch is on, in GUARD_REASONS order. */
export function activeGuards(reasons: readonly GuardReason[], on: readonly GuardReason[] | null | undefined): GuardReason[] {
  if (!on || on.length === 0) return [];
  return GUARD_REASONS.filter((r) => reasons.includes(r) && on.includes(r));
}

/** The board's paused line for the reasons that tripped: "Suspect data, the bid is above the ask: check your platform". */
export function guardLine(reasons: readonly GuardReason[]): string {
  return `Suspect data, ${reasons.map((r) => GUARD_WORDS[r]).join(" and ")}: check your platform`;
}
