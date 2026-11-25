// DEC-0080 / EXP-0056: a descriptive session-bootstrap band on the shadow arms' own trades. Not a verdict: the arms
// ended with at most 9 sessions and every trial closes with none on 2027-11-05. The method is
// `wt.options.arms_verdict.bootstrap` and `decide`, ported: whole New York sessions resampled with replacement,
// 5,000 draws, the mean, the 2.5th to 97.5th percentile (linear, numpy's default), and the two halves in order.
//
// It is switched off until DEC-0080 is accepted: while `BAND_ACCEPTED` is false the page draws no number from it.
// Pure: trades in, figures out.
import { nyTime } from "./journal";
import type { ArmBook } from "./paper";
import { inWindow } from "./research-arms";

/** DEC-0080's acceptance turns the band on. Flip only in the pull request that marks DEC-0080 ACCEPTED. */
export const BAND_ACCEPTED = false;

/** The arms DEC-0080 point 1 bands: their quantity is their own mean. */
export const BANDED = ["HYP-0046", "HYP-0047"] as const;
export const DRAWS = 5000;
export const SEED = 7;

export interface Unit {
  session: string;
  closedAt: string;
  value: number;
}

export interface Band {
  units: number;
  sessions: number;
  mean: number;
  /** The 2.5th and 97.5th percentiles of the resampled means; null with fewer than 2 sessions. */
  range: [number, number] | null;
  firstHalf: number | null;
  secondHalf: number | null;
}

/** mulberry32: a small seeded generator, fixed by EXP-0056's config. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** numpy.percentile's default (linear interpolation between closest ranks) on a sorted list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** The units of an arm: each closed trade with a readable `rop`, inside the window, in session then close order. */
export function unitsOf(book: ArmBook): Unit[] {
  const out: Unit[] = [];
  for (const t of book.trades) {
    const rop = book.meta.get(t.id)?.rop;
    const session = nyTime(t.opened_at).day;
    if (typeof rop !== "number" || !Number.isFinite(rop) || !inWindow(session)) continue;
    out.push({ session, closedAt: t.closed_at, value: rop });
  }
  return out.sort((a, b) => a.session.localeCompare(b.session) || a.closedAt.localeCompare(b.closedAt));
}

/** The band of a list of units, as DEC-0080 point 4 describes; null when there is no unit. */
export function band(units: readonly Unit[], draws = DRAWS, seed = SEED): Band | null {
  const m = mean(units.map((u) => u.value));
  if (m === null) return null;
  const days = [...new Set(units.map((u) => u.session))].sort();
  const half = Math.floor(units.length / 2);
  let range: Band["range"] = null;
  if (days.length >= 2) {
    const byDay = days.map((d) => units.filter((u) => u.session === d).map((u) => u.value));
    const rand = mulberry32(seed);
    const got: number[] = [];
    for (let i = 0; i < draws; i++) {
      let sum = 0;
      let n = 0;
      for (let j = 0; j < days.length; j++) {
        const day = byDay[Math.floor(rand() * days.length)]!;
        for (const v of day) sum += v;
        n += day.length;
      }
      got.push(sum / n);
    }
    got.sort((a, b) => a - b);
    range = [percentile(got, 2.5), percentile(got, 97.5)];
  }
  return {
    units: units.length,
    sessions: days.length,
    mean: m,
    range,
    firstHalf: mean(units.slice(0, half).map((u) => u.value)),
    secondHalf: mean(units.slice(half).map((u) => u.value)),
  };
}

/** The band of one arm, or null when DEC-0080 does not band it or it has no unit. Never consults BAND_ACCEPTED. */
export function armBand(book: ArmBook | null | undefined): Band | null {
  if (!book || !(BANDED as readonly string[]).includes(book.hyp)) return null;
  return band(unitsOf(book));
}

