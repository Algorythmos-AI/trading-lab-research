import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleQuote } from "@/lib/quote-route";
import { CACHE_MS, MAX_CACHED, MAX_SYMBOLS, alpacaKeys, fetchQuotes, normalise, parseSymbols, resetQuoteCache } from "@/lib/quote";

const NOW = new Date("2026-10-12T15:00:00Z");
const KEYS = { id: "test-key-id", secret: "test-key-secret" };

const snap = (p: number) => ({
  latestTrade: { t: "2026-10-12T14:59:58.123456789Z", p, s: 100 },
  latestQuote: { ap: p + 0.01, bp: p - 0.01 },
  dailyBar: { t: "2026-10-12T04:00:00Z", o: 779, h: 781, l: 777.5, c: p, v: 1 },
  prevDailyBar: { t: "2026-10-09T04:00:00Z", o: 776.24, h: 779.4, l: 775.16, c: 778.55, v: 1 },
});

function okFetch(body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  resetQuoteCache();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("symbols", () => {
  it("upper-cases, de-duplicates, drops junk and caps the list", () => {
    expect(parseSymbols("spy, QQQ,spy,,bad sym,BRK.B")).toEqual(["SPY", "QQQ", "BRK.B"]);
    expect(parseSymbols("../x,<script>")).toBeNull();
    expect(parseSymbols(null)).toBeNull();
    const many = Array.from({ length: MAX_SYMBOLS + 20 }, (_, i) => `A${i}`).join(",");
    expect(parseSymbols(many)!.length).toBe(MAX_SYMBOLS);
    // One options edition may carry 60 names; the cap must not drop any of them.
    expect(MAX_SYMBOLS).toBe(60);
  });
});

describe("alpacaKeys", () => {
  it("reads ALPACA_ names, falls back to Alpaca's own APCA_ names, and needs both halves", () => {
    expect(alpacaKeys({ ALPACA_API_KEY_ID: "a", ALPACA_API_SECRET_KEY: "b" })).toEqual({ id: "a", secret: "b" });
    expect(alpacaKeys({ APCA_API_KEY_ID: "c", APCA_API_SECRET_KEY: "d" })).toEqual({ id: "c", secret: "d" });
    expect(alpacaKeys({ ALPACA_API_KEY_ID: "a", ALPACA_API_SECRET_KEY: "b", APCA_API_KEY_ID: "c", APCA_API_SECRET_KEY: "d" })).toEqual({
      id: "a",
      secret: "b",
    });
    expect(alpacaKeys({ ALPACA_API_KEY_ID: "a", APCA_API_SECRET_KEY: "d" })).toBeNull();
    expect(alpacaKeys({})).toBeNull();
  });
});

describe("normalise", () => {
  it("keeps the last trade, the day's bar (dated in New York) and yesterday's close", () => {
    expect(normalise(snap(779.1))).toEqual({
      price: 779.1,
      at: "2026-10-12T14:59:58.123Z",
      open: 779,
      high: 781,
      low: 777.5,
      day: "2026-10-12",
      prev_close: 778.55,
    });
  });

  it("is null without a usable trade", () => {
    expect(normalise(null)).toBeNull();
    expect(normalise({ latestTrade: { t: "2026-10-12T14:59:58Z", p: 0 } })).toBeNull();
    expect(normalise({ latestTrade: { t: "nope", p: 10 } })).toBeNull();
  });
});

describe("fetchQuotes", () => {
  it("asks the IEX feed with the keys in headers, and reports missing names", async () => {
    const f = okFetch({ SPY: snap(779.1) });
    const r = await fetchQuotes(["SPY", "QQQ"], KEYS, NOW, f, "https://data.example");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://data.example/v2/stocks/snapshots?symbols=SPY%2CQQQ&feed=iex");
    expect((init!.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("test-key-id");
    expect(r.quotes.SPY!.price).toBe(779.1);
    expect(r.missing).toEqual(["QQQ"]);
    expect(r.feed).toBe("iex");
  });

  it("reads the older nested shape too", async () => {
    const r = await fetchQuotes(["SPY"], KEYS, NOW, okFetch({ snapshots: { SPY: snap(1) } }), "https://data.example");
    expect(r.quotes.SPY!.price).toBe(1);
  });

  it("serves the same symbol set from cache for CACHE_MS, then asks again", async () => {
    const f = okFetch({ SPY: snap(779.1) });
    await fetchQuotes(["SPY"], KEYS, NOW, f, "https://data.example");
    await fetchQuotes(["SPY"], KEYS, new Date(NOW.getTime() + CACHE_MS - 1), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(1);
    await fetchQuotes(["SPY"], KEYS, new Date(NOW.getTime() + CACHE_MS), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("caches each name on its own, so two pages with different names do not evict each other", async () => {
    const f = okFetch({ SPY: snap(779.1), QQQ: snap(751.2), AAPL: snap(336.6) });
    const board = ["SPY", "QQQ"];
    await fetchQuotes(board, KEYS, NOW, f, "https://data.example");
    await fetchQuotes(["AAPL"], KEYS, new Date(NOW.getTime() + 100), f, "https://data.example");
    const again = await fetchQuotes(board, KEYS, new Date(NOW.getTime() + 200), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
    expect(Object.keys(again.quotes)).toEqual(board);
  });

  it("asks upstream only for the names past their time, and dates the answer by the oldest fetch", async () => {
    const f = okFetch({ SPY: snap(779.1), QQQ: snap(751.2) });
    await fetchQuotes(["SPY"], KEYS, NOW, f, "https://data.example");
    const later = new Date(NOW.getTime() + 500);
    const r = await fetchQuotes(["SPY", "QQQ"], KEYS, later, f, "https://data.example");
    expect(String(f.mock.calls[1]![0])).toBe("https://data.example/v2/stocks/snapshots?symbols=QQQ&feed=iex");
    expect(r.quotes.SPY!.price).toBe(779.1);
    expect(r.quotes.QQQ!.price).toBe(751.2);
    expect(r.as_of).toBe(NOW.toISOString());
    // A name with no usable price is remembered as missing for the same time, not asked for again at once.
    const none = okFetch({});
    await fetchQuotes(["ZZZZ"], KEYS, later, none, "https://data.example");
    expect((await fetchQuotes(["ZZZZ"], KEYS, later, none, "https://data.example")).missing).toEqual(["ZZZZ"]);
    expect(none).toHaveBeenCalledTimes(1);
  });

  it("does not trust an entry stamped after the caller's clock", async () => {
    const f = okFetch({ SPY: snap(779.1) });
    await fetchQuotes(["SPY"], KEYS, NOW, f, "https://data.example");
    await fetchQuotes(["SPY"], KEYS, new Date(NOW.getTime() - 60_000), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("remembers at most MAX_CACHED names, dropping the oldest first", async () => {
    const f = okFetch({});
    const name = (i: number) => `A${i}`;
    const total = MAX_CACHED + MAX_SYMBOLS;
    for (let i = 0; i < total; i += MAX_SYMBOLS) {
      await fetchQuotes(Array.from({ length: MAX_SYMBOLS }, (_, k) => name(i + k)), KEYS, NOW, f, "https://data.example");
    }
    const calls = f.mock.calls.length;
    // The newest names are still held; the first ones were dropped and go upstream again.
    await fetchQuotes([name(total - 1)], KEYS, NOW, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(calls);
    await fetchQuotes([name(0)], KEYS, NOW, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(calls + 1);
  });

  it("throws on an HTTP error without caching it", async () => {
    const bad = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(fetchQuotes(["SPY"], KEYS, NOW, bad, "https://data.example")).rejects.toThrow();
    const f = okFetch({ SPY: snap(2) });
    expect((await fetchQuotes(["SPY"], KEYS, NOW, f, "https://data.example")).quotes.SPY!.price).toBe(2);
  });
});

describe("GET /api/quote", () => {
  const get = (q: string) => handleQuote(new Request(`https://lab.example/api/quote${q}`), NOW);

  it("400 without symbols", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?s=<x>")).status).toBe(400);
  });

  it("503 until the Alpaca keys are set, and never calls out", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "");
    vi.stubEnv("APCA_API_KEY_ID", "");
    vi.stubEnv("APCA_API_SECRET_KEY", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await get("?s=SPY");
    expect(res.status).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });

  it("502 when Alpaca fails, without echoing its body or the keys", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream-secret-body", { status: 500 })));
    const res = await get("?s=SPY");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("upstream-secret-body");
    expect(text).not.toContain("test-key");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("200 with quotes when configured", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubGlobal("fetch", okFetch({ SPY: snap(779.1) }));
    const res = await get("?s=SPY");
    expect(res.status).toBe(200);
    expect((await res.json()).quotes.SPY.price).toBe(779.1);
  });

  it("fixture mode answers from the options fixture with no keys and no network", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const body = await (await get("?s=SPY,ZZZZ")).json();
    expect(body.fixture).toBe(true);
    expect(body.quotes.SPY.day).toBe("2026-10-12");
    expect(body.missing).toEqual(["ZZZZ"]);
    expect(f).not.toHaveBeenCalled();
  });
});
