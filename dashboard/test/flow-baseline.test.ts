// The flow baseline cron (flow-baseline-run.ts): bearer only, idle off a session day or from the open, nothing asked
// when the baseline is stored, every page read on sip by name, and nothing written on a partial fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineSessions, parseBaseline, sessionSlots } from "@/lib/flow";
import { PreconditionFailed } from "@/lib/blob";
import { type BaselineDeps, baselinePath, CONCURRENCY, flowNames, MAX_PAGES, RUN_BUDGET_MS, runFlowBaseline } from "@/lib/flow-baseline-run";
import type { Options } from "@/lib/options";

const DAY = "2026-11-12";
const NOW = Date.parse("2026-11-12T12:30:00Z"); // 07:30 New York, EST
const SESSIONS = baselineSessions(DAY)!;
const edition = (session = DAY): Options => ({ session, tickers: [], focus: { items: [{ symbol: "AAPL", rank: 1, bias: "range" }] } }) as unknown as Options;

/** A fake upstream: each session's full regular-hours bars for every asked name, split over two pages. */
function upstream(fail: (url: URL) => number | null = () => null) {
  const urls: URL[] = [];
  const f = vi.fn<typeof fetch>(async (u) => {
    const url = new URL(String(u));
    urls.push(url);
    const status = fail(url);
    if (status !== null) return new Response("{}", { status });
    const open = Date.parse(url.searchParams.get("start")!);
    const syms = url.searchParams.get("symbols")!.split(",");
    const second = url.searchParams.get("page_token") === "p2";
    const ks = Array.from({ length: 195 }, (_, k) => k).filter((k) => (second ? k >= 100 : k < 100));
    const bars = Object.fromEntries(syms.map((s, i) => [s, ks.map((k) => ({ t: new Date(open + k * 120_000).toISOString(), o: 10, h: 11, l: 9, c: 10, v: 1_000 + k + i, vw: 10, n: 5 }))]));
    return Response.json({ bars, next_page_token: second ? null : "p2" });
  });
  return { f, urls };
}

function deps(over: Partial<BaselineDeps> = {}): BaselineDeps & { writes: [string, string][] } {
  const writes: [string, string][] = [];
  return {
    now: () => NOW,
    dry: false,
    env: { ALPACA_API_KEY_ID: "test-key-id", ALPACA_API_SECRET_KEY: "test-key-secret", ALPACA_FEED: "iex" },
    fetchImpl: upstream().f,
    loadEdition: async () => edition(),
    exists: async () => false,
    write: async (path, body) => {
      writes.push([path, body]);
    },
    ...over,
    writes,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the route", () => {
  it("refuses without the bearer CRON_SECRET, and runs nothing outside production", { timeout: 30_000 }, async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { GET } = await import("@/app/api/cron/flow-baseline/route");
    for (const auth of [null, "Bearer wrong", "s3cret"]) {
      const res = await GET(new Request("https://desk.example/api/cron/flow-baseline", { headers: auth ? { authorization: auth } : {} }));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const ok = await GET(new Request("https://desk.example/api/cron/flow-baseline", { headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, outcome: "not-production" });
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new Request("https://desk.example/api/cron/flow-baseline", { headers: { authorization: "Bearer " } }))).status).toBe(401);
  });
});

