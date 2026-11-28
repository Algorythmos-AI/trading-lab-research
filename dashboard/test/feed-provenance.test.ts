// Feed provenance: which Alpaca stock feed the site reads (ALPACA_FEED, alpaca-feed.ts), that every upstream URL
// carries it, that a bad value takes the prices off rather than guessing, and the two ages the page shows
// (feed-provenance.ts) on the server's clock, never the device's.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { configuredFeed, DEFAULT_FEED, FEED_PLAN_REFUSED, FEED_REFUSED, FeedMisconfigured, feedSetting, requireFeed, resetFeedWarning } from "@/lib/alpaca-feed";
import { type BarsResponse, fetchBars, resetBarsCache } from "@/lib/bars";
import { handleBars } from "@/lib/bars-route";
import { TRADE_STALE_MS } from "@/lib/entry-checks";
import { ageSeconds, ageStale, ageText, type DataFeed, feedAges, feedLabel, isDataFeed, recordFeed, tradeAgeRange } from "@/lib/feed-provenance";
import { fetchQuotes, type QuoteResponse, resetQuoteCache } from "@/lib/quote";
import { handleQuote } from "@/lib/quote-route";
import { FEED_STALE_MS, serverNow } from "@/lib/trade-state";
import { FeedFacts, FeedPill, LiveContext } from "@/components/client/live-layer";
import type { Feed } from "@/components/client/use-quotes";

const KEYS = { id: "test-key-id", secret: "test-key-secret" };
const NOW = new Date("2026-10-12T15:00:00Z");
const BASE = "https://data.example";

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  resetFeedWarning();
  resetQuoteCache();
  resetBarsCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ALPACA_FEED", () => {
  // DEC-0064 (SIP only): the default is sip, and iex is paused, refused like a value that is not a feed.
  it("is sip when unset or empty (or only spaces)", () => {
    expect(DEFAULT_FEED).toBe("sip");
    expect(feedSetting({})).toEqual({ ok: true, feed: "sip" });
    expect(feedSetting({ ALPACA_FEED: "" })).toEqual({ ok: true, feed: "sip" });
    expect(feedSetting({ ALPACA_FEED: "  " })).toEqual({ ok: true, feed: "sip" });
  });

  it("takes sip, and refuses iex (paused by DEC-0064) as it refuses a value that is not a feed", () => {
    expect(feedSetting({ ALPACA_FEED: "sip" })).toEqual({ ok: true, feed: "sip" });
    expect(feedSetting({ ALPACA_FEED: "iex" })).toEqual({ ok: false, length: 3 });
    expect(configuredFeed({ ALPACA_FEED: "iex" })).toBeNull();
    expect(() => requireFeed({ ALPACA_FEED: "iex" })).toThrow(FeedMisconfigured);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "alpaca.feed", outcome: "invalid", length: 3, allowed: "sip (iex is paused)" });
  });

  it("takes sip whatever its case and surrounding spaces: the choice is not ambiguous, and a pasted newline must not take the prices off; iex is refused in every spelling", () => {
    for (const v of ["SIP", "\tsip", "sip\r\n", " Sip "]) expect(feedSetting({ ALPACA_FEED: v })).toEqual({ ok: true, feed: "sip" });
    for (const v of ["IEX", " iex ", "Iex", "iex\n"]) expect(feedSetting({ ALPACA_FEED: v })).toEqual({ ok: false, length: v.length });
  });

  it("refuses anything else, Alpaca's other feeds included, keeping only the value's length", () => {
    for (const v of ["delayed_sip", "otc", "boats", "overnight", "i ex", "iex,sip", "sip1", "indicative", "true"]) {
      expect(feedSetting({ ALPACA_FEED: v })).toEqual({ ok: false, length: v.length });
    }
  });

  it("a refusal logs one line naming the length, never the value, once per instance", () => {
    const env = { ALPACA_FEED: "s1p-secretish" };
    expect(configuredFeed(env)).toBeNull();
    expect(configuredFeed(env)).toBeNull();
    expect(() => requireFeed(env)).toThrow(FeedMisconfigured);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "alpaca.feed", outcome: "invalid", length: 13 });
    expect(logged[0]).not.toContain("s1p");
    expect(logged[0]).not.toContain("secretish");
    expect(configuredFeed({ ALPACA_FEED: "sip" })).toBe("sip");
  });

  it("the page's allowlist is the same two names", () => {
    expect(isDataFeed("iex")).toBe(true);
    expect(isDataFeed("sip")).toBe(true);
    for (const v of ["IEX", "indicative", "", null, undefined, 1]) expect(isDataFeed(v)).toBe(false);
    expect(feedLabel("iex")).toBe("IEX");
    expect(feedLabel("sip")).toBe("SIP");
    // an answer that names no feed, or something else, names nothing on the page
    for (const v of [undefined, null, "", "IEX", "delayed_sip"]) expect(feedLabel(v)).toBeNull();
  });

  it("types every response's feed as one of the two, not a fixed one", () => {
    expectTypeOf<QuoteResponse["feed"]>().toEqualTypeOf<DataFeed>();
    expectTypeOf<BarsResponse["feed"]>().toEqualTypeOf<DataFeed>();
    expectTypeOf<DataFeed>().toEqualTypeOf<"iex" | "sip">();
  });
});

