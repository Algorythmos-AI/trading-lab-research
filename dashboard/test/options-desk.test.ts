import { describe, expect, it } from "vitest";
import {
  clockSpan,
  closeMinute,
  mapReadout,
  mapView,
  priceAtY,
  isDeskView,
  levelPrice,
  movesFromClose,
  nyInstant,
  OPEN_MIN,
  paperFor,
  sessionClock,
  sortByNumber,
  viewForClock,
  type Options,
} from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

const e = optionsJson as unknown as Options;
const SESSION = e.session; // 2026-10-12, a Monday in daylight time
const at = (iso: string) => new Date(iso);

describe("New York instants", () => {
  it("places the open under daylight time and under standard time", () => {
    expect(new Date(nyInstant("2026-10-12", OPEN_MIN)!).toISOString()).toBe("2026-10-12T13:30:00.000Z");
    // US clocks go back on 1 Nov 2026 and forward on 14 Mar 2027.
    expect(new Date(nyInstant("2026-11-02", OPEN_MIN)!).toISOString()).toBe("2026-11-02T14:30:00.000Z");
    expect(new Date(nyInstant("2027-03-12", OPEN_MIN)!).toISOString()).toBe("2027-03-12T14:30:00.000Z");
    expect(new Date(nyInstant("2027-03-15", OPEN_MIN)!).toISOString()).toBe("2027-03-15T13:30:00.000Z");
    expect(new Date(nyInstant("2026-10-12", closeMinute(false))!).toISOString()).toBe("2026-10-12T20:00:00.000Z");
    expect(nyInstant("not-a-day", OPEN_MIN)).toBeNull();
  });

  it("closes at 13:00 on a half day", () => {
    expect(closeMinute(true)).toBe(13 * 60);
    // 27 Nov 2026 is the half day after Thanksgiving, in standard time.
    expect(new Date(nyInstant("2026-11-27", closeMinute(true))!).toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });
});

describe("the session clock", () => {
  it("counts down to the open, then to the close, then stops", () => {
    expect(sessionClock(SESSION, false, at("2026-10-12T13:00:00Z"))).toEqual({ phase: "before", ms: 30 * 60_000 });
    expect(sessionClock(SESSION, false, at("2026-10-12T13:30:00Z"))).toEqual({ phase: "open", ms: 6.5 * 3_600_000 });
    expect(sessionClock(SESSION, false, at("2026-10-12T19:59:30Z"))).toEqual({ phase: "open", ms: 30_000 });
    expect(sessionClock(SESSION, false, at("2026-10-12T20:00:00Z"))).toEqual({ phase: "after", ms: null });
    // The weekend before: more than two days to the open.
    expect(sessionClock(SESSION, false, at("2026-10-10T05:00:00Z"))!.phase).toBe("before");
  });

  it("ends a half day at 13:00", () => {
    expect(sessionClock(SESSION, true, at("2026-10-12T17:00:00Z"))).toEqual({ phase: "after", ms: null });
    expect(sessionClock(SESSION, true, at("2026-10-12T16:59:00Z"))).toEqual({ phase: "open", ms: 60_000 });
  });

  it("writes a span as a clock under a day and as days and hours beyond", () => {
    expect(clockSpan(30_000)).toBe("0:00:30");
    expect(clockSpan(5 * 3_600_000 + 18 * 60_000 + 7_000)).toBe("5:18:07");
    expect(clockSpan(2 * 86_400_000 + 8 * 3_600_000 + 59 * 60_000)).toBe("2 d 8 h");
    expect(clockSpan(-5)).toBe("0:00:00");
  });
});

describe("the view that fits the clock", () => {
  it("is brief before the open, live in the session, review after the close", () => {
    expect(viewForClock(SESSION, false, at("2026-10-10T05:00:00Z"))).toBe("brief"); // Saturday
    expect(viewForClock(SESSION, false, at("2026-10-12T13:29:59Z"))).toBe("brief");
    expect(viewForClock(SESSION, false, at("2026-10-12T13:30:00Z"))).toBe("live");
    expect(viewForClock(SESSION, false, at("2026-10-12T19:59:59Z"))).toBe("live");
    expect(viewForClock(SESSION, false, at("2026-10-12T20:00:00Z"))).toBe("review");
    expect(viewForClock(SESSION, true, at("2026-10-12T17:00:00Z"))).toBe("review");
  });

  it("goes back to brief once New York's day has turned, when the edition is stale", () => {
    expect(viewForClock(SESSION, false, at("2026-10-13T03:59:00Z"))).toBe("review"); // 23:59 New York
    expect(viewForClock(SESSION, false, at("2026-10-13T04:00:00Z"))).toBe("brief");
  });

  it("recognises a view name and nothing else", () => {
    expect(isDeskView("live")).toBe(true);
    expect(isDeskView("classic")).toBe(false);
    expect(isDeskView(undefined)).toBe(false);
  });
});

describe("monitor helpers", () => {
  const spy = e.tickers.find((t) => t.symbol === "SPY")!;

  it("measures a price against the close in expected moves", () => {
    const close = spy.last!.close;
    const day = spy.expected_move!.day!;
    expect(movesFromClose(spy, close)).toBe(0);
    expect(movesFromClose(spy, close + day)).toBeCloseTo(1, 9);
    expect(movesFromClose(spy, close - day / 2)).toBeCloseTo(-0.5, 9);
    expect(movesFromClose(spy, null)).toBeNull();
    expect(movesFromClose({ ...spy, expected_move: null }, close)).toBeNull();
    expect(movesFromClose({ ...spy, last: null }, close)).toBeNull();
  });

  it("sorts by a number with missing values last both ways, and keeps ties in order", () => {
    const rows = [
      { k: "a", v: 2 },
      { k: "b", v: null },
      { k: "c", v: 1 },
      { k: "d", v: 2 },
      { k: "e", v: Number.NaN },
    ];
    expect(sortByNumber(rows, (r) => r.v, "asc").map((r) => r.k)).toEqual(["c", "a", "d", "b", "e"]);
    expect(sortByNumber(rows, (r) => r.v, "desc").map((r) => r.k)).toEqual(["a", "d", "c", "b", "e"]);
    expect(rows.map((r) => r.k)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("adds up one name's paper record", () => {
    const aapl = paperFor(e, "AAPL");
    expect(aapl.n).toBe(2);
    expect(aapl.wins).toBe(0);
    expect(aapl.totalR).toBeCloseTo(-1.156, 3);
    expect(paperFor(e, "GOOGL")).toEqual({ rows: [], n: 0, wins: 0, totalR: null });
    expect(paperFor({ ...e, paper: undefined }, "AAPL").n).toBe(0);
    // A corrupt stored edition can hold a row that is not a trade; the monitor must still be able to count.
    const corrupt = { ...e, paper: [null, ...e.paper!] } as unknown as Options;
    expect(paperFor(corrupt, "AAPL").n).toBe(2);
  });

  it("finds a named level", () => {
    expect(levelPrice(spy, "PDH")).toBeGreaterThan(0);
    expect(levelPrice(spy, "NOPE")).toBeNull();
    expect(levelPrice({ ...spy, levels: undefined }, "PDH")).toBeNull();
  });
});

describe("the map crosshair", () => {
  const spy = e.tickers.find((t) => t.symbol === "SPY")!;

  it("turns a height on the map into a price, and stays inside the plotted window", () => {
    // A window from 100 to 200 drawn between heights 10 (top) and 110 (bottom).
    expect(priceAtY(10, 100, 200, 10, 110)).toBe(200);
    expect(priceAtY(110, 100, 200, 10, 110)).toBe(100);
    expect(priceAtY(60, 100, 200, 10, 110)).toBe(150);
    expect(priceAtY(-50, 100, 200, 10, 110)).toBe(200);
    expect(priceAtY(999, 100, 200, 10, 110)).toBe(100);
    // A window with no height or no span cannot be read: the low is returned rather than NaN.
    expect(priceAtY(5, 100, 100, 10, 110)).toBe(100);
    expect(priceAtY(5, 100, 200, 10, 10)).toBe(100);
  });

  it("measures a price from the close in dollars, ATRs and expected moves", () => {
    const close = spy.last!.close;
    const zones = mapView(spy)!.zones;
    const at = mapReadout(spy, close + spy.atr14!, zones);
    expect(at.fromClose).toBeCloseTo(spy.atr14!, 9);
    expect(at.atrs).toBeCloseTo(1, 9);
    expect(at.moves).toBeCloseTo(spy.atr14! / spy.expected_move!.day!, 9);
    expect(mapReadout(spy, close, zones)).toMatchObject({ fromClose: 0, atrs: 0, moves: 0 });
  });

  it("names the zone a price is inside, the heaviest when two overlap, and none outside every zone", () => {
    const zones = mapView(spy)!.zones;
    const first = zones[0]!;
    const mid = (first.zone.lo + first.zone.hi) / 2;
    expect(mapReadout(spy, mid, zones).zone).not.toBeNull();
    const far = Math.max(...zones.map((z) => z.zone.hi)) + 1000;
    expect(mapReadout(spy, far, zones).zone).toBeNull();
    const light = { zone: { lo: 10, hi: 20, side: "support" as const, weight: 1 }, tone: "support" as const };
    const heavy = { zone: { lo: 15, hi: 25, side: "resistance" as const, weight: 6 }, tone: "resistance" as const };
    expect(mapReadout(spy, 17, [light, heavy]).zone).toBe(heavy);
    expect(mapReadout(spy, 17, [heavy, light]).zone).toBe(heavy);
    expect(mapReadout(spy, 12, [light, heavy]).zone).toBe(light);
  });

  it("leaves a distance unknown rather than wrong when the edition lacks what it needs", () => {
    const zones = mapView(spy)!.zones;
    expect(mapReadout({ ...spy, atr14: null }, 800, zones).atrs).toBeNull();
    expect(mapReadout({ ...spy, expected_move: null }, 800, zones).moves).toBeNull();
    expect(mapReadout({ ...spy, last: null }, 800, zones)).toMatchObject({ fromClose: null, atrs: null, moves: null });
  });
});
