// The Options page's health strip and the Operations panel, as pure functions of the feed watch's stamps: the chips in
// order with their states, the server check redrawn from the page's own status poll, and the panel's words, which
// never turn missing or unreadable data into "on time".
import { describe, expect, it } from "vitest";
import { stripChips, stripNow } from "@/components/client/feed-strip";
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
  it("runs on the server's render time and the monotonic clock: a device clock an hour off changes nothing", () => {
    expect(stripNow(NOW, 1_000, 61_000)).toBe(NOW + 60_000);
    expect(stripNow(NOW, null, 61_000)).toBe(NOW);
    expect(stripNow(NOW, 1_000, null)).toBe(NOW);
    expect(stripNow(NOW, 5_000, 4_000)).toBe(NOW); // never backwards
    // The chips are the same whatever the device's wall clock says; only browserNow (for the polls' ages) is the
    // device's, and the ages there are differences of the device's own readings.
    const base = { stamps, now: stripNow(NOW, 0, 0), prices: { status: "loading" as const, receivedAt: null }, bars: { status: "off" as const, receivedAt: null }, evalStatus: null };
    const states = (browserNow: number) => stripChips({ ...base, browserNow }).map((c) => c.state);
    expect(states(NOW - 3_600_000)).toEqual(states(NOW));
    expect(states(NOW + 3_600_000)).toEqual(states(NOW));
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
