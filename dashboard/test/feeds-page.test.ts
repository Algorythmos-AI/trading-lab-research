import { describe, expect, it } from "vitest";
import { ageMs, candleGeometry, parseLiveAnswer, rowView, serverClock, spreadOf, spreadText, TRADE_STALE_MS, tradeStale } from "@/lib/feeds-live";
import { chainStatus, comparedRows, fixtureDay, fixtureReports, MAX_COMPARED, previousSessionDay, stampPanel, toComparedSession } from "@/lib/feeds-page";
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

  it("is stale only past TRADE_STALE_MS, and with no trade time", () => {
    expect(tradeStale(TRADE_STALE_MS)).toBe(false);
    expect(tradeStale(TRADE_STALE_MS + 1)).toBe(true);
    expect(tradeStale(null)).toBe(true);
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

  it("greys a row past the limit with how long, and says when there is no price", () => {
    const t0 = Date.parse("2026-10-12T15:00:00Z");
    const row = (p: number | null, t: number | null) => ({ trade: { p, t }, quote: { bp: 1, bs: 1, ap: 1.01, as: 1, t }, bars: [] });
    const fresh = rowView("SPY", "sip", row(500, t0 - TRADE_STALE_MS), t0);
    expect(fresh).toMatchObject({ feed: "SIP", price: 500, stale: false, staleLine: null, tradeAgeMs: TRADE_STALE_MS });
    const old = rowView("SPY", "sip", row(500, t0 - TRADE_STALE_MS - 1_000), t0);
    expect(old).toMatchObject({ stale: true, staleLine: "No new price for 121 s" });
    expect(rowView("QQQ", "iex", undefined, t0)).toMatchObject({ feed: "IEX", price: null, stale: true, staleLine: "No price on IEX", tradeAgeMs: null });
    expect(rowView("QQQ", "iex", row(500, t0), null)).toMatchObject({ stale: true, staleLine: "No price on IEX" });
  });

  it("draws only whole bars, volume under the prices", () => {
    const v = rowView("SPY", "sip", { trade: { p: 1, t: 0 }, quote: { bp: null, bs: null, ap: null, as: null, t: null }, bars: [{ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: 1, o: null, h: 2, l: 1, c: 1, v: 1 }, { t: 2, o: 1.5, h: 1.6, l: 1, c: 1.2, v: null }] }, 0);
    expect(v.bars).toHaveLength(2);
    const g = candleGeometry(v.bars, 320, 120)!;
    expect(g.low).toBe(0.5);
    expect(g.high).toBe(2);
    expect(g.candles[0]!.volTop).not.toBeNull();
    expect(g.candles[1]!.volTop).toBeNull();
    expect(g.candles.every((c) => c.wickTop >= 0 && c.wickBottom <= g.priceHeight)).toBe(true);
    expect(candleGeometry([], 320, 120)).toBeNull();
  });

  it("parseLiveAnswer refuses an answer with no feed or server time", () => {
    expect(parseLiveAnswer({ feed: "delayed_sip", as_of: "x", served_at: "2026-10-12T15:00:00Z", rows: {} })).toBeNull();
    expect(parseLiveAnswer({ feed: "sip", as_of: "x", served_at: "never", rows: {} })).toBeNull();
    expect(parseLiveAnswer({ feed: "sip", as_of: "x", served_at: "2026-10-12T15:00:00Z", rows: { SPY: { trade: { p: "1" } } } })!.rows.SPY!.trade.p).toBeNull();
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
});
