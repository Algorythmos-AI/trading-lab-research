// The snapshot probe (quote-probe.ts): one fact at a time, the normal case, each abnormal case, missing data, wrong
// types and the exact boundaries (25.000% from the prior close, a minute bar ending exactly at server time, a bid equal
// to the ask), the session's edges (pre-market, the first minute, a half day), and the reader's counts.
import { describe, expect, it } from "vitest";
import { normalise } from "@/lib/quote";
import {
  AGE_BUCKETS,
  bucketOf,
  BPS_BUCKETS,
  MAX_CODES,
  phaseAt,
  previousSession,
  rateHeader,
  tradeClass,
  MAX_PROBED,
  type NameFacts,
  type NameProbe,
  PROBE_V,
  priorMove,
  probeSnapshot,
  probeSnapshots,
  safeCode,
  summariseProbe,
} from "@/lib/quote-probe";

// 2026-10-12 is a Monday in EDT (UTC-4).
const at = (nyTime: string, day = "2026-10-12", off = "-04:00") => Date.parse(`${day}T${nyTime}${off}`);
const iso = (t: number) => new Date(t).toISOString();
const NOW = at("10:30:30");

function snap(over: Record<string, unknown> = {}) {
  return {
    latestTrade: { t: iso(NOW - 1_000), x: "V", p: 100, s: 10, c: ["@"], i: 1, z: "B" },
    latestQuote: { t: iso(NOW - 2_000), ax: "V", ap: 100.02, as: 1, bx: "V", bp: 99.98, bs: 1, c: ["R"], z: "B" },
    minuteBar: { t: iso(at("10:30:00")), o: 100, h: 100.1, l: 99.9, c: 100, v: 5, n: 2, vw: 100 },
    dailyBar: { t: "2026-10-12T04:00:00Z", o: 99, h: 101, l: 98, c: 100, v: 1000, n: 50, vw: 99.5 },
    prevDailyBar: { t: "2026-10-09T04:00:00Z", o: 97, h: 99, l: 96, c: 98, v: 900, n: 40, vw: 97.5 },
    ...over,
  };
}
const facts = (raw: unknown, now = NOW): NameFacts => {
  const p = probeSnapshot("SPY", raw, now);
  if (p.source !== "fetched") throw new Error(`expected fetched, got ${p.source}`);
  return p;
};
const withTrade = (p: unknown, t: number = NOW - 1_000) => snap({ latestTrade: { t: iso(t), x: "V", p, s: 1, c: [], i: 1, z: "B" } });
const withQuote = (q: unknown) => snap({ latestQuote: q });

const KEYS = [
  "symbol",
  "source",
  "trade",
  "trade_day",
  "trade_age_s",
  "trade_x",
  "trade_c",
  "trade_c_dropped",
  "trade_class",
  "minute",
  "minute_age_s",
  "trade_vs_minute_s",
  "daily",
  "daily_day",
  "daily_session",
  "prev_session",
  "high_below_low",
  "open_outside",
  "trade_vs_day",
  "trade_outside_bps",
  "prev",
  "prior_move",
  "prior_move_bps",
  "quote",
  "spread_bps",
  "quote_time",
  "quote_age_s",
];

describe("a normal snapshot", () => {
  it("reads every fact as normal, with ages in seconds and distances in basis points", () => {
    expect(facts(snap())).toEqual({
      symbol: "SPY",
      source: "fetched",
      trade: "ok",
      trade_day: "today",
      trade_age_s: 1,
      trade_x: "V",
      trade_c: ["@"],
      trade_c_dropped: 0,
      trade_class: "regular",
      minute: "forming",
      minute_age_s: 30,
      trade_vs_minute_s: null,
      daily: "ok",
      daily_day: "today",
      daily_session: "today",
      prev_session: "previous-session",
      high_below_low: false,
      open_outside: false,
      trade_vs_day: "inside",
      trade_outside_bps: null,
      prev: "ok",
      prior_move: "within",
      prior_move_bps: 204.1,
      quote: "normal",
      quote_time: "ok",
      spread_bps: 4,
      quote_age_s: 2,
    });
  });

  it("stores the documented keys only, and never a price, a size or an id", () => {
    const raw = snap({
      latestTrade: { t: iso(NOW - 1_000), x: "V", p: 123.4567, s: 777, c: ["@"], i: 99991, z: "B" },
      latestQuote: { t: iso(NOW), ax: "V", ap: 123.4601, as: 3, bx: "V", bp: 123.4533, bs: 4, c: ["R"], z: "B" },
      dailyBar: { t: "2026-10-12T04:00:00Z", o: 122.1111, h: 124.2222, l: 121.3333, c: 123.4567, v: 1, n: 1, vw: 122.9 },
      prevDailyBar: { t: "2026-10-09T04:00:00Z", o: 120, h: 121, l: 119, c: 120.5555, v: 1, n: 1, vw: 120.1 },
    });
    const f = facts(raw);
    expect(Object.keys(f)).toEqual(KEYS);
    const text = JSON.stringify(f);
    for (const n of ["123.4567", "123.4601", "123.4533", "122.1111", "124.2222", "121.3333", "120.5555", "777", "99991"]) expect(text).not.toContain(n);
  });
});

