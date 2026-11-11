// The feed agreement (docs/runbooks/feed-agreement.md, revision 1): one session replayed on IEX and on SIP bars
// through the server's own evaluation, compared over the price-dependent units, read over five sessions of one engine
// label; the bars fetch; and the runner's stops, which leave no file behind.
import { describe, expect, it } from "vitest";
import { BAR_MS, type Evaluation, evaluateSlot, expectedSlots, nyHhmm, type RowSide, sessionBounds } from "@/lib/desk-eval";
import {
  clockFixed,
  compareFeeds,
  type Feed,
  feedAgreement,
  LIMITATIONS,
  matchEvents,
  MATCH_PCT,
  MIN_SESSIONS,
  readSummary,
  replayFeed,
  replayInput,
  type SessionReport,
  shareMeets,
  summaryRow,
  type SummaryRow,
  type Word,
} from "@/lib/feed-agreement";
import { CallLimiter, type Clock, fetchSessionBars, FetchStop, MAX_RETRIES, retryAfterMs } from "@/lib/feed-agreement-fetch";
import { EDITION_SIGNED, EXIT, main, parseArgs, type RunDeps } from "@/lib/feed-agreement-run";
import { focusOptions } from "@/lib/fixture-variants";
import { verify } from "@/lib/hmac";
import type { Options, TrailPoint } from "@/lib/options";
import type { Bar2 } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const OPEN = Date.parse(`${S}T13:30:00Z`);
const SYMS = E.focus!.items.map((i) => i.symbol); // three names, both plans each
const ny = (day: string, hhmmss: string, offset = "-04:00") => Date.parse(`${day}T${hhmmss}${offset}`);

/** The edition on another day (and, when asked, a half day as the v1 format says it: on each name). */
function on(day: string, half = false): Options {
  return { ...E, session: day, tickers: E.tickers.map((t) => ({ ...t, half_day: half })) } as Options;
}
/** The edition with one name's put plan removed (no support level on its card). */
function withoutPut(e: Options, sym: string): Options {
  return { ...e, focus: { ...e.focus!, items: e.focus!.items.map((i) => (i.symbol === sym ? { ...i, support: null, hold_above: null } : i)) } } as Options;
}

// ---- synthetic days ---------------------------------------------------------------------------------------------------
function pricePath(sym: string, seed: number, open = OPEN, minutes = 390, quiet = false): TrailPoint[] {
  const item = E.focus!.items.find((i) => i.symbol === sym)!;
  const hi = item.resistance!.price;
  const lo = item.support!.price;
  const mid = (hi + lo) / 2;
  const half = (hi - lo) / 2;
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  };
  const out: TrailPoint[] = [];
  for (let at = open; at < open + minutes * 60_000; at += 5_000) {
    const m = (at - open) / 60_000;
    const p = quiet
      ? mid + 0.02 * half * rnd()
      : mid + 1.5 * half * Math.sin((2 * Math.PI * m) / 97 + seed) + 0.5 * half * Math.sin((2 * Math.PI * m) / 17) + 0.15 * half * rnd();
    out.push({ at, p: Math.round(p * 100) / 100 });
  }
  return out;
}

function sessionBars(path: readonly TrailPoint[]): Bar2[] {
  const by = new Map<number, Bar2>();
  for (const x of path) {
    const start = Math.floor(x.at / BAR_MS) * BAR_MS;
    const b = by.get(start);
    if (b) {
      b.h = Math.max(b.h, x.p);
      b.l = Math.min(b.l, x.p);
      b.c = x.p;
    } else by.set(start, { start, end: start + BAR_MS, o: x.p, h: x.p, l: x.p, c: x.p });
  }
  return [...by.values()];
}

const BARS: Record<string, Bar2[]> = Object.fromEntries(SYMS.map((s, i) => [s, sessionBars(pricePath(s, i + 1))]));
const QUIET: Record<string, Bar2[]> = Object.fromEntries(SYMS.map((s, i) => [s, sessionBars(pricePath(s, i + 1, OPEN, 390, true))]));
const clone = (b: Record<string, Bar2[]>) => Object.fromEntries(Object.entries(b).map(([s, l]) => [s, l.map((x) => ({ ...x }))]));

// Per name and side on a full day: 192 live slots, 70 clock-fixed (45 lunch + 25 from 15:10), 122 price-dependent.
const FULL = { live: 192, fixed: 70, free: 122 };
// On a half day: 102 live slots, 25 clock-fixed (12:10 to 12:58), 77 price-dependent.
const HALF = { live: 102, fixed: 25, free: 77 };

// ---- synthetic evaluations, engine-realistic: no_trade inside the clock-gated windows ------------------------------
const SLOTS = expectedSlots(S);
const LIVE_FROM = SLOTS.findIndex((end) => nyHhmm(end) === "0936");
const GATED = (end: number) => {
  const h = nyHhmm(end);
  return (h >= "1130" && h < "1300") || h >= "1510";
};

function evals(fill: Word, over: Record<number, Partial<Record<string, Word>>> = {}, degraded: Record<number, string[]> = {}): Evaluation[] {
  return SLOTS.map((end, i) => {
    const live = i >= LIVE_FROM;
    const gone = new Set(degraded[i] ?? []);
    const rows = live
      ? SYMS.filter((s) => !gone.has(s)).flatMap((symbol) =>
          (["call", "put"] as RowSide[]).flatMap((side) => {
            const w = over[i]?.[`${symbol}|${side}`] ?? (GATED(end) ? "no_trade" : fill);
            return w === "none" ? [] : [{ symbol, side, state: w, bar_end: new Date(end).toISOString() }];
          }),
        )
      : [];
    return {
      status: "ok",
      reason: null,
      board: live ? "live" : "opening",
      rows,
      degraded_names: [...gone].map((symbol) => ({ symbol, reason: "bars-missing" as const })),
      snapshot_ok: true,
      day: { journal_current: false, break_today: false, day_limit_used: false, done: false, half_day: false, gap: false, broke_earlier: false, stale: false },
    };
  });
}

