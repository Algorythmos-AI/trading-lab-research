import { describe, expect, it } from "vitest";
import {
  ageMs,
  type BookIn,
  candleGeometry,
  CLOCK_UNKNOWN,
  compareShown,
  type LiveRow,
  oldRender,
  PANEL_MAX_AGE_MS,
  panelOutOfDate,
  parseLiveAnswer,
  type PriceIn,
  ROUTE_FAILED,
  rowView,
  serverClock,
  spreadOf,
  spreadText,
  tickWoke,
  TRADE_STALE_MS,
  tradeStale,
} from "@/lib/feeds-live";
import { FEED_STALE_MS } from "@/lib/trade-state";
import { liveRead, type LiveQuote, type OptionsTicker } from "@/lib/options";
import edition from "./fixtures/options.v1.json";
import { chainStatus, comparedRows, fixtureDay, fixtureReports, MAX_COMPARED, previousSession, previousSessionDay, stampPanel, toComparedSession } from "@/lib/feeds-page";
import { nyInstant } from "@/lib/options";

// The Feeds page's pure parts: the stored comparison read defensively (and never with a per-slot field), the live
// rows' ages, spread and staleness at their limits, and today's stamp panel.

const FULL = fixtureReports()[1] as Record<string, unknown>;

describe("toComparedSession", () => {
  it("reads every field of a full v1 report", () => {
    expect(toComparedSession(FULL)).toEqual({
      day: "2026-10-09",
      engine: "e-fixture00000",
      minutes: 390,
      expected: 390,
      identicalPct: 97.4,
      enterSip: 3,
      enterIex: 5,
      enterMatched: 3,
      priceDiffMedianBp: 0.8,
      priceDiffP95Bp: 3.9,
      priceDiffN: 1550,
      volumeRatio: { value: 38.5, n: 780 },
      spreadSip: { value: 0.6, n: 1550 },
      spreadIex: { value: 2.4, n: 1550 },
      tradeAgeP95Sip: { value: 1.6, n: 1550 },
      tradeAgeP95Iex: { value: 31, n: 1550 },
      notComparable: 7,
      signalsStatus: "ok",
      signalsWhy: null,
    });
  });

  it("turns each missing or wrong field into null, never a zero", () => {
    const s = toComparedSession({ v: 1, day: "2026-10-09", signals: { identical_pct: "97" }, prices: { not_comparable: { a: 2, b: -1 } }, spread: { sip_bp: { median: 1.2 } } })!;
    expect(s.day).toBe("2026-10-09");
    expect(s.identicalPct).toBeNull();
    expect(s.minutes).toBeNull();
    expect(s.enterSip).toBeNull();
    expect(s.notComparable).toBeNull();
    expect(s.spreadSip).toEqual({ value: 1.2, n: null });
    expect(s.volumeRatio).toEqual({ value: null, n: null });
    expect(s.engine).toBeNull();
  });

  it("refuses what is not a v1 report", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { v: 2, day: "2026-10-09" }, { v: "1" }]) expect(toComparedSession(bad)).toBeNull();
    expect(toComparedSession({ v: 1, day: "yesterday" })!.day).toBeNull();
  });

  it("carries no per-slot field into the rendered model, whatever the report holds", () => {
    const withSlots = { ...FULL, disagreements: [{ symbol: "SPY", slot: "10:02", sip: "WAIT", iex: "ENTER" }], slots: [{ symbol: "SPY" }] };
    const rows = comparedRows([withSlots]);
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    };
    walk(rows);
    expect(keys.has("disagreements")).toBe(false);
    expect(keys.has("slots")).toBe(false);
    expect(keys.has("symbol")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("ENTER");
  });

  it("orders the rows newest first and keeps at most MAX_COMPARED", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...FULL, day: `2026-09-${String(i + 1).padStart(2, "0")}` }));
    const rows = comparedRows([...many, { v: 1 }, "junk"]);
    expect(rows).toHaveLength(MAX_COMPARED);
    expect(rows[0]!.day).toBe("2026-09-25");
    expect(rows.map((r) => r.day)).toEqual([...rows.map((r) => r.day)].sort().reverse());
  });
});

