// Market context for the Options page's market bar (B2): what SPY and QQQ are doing, read from one /api/flow answer.
// Facts only: a price against session VWAP, the last five completed 10-minute closes, relative volume and the spread.
// Nothing here draws, alerts, changes a board state, a rule or a level, and nothing reads the engine's states.
//
// These thresholds (five 10-minute closes, three of four steps, the 20 s freshness limit) are DISPLAY definitions for
// now: they are frozen in a decision record before any signal uses them. The bar marks them "Testing".
//
// Pure: no I/O and no clock; the caller passes the answer and its checked age (flow-request.ts). Browser-safe. The slot
// clock is the answer's own (flow.ts slotClockFromAsOf), never the device's. Every input that is missing, stale or
// unusable gives null with a reason, never a direction: no colour is ever shown on data that cannot be trusted.
import {
  completedBars,
  type FlowBar,
  type FlowWhy,
  nameBaseline,
  type NameStats,
  relativeVolume,
  type SlotClock,
  SLOT_MS,
  slotClockFromAsOf,
  type Spread,
  spreadBps,
  type VolumeRatio,
  vwapSide,
  type VwapSide,
  sessionSlots,
  sessionVwap,
} from "./flow";
import { addDays, nyNow } from "./market-calendar";
import { SERVER_SETTLE_MS } from "./trade-state";

/** The two indexes the bar reads. Nothing per focus name here (EXP-0032's blind). */
export const INDEXES = ["SPY", "QQQ"] as const;
export type IndexSymbol = (typeof INDEXES)[number];

/** 2-minute slots in one 10-minute block. */
export const BLOCK_SLOTS = 5;
/** Completed 10-minute closes a trend is read over. */
export const TREND_CLOSES = 5;
/** Of the four steps between those closes, at least this many must go the trend's way. */
export const TREND_STEPS = 3;
/** An answer, a trade or a quote older than this (checked age, ms) is stale: no direction. Exactly 20 s still counts. */
export const STALE_MS = 20_000;

export type Trend = "up" | "down" | "range";
export type Direction = Trend;
export type MarketWord = "up" | "down" | "mixed" | "range";

/** Why an index has no direction. flow.ts's reasons, plus this module's own. */
export type ContextWhy = FlowWhy | "stale" | "too-early" | "no-price" | "no-vwap" | "one-sided" | "crossed";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;

// ---- 10-minute closes -------------------------------------------------------------------------------------------------

/** One completed 10-minute block that holds at least one bar. */
export interface BlockClose {
  /** Block j holds slots 5j to 5j + 4. */
  block: number;
  /** Its latest bar's close: a missing 2-minute bar inside the block carries the previous close. */
  close: number;
  /** How many of its five slots have a bar. */
  bars: number;
  /** Its last slot (5j + 4) has a bar. */
  hasLast: boolean;
}

/**
 * Today's COMPLETED 10-minute blocks, keyed by block index, oldest first, from the completed 2-minute bars (one per
 * slot, the last given wins, in slot order however they came). A block counts only once all five of its slots have
 * completed (flow.ts's settle included); the forming bar never counts. A block with no bar at all is absent here, and
 * direction() reads a gap among the last five as "lagging": it is never skipped over or carried into a reading.
 */
export function tenMinuteCloses(bars: readonly FlowBar[] | null | undefined, clock: SlotClock | null): BlockClose[] {
  if (!bars || !clock) return [];
  const blocks = Math.floor(clock.completed / BLOCK_SLOTS);
  const out = new Map<number, BlockClose>();
  for (const { slot, bar } of completedBars(bars, clock)) {
    const j = Math.floor(slot / BLOCK_SLOTS);
    if (j >= blocks || !isPos(bar.c)) continue;
    const prev = out.get(j);
    // completedBars is in slot order, so the latest bar of the block wins the close
    out.set(j, { block: j, close: bar.c, bars: (prev?.bars ?? 0) + 1, hasLast: slot === j * BLOCK_SLOTS + BLOCK_SLOTS - 1 });
  }
  return [...out.values()].sort((a, b) => a.block - b.block);
}

