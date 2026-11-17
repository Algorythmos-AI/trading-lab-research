import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import radarJson from "./fixtures/radar.v1.json";

// The radar edition copies (DEC-0055): every radar edition that became latest is kept once, keyed by its
// edition_date, never overwritten, with the store's own receipt time; the research key can list them for a date.

const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  const uploaded = new Map<string, string>();
  const clock = { now: "2026-11-18T11:12:00.000Z" };
  let seq = 0;
  const put = (pathname: string, text: string) => {
    const etag = `"e${++seq}"`;
    store.set(pathname, { text, etag });
    uploaded.set(pathname, clock.now);
    return etag;
  };
  return {
    store,
    uploaded,
    clock,
    put,
    PreconditionFailed,
    reset() {
      store.clear();
      uploaded.clear();
      clock.now = "2026-11-18T11:12:00.000Z";
      seq = 0;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => {
    const b = blob.store.get(pathname);
    return b ? { ...b, uploadedAt: blob.uploaded.get(pathname) } : null;
  }),
  exists: vi.fn(async (pathname: string) => blob.store.has(pathname)),
  storedMeta: vi.fn(async (pathname: string) => {
    const b = blob.store.get(pathname);
    return b ? { etag: b.etag, uploadedAt: blob.uploaded.get(pathname)! } : null;
  }),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null; createOnly?: boolean } = {}) => {
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    if (opts.createOnly && cur) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
  listPaths: vi.fn(async (prefix: string) =>
    [...blob.store.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname, url: `https://blob.test/${pathname}` })),
  ),
}));

const { handleIngest } = await import("@/lib/ingest");
const { runAndSession, lostMarkerFor, parseLostMarker } = await import("@/lib/edition-copy");
const { repairRadarCopy, repairOptionsCopy, resetCopyRepairMemo } = await import("@/lib/edition-copy-repair");
const { handleRadarCopies, radarCopiesSigned, editionBytes, MAX_COPIES } = await import("@/lib/radar-copies-route");

const RADAR_SECRET = "test-radar-secret";
const HOST_SECRET = "test-host-secret";
const DATE = "2026-11-18";

const edition = (runId: string, asOf: string) => ({ ...structuredClone(radarJson), edition_date: DATE, run_id: runId, as_of: asOf });

function postAt(body: unknown, at: Date): Request {
  const text = JSON.stringify(body);
  const ts = Math.floor(at.getTime() / 1000);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(ts),
      "x-wt-signature": sign(RADAR_SECRET, ts, Buffer.from(text, "utf8")),
      "x-wt-key-id": "radar",
    },
  });
}

function listing(date: string, now: Date, key = "radar", secret = RADAR_SECRET, signedDate = date): Request {
  const ts = Math.floor(now.getTime() / 1000);
  return new Request(`https://lab.example/api/research/radar-copies?date=${date}`, {
    headers: { "x-wt-timestamp": String(ts), "x-wt-signature": sign(secret, ts, radarCopiesSigned(signedDate)), "x-wt-key-id": key },
  });
}

async function ingestTwo(): Promise<void> {
  blob.clock.now = "2026-11-18T11:12:40.123Z";
  expect((await handleIngest(postAt(edition("radar-a", "2026-11-18T11:00:00Z"), new Date("2026-11-18T11:12:40Z")), new Date("2026-11-18T11:12:40Z"))).status).toBe(200);
  blob.clock.now = "2026-11-18T13:07:10.456Z";
  expect((await handleIngest(postAt(edition("radar-b", "2026-11-18T13:00:00Z"), new Date("2026-11-18T13:07:10Z")), new Date("2026-11-18T13:07:10Z"))).status).toBe(200);
}

