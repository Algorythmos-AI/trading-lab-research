import { describe, expect, it } from "vitest";
import { ENTRY_ATR, focusPlan, STOP_ATR } from "@/lib/focus-plan";
import { MIN_ROOM_MULTIPLE } from "@/lib/trade-rules";
import vectors from "./fixtures/focus-plan.vectors.json";

// focus-plan.ts says it does "the same arithmetic" as the after-close routine's focus card (focus.py side_plan).
// These vectors are that script's own output on synthetic inputs, generated in the private trading-options-funnel
// repository from a sha256-pinned copy of the script (scripts/gen_plan_vectors.py). Read only: this test changes no
// file of the engine's hash closure.
//
// Known difference, found by this test (2026-11-17): on an exact half-cent the two round differently. Python's round()
// rounds the binary value (104.285 is stored as 104.28499... and becomes 104.28); focus-plan.ts rounds v * 100 with
// Math.round (10428.5 becomes 10429, so 104.29). The stop then differs by 1 cent and the first target by 2 cents.
// Which one is right is a DEC-0035 question for the owner; until it is decided, the differing vectors are pinned
// here so any other drift fails.

interface Next {
  price: number;
  name: string;
}
interface Vector {
  input: { kind: "call" | "put"; level: number; atr: number | null; next: Next | null };
  expect: { entry: number | null; stop: number | null; t1: number | null; t2: Next | null } | null;
}

const doc = vectors as unknown as {
  constants: { ENTRY_ATR: number; STOP_ATR: number; ROOM: number };
  vectors: Vector[];
};

/** The vectors where only the half-cent rounding differs (see above). */
const HALF_CENT_TIES = [41, 75, 107, 122, 164, 204, 206, 217, 267, 296, 303, 358, 393];

function planOf(v: Vector) {
  const { kind, level, atr, next } = v.input;
  const item = {
    symbol: "TEST",
    atr,
    breakout_above: kind === "call" ? level : null,
    hold_above: kind === "put" ? level : null,
    target_up: kind === "call" ? next : null,
    target_down: kind === "put" ? next : null,
  } as unknown as Parameters<typeof focusPlan>[0];
  const p = focusPlan(item);
  return kind === "call" ? p.call : p.put;
}

const cents = (a: number | null, b: number | null) => (a === null || b === null ? (a === b ? 0 : Infinity) : Math.round(Math.abs(a - b) * 100));

describe("focus-plan.ts against the card's own arithmetic", () => {
  it("uses the card's constants", () => {
    expect(ENTRY_ATR).toBe(doc.constants.ENTRY_ATR);
    expect(STOP_ATR).toBe(doc.constants.STOP_ATR);
    expect(MIN_ROOM_MULTIPLE).toBe(doc.constants.ROOM);
  });

  it("gives the card's entry, stop and targets, except the pinned half-cent ties", () => {
    expect(doc.vectors.length).toBeGreaterThan(400);
    const differing: number[] = [];
    doc.vectors.forEach((v, i) => {
      const p = planOf(v);
      if (v.expect === null || p === null) {
        expect(p, `#${i}`).toBe(v.expect);
        return;
      }
      const same =
        p.entry === v.expect.entry &&
        p.stop === v.expect.stop &&
        p.target1 === v.expect.t1 &&
        JSON.stringify(p.target2) === JSON.stringify(v.expect.t2);
      if (same) return;
      differing.push(i);
      // The tie difference only: the same entry and second target, the stop 1 cent off, the first target 2 cents.
      expect(p.entry, `#${i} entry`).toBe(v.expect.entry);
      expect(cents(p.stop, v.expect.stop), `#${i} stop`).toBe(1);
      expect(cents(p.target1, v.expect.t1), `#${i} t1`).toBe(2);
      expect(JSON.stringify(p.target2), `#${i} t2`).toBe(JSON.stringify(v.expect.t2));
    });
    expect(differing).toEqual(HALF_CENT_TIES);
  });
});
