// The watchdog cron's ticks in their own budgets (src/lib/cron-watchdog.ts): a hanging tick never starves the next.
import { describe, expect, it } from "vitest";
import { runCronTicks } from "@/lib/cron-watchdog";
import type { FeedWatchDeps } from "@/lib/feed-watch-run";
import { FEEDS } from "@/lib/feed-watch";
import type { Notice } from "@/lib/ntfy";

const hang = () => new Promise<never>(() => undefined);
const log = () => undefined;

describe("the watchdog cron's ticks", () => {
  it("a hanging stocks tick and a hanging desk tick still let the feed tick run", async () => {
    const r = await runCronTicks(
      { stocks: hang, desks: [["hft", hang]], feeds: async () => ({ ok: true, ran: true }), log },
      { stocks: 30, desk: 30, feeds: 1_000 },
    );
    expect(r.stocks).toBeNull();
    expect(r.desks.hft).toMatchObject({ ok: false, timed_out: true });
    expect(r.feeds).toEqual({ ok: true, ran: true });
  });

  it("in a total outage the feed tick still sends its store notice after a hanging stocks tick", async () => {
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
      { stocks: hang, desks: [], feeds: () => runFeedWatch(tick0, deps, FEEDS.filter((f) => f.id === "options-edition")), log },
      { stocks: 30, desk: 30, feeds: 5_000 },
    );
    expect(r.stocks).toBeNull();
    expect(r.feeds).toMatchObject({ state: "read-failed", sent: 1 });
    expect(sent.map((n) => n.title)).toEqual(["Feed watch cannot read its store"]);
  });

  it("a tick that throws is reported and the rest run", async () => {
    const r = await runCronTicks(
      { stocks: async () => ({ ok: true }), desks: [["hft", () => Promise.reject(new Error("x"))]], feeds: async () => ({ ok: true }), log },
    );
    expect(r).toMatchObject({ stocks: { ok: true }, desks: { hft: { ok: false } }, feeds: { ok: true } });
  });
});
