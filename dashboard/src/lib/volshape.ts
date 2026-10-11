// Implied volatility by strike for one expiry: the "shape" a buyer is paying for. Pure: no I/O.
//
// The feed gives each contract an implied volatility. Laid out by strike it shows whether the strikes below the
// price are dearer than those above it, and how much dearer the far ones are than the near ones.
import type { ChainExpiry } from "./chain";

export interface VolPoint {
  strike: number;
  /** Annualised, as a fraction; null where the feed gave none for that side. */
  call: number | null;
  put: number | null;
}

export interface VolShape {
  points: VolPoint[];
  /** The lowest and highest volatility among the points, for the chart's scale. */
  lo: number;
  hi: number;
  /** At the strike nearest the stock's price: the mean of the sides that have one. */
  atm: { strike: number; iv: number };
}

/** Fewer strikes than this is not a shape. */
export const VOL_SHAPE_MIN = 3;
/** A volatility above this (500% a year) is a broken quote, not a price. */
const IV_MAX = 5;

const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= IV_MAX;

/** The shape of one expiry around `spot`, or null with too few strikes that carry a volatility. */
export function volShape(expiry: ChainExpiry, spot: number): VolShape | null {
  const by = new Map<number, VolPoint>();
  for (const c of expiry.contracts) {
    if (!(c.strike > 0) || !usable(c.iv)) continue;
    const p = by.get(c.strike) ?? { strike: c.strike, call: null, put: null };
    p[c.kind] = c.iv;
    by.set(c.strike, p);
  }
  const points = [...by.values()].sort((a, b) => a.strike - b.strike);
  if (points.length < VOL_SHAPE_MIN || !(spot > 0)) return null;
  const all = points.flatMap((p) => [p.call, p.put]).filter(usable);
  const near = points.reduce((best, p) => (Math.abs(p.strike - spot) < Math.abs(best.strike - spot) ? p : best));
  const sides = [near.call, near.put].filter(usable);
  return { points, lo: Math.min(...all), hi: Math.max(...all), atm: { strike: near.strike, iv: sides.reduce((a, v) => a + v, 0) / sides.length } };
}
