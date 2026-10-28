import { describe, expect, it } from "vitest";
import { expiryNote, focusPlan, levelWords, noEntryTimes } from "@/lib/focus-plan";

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
    expect(call).toMatchObject({ level: 212.85, entry: 212.91, stop: 212.23, target1: 214.27, target2: { price: 218.88, name: "PDH" } });
    expect(put).toMatchObject({ level: 211.26, entry: 211.2, stop: 211.88, target1: 209.84, target2: { price: 203.56, name: "MA200" } });
  });

  it("keeps the trigger and stop wording without a day range, and drops a next level inside the first target", () => {
    const { call } = focusPlan({ ...nvda, atr: null });
    expect(call).toMatchObject({ level: 212.85, entry: null, stop: null, target1: null, target2: { price: 218.88 } });
    const near = focusPlan({ ...nvda, target_up: { price: 213.5, name: "PDH" } });
    expect(near.call?.target2).toBeNull();
  });

  it("has no side without its level", () => {
    expect(focusPlan({ symbol: "SPY", rank: 1, bias: "range" })).toEqual({ call: null, put: null });
  });

  it("writes the level codes out", () => {
    expect(levelWords("PDL/WTDL")).toBe("yesterday's low, this week's low so far");
    expect(levelWords("MA200")).toBe("200-day average price");
    expect(levelWords("XYZ")).toBe("XYZ");
    expect(levelWords(null)).toBe("");
  });

  it("puts the no-entry times in Sydney, across both daylight-saving changes", () => {
    expect(noEntryTimes("2026-10-23")).toEqual({ firstEntry: "00:35", lunchFrom: "02:30", lunchTo: "04:00" });
    expect(noEntryTimes("2026-11-03")).toEqual({ firstEntry: "01:35", lunchFrom: "03:30", lunchTo: "05:00" });
    expect(noEntryTimes("2026-07-01")).toEqual({ firstEntry: "23:35", lunchFrom: "01:30", lunchTo: "03:00" });
    expect(noEntryTimes("bad")).toBeNull();
  });
});

// AVGO and AMD list options on Monday, Wednesday and Friday only (DEC-0038): the card says so, and nothing for the rest.
describe("expiry note", () => {
  it("tells a Tuesday or Thursday to take the next day's expiry", () => {
    expect(expiryNote("AVGO", "2026-10-27")).toMatch(/^No options expire today: use the next day's expiry and size down\. .*over \$2\.00/);
    expect(expiryNote("AMD", "2026-10-29")).toMatch(/^No options expire today/);
  });

  it("says the options expire today on a Monday, Wednesday or Friday", () => {
    for (const d of ["2026-10-26", "2026-10-28", "2026-10-30"]) expect(expiryNote("AVGO", d)).toMatch(/^Options expire today\./);
  });

  it("is null for names with a contract every session, and for a bad session", () => {
    expect(expiryNote("SPY", "2026-10-27")).toBeNull();
    expect(expiryNote("TSLA", "2026-10-27")).toBeNull();
    expect(expiryNote("AVGO", null)).toBeNull();
    expect(expiryNote("AVGO", "27 Oct")).toBeNull();
  });
});
