// The what-if checks the Options page works out from data it already has: how far a trigger is in the name's 1-day
// moves, whether the price sits inside the box, what the at-the-money option costs against the premium cap, which
// stop a trade would meet first, and the day's room after one more stop. Pure: no I/O; every clock is passed in.
//
// Every check here is shown only when its inputs are present and fresh; each function returns null otherwise, so a
// caller has nothing old to draw. The option quotes are 15 minutes behind the market, and every chain-derived line
// says so. Advisory and read only: nothing here is an order.
import type { OptionKind } from "./bs";
import type { ChainContract, ChainResponse } from "./chain";
import { minutesToExpiry, readQuote, STALE_SAME_DAY_MIN } from "./contract";
import { newYork } from "./format";
import type { NameStateName, NoTradeWhy } from "./trade-state";
import { DAY_LOSS_LIMIT, MAX_PREMIUM, MAX_TRADES_PER_DAY, PREMIUM_STOP, RISK_PER_TRADE, type DayCheck } from "./trade-rules";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const usd = (v: number) => `$${v.toFixed(2)}`;
const whole = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

// ---- distance in moves ----------------------------------------------------------------------------------------------
/** A trigger this many 1-day expected moves away, or more, is unlikely to be reached today. */
export const UNLIKELY_MOVES = 3;
export const UNLIKELY_WORDS = "unlikely today";

export interface MoveWords {
  /** The distance in 1-day moves, to one decimal (the number shown). */
  multiple: number;
  /** "0.2× move". */
  text: string;
  /** At UNLIKELY_MOVES or more, as shown: the strip and the hero add UNLIKELY_WORDS, muted. */
  unlikely: boolean;
}

/**
 * A distance ($ on the stock) as a multiple of the name's 1-day expected move: "0.2× move". The threshold is judged on
 * the number shown, so "3.0× move" always says "unlikely today" and "2.9× move" never does. Null without a positive
 * expected move or with a distance that is not one.
 */
export function moveWords(distance: number | null | undefined, expectedMove: number | null | undefined): MoveWords | null {
  if (!fin(distance) || distance < 0 || !fin(expectedMove) || expectedMove <= 0) return null;
  const multiple = Math.round((distance / expectedMove) * 10) / 10;
  return { multiple, text: `${multiple.toFixed(1)}× move`, unlikely: multiple >= UNLIKELY_MOVES };
}

// ---- inside the box -------------------------------------------------------------------------------------------------
/** True when a price is strictly between the floor and the ceiling (a box that is not one is never "inside"). */
export function insideBox(price: number | null | undefined, floor: number | null | undefined, ceiling: number | null | undefined): boolean {
  return fin(price) && fin(floor) && fin(ceiling) && floor < ceiling && price > floor && price < ceiling;
}

export const INSIDE_BOX_WORD = "INSIDE BOX · wait";

/**
 * Whether a card shows the INSIDE BOX chip beside the board's state chip: only on a live price dot (not pre-market,
 * the close, the last trade or paused), only while the board says watch, or no trade because the price is in the
 * middle of yesterday's range, with no live alternative, and only with the price strictly inside the box. Never beside
 * an entry, a get-ready or an alternative, and never beside a no trade for a closed window (the opening range, the
 * lunch block, after the flat time, the day's limit, the session closed): "wait" there would promise an entry the
 * rules will not allow.
 */
export function showInsideBox(p: {
  dot: { kind: string; price: number } | null;
  paused: boolean;
  state: NameStateName | null | undefined;
  /** The row's no-trade reason (NameState.why). */
  why?: NoTradeWhy | null;
  alt: boolean;
  floor: number | null | undefined;
  ceiling: number | null | undefined;
}): boolean {
  if (!p.dot || p.dot.kind !== "live" || p.paused || p.alt) return false;
  if (p.state !== "watch" && !(p.state === "no_trade" && p.why === "range_middle")) return false;
  return insideBox(p.dot.price, p.floor, p.ceiling);
}

// ---- the option chain -----------------------------------------------------------------------------------------------
/**
 * The price the chain is asked around: the live price in steps of half a percent of the close (near enough to follow
 * a move, coarse enough that a ticking price does not ask again every few seconds), else the close.
 */
