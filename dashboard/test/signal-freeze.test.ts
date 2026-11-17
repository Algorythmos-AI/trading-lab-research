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

  // The pin. DEC-0051's Amendment 1 states one signal-code hash beside the `dry` sessions it reads (section 2), so those
  // sessions must have run that one code: any change that moves the hash fails here, as a visible diff. That is any
  // change to a file of the import closure, comments included (the generator's scanner can count them), and
  // market-calendar.json, which is in the closure (adding later sessions moves the hash too). Changing this literal
  // needs, in the same pull request, a dated line in research/experiments/EXP-0034-desk-signal-gates/README.md
  // ("Dates and commits") saying what changed and why: a defect fix to the signal code (DEC-0051 section 8's
  // defect-fix route), or the DEC-0051 amendment that allows it.
  // Moved 2026-11-16 from s-0ec9e5efd1e65790ca5f83e5ba845269ad2c3666b500c631d89f2cb7327f2345 by the pre-dry defect
  // fixes (trade-state.ts retest touch, contract-pick.ts absurd ask): EXP-0034 README.md, "Dates and commits", the line
  // "Defect fixes to the outcome or signal code before the read" dated 2026-11-16.
  // Moved 2026-11-17 from s-44709694b261a3bceebdafe21cc15f9f58f49f2359b73122d493d6e54aca1a41 by DEC-0052 (a rule change,
  // not a defect fix: the board's break and retest completes as the clone's retest does, trade-state.ts and trade-now.ts,
  // and the card's "Break and hold" wording, focus-plan.ts, DEC-0052 section 6). DEC-0052 section 4: EXP-0034's
  // Amendment 1 reads only dry sessions recorded under this hash. EXP-0034 README.md, "Dates and commits", 2026-11-17.
  // Moved 2026-11-17 from s-065118e5ffe27eee3b520c817f045160327c9b6d9c14b4fa1e782cc289cc41e3 by DEC-0053 (a rule change,
  // not a defect fix: a failed break locks its side for the rest of the entry window, trade-state.ts, and the drawn
  // headline says the lock, trade-now.ts). DEC-0053 section 4:
  // EXP-0034 reads only dry sessions recorded under this hash. EXP-0034 README.md, "Dates and commits", 2026-11-17.
  it("is pinned: a change to the signal's code is a visible diff here", () => {
    expect(SIGNAL_CODE_HASH).toBe("s-ed25522ded279c218690d89ce110d996e607624d1ea270abf9377dc062ce9b44");
  });

  // Once DEC-0051 Amendment 1 sets FROZEN_CODE_HASH (signal-freeze.ts), this becomes a real assertion, and the
  // "nothing is frozen yet" test above and signal-params.test.ts's "are the candidates, not frozen" change with it.
  it.todo("after Amendment 1: SIGNAL_CODE_HASH === FROZEN_CODE_HASH");
});
