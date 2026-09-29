import { describe, expect, it } from "vitest";
import { bearerMatches } from "@/lib/auth";
import { scrubMoney } from "@/lib/ntfy";
import { evaluate, historyToPrune, INITIAL_STATE, parseState, sameState, type AlertState } from "@/lib/watchdog";
import { cleanSnapshot } from "./helpers";

// Window 2026-09-29 11:30Z-22:00Z; the snapshot's as_of is 12:00Z.
const snap = cleanSnapshot();
const at = (iso: string) => new Date(iso);
const state = (over: Partial<AlertState> = {}): AlertState => ({
  ...INITIAL_STATE,
  last_prune_day: "2026-09-29",
  last_offline_day: null,
  ...over,
});

describe("watchdog state machine", () => {
  it("stays quiet while fresh", () => {
    const d = evaluate(snap, state(), at("2026-09-29T12:30:00Z"));
    expect(d.notices).toEqual([]);
    expect(d.next.level).toBe("ok");
  });

  it("pages 'late' after 35 minutes in a window, once", () => {
    const d1 = evaluate(snap, state(), at("2026-09-29T12:40:00Z"));
    expect(d1.notices).toHaveLength(1);
    expect(d1.notices[0]).toMatchObject({ kind: "late", priority: 4, title: "Dashboard late: no update for 40 min" });
    expect(d1.next).toMatchObject({ level: "late", window: "2026-09-29", since: "2026-09-29T12:40:00.000Z" });

    const d2 = evaluate(snap, d1.next, at("2026-09-29T13:00:00Z"));
    expect(d2.notices).toEqual([]);
    expect(d2.next.level).toBe("late");
  });

  it("escalates to 'stopped' after 90 minutes, then recovers", () => {
    const late = evaluate(snap, state(), at("2026-09-29T12:40:00Z")).next;
    const d = evaluate(snap, late, at("2026-09-29T13:31:00Z"));
    expect(d.notices).toHaveLength(1);
    expect(d.notices[0]).toMatchObject({ kind: "stopped", priority: 4, title: "Dashboard stopped: no update for 91 min" });
    expect(d.next).toMatchObject({ level: "stopped", since: "2026-09-29T12:40:00.000Z" });

    // Still stopped: no repeat.
    expect(evaluate(snap, d.next, at("2026-09-29T14:00:00Z")).notices).toEqual([]);

    // A new snapshot arrives.
    const fresh = cleanSnapshot({ as_of: "2026-09-29T14:05:00+00:00" });
    const r = evaluate(fresh, d.next, at("2026-09-29T14:10:00Z"));
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ kind: "recovered", priority: 2, title: "Dashboard recovered" });
    expect(r.next).toMatchObject({ level: "ok", window: null, since: null });
  });

  it("jumps straight to 'stopped' when first seen past 90 minutes", () => {
    const d = evaluate(snap, state(), at("2026-09-29T14:00:00Z"));
    expect(d.notices.map((n) => n.kind)).toEqual(["stopped"]);
  });

  it("sends 'recovered' only if an alert fired before", () => {
    expect(evaluate(snap, state(), at("2026-09-29T12:05:00Z")).notices).toEqual([]);
  });

  it("does not page outside every window, and remembers the open alert", () => {
    const stopped = state({ level: "stopped", window: "2026-09-29", since: "2026-09-29T13:31:00.000Z" });
    const d = evaluate(snap, stopped, at("2026-09-29T23:00:00Z"));
    expect(d.notices).toEqual([]);
    expect(d.next.level).toBe("stopped");
    const quiet = evaluate(snap, state(), at("2026-09-30T02:00:00Z"));
    expect(quiet.notices).toEqual([]);
  });

  it("pages again in the next trading window if the Mac is still silent", () => {
    const s = cleanSnapshot({
      expected_windows: [
        { session: "2026-09-29", start: "2026-09-29T11:30:00+00:00", end: "2026-09-29T22:00:00+00:00" },
        { session: "2026-09-30", start: "2026-09-30T11:30:00+00:00", end: "2026-09-30T22:00:00+00:00" },
      ],
    });
    const prev = state({ level: "stopped", window: "2026-09-29", since: "2026-09-29T13:31:00.000Z" });
    const d = evaluate(s, prev, at("2026-09-30T11:40:00Z"));
    expect(d.notices.map((n) => n.kind)).toEqual(["stopped"]);
    expect(d.next.window).toBe("2026-09-30");
  });

  it("sends at most one 'Mac offline' note per UTC day after 48 h with every window ended", () => {
    const now = at("2026-10-01T13:00:00Z"); // 49 h after as_of
    const d1 = evaluate(snap, state(), now);
    expect(d1.notices).toHaveLength(1);
    expect(d1.notices[0]).toMatchObject({ kind: "offline", priority: 2, title: "Mac offline for 2 days" });
    expect(d1.next.last_offline_day).toBe("2026-10-01");

    expect(evaluate(snap, d1.next, at("2026-10-01T23:50:00Z")).notices).toEqual([]);

    const d3 = evaluate(snap, d1.next, at("2026-10-02T00:10:00Z"));
    expect(d3.notices.map((n) => n.title)).toEqual(["Mac offline for 2 days"]);
    const d4 = evaluate(snap, d3.next, at("2026-10-03T13:00:00Z"));
    expect(d4.notices.map((n) => n.title)).toEqual(["Mac offline for 4 days"]);
  });

  it("is not 'offline' before 48 h, or while a window is still ahead", () => {
    expect(evaluate(snap, state(), at("2026-10-01T11:00:00Z")).notices).toEqual([]);
    const ahead = cleanSnapshot({
      expected_windows: [{ session: "2026-10-09", start: "2026-10-09T11:30:00+00:00", end: "2026-10-09T22:00:00+00:00" }],
    });
    expect(evaluate(ahead, state(), at("2026-10-02T13:00:00Z")).notices).toEqual([]);
  });

  it("does nothing without a snapshot or an as_of", () => {
    expect(evaluate(null, state(), at("2026-09-29T12:40:00Z")).notices).toEqual([]);
    const noTime = cleanSnapshot({ as_of: null });
    expect(evaluate(noTime, state(), at("2026-09-29T12:40:00Z")).notices).toEqual([]);
  });

  it("asks for a history prune once per UTC day", () => {
    const d1 = evaluate(snap, state({ last_prune_day: "2026-09-28" }), at("2026-09-29T12:05:00Z"));
    expect(d1.prune).toBe(true);
    expect(d1.next.last_prune_day).toBe("2026-09-29");
    expect(evaluate(snap, d1.next, at("2026-09-29T12:15:00Z")).prune).toBe(false);
  });

  it("keeps page text free of money amounts", () => {
    const all = [
      evaluate(snap, state(), at("2026-09-29T12:40:00Z")),
      evaluate(snap, state(), at("2026-09-29T14:00:00Z")),
      evaluate(snap, state(), at("2026-10-01T13:00:00Z")),
      evaluate(cleanSnapshot({ as_of: "2026-09-29T14:05:00+00:00" }), state({ level: "late" }), at("2026-09-29T14:10:00Z")),
    ].flatMap((d) => d.notices);
    expect(all).toHaveLength(4);
    for (const n of all) {
      expect(`${n.title} ${n.message}`).not.toContain("$");
      expect(n.title).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("history pruning", () => {
  it("selects date folders older than 90 days", () => {
    const blobs = [
      { pathname: "snapshots/history/2026-06-30/23.json" },
      { pathname: "snapshots/history/2026-07-01/00.json" },
      { pathname: "snapshots/history/2026-09-29/12.json" },
      { pathname: "snapshots/latest.json" },
      { pathname: "snapshots/history/not-a-date/01.json" },
    ];
    expect(historyToPrune(blobs, at("2026-09-29T05:00:00Z")).map((b) => b.pathname)).toEqual([
      "snapshots/history/2026-06-30/23.json",
    ]);
  });
});

describe("alert state persistence", () => {
  it("parses tolerantly", () => {
    expect(parseState(null)).toEqual(INITIAL_STATE);
    expect(parseState("{not json")).toEqual(INITIAL_STATE);
    expect(parseState('{"level":"bogus","window":7}')).toEqual(INITIAL_STATE);
    const s = { level: "late", window: "2026-09-29", since: "x", last_offline_day: null, last_prune_day: "2026-09-29" };
    expect(parseState(JSON.stringify(s))).toEqual(s);
  });

  it("compares states field by field", () => {
    expect(sameState(state(), state())).toBe(true);
    expect(sameState(state(), state({ level: "late" }))).toBe(false);
  });
});

describe("helpers", () => {
  it("scrubs currency amounts", () => {
    expect(scrubMoney("down $1,234.50 today, US$3 risk, 0.5R")).toBe("down [amount] today, [amount] risk, 0.5R");
    expect(scrubMoney("cost $")).toBe("cost ");
  });

  it("compares the cron bearer token in constant time and fails closed", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
    expect(bearerMatches(null, "s3cret")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer undefined", undefined)).toBe(false);
  });
});
