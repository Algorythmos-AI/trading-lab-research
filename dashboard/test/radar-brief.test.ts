import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerdictPanel, WeekPanel } from "@/components/radar-brief";
import type { Trade } from "@/lib/journal";
import type { OptionsEdition } from "@/lib/options.types";
import type { Radar } from "@/lib/radar";
import {
  briefWeek,
  dayVerdict,
  earningsOf,
  holidaysOf,
  isMonthlyExpiry,
  keyLevels,
  mergedLevels,
  movers,
  openPlan,
  openRead,
  sessionRecord,
  sydneyAt,
  timedEvents,
  vixJumpPct,
  yourNames,
  type OptionsTicker,
} from "@/lib/radar-brief";
import radarJson from "./fixtures/radar.v1.json";

const spyOpt: OptionsTicker = {
  symbol: "SPY",
  last: { open: 768, high: 772.87, low: 764.43, close: 771.79 },
  expected_move: { day: 6.13 },
  levels: [
    { name: "PDH", price: 772.87 },
    { name: "PDL", price: 764.43 },
    { name: "PDC", price: 771.79 },
    { name: "PWH", price: 781.62 },
    { name: "PWL", price: 769.63 },
    { name: "PMH", price: 775.14 },
    { name: "PML", price: 749.6 },
    { name: "MA20", price: 770 },
  ],
};

const radar = (over: Partial<Radar> = {}): Radar => ({
  schema: "stocksdelta/radar",
  run_id: "r",
  as_of: "2026-10-16T10:47:00Z",
  edition_date: "2026-10-14",
  ...over,
});

let seq = 0;
const trade = (symbol: string, opened: string, pnl: number, over: Partial<Trade> = {}): Trade => ({
  id: `t${++seq}`,
  symbol,
  kind: "call",
  strike: 1,
  expiry: opened.slice(0, 10),
  side: "long",
  qty: 1,
  opened_at: opened,
  closed_at: new Date(Date.parse(opened) + 120_000).toISOString(),
  entry: 1,
  exit: 1,
  multiplier: 100,
  pnl,
  close: "order",
  ...over,
});

describe("key levels", () => {
  it("keeps only the day, week and month highs and lows, lowest first", () => {
    expect(keyLevels(spyOpt).map((l) => l.name)).toEqual(["PML", "PDL", "PWL", "PDH", "PMH", "PWH"]);
    expect(keyLevels(undefined)).toEqual([]);
  });
  it("merges levels at the same price", () => {
    expect(mergedLevels([{ name: "PDL", price: 760.64 }, { name: "PWL", price: 760.64 }, { name: "PDH", price: 773.25 }])).toEqual([
      { names: "PDL/PWL", price: 760.64 },
      { names: "PDH", price: 773.25 },
    ]);
  });
});

