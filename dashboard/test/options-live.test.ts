import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionsLiveHealth, OPTIONS_LIVE_ACCEPTS } from "@/lib/editions";
import { fixtureOptionsLive, occSymbol, VARIANT_FLAGS, type VariantFlag } from "@/lib/fixture-variants";
import { sign } from "@/lib/hmac";
import type { OptionsLive } from "@/lib/options-live.types";
import type { Options } from "@/lib/options";
import { parseContract, pickFor, positionRows, POSITIONS_GONE_MIN, POSITIONS_OLD_MIN, positionsAge, positionsTotal } from "@/lib/positions";
import { isOptionsLive, OPTIONS_LIVE_SCHEMA, validateOptionsLive } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

// The options live document: the open option positions of the paper account kept for manual option trades, and
// open interest. It comes from the trading host; the desk shows it and never acts on it.

// In-memory stand-in for the private Blob store, with etags.
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
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null } = {}) => {
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest } = await import("@/lib/ingest");

const e = optionsJson as unknown as Options;
const HOST_SECRET = "test-host-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-10-12T16:00:00Z"); // Monday, 12:00 in New York
const NOW_S = Math.floor(NOW.getTime() / 1000);
const doc = (flags: VariantFlag[] = [], mutate?: (d: OptionsLive) => void): OptionsLive => {
  const d = fixtureOptionsLive(e, NOW, new Set(flags));
  mutate?.(d);
  return d;
};
const loose = (d: OptionsLive) => d as unknown as Record<string, unknown>;

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
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the options live document's contract", () => {
  it("accepts the fixture in every state the tests bend it into", () => {
    for (const flags of [[], ["positions-none"], ["positions-old"]] as VariantFlag[][]) {
      expect(validateOptionsLive(doc(flags))).toMatchObject({ ok: true });
    }
    expect(isOptionsLive(doc())).toBe(true);
    expect(doc().schema).toBe(OPTIONS_LIVE_SCHEMA);
    expect(VARIANT_FLAGS).toEqual(expect.arrayContaining(["positions-off", "positions-none", "positions-old"]));
  });

  it("accepts a document with only what is required, and one with nothing open", () => {
    const bare = { schema: OPTIONS_LIVE_SCHEMA, run_id: "r1", as_of: "2026-10-12T16:00:00Z", paper: true, positions: [] };
    expect(validateOptionsLive(bare)).toMatchObject({ ok: true });
    expect(validateOptionsLive({ ...bare, market: null, open_interest: null, problems: null })).toMatchObject({ ok: true });
  });

  it.each([
    ["one that does not say it is the paper account", (d: OptionsLive) => delete loose(d).paper],
    ["one that says it is not the paper account", (d: OptionsLive) => (loose(d).paper = false)],
    ["an account number", (d: OptionsLive) => (loose(d).account_number = "PA123456")],
    ["a balance", (d: OptionsLive) => (loose(d).equity = 100000)],
    ["buying power under market", (d: OptionsLive) => ((loose(d).market as Record<string, unknown>).buying_power = 5000)],
    ["a stock position", (d: OptionsLive) => (d.positions[0]!.contract = "QQQM")],
    ["a contract symbol in lower case", (d: OptionsLive) => (d.positions[0]!.contract = d.positions[0]!.contract.toLowerCase())],
    ["a fraction of a contract", (d: OptionsLive) => (d.positions[0]!.qty = 1.5)],
    ["an unknown key on a position", (d: OptionsLive) => ((d.positions[0] as Record<string, unknown>).order_id = "abc")],
    ["a negative price", (d: OptionsLive) => (d.positions[0]!.price = -1)],
    ["negative open interest", (d: OptionsLive) => (d.open_interest![0]!.rows[0]!.oi = -5)],
    ["an expiry that is not a date", (d: OptionsLive) => (d.open_interest![0]!.rows[0]!.expiry = "next Friday")],
    ["a missing run id", (d: OptionsLive) => delete loose(d).run_id],
    ["a time with no zone", (d: OptionsLive) => (d.as_of = "2026-10-12T16:00:00")],
    ["more positions than a person holds", (d: OptionsLive) => (d.positions = Array.from({ length: 101 }, () => ({ ...d.positions[0]! })))],
  ])("refuses %s", (_what, damage) => {
    const d = doc();
    damage(d);
    expect(validateOptionsLive(d).ok).toBe(false);
  });
});

describe("an adjusted contract", () => {
  it("does not refuse the document, and is left off the desk's list", () => {
    const d = doc([], (x) => x.positions.push({ contract: "NVDA1261218C00120000", qty: 1 }));
    expect(validateOptionsLive(d)).toMatchObject({ ok: true });
    expect(positionRows(d, new Set(["SPY", "NVDA"]), NOW.getTime()).map((r) => r.symbol)).not.toContain("NVDA1");
    expect(positionRows(d, new Set(), NOW.getTime())).toHaveLength(3);
  });
});

