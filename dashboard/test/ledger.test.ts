import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEDGER_ACCEPTS, ledgerHealth } from "@/lib/editions";
import { sign } from "@/lib/hmac";
import { optionExitPremium, optionStoppedFirst, optionTotal, RESULT, running, showReview, sessionMinute, weekGrid, type LedgerDay } from "@/lib/ledger";
import type { LedgerEdition } from "@/lib/ledger.types";
import { isLedger, LEDGER_SCHEMA, validateLedger } from "@/lib/validate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LedgerReview, LEDGER_GLOSSARY, priceLabels, spread } from "@/components/ledger";
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

describe("when Options shows the review", () => {
  const at = (iso: string) => showReview(new Date(iso), "2026-10-29", "2026-10-30");
  it("not while New York is open; after the close, before the open and at weekends it does", () => {
    expect(at("2026-10-29T15:00:00Z")).toBe(false); // Thu 11:00 New York
    expect(at("2026-10-29T20:30:00Z")).toBe(true); // Thu 16:30, after the close
    expect(at("2026-10-30T13:00:00Z")).toBe(true); // Fri 09:00, before the open
    expect(at("2026-10-31T15:00:00Z")).toBe(true); // Saturday
    expect(showReview(new Date("2026-11-02T14:45:00Z"), "2026-10-30", "2026-11-02")).toBe(false); // Mon 09:45 on standard time
  });

  it("only for a card scored before the desk's session", () => {
    expect(showReview(new Date("2026-10-29T20:30:00Z"), "2026-10-29", "2026-10-29")).toBe(false);
    expect(showReview(new Date("2026-10-29T20:30:00Z"), "2026-10-28", "2026-10-12")).toBe(false);
  });
});

describe("the prices are written out, not only drawn", () => {
  it("labels each filled side's fill, stop, target 1 and exit, and the levels, one label per price", () => {
    const e = edition();
    for (const n of e.names) {
      const labels = priceLabels(n);
      const at = (v: number | null) => labels.find((l) => v !== null && l.v.toFixed(2) === v.toFixed(2));
      if (n.ceiling !== null) expect(at(n.ceiling)?.name).toMatch(/Ceiling/);
      const filled = n.sides.filter((x) => x.filled);
      for (const s of filled) {
        expect(at(s.entry)?.name).toMatch(/fill/i);
        expect(at(s.stop)?.name).toMatch(/stop/i);
        expect(at(s.t1)?.name).toMatch(/T1/);
        expect(at(s.exit)?.name).toMatch(/exit|stop|T1/i);
        if (filled.length > 1) expect(at(s.entry)?.name).toMatch(s.side === "call" ? /^Call / : /^Put /);
      }
      const printed = labels.map((l) => l.v.toFixed(2));
      expect(new Set(printed).size).toBe(printed.length);
    }
  });

  it("moves labels apart without changing their order or leaving the chart", () => {
    const ls = [{ y: 50 }, { y: 51 }, { y: 52 }, { y: 140 }];
    spread(ls, 12, 10, 145);
    expect(ls.map((l) => l.y)).toEqual([50, 62, 74, 140]);
    const low = [{ y: 140 }, { y: 141 }];
    spread(low, 12, 10, 145);
    expect(low.map((l) => l.y)).toEqual([133, 145]);
  });

  it("works out what the option sold for from its dollars", () => {
    expect(optionExitPremium({ right: "P", strike: 212.5, expiry: "2026-10-30", entry_premium: 1.1, pnl_usd: 30, return_pct: 27.3, exit_time: null, reason: "target1" })).toBe(1.4);
    expect(optionExitPremium({ right: "C", strike: 640, expiry: "2026-10-30", entry_premium: 1.9, pnl_usd: null, return_pct: null, exit_time: null, reason: "no_bars" })).toBeNull();
  });

  it("puts the day's trades in a table with entry, target 1, exit, R and option dollars, and a glossary", () => {
    const e = edition();
    const html = renderToStaticMarkup(createElement(LedgerReview, { e }));
    expect(html).toContain('data-testid="ledger-trades"');
    for (const h of ["Ticker", "Entry", "Target 1", "Exit", "Gain (R)", "Option", "Day total"]) expect(html).toContain(h);
    const filled = e.names.flatMap((n) => n.sides.filter((s) => s.filled));
    for (const s of filled) expect(html).toContain(s.entry.toFixed(2));
    expect(html).toContain('data-testid="ledger-glossary"');
    for (const g of LEDGER_GLOSSARY) expect(html).toContain(g.term.replace("&", "&amp;"));
  });
});
