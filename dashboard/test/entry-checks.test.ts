import { describe, expect, it } from "vitest";
import {
  brokenMarks,
  CHECK_HYP,
  type CheckInput,
  entryChecks,
  fiveSessionRange,
  IV_CAP_INDEX,
  IV_CAP_SINGLE,
  LEADERS,
  midThird,
  withLeaders,
} from "@/lib/entry-checks";
import type { LiveQuote } from "@/lib/options";

const S = "2026-10-12"; // a Monday, New York on EDT
const ny = (hhmm: string, day = S, offset = "-04:00") => new Date(`${day}T${hhmm}:00${offset}`);

const q = (over: Partial<LiveQuote> = {}): LiveQuote => ({
  price: 108,
  at: `${S}T14:30:00.000Z`,
  open: 108,
  high: 108.5,
  low: 107.5,
  day: S,
  prev_close: 108,
  vwap: 108,
  ...over,
});

// Yesterday: 100 to 110 (thirds at 103.33 and 106.67). The five sessions before it: 90 to 150 (thirds 110 and 130).
// The default quote, 108 with the open at 108, is in neither third and opened inside yesterday's range.
const daily = [
  { d: "2026-10-05", o: 100, h: 150, l: 99, c: 100 },
  { d: "2026-10-06", o: 100, h: 120, l: 90, c: 100 },
  { d: "2026-10-07", o: 100, h: 110, l: 100, c: 100 },
  { d: "2026-10-08", o: 100, h: 110, l: 100, c: 100 },
  { d: "2026-10-09", o: 100, h: 110, l: 100, c: 100 },
  { d: S, o: 1, h: 1000, l: 1, c: 1 }, // today's bar never counts
];
const ticker = (over: Partial<CheckInput["ticker"]> = {}): CheckInput["ticker"] => ({
  levels: [
    { name: "PDH", price: 110 },
    { name: "PDL", price: 100 },
    { name: "MA20", price: 107 },
  ],
  bars: daily,
  expected_move: { annual_iv: 0.2 },
  ...over,
});
const OPEN = Date.parse(`${S}T09:30:00-04:00`);
const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  symbol: "AAPL",
  ticker: ticker(),
  session: S,
  quote: q(),
  bars: [],
  since: OPEN - 60_000, // the page saw the whole session
  halfDay: false,
  now: ny("10:30"),
  wonToday: false,
  ...over,
});
const ids = (r: ReturnType<typeof entryChecks>) => r.cautions.map((c) => c.id);

describe("middle third (setups._mid_third)", () => {
  it("includes both ends and needs a real range", () => {
    const lo = 100 + (110 - 100) / 3;
    const hi = 110 - (110 - 100) / 3;
    expect(midThird(lo, 110, 100)).toBe(true);
    expect(midThird(hi, 110, 100)).toBe(true);
    expect(midThird(lo - 0.0001, 110, 100)).toBe(false);
    expect(midThird(hi + 0.0001, 110, 100)).toBe(false);
    expect(midThird(100, 100, 100)).toBe(false);
    expect(midThird(105, 100, 110)).toBe(false);
  });

  it("the five-session range is the five daily bars before the session, or none with fewer", () => {
    expect(fiveSessionRange(daily, S)).toEqual({ hi: 150, lo: 90 });
    expect(fiveSessionRange(daily.slice(1), S)).toBeNull();
    expect(fiveSessionRange(undefined, S)).toBeNull();
  });
});

describe("range caution (HYP-0034)", () => {
  it("shows in the middle third of yesterday's range with nothing broken, on both sides", () => {
    for (const side of ["call", "put"] as const) {
      const r = entryChecks(input({ quote: q({ price: 105 }) }), side);
      expect(ids(r)).toEqual(["range"]);
      expect(r.cautions[0]).toMatchObject({ word: "Middle of range", tone: "warn", hyp: "HYP-0034" });
      expect(r.cautions[0]!.side).toBeUndefined();
      expect(r.cautions[0]!.why).toContain("100.00 to 110.00");
    }
  });

  it("reads the five-day range when yesterday's third does not hold", () => {
    const r = entryChecks(input({ quote: q({ price: 112, open: 109, high: 112.5, low: 109 }) }), "call");
    expect(ids(r)).toEqual(["range"]);
    expect(r.cautions[0]!.why).toContain("five-day range (90.00 to 150.00)");
  });

  it("goes once a mark has broken today (a close across it from the open)", () => {
    const bars = [{ o: 108, h: 108, l: 106.5, c: 106.8 }]; // opened above MA20 107, closed below it
    expect(ids(entryChecks(input({ quote: q({ price: 105, open: 108, low: 105 }), bars }), "call"))).toEqual([]);
  });

  it("is left out, never clear, when the page missed the closes after a print crossed a mark", () => {
    const r = entryChecks(input({ quote: q({ price: 105, open: 108, low: 105 }), since: OPEN + 3_600_000 }), "call");
    expect(ids(r)).toEqual([]);
    expect(r.unknown.join(" ")).toMatch(/before the page opened/);
  });

  it("still shows when the page opened late but no print reached a mark", () => {
    const r = entryChecks(input({ quote: q({ price: 105.5, open: 105.6, high: 105.8, low: 105.2 }), since: OPEN + 3_600_000 }), "call");
    expect(ids(r)).toEqual(["range"]);
  });

  it("is unknown when a range is missing and the other's third does not hold", () => {
    const r = entryChecks(input({ ticker: ticker({ bars: [] }), quote: q({ price: 108, open: 108, low: 108, high: 108 }) }), "call");
    expect(ids(r)).toEqual([]);
    expect(r.unknown.join(" ")).toMatch(/range is missing/);
    // ...but one third holding is enough, as in the clone
    expect(ids(entryChecks(input({ ticker: ticker({ bars: [] }), quote: q({ price: 105, open: 105, low: 105, high: 105 }) }), "call"))).toEqual(["range"]);
  });
});

