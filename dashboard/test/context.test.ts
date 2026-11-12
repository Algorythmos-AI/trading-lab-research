// context.ts: the market bar's 10-minute closes, trend, one index's direction and the two indexes together. Pure:
// fixed instants on the real exchange calendar, each rule at pass, fail, missing and its exact boundary.
import { describe, expect, it } from "vitest";
import {
  ageWords,
  direction,
  firstTrendAt,
  indexInput,
  type IndexInput,
  type IndexReading,
  type IndexRow,
  marketRead,
  spreadWords,
  STALE_MS,
  tenMinuteCloses,
  trend,
  volumeWords,
  whyWords,
} from "@/lib/context";
import { type FlowBar, FULL_SESSION_SLOTS, SLOT_MS, slotClock, type SlotClock } from "@/lib/flow";
import { SERVER_SETTLE_MS } from "@/lib/trade-state";

// 2026-11-12, a Thursday on EST: 09:30 New York is 14:30Z.
const DAY = "2026-11-12";
const OPEN = Date.parse("2026-11-12T14:30:00Z");
const MIN = 60_000;
/** The clock with exactly `completed` slots done (the settle passed for the last of them). */
const clockAt = (completed: number): SlotClock => slotClock(OPEN + completed * SLOT_MS + SERVER_SETTLE_MS)!;

const bar = (k: number, c: number, v = 1_000, vw: number | null = c): FlowBar => ({ start: OPEN + k * SLOT_MS, end: OPEN + (k + 1) * SLOT_MS, o: c, h: c + 0.1, l: c - 0.1, c, v, vw, n: 10 });
/** One bar per slot 0..n-1, its close given by `close(k)`. */
const bars = (n: number, close: (k: number) => number): FlowBar[] => Array.from({ length: n }, (_, k) => bar(k, close(k)));

const baseline = (sym: string) => ({
  for_session: DAY,
  names: { [sym]: { slot_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 1_000), cum_median: Array.from({ length: FULL_SESSION_SLOTS }, (_, k) => 1_000 * (k + 1)), n: 20 } },
});

const closesOf = (b: FlowBar[], c: SlotClock) => tenMinuteCloses(b, c).map((x) => x.close);

describe("tenMinuteCloses", () => {
  it("counts a block only when all five of its slots have completed, keyed by block", () => {
    const b = bars(30, (k) => 100 + k);
    // 24 slots done: blocks 0..3 (slots 0..19) complete, block 4 has 4 of 5
    expect(closesOf(b, clockAt(24))).toEqual([104, 109, 114, 119]);
    expect(tenMinuteCloses(b, clockAt(25)).at(-1)).toEqual({ block: 4, close: 124, bars: 5, hasLast: true });
  });

  it("a block still forming never counts, nor the forming bar", () => {
    const c = clockAt(27); // slot 27 forming, block 5 has slots 25 and 26 done
    expect(closesOf(bars(28, (k) => 100 + k), c)).toEqual([104, 109, 114, 119, 124]);
  });

  it("a missing bar inside a block carries the previous close; a block with no bars is absent, its index kept", () => {
    const b = bars(25, (k) => 100 + k).filter((x) => x.start !== OPEN + 9 * SLOT_MS); // block 1's last bar missing
    expect(tenMinuteCloses(b, clockAt(25))[1]).toEqual({ block: 1, close: 108, bars: 4, hasLast: false });
    const gap = bars(25, (k) => 100 + k).filter((x) => x.start < OPEN + 10 * SLOT_MS || x.start >= OPEN + 15 * SLOT_MS); // block 2 empty
    expect(tenMinuteCloses(gap, clockAt(25)).map((x) => x.block)).toEqual([0, 1, 3, 4]);
  });

  it("out-of-order and duplicate bars: one per slot, the last given wins, in slot order", () => {
    const b = bars(25, (k) => 100 + k);
    const shuffled = [...b].reverse();
    expect(closesOf(shuffled, clockAt(25))).toEqual([104, 109, 114, 119, 124]);
    const dup = [...b, bar(24, 200)]; // slot 24 given twice: the later one stands
    expect(tenMinuteCloses(dup, clockAt(25)).at(-1)).toEqual({ block: 4, close: 200, bars: 5, hasLast: true });
  });

  it("no bars or no clock: no closes", () => {
    expect(tenMinuteCloses(null, clockAt(25))).toEqual([]);
    expect(tenMinuteCloses(bars(25, () => 100), null)).toEqual([]);
  });
});