beforeEach(() => {
  blob.reset();
  resetCopyRepairMemo();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("radar edition copies", () => {
  it("keeps each edition that became latest, keyed by its edition_date, with the store's receipt time", async () => {
    await ingestTwo();
    const copies = [...blob.store.keys()].filter((k) => k.startsWith(`radar/copies/${DATE}/`)).sort();
    expect(copies).toEqual([
      `radar/copies/${DATE}/20261118T111240123Z-radar-a.json`,
      `radar/copies/${DATE}/20261118T130710456Z-radar-b.json`,
    ]);
  });

  it("reads a radar edition's date from edition_date, an Options edition's from session", () => {
    expect(runAndSession(JSON.stringify({ run_id: "r", edition_date: DATE }))).toEqual({ runId: "r", session: DATE });
    expect(runAndSession(JSON.stringify({ run_id: "r", session: "2026-11-19", edition_date: DATE }))).toEqual({ runId: "r", session: "2026-11-19" });
    expect(runAndSession(JSON.stringify({ run_id: "r", edition_date: "11/18" })).session).toBeNull();
  });

  it("the repair gives a missing radar copy one, with latest's own receipt time, and leaves the Options kind alone", async () => {
    await ingestTwo();
    const path = `radar/copies/${DATE}/20261118T130710456Z-radar-b.json`;
    blob.store.delete(path);
    const lines: Record<string, unknown>[] = [];
    const deps = {
      meta: async (p: string) => {
        const b = blob.store.get(p);
        return b ? { etag: b.etag, uploadedAt: blob.uploaded.get(p)! } : null;
      },
      read: async (p: string) => blob.store.get(p)?.text ?? null,
      exists: async (p: string) => blob.store.has(p),
      create: async (p: string, body: string) => {
        if (blob.store.has(p)) throw new blob.PreconditionFailed();
        blob.put(p, body);
      },
      log: (_e: string, f: Record<string, unknown>) => lines.push(f),
    };
    expect(await repairRadarCopy(deps)).toBe("repaired");
    expect(blob.store.has(path)).toBe(true);
    expect(lines.at(-1)).toMatchObject({ desk: "radar", outcome: "repaired", session: DATE });
    expect(await repairOptionsCopy(deps)).toBe("no-latest");
    expect(lines.at(-1)).not.toHaveProperty("desk");
  });
});

describe("a radar edition replaced before its copy was made", () => {
  it("leaves a lost marker beside the copies, so the gap is in the store", async () => {
    blob.clock.now = "2026-11-18T11:12:40.123Z";
    const t1 = new Date("2026-11-18T11:12:40Z");
    expect((await handleIngest(postAt(edition("radar-a", "2026-11-18T11:00:00Z"), t1), t1)).status).toBe(200);
    const copy = [...blob.store.keys()].find((k) => k.startsWith(`radar/copies/${DATE}/`))!;
    blob.store.delete(copy);
    blob.clock.now = "2026-11-18T13:07:10.456Z";
    const t2 = new Date("2026-11-18T13:07:10Z");
    expect((await handleIngest(postAt(edition("radar-b", "2026-11-18T13:00:00Z"), t2), t2)).status).toBe(200);
    const marker = `radar/copies/${DATE}/20261118T111240123Z-radar-a.lost.json`;
    expect(parseLostMarker(blob.store.get(marker)!.text)).toEqual({ receivedAt: "2026-11-18T11:12:40.123Z", session: DATE, runId: "radar-a" });
  });

});

describe("GET /api/research/radar-copies", () => {
  const NOW = new Date("2026-11-18T14:31:00Z");

  it("lists every copy for the date, in receipt order, with receipt time, run and both hashes, and nothing else", async () => {
    await ingestTwo();
    const res = await handleRadarCopies(listing(DATE, NOW), NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schema: string; date: string; copies: Record<string, string>[] };
    expect(body.schema).toBe("stocksdelta/radar-copies");
    expect(body.copies.map((c) => [c.received_at, c.run_id])).toEqual([
      ["2026-11-18T11:12:40.123Z", "radar-a"],
      ["2026-11-18T13:07:10.456Z", "radar-b"],
    ]);
    const first = blob.store.get(body.copies[0]!.path!)!.text;
    expect(body.copies[0]!.copy_sha256).toBe(createHash("sha256").update(first).digest("hex"));
    const stored = JSON.stringify(edition("radar-a", "2026-11-18T11:00:00Z"));
    expect(body.copies[0]!.edition_sha256).toBe(createHash("sha256").update(stored).digest("hex"));
    expect(JSON.stringify(body)).not.toContain("DAILY RADAR");
  });

  it("an empty date is an empty list", async () => {
    const res = await handleRadarCopies(listing("2026-11-19", NOW), NOW);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { copies: unknown[] }).copies).toEqual([]);
  });

  it("refuses anything but the radar key's fresh signature for this date", async () => {
    await ingestTwo();
    expect((await handleRadarCopies(listing(DATE, NOW, "default", HOST_SECRET), NOW)).status).toBe(401);
    expect((await handleRadarCopies(listing(DATE, NOW, "radar", "wrong"), NOW)).status).toBe(401);
    expect((await handleRadarCopies(listing(DATE, NOW, "radar", RADAR_SECRET, "2026-11-17"), NOW)).status).toBe(401);
    expect((await handleRadarCopies(listing(DATE, new Date(NOW.getTime() - 600_000)), NOW)).status).toBe(401);
    expect((await handleRadarCopies(new Request(`https://lab.example/api/research/radar-copies?date=${DATE}`), NOW)).status).toBe(401);
    expect((await handleRadarCopies(listing("2026-13-45", NOW), NOW)).status).toBe(400);
  });

  it("never skips a copy it cannot read", async () => {
    await ingestTwo();
    const path = [...blob.store.keys()].find((k) => k.startsWith(`radar/copies/${DATE}/`))!;
    blob.put(path, "not a copy");
    expect((await handleRadarCopies(listing(DATE, NOW), NOW)).status).toBe(502);
  });

  it("refuses rather than truncates an implausible number of copies", async () => {
    const deps = { list: async () => Array.from({ length: MAX_COPIES + 1 }, (_, i) => ({ pathname: `radar/copies/${DATE}/${i}.json` })), read: async () => null };
    expect((await handleRadarCopies(listing(DATE, NOW), NOW, deps)).status).toBe(502);
  });

  it("finds the edition bytes only inside a copy written as the ingest writes it", () => {
    const head = { schema: "stocksdelta/edition-copy", version: 1, received_at: "2026-11-18T11:12:40.123Z", session: DATE, run_id: "r" };
    const good = `${JSON.stringify(head).slice(0, -1)},"edition":{"a":1}}`;
    expect(editionBytes(good)).toBe('{"a":1}');
    const reordered = `{"run_id":"r","schema":"stocksdelta/edition-copy","version":1,"received_at":"2026-11-18T11:12:40.123Z","session":"${DATE}","edition":{"a":1}}`;
    expect(editionBytes(reordered)).toBeNull();
    expect(editionBytes('{"schema":"x"}')).toBeNull();
  });

  it("refuses an impossible date", async () => {
    expect((await handleRadarCopies(listing("2026-02-31", NOW), NOW)).status).toBe(400);
  });

  it("lists a lost marker as a lost row, with no hashes", async () => {
    await ingestTwo();
    const marker = lostMarkerFor("radar/copies/", DATE, "2026-11-18T12:00:00.000Z", "radar-lost")!;
    blob.put(marker.path, marker.body);
    const body = (await (await handleRadarCopies(listing(DATE, NOW), NOW)).json()) as { copies: Record<string, unknown>[] };
    expect(body.copies.map((c) => [c.run_id, c.lost])).toEqual([
      ["radar-a", false],
      ["radar-lost", true],
      ["radar-b", false],
    ]);
    expect(body.copies[1]).toMatchObject({ copy_sha256: null, edition_sha256: null, received_at: "2026-11-18T12:00:00.000Z" });
  });
});