describe("gap caution (HYP-0036)", () => {
  const up = (low: number) => q({ price: 131, open: 111, high: 131.5, low });
  const down = (high: number) => q({ price: 98, open: 99, high, low: 97.5 });
  it("a call on a gap up while no low has reached PDH; a low of exactly PDH closes it", () => {
    const r = entryChecks(input({ quote: up(110.01) }), "call");
    expect(ids(r)).toEqual(["gap"]);
    expect(r.cautions[0]).toMatchObject({ side: "call", word: "Gap not filled", hyp: "HYP-0036" });
    expect(ids(entryChecks(input({ quote: up(110) }), "call"))).toEqual([]);
    expect(ids(entryChecks(input({ quote: up(110.01) }), "put"))).toEqual([]);
  });

  it("a put on a gap down while no high has reached PDL; a high of exactly PDL closes it", () => {
    expect(ids(entryChecks(input({ quote: down(99.99) }), "put"))).toEqual(["gap"]);
    expect(ids(entryChecks(input({ quote: down(100) }), "put"))).toEqual([]);
    expect(ids(entryChecks(input({ quote: down(99.99) }), "call"))).toEqual([]);
  });

  it("is unknown without the open or the day low", () => {
    expect(entryChecks(input({ quote: q({ price: 112, open: null }) }), "call").unknown.join(" ")).toMatch(/gap check is off/);
    expect(entryChecks(input({ quote: q({ price: 112, open: 111, low: null }) }), "call").unknown.join(" ")).toMatch(/gap check is off/);
  });
});

describe("leader caution (HYP-0038)", () => {
  const smh = (price: number, vwap: number | null) => q({ price, vwap });
  const qqq = (leaderQuote: LiveQuote | null) => input({ symbol: "QQQ", leaderQuote, quote: q() });
  it("QQQ against SMH's VWAP; equal is not against", () => {
    expect(LEADERS).toEqual({ QQQ: "SMH" });
    const below = entryChecks(qqq(smh(299.9, 300)), "call");
    expect(ids(below)).toEqual(["leader"]);
    expect(below.cautions[0]).toMatchObject({ word: "Semis against", side: "call", hyp: "HYP-0038" });
    expect(ids(entryChecks(qqq(smh(299.9, 300)), "put"))).toEqual([]);
    expect(ids(entryChecks(qqq(smh(300.1, 300)), "put"))).toEqual(["leader"]);
    expect(ids(entryChecks(qqq(smh(300, 300)), "call"))).toEqual([]);
    expect(ids(entryChecks(qqq(smh(300, 300)), "put"))).toEqual([]);
  });

  it("is unknown without the leader or its VWAP, and absent for names without a leader", () => {
    expect(entryChecks(qqq(null), "call").unknown.join(" ")).toMatch(/SMH/);
    expect(entryChecks(qqq(smh(300, null)), "call").unknown.join(" ")).toMatch(/SMH/);
    expect(entryChecks(qqq(q({ day: "2026-10-09" })), "call").unknown.join(" ")).toMatch(/SMH/);
    const other = entryChecks(input({ quote: q() }), "call");
    expect(other.unknown.join(" ")).not.toMatch(/SMH/);
  });
});

describe("IV caution (HYP-0040)", () => {
  const at = (symbol: string, iv: number | null) =>
    entryChecks(input({ symbol, ticker: ticker({ expected_move: { annual_iv: iv } }), quote: q() }), "call");
  it("rich above the cap, not at it: 0.35 for the index names, 0.70 for the rest", () => {
    expect(ids(at("SPY", IV_CAP_INDEX))).toEqual([]);
    expect(ids(at("SPY", 0.3501))).toEqual(["iv"]);
    expect(ids(at("QQQ", 0.36))).toContain("iv");
    expect(ids(at("AAPL", 0.36))).toEqual([]);
    expect(ids(at("AAPL", IV_CAP_SINGLE))).toEqual([]);
    expect(ids(at("AAPL", 0.71))).toEqual(["iv"]);
    expect(at("AAPL", 0.71).cautions[0]).toMatchObject({ word: "IV high", hyp: "HYP-0040" });
  });

  it("is unknown without an IV", () => {
    expect(ids(at("AAPL", null))).toEqual([]);
    expect(at("AAPL", null).unknown.join(" ")).toMatch(/IV check is off/);
  });
});

