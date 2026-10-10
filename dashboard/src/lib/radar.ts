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

export type RadarGauge = NonNullable<RadarEdition["gauges"]>[number];
export type RadarEvent = NonNullable<RadarEdition["calendar"]>[number];

/** The list the radar ranks its daily picks in. */
export const DAILY_LIST = "DAILY RADAR";

export interface ScoreRow {
  list: string;
  move: number;
  benchmark: string | null;
  benchMove: number | null;
  /** The list's move minus its benchmark's; null without a benchmark. */
  edge: number | null;
  hits: string | null;
}

/**
 * How each list's names moved in the last session against its benchmark, for the dumbbell chart. Rows without a
 * move are left out; old editions have no scorecard and give an empty list.
 */
export function scoreRows(r: Radar): ScoreRow[] {
  return (r.scorecard ?? [])
    .filter((x) => isNum(x.avg_move_pct))
    .map((x) => {
      const move = x.avg_move_pct as number;
      const benchMove = isNum(x.benchmark_move_pct) ? x.benchmark_move_pct : null;
      const hits =
        isNum(x.hits) && isNum(x.total) && x.total > 0 ? `${x.hits} of ${x.total}${x.hit_label ? ` ${x.hit_label}` : ""}` : null;
      return { list: x.list, move, benchmark: x.benchmark ?? null, benchMove, edge: benchMove === null ? null : move - benchMove, hits };
    });
}

/** A gauge's colour: good when it moved the way that helps stocks, bad when the other way, neutral otherwise. */
export function gaugeTone(g: RadarGauge): Tone {
  if (!isNum(g.change) || g.change === 0 || !g.better) return "neutral";
  return (g.change > 0) === (g.better === "up") ? "good" : "bad";
}

/** A ticker's room picture: support, the line above (resistance, else the 52-week high), price and pre-market. */
export interface Room {
  support: number;
  ceiling: number | null;
  /** True when the ceiling is the 52-week high because nothing stands above. */
  atHigh: boolean;
  price: number;
  premarket: number | null;
  /** How far price sits above support, in percent of price. */
  roomPct: number;
}

export function roomOf(t: RadarTicker): Room | null {
  if (!isNum(t.price) || !isNum(t.support) || t.price <= 0) return null;
  const ceiling = isNum(t.resistance) ? t.resistance : isNum(t.high_52w) ? t.high_52w : null;
  return {
    support: t.support,
    ceiling,
    atHigh: !isNum(t.resistance),
    price: t.price,
    premarket: isNum(t.premarket_price) ? t.premarket_price : null,
    roomPct: ((t.price - t.support) / t.price) * 100,
  };
}

export interface Distance {
  symbol: string;
  /** Percent: above support for a support play, under the line for a breakout. Negative = already through it. */
  pct: number;
  tag: RadarTicker["tag"];
}

/**
 * How close each name on a list is to the line that matters, shortest first: for SUPPORT PLAYS the distance above
 * support (where the idea is wrong), for anything else the distance under resistance (what it has to clear).
 */
export function distances(r: Radar, listName: string): Distance[] {
  const support = listName === "SUPPORT PLAYS";
  return tickersOf(r, listName)
    .map((t) => ({ symbol: t.symbol, pct: support ? -(t.to_support_pct ?? NaN) : (t.to_resistance_pct ?? NaN), tag: t.tag }))
    .filter((d) => Number.isFinite(d.pct))
    .sort((a, b) => a.pct - b.pct);
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The calendar as five weekdays from the edition's date, each with its events (timed ones first, by time). Events
 * further out are returned as `later`, nearest first.
 */
export function calendarWeek(r: Radar): { days: { date: string; events: RadarEvent[] }[]; later: RadarEvent[] } {
  const days: string[] = [];
  for (let i = 0; days.length < 5 && i < 10; i++) {
    const d = addDays(r.edition_date, i);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d);
  }
  const events = (r.calendar ?? []).filter((e) => e.date >= r.edition_date);
  const byTime = (a: RadarEvent, b: RadarEvent) => (a.time_et ?? "99").localeCompare(b.time_et ?? "99");
  const last = days[days.length - 1] ?? r.edition_date;
  return {
    days: days.map((date) => ({ date, events: events.filter((e) => e.date === date).sort(byTime) })),
    later: events.filter((e) => e.date > last).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b)),
  };
}
