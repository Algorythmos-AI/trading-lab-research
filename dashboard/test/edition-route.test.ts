import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import optionsJson from "./fixtures/options.v1.json";
import journalJson from "./fixtures/journal.v1.json";
import radarJson from "./fixtures/radar.v1.json";

// GET /api/editions/<kind>: the trading host's pipeline check reads back the stored radar and options editions.

const blob = vi.hoisted(() => {
  const store = new Map<string, { text: string; etag: string }>();
  return { store, reset: () => store.clear(), put: (p: string, t: string) => store.set(p, { text: t, etag: '"e"' }) };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: class extends Error {},
  listPaths: vi.fn(async () => []),
  readText: vi.fn(async (p: string) => blob.store.get(p) ?? null),
  readForUpdate: vi.fn(async (p: string) => blob.store.get(p) ?? null),
  writeText: vi.fn(async () => ({ etag: '"e"' })),
}));

const { editionSigned, handleEdition } = await import("@/lib/edition-route");

const HOST = "test-host-secret";
const NOW = new Date("2026-10-12T12:40:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function get(kind: string, o: { secret?: string; keyId?: string; ts?: number; signed?: string } = {}): Request {
  const ts = o.ts ?? NOW_S;
  const headers: Record<string, string> = {
    "x-wt-timestamp": String(ts),
    "x-wt-signature": sign(o.secret ?? HOST, ts, o.signed ?? `GET /api/editions/${kind}`),
  };
  if (o.keyId) headers["x-wt-key-id"] = o.keyId;
  return new Request(`https://lab.example/api/editions/${kind}`, { headers });
}

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST);
  vi.stubEnv("RADAR_INGEST_SECRET", "test-radar-secret");
  blob.put("radar/latest.json", JSON.stringify(radarJson));
  blob.put("options/latest.json", JSON.stringify(optionsJson));
  blob.put("journal/latest.json", JSON.stringify(journalJson));
});

describe("GET /api/editions/<kind>", () => {
  it("returns the stored radar, options and journal editions to a signed host request", async () => {
    for (const [kind, fixture] of [["radar", radarJson], ["options", optionsJson], ["journal", journalJson]] as const) {
      const res = await handleEdition(get(kind), kind, NOW);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.kind).toBe(kind);
      expect(body.edition.run_id).toBe((fixture as { run_id: string }).run_id);
    }
  });

  it("refuses the radar's own key, wrong, stale and other-path signatures with one answer", async () => {
    const refusals = [
      get("radar", { secret: "test-radar-secret", keyId: "radar" }),
      get("radar", { secret: "wrong" }),
      get("radar", { ts: NOW_S - 301 }),
      get("radar", { signed: editionSigned("options") }),
      get("radar", { signed: "GET /api/focus" }),
      get("radar", { keyId: "nobody" }),
    ];
    for (const req of refusals) {
      const res = await handleEdition(req, "radar", NOW);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("says 404 for an unknown kind or before any edition, 503 with no key configured", async () => {
    expect((await handleEdition(get("ledger"), "ledger", NOW)).status).toBe(404);
    blob.reset();
    expect((await handleEdition(get("radar"), "radar", NOW)).status).toBe(404);
    vi.stubEnv("DASHBOARD_INGEST_SECRET", "");
    expect((await handleEdition(get("radar"), "radar", NOW)).status).toBe(503);
  });

  it("matches the Python signer (wt.options.pipeline_check.edition_signature)", () => {
    expect(sign("edition-test-secret", 1760284800, editionSigned("radar"))).toBe("sha256=ddff8b93300e0eb8db538fcbd86c4bc20037231a912b632f3063006d5be516bc");
  });
});
