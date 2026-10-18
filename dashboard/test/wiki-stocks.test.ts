// The Stocks wiki's feeds and the host's code: whether each page's data arrived on time, and when the host needs a deploy.
import { describe, expect, it } from "vitest";
import { hostCode, stocksFeeds, type FeedInputs } from "@/components/wiki/stocks";
import { afterRunFresh, everyFresh, journalFresh, lastWeekdayUtc, utcToNy } from "@/lib/wiki";
import type { Snapshot } from "@/lib/types";

describe("feed clocks", () => {
  it("finds the newest weekday run at a UTC time, skipping the weekend", () => {
    // Sunday 18 Oct 2026, 00:00 UTC: the newest weekday 21:38 run was Friday's.
    expect(lastWeekdayUtc(new Date("2026-10-18T00:00:00Z"), 21, 38).toISOString()).toBe("2026-10-16T21:38:00.000Z");
    // Monday before the run: still Friday's. Monday after it: Monday's.
    expect(lastWeekdayUtc(new Date("2026-10-19T12:00:00Z"), 21, 38).toISOString()).toBe("2026-10-16T21:38:00.000Z");
    expect(lastWeekdayUtc(new Date("2026-10-19T22:00:00Z"), 21, 38).toISOString()).toBe("2026-10-19T21:38:00.000Z");
  });

  it("gives an after-close run its grace before calling it late", () => {
    const now = new Date("2026-10-19T21:50:00Z");
    // Twelve minutes after Monday's 21:38 run, Friday's copy is still on time; forty minutes after, it is late.
    expect(afterRunFresh("2026-10-16T21:40:00Z", now, 21, 38, 30)).toBe(true);
    expect(afterRunFresh("2026-10-16T21:40:00Z", new Date("2026-10-19T22:20:00Z"), 21, 38, 30)).toBe(false);
    expect(afterRunFresh("2026-10-19T21:41:00Z", new Date("2026-10-19T22:20:00Z"), 21, 38, 30)).toBe(true);
    expect(afterRunFresh(null, now, 21, 38, 30)).toBe(false);
  });

  it("holds a five-minute feed to its age", () => {
    const now = new Date("2026-10-19T15:00:00Z");
    expect(everyFresh("2026-10-19T14:30:00Z", now, 35)).toBe(true);
    expect(everyFresh("2026-10-19T14:20:00Z", now, 35)).toBe(false);
    expect(everyFresh("not a time", now, 35)).toBe(false);
  });

  it("expects the trade journal every half hour in the session and after the backstop otherwise", () => {
    // Monday 11:00 New York (EDT): the live sync's heartbeat must be recent.
    expect(journalFresh("2026-10-19T14:40:00Z", new Date("2026-10-19T15:00:00Z"))).toBe(true);
    expect(journalFresh("2026-10-16T21:40:00Z", new Date("2026-10-19T15:00:00Z"))).toBe(false);
    // Saturday: Friday's backstop is enough.
    expect(journalFresh("2026-10-16T21:40:00Z", new Date("2026-10-17T23:00:00Z"))).toBe(true);
    expect(journalFresh("2026-10-15T21:40:00Z", new Date("2026-10-17T23:00:00Z"))).toBe(false);
  });

  it("turns a UTC schedule into New York time on both sides of the clock change", () => {
    expect(utcToNy(21 * 60 + 52, new Date("2026-10-19T12:00:00Z"))).toBe(17 * 60 + 52);
    expect(utcToNy(21 * 60 + 52, new Date("2026-11-09T12:00:00Z"))).toBe(16 * 60 + 52);
    expect(utcToNy(10 * 60 + 30, new Date("2026-10-19T12:00:00Z"))).toBe(6 * 60 + 30);
  });
});

describe("stocksFeeds", () => {
  const now = new Date("2026-10-17T23:52:00Z"); // Saturday 10:52 Sydney, Friday's evening in New York is over
  const inputs = (over: Partial<FeedInputs> = {}): FeedInputs => ({
    snapshot: { status: "ok", snapshot: { as_of: "2026-10-17T23:48:00Z" } as Snapshot, etag: null, source: "blob" },
    positions: { status: "missing" },
    levels: { status: "ok", edition: { session: "2026-10-19", as_of: "2026-10-16T22:10:00Z" } as never, source: "blob" },
    radar: { status: "ok", edition: { edition_date: "2026-10-16", as_of: "2026-10-16T11:13:00Z" } as never, source: "blob" },
    journal: { status: "ok", doc: { as_of: "2026-10-16T21:45:00Z" } as never, source: "blob" },
    ...over,
  });

  it("reads every feed on a weekend as on time when the last runs landed", () => {
    const feeds = stocksFeeds(inputs(), now);
    expect(feeds.map((f) => [f.key, f.state])).toEqual([
      ["snapshot", "fresh"],
      ["positions", "missing"],
      ["levels", "fresh"],
      ["radar", "fresh"],
      ["journal", "fresh"],
    ]);
    expect(feeds.find((f) => f.key === "levels")?.when).toBe("17:52 after each session");
  });

  it("calls a feed late once its next run should have landed, and unreadable on a storage error", () => {
    const monday = new Date("2026-10-19T14:00:00Z"); // 10:00 New York, a session has started
    const feeds = stocksFeeds(inputs({ levels: { status: "ok", edition: { session: "2026-10-16", as_of: "2026-10-15T22:10:00Z" } as never, source: "blob" }, positions: { status: "error" } }), monday);
    const state = Object.fromEntries(feeds.map((f) => [f.key, f.state]));
    expect(state).toMatchObject({ snapshot: "late", positions: "error", levels: "late", radar: "late" });
  });

  it("does not call a weeks-old radar on time just because it is the weekend", () => {
    const old = { status: "ok", edition: { edition_date: "2026-09-21", as_of: "2026-09-21T09:00:00Z" } as never, source: "blob" } as const;
    expect(stocksFeeds(inputs({ radar: old }), now).find((f) => f.key === "radar")?.state).toBe("late");
  });
});

describe("hostCode", () => {
  const now = new Date("2026-10-17T23:52:00Z");
  const snap = (deployed: object) => ({ ops: { deployed } }) as Snapshot;

  it("asks for a deploy once the host's code is a day old and main has moved on", () => {
    const h = hostCode(snap({ head: "c39fa52", committed: "2026-10-12T07:27:45+00:00", behind: 21 }), now);
    expect(h).toMatchObject({ sha: "c39fa52", tone: "warn", stuck: true });
    expect(h.sub).toBe("from 12 Oct · main is 21 commits ahead");
  });

  it("stays quiet while the host is level with main, or only hours behind", () => {
    expect(hostCode(snap({ head: "6d9b9fb", committed: "2026-10-17T23:51:20+00:00", behind: 0 }), now)).toMatchObject({ tone: "good", stuck: false });
    expect(hostCode(snap({ head: "1cc3f8e", committed: "2026-10-17T18:42:39+00:00", behind: 2 }), now)).toMatchObject({ tone: "neutral", stuck: false });
    expect(hostCode(null, now)).toMatchObject({ tone: "neutral", stuck: false });
  });
});
