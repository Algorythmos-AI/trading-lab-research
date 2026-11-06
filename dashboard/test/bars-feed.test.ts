import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BARS_POLL_MS, BARS_RETRY_MS, type BarsFeed, barsPoller, barsUrl } from "@/lib/bars-feed";
import { barsInUse } from "@/lib/trade-now";

const BODY = { as_of: "2026-10-12T14:20:00.000Z", feed: "iex", bars: { SPY: [{ start: 1, end: 2, o: 1, h: 1, l: 1, c: 1 }] }, fetchedAt: { SPY: 123 }, missing: [] };
const ok = () => new Response(JSON.stringify(BODY), { status: 200 });

/** The poller the hook runs, on fake timers and a mocked fetch. */
function rig(fetchImpl: typeof fetch) {
  const feeds: BarsFeed[] = [];
  const p = barsPoller({
    url: barsUrl("SPY", false),
    fetch: fetchImpl,
    now: () => Date.now(),
    visible: () => true,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    onFeed: (f) => feeds.push(f),
  });
  return { p, feeds, last: () => feeds[feeds.length - 1]! };
}

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
    // retried later, and fresh again once it answers
    f.mockResolvedValueOnce(ok());
    await vi.advanceTimersByTimeAsync(BARS_RETRY_MS);
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