function fullBars(skip: Record<string, number[]> = {}): Record<string, Bar2[]> {
  return Object.fromEntries(SYMS.map((s) => [s, SLOTS.filter((end) => !(skip[s] ?? []).includes(end)).map((end) => ({ start: end - BAR_MS, end, o: 1, h: 1, l: 1, c: 1 }))]));
}

const enterAt = (sym: string, at: number, len = 3): Record<number, Partial<Record<string, Word>>> =>
  Object.fromEntries(Array.from({ length: len }, (_, k) => [at + k, { [`${sym}|call`]: "enter_zone" as Word }]));

const cmp = (iex: Evaluation[], sip: Evaluation[], bars: Partial<Record<Feed, Record<string, Bar2[]>>> = {}, edition = E): SessionReport =>
  compareFeeds({ edition, day: S, slots: SLOTS, evals: { iex, sip }, bars: { iex: bars.iex ?? fullBars(), sip: bars.sip ?? fullBars() } });

const AT = LIVE_FROM + 20; // 10:16, price-dependent

// ---- the replay ---------------------------------------------------------------------------------------------------------
describe("the replay runs the server's own evaluation", () => {
  it("gives evaluateSlot the neutral inputs: the slot's settle instant, a snapshot at the slot's end with no high or low, no journal", () => {
    const end = ny(S, "10:30:00");
    const input = replayInput(E, S, end, BARS);
    expect(input.journal).toBeNull();
    expect(input.done).toBe(false);
    for (const s of SYMS) {
      expect(input.fetchedAt[s]).toBe(end + 60_000);
      expect(input.snapshots[s]).toMatchObject({ at: new Date(end).toISOString(), day: S, high: null, low: null });
    }
    expect(replayFeed(E, S, [end], BARS)[0]).toEqual(evaluateSlot(input));
  });

  it("identical bars on both feeds: 100% of the price-dependent units match, no event unmatched, the excluded sets exact", () => {
    const r = feedAgreement(E, S, { iex: clone(BARS), sip: clone(BARS) });
    const n = SYMS.length * 2;
    expect(r.slots).toBe(194);
    expect(r.live_slots).toBe(FULL.live);
    expect(r.units).toEqual({ total: FULL.live * n, clock_fixed: FULL.fixed * n, no_plan: 0, both_lack: 0, comparable: FULL.free * n, identical: FULL.free * n, iex_lacks: 0, sip_lacks: 0 });
    expect(r.share).toBe(1);
    expect(r.events.iex).toBeGreaterThan(0);
    expect(r.events).toMatchObject({ matched: r.events.iex, iex_only: 0, sip_only: 0, median_offset: 0, worst_offset: 0 });
    expect(r.names_without_bars).toEqual({ iex: [], sip: [] });
    expect(r.limitations).toEqual(LIMITATIONS);
    // engine-realistic: the clock-fixed units are no_trade on both feeds by the engine itself
    expect(Object.keys(r.clock_fixed_pairs)).toEqual(["no_trade|no_trade"]);
  });

  it("the reviewer's case: IEX missing every 5th bar on a quiet day reads well under 98%, and different over five sessions", () => {
    const iex = clone(QUIET);
    for (const s of SYMS) iex[s] = iex[s]!.filter((_, k) => k % 5 !== 4);
    const r = feedAgreement(E, S, { iex, sip: clone(QUIET) });
    expect(r.units.iex_lacks).toBeGreaterThan(0);
    expect(r.units.sip_lacks).toBe(0);
    expect(r.units.both_lack).toBe(0);
    expect(r.share).toBeLessThan(0.9);
    expect(r.disagreements.some((d) => d.iex === "paused" || d.iex === "none")).toBe(true);
    const row = summaryRow(r, Date.parse("2026-10-12T21:00:00Z"));
    const lines = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((day) => JSON.stringify({ ...row, day }));
    expect(readSummary(lines).reading).toBe("different");
  });

  it("a bar missing on SIP alone leaves the unit comparable and counts it by its words (paused or none against the IEX word)", () => {
    const sip = clone(BARS);
    const sym = SYMS[0]!;
    const end = ny(S, "10:30:00");
    sip[sym] = sip[sym]!.filter((b) => b.end !== end);
    const base = feedAgreement(E, S, { iex: clone(BARS), sip: clone(BARS) });
    const r = feedAgreement(E, S, { iex: clone(BARS), sip });
    expect(r.units.comparable).toBe(base.units.comparable); // nothing left out
    expect(r.units.sip_lacks).toBe(2);
    expect(r.units.iex_lacks).toBe(0);
    const at = r.disagreements.filter((d) => d.symbol === sym && d.slot === "1030");
    // without a print in the slot the board on SIP pauses, or (a break since, then a missing slot) carries no state
    expect(at).toHaveLength(2);
    expect(at.every((d) => (d.sip === "paused" || d.sip === "none") && d.iex !== "paused" && d.iex !== "none")).toBe(true);
    expect(r.bars_missing.by_slot).toEqual([{ slot: "1030", iex: 0, sip: 1 }]);
  });

  it("a name with no IEX bars all day: listed, the report still made, its price-dependent units all disagreements", () => {
    const iex = clone(BARS);
    delete iex[SYMS[0]!];
    const r = feedAgreement(E, S, { iex, sip: clone(BARS) });
    expect(r.names_without_bars).toEqual({ iex: [SYMS[0]], sip: [] });
    expect(r.units.iex_lacks).toBe(FULL.free * 2);
    const own = r.disagreements.filter((d) => d.symbol === SYMS[0]);
    expect(own).toHaveLength(FULL.free * 2);
    expect(own.every((d) => d.iex === "none")).toBe(true);
    expect(r.no_state.iex.names["bars-missing"]).toBe(FULL.live); // live slots only, never 09:32 or 09:34
    expect(summaryRow(r, 0).names_without_bars).toEqual({ iex: [SYMS[0]], sip: [] });
  });

  it("no-plan sides and clock-fixed slots leave the share and are counted apart, exactly, on a full day", () => {
    const e = withoutPut(E, SYMS[2]!);
    const r = feedAgreement(e, S, { iex: clone(BARS), sip: clone(BARS) });
    expect(r.units.clock_fixed).toBe(FULL.fixed * 6);
    expect(r.units.no_plan).toBe(FULL.free); // its put side, outside the clock-fixed slots
    expect(r.units.comparable).toBe(FULL.free * 5);
  });

  it("on a half day: 102 live slots, 25 clock-fixed per side, no lunch block, both lack where neither feed has bars", () => {
    const H = "2026-11-27"; // the day after Thanksgiving: a half day, and the day after a holiday
    const slots = expectedSlots(H);
    expect(slots).toHaveLength(104);
    const e = withoutPut(on(H, true), SYMS[0]!);
    const r = feedAgreement(e, H, { iex: {}, sip: {} }, slots);
    expect(r.half_day).toBe(true);
    expect(r.live_slots).toBe(HALF.live);
    expect(r.units).toMatchObject({ total: HALF.live * 6, clock_fixed: HALF.fixed * 6, no_plan: HALF.free, both_lack: HALF.free * 5, comparable: 0 });
    expect(r.share).toBeNull();
    expect(clockFixed(ny(H, "12:08:00", "-05:00"), true)).toBe(false);
    expect(clockFixed(ny(H, "12:10:00", "-05:00"), true)).toBe(true);
    expect(clockFixed(ny(H, "11:30:00", "-05:00"), true)).toBe(false);
  });

  it("the clock-fixed boundaries agree with the engine: 11:28 and 13:00 free, 11:30, 12:58 and 15:10 fixed, all no_trade", () => {
    expect(clockFixed(ny(S, "11:28:00"), false)).toBe(false);
    expect(clockFixed(ny(S, "13:00:00"), false)).toBe(false);
    expect(clockFixed(ny(S, "15:08:00"), false)).toBe(false);
    for (const t of ["11:30:00", "12:58:00", "15:10:00", "15:58:00"]) {
      const end = ny(S, t);
      expect(clockFixed(end, false), t).toBe(true);
      const ev = evaluateSlot(replayInput(E, S, end, BARS));
      expect(ev.rows.every((x) => x.state === "no_trade"), t).toBe(true);
    }
    // the slots left in the share: 09:36 to 11:28 and 13:00 to 15:08
    const free = expectedSlots(S).filter((end) => !clockFixed(end, false) && nyHhmm(end) >= "0936");
    expect(free).toHaveLength(FULL.free);
  });

  it("holds counts, state words, slot times and symbols: no level and no price", () => {
    const sip = clone(BARS);
    for (const b of sip[SYMS[1]!]!) b.c = b.c + 0.37;
    const r = feedAgreement(E, S, { iex: clone(BARS), sip });
    const text = JSON.stringify(r);
    for (const i of E.focus!.items) for (const v of [i.resistance?.price, i.support?.price]) if (v != null) expect(text).not.toContain(String(v));
    for (const b of BARS[SYMS[0]!]!.slice(0, 30)) expect(text).not.toContain(`:${b.c},`);
    expect(text).not.toMatch(/"(price|level|entry|stop|target1)"/);
  });

  it("the engine does not import the comparison: its label's closure has no feed-agreement file", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const gen = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[] };
    const files = gen.engineFiles();
    expect(files.some((f) => f.endsWith("desk-eval.ts"))).toBe(true);
    expect(files.some((f) => f.includes("feed-agreement"))).toBe(false);
  });
});

