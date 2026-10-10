// The options levels page's view helpers. Pure: no I/O; the clock is always passed in.
import { dayIn, NEW_YORK, num } from "./format";
import type { OptionsEdition } from "./options.types";
import type { Tone } from "./radar";

export type Options = OptionsEdition;
export type OptionsTicker = OptionsEdition["tickers"][number];
export type OptionsZone = NonNullable<OptionsTicker["zones"]>[number];
export type OptionsRule = NonNullable<OptionsEdition["rules"]>[number];
export type PaperTrade = NonNullable<OptionsEdition["paper"]>[number];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Whether the edition is the one to use now, by New York date. Built after a close for the next session, it is
 * "next" until that session starts (the evening, the weekend), "today" on its session, and "stale" once a later
 * session has begun without a newer edition.
 */
export function editionState(session: string, now: Date): "next" | "today" | "stale" {
  const today = dayIn(now.toISOString(), NEW_YORK);
  if (!today || today < session) return "next";
  return today === session ? "today" : "stale";
}

/** Zones of this weight or more are "major" (the levels engine uses the same cut). */
export const MAJOR_WEIGHT = 5;

/** One rung of a ticker's ladder: a zone with its distance from the last close. */
export interface Rung {
  zone: OptionsZone;
  /** Edge nearest the close: the bottom of a zone above, the top of a zone below. */
  edge: number;
  /** Signed percent from the close to that edge (negative below); 0 when the close is inside. */
  distPct: number;
  /** The same distance in 14-day ATRs, unsigned; null without an ATR. */
  distAtr: number | null;
  /** True when the close sits inside the zone. */
  inside: boolean;
}

/**
 * A zone without yesterday's close (PDC). The close is always a member of the zone it sits in, so leaving it in
 * would show every name as "inside" a zone; the zone is rebuilt from its other members' prices, and dropped when
 * the close was its only member. Without the edition's levels the zone is used as published.
 */
export function withoutClose(zone: OptionsZone, levels: OptionsTicker["levels"]): OptionsZone | null {
  const members = zone.members ?? [];
  if (!members.includes("PDC")) return zone;
  const rest = members.filter((m) => m !== "PDC");
  if (rest.length === 0) return null;
  const byName = new Map((levels ?? []).map((l) => [l.name, l]));
  const prices: number[] = [];
  for (const m of rest) {
    const l = byName.get(m);
    if (!l) return { ...zone, members: rest };
    prices.push(isNum(l.lo) ? l.lo : l.price, isNum(l.hi) ? l.hi : l.price);
  }
  const weight = isNum(zone.weight) ? zone.weight - (byName.get("PDC")?.weight ?? 1) : zone.weight;
  return {
    ...zone,
    lo: Math.min(...prices),
    hi: Math.max(...prices),
    members: rest,
    weight,
    big: isNum(weight) ? weight >= MAJOR_WEIGHT : zone.big,
  };
}

/**
 * The zones around the last close: above it nearest first, the ones it sits inside, and below it nearest first.
 * Sides come from where each zone lies against the close, so a zone is never shown on the wrong side.
 */
export function ladder(t: OptionsTicker): { above: Rung[]; at: Rung[]; below: Rung[] } {
  const close = t.last?.close;
  if (!isNum(close) || close <= 0) return { above: [], at: [], below: [] };
  const atr = isNum(t.atr14) && t.atr14 > 0 ? t.atr14 : null;
  const above: Rung[] = [];
  const at: Rung[] = [];
  const below: Rung[] = [];
  for (const raw of t.zones ?? []) {
    const zone = withoutClose(raw, t.levels);
    if (!zone) continue;
    if (zone.lo > close) {
      const d = zone.lo - close;
      above.push({ zone, edge: zone.lo, distPct: (d / close) * 100, distAtr: atr ? d / atr : null, inside: false });
    } else if (zone.hi < close) {
      const d = close - zone.hi;
      below.push({ zone, edge: zone.hi, distPct: (-d / close) * 100, distAtr: atr ? d / atr : null, inside: false });
    } else {
      at.push({ zone, edge: close, distPct: 0, distAtr: 0, inside: true });
    }
  }
  above.sort((a, b) => a.edge - b.edge);
  below.sort((a, b) => b.edge - a.edge);
  return { above, at, below };
}