describe("trend", () => {
  it("needs five closes: four is too early", () => {
    expect(trend([1, 2, 3, 4])).toEqual({ trend: null, why: "too-early", closes: [1, 2, 3, 4] });
    expect(trend([1, 2, 3, 4, 5]).trend).toBe("up");
  });

  it("reads only the last five", () => {
    expect(trend([9, 9, 1, 2, 3, 4, 5])).toEqual({ trend: "up", closes: [1, 2, 3, 4, 5] });
  });

  it("up needs the last above the first AND three of four rising steps: two is range", () => {
    expect(trend([10, 11, 12, 13, 12.5]).trend).toBe("up"); // 3 rising
    expect(trend([10, 11, 10.5, 12, 11.5]).trend).toBe("range"); // last above first, 2 rising
    expect(trend([10, 11, 12, 13, 9]).trend).toBe("range"); // 3 rising, last below first
    expect(trend([10, 10, 11, 12, 13]).trend).toBe("up"); // a flat step is neither
    expect(trend([10, 10, 10, 11, 12]).trend).toBe("range"); // only 2 rising
  });

  it("down is the mirror", () => {
    expect(trend([13, 12, 11, 10, 10.5]).trend).toBe("down");
    expect(trend([13, 12, 12.5, 11, 11.5]).trend).toBe("range");
  });
});

/** A clean rising day for one index at 30 completed slots (block 5 complete), price above VWAP. */
function rising(over: Partial<IndexRow> = {}, completed = 30, ageMs: number | null = 1_000): IndexInput {
  const c = clockAt(completed);
  const asOf = c.now;
  const iso = new Date(asOf).toISOString();
  const row: IndexRow = { price: 120, trade_at: iso, bid: 119.99, ask: 120.01, quote_at: iso, bars: bars(completed + 1, (k) => 100 + k * 0.5), ...over };
  return { symbol: "SPY", row, baseline: baseline("SPY"), clock: c, asOf, ageMs };
}