const snapshotBody = { SPY: { latestTrade: { t: "2026-10-12T14:59:58Z", p: 780 }, dailyBar: { t: "2026-10-12T04:00:00Z", o: 779, h: 781, l: 777, c: 780 } } };
const barsBody = { bars: { SPY: [{ t: "2026-10-12T13:30:00Z", o: 1, h: 1, l: 1, c: 1 }] }, next_page_token: null };

describe("the upstream URLs carry the configured feed", () => {
  // DEC-0064: only sip can be configured; ALPACA_FEED=iex is refused before any read (next test).
  for (const feed of ["sip"] as const) {
    it(`snapshots and bars both ask ${feed}, and the answers say so`, async () => {
      vi.stubEnv("ALPACA_FEED", feed);
      const q = vi.fn<typeof fetch>(async () => Response.json(snapshotBody));
      const r = await fetchQuotes(["SPY"], KEYS, NOW, q, BASE);
      expect(new URL(String(q.mock.calls[0]![0])).searchParams.get("feed")).toBe(feed);
      expect(r.feed).toBe(feed);
      const b = vi.fn<typeof fetch>(async () => Response.json(barsBody));
      const rb = await fetchBars(["SPY"], KEYS, NOW, b, BASE);
      const url = new URL(String(b.mock.calls[0]![0]));
      expect(url.searchParams.get("feed")).toBe(feed);
      expect(url.searchParams.get("timeframe")).toBe("2Min");
      expect(rb.feed).toBe(feed);
    });
  }

  it("with ALPACA_FEED=iex (paused) nothing goes upstream", async () => {
    vi.stubEnv("ALPACA_FEED", "iex");
    const f = vi.fn<typeof fetch>();
    await expect(fetchQuotes(["SPY"], KEYS, NOW, f, BASE)).rejects.toThrow(FeedMisconfigured);
    await expect(fetchBars(["SPY"], KEYS, NOW, f, BASE)).rejects.toThrow(FeedMisconfigured);
    expect(f).not.toHaveBeenCalled();
  });

  it("a cached answer from the other feed is never served: the name is read again", async () => {
    const q = vi.fn<typeof fetch>(async () => Response.json(snapshotBody));
    await fetchQuotes(["SPY"], KEYS, NOW, q, BASE, { feed: "iex" });
    const r = await fetchQuotes(["SPY"], KEYS, NOW, q, BASE, { feed: "sip" });
    expect(q).toHaveBeenCalledTimes(2);
    expect(new URL(String(q.mock.calls[1]![0])).searchParams.get("feed")).toBe("sip");
    expect(r.feed).toBe("sip");
    const b = vi.fn<typeof fetch>(async () => Response.json(barsBody));
    await fetchBars(["SPY"], KEYS, NOW, b, BASE, false, { feed: "iex" });
    await fetchBars(["SPY"], KEYS, NOW, b, BASE, false, { feed: "sip" });
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("with a refused value nothing goes upstream", async () => {
    vi.stubEnv("ALPACA_FEED", "delayed_sip");
    const f = vi.fn<typeof fetch>();
    await expect(fetchQuotes(["SPY"], KEYS, NOW, f, BASE)).rejects.toThrow(FeedMisconfigured);
    await expect(fetchBars(["SPY"], KEYS, NOW, f, BASE)).rejects.toThrow(FeedMisconfigured);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("the routes with a refused ALPACA_FEED", () => {
  const quote = (cookie?: string) => handleQuote(new Request("https://lab.example/api/quote?s=SPY", cookie ? { headers: { cookie } } : {}), NOW);
  const bars = (cookie?: string) => handleBars(new Request("https://lab.example/api/bars?s=SPY", cookie ? { headers: { cookie } } : {}), NOW);

  it("answer 503 not-configured (the page drops its prices and stops), never call out, and log the length only", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubEnv("ALPACA_FEED", "sip-typo");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const res of [await quote(), await bars()]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toEqual(FEED_REFUSED);
      expect(JSON.stringify(body)).not.toContain("sip-typo");
    }
    expect(f).not.toHaveBeenCalled();
    expect(logged.filter((l) => l.includes("alpaca.feed"))).toEqual([expect.stringContaining('"length":8')]);
    expect(logged.join("\n")).not.toContain("sip-typo");
  });

  it("refuse in fixture mode too, so no fixture price is shown under a feed nobody chose", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ALPACA_FEED", "bogus");
    expect((await quote()).status).toBe(503);
    expect((await bars()).status).toBe(503);
  });

  it("with sip configured the fixture answers name sip; unset, sip too (DEC-0064); iex, refused", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ALPACA_FEED", "sip");
    expect((await (await quote()).json()).feed).toBe("sip");
    expect((await (await bars()).json()).feed).toBe("sip");
    vi.stubEnv("ALPACA_FEED", "");
    expect((await (await quote()).json()).feed).toBe("sip");
    expect((await (await quote("fx=focus.quotes-script")).json()).feed).toBe("sip");
    vi.stubEnv("ALPACA_FEED", "iex");
    for (const res of [await quote(), await bars()]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(FEED_REFUSED);
    }
  });
});

describe("sip refused by the data plan", () => {
  const quote = () => handleQuote(new Request("https://lab.example/api/quote?s=SPY"), NOW);
  const bars = () => handleBars(new Request("https://lab.example/api/bars?s=SPY"), NOW);
  const live = (feed: string, status: number) => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubEnv("ALPACA_FEED", feed);
    const f = vi.fn<typeof fetch>(async () => new Response("upstream-body", { status }));
    vi.stubGlobal("fetch", f);
    resetQuoteCache();
    resetBarsCache();
    return f;
  };
  const planLines = () => logged.filter((l) => l.includes('"outcome":"plan"'));

  it("sip with a 403 is not configured, why plan (the page shows off and stops), logged once as its own outcome", async () => {
    const f = live("sip", 403);
    for (const res of [await quote(), await bars(), await quote()]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(FEED_PLAN_REFUSED);
    }
    expect(new URL(String(f.mock.calls[0]![0])).searchParams.get("feed")).toBe("sip");
    expect(planLines()).toHaveLength(1);
    expect(JSON.parse(planLines()[0]!)).toMatchObject({ evt: "alpaca.feed", outcome: "plan", feed: "sip", status: 403 });
    expect(logged.join("\n")).not.toContain("upstream-body");
  });

  // DEC-0064: a 403 on iex can no longer happen, since ALPACA_FEED=iex is refused before any read. The case now
  // checks that iex is refused as the setting (why feed), never taken for the plan, and nothing is asked.
  it("iex (paused) is refused as the setting (503, why feed) before any read, never as the plan", async () => {
    const f = live("iex", 403);
    for (const res of [await quote(), await bars()]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(FEED_REFUSED);
    }
    expect(f).not.toHaveBeenCalled();
    expect(planLines()).toHaveLength(0);
  });

  it("a 401 on sip stays a failure (502): bad keys are not the plan", async () => {
    live("sip", 401);
    expect((await quote()).status).toBe(502);
    expect((await bars()).status).toBe(502);
    expect(planLines()).toHaveLength(0);
  });

  it("a 429 on sip is still the rate limit", async () => {
    live("sip", 429);
    expect((await quote()).status).toBe(429);
  });
});

// ---- the two ages ---------------------------------------------------------------------------------------------------
const TRADE = Date.parse("2026-10-12T15:00:00Z");
const quoteAt = (ms: number) => ({ at: new Date(ms).toISOString() });

describe("the age words", () => {
  it("read whole seconds, then minutes, hours and days, in at most six characters", () => {
    expect(ageText(0)).toBe("0 s");
    expect(ageText(1_000)).toBe("1 s");
    expect(ageText(59_000)).toBe("59 s");
    expect(ageText(59_400)).toBe("59 s");
    expect(ageText(59_500)).toBe("1 min"); // rounds as the board's other ages do
    expect(ageText(60_000)).toBe("1 min");
    expect(ageText(3_599_000)).toBe("59 min");
    expect(ageText(3_600_000)).toBe("1 h");
    expect(ageText(86_400_000)).toBe("1 d");
    expect(ageText(2_000 * 86_400_000)).toBe("999 d");
    for (const ms of [0, 1_000, 59_000, 60_000, 3_599_000, 86_399_000, 1e15]) expect(ageText(ms).length).toBeLessThanOrEqual(6);
    expect(ageSeconds(-5)).toBe(0);
  });

  it("turn to a warning just past the board's own limits, not at them", () => {
    expect(ageStale("trade", TRADE_STALE_MS)).toBe(false);
    expect(ageStale("trade", TRADE_STALE_MS + 1)).toBe(true);
    expect(ageStale("checked", FEED_STALE_MS)).toBe(false);
    expect(ageStale("checked", FEED_STALE_MS + 1)).toBe(true);
    expect(ageStale("trade", FEED_STALE_MS + 1)).toBe(false); // a 21 s old trade is not stale; a 21 s old answer is
  });
});

/** One name's ages, flat: its last trade and the answer. */
const flat = (a: ReturnType<typeof feedAges>) => {
  expect(a.trade.newestMs).toBe(a.trade.oldestMs);
  return { lastTradeMs: a.trade.newestMs, checkedMs: a.checkedMs };
};

describe("feedAges", () => {
  it("measures the last trade from Alpaca's trade time on the server's clock (trade-state's serverNow)", () => {
    for (const age of [0, 1_000, 59_000, 60_000, TRADE_STALE_MS, FEED_STALE_MS]) {
      const asOf = new Date(TRADE + age).toISOString();
      const a = flat(feedAges({ asOf, receivedAt: 5_000_000, quotes: { SPY: quoteAt(TRADE) } }, ["SPY"], 5_000_000));
      expect(a).toEqual({ lastTradeMs: age, checkedMs: 0 });
      expect(a.lastTradeMs).toBe(serverNow(asOf, 5_000_000, 5_000_000).getTime() - TRADE);
    }
  });

  it("a device clock five minutes fast or slow shows the same ages", () => {
    // The server answered at TRADE + 12 s; the browser got it, and looks again 3 s later, on its own clock.
    const asOf = new Date(TRADE + 12_000).toISOString();
    const real = Date.parse("2026-10-12T15:00:12Z");
    const read = (skew: number) => flat(feedAges({ asOf, receivedAt: real + skew, quotes: { SPY: quoteAt(TRADE) } }, ["SPY"], real + skew + 3_000, "2026-10-12"));
    const right = read(0);
    expect(right).toEqual({ lastTradeMs: 15_000, checkedMs: 3_000 });
    expect(read(5 * 60_000)).toEqual(right);
    expect(read(-5 * 60_000)).toEqual(right);
  });

  it("the same stale trade fetched again: checked stays small while the last trade grows", () => {
    const quotes = { SPY: quoteAt(TRADE) };
    const seen: { lastTradeMs: number | null; checkedMs: number | null }[] = [];
    // Answers every 2 s from TRADE + 10 s, each one looked at 1 s after it came; the browser's clock is 7 min slow.
    for (let i = 0; i < 30; i++) {
      const srv = TRADE + 10_000 + i * 2_000;
      const browser = srv - 7 * 60_000;
      seen.push(flat(feedAges({ asOf: new Date(srv).toISOString(), receivedAt: browser, quotes }, ["SPY"], browser + 1_000)));
    }
    expect(seen.every((a) => a.checkedMs === 1_000)).toBe(true);
    expect(seen.map((a) => a.lastTradeMs)).toEqual(seen.map((_, i) => 11_000 + i * 2_000));
    expect(ageStale("trade", seen.at(-1)!.lastTradeMs!)).toBe(false);
    // and once the answers stop, both grow
    const last = { asOf: new Date(TRADE + 10_000).toISOString(), receivedAt: 1_000_000, quotes };
    expect(flat(feedAges(last, ["SPY"], 1_000_000 + 30_000))).toEqual({ lastTradeMs: 40_000, checkedMs: 30_000 });
    expect(ageStale("checked", 30_000)).toBe(true);
  });

  it("reads every quote in the answer when no names are given", () => {
    const quotes = { SPY: quoteAt(TRADE - 30_000), QQQ: quoteAt(TRADE - 5_000) };
    const a = feedAges({ asOf: new Date(TRADE).toISOString(), receivedAt: 0, quotes }, null, 0);
    expect(a.trade).toEqual({ newestMs: 5_000, oldestMs: 30_000, traded: 2, noTrade: 0 });
  });

  it("knows nothing before the browser has a clock, or from an unreadable answer; never below zero", () => {
    const quotes = { SPY: quoteAt(TRADE + 5_000) };
    expect(flat(feedAges({ asOf: new Date(TRADE).toISOString(), receivedAt: 0, quotes }, null, null))).toEqual({ lastTradeMs: null, checkedMs: null });
    expect(flat(feedAges({ asOf: "nope", receivedAt: 0, quotes }, null, 0))).toEqual({ lastTradeMs: null, checkedMs: null });
    // a trade stamped a moment after the server's answer reads 0, not a negative age
    expect(flat(feedAges({ asOf: new Date(TRADE).toISOString(), receivedAt: 0, quotes }, null, 0))).toEqual({ lastTradeMs: 0, checkedMs: 0 });
  });
});

describe("tradeAgeRange: the spread of last-trade ages across the board's names", () => {
  const S = "2026-10-12";
  const NOW = TRADE + 60_000;
  it("one name: both ends are its age", () => {
    expect(tradeAgeRange({ SPY: quoteAt(TRADE) }, ["SPY"], NOW, S)).toEqual({ newestMs: 60_000, oldestMs: 60_000, traded: 1, noTrade: 0 });
  });

  it("several names: the newest and the oldest, so a busy name never hides a quiet one", () => {
    const q = { SPY: quoteAt(NOW - 1_000), QQQ: quoteAt(NOW - 90_000), AAPL: quoteAt(NOW - 20_000) };
    expect(tradeAgeRange(q, ["SPY", "QQQ", "AAPL"], NOW, S)).toEqual({ newestMs: 1_000, oldestMs: 90_000, traded: 3, noTrade: 0 });
  });

  it("equal times give equal ends", () => {
    const q = { SPY: quoteAt(TRADE), QQQ: quoteAt(TRADE) };
    expect(tradeAgeRange(q, ["SPY", "QQQ"], NOW, S)).toEqual({ newestMs: 60_000, oldestMs: 60_000, traded: 2, noTrade: 0 });
  });

  it("a name with no quote, an unreadable time or yesterday's trade is counted apart, never as fresh", () => {
    const q = { SPY: quoteAt(NOW - 2_000), BAD: { at: "x" }, OLD: quoteAt(Date.parse("2026-10-09T19:59:00Z")) };
    expect(tradeAgeRange(q, ["SPY", "QQQ", "BAD", "OLD"], NOW, S)).toEqual({ newestMs: 2_000, oldestMs: 2_000, traded: 1, noTrade: 3 });
    expect(tradeAgeRange(q, ["QQQ"], NOW, S)).toEqual({ newestMs: null, oldestMs: null, traded: 0, noTrade: 1 });
    // without a session every readable trade counts
    expect(tradeAgeRange(q, ["SPY", "OLD"], NOW, null).traded).toBe(2);
  });

  it("one name past the stale limit makes the oldest end stale while the newest is fresh", () => {
    const q = { SPY: quoteAt(NOW - 1_000), QQQ: quoteAt(NOW - TRADE_STALE_MS - 1_000) };
    const r = tradeAgeRange(q, ["SPY", "QQQ"], NOW, S);
    expect(ageStale("trade", r.newestMs!)).toBe(false);
    expect(ageStale("trade", r.oldestMs!)).toBe(true);
  });

  it("a provider time ahead of the server's clock reads 0, and no clock reads nothing", () => {
    const q = { SPY: quoteAt(NOW + 4_000), QQQ: quoteAt(NOW - 10_000) };
    expect(tradeAgeRange(q, ["SPY", "QQQ"], NOW, S)).toEqual({ newestMs: 0, oldestMs: 10_000, traded: 2, noTrade: 0 });
    expect(tradeAgeRange(q, ["SPY", "QQQ"], null, S)).toEqual({ newestMs: null, oldestMs: null, traded: 2, noTrade: 0 });
  });
});

describe("recordFeed: a stored shadow record's feed", () => {
  it("is the record's own, and null for one written before the field existed", () => {
    expect(recordFeed({ v: 1, feed: "sip" })).toBe("sip");
    expect(recordFeed({ v: 1, feed: "iex" })).toBe("iex");
    expect(recordFeed({ v: 1 })).toBeNull();
    expect(recordFeed({ v: 1, feed: null })).toBeNull();
    expect(recordFeed({ v: 1, feed: "SIP" })).toBeNull();
    expect(recordFeed(null)).toBeNull();
  });
});

// ---- what the page draws --------------------------------------------------------------------------------------------
describe("FeedFacts", () => {
  const okFeed = (over: Partial<Extract<Feed, { status: "ok" }>> = {}): Feed => ({
    status: "ok",
    asOf: new Date(TRADE + 12_000).toISOString(),
    source: "iex",
    quotes: { SPY: { price: 780, at: new Date(TRADE).toISOString(), open: null, high: null, low: null, day: "2026-10-12", prev_close: null, vwap: null } },
    missing: [],
    receivedAt: 1_000_000,
    trails: {},
    ...over,
  });
  const draw = (feed: Feed, now: number | null, symbols: string[] = ["SPY"]) =>
    renderToStaticMarkup(
      createElement(LiveContext.Provider, { value: { feed, session: "2026-10-12", now, backoff: null, retryNow: () => undefined } }, createElement(FeedFacts, { where: "board", symbols })),
    );
  const q = (at: number) => ({ price: 1, at: new Date(at).toISOString(), open: null, high: null, low: null, day: "2026-10-12", prev_close: null, vwap: null });
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("names the feed the answer reported, says it is fetched every 2 s, and gives both ages apart", () => {
    const html = draw(okFeed({ source: "sip" }), 1_003_000);
    expect(text(html)).toBe("SIP · authoritative · fetched every 2 s, not streamed last trade 15 s ago checked 3 s ago");
    expect(html).toContain('data-feed-age="trade"');
    expect(html).toContain('data-age-s="15"');
    expect(html).toContain('data-age-s="3"');
    expect(html).toContain('aria-live="off"');
    expect(html).not.toContain("text-warn");
    expect(text(draw(okFeed({ source: "sip" }), 1_003_000))).toMatch(/^SIP · /);
  });

  it("DEC-0050: SIP reads as authoritative, IEX in the warning tone with the decision as its title", () => {
    const sip = draw(okFeed({ source: "sip" }), 1_003_000);
    expect(sip).toContain('data-feed-name="SIP"');
    expect(text(sip)).toMatch(/^SIP · authoritative · fetched/);
    expect(sip).not.toContain("text-warn");
    const iex = draw(okFeed({ source: "iex" }), 1_003_000);
    expect(iex).toMatch(/<span data-feed-name="IEX" title="DEC-0050: the board should read SIP" aria-description="DEC-0050: the board should read SIP" class="text-warn font-medium">IEX<\/span>/);
    expect(text(iex)).toMatch(/^IEX · fetched/);
    expect(iex.match(/text-warn/g)).toHaveLength(1);
  });

  it("names no feed when the answer named none", () => {
    const html = draw(okFeed({ source: null }), 1_003_000);
    expect(html).not.toContain("data-feed-name");
    expect(text(html)).toMatch(/^fetched every 2 s, not streamed/);
    expect(html).not.toMatch(/IEX|SIP/);
  });

  it("warns past the limits, and draws nothing while the feed is off, failing before any answer, or loading", () => {
    const old = draw(okFeed({ source: "sip" }), 1_000_000 + 25_000); // answer 25 s old, trade 37 s old
    expect(old.match(/text-warn/g)).toHaveLength(1);
    expect(draw(okFeed({ source: "sip" }), 1_000_000 + 200_000).match(/text-warn/g)).toHaveLength(2);
    for (const feed of [{ status: "off" }, { status: "off", why: "feed" }, { status: "error" }, { status: "loading" }] as Feed[]) expect(draw(feed, 1_000_000)).toBe("");
  });

  it("several names show the spread, newest to oldest, coloured by the oldest end", () => {
    // the browser looks 3 s after the answer: the server's now is TRADE + 15 s
    const feed = okFeed({ quotes: { SPY: q(TRADE + 14_000), QQQ: q(TRADE - 75_000) } });
    const html = draw(feed, 1_003_000, ["SPY", "QQQ"]);
    expect(text(html)).toBe("IEX · fetched every 2 s, not streamed last trades 1 s to 1 min ago checked 3 s ago");
    expect(html).toContain('data-age-range="two"');
    expect(html).toContain('data-trade-stale="false"');
    const stale = draw(okFeed({ source: "sip", quotes: { SPY: q(TRADE + 14_000), QQQ: q(TRADE - 200_000) } }), 1_003_000, ["SPY", "QQQ"]);
    expect(stale).toContain('data-trade-stale="true"');
    expect(stale.match(/text-warn/g)).toHaveLength(1);
  });

  it("both ends reading the same show one value, the other end's room kept but hidden", () => {
    const html = draw(okFeed({ quotes: { SPY: q(TRADE), QQQ: q(TRADE) } }), 1_003_000, ["SPY", "QQQ"]);
    expect(html).toContain('data-age-range="one"');
    expect(html).toMatch(/data-age-range="one" aria-hidden="true" class="[^"]*invisible/);
  });

  it("a name with no trade today is said apart, in the warning colour, and never freshens the spread", () => {
    const html = draw(okFeed({ quotes: { SPY: q(TRADE), OLD: q(Date.parse("2026-10-09T19:59:00Z")) } }), 1_003_000, ["SPY", "OLD", "QQQ"]);
    expect(text(html)).toBe("IEX · fetched every 2 s, not streamed last trade 15 s ago 2 names with no trade today checked 3 s ago");
    expect(html).toContain('data-feed-no-trade="2"');
    const none = draw(okFeed({ quotes: {} }), 1_003_000, ["SPY"]);
    expect(text(none)).toBe("IEX · fetched every 2 s, not streamed no trade today checked 3 s ago");
    expect(none).not.toContain('data-feed-age="trade"');
  });

  it("before the browser has a clock the slots hold a dash, never a made-up age", () => {
    expect(text(draw(okFeed(), null))).toBe("IEX · fetched every 2 s, not streamed last trade – ago checked – ago");
  });

  it("the pill says why the prices are off when it is the setting or the plan, and stays as it was for missing keys", () => {
    const pill = (feed: Feed) =>
      renderToStaticMarkup(createElement(LiveContext.Provider, { value: { feed, session: "2026-10-12", now: 1, backoff: null, retryNow: () => undefined } }, createElement(FeedPill)))
        .replace(/<[^>]+>/g, "")
        .trim();
    expect(pill({ status: "off" })).toBe("Live off");
    expect(pill({ status: "off", why: "feed" })).toBe("Live off: ALPACA_FEED is not iex or sip");
    expect(pill({ status: "off", why: "plan" })).toBe("Live off: SIP is not on this data plan");
  });

  it("DEC-0050: the pill names SIP as authoritative, and IEX in the warning tone with the decision as its title", () => {
    const html = (feed: Feed) =>
      renderToStaticMarkup(createElement(LiveContext.Provider, { value: { feed, session: "2026-10-12", now: 1, backoff: null, retryNow: () => undefined } }, createElement(FeedPill)));
    const asOf = "2026-10-12T14:31:00Z"; // 10:31 New York
    const sip = html(okFeed({ source: "sip", asOf }));
    expect(text(sip)).toBe("Live 10:31 · SIP · authoritative");
    expect(sip).not.toContain("text-warn");
    const iex = html(okFeed({ source: "iex", asOf }));
    expect(text(iex)).toBe("Live 10:31 · IEX");
    expect(iex).toContain('title="DEC-0050: the board should read SIP"');
    expect(iex).toContain('aria-description="DEC-0050: the board should read SIP"');
    expect(iex).toContain("text-warn");
    expect(text(html(okFeed({ source: null, asOf })))).toBe("Live 10:31");
  });
});
