// The server's shadow evaluation (DEC-0044): the slot it evaluates, the board it reproduces by calling the page's own
// functions, the record it writes (enums, booleans, symbols and instants only) and the engine's label.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BAR_MS,
  ENGINE_VERSION,
  evaluateSlot,
  expectedSlots,
  type EvalInput,
  nyHhmm,
  pageLogPath,
  parseEvalSwitch,
  ROW_STATES,
  serverLogPath,
  serverRecord,
  settledSlotEnd,
  slotAt,
  stateRows,
  SYMBOL_RE,
} from "@/lib/desk-eval";
import { focusOptions } from "@/lib/fixture-variants";
import type { LiveQuote, Options, TrailPoint } from "@/lib/options";
import { boardMode, boardRows } from "@/lib/trade-now";
import { type Bar2, CLOSE_GRACE_MS, type NameState, SERVER_SETTLE_MS } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const OPEN = Date.parse(`${S}T13:30:00Z`);
const ny = (day: string, hhmmss: string, offset = "-04:00") => Date.parse(`${day}T${hhmmss}${offset}`);

// ---- the slot -------------------------------------------------------------------------------------------------------
describe("the slot a run evaluates", () => {
  it("is the last bar whose end + SERVER_SETTLE_MS has passed, at every second of a 2-minute window", () => {
    const end = ny(S, "10:30:00");
    for (let s = 0; s < 120; s++) {
      const t = end + SERVER_SETTLE_MS + s * 1000;
      expect(settledSlotEnd(t)).toBe(end);
      const at = slotAt(t);
      expect(at).toMatchObject({ kind: "slot", day: S, end });
    }
    // a millisecond before the settle instant it is still the bar before
    expect(settledSlotEnd(end + SERVER_SETTLE_MS - 1)).toBe(end - BAR_MS);
    expect(settledSlotEnd(end + SERVER_SETTLE_MS + 120_000)).toBe(end + BAR_MS);
  });

  it("is idle at 09:30:00 and until the 09:30 bar has settled at 09:33:00, then evaluates 09:32", () => {
    expect(slotAt(ny(S, "09:29:59"))).toEqual({ kind: "idle", why: "outside-hours" });
    expect(slotAt(ny(S, "09:30:00"))).toEqual({ kind: "idle", why: "no-slot-yet" });
    expect(slotAt(ny(S, "09:32:59"))).toEqual({ kind: "idle", why: "no-slot-yet" });
    expect(slotAt(ny(S, "09:33:00"))).toMatchObject({ kind: "slot", end: ny(S, "09:32:00") });
    expect(nyHhmm(ny(S, "09:32:00"))).toBe("0932");
  });

  it("logs its last slot (15:56 to 15:58) at 15:59, and is idle from 16:00", () => {
    expect(slotAt(ny(S, "15:59:30"))).toMatchObject({ kind: "slot", end: ny(S, "15:58:00") });
    expect(slotAt(ny(S, "16:00:00"))).toEqual({ kind: "idle", why: "outside-hours" });
    const slots = expectedSlots(S);
    expect(slots[0]).toBe(ny(S, "09:32:00"));
    expect(slots.at(-1)).toBe(ny(S, "15:58:00"));
    expect(slots).toHaveLength(194);
  });

  it("on a half day ends at 13:00: the last slot is 12:58, logged at 12:59", () => {
    const H = "2026-11-27"; // the day after Thanksgiving, EST
    expect(slotAt(ny(H, "12:59:10", "-05:00"))).toMatchObject({ kind: "slot", day: H, end: ny(H, "12:58:00", "-05:00") });
    expect(slotAt(ny(H, "13:00:00", "-05:00"))).toEqual({ kind: "idle", why: "outside-hours" });
    expect(expectedSlots(H)).toHaveLength(104);
    expect(expectedSlots(H).at(-1)).toBe(ny(H, "12:58:00", "-05:00"));
  });

  it("is idle all day on a weekend and on a holiday, whatever the hour", () => {
    for (const day of ["2026-11-14", "2026-11-15", "2026-11-26"]) {
      for (const h of ["09:45:00", "12:00:00", "15:30:00"]) expect(slotAt(ny(day, h, "-05:00"))).toEqual({ kind: "idle", why: "closed-day" });
      expect(expectedSlots(day)).toEqual([]);
    }
  });

  it("names one file per slot by the New York day and slot end, and the page's beside it", () => {
    const end = ny("2026-11-11", "10:04:00", "-05:00");
    expect(serverLogPath("2026-11-11", end)).toBe("desk/log/2026-11-11/1004.json");
    expect(pageLogPath("2026-11-11", end)).toBe("desk/log/2026-11-11/1004.page.json");
  });
});

