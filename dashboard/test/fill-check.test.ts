// The fill-time check of DEC-0049 point 4, its pure rules: units, the contract's OCC form, the sessions, the condition
// codes, the match and its exact bounds, the summary's percentiles and the verdict. Synthetic journals only.
import { describe, expect, it } from "vitest";
import {
  checkUnits,
  codeClass,
  eligible,
  matchUnit,
  occSymbol,
  percentile,
  pickSessions,
  priceMicro,
  requestSpan,
  stampNs,
  standardContract,
  summarise,
  verdict,
  type FillCheckSummary,
  type Outcome,
  type Unit,
} from "@/lib/fill-check";
import { sessionOf } from "@/lib/market-calendar";

// ---- synthetic journal rows ---------------------------------------------------------------------------------------
let n = 0;
type Row = Record<string, unknown>;
const piece = (o: Row = {}): Row => ({
  id: `p-${++n}`,
  symbol: "ABC",
  kind: "call",
  strike: 50,
  expiry: "2026-12-18",
  side: "long",
  qty: 1,
  opened_at: "2026-11-10T15:00:00.000Z",
  closed_at: "2026-11-10T15:20:00.000Z",
  entry: 1.2,
  exit: 1.5,
  multiplier: 100,
  pnl: 30,
  close: "order",
  ...o,
});
const journal = (trades: Row[], open: Row[] = []) => ({ schema: "stocksdelta/journal", trades, open });
const opening = (s: ReturnType<typeof checkUnits>) => s.units.filter((u) => u.side === "opening");
const closing = (s: ReturnType<typeof checkUnits>) => s.units.filter((u) => u.side === "closing");
const reasons = (s: ReturnType<typeof checkUnits>, side: "opening" | "closing") => s.excluded.filter((x) => x.side === side).map((x) => x.reason);

const S = 1_000_000_000n;
const T0 = "2026-11-10T15:00:00.000Z";
const t0 = stampNs(T0)!;
const at = (deltaNs: bigint) => {
  const ns = t0 + deltaNs;
  const ms = ns / 1_000_000n;
  return `${new Date(Number(ms)).toISOString().slice(0, -1)}${String(ns % 1_000_000n).padStart(6, "0")}Z`;
};
const unit: Pick<Unit, "atNs" | "priceMicro"> = { atNs: t0, priceMicro: priceMicro(1.2)! };

