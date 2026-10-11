import { describe, expect, it } from "vitest";
import { INTEREST_EACH, interestBySymbol, shortCount } from "@/lib/oi";
import type { OptionsLive } from "@/lib/options-live.types";

const NOW = Date.parse("2026-10-12T16:00:00Z");
const ALL = () => ({ lo: 0, hi: 1e9 });
const row = (strike: number, kind: "call" | "put", oi: number, expiry = "2026-10-16") => ({ expiry, strike, kind, oi });
const doc = (rows: ReturnType<typeof row>[], asOf = "2026-10-12T15:58:00Z"): OptionsLive => ({
  schema: "stocksdelta/options-live",
  run_id: "r",
  as_of: asOf,
  paper: true,
  positions: [],
  open_interest: [{ symbol: "SPY", as_of: "2026-10-09", rows }],
});

describe("open interest for the map", () => {
  it("adds a strike's contracts across expiries and keeps the largest of each kind, calls first", () => {
    const got = interestBySymbol(
      doc([
        row(780, "call", 1000),
        row(780, "call", 500, "2026-10-23"),
        row(785, "call", 1200),
        row(790, "call", 90),
        row(795, "call", 80),
        row(775, "put", 3000),
        row(770, "put", 3000),
      ]),
      NOW,
      ALL,
    );
    expect(got.SPY!.asOf).toBe("2026-10-09");
    expect(got.SPY!.marks).toEqual([
      { strike: 780, kind: "call", oi: 1500 },
      { strike: 785, kind: "call", oi: 1200 },
      { strike: 790, kind: "call", oi: 90 },
      // A tie goes to the lower strike, so the order never depends on how the host listed them.
      { strike: 770, kind: "put", oi: 3000 },
      { strike: 775, kind: "put", oi: 3000 },
    ]);
    expect(got.SPY!.marks.filter((m) => m.kind === "call")).toHaveLength(INTEREST_EACH);
  });

  it("leaves out empty strikes and rows it cannot read, and a name with nothing left", () => {
    const odd = [row(780, "call", 0), row(0, "put", 50), { ...row(781, "call", 5), kind: "straddle" }, null] as unknown as ReturnType<typeof row>[];
    expect(interestBySymbol(doc(odd), NOW, ALL)).toEqual({});
  });

  it("is empty with no document, with none sent, and once the document is as old as hidden positions", () => {
    expect(interestBySymbol(null, NOW, ALL)).toEqual({});
    expect(interestBySymbol({ ...doc([row(780, "call", 5)]), open_interest: null }, NOW, ALL)).toEqual({});
    expect(interestBySymbol(doc([row(780, "call", 5)], "2026-10-10T16:00:00Z"), NOW, ALL)).toEqual({});
    expect(interestBySymbol(doc([row(780, "call", 5)], "not a time"), NOW, ALL)).toEqual({});
    expect(Object.keys(interestBySymbol(doc([row(780, "call", 5)], "2026-10-11T16:00:00Z"), NOW, ALL))).toEqual(["SPY"]);
  });

  it("chooses among the strikes the map can show, and gives a name with none of them, or with no map, no marks", () => {
    const d = doc([row(900, "call", 99_000), row(780, "call", 10), row(785, "call", 20), row(700, "put", 50_000)]);
    const inMap = interestBySymbol(d, NOW, () => ({ lo: 750, hi: 800 }));
    expect(inMap.SPY!.marks).toEqual([
      { strike: 785, kind: "call", oi: 20 },
      { strike: 780, kind: "call", oi: 10 },
    ]);
    expect(interestBySymbol(d, NOW, () => ({ lo: 100, hi: 200 }))).toEqual({});
    expect(interestBySymbol(d, NOW, () => null)).toEqual({});
  });

  it("writes a count short", () => {
    expect([950, 1825, 22410, 999_999, 1_250_000].map(shortCount)).toEqual(["950", "1.8k", "22k", "1.0M", "1.3M"]);
  });
});
