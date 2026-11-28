import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BARS_CACHE_MS, fetchBars, MAX_PAGES, normaliseBar, resetBarsCache } from "@/lib/bars";
import { handleBars } from "@/lib/bars-route";
import { handleQuote } from "@/lib/quote-route";
import { scriptBars, SCRIPT_STEPS, stepInstant } from "@/lib/fixture-script";
import { SERVER_SETTLE_MS, atr2m, type Bar2, type Bars2m, mergeBars } from "@/lib/trade-state";

const NOW = new Date("2026-10-12T15:00:00Z"); // 11:00 New York, EDT
const OPEN = Date.parse("2026-10-12T13:30:00Z");
const KEYS = { id: "test-key-id", secret: "test-key-secret" };
const DONE = NOW.getTime(); // a server fetch well after every bar below had closed

const raw = (min: number, c: number) => ({ t: new Date(OPEN + min * 60_000).toISOString(), o: c - 0.1, h: c + 0.2, l: c - 0.3, c, v: 10, n: 2, vw: c });

beforeEach(() => {
  resetBarsCache();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("normaliseBar", () => {
  it("turns Alpaca's bar into start, end and prices", () => {
    expect(normaliseBar(raw(0, 100))).toEqual({ start: OPEN, end: OPEN + 120_000, o: 99.9, h: 100.2, l: 99.7, c: 100 });
  });
  it("drops non-finite prices, bad times and bars outside the regular session", () => {
    expect(normaliseBar({ ...raw(0, 100), c: Number.NaN })).toBeNull();
    expect(normaliseBar({ ...raw(0, 100), h: "1" })).toBeNull();
    expect(normaliseBar({ ...raw(0, 100), t: "yesterday" })).toBeNull();
    expect(normaliseBar({ ...raw(0, 100), o: 0 })).toBeNull();
    expect(normaliseBar(raw(-2, 100))).toBeNull(); // 09:28
    expect(normaliseBar(raw(390, 100))).toBeNull(); // 16:00
    expect(normaliseBar(null)).toBeNull();
  });
  it("ends a half day's session at 13:00", () => {
    expect(normaliseBar(raw(208, 100), true)).not.toBeNull(); // 12:58
    expect(normaliseBar(raw(210, 100), true)).toBeNull(); // 13:00
    expect(normaliseBar(raw(210, 100))).not.toBeNull();
  });
});

describe("fetchBars", () => {
  // DEC-0064: unset ALPACA_FEED is sip now (iex is paused), so the default read asks sip.
  it("reads every page, asks from 09:30 New York on the SIP feed (the default), and orders the bars", async () => {
    const urls: string[] = [];
    const pages = [
      { bars: { SPY: [raw(2, 101), raw(0, 100)], QQQ: [raw(0, 200)] }, next_page_token: "p2" },
      { bars: { QQQ: [raw(2, 201), raw(0, 200)] }, next_page_token: null },
    ];
    const f = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
    });
    const res = await fetchBars(["SPY", "QQQ", "AAPL"], KEYS, NOW, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
    const first = new URL(urls[0]!);
    expect(first.pathname).toBe("/v2/stocks/bars");
    expect(first.searchParams.get("timeframe")).toBe("2Min");
    expect(first.searchParams.get("feed")).toBe("sip");
    expect(first.searchParams.get("limit")).toBe("10000");
    expect(first.searchParams.get("start")).toBe("2026-10-12T13:30:00.000Z");
    expect(first.searchParams.get("symbols")).toBe("SPY,QQQ,AAPL");
    expect(new URL(urls[1]!).searchParams.get("page_token")).toBe("p2");
    expect(res.bars.SPY!.map((b) => b.c)).toEqual([100, 101]);
    // a page boundary that repeats a slot keeps one bar
    expect(res.bars.QQQ!.map((b) => b.c)).toEqual([200, 201]);
    expect(res.missing).toEqual(["AAPL"]);
    expect(res.feed).toBe("sip");
  });

  it("stops after MAX_PAGES even if Alpaca keeps paging, and reports those names missing, not cached as complete", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 1)] }, next_page_token: "again" }), { status: 200 }));
    const res = await fetchBars(["SPY"], KEYS, NOW, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(MAX_PAGES);
    expect(res.bars.SPY).toBeUndefined();
    expect(res.missing).toEqual(["SPY"]);
    expect(res.fetchedAt.SPY).toBeUndefined();
    // nothing cached: the next answer asks again
    await fetchBars(["SPY"], KEYS, new Date(NOW.getTime() + 1_000), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2 * MAX_PAGES);
    // logged without the token, the keys or the body
    const logged = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(logged).toContain("page-limit");
    expect(logged).not.toContain("again");
    expect(logged).not.toContain("test-key");
  });

  it("carries each name's fetch time, from the cache entry and not the request", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 1)] } }), { status: 200 }));
    const a = await fetchBars(["SPY"], KEYS, NOW, f, "https://data.example");
    expect(a.fetchedAt).toEqual({ SPY: NOW.getTime() });
    const b = await fetchBars(["SPY"], KEYS, new Date(NOW.getTime() + 3_000), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(1);
    expect(b.fetchedAt).toEqual({ SPY: NOW.getTime() });
  });

  it("drops a cached name at each 2-minute boundary, and again once the closed bar's grace has passed", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 1)] } }), { status: 200 }));
    const at = (hms: string) => new Date(`2026-10-12T${hms}-04:00`);
    await fetchBars(["SPY"], KEYS, at("10:21:55"), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(1);
    await fetchBars(["SPY"], KEYS, at("10:22:01"), f, "https://data.example"); // inside BARS_CACHE_MS, but a new slot
    expect(f).toHaveBeenCalledTimes(2);
    await fetchBars(["SPY"], KEYS, at("10:22:04"), f, "https://data.example"); // still inside the grace: cached
    expect(f).toHaveBeenCalledTimes(2);
    await fetchBars(["SPY"], KEYS, at("10:22:06"), f, "https://data.example"); // the 10:20 bar is complete now
    expect(f).toHaveBeenCalledTimes(3);
    await fetchBars(["SPY"], KEYS, at("10:22:10"), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("on a half day keeps no bar from 13:00 on", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 1), raw(208, 2), raw(210, 3), raw(300, 4)] } }), { status: 200 }));
    const late = new Date("2026-10-12T19:00:00Z"); // 15:00 New York
    const half = await fetchBars(["SPY"], KEYS, late, f, "https://data.example", true);
    expect(half.bars.SPY!.map((b) => b.c)).toEqual([1, 2]);
    resetBarsCache();
    const full = await fetchBars(["SPY"], KEYS, late, f, "https://data.example");
    expect(full.bars.SPY!.map((b) => b.c)).toEqual([1, 2, 3, 4]);
  });

  it("asks nothing before the open, and caches each name for a while", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 1)] } }), { status: 200 }));
    const early = await fetchBars(["SPY"], KEYS, new Date("2026-10-12T13:00:00Z"), f, "https://data.example");
    expect(f).not.toHaveBeenCalled();
    expect(early.bars).toEqual({});
    const mid = NOW.getTime() + 30_000; // inside a 2-minute slot, past its grace
    await fetchBars(["SPY"], KEYS, new Date(mid), f, "https://data.example");
    await fetchBars(["SPY"], KEYS, new Date(mid + BARS_CACHE_MS - 1), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(1);
    await fetchBars(["SPY"], KEYS, new Date(mid + BARS_CACHE_MS), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws on an HTTP error without caching it", async () => {
    const bad = vi.fn<typeof fetch>(async () => new Response("no", { status: 429 }));
    await expect(fetchBars(["SPY"], KEYS, NOW, bad, "https://data.example")).rejects.toThrow();
  });
});

