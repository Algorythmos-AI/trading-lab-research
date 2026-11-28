// The stored journal as every page gets it (loadJournal): a row that cannot be read (a null trade, a piece with no
// closed_at) is left out and counted when it is read, so no page that reads the trades can throw on it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNAL_PATHS } from "@/lib/desk";
import journalJson from "./fixtures/journal.v1.json";

const store = new Map<string, string>();
vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  readText: vi.fn(async (pathname: string) => (store.has(pathname) ? { text: store.get(pathname)! } : null)),
  listPaths: vi.fn(async () => []),
}));

const doc = journalJson as unknown as { trades: unknown[] };

describe("loadJournal", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.resetModules();
    store.clear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("leaves out the rows it cannot read and counts them", async () => {
    const broken = { ...doc, trades: [null, { ...(doc.trades[0] as object), closed_at: undefined }, ...doc.trades] };
    store.set(JOURNAL_PATHS.latest, JSON.stringify(broken));
    const { loadJournal } = await import("@/lib/snapshot");
    const r = await loadJournal();
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.skipped).toBe(2);
    expect(r.doc.trades).toHaveLength(doc.trades.length);
    expect(r.doc.trades.every((t) => t !== null && typeof t.closed_at === "string")).toBe(true);
  });

  it("changes nothing in a whole journal", async () => {
    store.set(JOURNAL_PATHS.latest, JSON.stringify(doc));
    const { loadJournal } = await import("@/lib/snapshot");
    const r = await loadJournal();
    expect(r).toMatchObject({ status: "ok", skipped: 0, source: "blob" });
    if (r.status === "ok") expect(r.doc.trades).toEqual(doc.trades);
  });
});
