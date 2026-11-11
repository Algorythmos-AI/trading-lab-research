// Feed provenance: which Alpaca stock feed the site reads (ALPACA_FEED, alpaca-feed.ts), that every upstream URL
// carries it, that a bad value takes the prices off rather than guessing, and the two ages the page shows
// (feed-provenance.ts) on the server's clock, never the device's.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { configuredFeed, DEFAULT_FEED, FEED_REFUSED, FeedMisconfigured, feedSetting, requireFeed, resetFeedWarning } from "@/lib/alpaca-feed";
import { type BarsResponse, fetchBars, resetBarsCache } from "@/lib/bars";
import { handleBars } from "@/lib/bars-route";
import { TRADE_STALE_MS } from "@/lib/entry-checks";
import { ageSeconds, ageStale, ageText, type DataFeed, feedAges, feedLabel, isDataFeed, newestTradeAt, recordFeed } from "@/lib/feed-provenance";
import { fetchQuotes, type QuoteResponse, resetQuoteCache } from "@/lib/quote";
import { handleQuote } from "@/lib/quote-route";
import { FEED_STALE_MS, serverNow } from "@/lib/trade-state";
import { FeedFacts, LiveContext } from "@/components/client/live-layer";
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
  it("is iex when unset or empty (or only spaces)", () => {
    expect(DEFAULT_FEED).toBe("iex");
    expect(feedSetting({})).toEqual({ ok: true, feed: "iex" });
    expect(feedSetting({ ALPACA_FEED: "" })).toEqual({ ok: true, feed: "iex" });
    expect(feedSetting({ ALPACA_FEED: "  " })).toEqual({ ok: true, feed: "iex" });
  });

  it("takes iex and sip", () => {
    expect(feedSetting({ ALPACA_FEED: "iex" })).toEqual({ ok: true, feed: "iex" });
    expect(feedSetting({ ALPACA_FEED: "sip" })).toEqual({ ok: true, feed: "sip" });
  });

  it("takes them whatever their case and surrounding spaces: the choice is not ambiguous, and a pasted newline must not take the prices off", () => {
    for (const v of ["IEX", " iex ", "Iex", "iex\n"]) expect(feedSetting({ ALPACA_FEED: v })).toEqual({ ok: true, feed: "iex" });
    for (const v of ["SIP", "\tsip", "sip\r\n", " Sip "]) expect(feedSetting({ ALPACA_FEED: v })).toEqual({ ok: true, feed: "sip" });
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
  for (const feed of ["iex", "sip"] as const) {
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

  it("with sip configured the fixture answers name sip; unset, iex", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ALPACA_FEED", "sip");
    expect((await (await quote()).json()).feed).toBe("sip");
    expect((await (await bars()).json()).feed).toBe("sip");
    vi.stubEnv("ALPACA_FEED", "");
    expect((await (await quote()).json()).feed).toBe("iex");
    expect((await (await quote("fx=focus.quotes-script")).json()).feed).toBe("iex");
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

describe("feedAges", () => {
  it("measures the last trade from Alpaca's trade time on the server's clock (trade-state's serverNow)", () => {
    for (const age of [0, 1_000, 59_000, 60_000, TRADE_STALE_MS, FEED_STALE_MS]) {
      const asOf = new Date(TRADE + age).toISOString();
      const a = feedAges({ asOf, receivedAt: 5_000_000, quotes: { SPY: quoteAt(TRADE) } }, ["SPY"], 5_000_000);
      expect(a).toEqual({ lastTradeMs: age, checkedMs: 0 });
      expect(a.lastTradeMs).toBe(serverNow(asOf, 5_000_000, 5_000_000).getTime() - TRADE);
    }
  });

  it("a device clock five minutes fast or slow shows the same ages", () => {
    // The server answered at TRADE + 12 s; the browser got it, and looks again 3 s later, on its own clock.
    const asOf = new Date(TRADE + 12_000).toISOString();
    const real = Date.parse("2026-10-12T15:00:12Z");
    const read = (skew: number) => feedAges({ asOf, receivedAt: real + skew, quotes: { SPY: quoteAt(TRADE) } }, ["SPY"], real + skew + 3_000);
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
      seen.push(feedAges({ asOf: new Date(srv).toISOString(), receivedAt: browser, quotes }, ["SPY"], browser + 1_000));
    }
    expect(seen.every((a) => a.checkedMs === 1_000)).toBe(true);
    expect(seen.map((a) => a.lastTradeMs)).toEqual(seen.map((_, i) => 11_000 + i * 2_000));
    expect(ageStale("trade", seen.at(-1)!.lastTradeMs!)).toBe(false);
    // and once the answers stop, both grow
    const last = { asOf: new Date(TRADE + 10_000).toISOString(), receivedAt: 1_000_000, quotes };
    expect(feedAges(last, ["SPY"], 1_000_000 + 30_000)).toEqual({ lastTradeMs: 40_000, checkedMs: 30_000 });
    expect(ageStale("checked", 30_000)).toBe(true);
  });

  it("takes the newest trade among the names asked for, and nothing it cannot read", () => {
    const quotes = { SPY: quoteAt(TRADE - 30_000), QQQ: quoteAt(TRADE - 5_000), AAPL: quoteAt(TRADE), BAD: { at: "x" } };
    expect(newestTradeAt(quotes, ["SPY", "QQQ"])).toBe(TRADE - 5_000);
    expect(newestTradeAt(quotes, null)).toBe(TRADE);
    expect(newestTradeAt(quotes, ["BAD", "NONE"])).toBeNull();
    const asOf = new Date(TRADE).toISOString();
    expect(feedAges({ asOf, receivedAt: 0, quotes }, ["NONE"], 0)).toEqual({ lastTradeMs: null, checkedMs: 0 });
  });

  it("knows nothing before the browser has a clock, or from an unreadable answer; never below zero", () => {
    const quotes = { SPY: quoteAt(TRADE + 5_000) };
    expect(feedAges({ asOf: new Date(TRADE).toISOString(), receivedAt: 0, quotes }, null, null)).toEqual({ lastTradeMs: null, checkedMs: null });
    expect(feedAges({ asOf: "nope", receivedAt: 0, quotes }, null, 0)).toEqual({ lastTradeMs: null, checkedMs: null });
    // a trade stamped a moment after the server's answer reads 0, not a negative age
    expect(feedAges({ asOf: new Date(TRADE).toISOString(), receivedAt: 0, quotes }, null, 0)).toEqual({ lastTradeMs: 0, checkedMs: 0 });
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
  const draw = (feed: Feed, now: number | null) =>
    renderToStaticMarkup(
      createElement(LiveContext.Provider, { value: { feed, session: "2026-10-12", now, backoff: null, retryNow: () => undefined } }, createElement(FeedFacts, { where: "board", symbols: ["SPY"] })),
    );
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("names the feed the answer reported, says it is fetched every 2 s, and gives both ages apart", () => {
    const html = draw(okFeed(), 1_003_000);
    expect(text(html)).toBe("IEX · fetched every 2 s, not streamed last trade 15 s ago checked 3 s ago");
    expect(html).toContain('data-feed-age="trade"');
    expect(html).toContain('data-age-s="15"');
    expect(html).toContain('data-age-s="3"');
    expect(html).toContain('aria-live="off"');
    expect(html).not.toContain("text-warn");
    expect(text(draw(okFeed({ source: "sip" }), 1_003_000))).toMatch(/^SIP · /);
  });

  it("names no feed when the answer named none", () => {
    const html = draw(okFeed({ source: null }), 1_003_000);
    expect(html).not.toContain("data-feed-name");
    expect(text(html)).toMatch(/^fetched every 2 s, not streamed/);
    expect(html).not.toMatch(/IEX|SIP/);
  });

  it("warns past the limits, and draws nothing while the feed is off, failing before any answer, or loading", () => {
    const old = draw(okFeed(), 1_000_000 + 25_000); // answer 25 s old, trade 37 s old
    expect(old.match(/text-warn/g)).toHaveLength(1);
    expect(draw(okFeed(), 1_000_000 + 200_000).match(/text-warn/g)).toHaveLength(2);
    for (const feed of [{ status: "off" }, { status: "off", why: "feed" }, { status: "error" }, { status: "loading" }] as Feed[]) expect(draw(feed, 1_000_000)).toBe("");
  });

  it("before the browser has a clock the slots hold a dash, never a made-up age", () => {
    expect(text(draw(okFeed(), null))).toBe("IEX · fetched every 2 s, not streamed last trade – ago checked – ago");
  });
});
