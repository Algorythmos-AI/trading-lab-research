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
  const sleeps: number[] = [];
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
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { d, sent, reads, store, sleeps };
}

const only = (...ids: string[]) => FEEDS.filter((f) => ids.includes(f.id));
const OPTIONS = "options/latest.json";
const LATE_AT = new Date("2026-11-12T23:00:00Z"); // after the 22:52 UTC deadline
const stale = { [OPTIONS]: { session: "2026-11-12", as_of: "2026-11-11T22:10:00Z" } };
const fresh = { [OPTIONS]: { session: "2026-11-13", as_of: "2026-11-12T23:05:00Z" } };
const BLOCK0 = new Date("2026-11-13T00:00:00Z").getTime(); // the first tick of a 2-hour block

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
    await Promise.all([runFeedWatch(LATE_AT, a.d, only("options-edition")), runFeedWatch(LATE_AT, b.d, only("options-edition"))]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });

  it("a page whose send fails stays pending and is sent on the next run, once", async () => {
    const w: World = { docs: { ...stale } };
    let result: "sent" | "failed" = "failed";
    const { d, sent, store } = deps(w, memStore(), { send: async () => result });
    await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(JSON.parse(store.get()!.text).outbox).toMatchObject([{ status: "pending", attempts: 1 }]);
    result = "sent";
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition"));
    await runFeedWatch(new Date(LATE_AT.getTime() + 20 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late", "feed-late"]); // one failed try, one delivery
    expect(JSON.parse(store.get()!.text).outbox).toEqual([]);
  });

  it("a page whose send keeps failing: 3 quick tries, sent_failed (logged), then one try every 30 min until 2 h: 6 at most", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent, store } = deps(w, memStore(), { send: async () => "failed" });
    const log = vi.mocked(console.log);
    for (let i = 0; i < 6; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    expect(sent).toHaveLength(4); // ticks 0, 1, 2, then 5
    expect(JSON.parse(store.get()!.text).outbox).toMatchObject([{ status: "sent_failed", tries: 4 }]);
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"evt":"feed-watch.outbox"') && l.includes('"sent_failed"'))).toHaveLength(1);
    for (let i = 6; i < 20; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    expect(sent).toHaveLength(6); // 3 quick (0, 10, 20 min) + 3 slow (50, 80, 110 min); at 140 min it is 2 h old: no more
    expect(JSON.parse(store.get()!.text).outbox).toMatchObject([{ status: "sent_failed", tries: 6 }]);
  });

  it("a short ntfy outage does not lose the alert: it goes out on a slow retry", async () => {
    const w: World = { docs: { ...stale } };
    let up = false;
    const { d, sent, store } = deps(w, memStore(), { send: async () => (up ? "sent" : "failed") });
    for (let i = 0; i < 4; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    up = true;
    for (let i = 4; i < 8; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    expect(sent).toHaveLength(4); // 3 failed quick tries, then the slow one at tick 5 goes
    expect(JSON.parse(store.get()!.text).outbox).toEqual([]);
  });

  it("a late page that went out, then a lost record, then recovery: the recovery is still sent", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    let writes = 0;
    d.writeState = async (body, opts) => {
      writes++;
      if (writes === 2) throw new Error("store down"); // run 1's phase 2: the late page's record is lost
      return store.writeState(body, opts);
    };
    await runFeedWatch(LATE_AT, d, only("options-edition"));
    w.docs = { ...fresh };
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toContain("feed-recovered");
  });

  it("a late page claimed but not sent for want of time, then recovery: both go out (a claim may have been sent)", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    let t = 0;
    d.clock = () => t;
    const read = store.readState;
    d.readState = async () => {
      t += FEED_RUN_BUDGET_MS; // no time left to send: the claim records no try
      return read();
    };
    await runFeedWatch(LATE_AT, d, only("options-edition"));
    d.readState = read;
    // A claim was stored, so the page counts as claimed (maybe sent): its recovery is still sent.
    w.docs = { ...fresh };
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late", "feed-recovered"]);
  });

  it("a late page that could not be sent, then recovery: one combined page says what happened", async () => {
    const w: World = { docs: { ...stale } };
    let up = false;
    const { d, sent } = deps(w, memStore(), { send: async () => (up ? "sent" : "failed") });
    for (let i = 0; i < 3; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    up = true;
    w.docs = { ...fresh };
    await runFeedWatch(new Date(LATE_AT.getTime() + 30 * 60_000), d, only("options-edition"));
    expect(sent.slice(3).map((n) => n.title)).toEqual(["Options edition was late, now back on time"]);
    expect(sent[3]!.message).toContain("was late for 30 min and is back on time. The page about it could not be sent.");
  });

  it("three unconfirmed phase-1 writes in a row, then a healthy run: the alert is sent once", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    let bad = 3;
    const write = store.writeState;
    d.writeState = async (body, opts) => {
      if (bad > 0) {
        bad--;
        await write(body, opts); // it lands, late...
        throw new Error("timed out"); // ...after the run gave up on it
      }
      return write(body, opts);
    };
    const read = store.readState;
    for (let i = 0; i < 3; i++) {
      // The re-read after the timeout fails too: the run cannot confirm, and sends nothing.
      d.readState = async () => {
        d.readState = async () => {
          throw new Error("store down");
        };
        return read(); // the run's first read works
      };
      const r = await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
      expect(r).toMatchObject({ state: "write-failed" });
      d.readState = read;
    }
    expect(sent).toEqual([]);
    await runFeedWatch(new Date(LATE_AT.getTime() + 30 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
  });

  it("a page is not re-sent within the tick that claimed it", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w, memStore(), { send: async () => "failed" });
    await runFeedWatch(LATE_AT, d, only("options-edition"));
    await runFeedWatch(new Date(LATE_AT.getTime() + 60_000), d, only("options-edition")); // the same 10-minute tick
    expect(sent).toHaveLength(1);
  });

  it("the reproduced loss: the first write lands but its reply is lost; the page is still sent, exactly once", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    let first = true;
    d.writeState = async (body, opts) => {
      const r = await store.writeState(body, opts);
      if (first) {
        first = false;
        throw new Error("reply lost");
      }
      return r;
    };
    for (let i = 0; i < 7; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
  });

  it("a phase-2 record that fails after a good send: at most one duplicate, then it settles", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    let writes = 0;
    d.writeState = async (body, opts) => {
      writes++;
      if (writes === 2) throw new Error("store down"); // run 1's phase 2
      return store.writeState(body, opts);
    };
    for (let i = 0; i < 5; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late", "feed-late"]);
    expect(JSON.parse(store.get()!.text).outbox).toEqual([]);
  });

  it("two overlapping runs on a pending page send it once between them", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    let result: "sent" | "failed" = "failed";
    const first = deps(w, store, { send: async () => result });
    await runFeedWatch(LATE_AT, first.d, only("options-edition")); // pending, attempt 1 failed
    result = "sent";
    const a = deps(w, store);
    const b = deps(w, store);
    const t = new Date(LATE_AT.getTime() + 10 * 60_000);
    await Promise.all([runFeedWatch(t, a.d, only("options-edition")), runFeedWatch(t, b.d, only("options-edition"))]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });

  it("a phase-1 write that throws, then a re-read that fails: nothing sent, and the next run pages once", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    const read = store.readState;
    const write = store.writeState;
    d.writeState = async () => {
      throw new Error("store down"); // nothing lands
    };
    d.readState = async () => {
      d.readState = async () => {
        throw new Error("store down");
      };
      return read();
    };
    const r = await runFeedWatch(new Date("2026-11-12T23:25:00Z"), d, only("options-edition"));
    expect(r).toMatchObject({ state: "write-failed", sent: 0 });
    expect(sent).toEqual([]);
    expect(store.get()).toBeNull();
    d.readState = read;
    d.writeState = write;
    await runFeedWatch(new Date("2026-11-12T23:35:00Z"), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
  });

  it("fails closed when the state cannot be written: no feed page, so a refusing store cannot loop a page", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w);
    d.writeState = async () => {
      throw new Error("store down");
    };
    const r = await runFeedWatch(new Date("2026-11-12T23:25:00Z"), d, only("options-edition")); // not a notice tick
    expect(sent).toEqual([]);
    expect(r).toMatchObject({ committed: false, state: "write-failed" });
  });

  it("a page not sent within the run's budget stays pending and is sent next run", async () => {
    const w: World = { docs: { ...stale } };
    let t = 0;
    const { d, sent, store } = deps(w, memStore(), { clock: () => t });
    const read = store.readState;
    d.readState = async () => {
      t += FEED_RUN_BUDGET_MS; // the reads used the whole budget
      return read();
    };
    const r = await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(sent).toEqual([]);
    expect(r).toMatchObject({ failed: 0, sent: 0 }); // no send was made, so no try is used
    d.readState = read;
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), d, only("options-edition"));
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
  });

  it("a lost precondition race is another run, never a store failure, and never a store notice", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent } = deps(w, store);
    let raced = false;
    d.writeState = async (body, opts) => {
      if (!raced) {
        raced = true;
        // Another run commits a different decision in between (its own incident state for another feed).
        await store.writeState(JSON.stringify({ v: 1, alerts: "on", feeds: { radar: { open: true, episode: "2026-11-12", since: null, sent: true, unknown_runs: 0, unknown_episode: null, unknown_sent: false } }, outbox: [] }), { createOnly: true });
      }
      return store.writeState(body, opts);
    };
    const r = await runFeedWatch(new Date(BLOCK0), d, only("options-edition", "radar")); // a notice tick
    expect(r.state).toBeUndefined();
    expect(sent.map((n) => n.title)).not.toContain("Feed watch cannot read its store");
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]); // decided again on the other run's state: only the edition
  });

  it("a read that fails once is tried again after a short pause", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const { d, sent, sleeps } = deps(w, store);
    let fails = 1;
    d.readState = async () => {
      if (fails-- > 0) throw new Error("blip");
      return store.readState();
    };
    await runFeedWatch(LATE_AT, d, only("options-edition"));
    expect(sleeps).toEqual([500]);
    expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
  });
});