export function chainPx(close: number | null | undefined, spot: number | null | undefined): number | null {
  if (!fin(close) || close <= 0) return null;
  if (!fin(spot) || spot <= 0) return close;
  const step = close * 0.005;
  return Math.round(Math.round(spot / step) * step * 100) / 100;
}

/**
 * How old a chain answer's prices are now, in minutes: how far its newest quote was behind its own `as_of` when it
 * was answered, plus the time since it reached the browser. Each part is read on one clock: the first on the
 * server's, the second on the browser's monotonic clock (`performance.now()`, which a changed wall clock does not
 * move), so neither a server and a browser that disagree on the time nor a clock set back can make an old answer look
 * new. `receivedPerf` and `perfNow` are that monotonic clock, ms. Null without a quote time or a receipt.
 */
export function chainAgeMin(chain: ChainResponse | null | undefined, receivedPerf: number | null | undefined, perfNow: number | null | undefined): number | null {
  if (!chain || !fin(receivedPerf) || !fin(perfNow)) return null;
  const asOf = Date.parse(chain.as_of);
  let newest = -Infinity;
  for (const x of chain.expiries)
    for (const c of x.contracts) {
      const at = c.at ? Date.parse(c.at) : NaN;
      if (Number.isFinite(at) && at > newest) newest = at;
    }
  if (!Number.isFinite(asOf) || !Number.isFinite(newest)) return null;
  // The monotonic clock never runs backwards; the clamp only guards a caller that passes the two the wrong way round.
  return Math.max(0, asOf - newest) / 60_000 + Math.max(0, perfNow - receivedPerf) / 60_000;
}

/** A chain answer is fresh enough for a check while its prices are no older than STALE_SAME_DAY_MIN. */
export function chainFresh(chain: ChainResponse | null | undefined, receivedPerf: number | null | undefined, perfNow: number | null | undefined): boolean {
  const age = chainAgeMin(chain, receivedPerf, perfNow);
  return age !== null && age <= STALE_SAME_DAY_MIN;
}

/** "Option chain 10:14 NY · 15 min behind": the label on every chain-derived line (the chain's own time and delay). */
export function chainStamp(chain: ChainResponse): string {
  const at = newYork(chain.as_of, false);
  return `Option chain ${at} NY · ${chain.delay_min} min behind`;
}

/**
 * The at-the-money contract on a side, chosen as the Brief prices one (costs.ts): the nearest expiry still trading at
 * `now`, the strike nearest `price`, the lower of two equally near. `bell` gives an expiry's closing minute (a half
 * day's own expiry ends at 13:00). Null when the chain has none, and null when the nearest strike is more than one
 * strike step from `price`: a chain asked for before a big move no longer reaches the money, and its nearest strike
 * is not at it.
 */
export function atmContract(
  chain: ChainResponse,
  kind: OptionKind,
  price: number,
  now: number,
  bell?: (expiry: string) => number,
): { expiry: string; contract: ChainContract } | null {
  if (!fin(price) || price <= 0) return null;
  const open = chain.expiries.filter((x) => x.contracts.some((c) => c.kind === kind) && (minutesToExpiry(x.date, now, bell?.(x.date)) ?? 0) > 0);
  const near = open[0];
  if (!near) return null;
  const of = near.contracts.filter((c) => c.kind === kind);
  const contract = of.reduce((best, x) => {
    const d = Math.abs(x.strike - price) - Math.abs(best.strike - price);
    return d < 0 || (d === 0 && x.strike < best.strike) ? x : best;
  });
  // The step is the gap to the next listed strike on either side; a lone strike has none, so it cannot be judged.
  const strikes = [...new Set(of.map((c) => c.strike))].sort((a, b) => a - b);
  const i = strikes.indexOf(contract.strike);
  const gaps = [strikes[i + 1]! - contract.strike, contract.strike - strikes[i - 1]!].filter((g) => Number.isFinite(g) && g > 0);
  if (!gaps.length || Math.abs(contract.strike - price) > Math.max(...gaps) + 1e-9) return null;
  return { expiry: near.date, contract };
}

