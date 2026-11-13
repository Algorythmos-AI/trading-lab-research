// flow.ts: the session VWAP, the side of VWAP, the spread, relative volume, a bar's surge and the baseline builder.
// Pure: fixed instants, the real exchange calendar unless a case passes its own.
import { describe, expect, it } from "vitest";
import {
  barRange,
  barSurge,
  type Baseline,
  baselineSessions,
  buildBaseline,
  completedBars,
  type FlowBar,
  type FlowCalendar,
  flowBarOf,
  FULL_SESSION_SLOTS,
  MARKET_CALENDAR,
  type NameBaseline,
  nameBaseline,
  parseBaseline,
  relativeVolume,
  sessionSlots,
  sessionVwap,
  SLOT_MS,
  slotClock,
  slotClockFromAsOf,
  slotIndex,
  spreadBps,
  vwapSide,
} from "@/lib/flow";
import { SERVER_SETTLE_MS } from "@/lib/trade-state";

// 2026-11-12, a Thursday, New York on EST (after the 2026-11-01 change): 09:30 is 14:30Z.
const DAY = "2026-11-12";
const OPEN = Date.parse("2026-11-12T14:30:00Z");
const MIN = 60_000;
const at = (nyMinutesAfterOpen: number) => OPEN + nyMinutesAfterOpen * MIN;

const bar = (k: number, v: number, vw: number | null = 100, open = OPEN): FlowBar => ({ start: open + k * SLOT_MS, end: open + (k + 1) * SLOT_MS, o: 100, h: 101, l: 99, c: 100, v, vw, n: 10 });

/** A name's baseline for DAY: every slot's median 1,000, the cumulative median 1,000 per slot so far. */
const base = (n = 20, forSession = DAY, slotMedian = 1_000): NameBaseline => ({
  for_session: forSession,
  slot_median: Array.from({ length: FULL_SESSION_SLOTS }, () => slotMedian),
  cum_median: Array.from({ length: FULL_SESSION_SLOTS }, (_, k) => slotMedian * (k + 1)),
  n,
});

describe("slots", () => {
  it("a full session has 195 slots, a half day 105, a weekend or holiday none", () => {
    expect(sessionSlots(DAY)).toMatchObject({ open: OPEN, close: Date.parse("2026-11-12T21:00:00Z"), halfDay: false, slots: 195 });
    expect(sessionSlots("2026-11-27")).toMatchObject({ halfDay: true, slots: 105 }); // the day after Thanksgiving, 13:00 close
    expect(sessionSlots("2026-11-14")).toBeNull(); // Saturday
    expect(sessionSlots("2026-11-26")).toBeNull(); // Thanksgiving
  });

  it("keys a bar by New York minutes since 09:30 on both sides of the 2026-11-01 clock change", () => {
    const before = sessionSlots("2026-10-30")!; // Friday, EDT: 09:30 is 13:30Z
    const after = sessionSlots("2026-11-02")!; // Monday, EST: 09:30 is 14:30Z
    expect(slotIndex(Date.parse("2026-10-30T13:30:00Z"), before)).toBe(0);
    expect(slotIndex(Date.parse("2026-11-02T14:30:00Z"), after)).toBe(0);
    // 13:30Z on the Monday is 08:30 New York: before the session, no slot
    expect(slotIndex(Date.parse("2026-11-02T13:30:00Z"), after)).toBeNull();
    expect(slotIndex(Date.parse("2026-11-02T20:58:00Z"), after)).toBe(194); // 15:58 New York, the last slot
    expect(slotIndex(Date.parse("2026-11-02T21:00:00Z"), after)).toBeNull(); // 16:00
    expect(slotIndex(Date.parse("2026-11-02T14:31:00Z"), after)).toBeNull(); // off the 2-minute grid
  });

  it("the clock of an answer is its as_of, the server's time", () => {
    expect(slotClockFromAsOf("2026-11-12T14:35:00.000Z")).toEqual(slotClock(at(5)));
    expect(slotClockFromAsOf("nonsense")).toBeNull();
    expect(slotClockFromAsOf(null)).toBeNull();
  });

  it("a slot completes SERVER_SETTLE_MS after it ends; before the open none, after the close all", () => {
    expect(slotClock(at(-1))!.completed).toBe(0);
    expect(slotClock(at(2) + SERVER_SETTLE_MS - 1)!.completed).toBe(0);
    expect(slotClock(at(2) + SERVER_SETTLE_MS)!.completed).toBe(1);
    expect(slotClock(at(5) - 1)!.completed).toBe(1); // 09:34:59.999
    expect(slotClock(at(5))!.completed).toBe(2); // 09:35
    expect(slotClock(at(500))!.completed).toBe(195);
    expect(slotClock(Date.parse("2026-11-14T15:00:00Z"))).toBeNull(); // Saturday
  });

  it("the forming bar and bars of another day are not completed; a repeated slot keeps the last bar", () => {
    const clock = slotClock(at(11))!; // 09:41: slots 0 to 4 completed, slot 5 (09:40) forming
    const yesterday = { ...bar(0, 7), start: OPEN - 86_400_000, end: OPEN - 86_400_000 + SLOT_MS };
    const done = completedBars([bar(5, 9), bar(0, 1), bar(0, 2), yesterday, bar(4, 3)], clock);
    expect(done.map((x) => [x.slot, x.bar.v])).toEqual([
      [0, 2],
      [4, 3],
    ]);
  });
});