describe("units", () => {
  it("one buy sold in two parts counts once on opening, and its two closes twice", () => {
    const s = checkUnits(journal([piece({ closed_at: "2026-11-10T15:10:00.000Z", exit: 1.4 }), piece({ closed_at: "2026-11-10T15:20:00.000Z" })]), null);
    expect(opening(s)).toHaveLength(1);
    expect(closing(s)).toHaveLength(2);
  });

  it("two parts closed by one sell count once on closing", () => {
    const s = checkUnits(journal([piece({ opened_at: "2026-11-10T14:40:00.000Z" }), piece({ opened_at: "2026-11-10T14:50:00.000Z" })]), null);
    expect(opening(s)).toHaveLength(2);
    expect(closing(s)).toHaveLength(1);
  });

  it("two buys of the same contract at different times count twice", () => {
    const s = checkUnits(journal([piece(), piece({ opened_at: "2026-11-10T15:05:00.000Z", closed_at: "2026-11-10T15:30:00.000Z" })]), null);
    expect(opening(s)).toHaveLength(2);
  });

  it("the same time and contract at another price is another unit", () => {
    expect(opening(checkUnits(journal([piece(), piece({ entry: 1.25 })]), null))).toHaveLength(2);
  });

  it("an expired piece has no closing unit and is not counted as left out", () => {
    const s = checkUnits(journal([piece({ close: "expired", exit: 0 })]), null);
    expect(opening(s)).toHaveLength(1);
    expect(closing(s)).toHaveLength(0);
    expect(reasons(s, "closing")).toEqual([]);
  });

  it("open lots, and sides without a time, are left out and counted", () => {
    const s = checkUnits(
      journal(
        [piece({ opened_at: undefined }), piece({ closed_at: "not a time" }), piece({ opened_at: "2026-11-10T10:00:00" })],
        [{ symbol: "ABC", kind: "call", strike: 50, expiry: "2026-12-18", side: "long", qty: 1, entry: 1.1, opened_at: "2026-11-10T16:00:00.000Z" }],
      ),
      null,
    );
    expect(reasons(s, "opening").sort()).toEqual(["no_time", "no_time", "open_lot"]);
    expect(reasons(s, "closing")).toEqual(["no_time"]);
    // The piece with no opening time still has a readable closing side.
    expect(closing(s)).toHaveLength(1);
  });

  it("an adjusted contract is skipped and counted, once per distinct side", () => {
    const s = checkUnits(journal([piece({ multiplier: 106 }), piece({ multiplier: 106, closed_at: "2026-11-10T15:30:00.000Z" }), piece({ symbol: "ABC1" }), piece({ symbol: "BRK.B" }), piece({ strike: null })]), null);
    expect(s.units).toHaveLength(0);
    expect(reasons(s, "opening")).toEqual(["adjusted", "adjusted", "adjusted", "adjusted"]);
    expect(reasons(s, "closing")).toEqual(["adjusted", "adjusted", "adjusted", "adjusted", "adjusted"]);
  });

  it("stock, short and malformed rows are not in scope", () => {
    const s = checkUnits(journal([piece({ kind: "stock", multiplier: 1 }), piece({ side: "short" }), null as unknown as Row, piece({ kind: "spread" })]), null);
    expect(s.units).toEqual([]);
    expect(s.excluded).toEqual([]);
  });

  it("a long option piece whose price or close cannot be read is counted as unreadable", () => {
    const s = checkUnits(journal([piece({ entry: "1.2" }), piece({ close: "assigned" })]), null);
    expect(reasons(s, "opening")).toEqual(["unreadable"]);
    expect(reasons(s, "closing")).toEqual(["unreadable"]);
  });

  it("with sessions, keeps only their days", () => {
    const s = checkUnits(journal([piece(), piece({ opened_at: "2026-11-12T15:00:00.000Z", closed_at: "2026-11-12T15:20:00.000Z" })]), ["2026-11-12"]);
    expect(opening(s).map((u) => u.day)).toEqual(["2026-11-12"]);
    expect(s.excluded).toEqual([]);
  });

  it("a side with no time is placed on the day of the piece's other time, and counted only on a picked session", () => {
    const j = journal([piece({ opened_at: null }), piece({ opened_at: "2026-11-12T15:00:00.000Z", closed_at: "bad" })]);
    expect(checkUnits(j, ["2026-11-10"]).excluded).toEqual([{ side: "opening", day: "2026-11-10", reason: "no_time" }]);
    expect(checkUnits(j, ["2026-11-12"]).excluded).toEqual([{ side: "closing", day: "2026-11-12", reason: "no_time" }]);
    expect(checkUnits(j, ["2026-11-13"]).excluded).toEqual([]);
  });

  it("a piece with neither time usable is counted once, overall, as no_times", () => {
    const s = checkUnits(journal([piece({ opened_at: null, closed_at: "2026-02-30T15:00:00Z" })]), ["2026-11-10"]);
    expect(s.units).toEqual([]);
    expect(s.excluded).toEqual([{ side: "opening", day: null, reason: "no_times" }]);
  });

  it("the unit's day is New York's, not UTC's", () => {
    const s = checkUnits(journal([piece({ opened_at: "2026-11-11T01:30:00.000Z", closed_at: "2026-11-11T01:40:00.000Z" })]), null);
    expect(opening(s)[0]!.day).toBe("2026-11-10");
  });
});

