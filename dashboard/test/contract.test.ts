import { describe, expect, it } from "vitest";
import { price } from "@/lib/bs";
import type { ChainContract, ChainResponse } from "@/lib/chain";
import {
  contractView,
  daysToExpiry,
  defaultPick,
  minutesToExpiry,
  parsePick,
  pickKey,
  readQuote,
  scenarioLevels,
  STALE_LATER_MIN,
  STALE_SAME_DAY_MIN,
  volFor,
  type Pick,
} from "@/lib/contract";
import type { Options } from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

const e = optionsJson as unknown as Options;
const spy = e.tickers.find((t) => t.symbol === "SPY")!;
const SESSION = e.session; // 2026-10-12, a Monday in daylight time: its close is 20:00 UTC
const at = (iso: string) => Date.parse(iso);
const NOON = at("2026-10-12T16:00:00Z"); // 12:00 in New York, four hours before the bell

const row = (over: Partial<ChainContract> = {}): ChainContract => ({
  kind: "call", strike: 780, bid: 2.95, ask: 3.1, last: 3.0, at: "2026-10-12T15:45:00Z", iv: 0.12, delta: 0.5, volume: 100, ...over,
});
const chainOf = (contracts: ChainContract[], date = SESSION): ChainResponse => ({
  as_of: "2026-10-12T16:00:00Z", feed: "indicative", delay_min: 15, symbol: "SPY", expiries: [{ date, contracts }],
});
const pick = (over: Partial<Pick> = {}): Pick => ({ kind: "call", expiry: SESSION, strike: 780, contracts: 1, paid: null, ...over });

describe("a remembered contract", () => {
  it("is read back when it is one", () => {
    const p = pick({ contracts: 3, paid: 2.5 });
    expect(parsePick(JSON.stringify(p))).toEqual(p);
    expect(pickKey("SPY")).toBe("tl-options-contract:SPY");
  });

  it.each([
    null,
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...pick(), kind: "straddle" }),
    JSON.stringify({ ...pick(), expiry: "12 Oct" }),
    JSON.stringify({ ...pick(), strike: 0 }),
    JSON.stringify({ ...pick(), strike: "780" }),
    JSON.stringify({ ...pick(), contracts: 0 }),
    JSON.stringify({ ...pick(), contracts: 1.5 }),
    JSON.stringify({ ...pick(), contracts: 5000 }),
    JSON.stringify({ ...pick(), paid: -1 }),
    JSON.stringify({ ...pick(), paid: "3" }),
  ])("is refused when storage holds %s", (raw) => {
    expect(parsePick(raw)).toBeNull();
  });
});

describe("time to expiry", () => {
  it("runs to the New York close of the expiration date, under daylight and standard time", () => {
    expect(minutesToExpiry("2026-10-12", NOON)).toBe(240);
    expect(minutesToExpiry("2026-10-12", at("2026-10-12T20:00:00Z"))).toBe(0);
    expect(minutesToExpiry("2026-10-12", at("2026-10-12T21:00:00Z"))).toBe(-60);
    // After the clocks go back on 1 Nov 2026 the bell is at 21:00 UTC.
    expect(minutesToExpiry("2026-11-02", at("2026-11-02T20:00:00Z"))).toBe(60);
    expect(minutesToExpiry("not a date", NOON)).toBeNull();
  });

  it("counts days from New York's today, not UTC's", () => {
    expect(daysToExpiry("2026-10-12", NOON)).toBe(0);
    expect(daysToExpiry("2026-10-16", NOON)).toBe(4);
    // 01:00 UTC on the 13th is still the evening of the 12th in New York.
    expect(daysToExpiry("2026-10-13", at("2026-10-13T01:00:00Z"))).toBe(1);
  });
});