describe("sessionVwap", () => {
  const clock = slotClock(at(11))!;
  it("weights each completed bar's vw by its volume", () => {
    expect(sessionVwap([bar(0, 100, 10), bar(1, 300, 20)], clock)).toBe(17.5);
  });
  it("skips a zero-volume bar, even one with no vw", () => {
    expect(sessionVwap([bar(0, 100, 10), bar(1, 0, 50), bar(2, 0, null)], clock)).toBe(10);
  });
  it("a bar that traded with no usable vw makes it null, never a partial VWAP", () => {
    expect(sessionVwap([bar(0, 100, 10), bar(2, 500, null)], clock)).toBeNull();
    expect(sessionVwap([bar(0, 100, 10), bar(2, 500, 0)], clock)).toBeNull();
    // the forming bar's missing vw does not count: it is not completed
    expect(sessionVwap([bar(0, 100, 10), bar(5, 500, null)], clock)).toBe(10);
  });
  it("a non-finite result is null", () => {
    expect(sessionVwap([bar(0, Number.MAX_VALUE, Number.MAX_VALUE)], clock)).toBeNull();
  });
  it("leaves the forming bar out", () => {
    expect(sessionVwap([bar(0, 100, 10), bar(5, 1_000_000, 99)], clock)).toBe(10);
  });
  it("is null with no usable bar, no bars, or no session", () => {
    expect(sessionVwap([bar(0, 0, 10)], clock)).toBeNull();
    expect(sessionVwap([], clock)).toBeNull();
    expect(sessionVwap([bar(0, 100, 10)], null)).toBeNull();
  });
});

describe("vwapSide", () => {
  it("above, below, and at inside the 3 bp band, its edge included", () => {
    expect(vwapSide(10_003, 10_000, null)).toBe("at"); // exactly 3 bp
    expect(vwapSide(9_997, 10_000, null)).toBe("at");
    expect(vwapSide(10_004, 10_000, null)).toBe("above");
    expect(vwapSide(9_996, 10_000, 1)).toBe("below"); // a narrower spread does not shrink the band
  });
  it("widens the band to the spread", () => {
    expect(vwapSide(10_008, 10_000, 8)).toBe("at");
    expect(vwapSide(10_009, 10_000, 8)).toBe("above");
  });
  it("is null without a price or a VWAP", () => {
    expect(vwapSide(null, 100, 2)).toBeNull();
    expect(vwapSide(100, null, 2)).toBeNull();
    expect(vwapSide(Number.NaN, 100, 2)).toBeNull();
    expect(vwapSide(0, 100, 2)).toBeNull();
  });
});

