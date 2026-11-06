import { describe, expect, it } from "vitest";
import {
  altTriggers,
  chartLevels,
  CHART_LINES_MAX,
  expiryNote,
  focusPlan,
  levelWords,
  noEntryTimes,
} from "@/lib/focus-plan";
import { BAR_MINUTES, FAIL_WITHIN_BARS, SWEEP_MIN_ATR } from "@/lib/entry-checks";
import { focusOptions } from "@/lib/fixture-variants";
import { runnerLine } from "@/lib/trade-now";
import { altAt, type Bar2 } from "@/lib/trade-state";
import type { Options } from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

// The focus card's plan in plain words: entry just through the level, the stop a tenth of the day's range back on the
// other side, the first target at twice the risk (the 2:1 rule), then the next named level.
describe("focus plan", () => {
  const nvda = {
    symbol: "NVDA",
    rank: 1,
    bias: "support" as const,
    atr: 6.16,
    resistance: { price: 212.85, name: "PWL" },
    support: { price: 211.26, name: "PDL/WTDL" },
    breakout_above: 212.85,
    hold_above: 211.26,
    target_up: { price: 218.88, name: "PDH" },
    target_down: { price: 203.56, name: "MA200" },
  };

  it("works out a call above the ceiling and a put below the floor", () => {
    const { call, put } = focusPlan(nvda);
    expect(call).toMatchObject({
      level: 212.85,
      entry: 212.91,
      stop: 212.23,
      target1: 214.27,
      target2: { price: 218.88, name: "PDH" },
    });
    expect(put).toMatchObject({
      level: 211.26,
      entry: 211.2,
      stop: 211.88,
      target1: 209.84,
      target2: { price: 203.56, name: "MA200" },
    });
  });

  it("keeps the trigger and stop wording without a day range, and drops a next level inside the first target", () => {
    const { call } = focusPlan({ ...nvda, atr: null });
    expect(call).toMatchObject({
      level: 212.85,
      entry: null,
      stop: null,
      target1: null,
      target2: { price: 218.88 },
    });
    const near = focusPlan({
      ...nvda,
      target_up: { price: 213.5, name: "PDH" },
    });
    expect(near.call?.target2).toBeNull();
  });

  it("has no side without its level", () => {
    expect(focusPlan({ symbol: "SPY", rank: 1, bias: "range" })).toEqual({
      call: null,
      put: null,
    });
  });

  it("writes the level codes out", () => {
    expect(levelWords("PDL/WTDL")).toBe(
      "yesterday's low, this week's low so far",
    );
    expect(levelWords("MA200")).toBe("200-day average price");
    expect(levelWords("XYZ")).toBe("XYZ");
    expect(levelWords(null)).toBe("");
  });

  it("writes out the pre-market and DEC-0041 research codes, keeping PMH / PML as last month's", () => {
    expect(levelWords("PMH/PMKH")).toBe("last month's high, pre-market high");
    expect(levelWords("PML/PMKL")).toBe("last month's low, pre-market low");
    expect(levelWords("ONH/ONL")).toBe("overnight high, overnight low");
    expect(levelWords("SWH/SWL")).toBe("five-day high, five-day low");
    expect(levelWords("EVH/EVL")).toBe(
      "last big-news day's high, last big-news day's low",
    );
    expect(levelWords("GAPH/GAPL")).toBe(
      "top of today's gap, bottom of today's gap",
    );
    expect(levelWords("ATH")).toBe("14-month high");
  });

  it("puts the no-entry times in New York, the same on both sides of the daylight-saving changes", () => {
    for (const day of ["2026-10-23", "2026-11-03", "2026-07-01"])
      expect(noEntryTimes(day)).toEqual({
        firstEntry: "09:35",
        lunchFrom: "11:30",
        lunchTo: "13:00",
      });
    expect(noEntryTimes("bad")).toBeNull();
  });
});

// AVGO and AMD list options on Monday, Wednesday and Friday only (DEC-0038): the card says so, and nothing for the rest.
describe("expiry note", () => {
  it("tells a Tuesday or Thursday to take the next day's expiry", () => {
    expect(expiryNote("AVGO", "2026-10-27")).toMatch(
      /^No options expire today: use the next day's expiry and size down\. .*over \$2\.00/,
    );
    expect(expiryNote("AMD", "2026-10-29")).toMatch(/^No options expire today/);
  });

  it("says the options expire today on a Monday, Wednesday or Friday", () => {
    for (const d of ["2026-10-26", "2026-10-28", "2026-10-30"])
      expect(expiryNote("AVGO", d)).toMatch(/^Options expire today\./);
  });

  it("is null for names with a contract every session, and for a bad session", () => {
    expect(expiryNote("SPY", "2026-10-27")).toBeNull();
    expect(expiryNote("TSLA", "2026-10-27")).toBeNull();
    expect(expiryNote("AVGO", null)).toBeNull();
    expect(expiryNote("AVGO", "27 Oct")).toBeNull();
  });
});

