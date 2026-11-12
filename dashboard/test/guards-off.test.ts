// The bad-data guards' one promise while they are switched off: nothing changes. Every case of guards-off-cases.ts
// (each fixture edition, the scripted morning, a session's clock, each fixture quote set and the `quotes-suspect`
// variant's) is run with every way the switches can be off, and the board's rows, the board as drawn and the server's
// evaluation with its record's engine fields must hash exactly as the code before the guards made them
// (guards-off.golden.json, written by guards-off-run.ts on origin/integration 0396e7e).
import { describe, expect, it } from "vitest";
import { ALL_OFF, parseGuardSwitches } from "@/lib/desk-guards";
import type { EvalInput } from "@/lib/desk-eval";
import { GUARD_REASONS, type GuardReason } from "@/lib/quote-guards";
import type { BoardInput } from "@/lib/trade-now";
import golden from "./fixtures/guards-off.golden.json";
import { type BoardCase, boardCases, type EvalCase, evalCases } from "./guards-off-cases";
import { hash, runBoard, runEval, serialise } from "./guards-off-run";

// As the golden run read them: through JSON, so both runs see the same plain data.
const cases = JSON.parse(JSON.stringify({ board: boardCases(), eval: evalCases() })) as { board: BoardCase[]; eval: EvalCase[] };
const G = golden as { cases: string; board: Record<string, { rows: string; html: string }>; eval: Record<string, string> };

/** Every way a run or a page holds the switches off. */
const OFF: [string, readonly GuardReason[] | undefined][] = [
  ["no switches given", undefined],
  ["an empty list", []],
  ["no document", parseGuardSwitches(null).on],
  ["a malformed document", parseGuardSwitches('{"v":1,"on":["bar-high-below-low","nope"]}').on],
  ["a document with none on", parseGuardSwitches('{"v":1,"on":[]}').on],
  ["a failed read", ALL_OFF("error").on],
];

const boardWith = (input: BoardInput, on: readonly GuardReason[] | undefined): BoardInput => (on === undefined ? input : { ...input, guards: { on } });
const evalWith = (input: EvalInput, on: readonly GuardReason[] | undefined): EvalInput => (on === undefined ? input : { ...input, guardsOn: on });

describe("with every guard switched off", () => {
  it("runs the very cases the pinned hashes were written from", () => {
    expect(cases.board.length).toBeGreaterThan(600);
    expect(cases.eval.length).toBeGreaterThan(80);
    expect(hash(serialise(cases))).toBe(G.cases);
    expect(Object.keys(G.board).sort()).toEqual(cases.board.map((c) => c.id).sort());
    expect(Object.keys(G.eval).sort()).toEqual(cases.eval.map((c) => c.id).sort());
  });

  for (const [what, on] of OFF) {
    it(`${what}: the board's rows and the board as drawn are byte-identical to before the guards, for every case`, () => {
      const diff = cases.board.filter((c) => {
        const got = runBoard(boardWith(c.input, on), c.live);
        return got.rows !== G.board[c.id]!.rows || got.html !== G.board[c.id]!.html;
      });
      expect(diff.map((c) => c.id)).toEqual([]);
    });

    it(`${what}: the server's evaluation and its record's engine fields are byte-identical, for every slot`, () => {
      const diff = cases.eval.filter((c) => runEval(evalWith(c.input, on), c.evaluatedAt) !== G.eval[c.id]);
      expect(diff.map((c) => c.id)).toEqual([]);
    });
  }
});

describe("the proof is not empty", () => {
  it("with every guard on, the suspect quotes do change the board in the session, and the healthy ones never do", () => {
    const all = [...GUARD_REASONS];
    const changed = cases.board.filter((c) => runBoard(boardWith(c.input, all), c.live).rows !== G.board[c.id]!.rows).map((c) => c.id);
    // only suspect quote sets ever change, and never one that is healthy (plain, or with healthy snapshot fields)
    expect(changed.every((id) => id.includes("/suspect-"))).toBe(true);
    // every suspect set changes some live in-session case
    for (const g of [...GUARD_REASONS, "turn"]) expect(changed.some((id) => id.includes(`/suspect-${g}`)), g).toBe(true);
    const evChanged = cases.eval.filter((c) => runEval(evalWith(c.input, all), c.evaluatedAt) !== G.eval[c.id]).map((c) => c.id);
    expect(evChanged.length).toBeGreaterThan(0);
    expect(evChanged.every((id) => id.includes("/suspect-"))).toBe(true);
  });
});