// ---- units and events, exactly ------------------------------------------------------------------------------------
describe("units and enter-zone events", () => {
  it("the same slot on both feeds: matched at offset 0", () => {
    const r = cmp(evals("watch", enterAt(SYMS[0]!, AT)), evals("watch", enterAt(SYMS[0]!, AT)));
    expect(r.events).toMatchObject({ iex: 1, sip: 1, matched: 1, iex_only: 0, sip_only: 0, median_offset: 0, worst_offset: 0 });
  });

  it("a one-slot shift: matched within one slot, offset +1 (SIP later)", () => {
    const r = cmp(evals("watch", enterAt(SYMS[0]!, AT)), evals("watch", enterAt(SYMS[0]!, AT + 1)));
    expect(r.events).toMatchObject({ iex: 1, sip: 1, matched: 1, iex_only: 0, sip_only: 0, median_offset: 1, worst_offset: 1 });
    expect(r.events.by_offset).toEqual({ "-1": 0, "0": 0, "1": 1 });
    expect(r.events.list).toEqual([{ symbol: SYMS[0], side: "call", iex: nyHhmm(SLOTS[AT]!), sip: nyHhmm(SLOTS[AT + 1]!), offset: 1 }]);
  });

  it("a two-slot shift: one IEX-only and one SIP-only event", () => {
    const r = cmp(evals("watch", enterAt(SYMS[0]!, AT)), evals("watch", enterAt(SYMS[0]!, AT + 2)));
    expect(r.events).toMatchObject({ iex: 1, sip: 1, matched: 0, iex_only: 1, sip_only: 1, median_offset: null, worst_offset: null });
  });

  it("an event enters enter zone from any other word; a run is one event; a slot with no state ends it", () => {
    const over = { ...enterAt(SYMS[0]!, AT, 3), ...enterAt(SYMS[0]!, AT + 4, 2) };
    const r = cmp(evals("watch", over, { [AT + 3]: [SYMS[0]!] }), evals("watch", over, { [AT + 3]: [SYMS[0]!] }));
    expect(r.events.iex).toBe(2);
    expect(r.events.matched).toBe(2);
    const first = cmp(evals("watch", enterAt(SYMS[1]!, LIVE_FROM, 1)), evals("watch"));
    expect(first.events).toMatchObject({ iex: 1, sip: 0, iex_only: 1 });
  });

  it("matching is one to one, closest first", () => {
    expect(matchEvents([10], [10, 11])).toEqual({ pairs: [[0, 0]], iexOnly: [], sipOnly: [1] });
    expect(matchEvents([10, 12], [11])).toEqual({ pairs: [[0, 0]], iexOnly: [1], sipOnly: [] });
    expect(matchEvents([10, 11], [11])).toEqual({ pairs: [[1, 0]], iexOnly: [0], sipOnly: [] });
  });

  it("a disagreeing word is counted and listed; none on one feed against watch is a disagreement, none against none is not", () => {
    const r = cmp(evals("watch"), evals("watch", { [AT]: { [`${SYMS[0]}|put`]: "get_ready" } }));
    expect(r.units.comparable - r.units.identical).toBe(1);
    expect(r.disagreements).toEqual([{ symbol: SYMS[0], side: "put", slot: nyHhmm(SLOTS[AT]!), iex: "watch", sip: "get_ready" }]);
    const one = cmp(evals("watch", {}, { [AT]: [SYMS[0]!] }), evals("watch"));
    expect(one.units.comparable - one.units.identical).toBe(2);
    expect(one.pairs["none|watch"]).toBe(2);
    const both = cmp(evals("watch", {}, { [AT]: [SYMS[0]!] }), evals("watch", {}, { [AT]: [SYMS[0]!] }));
    expect(both.units.comparable - both.units.identical).toBe(0);
    expect(both.no_state.iex.names["bars-missing"]).toBe(1);
  });

  it("both feeds lacking the slot's bar: left out as both lack; one feed lacking it: comparable, counted as a fact", () => {
    const both = cmp(evals("watch"), evals("watch"), { iex: fullBars({ [SYMS[2]!]: [SLOTS[AT]!] }), sip: fullBars({ [SYMS[2]!]: [SLOTS[AT]!] }) });
    expect(both.units.both_lack).toBe(2);
    expect(both.units.comparable).toBe(FULL.free * 6 - 2);
    const one = cmp(evals("watch"), evals("watch"), { sip: fullBars({ [SYMS[2]!]: [SLOTS[AT]!] }) });
    expect(one.units).toMatchObject({ both_lack: 0, sip_lacks: 2, comparable: FULL.free * 6 });
  });

  it("a pause inside a clock-fixed window stays out of the share and shows in the clock-fixed pairs", () => {
    const lunch = SLOTS.findIndex((end) => nyHhmm(end) === "1200");
    const r = cmp(evals("watch"), evals("watch", { [lunch]: { [`${SYMS[0]}|call`]: "paused" } }));
    expect(r.units.identical).toBe(r.units.comparable);
    expect(r.clock_fixed_pairs["no_trade|paused"]).toBe(1);
  });

  it("exactly 98% of the price-dependent units passes, and one identical unit fewer does not", () => {
    // 6 sides x 122 = 732 comparable units; 2% of 732 is 14.64: 14 disagreements pass (98.09%), and at 50 units 1 does
    const disagree = (n: number) => {
      const over: Record<number, Partial<Record<string, Word>>> = {};
      for (let k = 0; k < n; k++) over[AT + k] = { [`${SYMS[0]}|call`]: "get_ready" };
      return cmp(evals("watch"), evals("watch", over));
    };
    const r14 = disagree(14);
    const r15 = disagree(15);
    expect(r14.units.comparable).toBe(732);
    expect(shareMeets(r14.units.identical, r14.units.comparable)).toBe(true);
    expect(shareMeets(r15.units.identical, r15.units.comparable)).toBe(false);
    expect(shareMeets(49, 50)).toBe(true); // exactly 98.000%
    expect(shareMeets(48, 50)).toBe(false);
  });
});

