// The watchdog cron's ticks (src/lib/cron-watchdog.ts): no started tick is abandoned, a hanging tick never starves the
// feed watch, and the reply comes within the cap.
import { describe, expect, it } from "vitest";
import { runCronTicks } from "@/lib/cron-watchdog";
import type { FeedWatchDeps } from "@/lib/feed-watch-run";
import { FEEDS } from "@/lib/feed-watch";
import type { Notice } from "@/lib/ntfy";

const hang = () => new Promise<never>(() => undefined);
const log = () => undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the watchdog cron's ticks", () => {
  it("a desk tick whose page hangs past its budget still writes its rollback before the reply", async () => {
    const steps: string[] = [];
    const desk = async () => {
      steps.push("committed");
      await wait(120); // the page hangs past the 40 ms budget, then fails
      steps.push("rolled back");
      return { ok: true, desk: "hft" };
    };
    const deferred: unknown[] = [];
    const r = await runCronTicks(
      { stocks: async () => ({ ok: true }), desks: [["hft", desk]], feeds: async () => ({ ok: true }), log, defer: (w) => deferred.push(w) },
      { stocks: 40, desk: 40 },
      1_000,
    );
    expect(steps).toEqual(["committed", "rolled back"]);
    expect(r.desks.hft).toEqual({ ok: true, desk: "hft" });
    expect(deferred).toEqual([]);
  });

  it("a stocks tick that hangs forever does not stop the feed tick, and the reply comes at the cap with the rest deferred", async () => {
    let feedRan = false;
    const deferred: (() => Promise<unknown>)[] = [];
    const t0 = Date.now();
    const r = await runCronTicks(
      {
        stocks: hang,
        desks: [["hft", async () => ({ ok: true, desk: "hft" })]],
        feeds: async () => {
          feedRan = true;
          return { ok: true, ran: true };
        },
        log,
        defer: (w) => deferred.push(w),
      },
      { stocks: 30, desk: 30 },
      150,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(feedRan).toBe(true);
    expect(r.feeds).toEqual({ ok: true, ran: true });
    expect(r.desks.hft).toEqual({ ok: true, desk: "hft" });
    expect(r.stocks).toBeNull();
    expect(deferred).toHaveLength(1); // the hanging tick is kept alive past the reply, not dropped
  });

  it("in a total outage the feed tick sends its store notice while a stocks tick hangs", async () => {
    const { runFeedWatch } = await import("@/lib/feed-watch-run");
    const sent: Notice[] = [];
    const down = () => Promise.reject(new Error("store down"));
    const deps: FeedWatchDeps = {
      readDoc: down,
      readRefusal: down,
      readShadow: down,
      readState: down,
      writeState: down,
      send: async (n) => {
        sent.push(n);
        return "sent";
      },
      alertsOn: true,
      clock: () => Date.now(),
      sleep: async () => undefined,
    };
    const tick0 = new Date("2026-11-13T00:00:04Z");
    const r = await runCronTicks(
      { stocks: hang, desks: [], feeds: () => runFeedWatch(tick0, deps, FEEDS.filter((f) => f.id === "options-edition")), log, defer: () => undefined },
      { stocks: 30, desk: 30 },
      2_000,
    );
    expect(r.stocks).toBeNull();
    expect(r.feeds).toMatchObject({ state: "read-failed", sent: 1 });
    expect(sent.map((n) => n.title)).toEqual(["Feed watch cannot read its store"]);
  });

  it("a tick that throws is reported and the rest run", async () => {
    const r = await runCronTicks(
      { stocks: async () => ({ ok: true }), desks: [["hft", () => Promise.reject(new Error("x"))]], feeds: async () => ({ ok: true }), log, defer: () => undefined },
    );
    expect(r).toMatchObject({ stocks: { ok: true }, desks: { hft: { ok: false, desk: "hft" } }, feeds: { ok: true } });
  });
});
