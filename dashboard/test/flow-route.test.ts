// /api/flow (flow-route.ts): the allowed names only, SIP named literally, one snapshots and one paged bars read, its own
// cache, the baseline from the store, and the fixture flags. No network: every upstream call is a fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nameBaseline, parseBaseline, relativeVolume, slotClock, slotClockFromAsOf, spreadBps } from "@/lib/flow";
import { baselinePath } from "@/lib/flow-baseline-run";
import { CACHE_MS, type FlowAnswer, type FlowDeps, fixtureBaseline, handleFlow, MAX_BAR_PAGES, requestedNames, resetFlowCache, BASELINE_RETRY_MS } from "@/lib/flow-route";
import { FROZEN_NOW } from "@/lib/fixture-variants";
import { resetFeedWarning } from "@/lib/alpaca-feed";
import type { Options } from "@/lib/options";

const DAY = "2026-11-12";
const NOW = Date.parse("2026-11-12T15:30:00Z"); // 10:30 New York, EST
const OPEN = Date.parse("2026-11-12T14:30:00Z");
const KEYS = { ALPACA_API_KEY_ID: "test-key-id", ALPACA_API_SECRET_KEY: "test-key-secret", ALPACA_FEED: "iex" };
const edition = (session = DAY, symbols = ["AAPL", "NVDA"]): Options => ({ session, tickers: [], focus: { items: symbols.map((symbol, i) => ({ symbol, rank: i + 1, bias: "breakout" })) } }) as unknown as Options;
const rawBar = (k: number, v = 1_000) => ({ t: new Date(OPEN + k * 120_000).toISOString(), o: 100, h: 101, l: 99, c: 100, v, vw: 100, n: 9 });
const snap = (p: number) => ({
  latestTrade: { p, t: "2026-11-12T15:29:58Z" },
  latestQuote: { bp: p - 0.01, ap: p + 0.01, bs: 2, as: 3, t: "2026-11-12T15:29:59Z" },
  dailyBar: { t: "2026-11-12T05:00:00Z", v: 123_456 },
});
const BASELINE = {
  v: 1,
  for_session: DAY,
  built_at: "2026-11-12T12:10:00.000Z",
  feed: "sip",
  sessions: ["2026-11-11"],
  built_for: ["AAPL", "MSFT", "SPY"],
  names: { SPY: { slot_median: [1, 2], cum_median: [1, 3], n: 1 }, AAPL: { slot_median: [5], cum_median: [5], n: 1 }, MSFT: { slot_median: [7], cum_median: [7], n: 1 } },
};

/** A fake upstream: snapshots for every asked name, bars in `pages`; records each URL. */
function upstream(pages: unknown[] = [{ bars: { SPY: [rawBar(0), rawBar(1)] }, next_page_token: null }], status = 200) {
  const urls: URL[] = [];
  let barCalls = 0;
  const f = vi.fn<typeof fetch>(async (u) => {
    const url = new URL(String(u));
    urls.push(url);
    if (status !== 200) return new Response("{}", { status });
    if (url.pathname === "/v2/stocks/snapshots") {
      const syms = url.searchParams.get("symbols")!.split(",");
      return Response.json(Object.fromEntries(syms.filter((s) => s !== "QQQ").map((s) => [s, snap(500)])));
    }
    return Response.json(pages[Math.min(barCalls++, pages.length - 1)]);
  });
  return { f, urls };
}

const req = (q = "", init: RequestInit = {}) => new Request(`https://lab.example/api/flow${q}`, init);

function deps(over: Partial<FlowDeps> = {}): Partial<FlowDeps> {
  return {
    env: KEYS,
    now: () => new Date(NOW),
    baseUrl: "https://data.alpaca.markets",
    fixture: false,
    loadEdition: async () => edition(),
    readBaseline: async (s) => (s === DAY ? JSON.stringify(BASELINE) : null),
    ...over,
  };
}

