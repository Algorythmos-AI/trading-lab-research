import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import { editionState, ladder, moveBands, nearest, ruleLabel, type Options, type OptionsTicker } from "@/lib/options";
import { OPTIONS_SCHEMA, isOptions, validateOptionsEdition } from "@/lib/validate";
import { fixture } from "./helpers";
import optionsJson from "./fixtures/options.v1.json";

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
const NOW = new Date("2026-10-09T21:30:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function edition(mutate?: (r: Record<string, unknown>) => void): Record<string, unknown> {
  const r = structuredClone(optionsJson) as unknown as Record<string, unknown>;
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

const tickers = (r: Record<string, unknown>) => r.tickers as Record<string, unknown>[];

describe("options edition schema", () => {
  it("accepts the fixture the publisher built", () => {
    expect(validateOptionsEdition(edition()).ok).toBe(true);
    expect(isOptions(optionsJson)).toBe(true);
    expect(optionsJson.schema).toBe(OPTIONS_SCHEMA);
  });

  it("rejects unknown keys, bad statuses, bad zone sides and a missing session", () => {
    expect(validateOptionsEdition(edition((r) => (r.extra = 1))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => ((r.rules as Record<string, unknown>[])[0]!.status = "great"))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => ((tickers(r)[0]!.zones as Record<string, unknown>[])[0]!.side = "up"))).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => delete r.session)).ok).toBe(false);
    expect(validateOptionsEdition(edition((r) => (r.session = "12 Oct"))).ok).toBe(false);
  });

  it("refuses denylisted keys inside an options edition", () => {
    const r = validateOptionsEdition(edition((e) => (tickers(e)[0]!.setup = "x")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("/tickers/0/setup");
  });
});

describe("POST /api/ingest with an options edition", () => {
  it("stores latest and the per-session copy, touching nothing else", async () => {
    const res = await handleIngest(post(edition()), NOW);
    expect(res.status).toBe(200);
    expect([...blob.store.keys()].sort()).toEqual(["options/editions/2026-10-12.json", "options/latest.json"]);
  });

  it("is a duplicate on the same run_id and 409 when older", async () => {
    await handleIngest(post(edition()), NOW);
    expect((await (await handleIngest(post(edition()), NOW)).json()).status).toBe("duplicate");
    const older = edition((r) => {
      r.run_id = "options-older";
      r.as_of = "2026-10-09T20:00:00+00:00";
    });
    expect((await handleIngest(post(older), NOW)).status).toBe(409);
  });

  it("an options edition never lands in the radar's files, nor the reverse", async () => {
    await handleIngest(post(edition()), NOW);
    expect([...blob.store.keys()].some((k) => k.startsWith("radar/"))).toBe(false);
  });

  it("the radar key still cannot publish a stocks snapshot", async () => {
    const snap = fixture() as unknown as Record<string, unknown>;
    snap.run_id = "r1";
    snap.as_of = "2026-10-09T21:29:00+00:00";
    const res = await handleIngest(post(snap), NOW);
    expect(res.status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("401 with the wrong key; 422 on an invalid edition without echoing it", async () => {
    expect((await handleIngest(post(edition(), { secret: "wrong" }), NOW)).status).toBe(401);
    const res = await handleIngest(post(edition((r) => (r.private_note = "do-not-echo"))), NOW);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("do-not-echo");
  });
});

describe("options view helpers", () => {
  const e = optionsJson as unknown as Options;
  const spy = e.tickers.find((t) => t.symbol === "SPY")!;

  it("knows whether an edition is for the next session, today's, or out of date (New York dates)", () => {
    // Built Friday 9 Oct after the close for Monday 12 Oct.
    expect(editionState("2026-10-12", new Date("2026-10-09T21:30:00Z"))).toBe("next");
    expect(editionState("2026-10-12", new Date("2026-10-11T23:00:00Z"))).toBe("next"); // Sunday evening in New York
    expect(editionState("2026-10-12", new Date("2026-10-12T13:30:00Z"))).toBe("today");
    expect(editionState("2026-10-12", new Date("2026-10-13T03:59:00Z"))).toBe("today"); // still Monday in New York
    expect(editionState("2026-10-12", new Date("2026-10-13T13:30:00Z"))).toBe("stale");
  });

  it("orders the ladder outward from the close, without yesterday's close as a member", () => {
    const { above, at, below } = ladder(spy);
    expect(above.map((r) => r.zone.members)).toEqual([["PDH", "PWH", "52WH"]]);
    expect(at).toEqual([]);
    // PMH + PDL + PDC (775.14 to 778.55, weight 5) becomes PMH + PDL: 775.14 to 775.16, weight 4, not major.
    expect(below[0]!.zone).toMatchObject({ lo: 775.14, hi: 775.16, members: ["PMH", "PDL"], weight: 4, big: false });
    expect(below.map((r) => r.edge)).toEqual([...below.map((r) => r.edge)].sort((a, b) => b - a));
    expect(below.every((r) => r.zone.hi < 778.55)).toBe(true);
    const n = nearest(spy);
    expect(n.resistance!.edge).toBe(779.4);
    expect(n.resistance!.distPct).toBeCloseTo(((779.4 - 778.55) / 778.55) * 100, 6);
    expect(n.resistance!.distAtr).toBeCloseTo((779.4 - 778.55) / spy.atr14!, 6);
    expect(n.support!.distPct).toBeCloseTo(((775.16 - 778.55) / 778.55) * 100, 6);
  });

  it("drops a zone whose only member is yesterday's close, and keeps zones the close sits inside apart", () => {
    const t = {
      symbol: "X",
      last: { high: 105, low: 95, close: 100 },
      atr14: 2,
      levels: [
        { name: "PDC", price: 100, weight: 1 },
        { name: "DEMAND", price: 100, lo: 98, hi: 102, weight: 2 },
      ],
      zones: [
        { lo: 100, hi: 100, members: ["PDC"], side: "support", weight: 1 },
        { lo: 98, hi: 102, members: ["DEMAND"], side: "resistance", weight: 2 },
      ],
    } as OptionsTicker;
    const l = ladder(t);
    expect(l.above).toEqual([]);
    expect(l.below).toEqual([]);
    expect(l.at.map((r) => r.zone.members)).toEqual([["DEMAND"]]);
    expect(nearest(t)).toEqual({ support: null, resistance: null });
  });

  it("handles a ticker with no close or no zones", () => {
    const bare = { symbol: "X" } as OptionsTicker;
    expect(ladder(bare)).toEqual({ above: [], at: [], below: [] });
    expect(nearest({ ...spy, zones: [] })).toEqual({ support: null, resistance: null });
    expect(moveBands(bare)).toEqual({ day: null, week: null });
  });

  it("puts the expected move either side of the close", () => {
    const b = moveBands(spy);
    expect(b.day![0]).toBeCloseTo(778.55 - 5.85, 6);
    expect(b.week![1]).toBeCloseTo(778.55 + 13.07, 6);
  });

  it("names rules by label", () => {
    expect(ruleLabel(e, "brk_PDH_close")).toBe("Hourly close above yesterday's high");
    expect(ruleLabel(e, "unknown_rule")).toBe("unknown_rule");
  });
});