describe("direction", () => {
  it("up: above VWAP and the trend up, with the evidence", () => {
    const r = direction(rising());
    expect(r).toMatchObject({ direction: "up", why: null, price: 120, side: "above", trend: { trend: "up" } });
    expect(r.closes).toEqual([104.5, 107, 109.5, 112, 114.5]); // blocks 1..5's last bars (slots 9 to 29)
    expect(r.vwap).toBeCloseTo(107.25, 6);
    expect(r.volume).toEqual({ value: 1, sessions: 20 });
    expect(r.spread.bps).toBeCloseTo(1.667, 2);
    expect(r.ageMs).toBe(1_000);
  });

  it("down mirrored; a rising trend below VWAP or a falling one above it is range", () => {
    const c = 30;
    const down = rising({ price: 80, bars: bars(c + 1, (k) => 100 - k * 0.5) });
    expect(direction(down).direction).toBe("down");
    expect(direction(rising({ price: 90 })).direction).toBe("range"); // trend up, price below VWAP
    expect(direction(rising({ price: 120, bars: bars(c + 1, (k) => 100 - k * 0.5) })).direction).toBe("range");
  });

  it("the VWAP dead band: on its edge is at (range), just past it is above", () => {
    // VWAP 10,000 exactly (every bar's vw), so the 3 bp edge is a whole number: 10,003.
    const flat = bars(31, (k) => 9_990 + k * 0.5).map((b) => ({ ...b, vw: 10_000 }));
    const at = (p: number) => direction(rising({ price: p, bid: p - 0.001, ask: p + 0.001, bars: flat }));
    expect(at(10_003)).toMatchObject({ vwap: 10_000, side: "at", direction: "range" });
    expect(at(10_003.01)).toMatchObject({ side: "above", direction: "up" });
    expect(at(9_997)).toMatchObject({ side: "at", direction: "range" });
    expect(at(10_003).trend.trend).toBe("up"); // "at" VWAP with an up trend is range
  });

  it("fewer than five 10-minute closes is too early: 24 slots no, 25 yes", () => {
    expect(direction(rising({}, 24))).toMatchObject({ direction: null, why: "too-early" });
    expect(direction(rising({}, 25)).direction).toBe("up");
  });

  it("stale: the answer's checked age at exactly 20 s still counts, 20.001 s does not", () => {
    expect(direction(rising({}, 30, STALE_MS)).direction).toBe("up");
    expect(direction(rising({}, 30, STALE_MS + 1))).toMatchObject({ direction: null, why: "stale" });
    expect(direction(rising({}, 30, 20_000.001))).toMatchObject({ direction: null, why: "stale" });
    expect(direction(rising({}, 30, null))).toMatchObject({ direction: null, why: "stale" });
  });

  it("stale: the trade or quote standing before as_of adds to the age", () => {
    const i = rising({}, 30, 15_000);
    const old = new Date(i.asOf! - 5_001).toISOString();
    expect(direction({ ...i, row: { ...i.row!, quote_at: old } })).toMatchObject({ direction: null, why: "stale", ageMs: 20_001 });
    expect(direction({ ...i, row: { ...i.row!, trade_at: new Date(i.asOf! - 5_000).toISOString() } }).direction).toBe("up");
    expect(direction({ ...i, row: { ...i.row!, trade_at: null } }).why).toBe("stale");
  });

  it("outside the session is closed", () => {
    const i = rising();
    const after = slotClock(Date.parse("2026-11-12T21:00:00Z"))!;
    expect(direction({ ...i, clock: after }).why).toBe("closed");
    expect(direction({ ...i, clock: slotClock(Date.parse("2026-11-12T14:00:00Z")) }).why).toBe("closed");
    expect(direction({ ...i, clock: null }).why).toBe("closed");
  });

  it("missing pieces each give their reason, never a direction", () => {
    expect(direction({ ...rising(), row: null }).why).toBe("no-bars");
    expect(direction(rising({ bars: null })).why).toBe("no-bars");
    expect(direction(rising({ bars: [] })).why).toBe("no-bars");
    expect(direction(rising({ price: null })).why).toBe("no-price");
    expect(direction(rising({ bid: null })).why).toBe("one-sided");
    expect(direction(rising({ bid: 120.02, ask: 120.01 })).why).toBe("crossed");
    const noVw = rising();
    noVw.row!.bars![3] = { ...noVw.row!.bars![3]!, vw: null };
    expect(direction(noVw).why).toBe("no-vwap");
  });

  it("a locked quote is a market, not bad data: the reading stands and the spread says locked", () => {
    expect(direction(rising({ bid: 120, ask: 120 }))).toMatchObject({ direction: "up", spread: { bps: null, why: "locked" } });
  });

  it("bars lagging the clock (nothing in the last completed block) give no direction", () => {
    const i = rising();
    const lag = { ...i, row: { ...i.row!, bars: i.row!.bars!.filter((b) => b.start < OPEN + 25 * SLOT_MS) } };
    expect(direction(lag).why).toBe("lagging");
  });

  /** A rising day read at New York time `now` (ms), with only the slots `keep` lets through. */
  const readAt = (now: number, keep: (k: number) => boolean = () => true, over: Partial<IndexRow> = {}) => {
    const c = slotClock(now)!;
    const iso = new Date(now).toISOString();
    const all = bars(c.completed + 1, (k) => 100 + k * 0.5).filter((_, k) => keep(k));
    return direction({ symbol: "SPY", row: { price: 200, trade_at: iso, bid: 199.99, ask: 200.01, quote_at: iso, bars: all, ...over }, baseline: baseline("SPY"), clock: c, asOf: now, ageMs: 1_000 });
  };

  it("M1: at 10:31:30 with slots 26 to 29 missing, the bars lag: no direction and no VWAP", () => {
    const now = OPEN + 61.5 * MIN; // 30 slots done (0..29)
    expect(slotClock(now)!.completed).toBe(30);
    expect(readAt(now)).toMatchObject({ direction: "up" });
    expect(readAt(now, (k) => k < 26 || k > 29)).toMatchObject({ direction: null, why: "lagging", vwap: null });
  });

  it("M1: bars only at slots 0-9, 14, 19, 24 and 25 lag, whether or not the last slot is there", () => {
    const only = (k: number) => k <= 9 || [14, 19, 24, 25].includes(k);
    expect(readAt(OPEN + 61.5 * MIN, only).why).toBe("lagging"); // slot 29 missing
    expect(readAt(clockAt(26).now, only)).toMatchObject({ direction: null, why: "lagging" }); // slot 25 there, blocks 2 and 3 thin
  });

  it("M1: a block needs its last slot's bar and 4 of its 5; one missing mid-block slot still reads", () => {
    const now = OPEN + 61.5 * MIN;
    expect(readAt(now, (k) => k !== 17).direction).toBe("up"); // block 3 has 4 of 5, its last there
    expect(readAt(now, (k) => k !== 19).why).toBe("lagging"); // block 3's last slot missing
    expect(readAt(now, (k) => k !== 16 && k !== 17).why).toBe("lagging"); // 3 of 5
  });

  it("M2: the five closes are the five consecutive latest blocks: block 2 of 6 missing gives no direction", () => {
    expect(readAt(OPEN + 61.5 * MIN, (k) => k < 10 || k > 14)).toMatchObject({ direction: null, why: "lagging" });
    // block 0 missing is outside the last five (1..5): the reading stands
    expect(readAt(OPEN + 61.5 * MIN, (k) => k > 4).direction).toBe("up");
  });

  it("the first reading at 10:21:00 New York, not at 10:20:59", () => {
    expect(readAt(OPEN + 51 * MIN - 1_000)).toMatchObject({ direction: null, why: "too-early" });
    expect(readAt(OPEN + 51 * MIN).direction).toBe("up");
  });

  it("a half day: read in the session, closed from 13:00 New York", () => {
    const halfOpen = Date.parse("2026-11-27T14:30:00Z"); // the day after Thanksgiving, 09:30 to 13:00
    const at = (now: number) => {
      const c = slotClock(now)!;
      const iso = new Date(now).toISOString();
      const b = Array.from({ length: c.completed + 1 }, (_, k) => ({ ...bar(k, 100 + k * 0.5), start: halfOpen + k * SLOT_MS, end: halfOpen + (k + 1) * SLOT_MS }));
      return direction({ symbol: "SPY", row: { price: 200, trade_at: iso, bid: 199.99, ask: 200.01, quote_at: iso, bars: b }, baseline: null, clock: c, asOf: now, ageMs: 1_000 });
    };
    expect(slotClock(halfOpen)!.slots).toBe(105);
    expect(at(halfOpen + 150 * MIN)).toMatchObject({ direction: "up", volume: { value: null, why: "no-baseline" } });
    expect(at(Date.parse("2026-11-27T18:00:00Z")).why).toBe("closed");
  });

  it("closed stays closed until the next open, however old the answer; past the open it is stale", () => {
    const after = Date.parse("2026-11-12T22:00:00Z"); // 17:00 New York Thursday; next open Friday 14:30Z
    const i = { ...rising(), clock: slotClock(after), asOf: after };
    expect(direction({ ...i, ageMs: 60 * MIN }).why).toBe("closed");
    expect(direction({ ...i, ageMs: Date.parse("2026-11-13T14:30:00Z") - after }).why).toBe("stale");
    expect(direction({ ...i, ageMs: null }).why).toBe("stale");
  });

  it("indexInput builds the input from an answer: its clock from as_of, never the device", () => {
    const i = rising();
    const answer = { as_of: new Date(i.asOf!).toISOString(), baseline: i.baseline!, names: { SPY: i.row! } };
    const built = indexInput(answer, "SPY", 1_000);
    expect(built.clock).toEqual(i.clock);
    expect(direction(built).direction).toBe("up");
    expect(indexInput(answer, "QQQ", 1_000).row).toBeNull();
    expect(indexInput(null, "SPY", 1_000)).toMatchObject({ row: null, clock: null, asOf: null });
  });
});

