import { describe, expect, it } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import { sessionView, type JournalDoc, type Trade } from "@/lib/journal";
import {
  breakSummary,
  DAY_LOSS_LIMIT,
  dayCheck,
  GROUPS,
  MAX_PREMIUM,
  MAX_TRADES_PER_DAY,
  PLAN_EXAMPLE,
  planNumbers,
  PREMIUM_STOP,
  replayDayStop,
  RISK_PER_TRADE,
  ruleEvidence,
  RULES,
  tradeBreaks,
} from "@/lib/trade-rules";

let n = 0;
const trade = (
  pnl: number,
  opened: string,
  closed: string,
  extra: Partial<Trade> = {},
): Trade => ({
  id: `r${++n}`,
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

describe("the rules", () => {
  it("are nine, numbered in order, three to each group", () => {
    expect(RULES.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const g of GROUPS)
      expect(RULES.filter((r) => r.group === g.id)).toHaveLength(3);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(9);
  });

  it("say who holds each one: the setup is yours to check, the rest the journal can flag", () => {
    expect(
      RULES.filter((r) => r.group === "setup").every((r) => r.check === "you"),
    ).toBe(true);
    expect(
      RULES.filter((r) => r.group !== "setup").every((r) => r.check !== "you"),
    ).toBe(true);
  });

  it("work out the owner's example plan: $165 premium, $16.50 at risk, $33 target, 2:1", () => {
    const p = planNumbers(
      PLAN_EXAMPLE.premium,
      PLAN_EXAMPLE.stopShare,
      PLAN_EXAMPLE.targetShare,
    );
    expect(p.risk).toBeCloseTo(16.5);
    expect(p.reward).toBeCloseTo(33);
    expect(p.ratio).toBeCloseTo(2);
    expect(p.ok).toBe(true);
    expect(planNumbers(165, 0.1, 0.15).ok).toBe(false);
    expect(planNumbers(400, 0.25, 0.5).ok).toBe(false); // $100 at risk
  });

  it("cap a trade's loss: the largest premium at the stop costs no more than the risk per trade", () => {
    expect(MAX_PREMIUM * PREMIUM_STOP).toBeLessThanOrEqual(RISK_PER_TRADE);
  });
});

describe("replayDayStop", () => {
  it("skips trades opened after the day's earlier closes lost the limit, and keeps the rest", () => {
    const ts = [
      trade(-80, "2026-10-14T14:00:00Z", "2026-10-14T14:05:00Z"),
      trade(-40, "2026-10-14T14:10:00Z", "2026-10-14T14:20:00Z"), // opened at −80: kept
      trade(-200, "2026-10-14T14:30:00Z", "2026-10-14T14:40:00Z"), // opened at −120: skipped
      trade(50, "2026-10-14T14:12:00Z", "2026-10-14T14:50:00Z"), // opened at −80 (the −40 had not closed yet): kept
      trade(-200, "2026-10-15T14:00:00Z", "2026-10-15T14:05:00Z"), // a new day starts fresh
    ];
    const r = replayDayStop(ts, 100);
    expect(r).toEqual({ kept: 4, skipped: 1, net: -270, skippedNet: -200 });
  });
});

describe("tradeBreaks", () => {
  it("names each rule a trade broke, keeps clean losers out, and ends the day at the first break", () => {
    const ts = [
      trade(-10, "2026-10-14T14:00:00Z", "2026-10-14T14:02:00Z"), // a clean loss
      trade(-30, "2026-10-14T14:05:00Z", "2026-10-14T14:15:00Z", { exit: 0.7 }), // held 10 min and lost: rule 6, and down 30%: rule 5
      trade(25, "2026-10-14T14:20:00Z", "2026-10-14T14:21:00Z"), // a winner, but after a break: rule 7
      trade(-60, "2026-10-15T14:00:00Z", "2026-10-15T14:03:00Z", {
        exit: 0.4,
        entry: 1,
      }), // lost more than $50 (and past −25%)
      trade(5, "2026-10-15T19:00:00Z", "2026-10-16T14:00:00Z", {
        expiry: "2026-10-17",
        entry: 2.5,
        exit: 2.55,
      }), // overnight; premium $250: rules 4, 9
    ];
    const b = tradeBreaks(ts);
    expect(b.has(ts[0]!.id)).toBe(false);
    expect(b.get(ts[1]!.id)!.sort()).toEqual(["stop", "time"]);
    expect(b.get(ts[2]!.id)).toEqual(["day-stop"]);
    expect(b.get(ts[3]!.id)!.sort()).toEqual(["risk", "stop"]);
    expect(b.get(ts[4]!.id)!.sort()).toEqual(["day-stop", "flat", "risk"]);
  });

  it("counts entries past the day's cap", () => {
    const ts = Array.from({ length: MAX_TRADES_PER_DAY + 1 }, (_, i) =>
      trade(
        5,
        `2026-10-14T14:${String(i * 3).padStart(2, "0")}:00Z`,
        `2026-10-14T14:${String(i * 3 + 1).padStart(2, "0")}:00Z`,
      ),
    );
    const b = tradeBreaks(ts);
    expect([...b.values()]).toEqual([["day-cap"]]);
  });

  it("sums breaks apart from losses over the recent sessions", () => {
    const ts = [
      trade(-10, "2026-10-14T14:00:00Z", "2026-10-14T14:02:00Z"),
      trade(-80, "2026-10-14T14:05:00Z", "2026-10-14T14:07:00Z", { exit: 0.9 }),
    ];
    expect(breakSummary(ts)).toEqual({
      sessions: 1,
      trades: 1,
      byRule: { risk: 1 },
      brokeNet: -80,
      keptNet: -10,
      keptLosers: 1,
      keptLosersNet: -10,
    });
  });
});

describe("ruleEvidence", () => {
  it("always has the backtest rules, and nothing of the owner's with too few trades", () => {
    const ev = ruleEvidence([
      trade(10, "2026-10-14T14:00:00Z", "2026-10-14T14:01:00Z"),
    ]);
    expect(Object.keys(ev).sort()).toEqual(["levels", "retest"]);
    expect(ev.levels!.source).toBe("backtest");
  });

  it("measures each rule from the trades, comparing like with like", () => {
    const ts: Trade[] = [];
    for (let d = 1; d <= 30; d++) {
      const day = `2026-${d > 28 ? "10" : "09"}-${String(d > 28 ? d - 28 : d).padStart(2, "0")}`;
      // Every day: a quick win, and a slow loser held past the premium stop.
      ts.push(trade(20, `${day}T14:00:00Z`, `${day}T14:02:00Z`));
      ts.push(trade(-60, `${day}T14:10:00Z`, `${day}T14:40:00Z`));
      // Half the days are busy and end badly; on those the trades after the −$100 mark lose more.
      if (d % 2 === 0)
        for (let k = 0; k < 6; k++)
          ts.push(
            trade(
              -30,
              `${day}T15:${10 + k * 5}:00Z`,
              `${day}T15:${12 + k * 5}:00Z`,
            ),
          );
      // Some options are carried overnight and lose.
      if (d % 2 === 1 && d < 19)
        ts.push(
          trade(
            -15,
            `${day}T19:00:00Z`,
            `2026-09-${String(d + 1).padStart(2, "0")}T14:00:00Z`,
          ),
        );
    }
    const ev = ruleEvidence(ts);
    for (const id of [
      "room",
      "risk",
      "stop",
      "time",
      "day-stop",
      "day-cap",
      "flat",
    ])
      expect(ev[id], id).toBeDefined();
    expect(ev.time!.compare!.a.value).toBeGreaterThan(
      ev.time!.compare!.b.value,
    );
    expect(ev["day-stop"]!.compare!.a.value).toBeGreaterThan(
      ev["day-stop"]!.compare!.b.value,
    );
    expect(ev["day-cap"]!.compare!.a.value).toBeGreaterThan(
      ev["day-cap"]!.compare!.b.value,
    );
    expect(ev.flat!.finding).toMatch(/held overnight/);
    expect(ev.room!.compare!.b.value).toBeLessThan(0);
  });

  it("draws from the fixture without failing", () => {
    expect(() =>
      ruleEvidence((fixtureDoc as unknown as JournalDoc).trades),
    ).not.toThrow();
  });
});

describe("dayCheck", () => {
  const now = new Date("2026-10-16T16:00:00Z");
  it("starts a fresh day when the session on show is an earlier one", () => {
    const old = trade(-500, "2026-10-15T14:00:00Z", "2026-10-15T14:30:00Z");
    const c = dayCheck(sessionView({ trades: [old], open: [] }, now));
    expect(c).toMatchObject({ isToday: false, used: 0, status: "clear" });
  });

  it("is clear with room left, careful near a limit, and stops at either limit", () => {
    // Inside the premium stop, so only the day rules are in play.
    const t = (pnl: number, m: number) =>
      trade(
        pnl,
        `2026-10-16T14:${String(m).padStart(2, "0")}:00Z`,
        `2026-10-16T14:${String(m + 1).padStart(2, "0")}:00Z`,
        { exit: 0.9 },
      );
    expect(
      dayCheck(sessionView({ trades: [t(-20, 0)], open: [] }, now)),
    ).toMatchObject({ used: 1, status: "clear" });
    expect(
      dayCheck(sessionView({ trades: [t(-45, 0), t(-20, 5)], open: [] }, now))
        .status,
    ).toBe("careful");
    expect(
      dayCheck(sessionView({ trades: [t(-50, 0), t(-50, 5)], open: [] }, now)),
    ).toMatchObject({ status: "stop", net: -DAY_LOSS_LIMIT, brokenRules: [] });
    const many = Array.from({ length: MAX_TRADES_PER_DAY }, (_, i) =>
      t(5, i * 3),
    );
    expect(
      dayCheck(sessionView({ trades: many, open: [] }, now)),
    ).toMatchObject({ used: MAX_TRADES_PER_DAY, status: "stop" });
    expect(
      dayCheck(sessionView({ trades: many.slice(1), open: [] }, now)).status,
    ).toBe("careful");
  });

  it("stops the day at the first broken rule, whatever the result", () => {
    const big = trade(-70, "2026-10-16T14:00:00Z", "2026-10-16T14:02:00Z", {
      exit: 0.9,
    });
    const c = dayCheck(sessionView({ trades: [big], open: [] }, now));
    expect(c).toMatchObject({ status: "stop", breaks: 1, brokenRules: [4] });
    expect(c.line).toMatch(/^Rule 4 broken/);
  });

  it("counts a lot opened today and still held as a trade taken", () => {
    const lot = {
      symbol: "SPY",
      kind: "put" as const,
      strike: 750,
      expiry: "2026-10-16",
      side: "long" as const,
      qty: 1,
      entry: 1.2,
      opened_at: "2026-10-16T14:45:00Z",
    };
    const won = trade(10, "2026-10-16T14:00:00Z", "2026-10-16T14:02:00Z");
    expect(
      dayCheck(sessionView({ trades: [won], open: [lot] }, now)).used,
    ).toBe(2);
  });
});
