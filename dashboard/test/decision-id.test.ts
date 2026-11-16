// The decision id (decision-id.ts): derived at read time from a DEC-0051 signal record, never stored in it. Round trip,
// determinism, the record path's own date and hhmm, the DST changes of 2026-11-01 and 2027-03-14 (the sessions either
// side of each), a half day, refused inputs, and the ids of records the writer itself builds (signal-run.ts
// buildSignalRecord, dry and log, on the same fixture edition signal-run.test.ts uses) read back through the strict
// reader. The record's format is untouched: no id is written anywhere.
import { describe, expect, it } from "vitest";
import { decisionId, DecisionIdError, type DecisionIdWhy, decisionIdsOf, parseDecisionId } from "@/lib/decision-id";
import { expectedSlots, SIDES, SYMBOL_RE } from "@/lib/desk-eval";
import type { LoggedSlot } from "@/lib/desk-run";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import { parseSignalRecord, signalLogPath } from "@/lib/signal-record";
import { buildSignalRecord } from "@/lib/signal-run";
import optionsJson from "./fixtures/options.v1.json";

const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const why = (f: () => unknown): DecisionIdWhy | null => {
  try {
    f();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(DecisionIdError);
    return (e as DecisionIdError).why;
  }
};
/** The id's date and hhmm as the record's path names them: desk/signal/<date>/<hhmm>.json. */
const pathParts = (session: string, end: string) => {
  const m = /^desk\/signal\/(\d{4})-(\d{2})-(\d{2})\/(\d{4})\.json$/.exec(signalLogPath(session, Date.parse(end)))!;
  return `${m[1]}${m[2]}${m[3]}-${m[4]}`;
};

