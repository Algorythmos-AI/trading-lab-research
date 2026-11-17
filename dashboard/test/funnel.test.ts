import { beforeEach, describe, expect, it, vi } from "vitest";
import { FUNNEL_ACCEPTS, funnelHealth } from "@/lib/editions";
import { ENGINE_VERSION } from "@/lib/engine-version.gen";
import { FEEDS } from "@/lib/feed-watch";
import type { FunnelDoc } from "@/lib/funnel.types";
import { sign } from "@/lib/hmac";
import { INGEST_REJECT_KINDS } from "@/lib/ingest-reject";
import { SIGNAL_CODE_HASH } from "@/lib/signal-version.gen";
import { FUNNEL_SCHEMA, isFunnel, validateFunnel } from "@/lib/validate";
import funnelJson from "./fixtures/funnel.v1.json";

// The selection funnel's health document: after each seal, trading-options-funnel sends counts and statuses per
// stage as a research edition, signed with the radar's key. It carries no symbols, prices, scores or outcomes.

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

const RADAR_SECRET = "test-radar-secret";
const HOST_SECRET = "test-host-secret";
const NOW = new Date("2026-10-12T22:25:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const doc = (mutate?: (d: FunnelDoc) => void): FunnelDoc => {
  const d = structuredClone(funnelJson) as unknown as FunnelDoc;
  mutate?.(d);
  return d;
};

function post(body: unknown, keyId = "radar", secret = RADAR_SECRET): Request {
  const text = JSON.stringify(body);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(NOW_S),
      "x-wt-signature": sign(secret, NOW_S, Buffer.from(text, "utf8")),
      "x-wt-key-id": keyId,
    },
  });
}

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the funnel document's contract", () => {
  it("takes the fixture", () => {
    expect(isFunnel(doc())).toBe(true);
    expect(validateFunnel(doc()).ok).toBe(true);
    expect(FUNNEL_SCHEMA).toBe("stocksdelta/funnel");
  });

  it("refuses anything that could carry a name, a price or an outcome", () => {
    const refused = [
      doc((d) => Object.assign(d, { symbols: ["NVDA"] })),
      doc((d) => Object.assign(d.stages[0]!, { picked: ["NVDA"] })),
      doc((d) => Object.assign(d.stages[1]!, { r: 0.5 })),
      doc((d) => Object.assign(d.stages[1]!, { hit_rate: 0.5 })),
      doc((d) => (d.stages[1]!.flags[0]!.code = "NVDA" as never)),
      doc((d) => Object.assign(d, { setup: "a named setup" })),
      doc((d) => ((d.stages[1] as { stage: string }).stage = "board")),
      doc((d) => ((d.stages[1] as { evidence: string }).evidence = "fine")),
      doc((d) => (d.code_commit = "main")),
      doc((d) => (d.stages = [] as unknown as FunnelDoc["stages"])),
    ];
    for (const d of refused) expect(validateFunnel(d).ok).toBe(false);
  });

  it("reports itself on /api/health", () => {
    expect(funnelHealth({ status: "ok", doc: doc(), source: "fixture" })).toMatchObject({
      status: "ok",
      accepts: FUNNEL_ACCEPTS,
      session: "2026-10-13",
      schema_version: 1,
    });
    expect(funnelHealth({ status: "missing" })).toMatchObject({ status: "missing", session: null });
  });

  it("is watched, and its refusals are recorded", () => {
    expect(INGEST_REJECT_KINDS).toContain("funnel");
    const row = FEEDS.find((f) => f.id === "funnel");
    expect(row).toMatchObject({ type: "doc", ingest_kind: "funnel", severity: "display", verified: false });
    expect(FEEDS.some((f) => f.type === "refusal" && f.kind === "funnel")).toBe(true);
  });
});

describe("POST /api/ingest with a funnel document", () => {
  it("the radar's key stores it at funnel/latest.json and one copy per session", async () => {
    const res = await handleIngest(post(doc()), NOW);
    expect(res.status).toBe(200);
    expect(blob.store.has("funnel/latest.json")).toBe(true);
    expect(blob.store.has("funnel/editions/2026-10-13.json")).toBe(true);
    expect(blob.store.has("ledger/latest.json")).toBe(false);
    expect(blob.store.has("radar/latest.json")).toBe(false);
  });

  it("the same run again is a duplicate; an invalid one is refused and only the refusal is recorded", async () => {
    await handleIngest(post(doc()), NOW);
    expect((await (await handleIngest(post(doc()), NOW)).json()).status).toBe("duplicate");
    blob.reset();
    const bad = doc((d) => Object.assign(d.stages[1]!, { r: 1 }));
    expect((await handleIngest(post(bad), NOW)).status).toBe(422);
    expect([...blob.store.keys()]).toEqual(["ops/ingest-rejects/funnel.json"]);
  });

  it("a wrong signature stores nothing", async () => {
    const res = await handleIngest(post(doc(), "radar", "not-the-secret"), NOW);
    expect(res.status).toBe(401);
    expect(blob.store.size).toBe(0);
  });
});

describe("the funnel code stays outside the engine and signal hashes", () => {
  it("no funnel file is in either import closure, and both hashes are unchanged", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const engine = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[]; engineVersion(): string };
    // @ts-expect-error: a plain .mjs script, no types
    const signal = (await import("../scripts/gen-signal.mjs")) as { signalFiles(): string[]; signalHash(): string };
    const files = [...engine.engineFiles(), ...signal.signalFiles()].map((f) => f.replace(/\\/g, "/"));
    expect(files.filter((f) => /\/funnel[^/]*$/.test(f))).toEqual([]);
    expect(engine.engineVersion()).toBe(ENGINE_VERSION);
    expect(signal.signalHash()).toBe(SIGNAL_CODE_HASH);
  });
});