/**
 * The held contract when the chain carries it (its expiry, strike and side), else the at-the-money one on that side.
 * `held` says which, so the line can say whose delta it used.
 */
export function heldOrAtm(
  chain: ChainResponse,
  kind: OptionKind,
  held: { expiry: string; strike: number } | null | undefined,
  price: number,
  now: number,
  bell?: (expiry: string) => number,
): { expiry: string; contract: ChainContract; held: boolean } | null {
  if (held && (minutesToExpiry(held.expiry, now, bell?.(held.expiry)) ?? 0) > 0) {
    const c = chain.expiries.find((x) => x.date === held.expiry)?.contracts.find((x) => x.kind === kind && x.strike === held.strike);
    if (c) return { expiry: held.expiry, contract: c, held: true };
  }
  const atm = atmContract(chain, kind, price, now, bell);
  return atm ? { ...atm, held: false } : null;
}

export interface PremiumCheck {
  /** The ask per share. */
  ask: number;
  /** The ask for one contract (100 shares), in dollars. */
  perContract: number;
  over: boolean;
  /** "ATM call 755 ask $1.45 ($145 a contract), within the $2.00 cap ($200)", or the over-the-cap line. */
  line: string;
}

/**
 * The at-the-money option's ask for one contract against the premium cap (MAX_PREMIUM, dollars a contract). The line
 * says each figure a share first, as the platform quotes it, and a contract in brackets, the same form as the rules
 * strip's "Option under $2.00 ($200 a contract)", so the ask and the cap are always read in the same unit. Null
 * without an ask: nobody offering, or a crossed quote, whose ask is not to be trusted.
 */
export function premiumCheck(contract: ChainContract | null | undefined, cap: number = MAX_PREMIUM): PremiumCheck | null {
  if (!contract) return null;
  const q = readQuote(contract);
  if ((q.state !== "ok" && q.state !== "no-bid") || !fin(contract.ask) || contract.ask <= 0) return null;
  const ask = contract.ask;
  const perContract = Math.round(ask * 100 * 100) / 100;
  const over = perContract > cap + 1e-9;
  const capWords = `the ${usd(cap / 100)} cap (${whole(cap)})`;
  const head = `ATM ${contract.kind} ${contract.strike} ask ${usd(ask)} (${whole(perContract)} a contract)`;
  return { ask, perContract, over, line: over ? `${head}, over ${capWords}: pick a strike further out of the money` : `${head}, within ${capWords}` };
}

// ---- which stop first ---------------------------------------------------------------------------------------------
export interface StopFirst {
  first: "option" | "chart" | "together";
  /** The option's estimated loss at the chart stop, dollars a contract. */
  atChart: number;
  /** The −25% option stop, dollars a contract. */
  optionStop: number;
  text: string;
}

/**
 * Which stop a trade meets first: the chart stop `distance` away on the stock, where the option loses about
 * |delta| × distance × 100, or the −25% option stop at PREMIUM_STOP × premium × 100. The gap is said in $ on the stock.
 * The sign of delta does not matter (a put's is negative). Null without a positive distance, a delta or a premium.
 */
export function whichStopFirst(distance: number | null | undefined, delta: number | null | undefined, premium: number | null | undefined): StopFirst | null {
  if (!fin(distance) || distance <= 0 || !fin(delta) || delta === 0 || !fin(premium) || premium <= 0) return null;
  const d = Math.abs(delta);
  const atChart = d * distance * 100;
  const optionStop = PREMIUM_STOP * premium * 100;
  // The stock move at which the option has lost a quarter of its premium.
  const gap = distance - optionStop / (d * 100);
  const pct = `−${Math.round(PREMIUM_STOP * 100)}%`;
  if (Math.abs(gap) < 0.005)
    return { first: "together", atChart, optionStop, text: `The chart stop and the ${pct} option stop land about together (≈ −${whole(atChart)} on the option).` };
  if (gap > 0)
    return { first: "option", atChart, optionStop, text: `The ${pct} option stop comes first, about ${usd(gap)} on the stock before the chart stop.` };
  return {
    first: "chart",
    atChart,
    optionStop,
    text: `The chart stop comes first, about ${usd(-gap)} on the stock before the ${pct} option stop (≈ −${whole(atChart)} on the option there).`,
  };
}