/** A block a reading may use: a bar in its last slot and in at least this many of its five. */
export const BLOCK_MIN_BARS = 4;

/**
 * The five consecutive most recent completed blocks, or why not: fewer than five completed ("too-early"), or one of
 * them missing, without a bar in its last slot or with fewer than BLOCK_MIN_BARS bars ("lagging").
 */
export function lastFiveBlocks(bars: readonly FlowBar[], clock: SlotClock): { closes: number[] } | { why: "too-early" | "lagging" } {
  const done = Math.floor(clock.completed / BLOCK_SLOTS);
  if (done < TREND_CLOSES) return { why: "too-early" };
  const byBlock = new Map(tenMinuteCloses(bars, clock).map((b) => [b.block, b]));
  const closes: number[] = [];
  for (let j = done - TREND_CLOSES; j < done; j++) {
    const b = byBlock.get(j);
    if (!b || !b.hasLast || b.bars < BLOCK_MIN_BARS) return { why: "lagging" };
    closes.push(b.close);
  }
  return { closes };
}

/** A bar for the last completed 2-minute slot is there: otherwise the bars lag the clock. */
function lastSlotHasBar(bars: readonly FlowBar[], clock: SlotClock): boolean {
  if (clock.completed === 0) return false;
  const done = completedBars(bars, clock);
  return done.length > 0 && done[done.length - 1]!.slot === clock.completed - 1;
}

// ---- the session's hours ----------------------------------------------------------------------------------------------

/** The regular session is open at `ms` (New York's calendar). */
export function sessionOpenAt(ms: number): boolean {
  const s = sessionSlots(nyNow(new Date(ms)).day);
  return s !== null && ms >= s.open && ms < s.close;
}

/** The next regular-session open (09:30 New York on the next session day) strictly after `ms`; null past the calendar. */
export function nextOpenAfter(ms: number): number | null {
  const day = nyNow(new Date(ms)).day;
  for (let d = 0; d < 15; d++) {
    const s = sessionSlots(addDays(day, d));
    if (s && s.open > ms) return s.open;
  }
  return null;
}

// ---- trend --------------------------------------------------------------------------------------------------------------

export type TrendRead = { trend: Trend; closes: number[] } | { trend: null; why: "too-early"; closes: number[] };

/**
 * Over the last five completed 10-minute closes: "up" when the last is above the first AND at least three of the four
 * steps rise; "down" mirrored; otherwise "range". Fewer than five closes: null, "too-early". A step that is flat is
 * neither a rise nor a fall.
 */
export function trend(closes: readonly number[]): TrendRead {
  const last = closes.slice(-TREND_CLOSES);
  if (last.length < TREND_CLOSES || !last.every(isPos)) return { trend: null, why: "too-early", closes: last };
  let rises = 0;
  let falls = 0;
  for (let i = 1; i < last.length; i++) {
    if (last[i]! > last[i - 1]!) rises++;
    else if (last[i]! < last[i - 1]!) falls++;
  }
  const first = last[0]!;
  const end = last[last.length - 1]!;
  if (end > first && rises >= TREND_STEPS) return { trend: "up", closes: last };
  if (end < first && falls >= TREND_STEPS) return { trend: "down", closes: last };
  return { trend: "range", closes: last };
}

// ---- one index ----------------------------------------------------------------------------------------------------------

/** One index's row of a /api/flow answer: the fields this module reads. */
export interface IndexRow {
  price: number | null;
  trade_at: string | null;
  bid: number | null;
  ask: number | null;
  quote_at: string | null;
  bars: FlowBar[] | null;
}

/** What direction() reads for one index. */
export interface IndexInput {
  symbol: string;
  row: IndexRow | null | undefined;
  baseline: { for_session: string; names: Readonly<Record<string, NameStats>> } | null | undefined;
  /** The answer's slot clock, from its `as_of` (slotClockFromAsOf). */
  clock: SlotClock | null;
  /** The answer's `as_of`, ms. */
  asOf: number | null;
  /** The answer's checked age (flow-request.ts), ms; null when it cannot be judged fresh at all. */
  ageMs: number | null;
}