// ---- the session's slots ------------------------------------------------------------------------------------------------
describe("the slot list, by New York time from the exchange calendar", () => {
  it("the day after a holiday (Labor Day 2026-09-07): a full session of 194 slots from 09:32", () => {
    expect(expectedSlots("2026-09-07")).toEqual([]);
    const slots = expectedSlots("2026-09-08");
    expect(slots).toHaveLength(194);
    expect(slots[0]).toBe(ny("2026-09-08", "09:32:00"));
  });

  it("the week of the clock change: 09:32 New York is 13:32 UTC on Friday 30 Oct and 14:32 UTC on Monday 2 Nov", () => {
    const fri = expectedSlots("2026-10-30");
    const mon = expectedSlots("2026-11-02");
    expect(new Date(fri[0]!).toISOString()).toBe("2026-10-30T13:32:00.000Z");
    expect(new Date(mon[0]!).toISOString()).toBe("2026-11-02T14:32:00.000Z");
    expect(fri).toHaveLength(194);
    expect(mon).toHaveLength(194);
    expect(clockFixed(ny("2026-11-02", "11:30:00", "-05:00"), false)).toBe(true);
    expect(clockFixed(ny("2026-11-02", "11:28:00", "-05:00"), false)).toBe(false);
  });
});

// ---- the reading ----------------------------------------------------------------------------------------------------------
function row(day: string, over: Partial<SummaryRow> = {}): string {
  const base: SummaryRow = {
    v: 2,
    day,
    engine: "e-test",
    run_at: "2026-11-12T22:00:00.000Z",
    comparable: 200,
    identical: 196,
    events_iex: 3,
    events_sip: 3,
    matched: 3,
    iex_only: 0,
    sip_only: 0,
    iex_lacks: 0,
    sip_lacks: 0,
    both_lack: 0,
    clock_fixed: 100,
    no_plan: 0,
    bars_missing_iex: 0,
    bars_missing_sip: 0,
    names_without_bars: { iex: [], sip: [] },
  };
  return JSON.stringify({ ...base, ...over });
}
const DAYS = ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18"];

