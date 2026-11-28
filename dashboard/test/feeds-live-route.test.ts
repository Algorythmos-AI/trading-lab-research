import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFeedWarning } from "@/lib/alpaca-feed";
import { CACHE_MS, handleFeedsLive, liveBar, MAX_NAMES, resetFeedsLiveCache, snapshotQuote, type FeedsLiveDeps } from "@/lib/feeds-live-route";
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

  it("gives HEAD the same refusals as GET, with no body and no upstream read", async () => {
    const { f } = upstream();
    const head = (q: string, over: Partial<FeedsLiveDeps> = {}) => handleFeedsLive(req(q, {}, "HEAD"), deps({ fetch: f, ...over }));
    for (const [q, over, status] of [
      ["", {}, 400],
      ["?s=SPY", { env: { ...KEYS_ENV, ALPACA_FEED: "bad" } }, 503],
      ["?s=SPY", { env: {} }, 503],
      ["?s=SPY", {}, 200],
    ] as const) {
      const r = await head(q, over);
      expect(r.status).toBe(status);
      expect(await r.text()).toBe("");
    }
    expect((await handleFeedsLive(req("?s=SPY", { "x-vercel-protection-bypass": "x" }, "HEAD"), deps({ fetch: f }))).status).toBe(403);
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
    expect(snap.searchParams.get("symbols")).toBe("QQQ,SPY"); // sorted, as the cache key is
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
    expect(body.feed).toBe("sip"); // DEC-0064: unset ALPACA_FEED is sip
    expect(body.served_at).toBe(NOW.toISOString());
    expect(body.rows.SPY.trade).toBeUndefined(); // the price is the board's own, from /api/quote
    expect(body.rows.SPY.quote).toEqual({ bp: 500.11, bs: 2, ap: 500.13, as: 3, t: Date.parse("2026-10-12T14:59:59Z") });
    expect(body.rows.SPY.bars).toEqual([{ t: OPEN, o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 }]); // the pre-open bar is left out
    expect(body.rows.QQQ).toEqual({ quote: { bp: null, bs: null, ap: null, as: null, t: null }, bars: [] });
    expect(parseLiveAnswer(body)).not.toBeNull();
  });

  it("reads no bars before the open", async () => {
    const { f, urls } = upstream();
    await handleFeedsLive(req(), deps({ fetch: f, now: () => new Date("2026-10-12T13:00:00Z") }));
    expect(urls.filter((u) => u.includes("/v2/stocks/bars"))).toEqual([]);
  });

  it("shares one upstream read between concurrent misses, whatever the order of the names", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const urls: string[] = [];
    const f = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url));
      await gate;
      return new Response(JSON.stringify(String(url).includes("/v2/stocks/bars") ? bars : snapshots), { status: 200 });
    });
    const d = deps({ fetch: f });
    const all = Promise.all([handleFeedsLive(req("?s=SPY,QQQ"), d), handleFeedsLive(req("?s=QQQ,SPY"), d), handleFeedsLive(req("?s=SPY,QQQ"), d)]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    const got = await all;
    expect(got.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("answers bars null for every name when the bars read is still paging (cut short)", async () => {
    const f = vi.fn<typeof fetch>(async (url) =>
      new Response(JSON.stringify(String(url).includes("/v2/stocks/bars") ? { ...bars, next_page_token: "more" } : snapshots), { status: 200 }),
    );
    const body = await (await handleFeedsLive(req(), deps({ fetch: f }))).json();
    expect(body.rows.SPY.bars).toBeNull();
    expect(body.rows.QQQ.bars).toBeNull();
    expect(body.rows.SPY.quote.bp).toBe(500.11);
  });

  // DEC-0064: only sip can be configured now, so a second feed can no longer be put beside it. The case checks that
  // unset and an explicit sip are the same feed and share the cached answer, and that ALPACA_FEED=iex (paused) is
  // refused without being served the cached sip answer or reading anything.
  it("keeps its own cache for CACHE_MS (the 5 s poll), keyed by feed", async () => {
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
    // An explicit sip is the same feed as unset: it is served the cached answer.
    const sip = await (await handleFeedsLive(req(), { ...d, env: { ...KEYS_ENV, ALPACA_FEED: "sip" } })).json();
    expect(f).toHaveBeenCalledTimes(2);
    expect(sip.feed).toBe("sip");
    expect(sip.as_of).toBe(NOW.toISOString());
    // A paused feed never reads the cached answer, nor anything upstream.
    const iex = await handleFeedsLive(req(), { ...d, env: { ...KEYS_ENV, ALPACA_FEED: "iex" } });
    expect(iex.status).toBe(503);
    expect(await iex.json()).toEqual({ error: "not-configured", why: "feed" });
    expect(f).toHaveBeenCalledTimes(2);
    t += 1;
    await handleFeedsLive(req(), d);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("leaves fetchQuotes' cache untouched", async () => {
    const { f } = upstream();
    await handleFeedsLive(req("?s=SPY"), deps({ fetch: f }));
    const q = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(snapshots), { status: 200 }));
    await fetchQuotes(["SPY"], { id: "k", secret: "s" }, NOW, q, "https://data.example", { feed: "iex" });
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("in fixture mode answers made-up quotes and bars with no network, on the frozen or after-close clock", async () => {
    const f = vi.fn<typeof fetch>();
    const res = await handleFeedsLive(req("?s=SPY,QQQ", { cookie: "fx=frozen" }), deps({ fetch: f, fixture: true, env: {} }));
    expect(res.status).toBe(200);
    const a = parseLiveAnswer(await res.json())!;
    expect(f).not.toHaveBeenCalled();
    const served = Date.parse(a.served_at);
    expect(served).toBe(Date.parse("2026-10-12T15:01:00Z"));
    expect(served - a.rows.SPY!.quote.t!).toBeLessThan(10_000);
    expect(a.rows.SPY!.bars!.length).toBeGreaterThan(0);
    // The bar that started at 11:00 is still forming at 11:01.
    expect(a.rows.SPY!.bars!.at(-1)!.t).toBe(Date.parse("2026-10-12T15:00:00Z"));
    const after = parseLiveAnswer(await (await handleFeedsLive(req("?s=SPY", { cookie: "fxfeeds=after-close" }), deps({ fetch: f, fixture: true, env: {} }))).json())!;
    expect(after.served_at).toBe("2026-10-12T20:30:00.000Z");
  });
});

describe("reading Alpaca's answer", () => {
  it("snapshotQuote and liveBar keep numbers and drop everything else to null", () => {
    expect(snapshotQuote(null)).toEqual({ bp: null, bs: null, ap: null, as: null, t: null });
    expect(snapshotQuote({ latestQuote: { bp: Number.NaN, ap: "1", t: 5 } })).toEqual({ bp: null, bs: null, ap: null, as: null, t: null });
    expect(liveBar({ t: "bad" }, 0, Infinity)).toBeNull();
    expect(liveBar({ t: new Date(OPEN).toISOString(), o: "1" }, OPEN, OPEN + 1)).toEqual({ t: OPEN, o: null, h: null, l: null, c: null, v: null });
    expect(liveBar({ t: new Date(OPEN + 1).toISOString() }, OPEN, OPEN + 1)).toBeNull();
  });
});
