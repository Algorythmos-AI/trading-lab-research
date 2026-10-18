import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LevelMap, VerdictPanel, WeekAhead, YourNames } from "@/components/radar-brief";
import type { JournalDoc, Trade } from "@/lib/journal";
import type { Options } from "@/lib/options";
import type { Radar } from "@/lib/radar";
import {
  dayVerdict,
  earningsAhead,
  earningsFor,
  gapInMoves,
  hasEarningsData,
  levelLadder,
  matchingOptions,
  megaMovers,
  monthlyExpiry,
  nameRows,
  vixChangePct,
  windowRecord,
  yourNames,
} from "@/lib/radar-brief";
import journalJson from "./fixtures/journal.v1.json";
import optionsJson from "./fixtures/options.v1.json";
import radarJson from "./fixtures/radar.v1.json";

// The fixtures are synthetic. The radar is for Mon 21 Sep 2026; the options edition is for another session, so a
// test that needs both on one day moves the options edition onto the radar's date.
const radar = radarJson as unknown as Radar;
const options = optionsJson as unknown as Options;
const journal = journalJson as unknown as JournalDoc;
const NOW = new Date("2026-10-18T12:00:00Z");

function onDay(date = radar.edition_date): { r: Radar; o: Options } {
  const r = structuredClone(radar);
  r.edition_date = date;
  const o = structuredClone(options);
  o.session = date;
  return { r, o };
}

function setPre(r: Radar, symbol: string, pre: number, price?: number) {
  const t = r.tickers!.find((x) => x.symbol === symbol)!;
  t.premarket_price = pre;
  if (price !== undefined) t.price = price;
}

// SPY in the options fixture: close 778.55, one-day expected move 5.85.
const SPY_CLOSE = 778.55;
const SPY_MOVE = 5.85;

describe("monthly expiry", () => {
  it("is the third Friday", () => {
    expect(monthlyExpiry("2026-10-01")).toBe("2026-10-16");
    expect(monthlyExpiry("2026-09-30")).toBe("2026-09-18");
    // A month that starts on a Friday.
    expect(monthlyExpiry("2026-05-12")).toBe("2026-05-15");
  });
  it("moves to Thursday when that Friday is a holiday", () => {
    expect(monthlyExpiry("2025-04-02", new Set(["2025-04-18"]))).toBe("2025-04-17");
  });
});

describe("VIX change", () => {
  it("turns points into percent of the prior level", () => {
    // Fixture: 17.4 after +0.33 points.
    expect(vixChangePct(radar.gauges)).toBeCloseTo((0.33 / 17.07) * 100, 6);
  });
  it("passes percent through and gives up without a level", () => {
    expect(vixChangePct([{ label: "VIX", value: "18", change: 12.5, change_unit: "pct" }])).toBe(12.5);
    expect(vixChangePct([{ label: "VIX", value: "n/a", change: 1, change_unit: "pts" }])).toBeNull();
    expect(vixChangePct([{ label: "VIX", value: "18", change: 1 }])).toBeNull();
    expect(vixChangePct([{ label: "S&P 500", value: "6,612", change: -0.4, change_unit: "pct" }])).toBeNull();
    expect(vixChangePct(null)).toBeNull();
  });
});

describe("earnings", () => {
  const e = (label: string) => ({ date: "2026-10-21", label, kind: "earnings" as const });
  it("matches the symbol as a whole word only", () => {
    expect(earningsFor(e("TSLA"), "TSLA")).toBe(true);
    expect(earningsFor(e("META, TSLA after close"), "META")).toBe(true);
    expect(earningsFor(e("TSLAX"), "TSLA")).toBe(false);
    expect(earningsFor(e("SPYG"), "SPY")).toBe(false);
    expect(earningsFor({ ...e("TSLA"), kind: "macro" }, "TSLA")).toBe(false);
  });
  it("lists the names' reports from a date on, nearest first", () => {
    const r = structuredClone(radar);
    r.calendar = [e("META"), { ...e("TSLA"), date: "2026-10-20" }, { ...e("TSLA"), date: "2026-09-01" }];
    expect(earningsAhead(r, ["TSLA", "META"], "2026-10-19").map((x) => [x.symbol, x.event.date])).toEqual([
      ["TSLA", "2026-10-20"],
      ["META", "2026-10-21"],
    ]);
    expect(hasEarningsData(r)).toBe(true);
    r.calendar = r.calendar.map((x) => ({ ...x, kind: "macro" as const }));
    expect(hasEarningsData(r)).toBe(false);
  });
});

