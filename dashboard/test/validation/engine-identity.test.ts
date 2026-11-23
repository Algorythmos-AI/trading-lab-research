// DEC-0051 section 8's engine identity check for DEC-0072 (DEC-0044's engine label e-593cd517f8d5, DEC-0053's → LABEL
// below): a row whose symbol is not one of the desk's names (market-calendar.json `options_names`) reads paused, always
// and first. It changes trade-state.ts, and desk-eval.ts's `stale` day flag only (an off-desk pause is not a stale
// feed); every fixture names desk symbols only, so neither engine ever meets the new branch here.
//
// The old engine is the base commit's trade-state.ts (integration 5cf8997), rebuilt here from today's file by putting
// the old text back in place of each changed hunk (engine-identity.base.json, written from git when this check was set
// up), and proved byte-identical to the base file by its SHA-256. It is written to a temporary module, and every export
// of "@/lib/trade-state" is routed to the old or the new module by one switch, so the board (trade-now.ts) and the
// server's evaluation (desk-eval.ts) run whole on either engine.
//
// What is compared, as section 8 judges it: a row differs when a side's state, its `brokeAt` or a card number (level,
// entry, stop, target 1, target 2) differs. DEC-0072 changes no state of a desk name, so the answer pinned here is
// zero, and the rows are byte-identical as well:
// - every case of guards-off-cases.ts (the fixture editions, the scripted morning, a session's clock and a half day's,
//   each quote set): the board's rows and the server's evaluation;
// - every session of retest.vectors.json (the clone's own answers, scripts/gen_retest_vectors.py), read at each bar's
//   close.
// Then the new branch itself: the same cases with a desk name renamed to one the desk does not hold.
//
// The check DEC-0053 set up (base 6bee358) belonged to its release; this one replaces it, against its own base.
// It runs only while ENGINE_VERSION is its label (LABEL): a later engine change skips it, and needs its own identity
// check (DEC-0051 section 8), against its own base, in place of this one.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { evaluateSlot, type Evaluation } from "@/lib/desk-eval";
import { ENGINE_VERSION } from "@/lib/engine-version.gen";
import type { SidePlan } from "@/lib/focus-plan";
import type { LiveQuote } from "@/lib/options";
import { type BoardRow, boardRows, entryPrompt, noticeKey, rowView } from "@/lib/trade-now";
import { atr2m, type Bar2, type Bars2m, BAR_MINUTES, CLOSE_GRACE_MS, type SideState, sideState } from "@/lib/trade-state";
import { type BoardCase, boardCases, type EvalCase, evalCases } from "../guards-off-cases";
import { serialise } from "../guards-off-run";
import vectors from "../fixtures/retest.vectors.json";
import calendar from "@/lib/market-calendar.json";
import base from "./engine-identity.base.json";

/** The engine label this check was run for: the label after DEC-0072. */
const LABEL = "e-8591f874008c";

const H = vi.hoisted(() => ({
  engine: "new" as "old" | "new",
  baseSha: "",
  dir: "",
  constantsDiffer: [] as string[],
  onlyNew: [] as string[],
  missingHunks: 0,
}));

vi.mock("@/lib/trade-state", async (importOriginal) => {
  const { createHash: sha } = await import("node:crypto");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const url = await import("node:url");
  const nu = await importOriginal<Record<string, unknown>>();
  const file = url.fileURLToPath(new URL("../../src/lib/trade-state.ts", import.meta.url));
  const hunks = (JSON.parse(fs.readFileSync(url.fileURLToPath(new URL("./engine-identity.base.json", import.meta.url)), "utf8")) as { hunks: { new: string; old: string }[] }).hunks;
  let old = fs.readFileSync(file, "utf8");
  for (const h of hunks) {
    if (old.split(h.new).length !== 2) H.missingHunks++;
    else old = old.replace(h.new, () => h.old);
  }
  H.baseSha = sha("sha256").update(old).digest("hex");
  H.dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-identity-"));
  const out = path.join(H.dir, "trade-state.base.ts");
  fs.writeFileSync(out, old.replace(/from "\.\/([^"]+)"/g, 'from "@/lib/$1"'));
  const b = (await import(/* @vite-ignore */ url.pathToFileURL(out).href)) as Record<string, unknown>;
  const routed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(nu)) {
    if (typeof v === "function") {
      if (typeof b[k] !== "function") H.onlyNew.push(k);
      const pick = typeof b[k] === "function" ? b[k] : v;
      routed[k] = (...args: unknown[]) => ((H.engine === "old" ? pick : v) as (...a: unknown[]) => unknown)(...args);
    } else {
      if (JSON.stringify(b[k]) !== JSON.stringify(v)) H.constantsDiffer.push(k);
      routed[k] = v;
    }
  }
  return routed;
});

vi.setConfig({ testTimeout: 300_000 });
afterAll(() => {
  if (H.dir) rmSync(H.dir, { recursive: true, force: true });
});
// A string compare: the generated label is a literal type, and a later engine (another literal) must skip this check.
const otherEngine = (ENGINE_VERSION as string) !== LABEL;