describe("spreadBps", () => {
  it("is (ask - bid) over the mid in basis points", () => {
    expect(spreadBps(99, 101)).toEqual({ bps: 200 });
    expect((spreadBps(99.99, 100.01) as { bps: number }).bps).toBeCloseTo(2, 9);
  });
  it("one-sided, locked and crossed quotes have no number, never a negative one", () => {
    expect(spreadBps(null, 100)).toEqual({ bps: null, why: "one-sided" });
    expect(spreadBps(100, 0)).toEqual({ bps: null, why: "one-sided" });
    expect(spreadBps(100, 100)).toEqual({ bps: null, why: "locked" });
    expect(spreadBps(100.02, 100.01)).toEqual({ bps: null, why: "crossed" });
  });
});

describe("relativeVolume", () => {
  const today = Array.from({ length: 195 }, (_, k) => bar(k, 2_000));
  it("has no value at 09:34 and one at 09:35 New York", () => {
    expect(relativeVolume(today, base(), slotClock(at(4)))).toEqual({ value: null, why: "before-0935" });
    expect(relativeVolume(today, base(), slotClock(at(5) - 1))).toEqual({ value: null, why: "before-0935" });
    // 09:35: slots 0 and 1 completed, 4,000 shares against a median of 2,000 to slot 1
    expect(relativeVolume(today, base(), slotClock(at(5)))).toEqual({ value: 2, sessions: 20 });
  });
  it("needs 10 baseline sessions: 9 is thin", () => {
    expect(relativeVolume(today, base(9), slotClock(at(30)))).toEqual({ value: null, why: "thin-baseline" });
    expect(relativeVolume(today, base(10), slotClock(at(30)))).toEqual({ value: 2, sessions: 10 });
  });
  it("a baseline for another session is stale; none is no-baseline", () => {
    expect(relativeVolume(today, base(20, "2026-11-11"), slotClock(at(30)))).toEqual({ value: null, why: "stale-baseline" });
    expect(relativeVolume(today, null, slotClock(at(30)))).toEqual({ value: null, why: "no-baseline" });
  });
  it("no completed bar today is no-bars; a missing slot counts as no volume", () => {
    expect(relativeVolume([], base(), slotClock(at(30)))).toEqual({ value: null, why: "no-bars" });
    expect(relativeVolume([bar(14, 9_999)], base(), slotClock(at(30)))).toEqual({ value: null, why: "no-bars" }); // only the forming bar
    // 09:41: slots 0 to 4 completed; slots 1 and 2 had no trades, counted as zero
    expect(relativeVolume([bar(0, 2_500), bar(3, 0), bar(4, 0)], base(), slotClock(at(11)))).toEqual({ value: 0.5, sessions: 20 });
  });
  it("needs the bar of the last completed slot: bars that lag the clock are lagging, never a low ratio", () => {
    const clock = slotClock(at(10))!; // 09:40: slots 0 to 3 completed
    expect(clock.completed).toBe(4);
    expect(relativeVolume([bar(0, 1_000), bar(1, 1_000), bar(2, 1_000)], base(), clock)).toEqual({ value: null, why: "lagging" });
    expect(relativeVolume([bar(0, 1_000), bar(1, 1_000), bar(2, 1_000), bar(3, 1_000)], base(), clock)).toEqual({ value: 1, sessions: 20 });
    expect(relativeVolume([bar(0, 4_000)], base(), clock)).toEqual({ value: null, why: "lagging" });
  });
  it("a non-finite ratio is null", () => {
    expect(relativeVolume([bar(0, Number.MAX_VALUE), bar(1, Number.MAX_VALUE)], base(), slotClock(at(5)))).toEqual({ value: null, why: "no-baseline" });
  });
  it("leaves the forming bar out of the sum", () => {
    expect(relativeVolume([bar(0, 1_000), bar(1, 1_000), bar(2, 1_000_000)], base(), slotClock(at(5) + 30_000))).toEqual({ value: 1, sessions: 20 });
  });
  it("a zero-volume baseline at the slot has nothing to compare against", () => {
    expect(relativeVolume(today, base(20, DAY, 0), slotClock(at(30)))).toEqual({ value: null, why: "no-baseline" });
  });
  it("on a half day today, reads the same slots against a full-session baseline, but not its last five", () => {
    const half = "2026-11-27";
    const open = Date.parse("2026-11-27T14:30:00Z");
    const bars = Array.from({ length: 105 }, (_, k) => bar(k, 3_000, 100, open));
    const before = slotClock(Date.parse("2026-11-27T17:53:00Z") - 1)!; // 12:52:59.999: slots 0 to 99
    expect(before.completed).toBe(100);
    expect(relativeVolume(bars, base(20, half), before)).toEqual({ value: 3, sessions: 20 });
    const into = slotClock(Date.parse("2026-11-27T17:53:00Z"))!; // 12:53: slot 100, the fifth from the 13:00 close
    expect(relativeVolume(bars, base(20, half), into)).toEqual({ value: null, why: "half-day-close" });
    const late = slotClock(Date.parse("2026-11-27T20:00:00Z"))!; // 15:00: the session closed at 13:00
    expect(late.completed).toBe(105);
    expect(relativeVolume(bars, base(20, half), late)).toEqual({ value: null, why: "half-day-close" });
    expect(barSurge(bars[99]!, base(20, half), late)).toEqual({ value: 3, sessions: 20 });
    expect(barSurge(bars[100]!, base(20, half), late)).toEqual({ value: null, why: "half-day-close" });
  });
  it("a full day's last slots are compared as usual", () => {
    expect(relativeVolume(today, base(), slotClock(Date.parse("2026-11-12T22:00:00Z")))).toEqual({ value: 2, sessions: 20 });
  });
  it("no session today is closed", () => {
    expect(relativeVolume(today, base(), slotClock(Date.parse("2026-11-26T16:00:00Z")))).toEqual({ value: null, why: "closed" }); // Thanksgiving
    expect(barSurge(today[0], base(), null)).toEqual({ value: null, why: "closed" });
  });
});

