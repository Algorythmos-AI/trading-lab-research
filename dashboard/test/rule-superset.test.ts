import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayPanel } from "@/components/journal";
import { accountRisk } from "@/lib/account-risk";
import { calendar, closeDay, daily, holdMinutes, nyTime, sessionView, type JournalDoc, type Lot, type Trade } from "@/lib/journal";
import { yourDays } from "@/lib/market-calendar";
import { ruleDays } from "@/lib/overview";
import { entriesOf, exitStats, netPieces, ownerPositions, peakPremium, premiumOverAt } from "@/lib/owner-positions";
import { boardDay } from "@/lib/trade-now";
import {
  breakSummary,
  DAY_LOSS_LIMIT,
  dayCheck,
  MAX_PREMIUM,
  MAX_TRADES_PER_DAY,
  PREMIUM_STOP,
  RISK_PER_TRADE,
  TIME_STOP_MINUTES,
  tradeBreaks,
} from "@/lib/trade-rules";

// Grouping pieces into positions (DEC-0045 section 1) may only stop a scale-out from counting as several entries
// against the day's cap. For every other rule the verdict on a position must keep every break its pieces showed one
// at a time. This file holds the per-piece rules as they were before positions, as the oracle.

const isOption = (t: Trade) => t.kind !== "stock";

/** The per-piece tests of rules 4, 5, 6 and 9, as they were. */
function oldOwn(t: Trade): string[] {
  const ids: string[] = [];
  const option = isOption(t);
  if (t.pnl < -RISK_PER_TRADE || (option && t.side === "long" && t.entry * t.multiplier * t.qty > MAX_PREMIUM + 1e-9)) ids.push("risk");
  if (option && t.side === "long" && t.entry > 0 && 1 - t.exit / t.entry > PREMIUM_STOP + 1e-9) ids.push("stop");
  if (t.pnl < 0 && holdMinutes(t) > TIME_STOP_MINUTES) ids.push("time");
  if (option && closeDay(t) !== nyTime(t.opened_at).day) ids.push("flat");
  return ids;
}

/** The whole per-piece rule check as it was, day rules included. */
function oldTradeBreaks(trades: readonly Trade[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byDay = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = nyTime(t.opened_at).day;
    byDay.set(d, [...(byDay.get(d) ?? []), t]);
  }
  for (const list of byDay.values()) {
    const day = [...list].sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id));
    const own = new Map<Trade, string[]>(day.map((t) => [t, oldOwn(t)]));
    day.forEach((t, i) => {
      const ids = [...own.get(t)!];
      if (i >= MAX_TRADES_PER_DAY) ids.push("day-cap");
      const at = Date.parse(t.opened_at);
      const before = day.filter((p) => p !== t && Date.parse(p.closed_at) <= at);
      if (i > MAX_TRADES_PER_DAY || before.reduce((s, p) => s + p.pnl, 0) <= -DAY_LOSS_LIMIT || before.some((p) => own.get(p)!.length > 0)) ids.push("day-stop");
      if (ids.length) out.set(t.id, ids);
    });
  }
  return out;
}

let n = 0;
const P = (o: Partial<Trade> & Pick<Trade, "opened_at" | "closed_at" | "entry" | "exit">): Trade => {
  const qty = o.qty ?? 1;
  return { id: `p${String(++n).padStart(3, "0")}`, symbol: "SPY", kind: "call", strike: 600, expiry: "2026-10-16", side: "long", qty, multiplier: 100, close: "order", pnl: Math.round((o.exit - o.entry) * 100 * qty * 100) / 100, ...o };
};
const T = (hm: string, day = "2026-10-14") => `${day}T${hm}:00.000Z`;
const at = (m: number) => new Date(Date.parse("2026-10-14T13:30:00Z") + m * 60_000).toISOString();
const show = (m: Map<string, string[]>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]));
const rnd = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