/** One index's reading, with the values that produced it so the page can show the evidence. */
export interface IndexReading {
  symbol: string;
  direction: Direction | null;
  why: ContextWhy | null;
  price: number | null;
  vwap: number | null;
  side: VwapSide | null;
  /** The last five completed 10-minute closes (fewer early in the day), oldest first. */
  closes: number[];
  trend: TrendRead;
  volume: VolumeRatio;
  spread: Spread;
  /** How old the price is, ms: the answer's checked age plus the oldest of its trade and quote before `as_of`. */
  ageMs: number | null;
}

/** The input for one index from a /api/flow answer and its checked age. */
export function indexInput(answer: { as_of: string; baseline: IndexInput["baseline"]; names: Readonly<Record<string, IndexRow>> } | null, symbol: string, ageMs: number | null): IndexInput {
  const asOf = answer ? Date.parse(answer.as_of) : NaN;
  return {
    symbol,
    row: answer && Object.hasOwn(answer.names, symbol) ? answer.names[symbol] : null,
    baseline: answer?.baseline ?? null,
    clock: answer ? slotClockFromAsOf(answer.as_of) : null,
    asOf: Number.isFinite(asOf) ? asOf : null,
    ageMs,
  };
}

const at = (iso: string | null | undefined): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The price's age: the answer's checked age plus how far its older of trade and quote stood before `as_of`. */
function priceAge(i: IndexInput): number | null {
  if (i.ageMs === null || !isNum(i.ageMs) || i.asOf === null) return null;
  const trade = at(i.row?.trade_at);
  const quote = at(i.row?.quote_at);
  if (trade === null || quote === null) return null;
  return i.ageMs + Math.max(0, i.asOf - Math.min(trade, quote));
}

/**
 * "up" only when the price is ABOVE session VWAP (flow.ts vwapSide, with its dead band) and the trend is "up"; "down"
 * mirrored; "range" otherwise ("at" VWAP is always range). Null with the first reason that applies, in this order:
 *  * "closed": the answer's clock is outside the regular session, and the answer is not older than the time to the
 *    next open (a closed answer stays true until then; past it, or with no age at all, it is "stale");
 *  * "stale": the answer or its price older than STALE_MS by checked age;
 *  * no bars, no price; a one-sided or crossed quote;
 *  * "lagging": no bar for the last completed 2-minute slot;
 *  * no VWAP (computed only once that bar is there);
 *  * "too-early": fewer than five completed 10-minute blocks;
 *  * "lagging": one of the last five blocks missing, without its last slot's bar, or with fewer than 4 of its 5 bars.
 * A locked quote is a market, not bad data: it leaves VWAP's 3 bp band and shows as "locked".
 */
export function direction(i: IndexInput): IndexReading {
  const row = i.row ?? null;
  const clock = i.clock;
  const bars = row?.bars ?? null;
  const price = isPos(row?.price) ? row!.price : null;
  const spread = spreadBps(row?.bid ?? null, row?.ask ?? null);
  const current = bars !== null && clock !== null && lastSlotHasBar(bars, clock);
  const vwap = current ? sessionVwap(bars, clock) : null;
  const side = vwapSide(price, vwap, spread.bps);
  const five = bars && clock ? lastFiveBlocks(bars, clock) : { why: "too-early" as const };
  const tr: TrendRead = "closes" in five ? trend(five.closes) : { trend: null, why: "too-early", closes: [] };
  const volume = relativeVolume(bars ?? [], nameBaseline(i.baseline ?? null, i.symbol), clock);
  const ageMs = priceAge(i);
  const base = { symbol: i.symbol, price, vwap, side, closes: tr.closes, trend: tr, volume, spread, ageMs };
  const none = (why: ContextWhy): IndexReading => ({ ...base, direction: null, why });

  const fresh = i.ageMs !== null && isNum(i.ageMs);
  const closed = !clock || clock.now < clock.open || clock.now >= clock.close;
  if (closed) {
    const next = i.asOf !== null ? nextOpenAfter(i.asOf) : null;
    return fresh && i.asOf !== null && (next === null || i.asOf + i.ageMs! < next) ? none("closed") : none("stale");
  }
  if (!fresh || i.ageMs! > STALE_MS) return none("stale");
  if (!row || !bars) return none("no-bars");
  if (price === null) return none("no-price");
  if (ageMs === null || ageMs > STALE_MS) return none("stale");
  if (spread.bps === null && spread.why !== "locked") return none(spread.why);
  if (completedBars(bars, clock).length === 0) return none("no-bars");
  if (!current) return none("lagging");
  if (vwap === null) return none("no-vwap");
  if ("why" in five) return none(five.why);
  if (tr.trend === null) return none("too-early");
  if (side === null) return none("no-vwap");
  const d: Direction = side === "above" && tr.trend === "up" ? "up" : side === "below" && tr.trend === "down" ? "down" : "range";
  return { ...base, direction: d, why: null };
}