describe("GET /api/bars", () => {
  const get = (q: string, cookie?: string) => handleBars(new Request(`https://lab.example/api/bars${q}`, cookie ? { headers: { cookie } } : {}), NOW);

  it("400 without symbols", async () => {
    expect((await get("")).status).toBe(400);
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
    expect(res.headers.get("cache-control")).toBe("no-store");
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

  it("429 when Alpaca rate-limits us, so the page waits its longest; any other failure stays 502", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream-secret-body", { status: 429 })));
    const res = await get("?s=SPY");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate-limited" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    resetBarsCache();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 503 })));
    expect((await get("?s=SPY")).status).toBe(502); // upstream's own 503 is a failure, not "not configured"
  });

  it("passes the half-day flag through, and refuses any other value", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 779), raw(210, 780)] } }), { status: 200 })));
    const late = (q: string) => handleBars(new Request(`https://lab.example/api/bars${q}`), new Date("2026-10-12T19:00:00Z"));
    expect((await (await late("?s=SPY&half=1")).json()).bars.SPY.map((b: Bar2) => b.c)).toEqual([779]);
    resetBarsCache();
    expect((await (await late("?s=SPY")).json()).bars.SPY.map((b: Bar2) => b.c)).toEqual([779, 780]);
    expect((await late("?s=SPY&half=yes")).status).toBe(400);
    expect((await late("?s=SPY&half=0")).status).toBe(400);
  });

  it("200 with bars when configured", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ bars: { SPY: [raw(0, 779)] } }), { status: 200 })));
    const res = await get("?s=SPY");
    expect(res.status).toBe(200);
    expect((await res.json()).bars.SPY[0].c).toBe(779);
  });

  it("fixture mode answers with no keys and no network, and follows the fx cookie", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const body = await (await get("?s=SPY,ZZZZ")).json();
    expect(body.fixture).toBe(true);
    expect(body.missing).toEqual(["ZZZZ"]);
    expect(body.bars.SPY).toHaveLength(45);
    expect(body.bars.SPY[0].o).toBe(778.55); // the close
    expect(f).not.toHaveBeenCalled();
    expect((await get("?s=SPY", "fx=quotes-off")).status).toBe(503);
    expect((await get("?s=SPY", "fx=quotes-error")).status).toBe(502);
    const scripted = await (await get("?s=QQQ,AAPL,MSFT", "fx=focus.quotes-script; fxstep=3")).json();
    expect(scripted.as_of).toBe(new Date(stepInstant("2026-10-12", 3)).toISOString());
    expect(scripted.bars.QQQ).toEqual(scriptBars("QQQ", "2026-10-12", 3));
    expect(scripted.missing).toEqual(["MSFT"]);
    // each name's fetch time is the step's instant: the bar forming then is not complete
    // the script's bars are final: they read as settled at the step's clock
    expect(scripted.fetchedAt).toEqual({ QQQ: stepInstant("2026-10-12", 3) + SERVER_SETTLE_MS, AAPL: stepInstant("2026-10-12", 3) + SERVER_SETTLE_MS });
  });
});

