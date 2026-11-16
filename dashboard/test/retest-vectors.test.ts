// DEC-0052: the board's break and retest completes as the clone's does. Each case of retest.vectors.json
// (scripts/gen_retest_vectors.py, which runs wt.options.setups.retest bar by bar as the clone's runner does) names
// every bar at whose close the clone signals; tests/unit/test_retest_vectors.py re-runs the clone on them. Here the
// board's sideState is read at every bar's close, on the bars up to it with their own 2-minute ATR (atr2m, as
// trade-now.ts passes it): its enter zone is exactly the first signal's two slots (that close and the next), never for
// a case with none, and a later clone signal of the same break reads missed ("slot"): the first governs (DEC-0052).
import { describe, expect, it } from "vitest";
import type { SidePlan } from "@/lib/focus-plan";
import type { LiveQuote } from "@/lib/options";
import { atr2m, type Bar2, type Bars2m, BAR_MINUTES, CLOSE_GRACE_MS, MAX_BARS_TO_RETEST, RETEST_WITHIN_ATR, sideState } from "@/lib/trade-state";
import vectors from "./fixtures/retest.vectors.json";

interface Case {
  name: string;
  side: "call" | "put";
  level: number;
  bars: [number, number, number, number][];
  expect: { signals: { bar: number; atr: number }[]; confirm: number | null; atr_at_confirm: number | null };
}
const V = vectors as unknown as { session: string; bar_minutes: number; atr_period: number; retest: Record<string, number>; cases: Case[] };
const OPEN = Date.parse(`${V.session}T09:30:00-04:00`); // EDT
const BAR_MS = BAR_MINUTES * 60_000;

/** The board at bar i's close (+ the close grace): the bars up to it, settled, from the open; a fresh quote at its close. */
function boardAt(c: Case, i: number) {
  const closed: Bar2[] = c.bars.slice(0, i + 1).map(([o, h, l, cl], k) => ({ start: OPEN + k * BAR_MS, end: OPEN + (k + 1) * BAR_MS, o, h, l, c: cl }));
  const bars: Bars2m = { closed, partial: null, since: OPEN, complete: true, missing: [], gaps: 0 };
  const now = new Date(closed[i]!.end + CLOSE_GRACE_MS);
  const all = closed.flatMap((b) => [b.h, b.l]);
  const quote: LiveQuote = { price: closed[i]!.c, at: new Date(now.getTime() - 1_000).toISOString(), open: closed[0]!.o, high: Math.max(...all), low: Math.min(...all), day: V.session, prev_close: null, vwap: null };
  // the card's numbers far from the level, so target 1 never ends the case
  const s = c.side === "call" ? 1 : -1;
  const plan: SidePlan = { side: c.side, level: c.level, levelName: "L", entry: c.level + s * 0.02, stop: c.level - s * 0.2, target1: c.level + s * 50, target2: null };
  return { state: sideState(plan, 4, bars, quote, now, atr2m(closed)), atr: atr2m(closed) };
}

describe("the shared retest vectors (DEC-0052)", () => {
  it("use the board's numbers", () => {
    expect(V.retest.max_bars_to_retest).toBe(MAX_BARS_TO_RETEST);
    expect(V.retest.retest_within_atr).toBe(RETEST_WITHIN_ATR);
    expect(V.bar_minutes).toBe(BAR_MINUTES);
    expect(V.atr_period).toBe(14); // atr2m's period
    expect(V.cases.length).toBeGreaterThanOrEqual(10);
    expect(V.cases.some((c) => c.expect.signals.length >= 2)).toBe(true);
  });

  for (const c of V.cases)
    it(`${c.name}: the board's enter zone is bar ${c.expect.confirm ?? "none"}'s two slots, and nothing else`, () => {
      const read = c.bars.map((_, i) => boardAt(c, i).state);
      const enter = read.flatMap((x, i) => (x.state === "enter_zone" ? [i] : []));
      const k = c.expect.confirm;
      expect(enter).toEqual(k === null ? [] : [k, k + 1].filter((i) => i < c.bars.length));
      // a later clone signal of the same break: missed, the first confirmation's close kept
      for (const later of c.expect.signals.slice(1)) {
        expect(read[later.bar]).toMatchObject({ state: "missed", missedWhy: "slot", confirmClose: c.bars[k!]![3] });
      }
      if (k !== null) {
        const at = boardAt(c, k);
        // the same ATR the clone read there (Python sums with compensation, so to the last few bits)
        expect(at.atr).toBeCloseTo(c.expect.atr_at_confirm!, 10);
        expect(at.state.confirmClose).toBe(c.bars[k]![3]);
      }
    });
});
