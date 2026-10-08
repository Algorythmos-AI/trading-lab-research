// The standard performance views of the crypto tournament, computed from what the snapshot already carries:
// each book's published marks (the equity lines) and each sleeve's signal counts. Numbers only.
import type { Crypto } from "@/lib/crypto";
import { sleeveLabel, type EquityLine } from "@/lib/tournament";

const items = <T,>(v: readonly (T | null)[] | null | undefined): T[] => (Array.isArray(v) ? (v.filter((x) => x !== null && x !== undefined) as T[]) : []);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface DrawdownLine {
  name: string;
  label: string;
  baseline: boolean;
  /** How far the book is below its own highest mark so far, in percent of that mark: zero or below. */
  points: { t: number; pct: number }[];
  /** The deepest of them. Null with fewer than two marks. */
  worstPct: number | null;
  /** The latest one: zero means the book is at its high. */
  nowPct: number | null;
}

/** Each book's fall from its own running high. The book's start counts as its first high. */
export function drawdownLines(lines: readonly EquityLine[]): DrawdownLine[] {
  return lines.map((l) => {
    let peak = 1;
    const points = l.points.map((p) => {
      const value = 1 + p.pct / 100;
      peak = Math.max(peak, value);
      return { t: p.t, pct: peak > 0 ? (value / peak - 1) * 100 : 0 };
    });
    const enough = points.length >= 2;
    return {
      name: l.name,
      label: l.label,
      baseline: l.baseline,
      points,
      worstPct: enough ? Math.min(...points.map((p) => p.pct)) : null,
      nowPct: enough ? (points.at(-1)?.pct ?? null) : null,
    };
  });
}

export interface MonthlyReturns {
  /** UTC months that any book has a mark in, oldest first, as YYYY-MM. */
  months: string[];
  books: { name: string; label: string; baseline: boolean; byMonth: Record<string, number> }[];
}

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

/**
 * Each book's return in each UTC month, in percent: its last mark of the month against its last mark of the
 * month before (or against its start, for its first month). The current month is the month so far.
 */
export function monthlyReturns(lines: readonly EquityLine[]): MonthlyReturns {
  const months = new Set<string>();
  const books = lines.map((l) => {
    const last = new Map<string, number>();
    for (const p of [...l.points].sort((a, b) => a.t - b.t)) last.set(monthOf(p.t), 1 + p.pct / 100);
    const byMonth: Record<string, number> = {};
    let before = 1;
    for (const m of [...last.keys()].sort()) {
      const value = last.get(m) as number;
      if (before > 0) byMonth[m] = (value / before - 1) * 100;
      before = value;
      months.add(m);
    }
    return { name: l.name, label: l.label, baseline: l.baseline, byMonth };
  });
  return { months: [...months].sort(), books };
}

export interface SignalFunnel {
  name: string;
  label: string;
  since: string | null;
  fired: number;
  entered: number;
  /** What refused the rest, most frequent first. They add up to `fired - entered`. */
  refused: { code: string; count: number }[];
  /** Share of fired signals that were bought, 0 to 1. Null when none fired. */
  takenShare: number | null;
}

/** One funnel per sleeve that has recorded a signal: fired, bought, and refused by reason. */
export function signalFunnels(s: Crypto): SignalFunnel[] {
  return items(s.sleeves)
    .filter((x) => typeof x.name === "string" && x.funnel && isNum(x.funnel.fired) && x.funnel.fired > 0)
    .map((x) => {
      const f = x.funnel as NonNullable<typeof x.funnel>;
      const fired = f.fired as number;
      const entered = isNum(f.entered) ? f.entered : 0;
      return {
        name: x.name as string,
        label: sleeveLabel(x.name),
        since: f.since ?? null,
        fired,
        entered,
        refused: items(f.refused)
          .filter((r) => typeof r.code === "string" && isNum(r.count) && r.count > 0)
          .map((r) => ({ code: r.code as string, count: r.count as number }))
          .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
        takenShare: fired > 0 ? entered / fired : null,
      };
    });
}

/** The desk's signals together: how many fired, how many were bought, and the reasons across sleeves. */
export function deskFunnel(funnels: readonly SignalFunnel[]): { fired: number; entered: number; refused: { code: string; count: number }[] } {
  const by = new Map<string, number>();
  for (const f of funnels) for (const r of f.refused) by.set(r.code, (by.get(r.code) ?? 0) + r.count);
  return {
    fired: funnels.reduce((a, f) => a + f.fired, 0),
    entered: funnels.reduce((a, f) => a + f.entered, 0),
    refused: [...by.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}
