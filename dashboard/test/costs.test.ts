import { describe, expect, it, vi } from "vitest";
import type { ChainContract, ChainResponse } from "@/lib/chain";
import { costLines, SWING_MIN_DAYS } from "@/lib/costs";

vi.mock("server-only", () => ({}));

// Monday 12 October 2026, 11:00 in New York.
const NOW = Date.parse("2026-10-12T15:00:00Z");
const c = (kind: "call" | "put", strike: number, bid: number | null, ask: number | null): ChainContract => ({ kind, strike, bid, ask, last: null, at: null, iv: null, delta: null, volume: null });
const chain = (expiries: ChainResponse["expiries"]): ChainResponse => ({ as_of: "2026-10-12T14:45:00Z", feed: "indicative", delay_min: 15, symbol: "SPY", expiries });
const strip = [c("call", 775, 6.1, 6.3), c("call", 780, 2.2, 2.4), c("call", 785, 0.5, 0.6), c("put", 775, 0.4, 0.5), c("put", 780, 1.9, 2.1), c("put", 785, 5.8, 6.0)];

describe("at-the-money costs", () => {
  it("calls the same expiry a swing as the chain route does", async () => {
    expect(SWING_MIN_DAYS).toBe((await import("@/lib/chain")).SWING_MIN_DAYS);
  });

  it("prices the strike nearest the close at the ask, for the nearest expiry and the swing one", () => {
    const lines = costLines(chain([{ date: "2026-10-12", contracts: strip }, { date: "2026-10-14", contracts: strip }, { date: "2026-10-30", contracts: strip }]), 780.4, 4, NOW);
    expect(lines.map((l) => [l.expiry, l.days])).toEqual([
      ["2026-10-12", 0],
      ["2026-10-30", 18],
    ]);
    const { call, put } = lines[0]!;
    expect(call).toMatchObject({ strike: 780, ask: 2.4, state: "ok" });
    // Breakeven 782.40 is 2.00 above the close: half an expected day's move of 4.
    expect(call!.moves).toBeCloseTo(0.5, 10);
    expect(call!.spreadPct).toBeCloseTo((0.2 / 2.3) * 100, 10);
    // The put breaks even at 777.90, 2.50 below the close.
    expect(put).toMatchObject({ strike: 780, ask: 2.1 });
    expect(put!.moves).toBeCloseTo(0.625, 10);
  });

  it("gives one line when the nearest expiry is itself a fortnight out, and none when nothing is still trading", () => {
    expect(costLines(chain([{ date: "2026-10-30", contracts: strip }]), 780, 4, NOW)).toHaveLength(1);
    // Friday's expiry has rung; an expiry with no contracts is passed over.
    expect(costLines(chain([{ date: "2026-10-09", contracts: strip }, { date: "2026-10-13", contracts: [] }]), 780, 4, NOW)).toEqual([]);
    expect(costLines(chain([{ date: "2026-10-13", contracts: strip }]), 0, 4, NOW)).toEqual([]);
  });

  it("ends a half day's own expiry at its early bell", () => {
    const today = chain([{ date: "2026-10-12", contracts: strip }, { date: "2026-10-13", contracts: strip }]);
    // 14:00 in New York: still trading on a full day, rung an hour ago when the bell is at 13:00.
    const at = Date.parse("2026-10-12T18:00:00Z");
    expect(costLines(today, 780, 4, at)[0]!.expiry).toBe("2026-10-12");
    expect(costLines(today, 780, 4, at, (x) => (x === "2026-10-12" ? 13 * 60 : 16 * 60))[0]!.expiry).toBe("2026-10-13");
  });

  it("leaves a dash where nobody is offering, and takes no spread from half a quote or a crossed one", () => {
    const odd = [c("call", 780, null, null), c("put", 780, 3, 2), c("call", 790, 0, 0.05)];
    const [l] = costLines(chain([{ date: "2026-10-13", contracts: odd }]), 780, 4, NOW);
    expect(l!.call).toMatchObject({ strike: 780, ask: null, moves: null, state: "no-market" });
    expect(l!.put).toMatchObject({ ask: null, state: "crossed" });
    const [far] = costLines(chain([{ date: "2026-10-13", contracts: [c("call", 790, 0, 0.05)] }]), 789, 4, NOW);
    expect(far!.call).toMatchObject({ ask: 0.05, spreadPct: null, state: "no-bid" });
    expect(far!.put).toBeNull();
  });

  it("counts no moves without an expected move, and picks the lower of two equally near strikes", () => {
    const [l] = costLines(chain([{ date: "2026-10-13", contracts: [c("call", 785, 1, 1.1), c("call", 775, 6, 6.2)] }]), 780, null, NOW);
    expect(l!.call).toMatchObject({ strike: 775, moves: null });
  });
});