function on<T>(engine: "old" | "new", f: () => T): T {
  H.engine = engine;
  try {
    return f();
  } finally {
    H.engine = "new";
  }
}

/** What a row is judged on: each side's state and `brokeAt`, and the card numbers. */
const sideKey = (s: SideState | undefined) => (s ? { state: s.state, brokeAt: s.brokeAt } : null);
const boardKey = (r: BoardRow) => ({ symbol: r.symbol, state: r.state?.state ?? null, call: sideKey(r.state?.call), put: sideKey(r.state?.put), plan: r.state?.plan ?? null });
const evalKey = (ev: Evaluation) => ev.rows.map((r) => serialise(r));

// As guards-off.test.ts reads them: through JSON, so every run sees the same plain data.
const cases = JSON.parse(JSON.stringify({ board: boardCases(), eval: evalCases() })) as { board: BoardCase[]; eval: EvalCase[] };

describe.skipIf(otherEngine)("the old engine is the base commit's", () => {
  it("the rebuilt trade-state.ts is byte-identical to the file at 5cf8997; no constant moved, and no export was added", () => {
    expect(base.base).toBe("5cf8997");
    expect(H.missingHunks).toBe(0);
    expect(H.baseSha).toBe(base.base_sha256);
    const src = readFileSync(fileURLToPath(new URL("../../src/lib/trade-state.ts", import.meta.url)), "utf8");
    let old = src;
    for (const h of base.hunks) old = old.replace(h.new, () => h.old);
    expect(createHash("sha256").update(old).digest("hex")).toBe(base.base_sha256);
    expect(H.constantsDiffer.sort()).toEqual([]);
    expect(H.onlyNew.sort()).toEqual([]);
  });
});

describe.skipIf(otherEngine)("every fixture: old engine against new (DEC-0051 section 8)", () => {
  it("the board's rows over every guards-off case: no row differs, not even in its words", () => {
    let rows = 0;
    const differ: string[] = [];
    const anyByte: string[] = [];
    for (const c of cases.board) {
      const a = on("old", () => boardRows(c.input, c.live));
      const b = on("new", () => boardRows(c.input, c.live));
      expect(b.length).toBe(a.length);
      rows += a.length;
      a.forEach((r, i) => {
        if (serialise(boardKey(r)) !== serialise(boardKey(b[i]!))) differ.push(`${c.id}/${r.symbol}`);
      });
      if (serialise(a) !== serialise(b)) anyByte.push(c.id);
    }
    expect(cases.board.length).toBe(735);
    expect(rows).toBe(2205);
    expect(differ).toEqual([]);
    expect(anyByte).toEqual([]);
  });

  it("the server's evaluation over every guards-off slot: no row differs", () => {
    const differ: string[] = [];
    let rows = 0;
    for (const c of cases.eval) {
      const a = on("old", () => evaluateSlot(c.input));
      const b = on("new", () => evaluateSlot(c.input));
      rows += a.rows.length;
      if (serialise(evalKey(a)) !== serialise(evalKey(b))) differ.push(c.id);
    }
    expect(cases.eval.length).toBe(84);
    expect(rows).toBe(420);
    expect(differ).toEqual([]);
  });
});

// ---- the clone's own sessions -------------------------------------------------------------------------------------
interface Vec {
  name: string;
  side: "call" | "put";
  level: number;
  bars: [number, number, number, number][];
  expect: { signals: { bar: number }[]; confirm: number | null };
}
const V = vectors as unknown as { session: string; cases: Vec[] };
const OPEN = Date.parse(`${V.session}T09:30:00-04:00`);
const BAR_MS = BAR_MINUTES * 60_000;

/** One side's state at bar i's close, as retest-vectors.test.ts reads it; the plan's own ATR is 4. */
function stateAt(c: Vec, i: number): SideState {
  const closed: Bar2[] = c.bars.slice(0, i + 1).map(([o, h, l, cl], k) => ({ start: OPEN + k * BAR_MS, end: OPEN + (k + 1) * BAR_MS, o, h, l, c: cl }));
  const bars: Bars2m = { closed, partial: null, since: OPEN, complete: true, missing: [], gaps: 0 };
  const now = new Date(closed[i]!.end + CLOSE_GRACE_MS);
  const all = closed.flatMap((b) => [b.h, b.l]);
  const quote: LiveQuote = { price: closed[i]!.c, at: new Date(now.getTime() - 1_000).toISOString(), open: closed[0]!.o, high: Math.max(...all), low: Math.min(...all), day: V.session, prev_close: null, vwap: null };
  const s = c.side === "call" ? 1 : -1;
  const plan: SidePlan = { side: c.side, level: c.level, levelName: "L", entry: c.level + s * 0.02, stop: c.level - s * 0.2, target1: c.level + s * 50, target2: null };
  return sideState(plan, 4, bars, quote, now, atr2m(closed));
}

