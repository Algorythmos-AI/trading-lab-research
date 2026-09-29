import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import { fixture } from "./helpers";

// In-memory stand-in for the private Blob store, with etags and an injectable conflict.
const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  let seq = 0;
  const state = { conflicts: 0 };
  return {
    store,
    state,
    PreconditionFailed,
    reset() {
      store.clear();
      seq = 0;
      state.conflicts = 0;
    },
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag });
      return etag;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null } = {}) => {
    if (blob.state.conflicts > 0 && pathname === "snapshots/latest.json") {
      blob.state.conflicts--;
      blob.put(pathname, blob.store.get(pathname)?.text ?? "{}"); // someone else wrote meanwhile
      throw new blob.PreconditionFailed();
    }
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest, historyPath, MAX_BODY_BYTES } = await import("@/lib/ingest");

const SECRET = "test-ingest-secret";
const NOW = new Date("2026-09-29T21:46:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const URL_ = "https://lab.example/api/ingest";

function snapshotBody(runId: string, asOf: string, mutate?: (s: Record<string, unknown>) => void): string {
  const s = fixture() as unknown as Record<string, unknown>;
  s.run_id = runId;
  s.as_of = asOf;
  mutate?.(s);
  return JSON.stringify(s);
}

function signed(body: string, opts: { ts?: number; secret?: string; headers?: Record<string, string> } = {}): Request {
  const ts = opts.ts ?? NOW_S;
  return new Request(URL_, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(ts),
      "x-wt-signature": sign(opts.secret ?? SECRET, ts, Buffer.from(body, "utf8")),
      ...opts.headers,
    },
  });
}

beforeEach(() => {
  blob.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRET);
});

