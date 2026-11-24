import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAPER_OPTIONS_ACCEPTS, paperOptionsHealth } from "@/lib/editions";
import { fixturePaperOptions } from "@/lib/fixture-variants";
import { sign } from "@/lib/hmac";
import type { PaperOptions } from "@/lib/paper-options.types";
import { isPaperOptions, PAPER_OPTIONS_SCHEMA, validatePaperOptions } from "@/lib/validate";
import paperJson from "./fixtures/paper-options.v1.json";
import paperV2 from "./fixtures/paper-options.v2.json";

// The paper options history (DEC-0057): every closed paper option trade, sent by the trading host as a SAFE document
// the Paper options page draws.

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
const PATH = "paper-options/latest.json";
const doc = (mutate?: (d: PaperOptions) => void): PaperOptions => {
  const d = structuredClone(paperJson) as unknown as PaperOptions;
  mutate?.(d);
  return d;
};
const loose = (d: object) => d as Record<string, unknown>;
const refused = (d: PaperOptions) => {
  const r = validatePaperOptions(d);
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

describe("the paper options history's contract", () => {
  it("takes the fixture, its clone-only variant, and a document with the clone alone", () => {
    expect(PAPER_OPTIONS_SCHEMA).toBe("stocksdelta/paper-options");
    expect(isPaperOptions(doc())).toBe(true);
    expect(refused(doc())).toBe("");
    expect(refused(fixturePaperOptions(doc(), new Set(["partial"])))).toBe("");
    expect(refused(doc((d) => (delete loose(d).manual, delete loose(d).arms)))).toBe("");
    expect(refused(doc((d) => ((d.clone.trades = []), (d.manual!.trades = []), (d.arms = []))))).toBe("");
  });

  it("refuses a setup name anywhere, by the site's denylist and by the schema", () => {
    expect(refused(doc((d) => (loose(d.clone.trades[0]!).setup = "retest")))).toContain("/clone/trades/0/setup: key is not allowed to be published");
    expect(refused(doc((d) => (loose(d.arms![0]!).setup = "trap")))).toContain("/arms/0/setup: key is not allowed to be published");
    // An arm is named by its hypothesis id, never by a word.
    expect(validatePaperOptions(doc((d) => (d.arms![0]!.hyp = "trap"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.hyp = "retest"))).ok).toBe(false);
  });

  it("refuses free text where it takes a code, and says where without the value", () => {
    const text = refused(doc((d) => (d.clone.trades[0]!.exit_reason = "sold because the chart looked weak")));
    expect(text).toContain("/clone/trades/0/exit_reason");
    expect(text).not.toContain("chart looked weak");
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.window = "The New Rules!"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.clone.windows[0]!.id = "two words"))).ok).toBe(false);
  });

  it("is paper only, and holds no balance, account number, order id or note", () => {
    expect(validatePaperOptions(doc((d) => (loose(d).paper = false))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => delete loose(d).paper)).ok).toBe(false);
    for (const key of ["equity", "buying_power", "account", "cash"]) {
      expect(validatePaperOptions(doc((d) => (loose(d)[key] = 1))).ok, key).toBe(false);
      expect(validatePaperOptions(doc((d) => (loose(d.manual!)[key] = 1))).ok, key).toBe(false);
    }
    expect(validatePaperOptions(doc((d) => (loose(d.clone.trades[0]!).entry_id = "abc"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (loose(d.manual!.trades[0]!).order_id = "abc"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (loose(d.clone.trades[0]!).notes = "x"))).ok).toBe(false);
  });

  it("holds a trade to a real contract, a real time and a sane size", () => {
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.contract = "SPY 581 call"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.opened_at = "2026-10-12 10:00"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.qty = 0))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.fill = -1))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.clone.trades[0]!.trade_id = "trade one"))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (loose(d.manual!.trades[0]!).close = "assigned"))).ok).toBe(false);
  });

  it("takes a trade the clone could not settle with no exit, result or close time, but never without its id, contract or state", () => {
    const open = (d: PaperOptions) => Object.assign(d.clone.trades[0]!, { state: "unresolved", counts: false, fill: null, opened_at: null, exit_fill: null, pnl_usd: null, rop: null, closed_at: null, exit_reason: null });
    expect(refused(doc(open))).toBe("");
    expect(validatePaperOptions(doc((d) => delete loose(d.clone.trades[0]!).counts)).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => delete loose(d.clone.trades[0]!).state)).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (loose(d.clone.trades[0]!).quote_age_s = -1))).ok).toBe(false);
    expect(refused(doc((d) => (d.clone.trades[0]!.quote_age_s = null)))).toBe("");
  });

  it("caps each list, so a runaway host cannot fill the store", () => {
    const many = <T,>(rows: T[], n: number) => Array.from({ length: n }, (_, i) => ({ ...rows[i % rows.length]! }));
    expect(validatePaperOptions(doc((d) => (d.clone.trades = many(d.clone.trades, 2001)))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.manual!.trades = many(d.manual!.trades, 2001)))).ok).toBe(false);
    expect(validatePaperOptions(doc((d) => (d.arms![0]!.trades = many(d.arms![0]!.trades, 501)))).ok).toBe(false);
    const full = doc((d) => (d.clone.trades = many(d.clone.trades, 2000)));
    expect(validatePaperOptions(full).ok).toBe(true);
    // The fullest document the schema takes is well inside the ingest route's 3.5 MB body cap.
    const widest = doc((d) => ((d.clone.trades = many(d.clone.trades, 2000)), (d.manual!.trades = many(d.manual!.trades, 2000)), d.arms!.forEach((a) => (a.trades = many(a.trades, 500)))));
    expect(JSON.stringify(widest).length).toBeLessThan(2_500_000);
  });
});