describe("the reading over sessions (fixed thresholds)", () => {
  it("states the runbook's thresholds", () => {
    expect(MIN_SESSIONS).toBe(5);
    expect(MATCH_PCT).toBe(98);
  });

  it("exactly 98.000% over five sessions reads as equivalent; one identical unit fewer does not", () => {
    expect(readSummary(DAYS.map((d) => row(d)))).toMatchObject({ reading: "equivalent", engine: "e-test" });
    expect(readSummary(DAYS.map((d) => row(d))).labels[0]!.share).toBe(0.98);
    expect(readSummary(DAYS.map((d, i) => row(d, i === 0 ? { identical: 195 } : {}))).reading).toBe("different");
  });

  it("with 4 sessions says not enough sessions, however well they agree", () => {
    expect(readSummary(DAYS.slice(0, 4).map((d) => row(d, { identical: 200 }))).reading).toBe("not-enough-sessions");
  });

  it("five sessions under mixed engine labels: not enough sessions (labels differ), never pooled", () => {
    const mixed = DAYS.map((d, i) => row(d, { identical: 200, engine: i < 3 ? "e-aaa" : "e-bbb" }));
    const s = readSummary(mixed);
    expect(s.reading).toBe("not-enough-sessions-labels-differ");
    expect(s.engine).toBe("e-bbb");
    expect(s.labels.map((g) => [g.engine, g.sessions])).toEqual([
      ["e-aaa", 3],
      ["e-bbb", 2],
    ]);
    // five of the latest label read normally, the older label listed apart
    const later = [...mixed, ...["2026-11-19", "2026-11-20", "2026-11-23"].map((d) => row(d, { identical: 200, engine: "e-bbb" }))];
    expect(readSummary(later)).toMatchObject({ reading: "equivalent", engine: "e-bbb" });
  });

  it("one unmatched enter-zone event on either feed reads different, even at 100%", () => {
    expect(readSummary(DAYS.map((d, i) => row(d, { identical: 200, ...(i === 2 ? { sip_only: 1, events_sip: 4 } : {}) }))).reading).toBe("different");
    expect(readSummary(DAYS.map((d, i) => row(d, { identical: 200, ...(i === 4 ? { iex_only: 1, events_iex: 4 } : {}) }))).reading).toBe("different");
  });

  it("counts each day once (its latest run), skips unreadable and old-version lines, reads zero comparable as different", () => {
    const lines = [...DAYS.slice(0, 4).map((d) => row(d)), row(DAYS[0]!, { identical: 100 }), "not json", row(DAYS[4]!, { v: 1 as 2 }), row(DAYS[0]!)];
    const s = readSummary(lines);
    expect(s.labels[0]!.sessions).toBe(4);
    expect(s.unreadable).toBe(2);
    expect(readSummary(DAYS.map((d) => row(d, { comparable: 0, identical: 0 }))).reading).toBe("different");
  });
});

