// What an at-the-money call and put cost, for the Brief view. Pure: no I/O.
//
// For each name: the nearest expiry still trading, and the first a fortnight or more out. At each, the strike
// nearest the last close, priced at the ask (what a buyer pays), with how far the stock must travel to break even
// counted in expected day's moves, and how wide the quote is.
import type { OptionKind } from "./bs";
import type { ChainContract, ChainResponse } from "./chain";
import { daysToExpiry, minutesToExpiry, readQuote, type QuoteRead } from "./contract";
import { breakevenMoves } from "./longopt";

/** A swing expiry is a fortnight or more out, as the chain route chooses it (chain.ts is server-only). */
export const SWING_MIN_DAYS = 14;

export interface CostSide {
  strike: number;
  /** The ask per share, or null when nobody is offering. */
  ask: number | null;
  /** The bid-ask spread as a percentage of the mid. */
  spreadPct: number | null;
  /** Expected day's moves from the last close to breakeven at expiry, in the direction the option needs. */
  moves: number | null;
  state: QuoteRead["state"];
}

export interface CostLine {
  expiry: string;
  days: number | null;
  call: CostSide | null;
  put: CostSide | null;
}

function side(contracts: ChainContract[], kind: OptionKind, close: number, expectedMove: number | null | undefined): CostSide | null {
  const of = contracts.filter((c) => c.kind === kind);
  if (of.length === 0) return null;
  // Nearest the close; of two equally near, the lower strike, so the choice does not depend on the feed's order.
  const c = of.reduce((best, x) => {
    const d = Math.abs(x.strike - close) - Math.abs(best.strike - close);
    return d < 0 || (d === 0 && x.strike < best.strike) ? x : best;
  });
  const q = readQuote(c);
  const ask = q.state === "ok" || q.state === "no-bid" ? c.ask : null;
  return { strike: c.strike, ask, spreadPct: q.state === "ok" ? q.spreadPct : null, moves: ask !== null ? breakevenMoves(c.strike, ask, kind, close, expectedMove) : null, state: q.state };
}

/** The cost lines for one name: the nearest expiry still trading, then the swing expiry when it is a different one. */
export function costLines(chain: ChainResponse, close: number, expectedMove: number | null | undefined, now: number): CostLine[] {
  if (!(close > 0)) return [];
  const open = chain.expiries.filter((x) => x.contracts.length > 0 && (minutesToExpiry(x.date, now) ?? 0) > 0);
  const near = open[0];
  if (!near) return [];
  const swing = open.find((x) => (daysToExpiry(x.date, now) ?? 0) >= SWING_MIN_DAYS);
  return [near, ...(swing && swing !== near ? [swing] : [])].map((x) => ({
    expiry: x.date,
    days: daysToExpiry(x.date, now),
    call: side(x.contracts, "call", close, expectedMove),
    put: side(x.contracts, "put", close, expectedMove),
  }));
}