describe("POST /api/ingest", () => {
  it("403 on preview deployments", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:45:00+00:00")), NOW);
    expect(res.status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("403 locally (no VERCEL_ENV), with no override: only production ever writes", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ALLOW_PREVIEW_INGEST", "1"); // the old escape hatch is gone
    expect((await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:45:00+00:00")), NOW)).status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("401 on a bad signature", async () => {
    const res = await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:45:00+00:00"), { secret: "wrong" }), NOW);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" }); // the reason is logged, never returned
    expect(blob.store.size).toBe(0);
  });

  it("401 on a missing signature", async () => {
    const res = await handleIngest(new Request(URL_, { method: "POST", body: "{}" }), NOW);
    expect(res.status).toBe(401);
  });

  it("401 on a stale timestamp (outside +/-300 s)", async () => {
    const body = snapshotBody("r1", "2026-09-29T21:45:00+00:00");
    const res = await handleIngest(signed(body, { ts: NOW_S - 301 }), NOW);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect((await handleIngest(signed(body, { ts: NOW_S + 301 }), NOW)).status).toBe(401);
  });

  it("413 when the body is over the cap (streamed)", async () => {
    const res = await handleIngest(signed("x".repeat(MAX_BODY_BYTES + 1)), NOW);
    expect(res.status).toBe(413);
  });

  it("413 from content-length before reading", async () => {
    const res = await handleIngest(signed("{}", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }), NOW);
    expect(res.status).toBe(413);
  });

  it("422 on invalid JSON", async () => {
    const res = await handleIngest(signed("{not json"), NOW);
    expect(res.status).toBe(422);
  });

  it("422 on a schema violation, without echoing the body", async () => {
    const body = snapshotBody("r1", "2026-09-29T21:45:00+00:00", (s) => {
      s.secret_notes = "do-not-echo";
    });
    const res = await handleIngest(signed(body), NOW);
    expect(res.status).toBe(422);
    const out = await res.json();
    expect(out.error).toBe("invalid");
    expect(JSON.stringify(out)).not.toContain("do-not-echo");
    expect(blob.store.size).toBe(0);
  });

  it("422 on a denylisted key", async () => {
    const body = snapshotBody("r1", "2026-09-29T21:45:00+00:00", (s) => {
      (s.spec as Record<string, unknown>).title = "restricted";
    });
    expect((await handleIngest(signed(body), NOW)).status).toBe(422);
  });

  it("422 when run_id or as_of is null", async () => {
    expect((await handleIngest(signed(snapshotBody("r1", "not a time")), NOW)).status).toBe(422);
    const body = JSON.stringify({ schema: "trading-lab/snapshot", schema_version: 2, run_id: null, as_of: "2026-09-29T21:45:00Z" });
    expect((await handleIngest(signed(body), NOW)).status).toBe(422);
  });

  it("200 stored: writes latest and the hourly history copy", async () => {
    const body = snapshotBody("r1", "2026-09-29T21:45:00+00:00");
    const res = await handleIngest(signed(body), NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stored", run_id: "r1" });
    expect(blob.store.get("snapshots/latest.json")?.text).toBe(body);
    expect(blob.store.get("snapshots/history/2026-09-29/21.json")?.text).toBe(body);
  });

  it("200 duplicate for the same run_id", async () => {
    await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:45:00+00:00")), NOW);
    const res = await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:45:00+00:00")), NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "duplicate", run_id: "r1" });
  });

  it("409 older when as_of is not newer than the stored one", async () => {
    await handleIngest(signed(snapshotBody("r2", "2026-09-29T21:45:00+00:00")), NOW);
    const older = await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:30:00+00:00")), NOW);
    expect(older.status).toBe(409);
    expect(await older.json()).toEqual({ status: "older", run_id: "r1" });
    const same = await handleIngest(signed(snapshotBody("r3", "2026-09-29T21:45:00Z")), NOW);
    expect(same.status).toBe(409);
    expect(JSON.parse(blob.store.get("snapshots/latest.json")!.text).run_id).toBe("r2");
  });

  it("replaces an older stored snapshot", async () => {
    await handleIngest(signed(snapshotBody("r1", "2026-09-29T20:45:00+00:00")), NOW);
    const res = await handleIngest(signed(snapshotBody("r2", "2026-09-29T21:45:00+00:00")), NOW);
    expect(res.status).toBe(200);
    expect(JSON.parse(blob.store.get("snapshots/latest.json")!.text).run_id).toBe("r2");
    expect(blob.store.has("snapshots/history/2026-09-29/20.json")).toBe(true);
    expect(blob.store.has("snapshots/history/2026-09-29/21.json")).toBe(true);
  });

  it("retries once on an etag conflict, then stores", async () => {
    await handleIngest(signed(snapshotBody("r1", "2026-09-29T20:45:00+00:00")), NOW);
    blob.state.conflicts = 1;
    const res = await handleIngest(signed(snapshotBody("r2", "2026-09-29T21:45:00+00:00")), NOW);
    expect(res.status).toBe(200);
    expect(JSON.parse(blob.store.get("snapshots/latest.json")!.text).run_id).toBe("r2");
  });

  it("503 when the conflict persists, so the publisher retries", async () => {
    await handleIngest(signed(snapshotBody("r1", "2026-09-29T20:45:00+00:00")), NOW);
    blob.state.conflicts = 2;
    const res = await handleIngest(signed(snapshotBody("r2", "2026-09-29T21:45:00+00:00")), NOW);
    expect(res.status).toBe(503);
  });

  it("503 when the ingest secret is not configured", async () => {
    vi.stubEnv("DASHBOARD_INGEST_SECRET", "");
    expect((await handleIngest(signed("{}"), NOW)).status).toBe(503);
  });

  it("logs one secret-free JSON line per request", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleIngest(signed(snapshotBody("r1", "2026-09-29T21:45:00+00:00")), NOW);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("sha256=");
    }
  });

  it("maps the snapshot hour to the history path in UTC", () => {
    expect(historyPath(Date.parse("2026-09-29T09:05:00+10:00"))).toBe("snapshots/history/2026-09-28/23.json");
  });
});
