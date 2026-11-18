import { describe, expect, it } from "vitest";
import { DONE_TONE, DONE_WORDS, doneButtonState, undoLeft } from "@/lib/done-view";

describe("the Done for today button's state", () => {
  it("is a plain outline on an open day", () => {
    const s = doneButtonState({ unchecked: false, failed: false, limitReached: false });
    expect(s).toBe("open");
    expect(DONE_TONE[s]).toBe("neutral");
    expect(DONE_WORDS[s]).toBe("Done for today");
  });
  it("asks, in amber, once the day's limit is reached: a suggestion, never set by itself", () => {
    const s = doneButtonState({ unchecked: false, failed: false, limitReached: true });
    expect(s).toBe("limit");
    expect(DONE_TONE[s]).toBe("warn");
    expect(DONE_WORDS[s]).toBe("Day over: mark done?");
  });
  it("a failed save is red and wins; a flag that could not be read is amber", () => {
    expect(doneButtonState({ unchecked: true, failed: true, limitReached: true })).toBe("failed");
    expect(DONE_TONE.failed).toBe("bad");
    expect(doneButtonState({ unchecked: true, failed: false, limitReached: true })).toBe("unchecked");
    expect(DONE_TONE.unchecked).toBe("warn");
  });
});

describe("undoLeft", () => {
  it("counts the window down in whole seconds, rounding up, with the share left", () => {
    expect(undoLeft(61_000, 1_000, 60_000)).toEqual({ s: 60, share: 1 });
    expect(undoLeft(61_000, 31_500, 60_000)).toEqual({ s: 30, share: 29_500 / 60_000 });
    expect(undoLeft(61_000, 70_000, 60_000)).toEqual({ s: 0, share: 0 });
  });
  it("never reads more than the window, even from a clock a moment behind", () => {
    expect(undoLeft(60_500, 0, 60_000)).toEqual({ s: 60, share: 1 });
  });
  it("is nothing without a window, or before the browser's clock is read", () => {
    expect(undoLeft(null, 1, 60_000)).toBeNull();
    expect(undoLeft(5, null, 60_000)).toBeNull();
  });
});