describe("the day's verdict", () => {
  it("is not called normal when an input is missing", () => {
    // No options edition for the radar's day: gaps cannot be checked.
    const v = dayVerdict(radar, options, ["SPY"]);
    expect(matchingOptions(radar, options)).toBeNull();
    expect(v.level).toBe("unchecked");
    expect(v.unknown.join(" ")).toMatch(/pre-market gaps/);
  });

  it("is normal only with every input there and no rule fired", () => {
    const { r, o } = onDay();
    setPre(r, "SPY", SPY_CLOSE + 0.5);
    expect(dayVerdict(r, o, ["SPY"])).toEqual({ level: "green", reasons: [], unknown: [] });
  });

  it("is careful on a gap past 80% of the daily move", () => {
    const { r, o } = onDay();
    setPre(r, "SPY", SPY_CLOSE - SPY_MOVE * 0.9);
    const v = dayVerdict(r, o, ["SPY"]);
    expect(v.level).toBe("amber");
    expect(v.reasons[0]!.text).toBe("SPY gapped down 0.9× its daily move");
  });

  it("stands aside on a PCE day, red reasons first", () => {
    // The fixture calendar has PCE inflation at 08:30 on Fri 25 Sep.
    const { r, o } = onDay("2026-09-25");
    setPre(r, "SPY", SPY_CLOSE + SPY_MOVE);
    const v = dayVerdict(r, o, ["SPY"]);
    expect(v.level).toBe("red");
    expect(v.reasons.map((x) => x.level)).toEqual(["red", "amber"]);
    expect(v.reasons[0]!.text).toBe("PCE inflation at 08:30 NY");
  });

  it("is careful on the monthly expiry, a VIX jump and earnings today", () => {
    const { r, o } = onDay("2026-09-18");
    setPre(r, "SPY", SPY_CLOSE);
    r.gauges = [{ label: "VIX", value: "17.4", change: 2, change_unit: "pts" }];
    r.calendar = [...(r.calendar ?? []), { date: "2026-09-18", label: "SPY", kind: "earnings", time_et: "16:05" }];
    const texts = dayVerdict(r, o, ["SPY"]).reasons.map((x) => x.text);
    expect(texts).toEqual(["Monthly options expiry", "SPY reports earnings today (16:05 NY)", "VIX up 13.0%"]);
  });

  it("says earnings were not checked when the calendar carries none", () => {
    const { r, o } = onDay();
    setPre(r, "SPY", SPY_CLOSE);
    r.calendar = (r.calendar ?? []).filter((e) => e.kind !== "earnings");
    const v = dayVerdict(r, o, ["SPY"]);
    expect(v.level).toBe("unchecked");
    expect(v.unknown).toEqual(["earnings dates (not in today's calendar)"]);
  });

  it("says gaps were not checked without pre-market prices", () => {
    const { r, o } = onDay();
    expect(dayVerdict(r, o, ["SPY"]).unknown).toEqual(["pre-market gaps (no pre-market prices)"]);
  });
});

describe("the level ladder", () => {
  const spy = options.tickers.find((t) => t.symbol === "SPY")!;
  it("splits the named levels around pre-market", () => {
    const lad = levelLadder(spy, 780)!;
    expect(lad.ref).toBe(780);
    expect(lad.down).toMatchObject({ code: "PDH", price: 779.4 });
    expect(lad.up).toMatchObject({ code: "PWH", price: 781.62 });
    expect(lad.band![0]).toBeCloseTo(SPY_CLOSE - SPY_MOVE, 6);
    // PMH is last month's high, never a pre-market high.
    expect(lad.rungs.find((x) => x.code === "PMH")!.label).toBe("last month's high");
    expect(lad.rungs.map((x) => x.code)).not.toContain("PDC");
  });
  it("uses the close without a pre-market price", () => {
    const lad = levelLadder(spy, null)!;
    expect(lad.ref).toBe(SPY_CLOSE);
    expect(lad.up?.code).toBe("PDH");
    expect(lad.down?.code).toBe("PDL");
  });
  it("is null without a close", () => {
    expect(levelLadder({ ...spy, last: null }, 780)).toBeNull();
  });
  it("measures the gap in daily moves", () => {
    expect(gapInMoves({ symbol: "SPY", premarket_price: SPY_CLOSE + SPY_MOVE }, spy)).toBeCloseTo(1, 6);
    expect(gapInMoves({ symbol: "SPY" }, spy)).toBeNull();
    expect(gapInMoves(undefined, spy)).toBeNull();
  });
});

const trade = (over: Partial<Trade>): Trade => ({
  id: Math.random().toString(36).slice(2),
  symbol: "SPY",
  kind: "call",
  strike: 770,
  expiry: "2026-10-14",
  side: "long",
  qty: 1,
  opened_at: "2026-10-14T15:40:00Z",
  closed_at: "2026-10-14T15:50:00Z",
  entry: 1,
  exit: 1,
  multiplier: 100,
  pnl: 0,
  close: "order",
  ...over,
});
const doc = (trades: Trade[]): JournalDoc => ({ ...structuredClone(journal), trades });

