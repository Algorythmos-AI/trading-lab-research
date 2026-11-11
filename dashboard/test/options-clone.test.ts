import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionsCloneHealth, OPTIONS_CLONE_ACCEPTS } from "@/lib/editions";
import { fixtureOptionsClone } from "@/lib/fixture-variants";
import { sign } from "@/lib/hmac";
import type { OptionsClone } from "@/lib/options-clone.types";
import type { OptionsEdition } from "@/lib/options.types";
import { isOptionsClone, OPTIONS_CLONE_SCHEMA, validateOptionsClone } from "@/lib/validate";
import cloneJson from "./fixtures/options-clone.v1.json";
import optionsJson from "./fixtures/options.v1.json";

// The options clone (DEC-0030): the focus names go out to the trading host through a signed GET, and the clone's
// session comes back as a SAFE document the Trades page draws.

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
const { FOCUS_SIGNED, focusOf, handleFocus } = await import("@/lib/focus-route");

const HOST_SECRET = "test-host-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-10-12T20:06:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const doc = (mutate?: (d: OptionsClone) => void): OptionsClone => {
  const d = structuredClone(cloneJson) as unknown as OptionsClone;
  mutate?.(d);
  return d;
};
const loose = (d: object) => d as Record<string, unknown>;

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

function get(opts: { secret?: string; keyId?: string; ts?: number; signed?: string; unsigned?: boolean } = {}): Request {
  const ts = opts.ts ?? NOW_S;
  const headers: Record<string, string> = opts.unsigned
    ? {}
    : { "x-wt-timestamp": String(ts), "x-wt-signature": sign(opts.secret ?? HOST_SECRET, ts, opts.signed ?? FOCUS_SIGNED) };
  if (opts.keyId) headers["x-wt-key-id"] = opts.keyId;
  return new Request("https://lab.example/api/focus", { headers });
}

function withFocus(): OptionsEdition {
  const e = structuredClone(optionsJson) as unknown as OptionsEdition;
  e.focus = {
    picked_at: "2026-10-11T21:00:00Z",
    method: "a method note that must never leave through the focus route",
    items: [
      { symbol: "QQQ", rank: 2, bias: "support", why: "a reason that stays on the site", close: 600.1, breakout_above: 602 },
      { symbol: "SPY", rank: 1, bias: "breakout", why: "another reason", close: 580.2, hold_above: 579 },
    ],
  };
  return e;
}

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the options clone document's contract", () => {
  it("takes the fixture and its bad-day variant", () => {
    expect(isOptionsClone(doc())).toBe(true);
    expect(validateOptionsClone(doc()).ok).toBe(true);
    expect(validateOptionsClone(fixtureOptionsClone(doc(), new Set(["clone-latched"]))).ok).toBe(true);
    expect(OPTIONS_CLONE_SCHEMA).toBe("stocksdelta/options-clone");
  });

  it("refuses a setup name, by the site's denylist and by the schema", () => {
    const r = validateOptionsClone(doc((d) => (loose(d.trades[0]!).setup = "retest")));
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors.join("\n")).toContain("/trades/0/setup: key is not allowed to be published");
  });

  it("refuses free text where it takes a code, and says where without the value", () => {
    const r = validateOptionsClone(doc((d) => (d.trades[0]!.exit_reason = "sold because the chart looked weak")));
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.errors.join("\n");
    expect(text).toContain("/trades/0/exit_reason");
    expect(text).not.toContain("chart looked weak");
    expect(validateOptionsClone(doc((d) => (d.off = ["Feed Unfit!"]))).ok).toBe(false);
    expect(validateOptionsClone(doc((d) => (d.gates[0]!.refused_by = { "a gate with spaces": 1 }))).ok).toBe(false);
  });

  it("is paper only, and holds no balance", () => {
    expect(validateOptionsClone(doc((d) => (loose(d).paper = false))).ok).toBe(false);
    expect(validateOptionsClone(doc((d) => (loose(d).equity = 100_000))).ok).toBe(false);
    expect(validateOptionsClone(doc((d) => (loose(d.day_pnl).buying_power = 1))).ok).toBe(false);
  });
});

