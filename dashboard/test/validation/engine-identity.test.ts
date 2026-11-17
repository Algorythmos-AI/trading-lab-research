// DEC-0051 section 8's engine identity check for DEC-0053 (DEC-0044's engine label e-d6053c7fdd0a, DEC-0052's → LABEL
// below): a failed break locks its side for the rest of the entry window, and a confirmed retest on bars that do not
// cover the session from its open is get ready (`lockUnseen`). It changes trade-state.ts, and trade-now.ts's rowView
// only (the drawn headline of a row with a live alternative also says the lock); no row's key reads that headline, and
// trade-now.ts runs as today's on both engines here.
//
// The old engine is the base commit's trade-state.ts (integration 6bee358), rebuilt here from today's file by putting
// the old text back in place of each changed hunk (engine-identity.base.json, written from git when this check was set
// up), and proved byte-identical to the base file by its SHA-256. It is written to a temporary module, and every export
// of "@/lib/trade-state" is routed to the old or the new module by one switch, so the board (trade-now.ts) and the
// server's evaluation (desk-eval.ts) run whole on either engine. An export the old file does not have (lockUntil,
// locksOf) runs the new one on both: on the old engine's states (no `failedAt`) locksOf finds no lock.
//
// What is compared, as section 8 judges it: a row differs when a side's state, its `brokeAt` or a card number (level,
// entry, stop, target 1, target 2) differs. DEC-0053 is a rule change, so rows may differ, and the check's answer is
// the counts, pinned here:
// - every case of guards-off-cases.ts (the fixture editions, the scripted morning, a session's clock and a half day's,
//   each quote set): the board's rows and the server's evaluation;
// - every session of retest.vectors.json (the clone's own answers, scripts/gen_retest_vectors.py), read at each bar's
//   close: the new engine opens its enter zone at the clone's first signal except where an earlier failed break locks
//   the side (DEC-0053's stated departure from the clone).
//
// The check DEC-0052 set up (base 8cd5ff0d) belonged to its release; this one replaces it, against its own base.
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
import { type BoardRow, boardRows } from "@/lib/trade-now";
import { atr2m, type Bar2, type Bars2m, BAR_MINUTES, CLOSE_GRACE_MS, type SideState, sideState } from "@/lib/trade-state";
import { type BoardCase, boardCases, type EvalCase, evalCases } from "../guards-off-cases";
import { serialise } from "../guards-off-run";
import vectors from "../fixtures/retest.vectors.json";
import base from "./engine-identity.base.json";

/** The engine label this check was run for: the label after DEC-0053. */
const LABEL = "e-593cd517f8d5";

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
  it("the rebuilt trade-state.ts is byte-identical to the file at 6bee358; no constant moved, and the two new exports are DEC-0053's", () => {
    expect(base.base).toBe("6bee358");
    expect(H.missingHunks).toBe(0);
    expect(H.baseSha).toBe(base.base_sha256);
    const src = readFileSync(fileURLToPath(new URL("../../src/lib/trade-state.ts", import.meta.url)), "utf8");
    let old = src;
    for (const h of base.hunks) old = old.replace(h.new, () => h.old);
    expect(createHash("sha256").update(old).digest("hex")).toBe(base.base_sha256);
    expect(H.constantsDiffer.sort()).toEqual([]);
    expect(H.onlyNew.sort()).toEqual(["lockUntil", "locksOf"]);
  });
});

describe.skipIf(otherEngine)("every fixture: old engine against new (DEC-0051 section 8)", () => {
  it("the board's rows over every guards-off case: no row's state, brokeAt or card numbers differ; only a locked side's words do", () => {
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
    // the scripted morning's steps 3 to 5, in every edition and quote set: SPY's failed break (plan off at step 3, the
    // same state and brokeAt) is now worded as its lock ("Failed at 10:26: no call until 13:00"), on its row
    expect(anyByte.length).toBe(63);
    expect([...new Set(anyByte.map((id) => id.split("/")[1]))].sort()).toEqual(["step3", "step4", "step5"]);
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
  it("rows differ only after a failed break: the new engine's enter zone is the clone's first signal's two slots unless a lock holds, on these counts", () => {
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

/** The pinned answer on the vectors: the counts this check printed when it was set up (2026-11-17). */
const COUNTS = { sessions: 15, bars: 312, differ: 6, sessionsDiffer: 2 };
/** The two sessions with a failed break: in the first the side reads its lock after the failure, in the second the lock
 * also removes the clone's signal on the re-break. Every other session's bar states are the same on both engines. */
const SESSIONS_DIFFER = ["a close back through the level before the confirming close", "the first break fails; the second one's retest confirms"];