/** The nearest support and resistance beyond the close, for the board. */
export function nearest(t: OptionsTicker): { support: Rung | null; resistance: Rung | null } {
  const { above, below } = ladder(t);
  return { support: below[0] ?? null, resistance: above[0] ?? null };
}

/** Where a one-day and a one-week expected move put price, both ways, from the last close. */
export function moveBands(t: OptionsTicker): { day: [number, number] | null; week: [number, number] | null } {
  const close = t.last?.close;
  const em = t.expected_move;
  const band = (m: number | null | undefined): [number, number] | null =>
    isNum(close) && isNum(m) && m > 0 ? [close - m, close + m] : null;
  return { day: band(em?.day), week: band(em?.week) };
}

export function chipTone(chip: string | null | undefined): Tone {
  if (chip === "STRONG") return "good";
  if (chip === "WEAK") return "bad";
  return "neutral";
}

export const CHIP_LABEL: Record<string, string> = { STRONG: "Strong close", MID: "Mid close", WEAK: "Weak close" };

export function ruleTone(status: OptionsRule["status"]): Tone {
  if (status === "proven") return "good";
  if (status === "probation") return "warn";
  return "neutral";
}

export const RULE_STATUS_LABEL: Record<OptionsRule["status"], string> = {
  proven: "Proven",
  probation: "On probation",
  retired: "Retired",
};

/** A rule's readable name, falling back to its id. */
export function ruleLabel(e: Options, id: string): string {
  return (e.rules ?? []).find((r) => r.id === id)?.label ?? id;
}

/** "PDH" -> "yesterday's high", for tooltips and screen readers. Unknown names are returned as they are. */
export const LEVEL_NAMES: Record<string, string> = {
  PDH: "yesterday's high",
  PDL: "yesterday's low",
  PDC: "yesterday's close",
  PWH: "last week's high",
  PWL: "last week's low",
  WTDH: "this week's high so far",
  WTDL: "this week's low so far",
  PMH: "last month's high",
  PML: "last month's low",
  "52WH": "52-week high",
  "52WL": "52-week low",
  MA20: "20-day average",
  MA50: "50-day average",
  MA200: "200-day average",
  DEMAND: "demand zone (base before a strong up day)",
  SUPPLY: "supply zone (base before a strong down day)",
};

export function levelName(code: string): string {
  return LEVEL_NAMES[code] ?? code;
}

/** A live quote as the page uses it (the /api/quote shape). */
export interface LiveQuote {
  price: number;
  at: string;
  open: number | null;
  high: number | null;
  low: number | null;
  day: string | null;
  prev_close: number | null;
}