describe("the minute bar", () => {
  const minuteAt = (start: number, now: number) => facts(snap({ minuteBar: { t: iso(start), o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, vw: 1 } }), now);
  const start = at("10:30:00");

  it("is forming until its minute ends, and finished exactly at its end", () => {
    expect(minuteAt(start, start)).toMatchObject({ minute: "forming", minute_age_s: 0 });
    // ages are floored to one decimal: a forming bar never reads as 60 s old
    expect(minuteAt(start, start + 59_999)).toMatchObject({ minute: "forming", minute_age_s: 59.9 });
    expect(minuteAt(start, start + 60_000)).toMatchObject({ minute: "finished", minute_age_s: 60 });
    expect(minuteAt(start, start + 185_000)).toMatchObject({ minute: "finished", minute_age_s: 185 });
  });

  it("a bar stamped after server time reads as forming with a negative age, not as finished", () => {
    expect(minuteAt(start + 5_000, start)).toMatchObject({ minute: "forming", minute_age_s: -5 });
  });

  it("is absent when missing or null, and invalid when unreadable", () => {
    expect(facts(snap({ minuteBar: undefined })).minute).toBe("absent");
    expect(facts(snap({ minuteBar: null })).minute).toBe("absent");
    for (const bad of ["bar", 5, [], { t: "soon", o: 1, h: 1, l: 1, c: 1 }, { t: iso(start), o: "1", h: 1, l: 1, c: 1 }, { t: iso(start), o: 1, h: 0, l: 1, c: 1 }, { t: iso(start) }]) {
      expect(facts(snap({ minuteBar: bad })), JSON.stringify(bad)).toMatchObject({ minute: "invalid", minute_age_s: null });
    }
  });
});

describe("the last trade against the day's bar", () => {
  it("inside at the high and the low themselves; outside by basis points of the side it crossed", () => {
    expect(facts(withTrade(101))).toMatchObject({ trade_vs_day: "inside", trade_outside_bps: null });
    expect(facts(withTrade(98))).toMatchObject({ trade_vs_day: "inside", trade_outside_bps: null });
    expect(facts(withTrade(102))).toMatchObject({ trade_vs_day: "above-high", trade_outside_bps: 99 });
    expect(facts(withTrade(97))).toMatchObject({ trade_vs_day: "below-low", trade_outside_bps: 102 });
    expect(facts(withTrade(101.0101))).toMatchObject({ trade_vs_day: "above-high", trade_outside_bps: 1 });
  });

  it("no daily bar: absent or invalid, and the shape facts are unknown", () => {
    for (const [d, presence] of [
      [undefined, "absent"],
      [null, "absent"],
      ["x", "invalid"],
      [{ t: "2026-10-12T04:00:00Z", o: 1, h: "2", l: 1, c: 1 }, "invalid"],
      [{ t: "2026-10-12T04:00:00Z", o: 1, h: 2, l: -1, c: 1 }, "invalid"],
    ] as const) {
      expect(facts(snap({ dailyBar: d })), JSON.stringify(d)).toMatchObject({
        daily: presence,
        high_below_low: null,
        open_outside: null,
        trade_vs_day: "no-daily-bar",
        trade_outside_bps: null,
      });
    }
    // the bar's day comes from its stamp alone, as quote.ts' day does, even when its prices are unusable
    expect(facts(snap({ dailyBar: { t: "2026-10-12T04:00:00Z", o: 1, h: "2", l: 1, c: 1 } })).daily_day).toBe("today");
    expect(facts(snap({ dailyBar: null })).daily_day).toBe("unknown");
    expect(facts(snap({ dailyBar: "x" })).daily_day).toBe("unknown");
  });

  it("no usable trade: no-trade, whatever the day's bar says", () => {
    expect(facts(snap({ latestTrade: null }))).toMatchObject({ trade: "absent", trade_vs_day: "no-trade", trade_day: "unknown", daily_day: "today", trade_age_s: null });
    for (const t of ["x", { p: 0, t: iso(NOW) }, { p: -1, t: iso(NOW) }, { p: "100", t: iso(NOW) }, { p: 100, t: "now" }, { p: 100 }]) {
      expect(facts(snap({ latestTrade: t })), JSON.stringify(t)).toMatchObject({ trade: "invalid", trade_vs_day: "no-trade", prior_move: "unknown", prior_move_bps: null });
    }
  });

  it("pre-market: the day's bar is yesterday's, so the trade is not compared with its range", () => {
    const pre = at("08:00:00");
    const raw = snap({
      latestTrade: { t: iso(pre - 3_000), x: "V", p: 120, s: 1, c: ["@", "T"], i: 1, z: "B" },
      dailyBar: { t: "2026-10-09T04:00:00Z", o: 97, h: 99, l: 96, c: 98, v: 1, n: 1, vw: 97 },
      prevDailyBar: { t: "2026-10-08T04:00:00Z", o: 95, h: 97, l: 94, c: 96, v: 1, n: 1, vw: 95 },
      minuteBar: { t: iso(at("07:59:00")), o: 120, h: 120, l: 120, c: 120, v: 1, n: 1, vw: 120 },
    });
    expect(facts(raw, pre)).toMatchObject({ daily: "ok", daily_day: "other", trade_day: "today", trade_vs_day: "stale-day", trade_outside_bps: null, minute: "finished", minute_age_s: 60, trade_c: ["@", "T"] });
  });

  it("a daily bar from yesterday during the session reads as another day too", () => {
    expect(facts(snap({ dailyBar: { t: "2026-10-09T04:00:00Z", o: 99, h: 101, l: 98, c: 100 } }))).toMatchObject({ daily_day: "other", trade_vs_day: "stale-day" });
  });

  it("09:32 New York, an illiquid name: yesterday's last trade and yesterday's daily bar are stale-day, not outside today's range", () => {
    const now = at("09:32:00");
    const raw = snap({
      latestTrade: { t: "2026-10-09T19:59:58Z", x: "V", p: 150, s: 1, c: ["@"], i: 1, z: "B" },
      dailyBar: { t: "2026-10-09T04:00:00Z", o: 99, h: 101, l: 98, c: 100 },
    });
    expect(facts(raw, now)).toMatchObject({ trade_day: "other", daily_day: "other", trade_vs_day: "stale-day", trade_outside_bps: null });
    // a trade from today against yesterday's bar, and yesterday's trade against today's bar, are stale-day too
    expect(facts(snap({ dailyBar: { t: "2026-10-09T04:00:00Z", o: 99, h: 101, l: 98, c: 100 } }), now).trade_vs_day).toBe("stale-day");
    expect(facts(snap({ latestTrade: { t: "2026-10-09T19:59:58Z", p: 150 } }), now)).toMatchObject({ trade_day: "other", daily_day: "today", trade_vs_day: "stale-day" });
  });

  it("daily_day is the page's own test: quote.ts' day (the New York day of dailyBar.t) against the server's New York day", () => {
    const nyToday = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    const stamps = ["2026-10-12T04:00:00Z", "2026-10-09T04:00:00Z", "2026-10-13T03:59:59Z", "2026-10-12T03:59:59Z", "2026-10-13T04:00:00Z", "0001-01-01T00:00:00Z", "soon", null];
    for (const now of [at("04:00:00"), NOW, at("23:59:59"), at("09:32:00")]) {
      for (const t of stamps) {
        const raw = snap({ latestTrade: { t: iso(now - 1_000), p: 100 }, dailyBar: { t, o: 99, h: 101, l: 98, c: 100 } });
        const page = normalise(raw as never)!.day === nyToday(now);
        expect(facts(raw, now).daily_day === "today", `${String(t)} at ${iso(now)}`).toBe(page);
      }
    }
  });

  it("the day is New York's: a trade at 20:30 New York (00:30 UTC the next day) still matches its own day's bar", () => {
    const late = at("20:30:00");
    expect(facts(withTrade(100, late), late + 1_000)).toMatchObject({ daily_day: "today", trade_day: "today", trade_vs_day: "inside" });
  });
});