describe("the switch", () => {
  it("is log only for exactly { v: 1, eval: 'log' }; anything else, or nothing, is off", () => {
    expect(parseEvalSwitch('{"v":1,"eval":"log"}')).toBe("log");
    expect(parseEvalSwitch('{"eval":"log","v":1}')).toBe("log");
    for (const bad of [null, undefined, "", "log", "{}", '{"v":1,"eval":"LOG"}', '{"v":2,"eval":"log"}', '{"v":1,"eval":"log","x":1}', '{"v":"1","eval":"log"}', "[1]", '{"v":1,"eval":"off"}', "x".repeat(300)])
      expect(parseEvalSwitch(bad)).toBe("off");
  });
});

// ---- a synthetic day ------------------------------------------------------------------------------------------------
/** A deterministic price path for each focus name, one print every 5 s from 09:30 to 16:00, crossing its levels. */
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

const SYMS = E.focus!.items.map((i) => i.symbol);
const PATHS: Record<string, TrailPoint[]> = Object.fromEntries(SYMS.map((s, i) => [s, pricePath(s, i + 1)]));

/** The bars an upstream feed would hold at `at`: every print before it, by 2-minute slot, the last one still forming. */
function upstreamBars(path: readonly TrailPoint[], at: number): Bar2[] {
  const by = new Map<number, Bar2>();
  for (const x of path) {
    if (x.at >= at) break;
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

/** The snapshot as the page's quote saw it at the slot's close: the last print before it, the high and low so far. */
function snapshotAt(path: readonly TrailPoint[], at: number): LiveQuote {
  const seen = path.filter((x) => x.at < at);
  const last = seen.at(-1)!;
  return { price: last.p, at: new Date(last.at).toISOString(), open: seen[0]!.p, high: Math.max(...seen.map((x) => x.p)), low: Math.min(...seen.map((x) => x.p)), day: S, prev_close: null, vwap: null };
}

function serverInput(slotEnd: number, runAt: number, over: Partial<EvalInput> = {}): EvalInput {
  return {
    slot: { day: S, end: slotEnd },
    edition: E,
    journal: null,
    done: false,
    bars: Object.fromEntries(SYMS.map((s) => [s, upstreamBars(PATHS[s]!, runAt)])),
    fetchedAt: Object.fromEntries(SYMS.map((s) => [s, runAt])),
    // Here the snapshot holds what the page had at the slot's close, so both sides see the same prints; the
    // divergence tests (desk-divergence.test.ts) read it at run time, as production does.
    snapshots: Object.fromEntries(SYMS.map((s) => [s, snapshotAt(PATHS[s]!, slotEnd)])),
    ...over,
  };
}

/** The page's own board at the slot's close: every print it polled before the slot's end, the last as its quote. */
function pageStates(slotEnd: number): NameState[] {
  const now = slotEnd + CLOSE_GRACE_MS;
  const quotes: Record<string, LiveQuote> = {};
  const trails: Record<string, TrailPoint[]> = {};
  for (const s of SYMS) {
    const seen = PATHS[s]!.filter((x) => x.at < slotEnd);
    trails[s] = seen;
    const last = seen.at(-1)!;
    quotes[s] = { price: last.p, at: new Date(last.at).toISOString(), open: seen[0]!.p, high: Math.max(...seen.map((x) => x.p)), low: Math.min(...seen.map((x) => x.p)), day: S, prev_close: null, vwap: null };
  }
  const live = boardMode(S, false, "ok", now).kind === "live";
  const rows = boardRows(
    { session: S, halfDay: false, items: E.focus!.items, tickers: E.tickers, quotes, trails, serverBars: {}, serverFetchedAt: {}, now, receivedAt: now, dayLimitUsed: false, wonToday: null },
    live,
  );
  return rows.map((r) => r.state).filter((x): x is NameState => x !== null);
}

const strip = (rows: { symbol: string; side: string; state: string }[]) => rows.map((r) => `${r.symbol}/${r.side}:${r.state}`).sort();

describe("the server's board is the page's board", () => {
  it("at every slot of a dense synthetic day, from one price path and the same prints, the server's states equal the page's", () => {
    const seen = new Set<string>();
    for (const end of expectedSlots(S)) {
      const ev = evaluateSlot(serverInput(end, end + SERVER_SETTLE_MS + 1_000));
      expect(ev.status).toBe("ok");
      const page = pageStates(end).flatMap(stateRows);
      expect(strip(ev.rows), nyHhmm(end)).toEqual(strip(page));
      for (const r of ev.rows) seen.add(r.state);
      if (ev.board !== "live") expect(ev.rows).toEqual([]);
    }
    // The path is not a quiet one: it reaches the states that matter.
    for (const s of ["watch", "get_ready", "enter_zone", "plan_off", "no_trade"]) expect(seen, s).toContain(s);
  });

  it("two runs inside one slot, at T+61 s and at T+119 s (with the next bar already forming upstream), are identical", () => {
    for (const end of expectedSlots(S).filter((_, i) => i % 7 === 0)) {
      const a = evaluateSlot(serverInput(end, end + 61_000));
      const b = evaluateSlot(serverInput(end, end + 119_000));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(serverRecord(b, { day: S, end }, end + 70_000, E))).toBe(JSON.stringify(serverRecord(a, { day: S, end }, end + 70_000, E)));
    }
  });

  it("never reads a bar the server read before it settled", () => {
    const end = ny(S, "10:30:00");
    const early = serverInput(end, end + 61_000, { fetchedAt: Object.fromEntries(SYMS.map((s) => [s, end + 30_000])) });
    expect(evaluateSlot(early)).toMatchObject({ status: "degraded", reason: "bars-unsettled", rows: [] });
  });

  it("a name with no bars, or no snapshot for today, carries no state; the others keep theirs", () => {
    const end = ny(S, "10:30:00");
    const input = serverInput(end, end + 61_000);
    const ev = evaluateSlot({ ...input, bars: { ...input.bars, AAPL: [] }, snapshots: { ...input.snapshots, QQQ: { ...input.snapshots.QQQ!, day: "2026-10-09" } } });
    expect(ev.status).toBe("ok");
    expect(ev.degraded_names).toEqual([{ symbol: "QQQ", reason: "snapshot-missing" }, { symbol: "AAPL", reason: "bars-missing" }]);
    expect(ev.rows.map((r) => r.symbol)).toEqual(["SPY", "SPY"]);
    expect(ev.day.gap).toBe(true);
  });

  it("a focus symbol that is not a ticker makes the record degraded, never a quietly shorter one", () => {
    const end = ny(S, "10:30:00");
    const odd = { ...E, focus: { ...E.focus!, items: [...E.focus!.items, { ...E.focus!.items[0]!, symbol: "spy x", rank: 9 }] } };
    expect(evaluateSlot(serverInput(end, end + 61_000, { edition: odd }))).toMatchObject({ status: "degraded", reason: "bad-symbol", rows: [] });
    const ev = evaluateSlot(serverInput(end, end + 61_000));
    const rec = serverRecord({ ...ev, rows: [...ev.rows, { ...ev.rows[0]!, symbol: "bad sym" }] }, { day: S, end }, end + 62_000, E);
    expect(rec).toMatchObject({ status: "degraded", reason: "bad-symbol", rows: [], board: null });
  });

  it("an edition for another day logs wrong-day with no rows", () => {
    const end = ny(S, "10:30:00");
    const ev = evaluateSlot(serverInput(end, end + 61_000, { edition: { ...E, session: "2026-10-09" } }));
    expect(ev).toMatchObject({ status: "wrong-day", rows: [], board: null });
  });

  it("carries the done flag and the journal's facts as booleans", () => {
    const end = ny(S, "10:30:00");
    expect(evaluateSlot(serverInput(end, end + 61_000, { done: true })).day.done).toBe(true);
    const ev = evaluateSlot(serverInput(end, end + 61_000));
    expect(ev.day).toEqual({ journal_current: false, break_today: false, day_limit_used: false, done: false, half_day: false, gap: false, broke_earlier: false, stale: false });
  });
});

// ---- the record -----------------------------------------------------------------------------------------------------
const ENUMS = new Set<string>([
  "server", "page",
  "ok", "wrong-day", "no-focus", "degraded",
  "edition-missing", "edition-error", "store-timeout", "bars-off", "bars-failed", "bars-timeout", "bars-unsettled", "bars-gap", "bars-missing", "bad-symbol", "snapshot-off", "snapshot-failed", "snapshot-timeout", "snapshot-missing",
  "old", "off", "loading", "next", "opening", "live",
  "call", "put",
  ...ROW_STATES,
]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every number is the record's version; every string an enum, a focus symbol, a day, an instant or the engine. */
function walk(v: unknown, path: string, symbols: ReadonlySet<string>, bad: string[]): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!(path === "$.v" && v === 1)) bad.push(`${path}=${v}`);
    return;
  }
  if (typeof v === "string") {
    const ok = ENUMS.has(v) || ISO_RE.test(v) || DAY_RE.test(v) || v === ENGINE_VERSION || (SYMBOL_RE.test(v) && symbols.has(v));
    if (!ok) bad.push(`${path}="${v}"`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, symbols, bad));
  if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, symbols, bad);
  else bad.push(`${path}:${typeof v}`);
}

