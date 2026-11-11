import { afterEach, describe, expect, it, vi } from "vitest";
import { type Backoff, MANUAL_GAP_MS, type PollResult, startPoll, statusResult } from "@/lib/quote-poll";

const CAP = 30_000;

/** The loop on fake timers: each request waits for the test to answer it. Jitter is fixed at none unless asked. */
function setup(o: { rand?: () => number; fresh?: () => boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
  const listeners = new Set<() => void>();
  const shows = new Set<(e: { persisted?: boolean }) => void>();
  const win = {
    addEventListener: (_: "pageshow", fn: (e: { persisted?: boolean }) => void) => void shows.add(fn),
    removeEventListener: (_: "pageshow", fn: (e: { persisted?: boolean }) => void) => void shows.delete(fn),
  };
  const page = {
    visibilityState: "visible",
    addEventListener: (_: "visibilitychange", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) => void listeners.delete(fn),
  };
  const pending: ((r: PollResult) => void)[] = [];
  let calls = 0;
  /** When each request went out, ms since the start. */
  const sent: number[] = [];
  const t0 = Date.now();
  const run = () =>
    new Promise<PollResult>((resolve) => {
      calls++;
      sent.push(Date.now() - t0);
      pending.push(resolve);
    });
  const backoffs: (Backoff | null)[] = [];
  const poll = startPoll({
    run,
    page,
    show: win,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    pollMs: 2_000,
    backoff: { capMs: CAP, rand: o.rand ?? (() => 0) },
    onBackoff: (b) => backoffs.push(b),
    fresh: o.fresh,
  });
  const show = (state: string) => {
    page.visibilityState = state;
    listeners.forEach((fn) => fn());
  };
  const answer = async (r: PollResult = "ok") => {
    pending.shift()!(r);
    await vi.advanceTimersByTimeAsync(0);
  };
  const restore = (persisted: boolean) => shows.forEach((fn) => fn({ persisted }));
  return {
    stop: poll.stop,
    retryNow: poll.retryNow,
    failing: poll.failing,
    show,
    answer,
    restore,
    calls: () => calls,
    pending: () => pending.length,
    sent,
    elapsed: () => Date.now() - t0,
    backoffs,
    listeners,
    shows,
  };
}

/** Lets `ms` pass from timer to timer, answering each request with `r` the moment it is sent. */
async function failFor(t: ReturnType<typeof setup>, ms: number, r: PollResult = "error") {
  const end = t.elapsed() + ms;
  for (;;) {
    while (t.pending()) await t.answer(r);
    if (t.elapsed() >= end) break;
    await vi.advanceTimersToNextTimerAsync();
  }
}

afterEach(() => vi.useRealTimers());

describe("the quotes poll's visibility kick", () => {
  it("fetches once at once when the tab is shown again, with no second timer", async () => {
    const t = setup();
    expect(t.calls()).toBe(1);
    await t.answer();
    t.show("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.calls()).toBe(1); // nothing fetched while hidden
    t.show("visible");
    expect(t.calls()).toBe(2);
    await t.answer();
    // one timer only: the next fetch comes one interval later, not twice
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.calls()).toBe(3);
    t.stop();
  });

  it("fetches nothing on visible while a request is in flight", async () => {
    const t = setup();
    expect(t.calls()).toBe(1);
    t.show("visible");
    t.show("visible");
    expect(t.calls()).toBe(1);
    await t.answer();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.calls()).toBe(2);
    t.stop();
  });

  it("while waiting after a failure, a shown tab makes exactly one attempt at once, however often it flips", async () => {
    const t = setup();
    await t.answer("error"); // waits 2 s
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(2); // the one early attempt, not a wait of 2 s
    // flipping while it is in flight adds nothing: one request at a time
    for (let i = 0; i < 5; i++) {
      t.show("hidden");
      t.show("visible");
    }
    expect(t.calls()).toBe(2);
    await t.answer("error"); // a second failure in a row: waits 4 s, and the count was kept
    for (let i = 0; i < 10; i++) {
      t.show("hidden");
      t.show("visible");
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(t.calls()).toBe(2); // the run of failures has had its early attempt: the wait stands
    await vi.advanceTimersByTimeAsync(4_000 - 1_000 - 1);
    expect(t.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(3); // 4 s after the second failure, not 2: the count was kept
    await t.answer("ok");
    // healthy again: showing the tab fetches at once
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(4);
    await t.answer("error");
    // a new run of failures has its own early attempt
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(5);
    t.stop();
  });

  it("a tab shown once the wait has run out (it was hidden through it) fetches at once without using the early attempt", async () => {
    const t = setup();
    await t.answer("error"); // due at 2 s
    t.show("hidden");
    await vi.advanceTimersByTimeAsync(2_000); // the timer finds the tab hidden and only looks again later
    expect(t.calls()).toBe(1);
    t.show("visible");
    expect(t.calls()).toBe(2);
    await t.answer("error"); // waits 4 s
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(3); // the early attempt was still there to use
    t.stop();
  });

  it("after a rate limit (429), hiding and showing the tab sends nothing until the cap has run out", async () => {
    const t = setup();
    await t.answer("limited");
    for (let i = 0; i < 30; i++) {
      t.show("hidden");
      t.show("visible");
      t.restore(true);
      await vi.advanceTimersByTimeAsync(i === 29 ? 999 : 1_000);
    }
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(2);
    t.stop();
  });

  it("with a fresh answer standing, a tab shown again asks for nothing; with an old one, or failing, it asks at once", async () => {
    let fresh = true;
    const t = setup({ fresh: () => fresh });
    await t.answer("ok");
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(1); // young answer: the timer keeps its turn
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.calls()).toBe(2); // and it does come
    await t.answer("ok");
    fresh = false;
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(3); // old answer: at once
    await t.answer("error");
    fresh = true; // a run of failures: freshness does not hold back the early attempt
    t.show("hidden");
    t.show("visible");
    expect(t.calls()).toBe(4);
    t.stop();
  });

  it("treats a back-forward cache restore as shown again, with the same guards", async () => {
    const t = setup();
    await t.answer();
    t.restore(false);
    expect(t.calls()).toBe(1);
    t.restore(true);
    expect(t.calls()).toBe(2);
    t.restore(true); // in flight
    expect(t.calls()).toBe(2);
    await t.answer("error");
    t.restore(true); // within the wait: the one early attempt
    expect(t.calls()).toBe(3);
    await t.answer("error");
    t.restore(true); // and no second one
    expect(t.calls()).toBe(3);
    t.stop();
    expect(t.shows.size).toBe(0);
  });

  it("removes its listener and stops on unmount", async () => {
    const t = setup();
    await t.answer();
    expect(t.listeners.size).toBe(1);
    t.stop();
    expect(t.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.calls()).toBe(1);
  });
});

describe("the quotes poll's waits after failures", () => {
  it("waits 2, 4, 8, 16 s, then 30 s, after failures in a row, to the millisecond", async () => {
    const t = setup();
    await t.answer("error");
    const waits = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const w of waits) {
      const before = t.calls();
      await vi.advanceTimersByTimeAsync(w - 1);
      expect(t.calls()).toBe(before); // 1 ms early: nothing
      await vi.advanceTimersByTimeAsync(1);
      expect(t.calls()).toBe(before + 1); // on the dot
      await t.answer("error");
    }
    expect(t.sent).toEqual([0, 2_000, 6_000, 14_000, 30_000, 60_000, 90_000]);
    t.stop();
  });

  it("three failures in a row are retried at 2, 4 and 8 s: back inside the board's 20 s before it pauses", async () => {
    const t = setup();
    await t.answer("ok"); // a good answer at 0
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("error"); // 2 s
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("error"); // 4 s
    await vi.advanceTimersByTimeAsync(4_000);
    await t.answer("error"); // 8 s
    await vi.advanceTimersByTimeAsync(8_000);
    await t.answer("ok"); // 16 s
    expect(t.sent).toEqual([0, 2_000, 4_000, 8_000, 16_000]);
    expect(t.sent[4]! - t.sent[0]!).toBeLessThan(20_000);
    t.stop();
  });

  it("goes back to its 2 s interval on the first answer, and a later failure starts again at 2 s", async () => {
    const t = setup();
    await t.answer("error");
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("error");
    await vi.advanceTimersByTimeAsync(4_000);
    await t.answer("ok");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(t.calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(4);
    await t.answer("error"); // a new run: 2 s, not 8
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.calls()).toBe(5);
    t.stop();
  });

  it("stops for good when the feed is not configured (503), even in the middle of a run of failures", async () => {
    const t = setup();
    await t.answer("error");
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("off");
    expect(t.backoffs.at(-1)).toBeNull();
    t.show("hidden");
    t.show("visible");
    t.retryNow();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.calls()).toBe(2);
    t.stop();
  });

  it("waits the full 30 s at once after a rate limit (429), then keeps counting failures", async () => {
    const t = setup();
    await t.answer("limited");
    expect(t.backoffs.at(-1)).toEqual({ failures: 1, at: Date.now() + CAP, limited: true });
    await vi.advanceTimersByTimeAsync(CAP - 1);
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(2);
    await t.answer("error"); // the second failure in a row: 4 s
    expect(t.backoffs.at(-1)).toEqual({ failures: 2, at: Date.now() + 4_000, limited: false });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.calls()).toBe(3);
    t.stop();
  });

  it("says when a wait starts, when its attempt goes out, and when the feed is healthy again", async () => {
    const t = setup();
    await t.answer("ok");
    expect(t.backoffs).toEqual([]); // healthy from the start: nothing said
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("error");
    const at = Date.now() + 2_000;
    expect(t.backoffs).toEqual([{ failures: 1, at, limited: false }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.backoffs.at(-1)).toEqual({ failures: 1, at: null, limited: false }); // in flight
    await t.answer("ok");
    expect(t.backoffs.at(-1)).toBeNull();
    const n = t.backoffs.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("ok");
    expect(t.backoffs.length).toBe(n); // nothing more while it stays healthy
    t.stop();
  });

  it("shortens a wait by at most a tenth with jitter, never lengthens it", async () => {
    const t = setup({ rand: () => 0.999999 });
    await t.answer("error");
    // 2 s less up to 10%: due between 1.8 and 2 s
    await vi.advanceTimersByTimeAsync(1_799);
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(2);
    await t.answer("limited");
    // the cap less up to 10%: never past 30 s
    await vi.advanceTimersByTimeAsync(27_000);
    expect(t.calls()).toBe(3);
    t.stop();
  });

  it("keeps trying through a long outage without ever asking more than once at a time", async () => {
    const t = setup();
    await failFor(t, 10 * 60_000);
    // 2, 4, 8, 16, then every 30 s: 0, 2, 6, 14, 30, then 19 more by 600 s
    expect(t.calls()).toBe(5 + 19);
    const gaps = t.sent.slice(1).map((s, i) => s - t.sent[i]!);
    expect(Math.max(...gaps)).toBe(CAP);
    expect(Math.min(...gaps)).toBe(2_000);
    t.stop();
  });
});