describe("POST /api/ingest with the clone's document", () => {
  it("keeps the latest only, and touches nothing else", async () => {
    expect((await handleIngest(post(doc()), NOW)).status).toBe(200);
    expect([...blob.store.keys()]).toEqual(["options-clone/latest.json"]);
    const later = doc((d) => ((d.run_id = "later"), (d.as_of = "2026-10-12T20:05:30+00:00")));
    expect((await handleIngest(post(later), NOW)).status).toBe(200);
    expect([...blob.store.keys()]).toEqual(["options-clone/latest.json"]);
    expect(JSON.parse(blob.store.get("options-clone/latest.json")!.text).run_id).toBe("later");
  });

  it("is a duplicate on the same run and 409 when older", async () => {
    await handleIngest(post(doc()), NOW);
    expect((await (await handleIngest(post(doc()), NOW)).json()).status).toBe("duplicate");
    const older = doc((d) => ((d.run_id = "older"), (d.as_of = "2026-10-12T19:00:00+00:00")));
    expect((await handleIngest(post(older), NOW)).status).toBe(409);
  });

  it("is refused from the research environment's key: the clone's trades come from the trading host", async () => {
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

  it("refuses a document dated ahead of the server's clock", async () => {
    const ahead = doc((d) => (d.as_of = "2026-10-13T20:00:00+00:00"));
    expect((await handleIngest(post(ahead), NOW)).status).toBe(422);
    // Nothing is stored but the refusal's record (./ingest-reject), which carries no content.
    expect([...blob.store.keys()]).toEqual(["ops/ingest-rejects/options-clone.json"]);
  });

  it("is never taken for a desk snapshot by a key scoped to a desk", async () => {
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "hft-host": "hft-secret" }));
    vi.stubEnv("DASHBOARD_INGEST_SCOPES", JSON.stringify({ "hft-host": { desks: ["hft"] } }));
    expect((await handleIngest(post(doc(), { secret: "hft-secret", keyId: "hft-host" }), NOW)).status).toBe(403);
    expect(blob.store.size).toBe(0);
  });
});

describe("the health report", () => {
  it("says which session and run are stored, and nothing of the trades", () => {
    const d = doc();
    const h = optionsCloneHealth({ status: "ok", doc: d, source: "blob" });
    expect(h).toEqual({ status: "ok", accepts: OPTIONS_CLONE_ACCEPTS, session: d.session, run_id: d.run_id, as_of: d.as_of, schema_version: 1 });
    expect(JSON.stringify(h)).not.toMatch(/SPY|HYP|usd/);
    expect(optionsCloneHealth({ status: "missing" }).status).toBe("missing");
  });
});

describe("GET /api/focus", () => {
  beforeEach(() => {
    blob.put("options/latest.json", JSON.stringify(withFocus()));
  });

  it("answers a signed request with the focus names by rank and the edition's session, and nothing else", async () => {
    const res = await handleFocus(get(), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      session: "2026-10-12",
      items: [
        { symbol: "SPY", rank: 1, bias: "breakout" },
        { symbol: "QQQ", rank: 2, bias: "support" },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/reason|method|580|602/);
  });

  it("takes a host's own key id", async () => {
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "gcp-use1": "gcp-secret" }));
    expect((await handleFocus(get({ secret: "gcp-secret", keyId: "gcp-use1" }), NOW)).status).toBe(200);
    expect((await handleFocus(get({ secret: HOST_SECRET, keyId: "gcp-use1" }), NOW)).status).toBe(401);
  });

  it("refuses unsigned, wrongly signed, stale and other-route signatures with one answer", async () => {
    const refusals = [
      get({ unsigned: true }),
      get({ secret: "not-the-secret" }),
      get({ ts: NOW_S - 301 }),
      get({ ts: NOW_S + 301 }),
      get({ signed: "" }), // an ingest-style signature over an empty body
      get({ signed: "GET /api/health" }),
      get({ keyId: "nobody" }),
    ];
    for (const req of refusals) {
      const res = await handleFocus(req, NOW);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("matches the Python signer (wt.options.clone_site.focus_signature)", () => {
    expect(sign("focus-test-secret", 1760284800, FOCUS_SIGNED)).toBe("sha256=3b3922dd0b5aa7bdb9ab043108a69e08b8aadf44c48617bf54e7897143320e11");
  });

  it("says 404 before any edition, 503 with no key configured, and an empty list for an edition without focus", async () => {
    blob.reset();
    expect((await handleFocus(get(), NOW)).status).toBe(404);
    blob.put("options/latest.json", JSON.stringify(optionsJson));
    expect(await (await handleFocus(get(), NOW)).json()).toEqual({ session: "2026-10-12", items: [] });
    vi.stubEnv("DASHBOARD_INGEST_SECRET", "");
    expect((await handleFocus(get(), NOW)).status).toBe(503);
  });

  it("keeps symbol, rank and bias only", () => {
    expect(focusOf(withFocus()).items.every((i) => Object.keys(i).sort().join() === "bias,rank,symbol")).toBe(true);
  });
});
