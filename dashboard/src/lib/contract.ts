// One call or put the reader is weighing or holding, and what the desk can say about it. Pure: no I/O.
//
// Everything here is an estimate from a flat-volatility model (bs.ts) on quotes 15 minutes behind the market. It
// describes a contract; it never says whether to buy it.
import { floorValue, greeks, impliedVol, type OptionKind } from "./bs";
import type { ChainContract, ChainResponse } from "./chain";
import { weekDate } from "./format";
import { breakeven, breakevenMoves, decay, maxLoss, pnl, valueIf } from "./longopt";
import { closeMinute, nearest, nyClock, nyInstant, type OptionsTicker } from "./options";

/** The contract chosen for a name. Kept in the reader's browser only; it is never sent anywhere. */
export interface Pick {
  kind: OptionKind;
  /** YYYY-MM-DD. */
  expiry: string;
  strike: number;
  contracts: number;
  /** What was paid per share, when the reader has typed it. Null prices the trade at today's ask. */
  paid: number | null;
}

export const MAX_CONTRACTS = 999;
/** No stock option trades at a strike or a premium anywhere near these. Storage can hold anything, so they are bounds. */
const MAX_STRIKE = 1_000_000;
const MAX_PAID = 100_000;
export const pickKey = (symbol: string) => `tl-options-contract:${symbol}`;

/** A stored pick, or null when it is missing or not one: storage belongs to the browser and can hold anything. */
export function parsePick(raw: string | null | undefined): Pick | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (p.kind !== "call" && p.kind !== "put") return null;
  if (typeof p.expiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.expiry)) return null;
  if (!num(p.strike) || p.strike <= 0 || p.strike > MAX_STRIKE) return null;
  if (!num(p.contracts) || !Number.isInteger(p.contracts) || p.contracts < 1 || p.contracts > MAX_CONTRACTS) return null;
  if (p.paid !== null && !(num(p.paid) && p.paid > 0 && p.paid <= MAX_PAID)) return null;
  return { kind: p.kind, expiry: p.expiry, strike: p.strike, contracts: p.contracts, paid: p.paid };
}

/** Options stop trading at the New York close of their expiration date: 16:00, or 13:00 on a half day. */
export const EXPIRY_MINUTE = 16 * 60;

/**
 * The minute of the day a contract's last session closes. The only half day the page knows about is the edition's
 * own session, so that is the only expiry that can be given the early bell.
 */
export function bellMinute(expiry: string, session: string, halfDay: boolean | null | undefined): number {
  return expiry === session ? closeMinute(halfDay) : EXPIRY_MINUTE;
}

/** Minutes from `now` to a contract's expiry; negative once it has passed. Null for a date that is not one. */
export function minutesToExpiry(expiry: string, now: number, bell: number = EXPIRY_MINUTE): number | null {
  const at = nyInstant(expiry, bell);
  return at === null ? null : (at - now) / 60_000;
}

/** Calendar days from New York's today to the expiry: 0 on the day itself. */
export function daysToExpiry(expiry: string, now: number): number | null {
  const today = nyClock(new Date(now).toISOString())?.day;
  const a = Date.parse(`${expiry}T00:00:00Z`);
  const b = today ? Date.parse(`${today}T00:00:00Z`) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86_400_000) : null;
}

/**
 * What a contract's quote amounts to.
 * - `ok`: a bid and an ask, the right way round.
 * - `no-bid`: an ask but nobody bidding. The mid is half the ask, by convention; it is a weak guide.
 * - `no-market`: no ask, or no quote at all.
 * - `crossed`: the bid is above the ask, as a stale quote can be. No mid is taken from it.
 */
export interface QuoteRead {
  state: "ok" | "no-bid" | "no-market" | "crossed";
  mid: number | null;
  /** The bid-ask spread as a percentage of the mid. */
  spreadPct: number | null;
}

export function readQuote(c: ChainContract): QuoteRead {
  if (c.ask === null || c.ask <= 0) return { state: "no-market", mid: null, spreadPct: null };
  if (c.bid !== null && c.bid > c.ask) return { state: "crossed", mid: null, spreadPct: null };
  const bid = c.bid ?? 0;
  const mid = (bid + c.ask) / 2;
  return { state: bid > 0 ? "ok" : "no-bid", mid, spreadPct: ((c.ask - bid) / mid) * 100 };
}

/** Where the volatility used for a contract came from. */
export type VolSource = "quote" | "mid" | "name";

/**
 * The volatility to price a contract with: the one that came with its quote; failing that, the one its mid implies
 * at the stock's price; failing that, the name's own 30-day implied volatility from the edition.
 */
