// The feed watch drill (`make feed-watch-drill`): the real runFeedWatch on in-memory state through a late edition and
// its recovery, offline. Every Blob function is a spy that fails the test if called, ntfy is never reached (the drill
// hands each page to the recorder below), and the two pages are printed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ calls: [] as string[], ntfy: 0 }));
vi.mock("@/lib/blob", () => {
  const spy = (name: string) =>
    vi.fn(async () => {
      io.calls.push(name);
      throw new Error(`${name} must not be called by the drill`);
    });
  return {
    LATEST_PATH: "snapshots/latest.json",
    HISTORY_PREFIX: "snapshots/history/",
    ALERT_STATE_PATH: "alerts/state.json",
    PreconditionFailed: class extends Error {},
    readText: spy("readText"),
    readTextIfChanged: spy("readTextIfChanged"),
    readForUpdate: spy("readForUpdate"),
    writeText: spy("writeText"),
    storedAt: spy("storedAt"),
    exists: spy("exists"),
    listPaths: spy("listPaths"),
    deleteUrls: spy("deleteUrls"),
  };
});
vi.mock("@/lib/ntfy", async (orig) => ({
  ...(await orig<typeof import("@/lib/ntfy")>()),
  sendNtfy: vi.fn(async () => {
    io.ntfy++;
    return "sent" as const;
  }),
}));

const { runFeedDrill } = await import("@/lib/feed-watch-run");

beforeEach(() => {
  io.calls.length = 0;
  io.ntfy = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("feed watch drill", () => {
  it("pages late, then back on time, with no storage I/O and nothing sent to ntfy", async () => {
    const recorded: string[] = [];
    const r = await runFeedDrill(async (n) => {
      recorded.push(`${n.kind} | p${n.priority} | ${n.title} | ${n.message}`);
      return "sent";
    });
    expect(io.calls).toEqual([]);
    expect(io.ntfy).toBe(0);
    expect(r.pages.map((n) => [n.kind, n.priority])).toEqual([
      ["feed-late", 4],
      ["feed-recovered", 2],
    ]);
    expect(r.pages.every((n) => n.title.startsWith("DRILL: "))).toBe(true);
    expect(r.pages[0]!.message).toBe(
      "Options edition is late: 38 min past its 17:52 New York deadline, for the session of 2026-11-13. Checked 18:30 New York. The stored copy is for an earlier session.",
    );
    expect(r.pages[1]!.message).toBe(
      "Options edition recovered: it is on time (2 min old), for the session of 2026-11-13. Checked 18:40 New York. The earlier alert is cleared.",
    );
    // The drill's output: the two pages as they would be sent.
    process.stdout.write(`\nfeed watch drill\n${recorded.map((l) => `  ${l}`).join("\n")}\n\n`);
  });

  it("reports a failed page instead of hiding it: the incident is put back and the recovery has nothing to clear", async () => {
    const r = await runFeedDrill(async () => "failed");
    expect(r.pages.map((n) => n.kind)).toEqual(["feed-late"]);
    expect(io.calls).toEqual([]);
  });
});