describe("POST /api/ingest with an options live document", () => {
  it("keeps the latest and no dated copy, and touches nothing else", async () => {
    const res = await handleIngest(post(doc()), NOW);
    expect(res.status).toBe(200);
    expect([...blob.store.keys()]).toEqual(["options-live/latest.json"]);
    // A newer one replaces it in place.
    const later = doc([], (d) => ((d.run_id = "later"), (d.as_of = "2026-10-12T16:05:00Z")));
    expect((await handleIngest(post(later), NOW)).status).toBe(200);
    expect([...blob.store.keys()]).toEqual(["options-live/latest.json"]);
    expect(JSON.parse(blob.store.get("options-live/latest.json")!.text).run_id).toBe("later");
  });

  it("is a duplicate on the same run_id and 409 when older", async () => {
    await handleIngest(post(doc()), NOW);
    expect((await (await handleIngest(post(doc()), NOW)).json()).status).toBe("duplicate");
    const older = doc([], (d) => ((d.run_id = "older"), (d.as_of = "2026-10-12T15:00:00Z")));
    expect((await handleIngest(post(older), NOW)).status).toBe(409);
  });

  it("is acknowledged and dropped from a host that is not the primary, so two hosts never share the slot", async () => {
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "gcp-use1": HOST_SECRET }));
    vi.stubEnv("PRIMARY_HOST", "gcp-use1");
    // The default key is now a shadow host's.
    const res = await handleIngest(post(doc()), NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored", shadow: true });
    expect(blob.store.size).toBe(0);
    expect((await handleIngest(post(doc(), { keyId: "gcp-use1" }), NOW)).status).toBe(200);
    expect([...blob.store.keys()]).toEqual(["options-live/latest.json"]);
  });

  it("refuses a document dated ahead of the server's clock, which would read as fresh until time caught up", async () => {
    const ahead = doc([], (d) => (d.as_of = "2026-10-13T16:00:00Z"));
    const res = await handleIngest(post(ahead), NOW);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("as_of");
    expect(blob.store.size).toBe(0);
  });

  it("is refused from the research environment's key: positions come from the trading host", async () => {
    const res = await handleIngest(post(doc(), { secret: RADAR_SECRET, keyId: "radar" }), NOW);
    expect(res.status).toBe(403);
    expect(blob.store.size).toBe(0);
  });

  it("is refused whole when it is not valid, naming the key and never the value", async () => {
    const bad = doc([], (d) => (loose(d).account_number = "PA123456"));
    const res = await handleIngest(post(bad), NOW);
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("account_number");
    expect(text).not.toContain("PA123456");
    expect(blob.store.size).toBe(0);
  });
});

describe("the health report", () => {
  it("says which run is stored and when, and nothing of what it holds", () => {
    const d = doc();
    const h = optionsLiveHealth({ status: "ok", doc: d, source: "blob" });
    expect(h).toEqual({ status: "ok", accepts: OPTIONS_LIVE_ACCEPTS, run_id: d.run_id, as_of: d.as_of, schema_version: 1 });
    expect(JSON.stringify(h)).not.toMatch(/SPY|position|qty/);
    expect(optionsLiveHealth({ status: "missing" })).toEqual({ status: "missing", accepts: OPTIONS_LIVE_ACCEPTS, run_id: null, as_of: null, schema_version: null });
  });
});

describe("a contract's symbol", () => {
  it("gives the name, the expiry, the kind and the strike", () => {
    expect(parseContract("SPY261016C00780000")).toEqual({ symbol: "SPY", expiry: "2026-10-16", kind: "call", strike: 780 });
    expect(parseContract("NVDA261016P00232500")).toEqual({ symbol: "NVDA", expiry: "2026-10-16", kind: "put", strike: 232.5 });
    expect(parseContract(occSymbol("IWM", "2026-11-20", "call", 250))).toEqual({ symbol: "IWM", expiry: "2026-11-20", kind: "call", strike: 250 });
  });

  it.each(["SPY", "QQQM", "SPY261316C00780000", "SPY260631C00780000", "SPY261016X00780000", "SPY261016C00000000", "spy261016c00780000", ""])("is not read from %s", (s) => {
    expect(parseContract(s)).toBeNull();
  });
});