describe.skipIf(otherEngine)("the clone's retest sessions: old engine against new", () => {
  it("no bar state differs; the enter zone is still the clone's first signal's two slots unless DEC-0053's lock holds", () => {
    let bars = 0;
    let differ = 0;
    const sessionsDiffer: string[] = [];
    for (const c of V.cases) {
      let any = false;
      c.bars.forEach((_, i) => {
        bars++;
        const a = on("old", () => stateAt(c, i));
        const b = on("new", () => stateAt(c, i));
        if (serialise(sideKey(a)) !== serialise(sideKey(b))) {
          differ++;
          any = true;
        }
      });
      if (any) sessionsDiffer.push(c.name);
      const enter = c.bars.flatMap((_, i) => (on("new", () => stateAt(c, i)).state === "enter_zone" ? [i] : []));
      const k = c.expect.confirm;
      // DEC-0053: the clone's signal after a failed break in the same window is not the board's enter zone
      const locked = c.name === "the first break fails; the second one's retest confirms";
      expect(enter, c.name).toEqual(k === null || locked ? [] : [k, k + 1].filter((i) => i < c.bars.length));
      if (locked) expect(on("new", () => stateAt(c, k!)).state).toBe("plan_off");
    }
    expect(sessionsDiffer).toEqual(SESSIONS_DIFFER);
    expect({ sessions: V.cases.length, bars, differ, sessionsDiffer: sessionsDiffer.length }).toEqual(COUNTS);
  });
});

/** The pinned answer on the vectors: the counts this check printed when it was set up (2026-11-23). */
const COUNTS = { sessions: 15, bars: 312, differ: 0, sessionsDiffer: 0 };
const SESSIONS_DIFFER: string[] = [];

// ---- the new branch: a name the desk does not hold -----------------------------------------------------------------
/** A case with every occurrence of the symbol `from` (as a whole JSON string) renamed to `to`. */
const renamed = (c: BoardCase, from: string, to: string): BoardCase =>
  JSON.parse(JSON.stringify(c).replaceAll(JSON.stringify(from), JSON.stringify(to))) as BoardCase;

describe.skipIf(otherEngine)("a name the desk does not hold (DEC-0072 section 1)", () => {
  // Every live case with a row in the entry zone, and that row's symbol.
  const entering = cases.board.flatMap((c) =>
    c.live ? boardRows(c.input, c.live).filter((r) => r.state?.state === "enter_zone").map((r) => ({ c, symbol: r.symbol })) : [],
  );

  it("the fixtures hold rows in the entry zone, every one a desk name", () => {
    expect(entering.length).toBeGreaterThan(0);
    const desk = new Set(calendar.options_names);
    expect(entering.filter((e) => !desk.has(e.symbol))).toEqual([]);
  });

  it("the same row under a symbol off the desk reads paused, with no grid, no notice and no entry prompt, on both sides", () => {
    for (const { c, symbol } of entering) {
      const row = boardRows(renamed(c, symbol, "XYZQ").input, c.live).find((r) => r.symbol === "XYZQ")!;
      const s = row.state!;
      expect(s.state, c.id).toBe("paused");
      expect(s.offDesk).toBe(true);
      expect(s.line).toBe("Not one of the desk's names: its earnings and expiry facts are not on file");
      expect(s.side).toBeUndefined();
      expect(s.plan).toBeNull();
      const v = rowView(s);
      expect(v.grid).toBeNull();
      expect(JSON.stringify(v.badge)).not.toMatch(/ENTER|CALL|PUT/);
      expect(noticeKey(s)).toBeNull();
      expect(entryPrompt(s)).toBe(false);
    }
  });

  it("a lower-case desk symbol is still a desk name, and an alias is not (GOOG is not GOOGL)", () => {
    const { c, symbol } = entering[0]!;
    expect(boardRows(renamed(c, symbol, symbol.toLowerCase()).input, c.live)[0]!.state!.offDesk).toBeUndefined();
    const goog = renamed(c, symbol, "GOOG");
    expect(boardRows(goog.input, goog.live).find((r) => r.symbol === "GOOG")!.state!.state).toBe("paused");
  });

  it("the server's evaluation reads such a name paused, and does not count it as a stale feed", () => {
    // a slot whose names all have rows and whose day reads no stale feed: rename its first focus name off the desk
    const ev = cases.eval.find((e) => {
      const out = evaluateSlot(e.input);
      return out.rows.length > 0 && !out.day.stale && (e.input.edition.focus?.items?.length ?? 0) > 0;
    });
    expect(ev).toBeDefined();
    const first = ev!.input.edition.focus!.items![0]!.symbol;
    const off = JSON.parse(JSON.stringify(ev!.input).replaceAll(JSON.stringify(first), JSON.stringify("XYZQ"))) as EvalCase["input"];
    const out = evaluateSlot(off);
    const rows = out.rows.filter((r) => r.symbol === "XYZQ");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.state === "paused")).toBe(true);
    expect(out.day.stale).toBe(false);
  });
});
