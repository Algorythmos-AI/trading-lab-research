// The trade ticket's same-day line: for a contract that expires today, "Expires today" and which stop fires first, the
// -25% premium stop or the chart stop, with the dollar loss at each after fees. Display only, and pure.
//
// It sits apart from ticket.ts on purpose: ticket.ts is in the signal's hashed import closure (option-value.ts,
// contract-pick.ts and manage-stop.ts import it), and nothing in that closure imports this file, so neither hash moves.
// Only the typed price feeds these numbers, never the chain.
import { nyNow, sessionOf } from "./market-calendar";
import { type Estimate, type Size, usd } from "./ticket";
import { PREMIUM_STOP } from "./trade-rules";

/** Which stop the stock reaches first, if it moves against the trade: the premium stop, the chart stop, or both at once. */
export type FirstStop = "premium" | "chart" | "together";

export interface SameDay {
  /** Always "Expires today": the line the ticket shows for a contract whose expiry is today's New York session. */
  line: string;
  /**
   * The two stops side by side, or null when there is no estimate at the chart stop (then nothing is guessed) or the
   * estimate there is worth the typed price or more (the stock is past it on the winning side). Losses
   * are for the sized contracts against the typed price, round-trip fees in, as negative cents.
   */
  compare: {
    first: FirstStop;
    premiumStopCents: number;
    premiumLossCents: number;
    chartStop: number;
    chartValueCents: number;
    chartLossCents: number;
    text: string;
  } | null;
}

/**
 * For a contract that expires today (New York session day): the line "Expires today" and, when the typed price gave
 * an estimate at the chart stop, which stop fires first. A long option loses value as the stock moves toward the chart
 * stop, so when its estimated value there is under the premium stop's price, the premium stop is hit on the way: it
 * fires first. Only the typed price feeds these numbers (the premium stop from it, the chart-stop value from the
 * volatility it implies); the chain feeds none. Null for any other expiry, or when the time cannot be read.
 */
export function sameDay(
  expiry: string,
  now: number | null,
  size: Pick<Size, "priceCents" | "contracts" | "stopCents" | "riskCents">,
  chartStop: Pick<Estimate, "stockPrice" | "valueCents" | "pnlCents"> | null | undefined,
): SameDay | null {
  if (now === null || !Number.isFinite(now) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const ny = nyNow(new Date(now));
  if (expiry !== ny.day) return null;
  // Only while it can still trade: from today's own calendar, not the page's session, so a page left on an old edition
  // never calls an expired contract "today". A half day closes at 13:00; a day the market is shut has no bell.
  const close = sessionOf(expiry).close;
  if (close === null || ny.minute >= close) return null;
  const line = "Expires today";
  if (!chartStop || size.contracts < 1) return { line, compare: null };
  // A chart stop the estimate puts at or above the typed price is not a stop the stock reaches by going against the
  // trade (it is already past it, on the winning side): there is no order of stops to state.
  if (chartStop.valueCents >= size.priceCents) return { line, compare: null };
  const first: FirstStop = chartStop.valueCents < size.stopCents ? "premium" : chartStop.valueCents > size.stopCents ? "chart" : "together";
  const pct = Math.round(PREMIUM_STOP * 100);
  const prem = `−${usd(size.riskCents)} at the −${pct}% premium stop ${usd(size.stopCents)}`;
  const chart = `≈ ${usd(chartStop.pnlCents)} at the chart stop ${chartStop.stockPrice.toFixed(2)}`;
  // The estimate holds the time left still, so the order is for a move now; decay only brings the premium stop sooner.
  const head =
    first === "premium"
      ? `The −${pct}% premium stop fires first, before the stock reaches the chart stop: ${prem}; ${chart}.`
      : first === "chart"
        ? `If the stock got there now, the chart stop comes first, before the −${pct}% premium stop: ${chart}; ${prem}.`
        : `If the stock got there now, the −${pct}% premium stop and the chart stop land together: ${prem}; ${chart}.`;
  const text = `${head} Fees in. Time decay brings the premium stop closer as the day goes on.`;
  return {
    line,
    compare: {
      first,
      premiumStopCents: size.stopCents,
      premiumLossCents: -size.riskCents,
      chartStop: chartStop.stockPrice,
      chartValueCents: chartStop.valueCents,
      chartLossCents: chartStop.pnlCents,
      text,
    },
  };
}