describe("late caution (HYP-0042)", () => {
  const at = (now: Date, halfDay = false, session = S) =>
    ids(entryChecks(input({ now, halfDay, session, quote: q({ day: session }) }), "call"));
  it("late is [11:00, 14:30] New York; early and the rest are not", () => {
    expect(at(ny("10:59"))).toEqual([]);
    expect(at(ny("11:00"))).toEqual(["late"]);
    expect(at(ny("14:30"))).toEqual(["late"]);
    expect(at(new Date(ny("14:30").getTime() + 59_000))).toEqual(["late"]); // still the 14:30 minute
    expect(at(ny("14:31"))).toEqual([]);
    expect(at(ny("12:00"), true)).toEqual([]); // never on a half day
  });

  it("follows New York across the daylight-saving changes", () => {
    // 2026-03-09: the first Monday on EDT (UTC-4). 2026-11-02: the first Monday on EST (UTC-5).
    expect(at(new Date("2026-03-09T14:59:00Z"), false, "2026-03-09")).toEqual([]);
    expect(at(new Date("2026-03-09T15:00:00Z"), false, "2026-03-09")).toEqual(["late"]);
    expect(at(new Date("2026-11-02T15:59:00Z"), false, "2026-11-02")).toEqual([]);
    expect(at(new Date("2026-11-02T16:00:00Z"), false, "2026-11-02")).toEqual(["late"]);
  });
});

describe("winner caution and the whole list", () => {
  it("a winner today is an info caution; unknown when the journal cannot say", () => {
    const r = entryChecks(input({ wonToday: true, quote: q() }), "call");
    expect(r.cautions).toEqual([expect.objectContaining({ id: "winner", tone: "info", word: "Winner already today", hyp: null })]);
    expect(entryChecks(input({ wonToday: null }), "call").unknown.join(" ")).toMatch(/winner check is off/);
  });

  it("orders them range, gap, leader, iv, late, winner, with words of at most three words", () => {
    const r = entryChecks(
      input({
        symbol: "QQQ",
        ticker: ticker({ expected_move: { annual_iv: 0.5 }, levels: [{ name: "PDH", price: 104 }, { name: "PDL", price: 96 }] }),
        // opened above PDH 104, never back to it; 112 sits in the five-day third (110 to 130)
        quote: q({ price: 112, open: 105, high: 112.5, low: 104.5 }),
        leaderQuote: q({ price: 299, vwap: 300 }),
        now: ny("11:30"),
        wonToday: true,
      }),
      "call",
    );
    expect(ids(r)).toEqual(["range", "gap", "leader", "iv", "late", "winner"]);
    for (const c of r.cautions) expect(c.word.split(/\s+/).length).toBeLessThanOrEqual(3);
    expect(r.cautions.map((c) => c.hyp)).toEqual(["HYP-0034", "HYP-0036", "HYP-0038", "HYP-0040", "HYP-0042", null]);
    expect(CHECK_HYP.late).toBe("HYP-0042");
  });

  it("a quote from another day is no live price: the price checks are off, never clear", () => {
    const r = entryChecks(input({ quote: q({ day: "2026-10-09", price: 105 }) }), "call");
    expect(ids(r)).toEqual([]);
    expect(r.unknown[0]).toMatch(/No live price/);
  });
});

describe("broken marks", () => {
  it("counts a close across a mark from the open, and only a close", () => {
    const t = { levels: [{ name: "PDH", price: 110 }, { name: "PWH", price: 112 }, { name: "ZZZ", price: 109 }] };
    const quote = { open: 109.5, high: 111, low: 109 };
    expect(brokenMarks(t, quote, [{ o: 109.5, h: 111, l: 109.4, c: 110.2 }], true)).toEqual(["PDH"]);
    expect(brokenMarks(t, quote, [{ o: 109.5, h: 111, l: 109.4, c: 109.9 }], true)).toEqual([]); // a wick only
    expect(brokenMarks(t, quote, [], false)).toBeNull(); // a print crossed PDH, the closes unseen
    expect(brokenMarks(t, { open: null, high: 1, low: 1 }, [], true)).toBeNull();
  });
});

describe("leaders on the quote feed", () => {
  it("adds a present name's leader once, keeping the order", () => {
    expect(withLeaders(["SPY", "QQQ", "AAPL"])).toEqual(["SPY", "QQQ", "AAPL", "SMH"]);
    expect(withLeaders(["QQQ", "SMH", "QQQ"])).toEqual(["QQQ", "SMH"]);
    expect(withLeaders(["SPY"])).toEqual(["SPY"]);
    expect(withLeaders([])).toEqual([]);
  });
});