/** New York date and minutes after midnight of an instant. Null for an unreadable time. */
export function nyClock(iso: string): { day: string; minutes: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Minutes after midnight in New York when the regular session opens. */
export const OPEN_MIN = 9 * 60 + 30;

/** Minutes after midnight in New York when the regular session ends: 16:00, or 13:00 on a half day. */
export function closeMinute(halfDay: boolean | null | undefined): number {
  return halfDay ? 13 * 60 : 16 * 60;
}

export type LiveStateName =
  | "NOT OPEN YET"
  | "NO TRADE"
  | "GAP ABOVE"
  | "GAP BELOW"
  | "TESTING SUPPORT"
  | "TESTING RESISTANCE"
  | "ABOVE PDH"
  | "BELOW PDL"
  | "INSIDE"
  | "CLOSED";

/**
 * Where a live price stands against the session's levels, by the levels engine's rules (olib.state): no trade in
 * the first 15 minutes; a gap when the session opened beyond yesterday's high or low and is still beyond it;
 * testing a major zone within a quarter ATR of it; otherwise above yesterday's high, below its low, or inside.
 * Judged at the quote's own time, so a stale quote is never read as live. Yesterday's close is left out of the
 * zones, as everywhere on the page.
 */
export function liveState(t: OptionsTicker, q: LiveQuote, session: string): LiveStateName {
  const clock = nyClock(q.at);
  if (!clock) return "NOT OPEN YET";
  if (clock.day > session) return "CLOSED";
  if (clock.day < session || q.day !== session) return "NOT OPEN YET";
  if (clock.minutes >= (t.half_day ? 13 * 60 : 16 * 60)) return "CLOSED";
  if (clock.minutes < OPEN_MIN) return "NOT OPEN YET";
  if (clock.minutes < OPEN_MIN + 15) return "NO TRADE";
  const price = q.price;
  const pdh = t.levels?.find((l) => l.name === "PDH")?.price;
  const pdl = t.levels?.find((l) => l.name === "PDL")?.price;
  if (isNum(q.open) && isNum(pdh) && q.open > pdh && price > pdh) return "GAP ABOVE";
  if (isNum(q.open) && isNum(pdl) && q.open < pdl && price < pdl) return "GAP BELOW";
  const band = isNum(t.atr14) ? 0.25 * t.atr14 : 0;
  const close = t.last?.close;
  for (const raw of t.zones ?? []) {
    const z = withoutClose(raw, t.levels);
    if (!z?.big) continue;
    if (Math.abs(price - z.lo) <= band || Math.abs(price - z.hi) <= band || (z.lo <= price && price <= z.hi)) {
      const resistance = isNum(close) ? (z.lo > close ? true : z.hi < close ? false : z.side === "resistance") : z.side === "resistance";
      return resistance ? "TESTING RESISTANCE" : "TESTING SUPPORT";
    }
  }
  if (isNum(pdh) && price > pdh) return "ABOVE PDH";
  if (isNum(pdl) && price < pdl) return "BELOW PDL";
  return "INSIDE";
}

export const LIVE_STATE_TONE: Record<LiveStateName, Tone> = {
  "NOT OPEN YET": "neutral",
  "NO TRADE": "warn",
  "GAP ABOVE": "info",
  "GAP BELOW": "info",
  "TESTING SUPPORT": "good",
  "TESTING RESISTANCE": "bad",
  "ABOVE PDH": "info",
  "BELOW PDL": "info",
  INSIDE: "neutral",
  CLOSED: "neutral",
};

/**
 * The nearest zone edge above and below a live price (yesterday's close left out), with distances in ATR. A zone
 * the price is inside counts by its own top and bottom.
 */
export function liveNeighbours(t: OptionsTicker, price: number): { up: number | null; down: number | null; upAtr: number | null; downAtr: number | null } {
  let up: number | null = null;
  let down: number | null = null;
  for (const raw of t.zones ?? []) {
    const z = withoutClose(raw, t.levels);
    if (!z) continue;
    // Inside a zone, its own edges are the nearest levels each way.
    const upEdge = z.lo > price ? z.lo : z.hi > price ? z.hi : null;
    const downEdge = z.hi < price ? z.hi : z.lo < price ? z.lo : null;
    if (upEdge !== null && (up === null || upEdge < up)) up = upEdge;
    if (downEdge !== null && (down === null || downEdge > down)) down = downEdge;
  }
  const atr = isNum(t.atr14) && t.atr14 > 0 ? t.atr14 : null;
  return {
    up,
    down,
    upAtr: up !== null && atr ? (up - price) / atr : null,
    downAtr: down !== null && atr ? (price - down) / atr : null,
  };
}

/** How far each way, in ATRs, the glance strip's room bar reaches from price. */
export const ROOM_REACH = 3;

/** A zone placed on the room bar: offsets from price in ATRs, clamped to the bar's reach. */
export interface RoomZone {
  from: number;
  to: number;
  tone: "support" | "resistance" | "at";
  big: boolean;
  zone: OptionsZone;
}

/**
 * One name's row on the glance strip, centred on `price` (the live price, or the close): every zone within reach
 * as ATR offsets, the one-day expected move in ATRs, and the nearest edge each way. Null without a usable ATR,
 * since the bar is drawn in ATRs.
 */
export function roomView(
  t: OptionsTicker,
  price: number,
): { zones: RoomZone[]; em: number | null; up: number | null; down: number | null; upAtr: number | null; downAtr: number | null } | null {
  const atr = isNum(t.atr14) && t.atr14 > 0 ? t.atr14 : null;
  if (!atr || !isNum(price)) return null;
  const clamp = (v: number) => Math.max(-ROOM_REACH, Math.min(ROOM_REACH, v));
  const zones: RoomZone[] = [];
  for (const raw of t.zones ?? []) {
    const z = withoutClose(raw, t.levels);
    if (!z) continue;
    const lo = (z.lo - price) / atr;
    const hi = (z.hi - price) / atr;
    if (hi < -ROOM_REACH || lo > ROOM_REACH) continue;
    const tone = z.hi < price ? "support" : z.lo > price ? "resistance" : "at";
    zones.push({ from: clamp(lo), to: clamp(hi), tone, big: Boolean(z.big), zone: z });
  }
  const em = isNum(t.expected_move?.day) && t.expected_move.day > 0 ? t.expected_move.day / atr : null;
  return { zones, em, ...liveNeighbours(t, price) };
}

export type Bar = NonNullable<OptionsTicker["bars"]>[number];

/** A zone on the level map, with its side against the close. */
export interface MapZone {
  zone: OptionsZone;
  tone: "support" | "resistance";
}

/**
 * The level map's price window: the recent bars, the one-week expected move (or two ATRs without one) and the
 * zones that sit inside or just beyond that window. Zones far away (a 52-week low a third below) are left off so
 * they do not squash the chart; the full list stays under the chart. Null without a close.
 */
export function mapView(t: OptionsTicker): { lo: number; hi: number; bars: Bar[]; zones: MapZone[] } | null {
  const close = t.last?.close;
  if (!isNum(close) || close <= 0) return null;
  const bars = (t.bars ?? []).filter((b) => isNum(b.h) && isNum(b.l) && b.h >= b.l);
  const atr = isNum(t.atr14) && t.atr14 > 0 ? t.atr14 : close * 0.01;
  const reach = isNum(t.expected_move?.week) && t.expected_move.week > 0 ? t.expected_move.week : 2 * atr;
  let lo = close - reach;
  let hi = close + reach;
  for (const b of bars) {
    lo = Math.min(lo, b.l);
    hi = Math.max(hi, b.h);
  }
  const slack = (hi - lo) * 0.25;
  const zones: MapZone[] = [];
  for (const raw of t.zones ?? []) {
    const z = withoutClose(raw, t.levels);
    if (!z || z.hi < lo - slack || z.lo > hi + slack) continue;
    zones.push({ zone: z, tone: z.lo > close ? "resistance" : z.hi < close ? "support" : z.side });
  }
  for (const { zone } of zones) {
    lo = Math.min(lo, zone.lo);
    hi = Math.max(hi, zone.hi);
  }
  const pad = (hi - lo) * 0.04;
  return { lo: lo - pad, hi: hi + pad, bars, zones };
}

/** A round tick step giving about `count` gridlines across `span`. */
export function niceStep(span: number, count = 5): number {
  const raw = span / count;
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

/**
 * Spreads labels anchored at `ys` (top to bottom, in pixels) so none sit closer than `gap`, keeping them inside
 * [top, bottom]. Returns the label positions in the input order.
 */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const o of order) {
    const y = Math.max(o.y, prev + gap, top);
    out[o.i] = y;
    prev = y;
  }
  const over = prev - bottom;
  if (over > 0) {
    // Push the stack back up from the bottom, keeping the spacing.
    let next = Infinity;
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k]!.i;
      const y = Math.min(out[i]! - over, next - gap);
      out[i] = y;
      next = y;
    }
  }
  return out;
}

