import { describe, expect, it } from "vitest";
import { daily, summarize } from "@/lib/journal";
import {
  armBooks,
  cloneBook,
  crossCheck,
  execution,
  expiryKey,
  glance,
  MIN_SAMPLE,
  paperRows,
  paperStale,
  premiumKey,
  premiumStats,
  R_UNIT,
  reasonLabel,
  rolling,
  ROLLING,
  ropHistogram,
  windowLabel,
  windowMarks,
  windowOrder,
} from "@/lib/paper";
import type { CloneTrade, PaperOptions } from "@/lib/paper-options.types";
import fixture from "./fixtures/paper-options.v1.json";

// The Paper options page's arithmetic (DEC-0057): rows read into the journal's shape, and the figures the journal
// has no word for. Every total here is checked against a plain sum of the document's own rows.

const doc = (mutate?: (d: PaperOptions) => void): PaperOptions => {
  const d = structuredClone(fixture) as unknown as PaperOptions;
  mutate?.(d);
  return d;
};
const loose = (d: object) => d as Record<string, unknown>;
const cents = (v: number) => Math.round(v * 100) / 100;
const row = (over: Partial<CloneTrade> = {}): CloneTrade => ({
  trade_id: "2026-10-12-O-9",
  session: "2026-10-12",
  hyp: "HYP-0029",
  window: "no_oi",
  side: "call",
  contract: "SPY261012C00581000",
  qty: 1,
  opened_at: "2026-10-12T14:30:00+00:00",
  closed_at: "2026-10-12T14:50:00+00:00",
  timed_by: "plan",
  fill: 2,
  exit_fill: 2.5,
  exit_reason: "target",
  pnl_usd: 49.94,
  rop: 0.2497,
  quoted_ask: 2,
  best_bid: 2.8,
  worst_bid: 1.9,
  state: "closed",
  counts: true,
  ...over,
});
const only = (trades: CloneTrade[]) => doc((d) => (d.clone.trades = trades));

describe("the clone's book", () => {
  it("reads every counted row into the journal's shape, and adds up to the document's own rows", () => {
    const d = doc();
    const book = cloneBook(d);
    const counted = d.clone.trades.filter((t) => t.counts);
    expect(book.trades.length).toBe(counted.length);
    expect(book.skipped).toBe(0);
    expect(cents(summarize(book.trades).net)).toBe(cents(counted.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)));
    // The curve ends on the net result, and the days add up to it.
    const days = daily(book.trades);
    expect(cents(days.at(-1)!.cum)).toBe(cents(summarize(book.trades).net));
    expect(cents(days.reduce((s, x) => s + x.pnl, 0))).toBe(cents(summarize(book.trades).net));
    const t = book.trades.find((x) => x.id === "2026-10-12-O-1")!;
    expect(t).toMatchObject({ symbol: "SPY", kind: "call", strike: 581, expiry: "2026-10-12", side: "long", qty: 1, entry: 1.42, exit: 1.79, multiplier: 100, close: "order" });
    expect(book.meta.get(t.id)).toMatchObject({ hyp: "HYP-0029", window: "no_oi", reason: "target", roughTime: false });
  });

  it("lists a trade the clone could not settle, and keeps it out of every figure", () => {
    const d = doc();
    const book = cloneBook(d);
    const off = d.clone.trades.filter((t) => !t.counts);
    expect(off.length).toBe(1);
    expect(book.uncounted).toEqual([{ id: off[0]!.trade_id, contract: off[0]!.contract, state: "unresolved" }]);
    expect(book.trades.some((t) => t.id === off[0]!.trade_id)).toBe(false);
  });

  it("takes an unsettled trade with no exit, result or close time, and never counts a row that lacks what a figure needs", () => {
    const open = row({ trade_id: "2026-10-12-O-2", state: "unresolved", counts: false, exit_fill: null, pnl_usd: null, rop: null, closed_at: null, exit_reason: null });
    const noFill = row({ trade_id: "2026-10-12-O-3", state: "unresolved", counts: false, fill: null, opened_at: null, exit_fill: null, pnl_usd: null, rop: null, closed_at: null });
    // Said to count, but its result is missing: a host fault. It is in no figure and is counted as unread.
    const broken = row({ trade_id: "2026-10-12-O-4", pnl_usd: null });
    const book = cloneBook(only([row(), open, noFill, broken]));
    expect(book.trades.map((t) => t.id)).toEqual(["2026-10-12-O-9"]);
    expect(book.uncounted.map((u) => u.id)).toEqual(["2026-10-12-O-2", "2026-10-12-O-3"]);
    expect(book.skipped).toBe(1);
  });

  it("leaves out and counts a row it cannot read: a bad contract, a missing time, a repeated id, a null", () => {
    const good = row();
    const d = only([good, row({ trade_id: "2026-10-12-O-10", contract: "ZZZ269999C00000000" }), row({ trade_id: "2026-10-12-O-11", closed_at: "not a time" }), good]);
    (d.clone.trades as unknown[]).push(null);
    const book = cloneBook(d);
    expect(book.trades.map((t) => t.id)).toEqual([good.trade_id]);
    expect(book.skipped).toBe(4);
  });

  it("does not throw on a document with no clone block, and carries the host's truncated count", () => {
    expect(cloneBook({} as PaperOptions).trades).toEqual([]);
    expect(cloneBook(doc((d) => (d.clone.truncated = 7))).truncated).toBe(7);
  });
});

