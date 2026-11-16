// DEC-0051 section 8's engine identity check for the pre-dry defect fixes of 2026-11-16 (DEC-0044's engine label
// e-28344e769752 → e-9772bf0fb6e5). The only engine file they change is trade-state.ts (the retest touch, compared
// exactly); contract-pick.ts and ticket.ts are outside the engine's closure (scripts/gen-engine.mjs).
//
// The old engine is the base commit's trade-state.ts, rebuilt here from today's file by putting the two old lines back
// in place of the fix, and proved byte-identical to it by its SHA-256 (BASE_SHA256, the file at
// origin/test/dry-run-validation fe759dea). It is written to a temporary module, and every export of
// "@/lib/trade-state" is routed to the old or the new module by one switch, so the board (trade-now.ts) and the server's
// evaluation (desk-eval.ts) run whole on either engine.
//
// The fixtures: every case of guards-off-cases.ts (the fixture editions focus, partial and v2 of options.v1.json, the
// scripted morning, a session's clock and a half day's, each fixture quote set and the `quotes-suspect` variant's): the
// board's rows and the server's evaluation, as desk-eval.test.ts and desk-run.test.ts draw them from the same edition.
// Then a seeded sweep of retest scenes around the band, and the constructed boundary cases. A row differs when a
// side's state, its `brokeAt` or a card number (level, entry, stop, target 1, target 2) differs. The only rows allowed
// to differ are boundary touches: a retest dip exactly 0.1 ATR from the line.
//
// This check belongs to this one release: the next change to trade-state.ts makes the rebuild fail its hash, and that
// change needs its own identity check (DEC-0051 section 8) in place of this one.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { evaluateSlot, type Evaluation } from "@/lib/desk-eval";
import type { SidePlan } from "@/lib/focus-plan";
import type { LiveQuote } from "@/lib/options";
import { type BoardRow, boardRows } from "@/lib/trade-now";
import { type Bar2, type Bars2m, CLOSE_GRACE_MS, type SideState, sideState } from "@/lib/trade-state";
import { type BoardCase, boardCases, type EvalCase, evalCases } from "../guards-off-cases";
import { serialise } from "../guards-off-run";
import { mulberry32 } from "./harness-scene";

const H = vi.hoisted(() => ({ engine: "new" as "old" | "new", baseSha: "", constantsDiffer: [] as string[] }));

/** The fix as it stands in trade-state.ts, and the two lines it replaced. */
const NEW_BLOCK = /\n {2}\/\/ The touch compared exactly[^\n]*\n(?: {2}\/\/[^\n]*\n)*\s*const units = [^\n]*\n\s*const perAtr = [^\n]*\n\s*const touch = [^\n]*\n/;
const OLD_LINES = "\n  const near = a !== null ? RETEST_ATR * a : null;\n  const touch = near === null ? -1 : after.findIndex((b) => (s > 0 ? b.l - L : L - b.h) <= near);\n";
/** SHA-256 of dashboard/src/lib/trade-state.ts at origin/test/dry-run-validation (fe759dea), the engine before the fix. */
const BASE_SHA256 = "f67a46ee9d359a56010696d2b32c0d6aba87d732290783f606fa2295db3cc94f";

vi.mock("@/lib/trade-state", async (importOriginal) => {
  const { createHash: sha } = await import("node:crypto");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const url = await import("node:url");
  const nu = await importOriginal<Record<string, unknown>>();
  const file = url.fileURLToPath(new URL("../../src/lib/trade-state.ts", import.meta.url));
  const src = fs.readFileSync(file, "utf8");
  const re = /\n {2}\/\/ The touch compared exactly[^\n]*\n(?: {2}\/\/[^\n]*\n)*\s*const units = [^\n]*\n\s*const perAtr = [^\n]*\n\s*const touch = [^\n]*\n/;
  const old = src.replace(re, "\n  const near = a !== null ? RETEST_ATR * a : null;\n  const touch = near === null ? -1 : after.findIndex((b) => (s > 0 ? b.l - L : L - b.h) <= near);\n");
  H.baseSha = sha("sha256").update(old).digest("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-identity-"));
  const out = path.join(dir, "trade-state.base.ts");
  fs.writeFileSync(out, old.replace(/from "\.\/([^"]+)"/g, 'from "@/lib/$1"'));
  const base = (await import(/* @vite-ignore */ url.pathToFileURL(out).href)) as Record<string, unknown>;
  const routed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(nu)) {
    if (typeof v === "function") routed[k] = (...args: unknown[]) => ((H.engine === "old" ? base[k] : v) as (...a: unknown[]) => unknown)(...args);
    else {
      if (JSON.stringify(base[k]) !== JSON.stringify(v)) H.constantsDiffer.push(k);
      routed[k] = v;
    }
  }
  return routed;
});