describe("runFlowBaseline", () => {
  beforeEach(() => vi.stubEnv("DASHBOARD_FIXTURE", ""));

  it("reads every session's every page on sip, split-adjusted, and writes one baseline create-only", async () => {
    const { f, urls } = upstream();
    const d = deps({ fetchImpl: f });
    const r = await runFlowBaseline(d);
    expect(r).toEqual({ ok: true, outcome: "written", names: 3, sessions: 20, calls: 40 });
    for (const u of urls) {
      expect(u.pathname).toBe("/v2/stocks/bars");
      expect(u.searchParams.get("feed")).toBe("sip");
      // split-adjusted: a split inside the 20 sessions must not leave old volumes in old shares
      expect(u.searchParams.get("adjustment")).toBe("split");
      expect(u.searchParams.get("timeframe")).toBe("2Min");
      expect(u.searchParams.get("symbols")).toBe("AAPL,SPY,QQQ");
    }
    // each session asked from its own 09:30 New York, either side of the clock change
    const starts = new Set(urls.map((u) => u.searchParams.get("start")));
    expect(starts).toEqual(new Set(SESSIONS.map((s) => new Date(sessionSlots(s)!.open).toISOString())));
    expect(starts.has("2026-10-30T13:30:00.000Z") && starts.has("2026-11-02T14:30:00.000Z")).toBe(true);
    expect(d.writes).toHaveLength(1);
    const [path, body] = d.writes[0]!;
    expect(path).toBe(baselinePath(DAY));
    const b = parseBaseline(body)!;
    expect(b).toMatchObject({ for_session: DAY, feed: "sip", sessions: SESSIONS, built_at: new Date(NOW).toISOString(), built_for: ["AAPL", "QQQ", "SPY"] });
    expect(b.names.AAPL).toMatchObject({ n: 20 });
    expect(b.names.AAPL!.slot_median.slice(0, 2)).toEqual([1_000, 1_001]);
    expect(b.names.AAPL!.cum_median[1]).toBe(2_001);
    // version 2: the per-slot median bar range for DEC-0051's shock gate (the fake bars are 11 high, 9 low)
    expect(b.v).toBe(2);
    expect(b.names.AAPL!.range_median).toHaveLength(195);
    expect(new Set(b.names.AAPL!.range_median)).toEqual(new Set([2]));
  });

  it("a stored baseline: one head, nothing asked upstream, nothing written", async () => {
    const { f } = upstream();
    const d = deps({ fetchImpl: f, exists: async (p) => p === baselinePath(DAY) });
    expect(await runFlowBaseline(d)).toEqual({ ok: true, outcome: "exists" });
    expect(f).not.toHaveBeenCalled();
    expect(d.writes).toEqual([]);
  });

  it("a partial fetch writes nothing and logs counts only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bad = SESSIONS[7]!;
    const { f } = upstream((u) => (u.searchParams.get("start")!.startsWith(bad) && u.searchParams.get("page_token") === "p2" ? 500 : null));
    const d = deps({ fetchImpl: f });
    expect(await runFlowBaseline(d)).toEqual({ ok: true, outcome: "retry", why: "partial" });
    expect(d.writes).toEqual([]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    const line = JSON.parse(lines.find((l) => l.includes('"partial"'))!);
    expect(line).toMatchObject({ evt: "flow.baseline", outcome: "partial", why: "status-500", sessions: 20, names: 3 });
    for (const l of lines) for (const sym of ["AAPL", "SPY", "QQQ"]) expect(l).not.toContain(sym);
  });

  it("a page limit and the run's time budget are partial too", async () => {
    const endless = vi.fn<typeof fetch>(async () => Response.json({ bars: {}, next_page_token: "again" }));
    const d = deps({ fetchImpl: endless });
    expect(await runFlowBaseline(d)).toEqual({ ok: true, outcome: "retry", why: "partial" });
    expect(endless.mock.calls.length).toBeLessThanOrEqual(MAX_PAGES * CONCURRENCY);
    expect(d.writes).toEqual([]);

    let t = NOW;
    const { f } = upstream();
    const slow = vi.fn<typeof fetch>(async (u, i) => {
      t += RUN_BUDGET_MS / 4;
      return f(u, i);
    });
    const late = deps({ fetchImpl: slow, now: () => t });
    expect(await runFlowBaseline(late)).toEqual({ ok: true, outcome: "retry", why: "partial" });
    expect(late.writes).toEqual([]);
  });

  it("waits for today's edition: none or a stale one asks nothing", async () => {
    for (const ed of [null, edition("2026-11-11")]) {
      const { f } = upstream();
      const d = deps({ fetchImpl: f, loadEdition: async () => ed });
      expect(await runFlowBaseline(d)).toEqual({ ok: true, outcome: "retry", why: "edition-not-ready" });
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("is idle off a session day and from the open; a lost race reads as stored", async () => {
    const { f } = upstream();
    expect(await runFlowBaseline(deps({ fetchImpl: f, now: () => Date.parse("2026-11-26T12:30:00Z") }))).toEqual({ ok: true, outcome: "idle", why: "closed-day" });
    expect(await runFlowBaseline(deps({ fetchImpl: f, now: () => Date.parse("2026-11-14T12:30:00Z") }))).toEqual({ ok: true, outcome: "idle", why: "closed-day" });
    expect(await runFlowBaseline(deps({ fetchImpl: f, now: () => Date.parse("2026-11-12T14:30:00Z") }))).toEqual({ ok: true, outcome: "idle", why: "session-open" });
    expect(f).not.toHaveBeenCalled();
    const raced = deps({ write: async () => Promise.reject(new PreconditionFailed()) });
    expect(await runFlowBaseline(raced)).toEqual({ ok: true, outcome: "exists" });
  });

  it("without keys or with a foreign data URL asks nothing; a dry run touches nothing", async () => {
    const { f } = upstream();
    expect(await runFlowBaseline(deps({ fetchImpl: f, env: {} }))).toEqual({ ok: false, outcome: "no-keys" });
    expect(await runFlowBaseline(deps({ fetchImpl: f, env: { ALPACA_API_KEY_ID: "a", ALPACA_API_SECRET_KEY: "b", ALPACA_DATA_URL: "https://evil.example" } }))).toEqual({ ok: false, outcome: "data-url" });
    expect(await runFlowBaseline(deps({ fetchImpl: f, dry: true }))).toEqual({ ok: true, outcome: "not-production" });
    expect(f).not.toHaveBeenCalled();
  });

  it("flowNames: the edition's focus names when it is today's, then SPY and QQQ", () => {
    expect(flowNames(edition(), DAY)).toEqual(["AAPL", "SPY", "QQQ"]);
    expect(flowNames(edition("2026-11-11"), DAY)).toEqual(["SPY", "QQQ"]);
    expect(flowNames(null, DAY)).toEqual(["SPY", "QQQ"]);
  });
});