export function volFor(c: ChainContract | null, mid: number | null, spot: number, minutes: number, nameIv: number | null | undefined): { sigma: number | null; from: VolSource | null } {
  if (c?.iv != null) return { sigma: c.iv, from: "quote" };
  if (c && mid !== null) {
    const iv = impliedVol(mid, spot, c.strike, minutes, c.kind);
    if (iv !== null) return { sigma: iv, from: "mid" };
  }
  return nameIv != null && nameIv > 0 ? { sigma: nameIv, from: "name" } : { sigma: null, from: null };
}

/**
 * While the market is open, option quotes older than this are too old to price a same-day contract from (the feed
 * itself runs 15 minutes behind); a contract with days to run can stand older ones.
 */
export const STALE_SAME_DAY_MIN = 35;
export const STALE_LATER_MIN = 105;

/** How old the newest quote anywhere in the chain is, in minutes: the age of the feed, not of one quiet contract. */
export function feedAge(chain: ChainResponse | null, now: number): number | null {
  let newest = -Infinity;
  for (const x of chain?.expiries ?? []) {
    for (const c of x.contracts) {
      const at = c.at ? Date.parse(c.at) : NaN;
      if (at > newest) newest = at;
    }
  }
  return Number.isFinite(newest) ? Math.max(0, (now - newest) / 60_000) : null;
}

export interface ScenarioLevel {
  label: string;
  price: number;
}

/**
 * The stock prices worth asking "what if" about: the nearest resistance and support, one expected day's move either
 * side of the close, and the stock's own price, called "Now" when it is a live one and "Last close" when the market
 * is shut and it is not. Highest first; two that land on the same cent are one.
 */
export function scenarioLevels(t: OptionsTicker, spot: number, priceIsLive = true): ScenarioLevel[] {
  const here = priceIsLive ? "Now" : "Last close";
  const near = nearest(t);
  const close = t.last?.close ?? null;
  const day = t.expected_move?.day ?? null;
  const all: (ScenarioLevel | null)[] = [
    near.resistance ? { label: "Resistance", price: near.resistance.edge } : null,
    close !== null && day !== null ? { label: "+1 day move", price: close + day } : null,
    { label: here, price: spot },
    close !== null && day !== null ? { label: "−1 day move", price: close - day } : null,
    near.support ? { label: "Support", price: near.support.edge } : null,
  ];
  const out: ScenarioLevel[] = [];
  for (const l of all) {
    if (!l || !Number.isFinite(l.price) || l.price <= 0) continue;
    // The stock's own price wins a tie: it is the row the reader looks for.
    const twin = out.findIndex((o) => Math.abs(o.price - l.price) < 0.005);
    if (twin === -1) out.push(l);
    else if (l.label === here) out[twin] = l;
  }
  return out.sort((a, b) => b.price - a.price);
}

export interface ScenarioTime {
  label: string;
  /** Minutes from now. */
  ahead: number;
}

export interface ContractView {
  /** The chain's row for the pick, when the chain carries it. */
  contract: ChainContract | null;
  quote: QuoteRead | null;
  /** How old the newest option quote in the chain is, in minutes. */
  ageMin: number | null;
  /** Minutes to expiry; zero or less once it has passed. */
  minutes: number | null;
  days: number | null;
  expired: boolean;
  /** True while the market is open and the option quotes are too old to price from. The numbers are then withheld. */
  stale: boolean;
  /** The label of the row for the stock's own price: "Now", or "Last close" when the market is shut. */
  here: string;
  sigma: number | null;
  volFrom: VolSource | null;
  /** What the trade is priced at per share, and where that came from. */
  paid: number | null;
  paidFrom: "entered" | "ask" | "model" | null;
  /** The premium for all contracts, in dollars: the most the trade can lose. */
  cost: number | null;
  breakeven: number | null;
  /** Expected day's moves from the stock's price to breakeven, in the direction the option needs. */
  breakevenMoves: number | null;
  /** The model's value per share now, at the stock's price. */
  value: number | null;
  pnlNow: number | null;
  delta: number | null;
  thetaDay: number | null;
  /** What an hour of waiting costs per share, stock and volatility unchanged. */
  decayHour: number | null;
  times: ScenarioTime[];
  /** One row per level; one cell per time. P&L is for all contracts, in dollars, and null with nothing paid. */
  rows: { level: ScenarioLevel; cells: { value: number; pnl: number | null }[] }[];
}

/**
 * Everything the contract pane shows for one pick. `spot` is the stock's price: live in session, else the last
 * close, and `priceIsLive` says which. `marketOpen` is read off the clock, not off a quote: it is when old option
 * quotes mean a feed in trouble rather than a market that is shut.
 */