/** A live quote this old (or a feed that has not answered for this long) is shown as stale: the dot goes hollow. */
export const STALE_MS = 30_000;

/** How much of the price trail the live dot keeps: the last few minutes of quotes seen on this page. */
export const TRAIL_MS = 5 * 60_000;

/** One price seen on the live feed, at the time of its trade. */
export interface TrailPoint {
  at: number;
  p: number;
}

/** Adds a quote to a trail if it is newer than the last point, and drops points older than the trail's reach. */
export function extendTrail(trail: readonly TrailPoint[], q: LiveQuote): TrailPoint[] {
  const at = Date.parse(q.at);
  if (!Number.isFinite(at) || !isNum(q.price)) return [...trail];
  const last = trail[trail.length - 1];
  const next = last && last.at >= at ? [...trail] : [...trail, { at, p: q.price }];
  return next.filter((x) => x.at >= at - TRAIL_MS);
}

/** One name as the live layer shows it: the price to draw, its state, and whether the quote can still be trusted. */
export interface LiveRead {
  price: number | null;
  state: LiveStateName | null;
  /** True while the session is trading (the state is a live one, not before the open or after the close). */
  inSession: boolean;
  stale: boolean;
  /** Seconds since the quote's trade, or since the feed last answered, whichever is longer. */
  ageS: number | null;
  q: LiveQuote | null;
}