describe("decisionId", () => {
  it("names the New York session date and slot end, the symbol and C or P", () => {
    expect(decisionId({ session: "2026-10-12", slotEnd: "2026-10-12T14:30:00.000Z", symbol: "AAPL", side: "call" })).toBe("dec-20261012-1030-AAPL-C");
    expect(decisionId({ session: "2026-10-12", slotEnd: Date.parse("2026-10-12T14:30:00Z"), symbol: "BRK.B", side: "put" })).toBe("dec-20261012-1030-BRK.B-P");
  });

  it("is deterministic: the same input, as ISO or ms, always gives the same id", () => {
    const k = { session: "2026-11-16", slotEnd: "2026-11-16T15:02:00.000Z", symbol: "NVDA", side: "call" as const };
    const a = decisionId(k);
    expect(Array.from({ length: 5 }, () => decisionId({ ...k }))).toEqual(Array(5).fill(a));
    expect(decisionId({ ...k, slotEnd: Date.parse(k.slotEnd) })).toBe(a);
  });

  it("round-trips every slot end of a session, both sides, and its date and hhmm are the record path's", () => {
    const day = "2026-11-16";
    const slots = expectedSlots(day);
    expect(slots.length).toBe(194); // 09:32 .. 15:58
    for (const end of slots)
      for (const side of SIDES) {
        const slotEnd = new Date(end).toISOString();
        const id = decisionId({ session: day, slotEnd, symbol: "SPY", side });
        expect(parseDecisionId(id)).toEqual({ session: day, slotEnd, symbol: "SPY", side });
        expect(id.slice(4, 17)).toBe(pathParts(day, slotEnd));
      }
    expect(new Set(slots.map((end) => decisionId({ session: day, slotEnd: end, symbol: "SPY", side: "call" }))).size).toBe(slots.length);
  });

  it("keeps the New York clock across the DST changes (2026-11-01 back, 2027-03-14 forward)", () => {
    // Friday before / Monday after each Sunday change: 09:32 New York is 13:32Z under EDT and 14:32Z under EST.
    const cases = [
      ["2026-10-30", "2026-10-30T13:32:00.000Z", "2026-10-30T19:58:00.000Z"], // EDT
      ["2026-11-02", "2026-11-02T14:32:00.000Z", "2026-11-02T20:58:00.000Z"], // EST
      ["2027-03-12", "2027-03-12T14:32:00.000Z", "2027-03-12T20:58:00.000Z"], // EST
      ["2027-03-15", "2027-03-15T13:32:00.000Z", "2027-03-15T19:58:00.000Z"], // EDT
    ] as const;
    for (const [day, first, last] of cases) {
      const ymd = day.replaceAll("-", "");
      expect(decisionId({ session: day, slotEnd: first, symbol: "QQQ", side: "put" })).toBe(`dec-${ymd}-0932-QQQ-P`);
      expect(decisionId({ session: day, slotEnd: last, symbol: "QQQ", side: "call" })).toBe(`dec-${ymd}-1558-QQQ-C`);
      expect(parseDecisionId(`dec-${ymd}-0932-QQQ-P`).slotEnd).toBe(first);
      expect(parseDecisionId(`dec-${ymd}-1558-QQQ-C`).slotEnd).toBe(last);
      expect(expectedSlots(day).length).toBe(194);
    }
    // The other clock's instant of the same New York minute is an hour off the session's slots, not a slot.
    expect(why(() => decisionId({ session: "2026-11-02", slotEnd: "2026-11-02T13:32:00.000Z", symbol: "QQQ", side: "put" }))).toBe("off-slot");
    expect(why(() => decisionId({ session: "2027-03-15", slotEnd: "2027-03-15T14:32:00.000Z", symbol: "QQQ", side: "put" }))).toBe(null);
    expect(decisionId({ session: "2027-03-15", slotEnd: "2027-03-15T14:32:00.000Z", symbol: "QQQ", side: "put" })).toBe("dec-20270315-1032-QQQ-P");
    // The change days themselves are Sundays: no session.
    expect(why(() => parseDecisionId("dec-20261101-0932-QQQ-P"))).toBe("closed-day");
    expect(why(() => parseDecisionId("dec-20270314-0932-QQQ-P"))).toBe("closed-day");
  });

  it("stops at the half day's close (2026-11-27, 13:00)", () => {
    const day = "2026-11-27";
    expect(expectedSlots(day).length).toBe(104); // 09:32 .. 12:58
    expect(decisionId({ session: day, slotEnd: "2026-11-27T17:58:00.000Z", symbol: "AAPL", side: "call" })).toBe("dec-20261127-1258-AAPL-C");
    expect(parseDecisionId("dec-20261127-1258-AAPL-C").slotEnd).toBe("2026-11-27T17:58:00.000Z");
    expect(why(() => decisionId({ session: day, slotEnd: "2026-11-27T18:00:00.000Z", symbol: "AAPL", side: "call" }))).toBe("off-slot");
    expect(why(() => parseDecisionId("dec-20261127-1300-AAPL-C"))).toBe("off-slot");
    expect(why(() => parseDecisionId("dec-20261127-1400-AAPL-C"))).toBe("off-slot");
    expect(parseDecisionId("dec-20261127-1400-AAPL-C".replace("20261127", "20261130")).slotEnd).toBe(iso("2026-11-30T14:00:00-05:00"));
  });

  it("refuses what no record can hold, with a typed error", () => {
    const ok = { session: "2026-10-12", slotEnd: "2026-10-12T14:30:00.000Z", symbol: "AAPL", side: "call" as const };
    const cases: [Partial<Record<keyof typeof ok, unknown>>, DecisionIdWhy][] = [
      [{ session: "2026-10-1" }, "bad-session"],
      [{ session: "20261012" }, "bad-session"],
      [{ session: 20261012 }, "bad-session"],
      [{ session: "2026-10-11" }, "closed-day"], // Sunday
      [{ session: "2026-11-26" }, "closed-day"], // Thanksgiving
      [{ session: "2025-12-31" }, "closed-day"], // before the calendar
      [{ session: "2026-02-30" }, "bad-session"], // not a calendar date
      [{ session: "2026-13-01" }, "bad-session"],
      [{ session: "2026-04-31" }, "bad-session"],
      [{ session: "2027-02-29" }, "bad-session"],
      [{ slotEnd: "2026-10-12T14:30:00Z" }, "bad-slot-end"], // not canonical
      [{ slotEnd: "yesterday" }, "bad-slot-end"],
      [{ slotEnd: Number.NaN }, "bad-slot-end"],
      [{ slotEnd: 1.5 }, "bad-slot-end"],
      [{ slotEnd: "2026-10-12T14:31:00.000Z" }, "off-slot"], // odd minute
      [{ slotEnd: "2026-10-12T14:30:30.000Z" }, "off-slot"], // not on the minute
      [{ slotEnd: "2026-10-12T13:30:00.000Z" }, "off-slot"], // 09:30: the open, no bar has ended
      [{ slotEnd: "2026-10-12T20:00:00.000Z" }, "off-slot"], // 16:00: settles after the close
      [{ slotEnd: "2026-10-13T14:30:00.000Z" }, "off-slot"], // another session's
      [{ symbol: "aapl" }, "bad-symbol"],
      [{ symbol: "AAPL-W" }, "bad-symbol"],
      [{ symbol: "" }, "bad-symbol"],
      [{ symbol: "ABCDEFGHIJK" }, "bad-symbol"],
      [{ side: "C" }, "bad-side"],
      [{ side: "long" }, "bad-side"],
    ];
    for (const [over, want] of cases) expect([over, why(() => decisionId({ ...ok, ...over } as never))]).toEqual([over, want]);
    expect(decisionId(ok)).toBe("dec-20261012-1030-AAPL-C");
    // A real leap day is a calendar date and, a Tuesday, a session.
    expect(decisionId({ ...ok, session: "2028-02-29", slotEnd: "2028-02-29T15:30:00.000Z" })).toBe("dec-20280229-1030-AAPL-C");
  });

  it("takes exactly the symbols a record may hold (desk-eval.ts SYMBOL_RE), and they round-trip", () => {
    const ok = ["A", "SPY", "BRK.B", "X1", "A.B.C", "ABCDEFGHIJ", "Z9.9"];
    for (const symbol of ok) {
      expect(SYMBOL_RE.test(symbol)).toBe(true);
      for (const side of SIDES) {
        const k = { session: "2026-10-12", slotEnd: "2026-10-12T14:30:00.000Z", symbol, side };
        expect(parseDecisionId(decisionId(k))).toEqual(k);
      }
    }
    for (const symbol of ["1A", ".A", "ABCDEFGHIJK", "Aa"]) {
      expect(SYMBOL_RE.test(symbol)).toBe(false);
      expect(why(() => parseDecisionId(`dec-20261012-1030-${symbol}-C`))).toBe("bad-id");
    }
  });

  it("parses only its own form", () => {
    const bad: [unknown, DecisionIdWhy][] = [
      ["dec-20261012-1030-AAPL-c", "bad-id"],
      ["dec-20261012-1030-AAPL-X", "bad-id"],
      ["DEC-20261012-1030-AAPL-C", "bad-id"],
      ["dec-2026-10-12-1030-AAPL-C", "bad-id"],
      ["dec-20261012-930-AAPL-C", "bad-id"],
      ["dec-20261012-1030-aapl-C", "bad-id"],
      [" dec-20261012-1030-AAPL-C", "bad-id"],
      ["dec-20261012-1030-AAPL-C\n", "bad-id"],
      [null, "bad-id"],
      ["dec-20261012-1031-AAPL-C", "off-slot"],
      ["dec-20261012-0930-AAPL-C", "off-slot"],
      ["dec-20261012-1600-AAPL-C", "off-slot"],
      ["dec-20261012-2500-AAPL-C", "off-slot"],
      ["dec-20261011-1030-AAPL-C", "closed-day"],
      ["dec-20261340-1030-AAPL-C", "bad-id"], // not a calendar date
      ["dec-20260230-1030-AAPL-C", "bad-id"],
      ["dec-20260001-1030-AAPL-C", "bad-id"],
    ];
    for (const [id, want] of bad) expect([id, why(() => parseDecisionId(id as string))]).toEqual([id, want]);
  });
});

