import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BarsFeed } from "@/lib/bars-feed";
import { BARS_POLL_MS, BARS_RETRY_CAP_MS, barsPoller, barsUrl } from "@/lib/bars-poller";
import { barsInUse } from "@/lib/trade-now";

const BODY = { as_of: "2026-10-12T14:20:00.000Z", feed: "iex", bars: { SPY: [{ start: 1, end: 2, o: 1, h: 1, l: 1, c: 1 }] }, fetchedAt: { SPY: 123 }, missing: [] };
const ok = () => new Response(JSON.stringify(BODY), { status: 200 });

/** The poller the hook runs, on fake timers and a mocked fetch, with no jitter. */
function rig(fetchImpl: typeof fetch, visible: () => boolean = () => true) {
  const feeds: BarsFeed[] = [];
  const p = barsPoller({
    url: barsUrl("SPY", false),
    fetch: fetchImpl,
    now: () => Date.now(),
    visible,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    onFeed: (f) => feeds.push(f),
    rand: () => 0,
  });
  return { p, feeds, last: () => feeds[feeds.length - 1]! };
}

const fail = (status = 502) => new Response("no", { status });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T14:20:00Z"));
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("barsUrl", () => {
  it("asks for the names, and the half day only when it is one", () => {
    expect(barsUrl("SPY,QQQ", false)).toBe("/api/bars?s=SPY%2CQQQ");
    expect(barsUrl("SPY", true)).toBe("/api/bars?s=SPY&half=1");
  });
});

describe("the bars poll", () => {
  it("keeps the bars with their fetch times on success, then marks them failed when a poll fails", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error("offline"));
    const { p, last } = rig(f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ status: "ok", asOf: BODY.as_of, bars: BODY.bars, fetchedAt: { SPY: 123 }, receivedAt: Date.now(), failed: false });
    expect(barsInUse(last(), Date.now()).delayed).toBe(false);
    await vi.advanceTimersByTimeAsync(BARS_POLL_MS);
    expect(f).toHaveBeenCalledTimes(2);
    const after = last();
    expect(after).toMatchObject({ status: "ok", failed: true });
    // the board stops using them at once and says they are delayed
    expect(barsInUse(after, Date.now())).toEqual({ bars: {}, fetchedAt: {}, delayed: true });
    // retried 2 s later, and fresh again once it answers
    f.mockResolvedValueOnce(ok());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f).toHaveBeenCalledTimes(3);
    expect(last()).toMatchObject({ status: "ok", failed: false });
    p.stop();
  });

  it("an error before any bars is an error", async () => {
    const { p, last } = rig(vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("no", { status: 502 })));
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ status: "error" });
    p.stop();
  });

  it("does not drop a kick while a fetch is in flight: it fetches once more straight after", async () => {
    let release: (r: Response) => void = () => undefined;
    const f = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockResolvedValue(ok());
    const { p } = rig(f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    p.kick();
    p.kick(); // two kicks in flight: one refetch
    release(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("parks while the tab is hidden", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(ok());
    const p = barsPoller({
      url: barsUrl("SPY", false),
      fetch: f,
      now: () => Date.now(),
      visible: () => false,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
      onFeed: () => undefined,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(BARS_POLL_MS * 2);
    expect(f).not.toHaveBeenCalled();
    p.stop();
  });
});

describe("the bars poll's waits after failures", () => {
  /** A fetch that fails until told otherwise, counting its calls. */
  function flaky() {
    let failing = true;
    let status = 502;
    const f = vi.fn<typeof fetch>(async () => (failing ? fail(status) : ok()));
    return { f, heal: () => (failing = false), status: (s: number) => (status = s) };
  }

  it("waits 2, 4, 8, 16 s, then its 30 s interval, after failures in a row, to the millisecond", async () => {
    const u = flaky();
    const { p } = rig(u.f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.f).toHaveBeenCalledTimes(1);
    for (const w of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = u.f.mock.calls.length;
      await vi.advanceTimersByTimeAsync(w - 1);
      expect(u.f).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(u.f).toHaveBeenCalledTimes(before + 1);
    }
    expect(BARS_RETRY_CAP_MS).toBe(BARS_POLL_MS);
    p.stop();
  });

  it("goes back to its 30 s interval on the first answer, and a later failure starts again at 2 s", async () => {
    const u = flaky();
    const { p, last } = rig(u.f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    u.heal();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(u.f).toHaveBeenCalledTimes(3);
    expect(last()).toMatchObject({ status: "ok", failed: false });
    await vi.advanceTimersByTimeAsync(BARS_POLL_MS - 1);
    expect(u.f).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.f).toHaveBeenCalledTimes(4);
    u.f.mockResolvedValueOnce(fail());
    await vi.advanceTimersByTimeAsync(BARS_POLL_MS);
    expect(u.f).toHaveBeenCalledTimes(5);
    expect(last()).toMatchObject({ status: "ok", failed: true });
    await vi.advanceTimersByTimeAsync(2_000); // a new run: 2 s, not 8
    expect(u.f).toHaveBeenCalledTimes(6);
    p.stop();
  });

  it("stops for good on 503, even in the middle of a run of failures", async () => {
    const u = flaky();
    const { p, last } = rig(u.f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    u.status(503);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last()).toEqual({ status: "off" });
    expect(u.f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(u.f).toHaveBeenCalledTimes(2); // no timer after "off"
    p.stop();
  });

  it("waits the full 30 s at once after a rate limit (429)", async () => {
    const u = flaky();
    u.status(429);
    const { p } = rig(u.f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BARS_RETRY_CAP_MS - 1);
    expect(u.f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.f).toHaveBeenCalledTimes(2);
    u.status(502); // the third failure in a row waits 8 s: the count went on through the rate limit
    await vi.advanceTimersByTimeAsync(BARS_RETRY_CAP_MS);
    expect(u.f).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8_000 - 1);
    expect(u.f).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.f).toHaveBeenCalledTimes(4);
    p.stop();
  });

  it("while waiting, only the first kick of a run of failures fetches early; the rest leave the wait", async () => {
    const u = flaky();
    const { p } = rig(u.f);
    p.start();
    await vi.advanceTimersByTimeAsync(0); // fails: due at 2 s
    p.kick(); // the tab shown again: one early fetch
    await vi.advanceTimersByTimeAsync(0);
    expect(u.f).toHaveBeenCalledTimes(2); // fails again: due 4 s later, the count kept
    for (let i = 0; i < 10; i++) p.kick();
    await vi.advanceTimersByTimeAsync(4_000 - 1);
    expect(u.f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.f).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it("a kick during a fetch that fails does not fetch again straight after it: the wait stands", async () => {
    let release: (r: Response) => void = () => undefined;
    const f = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockResolvedValue(ok());
    const { p } = rig(f);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.kick(); // queued behind the fetch in flight
    release(fail());
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("a kick on a hidden page while waiting fetches nothing and keeps the early fetch for when it is seen", async () => {
    let seen = true;
    const u = flaky();
    const { p } = rig(u.f, () => seen);
    p.start();
    await vi.advanceTimersByTimeAsync(0); // fails: due at 2 s
    seen = false;
    p.kick(); // a new slot while hidden
    await vi.advanceTimersByTimeAsync(0);
    expect(u.f).toHaveBeenCalledTimes(1);
    seen = true;
    p.kick(); // shown again: the early fetch is still there
    await vi.advanceTimersByTimeAsync(0);
    expect(u.f).toHaveBeenCalledTimes(2);
    p.stop();
  });
});
