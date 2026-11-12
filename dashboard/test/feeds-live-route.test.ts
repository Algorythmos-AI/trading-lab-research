import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFeedWarning } from "@/lib/alpaca-feed";
import { CACHE_MS, handleFeedsLive, liveBar, MAX_NAMES, resetFeedsLiveCache, snapshotRow, type FeedsLiveDeps } from "@/lib/feeds-live-route";
import { parseLiveAnswer } from "@/lib/feeds-live";
import { fetchQuotes, resetQuoteCache } from "@/lib/quote";

// The Feeds page's live route: the board's own feed only, its own cache, the signed-in rules. No network: every
// upstream answer is a stub.

const NOW = new Date("2026-10-12T15:00:00Z"); // 11:00 New York on a session day
const OPEN = Date.parse("2026-10-12T13:30:00Z");
const HOST = "lab.example";
const KEYS_ENV = { ALPACA_API_KEY_ID: "test-key-id", ALPACA_API_SECRET_KEY: "test-key-secret" };

const req = (q = "?s=SPY,QQQ", headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://${HOST}/api/feeds/live${q}`, { method, headers: { "sec-fetch-site": "same-origin", ...headers } });

const snapshots = {
  SPY: { latestTrade: { p: 500.12, t: "2026-10-12T14:59:58Z" }, latestQuote: { bp: 500.11, bs: 2, ap: 500.13, as: 3, t: "2026-10-12T14:59:59Z" } },
  QQQ: { latestTrade: { p: "x", t: "never" }, latestQuote: null },
};
const bars = { bars: { SPY: [{ t: new Date(OPEN).toISOString(), o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 }, { t: new Date(OPEN - 120_000).toISOString(), o: 1, h: 2, l: 0.5, c: 1.5, v: 9 }] }, next_page_token: null };

function upstream() {
  const urls: string[] = [];
  const f = vi.fn<typeof fetch>(async (url) => {
    const u = String(url);
    urls.push(u);
    return new Response(JSON.stringify(u.includes("/v2/stocks/bars") ? bars : snapshots), { status: 200 });
  });
  return { f, urls };
}

const deps = (over: Partial<FeedsLiveDeps> = {}): Partial<FeedsLiveDeps> => ({
  env: { ...KEYS_ENV },
  now: () => NOW,
  baseUrl: "https://data.example",
  fixture: false,
  ...over,
});

beforeEach(() => {
  resetFeedsLiveCache();
  resetQuoteCache();
  resetFeedWarning();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("the live route's rules", () => {
  it("refuses the deployment-protection bypass, cross-site requests and other methods", async () => {
    const { f } = upstream();
    expect((await handleFeedsLive(req("?s=SPY", { "x-vercel-protection-bypass": "x" }), deps({ fetch: f }))).status).toBe(403);
    expect((await handleFeedsLive(req("?s=SPY&x-vercel-set-bypass-cookie=true"), deps({ fetch: f }))).status).toBe(403);
    expect((await handleFeedsLive(req("?s=SPY", { "sec-fetch-site": "cross-site" }), deps({ fetch: f }))).status).toBe(403);
    const post = await handleFeedsLive(req("?s=SPY", {}, "POST"), deps({ fetch: f }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(f).not.toHaveBeenCalled();
  });

  it("answers no-store, and refuses a missing or too long list of names", async () => {
    const { f } = upstream();
    expect((await handleFeedsLive(req(""), deps({ fetch: f }))).status).toBe(400);
    const many = Array.from({ length: MAX_NAMES + 1 }, (_, i) => `A${String.fromCharCode(65 + i)}`).join(",");
    expect((await handleFeedsLive(req(`?s=${many}`), deps({ fetch: f }))).status).toBe(400);
    const ok = await handleFeedsLive(req(), deps({ fetch: f }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 when ALPACA_FEED is refused, and asks nothing upstream", async () => {
    const { f } = upstream();
    const res = await handleFeedsLive(req(), deps({ fetch: f, env: { ...KEYS_ENV, ALPACA_FEED: "delayed_sip" } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not-configured", why: "feed" });
    expect(f).not.toHaveBeenCalled();
  });

  it("answers 503 without keys, and 503 why plan when Alpaca refuses SIP", async () => {
    const { f } = upstream();
    expect((await handleFeedsLive(req(), deps({ fetch: f, env: {} }))).status).toBe(503);
    const refused = vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 }));
    const res = await handleFeedsLive(req(), deps({ fetch: refused, env: { ...KEYS_ENV, ALPACA_FEED: "sip" } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not-configured", why: "plan" });
  });

  it("passes a rate limit on as 429 and anything else as 502", async () => {
    const limited = vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 }));
    expect((await handleFeedsLive(req(), deps({ fetch: limited }))).status).toBe(429);
    resetFeedsLiveCache();
    const broken = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
    expect((await handleFeedsLive(req(), deps({ fetch: broken }))).status).toBe(502);
  });
});

describe("what the live route reads and answers", () => {
  it("builds both URLs on the board's feed through alpacaDataUrl, bars at 2Min from the open", async () => {
    const { f, urls } = upstream();
    await handleFeedsLive(req(), deps({ fetch: f, env: { ...KEYS_ENV, ALPACA_FEED: "sip" } }));
    expect(urls).toHaveLength(2);
    const snap = new URL(urls.find((u) => u.includes("/v2/stocks/snapshots"))!);
    expect(snap.origin).toBe("https://data.example");
    expect(snap.searchParams.get("feed")).toBe("sip");
    expect(snap.searchParams.get("symbols")).toBe("SPY,QQQ");
    const b = new URL(urls.find((u) => u.includes("/v2/stocks/bars"))!);
    expect(b.searchParams.get("feed")).toBe("sip");
    expect(b.searchParams.get("timeframe")).toBe("2Min");
    expect(b.searchParams.get("start")).toBe(new Date(OPEN).toISOString());
    // The builder's own order of the query: the same string alpacaDataUrl gives.
    expect(urls.every((u) => u.includes("feed=sip"))).toBe(true);
  });

  it("answers numbers or null only, and keeps the session's bars", async () => {
    const { f } = upstream();
    const body = await (await handleFeedsLive(req(), deps({ fetch: f }))).json();
    expect(body.feed).toBe("iex");
    expect(body.served_at).toBe(NOW.toISOString());
    expect(body.rows.SPY.trade).toEqual({ p: 500.12, t: Date.parse("2026-10-12T14:59:58Z") });
    expect(body.rows.SPY.quote).toEqual({ bp: 500.11, bs: 2, ap: 500.13, as: 3, t: Date.parse("2026-10-12T14:59:59Z") });
    expect(body.rows.SPY.bars).toEqual([{ t: OPEN, o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 }]); // the pre-open bar is left out
    expect(body.rows.QQQ).toEqual({ trade: { p: null, t: null }, quote: { bp: null, bs: null, ap: null, as: null, t: null }, bars: [] });
    expect(parseLiveAnswer(body)).not.toBeNull();
  });

  it("reads no bars before the open", async () => {
    const { f, urls } = upstream();
    await handleFeedsLive(req(), deps({ fetch: f, now: () => new Date("2026-10-12T13:00:00Z") }));
    expect(urls.filter((u) => u.includes("/v2/stocks/bars"))).toEqual([]);
  });

  it("keeps its own cache for CACHE_MS, keyed by feed", async () => {
    const { f } = upstream();
    let t = NOW.getTime();
    const d = deps({ fetch: f, now: () => new Date(t) });
    await handleFeedsLive(req(), d);
    expect(f).toHaveBeenCalledTimes(2);
    t += CACHE_MS - 1;
    const again = await (await handleFeedsLive(req(), d)).json();
    expect(f).toHaveBeenCalledTimes(2);
    expect(again.as_of).toBe(NOW.toISOString());
    expect(again.served_at).toBe(new Date(t).toISOString());
    // Another feed never reads the cached answer.
    await handleFeedsLive(req(), { ...d, env: { ...KEYS_ENV, ALPACA_FEED: "sip" } });
    expect(f).toHaveBeenCalledTimes(4);
    t += 1;
    await handleFeedsLive(req(), d);
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("leaves fetchQuotes' cache untouched", async () => {
    const { f } = upstream();
    await handleFeedsLive(req("?s=SPY"), deps({ fetch: f }));
    const q = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(snapshots), { status: 200 }));
    await fetchQuotes(["SPY"], { id: "k", secret: "s" }, NOW, q, "https://data.example", { feed: "iex" });
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("in fixture mode answers made-up rows with no network, and one stale row with the page's own row-stale switch", async () => {
    const f = vi.fn<typeof fetch>();
    const res = await handleFeedsLive(req("?s=SPY,QQQ", { cookie: "fx=frozen; fxfeeds=row-stale" }), deps({ fetch: f, fixture: true, env: {} }));
    expect(res.status).toBe(200);
    const a = parseLiveAnswer(await res.json())!;
    expect(f).not.toHaveBeenCalled();
    const served = Date.parse(a.served_at);
    expect(served - a.rows.SPY!.trade.t!).toBeLessThan(10_000);
    expect(served - a.rows.QQQ!.trade.t!).toBeGreaterThan(120_000);
    expect(a.rows.SPY!.bars.length).toBeGreaterThan(0);
  });
});

describe("reading Alpaca's answer", () => {
  it("snapshotRow and liveBar keep numbers and drop everything else to null", () => {
    expect(snapshotRow(null)).toEqual({ trade: { p: null, t: null }, quote: { bp: null, bs: null, ap: null, as: null, t: null } });
    expect(snapshotRow({ latestTrade: { p: Number.NaN, t: 5 } }).trade).toEqual({ p: null, t: null });
    expect(liveBar({ t: "bad" }, 0, Infinity)).toBeNull();
    expect(liveBar({ t: new Date(OPEN).toISOString(), o: "1" }, OPEN, OPEN + 1)).toEqual({ t: OPEN, o: null, h: null, l: null, c: null, v: null });
    expect(liveBar({ t: new Date(OPEN + 1).toISOString() }, OPEN, OPEN + 1)).toBeNull();
  });
});
