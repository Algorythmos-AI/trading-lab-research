import { describe, expect, it } from "vitest";
import { focusPlan, type SidePlan } from "@/lib/focus-plan";
import { type LiveQuote, nyClock, type Options, type TrailPoint } from "@/lib/options";
import {
  altAt,
  bars2m,
  ema,
  type Entry,
  flatMinute,
  manage,
  type NameInput,
  nameState,
  RETEST_ATR,
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
    expect(b.since).toBe(at("10:00", 5));
    // a bar ends exactly at now: closed
    expect(bars2m(trail, null, new Date(at("10:02", 0))).closed).toHaveLength(1);
    expect(bars2m([], null, new Date(at("10:02", 0)))).toEqual({ closed: [], partial: null, since: null });
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
    expect(r.alt).toEqual({ kind: "failed_break", side: "put", level: 412.3, stop: 412.9, entry: 412.0 });
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
    expect(r.alt).toEqual({ kind: "sweep_reclaim", side: "call", level: 405.1, stop: 404.0, entry: 405.3 });
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

  it("before 10:00 there is no entry; before the open a stale quote is not a pause", () => {
    const early = scene([["09:44", 412.5, 412.9, 412.4, 412.8]], 412.85);
    expect(nameState(input(early))).toMatchObject({ state: "no_trade", line: "Opening range forming: first entries from 10:00" });
    const pre = { ...early, now: new Date(nyMs("09:00")) };
    expect(nameState(input(pre, { receivedAt: null })).line).toBe("Opening range forming: first entries from 10:00");
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
    expect(sc.bars.since).toBe(nyMs("11:00", S, "-04:00", 1));
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
      const early = scene([["09:56", 412.5, 412.9, 412.4, 412.8]], 412.85, { day, offset });
      expect(nameState(input(early)).state).toBe("no_trade"); // 09:58 + 5 s New York
    }
  });

  it("shows at most two cautions and counts the rest", () => {
    const sc = scene([A, B, C, D, E], 412.75, { nowExtra: nyMs("11:30") - nyMs("10:14") });
    const s = { ...sc, quote: { ...sc.quote, at: sc.now.toISOString() } };
    const r = nameState(
      input(s, { receivedAt: s.now.getTime(), wonToday: true, ticker: { ...TICKER, expected_move: { annual_iv: 0.9 } } }),
    );
    expect(r.state).toBe("enter_zone");
    expect(r.cautions.map((c) => c.id)).toEqual(["iv", "late"]);
    expect(r.moreCautions).toBe(1);
  });
});

describe("managing a trade", () => {
  const entry = (over: Partial<Entry> = {}): Entry => ({ side: "call", price: 412.4, at: new Date(nyMs("10:20")).toISOString(), source: "manual", ...over });
  const run = (specs: Spec[], live: number, e: Entry = entry(), plan: SidePlan | null = PLAN.call, halfDay = false, nowExtra = 0) => {
    const sc = scene(specs, live, { nowExtra });
    return manage(e, plan, sc.bars, sc.quote, sc.now, halfDay);
  };

  it("holds with the stop, target 1, the 5-minute clock and the time to 15:10", () => {
    const m = run([["10:20", 412.4, 412.5, 412.3, 412.45]], 412.45);
    expect(m).toMatchObject({ line: "Holding: stop 411.90 · target 1 413.22", tone: "info", stop: 411.9, target1: 413.22, trail: null, notWorkingSecLeft: 175, minToFlat: 288 });
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
    // past the entry at 5 minutes: working, the clock goes away
    const ok = run(
      [
        ["10:20", 412.4, 412.5, 412.3, 412.4],
        ["10:22", 412.4, 412.45, 412.3, 412.38],
        ["10:24", 412.38, 412.6, 412.3, 412.55],
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
