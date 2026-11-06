import { describe, expect, it } from "vitest";
import { screenKeeper, type WakeSentinel } from "@/lib/wake-lock";

// A fake Wake Lock: each request waits until the test resolves it, and each sentinel counts its release.
function fakeApi() {
  const waiting: ((s: WakeSentinel) => void)[] = [];
  const released: number[] = [];
  let n = 0;
  return {
    api: {
      request: () =>
        new Promise<WakeSentinel>((resolve) => {
          waiting.push(resolve);
        }),
    },
    /** Resolve the oldest pending request with a new sentinel; returns its number. */
    grant: async () => {
      const id = ++n;
      waiting.shift()!({ release: async () => void released.push(id) });
      await Promise.resolve();
      await Promise.resolve();
      return id;
    },
    requests: () => n + waiting.length,
    pending: () => waiting.length,
    released,
  };
}

describe("the cockpit's screen keeper", () => {
  it("sends one request at a time, however often it is asked", async () => {
    const f = fakeApi();
    const k = screenKeeper(f.api, () => true);
    k.take();
    k.take();
    k.take();
    expect(f.pending()).toBe(1);
    await f.grant();
    expect(k.held()).toBe(true);
    k.take();
    expect(f.pending()).toBe(0);
  });

  it("releases a lock that arrives after the tab was hidden, and takes a fresh one when it is shown", async () => {
    const f = fakeApi();
    let visible = true;
    const k = screenKeeper(f.api, () => visible);
    k.take();
    visible = false;
    k.drop();
    const first = await f.grant();
    expect(f.released).toEqual([first]);
    expect(k.held()).toBe(false);
    visible = true;
    k.take();
    await f.grant();
    expect(k.held()).toBe(true);
  });

  it("hidden and shown again while a request is pending: one lock, none leaked", async () => {
    const f = fakeApi();
    let visible = true;
    const k = screenKeeper(f.api, () => visible);
    k.take();
    visible = false;
    k.drop();
    visible = true;
    k.take(); // still pending: no second request
    expect(f.pending()).toBe(1);
    await f.grant();
    expect(k.held()).toBe(true);
    expect(f.released).toEqual([]);
  });

  it("releases a lock that arrives after the cockpit turned off, and the one it holds when stopped", async () => {
    const f = fakeApi();
    const k = screenKeeper(f.api, () => true);
    k.take();
    k.stop();
    const late = await f.grant();
    expect(f.released).toEqual([late]);
    const k2 = screenKeeper(f.api, () => true);
    k2.take();
    const held = await f.grant();
    k2.stop();
    await Promise.resolve();
    expect(f.released).toEqual([late, held]);
    k2.take();
    expect(f.pending()).toBe(0);
  });

  it("lets a refused request be asked again", async () => {
    let refuse = true;
    let asked = 0;
    const k = screenKeeper({ request: () => (asked++, refuse ? Promise.reject(new Error("no")) : new Promise<WakeSentinel>(() => undefined)) }, () => true);
    k.take();
    await Promise.resolve();
    await Promise.resolve();
    refuse = false;
    k.take();
    expect(asked).toBe(2);
  });
});