describe("the live rows' view helpers", () => {
  it("carries the server clock forward on the monotonic clock only", () => {
    expect(serverClock("2026-10-12T15:00:00Z", 1_000, 4_000)).toBe(Date.parse("2026-10-12T15:00:03Z"));
    expect(serverClock("2026-10-12T15:00:00Z", 1_000, 500)).toBe(Date.parse("2026-10-12T15:00:00Z"));
    expect(serverClock("not a time", 0, 0)).toBeNull();
    expect(ageMs(null, 5)).toBeNull();
    expect(ageMs(10, null)).toBeNull();
    expect(ageMs(10, 5)).toBe(0);
  });

  it("is stale only past the board's limits, and with no trade time or no clock", () => {
    expect(tradeStale(TRADE_STALE_MS, 0)).toBe(false);
    expect(tradeStale(TRADE_STALE_MS + 1, 0)).toBe(true);
    expect(tradeStale(1_000, FEED_STALE_MS)).toBe(false);
    expect(tradeStale(1_000, FEED_STALE_MS + 1)).toBe(true);
    expect(tradeStale(null, 0)).toBe(true);
    expect(tradeStale(1_000, null)).toBe(true);
  });

  it("names a locked or crossed book and never gives it a number", () => {
    expect(spreadOf(100, 100)).toEqual({ kind: "locked" });
    expect(spreadOf(100.01, 100)).toEqual({ kind: "crossed" });
    expect(spreadText(spreadOf(100, 100))).toBe("locked");
    expect(spreadText(spreadOf(100.01, 100))).toBe("crossed");
    const s = spreadOf(99.99, 100.01);
    expect(s.kind).toBe("bp");
    expect(spreadText(s)).toBe("2.0 bp");
    expect(spreadText(spreadOf(null, 100))).toBe("not available (no bid or no ask)");
    expect(spreadText(spreadOf(0, 100))).toBe("not available (a side at zero)");
  });

  const T0 = Date.parse("2026-10-12T15:00:00Z");
  const row = (bars: LiveRow["bars"] = []): LiveRow => ({ quote: { bp: 1, bs: 1, ap: 1.01, as: 1, t: T0 - 4_000 }, bars });
  const book = (over: Partial<BookIn> = {}): BookIn => ({ feed: "SIP", row: row(), clock: T0, servedAt: T0, failing: false, slept: false, ...over });
  const SPY = (edition.tickers as OptionsTicker[]).find((t) => t.symbol === "SPY")!;
  const quote = (atMs: number): LiveQuote => ({ price: 780.1, at: new Date(atMs).toISOString(), open: 778.55, high: 781, low: 777, day: "2026-10-12", prev_close: 778.55, vwap: 779 });
  /** The board's own read at T0 of a trade `ageMs` old, the quotes answered just now. */
  const boardRead = (ageMs: number, now = T0) => liveRead(SPY, quote(now - ageMs), "2026-10-12", now, now);
  const price = (over: Partial<PriceIn> = {}): PriceIn => ({ feed: "SIP", read: boardRead(3_000), tradeAgeMs: 3_000, noTradeToday: false, failing: false, slept: false, ...over });

  it("takes the price and its verdict from the board's own read, and greys with how long", () => {
    expect(rowView("SPY", price(), book())).toMatchObject({ price: "780.10", tradeAge: "3 s", quoteAge: "4 s", stale: false, staleLine: null, priceFeed: "SIP" });
    expect(rowView("QQQ", price({ read: null, tradeAgeMs: null }), book())).toMatchObject({ price: "not available", stale: true, staleLine: "No price on SIP" });
  });

  it("a 45 s old trade is stale on the board's chip and on the Feeds row alike", () => {
    const r = boardRead(45_000);
    expect(r.inSession).toBe(true);
    expect(r.stale).toBe(true); // what the board's StateChip draws as STALE
    expect(rowView("SPY", price({ read: r, tradeAgeMs: 45_000 }), book())).toMatchObject({ stale: true, staleLine: "No new price for 45 s" });
    // At the board's 30 s limit itself neither is stale.
    const edge = boardRead(30_000);
    expect(edge.stale).toBe(false);
    expect(rowView("SPY", price({ read: edge, tradeAgeMs: 30_000 }), book()).stale).toBe(false);
  });

  it("outside the session shows the board's price, greyed as not live, and no trade today before the open", () => {
    const preOpen = Date.parse("2026-10-12T13:00:00Z");
    const r = liveRead(SPY, quote(Date.parse("2026-10-09T19:59:00Z")), "2026-10-12", preOpen, preOpen);
    expect(r.inSession).toBe(false);
    const v = rowView("SPY", price({ read: r, tradeAgeMs: null, noTradeToday: true }), book());
    expect(v).toMatchObject({ price: r.price!.toFixed(2), tradeAge: "no trade today", stale: true, staleLine: "Not live: no trade today", tradeAgeMs: null });
  });

  it("while a source fails, greys every row and puts no age on screen", () => {
    const quotesDown = rowView("SPY", price({ failing: true }), book());
    expect(quotesDown).toMatchObject({ stale: true, tradeAge: ROUTE_FAILED, price: ROUTE_FAILED, tradeAgeMs: null });
    const bookDown = rowView("SPY", price(), book({ failing: true }));
    expect(bookDown).toMatchObject({ stale: true, quoteAge: ROUTE_FAILED, staleLine: `Quote and bars ${ROUTE_FAILED}` });
    expect(bookDown.spread.kind).toBe("none");
  });

  it("after the tab was hidden, treats the clock as unknown until a new answer", () => {
    const p = rowView("SPY", price({ slept: true }), book());
    expect(p).toMatchObject({ stale: true, tradeAge: CLOCK_UNKNOWN, tradeAgeMs: null });
    const b = rowView("SPY", price(), book({ slept: true }));
    expect(b).toMatchObject({ stale: true, quoteAge: CLOCK_UNKNOWN });
  });

  it("draws only whole bars, marks the forming one, and says when the bars were cut short", () => {
    const bars = [
      { t: T0 - 360_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: T0 - 240_000, o: null, h: 2, l: 1, c: 1, v: 1 },
      { t: T0 - 60_000, o: 1.5, h: 1.6, l: 1, c: 1.2, v: null },
    ];
    const v = rowView("SPY", price(), book({ row: row(bars) }));
    expect(v.bars).toHaveLength(2);
    expect(v.bars!.map((b) => b.forming)).toEqual([false, true]);
    const g = candleGeometry(v.bars!, 320, 120)!;
    expect(g.low).toBe(0.5);
    expect(g.high).toBe(2);
    expect(g.candles[0]!.volTop).not.toBeNull();
    expect(g.candles[1]!.volTop).toBeNull();
    expect(g.candles[1]!.forming).toBe(true);
    expect(g.candles.every((c) => c.wickTop >= 0 && c.wickBottom <= g.priceHeight)).toBe(true);
    expect(candleGeometry([], 320, 120)).toBeNull();
    expect(rowView("SPY", price(), book({ row: row(null) })).bars).toBeNull();
  });

  it("parseLiveAnswer refuses an answer with no feed or server time, and keeps a cut-short null", () => {
    expect(parseLiveAnswer({ feed: "delayed_sip", as_of: "x", served_at: "2026-10-12T15:00:00Z", rows: {} })).toBeNull();
    expect(parseLiveAnswer({ feed: "sip", as_of: "x", served_at: "never", rows: {} })).toBeNull();
    const a = parseLiveAnswer({ feed: "sip", as_of: "x", served_at: "2026-10-12T15:00:00Z", rows: { SPY: { quote: { bp: "1" }, bars: null } } })!;
    expect(a.rows.SPY!.quote.bp).toBeNull();
    expect(a.rows.SPY!.bars).toBeNull();
  });
});