describe("barSurge", () => {
  const clock = slotClock(at(30))!; // 10:00: slots 0 to 13 completed
  it("is the completed bar's volume over its slot's median", () => {
    expect(barSurge(bar(13, 2_500), base(), clock)).toEqual({ value: 2.5, sessions: 20 });
    expect(barSurge(bar(3, 0), base(), clock)).toEqual({ value: 0, sessions: 20 }); // a zero-volume bar is a real zero
  });
  it("the forming bar and a bar of another day have no value", () => {
    expect(barSurge(bar(14, 2_500), base(), clock)).toEqual({ value: null, why: "no-bars" });
    expect(barSurge({ ...bar(0, 1), start: OPEN - 86_400_000 }, base(), clock)).toEqual({ value: null, why: "no-bars" });
    expect(barSurge(null, base(), clock)).toEqual({ value: null, why: "no-bars" });
  });
  it("shares relativeVolume's reasons", () => {
    expect(barSurge(bar(0, 1), base(), slotClock(at(4)))).toEqual({ value: null, why: "before-0935" });
    expect(barSurge(bar(0, 1), base(9), clock)).toEqual({ value: null, why: "thin-baseline" });
    expect(barSurge(bar(0, 1), base(20, "2026-11-11"), clock)).toEqual({ value: null, why: "stale-baseline" });
    expect(barSurge(bar(0, 1), null, clock)).toEqual({ value: null, why: "no-baseline" });
    expect(barSurge(bar(0, 1), base(20, DAY, 0), clock)).toEqual({ value: null, why: "no-baseline" });
  });
});

