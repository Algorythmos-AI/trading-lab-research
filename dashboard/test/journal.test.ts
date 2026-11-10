import { describe, expect, it } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import {
  applyFilter,
  calendar,
  contractLabel,
  daily,
  daysToExpiry,
  dteKey,
  filterHref,
  groupBy,
  holdKey,
  hourKey,
  journalStale,
  lessons,
  marketState,
  moneyView,
  parseFilter,
  sessionView,
  summarize,
  type JournalDoc,
  type Trade,
} from "@/lib/journal";
import { validateJournal } from "@/lib/validate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { feeNote, JournalTiles, LossSizePanel, TodayPanel, toRows } from "@/components/journal";
import { dayCheck } from "@/lib/trade-rules";
import { ownerPositions, positionTrade, tradeUnits } from "@/lib/owner-positions";

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

describe("the fixture", () => {
  it("passes the schema, so fixture mode shows what production would", () => {
    const r = validateJournal(fixtureDoc);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});

describe("summarize", () => {
  const ts = [
    trade(100, "2026-10-14T14:00:00Z", "2026-10-14T14:05:00Z"),
    trade(-50, "2026-10-14T15:00:00Z", "2026-10-14T15:30:00Z"),
    trade(-150, "2026-10-15T14:00:00Z", "2026-10-15T14:10:00Z"),
    trade(30, "2026-10-16T14:00:00Z", "2026-10-16T14:01:00Z"),
  ];
  const s = summarize(ts);

  it("adds up the result, the wins and the losses", () => {
    expect(s.net).toBe(-70);
    expect([s.wins, s.losses, s.trades]).toEqual([2, 2, 4]);
    expect(s.winRate).toBe(0.5);
    expect(s.avgWin).toBe(65);
    expect(s.avgLoss).toBe(-100);
    expect(s.profitFactor).toBeCloseTo(130 / 200);
    expect(s.expectancy).toBe(-17.5);
    expect(s.lossStreak).toBe(2);
  });

  it("measures the deepest fall by day from the earlier high", () => {
    // Days: +50, -150, +30 → running 50, -100, -70; peak 50 → deepest -150.
    expect(daily(ts).map((d) => [d.day, d.pnl, d.cum, d.dd])).toEqual([
      ["2026-10-14", 50, 50, 0],
      ["2026-10-15", -150, -100, -150],
      ["2026-10-16", 30, -70, -120],
    ]);
    expect(s.maxDrawdown).toBe(-150);
    expect([s.days, s.greenDays]).toEqual([3, 2]);
    expect(s.worstDay).toMatchObject({ day: "2026-10-15", pnl: -150 });
  });

  it("is empty-safe", () => {
    const e = summarize([]);
    expect([e.trades, e.net, e.winRate, e.profitFactor, e.maxDrawdown]).toEqual([0, 0, null, null, 0]);
  });
});

describe("days and buckets follow New York", () => {
  it("books a trade closed after midnight UTC to the New York day", () => {
    const t = trade(10, "2026-10-16T19:50:00Z", "2026-10-17T00:30:00Z");
    expect(daily([t])[0]!.day).toBe("2026-10-16");
  });

  it("bands the entry time in New York hours", () => {
    expect(hourKey(trade(1, "2026-10-16T13:35:00Z", "2026-10-16T13:40:00Z"))).toBe("open"); // 9:35 EDT
    expect(hourKey(trade(1, "2026-10-16T18:07:00Z", "2026-10-16T18:10:00Z"))).toBe("14"); // 14:07 EDT
    expect(hourKey(trade(1, "2026-01-16T14:35:00Z", "2026-01-16T14:40:00Z"))).toBe("open"); // 9:35 EST
  });

  it("bands holding time and days to expiry", () => {
    expect(holdKey(trade(1, "2026-10-16T14:00:00Z", "2026-10-16T14:00:30Z"))).toBe("a");
    expect(holdKey(trade(1, "2026-10-16T14:00:00Z", "2026-10-16T14:20:00Z"))).toBe("c");
    expect(holdKey(trade(1, "2026-10-15T14:00:00Z", "2026-10-16T14:00:00Z"))).toBe("f");
    const t = trade(1, "2026-10-16T14:00:00Z", "2026-10-16T14:05:00Z", { expiry: "2026-10-19" });
    expect(daysToExpiry(t)).toBe(3);
    expect(dteKey(t)).toBe("3");
    expect(dteKey(trade(1, "2026-10-16T14:00:00Z", "2026-10-16T14:05:00Z"))).toBe("0");
    expect(dteKey(trade(1, "2026-10-16T14:00:00Z", "2026-10-16T14:05:00Z", { kind: "stock", expiry: null, strike: null }))).toBeNull();
  });

  it("keeps groups in the order given, empty ones too", () => {
    const g = groupBy([trade(5, "2026-10-16T14:00:00Z", "2026-10-16T14:05:00Z")], (t) => t.kind, [
      { key: "call", label: "Calls" },
      { key: "put", label: "Puts" },
    ]);
    expect(g.map((r) => [r.key, r.trades, r.pnl])).toEqual([
      ["call", 1, 5],
      ["put", 0, 0],
    ]);
  });
});

describe("filters", () => {
  const ts = [
    trade(1, "2025-03-03T15:00:00Z", "2025-03-03T15:05:00Z", { symbol: "TSLA" }),
    trade(2, "2026-09-01T15:00:00Z", "2026-09-01T15:05:00Z", { kind: "put" }),
    trade(3, "2026-10-15T15:00:00Z", "2026-10-15T15:05:00Z"),
  ];
  const now = new Date("2026-10-16T20:00:00Z");

  it("reads the address and ignores what it does not know", () => {
    expect(parseFilter({ p: "2025", s: "TSLA", k: "put" })).toEqual({ period: "2025", symbol: "TSLA", kind: "put" });
    expect(parseFilter({ p: "forever", s: "<script>", k: "future" })).toEqual({ period: "all", symbol: null, kind: null });
    expect(filterHref({ period: "all", symbol: null, kind: null })).toBe("/trades");
    expect(filterHref({ period: "30d", symbol: "SPY", kind: null })).toBe("/trades?p=30d&s=SPY");
  });

  it("keeps a year, a window, a ticker or a kind", () => {
    const pnl = (f: Parameters<typeof applyFilter>[1]) => applyFilter(ts, f, now).map((t) => t.pnl);
    expect(pnl({ period: "2025", symbol: null, kind: null })).toEqual([1]);
    expect(pnl({ period: "30d", symbol: null, kind: null })).toEqual([3]);
    expect(pnl({ period: "ytd", symbol: null, kind: null })).toEqual([2, 3]);
    expect(pnl({ period: "all", symbol: "TSLA", kind: null })).toEqual([1]);
    expect(pnl({ period: "all", symbol: null, kind: "put" })).toEqual([2]);
  });
});

describe("lessons", () => {
  it("compares trades opened straight after a loss with the rest", () => {
    const ts: Trade[] = [];
    for (let d = 1; d <= 9; d++) {
      const day = `2026-09-${String(d).padStart(2, "0")}`;
      ts.push(trade(-20, `${day}T14:00:00Z`, `${day}T14:05:00Z`)); // a loss
      ts.push(trade(-60, `${day}T14:08:00Z`, `${day}T14:12:00Z`)); // straight back in, 3 min after
      ts.push(trade(40, `${day}T17:00:00Z`, `${day}T17:20:00Z`)); // hours later
    }
    const l = lessons(ts).find((x) => x.id === "revenge");
    expect(l?.tone).toBe("bad");
    expect(l?.compare?.a.trades).toBe(9);
    expect(l?.compare?.a.avg).toBe(-60);
  });

  it("draws nothing from a handful of trades", () => {
    expect(lessons([trade(1, "2026-10-16T14:00:00Z", "2026-10-16T14:05:00Z")])).toEqual([]);
  });

  it("finds lessons in the fixture without failing", () => {
    const l = lessons((fixtureDoc as unknown as JournalDoc).trades);
    expect(l.length).toBeGreaterThan(2);
    for (const x of l) expect(x.finding).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("calendar and labels", () => {
  it("lays a month out Monday to Friday", () => {
    const days = daily([trade(5, "2026-10-16T14:00:00Z", "2026-10-16T14:05:00Z")]);
    const [oct] = calendar(days);
    expect(oct!.month).toBe("2026-10");
    // 1 Oct 2026 is a Thursday: the first week starts with three blanks.
    expect(oct!.weeks[0]!.map((c) => c?.day ?? null)).toEqual([null, null, null, "2026-10-01", "2026-10-02"]);
    const fri = oct!.weeks.flat().find((c) => c?.day === "2026-10-16");
    expect(fri).toEqual({ day: "2026-10-16", pnl: 5, trades: 1 });
  });

  it("names a contract the way a trader reads it", () => {
    expect(contractLabel({ symbol: "SPY", kind: "put", strike: 759, expiry: "2026-10-19" })).toBe("SPY 759 put · 19 Oct 26");
    expect(contractLabel({ symbol: "GRAB", kind: "stock", strike: null, expiry: null })).toBe("GRAB shares");
  });

  it("calls a journal stale only after a long weekend has passed", () => {
    expect(journalStale({ as_of: "2026-10-16T21:00:00Z" }, new Date("2026-10-19T12:00:00Z"))).toBe(false);
    expect(journalStale({ as_of: "2026-10-16T21:00:00Z" }, new Date("2026-10-20T12:00:00Z"))).toBe(true);
  });
});

describe("the session", () => {
  it("knows when the US market is open, New York time", () => {
    expect(marketState(new Date("2026-10-16T13:29:00Z"))).toBe("pre"); // 9:29
    expect(marketState(new Date("2026-10-16T13:30:00Z"))).toBe("open"); // 9:30
    expect(marketState(new Date("2026-10-16T19:59:00Z"))).toBe("open"); // 15:59
    expect(marketState(new Date("2026-10-16T20:00:00Z"))).toBe("after"); // 16:00
    expect(marketState(new Date("2026-10-17T02:00:00Z"))).toBe("closed"); // 22:00
    expect(marketState(new Date("2026-10-17T15:00:00Z"))).toBe("closed"); // Saturday
  });

  it("shows today's trades newest first while today has any", () => {
    const a = trade(50, "2026-10-16T13:40:00Z", "2026-10-16T13:50:00Z");
    const b = trade(-20, "2026-10-16T14:00:00Z", "2026-10-16T14:30:00Z");
    const old = trade(10, "2026-10-15T14:00:00Z", "2026-10-15T14:30:00Z");
    const v = sessionView({ trades: [old, a, b], open: [] }, new Date("2026-10-16T15:00:00Z"))!;
    expect(v.isToday).toBe(true);
    expect(v.day).toBe("2026-10-16");
    expect(v.trades.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(v.summary.net).toBe(30);
  });

  it("falls back to the latest session before the first trade of the day", () => {
    const old = trade(10, "2026-10-15T14:00:00Z", "2026-10-15T14:30:00Z");
    const v = sessionView({ trades: [old], open: [] }, new Date("2026-10-16T13:00:00Z"))!;
    expect(v.isToday).toBe(false);
    expect(v.day).toBe("2026-10-15");
  });

  it("stays on today once something is opened, even with nothing closed", () => {
    const old = trade(10, "2026-10-15T14:00:00Z", "2026-10-15T14:30:00Z");
    const lot = { symbol: "SPY", kind: "put" as const, strike: 750, expiry: "2026-10-16", side: "long" as const, qty: 2, entry: 1.2, opened_at: "2026-10-16T13:45:00Z" };
    const v = sessionView({ trades: [old], open: [lot] }, new Date("2026-10-16T14:00:00Z"))!;
    expect(v.isToday).toBe(true);
    expect(v.trades).toEqual([]);
    expect(v.open).toHaveLength(1);
  });

  it("returns nothing for an empty journal", () => {
    expect(sessionView({ trades: [], open: [] }, new Date("2026-10-16T14:00:00Z"))).toBeNull();
  });

  it("counts several fills of one holding as one open position, as the Risk page lists them", () => {
    const old = trade(10, "2026-10-15T14:00:00Z", "2026-10-15T14:30:00Z");
    const fill = (qty: number, entry: number, at: string) => ({ symbol: "SIRI", kind: "stock" as const, side: "long" as const, qty, entry, opened_at: at });
    const other = { symbol: "CBAKOQ", kind: "stock" as const, side: "long" as const, qty: 1, entry: 23, opened_at: "2026-10-14T15:00:00Z" };
    const v = sessionView({ trades: [old], open: [fill(10, 3, "2026-10-13T14:00:00Z"), fill(5, 3.6, "2026-10-14T14:00:00Z"), fill(4, 3, "2026-10-14T16:00:00Z"), other] }, new Date("2026-10-16T14:00:00Z"))!;
    expect(v.open).toHaveLength(2);
    const siri = v.open.find((l) => l.symbol === "SIRI")!;
    expect(siri.qty).toBe(19);
    expect(siri.entry).toBeCloseTo((30 + 18 + 12) / 19);
    expect(siri.opened_at).toBe("2026-10-14T16:00:00Z");
    expect(v.open[0]!.symbol).toBe("SIRI");     // newest first by its newest fill
  });
});

describe("money in and out", () => {
  const money = {
    currency: "AUD",
    as_of: "2026-10-16T21:05:00Z",
    account_value: 5240,
    usd_rate: 1.5,
    complete_from: "2025-01-02",
    transfers: [
      { date: "2025-01-02", amount: 5000, source: "statement" as const },
      { date: "2025-11-03", amount: -1500, source: "statement" as const },
      { date: "2026-10-14", amount: 500, source: "detected" as const },
    ],
    values: [{ date: "2026-10-15", value: 5240 }],
  };

  it("adds up what went in and out and compares it with the value", () => {
    const m = moneyView(money, -100);
    expect(m.deposits).toBe(5500);
    expect(m.withdrawals).toBe(1500);
    expect(m.netIn).toBe(4000);
    expect(m.gain).toBe(1240);
    expect(m.gainPct).toBeCloseTo(0.31);
    expect(m.tradingLocal).toBe(-150);
    expect(m.complete).toBe(true);
    expect(m.transfers[0]!.date).toBe("2026-10-14");
  });

  it("steps the money put in and taken out at each transfer and carries the value where recorded", () => {
    const m = moneyView(money, 0);
    expect(m.series.map((p) => [p.date, p.putIn, p.takenOut, p.netIn, p.value])).toEqual([
      ["2025-01-02", 5000, 0, 5000, null],
      ["2025-11-03", 5000, 1500, 3500, null],
      ["2026-10-14", 5500, 1500, 4000, null],
      ["2026-10-15", 5500, 1500, 4000, 5240],
    ]);
  });

  it("keeps both totals at zero or above when a deposit is dated after the withdrawals it paid for", () => {
    const late = { ...money, transfers: [
      { date: "2024-01-05", amount: -300, source: "statement" as const },
      { date: "2025-01-04", amount: 1000, source: "statement" as const },
    ] };
    const m = moneyView(late, 0);
    expect(m.series.every((p) => p.putIn >= 0 && p.takenOut >= 0)).toBe(true);
    expect(m.series[0]).toMatchObject({ putIn: 0, takenOut: 300, netIn: -300 });
  });

  it("gives no gain before anything has been put in", () => {
    const m = moneyView({ ...money, transfers: [], complete_from: null }, 0);
    expect(m.gain).toBeNull();
    expect(m.complete).toBe(false);
  });

  it("accepts a journal with money and refuses an unknown field in it", () => {
    expect(validateJournal(fixtureDoc).ok).toBe(true);
    const bad = { ...fixtureDoc, money: { ...money, balance_by_account: 1 } };
    expect(validateJournal(bad).ok).toBe(false);
  });
});

describe("the Trades page counts positions, after fees", () => {
  const doc = fixtureDoc as unknown as JournalDoc;
  const units = tradeUnits(doc.trades, { basis: "net", open: doc.open, gaps: doc.gaps, feesIncluded: doc.fees_included });
  const positions = units.flatMap((u) => (u.position ? [u.position] : []));

  it("summarises trades, not pieces, and takes the fees off options only", () => {
    const net = summarize(units.map((u) => u.unit));
    const gross = summarize(units.map((u) => (u.position ? positionTrade(u.position, "gross") : u.unit)));
    expect([doc.trades.length, net.trades]).toEqual([259, 256]); // three scale-outs of two pieces each
    expect(gross.net).toBeCloseTo(doc.trades.reduce((s, t) => s + t.pnl, 0));
    const fees = positions.reduce((s, p) => s + p.fees, 0);
    expect(fees).toBeGreaterThan(0);
    expect(gross.net - net.net).toBeCloseTo(fees);
  });

  it("filters a position by the day of its last close", () => {
    const kept = applyFilter(units.map((u) => u.unit), { period: "2026", symbol: "SPY", kind: "call" }, new Date("2026-10-16T20:00:00Z"));
    expect(kept.some((t) => t.id === "fx-pos-1")).toBe(true);
    expect(kept.some((t) => t.id === "fx-pos-2")).toBe(false); // a piece of fx-pos-1's position, not a trade of its own
  });

  it("lists a scale-out once, with its pieces, its fees, and its result before and after them", () => {
    const row = toRows(units).find((r) => r.id === "fx-pos-1")!;
    expect(row.pieces).toHaveLength(2);
    expect(row.qty).toBe(2);
    expect(row.fees).toBeCloseTo(2 * 0.55 + 2 * 0.56);
    expect(row.gross).toBeCloseTo(80);
    expect(row.pnl).toBeCloseTo(80 - 2.22);
    expect(row.r25).toBeCloseTo((80 - 2.22) / 60);
    const share = toRows(units).find((r) => r.kind === "stock")!;
    expect([share.fees, share.r25, share.pieces]).toEqual([null, null, []]);
  });

  it("shows the before-fees result beside the headline and says what the fees are", () => {
    const s = summarize(units.map((u) => u.unit));
    const g = summarize(units.map((u) => (u.position ? positionTrade(u.position, "gross") : u.unit)));
    const html = renderToStaticMarkup(createElement(JournalTiles, { s, gross: g, fees: { included: false, total: 12.34 } }));
    expect(html).toContain("after fees");
    expect(html).toContain("before fees");
    expect(html).toContain("$0.55 in, $0.56 out per contract");
    expect(feeNote({ included: true, total: 0 })).toMatch(/already carry fees/);
  });

  it("counts today's closed trades as the day's rules do, after fees, with the pieces one click away", () => {
    const now = new Date("2026-09-16T20:30:00Z");
    const today = { ...doc, trades: doc.trades.filter((t) => t.opened_at.startsWith("2026-09-16")), open: [] };
    const view = sessionView(today, now)!;
    expect(view.trades).toHaveLength(7);
    const used = dayCheck(view).used;
    expect(used).toBe(4);
    const html = renderToStaticMarkup(createElement(TodayPanel, { view, asOf: "2026-09-16T20:25:00Z", now, market: "after", feesIncluded: false }));
    expect(html).toMatch(new RegExp(`Closed trades</span></p><p[^>]*>${used}</p>`));
    expect(html).toContain("Day result, after fees");
    expect(html).toContain("before fees −\u2060$75"); // the seven pieces' results, as the broker reports them
    expect(html).toContain("2 pieces");
  });

  it("measures loss size with its n, and says when there are too few to average", () => {
    const few = renderToStaticMarkup(createElement(LossSizePanel, { positions: positions.slice(0, 5) }));
    expect(few).toMatch(/n = \d+ over \d+ sessions?: too few to average/);
    expect(few).toMatch(/Losers n = \d+, winners n = \d+: too few to average/);
    expect(few).not.toMatch(/target 1|would have made/i);
    const all = renderToStaticMarkup(createElement(LossSizePanel, { positions }));
    expect(all).toMatch(/after fees, n = \d+ over \d+ sessions/);
    expect(renderToStaticMarkup(createElement(LossSizePanel, { positions: [] }))).toContain("No option trades to measure");
  });

  it("holds the average loser and winner to the overall mean's sample, since together they give it back", () => {
    // 9 losers and 8 winners on one session: enough of each, but not 20 trades over 10 sessions.
    let k = 0;
    const p = (sym: string, m: number, exit: number) => trade(Math.round((exit - 1) * 100), `2026-10-14T14:${String(m).padStart(2, "0")}:00Z`, `2026-10-14T14:${String(m).padStart(2, "0")}:30Z`, { id: `e${++k}`, symbol: sym, entry: 1, exit });
    const few = ownerPositions({ trades: [...Array.from({ length: 9 }, (_, i) => p(`S${i}`, i, 0.8)), ...Array.from({ length: 8 }, (_, i) => p(`W${i}`, 20 + i, 1.3))] }).positions;
    const html = renderToStaticMarkup(createElement(LossSizePanel, { positions: few }));
    expect(html).toContain("Losers n = 9, winners n = 8: too few to average");
    expect(html).not.toMatch(/[−+]\d\.\d\dR \/ /);
    expect(html).toContain("Winners closed under +50% on premium");
    expect(html).not.toMatch(/rule 3|2:1|target/i);
  });

  it("says how many trades were left out when every one in view was", () => {
    const flagged = ownerPositions({ trades: [trade(10, "2026-10-14T14:00:00Z", "2026-10-14T14:01:00Z", { entry: 0, exit: 0.1 })] }).positions;
    expect(renderToStaticMarkup(createElement(LossSizePanel, { positions: flagged }))).toContain("1 option trade was left out");
  });
});
