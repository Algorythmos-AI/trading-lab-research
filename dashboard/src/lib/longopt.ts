// The numbers a holder of one long call or put asks for: where it breaks even, what it would be worth if the stock
// were somewhere else later, what an hour of waiting costs, and the most it can lose. Pure.
//
// Built on bs.ts, so the same caveat holds: these are estimates from a flat-volatility model. Money amounts are for
// whole contracts of 100 shares. The same arithmetic as src/wt/options/longopt.py, held to the same vectors.
import { price, type OptionKind } from "./bs";

/** Shares in one standard contract. Adjusted contracts of another size are left out before they get here. */
export const MULTIPLIER = 100;

/** The stock price at expiry at which the option is worth exactly what was paid for it. */
export function breakeven(strike: number, premium: number, kind: OptionKind): number {
  return kind === "call" ? strike + premium : strike - premium;
}

/**
 * How far the stock is from breakeven, in expected moves, counted in the direction the option needs. Positive
 * means the stock still has that far to go; negative means it is already past breakeven. Null without a usable
 * expected move.
 */
export function breakevenMoves(strike: number, premium: number, kind: OptionKind, spot: number, expectedMove: number | null | undefined): number | null {
  if (expectedMove == null || !(expectedMove > 0)) return null;
  const gap = breakeven(strike, premium, kind) - spot;
  return (kind === "call" ? gap : -gap) / expectedMove;
}

/** The most a long option can lose: what was paid for it. */
export function maxLoss(premium: number, contracts = 1): number {
  return premium * MULTIPLIER * contracts;
}

/** Profit or loss if the option is worth `value` per share, against the premium paid. */
export function pnl(value: number, premium: number, contracts = 1): number {
  return (value - premium) * MULTIPLIER * contracts;
}

/** What the option loses per share over the next `ahead` minutes if the stock and its volatility stay put. */
export function decay(s: number, strike: number, minutes: number, sigma: number | null | undefined, kind: OptionKind, ahead = 60, r = 0, q = 0): number {
  const later = Math.max(minutes - ahead, 0);
  return price(s, strike, minutes, sigma, kind, r, q) - price(s, strike, later, sigma, kind, r, q);
}

/** The option's value per share if the stock is at `sThen` in `ahead` minutes, volatility unchanged. */
export function valueIf(sThen: number, strike: number, minutes: number, sigma: number | null | undefined, kind: OptionKind, ahead = 0, r = 0, q = 0): number {
  return price(sThen, strike, Math.max(minutes - ahead, 0), sigma, kind, r, q);
}