describe("the OCC symbol", () => {
  it("a fractional strike", () => {
    expect(occSymbol("ABC", "2026-01-16", "call", 172.5)).toBe("ABC260116C00172500");
  });
  it("a 4-digit strike and a put", () => {
    expect(occSymbol("XYZ", "2026-12-18", "put", 1250)).toBe("XYZ261218P01250000");
  });
  it("cents and a one-letter root", () => {
    expect(occSymbol("X", "2027-03-19", "call", 2.5)).toBe("X270319C00002500");
    expect(occSymbol("ABC", "2026-12-18", "call", 0.01)).toBe("ABC261218C00000010");
  });
  it("refuses what does not round-trip or fit", () => {
    expect(occSymbol("ABC", "2026-12-18", "call", 172.0005)).toBeNull();
    expect(occSymbol("ABC", "2026-12-18", "call", 100_000)).toBeNull();
    expect(occSymbol("ABC", "2026-12-18", "call", 0)).toBeNull();
    expect(occSymbol("ABC", "2026-12-18", "call", -5)).toBeNull();
    expect(occSymbol("ABC", "2026-02-30", "call", 50)).toBeNull();
    expect(occSymbol("ABC", "1999-12-17", "call", 50)).toBeNull();
    expect(occSymbol("ABC", "2026-12-18", "stock", 50)).toBeNull();
    expect(occSymbol("abc", "2026-12-18", "call", 50)).toBeNull();
    expect(occSymbol("ABCDEFG", "2026-12-18", "call", 50)).toBeNull();
  });
  it("a multiplier other than 100 is not standard", () => {
    expect(standardContract({ symbol: "ABC", kind: "call", strike: 50, expiry: "2026-12-18", multiplier: 100 })).toBe("ABC261218C00050000");
    expect(standardContract({ symbol: "ABC", kind: "call", strike: 50, expiry: "2026-12-18", multiplier: 10 })).toBeNull();
  });
});

describe("sessions", () => {
  const day = (d: string) => piece({ opened_at: `${d}T15:00:00.000Z`, closed_at: `${d}T15:20:00.000Z` });

  it("skips a half day, today's unfinished session and days with no opening unit, newest first", () => {
    // 2026-11-27 is a half day; 2026-11-30 is today; 2026-11-26 is Thanksgiving; 2026-11-24 holds only a stock piece.
    const j = journal([day("2026-11-23"), day("2026-11-25"), day("2026-11-27"), day("2026-11-30"), piece({ kind: "stock", multiplier: 1, opened_at: "2026-11-24T15:00:00.000Z" })]);
    expect(pickSessions(j, sessionOf, new Date("2026-11-30T20:59:00.000Z"))).toEqual(["2026-11-25", "2026-11-23"]);
    // At 16:00 New York the day's session has ended.
    expect(pickSessions(j, sessionOf, new Date("2026-11-30T21:00:00.000Z"))).toEqual(["2026-11-30", "2026-11-25", "2026-11-23"]);
  });

  it("a day holding only an open lot, a closing side or an adjusted contract holds no opening unit", () => {
    const j = journal(
      [piece({ opened_at: "2026-11-09T15:00:00.000Z", closed_at: "2026-11-10T15:00:00.000Z" }), piece({ opened_at: "2026-11-11T15:00:00.000Z", closed_at: "2026-11-11T15:10:00.000Z", multiplier: 50 })],
      [{ symbol: "ABC", kind: "call", strike: 50, expiry: "2026-12-18", side: "long", qty: 1, entry: 1, opened_at: "2026-11-12T15:00:00.000Z" }],
    );
    expect(pickSessions(j, sessionOf, new Date("2026-11-20T00:00:00Z"))).toEqual(["2026-11-09"]);
  });

  it("takes at most 10", () => {
    const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"];
    const got = pickSessions(journal(days.map(day)), sessionOf, new Date("2026-11-20T00:00:00Z"));
    expect(got).toHaveLength(10);
    expect(got[0]).toBe("2026-11-17");
    expect(got.at(-1)).toBe("2026-11-04");
  });
});

describe("condition codes", () => {
  it("excludes each listed letter: A to G, f to m, n to s", () => {
    for (const c of "ABCDEFGfghijklmnopqrs") {
      expect(codeClass(c)).toBe("excluded");
      expect(eligible({ c })).toBe(false);
    }
  });
  it("accepts other letters, case-sensitively, and a missing or empty code", () => {
    for (const c of ["I", "S", "a", "H", "t", "z", "Z", "", undefined, null]) expect(eligible({ c })).toBe(true);
  });
  it("an unknown-shape code is not eligible and is classed apart", () => {
    for (const c of ["II", "AI", "1", " ", "#", 7, ["I"], {}]) {
      expect(codeClass(c)).toBe("unknown");
      expect(eligible({ c })).toBe(false);
    }
  });
});