// ---- the bars fetch ---------------------------------------------------------------------------------------------------------
function fakeClock(start: number): Clock & { sleeps: number[]; t: { now: number } } {
  const t = { now: start };
  const sleeps: number[] = [];
  return {
    t,
    sleeps,
    now: () => t.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      t.now += ms;
    },
  };
}
const raw = (b: Bar2) => ({ t: new Date(b.start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: 100 });
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("the bars fetch", () => {
  const bounds = sessionBounds(S)!;
  const opts = (fetchImpl: typeof fetch, clock = fakeClock(ny(S, "18:00:00")), budget = 120_000) => ({
    keys: { id: "k", secret: "s" },
    clock,
    deadline: clock.now() + budget,
    limiter: new CallLimiter(),
    fetchImpl,
  });

  it("follows next_page_token, drops duplicates, sorts, and keeps the regular session only", async () => {
    const all = BARS[SYMS[0]!]!;
    const pages = [
      { bars: { [SYMS[0]!]: [raw(all[5]!), raw(all[1]!), raw(all[0]!)] }, next_page_token: "p2" },
      { bars: { [SYMS[0]!]: [raw(all[1]!), raw(all[2]!), { t: "2026-10-12T13:28:00Z", o: 1, h: 1, l: 1, c: 1 }, { t: "2026-10-12T20:00:00Z", o: 1, h: 1, l: 1, c: 1 }] }, next_page_token: null },
    ];
    const tokens: (string | null)[] = [];
    const f = (async (url: string) => {
      tokens.push(new URL(url).searchParams.get("page_token"));
      return jsonRes(pages.shift());
    }) as unknown as typeof fetch;
    const got = await fetchSessionBars("iex", SYMS, bounds, opts(f));
    expect(tokens).toEqual([null, "p2"]);
    expect(got[SYMS[0]!]!.map((b) => b.start)).toEqual([all[0]!.start, all[1]!.start, all[2]!.start, all[5]!.start]);
    expect(got[SYMS[1]!]).toEqual([]);
  });

  it("on a half day keeps bars before 13:00 only", async () => {
    const H = "2026-11-27";
    const hb = sessionBounds(H)!;
    const bar = (hhmm: string) => ({ t: new Date(ny(H, `${hhmm}:00`, "-05:00")).toISOString(), o: 1, h: 1, l: 1, c: 1 });
    const f = (async () => jsonRes({ bars: { [SYMS[0]!]: [bar("12:56"), bar("12:58"), bar("13:00"), bar("13:02")] } })) as unknown as typeof fetch;
    const got = await fetchSessionBars("sip", SYMS, hb, opts(f, fakeClock(ny(H, "18:00:00", "-05:00"))));
    expect(got[SYMS[0]!]!.map((b) => nyHhmm(b.end))).toEqual(["1258", "1300"]);
  });

  it("a winter (EST) day asks from 14:30 to 21:00 UTC", async () => {
    const W = "2026-11-11";
    let q: URLSearchParams | null = null;
    const f = (async (url: string) => {
      q = new URL(url).searchParams;
      return jsonRes({ bars: { [SYMS[0]!]: [{ t: "2026-11-11T14:30:00Z", o: 1, h: 1, l: 1, c: 1 }] } });
    }) as unknown as typeof fetch;
    const got = await fetchSessionBars("iex", SYMS, sessionBounds(W)!, opts(f, fakeClock(ny(W, "18:00:00", "-05:00"))));
    expect(q!.get("start")).toBe("2026-11-11T14:30:00.000Z");
    expect(q!.get("end")).toBe("2026-11-11T21:00:00.000Z");
    expect(got[SYMS[0]!]).toHaveLength(1);
  });

  const stop = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as FetchStop;
    }
    throw new Error("no stop");
  };

  it("a 401 is upstream with keys rejected; a body that is not JSON is upstream", async () => {
    const e401 = await stop(fetchSessionBars("iex", SYMS, bounds, opts((async () => jsonRes({}, 401)) as unknown as typeof fetch)));
    expect([e401.kind, e401.line]).toEqual(["upstream", "upstream: iex bars answered HTTP 401 (keys rejected); no report written"]);
    const bad = await stop(fetchSessionBars("iex", SYMS, bounds, opts((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)));
    expect(bad.kind).toBe("upstream");
    expect(bad.line).toMatch(/not JSON/);
  });

  it("a deadline abort while the body arrives is the time budget, not 'not JSON'", async () => {
    const slow = {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    };
    const e = await stop(fetchSessionBars("sip", SYMS, bounds, opts((async () => slow) as unknown as typeof fetch, undefined, 10_000)));
    expect(e.kind).toBe("time-budget");
  });

  it("waits an HTTP-date Retry-After, and stops when the call limit's wait would reach the deadline", async () => {
    const clock = fakeClock(ny(S, "18:00:00"));
    const answers = [jsonRes({}, 429, { "retry-after": new Date(clock.now() + 4_000).toUTCString() }), jsonRes({ bars: { [SYMS[0]!]: [raw(BARS[SYMS[0]!]![0]!)] } })];
    await fetchSessionBars("iex", SYMS, bounds, opts((async () => answers.shift()!) as unknown as typeof fetch, clock));
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(3_000);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(4_000);
    const full = fakeClock(ny(S, "18:00:00"));
    const o = opts((async () => jsonRes({ bars: {} })) as unknown as typeof fetch, full, 30_000);
    for (let i = 0; i < 180; i++) o.limiter.record(full.now());
    const e = await stop(fetchSessionBars("iex", SYMS, bounds, o));
    expect(e.kind).toBe("time-budget");
    expect(full.sleeps).toEqual([]);
  });

  it("the call limit and Retry-After parsing", () => {
    const l = new CallLimiter();
    for (let i = 0; i < 180; i++) l.record(1000 + i);
    expect(l.waitMs(2000)).toBe(1000 + 60_000 - 2000);
    expect(l.waitMs(61_000)).toBe(0);
    expect(retryAfterMs("2", 0)).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs("soon", 0)).toBeNull();
  });
});

// ---- the runner -------------------------------------------------------------------------------------------------------------
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "hang";

function rawBars(bars: Record<string, Bar2[]>) {
  return Object.fromEntries(Object.entries(bars).map(([s, l]) => [s, l.map(raw)]));
}

/** A fake run: in-memory files, a clock that moves only when the runner sleeps or a call hangs, scripted answers. */
function harness(answers: Record<Feed | "site", Answer[]>, opts: { now?: number; edition?: unknown; env?: Record<string, string>; failWrite?: (p: string) => boolean; failRename?: (p: string) => boolean } = {}) {
  let now = opts.now ?? ny(S, "18:00:00");
  const files = new Map<string, string>();
  files.set("/ed.json", JSON.stringify(opts.edition ?? E));
  const printed: string[] = [];
  const sleeps: number[] = [];
  const urls: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    headersSeen.push(init.headers as Record<string, string>);
    const feed = url.includes("/api/editions/") ? "site" : (new URL(url).searchParams.get("feed") as Feed);
    const a = answers[feed].shift() ?? { status: 500 };
    if (a === "hang") {
      now += 200_000;
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: a.headers ?? {} });
  }) as unknown as typeof fetch;
  const deps: RunDeps = {
    env: opts.env ?? { APCA_API_KEY_ID: "KEYID-SECRETISH", APCA_API_SECRET_KEY: "SECRET-VALUE" },
    clock: {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    fetchImpl,
    readText: async (p) => files.get(p) ?? null,
    writeText: async (p, t) => {
      if (opts.failWrite?.(p)) throw Object.assign(new Error("disk full"), { name: "ENOSPC" });
      files.set(p, t);
    },
    rename: async (a, b) => {
      if (opts.failRename?.(b)) throw Object.assign(new Error("no"), { name: "EACCES" });
      const t = files.get(a);
      if (t === undefined) throw new Error("missing");
      files.delete(a);
      files.set(b, t);
    },
    remove: async (p) => void files.delete(p),
    mkdirp: async () => {},
    print: (l) => printed.push(l),
    defaultOut: "/out",
  };
  const written = () => [...files.keys()].filter((k) => k.startsWith("/out")).sort();
  return { deps, files, printed, sleeps, urls, headersSeen, written };
}

