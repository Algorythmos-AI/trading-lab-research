// The options levels page's view helpers. Pure: no I/O; the clock is always passed in.
import { dayIn, NEW_YORK } from "./format";
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

const OPEN_MIN = 9 * 60 + 30;

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
