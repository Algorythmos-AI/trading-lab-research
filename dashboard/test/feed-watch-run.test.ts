// The feed watch's tick (src/lib/feed-watch-run.ts) on in-memory state: a store with real etag semantics, a recorded
// pager, and documents by path. No network, no Blob store, nothing sent to ntfy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed, type StoredText } from "@/lib/blob";
import { FEEDS, type DocFeed, type FeedRow } from "@/lib/feed-watch";
import { FEED_ALERT_PATH, FEED_RUN_BUDGET_MS, feedAlertsOn, type FeedWatchDeps, readFeedInputs, runFeedWatch } from "@/lib/feed-watch-run";
import type { Notice } from "@/lib/ntfy";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

/** One state document with ifMatch / create-only semantics, as the Blob store keeps it. */
function memStore() {
  let cur: StoredText | null = null;
  let seq = 0;
  const writes: string[] = [];
  return {
    get: () => cur,
    writes,
    readState: async () => cur,
    writeState: async (body: string, opts: { ifMatch?: string; createOnly?: boolean }) => {
      if (opts.createOnly && cur) throw new PreconditionFailed();
      if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new PreconditionFailed();
      cur = { text: body, etag: `e${++seq}` };
      writes.push(body);
      return { etag: cur.etag };
    },
  };
}

interface World {
  docs: Record<string, unknown>;
  failDocs?: Set<string>;
  refused?: Partial<Record<string, string>>;
}

function deps(world: World, store = memStore(), opts: { alertsOn?: boolean; send?: (n: Notice) => Promise<"sent" | "failed" | "skipped">; clock?: () => number } = {}) {
  const sent: Notice[] = [];
  const reads: string[] = [];
  const d: FeedWatchDeps = {
    readDoc: async (path) => {
      reads.push(path);
      if (world.failDocs?.has(path)) throw new Error("store down");
      return path in world.docs ? JSON.stringify(world.docs[path]) : null;
    },
    readRefusal: async (kind) => {
      const at = world.refused?.[kind];
      return at ? { current: true, at, outcome: "invalid" } : { current: false, at: null, outcome: null };
    },
    readShadow: async () => ({ on: false, switched_at: null, last_slot_end: null }),
    readState: store.readState,
    writeState: store.writeState,
    send: async (n) => {
      sent.push(n);
      return opts.send ? opts.send(n) : "sent";
    },
    alertsOn: opts.alertsOn ?? true,
    clock: opts.clock ?? (() => Date.now()),
  };
  return { d, sent, reads, store };
}

const only = (...ids: string[]) => FEEDS.filter((f) => ids.includes(f.id));
const OPTIONS = "options/latest.json";
const LATE_AT = new Date("2026-11-12T23:00:00Z"); // after the 22:52 UTC deadline
const stale = { [OPTIONS]: { session: "2026-11-12", as_of: "2026-11-11T22:10:00Z" } };
const fresh = { [OPTIONS]: { session: "2026-11-13", as_of: "2026-11-12T23:05:00Z" } };

describe("the switch", () => {
  it("is on only for exactly FEED_WATCH_ALERTS=on", () => {
    expect(feedAlertsOn({})).toBe(false);
    expect(feedAlertsOn({ FEED_WATCH_ALERTS: "1" })).toBe(false);
    expect(feedAlertsOn({ FEED_WATCH_ALERTS: "ON" })).toBe(false);
    expect(feedAlertsOn({ FEED_WATCH_ALERTS: "on" })).toBe(true);
  });
});