describe("failing closed", () => {
  const OPEN = Date.parse("2026-10-13T13:30:00Z");
  const base = { hideAt: OPEN, mountPerf: 1_000, perfNow: 2_000, answer: { servedAt: OPEN - 60_000, perfReceived: 1_500, failing: false }, routeError: false, wakePerf: null };

  it("shows the compared sessions only once an answer after this mount puts the server time before the next open", () => {
    expect(compareShown(base)).toBe(true);
    expect(compareShown({ ...base, perfNow: 1_500 + 60_000 })).toBe(false); // the clock reached the open
    expect(compareShown({ ...base, answer: { ...base.answer, failing: true } })).toBe(false);
    expect(compareShown({ ...base, routeError: true })).toBe(false);
    expect(compareShown({ ...base, wakePerf: 1_800 })).toBe(false); // hidden since that answer
    expect(compareShown({ ...base, wakePerf: 1_200 })).toBe(true); // an answer after the wake vouches again
    expect(compareShown({ ...base, hideAt: null })).toBe(false);
    expect(compareShown({ ...base, answer: null })).toBe(false); // the render's own time alone is never trusted
  });

  it("a remount with an old server time keeps the table hidden until a fresh answer", () => {
    // A back/forward restore: the page mounts again at perf 10 000; the provider still holds an answer from before it.
    const remount = { ...base, mountPerf: 10_000, perfNow: 10_500 };
    expect(compareShown(remount)).toBe(false);
    expect(oldRender(OPEN - 3 * 3_600_000, OPEN)).toBe(true); // a render hours old: the page refreshes
    expect(oldRender(OPEN - 60_000, OPEN)).toBe(false);
    // The next answer after the remount shows the time again.
    expect(compareShown({ ...remount, answer: { servedAt: OPEN - 30_000, perfReceived: 10_200, failing: false } })).toBe(true);
    // And if that answer says the open has come, it stays hidden.
    expect(compareShown({ ...remount, answer: { servedAt: OPEN + 1, perfReceived: 10_200, failing: false } })).toBe(false);
  });

  it("a wall-clock jump, a backward step or a monotonic gap between ticks counts as a wake", () => {
    const prev = { perf: 1_000, wall: 1_000_000 };
    expect(tickWoke(prev, { perf: 2_000, wall: 1_001_000 }, 5_000)).toBe(false);
    expect(tickWoke(prev, { perf: 2_000, wall: 1_001_000 + 3_600_000 }, 5_000)).toBe(true); // slept; monotonic missed it
    expect(tickWoke(prev, { perf: 2_000, wall: 999_000 }, 5_000)).toBe(true); // the wall clock went back
    expect(tickWoke(prev, { perf: 7_001, wall: 1_001_000 }, 5_000)).toBe(true); // timers stood still
  });

  it("marks the stamp panel out of date past 2 minutes on the monotonic clock, or after a hidden period", () => {
    expect(panelOutOfDate(PANEL_MAX_AGE_MS, false)).toBe(false);
    expect(panelOutOfDate(PANEL_MAX_AGE_MS + 1, false)).toBe(true);
    expect(panelOutOfDate(1_000, true)).toBe(true);
    expect(panelOutOfDate(null, false)).toBe(true);
  });

  it("reads a report's status word and why into its row, and nothing else of the signals", () => {
    const s = toComparedSession({ v: 1, day: "2026-10-09", signals: { status: "no_bars", why: "bars_failed", per_slot: [1] } })!;
    expect(s.signalsStatus).toBe("no_bars");
    expect(s.signalsWhy).toBe("bars_failed");
    expect(toComparedSession({ v: 1, signals: { status: "Not A Word!" } })!.signalsStatus).toBeNull();
  });
});

