// The drill runs the real watchdog logic but must never touch storage: every Blob function is a spy that fails the
// test if called, and ntfy is recorded.
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  calls: [] as string[],
  sent: [] as { kind: string; title: string; priority: number }[],
}));
vi.mock("@/lib/blob", () => {
  const spy = (name: string) => vi.fn(async () => {
    io.calls.push(name);
    throw new Error(`${name} must not be called by the drill`);
  });
  return {
    LATEST_PATH: "snapshots/latest.json",
    HISTORY_PREFIX: "snapshots/history/",
    ALERT_STATE_PATH: "alerts/state.json",
    PreconditionFailed: class extends Error {},
    readText: spy("readText"),
    readForUpdate: spy("readForUpdate"),
    writeText: spy("writeText"),
    listPaths: spy("listPaths"),
    deleteUrls: spy("deleteUrls"),
  };
});
vi.mock("@/lib/ntfy", async (orig) => ({
  ...(await orig<typeof import("@/lib/ntfy")>()),
  sendNtfy: vi.fn(async (n: { kind: string; title: string; priority: number }) => {
    io.sent.push(n);
    return "sent" as const;
  }),
}));

const { runDrill } = await import("@/lib/watchdog-run");

beforeEach(() => {
  io.calls.length = 0;
  io.sent.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("watchdog drill", () => {
  it("sends a DRILL late page then a DRILL recovered page, with zero storage I/O", async () => {
    const r = await runDrill(new Date("2026-09-30T14:00:00Z"));
    expect(io.calls).toEqual([]);
    expect(io.sent.map((n) => [n.kind, n.priority])).toEqual([["late", 4], ["recovered", 2]]);
    expect(io.sent.every((n) => n.title.startsWith("DRILL: "))).toBe(true);
    expect(r).toMatchObject({ ok: true, drill: true, pages: [
      { kind: "late", priority: 4, result: "sent" },
      { kind: "recovered", priority: 2, result: "sent" },
    ] });
  });

  it("works at any time of day: the window is built around the real now", async () => {
    for (const iso of ["2026-10-03T03:00:00Z", "2026-12-25T12:00:00Z"]) {
      io.sent.length = 0;
      await runDrill(new Date(iso));
      expect(io.sent.map((n) => n.kind)).toEqual(["late", "recovered"]);
    }
  });

  it("reports a failed page instead of hiding it", async () => {
    // The level is rolled back after a failed page (so a real tick would retry), so tick 2 has nothing to
    // recover from: the drill shows one failed "late" page, and `make watchdog-drill` fails.
    const r = await runDrill(new Date("2026-09-30T14:00:00Z"), async () => "failed");
    expect(r.pages).toEqual([{ kind: "late", priority: 4, result: "failed" }]);
    expect(io.calls).toEqual([]);
  });
});
