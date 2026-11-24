import { beforeEach, describe, expect, it, vi } from "vitest";
import { GAP_HUNTER_LIVE_ACCEPTS, gapHunterLiveHealth } from "@/lib/editions";
import type { GapHunterLive } from "@/lib/gap-hunter-live.types";
import { sign } from "@/lib/hmac";
import { GAP_HUNTER_LIVE_SCHEMA, isGapHunterLive, validateGapHunterLive } from "@/lib/validate";
import snapshotJson from "./fixtures/snapshot.v3.json";

// Gap Hunter's live state (DEC-0078): the stocks snapshot's `gap_hunter` block on its own, sent by the trading host
// every minute in session and stored as its own document, because the ingest has no partial merge of a snapshot.

const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  let seq = 0;
  return {
    store,
    PreconditionFailed,
    reset() {
      store.clear();
      seq = 0;
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
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  listPaths: vi.fn(async () => []),
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null } = {}) => {
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest } = await import("@/lib/ingest");

const HOST_SECRET = "test-host-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-10-12T20:11:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const PATH = "gap-hunter-live/latest.json";
const doc = (mutate?: (d: GapHunterLive) => void): GapHunterLive => {
  const block = structuredClone((snapshotJson as unknown as { gap_hunter: GapHunterLive["gap_hunter"] }).gap_hunter);
  const d: GapHunterLive = { schema: GAP_HUNTER_LIVE_SCHEMA, schema_version: 1, run_id: "r1", as_of: "2026-10-12T20:10:00+00:00", paper: true, gap_hunter: block };
  mutate?.(d);
  return d;
};
const loose = (d: object) => d as Record<string, unknown>;
const refused = (d: unknown) => {
  const r = validateGapHunterLive(d);
  return r.ok ? "" : r.errors.join("\n");
};

function post(body: unknown, opts: { secret?: string; keyId?: string } = {}): Request {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-wt-timestamp": String(NOW_S),
    "x-wt-signature": sign(opts.secret ?? HOST_SECRET, NOW_S, Buffer.from(text, "utf8")),
  };
  if (opts.keyId) headers["x-wt-key-id"] = opts.keyId;
  return new Request("https://lab.example/api/ingest", { method: "POST", body: text, headers });
}

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the Gap Hunter live document's contract", () => {
  it("takes the fixture snapshot's own block, with its pick and position", () => {
    expect(GAP_HUNTER_LIVE_SCHEMA).toBe("stocksdelta/gap-hunter-live");
    expect(isGapHunterLive(doc())).toBe(true);
    expect(refused(doc())).toBe("");
    expect(doc().gap_hunter.position).toBeTruthy();
  });

  it("refuses a document that is not paper, of another version, or with a key the block does not have", () => {
    expect(refused(doc((d) => (loose(d).paper = false)))).not.toBe("");
    expect(refused(doc((d) => (loose(d).schema_version = 2)))).not.toBe("");
    expect(refused(doc((d) => (loose(d.gap_hunter).note = "free text")))).toContain('unknown key "note"');
  });

  it("refuses a setup name anywhere, by the site's denylist", () => {
    expect(refused(doc((d) => (loose(d.gap_hunter.position!).setup = "anything")))).toContain("/gap_hunter/position/setup: key is not allowed to be published");
  });
});

describe("POST /api/ingest with the Gap Hunter live document", () => {
  it("keeps the latest only, and touches nothing else", async () => {
    expect((await handleIngest(post(doc()), NOW)).status).toBe(200);
    expect([...blob.store.keys()]).toEqual([PATH]);
    const later = doc((d) => ((d.run_id = "later"), (d.as_of = "2026-10-12T20:10:30+00:00")));
    expect((await handleIngest(post(later), NOW)).status).toBe(200);
    expect([...blob.store.keys()]).toEqual([PATH]);
    expect(JSON.parse(blob.store.get(PATH)!.text).run_id).toBe("later");
  });

  it("is a duplicate on the same run and 409 when older", async () => {
    await handleIngest(post(doc()), NOW);
    expect((await (await handleIngest(post(doc()), NOW)).json()).status).toBe("duplicate");
    const older = doc((d) => ((d.run_id = "older"), (d.as_of = "2026-10-12T19:00:00+00:00")));
    expect((await handleIngest(post(older), NOW)).status).toBe(409);
  });

  it("is refused from the research environment's key: the robot's state comes from the trading host", async () => {
    expect((await handleIngest(post(doc(), { secret: RADAR_SECRET, keyId: "radar" }), NOW)).status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("is acknowledged and dropped from a host that is not the primary", async () => {
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "gcp-use1": HOST_SECRET }));
    vi.stubEnv("PRIMARY_HOST", "gcp-use1");
    expect(await (await handleIngest(post(doc()), NOW)).json()).toMatchObject({ status: "ignored", shadow: true });
    expect(blob.store.size).toBe(0);
    expect((await handleIngest(post(doc(), { keyId: "gcp-use1" }), NOW)).status).toBe(200);
  });

  it("records a refusal without storing it or its values, and refuses one dated ahead of the clock", async () => {
    expect((await handleIngest(post(doc((d) => (loose(d.gap_hunter.position!).setup = "secret-name"))), NOW)).status).toBe(422);
    expect([...blob.store.keys()]).toEqual(["ops/ingest-rejects/gap-hunter-live.json"]);
    expect(blob.store.get("ops/ingest-rejects/gap-hunter-live.json")!.text).not.toMatch(/secret-name/);
    expect((await handleIngest(post(doc((d) => (d.as_of = "2026-10-13T20:00:00+00:00"))), NOW)).status).toBe(422);
    expect(blob.store.has(PATH)).toBe(false);
  });

  it("is never taken for a desk snapshot by a key scoped to a desk", async () => {
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "hft-host": "hft-secret" }));
    vi.stubEnv("DASHBOARD_INGEST_SCOPES", JSON.stringify({ "hft-host": { desks: ["hft"] } }));
    expect((await handleIngest(post(doc(), { secret: "hft-secret", keyId: "hft-host" }), NOW)).status).toBe(403);
    expect(blob.store.size).toBe(0);
  });
});

describe("the health report", () => {
  it("says which run is stored and what the site accepts, and nothing of the robot's state", () => {
    const d = doc();
    const h = gapHunterLiveHealth({ status: "ok", doc: d, source: "blob" });
    expect(h).toEqual({ status: "ok", accepts: GAP_HUNTER_LIVE_ACCEPTS, run_id: "r1", as_of: d.as_of, schema_version: 1 });
    expect(JSON.stringify(h)).not.toMatch(/position|symbol|AAAA/);
    expect(gapHunterLiveHealth({ status: "missing" })).toMatchObject({ status: "missing", accepts: 1, run_id: null });
  });
});