describe("display only (FEED_WATCH_ALERTS unset) and switch-on", () => {
  const ids = ["options-edition", "refusal-options"];
  it("sends nothing while off and stores the incident; at switch-on one summary, then the usual pages", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const off = deps(w, store, { alertsOn: false });
    for (let i = 0; i < 5; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), off.d, only(...ids));
    expect(off.sent).toEqual([]);
    expect(JSON.parse(store.get()!.text)).toMatchObject({ alerts: "off", feeds: { "options-edition": { open: true, sent: false } } });
    const on = deps(w, store, { alertsOn: true });
    for (let i = 5; i < 10; i++) await runFeedWatch(new Date(LATE_AT.getTime() + i * 10 * 60_000), on.d, only(...ids));
    expect(on.sent.map((n) => n.title)).toEqual(["Feed alerts on: 1 not on time"]);
    w.docs = { ...fresh };
    await runFeedWatch(new Date(LATE_AT.getTime() + 120 * 60_000), on.d, only(...ids));
    expect(on.sent.map((n) => n.kind)).toEqual(["feed-late", "feed-recovered"]);
  });

  it("two overlapping runs at switch-on send one summary", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    await runFeedWatch(LATE_AT, deps(w, store, { alertsOn: false }).d, only(...ids));
    const a = deps(w, store);
    const b = deps(w, store);
    const t = new Date(LATE_AT.getTime() + 10 * 60_000);
    await Promise.all([runFeedWatch(t, a.d, only(...ids)), runFeedWatch(t, b.d, only(...ids))]);
    expect([...a.sent, ...b.sent].map((n) => n.title)).toEqual(["Feed alerts on: 1 not on time"]);
  });

  it("a summary whose send fails is sent again on the next run", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    await runFeedWatch(LATE_AT, deps(w, store, { alertsOn: false }).d, only(...ids));
    let result: "sent" | "failed" = "failed";
    const on = deps(w, store, { send: async () => result });
    await runFeedWatch(new Date(LATE_AT.getTime() + 10 * 60_000), on.d, only(...ids));
    result = "sent";
    await runFeedWatch(new Date(LATE_AT.getTime() + 20 * 60_000), on.d, only(...ids));
    await runFeedWatch(new Date(LATE_AT.getTime() + 30 * 60_000), on.d, only(...ids));
    expect(on.sent.map((n) => n.title)).toEqual(["Feed alerts on: 1 not on time", "Feed alerts on: 1 not on time"]);
    expect(JSON.parse(store.get()!.text).outbox).toEqual([]);
  });
});

