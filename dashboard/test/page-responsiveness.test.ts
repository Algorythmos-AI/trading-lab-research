// The Options page's main-thread budget (fix/dashboard-responsiveness): one shared clock per interval, the minute
// refresh guarded, the feed runs worked out once a day, and every live poll's request bounded in time. Pure: the
// clock and timers are vitest's fake ones.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningTickers, subscribeEvery } from "@/components/client/use-now";
import { MAX_HOLDS, QUIET_MS, refreshTurn } from "@/lib/refresh-guard";
import { BARS_DEADLINE_MS, CHAIN_DEADLINE_MS, deadline, FLAGS_DEADLINE_MS, QUOTE_DEADLINE_MS } from "@/lib/fetch-deadline";
import { FEEDS, slotsAround, type DocFeed } from "@/lib/feed-watch";

describe("the shared clock (use-now.ts)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-23T14:31:00.400Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("runs one timer for every reader of an interval, and tells them all in the same tick", () => {
    const sub = subscribeEvery(1_000);
    const seen: number[][] = [[], [], [], [], [], [], []];
    const offs = seen.map((s, i) => sub(() => s.push(i)));
    expect(runningTickers()).toBe(1);
    vi.advanceTimersByTime(3_000);
    // every reader told three times, none more
    expect(seen.map((s) => s.length)).toEqual([3, 3, 3, 3, 3, 3, 3]);
    for (const off of offs) off();
    expect(runningTickers()).toBe(0);
  });

  it("is the same function for the same interval, so a redraw never starts a new timer", () => {
    expect(subscribeEvery(1_000)).toBe(subscribeEvery(1_000));
    expect(subscribeEvery(250)).not.toBe(subscribeEvery(1_000));
  });

  it("fires on the wall clock's whole second, not up to a second later", () => {
    const at: number[] = [];
    const off = subscribeEvery(1_000)(() => at.push(Date.now()));
    vi.advanceTimersByTime(2_000);
    off();
    expect(at.map((t) => t % 1_000)).toEqual([0, 0]);
    expect(at[0]).toBe(Date.parse("2026-11-23T14:31:01.000Z"));
  });

  it("keeps one timer per interval, and stops each with its last reader", () => {
    const a = subscribeEvery(1_000)(() => undefined);
    const b = subscribeEvery(250)(() => undefined);
    const c = subscribeEvery(1_000)(() => undefined);
    expect(runningTickers()).toBe(2);
    a();
    expect(runningTickers()).toBe(2);
    c();
    expect(runningTickers()).toBe(1);
    b();
    expect(runningTickers()).toBe(0);
    // nothing left to fire
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a reader stop while it is being told", () => {
    const sub = subscribeEvery(1_000);
    let n = 0;
    const offA: () => void = sub(() => {
      n++;
      offA();
    });
    const offB = sub(() => n++);
    vi.advanceTimersByTime(2_000);
    expect(n).toBe(3); // A once, B twice
    offB();
    expect(runningTickers()).toBe(0);
  });
});

describe("the minute refresh's guard (refresh-guard.ts)", () => {
  it("never starts a second refresh while the last is still being drawn", () => {
    expect(refreshTurn(true, Infinity, 0)).toBe("skip");
    expect(refreshTurn(true, 0, 0)).toBe("skip");
  });
  it("waits while the owner is clicking or typing, but not for ever", () => {
    expect(refreshTurn(false, 500, 0)).toBe("hold");
    expect(refreshTurn(false, 500, MAX_HOLDS - 1)).toBe("hold");
    expect(refreshTurn(false, 500, MAX_HOLDS)).toBe("refresh");
    expect(refreshTurn(false, QUIET_MS, 0)).toBe("refresh");
    expect(refreshTurn(false, Infinity, 0)).toBe("refresh");
  });
});

describe("the feed runs, worked out once a day (feed-watch.ts slotsAround)", () => {
  const docs = FEEDS.filter((f): f is DocFeed => f.type === "doc");
  const fresh = (f: DocFeed) => ({ ...f }) as DocFeed; // a new object: nothing kept for it yet

  it("gives the same runs from the cache as worked out afresh, at every minute of a session day", () => {
    for (const f of docs) {
      for (let m = 0; m < 24 * 60; m += 37) {
        const t = Date.parse("2026-11-23T05:00:00Z") + m * 60_000;
        expect(slotsAround(f, t)).toEqual(slotsAround(fresh(f), t));
      }
    }
  });

  it("is shared within a New York day and new on the next", () => {
    const f = docs[0]!;
    const morning = slotsAround(f, Date.parse("2026-11-23T14:00:00Z"));
    expect(slotsAround(f, Date.parse("2026-11-23T20:59:00Z"))).toBe(morning);
    // 2026-11-24 00:30 New York is a new day
    expect(slotsAround(f, Date.parse("2026-11-24T05:30:00Z"))).not.toBe(morning);
    // another window is its own answer
    expect(slotsAround(f, Date.parse("2026-11-23T14:00:00Z"), 7, 1)).not.toBe(morning);
  });

  it("holds the half day, the holiday and the clock change as before (2026-11-26, -27; 2026-11-01)", () => {
    for (const f of docs) {
      for (const iso of ["2026-11-26T15:00:00Z", "2026-11-27T17:30:00Z", "2026-11-01T06:30:00Z", "2026-11-02T14:00:00Z"]) {
        const t = Date.parse(iso);
        expect(slotsAround(f, t)).toEqual(slotsAround(fresh(f), t));
      }
    }
  });
});

describe("every live poll's request is bounded (fetch-deadline.ts)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sits above what each route itself may take upstream", () => {
    expect(QUOTE_DEADLINE_MS).toBeGreaterThan(8_000);
    expect(CHAIN_DEADLINE_MS).toBeGreaterThan(3 * 8_000);
    expect(BARS_DEADLINE_MS).toBeGreaterThanOrEqual(60_000);
    expect(FLAGS_DEADLINE_MS).toBeGreaterThan(5_000);
  });

  it("aborts after its time, at once when cancelled, and never once done", () => {
    const a = deadline(1_000);
    vi.advanceTimersByTime(999);
    expect(a.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(a.signal.aborted).toBe(true);

    const b = deadline(1_000);
    b.cancel();
    expect(b.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const c = deadline(1_000);
    c.done();
    vi.advanceTimersByTime(5_000);
    expect(c.signal.aborted).toBe(false);
  });
});
