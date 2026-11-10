import { describe, expect, it } from "vitest";
import { parseFilter, type Trade } from "@/lib/journal";
import { tradesView } from "@/lib/trades-view";

// A buy of 2 on 31 Dec 2025: half sold that day for +$50, the rest on 2 Jan 2026 for −$20.
const piece = (id: string, closed: string, exit: number, pnl: number): Trade => ({ id, symbol: "SPY", kind: "call", strike: 600, expiry: "2026-01-09", side: "long", qty: 1, opened_at: "2025-12-31T15:00:00.000Z", closed_at: closed, entry: 1, exit, multiplier: 100, pnl, close: "order" });
const doc = { trades: [piece("a", "2025-12-31T15:30:00.000Z", 1.5, 50), piece("b", "2026-01-02T15:30:00.000Z", 0.8, -20)], open: [], gaps: [], fees_included: false };
const now = new Date("2026-01-10T20:00:00Z");
const round = (v: number) => Math.round(v * 100) / 100;

describe("the Trades page's period filter", () => {
  it("books money to the day each piece was sold, and counts a trade on the day it finished", () => {
    const y25 = tradesView(doc, parseFilter({ p: "2025" }), now);
    expect(y25.empty).toBe(false);
    expect(round(y25.s.net)).toBe(48.89);
    expect(round(y25.gross.net)).toBe(50);
    expect(y25.s.trades).toBe(0); // the trade finished in 2026
    const y26 = tradesView(doc, parseFilter({ p: "2026" }), now);
    expect(round(y26.s.net)).toBe(-21.11);
    expect(round(y26.days.reduce((s, d) => s + d.pnl, 0))).toBe(round(y26.s.net));
    expect(y26.s.trades).toBe(1);
    expect(round(y26.positions[0]!.net)).toBe(27.78);
    expect(round(y26.fees.total)).toBe(1.11);
  });

  it("is empty only when nothing was sold and nothing finished in the view", () => {
    expect(tradesView(doc, parseFilter({ p: "2024" }), now).empty).toBe(true);
    expect(tradesView(doc, parseFilter({}), now).empty).toBe(false);
  });
});