describe("positions as rows for the desk", () => {
  const names = new Set(e.tickers.map((t) => t.symbol));
  const now = NOW.getTime();

  it("puts the desk's own names first and marks the rest", () => {
    const rows = positionRows(doc(), names, now);
    expect(rows.map((r) => `${r.symbol} ${r.kind} ${r.onDesk}`)).toEqual(["NVDA put true", "SPY call true", "IWM call false"]);
    const spy = rows.find((r) => r.symbol === "SPY")!;
    expect(spy).toMatchObject({ qty: 2, avgPrice: 2.85, price: 3.1, unrealized: 50, expired: false });
    expect(spy.days).toBeGreaterThanOrEqual(7);
  });

  it("works the price paid and the mark out of value and result when the broker sends only those", () => {
    const iwm = positionRows(doc(), names, now).find((r) => r.symbol === "IWM")!;
    // One contract worth $180 that is $12.50 up cost $167.50: 1.675 a share, marked at 1.80.
    expect(iwm.avgPrice).toBeCloseTo(1.675, 9);
    expect(iwm.price).toBeCloseTo(1.8, 9);
  });

  it("reads a short position's cost the other way round", () => {
    const d = doc([], (x) => (x.positions = [{ contract: "SPY261120C00800000", qty: -1, market_value: -150, unrealized_pl: 30 }]));
    const [row] = positionRows(d, names, now);
    // Sold for $180, now worth $150: $30 up.
    expect(row!.avgPrice).toBeCloseTo(1.8, 9);
    expect(row!.qty).toBe(-1);
    expect(pickFor(row!)).toBeNull();
  });

  it("leaves out what is not an open option position, and never shows a number that is not one", () => {
    const d = doc([], (x) => {
      x.positions = [
        { contract: "SPY261120C00800000", qty: 0 },
        { contract: "NOTACONTRACT", qty: 1 } as OptionsLive["positions"][number],
        { contract: "SPY261120C00805000", qty: 1 },
        { contract: "SPY261120C00810000", qty: 1, market_value: NaN, unrealized_pl: Infinity, avg_price: NaN, price: NaN } as OptionsLive["positions"][number],
      ];
    });
    const rows = positionRows(d, names, now);
    expect(rows.map((r) => r.strike)).toEqual([805, 810]);
    for (const r of rows) expect([r.avgPrice, r.price, r.unrealized]).toEqual([null, null, null]);
    expect(positionsTotal(rows)).toBeNull();
    expect(positionRows({ ...d, positions: [] }, names, now)).toEqual([]);
  });

  it("adds up the open result over the rows that have one", () => {
    expect(positionsTotal(positionRows(doc(), names, now))).toBeCloseTo(12.5, 9);
  });

  it("marks a contract whose bell has rung, and does not offer it to the contract pane", () => {
    const d = doc([], (x) => (x.positions = [{ contract: "SPY261009C00780000", qty: 1, avg_price: 1, price: 0, market_value: 0, unrealized_pl: -100 }]));
    const [row] = positionRows(d, names, now);
    expect(row!.expired).toBe(true);
    expect(pickFor(row!)).toBeNull();
  });

  it("hands a long position to the contract pane as what is held and what was paid", () => {
    const spy = positionRows(doc(), names, now).find((r) => r.symbol === "SPY")!;
    expect(pickFor(spy)).toEqual({ kind: "call", expiry: spy.expiry, strike: spy.strike, contracts: 2, paid: 2.85 });
    // Paid is rounded to the cent, and left out when it cannot be known.
    expect(pickFor({ ...spy, avgPrice: 1.67499 })!.paid).toBe(1.67);
    expect(pickFor({ ...spy, avgPrice: null })!.paid).toBeNull();
    expect(pickFor({ ...spy, avgPrice: 0 })!.paid).toBeNull();
    expect(pickFor({ ...spy, qty: 5000 })!.contracts).toBe(999);
  });
});

describe("how far to trust the document by its age", () => {
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

  it("is fresh, then old while the market is open, then gone", () => {
    expect(positionsAge(at(2), NOW.getTime(), true)).toEqual({ minutes: 2, state: "fresh" });
    expect(positionsAge(at(POSITIONS_OLD_MIN), NOW.getTime(), true).state).toBe("fresh");
    expect(positionsAge(at(POSITIONS_OLD_MIN + 1), NOW.getTime(), true).state).toBe("old");
    // With the market shut the last document of the day is simply the last one.
    expect(positionsAge(at(600), NOW.getTime(), false).state).toBe("fresh");
    expect(positionsAge(at(POSITIONS_GONE_MIN + 1), NOW.getTime(), false).state).toBe("gone");
    expect(positionsAge(at(POSITIONS_GONE_MIN + 1), NOW.getTime(), true).state).toBe("gone");
  });

  it("is gone when the document has no usable time", () => {
    for (const bad of [null, undefined, "", "yesterday"]) expect(positionsAge(bad, NOW.getTime(), true).state).toBe("gone");
    // A clock that is behind the document's does not make it negative.
    expect(positionsAge(at(-5), NOW.getTime(), true)).toEqual({ minutes: 0, state: "fresh" });
  });
});
