/**
 * A desk's closed trades as a running R curve: the running total after each trade and how far it stands below the
 * earlier high (the drawdown, zero or below). SAFE figures only: an index, a day and an R multiple per trade.
 *
 * Trades with no R are skipped rather than counted as zero, so a gap in the data never bends the line.
 */
export interface RTrade {
  day: string | null;
  r: number | null;
  /** A short code for the tooltip (a rule code), never a symbol. */
  code?: string | null;
}

export interface RCurvePoint {
  i: number;
  day: string;
  r: number;
  cum: number;
  dd: number;
  code: string | null;
}

export interface RCurve {
  points: RCurvePoint[];
  total: number;
  /** The deepest drawdown, zero or below. */
  maxDd: number;
  wins: number;
  losses: number;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

export function rCurve(trades: readonly RTrade[], fmtDay: (d: string | null) => string = (d) => d ?? "—"): RCurve {
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  const points: RCurvePoint[] = [];
  for (const t of trades) {
    if (typeof t.r !== "number" || !Number.isFinite(t.r)) continue;
    cum = round(cum + t.r);
    peak = Math.max(peak, cum);
    const dd = round(Math.min(0, cum - peak));
    maxDd = Math.min(maxDd, dd);
    if (t.r > 0) wins += 1;
    else if (t.r < 0) losses += 1;
    points.push({ i: points.length + 1, day: fmtDay(t.day), r: t.r, cum, dd, code: t.code ?? null });
  }
  return { points, total: cum, maxDd, wins, losses };
}