export function contractView(
  pick: Pick,
  chain: ChainResponse | null,
  t: OptionsTicker,
  spot: number,
  now: number,
  session: string,
  clock: { marketOpen: boolean; priceIsLive: boolean },
): ContractView {
  const contract = chain?.expiries.find((x) => x.date === pick.expiry)?.contracts.find((c) => c.kind === pick.kind && c.strike === pick.strike) ?? null;
  const quote = contract ? readQuote(contract) : null;
  const ageMin = feedAge(chain, now);
  const minutes = minutesToExpiry(pick.expiry, now, bellMinute(pick.expiry, session, t.half_day));
  const days = daysToExpiry(pick.expiry, now);
  const expired = minutes === null || minutes <= 0;
  const stale = clock.marketOpen && !expired && ageMin !== null && ageMin > (days === 0 ? STALE_SAME_DAY_MIN : STALE_LATER_MIN);
  const here = clock.priceIsLive ? "Now" : "Last close";
  const blank: ContractView = {
    contract, quote, ageMin, minutes, days, expired, stale, here,
    sigma: null, volFrom: null, paid: null, paidFrom: null, cost: null, breakeven: null, breakevenMoves: null,
    value: null, pnlNow: null, delta: null, thetaDay: null, decayHour: null, times: [], rows: [],
  };
  if (expired || stale || !(spot > 0)) return blank;

  const left = minutes!;
  const { sigma, from } = volFor(contract, quote?.mid ?? null, spot, left, t.expected_move?.annual_iv);
  const value = sigma !== null ? valueIf(spot, pick.strike, left, sigma, pick.kind) : null;
  const ask = contract?.ask ?? null;
  const [paid, paidFrom]: [number | null, ContractView["paidFrom"]] =
    pick.paid !== null ? [pick.paid, "entered"] : ask !== null && ask > 0 && quote?.state !== "crossed" ? [ask, "ask"] : value !== null && value > 0 ? [value, "model"] : [null, null];
  const g = sigma !== null ? greeks(spot, pick.strike, left, sigma, pick.kind) : null;

  // With no volatility the model can only say what the option is worth at expiry, where volatility no longer matters.
  const times: ScenarioTime[] = [];
  if (sigma !== null) {
    times.push({ label: here, ahead: 0 });
    const close = nyInstant(session, closeMinute(t.half_day));
    const untilClose = close === null ? null : (close - now) / 60_000;
    // The session's close, when it is still ahead and is not the expiry itself.
    if (untilClose !== null && untilClose > 1 && untilClose < left - 1) times.push({ label: `${weekDate(session)} close`, ahead: untilClose });
  }
  times.push({ label: "Expiry", ahead: left });

  return {
    ...blank,
    sigma,
    volFrom: from,
    paid,
    paidFrom,
    cost: paid !== null ? maxLoss(paid, pick.contracts) : null,
    breakeven: paid !== null ? breakeven(pick.strike, paid, pick.kind) : null,
    breakevenMoves: paid !== null ? breakevenMoves(pick.strike, paid, pick.kind, spot, t.expected_move?.day) : null,
    value,
    pnlNow: value !== null && paid !== null ? pnl(value, paid, pick.contracts) : null,
    delta: g?.delta ?? null,
    thetaDay: g?.thetaDay ?? null,
    // Never below zero: with no rate or yield an option cannot gain from time passing, only rounding can say so.
    decayHour: sigma !== null ? Math.max(0, decay(spot, pick.strike, left, sigma, pick.kind, 60)) : null,
    times,
    rows: scenarioLevels(t, spot, clock.priceIsLive).map((level) => ({
      level,
      cells: times.map((time) => {
        // At expiry the option is worth exactly what it would be exercised for; the model's one-minute floor on
        // time would add a few cents at the strike and disagree with the breakeven above.
        const v = time.ahead >= left ? floorValue(level.price, pick.strike, 0, pick.kind) : valueIf(level.price, pick.strike, left, sigma, pick.kind, time.ahead);
        return { value: v, pnl: paid !== null ? pnl(v, paid, pick.contracts) : null };
      }),
    })),
  };
}

/**
 * The pick a name opens on when the reader has chosen nothing: one call, nearest expiry, the strike nearest `around`.
 * `around` should be a price that holds still (the one the chain was asked for), or the strike would flip with
 * every tick of a stock sitting between two strikes.
 */
export function defaultPick(chain: ChainResponse, around: number): Pick | null {
  const first = chain.expiries.find((x) => x.contracts.length > 0);
  if (!first) return null;
  const calls = first.contracts.filter((c) => c.kind === "call");
  const from = calls.length > 0 ? calls : first.contracts;
  const c = from.reduce((best, x) => (Math.abs(x.strike - around) < Math.abs(best.strike - around) ? x : best));
  return { kind: c.kind, expiry: first.date, strike: c.strike, contracts: 1, paid: null };
}