describe("reading a quote", () => {
  it("takes the middle of a bid and an ask, and the gap as a share of it", () => {
    expect(readQuote(row({ bid: 2, ask: 3 }))).toEqual({ state: "ok", mid: 2.5, spreadPct: 40 });
  });

  it("says no bid when nobody is bidding, and halves the ask", () => {
    expect(readQuote(row({ bid: 0, ask: 0.1 }))).toEqual({ state: "no-bid", mid: 0.05, spreadPct: 200 });
    expect(readQuote(row({ bid: null, ask: 0.1 })).state).toBe("no-bid");
  });

  it("takes no middle from a crossed quote or from no market", () => {
    expect(readQuote(row({ bid: 3.6, ask: 3.1 }))).toEqual({ state: "crossed", mid: null, spreadPct: null });
    expect(readQuote(row({ bid: 0, ask: 0 })).state).toBe("no-market");
    expect(readQuote(row({ bid: null, ask: null })).state).toBe("no-market");
  });
});

describe("the volatility a contract is priced with", () => {
  it("is the quote's own when it has one", () => {
    expect(volFor(row({ iv: 0.2 }), 3, 780, 240, 0.12)).toEqual({ sigma: 0.2, from: "quote" });
  });

  it("is worked out from the mid when the quote has none", () => {
    const mid = price(780, 780, 240, 0.15, "call");
    const got = volFor(row({ iv: null }), mid, 780, 240, 0.12);
    expect(got.from).toBe("mid");
    expect(got.sigma).toBeCloseTo(0.15, 6);
  });

  it("falls back to the name's own when the mid explains nothing, and to none when the name has none", () => {
    // A mid under what the option is worth exercised implies no volatility.
    expect(volFor(row({ iv: null, strike: 700 }), 10, 780, 240, 0.12)).toEqual({ sigma: 0.12, from: "name" });
    expect(volFor(row({ iv: null }), null, 780, 240, 0.12)).toEqual({ sigma: 0.12, from: "name" });
    expect(volFor(null, null, 780, 240, null)).toEqual({ sigma: null, from: null });
    expect(volFor(null, null, 780, 240, 0)).toEqual({ sigma: null, from: null });
  });
});

describe("the prices worth asking about", () => {
  it("are the nearest zones, a day's move either side of the close, and now, highest first", () => {
    const levels = scenarioLevels(spy, 780.43);
    expect(levels.map((l) => l.label)).toEqual(["+1 day move", "Now", "Resistance", "Support", "−1 day move"]);
    const prices = levels.map((l) => l.price);
    expect([...prices].sort((a, b) => b - a)).toEqual(prices);
    expect(levels.find((l) => l.label === "+1 day move")!.price).toBeCloseTo(spy.last!.close + spy.expected_move!.day!, 9);
  });

  it("keep one row where two land on the same cent, and it is Now", () => {
    const close = spy.last!.close;
    const levels = scenarioLevels({ ...spy, zones: [], levels: [], expected_move: { ...spy.expected_move!, day: 2 } }, close + 2);
    expect(levels.map((l) => l.label)).toEqual(["Now", "−1 day move"]);
  });

  it("are just now for a name with no zones and no expected move", () => {
    expect(scenarioLevels({ ...spy, zones: [], levels: [], expected_move: null }, 500)).toEqual([{ label: "Now", price: 500 }]);
  });
});

