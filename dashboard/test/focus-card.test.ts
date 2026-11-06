// The focus card's small pure decisions (lib/focus-card.ts): the strip emphasis, the live distance a strip shows (and
// never a stale one), when an alternative chip lights up, and the rules as chips with their New York times.
import { describe, expect, it } from "vitest";
import { altChips, altIsLive, type CardBoardRead, ruleChips, stripDistance, stripEmphasis } from "@/lib/focus-card";
import { CONNECTING_CAPTION, type LadderLiveView, OFF_CAPTION, triggerDistances } from "@/lib/level-ladder";
import type { RowView } from "@/lib/trade-now";

const view = (from: LadderLiveView["from"], price = 778.9): LadderLiveView => ({
  dot: from ? { kind: from === "live" ? "live" : "pre", price, label: "live 10:02" } : null,
  caption: from ? null : OFF_CAPTION,
  distances: from ? triggerDistances(price, 779.4, 775.16, 6.26, 5) : [],
  from,
});

describe("strip emphasis", () => {
  it("emphasises the side the board points at and mutes the other; both alike when it points at neither", () => {
    expect(stripEmphasis("call", "call")).toBe("on");
    expect(stripEmphasis("put", "call")).toBe("off");
    expect(stripEmphasis("put", null)).toBe("none");
  });
});

describe("the strip's live distance", () => {
  it("reads the call's distance to the ceiling and the put's to the floor, split into the big and the small part", () => {
    expect(stripDistance(view("live"), "call")).toEqual({ away: "0.50 away", move: "0.1× move", past: false, from: "live", near: true, unlikely: false });
    expect(stripDistance(view("live"), "put")).toEqual({ away: "3.74 away", move: "0.7× move", past: false, from: "live", near: false, unlikely: false });
  });

  it("says past once the price is through the trigger", () => {
    expect(stripDistance(view("live", 780.65), "call")).toMatchObject({ away: "+0.2 ATR past", move: null, past: true });
  });

  it("keeps where it is measured from: the pre-market price before the open", () => {
    expect(stripDistance(view("pre"), "call")?.from).toBe("pre");
  });

  it("shows nothing, never a stale number, when the view has no distance", () => {
    expect(stripDistance(view(null), "call")).toBeNull();
    expect(stripDistance({ dot: null, caption: CONNECTING_CAPTION, distances: [], from: null }, "put")).toBeNull();
    // A view with distances but no source is not trusted either.
    expect(stripDistance({ ...view("live"), from: null }, "call")).toBeNull();
  });
});

describe("the alternative chips", () => {
  const item = { symbol: "QQQ", rank: 1, bias: "support" as const, resistance: { price: 712.5, name: "PDH" }, support: { price: 704.1, name: "PWL" }, atr: 9.1 };
  const read = (alt: RowView["badge"]["alt"], side: RowView["badge"]["side"], paused = false): CardBoardRead => ({
    view: { badge: { word: "Alternative", tone: "warn", side, alt }, testing: true, headline: "", grid: null },
    paused,
  });

  it("are the four alternatives in the engine's order, each with its word, side and level", () => {
    expect(altChips(item).map((a) => `${a.word} ${a.level.toFixed(2)}`)).toEqual([
      "Failed break · put 712.50",
      "Failed break · call 704.10",
      "Sweep · put 712.50",
      "Sweep · call 704.10",
    ]);
    expect(altChips({ ...item, atr: undefined })).toEqual([]);
  });

  it("light up only for the very alternative the board shows live, and never while paused", () => {
    expect(altIsLive(read("failed_break", "put"), "failed_break", "put")).toBe(true);
    expect(altIsLive(read("failed_break", "put"), "failed_break", "call")).toBe(false);
    expect(altIsLive(read("failed_break", "put"), "sweep_reclaim", "put")).toBe(false);
    expect(altIsLive(read("failed_break", "put", true), "failed_break", "put")).toBe(false);
    expect(altIsLive(read(null, "put"), "failed_break", "put")).toBe(false);
    expect(altIsLive(null, "failed_break", "put")).toBe(false);
  });
});

describe("the rules as chips", () => {
  it("say the New York no-entry times, the premium cap, the time stop and the day's maximum", () => {
    expect(ruleChips("2026-10-19", false).map((c) => c.text)).toEqual([
      "No entries before 09:35",
      "No entries 11:30–13:00",
      "Option under $2.00",
      "Out after 5 min",
      "Max 5 a day",
    ]);
  });

  it("drop the lunch chip on a half day, and the time chips for a session that is not a day", () => {
    expect(ruleChips("2026-11-27", true).map((c) => c.key)).toEqual(["first", "premium", "time", "max"]);
    expect(ruleChips("not a day", false).map((c) => c.key)).toEqual(["premium", "time", "max"]);
  });
});