describe("the record", () => {
  it("holds no price, level, amount or free text: only the version, enums, booleans, focus symbols and instants", () => {
    const symbols = new Set(SYMS);
    let checked = 0;
    for (const end of expectedSlots(S).filter((_, i) => i % 5 === 0)) {
      const rec = serverRecord(evaluateSlot(serverInput(end, end + 61_000)), { day: S, end }, end + 62_345, E);
      const bad: string[] = [];
      walk(JSON.parse(JSON.stringify(rec)), "$", symbols, bad);
      expect(bad).toEqual([]);
      checked += rec.rows.length;
    }
    expect(checked).toBeGreaterThan(100);
    // and the walker does catch a price or a sentence
    const bad: string[] = [];
    walk({ v: 1, rows: [{ symbol: "SPY", price: 779.4 }], note: "Retest holding 779.40" }, "$", symbols, bad);
    expect(bad).toHaveLength(2);
  });

  it("names the edition by its session and build time only, and every record carries the engine", () => {
    const end = ny(S, "10:30:00");
    const rec = serverRecord(evaluateSlot(serverInput(end, end + 61_000)), { day: S, end }, end + 61_500, E);
    expect(rec).toMatchObject({ v: 1, engine: ENGINE_VERSION, source: "server", status: "ok", slot_end: "2026-10-12T14:30:00.000Z", evaluated_at: "2026-10-12T14:31:01.500Z", session: S, edition_session: S, edition_as_of: "2026-10-09T21:00:00.000Z", board: "live" });
    expect(Object.keys(rec).sort()).toEqual(["board", "day", "degraded_names", "edition_as_of", "edition_session", "engine", "evaluated_at", "reason", "rows", "session", "slot_end", "snapshot_ok", "source", "status", "v"]);
    expect(rec.rows.every((r) => r.bar_end === "2026-10-12T14:30:00.000Z")).toBe(true);
    expect(JSON.stringify(rec)).not.toContain("run_id");
  });
});