describe("a tick", () => {
  it("reads each path once, pages a late feed once, and the next tick is quiet", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent, reads, store } = deps(w);
    const r1 = await runFeedWatch(LATE_AT, d, only("options-edition", "pre-open"));
    expect(reads).toEqual([OPTIONS]); // two rows, one path, one read
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
    expect(r1).toMatchObject({ committed: true, alerts: "on", states: { "options-edition": "late", "pre-open": "not_expected" } });
    expect(JSON.parse(store.get()!.text).feeds["options-edition"]).toMatchObject({ open: true, sent: true, episode: "2026-11-12" });
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition", "pre-open"));
    expect(sent).toHaveLength(1);
  });

  it("late, then recovered: two pages in twenty-one ticks", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w);
    for (let i = 0; i < 20; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    w.docs = { ...fresh };
    await runFeedWatch(new Date(LATE_AT.getTime() + 210 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late", "feed-recovered"]);
  });

  it("an unreadable store is unknown, not late, and pages only on the third run in a row", async () => {
    const w: World = { docs: { ...stale }, failDocs: new Set([OPTIONS]) };
    const { d, sent } = deps(w);
    const r = await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(r).toMatchObject({ states: { "options-edition": "unknown" } });
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition"));
    expect(sent).toEqual([]);
    await runFeedWatch(new Date(LATE_AT.getTime() + 20 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.title)).toEqual(["Options edition cannot be checked"]);
  });

  it("two overlapping runs page once", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const a = deps(w, store);
    const b = deps(w, store);
    const [ra, rb] = await Promise.all([runFeedWatch(LATE_AT, a.d, only("options-edition")), runFeedWatch(LATE_AT, b.d, only("options-edition"))]);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect([ra.skipped, rb.skipped].filter(Boolean)).toEqual(["concurrent run"]);
    expect(store.writes).toHaveLength(1);
  });

  it("a page that fails puts that feed back, so the next run pages again", async () => {
    const w: World = { docs: { ...stale } };
    let result: "sent" | "failed" = "failed";
    const { d, sent, store } = deps(w, memStore(), { send: async () => result });
    await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(JSON.parse(store.get()!.text).feeds["options-edition"]).toBeUndefined();
    result = "sent";
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late", "feed-late"]);
    expect(JSON.parse(store.get()!.text).feeds["options-edition"]).toMatchObject({ open: true });
  });

  it("still pages when the state cannot be written (fails open)", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w);
    d.writeState = async () => {
      throw new Error("store down");
    };
    const r = await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(sent).toHaveLength(1);
    expect(r).toMatchObject({ committed: false });
  });

  it("a page not sent within the run's budget counts as failed and is retried", async () => {
    const w: World = { docs: { ...stale } };
    let t = 0;
    const { d, sent, store } = deps(w, memStore(), { clock: () => t });
    d.readState = async () => {
      t += FEED_RUN_BUDGET_MS; // the reads used the whole budget
      return store.get();
    };
    const r = await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(sent).toEqual([]);
    expect(r).toMatchObject({ failed: 1 });
    expect(JSON.parse(store.get()!.text).feeds["options-edition"]).toBeUndefined();
  });
});

describe("display only (FEED_WATCH_ALERTS unset)", () => {
  it("sends nothing in either mode change, stores the incident, and switch-on does not burst", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const off = deps(w, store, { alertsOn: false });
    for (let i = 0; i < 5; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), off.d, only("options-edition", "refusal-options"));
    expect(off.sent).toEqual([]);
    expect(JSON.parse(store.get()!.text).feeds["options-edition"]).toMatchObject({ open: true, sent: false });
    // The owner switches it on with the incident still under way: nothing is sent for it.
    const on = deps(w, store, { alertsOn: true });
    for (let i = 5; i < 10; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), on.d, only("options-edition", "refusal-options"));
    expect(on.sent).toEqual([]);
    // Its recovery is silent too; the next incident pages.
    w.docs = { ...fresh };
    await runFeedWatch(new Date(LATE_AT.getTime() + 120 * 60_000), on.d, only("options-edition", "refusal-options"));
    expect(on.sent).toEqual([]);
    w.docs = { ...fresh };
    w.refused = { options: "2026-11-13T22:30:00Z" };
    await runFeedWatch(new Date("2026-11-13T22:40:00Z"), on.d, only("options-edition", "refusal-options"));
    expect(on.sent.map((n) => n.kind)).toEqual(["rejected"]);
  });
});

describe("the table is the only place a feed is defined", () => {
  it("a new row (an after-close selection pass) is read, evaluated and paged with no other change", async () => {
    const stage: DocFeed = {
      type: "doc",
      id: "selection-stage-1",
      name: "Selection stage 1",
      short: "Stage 1",
      path: "selection/stage1.json",
      stamp: (doc) => ({ session: (doc as { session?: string }).session ?? null, at: null }),
      want: "next-session",
      schedules: [{ zone: "America/New_York", times: ["16:30"], grace_min: 30 }],
      severity: "alert",
      verified: true,
      misses_to_alert: 1,
    };
    const table: FeedRow[] = [...only("options-edition"), stage];
    const w: World = { docs: { ...fresh, "selection/stage1.json": { session: "2026-11-12" } } };
    const { d, sent, reads } = deps(w);
    const inputs = await readFeedInputs(d, LATE_AT.getTime(), table);
    expect(Object.keys(inputs.docs).sort()).toEqual([OPTIONS, "selection/stage1.json"].sort());
    // 16:30 New York is 21:30 UTC in November; 30 minutes' grace: late from 22:00 UTC.
    const r = await runFeedWatch(LATE_AT, d, table);
    expect(r).toMatchObject({ states: { "options-edition": "on_time", "selection-stage-1": "late" } });
    expect(sent.map((n) => n.title)).toEqual(["Selection stage 1 late by 60 min"]);
    expect(reads).toContain("selection/stage1.json");
  });

  it("the state document has its own path", () => {
    expect(FEED_ALERT_PATH).toBe("ops/feeds-alert.json");
  });
});