// ---- both -------------------------------------------------------------------------------------------------------------

export type MarketRead = { read: MarketWord; why: null } | { read: null; why: { symbol: string; why: ContextWhy }[] };

/**
 * "up" when both are up, "down" when both are down, "range" when both range, and "mixed" on ANY disagreement (up with
 * down, and also either one with range). Null when either has no direction, with each one's reason.
 */
export function marketRead(spy: IndexReading, qqq: IndexReading): MarketRead {
  const missing = [spy, qqq].filter((r) => r.direction === null).map((r) => ({ symbol: r.symbol, why: r.why ?? ("no-bars" as ContextWhy) }));
  if (missing.length) return { read: null, why: missing };
  const a = spy.direction!;
  const b = qqq.direction!;
  return { read: a === b ? a : "mixed", why: null };
}

// ---- words ------------------------------------------------------------------------------------------------------------

const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** When the fifth 10-minute block of `clock`'s session has completed (settle included): the first trend. */
export function firstTrendAt(clock: SlotClock): number {
  return clock.open + TREND_CLOSES * BLOCK_SLOTS * SLOT_MS + SERVER_SETTLE_MS;
}

/** An age in plain words: "25 s", "3 min", "over an hour". */
export function ageWords(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 120) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return "over an hour";
}

/** One reason in plain words, for the bar's headline. `clock` gives the first-trend time; `ageMs` the stale age. */
export function whyWords(why: ContextWhy, clock: SlotClock | null = null, ageMs: number | null = null): string {
  switch (why) {
    case "stale":
      return ageMs === null ? "prices are updating" : `prices are ${ageWords(ageMs)} old`;
    case "closed":
      return "market closed";
    case "too-early":
      return clock ? `before ${hhmm(firstTrendAt(clock))}: not enough bars yet` : "not enough bars yet";
    case "before-0935":
      return "before 09:35";
    case "no-bars":
      return "no bars yet";
    case "lagging":
      return "bars are behind";
    case "no-price":
      return "no last price";
    case "no-vwap":
      return "no VWAP yet";
    case "one-sided":
      return "quote is one-sided";
    case "crossed":
      return "quote is crossed";
    case "thin-baseline":
      return "too few past sessions";
    case "no-baseline":
      return "no volume baseline";
    case "stale-baseline":
      return "volume baseline is not today's";
    case "half-day-close":
      return "closing auction";
  }
}

/** Relative volume in plain words: "1.4× normal volume", or its reason. */
export function volumeWords(v: VolumeRatio): string {
  if (v.value !== null) return `${v.value.toFixed(1)}× normal volume`;
  return v.why === "closed" ? "volume: market closed" : v.why === "before-0935" ? "volume from 09:35" : `volume: ${whyWords(v.why)}`;
}

/** The bid–ask gap in plain words: "bid–ask 0.3 bp", "locked", "crossed", or "one-sided". */
export function spreadWords(s: Spread): string {
  // "bid–ask", not the other word for it: the classic Options page bans that word, which reads as an option strategy.
  if (s.bps !== null) return `bid–ask ${s.bps < 10 ? s.bps.toFixed(1) : Math.round(s.bps)} bp`;
  return s.why === "one-sided" ? "one-sided quote" : s.why;
}