vi.setConfig({ testTimeout: 300_000 });

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

describe("the old engine is the base commit's", () => {
  it("the rebuilt trade-state.ts is byte-identical to the file before the fix, and no constant moved", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/lib/trade-state.ts", import.meta.url)), "utf8");
    expect(NEW_BLOCK.test(src)).toBe(true);
    expect(createHash("sha256").update(src.replace(NEW_BLOCK, OLD_LINES)).digest("hex")).toBe(BASE_SHA256);
    expect(H.baseSha).toBe(BASE_SHA256);
    expect(H.constantsDiffer).toEqual([]);
  });
});

describe("every fixture: old engine against new (DEC-0051 section 8)", () => {
  it("the board's rows: no row's state, brokeAt or card numbers differ (735 cases)", () => {
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
    expect(rows).toBeGreaterThan(0);
    expect(differ).toEqual([]);
    expect(anyByte).toEqual([]);
  });

  it("the server's evaluation: no row differs, nor any other byte of it (84 slots)", () => {
    const differ: string[] = [];
    let rows = 0;
    for (const c of cases.eval) {
      const a = on("old", () => evaluateSlot(c.input));
      const b = on("new", () => evaluateSlot(c.input));
      rows += a.rows.length;
      if (serialise(evalKey(a)) !== serialise(evalKey(b)) || serialise(a) !== serialise(b)) differ.push(c.id);
    }
    expect(cases.eval.length).toBe(84);
    expect(rows).toBeGreaterThan(0);
    expect(differ).toEqual([]);
  });
});