describe("Retry now", () => {
  it("makes one attempt at once while waiting, keeping the count of failures", async () => {
    const t = setup();
    await t.answer("error");
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("error"); // waits 4 s
    t.retryNow();
    expect(t.calls()).toBe(3);
    t.retryNow(); // in flight: nothing more
    t.retryNow();
    expect(t.calls()).toBe(3);
    await t.answer("error"); // the third failure in a row: 8 s
    await vi.advanceTimersByTimeAsync(8_000 - 1);
    expect(t.calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(4);
    await t.answer("ok");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.calls()).toBe(5); // the 2 s interval again
    t.stop();
  });

  it("each press a second or more after the last tries once more; it is not used up like the tab's early attempt", async () => {
    const t = setup();
    await t.answer("error");
    for (let i = 0; i < 3; i++) {
      t.retryNow();
      await t.answer("error");
      await vi.advanceTimersByTimeAsync(MANUAL_GAP_MS);
    }
    expect(t.calls()).toBe(4);
    expect(t.backoffs.at(-1)).toEqual({ failures: 4, at: Date.now() - MANUAL_GAP_MS + 16_000, limited: false });
    t.stop();
  });

  it("a held finger during a plain outage sends at most one attempt a second, to the millisecond", async () => {
    const t = setup();
    await t.answer("error"); // waits 2 s
    t.retryNow(); // at 0: goes
    expect(t.calls()).toBe(2);
    await t.answer("error"); // answered at once: the press could go again but for the gap
    for (let i = 0; i < 99; i++) {
      t.retryNow();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(MANUAL_GAP_MS - 1 - t.elapsed());
    expect(t.elapsed()).toBe(MANUAL_GAP_MS - 1);
    t.retryNow(); // 999 ms after the last: still nothing
    expect(t.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    t.retryNow(); // 1000 ms: goes
    expect(t.calls()).toBe(3);
    await t.answer("error");
    // pressed every 10 ms for 10 s while every attempt fails at once: about one a second, plus the timers' own
    const before = t.calls();
    const start = t.elapsed();
    while (t.elapsed() - start < 10_000) {
      t.retryNow();
      while (t.pending()) await t.answer("error");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(t.calls() - before).toBeLessThanOrEqual(10 + 2);
    expect(t.calls() - before).toBeGreaterThanOrEqual(9);
    t.stop();
  });

  it("after a rate limit (429) does nothing until the cap has run out, however often it is pressed", async () => {
    const t = setup();
    await t.answer("limited");
    for (let i = 0; i < 300; i++) {
      t.retryNow();
      await vi.advanceTimersByTimeAsync(CAP / 300 - (i === 299 ? 1 : 0));
    }
    expect(t.calls()).toBe(1); // 29 999 ms: not one request
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(2); // the cap's own attempt
    t.retryNow(); // in flight
    expect(t.calls()).toBe(2);
    await t.answer("error"); // a plain failure now: Retry now works again
    t.retryNow();
    expect(t.calls()).toBe(3);
    t.stop();
  });

  it("does nothing while the feed is healthy, while the tab is hidden, or once stopped", async () => {
    const t = setup();
    await t.answer("ok");
    t.retryNow();
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("error");
    t.show("hidden");
    t.retryNow();
    expect(t.calls()).toBe(2);
    t.show("visible"); // the tab's early attempt
    expect(t.calls()).toBe(3);
    await t.answer("error");
    t.stop();
    t.retryNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls()).toBe(3);
  });

  it("says whether it is in a run of failures, so the chain's Try again uses it instead of starting afresh", async () => {
    const t = setup();
    await t.answer("ok");
    expect(t.failing()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await t.answer("limited");
    expect(t.failing()).toBe(true);
    await vi.advanceTimersByTimeAsync(CAP);
    expect(t.failing()).toBe(true); // its attempt in flight
    await t.answer("ok");
    expect(t.failing()).toBe(false);
    t.stop();
  });

  it("drops the pending timer: no second request follows at the old time", async () => {
    const t = setup();
    await t.answer("error"); // due at 2 s
    await vi.advanceTimersByTimeAsync(1_000);
    t.retryNow(); // at 1 s
    await t.answer("ok");
    await vi.advanceTimersByTimeAsync(1_000); // 2 s: the old retry would have gone now
    expect(t.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); // 3 s: the 2 s interval after the answer at 1 s
    expect(t.calls()).toBe(3);
    t.stop();
  });
});

describe("statusResult", () => {
  it("maps our routes' statuses: 503 stops, 429 waits the cap, other failures retry, 2xx answers", () => {
    expect(statusResult(503)).toBe("off");
    expect(statusResult(429)).toBe("limited");
    for (const s of [400, 401, 403, 404, 500, 502, 504, 301, 199]) expect(statusResult(s)).toBe("error");
    for (const s of [200, 204, 299]) expect(statusResult(s)).toBe("ok");
  });
});
