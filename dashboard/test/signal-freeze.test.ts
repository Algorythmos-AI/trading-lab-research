// The freeze cannot be passed around: with signal-freeze.ts's real constants (null until DEC-0051 Amendment 1), every
// word is NO TRADE (data), whatever a caller passes. And the signal's code hash is generated and checked like the
// engine's label (scripts/gen-signal.mjs).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FROZEN_CODE_HASH, FROZEN_PARAMS_HASH } from "@/lib/signal-freeze";
import { freezeReasons, type Gates, signalWord } from "@/lib/signal";
import { paramsHash, SIGNAL_PARAMS } from "@/lib/signal-params";
import { SIGNAL_CODE_HASH } from "@/lib/signal-version.gen";

const pass = <K extends keyof Gates>(id: K) => ({ id, pass: true, notYet: false, value: null as never, why: id }) as unknown as Gates[K];
const clean: Gates = { market_direction: pass("market_direction"), volume: pass("volume"), stock_bid_ask: pass("stock_bid_ask"), shock: pass("shock"), contract: pass("contract") };

describe("the freeze", () => {
  it("nothing is frozen yet", () => {
    expect(FROZEN_PARAMS_HASH).toBeNull();
    expect(FROZEN_CODE_HASH).toBeNull();
    expect(freezeReasons()).toEqual(["the signal's numbers are not the frozen ones", "the signal's code is not the frozen one"]);
  });

  it("a clean enter zone with every gate passing is NO TRADE (data) while nothing is frozen", () => {
    const w = signalWord({ side: "call", rowState: "enter_zone", sideState: { brokeEarlier: false, gap: false }, gates: clean, unusable: [] });
    expect(w).toMatchObject({ word: "NO TRADE", scoring: "not_usable" });
    expect(w.against.slice(0, 2)).toEqual(["data: the signal's numbers are not the frozen ones", "data: the signal's code is not the frozen one"]);
  });

  it("the reviewer's bypass, loose numbers and matching made-up hashes passed in, is still NO TRADE", () => {
    const loose = { ...SIGNAL_PARAMS, volume_min_ratio: 0, stock_spread_max_bps: 1_000 };
    const bypass = {
      side: "call",
      rowState: "enter_zone",
      sideState: { brokeEarlier: false, gap: false },
      gates: clean,
      unusable: [],
      params: loose,
      paramsHash: paramsHash(loose),
      frozenParamsHash: paramsHash(loose),
      codeHash: "s-fake",
      frozenCodeHash: "s-fake",
    } as unknown as Parameters<typeof signalWord>[0];
    expect(signalWord(bypass).word).toBe("NO TRADE");
  });
});

describe("SIGNAL_CODE_HASH", () => {
  it("is generated from the signal's code, and the checked-in file is not stale (node scripts/gen-signal.mjs)", () => {
    expect(SIGNAL_CODE_HASH).toMatch(/^s-[0-9a-f]{64}$/);
    const script = fileURLToPath(new URL("../scripts/gen-signal.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("covers the whole import closure of signal.ts, never the freeze or the generated files", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const gen = (await import("../scripts/gen-signal.mjs")) as { signalFiles(): string[]; signalHash(): string };
    const files = gen.signalFiles().map((f) => f.split("/src/lib/")[1]);
    for (const f of ["signal.ts", "flow.ts", "context.ts", "contract-pick.ts", "signal-params.ts", "option-value.ts", "board-events.ts", "ticket.ts", "desk-eval.ts", "trade-state.ts"]) expect(files).toContain(f);
    for (const f of ["signal-freeze.ts", "signal-version.gen.ts", "engine-version.gen.ts"]) expect(files).not.toContain(f);
    expect(gen.signalHash()).toBe(SIGNAL_CODE_HASH);
  });
});
