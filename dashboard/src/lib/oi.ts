// Open interest from the options live document, reduced to what the level map draws. Pure: no I/O.
//
// The host sends up to 200 contracts a name. The page needs a handful of marks: for each name, the strikes that
// hold the most open calls and the most open puts, added across the expiries sent (five weeks out).
import type { OptionsLive } from "./options-live.types";
import { POSITIONS_GONE_MIN } from "./positions";

export interface InterestMark {
  strike: number;
  kind: "call" | "put";
  /** Open contracts at this strike, added across expiries. */
  oi: number;
}

export interface Interest {
  /** The session the exchange's figures are for (a day behind), or null when the host did not say. */
  asOf: string | null;
  /** The largest strikes of each kind, largest first within a kind, calls before puts. */
  marks: InterestMark[];
}

/** Strikes shown for each of calls and puts. */
export const INTEREST_EACH = 3;

/**
 * Each name's marks. Empty when there is no document, when it carries no open interest, or when it is as old as a
 * positions document that is no longer shown: a reading from before the last session says nothing about now.
 *
 * `range` gives the prices a name's map spans. The largest strikes are chosen among those the map can show: the
 * heaviest open interest often sits at round numbers beyond it, and choosing first would leave the map empty.
 * A name with no map, or with no open interest inside it, gets no marks.
 */
export function interestBySymbol(doc: OptionsLive | null, now: number, range: (symbol: string) => { lo: number; hi: number } | null): Record<string, Interest> {
  const out: Record<string, Interest> = {};
  const at = doc ? Date.parse(doc.as_of) : NaN;
  if (!doc || !Number.isFinite(at) || (now - at) / 60_000 > POSITIONS_GONE_MIN) return out;
  for (const name of doc.open_interest ?? []) {
    if (!name || typeof name.symbol !== "string" || !Array.isArray(name.rows)) continue;
    const span = range(name.symbol);
    if (!span) continue;
    const sums = new Map<string, InterestMark>();
    for (const r of name.rows) {
      if (!r || !(r.strike > 0) || !(r.oi > 0) || (r.kind !== "call" && r.kind !== "put")) continue;
      if (r.strike < span.lo || r.strike > span.hi) continue;
      const key = `${r.kind}:${r.strike}`;
      const have = sums.get(key);
      if (have) have.oi += r.oi;
      else sums.set(key, { strike: r.strike, kind: r.kind, oi: r.oi });
    }
    const top = (kind: "call" | "put") =>
      [...sums.values()]
        .filter((m) => m.kind === kind)
        .sort((a, b) => b.oi - a.oi || a.strike - b.strike)
        .slice(0, INTEREST_EACH);
    const marks = [...top("call"), ...top("put")];
    if (marks.length > 0) out[name.symbol] = { asOf: typeof name.as_of === "string" ? name.as_of : null, marks };
  }
  return out;
}

/** A count of contracts, short: 950, 1.8k, 22k, 1.2M. */
export function shortCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