describe("the day bar's shape", () => {
  const day = (o: number, h: number, l: number) => facts(snap({ dailyBar: { t: "2026-10-12T04:00:00Z", o, h, l, c: 100 } }));

  it("flags a high below the low and an open outside low..high; an open at the high or low is inside", () => {
    expect(day(99, 101, 98)).toMatchObject({ high_below_low: false, open_outside: false });
    expect(day(98, 101, 98)).toMatchObject({ open_outside: false });
    expect(day(101, 101, 98)).toMatchObject({ open_outside: false });
    expect(day(102, 101, 98)).toMatchObject({ high_below_low: false, open_outside: true });
    expect(day(97, 101, 98)).toMatchObject({ open_outside: true });
    expect(day(99, 98, 101)).toMatchObject({ high_below_low: true, open_outside: true });
    // equal high and low is not "below"
    expect(day(100, 100, 100)).toMatchObject({ high_below_low: false, open_outside: false });
  });

  it("the first minute after the open: one print, open = high = low, all normal", () => {
    const now = at("09:30:20");
    const raw = snap({
      latestTrade: { t: iso(at("09:30:01")), x: "V", p: 100, s: 1, c: ["@", "O"], i: 1, z: "B" },
      minuteBar: { t: iso(at("09:30:00")), o: 100, h: 100, l: 100, c: 100, v: 1, n: 1, vw: 100 },
      dailyBar: { t: "2026-10-12T04:00:00Z", o: 100, h: 100, l: 100, c: 100, v: 1, n: 1, vw: 100 },
    });
    expect(facts(raw, now)).toMatchObject({ minute: "forming", minute_age_s: 20, high_below_low: false, open_outside: false, trade_vs_day: "inside", trade_age_s: 19 });
  });

  it("a half day (2026-11-27, close 13:00): the 12:59 bar finishes exactly at 13:00, and a print after the close is still read", () => {
    const close = at("13:00:00", "2026-11-27", "-05:00");
    const raw = {
      latestTrade: { t: iso(close + 5 * 60_000), x: "V", p: 101.5, s: 1, c: ["@", "T"], i: 1, z: "B" },
      minuteBar: { t: iso(close - 60_000), o: 100, h: 100, l: 100, c: 100, v: 1, n: 1, vw: 100 },
      dailyBar: { t: "2026-11-27T05:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1, n: 1, vw: 100 },
      prevDailyBar: { t: "2026-11-25T05:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1, n: 1, vw: 100 },
    };
    expect(facts(raw, close)).toMatchObject({ minute: "finished", minute_age_s: 60 });
    expect(facts(raw, close + 6 * 60_000)).toMatchObject({ trade_vs_day: "above-high", trade_outside_bps: 49.5, daily_day: "today", trade_age_s: 60 });
  });
});

describe("the move from the prior close", () => {
  const prev = (c: unknown) => ({ t: "2026-10-09T04:00:00Z", o: 1, h: 1, l: 1, c });

  it("exactly 25.000% either way is at-limit; a hair past is beyond, a hair short is within", () => {
    expect(facts(snap({ ...withTrade(125), prevDailyBar: prev(100) }))).toMatchObject({ prior_move: "at-limit", prior_move_bps: 2500 });
    expect(facts(snap({ ...withTrade(75), prevDailyBar: prev(100) }))).toMatchObject({ prior_move: "at-limit", prior_move_bps: 2500 });
    expect(facts(snap({ ...withTrade(125.01), prevDailyBar: prev(100) }))).toMatchObject({ prior_move: "beyond", prior_move_bps: 2501 });
    expect(facts(snap({ ...withTrade(74.99), prevDailyBar: prev(100) }))).toMatchObject({ prior_move: "beyond" });
    expect(facts(snap({ ...withTrade(124.99), prevDailyBar: prev(100) }))).toMatchObject({ prior_move: "within", prior_move_bps: 2499 });
    expect(facts(snap({ ...withTrade(300), prevDailyBar: prev(100) }))).toMatchObject({ prior_move: "beyond", prior_move_bps: 20000 });
  });

  it("the boundary holds where float subtraction is not exact", () => {
    // 12.75 - 10.2 is 2.5500000000000007 in binary floating point; it is still exactly 25%.
    expect(priorMove(12.75, 10.2).move).toBe("at-limit");
    expect(priorMove(7.65, 10.2).move).toBe("at-limit");
    expect(priorMove(12.7501, 10.2).move).toBe("beyond");
  });

  it("unknown without a prior bar or without a trade; the prior bar's own presence is reported", () => {
    expect(facts(snap({ prevDailyBar: null }))).toMatchObject({ prev: "absent", prior_move: "unknown", prior_move_bps: null });
    expect(facts(snap({ prevDailyBar: prev("98") }))).toMatchObject({ prev: "invalid", prior_move: "unknown" });
    expect(facts(snap({ prevDailyBar: prev(0) }))).toMatchObject({ prev: "invalid", prior_move: "unknown" });
    expect(facts(snap({ latestTrade: null }))).toMatchObject({ prev: "ok", prior_move: "unknown" });
  });
});

describe("the latest quote", () => {
  const q = (bp: unknown, ap: unknown, t: unknown = iso(NOW - 2_000)) => ({ t, ax: "V", ap, as: 1, bx: "V", bp, bs: 1, c: ["R"], z: "B" });

  it("normal, locked at bid = ask, crossed with a negative spread", () => {
    expect(facts(withQuote(q(99.98, 100.02)))).toMatchObject({ quote: "normal", spread_bps: 4, quote_age_s: 2 });
    expect(facts(withQuote(q(100, 100)))).toMatchObject({ quote: "locked", spread_bps: 0 });
    expect(facts(withQuote(q(100.02, 99.98)))).toMatchObject({ quote: "crossed", spread_bps: -4 });
  });

  it("one-sided when one price is 0 (Alpaca's no active side), empty when both are", () => {
    expect(facts(withQuote(q(0, 100)))).toMatchObject({ quote: "one-sided", spread_bps: null });
    expect(facts(withQuote(q(100, 0)))).toMatchObject({ quote: "one-sided", spread_bps: null });
    expect(facts(withQuote(q(0, 0)))).toMatchObject({ quote: "empty", spread_bps: null });
  });

  it("absent when missing or null; invalid for wrong types or a negative price; an unreadable time is a null age", () => {
    expect(facts(snap({ latestQuote: undefined }))).toMatchObject({ quote: "absent", spread_bps: null, quote_age_s: null });
    expect(facts(withQuote(null))).toMatchObject({ quote: "absent" });
    for (const bad of ["q", 1, [], q("99", 100), q(99, null), q(-1, 100), q(Number.NaN, 100), {}]) {
      expect(facts(withQuote(bad)), JSON.stringify(bad)).toMatchObject({ quote: "invalid", spread_bps: null });
    }
    expect(facts(withQuote(q(99.98, 100.02, "later")))).toMatchObject({ quote: "normal", quote_time: "invalid", quote_age_s: null });
    expect(facts(withQuote(q(99.98, 100.02, null)))).toMatchObject({ quote: "normal", quote_time: "absent", quote_age_s: null });
  });
});

describe("condition and exchange codes", () => {
  const codes = (c: unknown, x: unknown = "V") => facts(snap({ latestTrade: { t: iso(NOW - 1_000), x, p: 100, s: 1, c, i: 1, z: "B" } }));

  it("keeps 1-2 characters of A-Z, 0-9, space or @, in order, and counts what it drops", () => {
    expect(codes(["@", "F", " ", "T I", "ab", 5, "<x>", "12", "", null, "Z@"])).toMatchObject({ trade_c: ["@", "F", " ", "12", "Z@"], trade_c_dropped: 6 });
    expect(codes([])).toMatchObject({ trade_c: [], trade_c_dropped: 0 });
    expect(codes(undefined)).toMatchObject({ trade_c: [], trade_c_dropped: 0 });
    expect(codes(null)).toMatchObject({ trade_c: [], trade_c_dropped: 0 });
    expect(codes("@")).toMatchObject({ trade_c: [], trade_c_dropped: -1 });
    expect(codes({ 0: "@" })).toMatchObject({ trade_c: [], trade_c_dropped: -1 });
  });

  it("keeps at most MAX_CODES and counts the rest as dropped", () => {
    const many = Array.from({ length: MAX_CODES + 3 }, (_, i) => String(i % 10));
    expect(codes(many)).toMatchObject({ trade_c: many.slice(0, MAX_CODES), trade_c_dropped: 3 });
  });

  it("the exchange code likewise, else null; an invalid trade still reports its codes", () => {
    expect(codes([], "V").trade_x).toBe("V");
    for (const x of ["v", "VVV", "", 7, null, "<", "\n"]) expect(codes([], x).trade_x, String(x)).toBeNull();
    expect(facts(snap({ latestTrade: { p: 0, x: "V", c: ["@"] } }))).toMatchObject({ trade: "invalid", trade_x: "V", trade_c: ["@"] });
    expect(safeCode("@ ")).toBe("@ ");
    expect(safeCode(undefined)).toBeNull();
    expect(safeCode("A\u0000")).toBeNull();
  });
});

describe("missing data and wrong types", () => {
  it("no snapshot at all is 'missing'", () => {
    expect(probeSnapshot("SPY", null, NOW)).toEqual({ symbol: "SPY", source: "missing" });
    expect(probeSnapshot("SPY", undefined, NOW)).toEqual({ symbol: "SPY", source: "missing" });
  });

  it("a snapshot that is an array or a primitive is 'invalid', with no facts", () => {
    for (const raw of ["snap", 42, 0, [], [snap()], true, false, Number.NaN]) {
      expect(probeSnapshot("SPY", raw, NOW), JSON.stringify(raw)).toEqual({ symbol: "SPY", source: "invalid" });
    }
  });

  it("an empty snapshot object reads as every part absent", () => {
    for (const raw of [{}, { other: 1 }]) {
      expect(facts(raw), JSON.stringify(raw)).toMatchObject({
        trade: "absent",
        minute: "absent",
        daily: "absent",
        prev: "absent",
        quote: "absent",
        trade_vs_day: "no-trade",
        prior_move: "unknown",
        trade_x: null,
        trade_c: [],
      });
    }
  });

  it("never throws, whatever it is given", () => {
    const junk: unknown[] = [null, undefined, 0, -1, Number.NaN, Infinity, "", "x", [], [1], {}, { t: 1 }, { p: 1 }, true, Symbol.iterator, () => 1];
    const parts = ["latestTrade", "latestQuote", "minuteBar", "dailyBar", "prevDailyBar"];
    for (const j of junk) {
      expect(() => probeSnapshot("SPY", j, NOW)).not.toThrow();
      for (const p of parts) {
        expect(() => probeSnapshot("SPY", snap({ [p]: j }), NOW)).not.toThrow();
        for (const k of ["t", "p", "x", "c", "o", "h", "l", "bp", "ap"]) {
          const base = snap() as Record<string, Record<string, unknown>>;
          expect(() => probeSnapshot("SPY", { ...base, [p]: { ...base[p], [k]: j } }, NOW)).not.toThrow();
        }
      }
      expect(() => probeSnapshot("SPY", snap(), j as number)).not.toThrow();
    }
  });

  it("an unusable server time gives null ages, an invalid minute and unknown days, never a guess", () => {
    expect(facts(snap(), Number.NaN)).toMatchObject({
      trade_age_s: null,
      quote_age_s: null,
      minute: "invalid",
      minute_age_s: null,
      trade: "ok",
      trade_day: "unknown",
      daily_day: "unknown",
      trade_vs_day: "stale-day",
    });
  });
});

describe("unreadable times", () => {
  const ZERO = "0001-01-01T00:00:00Z"; // Go's zero time

  it("Go's zero time, a time before 1970, or one more than 7 days away is invalid, never an age", () => {
    for (const t of [ZERO, "1969-12-31T23:59:59Z", iso(NOW - 8 * 86_400_000), iso(NOW + 8 * 86_400_000)]) {
      expect(facts(snap({ latestTrade: { t, x: "V", p: 100, c: ["@"] } })), t).toMatchObject({ trade: "invalid", trade_age_s: null, trade_day: "unknown", trade_vs_day: "no-trade" });
      expect(facts(withQuote({ t, bp: 99.98, ap: 100.02 })), t).toMatchObject({ quote: "normal", quote_time: "invalid", quote_age_s: null });
      expect(facts(snap({ minuteBar: { t, o: 1, h: 1, l: 1, c: 1 } })), t).toMatchObject({ minute: "invalid", minute_age_s: null });
      expect(facts(snap({ dailyBar: { t, o: 99, h: 101, l: 98, c: 100 } })), t).toMatchObject({ daily: "invalid", daily_day: "unknown", trade_vs_day: "no-daily-bar" });
    }
    // within the window is read: 6 days back is a usable (if old) prior bar
    expect(facts(snap({ prevDailyBar: { t: iso(NOW - 6 * 86_400_000), o: 1, h: 1, l: 1, c: 98 } })).prev).toBe("ok");
  });

  it("a stamp 30 s ahead of server time is read, with a negative age (clock skew), never rounded to 0", () => {
    expect(facts(withTrade(100, NOW + 30_000))).toMatchObject({ trade: "ok", trade_age_s: -30, trade_vs_day: "inside" });
    expect(facts(withQuote({ t: iso(NOW + 30_000), bp: 99.98, ap: 100.02 }))).toMatchObject({ quote_time: "ok", quote_age_s: -30 });
    expect(facts(withTrade(100, NOW + 450))).toMatchObject({ trade_age_s: -0.5 });
  });

  it("every age is floored to one decimal alike", () => {
    expect(facts(withTrade(100, NOW - 59_999))).toMatchObject({ trade_age_s: 59.9 });
    expect(facts(withQuote({ t: iso(NOW - 4_999), bp: 99.98, ap: 100.02 }))).toMatchObject({ quote_age_s: 4.9 });
  });
});

describe("probeSnapshots", () => {
  it("one entry per valid name, once each: fetched, missing (left out of the answer) or cached", () => {
    const r = probeSnapshots(["SPY", "QQQ", "AAPL", "SPY", "bad name", "<x>", "IWM"], { fetched: { SPY: snap(), QQQ: null, IWM: [] }, at: NOW });
    expect(r!.v).toBe(PROBE_V);
    expect(r!.names.map((n) => [n.symbol, n.source])).toEqual([
      ["SPY", "fetched"],
      ["QQQ", "missing"],
      ["AAPL", "cached"],
      ["IWM", "invalid"],
    ]);
  });

  it("is null when no answer was handed over", () => {
    expect(probeSnapshots(["SPY"], null)).toBeNull();
    expect(probeSnapshots(["SPY"], { fetched: null as unknown as Record<string, unknown>, at: NOW })).toBeNull();
  });

  it("probes at most MAX_PROBED names, quickly", () => {
    const syms = Array.from({ length: MAX_PROBED + 10 }, (_, i) => `N${i}`);
    const fetched = Object.fromEntries(syms.map((s) => [s, snap()]));
    const r = probeSnapshots(syms, { fetched, at: NOW });
    expect(r!.names).toHaveLength(MAX_PROBED);
    // A few ms at most for a full board (four names in practice). The best of three runs, against a loose bound, so a
    // garbage collection or a busy CI runner cannot flake it.
    const times = [0, 1, 2].map(() => {
      const t0 = performance.now();
      probeSnapshots(syms, { fetched, at: NOW });
      return performance.now() - t0;
    });
    expect(Math.min(...times)).toBeLessThan(50);
  });
});

describe("summariseProbe", () => {
  const rec = (names: NameProbe[], feed: unknown = "iex", extra: Record<string, unknown> = {}) => ({ v: 1, status: "ok", feed, probe: { v: PROBE_V, phase: "regular", rate_limit: 200, rate_remaining: 150, names, ...extra } });
  const n = (sym: string, raw: unknown, now = NOW) => probeSnapshot(sym, raw, now);

  it("counts every fact per name and in total, and keeps the worst numbers", () => {
    const records = [
      rec([n("SPY", snap()), n("QQQ", withTrade(102))]),
      rec([n("SPY", withQuote({ t: iso(NOW), bp: 100.02, ap: 99.98 })), { symbol: "QQQ", source: "cached" }]),
      rec([n("SPY", snap({ dailyBar: { t: "2026-10-12T04:00:00Z", o: 99, h: 98, l: 101, c: 100 } })), n("QQQ", null)]),
      { v: 1, status: "ok", feed: "iex" }, // written before the probe
      { v: 1, status: "degraded", feed: null, probe: null }, // the snapshot read did not answer
    ];
    const s = summariseProbe(records);
    expect(s).toMatchObject({ records: 5, with_probe: 3, without_probe: 2 });
    const g = s.by_feed.iex;
    expect(g.records).toBe(3);
    expect(g.total.samples).toBe(6);
    expect(g.total.counts.source).toEqual({ fetched: 4, cached: 1, missing: 1, invalid: 0 });
    expect(g.by_symbol.SPY!.counts.quote).toMatchObject({ normal: 2, crossed: 1 });
    expect(g.by_symbol.SPY!.counts.high_below_low).toEqual({ yes: 1, no: 2, unknown: 0 });
    expect(g.by_symbol.SPY!.counts.open_outside).toEqual({ yes: 1, no: 2, unknown: 0 });
    expect(g.by_symbol.QQQ!.counts.trade_vs_day).toMatchObject({ "above-high": 1, inside: 0 });
    expect(g.by_symbol.QQQ!.counts.source).toEqual({ fetched: 1, cached: 1, missing: 1, invalid: 0 });
    // skipped names count only towards their source
    expect(g.by_symbol.QQQ!.counts.quote.normal).toBe(1);
    // the worst is SPY's last trade above a day bar whose high is below its low: (100 - 98) / 98
    expect(g.total.numbers.trade_outside_bps).toEqual({ n: 2, min: 99, max: 204.1, buckets: { negative: 0, "0-10": 0, "10-50": 0, "50-250": 2, "250+": 0 } });
    expect(g.by_symbol.QQQ!.numbers.trade_outside_bps!.max).toBe(99);
    expect(g.total.numbers.spread_bps).toMatchObject({ n: 4, min: -4, max: 4, buckets: { negative: 1, "0-10": 3 } });
    expect(g.total.conditions).toEqual({ "@": 3 });
    expect(g.total.exchanges).toEqual({ V: 4 });
    expect(g.total.conditions_dropped).toBe(0);
    expect(g.phase).toMatchObject({ regular: 3, "pre-open": 0 });
    expect(g.rate_limit).toEqual({ "200": 3 });
    expect(g.rate_remaining).toMatchObject({ n: 3, min: 150, max: 150, buckets: { "100+": 3 } });
    expect(s.by_feed.sip.records).toBe(0);
    expect(s.by_feed.unknown.records).toBe(0);
  });

  it("groups by the record's feed: IEX and SIP are never pooled, and a record with no readable feed is 'unknown'", () => {
    const s = summariseProbe([
      rec([n("SPY", snap())], "iex"),
      rec([n("SPY", withQuote({ t: iso(NOW), bp: 100, ap: 100 }))], "sip"),
      rec([n("SPY", withQuote({ t: iso(NOW), bp: 100.02, ap: 99.98 }))], "sip", { phase: "pre-open", rate_limit: 10_000, rate_remaining: 5 }),
      rec([n("SPY", snap())], null),
      rec([n("SPY", snap())], "SIP"),
    ]);
    expect(s.by_feed.iex.total.counts.quote).toMatchObject({ normal: 1, locked: 0, crossed: 0 });
    expect(s.by_feed.sip.total.counts.quote).toMatchObject({ normal: 0, locked: 1, crossed: 1 });
    expect(s.by_feed.sip.phase).toMatchObject({ regular: 1, "pre-open": 1 });
    expect(s.by_feed.sip.rate_limit).toEqual({ "200": 1, "10000": 1 });
    expect(s.by_feed.sip.rate_remaining).toMatchObject({ n: 2, min: 5, max: 150 });
    expect(s.by_feed.unknown.records).toBe(2);
    expect(Object.keys(s)).not.toContain("total");
  });

  it("is lenient with what it reads: junk records and entries are counted or skipped, never thrown on", () => {
    const s = summariseProbe([
      null,
      "x",
      7,
      [],
      { probe: "x" },
      { probe: { v: 2, names: [] } },
      { probe: { v: 1, names: "x" } },
      {
        probe: {
          v: 1,
          phase: "lunch",
          rate_limit: -1,
          rate_remaining: "9",
          names: [null, 5, { symbol: "bad name", source: "fetched" }, { symbol: "__proto__" }, { symbol: "SPY", source: "fetched", quote: "weird", trade_c: ["@", "<script>"], trade_x: "<", trade_c_dropped: 2, spread_bps: "9" }],
        },
      },
    ]);
    expect(s).toMatchObject({ records: 8, with_probe: 1, without_probe: 7 });
    const g = s.by_feed.unknown;
    expect(Object.keys(g.by_symbol)).toEqual(["SPY"]);
    expect(g.total.samples).toBe(1);
    expect(g.total.counts.quote["invalid-record"]).toBe(1);
    expect(g.total.conditions).toEqual({ "@": 1 });
    expect(g.total.exchanges).toEqual({});
    expect(g.total.conditions_dropped).toBe(1);
    expect(g.total.numbers.spread_bps).toEqual({ n: 0, min: null, max: null, buckets: { negative: 0, "0-10": 0, "10-50": 0, "50-250": 0, "250+": 0 } });
    expect(g.phase["invalid-record"]).toBe(1);
    expect(g.rate_limit).toEqual({});
    expect(g.rate_remaining.n).toBe(0);
  });

  it("keeps the smallest, the largest and fixed buckets per number, so clock skew and one bad stamp cannot hide the rest", () => {
    const ages = [-30, -0.5, 0, 4.9, 5, 19.9, 20, 119.9, 120, 3_600];
    const s = summariseProbe([rec(ages.map((a) => n("SPY", withTrade(100, NOW - a * 1_000))))]);
    const g = s.by_feed.iex;
    expect(g.total.numbers.trade_age_s).toEqual({ n: 10, min: -30, max: 3_600, buckets: { negative: 2, "0-5": 2, "5-20": 2, "20-120": 2, "120+": 2 } });
    expect(bucketOf(0, AGE_BUCKETS)).toBe("0-5");
    expect(bucketOf(250, BPS_BUCKETS)).toBe("250+");
    expect(bucketOf(-0.1, BPS_BUCKETS)).toBe("negative");
    expect(g.total.numbers.prior_move_bps!.buckets["100-500"]).toBe(10);
    expect(g.total.numbers.trade_vs_minute_s!.n).toBe(0); // the minute bar is forming in every sample
  });

  it("an empty session is all zeros", () => {
    const s = summariseProbe([]);
    expect(s).toMatchObject({ records: 0, with_probe: 0, without_probe: 0 });
    for (const g of Object.values(s.by_feed)) {
      expect(g.records).toBe(0);
      expect(g.total.samples).toBe(0);
      expect(Object.values(g.total.counts.quote).every((c) => c === 0)).toBe(true);
    }
  });
});

describe("the trade's conditions (Alpaca's market-data FAQ, how bars are aggregated)", () => {
  const cls = (c: unknown, z: unknown = "B") => facts(snap({ latestTrade: { t: iso(NOW - 1_000), x: "V", p: 100, s: 1, c, i: 1, z } })).trade_class;

  it("regular codes update the price", () => {
    for (const c of [["@"], [" "], ["@", "F"], ["O"], ["6"], ["@", "5"], ["E", "K", "L", "X", "Y", "A", "D"]]) expect(cls(c), JSON.stringify(c)).toBe("regular");
  });

  it("each class by its codes, with B by its tape (average price on A and B, bunched on C)", () => {
    expect(cls(["@", "T"])).toBe("extended-hours");
    expect(cls(["U"])).toBe("extended-hours");
    expect(cls(["@", "I"])).toBe("odd-lot");
    expect(cls(["4"])).toBe("derivatively-priced");
    for (const c of ["7", "9", "C", "G", "H", "M", "N", "P", "Q", "R", "V", "W", "Z"]) expect(cls(["@", c]), c).toBe("other-non-updating");
    expect(cls(["B"], "A")).toBe("other-non-updating");
    expect(cls(["B"], "B")).toBe("other-non-updating");
    expect(cls(["B"], "C")).toBe("regular");
    expect(cls(["B"], null)).toBe("unknown");
  });

  it("strictest first, whatever the order", () => {
    expect(cls(["T", "I"])).toBe("odd-lot");
    expect(cls(["I", "T"])).toBe("odd-lot");
    expect(cls(["I", "M"])).toBe("other-non-updating");
    expect(cls(["T", "4"])).toBe("derivatively-priced");
    expect(cls(["@", "S"])).toBe("unknown"); // S is not in the FAQ's table
    expect(cls(["S", "T"])).toBe("extended-hours"); // a known stricter class wins over an unknown code
  });

  it("unknown with nothing to read: no codes, not an array, a dropped code, or no trade", () => {
    expect(cls([])).toBe("unknown");
    expect(cls(undefined)).toBe("unknown");
    expect(cls("@")).toBe("unknown");
    expect(cls(["@", "<x>"])).toBe("unknown");
    expect(cls(["I", "<x>"])).toBe("odd-lot");
    expect(facts(snap({ latestTrade: null })).trade_class).toBe("unknown");
    expect(tradeClass(["@"], 0, "C")).toBe("regular");
  });
});

describe("the daily bars' days against the calendar, and the run's phase", () => {
  // 2026-10-12 is a Monday: the previous session is Friday 2026-10-09.
  const sess = (dailyT: unknown, prevT: unknown, now = NOW) =>
    facts(snap({ dailyBar: dailyT === undefined ? undefined : { t: dailyT, o: 99, h: 101, l: 98, c: 100 }, prevDailyBar: prevT === undefined ? undefined : { t: prevT, o: 1, h: 1, l: 1, c: 98 } }), now);

  it("today, the previous session, older, a non-session day between, a day ahead, absent and unreadable", () => {
    expect(sess("2026-10-12T04:00:00Z", "2026-10-09T04:00:00Z")).toMatchObject({ daily_session: "today", prev_session: "previous-session" });
    expect(sess("2026-10-09T04:00:00Z", "2026-10-08T04:00:00Z")).toMatchObject({ daily_session: "previous-session", prev_session: "older" });
    expect(sess("2026-10-10T04:00:00Z", "2026-10-11T04:00:00Z")).toMatchObject({ daily_session: "off-session", prev_session: "off-session" });
    expect(sess("2026-10-13T04:00:00Z", undefined)).toMatchObject({ daily_session: "future", prev_session: "absent" });
    expect(sess("0001-01-01T00:00:00Z", "soon")).toMatchObject({ daily_session: "invalid", prev_session: "invalid" });
    expect(facts(snap({ dailyBar: null, prevDailyBar: "x" }))).toMatchObject({ daily_session: "absent", prev_session: "invalid" });
    expect(sess("2026-10-12T04:00:00Z", "2026-10-09T04:00:00Z", Number.NaN)).toMatchObject({ daily_session: "unknown", prev_session: "unknown" });
  });

  it("before 09:30 the daily bar can still be the previous session's: that is what the field answers", () => {
    expect(sess("2026-10-09T04:00:00Z", "2026-10-08T04:00:00Z", at("09:00:00")).daily_session).toBe("previous-session");
    expect(sess("2026-10-12T04:00:00Z", "2026-10-09T04:00:00Z", at("09:00:00")).daily_session).toBe("today");
  });

  it("the previous session skips weekends and holidays, by the calendar", () => {
    expect(previousSession("2026-10-12")).toBe("2026-10-09");
    expect(previousSession("2026-11-27")).toBe("2026-11-25"); // Thanksgiving, 2026-11-26, is closed
    const fri = at("10:00:00", "2026-11-27", "-05:00");
    expect(sess("2026-11-25T05:00:00Z", "2026-11-24T05:00:00Z", fri)).toMatchObject({ daily_session: "previous-session", prev_session: "older" });
    expect(sess("2026-11-26T05:00:00Z", undefined, fri).daily_session).toBe("off-session");
  });

  it("the phase: pre-open before 09:30, regular to the close (13:00 on a half day), after-close from it, closed on a non-session day", () => {
    expect(phaseAt(at("09:29:59"))).toBe("pre-open");
    expect(phaseAt(at("09:30:00"))).toBe("regular");
    expect(phaseAt(at("15:59:59"))).toBe("regular");
    expect(phaseAt(at("16:00:00"))).toBe("after-close");
    expect(phaseAt(at("12:59:59", "2026-11-27", "-05:00"))).toBe("regular");
    expect(phaseAt(at("13:00:00", "2026-11-27", "-05:00"))).toBe("after-close");
    expect(phaseAt(at("12:00:00", "2026-11-26", "-05:00"))).toBe("closed");
    expect(phaseAt(at("12:00:00", "2026-10-10"))).toBe("closed");
    expect(phaseAt(Number.NaN)).toBe("unknown");
    expect(phaseAt(Date.parse("2099-06-01T15:00:00Z"))).toBe("unknown");
    expect(probeSnapshots(["SPY"], { fetched: { SPY: snap() }, at: at("09:00:00") })!.phase).toBe("pre-open");
  });
});

describe("the last trade against the finished minute bar", () => {
  const vs = (barStart: number, tradeAt: number, now: number) =>
    facts(snap({ minuteBar: { t: iso(barStart), o: 1, h: 1, l: 1, c: 1 }, latestTrade: { t: iso(tradeAt), x: "V", p: 100, c: ["@"] } }), now);
  const start = at("10:29:00");

  it("the bar's end minus the trade's time, in seconds: positive when the trade is inside the bar, negative when after it", () => {
    expect(vs(start, start + 59_000, at("10:30:30"))).toMatchObject({ minute: "finished", trade_vs_minute_s: 1 });
    expect(vs(start, start + 60_000, at("10:30:30"))).toMatchObject({ trade_vs_minute_s: 0 });
    expect(vs(start, start + 72_500, at("10:30:30"))).toMatchObject({ trade_vs_minute_s: -12.5 });
    expect(vs(start, start - 300_000, at("10:30:30"))).toMatchObject({ trade_vs_minute_s: 360 });
  });

  it("null while the bar is forming, or without a readable bar or trade", () => {
    expect(vs(at("10:30:00"), at("10:30:10"), at("10:30:30")).trade_vs_minute_s).toBeNull();
    expect(facts(snap({ minuteBar: null })).trade_vs_minute_s).toBeNull();
    expect(facts(snap({ minuteBar: { t: iso(start), o: 1, h: 1, l: 1, c: 1 }, latestTrade: null }), at("10:30:30")).trade_vs_minute_s).toBeNull();
  });
});

describe("the rate-limit headers and zero sizes", () => {
  it("reads the headers as whole numbers of 0 or more, else null", () => {
    const r = (limit: string | null, remaining: string | null) => probeSnapshots(["SPY"], { fetched: { SPY: snap() }, at: NOW, rate: { limit, remaining } })!;
    expect(r("200", "187")).toMatchObject({ rate_limit: 200, rate_remaining: 187 });
    expect(r(" 200 ", "0")).toMatchObject({ rate_limit: 200, rate_remaining: 0 });
    for (const bad of [null, "", "-1", "1.5", "abc", "1e3", "9999999999"]) expect(r(bad, bad), String(bad)).toMatchObject({ rate_limit: null, rate_remaining: null });
    expect(probeSnapshots(["SPY"], { fetched: { SPY: snap() }, at: NOW })).toMatchObject({ rate_limit: null, rate_remaining: null });
    expect(rateHeader(5 as unknown)).toBeNull();
  });

  it("a zero size on a side is no active side, as a zero price is; a bad size is invalid; a missing size leaves it to the price", () => {
    const q = (bp: number, bs: unknown, ap: number, as: unknown) => facts(withQuote({ t: iso(NOW), bp, bs, ap, as })).quote;
    expect(q(99.98, 100, 100.02, 100)).toBe("normal");
    expect(q(99.98, 0, 100.02, 100)).toBe("one-sided");
    expect(q(99.98, 100, 100.02, 0)).toBe("one-sided");
    expect(q(99.98, 0, 100.02, 0)).toBe("empty");
    expect(q(0, 100, 100.02, 0)).toBe("empty");
    expect(q(100, 1, 100, 1)).toBe("locked");
    expect(q(100.02, 1, 99.98, 1)).toBe("crossed");
    expect(q(100.02, 0, 99.98, 1)).toBe("one-sided"); // a zero-size side cannot cross the book
    for (const bad of [-1, "1", null, Number.NaN]) expect(q(99.98, bad, 100.02, 1), String(bad)).toBe("invalid");
    expect(q(99.98, undefined, 100.02, undefined)).toBe("normal");
  });
});