// The lines the owner draws on the chart beside the card, in one fixed colour code. SPY from the fixture: ceiling
// 779.40 (PDH), floor 775.16 (PDL), ATR 6.26; its levels put last month's high 2 cents under the floor and last week's
// high on the one-year high.
describe("chart lines", () => {
  const e = focusOptions(optionsJson as unknown as Options);
  const spy = e.focus!.items.find((i) => i.symbol === "SPY")!;
  const levels = e.tickers.find((t) => t.symbol === "SPY")!.levels;
  const nvda = {
    symbol: "NVDA",
    rank: 1,
    bias: "support" as const,
    atr: 6.16,
    resistance: { price: 212.85, name: "PWL" },
    support: { price: 211.26, name: "PDL/WTDL" },
    target_up: { price: 218.88, name: "PDH" },
    target_down: { price: 203.56, name: "MA200" },
  };

  it("lists at most six lines, highest first, with the triggers, both first targets and the nearest levels", () => {
    const lines = chartLevels(spy, levels);
    expect(lines.map((l) => [l.price, l.kind])).toEqual([
      [781.62, "month"],
      [780.84, "target"],
      [779.4, "ceiling"],
      [775.16, "floor"],
      [773.72, "target"],
      [769.63, "week"],
    ]);
    expect(lines.length).toBeLessThanOrEqual(CHART_LINES_MAX);
  });

  it("joins levels on the same line: the floor keeps it, and a target on a level says so", () => {
    const lines = chartLevels(spy, levels);
    expect(lines.find((l) => l.kind === "floor")).toMatchObject({
      codes: ["PDL", "PMH"],
      targets: [],
    });
    expect(lines.find((l) => l.price === 781.62)).toMatchObject({
      codes: expect.arrayContaining(["PWH", "52WH"]),
      targets: ["call target 2"],
    });
    expect(lines.find((l) => l.price === 769.63)).toMatchObject({
      kind: "week",
      targets: ["put target 2"],
    });
  });

  it("treats PMH / PML as last month's, never draws averages, yesterday's close or zones, and leaves far levels off", () => {
    const lines = chartLevels(spy, levels);
    const codes = lines.flatMap((l) => l.codes);
    for (const c of ["MA20", "MA50", "MA200", "PDC", "DEMAND", "52WL"])
      expect(codes).not.toContain(c);
    expect(lines.some((l) => l.price === 749.6)).toBe(false); // last month's low, 4 ATRs under the floor
    expect(
      chartLevels(spy, [{ name: "PML", price: 772, tf: "month", weight: 1 }]).find(
        (l) => l.price === 772,
      )?.kind,
    ).toBe("month");
  });

  it("draws the 14-month high as a month line and a five-day high as a week line, never the intraday research codes", () => {
    const lines = chartLevels(spy, [
      { name: "ATH", price: 782, tf: "52w", weight: 1 },
      { name: "SWL", price: 772, tf: "week", weight: 1 },
      { name: "ONH", price: 781, tf: "day", weight: 1 },
      { name: "GAPL", price: 774, tf: "day", weight: 1 },
    ]);
    expect(lines.find((l) => l.price === 782)?.kind).toBe("month");
    expect(lines.find((l) => l.price === 772)?.kind).toBe("week");
    expect(lines.some((l) => l.price === 781 || l.price === 774)).toBe(false);
  });

  it("leaves week and month levels inside the no-trade box off", () => {
    const lines = chartLevels(spy, [
      { name: "PWL", price: 777, tf: "week", weight: 1 },
    ]);
    expect(lines.some((l) => l.price === 777)).toBe(false);
  });

  it("keeps the triggers and first targets when it has to cut", () => {
    const lines = chartLevels(spy, levels, 4);
    expect(lines.map((l) => l.price)).toEqual([780.84, 779.4, 775.16, 773.72]);
  });

  it("draws the triggers and targets without levels, nothing without triggers, and no first target without a day range", () => {
    expect(chartLevels(nvda, undefined).map((l) => l.kind)).toEqual([
      "target",
      "target",
      "ceiling",
      "floor",
      "target",
      "target",
    ]);
    expect(
      chartLevels({ symbol: "SPY", rank: 1, bias: "range" }, levels),
    ).toEqual([]);
    const noAtr = chartLevels({ ...nvda, atr: null }, undefined);
    expect(noAtr.flatMap((l) => l.targets)).toEqual([
      "call target 2",
      "put target 2",
    ]);
  });
});