describe("barRange", () => {
  const clock = slotClock(at(30))!; // 10:00: slots 0 to 13 completed
  /** base() with every slot's median range 0.5 (the test bars' range is 2: high 101, low 99). */
  const ranged = (median = 0.5, n = 20, forSession = DAY): NameBaseline => ({ ...base(n, forSession), range_median: Array.from({ length: FULL_SESSION_SLOTS }, () => median) });
  it("is the completed bar's high − low over its slot's median range", () => {
    expect(barRange(bar(13, 10), ranged(), clock)).toEqual({ value: 4, sessions: 20 });
    expect(barRange({ ...bar(13, 10), h: 100, l: 100 }, ranged(), clock)).toEqual({ value: 0, sessions: 20 });
  });
  it("no ratio without ranges, with a zero median range, or for a bar that is not a completed one", () => {
    expect(barRange(bar(13, 10), base(), clock)).toEqual({ value: null, why: "no-range-baseline" });
    expect(barRange(bar(13, 10), ranged(0), clock)).toEqual({ value: null, why: "no-range-baseline" });
    expect(barRange(bar(14, 10), ranged(), clock)).toEqual({ value: null, why: "no-bars" });
    expect(barRange({ ...bar(13, 10), h: 98 }, ranged(), clock)).toEqual({ value: null, why: "no-bars" }); // high under the low
    expect(barRange(null, ranged(), clock)).toEqual({ value: null, why: "no-bars" });
  });
  it("shares barSurge's reasons", () => {
    expect(barRange(bar(0, 1), ranged(), slotClock(at(4)))).toEqual({ value: null, why: "before-0935" });
    expect(barRange(bar(0, 1), ranged(0.5, 9), clock)).toEqual({ value: null, why: "thin-baseline" });
    expect(barRange(bar(0, 1), ranged(0.5, 20, "2026-11-11"), clock)).toEqual({ value: null, why: "stale-baseline" });
    expect(barRange(bar(0, 1), null, clock)).toEqual({ value: null, why: "no-baseline" });
    expect(barRange(bar(0, 1), ranged(), null)).toEqual({ value: null, why: "closed" });
  });
});

describe("baselineSessions", () => {
  it("the 20 full sessions before a day, oldest first, across the clock change", () => {
    const s = baselineSessions(DAY)!;
    expect(s).toHaveLength(20);
    expect(s.at(-1)).toBe("2026-11-11");
    expect(s).toContain("2026-10-30");
    expect(s).toContain("2026-11-02");
    expect(s[0]).toBe("2026-10-15");
  });
  it("passes over a holiday and a half day", () => {
    const s = baselineSessions("2026-11-30")!;
    expect(s.at(-1)).toBe("2026-11-25");
    expect(s).not.toContain("2026-11-26");
    expect(s).not.toContain("2026-11-27");
  });
  it("on the day after a holiday, ends at the session before it", () => {
    expect(baselineSessions("2026-09-08")!.at(-1)).toBe("2026-09-04"); // Labor Day, 2026-09-07
  });
  it("is null when the calendar does not reach back far enough", () => {
    const short: FlowCalendar = { sessionOf: (d) => (d < "2026-11-01" ? { kind: "out_of_range", name: null, open: null, close: null } : MARKET_CALENDAR.sessionOf(d)) };
    expect(baselineSessions(DAY, short)).toBeNull();
  });
});