describe("your names and your session", () => {
  it("ranks this year's names by trade count", () => {
    expect(yourNames(journal, NOW).map((x) => x.key)).toEqual(["SPY", "QQQ", "TSLA", "NVDA", "AAPL"]);
    expect(yourNames(null, NOW)).toEqual([]);
  });
  it("falls back to every trade early in a year with none", () => {
    expect(yourNames(journal, new Date("2027-01-02T12:00:00Z")).map((x) => x.key)).toEqual(["SPY", "QQQ", "TSLA", "NVDA", "AAPL"]);
  });
  it("buckets same-day options by entry time and names the worst band", () => {
    // 11:40 New York (EDT) is 15:40Z.
    const at11 = Array.from({ length: 5 }, () => trade({ pnl: -20 }));
    const at10 = Array.from({ length: 6 }, () => trade({ opened_at: "2026-10-14T14:10:00Z", pnl: -5 }));
    const small = [trade({ opened_at: "2026-10-14T17:10:00Z", pnl: -500 })];
    const notSameDay = [trade({ expiry: "2026-10-16", pnl: -1000 }), trade({ kind: "stock", expiry: null, pnl: -1000 })];
    const rec = windowRecord(doc([...at11, ...at10, ...small, ...notSameDay]), NOW);
    expect(rec.trades).toBe(12);
    expect(rec.rows.map((r) => r.key)).toEqual(["open", "10", "11", "12", "13", "14", "15"]);
    expect(rec.rows.find((r) => r.key === "11")).toMatchObject({ trades: 5, pnl: -100 });
    // The 1 pm band lost most but has one trade, so it is not called the worst.
    expect(rec.worst).toBe("11");
    expect(windowRecord(doc([]), NOW)).toMatchObject({ trades: 0, worst: null });
  });
});

describe("rows and movers", () => {
  it("puts each name against its levels with this week's earnings", () => {
    const { r, o } = onDay();
    setPre(r, "SPY", 780);
    r.calendar = [...(r.calendar ?? []), { date: "2026-09-23", label: "TSLA", kind: "earnings", time_et: "16:10" }, { date: "2026-10-30", label: "SPY", kind: "earnings" }];
    const rows = nameRows(r, o, yourNames(journal, NOW).slice(0, 3));
    const spy = rows.find((x) => x.symbol === "SPY")!;
    expect(spy).toMatchObject({ pre: 780, down: { code: "PDH" }, up: { code: "PWH" }, move: SPY_MOVE, earnings: null });
    expect(rows.find((x) => x.symbol === "TSLA")!.earnings?.date).toBe("2026-09-23");
    // QQQ has no pre-market price in the fixture: no gap, levels from the close.
    expect(rows.find((x) => x.symbol === "QQQ")).toMatchObject({ pre: null, gap: null });
  });
  it("leaves levels out when the options edition is for another session", () => {
    const rows = nameRows(radar, options, yourNames(journal, NOW).slice(0, 1));
    expect(rows[0]).toMatchObject({ symbol: "SPY", up: null, down: null, move: null });
  });
  it("orders the mega caps by pre-market move and skips names without one", () => {
    const r = structuredClone(radar);
    setPre(r, "TSLA", 110, 100);
    setPre(r, "SPY", 99, 100);
    expect(megaMovers(r).map((m) => m.symbol)).toEqual(["TSLA", "AMZN", "SPY"]);
    expect(megaMovers(r)[0]!.pct).toBeCloseTo(10, 6);
  });
});

describe("the brief's panels", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
  it("prints the rules and what it could not check", () => {
    const out = html(createElement(VerdictPanel, { v: dayVerdict(radar, options, ["SPY"]), regime: "neutral", vix: "17.4" }));
    expect(out).toContain("Not fully checked");
    expect(out).toContain("Could not check: pre-market gaps");
    expect(out).toContain("Rules: stand aside on an FOMC, CPI, payrolls or PCE day");
  });
  it("says when the levels are for another session", () => {
    const spy = options.tickers.find((t) => t.symbol === "SPY")!;
    const out = html(createElement(LevelMap, { symbol: "SPY", lad: levelLadder(spy, null), session: options.session, current: false }));
    expect(out).toContain("not this edition");
    expect(out).toContain("PDH 779.40");
    expect(html(createElement(LevelMap, { symbol: "SPY", lad: null, session: null, current: false }))).toContain("not available");
  });
  it("never claims an empty week when the calendar has no earnings", () => {
    const r = structuredClone(radar);
    r.calendar = [];
    const out = html(createElement(WeekAhead, { r, earningsKnown: false }));
    expect(out).not.toContain("Nothing dated");
    expect(out).toContain("carries no earnings dates");
    const names = html(createElement(YourNames, { rows: nameRows(r, null, yourNames(journal, NOW)), journal: true, earningsKnown: false }));
    expect(names).toContain("Earnings dates are not in today");
  });
  it("draws without a journal", () => {
    expect(html(createElement(YourNames, { rows: [], journal: false, earningsKnown: true }))).toContain("journal is not available");
  });
});