// "Also watch" on the focus card: the two other triggers under test, as conditions, with the engine's own numbers.
describe("the card's other triggers", () => {
  const item = {
    symbol: "QQQ",
    rank: 1,
    bias: "breakout" as const,
    atr: 9.1,
    resistance: { price: 412.3, name: "PDH" },
    support: { price: 405.1, name: "PDL" },
  };

  it("lists all four the engine can raise, in order: both failed breaks, then both sweeps", () => {
    const alts = altTriggers(focusPlan(item), item.atr);
    expect(alts.map((a) => [a.kind, a.side, a.level])).toEqual([
      ["failed_break", "put", 412.3],
      ["failed_break", "call", 405.1],
      ["sweep_reclaim", "put", 412.3],
      ["sweep_reclaim", "call", 405.1],
    ]);
    expect(alts.map((a) => a.line)).toEqual([
      "Failed break: if it closes above 412.30 and back below within 3 bars (6 min), a put under 412.30, stop above the push high",
      "Failed break: if it closes below 405.10 and back above within 3 bars (6 min), a call above 405.10, stop below the push low",
      "Sweep: if it rises at least 0.25 × the 2-min ATR over 412.30 and closes back at or below it, a put under 412.30, stop above the sweep high",
      "Sweep: if it drops at least 0.25 × the 2-min ATR under 405.10 and closes back at or above it, a call above 405.10, stop below the sweep low",
    ]);
  });

  it("mirrors the engine: altAt raises each one, at that level and on that side", () => {
    const plan = focusPlan(item);
    const t0 = Date.parse("2026-10-12T14:00:00Z");
    const bars = (cs: [number, number, number][]): Bar2[] =>
      cs.map(([h, l, c], i) => ({ start: t0 + i * 120_000, end: t0 + (i + 1) * 120_000, o: c, h, l, c }));
    const raised = (level: number, planSide: "call" | "put", b: Bar2[]) => {
      const a = altAt(level, planSide, b, 1);
      return a ? [a.kind, a.side, a.level] : null;
    };
    const C = plan.call!.level;
    const F = plan.put!.level;
    const got = [
      raised(C, "call", bars([[C, C - 0.5, C - 0.2], [C + 0.4, C - 0.1, C + 0.3], [C + 0.1, C - 0.4, C - 0.2]])), // closes above, then back below
      raised(F, "put", bars([[F + 0.5, F, F + 0.2], [F + 0.1, F - 0.4, F - 0.3], [F + 0.4, F - 0.1, F + 0.2]])), // closes below, then back above
      raised(C, "call", bars([[C, C - 0.5, C - 0.2], [C + SWEEP_MIN_ATR, C - 0.3, C]])), // reaches the ATR share over it, closes at it
      raised(F, "put", bars([[F + 0.5, F, F + 0.2], [F + 0.3, F - SWEEP_MIN_ATR, F]])), // reaches the ATR share under it, closes at it
    ];
    expect(got).toEqual(altTriggers(plan, item.atr).map((a) => [a.kind, a.side, a.level]));
  });

  it("uses the engine's constants", () => {
    const alts = altTriggers(focusPlan(item), item.atr);
    for (const a of alts.filter((x) => x.kind === "failed_break")) expect(a.line).toContain(`within ${FAIL_WITHIN_BARS} bars (${FAIL_WITHIN_BARS * BAR_MINUTES} min)`);
    for (const a of alts.filter((x) => x.kind === "sweep_reclaim")) expect(a.line).toContain(`at least ${SWEEP_MIN_ATR} × the ${BAR_MINUTES}-min ATR`);
  });

  it("has one per level present, and none without the plan's ATR", () => {
    expect(altTriggers({ ...focusPlan(item), put: null }, 9.1).map((a) => [a.kind, a.side])).toEqual([
      ["failed_break", "put"],
      ["sweep_reclaim", "put"],
    ]);
    expect(altTriggers({ ...focusPlan(item), call: null }, 9.1).map((a) => [a.kind, a.side])).toEqual([
      ["failed_break", "call"],
      ["sweep_reclaim", "call"],
    ]);
    expect(altTriggers(focusPlan(item), null)).toEqual([]);
    expect(altTriggers(focusPlan(item), 0)).toEqual([]);
  });

  it("writes the runner line from the side's own plan, with the half-day flat time", () => {
    const { call, put } = focusPlan(item);
    expect(runnerLine(call, false)).toBe(
      `Sell half at ${call!.target1!.toFixed(2)}, stop to ${call!.entry!.toFixed(2)}, trail the rest under the 2-min EMA9 to the next level or 15:10. Needs 2 contracts within your $50 risk; otherwise skip.`,
    );
    expect(runnerLine(put, true)).toContain("or 12:10.");
    expect(runnerLine({ ...call!, target1: null }, false)).toBeNull();
    expect(runnerLine(null, false)).toBeNull();
  });
});