beforeEach(() => {
  resetFlowCache();
  resetFeedWarning();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the allowed names (EXP-0032's blind)", () => {
  beforeEach(() => vi.stubEnv("DASHBOARD_FIXTURE", ""));

  it("refuses any other symbol with 400, and asks upstream for nothing", async () => {
    const { f } = upstream();
    for (const q of ["?s=MSFT", "?s=SPY,MSFT", "?s=spy,<b>", "?s=,"]) {
      const res = await handleFlow(req(q), deps({ fetch: f }));
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: "not-allowed" });
    }
    const head = await handleFlow(req("?s=MSFT", { method: "HEAD" }), deps({ fetch: f }));
    expect(head.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("allows today's focus names and SPY and QQQ; a stale edition allows the market names only", async () => {
    expect(requestedNames(null, ["AAPL", "SPY"])).toEqual(["AAPL", "SPY"]);
    expect(requestedNames(" aapl , spy,aapl", ["AAPL", "SPY"])).toEqual(["AAPL", "SPY"]);
    expect(requestedNames("AAPL,MSFT", ["AAPL", "SPY"])).toBeNull();
    const { f } = upstream();
    expect((await handleFlow(req("?s=AAPL,QQQ"), deps({ fetch: f }))).status).toBe(200);
    resetFlowCache();
    expect((await handleFlow(req("?s=AAPL"), deps({ fetch: f, loadEdition: async () => edition("2026-11-11") }))).status).toBe(400);
    resetFlowCache();
    expect((await handleFlow(req("?s=AAPL"), deps({ fetch: f, loadEdition: async () => Promise.reject(new Error("store")) }))).status).toBe(400);
    resetFlowCache();
    expect((await handleFlow(req("?s=SPY"), deps({ fetch: f, loadEdition: async () => null }))).status).toBe(200);
  });

  it("without ?s= answers every allowed name", async () => {
    const { f, urls } = upstream();
    const body = (await (await handleFlow(req(), deps({ fetch: f }))).json()) as FlowAnswer;
    expect(Object.keys(body.names)).toEqual(["AAPL", "NVDA", "QQQ", "SPY"]);
    expect(urls[0]!.searchParams.get("symbols")).toBe("AAPL,NVDA,QQQ,SPY");
  });
});

describe("the answer", () => {
  beforeEach(() => vi.stubEnv("DASHBOARD_FIXTURE", ""));

  it("asks sip by name whatever ALPACA_FEED says, raw bars from 09:30 New York", async () => {
    const { f, urls } = upstream();
    const res = await handleFlow(req("?s=SPY,QQQ"), deps({ fetch: f }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(f).toHaveBeenCalledTimes(2);
    for (const u of urls) expect(u.searchParams.get("feed")).toBe("sip");
    const bars = urls.find((u) => u.pathname === "/v2/stocks/bars")!;
    expect(bars.searchParams.get("timeframe")).toBe("2Min");
    expect(bars.searchParams.get("adjustment")).toBe("raw");
    expect(bars.searchParams.get("start")).toBe("2026-11-12T14:30:00.000Z");
    const body = (await res.json()) as FlowAnswer;
    expect(body.feed).toBe("sip");
    expect(body.missing).toEqual(["QQQ"]);
    expect(body.names.SPY).toEqual({
      price: 500,
      trade_at: "2026-11-12T15:29:58Z",
      bid: 499.99,
      ask: 500.01,
      bid_size: 2,
      ask_size: 3,
      quote_at: "2026-11-12T15:29:59Z",
      day_volume: 123_456,
      bars: [
        { start: OPEN, end: OPEN + 120_000, o: 100, h: 101, l: 99, c: 100, v: 1_000, vw: 100, n: 9 },
        { start: OPEN + 120_000, end: OPEN + 240_000, o: 100, h: 101, l: 99, c: 100, v: 1_000, vw: 100, n: 9 },
      ],
    });
    expect(body.names.QQQ).toMatchObject({ price: null, bid: null, day_volume: null, bars: [] });
    // the baseline, for the answered names only
    expect(body.baseline).toEqual({ for_session: DAY, sessions: ["2026-11-11"], names: { SPY: BASELINE.names.SPY } });
    // a version 2 baseline's ranges never reach the browser
    expect(Object.keys(body.baseline!.names.SPY!)).not.toContain("range_median");
  });

  it("reads the bars to the last page, and a read still paging after MAX_BAR_PAGES is null, never part of a day", async () => {
    const pages = [
      { bars: { SPY: [rawBar(1)] }, next_page_token: "p2" },
      { bars: { SPY: [rawBar(0)], QQQ: [rawBar(0)] }, next_page_token: "p3" },
      { bars: { QQQ: [rawBar(1)] }, next_page_token: null },
    ];
    const { f, urls } = upstream(pages);
    const body = (await (await handleFlow(req("?s=SPY,QQQ"), deps({ fetch: f }))).json()) as FlowAnswer;
    const barUrls = urls.filter((u) => u.pathname === "/v2/stocks/bars");
    expect(barUrls.map((u) => u.searchParams.get("page_token"))).toEqual([null, "p2", "p3"]);
    expect(body.names.SPY!.bars!.map((b) => b.start)).toEqual([OPEN, OPEN + 120_000]);
    expect(body.names.QQQ!.bars).toHaveLength(2);

    resetFlowCache();
    const endless = upstream([{ bars: { SPY: [rawBar(0)] }, next_page_token: "again" }]);
    const cut = (await (await handleFlow(req("?s=SPY"), deps({ fetch: endless.f }))).json()) as FlowAnswer;
    expect(endless.urls.filter((u) => u.pathname === "/v2/stocks/bars")).toHaveLength(MAX_BAR_PAGES);
    expect(cut.names.SPY!.bars).toBeNull();
  });

  it("asks for no bars before the open", async () => {
    const { f, urls } = upstream();
    const body = (await (await handleFlow(req("?s=SPY"), deps({ fetch: f, now: () => new Date("2026-11-12T14:00:00Z") }))).json()) as FlowAnswer;
    expect(urls.map((u) => u.pathname)).toEqual(["/v2/stocks/snapshots"]);
    expect(body.names.SPY!.bars).toEqual([]);
  });

  it("a daily bar of another day gives no day volume", async () => {
    const f = vi.fn<typeof fetch>(async (u) =>
      new URL(String(u)).pathname === "/v2/stocks/snapshots" ? Response.json({ SPY: { ...snap(1), dailyBar: { t: "2026-11-11T05:00:00Z", v: 9 } } }) : Response.json({ bars: {}, next_page_token: null }),
    );
    const body = (await (await handleFlow(req("?s=SPY"), deps({ fetch: f }))).json()) as FlowAnswer;
    expect(body.names.SPY!.day_volume).toBeNull();
  });
});

describe("the cache", () => {
  beforeEach(() => vi.stubEnv("DASHBOARD_FIXTURE", ""));

  it("is keyed by the sorted names and kept CACHE_MS; another set of names reads again", async () => {
    let t = NOW;
    const { f } = upstream();
    const d = deps({ fetch: f, now: () => new Date(t) });
    await handleFlow(req("?s=SPY,QQQ"), d);
    expect(f).toHaveBeenCalledTimes(2);
    t += CACHE_MS - 1;
    await handleFlow(req("?s=QQQ,spy"), d); // the same names in another order: the same key
    expect(f).toHaveBeenCalledTimes(2);
    await handleFlow(req("?s=SPY"), d);
    expect(f).toHaveBeenCalledTimes(4);
    t += 1;
    await handleFlow(req("?s=SPY,QQQ"), d);
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("shares one upstream read between requests in flight", async () => {
    const { f } = upstream();
    await Promise.all([handleFlow(req("?s=SPY"), deps({ fetch: f })), handleFlow(req("?s=SPY"), deps({ fetch: f }))]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps a found baseline for the session; a missing one is asked for again after BASELINE_RETRY_MS", async () => {
    let t = NOW;
    let reads = 0;
    let stored: string | null = null;
    const { f } = upstream();
    const d = deps({ fetch: f, now: () => new Date(t), readBaseline: async (s) => (reads++, s === DAY ? stored : null) });
    expect(((await (await handleFlow(req("?s=SPY"), d)).json()) as FlowAnswer).baseline).toBeNull();
    stored = JSON.stringify(BASELINE);
    t += BASELINE_RETRY_MS - 1;
    expect(((await (await handleFlow(req("?s=SPY"), d)).json()) as FlowAnswer).baseline).toBeNull();
    expect(reads).toBe(1);
    t += 1;
    expect(((await (await handleFlow(req("?s=SPY"), d)).json()) as FlowAnswer).baseline).not.toBeNull();
    t += 10 * BASELINE_RETRY_MS;
    await handleFlow(req("?s=SPY"), d);
    expect(reads).toBe(2);
  });

  it("a baseline stored for another session under today's path, or unreadable, is no baseline", async () => {
    const { f } = upstream();
    const wrong = JSON.stringify({ ...BASELINE, for_session: "2026-11-11" });
    expect(((await (await handleFlow(req("?s=SPY"), deps({ fetch: f, readBaseline: async () => wrong }))).json()) as FlowAnswer).baseline).toBeNull();
    resetFlowCache();
    expect(((await (await handleFlow(req("?s=SPY"), deps({ fetch: f, readBaseline: async () => "{" }))).json()) as FlowAnswer).baseline).toBeNull();
    expect(baselinePath(DAY)).toBe("flow/baseline/2026-11-12.json");
    expect(parseBaseline(JSON.stringify(BASELINE))).not.toBeNull(); // the good case above is a valid document
  });
});

describe("refusals and upstream errors", () => {
  beforeEach(() => vi.stubEnv("DASHBOARD_FIXTURE", ""));

  it("a 403 on sip is 503 not-configured (the plan); 429 stays 429; anything else is 502", async () => {
    for (const [status, want, body] of [
      [403, 503, { error: "not-configured", why: "plan" }],
      [429, 429, { error: "rate-limited" }],
      [500, 502, { error: "upstream" }],
      [401, 502, { error: "upstream" }],
    ] as const) {
      resetFlowCache();
      const { f } = upstream(undefined, status);
      const res = await handleFlow(req("?s=SPY"), deps({ fetch: f }));
      expect(res.status, String(status)).toBe(want);
      expect(await res.json()).toEqual(body);
    }
  });

  it("503 not-configured for a data URL that is not Alpaca's, before anything is asked", async () => {
    const { f } = upstream();
    for (const baseUrl of ["https://data.example", "http://data.alpaca.markets", "https://data.alpaca.markets.evil.example"]) {
      const res = await handleFlow(req("?s=SPY"), deps({ fetch: f, baseUrl }));
      expect(res.status, baseUrl).toBe(503);
      expect(await res.json()).toEqual({ error: "not-configured" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("503 without keys, before anything is asked", async () => {
    const { f } = upstream();
    const res = await handleFlow(req("?s=SPY"), deps({ fetch: f, env: {} }));
    expect(res.status).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses the bypass, a cross-site request and other methods", async () => {
    const { f } = upstream();
    expect((await handleFlow(req("?s=SPY", { headers: { "sec-fetch-site": "cross-site" } }), deps({ fetch: f }))).status).toBe(403);
    expect((await handleFlow(req("?s=SPY", { headers: { "x-vercel-protection-bypass": "x" } }), deps({ fetch: f }))).status).toBe(403);
    expect((await handleFlow(req("?s=SPY", { method: "POST" }), deps({ fetch: f }))).status).toBe(405);
    const head = await handleFlow(req("?s=SPY", { method: "HEAD" }), deps({ fetch: f }));
    expect(head.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fixture mode", () => {
  const net = vi.fn<typeof fetch>();
  const store = vi.fn(async () => null);
  afterEach(() => {
    // fixture mode never touches the network or the store
    expect(net).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
  const fx = (flags: string, q = "?s=SPY,QQQ") => handleFlow(req(q, { headers: { cookie: `fx=${flags}` } }), { fixture: true, fetch: net, readBaseline: store, loadEdition: store });
  const read = async (flags: string) => (await (await fx(flags)).json()) as FlowAnswer;
  const clock = slotClock(Date.parse(FROZEN_NOW))!;

  it("answers the fixture session at FROZEN_NOW with volume, a baseline and no network", async () => {
    const body = await read("");
    expect(slotClockFromAsOf(body.as_of)).toEqual(clock);
    expect(body).toMatchObject({ as_of: FROZEN_NOW.replace("Z", ".000Z"), feed: "sip", fixture: true, missing: [] });
    const bars = body.names.SPY!.bars!;
    expect(bars).toHaveLength(46); // 09:30 to 11:00, the 11:00 bar forming
    expect(body.baseline!.sessions).toHaveLength(20);
    const rv = relativeVolume(bars, nameBaseline(body.baseline, "SPY"), clock);
    expect(rv.value).not.toBeNull();
    expect(spreadBps(body.names.SPY!.bid, body.names.SPY!.ask).bps).not.toBeNull();
    expect(await read("")).toEqual(body); // deterministic
  });

  it("the fixture baseline is version 2 with ranges, and the answer the browser gets carries no ranges", async () => {
    const b = fixtureBaseline(["SPY", "QQQ"], clock.day, new Set())!;
    expect(b.v).toBe(2);
    expect(b.names.SPY!.range_median).toHaveLength(195);
    expect(b.names.SPY!.range_median!.every((x) => x > 0)).toBe(true);
    expect(parseBaseline(JSON.stringify(b))).toEqual(b);
    const body = await read("");
    for (const n of Object.values(body.baseline!.names)) expect(Object.keys(n).sort()).toEqual(["cum_median", "n", "slot_median"]);
  });

  it("flow-off is 503, flow-error 502", async () => {
    expect((await fx("flow-off")).status).toBe(503);
    expect((await fx("flow-error")).status).toBe(502);
  });

  it("flow-thin has 9 sessions, flow-stale a baseline for another session, flow-crossed a crossed first quote", async () => {
    const thin = await read("flow-thin");
    expect(thin.baseline!.sessions).toHaveLength(9);
    expect(relativeVolume(thin.names.SPY!.bars!, nameBaseline(thin.baseline, "SPY"), clock)).toEqual({ value: null, why: "thin-baseline" });
    const stale = await read("flow-stale");
    expect(stale.baseline!.for_session).not.toBe(clock.day);
    expect(relativeVolume(stale.names.SPY!.bars!, nameBaseline(stale.baseline, "SPY"), clock)).toEqual({ value: null, why: "stale-baseline" });
    const crossed = await read("flow-crossed");
    const [first, second] = Object.keys(crossed.names);
    expect(spreadBps(crossed.names[first!]!.bid, crossed.names[first!]!.ask)).toEqual({ bps: null, why: "crossed" });
    expect(spreadBps(crossed.names[second!]!.bid, crossed.names[second!]!.ask).bps).not.toBeNull();
  });

  it("refuses a name outside the fixture's allowed names; `focus` with `quotes-script` allows AAPL", async () => {
    expect((await fx("", "?s=AAPL")).status).toBe(400);
    expect((await fx("focus.quotes-script", "?s=AAPL")).status).toBe(200);
  });
});
