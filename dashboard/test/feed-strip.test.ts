// The Options page's health strip and the Operations panel, as pure functions of the feed watch's stamps: the chips in
// order with their states, the server check redrawn from the page's own status poll, and the panel's words, which
// never turn missing or unreadable data into "on time".
import { describe, expect, it } from "vitest";
import { type Anchor, stripChips, stripClock, withStaleClock } from "@/components/client/feed-strip";
import { panelState } from "@/components/operations/feeds-panel";
import { evaluateStamped, type StampedInputs } from "@/lib/feed-watch";

const NOW = Date.parse("2026-11-12T16:01:00Z"); // 11:01 New York, a Thursday session
const stamps: StampedInputs = {
  stamps: {
    "options-edition": { status: "ok", value: { session: "2026-11-12", at: Date.parse("2026-11-11T22:10:00Z") } },
    "pre-open": { status: "ok", value: { session: "2026-11-12", at: Date.parse("2026-11-12T13:52:00Z") } },
    journal: { status: "ok", value: { session: "2026-11-12", at: NOW - 5 * 60_000 } },
  },
  refusals: {},
  shadow: { status: "ok", value: { on: true, switched_at: null, last_slot_end: Date.parse("2026-11-12T15:30:00Z") } },
};

describe("the strip", () => {
  it("six chips in order, from the server's stamps and the page's own polls", () => {
    const chips = stripChips({
      stamps,
      now: NOW,
      browserNow: NOW,
      prices: { status: "ok", receivedAt: NOW - 2_000 },
      bars: { status: "ok", receivedAt: NOW - 40_000 },
      evalStatus: null,
    });
    expect(chips.map((c) => [c.id, c.state, c.age])).toEqual([
      ["options-edition", "on_time", "17h"],
      ["pre-open", "on_time", "2h"],
      ["prices", "on_time", "2s"],
      ["bars", "on_time", "40s"],
      ["journal", "on_time", "5m"],
      ["shadow", "late", "31m"],
    ]);
  });

  it("the server check follows the page's own status read when there is one", () => {
    const chips = stripChips({
      stamps,
      now: NOW,
      browserNow: NOW,
      prices: { status: "loading", receivedAt: null },
      bars: { status: "loading", receivedAt: null },
      evalStatus: { eval: "log", last: Date.parse("2026-11-12T16:00:00Z") },
    });
    expect(chips.find((c) => c.id === "shadow")).toMatchObject({ state: "on_time", age: "1m" });
    expect(chips.find((c) => c.id === "prices")!.state).toBe("waiting");
    const off = stripChips({ stamps, now: NOW, browserNow: NOW, prices: { status: "off", receivedAt: null }, bars: { status: "off", receivedAt: null }, evalStatus: { eval: "off", last: null } });
    expect(off.map((c) => c.state)).toEqual(["on_time", "on_time", "failed", "not_expected", "on_time", "not_expected"]);
  });
});

