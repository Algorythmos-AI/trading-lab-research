// The pre-market radar's view helpers. Pure: no I/O, no clock.
import type { RadarEdition } from "./radar.types";

export type Radar = RadarEdition;
export type RadarTicker = NonNullable<RadarEdition["tickers"]>[number];
export type RadarNote = NonNullable<RadarTicker["notes"]>[number];

/** Dates (YYYY-MM-DD) from edition paths like "radar/editions/2026-10-09.json", newest first, no repeats. */
export function radarDates(pathnames: readonly string[], prefix: string): string[] {
  const out = new Set<string>();
  for (const p of pathnames) {
    if (!p.startsWith(prefix)) continue;
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(p.slice(prefix.length));
    if (m?.[1]) out.add(m[1]);
  }
  return [...out].sort().reverse();
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

/** The badge colour for a ticker's stance. Unknown stances are neutral. */
export function stanceTone(stance: string | null | undefined): Tone {
  const s = (stance ?? "").toLowerCase();
  if (s.includes("downtrend") || s.includes("broke")) return "bad";
  if (s.includes("held")) return "good";
  if (s.includes("testing") || s.includes("support")) return "warn";
  if (s.includes("resistance") || s.includes("high") || s.includes("breakout")) return "info";
  return "neutral";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Where price sits between support (0) and the 52-week high (1), for the level bar. Null when either end is
 * missing or the range is empty.
 */
export function levelPosition(t: Pick<RadarTicker, "price" | "support" | "high_52w">): number | null {
  const { price, support, high_52w: high } = t;
  if (!isNum(price) || !isNum(support) || !isNum(high) || high <= support) return null;
  return Math.min(1, Math.max(0, (price - support) / (high - support)));
}

/** Tickers for one watchlist, in the list's own order; names the edition lists but does not describe are skipped. */
export function tickersOf(r: Radar, listName: string): RadarTicker[] {
  const bySymbol = new Map((r.tickers ?? []).map((t) => [t.symbol, t]));
  const list = (r.lists ?? []).find((l) => l.name === listName);
  return (list?.symbols ?? []).map((s) => bySymbol.get(s)).filter((t): t is RadarTicker => t !== undefined);
}

/** Tickers with research notes, in edition order: the cards at the bottom of the page. */
export function researched(r: Radar): RadarTicker[] {
  return (r.tickers ?? []).filter((t) => (t.notes ?? []).length > 0);
}
