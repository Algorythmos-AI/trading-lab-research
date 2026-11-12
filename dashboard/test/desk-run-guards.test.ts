// The server check (desk-run.ts) and the bad-data guards: the switches read every evaluated run, a failed read is
// every guard off and said on the record; the observe-mode log, always written, from what the run already read; the
// 429 count; and the page's side of the shadow comparison (desk-shadow-client.ts, desk-page-run.ts, desk-shadow.ts)
// keeping a slot out of the comparison when the page and the server ran with different switches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import type { BarsResponse } from "@/lib/bars";
import { BAR_MS, ENGINE_VERSION, type PageRecord, type ServerRecord } from "@/lib/desk-eval";
import { type DeskLogRecord, type DeskRunDeps, guardLogOf, runDeskEval } from "@/lib/desk-run";
import { parsePagePost } from "@/lib/desk-page-run";
import { shadowSummary } from "@/lib/desk-shadow";
import { pageBody } from "@/lib/desk-shadow-client";
import { suspectQuote } from "@/lib/fixture-suspect";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import type { Quote } from "@/lib/quote";
import { GUARD_REASONS } from "@/lib/quote-guards";
import { type Bar2, type NameState } from "@/lib/trade-state";
import { UpstreamError } from "@/lib/upstream";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, EDT
const OPEN = Date.parse(`${S}T13:30:00Z`);
const ny = (hhmmss: string) => Date.parse(`${S}T${hhmmss}-04:00`);
const SYMS = E.focus!.items.map((i) => i.symbol);
const LOG = '{"v":1,"eval":"log"}';

function bars(at: number): Record<string, Bar2[]> {
  const out: Record<string, Bar2[]> = {};
  for (const s of SYMS) {
    const c = E.focus!.items.find((i) => i.symbol === s)!.close ?? 100;
    const list: Bar2[] = [];
    for (let start = OPEN; start < at; start += BAR_MS) list.push({ start, end: start + BAR_MS, o: c, h: c + 0.1, l: c - 0.1, c });
    out[s] = list;
  }
  return out;
}

/** An in-memory run, as desk-run.test.ts has it, with the guards' switches in the store and a hook to bend the snapshot. */
function fakeDeps(over: Partial<DeskRunDeps> & { bend?: (sym: string, q: Quote) => Quote } = {}) {
  const store = new Map<string, string>();
  const calls = { switch: 0, guards: 0, exists: 0, write: 0, edition: 0, journal: 0, done: 0, bars: 0, snapshots: 0 };
  const { bend, ...rest } = over;
  const deps: DeskRunDeps = {
    now: () => ny("10:31:01"),
    dry: false,
    readSwitch: async () => {
      calls.switch++;
      return store.get("desk/eval.json") ?? null;
    },
    readGuards: async () => {
      calls.guards++;
      return store.get("desk/guards.json") ?? null;
    },
    exists: async (p) => {
      calls.exists++;
      return store.has(p);
    },
    write: async (p, body) => {
      calls.write++;
      if (store.has(p)) throw new PreconditionFailed();
      store.set(p, body);
    },
    loadEdition: async () => {
      calls.edition++;
      return { status: "ok", edition: E };
    },
    loadJournal: async () => {
      calls.journal++;
      return null;
    },
    readDone: async () => {
      calls.done++;
      return { status: "ok", doc: { v: 1, done: null }, memory: false };
    },
    fetchBars: async (symbols, o): Promise<BarsResponse> => {
      calls.bars++;
      const t = o.now.getTime();
      const b = bars(t);
      return { as_of: o.now.toISOString(), feed: "iex", bars: Object.fromEntries(symbols.map((s) => [s, b[s]!])), fetchedAt: Object.fromEntries(symbols.map((s) => [s, t])), missing: [] };
    },
    fetchSnapshots: async (symbols, o) => {
      calls.snapshots++;
      const t = o.now.getTime();
      const b = bars(t);
      const quotes = Object.fromEntries(
        symbols.map((s) => {
          const last = b[s]!.at(-1)!;
          const q: Quote = { price: last.c, at: new Date(t - 1_000).toISOString(), open: last.o, high: last.h, low: last.l, day: S, prev_close: null, vwap: null };
          return [s, bend ? bend(s, q) : q];
        }),
      );
      return { as_of: o.now.toISOString(), feed: "iex", quotes, missing: [] };
    },
    ...rest,
  };
  const records = () => [...store.entries()].filter(([k]) => k.startsWith("desk/log/")).map(([k, v]) => [k, JSON.parse(v) as DeskLogRecord] as const);
  return { deps, store, calls, records };
}