describe("the match", () => {
  it("10.000 s matches, 10.001 s does not, on either side", () => {
    expect(matchUnit(unit, [{ t: at(10n * S), p: 1.2 }]).truth).toBe(true);
    expect(matchUnit(unit, [{ t: at(-10n * S), p: 1.2 }]).truth).toBe(true);
    expect(matchUnit(unit, [{ t: at(10_001_000_000n), p: 1.2 }]).truth).toBe(false);
    expect(matchUnit(unit, [{ t: at(-10_001_000_000n), p: 1.2 }]).truth).toBe(false);
    // To the nanosecond.
    expect(matchUnit(unit, [{ t: at(10n * S + 1n), p: 1.2 }]).truth).toBe(false);
  });

  it("$0.01 matches, just over does not, in whole numbers", () => {
    // In floating point 1.21 - 1.2 is just over 0.01; in millionths it is exactly 10 000.
    expect(matchUnit(unit, [{ t: T0, p: 1.21 }]).truth).toBe(true);
    expect(matchUnit(unit, [{ t: T0, p: 1.19 }]).truth).toBe(true);
    expect(matchUnit(unit, [{ t: T0, p: 1.210001 }]).truth).toBe(false);
    expect(matchUnit(unit, [{ t: T0, p: 1.189999 }]).truth).toBe(false);
    expect(matchUnit(unit, [{ t: T0, p: 1.211 }]).truth).toBe(false);
  });

  it("an excluded or unknown code never matches, and an unknown one is counted", () => {
    const m = matchUnit(unit, [{ t: T0, p: 1.2, c: "f" }, { t: T0, p: 1.2, c: "XX" }]);
    expect(m).toMatchObject({ truth: false, prints: 2, unknownCodes: 1 });
    expect(matchUnit(unit, [{ t: T0, p: 1.2, c: "a" }]).truth).toBe(true);
  });

  it("control windows at exactly ±5 min, each ±10 s", () => {
    expect(matchUnit(unit, [{ t: at(300n * S), p: 1.2 }])).toMatchObject({ truth: false, early: false, late: true });
    expect(matchUnit(unit, [{ t: at(-300n * S), p: 1.2 }])).toMatchObject({ truth: false, early: true, late: false });
    expect(matchUnit(unit, [{ t: at(310n * S), p: 1.2 }]).late).toBe(true);
    expect(matchUnit(unit, [{ t: at(290n * S), p: 1.2 }]).late).toBe(true);
    expect(matchUnit(unit, [{ t: at(289_999_999_999n), p: 1.2 }]).late).toBe(false);
    expect(matchUnit(unit, [{ t: at(-310n * S), p: 1.2 }]).early).toBe(true);
  });

  it("a print that matches a control window but not the true time", () => {
    const m = matchUnit(unit, [{ t: at(-302n * S), p: 1.2 }, { t: at(5n * S), p: 1.5 }]);
    expect(m).toMatchObject({ truth: false, early: true, late: false, offsetMs: null, prints: 2 });
  });

  it("offsets keep their sign; the nearest wins, the earlier on a tie", () => {
    expect(matchUnit(unit, [{ t: at(-3_250_000_000n), p: 1.2 }]).offsetMs).toBe(-3250);
    expect(matchUnit(unit, [{ t: at(4_000_400_000n), p: 1.2 }]).offsetMs).toBe(4000);
    expect(matchUnit(unit, [{ t: at(8n * S), p: 1.2 }, { t: at(-2n * S), p: 1.2 }, { t: at(6n * S), p: 1.2 }]).offsetMs).toBe(-2000);
    expect(matchUnit(unit, [{ t: at(2n * S), p: 1.2 }, { t: at(-2n * S), p: 1.2 }]).offsetMs).toBe(-2000);
    // Alpaca's stamps to the nanosecond, with a zone written as an offset.
    expect(matchUnit(unit, [{ t: "2026-11-10T10:00:01.500000001-05:00", p: 1.2 }]).offsetMs).toBe(1500);
  });

  it("prints outside the span, or unreadable, are not counted", () => {
    expect(matchUnit(unit, [{ t: at(311n * S), p: 1.2 }, { t: "yesterday", p: 1.2 }, { t: T0, p: "1.2" }, { t: T0, p: 0 }]).prints).toBe(0);
  });

  it("the request span is 5 min 10 s either side, never wider", () => {
    const s = requestSpan({ atNs: t0 });
    expect(new Date(s.startMs).toISOString()).toBe("2026-11-10T14:54:50.000Z");
    expect(new Date(s.endMs).toISOString()).toBe("2026-11-10T15:05:10.000Z");
    // A time with sub-millisecond digits is rounded inwards.
    const odd = requestSpan({ atNs: t0 + 400n });
    expect(BigInt(odd.endMs) * 1_000_000n <= t0 + 400n + 310n * S).toBe(true);
    expect(BigInt(odd.startMs) * 1_000_000n >= t0 + 400n - 310n * S).toBe(true);
    expect(odd.endMs - odd.startMs).toBe(619_999);
  });
});

