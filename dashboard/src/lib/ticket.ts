// The trade ticket: the owner's own rules worked out against the option price he types from Webull. How many
// contracts fit, the stop to place, the dollars at risk at that stop with fees, and, only when the typed price lets
// a volatility be solved, estimates of what the option may be worth at the chart stop and the first target. Pure.
//
// Every amount is held in whole cents, so no rule is passed or failed by a floating-point crumb. The option chain on
// the site is 15 minutes behind and never feeds any number here: only the typed price does. This is arithmetic on
// the owner's rules, not advice, and nothing here places an order.
import { impliedVol, type OptionKind } from "./bs";
import { minutesToExpiry } from "./contract";
import { nyNow, sessionOf } from "./market-calendar";
import { MULTIPLIER, valueIf } from "./longopt";
import { OWNER_FEES } from "./owner-positions";
import { MAX_PREMIUM, PREMIUM_STOP, RISK_PER_TRADE } from "./trade-rules";

// ---- reading what was typed -----------------------------------------------------------------------------------------
/** No listed stock option is quoted anywhere near this a share; a bigger number is a typing slip. */
export const MAX_TYPED = 10_000;

export type PriceRead =
  | { kind: "empty" }
  | { kind: "bad"; why: "not_a_number" | "zero" | "negative" | "too_high" | "too_many_decimals"; text: string }
  /**
   * `cents` a share. `reread` when what was typed is not a plain price like "1.25" or "$1.25" (a comma, a space, a
   * grouping, trailing zeros): the page then says what it read, so a misread is seen before it is sized.
   */
  | { kind: "ok"; cents: number; reread: boolean };

/** A price written the plain way: digits, at most two decimals, an optional leading "$". */
const PLAIN = /^\$?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;

/**
 * A typed amount as whole cents, read from the string itself (never through a float): "1.25", "$1.25", "1,25",
 * " 1.25 ", ".5" all read. Null for anything that is not a non-negative decimal; `neg` marks a leading minus, and
 * `extra` a non-zero digit past the cent (refused, never rounded).
 */
function toCents(raw: string): { cents: number; neg: boolean; extra: boolean } | null {
  // "$-1.25", "-$1.25" and "−1.25" are all a minus sign and a price.
  let s = raw.replace(/\s+/g, "").replace(/^\$/, "");
  const neg = /^[-−]/.test(s);
  if (neg) s = s.slice(1).replace(/^\$/, "");
  // A comma is a decimal point when it is the only separator ("1,25"); beside a point it groups thousands.
  s = s.includes(".") ? s.replace(/,/g, "") : s.replace(",", ".");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = m[2] ?? "";
  if (!Number.isSafeInteger(whole) || whole > MAX_TYPED * 10) return { cents: Number.MAX_SAFE_INTEGER, neg, extra: false };
  const two = Number((frac + "00").slice(0, 2));
  return { cents: whole * 100 + two, neg, extra: /[1-9]/.test(frac.slice(2)) };
}

/** The option price as typed: empty, not usable (with a plain reason), or whole cents a share. */
export function readPrice(raw: string | null | undefined): PriceRead {
  if (raw == null || raw.trim() === "" || raw.trim() === "$") return { kind: "empty" };
  const c = toCents(raw);
  if (!c) return { kind: "bad", why: "not_a_number", text: "Type the price as a number, like 1.25." };
  if (c.neg && (c.cents > 0 || c.extra)) return { kind: "bad", why: "negative", text: "A price can't be below zero." };
  if (c.extra) return { kind: "bad", why: "too_many_decimals", text: "Use at most two decimals, like 1.25: options trade in cents." };
  if (c.cents === 0) return { kind: "bad", why: "zero", text: "A price of zero is not a price to size." };
  if (c.cents > MAX_TYPED * 100) return { kind: "bad", why: "too_high", text: "That is far too high for an option price a share." };
  return { kind: "ok", cents: c.cents, reread: !PLAIN.test(raw.trim()) };
}

/** A typed strike or other positive amount in dollars, or null when it is not one. */
export function readAmount(raw: string | null | undefined): number | null {
  const p = readPrice(raw);
  return p.kind === "ok" ? p.cents / 100 : null;
}

// ---- the tick -----------------------------------------------------------------------------------------------------
/**
 * The price step, in cents, for an option price in cents. The site has no source for a contract's real tick, so this
 * is an assumption the page states ("check the tick in Webull"): $0.01 under $3.00 and $0.05 at or above, the common
 * penny-program steps. A contract outside that program may step $0.05 under $3.00; Webull shows which.
 */
export const TICK_SWITCH_CENTS = 300;
export function tickCents(priceCents: number): 1 | 5 {
  return priceCents >= TICK_SWITCH_CENTS ? 5 : 1;
}