describe("the reviewer's cases: no break a piece showed is lost", () => {
  it("rule 7 counts a piece's break from that piece's close, not the whole position's", () => {
    const j = [
      P({ opened_at: T("14:00"), closed_at: T("14:02"), entry: 1.5, exit: 1.0 }), // half sold −33% at 14:02
      P({ opened_at: T("14:00"), closed_at: T("14:40"), entry: 1.5, exit: 1.6 }),
      P({ symbol: "QQQ", strike: 500, opened_at: T("14:10"), closed_at: T("14:12"), entry: 1.0, exit: 1.05 }),
    ];
    expect(tradeBreaks(j).get(j[2]!.id)).toEqual(["day-stop"]);
    expect(tradeBreaks(j).get(j[0]!.id)).toContain("stop");
  });

  it("rule 6 flags the rest of a scale-out held 20 minutes that lost, inside a green position", () => {
    const j = [P({ opened_at: T("14:00"), closed_at: T("14:02"), entry: 1.0, exit: 1.4 }), P({ opened_at: T("14:00"), closed_at: T("14:20"), entry: 1.0, exit: 0.8 })];
    expect(tradeBreaks(j).get(j[1]!.id)).toContain("time");
  });

  it("rule 4 flags a piece that lost more than $50 when the whole lost less", () => {
    const j = [P({ opened_at: T("14:00"), closed_at: T("14:02"), entry: 1.8, exit: 1.6, qty: 3 }), P({ opened_at: T("14:00"), closed_at: T("14:03"), entry: 1.8, exit: 2.0 })];
    expect(tradeBreaks(j).get(j[0]!.id)).toContain("risk");
  });

  it("rule 5 flags a piece sold 40% under its own entry, however the average was brought down", () => {
    const j = [P({ kind: "put", opened_at: T("14:00"), closed_at: T("14:04"), entry: 0.8, exit: 0.48 }), P({ kind: "put", opened_at: T("14:03"), closed_at: T("14:04"), entry: 0.4, exit: 0.48 })];
    expect(tradeBreaks(j).get(j[0]!.id)).toContain("stop");
  });

  it("two zero-length pieces of one instant stand as two positions, as the record's rule reads", () => {
    const j = [P({ opened_at: T("14:00"), closed_at: T("14:00"), entry: 1, exit: 1.1 }), P({ opened_at: T("14:00"), closed_at: T("14:00"), entry: 1, exit: 1.1 })];
    expect(ownerPositions({ trades: j }).positions).toHaveLength(2);
  });
});