describe("POST /api/ingest with the paper options history", () => {
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

  it("is refused from the research environment's key: paper trades come from the trading host", async () => {
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

  it("records a refusal of an invalid document without storing it, and refuses one dated ahead of the clock", async () => {
    expect((await handleIngest(post(doc((d) => (loose(d.clone.trades[0]!).setup = "retest"))), NOW)).status).toBe(422);
    expect([...blob.store.keys()]).toEqual(["ops/ingest-rejects/paper-options.json"]);
    expect(blob.store.get("ops/ingest-rejects/paper-options.json")!.text).not.toMatch(/setup|retest/);
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
  it("says which run is stored and what the site accepts, and nothing of the trades", () => {
    const d = doc();
    const h = paperOptionsHealth({ status: "ok", doc: d, source: "blob" });
    expect(h).toEqual({ status: "ok", accepts: PAPER_OPTIONS_ACCEPTS, run_id: d.run_id, as_of: d.as_of, schema_version: 1 });
    expect(JSON.stringify(h)).not.toMatch(/SPY|HYP|usd|trades/);
    expect(paperOptionsHealth({ status: "missing" })).toMatchObject({ status: "missing", accepts: 5, run_id: null });
  });
});


describe("version 2: the options lab's tape status (DEC-0067)", () => {
  it("takes version 1 without the block and version 2 with it", () => {
    expect(validatePaperOptions(structuredClone(paperJson)).ok).toBe(true);
    expect(validatePaperOptions(structuredClone(paperV2)).ok).toBe(true);
  });

  it("refuses a name, a contract or an unknown field in the block", () => {
    const bad = (mutate: (d: Record<string, any>) => void) => {      // eslint-disable-line @typescript-eslint/no-explicit-any
      const d = structuredClone(paperV2) as Record<string, any>;     // eslint-disable-line @typescript-eslint/no-explicit-any
      mutate(d);
      return validatePaperOptions(d).ok;
    };
    expect(bad((d) => (d.lab.sessions[0].symbol = "AAA"))).toBe(false);
    expect(bad((d) => (d.lab.names = ["AAA"]))).toBe(false);
    expect(bad((d) => (d.lab.sessions[0].why_not = ["because"]))).toBe(false);
    expect(bad((d) => (d.lab.sessions[0].coverage = 1.5))).toBe(false);
    expect(bad((d) => (d.schema_version = 6))).toBe(false);
    expect(bad((d) => (d.select.sessions[0].symbol = "AAA"))).toBe(false);
    expect(bad((d) => (d.select.sessions[0].picks = ["AAA"]))).toBe(false);
    expect(bad((d) => (d.select.sessions[0].radar_detail = "free text"))).toBe(false);
    expect(bad((d) => (d.select.sessions[0].universe.rejected = { "Not A Code": 1 }))).toBe(false);
    expect(bad((d) => (d.select.mode = "live"))).toBe(false);
  });
});