// ---- the engine's label ---------------------------------------------------------------------------------------------
describe("ENGINE_VERSION", () => {
  it("is generated from the engine's code, and the checked-in file is not stale (pnpm gen:engine)", () => {
    expect(ENGINE_VERSION).toMatch(/^e-[0-9a-f]{12}$/);
    const script = fileURLToPath(new URL("../scripts/gen-engine.mjs", import.meta.url));
    // exits 1 (and throws here) when src/lib/engine-version.gen.ts does not match the code
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("covers the whole import closure of desk-eval.ts, and ignores comments and spacing only", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const gen = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[]; tokens(t: string): string };
    expect(gen.tokens("const a = 1; // why\n/* note */ export  {a};")).toBe(gen.tokens("const a=1;export {a};"));
    expect(gen.tokens('const a = "x  y";')).not.toBe(gen.tokens('const a = "x y";'));
    expect(gen.tokens("const a = 1;")).not.toBe(gen.tokens("const a = 2;"));
    const files = gen.engineFiles().map((f) => f.split("/src/lib/")[1]);
    for (const f of ["desk-eval.ts", "trade-state.ts", "trade-now.ts", "entry-checks.ts", "focus-plan.ts", "trade-rules.ts", "options.ts", "journal.ts", "market-calendar.ts", "market-calendar.json"]) expect(files).toContain(f);
    expect(files).not.toContain("engine-version.gen.ts");
  });
});