describe("the scripted quotes", () => {
  it("date the answer at the step, quote SMH below its VWAP, and follow the server's clock without a step", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    const q = (cookie: string, at = NOW) => handleQuote(new Request("https://lab.example/api/quote?s=QQQ,SMH,MSFT", { headers: { cookie } }), at);
    const body = await (await q("fx=focus.quotes-script; fxstep=3")).json();
    expect(body.as_of).toBe(new Date(stepInstant("2026-10-12", 3) + 3_000).toISOString());
    expect(body.quotes.QQQ.at).toBe(new Date(stepInstant("2026-10-12", 3)).toISOString());
    expect(body.quotes.SMH.price).toBeLessThan(body.quotes.SMH.vwap);
    expect(body.missing).toEqual(["MSFT"]);
    const a = await (await q("fx=quotes-script", new Date(0))).json();
    const b = await (await q("fx=quotes-script", new Date(6_000))).json();
    expect(a.as_of).not.toBe(b.as_of);
    expect((await q("fx=quotes-script.quotes-off; fxstep=3")).status).toBe(503);
  });
});

describe("the scripted bars", () => {
  it("run from 09:30 to the step, the last one still forming", () => {
    const b = scriptBars("SPY", "2026-10-12", 3);
    expect(b[0]!.start).toBe(OPEN);
    const at = stepInstant("2026-10-12", 3);
    expect(b[b.length - 1]!.start).toBeLessThanOrEqual(at);
    expect(b[b.length - 1]!.end).toBeGreaterThan(at);
    expect(b.length).toBe(Math.floor((SCRIPT_STEPS[3]! - (9 * 3600 + 30 * 60)) / 120) + 1);
    expect(scriptBars("MSFT", "2026-10-12", 3)).toEqual([]);
  });
});