describe("where a name opens", () => {
  it("places pre-market above the previous day's high and measures the gap against the expected move", () => {
    const o = openRead("SPY", spyOpt, { symbol: "SPY", price: 771.79, premarket_price: 773.59, why: "Back above 770." });
    expect(o.where).toBe("above");
    expect(o.below?.name).toBe("PDH");
    expect(o.above?.name).toBe("PMH");
    expect(o.gapPct).toBeCloseTo(0.233, 2);
    expect(o.gapVsMove).toBeCloseTo(0.294, 2);
    expect(openPlan(o)).toMatch(/^Pre-market 773\.59 sits above yesterday's high \(PDH 772\.87\)\. A pullback that holds 772\.87/);
  });
  it("falls back to the close without a pre-market price, and reads inside the range", () => {
    const o = openRead("SPY", spyOpt, undefined);
    expect(o.premarket).toBeNull();
    expect(o.where).toBe("inside");
    expect(openPlan(o)).toMatch(/^The close, 771\.79, sits inside yesterday's range, 764\.43 to 772\.87/);
  });
  it("says nothing without levels", () => {
    const o = openRead("SPY", undefined, { symbol: "SPY", price: 700 });
    expect(o.where).toBeNull();
    expect(openPlan(o)).toBeNull();
  });
});

describe("the day's verdict", () => {
  const tsla: OptionsTicker = { symbol: "TSLA", last: { high: 363.75, low: 355.23, close: 362.44 }, expected_move: { day: 10.12 } };
  it("is red on a CPI morning", () => {
    const r = radar({ calendar: [{ date: "2026-10-14", time_et: "08:30", label: "CPI", kind: "macro", impact: "high" }] });
    const v = dayVerdict(r, ["SPY"], [], []);
    expect(v.word).toBe("Event day");
    expect(v.reasons[0]?.text).toBe("CPI 08:30: no entries until 30 minutes after");
  });
  it("is amber on the monthly expiry, on a big gap and on earnings from one of your names", () => {
    const r = radar({ edition_date: "2026-10-16" });
    const gap = openRead("TSLA", tsla, { symbol: "TSLA", premarket_price: 378.9 });
    const v = dayVerdict(r, ["SPY", "TSLA"], [gap], [{ date: "2026-10-16", symbol: "TSLA", when: "amc" }]);
    expect(v.word).toBe("Careful day");
    expect(v.reasons.map((x) => x.text)).toEqual([
      "Monthly options expiry",
      "TSLA reports today: no overnight holds",
      "TSLA gapped 1.6× its daily move: wait for a retest",
    ]);
  });
  // Every input the call reads, present and quiet: a dated release, an earnings row, a VIX move and a small gap.
  const quiet = () =>
    radar({
      calendar: [{ date: "2026-10-14", time_et: "10:00", label: "Business inventories", kind: "macro", impact: "low" }],
      gauges: [{ label: "VIX", value: "16.5", change: 0.2, change_unit: "pts" }],
    });
  const smallGap = () => openRead("SPY", spyOpt, { symbol: "SPY", premarket_price: 772.5 });
  it("ignores earnings from names you don't trade and is green on a quiet day", () => {
    const v = dayVerdict(quiet(), ["SPY"], [smallGap()], [{ date: "2026-10-14", symbol: "NFLX", when: "amc" }]);
    expect(v).toEqual({ tone: "good", word: "Normal day", reasons: [], unchecked: [] });
  });
  it("never calls a day normal when an input is missing", () => {
    const nflx = [{ date: "2026-10-14", symbol: "NFLX", when: "amc" }];
    // No earnings rows anywhere: "no report from your names" would be a guess.
    expect(dayVerdict(quiet(), ["SPY"], [smallGap()], [])).toEqual({
      tone: "neutral",
      word: "Not fully checked",
      reasons: [],
      unchecked: ["earnings dates (none in the calendars)"],
    });
    expect(dayVerdict(radar({ ...quiet(), gauges: [] }), ["SPY"], [smallGap()], nflx).unchecked).toEqual(["the VIX move"]);
    expect(dayVerdict(radar({ ...quiet(), calendar: [] }), ["SPY"], [smallGap()], nflx).unchecked).toEqual(["the release calendar"]);
    // No pre-market price, or no levels for the session: the gap rule could not run.
    const noPre = openRead("SPY", spyOpt, { symbol: "SPY" });
    const noOpt = openRead("SPY", undefined, { symbol: "SPY", premarket_price: 772.5, price: 771.79 });
    for (const read of [noPre, noOpt]) {
      expect(dayVerdict(quiet(), ["SPY"], [read], nflx).word).toBe("Not fully checked");
    }
    expect(dayVerdict(quiet(), ["SPY"], [], nflx).unchecked).toEqual(["pre-market gaps (no pre-market price or expected move)"]);
  });
  it("still names a rule that fired when something else is missing", () => {
    const v = dayVerdict(radar({ edition_date: "2026-10-16" }), ["SPY"], [], []);
    expect(v.word).toBe("Careful day");
    expect(v.reasons.map((x) => x.text)).toEqual(["Monthly options expiry"]);
    expect(v.unchecked.length).toBeGreaterThan(0);
  });
  it("finds the third Friday", () => {
    expect(isMonthlyExpiry("2026-10-16")).toBe(true);
    expect(isMonthlyExpiry("2026-10-09")).toBe(false);
    expect(isMonthlyExpiry("2026-10-23")).toBe(false);
    expect(isMonthlyExpiry("2026-10-15")).toBe(false);
  });
  it("moves the expiry to Thursday when the third Friday is a holiday", () => {
    // Good Friday 2025 fell on the third Friday of April.
    const goodFriday = new Set(["2025-04-18"]);
    expect(isMonthlyExpiry("2025-04-17", goodFriday)).toBe(true);
    expect(isMonthlyExpiry("2025-04-18", goodFriday)).toBe(false);
    expect(isMonthlyExpiry("2025-04-17")).toBe(false);
    // The radar's calendar is where the holiday comes from.
    const r = radar({ edition_date: "2025-04-17", calendar: [{ date: "2025-04-18", label: "Good Friday: market closed", kind: "holiday" }] });
    expect(holidaysOf(r)).toEqual(new Set(["2025-04-18"]));
    expect(dayVerdict(r, ["SPY"], [], []).reasons.map((x) => x.text)).toEqual(["Monthly options expiry"]);
  });
  it("reads the VIX move in percent from points", () => {
    expect(vixJumpPct(radar({ gauges: [{ label: "VIX", value: "22.0", change: 2, change_unit: "pts" }] }))).toBeCloseTo(10, 5);
    expect(vixJumpPct(radar({ gauges: [{ label: "VIX", value: "16.46", change: -2.43, change_unit: "pct" }] }))).toBe(-2.43);
    expect(vixJumpPct(radar())).toBeNull();
  });
});

describe("your names", () => {
  it("ranks by trades in the last 180 days, SPY first, with this year's and all-time results", () => {
    const t = [
      trade("TSLA", "2026-10-01T14:00:00Z", -50),
      trade("TSLA", "2026-10-02T14:00:00Z", 20),
      trade("META", "2026-10-03T14:00:00Z", 10),
      trade("SPY", "2026-10-05T14:00:00Z", 5),
      trade("AMD", "2025-01-05T15:00:00Z", -500),
    ];
    const n = yourNames(t, "2026-10-16", 3);
    expect(n.map((x) => x.symbol)).toEqual(["SPY", "TSLA", "META"]);
    expect(n[1]).toMatchObject({ yearTrades: 2, yearPnl: -30, allTrades: 2, allPnl: -30 });
  });
});

describe("the session record", () => {
  it("counts SPY same-day options by entry window and names the worst one with enough trades", () => {
    const t: Trade[] = [];
    for (let i = 0; i < 12; i++) t.push(trade("SPY", `2026-10-0${(i % 5) + 1}T16:${10 + i}:00Z`, -10)); // 12:10 NY
    for (let i = 0; i < 10; i++) t.push(trade("SPY", `2026-10-0${(i % 5) + 1}T13:${40 + i}:00Z`, 3)); // 09:40 NY
    const rec = sessionRecord(t);
    expect(rec.scope).toBe("SPY 0DTE");
    expect(rec.rows.find((r) => r.key === "lunch")).toMatchObject({ trades: 12, pnl: -120 });
    expect(rec.rows.find((r) => r.key === "open")).toMatchObject({ trades: 10, pnl: 30 });
    expect(rec.worst?.label).toBe("11:30–13:00");
  });
  it("names no worst window on a thin record", () => {
    expect(sessionRecord([trade("SPY", "2026-10-01T16:00:00Z", -10)]).worst).toBeNull();
  });
  it("turns today's timed releases into clock minutes", () => {
    const r = radar({
      calendar: [
        { date: "2026-10-14", time_et: "14:00", label: "FOMC decision", kind: "macro", impact: "high" },
        { date: "2026-10-14", time_et: "08:30", label: "Import prices", kind: "macro", impact: "medium" },
        { date: "2026-10-15", time_et: "08:30", label: "CPI", kind: "macro" },
      ],
    });
    expect(timedEvents(r)).toEqual([
      { minute: 510, label: "Import prices", tone: "warn" },
      { minute: 840, label: "FOMC decision", tone: "bad" },
    ]);
  });
  it("gives the Sydney clock for a New York time", () => {
    expect(sydneyAt("2026-10-16", 570)).toBe("Sat 00:30");
    expect(sydneyAt("2026-03-02", 570)).toBe("Tue 01:30");
  });
});

describe("movers and the week", () => {
  const opt = { schema: "stocksdelta/options", session: "2026-10-14", tickers: [spyOpt, { symbol: "TSLA", last: { high: 1, low: 1, close: 362.44 } }] } as OptionsEdition;
  it("measures the big names' pre-market moves from the levels' close, index funds left out", () => {
    const r = radar({
      lists: [{ name: "MEGA CAP OPTIONS", symbols: ["SPY", "TSLA", "AAPL", "NVDA"] }],
      tickers: [
        { symbol: "SPY", price: 771.79, premarket_price: 773.59 },
        { symbol: "TSLA", price: 999, premarket_price: 378.9, why: "No news." },
        { symbol: "AAPL", price: 342, premarket_price: 342.38 },
        { symbol: "NVDA", price: 217.23 },
      ],
    });
    const m = movers(r, opt);
    expect(m.map((x) => x.symbol)).toEqual(["TSLA", "AAPL"]);
    expect(m[0]?.pct).toBeCloseTo(4.54, 2);
  });
  it("merges earnings from both editions and marks your names", () => {
    const r = radar({ calendar: [{ date: "2026-10-15", label: "META", kind: "earnings" }, { date: "2026-10-28", time_et: "14:00", label: "FOMC decision", kind: "macro", impact: "high" }] });
    const o = { ...opt, events: [{ date: "2026-10-15", kind: "earnings", type: "earnings", symbol: "TSLA", when: "amc" }] } as OptionsEdition;
    const e = earningsOf(r, o);
    expect(e).toEqual([
      { date: "2026-10-15", symbol: "META", when: null },
      { date: "2026-10-15", symbol: "TSLA", when: "amc" },
    ]);
    const w = briefWeek(r, e, ["SPY", "TSLA"]);
    expect(w.days.map((d) => d.date)).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]);
    expect(w.days[1]?.earnings.map((x) => `${x.symbol}${x.yours ? "*" : ""}`)).toEqual(["TSLA*", "META"]);
    expect(w.later.map((x) => x.label)).toEqual(["FOMC decision"]);
  });
  it("reads the report time from the radar's label", () => {
    const r = radar({
      calendar: [
        { date: "2026-10-21", label: "TSLA after close", kind: "earnings", impact: "high" },
        { date: "2026-10-22", label: "NFLX before open", kind: "earnings" },
        { date: "2026-10-23", label: "META (estimated)", kind: "earnings", impact: "medium" },
      ],
    });
    expect(earningsOf(r, null)).toEqual([
      { date: "2026-10-21", symbol: "TSLA", when: "amc" },
      { date: "2026-10-22", symbol: "NFLX", when: "bmo" },
      { date: "2026-10-23", symbol: "META", when: null },
    ]);
  });
  it("works on the fixture edition", () => {
    const r = radarJson as unknown as Radar;
    expect(earningsOf(r, null).map((x) => x.symbol)).toEqual(["MU"]);
    // The fixture has no pre-market price for SPY, so the gap rule cannot run.
    expect(dayVerdict(r, ["SPY"], [], earningsOf(r, null)).word).toBe("Not fully checked");
  });
});