describe("the arms", () => {
  it("is null until the host sends the arms, and reads the clone the same with or without the closed account's block", () => {
    expect(armBooks(doc((d) => (d.arms = null)))).toBeNull();
    const withManual = cloneBook(doc());
    const without = cloneBook(doc((d) => delete loose(d).manual));
    expect(without.trades.map((t) => t.id)).toEqual(withManual.trades.map((t) => t.id));
    expect(cents(summarize(without.trades).net)).toBe(cents(summarize(withManual.trades).net));
  });

  it("keeps each arm apart, by its hypothesis id", () => {
    const d = doc();
    const books = armBooks(d)!;
    expect(books.map((b) => b.hyp)).toEqual(d.arms!.map((a) => a.hyp));
    for (const [i, b] of books.entries()) {
      expect(b.trades.length).toBe(d.arms![i]!.trades.length);
      expect(cents(summarize(b.trades).net)).toBe(cents(d.arms![i]!.trades.reduce((s, t) => s + t.pnl_usd, 0)));
    }
  });
});

describe("the glance", () => {
  it("gives the total, today's result on New York's day, and a curve that ends on the total", () => {
    const book = cloneBook(doc());
    const g = glance(book.trades, new Date("2026-10-12T20:30:00Z"));
    expect(cents(g.net)).toBe(cents(summarize(book.trades).net));
    expect(g.todayTrades).toBe(2);
    expect(cents(g.today!)).toBe(cents(36.94 + -12.06));
    expect(g.curve[0]).toBe(0);
    expect(cents(g.curve.at(-1)!)).toBe(cents(g.net));
    // 03:30 UTC the next day is still the 12th in New York.
    expect(glance(book.trades, new Date("2026-10-13T03:30:00Z")).todayTrades).toBe(2);
    expect(glance(book.trades, new Date("2026-10-13T14:00:00Z")).today).toBeNull();
    expect(glance([], new Date())).toMatchObject({ trades: 0, net: 0, today: null, winRate: null, curve: [0], last: null });
  });
});

describe("results on the premium", () => {
  it("shows no average under the floor, and the same average in R above it", () => {
    const few = cloneBook(only(Array.from({ length: MIN_SAMPLE - 1 }, (_, i) => row({ trade_id: `2026-10-12-O-${i + 1}` }))));
    expect(premiumStats(few)).toMatchObject({ n: MIN_SAMPLE - 1, mean: null, meanR: null, median: null });
    const enough = cloneBook(only(Array.from({ length: MIN_SAMPLE }, (_, i) => row({ trade_id: `2026-10-12-O-${i + 1}`, rop: i % 2 ? 0.5 : -0.25 }))));
    const s = premiumStats(enough);
    expect(s.mean).toBeCloseTo(0.125);
    expect(s.meanR).toBeCloseTo(0.125 / R_UNIT);
    expect(s.median).toBeCloseTo(0.125);
  });

  it("puts every trade with a result in exactly one band, a stop on the edge in the worst one", () => {
    const book = cloneBook(doc());
    const bands = ropHistogram(book);
    expect(bands.reduce((s, b) => s + b.trades, 0)).toBe(book.trades.filter((t) => book.meta.get(t.id)?.rop !== null).length);
    expect(cents(bands.reduce((s, b) => s + b.pnl, 0))).toBe(cents(summarize(book.trades).net));
    const edge = ropHistogram(cloneBook(only([row({ rop: -0.25 }), row({ trade_id: "2026-10-12-O-2", rop: 0 }), row({ trade_id: "2026-10-12-O-3", rop: 0.5 })])));
    expect(edge.map((b) => b.trades)).toEqual([1, 0, 0, 1, 0, 0, 1]);
    expect(edge.map((b) => b.loss)).toEqual([true, true, true, false, false, false, false]);
  });
});

