// The snapshot probe (quote-probe.ts): one fact at a time, the normal case, each abnormal case, missing data, wrong
// types and the exact boundaries (25.000% from the prior close, a minute bar ending exactly at server time, a bid equal
// to the ask), the session's edges (pre-market, the first minute, a half day), and the reader's counts.
import { describe, expect, it } from "vitest";
import {
  MAX_CODES,
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
  "trade_age_s",
  "trade_x",
  "trade_c",
  "trade_c_dropped",
  "minute",
  "minute_age_s",
  "daily",
  "daily_day",
  "high_below_low",
  "open_outside",
  "trade_vs_day",
  "trade_outside_bps",
  "prev",
  "prior_move",
  "prior_move_bps",
  "quote",
  "spread_bps",
  "quote_age_s",
];

describe("a normal snapshot", () => {
  it("reads every fact as normal, with ages in seconds and distances in basis points", () => {
    expect(facts(snap())).toEqual({
      symbol: "SPY",
      source: "fetched",
      trade: "ok",
      trade_age_s: 1,
      trade_x: "V",
      trade_c: ["@"],
      trade_c_dropped: 0,
      minute: "forming",
      minute_age_s: 30,
      daily: "ok",
      daily_day: "same",
      high_below_low: false,
      open_outside: false,
      trade_vs_day: "inside",
      trade_outside_bps: null,
      prev: "ok",
      prior_move: "within",
      prior_move_bps: 204.1,
      quote: "normal",
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
    expect(minuteAt(start, start + 59_999)).toMatchObject({ minute: "forming", minute_age_s: 60 });
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
        daily_day: "unknown",
        high_below_low: null,
        open_outside: null,
        trade_vs_day: "no-daily-bar",
        trade_outside_bps: null,
      });
    }
  });

  it("no usable trade: no-trade, whatever the day's bar says", () => {
    expect(facts(snap({ latestTrade: null }))).toMatchObject({ trade: "absent", trade_vs_day: "no-trade", daily_day: "unknown", trade_age_s: null });
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
    expect(facts(raw, pre)).toMatchObject({ daily: "ok", daily_day: "other", trade_vs_day: "other-day", trade_outside_bps: null, minute: "finished", minute_age_s: 60, trade_c: ["@", "T"] });
  });

  it("a daily bar from yesterday during the session reads as another day too", () => {
    expect(facts(snap({ dailyBar: { t: "2026-10-09T04:00:00Z", o: 99, h: 101, l: 98, c: 100 } }))).toMatchObject({ daily_day: "other", trade_vs_day: "other-day" });
  });

  it("the day is New York's: a trade at 20:30 New York (00:30 UTC the next day) still matches its own day's bar", () => {
    const late = at("20:30:00");
    expect(facts(withTrade(100, late), late + 1_000)).toMatchObject({ daily_day: "same", trade_vs_day: "inside" });
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
    expect(facts(raw, close + 6 * 60_000)).toMatchObject({ trade_vs_day: "above-high", trade_outside_bps: 49.5, daily_day: "same", trade_age_s: 60 });
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
    expect(facts(withQuote(q(99.98, 100.02, "later")))).toMatchObject({ quote: "normal", quote_age_s: null });
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

  it("a snapshot that is not an object, or an empty one, reads as every part absent", () => {
    for (const raw of [{}, "snap", 42, [], true]) {
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

  it("an unusable server time gives null ages and an invalid minute, never a guess", () => {
    expect(facts(snap(), Number.NaN)).toMatchObject({ trade_age_s: null, quote_age_s: null, minute: "invalid", minute_age_s: null, trade: "ok", trade_vs_day: "inside" });
  });
});

describe("probeSnapshots", () => {
  it("one entry per valid name, once each: fetched, missing (left out of the answer) or cached", () => {
    const r = probeSnapshots(["SPY", "QQQ", "AAPL", "SPY", "bad name", "<x>"], { fetched: { SPY: snap(), QQQ: null }, at: NOW });
    expect(r!.v).toBe(PROBE_V);
    expect(r!.names.map((n) => [n.symbol, n.source])).toEqual([
      ["SPY", "fetched"],
      ["QQQ", "missing"],
      ["AAPL", "cached"],
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
  const rec = (names: NameProbe[]) => ({ v: 1, status: "ok", feed: "iex", probe: { v: PROBE_V, names } });
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
    expect(s.total.samples).toBe(6);
    expect(s.total.counts.source).toEqual({ fetched: 4, cached: 1, missing: 1 });
    expect(s.by_symbol.SPY!.counts.quote).toMatchObject({ normal: 2, crossed: 1 });
    expect(s.by_symbol.SPY!.counts.high_below_low).toEqual({ yes: 1, no: 2, unknown: 0 });
    expect(s.by_symbol.SPY!.counts.open_outside).toEqual({ yes: 1, no: 2, unknown: 0 });
    expect(s.by_symbol.QQQ!.counts.trade_vs_day).toMatchObject({ "above-high": 1, inside: 0 });
    expect(s.by_symbol.QQQ!.counts.source).toEqual({ fetched: 1, cached: 1, missing: 1 });
    // skipped names count only towards their source
    expect(s.by_symbol.QQQ!.counts.quote.normal).toBe(1);
    // the worst is SPY's last trade above a day bar whose high is below its low: (100 - 98) / 98
    expect(s.total.max.trade_outside_bps).toBe(204.1);
    expect(s.by_symbol.QQQ!.max.trade_outside_bps).toBe(99);
    expect(s.total.min_spread_bps).toBe(-4);
    expect(s.total.max.spread_bps).toBe(4);
    expect(s.total.conditions).toEqual({ "@": 3 });
    expect(s.total.exchanges).toEqual({ V: 4 });
    expect(s.total.conditions_dropped).toBe(0);
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
      { probe: { v: 1, names: [null, 5, { symbol: "bad name", source: "fetched" }, { symbol: "__proto__" }, { symbol: "SPY", source: "fetched", quote: "weird", trade_c: ["@", "<script>"], trade_x: "<", trade_c_dropped: 2, spread_bps: "9" }] } },
    ]);
    expect(s).toMatchObject({ records: 8, with_probe: 1, without_probe: 7 });
    expect(Object.keys(s.by_symbol)).toEqual(["SPY"]);
    expect(s.total.samples).toBe(1);
    expect(s.total.counts.quote["invalid-record"]).toBe(1);
    expect(s.total.conditions).toEqual({ "@": 1 });
    expect(s.total.exchanges).toEqual({});
    expect(s.total.conditions_dropped).toBe(1);
    expect(s.total.max.spread_bps).toBeNull();
  });

  it("an empty session is all zeros", () => {
    const s = summariseProbe([]);
    expect(s).toMatchObject({ records: 0, with_probe: 0, without_probe: 0, by_symbol: {} });
    expect(s.total.samples).toBe(0);
    expect(Object.values(s.total.counts.quote).every((c) => c === 0)).toBe(true);
  });
});
