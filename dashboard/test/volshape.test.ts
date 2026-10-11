import { describe, expect, it } from "vitest";
import type { ChainContract, ChainExpiry } from "@/lib/chain";
import { volShape } from "@/lib/volshape";

const c = (kind: "call" | "put", strike: number, iv: number | null): ChainContract => ({ kind, strike, bid: 1, ask: 1.1, last: null, at: null, iv, delta: null, volume: null });
const expiry = (contracts: ChainContract[]): ChainExpiry => ({ date: "2026-10-16", contracts });

describe("volatility by strike", () => {
  it("lays the strikes out in order with each side's volatility, and reads the one nearest the price", () => {
    const s = volShape(expiry([c("put", 785, 0.11), c("call", 775, 0.14), c("put", 775, 0.15), c("call", 780, 0.12), c("put", 780, 0.13), c("call", 785, 0.1)]), 780.4)!;
    expect(s.points).toEqual([
      { strike: 775, call: 0.14, put: 0.15 },
      { strike: 780, call: 0.12, put: 0.13 },
      { strike: 785, call: 0.1, put: 0.11 },
    ]);
    expect([s.lo, s.hi]).toEqual([0.1, 0.15]);
    expect(s.atm.strike).toBe(780);
    expect(s.atm.iv).toBeCloseTo(0.125, 12);
  });

  it("keeps a strike with one side only, and drops a volatility that is missing, zero, negative or absurd", () => {
    const s = volShape(expiry([c("call", 770, null), c("call", 775, 0.14), c("call", 780, 0), c("put", 780, 0.13), c("call", 785, -0.2), c("put", 785, 9), c("call", 790, 0.1)]), 780)!;
    expect(s.points).toEqual([
      { strike: 775, call: 0.14, put: null },
      { strike: 780, call: null, put: 0.13 },
      { strike: 790, call: 0.1, put: null },
    ]);
    expect(s.atm).toEqual({ strike: 780, iv: 0.13 });
  });

  it("is nothing with fewer than three strikes, or without a price", () => {
    expect(volShape(expiry([c("call", 775, 0.14), c("call", 780, 0.12)]), 780)).toBeNull();
    expect(volShape(expiry([]), 780)).toBeNull();
    expect(volShape(expiry([c("call", 775, 0.14), c("call", 780, 0.12), c("call", 785, 0.1)]), 0)).toBeNull();
  });
});
