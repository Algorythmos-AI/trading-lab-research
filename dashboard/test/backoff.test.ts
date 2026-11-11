import { describe, expect, it } from "vitest";
import { BACKOFF_FIRST_MS, BACKOFF_JITTER, capDelay, retryDelay } from "@/lib/backoff";

const none = () => 0;
const most = () => 0.999999;

describe("retryDelay", () => {
  it("doubles from 2 s with each failure in a row and stops at the cap", () => {
    const o = { capMs: 30_000, rand: none };
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => retryDelay(n, o))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    expect(BACKOFF_FIRST_MS).toBe(2_000);
  });

  it("three failures wait 14 s in all, inside the board's 20 s before it pauses", () => {
    const o = { capMs: 30_000, rand: none };
    expect(retryDelay(1, o) + retryDelay(2, o) + retryDelay(3, o)).toBe(14_000);
  });

  it("reaches the cap exactly at a power of two, and a cap between steps is never passed", () => {
    expect(retryDelay(4, { capMs: 16_000, rand: none })).toBe(16_000);
    expect(retryDelay(5, { capMs: 16_000, rand: none })).toBe(16_000);
    expect(retryDelay(4, { capMs: 15_999, rand: none })).toBe(15_999);
    expect(retryDelay(3, { capMs: 15_999, rand: none })).toBe(8_000);
  });

  it("takes its own first wait, and a cap below it wins", () => {
    expect(retryDelay(1, { firstMs: 500, capMs: 10_000, rand: none })).toBe(500);
    expect(retryDelay(3, { firstMs: 500, capMs: 10_000, rand: none })).toBe(2_000);
    expect(retryDelay(1, { firstMs: 5_000, capMs: 1_000, rand: none })).toBe(1_000);
  });

  it("is 0 with no failure yet (the poll's normal interval applies), and for nonsense counts", () => {
    for (const n of [0, -1, Number.NaN]) expect(retryDelay(n, { capMs: 30_000, rand: none })).toBe(0);
  });

  it("never overflows: a huge count is the cap", () => {
    expect(retryDelay(10_000, { capMs: 30_000, rand: none })).toBe(30_000);
    expect(retryDelay(Number.POSITIVE_INFINITY, { capMs: 30_000, rand: none })).toBe(30_000);
  });

  it("jitter only shortens a wait, by at most its share (a tenth by default)", () => {
    expect(BACKOFF_JITTER).toBe(0.1);
    for (const n of [1, 2, 3, 4, 5, 9]) {
      const base = retryDelay(n, { capMs: 30_000, rand: none });
      const low = retryDelay(n, { capMs: 30_000, rand: most });
      expect(low).toBeLessThanOrEqual(base);
      expect(low).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
      expect(retryDelay(n, { capMs: 30_000, rand: () => 0.5 })).toBe(Math.round(base * 0.95));
    }
    // Math.random by default: always inside the bounds
    for (let i = 0; i < 200; i++) {
      const w = retryDelay(3, { capMs: 30_000 });
      expect(w).toBeGreaterThanOrEqual(7_200);
      expect(w).toBeLessThanOrEqual(8_000);
    }
  });

  it("keeps jitter and the random number inside 0 to 1, whatever is passed", () => {
    expect(retryDelay(1, { capMs: 30_000, jitter: 0, rand: most })).toBe(2_000);
    expect(retryDelay(1, { capMs: 30_000, jitter: 5, rand: () => 0.5 })).toBe(1_000);
    expect(retryDelay(1, { capMs: 30_000, jitter: -1, rand: most })).toBe(2_000);
    expect(retryDelay(1, { capMs: 30_000, rand: () => 7 })).toBe(1_800);
    expect(retryDelay(1, { capMs: 30_000, rand: () => -7 })).toBe(2_000);
  });
});

describe("capDelay", () => {
  it("is the cap at once, for a rate limit, with the same jitter", () => {
    expect(capDelay({ capMs: 30_000, rand: none })).toBe(30_000);
    expect(capDelay({ capMs: 30_000, rand: most })).toBeGreaterThanOrEqual(27_000);
    expect(capDelay({ capMs: 30_000, rand: most })).toBeLessThan(30_000);
  });
});
