// The feed agreement (docs/runbooks/feed-agreement.md): one session replayed on IEX and on SIP bars through the
// server's own evaluation, compared, and read over five sessions; and the runner's stops, which write nothing.
import { describe, expect, it } from "vitest";
import { BAR_MS, type Evaluation, evaluateSlot, expectedSlots, nyHhmm, type RowSide } from "@/lib/desk-eval";
import {
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
} from "@/lib/feed-agreement";
import { CallLimiter, FetchStop, MAX_RETRIES, retryAfterMs } from "@/lib/feed-agreement-fetch";
import { EXIT, main, parseArgs, type RunDeps } from "@/lib/feed-agreement-run";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options, TrailPoint } from "@/lib/options";
import type { Bar2, NameStateName } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const OPEN = Date.parse(`${S}T13:30:00Z`);
const SYMS = E.focus!.items.map((i) => i.symbol);
const ny = (day: string, hhmmss: string, offset = "-04:00") => Date.parse(`${day}T${hhmmss}${offset}`);

// ---- a synthetic day (the same kind of path as desk-eval.test.ts) ---------------------------------------------------
function pricePath(sym: string, seed: number): TrailPoint[] {
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
  for (let at = OPEN; at < OPEN + 390 * 60_000; at += 5_000) {
    const m = (at - OPEN) / 60_000;
    const p = mid + 1.5 * half * Math.sin((2 * Math.PI * m) / 97 + seed) + 0.5 * half * Math.sin((2 * Math.PI * m) / 17) + 0.15 * half * rnd();
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
const clone = (b: Record<string, Bar2[]>) => Object.fromEntries(Object.entries(b).map(([s, l]) => [s, l.map((x) => ({ ...x }))]));

// ---- synthetic evaluations, for exact event timing ------------------------------------------------------------------
const SLOTS = expectedSlots(S);
const LIVE_FROM = SLOTS.findIndex((end) => nyHhmm(end) === "0936");

/** One feed's evaluations: board live from 09:36, every focus name's two sides at `fill`, with overrides by slot index. */
function evals(fill: NameStateName, over: Record<number, Partial<Record<string, NameStateName>>> = {}, degraded: Record<number, string[]> = {}): Evaluation[] {
  return SLOTS.map((end, i) => {
    const live = i >= LIVE_FROM;
    const gone = new Set(degraded[i] ?? []);
    const rows = live
      ? SYMS.filter((s) => !gone.has(s)).flatMap((symbol) =>
          (["call", "put"] as RowSide[]).map((side) => ({ symbol, side, state: over[i]?.[`${symbol}|${side}`] ?? fill, bar_end: new Date(end).toISOString() })),
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

/** A bar at every slot for every focus name (prices do not matter to the comparison). */
function fullBars(skip: Record<string, number[]> = {}): Record<string, Bar2[]> {
  return Object.fromEntries(
    SYMS.map((s) => [s, SLOTS.filter((end) => !(skip[s] ?? []).includes(end)).map((end) => ({ start: end - BAR_MS, end, o: 1, h: 1, l: 1, c: 1 }))]),
  );
}

/** Enter zone on one name's call side for `len` slots from slot index `at`. */
const enterAt = (sym: string, at: number, len = 3): Record<number, Partial<Record<string, NameStateName>>> =>
  Object.fromEntries(Array.from({ length: len }, (_, k) => [at + k, { [`${sym}|call`]: "enter_zone" as NameStateName }]));

const cmp = (iex: Evaluation[], sip: Evaluation[], bars: Partial<Record<Feed, Record<string, Bar2[]>>> = {}): SessionReport =>
  compareFeeds({ edition: E, day: S, slots: SLOTS, evals: { iex, sip }, bars: { iex: bars.iex ?? fullBars(), sip: bars.sip ?? fullBars() } });

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
    // exactly what evaluateSlot gives for that input: no copy of the engine
    expect(replayFeed(E, S, [end], BARS)[0]).toEqual(evaluateSlot(input));
  });

  it("identical bars on both feeds: 100% of comparable units match and no event is unmatched", () => {
    const r = feedAgreement(E, S, { iex: clone(BARS), sip: clone(BARS) });
    expect(r.slots).toBe(194);
    expect(r.live_slots).toBe(192); // 09:32 and 09:34 are the opening range
    expect(r.units.total).toBe(192 * SYMS.length * 2);
    expect(r.units.comparable).toBe(r.units.total);
    expect(r.units.identical).toBe(r.units.comparable);
    expect(r.share).toBe(1);
    expect(r.disagreements).toEqual([]);
    expect(r.events.iex).toBeGreaterThan(0); // the path reaches enter zone, so the event rule is exercised
    expect(r.events.iex).toBe(r.events.sip);
    expect(r.events.matched).toBe(r.events.iex);
    expect(r.events.iex_only + r.events.sip_only).toBe(0);
    expect(r.events.median_offset).toBe(0);
    expect(r.events.worst_offset).toBe(0);
    expect(r.bars_missing).toEqual({ iex: 0, sip: 0, by_slot: [] });
    expect(r.limitations).toEqual(LIMITATIONS);
  });

  it("a bar missing on SIP alone puts that name's units for that slot in SIP lacks, never in agreement", () => {
    const sip = clone(BARS);
    const sym = SYMS[0]!;
    const end = ny(S, "10:30:00");
    sip[sym] = sip[sym]!.filter((b) => b.end !== end);
    const r = feedAgreement(E, S, { iex: clone(BARS), sip });
    expect(r.units.one_sided.sip_lacks).toBeGreaterThanOrEqual(2);
    expect(r.units.one_sided.iex_lacks).toBe(0);
    expect(r.units.comparable + r.units.one_sided.sip_lacks + r.units.one_sided.iex_lacks + r.units.both_lack).toBe(r.units.total);
    expect(r.disagreements.some((d) => d.symbol === sym && d.slot === "1030")).toBe(false);
    expect(r.bars_missing.sip).toBe(1);
    expect(r.bars_missing.by_slot).toEqual([{ slot: "1030", iex: 0, sip: 1 }]);
  });

  it("holds counts, state words, slot times and symbols: no level and no price", () => {
    const sip = clone(BARS);
    for (const b of sip[SYMS[1]!]!) b.c = b.c + 0.37; // a different tape, so states and events differ
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

// ---- the events ---------------------------------------------------------------------------------------------------------
describe("enter-zone events", () => {
  const at = LIVE_FROM + 40;

  it("the same slot on both feeds: matched at offset 0", () => {
    const r = cmp(evals("watch", enterAt(SYMS[0]!, at)), evals("watch", enterAt(SYMS[0]!, at)));
    expect(r.events).toMatchObject({ iex: 1, sip: 1, matched: 1, iex_only: 0, sip_only: 0, median_offset: 0, worst_offset: 0 });
  });

  it("a one-slot shift: matched within one slot, offset +1 (SIP later)", () => {
    const r = cmp(evals("watch", enterAt(SYMS[0]!, at)), evals("watch", enterAt(SYMS[0]!, at + 1)));
    expect(r.events).toMatchObject({ iex: 1, sip: 1, matched: 1, iex_only: 0, sip_only: 0, median_offset: 1, worst_offset: 1 });
    expect(r.events.by_offset).toEqual({ "-1": 0, "0": 0, "1": 1 });
    expect(r.events.list).toEqual([{ symbol: SYMS[0], side: "call", iex: nyHhmm(SLOTS[at]!), sip: nyHhmm(SLOTS[at + 1]!), offset: 1 }]);
  });

  it("a two-slot shift: one IEX-only and one SIP-only event", () => {
    const r = cmp(evals("watch", enterAt(SYMS[0]!, at)), evals("watch", enterAt(SYMS[0]!, at + 2)));
    expect(r.events).toMatchObject({ iex: 1, sip: 1, matched: 0, iex_only: 1, sip_only: 1, median_offset: null, worst_offset: null });
  });

  it("an event is a slot entering enter zone from any other state; a run of enter zone is one event, a gap ends it", () => {
    // enter zone for 3 slots, a slot with no state (name degraded), then enter zone again: two events
    const over = { ...enterAt(SYMS[0]!, at, 3), ...enterAt(SYMS[0]!, at + 4, 2) };
    const r = cmp(evals("watch", over, { [at + 3]: [SYMS[0]!] }), evals("watch", over, { [at + 3]: [SYMS[0]!] }));
    expect(r.events.iex).toBe(2);
    expect(r.events.matched).toBe(2);
    // the first live slot has no previous slot: enter zone there is an event
    const first = cmp(evals("watch", enterAt(SYMS[1]!, LIVE_FROM, 1)), evals("watch"));
    expect(first.events).toMatchObject({ iex: 1, sip: 0, iex_only: 1 });
  });

  it("matching is one to one, closest first", () => {
    expect(matchEvents([10], [10, 11])).toEqual({ pairs: [[0, 0]], iexOnly: [], sipOnly: [1] });
    expect(matchEvents([10, 12], [11])).toEqual({ pairs: [[0, 0]], iexOnly: [1], sipOnly: [] });
    expect(matchEvents([10, 11], [11])).toEqual({ pairs: [[1, 0]], iexOnly: [0], sipOnly: [] });
  });

  it("a disagreeing state is counted and listed by name, side and slot", () => {
    const r = cmp(evals("watch"), evals("watch", { [at]: { [`${SYMS[0]}|put`]: "get_ready" } }));
    expect(r.units.comparable - r.units.identical).toBe(1);
    expect(r.disagreements).toEqual([{ symbol: SYMS[0], side: "put", slot: nyHhmm(SLOTS[at]!), iex: "watch", sip: "get_ready" }]);
    expect(r.pairs["watch|get_ready"]).toBe(1);
  });

  it("a name with no state on IEX alone is IEX lacks; on both is both lack", () => {
    const r = cmp(evals("watch", {}, { [at]: [SYMS[0]!] }), evals("watch"));
    expect(r.units.one_sided).toEqual({ iex_lacks: 2, sip_lacks: 0 });
    const both = cmp(evals("watch", {}, { [at]: [SYMS[0]!] }), evals("watch", {}, { [at]: [SYMS[0]!] }));
    expect(both.units.both_lack).toBe(2);
    expect(both.no_state.iex.names["bars-missing"]).toBe(1);
  });

  it("a missing bar with a state still present on SIP is not comparable", () => {
    const r = cmp(evals("watch"), evals("watch"), { sip: fullBars({ [SYMS[2]!]: [SLOTS[at]!] }) });
    expect(r.units.one_sided.sip_lacks).toBe(2);
    expect(r.bars_missing.by_slot).toEqual([{ slot: nyHhmm(SLOTS[at]!), iex: 0, sip: 1 }]);
  });
});

// ---- the session's slots ------------------------------------------------------------------------------------------------
describe("the slot list, by New York time from the exchange calendar", () => {
  it("a half day (the day after Thanksgiving, also the day after a holiday): 104 slots, 09:32 to 12:58", () => {
    const H = "2026-11-27";
    const slots = expectedSlots(H);
    expect(slots).toHaveLength(104);
    expect(nyHhmm(slots[0]!)).toBe("0932");
    expect(nyHhmm(slots.at(-1)!)).toBe("1258");
    const half = { ...E, session: H, market: { ...(E.market ?? {}), session: { ...(E.market?.session ?? {}), half_day: true } } } as Options;
    const r = feedAgreement(half, H, { iex: {}, sip: {} }, slots);
    expect(r.half_day).toBe(true);
    expect(r.slots).toBe(104);
    expect(r.units.both_lack).toBe(r.units.total); // no bars on either feed: nothing comparable, nothing counted as agreement
    expect(r.units.comparable).toBe(0);
    expect(r.share).toBeNull();
  });

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
    expect(nyHhmm(mon.at(-1)!)).toBe("1558");
  });
});

// ---- the reading ----------------------------------------------------------------------------------------------------------
function row(day: string, over: Partial<SummaryRow> = {}): string {
  const base: SummaryRow = {
    v: 1,
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
    bars_missing_iex: 0,
    bars_missing_sip: 0,
  };
  return JSON.stringify({ ...base, ...over });
}
const DAYS = ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18"];

describe("the reading over sessions (fixed thresholds)", () => {
  it("states the runbook's thresholds", () => {
    expect(MIN_SESSIONS).toBe(5);
    expect(MATCH_PCT).toBe(98);
  });

  it("exactly 98.000% reads as equivalent; just under does not", () => {
    expect(shareMeets(98, 100)).toBe(true);
    expect(shareMeets(4900, 5000)).toBe(true);
    expect(shareMeets(4899, 5000)).toBe(false); // 97.98%
    expect(shareMeets(0, 0)).toBe(false);
    expect(readSummary(DAYS.map((d) => row(d)))).toMatchObject({ reading: "equivalent", sessions: 5, share: 0.98 });
    const under = DAYS.map((d, i) => row(d, i === 0 ? { identical: 195 } : {}));
    expect(readSummary(under).reading).toBe("different"); // 979 of 1000
  });

  it("with 4 sessions says not enough sessions, however well they agree", () => {
    const s = readSummary(DAYS.slice(0, 4).map((d) => row(d, { identical: 200 })));
    expect(s).toMatchObject({ reading: "not-enough-sessions", sessions: 4 });
  });

  it("one unmatched enter-zone event on either feed reads different, even at 100%", () => {
    expect(readSummary(DAYS.map((d, i) => row(d, { identical: 200, ...(i === 2 ? { sip_only: 1, events_sip: 4 } : {}) }))).reading).toBe("different");
    expect(readSummary(DAYS.map((d, i) => row(d, { identical: 200, ...(i === 4 ? { iex_only: 1, events_iex: 4 } : {}) }))).reading).toBe("different");
  });

  it("counts each session day once (its latest run), skips unreadable lines, and reads zero comparable units as different", () => {
    const lines = [...DAYS.slice(0, 4).map((d) => row(d)), row(DAYS[0]!, { identical: 100 }), "not json", row(DAYS[0]!)];
    const s = readSummary(lines);
    expect(s.sessions).toBe(4);
    expect(s.unreadable).toBe(1);
    expect(readSummary(DAYS.map((d) => row(d, { comparable: 0, identical: 0 }))).reading).toBe("different");
  });

  it("a report's summary row carries its counts", () => {
    const r = feedAgreement(E, S, { iex: clone(BARS), sip: clone(BARS) });
    const x = summaryRow(r, Date.parse("2026-10-12T21:00:00Z"));
    expect(x).toMatchObject({ day: S, comparable: r.units.comparable, identical: r.units.identical, matched: r.events.matched, iex_only: 0, sip_only: 0 });
  });
});

// ---- the runner -------------------------------------------------------------------------------------------------------------
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "hang";

function rawBars(bars: Record<string, Bar2[]>) {
  return Object.fromEntries(Object.entries(bars).map(([s, l]) => [s, l.map((b) => ({ t: new Date(b.start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: 100 }))]));
}

/** A fake run: in-memory files, a clock that moves only when the runner sleeps or a call hangs, scripted answers per feed. */
function harness(answers: Record<Feed, Answer[]>, opts: { now?: number; edition?: unknown; env?: Record<string, string> } = {}) {
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
    const feed = new URL(url).searchParams.get("feed") as Feed;
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
    writeText: async (p, t) => void files.set(p, t),
    appendText: async (p, t) => void files.set(p, (files.get(p) ?? "") + t),
    mkdirp: async () => {},
    print: (l) => printed.push(l),
    defaultOut: "/out",
  };
  const written = () => [...files.keys()].filter((k) => k.startsWith("/out"));
  return { deps, files, printed, sleeps, urls, headersSeen, written };
}

const ok = (bars: Record<string, Bar2[]>): Answer => ({ status: 200, body: { bars: rawBars(bars), next_page_token: null } });
const ARGV = ["--day", S, "--edition", "/ed.json"];

describe("the runner", () => {
  it("reads both feeds, writes the JSON report, the table and one summary row, and never prints a key", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [ok(BARS)] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.ok);
    expect(h.written().sort()).toEqual(["/out/2026-10-12.json", "/out/2026-10-12.txt", "/out/summary.jsonl"]);
    const report = JSON.parse(h.files.get("/out/2026-10-12.json")!) as SessionReport;
    expect(report.share).toBe(1);
    expect(h.files.get("/out/summary.jsonl")!.trim().split("\n")).toHaveLength(1);
    expect(h.urls.map((u) => new URL(u).searchParams.get("feed"))).toEqual(["iex", "sip"]);
    for (const u of h.urls) {
      const q = new URL(u).searchParams;
      expect(new URL(u).origin + new URL(u).pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
      expect(q.get("timeframe")).toBe("2Min");
      expect(q.get("start")).toBe("2026-10-12T13:30:00.000Z");
      expect(q.get("end")).toBe("2026-10-12T20:00:00.000Z");
      expect(q.get("symbols")!.split(",")).toEqual(SYMS);
    }
    expect(h.headersSeen[0]!["APCA-API-KEY-ID"]).toBe("KEYID-SECRETISH");
    const out = [...h.printed, ...h.files.values()].join("\n");
    expect(out).not.toContain("KEYID-SECRETISH");
    expect(out).not.toContain("SECRET-VALUE");
    expect(h.printed.join("\n")).toContain("reading: not enough sessions");
  });

  it("an empty SIP answer: says so, exits no-bars, writes nothing", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [{ status: 200, body: { bars: {}, next_page_token: null } }] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.noBars);
    expect(h.printed.join("\n")).toMatch(/^no bars: the sip feed returned no bars for any focus name on 2026-10-12/);
    expect(h.written()).toEqual([]);
  });

  it("SIP answers 403: sip not entitled, exit 5, nothing written", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [{ status: 403, body: { message: "subscription does not permit querying recent SIP data" } }] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.plan);
    expect(h.printed[0]).toMatch(/^sip not entitled: Alpaca answered 403/);
    expect(h.printed.join("\n")).not.toContain("subscription"); // the body is never printed
    expect(h.written()).toEqual([]);
  });

  it("a 429 with Retry-After is waited out exactly, then the run completes", async () => {
    const h = harness({ iex: [{ status: 429, headers: { "retry-after": "3" } }, ok(BARS)], sip: [ok(BARS)] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.ok);
    expect(h.sleeps).toEqual([3000]);
    expect(h.urls).toHaveLength(3);
  });

  it("a 429 whose Retry-After outlasts the budget: time budget, exit 7, nothing written", async () => {
    const h = harness({ iex: [ok(BARS)], sip: [{ status: 429, headers: { "retry-after": "500" } }] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.budget);
    expect(h.printed[0]).toMatch(/^time budget: a 429 Retry-After on sip/);
    expect(h.sleeps).toEqual([]);
    expect(h.written()).toEqual([]);
  });

  it("429 after 429: gives up after the retries, exit 8, nothing written", async () => {
    const many = Array.from({ length: MAX_RETRIES + 1 }, () => ({ status: 429, headers: { "retry-after": "1" } }));
    const h = harness({ iex: many, sip: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.upstream);
    expect(h.sleeps).toHaveLength(MAX_RETRIES);
    expect(h.written()).toEqual([]);
  });

  it("a call that runs past the time budget: time budget, exit 7, nothing written", async () => {
    const h = harness({ iex: ["hang"], sip: [] });
    expect(await main(ARGV, h.deps)).toBe(EXIT.budget);
    expect(h.printed[0]).toMatch(/^time budget:/);
    expect(h.written()).toEqual([]);
  });

  it("refuses a holiday, a session not yet closed, and an edition for another day, before any call", async () => {
    const holiday = harness({ iex: [], sip: [] });
    expect(await main(["--day", "2026-11-26", "--edition", "/ed.json"], holiday.deps)).toBe(EXIT.refused);
    const early = harness({ iex: [], sip: [] }, { now: ny(S, "15:59:00") });
    expect(await main(ARGV, early.deps)).toBe(EXIT.refused);
    expect(early.printed[0]).toBe("refused: the 2026-10-12 session has not closed yet");
    const other = harness({ iex: [], sip: [] }, { edition: { ...E, session: "2026-10-13" } });
    expect(await main(ARGV, other.deps)).toBe(EXIT.refused);
    const empty = harness({ iex: [], sip: [] }, { edition: { ...E, focus: { ...E.focus, items: [] } } });
    expect(await main(ARGV, empty.deps)).toBe(EXIT.refused);
    for (const h of [holiday, early, other, empty]) {
      expect(h.urls).toEqual([]);
      expect(h.written()).toEqual([]);
    }
  });

  it("without keys says so and exits 4; bad arguments print the usage and exit 2", async () => {
    const h = harness({ iex: [], sip: [] }, { env: {} });
    expect(await main(ARGV, h.deps)).toBe(EXIT.noKeys);
    expect(h.urls).toEqual([]);
    expect(parseArgs(["--day", "2026-1-1", "--edition", "x"])).toBeNull();
    expect(parseArgs(["--summary", "--day", S])).toBeNull();
    expect(parseArgs(["--day", S, "--edition", "x", "--budget-s", "0"])).toBeNull();
    const u = harness({ iex: [], sip: [] });
    expect(await main(["--day"], u.deps)).toBe(EXIT.usage);
  });

  it("the summary mode reads the running summary and changes nothing", async () => {
    const h = harness({ iex: [], sip: [] });
    h.files.set("/out/summary.jsonl", `${DAYS.map((d) => row(d)).join("\n")}\n`);
    expect(await main(["--summary"], h.deps)).toBe(EXIT.ok);
    expect(h.printed.join("\n")).toContain("reading: equivalent for the board");
    expect(h.urls).toEqual([]);
  });
});

describe("the call limits", () => {
  it("keeps under 200 calls a minute", () => {
    const l = new CallLimiter();
    for (let i = 0; i < 180; i++) l.record(1000 + i);
    expect(l.waitMs(2000)).toBe(1000 + 60_000 - 2000);
    expect(l.waitMs(61_000)).toBe(0);
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs("2", 0)).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs("soon", 0)).toBeNull();
    expect(new FetchStop("no-bars", "x").kind).toBe("no-bars");
  });
});