/**
 * Reads one name off the live feed. Outside the session (or with no quote) the price is the edition's close. A
 * quote is stale once its last trade, or the feed's last answer, is more than 30 seconds old; `now` and
 * `receivedAt` are browser times, `q.at` is the trade's time.
 */
export function liveRead(t: OptionsTicker, q: LiveQuote | undefined, session: string, now: number | null, receivedAt: number | null): LiveRead {
  const close = t.last?.close ?? null;
  if (!q) return { price: close, state: null, inSession: false, stale: false, ageS: null, q: null };
  const state = liveState(t, q, session);
  const inSession = state !== "CLOSED" && state !== "NOT OPEN YET";
  let ageS: number | null = null;
  if (now !== null) {
    const ages = [now - Date.parse(q.at), receivedAt !== null ? now - receivedAt : 0].filter((a) => Number.isFinite(a));
    ageS = ages.length > 0 ? Math.max(0, Math.round(Math.max(...ages) / 1000)) : null;
  }
  return {
    price: inSession ? q.price : close,
    state,
    inSession,
    stale: inSession && ageS !== null && ageS * 1000 > STALE_MS,
    ageS,
    q,
  };
}

/** How urgently each live state wants a look: a test of a major zone first, a fresh gap next, then the rest. */
const LOOK_RANK: Record<LiveStateName, number> = {
  "TESTING SUPPORT": 0,
  "TESTING RESISTANCE": 0,
  "GAP ABOVE": 1,
  "GAP BELOW": 1,
  "ABOVE PDH": 2,
  "BELOW PDL": 2,
  INSIDE: 3,
  "NO TRADE": 4,
  "NOT OPEN YET": 5,
  CLOSED: 5,
};

/**
 * The glance strip's order while the session trades: names testing a major zone float to the top, then gaps,
 * then breaks of yesterday's range. A stale quote sorts below fresh ones of the same state. Ties keep the
 * edition's order, so rows only move when a state changes, not on every tick.
 */