// ---- the manage card's estimate -------------------------------------------------------------------------------------
/** $ on the stock from the price to the stop, on the side the trade is on; 0 or less once the price is through it. */
export function stopDistance(side: OptionKind, price: number | null | undefined, stop: number | null | undefined): number | null {
  if (!fin(price) || !fin(stop)) return null;
  return Math.round((side === "call" ? price - stop : stop - price) * 100) / 100;
}

/** The option's estimated loss at the stop, dollars a contract (|delta| × distance × 100). Null without both. */
export function optionAtStop(distance: number | null | undefined, delta: number | null | undefined): number | null {
  if (!fin(distance) || distance <= 0 || !fin(delta) || delta === 0) return null;
  return Math.abs(delta) * distance * 100;
}

/**
 * $ on the stock from the entry to the stop: what a stop costs the trade, whatever the price is doing now. Null when
 * the stop is not on the losing side of the entry for the side (a call's below it, a put's above it), or is the
 * entry: a stop on the wrong side is a mistake in the levels, and taking its size would hide it behind a loss that
 * looks normal. The hero's which-stop line and the manage card's estimate both measure with this, so they agree.
 */
export function entryStopDistance(side: OptionKind, entry: number | null | undefined, stop: number | null | undefined): number | null {
  if (!fin(entry) || !fin(stop)) return null;
  const d = Math.round((side === "call" ? entry - stop : stop - entry) * 100) / 100;
  return d > 0 ? d : null;
}

/**
 * The manage card's label for lossFromEntry, naming whose entry it is measured from: a journal lot's fill is unknown,
 * so its card measures from the card's entry and says so rather than calling it the owner's.
 */
export function fromEntryLabel(cardEntry: boolean): string {
  return `At the stop, from ${cardEntry ? "the card entry" : "your entry"}`;
}

/** The option's estimated loss if the stop is hit, measured from the entry: |delta| × |entry − stop| × 100. */
export function lossFromEntry(
  side: OptionKind,
  entry: number | null | undefined,
  stop: number | null | undefined,
  delta: number | null | undefined,
): number | null {
  return optionAtStop(entryStopDistance(side, entry, stop), delta);
}

// ---- the day's room -------------------------------------------------------------------------------------------------
/**
 * "A stop now leaves $50 of $100 and 4 trades": the day's room once one more trade is taken and stopped, a stop
 * costing at most RISK_PER_TRADE. Null when it cannot be said truthfully: the journal is not current, the day is
 * already over, or a position is open (its open loss is not priced here).
 */
export function dayRoom(c: Pick<DayCheck, "status" | "current" | "used" | "net" | "openLine">): string | null {
  if (!c.current || c.status === "stop" || c.status === "unknown" || c.openLine) return null;
  if (!fin(c.used) || !fin(c.net)) return null;
  const left = Math.max(0, DAY_LOSS_LIMIT + Math.min(0, c.net) - RISK_PER_TRADE);
  const trades = Math.max(0, MAX_TRADES_PER_DAY - c.used - 1);
  const room = `${whole(left)} of ${whole(DAY_LOSS_LIMIT)}`;
  if (left <= 0) return `A stop now ends the day: ${room} left.`;
  if (trades === 0) return `A stop now leaves ${room} and no trades: this is the day's last.`;
  return `A stop now leaves ${room} and ${trades} trade${trades === 1 ? "" : "s"}.`;
}

/**
 * The day's room line as the page shows it (the rail and the hero alike): none while the board has any open trade card.
 * The server builds the line from the journal alone, and an "I'm in" note lives only in this browser: its trade is
 * not priced, and its fill may not have reached the journal yet, so a room worked out without it would be too generous.
 */
export function roomShown(room: string | null | undefined, openCards: number): string | null {
  return room && openCards === 0 ? room : null;
}