describe("overlapping runs on clocks a few milliseconds apart", () => {
  it("page once", async () => {
    const w: World = { docs: { ...stale } };
    const store = memStore();
    const a = deps(w, store);
    const b = deps(w, store);
    await Promise.all([
      runFeedWatch(new Date(LATE_AT.getTime() + 3), a.d, only("options-edition")),
      runFeedWatch(new Date(LATE_AT.getTime() + 41), b.d, only("options-edition")),
    ]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });
});

describe("a new row is read, evaluated and alerted with no other change", () => {
  it("a new row (an after-close selection pass) is read by the runner, evaluated and paged", async () => {
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

describe("the pages' loader derives what it reads from the table", () => {
  it("a new row's document is read by its path, its refusal kind and the shadow records only when asked for", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { loadPageFeeds } = await import("@/lib/feed-watch-run");
    const stage: DocFeed = {
      type: "doc",
      id: "selection-stage-1",
      name: "Selection stage 1",
      short: "Stage 1",
      path: "selection/stage1.json",
      ingest_kind: "options",
      stamp: () => ({ session: null, at: null }),
      want: "next-session",
      schedules: [{ zone: "America/New_York", times: ["16:30"], grace_min: 30 }],
      severity: "alert",
      verified: true,
      misses_to_alert: 1,
    };
    const table: FeedRow[] = [...FEEDS, stage];
    const s = await loadPageFeeds({ ids: ["selection-stage-1"] }, LATE_AT, table);
    expect(s.stamps).toEqual({ "selection-stage-1": { status: "missing" } }); // fixture mode: nothing in the store
    expect(Object.keys(s.refusals)).toEqual(["options"]);
    expect(s.shadow).toBeNull();
  });
});

describe("when the alert state itself cannot be read or written", () => {
  // Ticks every 10 minutes from 00:00 UTC on Friday 13 November 2026: ticks 0 and 1 of each 2-hour block may notify.
  const tickAt = (i: number) => new Date(BLOCK0 + i * 10 * 60_000 + 4_000); // each run starts a few seconds after its tick

  it("24 ticks with the read failing: 4 store notices (ticks 0 and 1 of each block), no late page", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w);
    let reads = 0;
    d.readState = async () => {
      reads++;
      throw new Error("store down");
    };
    for (let i = 0; i < 24; i++) await runFeedWatch(tickAt(i), d, only("options-edition"));
    expect(sent.map((n) => n.title)).toEqual(Array(4).fill("Feed watch cannot read its store"));
    expect(reads).toBe(48); // two tries per run
  });

  it("a skipped notice run is covered by the block's other one: silence never passes 2 hours 10 minutes", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w);
    d.readState = async () => Promise.reject(new Error("store down"));
    for (let i = 0; i < 24; i++) if (i !== 12) await runFeedWatch(tickAt(i), d, only("options-edition")); // tick 12 never ran
    expect(sent).toHaveLength(3);
  });

  it("with alerts off it sends nothing at all", async () => {
    const { d, sent } = deps({ docs: { ...stale } }, memStore(), { alertsOn: false });
    d.readState = async () => Promise.reject(new Error("store down"));
    for (let i = 0; i < 24; i++) await runFeedWatch(tickAt(i), d, only("options-edition"));
    expect(sent).toEqual([]);
  });

  it("a read that fails once and recovers never re-sends the incident paged before it", async () => {
    for (const failAt of [0, 5]) {
      const w: World = { docs: { ...stale } };
      const store = memStore();
      const { d, sent } = deps(w, store);
      await runFeedWatch(new Date(BLOCK0 - 50 * 60_000), d, only("options-edition")); // Thursday 23:10 UTC: late, paged
      expect(sent.map((n) => n.kind)).toEqual(["feed-late"]);
      for (let i = 0; i < 8; i++) {
        d.readState = i === failAt ? async () => Promise.reject(new Error("store down")) : store.readState;
        await runFeedWatch(tickAt(i), d, only("options-edition"));
      }
      const titles = sent.map((n) => n.title);
      expect(titles.filter((t) => t.includes("late by"))).toHaveLength(1);
      expect(titles.filter((t) => t === "Feed watch cannot read its store")).toHaveLength(failAt === 0 ? 1 : 0);
    }
  });

  it("the notice ticks are 0 and 1 of each block, by the run's own time", async () => {
    const { storeNoticeTick } = await import("@/lib/feed-watch-run");
    expect(storeNoticeTick(tickAt(0).getTime())).toBe(true);
    expect(storeNoticeTick(tickAt(0).getTime() + 30_000)).toBe(true);
    expect(storeNoticeTick(tickAt(1).getTime())).toBe(true);
    expect(storeNoticeTick(tickAt(2).getTime())).toBe(false);
    expect(storeNoticeTick(tickAt(12).getTime())).toBe(true);
  });

  it("a write that keeps failing while reads work: no feed page loops, store notices on the notice ticks only", async () => {
    const w: World = { docs: { ...stale } };
    const { d, sent } = deps(w);
    d.writeState = async () => {
      throw new Error("store down");
    };
    for (let i = 0; i < 24; i++) await runFeedWatch(tickAt(i), d, only("options-edition"));
    expect(sent.map((n) => n.title)).toEqual(Array(4).fill("Feed watch cannot read its store"));
  });
});