describe("the rolling figures", () => {
  it("starts at the ROLLING-th trade and moves one trade at a time", () => {
    const book = cloneBook(doc());
    const points = rolling(book.trades);
    expect(points.length).toBe(book.trades.length - ROLLING + 1);
    expect(points[0]!.n).toBe(ROLLING);
    const first = book.trades.slice(0, ROLLING);
    expect(points[0]!.winRate).toBeCloseTo(first.filter((t) => t.pnl > 0).length / ROLLING);
    expect(points[0]!.expectancy).toBeCloseTo(first.reduce((s, t) => s + t.pnl, 0) / ROLLING);
    const last = book.trades.slice(-ROLLING);
    expect(points.at(-1)!.expectancy).toBeCloseTo(last.reduce((s, t) => s + t.pnl, 0) / ROLLING);
    expect(rolling(book.trades.slice(0, ROLLING - 1))).toEqual([]);
  });
});

describe("the rule windows and the other keys", () => {
  it("keeps the document's order, and marks the first day with a trade in each later window", () => {
    const d = doc();
    const order = windowOrder(d);
    expect(order.map((w) => w.key)).toEqual(["old", "cap15", "spread5", "no_oi"]);
    const days = daily(cloneBook(d).trades);
    const marks = windowMarks(days, order);
    expect(marks.map((m) => m.label)).toEqual(["Ask cap $15", "Spread cap $5", "No open-interest floor"]);
    for (const [i, m] of marks.entries()) expect(m.day >= order[i + 1]!.from!).toBe(true);
    expect(windowMarks([], order)).toEqual([]);
    expect(windowOrder({} as PaperOptions)).toEqual([]);
  });

  it("names a code it knows, and shows one it does not as it is", () => {
    expect(reasonLabel("premium")).toBe("Premium stop (−25%)");
    expect(reasonLabel("some_new-code")).toBe("some new code");
    // Seen as bare codes on the live page on 2026-11-18: every exit the clone and the arms can record has a name.
    expect(["chart", "trail", "next-level", "broker-stop", "stock-feed-stalled", "day-loss", "operational"].map(reasonLabel)).toEqual([
      "Chart stop", "Trailing stop", "Next level reached", "Broker's stop order", "Stock feed stalled", "Day loss limit", "Operational exit",
    ]);
    expect(reasonLabel(null)).toBe("Not recorded");
    expect(windowLabel("no_oi")).toBe("No open-interest floor");
    expect(windowLabel("next")).toBe("next");
  });

  it("tells a same-day expiry from a later one by New York's day, and bands the premium paid", () => {
    const book = cloneBook(only([row(), row({ trade_id: "2026-10-12-O-2", contract: "NVDA261016C00185000" }), row({ trade_id: "2026-10-12-O-3", fill: 0.5 }), row({ trade_id: "2026-10-12-O-4", fill: 4.5 })]));
    const byId = new Map(book.trades.map((t) => [t.id, t]));
    expect(expiryKey(byId.get("2026-10-12-O-9")!)).toBe("same");
    expect(expiryKey(byId.get("2026-10-12-O-2")!)).toBe("later");
    expect(premiumKey(byId.get("2026-10-12-O-3")!)).toBe("a");
    expect(premiumKey(byId.get("2026-10-12-O-9")!)).toBe("c");
    expect(premiumKey(byId.get("2026-10-12-O-4")!)).toBe("d");
  });
});

