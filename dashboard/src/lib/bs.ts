// Black-Scholes for one long option: its value, its sensitivities, and the volatility a price implies. Pure.
//
// The same arithmetic as src/wt/options/bs.py, and held to the same vectors (test/fixtures/bs.vectors.json, written
// by scripts/gen_bs_vectors.py). It is the textbook European formula with a flat rate and a flat dividend yield.
// US stock options are American, so a put, and a call just before a dividend, are worth slightly more than this
// says: every number built on it is an estimate, and the page says so.

export type OptionKind = "call" | "put";

export const MINUTES_PER_YEAR = 365 * 24 * 60;
/** Time to expiry is never taken as less than one minute: at zero the formulas divide by zero. */
export const MIN_MINUTES = 1;
/** The range searched for an implied volatility: 0.01% to 1000% a year. */
export const VOL_LO = 1e-4;
export const VOL_HI = 10;
/**
 * A price this close to a bound of the search, as a fraction of the stock price, carries no information about
 * volatility: the answer would be decided by rounding. A billionth of the stock price is far below a cent.
 */
export const VOL_EDGE = 1e-9;
/** Halvings of that range: past what a double can resolve, and the same fixed count as the Python. */
const BISECTIONS = 60;

/** How the value moves: per $1 of stock, per $1 of stock again, per calendar day, per volatility point. */
export interface Greeks {
  delta: number;
  gamma: number;
  thetaDay: number;
  vegaPt: number;
}

/** Minutes to expiry as a fraction of a 365-day year, floored at one minute. */
export function years(minutes: number): number {
  return Math.max(minutes, MIN_MINUTES) / MINUTES_PER_YEAR;
}

const SQRT_PI = Math.sqrt(Math.PI);

/**
 * The complementary error function to double precision, tails included. JavaScript has none built in.
 *
 * Near zero it sums the series for erf whose terms are all positive, so nothing cancels. Further out, where erfc is
 * tiny and 1 − erf would lose every digit, it evaluates the continued fraction for erfc itself.
 */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x < 2.5) {
    // erf(x) = 2/√π · e^(−x²) · Σ 2ⁿ x^(2n+1) / (1·3·5···(2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n++) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * sum;
  }
  if (x > 27) return 0;
  // erfc(x) = e^(−x²)/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + …))))), evaluated from the tail inwards.
  let tail = x;
  for (let n = 60; n >= 1; n--) tail = x + n / 2 / tail;
  return Math.exp(-x * x) / (SQRT_PI * tail);
}

const cdf = (x: number) => 0.5 * erfc(-x / Math.SQRT2);
const pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const usable = (sigma: number | null | undefined): sigma is number => typeof sigma === "number" && Number.isFinite(sigma) && sigma > 0;

function check(s: number, k: number): void {
  if (!(Number.isFinite(s) && Number.isFinite(k) && s > 0 && k > 0)) throw new RangeError("stock price and strike must be positive numbers");
}

/** The value with no volatility at all: how far in the money the forward is, never below zero. */
export function floorValue(s: number, k: number, minutes: number, kind: OptionKind, r = 0, q = 0): number {
  check(s, k);
  const t = years(minutes);
  const forward = s * Math.exp(-q * t) - k * Math.exp(-r * t);
  return Math.max(kind === "call" ? forward : -forward, 0);
}

function d1d2(s: number, k: number, t: number, sigma: number, r: number, q: number): [number, number] {
  const spread = sigma * Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / spread;
  return [d1, d1 - spread];
}

/** The option's value per share. With no usable volatility it falls back to `floorValue`. */
export function price(s: number, k: number, minutes: number, sigma: number | null | undefined, kind: OptionKind, r = 0, q = 0): number {
  check(s, k);
  if (!usable(sigma)) return floorValue(s, k, minutes, kind, r, q);
  const t = years(minutes);
  const [d1, d2] = d1d2(s, k, t, sigma, r, q);
  const stock = s * Math.exp(-q * t);
  const strike = k * Math.exp(-r * t);
  return kind === "call" ? stock * cdf(d1) - strike * cdf(d2) : strike * cdf(-d2) - stock * cdf(-d1);
}

/** The sensitivities, or null with no usable volatility: a blank is honest, a made-up delta is not. */
export function greeks(s: number, k: number, minutes: number, sigma: number | null | undefined, kind: OptionKind, r = 0, q = 0): Greeks | null {
  check(s, k);
  if (!usable(sigma)) return null;
  const t = years(minutes);
  const [d1, d2] = d1d2(s, k, t, sigma, r, q);
  const root = Math.sqrt(t);
  const stock = s * Math.exp(-q * t);
  const strike = k * Math.exp(-r * t);
  const decay = (-stock * pdf(d1) * sigma) / (2 * root);
  const call = kind === "call";
  const delta = call ? Math.exp(-q * t) * cdf(d1) : -Math.exp(-q * t) * cdf(-d1);
  const theta = call ? decay - r * strike * cdf(d2) + q * stock * cdf(d1) : decay + r * strike * cdf(-d2) - q * stock * cdf(-d1);
  return {
    delta,
    gamma: (Math.exp(-q * t) * pdf(d1)) / (s * sigma * root),
    thetaDay: theta / 365,
    vegaPt: (stock * pdf(d1) * root) / 100,
  };
}

/**
 * The volatility at which `price` gives `value`, or null when no volatility in the searched range does: a price at
 * or under the no-volatility floor (a stale or crossed quote), one above what even 1000% a year would give, or one
 * so close to either that rounding would decide the answer.
 */
export function impliedVol(value: number, s: number, k: number, minutes: number, kind: OptionKind, r = 0, q = 0): number | null {
  check(s, k);
  if (!(Number.isFinite(value) && value > 0)) return null;
  let lo = VOL_LO;
  let hi = VOL_HI;
  const edge = VOL_EDGE * s;
  if (value - price(s, k, minutes, lo, kind, r, q) <= edge || price(s, k, minutes, hi, kind, r, q) - value <= edge) return null;
  for (let i = 0; i < BISECTIONS; i++) {
    const mid = 0.5 * (lo + hi);
    if (price(s, k, minutes, mid, kind, r, q) < value) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
