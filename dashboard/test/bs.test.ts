import { describe, expect, it } from "vitest";
import { erfc, floorValue, greeks, impliedVol, MINUTES_PER_YEAR, price, years, type OptionKind } from "@/lib/bs";
import { breakeven, breakevenMoves, decay, maxLoss, pnl, valueIf } from "@/lib/longopt";
import vectors from "./fixtures/bs.vectors.json";

// The vectors are worked out by the Python (scripts/gen_bs_vectors.py), which also keeps them current. Agreeing
// with them here means the page and the engine price an option the same way.
const kind = (k: string) => k as OptionKind;
/** Within a billionth of `scale`, or of the value itself where that is larger. */
function near(got: number | null, want: number | null, scale: number) {
  if (want === null) return expect(got).toBeNull();
  expect(got).not.toBeNull();
  expect(Math.abs(got! - want)).toBeLessThanOrEqual(1e-9 * Math.max(scale, Math.abs(want)));
}

describe("the vectors shared with the Python", () => {
  it("are the ones this suite was written for", () => {
    expect(vectors.schema).toBe("wt/bs-vectors");
    expect(vectors.version).toBe(1);
    expect(vectors.price.length).toBeGreaterThan(50);
    expect(vectors.implied.length).toBeGreaterThan(30);
    expect(vectors.long.length).toBeGreaterThan(20);
  });

  it("price every case the same, with and without a usable volatility", () => {
    for (const c of vectors.price) near(price(c.s, c.k, c.minutes, c.sigma, kind(c.kind), c.r, c.q), c.price, c.s);
  });

  it("give the same sensitivities, and none where there is no volatility", () => {
    for (const c of vectors.price) {
      const g = greeks(c.s, c.k, c.minutes, c.sigma, kind(c.kind), c.r, c.q);
      if (c.greeks === null) {
        expect(g).toBeNull();
        continue;
      }
      expect(g).not.toBeNull();
      near(g!.delta, c.greeks.delta, 1);
      near(g!.gamma, c.greeks.gamma, 1 / c.s);
      near(g!.thetaDay, c.greeks.theta_day, c.s);
      near(g!.vegaPt, c.greeks.vega_pt, c.s);
    }
  });

  it("find the same implied volatility, and none for a price no volatility explains", () => {
    for (const c of vectors.implied) {
      const iv = impliedVol(c.value, c.s, c.k, c.minutes, kind(c.kind), c.r, c.q);
      if (c.sigma === null) expect(iv).toBeNull();
      else {
        expect(iv).not.toBeNull();
        expect(Math.abs(iv! - c.sigma)).toBeLessThanOrEqual(1e-8);
      }
    }
  });

  it("work out the long-option numbers the same", () => {
    for (const c of vectors.long) {
      const k = kind(c.kind);
      near(breakeven(c.strike, c.premium, k), c.breakeven, c.strike);
      near(breakevenMoves(c.strike, c.premium, k, c.spot, c.expected_move), c.breakeven_moves, 1);
      near(maxLoss(c.premium, c.contracts), c.max_loss, 1);
      const value = valueIf(c.s_then, c.strike, c.minutes, c.sigma, k, c.ahead, c.r, c.q);
      near(value, c.value_if, c.spot);
      near(pnl(value, c.premium, c.contracts), c.pnl, c.spot * 100 * c.contracts);
      near(decay(c.spot, c.strike, c.minutes, c.sigma, k, 60, c.r, c.q), c.decay_hour, c.spot);
    }
  });
});

describe("the error function", () => {
  // Reference values from Python's math.erfc.
  it.each([
    [0, 1],
    [0.5, 0.4795001221869535],
    [1, 0.15729920705028516],
    [2.5, 0.000406952017444959],
    [3, 2.2090496998585438e-5],
    [5, 1.537459794428035e-12],
    [10, 2.0884875837625446e-45],
    [26, 5.663192408856143e-296],
    [-1, 1.8427007929497148],
    [-3, 1.9999779095030015],
  ])("erfc(%f) keeps its digits, tails included", (x, want) => {
    expect(Math.abs(erfc(x) - want) / want).toBeLessThan(1e-11);
  });

  it("is 0 far out, 2 far the other way, and not a number for not a number", () => {
    expect(erfc(40)).toBe(0);
    expect(erfc(-40)).toBe(2);
    expect(erfc(Infinity)).toBe(0);
    expect(erfc(NaN)).toBeNaN();
  });
});