describe("the Operations panel", () => {
  it("draws a card for the funnel's evidence, unwatched until a first night arrives", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeedsPanel } = await import("@/components/operations/feeds-panel");
    const stampOf = (at: string | null): Record<string, { status: "ok"; value: { session: string; at: number } }> =>
      at === null ? {} : { funnel: { status: "ok", value: { session: "2026-10-13", at: Date.parse(at) } } };
    const panel = (at: string | null) =>
      renderToStaticMarkup(
        createElement(FeedsPanel, {
          now: new Date("2026-10-12T23:00:00Z"),
          snapshot: { status: "missing" },
          journal: { status: "missing" },
          options: { status: "missing" },
          optionsLive: { status: "missing" },
          radar: { status: "missing" },
          feeds: { stamps: stampOf(at), refusals: {}, shadow: null },
          optionsDates: [],
          radarDates: [],
        }),
      );
    const none = panel(null);
    expect(none).toContain("Selection funnel evidence");
    expect(none).toContain("not yet watched");
    expect(panel("2026-10-12T22:20:05Z")).toContain("Selection funnel evidence");
  });
});

describe("what the schema alone cannot say", () => {
  it("refuses a ticker in run_id or a flag, a stage twice, counts without evidence, more kept than judged", () => {
    const refused = [
      doc((d) => (d.run_id = "NVDA-AAPL-picked")),
      doc((d) => (d.run_id = "funnel-2026-10-13-nvda")),
      doc((d) => (d.stages[1]!.flags[0]!.code = "nvda" as never)),
      doc((d) => (d.stages[1]!.flags[0]!.code = "nvda_picked" as never)),
      doc((d) => d.stages.push(structuredClone(d.stages[1]!))),
      doc((d) => (d.stages[1]!.stage = "radar")),
      doc((d) => Object.assign(d.stages[1]!, { evidence: "missing", replay: "not_run" })),
      doc((d) => Object.assign(d.stages[1]!, { names_kept: 13 })),
      doc((d) => Object.assign(d.stages[1]!, { evidence: "broken" })),
    ];
    for (const d of refused) expect(validateFunnel(d).ok, JSON.stringify(d.stages)).toBe(false);
    const missing = doc((d) =>
      Object.assign(d.stages[1]!, { evidence: "missing", sealed_at: null, names_judged: null, names_kept: null, flags: [], replay: "not_run" }),
    );
    expect(validateFunnel(missing).ok).toBe(true);
  });
});

describe("ingest rules for the funnel document", () => {
  const at = (iso: string) => (d: FunnelDoc) => {
    d.as_of = iso;
    d.run_id = `funnel-2026-10-13-${iso.replace(/\D/g, "").slice(-12).padStart(12, "0")}`;
  };

  it("an older document is refused and the latest stays", async () => {
    await handleIngest(post(doc()), NOW);
    const latest = blob.store.get("funnel/latest.json")!.text;
    const res = await handleIngest(post(doc(at("2026-10-12T21:00:00Z"))), NOW);
    expect(res.status).toBe(409);
    expect(blob.store.get("funnel/latest.json")!.text).toBe(latest);
  });

  it("a document dated ahead of the clock is refused and recorded", async () => {
    const res = await handleIngest(post(doc(at("2026-10-12T23:30:00Z"))), NOW);
    expect(res.status).toBe(422);
    expect(blob.store.has("funnel/latest.json")).toBe(false);
    expect(blob.store.has("ops/ingest-rejects/funnel.json")).toBe(true);
  });

  it("a later run for the same session replaces the latest and the session's copy", async () => {
    await handleIngest(post(doc()), NOW);
    const later = doc(at("2026-10-12T22:24:00Z"));
    expect((await handleIngest(post(later), NOW)).status).toBe(200);
    expect(JSON.parse(blob.store.get("funnel/editions/2026-10-13.json")!.text).run_id).toBe(later.run_id);
    expect(JSON.parse(blob.store.get("funnel/latest.json")!.text).run_id).toBe(later.run_id);
  });

  it("the trading host's key may store it too; a key scoped to a desk may not", async () => {
    expect((await handleIngest(post(doc(), "default", HOST_SECRET), NOW)).status).toBe(200);
    blob.reset();
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "hft-pub": "test-hft-secret" }));
    vi.stubEnv("DASHBOARD_INGEST_SCOPES", JSON.stringify({ "hft-pub": { desks: ["hft"] } }));
    expect((await handleIngest(post(doc(), "hft-pub", "test-hft-secret"), NOW)).status).toBe(403);
    expect(blob.store.has("funnel/latest.json")).toBe(false);
  });
});

describe("the funnel card before the first night", () => {
  it("says nothing yet, never late, while the row is unverified and no document exists", async () => {
    const { buildFeeds } = await import("@/components/operations/feeds-panel");
    const input = (now: string) => ({
      now: new Date(now),
      snapshot: { status: "missing" as const },
      journal: { status: "missing" as const },
      options: { status: "missing" as const },
      optionsLive: { status: "missing" as const },
      radar: { status: "missing" as const },
      // As the page reads it: the store has no funnel document yet.
      feeds: { stamps: { funnel: { status: "missing" as const } }, refusals: {}, shadow: null },
      optionsDates: [],
      radarDates: [],
    });
    for (const now of ["2026-10-12T23:45:00Z", "2026-10-13T02:00:00Z", "2026-10-16T12:00:00Z"]) {
      const card = buildFeeds(input(now)).find((f) => f.key === "funnel");
      expect(card?.state, now).toBe("missing");
    }
  });
});