describe("fills and exits", () => {
  it("needs the floor of rows, and reads slippage, the best moment and what the exit kept", () => {
    const rows = Array.from({ length: MIN_SAMPLE }, (_, i) => row({ trade_id: `2026-10-12-O-${i + 1}`, fill: 2.02, quoted_ask: 2, exit_fill: 2.42, best_bid: 2.82, worst_bid: 1.82 }));
    const ex = execution(cloneBook(only(rows)));
    expect(ex.n).toBe(MIN_SAMPLE);
    expect(ex.slipMedianPct).toBeCloseTo(1);
    expect(ex.atOrBetter).toBe(0);
    expect(ex.bestMean).toBeCloseTo(0.8 / 2.02);
    expect(ex.worstMean).toBeCloseTo(-0.2 / 2.02);
    expect(ex.keptMedian).toBeCloseTo(0.5);
    expect(ex.gaveBack).toBe(0);
    expect(ex.quoteAgeMedianS).toBeNull(); // no row carries a quote age
    expect(execution(cloneBook(only(rows.map((r, i) => ({ ...r, quote_age_s: i + 1 }))))).quoteAgeMedianS).toBeCloseTo(4.5);
    const short = execution(cloneBook(only(rows.slice(0, MIN_SAMPLE - 1))));
    expect(short).toMatchObject({ slipMedianPct: null, atOrBetter: null, bestMean: null, keptMedian: null });
  });

  it("counts a trade up a full R that closed at a loss, and skips rows without the numbers", () => {
    const ex = execution(cloneBook(only([row({ best_bid: 2.6, exit_fill: 1.5, pnl_usd: -50.06 }), row({ trade_id: "2026-10-12-O-2", quoted_ask: null, best_bid: null, worst_bid: null })])));
    expect(ex.gaveBack).toBe(1);
    expect(ex.n).toBe(1);
    expect(ex.held).toBe(1);
  });
});

describe("the check against the clone's own document", () => {
  const trades = cloneBook(only([row(), row({ trade_id: "2026-10-12-O-2", pnl_usd: -20 })])).trades;
  it("agrees within rounding, differs beyond it, and is not compared on a different count", () => {
    expect(crossCheck(trades, { trades: 2, total_usd: 29.94 })).toEqual({ status: "agree" });
    expect(crossCheck(trades, { trades: 2, total_usd: 29.9 })).toEqual({ status: "agree" });
    expect(crossCheck(trades, { trades: 2, total_usd: 80 })).toMatchObject({ status: "differ", clone: 80, trades: 2 });
    expect(crossCheck(trades, { trades: 3, total_usd: 80 })).toEqual({ status: "not-comparable" });
    expect(crossCheck(trades, { trades: 2, total_usd: null })).toEqual({ status: "not-comparable" });
    expect(crossCheck(trades, null)).toEqual({ status: "not-comparable" });
    expect(crossCheck([], { trades: 0, total_usd: 0 })).toEqual({ status: "not-comparable" });
  });
});

describe("the list", () => {
  it("is newest first, in New York's times, with the result on the premium and in R", () => {
    const rows = paperRows(cloneBook(doc()));
    expect(rows[0]!.at).toBeGreaterThanOrEqual(rows[1]!.at);
    const r = rows.find((x) => x.id === "2026-10-12-O-1")!;
    expect(r).toMatchObject({ day: "12 Oct 26", symbol: "SPY", kind: "call", short: false, qty: 1, entry: 1.42, exit: 1.79, reason: "Target", hyp: "HYP-0029", window: "No open-interest floor" });
    expect(r.opened).toMatch(/^\d{2}:\d{2}$/);
    expect(r.r).toBeCloseTo(r.rop! / R_UNIT);
    expect(rows.filter((x) => x.roughTime).length).toBe(1);
  });
});

describe("staleness", () => {
  it("says so more than a day behind, or when the time cannot be read", () => {
    expect(paperStale({ as_of: "2026-10-12T20:10:00+00:00" }, new Date("2026-10-13T20:00:00Z"))).toBe(false);
    expect(paperStale({ as_of: "2026-10-12T20:10:00+00:00" }, new Date("2026-10-14T00:00:00Z"))).toBe(true);
    expect(paperStale({ as_of: "soon" }, new Date("2026-10-12T20:10:00Z"))).toBe(true);
  });
});