describe("the summary", () => {
  it("percentiles by linear interpolation on 1, 2 and many values", () => {
    expect([percentile([7], 0.1), percentile([7], 0.5), percentile([7], 0.9)]).toEqual([7, 7, 7]);
    expect(percentile([1, 3], 0.5)).toBe(2);
    expect(percentile([1, 3], 0.1)).toBeCloseTo(1.2, 12);
    expect(percentile([1, 3], 0.9)).toBeCloseTo(2.8, 12);
    const many = Array.from({ length: 11 }, (_, i) => i * 10); // 0..100
    expect([percentile(many, 0.1), percentile(many, 0.5), percentile(many, 0.9)]).toEqual([10, 50, 90]);
    expect(percentile([0, 10, 20, 30], 0.5)).toBe(15);
    expect(() => percentile([], 0.5)).toThrow();
  });

  const hit = (day: string, offsetMs: number, side: "opening" | "closing" = "opening"): Outcome => ({ side, day, checked: true, match: { truth: true, early: false, late: false, offsetMs } });
  const miss = (day: string, early = false, late = false, side: "opening" | "closing" = "opening"): Outcome => ({ side, day, checked: true, match: { truth: false, early, late, offsetMs: null } });

  it("per session and overall, with reasons, and the sides without a day counted overall only", () => {
    const sum = summarise(
      ["2026-11-11", "2026-11-10"],
      [
        hit("2026-11-11", -1000),
        hit("2026-11-11", 3000),
        miss("2026-11-11", true, false),
        miss("2026-11-10", true, true),
        hit("2026-11-10", 500, "closing"),
        { side: "opening", day: "2026-11-10", checked: false, reason: "no_prints" },
        { side: "opening", day: null, checked: false, reason: "no_time" },
      ],
    );
    const [a, b] = sum.sessions;
    expect(a).toMatchObject({ day: "2026-11-11", opening: { checked: 3, matched: 2, early: 1, late: 0, offset_s: { n: 2, median: 1, p10: -0.6, p90: 2.6 } } });
    expect(a!.opening.true_rate).toBeCloseTo(2 / 3, 12);
    expect(a!.opening.control_rate).toBeCloseTo(1 / 6, 12);
    expect(b!.opening.not_checked.no_prints).toBe(1);
    expect(b!.opening.not_checked.no_time).toBe(0);
    expect(b!.closing).toMatchObject({ checked: 1, matched: 1, offset_s: { n: 1, median: 0.5 } });
    expect(sum.overall.opening).toMatchObject({ checked: 4, matched: 2, early: 2, late: 1 });
    expect(sum.overall.opening.not_checked).toMatchObject({ no_prints: 1, no_time: 1 });
    expect(sum.overall.sessions_checked).toBe(2);
  });

  it("no unit checked: rates and offsets are null", () => {
    const s = summarise(["2026-11-10"], []);
    expect(s.overall.opening).toMatchObject({ checked: 0, true_rate: null, control_rate: null, offset_s: null });
  });
});

