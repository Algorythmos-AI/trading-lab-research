// The shape of a stock quote's two sides, and its spread: one definition for every reader of Alpaca's `latestQuote`
// (the log-only snapshot probe, quote-probe.ts; quote.ts' normalise; the board's crossed-quote guard,
// quote-guards.ts). Pure and total: it takes whatever it is given and never throws.
//
// Stable signature, for other readers (a spread display, say): `quoteShape(bid, ask, bidSize, askSize)` with the
// values as Alpaca sends them (`bp`, `ap`, `bs`, `as`), and `{ shape, spread_bps }` back. Nothing else here is meant to
// be imported.

/**
 * - `invalid`: a price that is not a number of 0 or more, or a size that is sent but is not a number of 0 or more;
 * - `empty`: no active side (a price of 0, or a size of 0, is Alpaca's "no active bid or ask");
 * - `one-sided`: one active side only;
 * - `crossed`: both sides active and the bid above the ask;
 * - `locked`: both sides active at the same price (not crossed);
 * - `normal`: both sides active, the bid below the ask.
 */
export const QUOTE_SHAPES = ["invalid", "empty", "one-sided", "crossed", "locked", "normal"] as const;
export type QuoteShape = (typeof QUOTE_SHAPES)[number];

export interface QuoteShapeResult {
  shape: QuoteShape;
  /**
   * (ask - bid) / mid in basis points, rounded to one decimal place: negative when crossed, 0 when locked. Null unless
   * both sides are active.
   */
  spread_bps: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A size as sent: missing (undefined or null) leaves the side to its price; otherwise a number of 0 or more. */
const sizeOk = (z: unknown) => z === undefined || z === null || (isNum(z) && z >= 0);

/**
 * The quote's shape from its bid and ask prices and (optional) sizes, in shares. A missing size leaves the side to its
 * price; a size of 0 is no active side, like a price of 0. So a zero price or size on one side reads one-sided, never
 * crossed.
 */
export function quoteShape(bid: unknown, ask: unknown, bidSize?: unknown, askSize?: unknown): QuoteShapeResult {
  if (!isNum(bid) || !isNum(ask) || bid < 0 || ask < 0 || !sizeOk(bidSize) || !sizeOk(askSize)) return { shape: "invalid", spread_bps: null };
  const hasBid = bid > 0 && bidSize !== 0;
  const hasAsk = ask > 0 && askSize !== 0;
  if (!hasBid && !hasAsk) return { shape: "empty", spread_bps: null };
  if (!hasBid || !hasAsk) return { shape: "one-sided", spread_bps: null };
  const bps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
  const spread_bps = Math.round(bps * 10) / 10;
  return { shape: bid > ask ? "crossed" : bid === ask ? "locked" : "normal", spread_bps };
}