/** The engine's fields of a record: everything before `feed`. */
const engineOf = (r: DeskLogRecord) => {
  const engine: Record<string, unknown> = { ...r };
  for (const k of ["feed", "probe", "guards", "http_429", "evaluated_at"]) delete engine[k];
  return engine;
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const crossedSpy = (s: string, q: Quote) => (s === "SPY" ? suspectQuote(q, "quote-crossed") : q);

describe("the server check and the guards' switches", () => {
  it("are read every evaluated run, beside the journal and the done flag: one read, and no other new call", async () => {
    const f = fakeDeps();
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    expect(f.calls).toEqual({ switch: 1, guards: 1, exists: 1, write: 1, edition: 1, journal: 1, done: 1, bars: 1, snapshots: 1 });
    // a run that does not evaluate reads no switches of the guards
    const off = fakeDeps();
    await runDeskEval(off.deps);
    expect(off.calls.guards).toBe(0);
    const again = fakeDeps();
    again.store.set("desk/eval.json", LOG);
    await runDeskEval(again.deps);
    await runDeskEval(again.deps); // already logged
    expect(again.calls.guards).toBe(1);
  });

  it("off, missing, malformed or unreadable: the engine's fields are exactly those of a run with none on", async () => {
    const run = async (doc: string | null | Error) => {
      const f = fakeDeps({ bend: crossedSpy, ...(doc instanceof Error ? { readGuards: () => Promise.reject(doc) } : {}) });
      f.store.set("desk/eval.json", LOG);
      if (typeof doc === "string") f.store.set("desk/guards.json", doc);
      await runDeskEval(f.deps);
      return f.records()[0]![1];
    };
    const none = await run(null);
    for (const doc of ['{"v":1,"on":[]}', "{", '{"v":1,"on":["nope"]}', new Error("store down")]) {
      const r = await run(doc);
      expect(engineOf(r), String(doc)).toEqual(engineOf(none));
    }
    expect(none.rows.filter((r) => r.symbol === "SPY").map((r) => r.state)).not.toContain("paused");
  });

  it("a failed read is every guard off, logged, and said on the record", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const f = fakeDeps({ bend: crossedSpy, readGuards: () => Promise.reject(new Error("store down")) });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    const r = f.records()[0]![1];
    expect(r.guards).toMatchObject({ v: 1, switches: "error", on: [] });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("desk-eval.guards");
    // and a read that times out is the same
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const slow = fakeDeps({ readGuards: () => new Promise(() => undefined) });
      slow.store.set("desk/eval.json", LOG);
      await runDeskEval(slow.deps);
      expect(slow.records()[0]![1].guards).toMatchObject({ switches: "error", on: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("on and tripped: the name is paused on the record's rows, and its guard log says it was the guard", async () => {
    const f = fakeDeps({ bend: crossedSpy });
    f.store.set("desk/eval.json", LOG);
    f.store.set("desk/guards.json", '{"v":1,"on":["quote-crossed"]}');
    await runDeskEval(f.deps);
    const r = f.records()[0]![1];
    expect(r.rows.filter((x) => x.symbol === "SPY").map((x) => x.state)).toEqual(["paused", "paused"]);
    expect(r.day.stale).toBe(false);
    expect(r.guards).toEqual({
      v: 1,
      switches: "ok",
      on: ["quote-crossed"],
      names: SYMS.map((s) => (s === "SPY" ? { symbol: s, would: ["quote-crossed"], far_from_prior_close: false, paused: "guard" } : { symbol: s, would: [], far_from_prior_close: false, paused: null })),
    });
  });
});

describe("the observe-mode log", () => {
  it("with every switch off, still records per focus name which guards would have paused it, and pauses nothing", async () => {
    const f = fakeDeps({ bend: (s, q) => (s === "SPY" ? suspectQuote(q, "bar-high-below-low") : s === "QQQ" ? suspectQuote(q, "print-far-outside-day-range") : q) });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    const r = f.records()[0]![1];
    expect(r.guards).toEqual({
      v: 1,
      switches: "missing",
      on: [],
      names: SYMS.map((s) => ({
        symbol: s,
        would: s === "SPY" ? ["bar-high-below-low", "bar-open-outside-range"] : s === "QQQ" ? ["print-far-outside-day-range"] : [],
        far_from_prior_close: s === "QQQ",
        paused: null,
      })),
    });
    expect(r.rows.some((x) => x.state === "paused")).toBe(false);
    // enum words and symbols only
    const words = new Set<string>([...GUARD_REASONS, "ok", "missing", "malformed", "error", "stale", "guard", ...SYMS]);
    const walk = (v: unknown): void => {
      if (typeof v === "string") expect(words.has(v), v).toBe(true);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk([r.guards!.switches, r.guards!.on, r.guards!.names]);
  });

  it("counts a stale name as paused for no fresh price; another day's snapshot would pause nothing", () => {
    const q: Quote = { price: 100, at: "2026-10-12T14:30:00.000Z", open: 99, high: 101, low: 98, day: S, prev_close: 99, vwap: null };
    const stale = { symbol: "QQQ", state: "paused", guards: undefined } as unknown as NameState;
    const g = guardLogOf({ status: "ok", on: [] }, ["SPY", "QQQ", "AAPL"], { SPY: { ...suspectQuote(q, "quote-crossed"), day: "2026-10-09" }, QQQ: q }, S, [stale], Date.parse(q.at) + 5_000);
    expect(g.names).toEqual([
      { symbol: "SPY", would: [], far_from_prior_close: false, paused: null },
      { symbol: "QQQ", would: [], far_from_prior_close: false, paused: "stale" },
    ]);
  });

  it("records the prior-close fact on its own: a real 30% gap inside the day's range would pause nothing", () => {
    const q: Quote = { price: 130, at: "2026-10-12T14:30:00.000Z", open: 129.5, high: 131, low: 129, day: S, prev_close: 100, vwap: null, bar_ok: true, prev_bar_ok: true };
    const g = guardLogOf({ status: "ok", on: [] }, ["SPY"], { SPY: q }, S, [], Date.parse(q.at) + 5_000);
    expect(g.names).toEqual([{ symbol: "SPY", would: [], far_from_prior_close: true, paused: null }]);
    const print = guardLogOf({ status: "ok", on: [] }, ["SPY"], { SPY: { ...q, price: 132 } }, S, [], Date.parse(q.at) + 5_000);
    expect(print.names).toEqual([{ symbol: "SPY", would: ["print-far-outside-day-range"], far_from_prior_close: true, paused: null }]);
  });

  it("when the snapshot answered but the bars did not, still counts the names; when the snapshot failed, writes no log", async () => {
    const noBars = fakeDeps({ bend: crossedSpy, fetchBars: () => Promise.reject(new Error("alpaca 500")) });
    noBars.store.set("desk/eval.json", LOG);
    await runDeskEval(noBars.deps);
    const a = noBars.records()[0]![1];
    expect(a.status).toBe("degraded");
    expect(a.guards!.names.find((n) => n.symbol === "SPY")).toEqual({ symbol: "SPY", would: ["quote-crossed"], far_from_prior_close: false, paused: null });
    const noSnap = fakeDeps({ fetchSnapshots: () => Promise.reject(new Error("alpaca 500")) });
    noSnap.store.set("desk/eval.json", LOG);
    await runDeskEval(noSnap.deps);
    expect(noSnap.records()[0]![1].guards).toBeNull();
  });

  it("a failing log never fails the run, and leaves the engine's fields alone", async () => {
    const ok = fakeDeps();
    ok.store.set("desk/eval.json", LOG);
    await runDeskEval(ok.deps);
    const f = fakeDeps({
      guardLog: () => {
        throw new Error("boom");
      },
    });
    f.store.set("desk/eval.json", LOG);
    const res = await runDeskEval(f.deps);
    expect(res).toMatchObject({ ok: true, outcome: "logged" });
    const r = f.records()[0]![1];
    expect(r.guards).toBeNull();
    expect(engineOf(r)).toEqual(engineOf(ok.records()[0]![1]));
  });
});

describe("the 429 count", () => {
  it("counts the bars' and the snapshot's 429 answers, 0 when none", async () => {
    const none = fakeDeps();
    none.store.set("desk/eval.json", LOG);
    await runDeskEval(none.deps);
    expect(none.records()[0]![1].http_429).toBe(0);
    const both = fakeDeps({ fetchBars: () => Promise.reject(new UpstreamError(429)), fetchSnapshots: () => Promise.reject(new UpstreamError(429)) });
    both.store.set("desk/eval.json", LOG);
    await runDeskEval(both.deps);
    expect(both.records()[0]![1]).toMatchObject({ http_429: 2, status: "degraded", reason: "bars-failed" });
    const one = fakeDeps({ fetchSnapshots: () => Promise.reject(new UpstreamError(429)) });
    one.store.set("desk/eval.json", LOG);
    await runDeskEval(one.deps);
    expect(one.records()[0]![1].http_429).toBe(1);
    const other = fakeDeps({ fetchSnapshots: () => Promise.reject(new UpstreamError(500)) });
    other.store.set("desk/eval.json", LOG);
    await runDeskEval(other.deps);
    expect(other.records()[0]![1].http_429).toBe(0);
  });
});

// ---- the shadow comparison ------------------------------------------------------------------------------------------------
describe("the shadow comparison and the switches", () => {
  const SLOT = ny("10:30:00");
  const rows = SYMS.flatMap((symbol) => (["call", "put"] as const).map((side) => ({ symbol, side, state: "watch" as const })));
  const snap = { rows, asOf: SLOT + 5_000, barsDelayed: false };

  it("the page names the guards it ran with only when any was on, so with none on its body is as before", () => {
    const plain = JSON.parse(pageBody(SLOT, snap, [])) as Record<string, unknown>;
    expect(Object.keys(plain)).toEqual(["slot_end", "engine", "as_of", "bars_delayed", "rows", "rows_at_settle"]);
    expect(pageBody(SLOT, { ...snap, guards: [] }, [])).toBe(pageBody(SLOT, snap, []));
    const on = JSON.parse(pageBody(SLOT, { ...snap, guards: ["quote-crossed"] }, [])) as Record<string, unknown>;
    expect(Object.keys(on).at(-1)).toBe("guards");
    expect(on.guards).toEqual(["quote-crossed"]);
    expect(JSON.parse(pageBody(SLOT, null, []))).toEqual({ slot_end: new Date(SLOT).toISOString(), engine: ENGINE_VERSION, hidden: true });
  });

  it("the route takes the guards list strictly, and keeps the page's record as before when none was on", () => {
    const focus = new Set(SYMS);
    const body = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ slot_end: new Date(SLOT).toISOString(), engine: ENGINE_VERSION, as_of: new Date(SLOT + 5_000).toISOString(), bars_delayed: false, rows, rows_at_settle: rows, ...extra });
    expect(parsePagePost(body(), focus)).toMatchObject({ hidden: false, guards: [] });
    expect(parsePagePost(body({ guards: ["quote-crossed"] }), focus)).toMatchObject({ guards: ["quote-crossed"] });
    for (const bad of [[], ["nope"], ["quote-crossed", "quote-crossed"], "quote-crossed", null]) expect(parsePagePost(body({ guards: bad }), focus), JSON.stringify(bad)).toBeNull();
    expect(parsePagePost(JSON.stringify({ slot_end: new Date(SLOT).toISOString(), engine: ENGINE_VERSION, hidden: true, guards: ["quote-crossed"] }), focus)).toBeNull();
  });

  it("a slot whose page and server ran with different switches is not compared: it is counted apart", () => {
    const srv = (on: string[] | undefined): ServerRecord =>
      ({
        v: 1,
        engine: ENGINE_VERSION,
        source: "server",
        status: "ok",
        reason: null,
        slot_end: new Date(SLOT).toISOString(),
        evaluated_at: new Date(SLOT + 65_000).toISOString(),
        session: S,
        edition_session: S,
        edition_as_of: null,
        board: "live",
        rows: rows.map((r) => ({ ...r, bar_end: new Date(SLOT).toISOString() })),
        degraded_names: [],
        snapshot_ok: true,
        day: { journal_current: false, break_today: false, day_limit_used: false, done: false, half_day: false, gap: false, broke_earlier: false, stale: false },
        ...(on === undefined ? {} : { guards: { v: 1, switches: "ok", on, names: [] } }),
      }) as ServerRecord;
    const page = (guards?: string[]): PageRecord => ({
      v: 1,
      engine: ENGINE_VERSION,
      source: "page",
      slot_end: new Date(SLOT).toISOString(),
      received_at: new Date(SLOT + 61_000).toISOString(),
      hidden: false,
      as_of: new Date(SLOT + 5_000).toISOString(),
      bars_delayed: false,
      rows,
      rows_at_settle: rows,
      ...(guards ? { guards: guards as PageRecord["guards"] } : {}),
    });
    // a record from before the guards, and one with none on, read alike: compared
    expect(shadowSummary([S], [srv(undefined)], [page()])).toMatchObject({ compared: 1, guardsMismatch: 0, agreed: 1 });
    expect(shadowSummary([S], [srv([])], [page()])).toMatchObject({ compared: 1, guardsMismatch: 0 });
    expect(shadowSummary([S], [srv(["quote-crossed"])], [page(["quote-crossed"])])).toMatchObject({ compared: 1, guardsMismatch: 0 });
    // the owner switched between the two reads: not compared
    expect(shadowSummary([S], [srv(["quote-crossed"])], [page()])).toMatchObject({ compared: 0, guardsMismatch: 1 });
    expect(shadowSummary([S], [srv([])], [page(["quote-crossed"])])).toMatchObject({ compared: 0, guardsMismatch: 1 });
  });
});
