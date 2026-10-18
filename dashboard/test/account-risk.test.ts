import { describe, expect, it } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import { accountRisk, drawdown, openRisk } from "@/lib/account-risk";
import { daily, type JournalDoc, type Lot, type Trade } from "@/lib/journal";

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
const at = (day: string, hh: number, mm: number) => `${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`;
const quick = (pnl: number, day: string, m: number, extra: Partial<Trade> = {}) => trade(pnl, at(day, 14, m), at(day, 14, m + 2), extra);

describe("account risk", () => {
  it("counts each limit over the recent days", () => {
    const trades = [
      // 14 Oct: six trades, down $130, one loser past $50 and past the 25% stop.
      ...[1, 4, 7, 10, 13].map((m) => quick(-10, "2026-10-14", m)),
      quick(-80, "2026-10-14", 20, { entry: 2, exit: 1.6 }),
      // 15 Oct: one winner on $250 of premium, one slow loser.
      quick(40, "2026-10-15", 1, { entry: 2.5, exit: 2.9 }),
      trade(-5, at("2026-10-15", 15, 0), at("2026-10-15", 15, 30)),
      // An option held overnight.
      trade(20, at("2026-10-15", 19, 0), at("2026-10-16", 14, 0)),
    ];
    const r = accountRisk({ trades, open: [] }, new Date("2026-10-17T15:00:00Z"));
    const by = Object.fromEntries(r.limits.map((l) => [l.id, l]));
    expect(by["day-stop"]!.broken).toBe(1);
    expect(by["day-stop"]!.worst).toBe("worst −$130");
    expect(by["day-cap"]!.broken).toBe(1);
    expect(by.risk!.broken).toBe(1);
    expect(by.premium!.broken).toBe(1);
    expect(by.stop!.broken).toBe(0); // −20% of premium is inside the stop
    expect(by.time!.broken).toBe(1);
    expect(by.flat!.broken).toBe(1);
    expect(r.recent.map((d) => d.day)).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    // 17 Oct has no trades: a fresh day, no reading today.
    expect(r.check.isToday).toBe(false);
    expect(by["day-stop"]!.today).toBeNull();
  });

  it("reads today's usage when today has trades", () => {
    const trades = [quick(-30, "2026-10-16", 1), quick(-45, "2026-10-16", 5)];
    const r = accountRisk({ trades, open: [] }, new Date("2026-10-16T15:00:00Z"));
    const by = Object.fromEntries(r.limits.map((l) => [l.id, l]));
    expect(r.check.isToday).toBe(true);
    expect(r.check.status).toBe("careful");
    expect(by["day-stop"]!.today).toBe("−$75");
    expect(by["day-stop"]!.todayShare).toBeCloseTo(0.75);
    expect(by["day-cap"]!.today).toBe("2");
    expect(by.risk!.today).toBe("worst −$45");
  });

  it("totals open option cost and flags overnight and oversize lots", () => {
    const lots: Lot[] = [
      { symbol: "SPY", kind: "put", strike: 750, expiry: "2026-10-16", side: "long", qty: 1, entry: 1.2, opened_at: "2026-10-16T14:00:00Z" },
      { symbol: "SPY", kind: "put", strike: 750, expiry: "2026-10-16", side: "long", qty: 1, entry: 1.0, opened_at: "2026-10-16T14:05:00Z" },
      { symbol: "TSLA", kind: "call", strike: 300, expiry: "2026-10-23", side: "long", qty: 1, entry: 0.5, opened_at: "2026-10-15T14:00:00Z" },
      { symbol: "AAPL", kind: "stock", side: "long", qty: 10, entry: 200, opened_at: "2026-10-01T14:00:00Z" },
    ];
    const o = openRisk(lots, "2026-10-16");
    expect(o.optionCost).toBeCloseTo(270);
    expect(o.overnight).toBe(1);
    expect(o.uncapped).toBe(1);
    const spy = o.lots.find((l) => l.label.startsWith("SPY"))!;
    expect(spy.qty).toBe(2);
    expect(spy.overPremium).toBe(true);
    expect(o.lots.find((l) => l.label.startsWith("TSLA"))!.overnight).toBe(true);
  });

  it("measures the fall from the high", () => {
    const days = daily([quick(100, "2026-10-12", 1), quick(-150, "2026-10-13", 1), quick(30, "2026-10-14", 1)]);
    expect(drawdown(days)).toEqual({ now: -120, max: -150, maxDay: "2026-10-13", peak: 100, peakDay: "2026-10-12" });
  });

  it("runs over the fixture without throwing", () => {
    const r = accountRisk(fixtureDoc as unknown as JournalDoc, new Date("2026-10-16T20:00:00Z"));
    expect(r.limits).toHaveLength(7);
    expect(r.recent.length).toBeGreaterThan(0);
    expect(r.recent.length).toBeLessThanOrEqual(20);
  });
});