// ---- ids of records the writer builds ------------------------------------------------------------------------------
const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, EDT
const FOCUS = E.focus!.items.map((i) => i.symbol); // SPY, QQQ, AAPL
const SLOT = Date.parse(`${S}T10:30:00-04:00`);

function record(mode: "dry" | "log", edition: Options | null = E, end = SLOT) {
  const logged = {
    path: `desk/log/${S}/1030.json`,
    body: "{}",
    record: { session: S, status: "ok", reason: null, evaluated_at: new Date(end + 61_000).toISOString(), rows: [], degraded_names: [] },
    slot: { day: S, end },
    edition,
    states: [],
  } as unknown as LoggedSlot;
  const built = buildSignalRecord({
    mode,
    switch: mode,
    logged,
    evaluatedAt: end + 63_000,
    stamp: { stamp: null, usable: false },
    flow: null,
    flowWhy: "no flow answer",
    chains: {},
    history: { breaks: [], from: null, usable: true },
  });
  // Read back exactly as the Lab and the scorer will: the stored bytes through the strict reader.
  const read = parseSignalRecord(JSON.stringify(built));
  expect(read).not.toBeNull();
  return read!;
}

describe("decisionIdsOf", () => {
  it("lists one id per focus name and side, in the record's order, for dry and log records alike", () => {
    const want = FOCUS.flatMap((s) => [`dec-20261012-1030-${s}-C`, `dec-20261012-1030-${s}-P`]);
    expect(FOCUS).toEqual(["SPY", "QQQ", "AAPL"]);
    for (const mode of ["dry", "log"] as const) {
      const r = record(mode);
      expect(r.mode).toBe(mode);
      expect(r.focus).toEqual(FOCUS);
      expect(decisionIdsOf(r)).toEqual({ ids: want, duplicates: [] });
      expect(decisionIdsOf(r).ids.map(parseDecisionId)).toEqual(FOCUS.flatMap((symbol) => SIDES.map((side) => ({ session: S, slotEnd: r.slot_end, symbol, side }))));
      expect(want.every((id) => id.slice(4, 17) === pathParts(r.session, r.slot_end))).toBe(true);
      // Derived, never stored: no field of the record holds an id.
      expect(JSON.stringify(r)).not.toContain("dec-2026");
    }
  });

  it("a record with no edition for its session holds no names and implies no ids", () => {
    for (const ed of [null, { ...E, session: "2026-10-09" }]) {
      const r = record("log", ed);
      expect(r.names).toEqual([]);
      expect(decisionIdsOf(r)).toEqual({ ids: [], duplicates: [] });
    }
  });

  it("an edition listing a focus name twice: each id once, in record order, and the repeats listed, not thrown", () => {
    const items = E.focus!.items;
    const twice: Options = { ...E, focus: { ...E.focus!, items: [items[0]!, items[1]!, items[0]!, items[2]!, items[1]!] } };
    for (const mode of ["dry", "log"] as const) {
      const r = record(mode, twice);
      // The writer holds the repeated names as the edition gives them (its own order); the ids keep first places.
      expect([...r.names.map((n) => n.symbol)].sort()).toEqual(["AAPL", "QQQ", "QQQ", "SPY", "SPY"]);
      expect(decisionIdsOf(r)).toEqual({
        ids: FOCUS.flatMap((s) => [`dec-20261012-1030-${s}-C`, `dec-20261012-1030-${s}-P`]),
        duplicates: ["dec-20261012-1030-SPY-C", "dec-20261012-1030-SPY-P", "dec-20261012-1030-QQQ-C", "dec-20261012-1030-QQQ-P"],
      });
    }
  });

  it("refuses a record whose session and slot end make no id", () => {
    const r = record("dry");
    expect(why(() => decisionIdsOf({ ...r, slot_end: "2026-10-12T14:31:00.000Z" }))).toBe("off-slot");
    expect(why(() => decisionIdsOf({ ...r, names: [], slot_end: "2026-10-12T20:00:00.000Z" }))).toBe("off-slot");
    expect(why(() => decisionIdsOf({ ...r, session: "2026-10-11" }))).toBe("closed-day");
    expect(why(() => decisionIdsOf({ ...r, session: "2026-02-30" }))).toBe("bad-session");
  });
});