const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/** Share of the premium kept at the stop, in whole percent (75 for a 25% stop). */
const KEEP_PCT = Math.round((1 - PREMIUM_STOP) * 100);

/**
 * The stop price to place, in cents: (1 − PREMIUM_STOP) × price, rounded UP to the tick (a higher stop loses less).
 * The tick is the one for the stop's own price: under $3.00 it rounds to the cent, else to the nickel.
 */
export function stopCents(priceCents: number): number {
  const num = KEEP_PCT * priceCents; // the exact stop is num / 100 cents
  if (num >= TICK_SWITCH_CENTS * 100) return ceilDiv(num, 500) * 5;
  return ceilDiv(num, 100);
}

// ---- sizing -------------------------------------------------------------------------------------------------------
export interface Fees {
  openPerContract: number;
  closePerContract: number;
}

/** Fees for one contract bought and sold, in cents. */
export function roundTripCents(fees: Fees = OWNER_FEES): number {
  return Math.round(fees.openPerContract * 100) + Math.round(fees.closePerContract * 100);
}

export interface Limits {
  /** The most premium for the whole trade, dollars. */
  maxPremium: number;
  /** The most the trade may lose at its stop, fees included, dollars. */
  maxRisk: number;
  fees: Fees;
}

export const OWNER_LIMITS: Limits = { maxPremium: MAX_PREMIUM, maxRisk: RISK_PER_TRADE, fees: OWNER_FEES };

/** The rules a price can fail: the premium cap, the risk cap, or no room for a stop under the price at all. */
export type RuleName = "premium" | "risk" | "stop";

export interface Size {
  priceCents: number;
  /** The largest whole number of contracts that keeps both rules; 0 when not even one does. */
  contracts: number;
  stopCents: number;
  /** The tick the stop was rounded to, cents. */
  tick: 1 | 5;
  /** One contract: what it costs, what it loses at the stop before fees, and its round-trip fees, all cents. */
  perContract: { premium: number; lossAtStop: number; fees: number; risk: number };
  /** The whole trade at `contracts`: premium paid, fees, and the loss at the stop with fees, all cents. */
  premiumCents: number;
  feesCents: number;
  riskCents: number;
  /** The most contracts each rule alone allows. */
  byPremium: number;
  byRisk: number;
  /** The rules that one contract already breaks: why `contracts` is 0. Empty when it is not. */
  fails: RuleName[];
}

/**
 * contracts = the largest N with N × price × 100 ≤ maxPremium and N × (loss a contract at the stop + round-trip fees
 * a contract) ≤ maxRisk, the stop being stopCents(price). Integer cents throughout.
 */
export function sizeTicket(priceCents: number, limits: Limits = OWNER_LIMITS): Size {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new RangeError("price must be a positive whole number of cents");
  const stop = stopCents(priceCents);
  const premium = priceCents * MULTIPLIER;
  const lossAtStop = (priceCents - stop) * MULTIPLIER;
  const fees = roundTripCents(limits.fees);
  const risk = lossAtStop + fees;
  const capCents = Math.round(limits.maxPremium * 100);
  const riskCents = Math.round(limits.maxRisk * 100);
  const byPremium = Math.floor(capCents / premium);
  const byRisk = risk > 0 ? Math.floor(riskCents / risk) : Number.MAX_SAFE_INTEGER;
  // A price so low that the stop rounds up to the price itself has no stop under it: nothing to size.
  const noStop = stop >= priceCents;
  const contracts = noStop ? 0 : Math.max(0, Math.min(byPremium, byRisk));
  const fails: RuleName[] = [];
  if (byPremium < 1) fails.push("premium");
  if (byRisk < 1) fails.push("risk");
  if (noStop) fails.push("stop");
  return {
    priceCents,
    contracts,
    stopCents: stop,
    tick: tickCents(stop),
    perContract: { premium, lossAtStop, fees, risk },
    premiumCents: contracts * premium,
    feesCents: contracts * fees,
    riskCents: contracts * risk,
    byPremium,
    byRisk,
    fails,
  };
}