describe("the verdict", () => {
  // `checked` opening units over `sessions` sessions, `matched` at the true time and `control` control hits in all.
  function summary(checked: number, sessions: number, matched: number, control: number, closing?: { checked: number; matched: number }): FillCheckSummary {
    const days = Array.from({ length: sessions }, (_, i) => `2026-11-${String(2 + i).padStart(2, "0")}`);
    const out: Outcome[] = [];
    for (let i = 0; i < checked; i++) {
      const c1 = i < control;
      const c2 = i + checked < control;
      out.push({ side: "opening", day: days[i % sessions]!, checked: true, match: { truth: i < matched, early: c1, late: c2, offsetMs: i < matched ? 0 : null } });
    }
    for (let i = 0; i < (closing?.checked ?? 0); i++) out.push({ side: "closing", day: days[0]!, checked: true, match: { truth: i < closing!.matched, early: false, late: false, offsetMs: 0 } });
    return summarise(days, out);
  }

  it("passes at exactly 30 units, 3 sessions and 50 points", () => {
    // True 15/30 = 50%, control 0: exactly 50 points.
    expect(verdict(summary(30, 3, 15, 0))).toBe("pass");
    // True 24/30 = 80%, control 18 of 60 windows = 30%: exactly 50 points.
    expect(verdict(summary(30, 3, 24, 18))).toBe("pass");
  });

  it("exactly 50 points where floating point says 49.99...: 21 of 30 against 12 of 60 is a pass", () => {
    expect(21 / 30 - 12 / 60).toBeLessThan(0.5);
    expect(verdict(summary(30, 3, 21, 12))).toBe("pass");
    expect(verdict(summary(30, 3, 21, 13))).toBe("fail");
  });

  it("fails one below 50 points", () => {
    expect(verdict(summary(30, 3, 14, 0))).toBe("fail");
    // True 80% against 19 of 60 control windows (31.67%): 48.3 points.
    expect(verdict(summary(30, 3, 24, 19))).toBe("fail");
  });

  it("too few one below 30 units, and one below 3 sessions", () => {
    expect(verdict(summary(29, 3, 29, 0))).toBe("too_few");
    expect(verdict(summary(30, 2, 30, 0))).toBe("too_few");
  });

  it("sessions are counted only when they hold an opening unit checked", () => {
    const s = summary(30, 3, 30, 0);
    const extra = summarise([...s.sessions.map((x) => x.day), "2026-11-20"], []);
    expect(extra.overall.sessions_checked).toBe(0);
    expect(s.overall.sessions_checked).toBe(3);
  });

  it("closing sides never rescue a fail or a too few", () => {
    expect(verdict(summary(30, 3, 10, 0, { checked: 100, matched: 100 }))).toBe("fail");
    expect(verdict(summary(10, 3, 10, 0, { checked: 100, matched: 100 }))).toBe("too_few");
  });
});

describe("whole numbers", () => {
  it("stamps parse to the nanosecond with their zone; a stamp with no zone is refused", () => {
    expect(stampNs("2026-11-10T15:00:00.000000001Z")! - t0).toBe(1n);
    expect(stampNs("2026-11-10T10:00:00-05:00")).toBe(t0);
    expect(stampNs("2026-11-10T15:00:00")).toBeNull();
    expect(stampNs(12)).toBeNull();
  });
  it("a date or time that does not round-trip is refused, never rolled over", () => {
    expect(stampNs("2026-02-30T15:00:00Z")).toBeNull();
    expect(stampNs("2026-02-29T15:00:00Z")).toBeNull();
    expect(stampNs("2028-02-29T15:00:00Z")).not.toBeNull();
    expect(stampNs("2026-11-10T24:00:00Z")).toBeNull();
    expect(stampNs("2026-11-10T23:60:00Z")).toBeNull();
    expect(stampNs("2026-11-10T23:59:60Z")).toBeNull();
    expect(stampNs("2026-13-01T10:00:00Z")).toBeNull();
    expect(stampNs("2026-11-10T10:00:00+24:00")).toBeNull();
    expect(stampNs("2026-11-10T10:00:00+05:60")).toBeNull();
    expect(stampNs("2026-11-10T20:30:00+05:30")).toBe(stampNs("2026-11-10T15:00:00Z"));
  });
  it("prices to the millionth", () => {
    expect(priceMicro(0.79)).toBe(790_000);
    expect(priceMicro(172.5)).toBe(172_500_000);
    expect(priceMicro(0)).toBeNull();
    expect(priceMicro(Number.NaN)).toBeNull();
  });
});
