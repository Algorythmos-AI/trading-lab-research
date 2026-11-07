import { describe, expect, it } from "vitest";
import { focusPlan, type SidePlan } from "@/lib/focus-plan";
import { type LiveQuote, nyClock, type Options, type TrailPoint } from "@/lib/options";
import {
  ALT_LIVE_BARS,
  altAt,
  bars2m,
  coveredSince,
  ema,
  type Entry,
  FIRST_ENTRY_MIN,
  flatMinute,
  LUNCH_FROM_MIN,
  LUNCH_TO_MIN,
  manage,
  MAX_BARS_TO_RETEST,
  type NameInput,
  nameState,
  RETEST_ATR,
  serverNow,
  sideState,
} from "@/lib/trade-state";

type Item = NonNullable<Options["focus"]>["items"][number];

const S = "2026-10-12"; // a Monday on EDT
const ITEM: Item = {
  symbol: "AAPL",
  rank: 1,
  bias: "breakout",
  atr: 4,
  breakout_above: 412.3,
  hold_above: 405.1,
  resistance: { price: 412.3, name: "PDH" },
  support: { price: 405.1, name: "PDL" },
  target_up: { price: 416, name: "PWH" },
  target_down: { price: 401, name: "PWL" },
};
const PLAN = focusPlan(ITEM);
// call: level 412.30, entry 412.34, stop 411.90, target 1 413.22; put: level 405.10, entry 405.06, stop 405.50, target 1 404.18
const TICKER: NameInput["ticker"] = {
  levels: [
    { name: "PDH", price: 412.3 },
    { name: "PDL", price: 405.1 },
  ],
  bars: [],
  expected_move: { annual_iv: 0.2 },
};

/** A New York wall time on a day, as ms. */
const nyMs = (hhmm: string, day = S, offset = "-04:00", sec = 0) => Date.parse(`${day}T${hhmm}:${String(sec).padStart(2, "0")}${offset}`);

type Spec = [hhmm: string, o: number, h: number, l: number, c: number];

/** Prices that build exactly the given 2-minute bars, then a live print 3 s into the next slot. */
function scene(specs: Spec[], live: number, opt: { day?: string; offset?: string; nowExtra?: number } = {}) {
  const day = opt.day ?? S;
  const offset = opt.offset ?? "-04:00";
  const trail: TrailPoint[] = [];
  for (const [hhmm, o, h, l, c] of specs) {
    const start = nyMs(hhmm, day, offset);
    trail.push({ at: start + 1_000, p: o }, { at: start + 30_000, p: h }, { at: start + 60_000, p: l }, { at: start + 110_000, p: c });
  }
  const lastStart = nyMs(specs[specs.length - 1]![0], day, offset);
  const liveAt = lastStart + 120_000 + 3_000;
  const now = new Date(liveAt + 2_000 + (opt.nowExtra ?? 0));
  const all = [...trail.map((x) => x.p), live];
  const quote: LiveQuote = {
    price: live,
    at: new Date(liveAt).toISOString(),
    open: specs[0]![1],
    high: Math.max(...all),
    low: Math.min(...all),
    day,
    prev_close: 408,
    vwap: 408,
  };
  return { trail, quote, now, bars: bars2m(trail, quote, now) };
}

function input(sc: ReturnType<typeof scene>, over: Partial<NameInput> = {}): NameInput {
  return {
    symbol: "AAPL",
    session: sc.quote.day!,
    call: PLAN.call,
    put: PLAN.put,
    atr: ITEM.atr,
    sweepAtr: ITEM.atr,
    ticker: TICKER,
    bars: sc.bars,
    quote: sc.quote,
    receivedAt: sc.now.getTime() - 1_000,
    now: sc.now,
    halfDay: false,
    dayLimitUsed: false,
    wonToday: false,
    ...over,
  };
}

describe("2-minute bars", () => {
  it("aligns to the New York :00/:02 grid, keeps only finished bars as closed, and dates the first price", () => {
    const at = (hhmm: string, sec: number) => nyMs(hhmm, S, "-04:00", sec);
    const trail: TrailPoint[] = [
      { at: at("09:29", 50), p: 400 }, // pre-market: not a session bar
      { at: at("10:00", 5), p: 410 },
      { at: at("10:00", 40), p: 411 },
      { at: at("10:01", 50), p: 409.5 },
      { at: at("10:02", 10), p: 410.2 },
    ];
    const quote: LiveQuote = { price: 410.4, at: new Date(at("10:02", 20)).toISOString(), open: 410, high: 411, low: 400, day: S, prev_close: 409, vwap: 410 };
    const b = bars2m(trail, quote, new Date(at("10:02", 30)));
    expect(b.closed).toEqual([{ start: at("10:00", 0), end: at("10:02", 0), o: 410, h: 411, l: 409.5, c: 409.5 }]);
    expect(b.partial).toMatchObject({ start: at("10:02", 0), o: 410.2, h: 410.4, l: 410.2, c: 410.4 });
    // the start of the first bar, on the grid (finding 6)
    expect(b.since).toBe(at("10:00", 0));
    expect(b.complete).toBe(false);
    expect(b.gaps).toBe(0);
    // a bar that ends at now with no later price is still forming for 5 s (finding 8)
    const atEnd = bars2m(trail, null, new Date(at("10:02", 0)));
    expect(atEnd.closed).toHaveLength(0);
    expect(atEnd.partial).toMatchObject({ start: at("10:00", 0), c: 409.5 });
    expect(bars2m(trail, null, new Date(at("10:02", 4))).closed).toHaveLength(0);
    expect(bars2m(trail, null, new Date(at("10:02", 5))).closed).toHaveLength(1);
    expect(bars2m([], null, new Date(at("10:02", 0)))).toEqual({ closed: [], partial: null, since: null, complete: false, missing: [], gaps: 0 });
  });

  it("is on the New York grid on both daylight-saving change days", () => {
    for (const [day, offset] of [
      ["2026-03-09", "-04:00"],
      ["2026-11-02", "-05:00"],
    ] as const) {
      const sc = scene([["10:04", 1, 1, 1, 1]], 1, { day, offset });
      const start = sc.bars.closed[0]!.start;
      expect(nyClock(new Date(start).toISOString())).toEqual({ day, minutes: 10 * 60 + 4 });
    }
  });

  it("EMA is seeded with the simple mean of the first n (regime.ema)", () => {
    expect(ema([1, 2, 3, 4, 5, 6, 7, 8, 9], 9)).toBe(5);
    expect(ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9)).toBeCloseTo(10 * 0.2 + 5 * 0.8, 10);
    expect(ema([1, 2, 3], 9)).toBeNull();
  });
});