const bar = (start: number, c: number, spread = 0.5): Bar2 => ({ start, end: start + 120_000, o: c, h: c + spread, l: c - spread, c });

describe("mergeBars", () => {
  const trail = (closed: Bar2[], partial: Bar2 | null, since: number | null, missing: number[] = []): Bars2m => ({
    closed,
    partial,
    since,
    complete: since !== null && since <= OPEN,
    missing,
    gaps: missing.length,
  });

  it("lets the server win every slot it has and the trail fill the rest", () => {
    const server = [bar(OPEN, 10), bar(OPEN + 120_000, 11)];
    const mine = trail([bar(OPEN + 120_000, 99), bar(OPEN + 240_000, 12)], bar(OPEN + 360_000, 13), OPEN + 130_000);
    const m = mergeBars(server, mine, DONE);
    expect(m.closed.map((b) => b.c)).toEqual([10, 11, 12]);
    expect(m.partial?.c).toBe(13);
    expect(m.since).toBe(OPEN);
    // every slot from the open is covered: no gap
    expect(m.missing).toEqual([]);
    expect(m.complete).toBe(true);
  });

  it("counts the slots no one has, between the bars and after them", () => {
    const server = [bar(OPEN, 10), bar(OPEN + 240_000, 12)];
    const m = mergeBars(server, trail([bar(OPEN + 360_000, 13)], null, OPEN + 360_000, [OPEN + 480_000]), DONE);
    expect(m.missing).toEqual([OPEN + 120_000, OPEN + 480_000]);
    expect(m.gaps).toBe(2);
    expect(m.since).toBe(OPEN);
    expect(mergeBars([bar(OPEN + 120_000, 1)], trail([], null, null), DONE).complete).toBe(false);
  });

  it("drops the trail's partial when the server already has that slot, and bad bars", () => {
    const server = [bar(OPEN, 10), { ...bar(OPEN + 120_000, 11), c: Number.NaN }];
    const m = mergeBars(server, trail([], bar(OPEN, 9), OPEN + 5_000), DONE);
    expect(m.closed.map((b) => b.c)).toEqual([10]);
    expect(m.partial).toBeNull();
  });

  it("fills a slot the server lacks inside its range from the trail's completed bar: no gap", () => {
    const at = (hhmm: string) => Date.parse(`2026-10-12T${hhmm}:00-04:00`);
    // IEX printed nothing in the 10:14 slot; the page saw prices in it
    const server = [bar(at("10:10"), 10), bar(at("10:12"), 11), bar(at("10:16"), 13)];
    const m = mergeBars(server, trail([bar(at("10:14"), 12)], null, at("10:14")), at("10:20"));
    expect(m.closed.map((b) => b.c)).toEqual([10, 11, 12, 13]);
    expect(m.missing).toEqual([]);
    expect(m.gaps).toBe(0);
  });

  it("waits SERVER_SETTLE_MS before an ended server bar may stand for its slot: the trail's close wins until then", () => {
    const at = (hhmm: string, sec = 0) => Date.parse(`2026-10-12T${hhmm}:${String(sec).padStart(2, "0")}-04:00`);
    // fetched 6 s after the 10:20 bar ended: upstream may not yet hold its last minute (c 752.95 is the first minute's)
    const server = [bar(at("10:18"), 752.8), { ...bar(at("10:20"), 752.95) }];
    const mine = trail([bar(at("10:20"), 752.7)], null, at("10:20"));
    const early = mergeBars(server, mine, at("10:22", 6));
    expect(early.closed.find((b) => b.start === at("10:20"))!.c).toBe(752.7);
    // without the page's bar for that slot it is missing (a gap), never the unsettled server close
    const none = mergeBars(server, trail([], null, null), at("10:22", 6));
    expect(none.closed.some((b) => b.start === at("10:20"))).toBe(false);
    expect(SERVER_SETTLE_MS).toBe(60_000);
    // a minute later the server's bar is settled and wins
    expect(mergeBars(server, mine, at("10:22") + SERVER_SETTLE_MS).closed.find((b) => b.start === at("10:20"))!.c).toBe(752.95);
  });

  it("never takes a server bar still forming at its fetch as closed: the trail's bar wins that slot", () => {
    const at = (hms: string) => Date.parse(`2026-10-12T${hms}-04:00`);
    const forming = { start: at("10:20:00"), end: at("10:22:00"), o: 752.0, h: 752.95, l: 751.9, c: 752.95 };
    const mine = trail([{ start: at("10:20:00"), end: at("10:22:00"), o: 752.1, h: 752.95, l: 752.0, c: 752.7 }], null, at("10:20:00"));
    const m = mergeBars([bar(at("10:18:00"), 752), forming], mine, at("10:21:45"));
    expect(m.closed.map((b) => b.c)).toEqual([752, 752.7]);
    // fetched 4 s after its end: still inside the grace, not complete either
    expect(mergeBars([forming], trail([], null, null), at("10:22:04")).closed).toEqual([]);
    // and no fetch time: no server bar at all
    expect(mergeBars([forming], mine, null)).toEqual(mine);
    // complete at its fetch: the server's wins
    expect(mergeBars([forming], mine, at("10:23:00")).closed.map((b) => b.c)).toEqual([752.95]); // settled: SERVER_SETTLE_MS after its end
  });

  it("is the trail alone without server bars, and the server alone without a trail", () => {
    const t = trail([bar(OPEN, 1)], bar(OPEN + 120_000, 2), OPEN + 1);
    expect(mergeBars([], t, DONE)).toEqual(t);
    expect(mergeBars([bar(OPEN, 1)], trail([], null, null), DONE)).toEqual({ closed: [bar(OPEN, 1)], partial: null, since: OPEN, complete: true, missing: [], gaps: 0 });
    expect(mergeBars([], trail([], null, null), DONE)).toEqual(trail([], null, null));
  });
});

describe("atr2m", () => {
  it("is the plain mean of the last n true ranges, as wt.options.regime.atr", () => {
    const closed = [bar(0, 10, 0.5), bar(1, 11, 0.5), bar(2, 10, 0.25), bar(3, 13, 0.5)];
    // true ranges against the bar before: max(1, |11.5-10|, |10.5-10|) = 1.5; max(0.5, |10.25-11|, |9.75-11|) = 1.25; max(1, |13.5-10|, |12.5-10|) = 3.5
    expect(atr2m(closed, 3)).toBeCloseTo((1.5 + 1.25 + 3.5) / 3, 10);
    expect(atr2m(closed, 2)).toBeCloseTo((1.25 + 3.5) / 2, 10);
    expect(atr2m(closed, 4)).toBeNull();
    expect(atr2m([], 14)).toBeNull();
  });
});
