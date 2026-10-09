import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleQuote } from "@/lib/quote-route";
import { CACHE_MS, MAX_SYMBOLS, fetchQuotes, normalise, parseSymbols, resetQuoteCache } from "@/lib/quote";

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
    const many = Array.from({ length: 30 }, (_, i) => `A${i}`).join(",");
    expect(parseSymbols(many)!.length).toBe(MAX_SYMBOLS);
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