describe("buildBaseline", () => {
  const sessions = baselineSessions(DAY)!;
  const openOf = (d: string) => sessionSlots(d)!.open;
  const day = (d: string, vols: Record<number, number>): FlowBar[] => Object.entries(vols).map(([k, v]) => bar(Number(k), v, 100, openOf(d)));

  it("medians per slot and of the running total, a missing slot as zero, across the clock change", () => {
    const input = {
      "2026-10-30": { AAA: day("2026-10-30", { 0: 100, 1: 10 }) }, // EDT
      "2026-11-02": { AAA: day("2026-11-02", { 0: 300 }) }, // EST; slot 1 missing: zero
      "2026-11-03": { AAA: day("2026-11-03", { 0: 200, 1: 30 }) },
    };
    const b = buildBaseline(input, DAY, MARKET_CALENDAR, "2026-11-12T12:00:00.000Z")!;
    expect(b).toMatchObject({ v: 2, for_session: DAY, feed: "sip", built_at: "2026-11-12T12:00:00.000Z", sessions });
    const a = b.names.AAA!;
    expect(a.n).toBe(3);
    expect(a.slot_median).toHaveLength(195);
    expect(a.slot_median.slice(0, 3)).toEqual([200, 10, 0]);
    // running totals: 110, 300, 230 → 230
    expect(a.cum_median.slice(0, 2)).toEqual([200, 230]);
  });

  it("a session with no bars, or only bars outside the session, is not counted; an even count takes the middle two", () => {
    const input = {
      "2026-10-30": { AAA: day("2026-10-30", { 0: 100 }), BBB: [] },
      "2026-11-02": { AAA: day("2026-11-02", { 0: 300 }) },
      "2026-11-03": { AAA: [{ ...bar(0, 999), start: openOf("2026-11-03") - SLOT_MS }] }, // 09:28
    };
    const b = buildBaseline(input, DAY, MARKET_CALENDAR, undefined, ["CCC"])!;
    expect(b.built_for).toEqual(["AAA", "BBB", "CCC"]);
    expect(b.names.CCC).toEqual({ slot_median: [], cum_median: [], range_median: [], n: 0 });
    expect(b.names.AAA!.n).toBe(2);
    expect(b.names.AAA!.slot_median[0]).toBe(200);
    expect(b.names.BBB).toEqual({ slot_median: [], cum_median: [], range_median: [], n: 0 });
  });

  it("reads only the 20 sessions: a half day or a day outside them is ignored", () => {
    const input = { "2026-11-27": { AAA: day("2026-11-27", { 0: 5 }) }, "2026-11-12": { AAA: day("2026-11-12", { 0: 5 }) } };
    expect(buildBaseline(input, DAY)!.names).toEqual({});
  });

  it("parses back what it builds, and refuses anything off", () => {
    const b = buildBaseline({ "2026-11-03": { AAA: day("2026-11-03", { 0: 5 }) } }, DAY)!;
    expect(parseBaseline(JSON.stringify(b))).toEqual(b);
    const a = b.names.AAA!;
    const off = (over: object) => parseBaseline(JSON.stringify({ ...b, ...over }));
    const name = (over: object) => off({ names: { AAA: { ...a, ...over } } });
    expect(off({ feed: "iex" })).toBeNull();
    expect(off({ v: 3 })).toBeNull();
    expect(off({ v: 1 })).toBeNull(); // a version 1 document never carries ranges
    expect(off({ for_session: "2026-02-30" })).toBeNull(); // not a date
    expect(off({ sessions: [...b.sessions, "2026-11-12"] })).toBeNull(); // 21 sessions
    expect(off({ built_for: ["aapl"] })).toBeNull();
    expect(off({ built_for: undefined })).toBeNull();
    expect(off({ names: { "<b>": a } })).toBeNull();
    expect(name({ slot_median: [1, -1], cum_median: [1, 1] })).toBeNull();
    expect(name({ slot_median: [1, 2], cum_median: [1, 3, 4] })).toBeNull(); // unequal lengths
    expect(name({ range_median: undefined })).toBeNull(); // version 2 needs the ranges
    expect(name({ range_median: a.range_median!.slice(1) })).toBeNull(); // ranges of another length
    expect(name({ range_median: [-1, ...a.range_median!.slice(1)] })).toBeNull();
    expect(name({ slot_median: [3, 0], cum_median: [3, 2] })).toBeNull(); // the running total falls
    expect(name({ n: 1.5 })).toBeNull();
    expect(name({ n: 21 })).toBeNull(); // more than the sessions
    expect(name({ n: 20, slot_median: [1, 0], cum_median: [1, 1], range_median: [0, 0] })).not.toBeNull(); // n = sessions.length, flat total
    expect(parseBaseline('{"v":1,"for_session":"2026-11-12","built_at":"x","feed":"sip","sessions":[],"built_for":[],"names":{"A":{"slot_median":[1e999],"cum_median":[1],"n":0}}}')).toBeNull();
    expect(parseBaseline("not json")).toBeNull();
  });

  it("ranges: the median of high − low per slot, a missing slot as a zero range, from the same sessions", () => {
    const ranged = (d: string, k: number, h: number, l: number): FlowBar => ({ ...bar(k, 10, 100, openOf(d)), h, l });
    const input = {
      "2026-10-30": { AAA: [ranged("2026-10-30", 0, 101, 99), ranged("2026-10-30", 1, 100.5, 100)] },
      "2026-11-02": { AAA: [ranged("2026-11-02", 0, 104, 100)] }, // slot 1 missing: a zero range
      "2026-11-03": { AAA: [ranged("2026-11-03", 0, 100.25, 100), ranged("2026-11-03", 1, 102, 100)] },
    };
    const a = buildBaseline(input, DAY)!.names.AAA!;
    expect(a.range_median).toHaveLength(195);
    expect(a.range_median!.slice(0, 3)).toEqual([2, 0.5, 0]);
  });

  it("ranges are kept to 4 decimals", () => {
    const b = buildBaseline({ "2026-11-03": { AAA: [{ ...bar(0, 10, 100, openOf("2026-11-03")), h: 100.123456, l: 100 }] } }, DAY)!;
    expect(b.names.AAA!.range_median![0]).toBe(0.1235);
  });

  it("a version 1 baseline still parses, has no ranges, and gives no range ratio, never a pass", () => {
    const v2 = buildBaseline({ "2026-11-03": { AAA: day("2026-11-03", { 0: 5 }) } }, DAY)!;
    const noRange: Record<string, unknown> = { ...v2.names.AAA! };
    delete noRange.range_median;
    const v1 = parseBaseline(JSON.stringify({ ...v2, v: 1, names: { AAA: noRange } }))!;
    expect(v1.v).toBe(1);
    expect(v1.names.AAA!.range_median).toBeUndefined();
    const clock = slotClock(at(30) + SERVER_SETTLE_MS)!;
    const nb = { ...nameBaseline(v1, "AAA")!, n: 20 };
    expect(barRange(bar(10, 100), nb, clock)).toEqual({ value: null, why: "no-range-baseline" });
  });

  it("nameBaseline picks one name, or null", () => {
    const b: Baseline = buildBaseline({ "2026-11-03": { AAA: day("2026-11-03", { 0: 5 }) } }, DAY)!;
    expect(nameBaseline(b, "AAA")).toMatchObject({ for_session: DAY, n: 1 });
    expect(nameBaseline(b, "ZZZ")).toBeNull();
    expect(nameBaseline(null, "AAA")).toBeNull();
  });
});

describe("flowBarOf", () => {
  const raw = { t: "2026-11-12T14:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 1234, vw: 100.2, n: 56 };
  it("reads Alpaca's bar with its volume", () => {
    expect(flowBarOf(raw)).toEqual({ start: OPEN, end: OPEN + SLOT_MS, o: 100, h: 101, l: 99, c: 100.5, v: 1234, vw: 100.2, n: 56 });
  });
  it("keeps a bar with no vw or count, and a zero-volume bar", () => {
    expect(flowBarOf({ ...raw, vw: undefined, n: "x" })).toMatchObject({ vw: null, n: null });
    expect(flowBarOf({ ...raw, v: 0 })).toMatchObject({ v: 0 });
  });
  it("drops a bar without a usable time, price or volume", () => {
    expect(flowBarOf({ ...raw, t: "soon" })).toBeNull();
    expect(flowBarOf({ ...raw, c: 0 })).toBeNull();
    expect(flowBarOf({ ...raw, v: -1 })).toBeNull();
    expect(flowBarOf({ ...raw, v: null })).toBeNull();
    expect(flowBarOf(null)).toBeNull();
  });
});
