import { describe, expect, it } from "vitest";
import type { Trade } from "@/lib/journal";
import { hourBands, keptStreak, keptVsBroken, nextOpen, periodTotals, quickVsSlow, ruleDays, tickerEnds, untilText, weekStart, withRun } from "@/lib/overview";

let n = 0;
const trade = (pnl: number, opened: string, closed: string, extra: Partial<Trade> = {}): Trade => ({
  id: `t${++n}`,
  symbol: "SPY",
  kind: "call",
  strike: 760,
  expiry: closed.slice(0, 10),
  side: "long",
  qty: 1,
  opened_at: opened,
  closed_at: closed,
  entry: 1,
  exit: 1 + pnl / 100,
  multiplier: 100,
  pnl,
  close: "order",
  ...extra,
});

// New York is UTC-4 in October: 14:00Z is 10:00 in New York.
const at = (day: string, ny: string) => `${day}T${String(Number(ny.slice(0, 2)) + 4).padStart(2, "0")}:${ny.slice(3)}:00Z`;

describe("periods", () => {
  it("starts the week on Monday", () => {
    expect(weekStart("2026-10-16")).toBe("2026-10-12");
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12");
  });

  it("adds each trade to every period it falls in, by the New York close day", () => {
    const trades = [
      trade(10, at("2026-10-16", "10:00"), at("2026-10-16", "10:03")),
      trade(-30, at("2026-10-09", "10:00"), at("2026-10-09", "10:03")),
      trade(5, at("2026-03-02", "10:00"), at("2026-03-02", "10:03")),
      trade(-100, at("2025-06-02", "10:00"), at("2025-06-02", "10:03")),
    ];
    const p = periodTotals(trades, new Date("2026-10-17T12:00:00Z"));
    expect(p.map((x) => [x.key, x.pnl, x.trades])).toEqual([
      ["week", 10, 1],
      ["month", -20, 2],
      ["year", -15, 3],
      ["all", -115, 4],
    ]);
    expect(p[1]!.label).toBe("October");
  });
});

describe("day rules", () => {
  const day = (d: string, pnls: number[]) => pnls.map((p, i) => trade(p, at(d, `10:0${i}`), at(d, `10:1${i}`)));
  const trades = [
    ...day("2026-10-12", [20]),
    ...day("2026-10-13", [-60, -50]), // lost more than $100
    ...day("2026-10-14", [1, 1, 1, 1, 1, 1]), // six trades
    ...day("2026-10-15", [-20]),
    ...day("2026-10-16", [30]),
  ];

  it("marks each day kept or broken, and counts the streak back from the latest", () => {
    const days = ruleDays(trades);
    expect(days.map((d) => [d.day, d.kept, d.broke])).toEqual([
      ["2026-10-12", true, null],
      ["2026-10-13", false, "loss"],
      ["2026-10-14", false, "count"],
      ["2026-10-15", true, null],
      ["2026-10-16", true, null],
    ]);
    expect(keptStreak(days)).toBe(2);
    expect(keptVsBroken(days)).toEqual({ kept: 3, keptPnl: 30, broken: 2, brokenPnl: -104 });
    expect(withRun(days).map((d) => d.run)).toEqual([20, -90, -84, -104, -74]);
  });

  it("keeps only the latest days asked for", () => {
    expect(ruleDays(trades, 2).map((d) => d.day)).toEqual(["2026-10-15", "2026-10-16"]);
  });
});

describe("next open", () => {
  it("counts to Monday's open over a weekend", () => {
    // Sat 17 Oct 19:21 New York.
    const o = nextOpen(new Date("2026-10-17T23:21:00Z"));
    expect(o).toEqual({ open: false, day: "2026-10-19", minutes: 2 * 1440 + 570 - (19 * 60 + 21) });
    expect(untilText(o.minutes)).toBe("1 d 14 h");
  });

  it("counts to the close while the session is open, and to today's open before it", () => {
    expect(nextOpen(new Date("2026-10-16T19:00:00Z"))).toEqual({ open: true, day: "2026-10-16", minutes: 60 });
    expect(nextOpen(new Date("2026-10-16T12:00:00Z"))).toEqual({ open: false, day: "2026-10-16", minutes: 90 });
    expect(nextOpen(new Date("2026-10-16T21:00:00Z")).day).toBe("2026-10-19");
    expect(untilText(25)).toBe("25 min");
    expect(untilText(190)).toBe("3 h 10 min");
  });
});

describe("patterns", () => {
  const trades = [
    trade(50, at("2026-10-16", "09:35"), at("2026-10-16", "09:37"), { symbol: "PLTR" }),
    trade(-80, at("2026-10-16", "10:10"), at("2026-10-16", "10:40"), { symbol: "AMD" }),
    trade(-10, at("2026-10-15", "15:10"), at("2026-10-15", "15:12"), { symbol: "SPY" }),
    trade(20, at("2026-10-15", "15:20"), at("2026-10-15", "15:22"), { symbol: "SPY" }),
  ];

  it("names the best and worst hour and leaves out empty extended hours", () => {
    const h = hourBands(trades);
    expect(h.rows.map((r) => r.key)).toEqual(["open", "10", "11", "12", "13", "14", "15"]);
    expect(h.best?.key).toBe("open");
    expect(h.worst?.key).toBe("10");
  });

  it("splits quick exits from slow ones at the time stop", () => {
    expect(quickVsSlow(trades)).toEqual({ quick: { trades: 3, pnl: 60 }, slow: { trades: 1, pnl: -80 } });
  });

  it("lists winners best first, then losers, with no ticker twice", () => {
    expect(tickerEnds(trades, 4).map((g) => [g.key, g.pnl])).toEqual([
      ["PLTR", 50],
      ["SPY", 10],
      ["AMD", -80],
    ]);
  });
});