/** "$1,234.56" from whole cents. */
export function usd(cents: number): string {
  const neg = cents < 0;
  const a = Math.abs(Math.round(cents));
  const s = `$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
  return neg ? `−${s}` : s;
}

/** Why a price sizes to nothing, one plain line per rule it breaks. */
export function failWords(s: Size, limits: Limits = OWNER_LIMITS): string[] {
  const out: string[] = [];
  if (s.fails.includes("premium"))
    out.push(`One contract costs ${usd(s.perContract.premium)}, over the ${usd(limits.maxPremium * 100)} premium cap.`);
  if (s.fails.includes("risk"))
    out.push(
      `One contract would lose ${usd(s.perContract.risk)} at the stop with fees (${usd(s.perContract.lossAtStop)} + ${usd(s.perContract.fees)} fees), over the ${usd(limits.maxRisk * 100)} risk cap.`,
    );
  if (s.fails.includes("stop"))
    out.push(`Too cheap to place a stop under it: −${Math.round(PREMIUM_STOP * 100)}% rounds up to ${usd(s.stopCents)}, the price itself.`);
  return out;
}

/** The one short line read out on a change: the size and the stop, or that nothing fits. Not the whole block. */
export function resultLine(size: Size): string {
  if (size.contracts === 0) return `At ${usd(size.priceCents)}: does not fit your rules.`;
  return `${size.contracts} contract${size.contracts === 1 ? "" : "s"}, stop ${usd(size.stopCents)}.`;
}

/** What each cent of a worse fill at the stop costs the sized trade, cents: a cent a share on 100 shares a contract. */
export function slipPerCent(s: Pick<Size, "contracts">): number {
  return s.contracts * MULTIPLIER;
}

/**
 * The stop if the contract steps $0.05, not $0.01: (1 − PREMIUM_STOP) × price rounded UP to the nickel, with the sized
 * trade's loss there, fees in. Only when the assumed stop is under $3.00 and off the nickel (else they agree), and
 * never a stop at or over the price. Never a rounded-down stop.
 */
export function nickelStop(s: Size, fees: Fees = OWNER_FEES): { stopCents: number; riskCents: number } | null {
  if (s.contracts < 1 || s.stopCents >= TICK_SWITCH_CENTS || s.stopCents % 5 === 0) return null;
  const stop = ceilDiv(KEEP_PCT * s.priceCents, 500) * 5;
  if (stop >= s.priceCents) return null;
  return { stopCents: stop, riskCents: s.contracts * ((s.priceCents - stop) * MULTIPLIER + roundTripCents(fees)) };
}

// ---- the most he may pay --------------------------------------------------------------------------------------------
export interface LimitRow {
  contracts: number;
  /** The highest price a share, on the tick, with contracts × price × 100 within the premium cap. Cents. */
  capCents: number;
  /** The highest price a share, on the tick, at which this many contracts keep both rules, fees in. Null if none. */
  bothCents: number | null;
}

/** The highest price on the tick at or below `cents` (rounded DOWN). */
export function floorToTick(cents: number): number {
  const c = Math.floor(cents);
  // Rounding a price at or over $3.00 down to the nickel never takes it under $3.00, so one test is enough.
  return c >= TICK_SWITCH_CENTS ? Math.floor(c / 5) * 5 : c;
}

/** For N = 1 … rows: the most a share that keeps N contracts within the premium cap, and within both rules. */
export function maxLimitTable(rows = 5, limits: Limits = OWNER_LIMITS): LimitRow[] {
  const capTotal = Math.round(limits.maxPremium * 100);
  const out: LimitRow[] = [];
  for (let n = 1; n <= rows; n++) {
    const capCents = floorToTick(Math.floor(capTotal / (n * MULTIPLIER)));
    let both: number | null = null;
    // Down from the cap one tick at a time: the first price that fits is the highest (a few hundred steps at most).
    for (let p = capCents; p >= 1; p -= tickCents(p - 1)) {
      if (sizeTicket(p, limits).contracts >= n) {
        both = p;
        break;
      }
    }
    out.push({ contracts: n, capCents, bothCents: both });
  }
  return out;
}

// ---- estimates from the typed price ---------------------------------------------------------------------------------
/** An implied volatility outside this range (3% to 500% a year) is taken as a failed solve, not a reading. */
export const IV_MIN = 0.03;
export const IV_MAX = 5;
/** Under $0.05 a share a cent of the price is a fifth of it: too coarse to solve a volatility from. */
export const MIN_ESTIMATE_CENTS = 5;

export interface EstimateInput {
  kind: OptionKind;
  /** The typed price a share, cents. */
  paidCents: number;
  /** The live stock price. Nothing else (a close, a pre-market print) will do. */
  spot: number | null | undefined;
  strike: number | null | undefined;
  /** Minutes to the contract's last bell. */
  minutes: number | null | undefined;
  contracts: number;
  levels: { key: "stop" | "t1"; label: string; price: number | null | undefined }[];
  fees?: Fees;
}

export interface Estimate {
  key: "stop" | "t1";
  label: string;
  stockPrice: number;
  /** The option's estimated value a share, cents. */
  valueCents: number;
  /** For the sized contracts, against the typed price, round-trip fees in. Cents. */
  pnlCents: number;
}

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * What the option may be worth if the stock were at each level now, from the volatility the typed price implies at
 * the live stock price, strike and time left. Null, with no number at all, whenever any input is missing, the solve
 * fails, or it lands outside IV_MIN … IV_MAX: there is no fallback volatility.
 */
export function ticketEstimates(x: EstimateInput): { iv: number; rows: Estimate[] } | null {
  if (!Number.isSafeInteger(x.paidCents) || x.paidCents < MIN_ESTIMATE_CENTS) return null;
  if (!pos(x.spot) || !pos(x.strike) || !pos(x.minutes)) return null;
  if (x.kind !== "call" && x.kind !== "put") return null;
  // Within a tick of what it is in the money by, the price says almost nothing about volatility: no estimate.
  const intrinsic = Math.round(Math.max(0, x.kind === "call" ? x.spot - x.strike : x.strike - x.spot) * 100);
  if (x.paidCents <= intrinsic + tickCents(x.paidCents)) return null;
  const iv = impliedVol(x.paidCents / 100, x.spot, x.strike, x.minutes, x.kind);
  if (iv === null || !Number.isFinite(iv) || iv < IV_MIN || iv > IV_MAX) return null;
  const fees = roundTripCents(x.fees);
  const n = Math.max(0, Math.floor(x.contracts));
  const rows: Estimate[] = [];
  for (const l of x.levels) {
    if (!pos(l.price)) continue;
    const v = valueIf(l.price, x.strike, x.minutes, iv, x.kind);
    if (!Number.isFinite(v) || v < 0) continue;
    const valueCents = Math.round(v * 100);
    rows.push({ key: l.key, label: l.label, stockPrice: l.price, valueCents, pnlCents: n * ((valueCents - x.paidCents) * MULTIPLIER - fees) });
  }
  return rows.length ? { iv, rows } : null;
}

/** Strikes ordered by distance from the live stock price, nearest first; the lower of two equally near first. */
export function strikesByDistance(strikes: readonly number[], spot: number | null | undefined, limit = 6): number[] {
  if (!pos(spot)) return [];
  const uniq = [...new Set(strikes.filter(pos))];
  return uniq.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b).slice(0, limit);
}

// ---- the expiry and the quote's age -------------------------------------------------------------------------------
/**
 * Minutes from `now` to an expiry's last bell, from the market calendar (a half day closes at 13:00). Null when it
 * cannot be said truthfully: not a date, a day the market is shut, or today while the page's edition is for another
 * session (its clock is not today's, so a same-day number would rest on it). Zero or less once the bell has gone.
 */
export function minutesLeft(expiry: string, now: number | null, session: string): number | null {
  if (now === null || !Number.isFinite(now) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const today = nyNow(new Date(now)).day;
  const day = sessionOf(expiry);
  if (expiry === today && session !== today) return null;
  if (day.kind === "closed" || day.kind === "weekend") return null;
  // Past the calendar's range the regular 16:00 bell is assumed: that far out a half day moves nothing that matters.
  return minutesToExpiry(expiry, now, day.close ?? 16 * 60);
}

export type ExpiryPick = { expiry: string | null; note: string | null };

/**
 * The expiry the estimates use: only one the reader picked, never a default. `listed` is the chain's expiries for the
 * side, or null with no chain. A pick that has passed, or that the chain no longer lists, is dropped and said.
 */
export function expiryPick(picked: string, listed: readonly string[] | null, minutes: number | null): ExpiryPick {
  if (!picked) return { expiry: null, note: null };
  if (listed !== null && listed.length > 0 && !listed.includes(picked)) return { expiry: null, note: `${picked} is no longer in the chain: pick an expiry again.` };
  if (minutes !== null && minutes <= 0) return { expiry: null, note: `${picked} has passed: pick an expiry again.` };
  return { expiry: picked, note: null };
}

/**
 * How old one contract's quote is now, in whole minutes rounded UP so it is never understated: its own quote time
 * against the answer's `as_of` (both on the server's clock), plus the time since the answer arrived (the browser's
 * monotonic clock). Null without that contract's own time.
 */
export function quoteAgeMin(at: string | null | undefined, asOf: string, receivedPerf: number | null | undefined, perfNow: number | null | undefined): number | null {
  const q = at ? Date.parse(at) : NaN;
  const a = Date.parse(asOf);
  if (!Number.isFinite(q) || !Number.isFinite(a) || typeof receivedPerf !== "number" || typeof perfNow !== "number") return null;
  return Math.ceil((Math.max(0, a - q) + Math.max(0, perfNow - receivedPerf)) / 60_000);
}
