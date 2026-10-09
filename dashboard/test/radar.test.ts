import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import { levelPosition, radarDates, researched, stanceTone, tickersOf, type Radar } from "@/lib/radar";
import { RADAR_SCHEMA, validateRadarEdition } from "@/lib/validate";
import { fixture } from "./helpers";
import radarJson from "./fixtures/radar.v1.json";

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
  SHADOW_LATEST_PATH: "shadow/latest.json",
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

const { handleIngest } = await import("@/lib/ingest");

const DEFAULT_SECRET = "test-default-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-10-09T10:30:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function edition(mutate?: (r: Record<string, unknown>) => void): Record<string, unknown> {
  const r = structuredClone(radarJson) as unknown as Record<string, unknown>;
  mutate?.(r);
  return r;
}

function post(body: unknown, opts: { secret?: string; keyId?: string } = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-wt-timestamp": String(NOW_S),
    "x-wt-signature": sign(opts.secret ?? RADAR_SECRET, NOW_S, Buffer.from(text, "utf8")),
  };
  if (opts.keyId !== "") headers["x-wt-key-id"] = opts.keyId ?? "radar";
  return new Request("https://lab.example/api/ingest", { method: "POST", body: text, headers });
}

beforeEach(() => {
  blob.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", DEFAULT_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("radar edition schema", () => {
  it("accepts the fixture", () => {
    const r = validateRadarEdition(edition());
    expect(r.ok).toBe(true);
    expect(radarJson.schema).toBe(RADAR_SCHEMA);
  });

  it("rejects unknown keys, bad confidence values and non-claude report links", () => {
    expect(validateRadarEdition(edition((r) => (r.extra = 1))).ok).toBe(false);
    expect(
      validateRadarEdition(
        edition((r) => {
          ((r.tickers as Record<string, unknown>[])[0]!.notes as Record<string, unknown>[])[0]!.confidence = "Certain";
        }),
      ).ok,
    ).toBe(false);
    expect(validateRadarEdition(edition((r) => (r.report_url = "https://evil.example/"))).ok).toBe(false);
  });

  it("refuses denylisted keys even inside a radar edition", () => {
    const r = validateRadarEdition(edition((e) => ((e.tickers as Record<string, unknown>[])[0]!.setup = "x")));
    expect(r.ok).toBe(false);
  });

  it("needs an edition date", () => {
    expect(validateRadarEdition(edition((r) => delete r.edition_date)).ok).toBe(false);
    expect(validateRadarEdition(edition((r) => (r.edition_date = "9 Oct"))).ok).toBe(false);
  });
});

describe("POST /api/ingest with a radar edition", () => {
  it("stores latest and the dated copy, never touching the desks' snapshots", async () => {
    const res = await handleIngest(post(edition()), NOW);
    expect(res.status).toBe(200);
    expect([...blob.store.keys()].sort()).toEqual(["radar/editions/2026-09-21.json", "radar/latest.json"]);
  });

  it("is a duplicate on the same run_id and 409 when older", async () => {
    await handleIngest(post(edition()), NOW);
    expect((await (await handleIngest(post(edition()), NOW)).json()).status).toBe("duplicate");
    const older = edition((r) => {
      r.run_id = "radar-older";
      r.as_of = "2026-09-20T09:00:00+00:00";
    });
    expect((await handleIngest(post(older), NOW)).status).toBe(409);
  });

  it("a same-day refresh replaces the dated copy", async () => {
    await handleIngest(post(edition()), NOW);
    const refresh = edition((r) => {
      r.run_id = "radar-refresh";
      r.as_of = "2026-09-21T10:30:00+00:00";
    });
    expect((await handleIngest(post(refresh), NOW)).status).toBe(200);
    expect(JSON.parse(blob.store.get("radar/editions/2026-09-21.json")!.text).run_id).toBe("radar-refresh");
  });

  it("the radar key cannot publish a stocks snapshot", async () => {
    const snap = fixture() as unknown as Record<string, unknown>;
    snap.run_id = "r1";
    snap.as_of = "2026-10-09T10:29:00+00:00";
    const res = await handleIngest(post(snap), NOW);
    expect(res.status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("401 when signed with the wrong key, or with the radar key under the default id", async () => {
    expect((await handleIngest(post(edition(), { secret: "wrong" }), NOW)).status).toBe(401);
    expect((await handleIngest(post(edition(), { keyId: "" }), NOW)).status).toBe(401);
  });

  it("401 when the radar key is not configured on the server", async () => {
    vi.stubEnv("RADAR_INGEST_SECRET", "");
    expect((await handleIngest(post(edition()), NOW)).status).toBe(401);
  });

  it("the default key may publish a radar edition too", async () => {
    expect((await handleIngest(post(edition(), { secret: DEFAULT_SECRET, keyId: "" }), NOW)).status).toBe(200);
  });

  it("422 on an invalid radar edition, without echoing it", async () => {
    const res = await handleIngest(post(edition((r) => (r.private_note = "do-not-echo"))), NOW);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("do-not-echo");
  });
});

describe("radar view helpers", () => {
  const r = radarJson as unknown as Radar;

  it("lists edition dates newest first and ignores other paths", () => {
    expect(
      radarDates(["radar/editions/2026-10-08.json", "radar/editions/2026-10-09.json", "radar/latest.json", "radar/editions/x.json"], "radar/editions/"),
    ).toEqual(["2026-10-09", "2026-10-08"]);
  });

  it("orders a watchlist as the edition does and finds researched names", () => {
    expect(tickersOf(r, "SUPPORT PLAYS").map((t) => t.symbol)).toEqual(["AMZN", "GOOGL", "IBKR"]);
    expect(tickersOf(r, "NOT A LIST")).toEqual([]);
    expect(researched(r).length).toBe(6);
  });

  it("places price between support and the 52-week high", () => {
    expect(levelPosition({ price: 150, support: 100, high_52w: 200 })).toBe(0.5);
    expect(levelPosition({ price: 90, support: 100, high_52w: 200 })).toBe(0);
    expect(levelPosition({ price: 150, support: null, high_52w: 200 })).toBeNull();
  });

  it("colours stances", () => {
    expect(stanceTone("Downtrend")).toBe("bad");
    expect(stanceTone("Held support")).toBe("good");
    expect(stanceTone("Testing support")).toBe("warn");
    expect(stanceTone("At highs")).toBe("info");
    expect(stanceTone(null)).toBe("neutral");
  });
});
