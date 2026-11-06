import { describe, expect, it } from "vitest";
import { BAR_MINUTES, type CheckInput, type CheckId, entryChecks, LEADERS, type Side } from "@/lib/entry-checks";
import { type LiveQuote, nyInstant, OPEN_MIN } from "@/lib/options";
import vectors from "./fixtures/entry-checks.vectors.json";

// The vectors hold what the clone's own `setups.tag_decision` answers for each synthetic session (written by
// scripts/gen_entry_check_vectors.py, re-checked by tests/unit/test_entry_checks_parity.py). The desk's cautions must
// give the same answers: a caution shown is the flag true, none shown is false, and a flag the clone leaves unknown
// (None) is a check the desk leaves out and names in `unknown`, never shown as clear.
type Flag = boolean | null;
interface Vector {
  name: string;
  side: Side;
  root: string;
  marks: { name: string; price: number }[];
  daily: { d: string; o: number; h: number; l: number; c: number }[];
  bars: number[][];
  leader: { close: number; vwap: number | null } | null;
  iv: number | null;
  half_day: boolean;
  bar_end: string;
  expect: { ntz: Flag; gap_against: Flag; leader_against: Flag; iv_rich: Flag; early: Flag };
}

const S = vectors.session;
const cases = vectors.cases as Vector[];

function inputOf(v: Vector): CheckInput {
  const open = nyInstant(S, OPEN_MIN)!;
  const [h, m] = v.bar_end.split(":").map(Number) as [number, number];
  // a moment inside the bar that ends at bar_end: the bar the owner would enter on
  const now = new Date(nyInstant(S, h * 60 + m)! - 60_000);
  const bars = v.bars.map(([o, hi, lo, c]) => ({ o: o!, h: hi!, l: lo!, c: c! }));
  const last = bars[bars.length - 1]!;
  const quote: LiveQuote = {
    price: last.c,
    at: now.toISOString(),
    open: bars[0]!.o,
    high: Math.max(...bars.map((b) => b.h)),
    low: Math.min(...bars.map((b) => b.l)),
    day: S,
    prev_close: null,
    vwap: null,
  };
  const leaderQuote: LiveQuote | null = v.leader
    ? { price: v.leader.close, at: now.toISOString(), open: null, high: null, low: null, day: S, prev_close: null, vwap: v.leader.vwap }
    : null;
  return {
    symbol: v.root,
    ticker: { levels: v.marks, bars: v.daily, expected_move: { annual_iv: v.iv } },
    session: S,
    quote,
    leaderQuote,
    bars,
    since: open,
    gaps: 0,
    halfDay: v.half_day,
    now,
    wonToday: false,
  };
}

describe("entry checks against the clone's tag_decision (shared vectors)", () => {
  it("the vectors are the clone's and on the desk's bar", () => {
    expect(vectors.schema).toBe("wt/entry-check-vectors");
    expect(vectors.bar_minutes).toBe(BAR_MINUTES);
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  for (const v of cases)
    it(v.name, () => {
      const r = entryChecks(inputOf(v), v.side);
      const has = (id: CheckId) => r.cautions.some((c) => c.id === id);
      const unknown = r.unknown.join(" ");
      const e = v.expect;
      expect({
        ntz: has("range"),
        gap_against: has("gap"),
        leader_against: has("leader"),
        iv_rich: has("iv"),
        late: has("late"),
      }).toEqual({
        ntz: e.ntz === true,
        gap_against: e.gap_against === true,
        leader_against: e.leader_against === true,
        iv_rich: e.iv_rich === true,
        late: e.early === false, // the desk cautions late entries: the clone's early False
      });
      // an unknown flag is a check left out and named, never a clear one
      expect(/range is missing/.test(unknown)).toBe(e.ntz === null);
      expect(/IV check is off/.test(unknown)).toBe(e.iv_rich === null);
      expect(/SMH/.test(unknown)).toBe(v.root in LEADERS && e.leader_against === null);
    });
});