describe("the strip's clock and its failing polls", () => {
  it("stays on true time across four hours of 60 s refreshes, each bringing a new server time", () => {
    // The page opens at 08:30 New York; true time, the server's clock and the monotonic clock all advance together, and
    // every minute a refresh re-renders with a new server time (a little later than the refresh started).
    const open = Date.parse("2026-11-12T13:30:00Z");
    let anchor: Anchor | null = null;
    let worst = 0;
    for (let s2 = 0; s2 <= 4 * 3600; s2 += 5) {
      const trueNow = open + s2 * 1000;
      const perf = 10_000 + s2 * 1000; // the monotonic clock started before the page
      if (s2 % 60 === 0) anchor = { server: trueNow - 250, perf, wall: trueNow + 7_000 }; // the server render is 250 ms old; the device 7 s fast
      const c = stripClock(anchor, anchor!.server, perf, trueNow + 7_000);
      worst = Math.max(worst, Math.abs(c.now - trueNow));
      expect(c.stale).toBe(false);
    }
    expect(worst).toBeLessThanOrEqual(2_000);
  });

  it("before any anchor (server render, hydration) it is the server's own time", () => {
    expect(stripClock(null, NOW, 123, 456)).toEqual({ now: NOW, stale: false });
    expect(stripClock({ server: NOW, perf: 0, wall: 0 }, NOW, null, null)).toEqual({ now: NOW, stale: false });
  });

  it("goes stale with no new server time for five minutes", () => {
    const a = { server: NOW, perf: 1_000, wall: NOW };
    expect(stripClock(a, NOW, 1_000 + 170_000, NOW + 170_000).stale).toBe(false);
    expect(stripClock(a, NOW, 1_000 + 300_000, NOW + 300_000)).toEqual({ now: NOW + 300_000, stale: true });
  });

  it("goes stale when the machine slept: the monotonic clock stood still while the wall clock moved eight hours", () => {
    const a = { server: NOW, perf: 1_000, wall: NOW };
    expect(stripClock(a, NOW, 1_000 + 5_000, NOW + 8 * 3_600_000)).toEqual({ now: NOW + 5_000, stale: true });
  });

  it("goes stale when the device's clock is changed by hand while the monotonic clock runs on", () => {
    const a = { server: NOW, perf: 1_000, wall: NOW };
    expect(stripClock(a, NOW, 61_000, NOW + 60_000 - 3_600_000).stale).toBe(true);
    expect(stripClock(a, NOW, 61_000, NOW + 60_000 + 20_000).stale).toBe(false); // 20 s of drift: within the limit
  });

  it("with a stale clock nothing time-dependent is presented as current, and nothing as on time", () => {
    const chips = stripChips({
      stamps,
      now: NOW,
      browserNow: NOW,
      prices: { status: "ok", receivedAt: NOW - 1_000 },
      bars: { status: "error", receivedAt: null },
      evalStatus: null,
    });
    const stale = withStaleClock(chips);
    expect(stale.map((c) => [c.id, c.state])).toEqual([
      ["options-edition", "checking"],
      ["pre-open", "checking"],
      ["prices", "checking"],
      ["bars", "failed"], // a failure is still shown as one
      ["journal", "checking"],
      ["shadow", "checking"],
    ]);
    expect(stale.some((c) => c.state === "on_time")).toBe(false);
  });

  it("the prices chip is never on time while the page is trying again (the retry line is up)", () => {
    const chips = stripChips({
      stamps,
      now: NOW,
      browserNow: NOW,
      prices: { status: "ok", receivedAt: NOW - 1_000, failing: true },
      bars: { status: "ok", receivedAt: NOW - 1_000, failed: true },
      evalStatus: null,
    });
    expect(chips.find((c) => c.id === "prices")!.state).toBe("late");
    expect(chips.find((c) => c.id === "bars")!.state).toBe("late");
  });

  it("past the calendar's end the polled chips say their schedule is assumed", () => {
    const t = Date.parse("2028-01-04T16:00:00Z");
    const chips = stripChips({ stamps, now: t, browserNow: t, prices: { status: "ok", receivedAt: t - 1_000 }, bars: { status: "off", receivedAt: null }, evalStatus: null });
    expect(chips.find((c) => c.id === "prices")).toMatchObject({ state: "on_time", assumed: true });
  });
});

describe("the Operations panel's words", () => {
  it("never says on time for a missing, unreadable or unread feed", () => {
    const missing = evaluateStamped({ stamps: { "options-edition": { status: "missing" } }, refusals: {}, shadow: null }, Date.parse("2026-11-12T23:00:00Z"));
    expect(panelState(missing.find((v) => v.id === "options-edition"))).toBe("late");
    const error = evaluateStamped({ stamps: { "options-edition": { status: "error" } }, refusals: {}, shadow: null }, Date.parse("2026-11-12T23:00:00Z"));
    expect(panelState(error.find((v) => v.id === "options-edition"))).toBe("error");
    expect(panelState(undefined)).toBe("error");
    // Nothing stored and nothing due yet (before 08:50): "nothing yet", not on time; once due and past its grace, late.
    const early = evaluateStamped({ stamps: { "pre-open": { status: "missing" } }, refusals: {}, shadow: null }, Date.parse("2026-11-12T13:00:00Z"));
    expect(panelState(early.find((v) => v.id === "pre-open"))).toBe("missing");
    const due = evaluateStamped({ stamps: { "pre-open": { status: "missing" } }, refusals: {}, shadow: null }, Date.parse("2026-11-12T14:10:00Z"));
    expect(panelState(due.find((v) => v.id === "pre-open"))).toBe("late");
  });
});