const ok = (bars: Record<string, Bar2[]>): Answer => ({ status: 200, body: { bars: rawBars(bars), next_page_token: null } });
const ARGV = ["--day", S, "--edition", "/ed.json"];
const NO: Answer[] = [];

describe("the runner", () => {
  it("reads both feeds, writes the report, the table and one summary row, and never prints a key", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [ok(BARS)], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.ok);
    expect(h.written()).toEqual(["/out/2026-10-12.json", "/out/2026-10-12.txt", "/out/summary.jsonl"]);
    const report = JSON.parse(h.files.get("/out/2026-10-12.json")!) as SessionReport;
    expect(report.share).toBe(1);
    expect(h.files.get("/out/summary.jsonl")!.trim().split("\n")).toHaveLength(1);
    expect(h.urls.map((u) => new URL(u).searchParams.get("feed"))).toEqual(["iex", "sip"]);
    for (const u of h.urls) {
      const q = new URL(u).searchParams;
      expect(new URL(u).origin + new URL(u).pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
      expect([q.get("timeframe"), q.get("start"), q.get("end")]).toEqual(["2Min", "2026-10-12T13:30:00.000Z", "2026-10-12T20:00:00.000Z"]);
      expect(q.get("symbols")!.split(",")).toEqual(SYMS);
    }
    expect(h.headersSeen[0]!["APCA-API-KEY-ID"]).toBe("KEYID-SECRETISH");
    const out = [...h.printed, ...h.files.values()].join("\n");
    expect(out).not.toContain("KEYID-SECRETISH");
    expect(out).not.toContain("SECRET-VALUE");
    expect(h.printed.join("\n")).toContain("reading: not enough sessions");
    // a second session appends a second row
    const h2 = harness({ iex: [ok(BARS)], sip: [ok(BARS)], site: [] });
    h2.files.set("/out/summary.jsonl", h.files.get("/out/summary.jsonl")!);
    await main(ARGV, h2.deps);
    expect(h2.files.get("/out/summary.jsonl")!.trim().split("\n")).toHaveLength(2);
  });

  it("a winter day through the whole fetch path", async () => {
    const W = "2026-11-11";
    const wb: Record<string, Bar2[]> = Object.fromEntries(SYMS.map((s, i) => [s, sessionBars(pricePath(s, i + 1, Date.parse(`${W}T14:30:00Z`)))]));
    const h = harness({ iex: [ok(wb)], sip: [ok(wb)], site: [] }, { now: ny(W, "17:00:00", "-05:00"), edition: on(W) });
    expect(await main(["--day", W, "--edition", "/ed.json"], h.deps)).toBe(EXIT.ok);
    const r = JSON.parse(h.files.get(`/out/${W}.json`)!) as SessionReport;
    expect(r.units.comparable).toBe(FULL.free * 6);
    expect(r.share).toBe(1);
  });

  it("an empty SIP answer: says so, exits no-bars, writes nothing", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [{ status: 200, body: { bars: {}, next_page_token: null } }], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.noBars);
    expect(h.printed[0]).toMatch(/^no bars: the sip feed returned no bars for any focus name on 2026-10-12/);
    expect(h.written()).toEqual([]);
  });

  it("SIP answers 403: sip not entitled, worded for both causes, exit 5, nothing written, no body printed", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [{ status: 403, body: { message: "subscription does not permit querying recent SIP data" } }], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.plan);
    expect(h.printed[0]).toBe("sip not entitled: Alpaca answered 403 (not entitled, or recent data not permitted on this plan) for the SIP feed; no report written");
    expect(h.written()).toEqual([]);
  });

  it("a 401: upstream, exit 8, nothing written", async () => {
    const h = harness({ iex: [{ status: 401 }], sip: [], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.upstream);
    expect(h.printed[0]).toMatch(/401 \(keys rejected\)/);
    expect(h.written()).toEqual([]);
  });

  it("a 429 with Retry-After is waited out exactly, then the run completes", async () => {
    const h = harness({ iex: [{ status: 429, headers: { "retry-after": "3" } }, ok(BARS)], sip: [ok(BARS)], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.ok);
    expect(h.sleeps).toEqual([3000]);
  });

  it("a 429 whose Retry-After outlasts the budget: time budget, exit 7, nothing written", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [{ status: 429, headers: { "retry-after": "500" } }], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.budget);
    expect(h.printed[0]).toMatch(/^time budget: a 429 Retry-After on sip/);
    expect(h.written()).toEqual([]);
  });

  it(`429 after 429: gives up after ${MAX_RETRIES} retries, exit 8, nothing written`, async () => {
    const many = Array.from({ length: MAX_RETRIES + 1 }, () => ({ status: 429, headers: { "retry-after": "1" } }));
    const h = harness({ iex: many, sip: [], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.upstream);
    expect(h.sleeps).toHaveLength(MAX_RETRIES);
    expect(h.written()).toEqual([]);
  });

  it("a call that runs past the time budget: time budget, exit 7, nothing written", async () => {
    const h = harness({ iex: ["hang"], sip: [], site: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.budget);
    expect(h.printed[0]).toMatch(/^time budget:/);
    expect(h.written()).toEqual([]);
  });

  it("a failed report write: exit 9, one line, no file and no temporary file left", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [ok(BARS)], site: [] }, { failWrite: (p) => p.includes(".txt") });
    expect(await main(ARGV, h.deps)).toBe(EXIT.write);
    expect(h.printed).toEqual(["write failed: ENOSPC; nothing was left behind"]);
    expect(h.written()).toEqual([]);
  });

  it("a failed summary append: exit 9, the new report files removed, the old summary untouched", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [ok(BARS)], site: [] }, { failRename: (p) => p.endsWith("summary.jsonl") });
    h.files.set("/out/summary.jsonl", `${row("2026-10-09")}\n`);
    expect(await main(ARGV, h.deps)).toBe(EXIT.write);
    expect(h.written()).toEqual(["/out/summary.jsonl"]);
    expect(h.files.get("/out/summary.jsonl")).toBe(`${row("2026-10-09")}\n`);
  });

  it("an unexpected failure is one line and exit 10, never a stack trace", async () => {
    const h = harness({ iex: [], sip: [], site: [] });
    h.deps.readText = async () => {
      throw new TypeError("boom");
    };
    expect(await main(ARGV, h.deps)).toBe(EXIT.failed);
    expect(h.printed).toEqual(["failed: TypeError; no report written"]);
  });

  it("refuses a holiday, a run before the close plus 20 minutes (half days too), and an edition for another day, before any call", async () => {
    const holiday = harness({ iex: [], sip: [], site: [] });
    expect(await main(["--day", "2026-11-26", "--edition", "/ed.json"], holiday.deps)).toBe(EXIT.refused);
    const early = harness({ iex: [], sip: [], site: [] }, { now: ny(S, "16:19:59") });
    expect(await main(ARGV, early.deps)).toBe(EXIT.refused);
    expect(early.printed[0]).toBe("refused: run from 20 minutes after the 2026-10-12 close, when its bars have settled");
    const H = "2026-11-27";
    const halfEarly = harness({ iex: [], sip: [], site: [] }, { now: ny(H, "13:19:00", "-05:00"), edition: on(H, true) });
    expect(await main(["--day", H, "--edition", "/ed.json"], halfEarly.deps)).toBe(EXIT.refused);
    const other = harness({ iex: [], sip: [], site: [] }, { edition: { ...E, session: "2026-10-13" } });
    expect(await main(ARGV, other.deps)).toBe(EXIT.refused);
    const empty = harness({ iex: [], sip: [], site: [] }, { edition: { ...E, focus: { ...E.focus, items: [] } } });
    expect(await main(ARGV, empty.deps)).toBe(EXIT.refused);
    for (const h of [holiday, early, halfEarly, other, empty]) {
      expect(h.urls).toEqual([]);
      expect(h.written()).toEqual([]);
    }
    const onTime = harness({ iex: [ok(BARS)], sip: [ok(BARS)], site: [] }, { now: ny(S, "16:20:00") });
    expect(await main(ARGV, onTime.deps)).toBe(EXIT.ok);
  });

  it("without keys says so and exits 4; bad arguments print the usage and exit 2", async () => {
    const h = harness({ iex: [], sip: [], site: [] }, { env: {} });
    expect(await main(ARGV, h.deps)).toBe(EXIT.noKeys);
    expect(h.urls).toEqual([]);
    expect(parseArgs(["--day", "2026-1-1", "--edition", "x"])).toBeNull();
    expect(parseArgs(["--day", "2026-11-12;rm", "--save-edition"])).toBeNull();
    expect(parseArgs(["--summary", "--day", S])).toBeNull();
    expect(parseArgs(["--summary", "--save-edition"])).toBeNull();
    expect(parseArgs(["--day", S, "--edition", "x", "--budget-s", "0"])).toBeNull();
    const u = harness({ iex: [], sip: [], site: [] });
    expect(await main(["--day"], u.deps)).toBe(EXIT.usage);
  });

  it("the summary mode reads the running summary and changes nothing", async () => {
    const h = harness({ iex: [], sip: [], site: [] });
    h.files.set("/out/summary.jsonl", `${DAYS.map((d) => row(d)).join("\n")}\n`);
    expect(await main(["--summary"], h.deps)).toBe(EXIT.ok);
    expect(h.printed.join("\n")).toContain("reading: equivalent for the board");
    expect(h.urls).toEqual([]);
  });
});