// One name through the day: the middle, then watch, a price above the ceiling, a 2-minute close above it, a dip that
// holds it, then past target 1.
const A: Spec = ["10:04", 408, 408.5, 407.8, 408.2];
const B: Spec = ["10:06", 408.2, 411.2, 408.1, 411.0];
const C: Spec = ["10:08", 411.0, 412.2, 410.9, 412.1];
const D: Spec = ["10:10", 412.5, 412.9, 412.4, 412.8]; // the break: closes above 412.30, the close before at 412.10
const E: Spec = ["10:12", 412.8, 412.85, 412.5, 412.7]; // the dip: low 0.20 above the level, within 0.1 ATR (0.40)

describe("one name through the session", () => {
  const steps: { name: string; specs: Spec[]; live: number; state: string; tone: string; line: string; side?: string }[] = [
    { name: "middle", specs: [A], live: 408.4, state: "no_trade", tone: "neutral", line: "In the middle of yesterday's range: wait for 405.10 or 412.30" },
    { name: "watch", specs: [A, B], live: 411.1, state: "watch", tone: "info", line: "Calls above 412.30 (0.3 ATR) · Puts below 405.10 (1.5 ATR)", side: "call" },
    { name: "price above", specs: [A, B, C], live: 412.5, state: "get_ready", tone: "warn", line: "Above 412.30: wait for a 2-min close above it", side: "call" },
    { name: "broke", specs: [A, B, C, D], live: 412.85, state: "get_ready", tone: "warn", line: "Broke above 412.30: wait for a dip that holds it", side: "call" },
    {
      name: "dip holds",
      specs: [A, B, C, D, E],
      live: 412.75,
      state: "enter_zone",
      tone: "good",
      line: "Retest holding 412.30: call limit ~412.34 · stop 411.90 / −25% · target 413.22",
      side: "call",
    },
  ];
  for (const st of steps)
    it(st.name, () => {
      const r = nameState(input(scene(st.specs, st.live)));
      expect({ state: r.state, tone: r.tone, line: r.line, side: r.side }).toEqual({ state: st.state, tone: st.tone, line: st.line, side: st.side });
    });

  it("says why a row is no trade: the middle of yesterday's range, no plan, or the session's clock", () => {
    expect(nameState(input(scene([A], 408.4))).why).toBe("range_middle");
    expect(nameState(input(scene([A], 408.4), { call: null, put: null, ticker: { ...TICKER, levels: [] } })).why).toBe("no_plan");
    // a row with a state other than no trade carries no reason
    expect(nameState(input(scene([A, B], 411.1))).why).toBeUndefined();
    // after the close, and on a day before the session
    const after = scene([A], 408.4);
    expect(nameState(input({ ...after, now: new Date(nyMs("16:30")) }, { receivedAt: null })).why).toBe("closed");
    expect(nameState(input({ ...after, now: new Date(nyMs("12:00", "2026-10-09")) }, { receivedAt: null })).why).toBe("closed");
  });

  it("ranks an entry above a watch, and hands back the plan's prices", () => {
    const enter = nameState(input(scene([A, B, C, D, E], 412.75)));
    const watch = nameState(input(scene([A, B], 411.1)));
    expect(enter.rank).toBeLessThan(watch.rank);
    expect(enter.plan).toEqual({ level: 412.3, entry: 412.34, stop: 411.9, target1: 413.22, target2: 416 });
    expect(RETEST_ATR).toBe(0.1);
  });

  it("past target 1: the call is missed (don't chase), so the row watches the put and says so", () => {
    const sc = scene([A, B, C, D, E], 413.3);
    expect(sideState(PLAN.call, 4, sc.bars, sc.quote, sc.now).state).toBe("missed");
    const r = nameState(input(sc));
    expect(r.state).toBe("watch");
    expect(r.line).toMatch(/^Calls past target 1 \(413\.22\): don't chase · Puts below 405\.10 \(2\.\d ATR\)$/);
    // missed ranks last: the put's watch is the row
    expect(r.side).toBe("put");
  });

  it("target 1 reached before any dip is missed too", () => {
    const sc = scene([A, B, C, ["10:10", 412.5, 413.4, 412.45, 413.3]], 413.35);
    expect(sideState(PLAN.call, 4, sc.bars, sc.quote, sc.now).state).toBe("missed");
  });

  it("with only one side planned, a missed side is the row", () => {
    const sc = scene([A, B, C, D, E], 413.3);
    expect(nameState(input(sc, { put: null }))).toMatchObject({ state: "missed", line: "Already past target 1 (413.22): don't chase" });
  });

  it("a dip that comes back but has no close yet is not an entry", () => {
    const sc = scene([A, B, C, D, E], 412.25);
    expect(sideState(PLAN.call, 4, sc.bars, sc.quote, sc.now).state).toBe("get_ready");
  });
});

describe("a failed break and a sweep", () => {
  it("a close back under the ceiling within 3 bars: plan off, and a failed-break put armed above the push high", () => {
    const back: Spec = ["10:12", 412.8, 412.9, 411.9, 412.0];
    const r = nameState(input(scene([A, B, C, D, back], 411.95)));
    expect(r.state).toBe("plan_off");
    expect(r.tone).toBe("bad");
    expect(r.alt).toEqual({ kind: "failed_break", side: "put", level: 412.3, stop: 412.9, entry: 412.0, at: nyMs("10:12") });
    expect(r.line).toBe("Fell back below 412.30: call plan off · Failed break: put under 412.30, stop above 412.90 (push high) · testing");
    // ranked above a plain watch
    expect(r.rank).toBeLessThan(nameState(input(scene([A, B], 411.1))).rank);
  });

  it("a close back under after more than 3 bars is plan off with no alternative", () => {
    const hold = (hhmm: string): Spec => [hhmm, 412.7, 412.8, 412.6, 412.7];
    const sc = scene([A, B, C, D, hold("10:12"), hold("10:14"), hold("10:16"), ["10:18", 412.7, 412.7, 411.9, 412.0]], 412.0);
    const call = sideState(PLAN.call, 4, sc.bars, sc.quote, sc.now);
    expect(call.state).toBe("plan_off");
    expect(call.alt).toBeNull();
    // the row reads as a watch again: a new close above re-arms the call
    expect(nameState(input(sc)).line).toBe("Calls above 412.30 (0.1 ATR) · Puts below 405.10 (1.7 ATR)");
  });

  it("a sweep under the floor by 0.25 ATR that closes back above it arms a call below the sweep low", () => {
    const sc = scene(
      [
        ["10:04", 406, 406.2, 405.6, 405.8],
        ["10:06", 405.8, 405.9, 404.0, 405.3],
      ],
      405.4,
    );
    const r = nameState(input(sc));
    expect(r.alt).toEqual({ kind: "sweep_reclaim", side: "call", level: 405.1, stop: 404.0, entry: 405.3, at: nyMs("10:06") });
    expect(r.line).toBe("Sweep and reclaim: call above 405.10, stop below 404.00 (sweep low) · testing");
    expect(r.side).toBe("put");
    // the sweep is measured in the 2-minute bars' ATR: without one it is not looked for
    expect(nameState(input(sc, { sweepAtr: null })).alt).toBeNull();
    // not far enough (0.25 ATR is 1.00 under 405.10, so 404.10)
    const short = scene(
      [
        ["10:04", 406, 406.2, 405.6, 405.8],
        ["10:06", 405.8, 405.9, 404.2, 405.3],
      ],
      405.4,
    );
    expect(altAt(405.1, "put", short.bars.closed, 4)).toBeNull();
    // a later close back under the floor ends it
    const ended = scene(
      [
        ["10:04", 406, 406.2, 405.6, 405.8],
        ["10:06", 405.8, 405.9, 404.0, 405.3],
        ["10:08", 405.3, 405.4, 404.8, 404.9],
      ],
      404.9,
    );
    expect(altAt(405.1, "put", ended.bars.closed, 4)).toBeNull();
  });
});

describe("the clock and the feed", () => {
  it("a stale feed in the session pauses every row and never shows an entry", () => {
    const sc = scene([A, B, C, D, E], 412.75);
    const late = nameState(input(sc, { receivedAt: sc.now.getTime() - 21_000 }));
    expect(late).toMatchObject({ state: "paused", tone: "neutral", line: "No new price for 21 s: check your platform" });
    const old = { ...sc.quote, at: new Date(sc.now.getTime() - 121_000).toISOString() };
    expect(nameState(input(sc, { quote: old })).line).toBe("No new price for 121 s: check your platform");
    expect(nameState(input(sc, { quote: null })).line).toBe("No price yet: check your platform");
    expect(nameState(input(sc, { receivedAt: null })).state).toBe("paused");
  });

  it("before 09:35 there is no entry; before the open a stale quote is not a pause", () => {
    expect(FIRST_ENTRY_MIN).toBe(9 * 60 + 35);
    const early = scene([["09:30", 412.5, 412.9, 412.4, 412.8]], 412.85); // 09:32 + 5 s New York
    expect(nameState(input(early))).toMatchObject({ state: "no_trade", line: "Opening range forming: first entries from 09:35", why: "opening" });
    const pre = { ...early, now: new Date(nyMs("09:00")) };
    expect(nameState(input(pre, { receivedAt: null })).line).toBe("Opening range forming: first entries from 09:35");
  });

  it("from 09:35 to 10:00 a row carries the desk's own early caution, kept apart from the clone's checks", () => {
    const sc = scene([["09:44", 412.5, 412.9, 412.4, 412.8]], 412.85); // 09:46 + 5 s New York
    const r = nameState(input(sc));
    expect(r.state).not.toBe("no_trade");
    const early = r.cautions.find((c) => c.id === "before10");
    expect(early).toMatchObject({ word: "Early: before 10:00", tone: "warn", hyp: null });
    expect(early?.why).toMatch(/^The desk's own caution: .*the clone's tested window starts at 10:00\.$/);
  });

  it("from 15:10 (12:10 on a half day) no new entries; the day limit ends the day", () => {
    const sc = (hhmm: string) => scene([A], 411.1, { nowExtra: nyMs(hhmm) - nyMs("10:04") - 125_000 });
    expect(flatMinute(false)).toBe(15 * 60 + 10);
    expect(flatMinute(true)).toBe(12 * 60 + 10);
    const at = (hhmm: string, halfDay = false) => {
      const s = sc(hhmm);
      return nameState(input(s, { receivedAt: s.now.getTime(), quote: { ...s.quote, at: s.now.toISOString() }, halfDay }));
    };
    expect(at("15:09").state).not.toBe("no_trade");
    expect(at("15:10")).toMatchObject({ state: "no_trade", line: "After 15:10: no new entries, be flat" });
    expect(at("12:09", true).state).not.toBe("no_trade");
    expect(at("12:10", true).line).toBe("After 12:10: no new entries, be flat");
    expect(at("13:00", true).line).toBe("Session closed");
    expect(nameState(input(scene([A, B], 411.1), { dayLimitUsed: true })).line).toBe("Day limit reached: no more trades today");
    // each says why, so the page never reads a closed window as a quiet range
    expect(at("15:10").why).toBe("late");
    expect(at("13:00", true).why).toBe("closed");
    expect(nameState(input(scene([A, B], 411.1), { dayLimitUsed: true })).why).toBe("day_limit");
    expect(at("15:09").why).toBeUndefined();
  });

  it("a page opened after the break says so and never claims a dip from bars it does not have", () => {
    const sc = scene(
      [
        ["11:00", 413.0, 413.1, 412.9, 413.0],
        ["11:02", 413.0, 413.05, 412.4, 412.8],
      ],
      412.9,
    );
    const r = nameState(input(sc));
    expect(r).toMatchObject({ state: "get_ready", brokeEarlier: true, line: "Broke above 412.30 before you opened the page: confirm the hold on your chart" });
    expect(sc.bars.since).toBe(nyMs("11:00"));
    // the day's high already past target 1: don't chase
    const past = { ...sc.quote, high: 413.5 };
    expect(sideState(PLAN.call, 4, sc.bars, past, sc.now)).toMatchObject({ state: "missed", brokeEarlier: true });
    // the day's high crossed the level before the page opened, the price is back under it: a watch, flagged
    const one = scene([["11:00", 411.5, 411.6, 411.4, 411.5]], 411.5);
    const crossed = { ...one.quote, high: 412.9 };
    expect(sideState(PLAN.call, 4, one.bars, crossed, one.now)).toMatchObject({ state: "watch", brokeEarlier: true });
  });

  it("walks the same way on the daylight-saving change days", () => {
    for (const [day, offset] of [
      ["2026-03-09", "-04:00"],
      ["2026-11-02", "-05:00"],
    ] as const) {
      const sc = scene([A, B, C, D, E], 412.75, { day, offset });
      expect(nameState(input(sc)).state).toBe("enter_zone");
      const early = scene([["09:30", 412.5, 412.9, 412.4, 412.8]], 412.85, { day, offset });
      expect(nameState(input(early)).state).toBe("no_trade"); // 09:32 + 5 s New York
      const soon = scene([["09:56", 412.5, 412.9, 412.4, 412.8]], 412.85, { day, offset });
      expect(nameState(input(soon)).state).not.toBe("no_trade"); // 09:58 + 5 s New York: from the 09:35 first entry
    }
  });

  it("takes no new entries from 11:30 to 13:00 New York, except on a half day", () => {
    const sc = (hhmm: string) => scene([A], 411.1, { nowExtra: nyMs(hhmm) - nyMs("10:04") - 125_000 });
    const at = (hhmm: string, halfDay = false) => {
      const s = sc(hhmm);
      return nameState(input(s, { receivedAt: s.now.getTime(), quote: { ...s.quote, at: s.now.toISOString() }, halfDay }));
    };
    const block = "No new entries 11:30–13:00 New York: next entries from 13:00";
    expect(LUNCH_FROM_MIN).toBe(11 * 60 + 30);
    expect(LUNCH_TO_MIN).toBe(13 * 60);
    expect(at("11:29").state).not.toBe("no_trade");
    expect(at("11:30")).toMatchObject({ state: "no_trade", line: block, cautions: [], why: "lunch" });
    expect(at("12:59")).toMatchObject({ state: "no_trade", line: block });
    expect(at("13:00").state).not.toBe("no_trade");
    expect(at("11:45", true).line).not.toBe(block); // a half day closes at 13:00: no block, flat from 12:10
    expect(at("11:45", true).state).not.toBe("no_trade");
  });

  it("never hides the desk's early caution behind the two clone cautions", () => {
    const early = (x: Spec): Spec => [`09:${40 + Number(x[0].slice(3))}`, x[1], x[2], x[3], x[4]];
    const s = scene([A, B, C, D, E].map(early), 412.75); // 09:44 to 09:52
    const r = nameState(
      input(s, { receivedAt: s.now.getTime(), wonToday: true, ticker: { ...TICKER, expected_move: { annual_iv: 0.9 } } }),
    );
    expect(r.state).toBe("enter_zone");
    expect(r.cautions.map((c) => c.id)).toEqual(["iv", "winner", "before10"]);
    expect(r.moreCautions).toBe(0);
  });

  it("shows at most two cautions and counts the rest", () => {
    const later = (x: Spec, min: number): Spec => [`${Number(x[0].slice(0, 2)) + 1}:${String(Number(x[0].slice(3)) + min).padStart(2, "0")}`, x[1], x[2], x[3], x[4]];
    const s = scene([A, B, C, D, E].map((x) => later(x, 10)), 412.75); // 11:14 to 11:22
    const r = nameState(
      input(s, { receivedAt: s.now.getTime(), wonToday: true, ticker: { ...TICKER, expected_move: { annual_iv: 0.9 } } }),
    );
    expect(r.state).toBe("enter_zone");
    expect(r.cautions.map((c) => c.id)).toEqual(["iv", "late"]);
    expect(r.moreCautions).toBe(1);
  });
});

describe("managing a trade", () => {
  const entry = (over: Partial<Entry> = {}): Entry => ({ side: "call", price: 412.4, at: new Date(nyMs("10:18", S, "-04:00", 30)).toISOString(), source: "manual", ...over });
  const run = (specs: Spec[], live: number, e: Entry = entry(), plan: SidePlan | null = PLAN.call, halfDay = false, nowExtra = 0) => {
    const sc = scene(specs, live, { nowExtra });
    return manage(e, plan, sc.bars, sc.quote, sc.now, halfDay);
  };

  it("holds with the stop, target 1, the 5-minute clock and the time to 15:10", () => {
    const m = run([["10:20", 412.4, 412.5, 412.3, 412.45]], 412.45);
    expect(m).toMatchObject({ line: "Holding: stop 411.90 · target 1 413.22", tone: "info", stop: 411.9, target1: 413.22, trail: null, notWorkingSecLeft: 85, minToFlat: 288 });
  });

  it("a completed close under the stop: exit", () => {
    expect(run([["10:20", 412.4, 412.5, 411.7, 411.8]], 411.85)).toMatchObject({ line: "Below the stop 411.90: exit", tone: "bad" });
  });

  it("5 minutes in and not past the entry: exit (rule 6)", () => {
    const m = run(
      [
        ["10:20", 412.4, 412.5, 412.3, 412.4],
        ["10:22", 412.4, 412.45, 412.3, 412.38],
        ["10:24", 412.38, 412.45, 412.3, 412.39],
      ],
      412.35,
      entry(),
      PLAN.call,
      false,
      0,
    );
    expect(m).toMatchObject({ line: "5 min, not working: exit", notWorkingSecLeft: 0 });
    // past the entry at 5 minutes (the first price from 10:23:30, the 10:24 open): working, the clock goes away
    const ok = run(
      [
        ["10:20", 412.4, 412.5, 412.3, 412.4],
        ["10:22", 412.4, 412.45, 412.3, 412.38],
        ["10:24", 412.45, 412.6, 412.3, 412.55],
      ],
      412.6,
    );
    expect(ok.notWorkingSecLeft).toBeNull();
  });

  it("target 1 hit: sell half and move the stop to the entry; a close back under the entry then exits", () => {
    const hit = run([["10:20", 412.4, 413.3, 412.3, 413.1]], 413.15);
    expect(hit).toMatchObject({ line: "Target 1 hit: sell half, stop to 412.40", tone: "good", stop: 412.4, notWorkingSecLeft: null });
    const back = run(
      [
        ["10:20", 412.4, 413.3, 412.3, 413.1],
        ["10:22", 413.1, 413.1, 412.2, 412.3],
      ],
      412.3,
    );
    expect(back.line).toBe("Below the stop 412.40: exit");
  });

  it("after target 1 the rest trails the EMA9 of the 2-minute closes", () => {
    const plan: SidePlan = { side: "call", level: 409.9, levelName: "PDH", entry: 410, stop: 409.5, target1: 411, target2: null };
    const specs: Spec[] = Array.from({ length: 10 }, (_, i) => {
      const c = 410 + 0.3 * i;
      return [`10:${String(i * 2).padStart(2, "0")}`, c - 0.05, c + 0.1, c - 0.1, c] as Spec;
    });
    const e = entry({ price: 410, at: new Date(nyMs("10:00", S, "-04:00", 30)).toISOString() });
    const closes = specs.map((x) => x[4]);
    const trail = Math.round(ema(closes, 9)! * 100) / 100;
    const m = run(specs, 412.8, e, plan);
    expect(m).toMatchObject({ trail, line: `Trail ${trail.toFixed(2)}: exit on a 2-min close under it` });
    const drop: Spec = ["10:20", 412.7, 412.7, 411.2, 411.3];
    const out = run([...specs, drop], 411.3, e, plan);
    const trail2 = Math.round(ema([...closes, 411.3], 9)! * 100) / 100;
    expect(out).toMatchObject({ trail: trail2, line: `Under the trail ${trail2.toFixed(2)}: exit`, tone: "bad" });
  });

  it("15:10 (12:10 on a half day): flat", () => {
    const at15 = run([["15:06", 412.4, 412.5, 412.3, 412.45]], 412.45, entry({ at: new Date(nyMs("15:06")).toISOString() }), PLAN.call, false, nyMs("15:10") - nyMs("15:08") - 5_000);
    expect(at15).toMatchObject({ line: "15:10: flat", minToFlat: 0 });
    const half = run([["12:06", 412.4, 412.5, 412.3, 412.45]], 412.45, entry({ at: new Date(nyMs("12:06")).toISOString() }), PLAN.call, true, nyMs("12:10") - nyMs("12:08") - 5_000);
    expect(half.line).toBe("12:10: flat");
  });

  it("a put mirrors it", () => {
    const e = entry({ side: "put", price: 405.0 });
    expect(run([["10:20", 405.0, 405.7, 404.9, 405.6]], 405.6, e, PLAN.put)).toMatchObject({ line: "Above the stop 405.50: exit" });
    expect(run([["10:20", 405.0, 405.1, 404.1, 404.2]], 404.2, e, PLAN.put).line).toBe("Target 1 hit: sell half, stop to 405.00");
  });
});

// ---- review findings on PR #351: the desk never says enter_zone on data it does not have or that is out of date ----
/** The scene with more prices in it (and the quote changed), its bars rebuilt. */
function withPoints(sc: ReturnType<typeof scene>, pts: TrailPoint[], q: Partial<LiveQuote> = {}) {
  const trail = [...sc.trail, ...pts].sort((x, y) => x.at - y.at);
  const quote = { ...sc.quote, ...q };
  return { ...sc, trail, quote, bars: bars2m(trail, quote, sc.now) };
}
const call = (sc: { bars: ReturnType<typeof bars2m>; quote: LiveQuote; now: Date }, q: Partial<LiveQuote> = {}) =>
  sideState(PLAN.call, 4, sc.bars, { ...sc.quote, ...q }, sc.now);
/** Above the level with no dip: the low 0.50 over it, more than 0.1 ATR. */
const hold = (hhmm: string): Spec => [hhmm, 412.85, 412.95, 412.8, 412.85];

describe("finding 1: target 1 after the dip", () => {
  it("a bar after the dip that reached target 1 makes the side missed, not an entry", () => {
    const F: Spec = ["10:14", 412.7, 413.4, 412.6, 412.9];
    expect(call(scene([A, B, C, D, E, F], 412.8))).toMatchObject({ state: "missed", missedWhy: "target" });
  });

  it("so does the bar still forming, after the dip", () => {
    const sc = scene([A, B, C, D, E], 412.8);
    const spiked = withPoints(sc, [{ at: nyMs("10:14", S, "-04:00", 1), p: 413.3 }]);
    expect(spiked.bars.partial!.h).toBe(413.3);
    expect(call(spiked).state).toBe("missed");
  });
});

describe("finding 2: missing 2-minute slots", () => {
  // the break at 10:10, no prices for 10:12 and 10:14, then a dip that holds at 10:16
  const dip: Spec = ["10:16", 412.6, 412.9, 412.35, 412.7];
  it("bars2m counts the slots with no bar, and coveredSince reads them", () => {
    const sc = scene([A, B, C, D, dip], 412.75);
    expect(sc.bars.gaps).toBe(2);
    expect(sc.bars.missing).toEqual([nyMs("10:12"), nyMs("10:14")]);
    expect(coveredSince(sc.bars, nyMs("10:10"))).toBe(false);
    expect(coveredSince(sc.bars, nyMs("10:16"))).toBe(true);
    expect(coveredSince(sc.bars, nyMs("10:03"))).toBe(false); // before the first bar
    // a feed that stops leaves the slots up to now missing too
    const quiet = { ...sc, now: new Date(nyMs("10:24", S, "-04:00", 10)) };
    expect(bars2m(quiet.trail, quiet.quote, quiet.now).gaps).toBe(4); // 10:12, 10:14, 10:20 and 10:22
  });

  it("a missing slot after the break: get ready, flagged, and the line says confirm on your chart", () => {
    const sc = scene([A, B, C, D, dip], 412.75);
    expect(call(sc)).toMatchObject({ state: "get_ready", gap: true });
    const r = nameState(input(sc));
    expect(r.state).toBe("get_ready");
    expect(r.line).toMatch(/confirm on your chart/);
  });

  it("the day's high past target 1 while the page was blind: missed", () => {
    expect(call(scene([A, B, C, D, dip], 412.75), { high: 413.4 }).state).toBe("missed");
    // the review's own case: no prices 10:12 to 10:40 while the price ran to target 1 and back
    const rv = scene([A, B, C, D, ["10:40", 412.6, 412.9, 412.35, 412.7]], 412.75);
    expect(call(rv, { high: 413.4 }).state).toBe("missed");
    expect(call(rv).state).not.toBe("enter_zone");
  });

  it("with full coverage, a day high past target 1 the page's bars do not show is missed; one before the break is not", () => {
    // the trail missed a spike inside a bar
    expect(call(scene([A, B, C, D, E], 412.75), { high: 413.4 }).state).toBe("missed");
    const X: Spec = ["10:04", 412.2, 413.4, 412.0, 412.1];
    const Y: Spec = ["10:06", 412.1, 412.2, 411.9, 412.0];
    const brk: Spec = ["10:08", 412.1, 412.8, 412.0, 412.7];
    const dip2: Spec = ["10:10", 412.7, 412.8, 412.35, 412.7];
    expect(call(scene([X, Y, brk, dip2], 412.75), { high: 413.4 }).state).toBe("enter_zone");
  });
});

describe("finding 3: a break on the page's first bar", () => {
  const first: Spec = ["11:00", 412.1, 412.6, 412.0, 412.5];
  const second: Spec = ["11:02", 412.5, 412.6, 412.35, 412.55];
  it("is not a break when the page opened after the open: the close before it is unknown", () => {
    expect(call(scene([first, second], 412.6))).toMatchObject({ state: "get_ready", brokeEarlier: true, brokeAt: null });
  });

  it("is not a break even with the session from 09:30: the clone's retest needs the close before it", () => {
    const sc = scene([["09:30", ...first.slice(1)] as Spec, ["09:32", ...second.slice(1)] as Spec], 412.6);
    expect(sc.bars.complete).toBe(true);
    expect(call(sc).state).not.toBe("enter_zone");
  });
});

describe("finding 4: the retest window", () => {
  it("is the clone's max_bars_to_retest", () => {
    expect(MAX_BARS_TO_RETEST).toBe(6);
  });

  it("a touch more than 6 bars after the break is missed: the window passed", () => {
    const sc = scene([A, B, C, D, hold("10:12"), hold("10:14"), hold("10:16"), hold("10:18"), hold("10:20"), hold("10:22"), ["10:24", 412.8, 412.9, 412.35, 412.75]], 412.8);
    expect(call(sc)).toMatchObject({ state: "missed", missedWhy: "window" });
    const r = nameState(input(sc, { put: null }));
    expect(r.line).toBe("Retest window at 412.30 passed: don't chase");
  });

  it("the entry is live from the touch until 6 bars after the break, then missed", () => {
    const touch6 = [A, B, C, D, hold("10:12"), hold("10:14"), hold("10:16"), hold("10:18"), hold("10:20"), ["10:22", 412.8, 412.9, 412.35, 412.75] as Spec];
    expect(call(scene(touch6, 412.8)).state).toBe("enter_zone"); // the bar forming is the 7th after the break
    const kept = [A, B, C, D, E, hold("10:14"), hold("10:16"), hold("10:18"), hold("10:20")];
    expect(call(scene(kept, 412.8)).state).toBe("enter_zone");
    expect(call(scene([...kept, hold("10:22")], 412.8)).state).toBe("enter_zone");
    expect(call(scene([...kept, hold("10:22"), hold("10:24")], 412.8))).toMatchObject({ state: "missed", missedWhy: "window" });
  });
});

describe("finding 5: alternative triggers expire", () => {
  const back: Spec = ["10:12", 412.8, 412.9, 411.9, 412.0];
  const under = (hhmm: string): Spec => [hhmm, 412.0, 412.1, 411.8, 411.9];
  it("lives for 3 completed bars after the bar that completed it", () => {
    expect(ALT_LIVE_BARS).toBe(3);
    expect(call(scene([A, B, C, D, back, under("10:14"), under("10:16")], 411.9)).alt).not.toBeNull();
    expect(call(scene([A, B, C, D, back, under("10:14"), under("10:16"), under("10:18")], 411.9)).alt).toBeNull();
  });

  it("ends once the live price reaches its stop or moves more than 1 ATR from the level", () => {
    const sc = scene([A, B, C, D, back], 411.95);
    expect(call(sc).alt).not.toBeNull();
    expect(call(sc, { price: 411.0 }).alt).not.toBeNull();
    expect(call(sc, { price: 412.95 }).alt).toBeNull(); // the push high 412.90 is the stop
    expect(call(sc, { price: 408.2 }).alt).toBeNull(); // 4.1 under the level, the ATR is 4
    expect(call(sc, { price: Number.NaN }).alt).toBeNull(); // no live price
  });

  it("is never read across a missing slot", () => {
    const sc = scene([A, B, C, D, ["10:14", 412.8, 412.9, 411.9, 412.0]], 411.95); // 10:12 missing
    expect(call(sc).alt).toBeNull();
  });
});

describe("finding 6: complete coverage", () => {
  it("a page that has prices from 09:30 has complete bars", () => {
    const sc = scene([["09:30", 408, 408.5, 407.8, 408.2], ["09:32", 408.2, 408.4, 408.0, 408.1]], 408.1);
    expect(sc.bars.since).toBe(nyMs("09:30"));
    expect(sc.bars.complete).toBe(true);
  });
});

describe("finding 7: one New York day", () => {
  it("drops yesterday's in-session prices, and every price outside the given session", () => {
    const y = (hhmm: string, sec: number) => nyMs(hhmm, "2026-10-09", "-04:00", sec);
    const trail: TrailPoint[] = [
      { at: y("15:58", 10), p: 500 },
      { at: y("15:59", 50), p: 501 },
      { at: nyMs("10:00", S, "-04:00", 5), p: 410 },
      { at: nyMs("10:01", S, "-04:00", 50), p: 411 },
      { at: nyMs("10:02", S, "-04:00", 5), p: 411.5 },
    ];
    const now = new Date(nyMs("10:02", S, "-04:00", 10));
    const b = bars2m(trail, null, now);
    expect(b.closed.map((x) => x.o)).toEqual([410]);
    expect(b.since).toBe(nyMs("10:00"));
    expect(bars2m(trail, null, now, false, "2026-10-09")).toMatchObject({ closed: [], partial: null, since: null });
  });
});

describe("finding 8: the server's clock", () => {
  it("serverNow shifts the browser clock by the feed's offset, and falls back to the browser", () => {
    const recv = Date.parse("2026-10-12T14:00:00.000Z");
    expect(serverNow("2026-10-12T14:00:30.000Z", recv, recv + 5_000).toISOString()).toBe("2026-10-12T14:00:35.000Z");
    expect(serverNow("2026-10-12T13:59:50.000Z", recv, recv + 5_000).toISOString()).toBe("2026-10-12T13:59:55.000Z");
    expect(serverNow(null, recv, recv + 5_000).getTime()).toBe(recv + 5_000);
    expect(serverNow("not a time", recv, recv + 5_000).getTime()).toBe(recv + 5_000);
    expect(serverNow("2026-10-12T14:00:30.000Z", null, recv).getTime()).toBe(recv);
  });
});

describe("finding 9: managing on prices after the fill", () => {
  const e = (at: string): Entry => ({ side: "call", price: 412.4, at, source: "manual" });
  const iso = (hhmm: string, sec = 0) => new Date(nyMs(hhmm, S, "-04:00", sec)).toISOString();
  it("(a) the fill bar's high before the fill is not target 1; the trail's later points in it are", () => {
    const sc = scene([["10:20", 412.4, 413.3, 412.3, 412.5]], 412.6); // the 413.30 print is at 10:20:30
    const m = manage(e(iso("10:20", 40)), PLAN.call, sc.bars, sc.quote, sc.now, false);
    expect(m).toMatchObject({ line: "Holding: stop 411.90 · target 1 413.22", stop: 411.9 });
    const withTrail = manage(e(iso("10:20", 20)), PLAN.call, sc.bars, sc.quote, sc.now, false, sc.trail);
    // target 1 printed inside the fill's bar; that bar has closed since, so the stop is at the entry and the trail waits
    expect(withTrail).toMatchObject({ line: "Stop at 412.40: trail starts after 9 bars", stop: 412.4 });
    // but the fill bar's close prints after the fill: a close under the stop there is an exit at once, not 2 min later
    const low = scene([["10:20", 412.4, 412.5, 411.7, 411.8]], 412.0);
    expect(manage(e(iso("10:20", 40)), PLAN.call, low.bars, low.quote, low.now, false)).toMatchObject({ line: "Below the stop 411.90: exit", tone: "bad" });
  });

  it("(b) an unreadable fill time: manage it on your chart, with the stop and target still shown", () => {
    const sc = scene([["10:20", 412.4, 412.5, 412.3, 412.45]], 412.45);
    expect(manage(e("garbage"), PLAN.call, sc.bars, sc.quote, sc.now, false)).toMatchObject({
      tone: "warn",
      line: "Fill time unknown: manage this one on your chart",
      stop: 411.9,
      target1: 413.22,
      notWorkingSecLeft: null,
    });
  });

  it("(c) rule 6 is judged once, on the first price from 5 minutes in", () => {
    const fill = e(iso("10:18", 30)); // due at 10:23:30: the first price after it is the 10:24 open
    const base: Spec[] = [
      ["10:20", 412.4, 412.5, 412.3, 412.4],
      ["10:22", 412.4, 412.45, 412.3, 412.38],
    ];
    // not past the entry then: the exit holds though the price is past it now
    const not = scene([...base, ["10:24", 412.35, 412.45, 412.3, 412.4], ["10:26", 412.5, 412.7, 412.5, 412.6]], 412.65);
    expect(manage(fill, PLAN.call, not.bars, not.quote, not.now, false)).toMatchObject({ line: "5 min, not working: exit", notWorkingSecLeft: 0 });
    // past it then: satisfied, and not shown again though the price is back under it
    const ok = scene([...base, ["10:24", 412.5, 412.55, 412.4, 412.45], ["10:26", 412.4, 412.45, 412.2, 412.3]], 412.3);
    expect(manage(fill, PLAN.call, ok.bars, ok.quote, ok.now, false)).toMatchObject({ line: "Holding: stop 411.90 · target 1 413.22", notWorkingSecLeft: null });
    // the trail's first point from 10:23:30 judges it when the page has the trail
    const t = withPoints(not, [{ at: nyMs("10:23", S, "-04:00", 40), p: 412.5 }]);
    expect(manage(fill, PLAN.call, t.bars, t.quote, t.now, false, t.trail).notWorkingSecLeft).toBeNull();
  });
});