describe("the stamp panel", () => {
  const DAY = "2026-10-12";
  const at = (m: number) => new Date(nyInstant(DAY, m)!);

  it("says outside a session before the open and on a weekend", () => {
    expect(stampPanel(at(9 * 60), null, null).phase).toBe("outside");
    expect(stampPanel(new Date("2026-10-11T15:00:00Z"), null, null)).toMatchObject({ phase: "outside", day: null });
  });

  it("never reads well with no stamp: the checks are not available", () => {
    const p = stampPanel(at(10 * 60), fixtureDay(DAY, 0, false), null);
    expect(p.phase).toBe("session");
    expect(p.read).toMatchObject({ count: 0, elapsed: 30, lastAgeMs: null, ok: 0, ends: null });
  });

  it("counts the stamps against the minutes, the last one's age and the ok share", () => {
    const now = at(10 * 60);
    const p = stampPanel(now, fixtureDay(DAY, now.getTime(), false), null);
    expect(p.read!.count).toBe(30);
    expect(p.read!.elapsed).toBe(30);
    expect(p.read!.lastAgeMs).toBe(55_000);
    expect(p.read!.ends).toEqual({ not_sip: false, hidden_change: false });
    expect(p.read!.feeds).toEqual({ sip: 30 });
    expect(stampPanel(at(16 * 60 + 30), fixtureDay(DAY, Infinity, false), null).phase).toBe("closed");
  });

  it("reads the store as unreadable rather than empty", () => {
    expect(stampPanel(at(10 * 60), null, null).read).toBeNull();
    expect(chainStatus(null)).toBe("unreadable");
  });

  it("checks the previous session's chain with verifyChain", () => {
    expect(previousSessionDay(DAY)).toBe("2026-10-09");
    expect(chainStatus(fixtureDay("2026-10-09", Infinity, true))).toBe("ok");
    expect(chainStatus(fixtureDay("2026-10-09", Infinity, false))).toBe("no_manifest");
    const d = fixtureDay("2026-10-09", Infinity, true);
    d.bodies.splice(5, 1);
    expect(chainStatus(d)).toBe("prev_mismatch");
  });

  it("counts the previous session's stamps against its minutes", () => {
    const full = previousSession("2026-10-09", fixtureDay("2026-10-09", Infinity, true));
    expect(full).toMatchObject({ day: "2026-10-09", status: "ok", count: 390, minutes: 390 });
    const d = fixtureDay("2026-10-09", Infinity, true);
    d.stamps.splice(0, 3);
    expect(previousSession("2026-10-09", d)).toMatchObject({ count: 387, minutes: 390 });
    expect(previousSession("2026-10-09", null)).toMatchObject({ status: "unreadable", count: null, minutes: 390 });
    expect(previousSession("2026-10-10", null).minutes).toBeNull();
  });
});