describe("saving the session's edition", () => {
  const env = { DASHBOARD_INGEST_URL: "https://dash.example.test/api/ingest", DASHBOARD_INGEST_SECRET: "ingest-secret" };

  it("one signed GET; saved only when it is that session's", async () => {
    const h = harness({ iex: NO, sip: NO, site: [{ status: 200, body: { kind: "options", edition: E } }] }, { env });
    expect(await main(["--save-edition", "--day", S], h.deps)).toBe(EXIT.ok);
    expect(h.urls).toEqual(["https://dash.example.test/api/editions/options"]);
    const hd = h.headersSeen[0]!;
    expect(verify("ingest-secret", hd["x-wt-timestamp"]!, hd["x-wt-signature"]!, EDITION_SIGNED, new Date(ny(S, "18:00:00"))).ok).toBe(true);
    expect(JSON.parse(h.files.get(`/out/editions/${S}.json`)!).session).toBe(S);
    expect(h.printed.join("\n")).not.toContain("ingest-secret");
  });

  it("another session's edition: refused, nothing saved; no ingest settings: exit 4", async () => {
    const h = harness({ iex: NO, sip: NO, site: [{ status: 200, body: { edition: { ...E, session: "2026-10-13" } } }] }, { env });
    expect(await main(["--save-edition", "--day", S], h.deps)).toBe(EXIT.refused);
    expect(h.printed[0]).toBe("refused: the site holds the 2026-10-13 edition, not 2026-10-12; nothing saved");
    expect(h.written()).toEqual([]);
    const none = harness({ iex: NO, sip: NO, site: [] }, { env: {} });
    expect(await main(["--save-edition", "--day", S], none.deps)).toBe(EXIT.noKeys);
    expect(none.urls).toEqual([]);
  });
});
