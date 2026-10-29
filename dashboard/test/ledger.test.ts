import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEDGER_ACCEPTS, ledgerHealth } from "@/lib/editions";
import { sign } from "@/lib/hmac";
import { optionStoppedFirst, optionTotal, RESULT, running, sessionMinute, weekGrid, type LedgerDay } from "@/lib/ledger";
import type { LedgerEdition } from "@/lib/ledger.types";
import { isLedger, LEDGER_SCHEMA, validateLedger } from "@/lib/validate";
import ledgerJson from "./fixtures/ledger.v1.json";

// The focus card ledger: after each close, focus-card-ledger sends how the Top 4 Focus Card did as a research
// edition, signed with the radar's key, and the Card record page draws it. The fixture's prices are synthetic.

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
const NOW = new Date("2026-10-28T20:40:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const edition = (mutate?: (e: LedgerEdition) => void): LedgerEdition => {
  const e = structuredClone(ledgerJson) as unknown as LedgerEdition;
  mutate?.(e);
  return e;
};

function post(body: unknown): Request {
  const text = JSON.stringify(body);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(NOW_S),
      "x-wt-signature": sign(RADAR_SECRET, NOW_S, Buffer.from(text, "utf8")),
      "x-wt-key-id": "radar",
    },
  });
}

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", "test-host-secret");
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the ledger edition's contract", () => {
  it("takes the fixture", () => {
    expect(isLedger(edition())).toBe(true);
    expect(validateLedger(edition()).ok).toBe(true);
    expect(LEDGER_SCHEMA).toBe("stocksdelta/ledger");
  });

  it("refuses free text and fields it does not know", () => {
    const withNote = edition((e) => Object.assign(e.names[0]!, { why: "closed above support" }));
    expect(validateLedger(withNote).ok).toBe(false);
    const withSetup = edition((e) => Object.assign(e, { setup: "a named setup" }));
    const r = validateLedger(withSetup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("not allowed to be published");
  });

  it("refuses an unknown result and bars outside the session", () => {
    expect(validateLedger(edition((e) => ((e.names[0]!.sides[0] as { result: string }).result = "won"))).ok).toBe(false);
    expect(validateLedger(edition((e) => (e.names[0]!.bars!.t[0] = 400))).ok).toBe(false);
  });

  it("reports itself on /api/health", () => {
    const h = ledgerHealth({ status: "ok", edition: edition(), source: "fixture" });
    expect(h).toMatchObject({ status: "ok", accepts: LEDGER_ACCEPTS, session: "2026-10-28", schema_version: 1 });
    expect(ledgerHealth({ status: "missing" })).toMatchObject({ status: "missing", session: null });
  });
});

describe("POST /api/ingest with a ledger edition", () => {
  it("the radar's key stores it at ledger/latest.json and one copy per session", async () => {
    const res = await handleIngest(post(edition()), NOW);
    expect(res.status).toBe(200);
    expect(blob.store.has("ledger/latest.json")).toBe(true);
    expect(blob.store.has("ledger/editions/2026-10-28.json")).toBe(true);
    expect(blob.store.has("radar/latest.json")).toBe(false);
  });

  it("the same run again is a duplicate; an invalid one is refused and nothing is stored", async () => {
    await handleIngest(post(edition()), NOW);
    expect((await (await handleIngest(post(edition()), NOW)).json()).status).toBe("duplicate");
    blob.reset();
    const bad = edition((e) => ((e as { day: unknown }).day = null));
    expect((await handleIngest(post(bad), NOW)).status).toBe(422);
    expect(blob.store.size).toBe(0);
  });
});

describe("reading an edition for the page", () => {
  it("names every result the scorer writes", () => {
    for (const r of ["target1", "stopped", "session_close", "no_trigger", "no_fill", "failed_before_retest"] as const) {
      expect(RESULT[r].label).toBeTruthy();
    }
  });

  it("places an instant on the New York session, across a clock change", () => {
    expect(sessionMinute("2026-10-28T13:30:00Z")).toBe(0);
    expect(sessionMinute("2026-10-28T14:54:00Z")).toBe(84);
    // After 1 Nov New York is on standard time: 09:30 is 14:30 UTC.
    expect(sessionMinute("2026-11-02T14:30:00Z")).toBe(0);
    expect(sessionMinute(null)).toBeNull();
  });

  it("finds the stock winners whose option was stopped out first", () => {
    const hits = optionStoppedFirst(edition());
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.side.result).toBe("target1");
      expect(h.side.option?.reason).toBe("option_stop_25pct");
    }
  });

  it("keeps running totals and option dollars only where they were kept", () => {
    const d = (session: string, r: number, r5: number, opt: number | null) => ({ session, r, r_five_min: r5, option_usd: opt }) as LedgerDay;
    const days = [d("2026-10-26", 1, 0.5, null), d("2026-10-27", -0.5, 0, null), d("2026-10-28", 2, 1, -87)];
    expect(running(days).map((p) => p.r)).toEqual([1, 0.5, 2.5]);
    expect(running(days).map((p) => p.r5)).toEqual([0.5, 0.5, 1.5]);
    expect(optionTotal(days)).toEqual({ usd: -87, days: 1, first: "2026-10-28" });
    expect(optionTotal(days.slice(0, 2)).usd).toBeNull();
  });

  it("lays the days out Monday to Friday, with a gap for a day not scored", () => {
    const d = (session: string) => ({ session, r: 0 }) as LedgerDay;
    const weeks = weekGrid([d("2026-10-22"), d("2026-10-23"), d("2026-10-26"), d("2026-10-28")]);
    expect(weeks.map((w) => w[0]!.date)).toEqual(["2026-10-19", "2026-10-26"]);
    expect(weeks[1]!.map((c) => c.day?.session ?? null)).toEqual(["2026-10-26", null, "2026-10-28", null, null]);
  });
});
