// The watchdog tick against a fake Blob SDK (real etag round trip) and a recorded ntfy.
// The first two tests fail on the old code: it took the state etag from get(), every conditional write
// was rejected, and the tick returned "skipped" before paging, so the dead-man's switch never paged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeBlobSdk } from "./blob-sdk";
import { cleanSnapshot } from "./helpers";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});
const pages = vi.hoisted(() => ({ sent: [] as { kind: string }[], result: "sent" as "sent" | "failed" }));
vi.mock("@/lib/ntfy", async (orig) => ({
  ...(await orig<typeof import("@/lib/ntfy")>()),
  sendNtfy: vi.fn(async (n: { kind: string }) => {
    pages.sent.push(n);
    return pages.result;
  }),
}));

const { runWatchdog } = await import("@/lib/watchdog-run");
const LATEST = "snapshots/latest.json";
const STATE = "alerts/state.json";
const LATE = new Date("2026-09-29T12:40:00Z"); // 40 min after the snapshot, inside the 11:30-22:00Z window

beforeEach(() => {
  sdk.current.reset();
  pages.sent.length = 0;
  pages.result = "sent";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  sdk.current.write(LATEST, JSON.stringify(cleanSnapshot()));
});

const storedLevel = () => JSON.parse(sdk.current.store.get(STATE)!.text).level;

describe("watchdog tick", () => {
  it("pages a transition once and persists it; the next tick is quiet", async () => {
    sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-29" }));
    const r1 = await runWatchdog(LATE);
    expect(pages.sent.map((n) => n.kind)).toEqual(["late"]);
    expect(r1).toMatchObject({ committed: true });
    expect(storedLevel()).toBe("late");
    await runWatchdog(new Date("2026-09-29T12:50:00Z"));
    expect(pages.sent).toHaveLength(1);
  });

  it("pages on the first tick of a UTC day (prune bookkeeping changes the state)", async () => {
    sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-28" }));
    await runWatchdog(LATE);
    expect(pages.sent.map((n) => n.kind)).toEqual(["late"]);
    expect(JSON.parse(sdk.current.store.get(STATE)!.text).last_prune_day).toBe("2026-09-29");
  });

  it("still pages when the state can't be written (fails open)", async () => {
    sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-29" }));
    sdk.current.hooks.beforePut = (pathname) => {
      if (pathname === STATE) throw new sdk.current.BlobError("store unavailable");
    };
    const r = await runWatchdog(LATE);
    expect(pages.sent.map((n) => n.kind)).toEqual(["late"]);
    expect(r).toMatchObject({ committed: false });
  });

  it("stays quiet only when another tick already committed the same transition", async () => {
    sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-29" }));
    sdk.current.hooks.beforePut = (pathname, body) => {
      if (pathname !== STATE) return;
      sdk.current.hooks.beforePut = undefined;
      sdk.current.write(STATE, body); // the concurrent tick wrote exactly this state (and paged)
    };
    const r = await runWatchdog(LATE);
    expect(r).toMatchObject({ skipped: "concurrent run" });
    expect(pages.sent).toHaveLength(0);
  });

  it("pages when a concurrent write left a different state", async () => {
    sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-29" }));
    sdk.current.hooks.beforePut = (pathname) => {
      if (pathname !== STATE) return;
      sdk.current.hooks.beforePut = undefined;
      sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-30" }));
    };
    await runWatchdog(LATE);
    expect(pages.sent.map((n) => n.kind)).toEqual(["late"]);
  });

  it("creates the state on first use and pages", async () => {
    await runWatchdog(LATE);
    expect(pages.sent.map((n) => n.kind)).toEqual(["late"]);
    expect(storedLevel()).toBe("late");
  });

  it("rolls the level back when the page failed, so the next tick retries it", async () => {
    sdk.current.write(STATE, JSON.stringify({ level: "ok", last_prune_day: "2026-09-29" }));
    pages.result = "failed";
    await runWatchdog(LATE);
    expect(storedLevel()).toBe("ok");
    pages.result = "sent";
    await runWatchdog(new Date("2026-09-29T12:50:00Z"));
    expect(pages.sent.map((n) => n.kind)).toEqual(["late", "late"]);
  });
});

describe("watchdog tick with injected dependencies", () => {
  it("survives an unreadable latest snapshot (judged like a missing one, never a crashed tick)", async () => {
    const sent: string[] = [];
    const r = await runWatchdog(LATE, {
      readLatest: async () => {
        throw new Error("blob read failed");
      },
      readState: async () => null,
      writeState: async () => ({ etag: "e1" }),
      listHistory: async () => [],
      deleteHistory: async () => undefined,
      send: async (n) => {
        sent.push(n.kind);
        return "sent";
      },
      prune: false,
    });
    expect(r).toMatchObject({ ok: true, has_snapshot: false });
  });
});