describe("the brief's panels say what they could not check", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
  const panel = (verdict: ReturnType<typeof dayVerdict>) => html(createElement(VerdictPanel, { verdict, vix: null, vixChange: null, spyMove: null, regime: null }));
  it("never shows the all-clear badge on an unchecked day", () => {
    const out = panel(dayVerdict(radar(), ["SPY"], [], []));
    expect(out).toContain("Not fully checked");
    expect(out).toContain("Could not check: the release calendar; earnings dates (none in the calendars); the VIX move;");
    expect(out).toContain("So the day is not called normal.");
    expect(out).not.toContain("no earnings on your names");
  });
  it("keeps the all-clear badge for a fully checked quiet day", () => {
    const r = radar({
      calendar: [{ date: "2026-10-14", time_et: "10:00", label: "Business inventories", kind: "macro", impact: "low" }],
      gauges: [{ label: "VIX", value: "16.5", change: 0.2, change_unit: "pts" }],
    });
    const out = panel(dayVerdict(r, ["SPY"], [openRead("SPY", spyOpt, { symbol: "SPY", premarket_price: 772.5 })], [{ date: "2026-10-20", symbol: "NFLX", when: "amc" }]));
    expect(out).toContain("Normal day");
    expect(out).toContain("no earnings on your names");
    expect(out).not.toContain("Could not check");
  });
  it("warns that the week may be missing a report when no calendar has earnings", () => {
    const w = briefWeek(radar(), [], ["SPY"]);
    const none = html(createElement(WeekPanel, { days: w.days, later: w.later, today: "2026-10-14", earningsKnown: false }));
    expect(none).toContain("Neither calendar carries earnings dates");
    const some = html(createElement(WeekPanel, { days: w.days, later: w.later, today: "2026-10-14", earningsKnown: true }));
    expect(some).not.toContain("Neither calendar carries earnings dates");
  });
});