describe("what the pane shows for a contract", () => {
  it("prices it at the ask, with its breakeven, its value now and what waiting costs", () => {
    const v = contractView(pick(), chainOf([row()]), spy, 780.43, NOON, SESSION, true);
    expect(v.expired).toBe(false);
    expect(v.stale).toBe(false);
    expect(v.minutes).toBe(240);
    expect(v.days).toBe(0);
    expect(v.ageMin).toBe(15);
    expect([v.sigma, v.volFrom]).toEqual([0.12, "quote"]);
    expect([v.paid, v.paidFrom]).toEqual([3.1, "ask"]);
    expect(v.cost).toBeCloseTo(310, 9);
    expect(v.breakeven).toBeCloseTo(783.1, 9);
    expect(v.breakevenMoves).toBeCloseTo((783.1 - 780.43) / spy.expected_move!.day!, 9);
    expect(v.value).toBeCloseTo(price(780.43, 780, 240, 0.12, "call"), 12);
    expect(v.pnlNow).toBeCloseTo((v.value! - 3.1) * 100, 9);
    expect(v.delta).toBeGreaterThan(0.4);
    expect(v.delta).toBeLessThan(0.7);
    expect(v.decayHour).toBeGreaterThan(0);
  });

  it("asks what if at each level, now and at expiry; at expiry the option is worth what it would be exercised for", () => {
    const v = contractView(pick(), chainOf([row()]), spy, 780.43, NOON, SESSION, true);
    // The session's close is the expiry itself here, so it is not a column of its own.
    expect(v.times.map((t) => t.label)).toEqual(["Now", "Expiry"]);
    expect(v.rows.map((r) => r.level.label)).toEqual(["+1 day move", "Now", "Resistance", "Support", "−1 day move"]);
    for (const r of v.rows) {
      expect(r.cells).toHaveLength(2);
      expect(r.cells[1]!.value).toBeCloseTo(Math.max(r.level.price - 780, 0), 2);
      expect(r.cells[1]!.pnl).toBeCloseTo((r.cells[1]!.value - 3.1) * 100, 9);
    }
    const now = v.rows.find((r) => r.level.label === "Now")!;
    expect(now.cells[0]!.value).toBeCloseTo(v.value!, 12);
  });

  it("adds the session's close as a column when the contract outlives it", () => {
    const v = contractView(pick({ expiry: "2026-10-16" }), chainOf([row()], "2026-10-16"), spy, 780.43, NOON, SESSION, true);
    expect(v.times.map((t) => t.label)).toEqual(["Now", "Mon 12 Oct close", "Expiry"]);
    expect(v.times[1]!.ahead).toBe(240);
    // And once that close has passed, it is gone again.
    const later = contractView(pick({ expiry: "2026-10-16" }), chainOf([row()], "2026-10-16"), spy, 780.43, at("2026-10-12T21:00:00Z"), SESSION, false);
    expect(later.times.map((t) => t.label)).toEqual(["Now", "Expiry"]);
  });

  it("uses what the reader paid, for more than one contract, and for a put", () => {
    const put = row({ kind: "put", strike: 775, bid: 1.0, ask: 1.1, iv: 0.13 });
    const v = contractView(pick({ kind: "put", strike: 775, contracts: 3, paid: 2 }), chainOf([row(), put]), spy, 780.43, NOON, SESSION, true);
    expect([v.paid, v.paidFrom]).toEqual([2, "entered"]);
    expect(v.cost).toBe(600);
    expect(v.breakeven).toBe(773);
    // A put needs the stock to fall: breakeven is below the price, so the distance is positive.
    expect(v.breakevenMoves).toBeGreaterThan(0);
    expect(v.delta).toBeLessThan(0);
    expect(v.pnlNow).toBeCloseTo((v.value! - 2) * 300, 9);
  });

  it("prices from the model's own value when the quote is crossed or there is no market", () => {
    const crossed = contractView(pick(), chainOf([row({ bid: 3.6, ask: 3.1 })]), spy, 780.43, NOON, SESSION, true);
    expect(crossed.quote!.state).toBe("crossed");
    expect(crossed.paidFrom).toBe("model");
    const none = contractView(pick(), chainOf([row({ bid: 0, ask: 0, last: null })]), spy, 780.43, NOON, SESSION, true);
    expect(none.quote!.state).toBe("no-market");
    expect(none.paidFrom).toBe("model");
    expect(none.paid).toBeCloseTo(none.value!, 12);
  });

  it("shows only expiry when no volatility can be found", () => {
    const bare = { ...spy, expected_move: null };
    const v = contractView(pick(), chainOf([row({ iv: null, bid: 0, ask: 0 })]), bare, 780.43, NOON, SESSION, true);
    expect(v.sigma).toBeNull();
    expect(v.times.map((t) => t.label)).toEqual(["Expiry"]);
    expect(v.value).toBeNull();
    expect(v.delta).toBeNull();
    expect(v.paid).toBeNull();
    for (const r of v.rows) expect(r.cells[0]!.pnl).toBeNull();
  });

  it("prices a strike the chain does not carry from the name's own volatility", () => {
    const v = contractView(pick({ strike: 700 }), chainOf([row()]), spy, 780.43, NOON, SESSION, true);
    expect(v.contract).toBeNull();
    expect(v.quote).toBeNull();
    expect(v.volFrom).toBe("name");
    expect(v.paidFrom).toBe("model");
  });

  it("withholds everything for an expired contract", () => {
    const v = contractView(pick(), chainOf([row()]), spy, 780.43, at("2026-10-12T20:00:00Z"), SESSION, false);
    expect(v.expired).toBe(true);
    expect(v.rows).toEqual([]);
    expect(v.value).toBeNull();
  });

  it("withholds the numbers in session when the quote is too old, sooner for a same-day contract", () => {
    const old = (min: number) => new Date(NOON - min * 60_000).toISOString();
    const sameDay = (min: number, inSession = true) => contractView(pick(), chainOf([row({ at: old(min) })]), spy, 780.43, NOON, SESSION, inSession);
    expect(sameDay(STALE_SAME_DAY_MIN).stale).toBe(false);
    expect(sameDay(STALE_SAME_DAY_MIN + 1).stale).toBe(true);
    expect(sameDay(STALE_SAME_DAY_MIN + 1).rows).toEqual([]);
    // With the market shut an old quote is simply the last one there is.
    expect(sameDay(600, false).stale).toBe(false);
    const later = (min: number) => contractView(pick({ expiry: "2026-10-16" }), chainOf([row({ at: old(min) })], "2026-10-16"), spy, 780.43, NOON, SESSION, true);
    expect(later(STALE_SAME_DAY_MIN + 1).stale).toBe(false);
    expect(later(STALE_LATER_MIN + 1).stale).toBe(true);
  });

  it("never shows NaN or Infinity, whatever the chain row holds", () => {
    const rows = [row(), row({ iv: null }), row({ bid: null, ask: null, last: null, at: null, iv: null, delta: null, volume: null }), row({ bid: 0, ask: 0.01 })];
    for (const r of rows) {
      for (const spot of [780.43, 0.01, 100000]) {
        const v = contractView(pick(), chainOf([r]), spy, spot, NOON, SESSION, true);
        const numbers = [v.cost, v.breakeven, v.breakevenMoves, v.value, v.pnlNow, v.delta, v.thetaDay, v.decayHour, ...v.rows.flatMap((x) => x.cells.flatMap((c) => [c.value, c.pnl]))];
        for (const n of numbers) if (n !== null) expect(Number.isFinite(n)).toBe(true);
      }
    }
  });
});

describe("the contract a name opens on", () => {
  it("is one call, nearest expiry, the strike nearest the price", () => {
    const chain = chainOf([row({ strike: 775 }), row({ strike: 780 }), row({ strike: 785 }), row({ kind: "put", strike: 780 })]);
    expect(defaultPick(chain, 781)).toEqual({ kind: "call", expiry: SESSION, strike: 780, contracts: 1, paid: null });
    expect(defaultPick(chain, 783)!.strike).toBe(785);
  });

  it("is a put when the expiry has no calls, and nothing when the chain is empty", () => {
    expect(defaultPick(chainOf([row({ kind: "put", strike: 770 })]), 781)!.kind).toBe("put");
    expect(defaultPick(chainOf([]), 781)).toBeNull();
    expect(defaultPick({ ...chainOf([]), expiries: [] }, 781)).toBeNull();
  });
});