describe("marketRead", () => {
  const r = (symbol: string, d: IndexReading["direction"], why: IndexReading["why"] = null) => ({ ...direction(rising()), symbol, direction: d, why });
  it("both up, both down, both range, and disagreeing is mixed", () => {
    expect(marketRead(r("SPY", "up"), r("QQQ", "up"))).toEqual({ read: "up", why: null });
    expect(marketRead(r("SPY", "down"), r("QQQ", "down"))).toEqual({ read: "down", why: null });
    expect(marketRead(r("SPY", "range"), r("QQQ", "range"))).toEqual({ read: "range", why: null });
    expect(marketRead(r("SPY", "up"), r("QQQ", "down")).read).toBe("mixed");
    expect(marketRead(r("SPY", "up"), r("QQQ", "range")).read).toBe("mixed");
  });

  it("any disagreement is MIXED, range included: one up and one range shows the word", () => {
    expect(marketRead(r("SPY", "range"), r("QQQ", "up"))).toEqual({ read: "mixed", why: null });
    expect(marketRead(r("SPY", "down"), r("QQQ", "range"))).toEqual({ read: "mixed", why: null });
  });

  it("null when either has no direction, with each one's reason", () => {
    expect(marketRead(r("SPY", "up"), r("QQQ", null, "crossed"))).toEqual({ read: null, why: [{ symbol: "QQQ", why: "crossed" }] });
    expect(marketRead(r("SPY", null, "stale"), r("QQQ", null, "stale")).why).toHaveLength(2);
  });
});

describe("words", () => {
  it("say the reasons plainly", () => {
    expect(whyWords("too-early", clockAt(10))).toBe("before 10:21: not enough bars yet");
    expect(new Date(firstTrendAt(clockAt(10))).toISOString()).toBe("2026-11-12T15:21:00.000Z");
    expect(whyWords("stale", null, 25_000)).toBe("prices are 25 s old");
    expect(whyWords("stale", null, 25_000.5)).toBe("prices are 26 s old");
    expect(whyWords("stale", null, 4 * 60 * MIN)).toBe("prices are over an hour old");
    expect(whyWords("closed")).toBe("market closed");
    expect(ageWords(150_000)).toBe("2 min");
  });

  it("volume and spread", () => {
    expect(volumeWords({ value: 1.44, sessions: 20 })).toBe("1.4× normal volume");
    expect(volumeWords({ value: null, why: "thin-baseline" })).toBe("volume: too few past sessions");
    expect(spreadWords({ bps: 0.26 })).toBe("0.3 bp spread");
    expect(spreadWords({ bps: null, why: "crossed" })).toBe("crossed");
    expect(spreadWords({ bps: null, why: "locked" })).toBe("locked");
  });
});