export function needsALook<T>(rows: readonly T[], read: (row: T) => LiveRead): T[] {
  const rank = (r: LiveRead) => (r.state && r.inSession ? LOOK_RANK[r.state] * 2 + (r.stale ? 1 : 0) : 99);
  return rows
    .map((row, i) => ({ row, i, k: rank(read(row)) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.row);
}

/**
 * Where the live dot sits across the level map's gap between the last candle and the one-day line: the share of
 * the regular session gone, 0 at the open and 1 at the close (13:00 on a half day). Null before the open.
 */
export function sessionShare(t: OptionsTicker, atIso: string): number | null {
  const clock = nyClock(atIso);
  if (!clock) return null;
  const close = t.half_day ? 13 * 60 : 16 * 60;
  const open = 9 * 60 + 30;
  return Math.max(0, Math.min(1, (clock.minutes - open) / (close - open)));
}

/** IV percentile at or below this reads as cheap options, at or above RICH_IVP as rich (52-week percentile, 0 to 1). */
export const CHEAP_IVP = 0.25;
export const RICH_IVP = 0.6;
/** A close in the top quarter of the day's range is strong; the bottom quarter is weak. */
export const STRONG_POS = 0.75;
export const WEAK_POS = 0.25;

export interface StructurePoint {
  symbol: string;
  /** IV percentile, 52 weeks, 0 to 1. */
  ivp: number;
  /** Where the close sat in the day's range, 0 at the low and 1 at the high. */
  pos: number;
  chip: string | null;
}

/** The corners of the structure map that are worth naming: a strong or weak close with cheap or rich options. */
export type Corner = "strong-cheap" | "strong-rich" | "weak-cheap" | "weak-rich";

/**
 * The names for the close strength vs option price map: every name with both a close position and an IV
 * percentile, plus the names left off for want of either, and which names sit in each corner.
 */
export function structureView(tickers: readonly OptionsTicker[]): {
  points: StructurePoint[];
  missing: string[];
  corners: Record<Corner, string[]>;
} {
  const points: StructurePoint[] = [];
  const missing: string[] = [];
  const corners: Record<Corner, string[]> = { "strong-cheap": [], "strong-rich": [], "weak-cheap": [], "weak-rich": [] };
  for (const t of tickers) {
    const pos = t.close_strength?.pos;
    const ivp = t.expected_move?.iv_pct_52w;
    if (!isNum(pos) || !isNum(ivp)) {
      missing.push(t.symbol);
      continue;
    }
    points.push({ symbol: t.symbol, ivp, pos, chip: t.close_strength?.chip ?? null });
    const side = pos >= STRONG_POS ? "strong" : pos <= WEAK_POS ? "weak" : null;
    const price = ivp <= CHEAP_IVP ? "cheap" : ivp >= RICH_IVP ? "rich" : null;
    if (side && price) corners[`${side}-${price}`].push(t.symbol);
  }
  return { points, missing, corners };
}

/** What a corner of the map says about the price of a single call or put. A description, never a trade. */
export const CORNER_COST: Record<Corner, string> = {
  "strong-cheap": "calls and puts cost less than usual",
  "strong-rich": "calls and puts cost more than usual",
  "weak-cheap": "calls and puts cost less than usual",
  "weak-rich": "calls and puts cost more than usual",
};

/** A finding as a share of days, against the share to compare it with when there is one. */
export interface Finding {
  title: string;
  value: number;
  valueLabel: string;
  base?: number;
  baseLabel?: string;
  use: string;
  /** True until a registered experiment stands behind the number. */
  exploratory: boolean;
}

/** What a one-standard-deviation move covers when the implied vol is exactly right, in percent of days. */
export const ONE_SIGMA_PCT = 68;

/**
 * The testing behind the page. None of it has a registered experiment yet, so every finding is exploratory: the
 * first two are fixed figures from early testing, the third is recomputed by the after-close run and shows only
 * when the edition carries it.
 */
export function findingsOf(e: Options): Finding[] {
  const findings: Finding[] = [
    {
      title: "Price touched yesterday's high or low",
      value: 88.5,
      valueLabel: "of days, 2 years, 10 names",
      use: "The levels are a map, not a signal: good targets and stop references.",
      exploratory: true,
    },
    {
      title: "Higher high the next day",
      value: 77.6,
      valueLabel: "after a strong close",
      base: 52.9,
      baseLabel: "after an ordinary day",
      use: "The edge comes from the close, not from breaking a level.",
      exploratory: true,
    },
  ];
  const check = e.expected_move_check;
  if (check?.inside_1d_pct != null) {
    findings.push({
      title: "Stayed inside the 1-day expected move",
      value: Math.round(check.inside_1d_pct),
      valueLabel: `of ${num(check.n)} days${check.period ? `, ${check.period}` : ""}`,
      base: ONE_SIGMA_PCT,
      baseLabel: "if the implied vol were exactly right",
      use: `On this check options priced in more movement than arrived${check.touch_5d_pct != null ? ` (price went beyond it within a week ${num(check.touch_5d_pct, 0)}% of the time)` : ""}. A long call or put pays for the move that is priced in.`,
      exploratory: true,
    });
  }
  return findings;
}

/** The instant of a New York wall-clock time on a given day, right under either daylight-saving offset. */
export function nyInstant(day: string, minutes: number): number | null {
  // Right when New York is four hours behind UTC; one more look at the clock corrects it when it is five.
  const guess = Date.parse(`${day}T00:00:00Z`) + (minutes + 4 * 60) * 60_000;
  if (!Number.isFinite(guess)) return null;
  const at = nyClock(new Date(guess).toISOString());
  if (!at) return null;
  const seen = at.day === day ? at.minutes : at.day < day ? at.minutes - 1440 : at.minutes + 1440;
  return guess - (seen - minutes) * 60_000;
}

/** Where `now` falls against the edition's own session, and how long until its open or its close. */
export interface SessionClock {
  phase: "before" | "open" | "after";
  /** Milliseconds to the open (before) or to the close (open); null once the session has closed. */
  ms: number | null;
}

/**
 * The edition's session against the clock. The session day comes from the edition, which is only ever built for a
 * trading day, so no holiday calendar is needed here; `halfDay` moves the close to 13:00.
 */
export function sessionClock(session: string, halfDay: boolean, now: Date): SessionClock | null {
  const open = nyInstant(session, OPEN_MIN);
  const close = nyInstant(session, closeMinute(halfDay));
  if (open === null || close === null) return null;
  const t = now.getTime();
  if (t < open) return { phase: "before", ms: open - t };
  if (t < close) return { phase: "open", ms: close - t };
  return { phase: "after", ms: null };
}

/** A span of time for a countdown: "5:18:07" under a day, "2 d 8 h" beyond it. */
export function clockSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  if (days > 0) return `${days} d ${hours} h`;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/** The three ways to read the desk: before the open, while the session trades, and after its close. */
export const DESK_VIEWS = ["brief", "live", "review"] as const;
export type DeskView = (typeof DESK_VIEWS)[number];
export const isDeskView = (v: unknown): v is DeskView => typeof v === "string" && (DESK_VIEWS as readonly string[]).includes(v);

/**
 * The view that fits the clock for this edition: live while its session trades, review from its close until New
 * York's midnight, and brief the rest of the time (the evening before, the weekend, the morning before the open,
 * and an edition that has gone stale, which the page flags on its own).
 */
export function viewForClock(session: string, halfDay: boolean, now: Date): DeskView {
  const clock = sessionClock(session, halfDay, now);
  if (!clock || clock.phase === "before") return "brief";
  if (clock.phase === "open") return "live";
  return nyClock(now.toISOString())?.day === session ? "review" : "brief";
}

/** How far a price sits from the edition's close, in one-day expected moves. Null without both. */
export function movesFromClose(t: OptionsTicker, price: number | null | undefined): number | null {
  const close = t.last?.close;
  const day = t.expected_move?.day;
  if (!isNum(price) || !isNum(close) || !isNum(day) || day <= 0) return null;
  return (price - close) / day;
}

/** Rows ordered by a number. A row without one goes last whichever way the sort runs; ties keep their order. */
export function sortByNumber<T>(rows: readonly T[], value: (row: T) => number | null | undefined, dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const an = isNum(a.v);
      const bn = isNum(b.v);
      if (an && bn) return sign * ((a.v as number) - (b.v as number)) || a.i - b.i;
      if (an !== bn) return an ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.row);
}

/**
 * One name's paper record in an edition: its trades, how many won, and their total in R. A row that is not a
 * trade at all (a corrupt stored edition) is skipped, so the monitor that calls this for every name still draws.
 */
export function paperFor(e: Options, symbol: string): { rows: PaperTrade[]; n: number; wins: number; totalR: number | null } {
  const rows = (e.paper ?? []).filter((p) => p !== null && typeof p === "object" && p.symbol === symbol);
  const scored = rows.filter((p) => isNum(p.r));
  return {
    rows,
    n: rows.length,
    wins: scored.filter((p) => (p.r as number) > 0).length,
    totalR: scored.length > 0 ? scored.reduce((a, p) => a + (p.r as number), 0) : null,
  };
}

/** A named level's price on a name ("PDH", "PDL", …), or null when the edition does not carry it. */
export function levelPrice(t: OptionsTicker, name: string): number | null {
  const p = t.levels?.find((l) => l.name === name)?.price;
  return isNum(p) ? p : null;
}

/** The layers of the level map a reader can switch off. The close line and the live price always stay. */
export const MAP_LAYERS = ["zones", "candles", "move", "labels"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];
export const MAP_LAYER_LABEL: Record<MapLayer, string> = { zones: "Zones", candles: "Candles", move: "Expected move", labels: "Labels" };

/**
 * The layers a name's map actually draws, judged the way the map judges them: no candles without bars, no expected
 * move without one, no zones when none falls inside the map's window. The labels always include the close. Empty
 * when the name has no map at all.
 */
export function mapLayersOf(t: OptionsTicker): MapLayer[] {
  const view = mapView(t);
  if (!view) return [];
  return MAP_LAYERS.filter((k) => (k === "candles" ? view.bars.length > 0 : k === "move" ? moveBands(t).day !== null : k === "zones" ? view.zones.length > 0 : true));
}

/** The price at a height on the level map, for a height in the map's own units. Clamped to the plotted window. */
export function priceAtY(y: number, lo: number, hi: number, top: number, bottom: number): number {
  if (!(bottom > top) || !(hi > lo)) return lo;
  const share = (Math.max(top, Math.min(bottom, y)) - top) / (bottom - top);
  return hi - share * (hi - lo);
}

/** What the crosshair says about one price on a name's map. */
export interface MapReadout {
  price: number;
  /** Signed distance from the close in dollars, in 14-day ATRs and in one-day expected moves; null when unknown. */
  fromClose: number | null;
  atrs: number | null;
  moves: number | null;
  /** The zone the price sits inside; the heaviest one when zones overlap. */
  zone: MapZone | null;
}

/** Reads one price off a name's map: how far it is from the close, in three units, and the zone it is inside. */
export function mapReadout(t: OptionsTicker, price: number, zones: readonly MapZone[]): MapReadout {
  const close = t.last?.close;
  const fromClose = isNum(close) ? price - close : null;
  const atr = isNum(t.atr14) && t.atr14 > 0 ? t.atr14 : null;
  let zone: MapZone | null = null;
  for (const z of zones) {
    if (z.zone.lo <= price && price <= z.zone.hi && (zone === null || (z.zone.weight ?? 0) > (zone.zone.weight ?? 0))) zone = z;
  }
  return {
    price,
    fromClose,
    atrs: fromClose !== null && atr !== null ? fromClose / atr : null,
    moves: movesFromClose(t, price),
    zone,
  };
}