describe("old ⊆ new", () => {
  it("on random multi-piece journals, every break of rules 4, 5, 6 and 9 a piece had by itself is still on its position", () => {
    const r = rnd(20261111);
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      n = 0;
      const j: Trade[] = [];
      const m = 2 + Math.floor(r() * 10);
      for (let i = 0; i < m; i++) {
        const o = Math.floor(r() * 120);
        const h = Math.floor(r() * 25);
        const expired = r() < 0.08;
        const entry = Math.round(r() * 250) / 100 + 0.05;
        j.push(
          P({
            symbol: r() < 0.5 ? "SPY" : "QQQ",
            kind: r() < 0.5 ? "call" : "put",
            strike: 600 + Math.floor(r() * 2),
            qty: 1 + Math.floor(r() * 3),
            opened_at: at(o),
            closed_at: at(o + h + (r() < 0.05 ? 1440 : 0)),
            entry,
            exit: expired ? 0 : Math.round(r() * 300) / 100,
            close: expired ? "expired" : "order",
          }),
        );
      }
      const now = tradeBreaks(j);
      for (const t of j) {
        for (const id of oldOwn(t)) {
          expect(now.get(t.id) ?? [], `${id} on ${t.id} in ${JSON.stringify(j)}`).toContain(id);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("on journals where every piece is its own contract, the verdicts are exactly the old ones", () => {
    const r = rnd(7);
    for (let k = 0; k < 300; k++) {
      n = 0;
      const j: Trade[] = [];
      const m = 1 + Math.floor(r() * 9);
      for (let i = 0; i < m; i++) {
        const o = Math.floor(r() * 300);
        const h = 1 + Math.floor(r() * 30);
        const kind = r() < 0.15 ? "stock" : r() < 0.5 ? "call" : "put";
        const exit = r() < 0.1 ? 0 : Math.round(r() * 300) / 100;
        j.push(
          P({
            symbol: `X${i}`,
            kind,
            strike: kind === "stock" ? null : 100 + i,
            multiplier: kind === "stock" ? 1 : 100,
            side: r() < 0.1 ? "short" : "long",
            qty: 1 + Math.floor(r() * 3),
            opened_at: at(o),
            closed_at: at(o + h + (r() < 0.05 ? 1440 : 0)),
            entry: Math.round(r() * 300) / 100 + 0.01,
            exit,
            close: exit === 0 && r() < 0.5 ? "expired" : "order",
          }),
        );
      }
      expect(show(tradeBreaks(j))).toEqual(show(oldTradeBreaks(j)));
    }
  });
});

describe("rule 8 counts entries: each distinct buy fill", () => {
  const now = new Date(at(120));
  const doc = (trades: Trade[], open: Lot[] = []) => ({ as_of: at(119), open, trades }) as unknown as JournalDoc;

  it("gives 8 for an overlapping chain of 8 buys in one contract, and 1 for one buy sold in 3", () => {
    n = 0;
    const chain = Array.from({ length: 8 }, (_, i) => P({ opened_at: at(i * 5), closed_at: at(i * 5 + 7), entry: 0.2, exit: 0.21 }));
    expect(ownerPositions({ trades: chain }).positions).toHaveLength(1);
    expect(entriesOf(ownerPositions({ trades: chain }).positions[0]!)).toHaveLength(8);
    expect(dayCheck(sessionView(doc(chain), now))).toMatchObject({ used: 8, status: "stop" });
    expect(boardDay(doc(chain), now).dayLimitUsed).toBe(true);
    n = 0;
    const three = [5, 9, 14].map((c) => P({ opened_at: at(0), closed_at: at(c), entry: 0.5, exit: 0.55 }));
    expect(dayCheck(sessionView(doc(three), now))).toMatchObject({ used: 1, status: "clear" });
    expect(boardDay(doc(three), now).dayLimitUsed).toBe(false);
  });

  it("counts a held lot bought in a fill already counted once, and a new buy while holding as one more", () => {
    n = 0;
    const half = [P({ opened_at: at(0), closed_at: at(3), entry: 0.5, exit: 0.55 })];
    const lot = { symbol: "SPY", kind: "call" as const, strike: 600, expiry: "2026-10-16", side: "long" as const, qty: 1, entry: 0.5, opened_at: at(0) };
    expect(dayCheck(sessionView(doc(half, [lot]), now)).used).toBe(1);
    expect(dayCheck(sessionView(doc(half, [{ ...lot, opened_at: at(2) }]), now)).used).toBe(2);
  });

  it("gives the same rule-8 answer on every page that reads it", () => {
    const day = "2026-10-14";
    const check = (trades: Trade[]) => {
      const d = doc(trades);
      return {
        used: dayCheck(sessionView(d, now)).used,
        cap: breakSummary(trades).byRule["day-cap"] ?? 0,
        overview: ruleDays(trades).find((x) => x.day === day)!.broke === "count",
        calendar: yourDays(trades).get(day)!.broke === "count",
        calendarRules: yourDays(trades).get(day)!.rules.includes(8),
        risk: accountRisk(d, now).limits.find((l) => l.id === "day-cap")!,
      };
    };
    n = 0;
    const chain = check(Array.from({ length: 8 }, (_, i) => P({ opened_at: at(i * 5), closed_at: at(i * 5 + 7), entry: 0.2, exit: 0.21 })));
    expect(chain).toMatchObject({ used: 8, cap: 1, overview: true, calendar: true, calendarRules: true });
    expect([chain.risk.today, chain.risk.broken]).toEqual(["8", 1]);
    n = 0;
    const three = check([5, 9, 14].map((c) => P({ opened_at: at(0), closed_at: at(c), entry: 0.5, exit: 0.55 })));
    expect(three).toMatchObject({ used: 1, cap: 0, overview: false, calendar: false, calendarRules: false });
    expect([three.risk.today, three.risk.broken]).toEqual(["1", 0]);
  });
});

describe("rule 4 premium is the most held at once", () => {
  it("flags 4 × $1.00 bought at once and sold 2 + 2, and two overlapping buys of $150", () => {
    n = 0;
    const once = [P({ opened_at: T("14:00"), closed_at: T("14:03"), entry: 1, exit: 1.02, qty: 2 }), P({ opened_at: T("14:00"), closed_at: T("14:05"), entry: 1, exit: 1.02, qty: 2 })];
    expect(tradeBreaks(once).get(once[0]!.id)).toEqual(["risk"]);
    const two = [P({ opened_at: T("14:00"), closed_at: T("14:06"), entry: 1.5, exit: 1.52 }), P({ opened_at: T("14:02"), closed_at: T("14:06"), entry: 1.5, exit: 1.52 })];
    expect(tradeBreaks(two).get(two[0]!.id)).toEqual(["risk"]);
  });

  it("does not flag a churned chain that never held more than $200, and still flags any single piece over it", () => {
    n = 0;
    const chain = [0, 4, 8].map((s) => P({ opened_at: at(s), closed_at: at(s + 5), entry: 1.0, exit: 1.02 }));
    expect(peakPremium(chain)).toBeCloseTo(200);
    expect(tradeBreaks(chain).size).toBe(0);
    expect(dayCheck(sessionView({ trades: chain, open: [] }, new Date(at(120)))).brokenRules).toEqual([]);
    const big = [P({ opened_at: at(0), closed_at: at(2), entry: 2.5, exit: 2.55 })];
    expect(tradeBreaks(big).get(big[0]!.id)).toEqual(["risk"]);
  });

  it("adds a held lot to the position it is part of in the day check", () => {
    n = 0;
    const sold = [P({ opened_at: at(0), closed_at: at(3), entry: 1.2, exit: 1.25 })];
    const lot = { symbol: "SPY", kind: "call" as const, strike: 600, expiry: "2026-10-16", side: "long" as const, qty: 1, entry: 1.2, opened_at: at(1) };
    expect(dayCheck(sessionView({ trades: sold, open: [lot] }, new Date(at(120)))).brokenRules).toEqual([4]); // $240 held at once
    expect(dayCheck(sessionView({ trades: sold, open: [{ ...lot, opened_at: at(10) }] }, new Date(at(120)))).brokenRules).toEqual([]);
  });
});

describe("each day's figure books each piece to its own close day", () => {
  it("shows a half sold on one day and the rest the next on both days, the same on the calendar, the Today panel and the day check", () => {
    n = 0;
    const D = "2026-10-14";
    const E = "2026-10-15";
    const j = [
      P({ opened_at: T("14:00", D), closed_at: T("14:30", D), entry: 1, exit: 1.5, expiry: "2026-10-17" }),
      P({ opened_at: T("14:00", D), closed_at: T("14:30", E), entry: 1, exit: 0.8, expiry: "2026-10-17" }),
    ];
    const days = daily(netPieces(j, false));
    expect(days.map((d) => [d.day, Math.round(d.pnl * 100) / 100])).toEqual([
      [D, 48.89],
      [E, -21.11],
    ]);
    const cells = calendar(days, 1)[0]!.weeks.flat().filter((c) => c && c.pnl !== null);
    expect(cells.map((c) => [c!.day, Math.round(c!.pnl! * 100) / 100])).toEqual([
      [D, 48.89],
      [E, -21.11],
    ]);
    for (const [day, net, gross, shown] of [
      [D, 48.89, 50, "+⁠$49"],
      [E, -21.11, -20, "−⁠$21"],
    ] as const) {
      const now = new Date(`${day}T20:30:00Z`);
      const view = sessionView({ trades: j, open: [] }, now)!;
      // The day check reads the day before fees, as the day loss limit always has.
      expect(dayCheck(view).net).toBeCloseTo(gross);
      const html = renderToStaticMarkup(createElement(TodayPanel, { view, asOf: `${day}T20:25:00Z`, now, market: "after", feesIncluded: false }));
      expect(html).toContain(shown);
      expect(Math.round(days.find((d) => d.day === day)!.pnl * 100) / 100).toBe(net);
    }
  });
});

describe("round 2", () => {
  it("S1: counts a part held past −25% of its own entry as rule 5 does, however the average was brought down", () => {
    n = 0;
    const j = [P({ kind: "put", opened_at: T("14:00"), closed_at: T("14:04"), entry: 0.8, exit: 0.48 }), P({ kind: "put", opened_at: T("14:03"), closed_at: T("14:04"), entry: 0.4, exit: 0.48 })];
    const x = exitStats(ownerPositions({ trades: j }).positions, 1);
    expect(x.partPastStop).toBe(1);
    expect(tradeBreaks(j).get(j[0]!.id)).toContain("stop");
  });

  it("S3: judges the cap on the day the entries were made, even when every one closed the next day", () => {
    n = 0;
    const j = Array.from({ length: 6 }, (_, i) => P({ symbol: `N${i}`, opened_at: `2026-10-14T19:0${i}:00.000Z`, closed_at: "2026-10-15T14:00:00.000Z", entry: 0.5, exit: 0.55, expiry: "2026-10-17" }));
    const rd = new Map(ruleDays(j).map((d) => [d.day, d.broke]));
    expect([rd.get("2026-10-14"), rd.get("2026-10-15")]).toEqual(["count", null]);
    const yd = yourDays(j);
    expect([yd.get("2026-10-14")!.broke, yd.get("2026-10-15")!.broke]).toEqual(["count", null]);
    expect(yd.get("2026-10-14")!.rules).toContain(8);
    const cap = accountRisk({ trades: j, open: [] }, new Date("2026-10-15T20:00:00Z")).limits.find((l) => l.id === "day-cap")!;
    expect([cap.broken, cap.worst]).toEqual([1, "most 6"]);
  });

  it("S4: counts two held buys of one contract as two entries and sees their $300 together", () => {
    const now = new Date(at(120));
    const lot = { symbol: "SPY", kind: "call" as const, strike: 600, expiry: "2026-10-16", side: "long" as const, qty: 1, entry: 1.5, opened_at: at(30) };
    const c = dayCheck(sessionView({ trades: [], open: [lot, { ...lot, opened_at: at(32) }] }, now));
    expect(c.used).toBe(2);
    expect(c.brokenRules).toEqual([4]);
    // The holding the other pages list is still the merged one.
    expect(sessionView({ trades: [], open: [lot, { ...lot, opened_at: at(32) }] }, now)!.open).toHaveLength(1);
  });

  it("N2: a piece bought and sold at one instant counts while held; a sale and a rebuy at one instant net", () => {
    n = 0;
    const flash = [P({ opened_at: T("14:00"), closed_at: T("14:05"), entry: 1.5, exit: 1.5 }), P({ opened_at: T("14:03"), closed_at: T("14:03"), entry: 1.5, exit: 1.5 })];
    expect(peakPremium(flash)).toBeCloseTo(300);
    const rebuy = [P({ opened_at: T("14:00"), closed_at: T("14:03"), entry: 1.5, exit: 1.5 }), P({ opened_at: T("14:03"), closed_at: T("14:06"), entry: 1.5, exit: 1.5 })];
    expect(peakPremium(rebuy)).toBeCloseTo(150);
  });

  it("N3: a premium over the cap that only the whole position shows is known from the fill that took it over", () => {
    n = 0;
    // $150 at 14:00, another $150 at 14:02 (over $200 from 14:02); both sold at 14:30. Another trade at 14:10.
    const j = [
      P({ opened_at: T("14:00"), closed_at: T("14:30"), entry: 1.5, exit: 1.52 }),
      P({ opened_at: T("14:02"), closed_at: T("14:30"), entry: 1.5, exit: 1.52 }),
      P({ symbol: "QQQ", strike: 500, opened_at: T("14:10"), closed_at: T("14:12"), entry: 1, exit: 1.02 }),
    ];
    expect(tradeBreaks(j).get(j[0]!.id)).toEqual(["risk"]);
    expect(tradeBreaks(j).get(j[2]!.id)).toEqual(["day-stop"]);
    expect(premiumOverAt(j.slice(0, 2), MAX_PREMIUM)).toBe(Date.parse(T("14:02")));
  });

  it("keeps every rule 4 to 9 break the old day check showed, with lots held, on random days", () => {
    const r = rnd(424242);
    const now = new Date(at(130));
    const merged = (lots: Lot[]) => {
      const by = new Map<string, number>();
      for (const l of lots) by.set(JSON.stringify([l.symbol, l.kind, l.strike, l.expiry, l.side]), (by.get(JSON.stringify([l.symbol, l.kind, l.strike, l.expiry, l.side])) ?? 0) + l.entry * 100 * l.qty);
      return [...by.values()];
    };
    for (let k = 0; k < 600; k++) {
      n = 0;
      const j: Trade[] = [];
      for (let i = 0, m = Math.floor(r() * 8); i < m; i++) {
        const o = Math.floor(r() * 100);
        j.push(P({ symbol: r() < 0.5 ? "SPY" : "QQQ", strike: 600 + Math.floor(r() * 2), qty: 1 + Math.floor(r() * 2), opened_at: at(o), closed_at: at(o + Math.floor(r() * 15)), entry: Math.round(r() * 200) / 100 + 0.05, exit: Math.round(r() * 250) / 100 }));
      }
      const lots: Lot[] = [];
      for (let i = 0, m = Math.floor(r() * 3); i < m; i++) lots.push({ symbol: r() < 0.5 ? "SPY" : "QQQ", kind: "call", strike: 600 + Math.floor(r() * 2), expiry: "2026-10-16", side: "long", qty: 1, entry: Math.round(r() * 200) / 100, opened_at: at(Math.floor(r() * 120)) });
      const old = new Set<number>();
      const numbers: Record<string, number> = { risk: 4, stop: 5, time: 6, flat: 9 };
      for (const t of j) for (const id of oldOwn(t)) old.add(numbers[id]!);
      if (merged(lots).some((c) => c > MAX_PREMIUM + 1e-9)) old.add(4);
      const got = dayCheck(sessionView({ trades: j, open: lots }, now)).brokenRules;
      for (const rule of old) expect(got, JSON.stringify({ j, lots })).toContain(rule);
    }
  });
});