// ---- retest scenes: a break, then one retest bar whose low (call) or high (put) sits near the band ------------------
const D = "2026-10-12"; // a Monday on EDT
const at = (hhmm: string) => Date.parse(`${D}T${hhmm}:00-04:00`);
const bar = (hhmm: string, o: number, h: number, l: number, c: number): Bar2 => ({ start: at(hhmm), end: at(hhmm) + 120_000, o, h, l, c });
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * A break at 10:02 through L (up for a call, down for a put), then a retest bar at 10:04 reaching `extreme`; every
 * other price a fixed share of the ATR from the line (as logic-suspects.test.ts's scene, which is this one at ATR 1).
 */
function retest(kind: "call" | "put", L: number, atr: number, extreme: number) {
  const s = kind === "call" ? 1 : -1;
  const p = (d: number) => r4(L + s * d * atr);
  const closed =
    kind === "call"
      ? [bar("10:00", p(-0.5), p(-0.1), p(-0.6), p(-0.3)), bar("10:02", p(-0.3), p(0.5), p(-0.3), p(0.4)), bar("10:04", p(0.4), p(0.5), extreme, p(0.3))]
      : [bar("10:00", p(-0.5), p(-0.6), p(-0.1), p(-0.3)), bar("10:02", p(-0.3), p(-0.3), p(0.5), p(0.4)), bar("10:04", p(0.4), extreme, p(0.5), p(0.3))];
  const bars: Bars2m = { closed, partial: null, since: at("10:00"), complete: false, missing: [], gaps: 0 };
  const now = new Date(at("10:06") + CLOSE_GRACE_MS);
  const quote = { price: p(0.3), at: new Date(now.getTime() - 1_000).toISOString(), open: p(-0.5), high: Math.max(p(0.5), p(-0.6)), low: Math.min(p(0.5), p(-0.6)), day: D, prev_close: null, vwap: null } as LiveQuote;
  const plan: SidePlan = { side: kind, level: L, levelName: "test", entry: L, stop: p(-1), target1: p(5), target2: null };
  return sideState(plan, atr, bars, quote, now);
}

describe("retest scenes around the band: only exact boundary touches differ", () => {
  it("a seeded sweep (levels and extremes to the cent or ten-thousandth, ATRs to the cent): every difference is a dip of exactly 0.1 ATR", () => {
    const r = mulberry32(20261116);
    let differ = 0;
    let boundary = 0;
    for (let i = 0; i < 40_000; i++) {
      const kind = r() < 0.5 ? "call" : "put";
      const fine = r() < 0.3;
      const grid = fine ? 10_000 : 100;
      const L = Math.round((20 + r() * 900) * grid) / grid;
      const atrCents = 1 + Math.floor(r() * 3_000); // $0.01 to $30.00
      const atr = atrCents / 100;
      // the dip, in ten-thousandths: on the band (exactly atrCents × 10), or a few units either side of it
      const onBand = atrCents * 10;
      const dipUnits = r() < 0.4 ? onBand : onBand + Math.round((r() - 0.5) * (fine ? 40 : 4)) * (fine ? 1 : 100);
      const s = kind === "call" ? 1 : -1;
      const extreme = Math.round(L * 10_000 + s * dipUnits) / 10_000;
      const a = on("old", () => retest(kind, L, atr, extreme));
      const b = on("new", () => retest(kind, L, atr, extreme));
      const isBoundary = dipUnits === onBand;
      if (isBoundary) boundary++;
      if (serialise(sideKey(a)) !== serialise(sideKey(b))) {
        differ++;
        expect(isBoundary, `${kind} L=${L} ATR=${atr} extreme=${extreme}`).toBe(true);
        expect([a.state, b.state]).toEqual(["get_ready", "enter_zone"]);
        expect(b.brokeAt).toBe(a.brokeAt);
      }
      if (!isBoundary) expect(b.state).toBe(a.state);
    }
    expect(boundary).toBeGreaterThan(10_000);
    // float lands either side of the edge: some boundary scenes were already touches, some were not
    expect(differ).toBeGreaterThan(0);
    expect(differ).toBeLessThan(boundary);
  });

  it("ATRs with many decimals (the edition's close × 0.01 fallback): old and new agree on every scene", () => {
    const r = mulberry32(51);
    for (let i = 0; i < 20_000; i++) {
      const kind = r() < 0.5 ? "call" : "put";
      const L = Math.round((20 + r() * 900) * 100) / 100;
      const atr = (20 + r() * 900) * 0.01;
      const dip = Math.round(0.1 * atr * 10_000) + Math.round((r() - 0.5) * 6);
      const extreme = Math.round(L * 10_000 + (kind === "call" ? 1 : -1) * dip) / 10_000;
      const a = on("old", () => retest(kind, L, atr, extreme));
      const b = on("new", () => retest(kind, L, atr, extreme));
      expect(serialise(sideKey(b)), `${kind} L=${L} ATR=${atr} extreme=${extreme}`).toBe(serialise(sideKey(a)));
    }
  });

  it.each([
    ["call", 100.1, 1.0, 100.2],
    ["call", 100, 0.3, 100.03],
    ["put", 100.2, 1.0, 100.1],
    ["put", 100.03, 0.3, 100],
  ] as const)("constructed boundary: %s, L=%s, ATR=%s, retest extreme %s: get_ready on the old engine, enter_zone on the new", (kind, L, atr, extreme) => {
    const a = on("old", () => retest(kind, L, atr, extreme));
    const b = on("new", () => retest(kind, L, atr, extreme));
    expect(a.state).toBe("get_ready");
    expect(b.state).toBe("enter_zone");
    expect(b.brokeAt).toBe(a.brokeAt);
    expect(b.brokeAt).not.toBeNull();
  });

  it("controls: a dip clearly inside the band and one clearly outside read the same on both engines", () => {
    for (const [kind, L, extreme, want] of [
      ["call", 100, 100.05, "enter_zone"],
      ["call", 100, 100.2, "get_ready"],
      ["put", 100, 99.95, "enter_zone"],
      ["put", 100, 99.8, "get_ready"],
    ] as const) {
      expect(on("old", () => retest(kind, L, 1, extreme)).state).toBe(want);
      expect(on("new", () => retest(kind, L, 1, extreme)).state).toBe(want);
    }
  });
});