describe("option value at the edges", () => {
  it("floors time to expiry at one minute, so nothing divides by zero at the bell", () => {
    expect(years(0)).toBe(1 / MINUTES_PER_YEAR);
    expect(years(-30)).toBe(years(1));
    for (const k of ["call", "put"] as const) {
      const atBell = price(100, 100, 0, 0.2, k);
      expect(atBell).toBe(price(100, 100, 1, 0.2, k));
      expect(atBell).toBeGreaterThan(0);
      expect(atBell).toBeLessThan(0.05);
      const g = greeks(100, 100, 0, 0.2, k)!;
      for (const v of [g.delta, g.gamma, g.thetaDay, g.vegaPt]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it.each([null, undefined, 0, -0.2, NaN, Infinity])("falls back to the floor, with blank sensitivities, when volatility is %s", (sigma) => {
    expect(price(50, 45, 30240, sigma, "call")).toBe(5);
    expect(price(50, 45, 30240, sigma, "put")).toBe(0);
    expect(price(50, 55, 30240, sigma, "put")).toBe(5);
    expect(floorValue(50, 55, 30240, "call")).toBe(0);
    expect(greeks(50, 45, 30240, sigma, "call")).toBeNull();
  });

  it.each([
    [0, 100],
    [100, 0],
    [-5, 100],
    [NaN, 100],
    [100, Infinity],
  ])("refuses a stock price of %f against a strike of %f", (s, k) => {
    expect(() => price(s, k, 60, 0.2, "call")).toThrow(RangeError);
    expect(() => greeks(s, k, 60, 0.2, "put")).toThrow(RangeError);
    expect(() => floorValue(s, k, 60, "call")).toThrow(RangeError);
    expect(() => impliedVol(1, s, k, 60, "call")).toThrow(RangeError);
  });

  it("keeps put-call parity", () => {
    for (const c of vectors.price) {
      if (c.sigma === null) continue;
      const t = years(c.minutes);
      const gap = price(c.s, c.k, c.minutes, c.sigma, "call", c.r, c.q) - price(c.s, c.k, c.minutes, c.sigma, "put", c.r, c.q);
      expect(Math.abs(gap - (c.s * Math.exp(-c.q * t) - c.k * Math.exp(-c.r * t)))).toBeLessThan(1e-9 * c.s);
    }
  });
});

describe("implied volatility", () => {
  it.each([0, -1, NaN, Infinity])("is null for a price of %f", (value) => {
    expect(impliedVol(value, 100, 100, 2880, "call")).toBeNull();
  });

  it("is null for a quote under what the option is worth exercised, at that floor, and above the stock", () => {
    expect(impliedVol(4, 100, 90, 2880, "call")).toBeNull();
    expect(impliedVol(3.5, 100, 108, 2880, "put")).toBeNull();
    expect(impliedVol(10, 100, 90, 2880, "call")).toBeNull();
    expect(impliedVol(10 + 1e-8, 100, 90, 2880, "call")).toBeNull();
    expect(impliedVol(101, 100, 100, 2880, "call")).toBeNull();
    expect(impliedVol(120, 100, 110, 2880, "put")).toBeNull();
  });

  it("gives back the volatility that made a price", () => {
    const value = price(780.43, 785, 2880, 0.1192, "call");
    expect(impliedVol(value, 780.43, 785, 2880, "call")).toBeCloseTo(0.1192, 9);
  });
});

describe("one long option", () => {
  it("breaks even at the strike plus or minus what was paid", () => {
    expect(breakeven(780, 4.25, "call")).toBe(784.25);
    expect(breakeven(780, 4.25, "put")).toBe(775.75);
    expect(price(784.25, 780, 0, 0.12, "call")).toBeCloseTo(4.25, 3);
  });

  it("counts the distance to breakeven in the direction the option needs", () => {
    expect(breakevenMoves(780, 4, "call", 778, 6)).toBeCloseTo(1, 12);
    expect(breakevenMoves(780, 4, "put", 778, 6)).toBeCloseTo(1 / 3, 12);
    expect(breakevenMoves(780, 4, "call", 790, 6)).toBeCloseTo(-1, 12);
    expect(breakevenMoves(780, 4, "put", 770, 6)).toBeCloseTo(-1, 12);
    for (const move of [null, undefined, 0, -1, NaN]) expect(breakevenMoves(780, 4, "call", 778, move)).toBeNull();
  });

  it("can lose what was paid and no more", () => {
    expect(maxLoss(4.25)).toBe(425);
    expect(maxLoss(4.25, 3)).toBe(1275);
    expect(pnl(0, 4.25, 3)).toBe(-1275);
    expect(pnl(6.25, 4.25)).toBeCloseTo(200, 9);
  });

  it("loses value by waiting, and has nothing left to lose once expired", () => {
    for (const k of ["call", "put"] as const) {
      const hour = decay(780, 780, 390, 0.12, k);
      expect(hour).toBeGreaterThan(0);
      expect(hour).toBeLessThan(price(780, 780, 390, 0.12, k));
      expect(decay(780, 780, 30, 0.12, k, 60)).toBe(decay(780, 780, 30, 0.12, k, 30));
    }
    expect(decay(780, 780, 0, 0.12, "call")).toBe(0);
  });

  it("is worth, at another price later, what pricing it there and then gives", () => {
    expect(valueIf(785, 780, 390, 0.12, "call", 60)).toBe(price(785, 780, 330, 0.12, "call"));
    expect(valueIf(785, 780, 390, 0.12, "call", 10_000)).toBeCloseTo(5, 3);
    expect(valueIf(785, 780, 390, 0.12, "put", 10_000)).toBeCloseTo(0, 3);
  });
});
