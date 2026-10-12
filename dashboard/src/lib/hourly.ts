import type { OptionsLive } from "./options-live.types";
import type { OptionsTicker } from "./options";
import { POSITIONS_GONE_MIN } from "./positions";

// The map's hourly range: each name's finished hourly bars for the last few sessions, as the trading host last
// sent them (delayed tape). The daily range comes from the after-close edition; this one moves during the day.

export interface HourlyBar {
  /** The bar's start, New York time: 2026-10-12T10:00. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Fewer bars than this is not a picture worth switching to. */
export const HOURLY_MIN_BARS = 6;

/** A stored document is not checked again when it is read, so the stamp's shape is checked here. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The hourly bars by name, for the names the edition carries. A bar with a price that is not one, or whose high
 * is under its low, is passed over; a name left with too few is left out, and so is everything once the host's
 * document is as old as positions that are no longer shown. Never throws on a damaged document.
 */
export function hourlyBySymbol(doc: OptionsLive | null, carried: readonly string[], now: number): Record<string, HourlyBar[]> {
  const out: Record<string, HourlyBar[]> = {};
  const at = Date.parse(doc?.as_of ?? "");
  if (!doc || !Array.isArray(doc.hourly) || !Number.isFinite(at) || (now - at) / 60_000 > POSITIONS_GONE_MIN) return out;
  const names = new Set(carried);
  for (const n of doc.hourly) {
    if (!n || typeof n !== "object" || !names.has(n.symbol) || !Array.isArray(n.bars) || Object.hasOwn(out, n.symbol)) continue;
    const seen = new Set<string>();
    const bars: HourlyBar[] = [];
    for (const b of n.bars) {
      if (!b || typeof b !== "object" || typeof b.t !== "string" || !STAMP.test(b.t) || seen.has(b.t)) continue;
      if (!price(b.o) || !price(b.h) || !price(b.l) || !price(b.c)) continue;
      if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) continue; // not a candle
      seen.add(b.t);
      bars.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    bars.sort((p, q) => (p.t < q.t ? -1 : p.t > q.t ? 1 : 0)); // fixed-width stamps: plain order is time order
    if (bars.length >= HOURLY_MIN_BARS) out[n.symbol] = bars;
  }
  return out;
}

/** The name as the map draws it on the hourly range: the same levels and zones, with the hourly bars as its candles. */
export function withHourly(t: OptionsTicker, bars: readonly HourlyBar[]): OptionsTicker {
  return { ...t, bars: bars.map((b) => ({ d: b.t, o: b.o, h: b.h, l: b.l, c: b.c })) };
}
