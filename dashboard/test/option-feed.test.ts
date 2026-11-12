// The option chain's feed (ALPACA_OPTION_FEED, option-feed.ts): indicative by default, OPRA on the owner's setting
// (DEC-0050, point 6). A bad value takes the chain off rather than guessing; opra refused by the plan falls back to
// indicative, says so, and does not ask opra again for ten minutes; answers are never shared across feeds; and the
// page's freshness limits and words follow the feed, never reassuring on old quotes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_POLL_MS, CHAIN_RETRY_CAP_MS, chainFresh as pollFresh, chainPollMs, chainRetryCapMs, OPRA_POLL_MS } from "@/components/client/use-chain";
import { CHAIN_CACHE_MS, fetchChain, normaliseContract, OPRA_CACHE_MS, OPRA_RETRY_MS, resetChainCache, type ChainContract, type ChainResponse } from "@/lib/chain";
import { fixtureChain, FIXTURE_OPRA_AGE_MS, handleChain } from "@/lib/chain-route";
import {
  chainFeedWords,
  contractView,
  feedsWords,
  OPRA_STALE_LATER_MIN,
  OPRA_STALE_SAME_DAY_MIN,
  STALE_LATER_MIN,
  STALE_SAME_DAY_MIN,
  staleLimits,
  type Pick,
} from "@/lib/contract";
import { VARIANT_FLAGS } from "@/lib/fixture-variants";
import { configuredOptionFeed, DEFAULT_OPTION_FEED, OPTION_FEED_REFUSED, optionFeedSetting, resetOptionFeedWarning } from "@/lib/option-feed";
import type { OptionsTicker } from "@/lib/options";
import { anyOpra, chainAsks, quotes } from "@/lib/positions";
import { startPoll, type PollResult } from "@/lib/quote-poll";
import { chainFresh, chainStamp, contractQuoteTime } from "@/lib/what-if";

const NOW = new Date("2026-10-12T16:00:00Z"); // Monday, 12:00 in New York
const KEYS = { id: "test-key-id", secret: "test-key-secret" };
const BASE = "https://data.example";
const occ = (date: string, kind: "C" | "P", strike: number) => `SPY${date.slice(2).replace(/-/g, "")}${kind}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const snap = (q: Record<string, unknown> = {}) => ({
  latestQuote: { bp: 1, ap: 1.1, bs: 12, as: 30, t: "2026-10-12T15:59:58Z", ...q },
  latestTrade: { p: 1.05 },
  greeks: { delta: 0.5 },
  impliedVolatility: 0.14,
  dailyBar: { v: 1200 },
});
const body = (snapshots: Record<string, unknown>) => new Response(JSON.stringify({ snapshots, next_page_token: null }), { status: 200 });
const near = { [occ("2026-10-12", "C", 780)]: snap(), [occ("2026-10-12", "P", 780)]: snap({ bs: undefined, as: 2.5 }) };
const far = { [occ("2026-10-30", "C", 780)]: snap() };
/** Answers every feed; `refuse` lists the feeds that get a 403. */
const upstream = (refuse: string[] = []) =>
  vi.fn<typeof fetch>(async (input) => {
    const q = new URL(String(input)).searchParams;
    if (refuse.includes(q.get("feed") ?? "")) return new Response("upstream-secret-body", { status: 403 });
    return q.get("expiration_date_gte") === "2026-10-12" ? body(near) : body(far);
  });
const feeds = (f: ReturnType<typeof upstream>) => f.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("feed"));
const at = (ms: number) => new Date(NOW.getTime() + ms);
/** The option-feed log lines, parsed. */
const optionLines = () => logged.filter((l) => l.includes('"evt":"alpaca.option_feed"')).map((l) => JSON.parse(l) as Record<string, unknown>);

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  resetOptionFeedWarning();
  resetChainCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ALPACA_OPTION_FEED", () => {
  it("is indicative when unset, empty or only spaces", () => {
    expect(DEFAULT_OPTION_FEED).toBe("indicative");
    for (const env of [{}, { ALPACA_OPTION_FEED: "" }, { ALPACA_OPTION_FEED: "  " }]) expect(optionFeedSetting(env)).toEqual({ ok: true, feed: "indicative" });
  });

  it("takes opra or indicative, whatever the case and the surrounding spaces", () => {
    for (const v of ["opra", "OPRA", " Opra\n", "\topra "]) expect(optionFeedSetting({ ALPACA_OPTION_FEED: v })).toEqual({ ok: true, feed: "opra" });
    for (const v of ["indicative", "INDICATIVE", " Indicative\n"]) expect(optionFeedSetting({ ALPACA_OPTION_FEED: v })).toEqual({ ok: true, feed: "indicative" });
  });

  it("refuses anything else, keeping only the raw value's length", () => {
    for (const v of ["sip", "iex", "op ra", "opra,indicative", "opra1", "true", "delayed"]) expect(optionFeedSetting({ ALPACA_OPTION_FEED: v })).toEqual({ ok: false, length: v.length });
  });

  it("logs a refusal once per instance, with the length and never the value", () => {
    expect(configuredOptionFeed({ ALPACA_OPTION_FEED: "secretish-value" })).toBeNull();
    expect(configuredOptionFeed({ ALPACA_OPTION_FEED: "secretish-value" })).toBeNull();
    expect(configuredOptionFeed({ ALPACA_OPTION_FEED: "opra" })).toBe("opra");
    expect(logged).toHaveLength(1);
    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ evt: "alpaca.option_feed", outcome: "invalid", length: 15 });
    expect(logged[0]).not.toContain("secretish");
  });
});

describe("the chain on opra", () => {
  it("asks Alpaca's opra feed and answers with no delay", async () => {
    const f = upstream();
    const got = await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    expect(feeds(f)).toEqual(["opra", "opra"]);
    expect(got).toMatchObject({ feed: "opra", delay_min: 0, symbol: "SPY" });
    expect(got.fallback).toBeUndefined();
    for (const c of f.mock.calls) expect(String(c[0])).not.toContain("test-key");
  });

  it("parses the quote sizes, and leaves an absent or unusable one null", async () => {
    const got = await fetchChain("SPY", 780, KEYS, NOW, upstream(), BASE, null, "opra");
    const [call, put] = got.expiries[0]!.contracts;
    expect([call!.bid_size, call!.ask_size]).toEqual([12, 30]);
    expect([put!.bid_size, put!.ask_size]).toEqual([null, null]); // absent, and a fraction of a contract
    const sizes = (q: Record<string, unknown>) => {
      const c = normaliseContract("call", 780, { latestQuote: q });
      return [c.bid_size, c.ask_size];
    };
    expect(sizes({ bs: 0, as: 5 })).toEqual([0, 5]);
    expect(sizes({ bs: -1, as: "7" })).toEqual([null, null]);
    expect(sizes({ bs: Number.NaN, as: Infinity })).toEqual([null, null]);
    expect(sizes({})).toEqual([null, null]);
    expect(normaliseContract("call", 780, null)).toMatchObject({ bid_size: null, ask_size: null });
  });

  it("shares an opra answer for 5 s only, and indicative's for 20 s as before", async () => {
    expect(OPRA_CACHE_MS).toBe(5_000);
    expect(CHAIN_CACHE_MS).toBe(20_000);
    const f = upstream();
    await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    await fetchChain("SPY", 780, KEYS, at(OPRA_CACHE_MS - 1), f, BASE, null, "opra");
    expect(f).toHaveBeenCalledTimes(2);
    await fetchChain("SPY", 780, KEYS, at(OPRA_CACHE_MS), f, BASE, null, "opra");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("never serves one feed's answer for the other's", async () => {
    const f = upstream();
    const a = await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "indicative");
    const b = await fetchChain("SPY", 780, KEYS, at(1000), f, BASE, null, "opra");
    expect(feeds(f)).toEqual(["indicative", "indicative", "opra", "opra"]);
    expect([a.feed, b.feed]).toEqual(["indicative", "opra"]);
    // Each is then served from its own entry.
    expect((await fetchChain("SPY", 780, KEYS, at(2000), f, BASE, null, "indicative")).feed).toBe("indicative");
    expect((await fetchChain("SPY", 780, KEYS, at(2000), f, BASE, null, "opra")).feed).toBe("opra");
    expect(f).toHaveBeenCalledTimes(4);
  });
});

describe("opra refused by the plan (403)", () => {
  it("answers from indicative, labelled, and logs the refusal and the retry's outcome", async () => {
    const f = upstream(["opra"]);
    const got = await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    expect(got).toMatchObject({ feed: "indicative", delay_min: 15, fallback: "opra-refused" });
    expect(got.expiries.length).toBeGreaterThan(0);
    expect(feeds(f)).toEqual(["opra", "opra", "indicative", "indicative"]);
    const lines = optionLines();
    expect(lines.map((l) => [l.outcome, l.answer])).toEqual([
      ["plan", "retry-indicative"],
      ["fallback", "indicative"],
    ]);
    expect(logged.join("\n")).not.toContain("upstream-secret-body");
    expect(logged.join("\n")).not.toContain("test-key");
  });

  it("stays on indicative for ten minutes, then tries opra again", async () => {
    expect(OPRA_RETRY_MS).toBe(10 * 60_000);
    const f = upstream(["opra"]);
    await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    expect(f).toHaveBeenCalledTimes(4);
    // Past indicative's cache but inside the wait: indicative only, still labelled.
    const mid = await fetchChain("SPY", 780, KEYS, at(CHAIN_CACHE_MS + 1), f, BASE, null, "opra");
    expect(feeds(f).slice(4)).toEqual(["indicative", "indicative"]);
    expect(mid).toMatchObject({ feed: "indicative", delay_min: 15, fallback: "opra-refused" });
    const last = await fetchChain("SPY", 780, KEYS, at(OPRA_RETRY_MS - 1), f, BASE, null, "opra");
    expect(feeds(f).slice(6)).toEqual(["indicative", "indicative"]);
    expect(last.fallback).toBe("opra-refused");
    // Inside the wait nothing more is logged: no opra was asked for.
    expect(optionLines()).toHaveLength(2);
    // Ten minutes on, opra is asked for again; still refused, the same lapse logs only the retry's outcome.
    await fetchChain("SPY", 780, KEYS, at(OPRA_RETRY_MS), f, BASE, null, "opra");
    expect(feeds(f).slice(8, 10)).toEqual(["opra", "opra"]);
    expect(optionLines().map((l) => l.outcome)).toEqual(["plan", "fallback", "fallback"]);
  });

  it("logs the retry's failure as an error, with its status, when indicative fails too (a key problem)", async () => {
    await expect(fetchChain("SPY", 780, KEYS, NOW, upstream(["opra", "indicative"]), BASE, null, "opra")).rejects.toThrow("alpaca 403");
    expect(optionLines().map((l) => [l.outcome, l.answer, l.status])).toEqual([
      ["plan", "retry-indicative", 403],
      ["fallback", "error", 403],
    ]);
    expect(logged.join("\n")).not.toContain("upstream-secret-body");
  });

  it("logs a second lapse again once opra has answered in between", async () => {
    let refuse = ["opra"];
    const f = vi.fn<typeof fetch>(async (input) => upstream(refuse)(input));
    await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    refuse = [];
    await fetchChain("SPY", 780, KEYS, at(OPRA_RETRY_MS), f, BASE, null, "opra");
    refuse = ["opra"];
    await fetchChain("SPY", 780, KEYS, at(OPRA_RETRY_MS + OPRA_CACHE_MS), f, BASE, null, "opra");
    expect(optionLines().map((l) => l.outcome)).toEqual(["plan", "fallback", "plan", "fallback"]);
  });

  it("goes back to opra once the plan includes it again", async () => {
    let refuse = ["opra"];
    const f = vi.fn<typeof fetch>(async (input) => upstream(refuse)(input));
    await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    refuse = [];
    const got = await fetchChain("SPY", 780, KEYS, at(OPRA_RETRY_MS), f, BASE, null, "opra");
    expect(got).toMatchObject({ feed: "opra", delay_min: 0 });
    expect(got.fallback).toBeUndefined();
  });

  it("is only for opra and only for 403: every other failure throws as before", async () => {
    await expect(fetchChain("SPY", 780, KEYS, NOW, upstream(["indicative"]), BASE, null, "indicative")).rejects.toThrow("alpaca 403");
    for (const status of [401, 429, 500]) {
      resetChainCache();
      const f = vi.fn<typeof fetch>(async () => new Response("x", { status }));
      await expect(fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra")).rejects.toThrow(`alpaca ${status}`);
      expect(feeds(f as ReturnType<typeof upstream>).every((x) => x === "opra")).toBe(true);
    }
    // A 403 on both feeds: the indicative retry's failure is the answer.
    resetChainCache();
    await expect(fetchChain("SPY", 780, KEYS, NOW, upstream(["opra", "indicative"]), BASE, null, "opra")).rejects.toThrow("alpaca 403");
  });

  it("leaves indicative's answer exactly as before when indicative is the feed", async () => {
    const got = await fetchChain("SPY", 780, KEYS, NOW, upstream(), BASE);
    expect(Object.keys(got).sort()).toEqual(["as_of", "delay_min", "expiries", "feed", "served_at", "symbol"]);
    expect(got).toMatchObject({ feed: "indicative", delay_min: 15 });
  });
});

describe("GET /api/chain and the setting", () => {
  const get = (q: string, cookie = "") => handleChain(new Request(`https://lab.example/api/chain${q}`, { headers: cookie ? { cookie } : {} }), NOW);
  const live = () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
  };

  it("answers 503 not-configured, why feed, on a refused value, and never calls out", async () => {
    live();
    vi.stubEnv("ALPACA_OPTION_FEED", "sip");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await get("?s=SPY&px=780");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(OPTION_FEED_REFUSED);
    expect(OPTION_FEED_REFUSED).toEqual({ error: "not-configured", why: "feed" });
    expect(f).not.toHaveBeenCalled();
    expect(logged.some((l) => l.includes('"length":3'))).toBe(true);
  });

  it("asks the configured feed upstream", async () => {
    live();
    vi.stubEnv("ALPACA_OPTION_FEED", " OPRA ");
    const f = upstream();
    vi.stubGlobal("fetch", f);
    const res = await get("?s=SPY&px=780");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ feed: "opra", delay_min: 0 });
    expect(feeds(f)).toEqual(["opra", "opra"]);
  });

  it("asks indicative when the setting is unset", async () => {
    live();
    vi.stubEnv("ALPACA_OPTION_FEED", "");
    const f = upstream();
    vi.stubGlobal("fetch", f);
    expect(await (await get("?s=SPY&px=780")).json()).toMatchObject({ feed: "indicative", delay_min: 15 });
    expect(feeds(f)).toEqual(["indicative", "indicative"]);
  });

  it("in fixture mode ignores the setting, and answers as opra under the chain-opra flag", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ALPACA_OPTION_FEED", "nonsense");
    expect(VARIANT_FLAGS).toContain("chain-opra");
    const plain = (await (await get("?s=SPY&px=780")).json()) as ChainResponse;
    expect(plain).toMatchObject({ feed: "indicative", delay_min: 15 });
    const opra = (await (await get("?s=SPY&px=780", "fx=chain-opra")).json()) as ChainResponse;
    expect(opra).toMatchObject({ feed: "opra", delay_min: 0, fixture: true });
    expect(opra.expiries.length).toBeGreaterThan(0);
  });
});

describe("the fixture chain", () => {
  it("carries quote sizes, and on opra quotes a few seconds old", async () => {
    const ind = await fixtureChain("SPY", NOW);
    const opra = await fixtureChain("SPY", NOW, false, null, "opra");
    expect(opra).toMatchObject({ feed: "opra", delay_min: 0 });
    for (const x of [...ind.expiries, ...opra.expiries])
      for (const c of x.contracts) {
        expect(Number.isInteger(c.bid_size) && c.bid_size! >= 0).toBe(true);
        expect(Number.isInteger(c.ask_size) && c.ask_size! >= 0).toBe(true);
      }
    for (const x of opra.expiries) for (const c of x.contracts) expect(c.at).toBe(new Date(NOW.getTime() - FIXTURE_OPRA_AGE_MS).toISOString());
    expect(FIXTURE_OPRA_AGE_MS).toBeLessThan(OPRA_STALE_SAME_DAY_MIN * 60_000);
  });
});

// ---- freshness and words, on the page's side --------------------------------------------------------------------
const QUOTED = "2026-10-12T15:00:00Z";
const row = (over: Partial<ChainContract> = {}): ChainContract => ({
  kind: "call", strike: 780, bid: 2.95, ask: 3.1, last: 3.0, at: QUOTED, iv: 0.12, delta: 0.5, volume: 100, bid_size: 10, ask_size: 10, ...over,
});
const chainOf = (feed: ChainResponse["feed"], date: string, as_of = QUOTED, extra: Partial<ChainResponse> = {}): ChainResponse => ({
  as_of, feed, delay_min: feed === "opra" ? 0 : 15, symbol: "SPY", expiries: [{ date, contracts: [row()] }], ...extra,
});

describe("feed-aware limits", () => {
  it("keeps indicative's 35 and 105 minutes, and holds opra (and anything unknown) to 2 and 5", () => {
    expect([STALE_SAME_DAY_MIN, STALE_LATER_MIN]).toEqual([35, 105]);
    expect([OPRA_STALE_SAME_DAY_MIN, OPRA_STALE_LATER_MIN]).toEqual([2, 5]);
    expect(staleLimits("indicative")).toEqual({ sameDay: 35, later: 105 });
    expect(staleLimits("opra")).toEqual({ sameDay: 2, later: 5 });
    expect(staleLimits(undefined)).toEqual({ sameDay: 2, later: 5 });
    expect(staleLimits("sip" as unknown as ChainResponse["feed"])).toEqual({ sameDay: 2, later: 5 });
  });

  it("what-if's chainFresh: opra stands to 2 minutes exactly, indicative to 35", () => {
    const opra = chainOf("opra", "2026-10-12");
    // The newest quote is at as_of, so the age is the time since receipt.
    expect(chainFresh(opra, 0, OPRA_STALE_SAME_DAY_MIN * 60_000)).toBe(true);
    expect(chainFresh(opra, 0, OPRA_STALE_SAME_DAY_MIN * 60_000 + 1)).toBe(false);
    const ind = chainOf("indicative", "2026-10-12");
    expect(chainFresh(ind, 0, STALE_SAME_DAY_MIN * 60_000)).toBe(true);
    expect(chainFresh(ind, 0, STALE_SAME_DAY_MIN * 60_000 + 1)).toBe(false);
    // A fallback answer is indicative's: indicative's limits.
    expect(chainFresh(chainOf("indicative", "2026-10-12", QUOTED, { fallback: "opra-refused" }), 0, 30 * 60_000)).toBe(true);
  });

  const spy = { symbol: "SPY", last: { close: 780 }, expected_move: { day: 8, annual_iv: 0.15 }, half_day: false } as unknown as OptionsTicker;
  const view = (feed: ChainResponse["feed"], expiry: string, ageMin: number) => {
    const pick: Pick = { kind: "call", expiry, strike: 780, contracts: 1, paid: null };
    const now = Date.parse(QUOTED) + ageMin * 60_000;
    return contractView(pick, chainOf(feed, expiry), spy, 780, now, "2026-10-12", { marketOpen: true, priceIsLive: true });
  };

  it("contractView withholds an opra same-day contract past 2 minutes and a later one past 5", () => {
    expect(view("opra", "2026-10-12", OPRA_STALE_SAME_DAY_MIN).stale).toBe(false);
    expect(view("opra", "2026-10-12", OPRA_STALE_SAME_DAY_MIN + 0.01).stale).toBe(true);
    expect(view("opra", "2026-10-12", OPRA_STALE_SAME_DAY_MIN + 0.01).rows).toEqual([]);
    expect(view("opra", "2026-10-16", OPRA_STALE_LATER_MIN).stale).toBe(false);
    expect(view("opra", "2026-10-16", OPRA_STALE_LATER_MIN + 0.01).stale).toBe(true);
  });

  it("contractView keeps indicative's limits exactly", () => {
    expect(view("indicative", "2026-10-12", STALE_SAME_DAY_MIN).stale).toBe(false);
    expect(view("indicative", "2026-10-12", STALE_SAME_DAY_MIN + 0.01).stale).toBe(true);
    expect(view("indicative", "2026-10-16", STALE_LATER_MIN).stale).toBe(false);
    expect(view("indicative", "2026-10-16", STALE_LATER_MIN + 0.01).stale).toBe(true);
  });
});

describe("the words", () => {
  const as_of = "2026-10-12T14:14:00Z"; // 10:14 in New York
  it("stamps each feed plainly", () => {
    expect(chainStamp(chainOf("indicative", "2026-10-12", as_of))).toBe("Option chain 10:14 NY · 15 min behind");
    expect(chainStamp(chainOf("opra", "2026-10-12", as_of))).toBe("Option chain 10:14 NY · OPRA (real-time feed)");
    for (const feed of ["opra", "indicative"] as const) expect(chainStamp(chainOf(feed, "2026-10-12", as_of))).not.toMatch(/\blive\b|real time/);
    expect(chainStamp(chainOf("indicative", "2026-10-12", as_of, { fallback: "opra-refused" }))).toBe("Option chain 10:14 NY · 15 min behind (OPRA refused)");
  });

  it("says where the contract pane's quotes come from", () => {
    expect(chainFeedWords(chainOf("indicative", "2026-10-12"))).toBe("Option quotes run 15 minutes behind the market");
    expect(chainFeedWords(chainOf("opra", "2026-10-12"))).toBe("Option quotes: OPRA, real time");
    expect(chainFeedWords(chainOf("indicative", "2026-10-12", QUOTED, { fallback: "opra-refused" }))).toBe("Option quotes run 15 minutes behind the market (OPRA refused)");
  });
});

describe("how often the page asks", () => {
  it("every 10 s while the last good answer is opra's, every 30 s otherwise", () => {
    expect(OPRA_POLL_MS).toBe(10_000);
    expect(chainPollMs("opra")).toBe(10_000);
    expect(chainPollMs("indicative")).toBe(CHAIN_POLL_MS);
    expect(chainPollMs(null)).toBe(CHAIN_POLL_MS);
    expect(chainPollMs(undefined)).toBe(CHAIN_POLL_MS);
  });

  it("the fresh-on-re-show window follows the same interval", () => {
    expect(pollFresh(1_000, 1_000 + OPRA_POLL_MS - 1, OPRA_POLL_MS)).toBe(true);
    expect(pollFresh(1_000, 1_000 + OPRA_POLL_MS, OPRA_POLL_MS)).toBe(false);
    expect(pollFresh(1_000, 1_000 + CHAIN_POLL_MS - 1)).toBe(true);
  });

  it("the poll reads its interval afresh after each answer", async () => {
    vi.useFakeTimers();
    try {
      const page = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
      let every = CHAIN_POLL_MS;
      const sent: number[] = [];
      const t0 = Date.now();
      const p = startPoll({
        run: async (): Promise<PollResult> => {
          sent.push(Date.now() - t0);
          every = OPRA_POLL_MS; // the answer was opra's
          return "ok";
        },
        page,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        pollMs: () => every,
        backoff: { capMs: CHAIN_POLL_MS, rand: () => 0 },
      });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sent).toEqual([0, 10_000, 20_000]);
      every = CHAIN_POLL_MS;
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- review fixes: the browser clock, many names, one contract's time, the retry cap ---------------------------
describe("the quotes' age is not read off the browser clock", () => {
  const spy = { symbol: "SPY", last: { close: 780 }, expected_move: { day: 8, annual_iv: 0.15 }, half_day: false } as unknown as OptionsTicker;
  const pick: Pick = { kind: "call", expiry: "2026-10-12", strike: 780, contracts: 1, paid: null };
  // The server answered at 15:00 with quotes a minute old; the answer arrived 3 minutes ago (monotonic clock), so
  // the quotes are 4 minutes old. The browser's wall clock runs 3 minutes slow, so it reads 15:00 now.
  const asOf = "2026-10-12T15:00:00Z";
  const opra: ChainResponse = { as_of: asOf, feed: "opra", delay_min: 0, symbol: "SPY", expiries: [{ date: "2026-10-12", contracts: [row({ at: "2026-10-12T14:59:00Z" })] }] };
  const slowWall = Date.parse(asOf);
  const receipt = { receivedPerf: 10_000, perfNow: 10_000 + 3 * 60_000 };

  it("a 4-minute-old opra chain is stale with a browser clock 3 minutes slow", () => {
    const v = contractView(pick, opra, spy, 780, slowWall, "2026-10-12", { marketOpen: true, priceIsLive: true, ...receipt });
    expect(v.ageMin).toBeCloseTo(4, 6);
    expect(v.stale).toBe(true);
    expect(v.rows).toEqual([]);
  });

  it("without a receipt, never younger than the quotes were when answered", () => {
    const behind = contractView(pick, opra, spy, 780, slowWall - 5 * 60_000, "2026-10-12", { marketOpen: true, priceIsLive: true });
    expect(behind.ageMin).toBe(1);
  });

  it("feeds the positions' greeks the same way", async () => {
    const { positionGreeks } = await import("@/lib/positions");
    const r = { contract: "SPY261012C00780000", symbol: "SPY", kind: "call", strike: 780, expiry: "2026-10-12", qty: 1, onDesk: true, expired: false, days: 0, price: 3, avgPrice: 3, unrealized: 0 } as unknown as Parameters<typeof positionGreeks>[0];
    expect(positionGreeks(r, opra, spy, 780, slowWall, "2026-10-12", { marketOpen: true, priceIsLive: true, ...receipt })).toBeNull();
    expect(positionGreeks(r, opra, spy, 780, slowWall, "2026-10-12", { marketOpen: true, priceIsLive: true, receivedPerf: 10_000, perfNow: 10_000 })).not.toBeNull();
  });
});

describe("words for a list of names (costs, positions)", () => {
  const as_of = "2026-10-12T14:14:00Z";
  const read = (feed: ChainResponse["feed"], ageMin: number | null, extra: Partial<ChainResponse> = {}) => ({ chain: chainOf(feed, "2026-10-12", as_of, extra), ageMin });
  it("never says real time, names the read time on opra, and says mixed feeds when the names differ", () => {
    expect(feedsWords([])).toBe("Option quotes run 15 minutes behind the market");
    expect(feedsWords([read("indicative", 15)])).toBe("Option quotes run 15 minutes behind the market");
    expect(feedsWords([read("indicative", 15, { fallback: "opra-refused" })])).toBe("Option quotes run 15 minutes behind the market (OPRA refused)");
    expect(feedsWords([read("opra", 0.1), read("opra", 0.2)])).toBe("OPRA feed, read at 10:14 NY");
    expect(feedsWords([read("opra", 0.1), read("opra", OPRA_STALE_SAME_DAY_MIN + 0.1)])).toBe("OPRA feed, read at 10:14 NY, too old to use");
    expect(feedsWords([read("opra", null)])).toBe("OPRA feed, read at 10:14 NY, too old to use");
    expect(feedsWords([read("opra", 0.1), read("indicative", 15, { fallback: "opra-refused" })])).toBe(
      "Option quotes from mixed feeds: OPRA on some names, 15 minutes behind on the others",
    );
    for (const w of [feedsWords([read("opra", 0.1)]), feedsWords([read("opra", 0.1), read("indicative", 15)])]) expect(w).not.toMatch(/real time|\blive\b/i);
  });

  it("the contract pane drops real time on an opra answer past its limit", () => {
    expect(chainFeedWords(chainOf("opra", "2026-10-12", as_of), true)).toBe("Option quotes: OPRA feed, read at 10:14 NY");
    expect(chainFeedWords(chainOf("opra", "2026-10-12", as_of), false)).toBe("Option quotes: OPRA, real time");
  });

  it("the Brief's costs are old past 30 minutes on indicative, and past opra's own limit on any opra answer", async () => {
    const { costsOld, COSTS_OLD_MIN } = await import("@/components/client/options-costs");
    const ind = { chain: chainOf("indicative", "2026-10-12"), receivedPerf: 0 };
    const opra = { chain: chainOf("opra", "2026-10-12"), receivedPerf: 0 };
    expect(costsOld([ind], COSTS_OLD_MIN, 0)).toBe(false);
    expect(costsOld([ind], COSTS_OLD_MIN + 0.01, 0)).toBe(true);
    expect(costsOld([opra], 1, OPRA_STALE_SAME_DAY_MIN * 60_000)).toBe(false);
    expect(costsOld([opra], 1, OPRA_STALE_SAME_DAY_MIN * 60_000 + 1)).toBe(true);
    expect(costsOld([ind, opra], 1, OPRA_STALE_SAME_DAY_MIN * 60_000 + 1)).toBe(true);
    expect(costsOld([opra], null, null)).toBe(true); // its age cannot be read
  });
});

describe("one contract's own quote time", () => {
  it("is named when the feed gave one, and left out when it did not", () => {
    expect(contractQuoteTime(row({ at: "2026-10-12T14:13:00Z" }))).toBe("Contract quote 10:13 NY");
    expect(contractQuoteTime(row({ at: null }))).toBeNull();
    expect(contractQuoteTime(row({ at: "junk" }))).toBeNull();
    expect(contractQuoteTime(null)).toBeNull();
  });
});

describe("the retry cap follows the interval", () => {
  it("is 10 s on opra and 30 s on indicative", () => {
    expect(chainRetryCapMs(OPRA_POLL_MS)).toBe(10_000);
    expect(chainRetryCapMs(CHAIN_POLL_MS)).toBe(30_000);
  });

  it("the poll reads its backoff afresh at each failure", async () => {
    vi.useFakeTimers();
    try {
      const page = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
      const sent: number[] = [];
      const t0 = Date.now();
      const p = startPoll({
        run: async (): Promise<PollResult> => {
          sent.push(Date.now() - t0);
          return "limited"; // a rate limit waits the cap
        },
        page,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        pollMs: OPRA_POLL_MS,
        backoff: () => ({ capMs: chainRetryCapMs(OPRA_POLL_MS), rand: () => 0 }),
      });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sent).toEqual([0, 10_000, 20_000]);
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- second review: one request a name, rate limits, the cache's lag ---------------------------------------------
describe("the positions ask once a name a round", () => {
  type Row = Parameters<typeof chainAsks>[0][number];
  const pos = (symbol: string, strike: number, days = 0): Row =>
    ({ contract: `${symbol}261012C${String(strike * 1000).padStart(8, "0")}`, symbol, kind: "call", strike, expiry: "2026-10-12", days, qty: 1, onDesk: true, expired: false, avgPrice: 1, price: 1, unrealized: 0 }) as Row;
  const rows = [pos("SPY", 780), pos("SPY", 785), pos("SPY", 790), pos("QQQ", 600), pos("QQQ", 605)];
  const opraAnswer = (servedAgoMin: number): ChainResponse => ({
    as_of: "2026-10-12T15:00:00Z", served_at: "2026-10-12T15:00:00Z", feed: "opra", delay_min: 0, symbol: "SPY",
    expiries: [{ date: "2026-10-12", contracts: [row({ at: new Date(Date.parse("2026-10-12T15:00:00Z") - servedAgoMin * 60_000).toISOString() })] }],
  });

  it("asks at most one request per distinct name, every name on a document's first round", () => {
    const first = chainAsks(rows, {}, 0, OPRA_POLL_MS, true);
    expect(first.map((a) => a.symbol).sort()).toEqual(["QQQ", "SPY"]);
    expect(first.length).toBeLessThanOrEqual(new Set(rows.map((r) => r.symbol)).size);
  });

  it("later, asks only the names whose opra quotes would pass their limit before the next turn", () => {
    const fresh = { chain: opraAnswer(0), receivedPerf: 0 };
    const held = Object.fromEntries(rows.map((r) => [r.contract, fresh]));
    // 1:40 after receipt plus 10 s: still under 2 minutes.
    expect(chainAsks(rows, held, 100_000, OPRA_POLL_MS, false)).toEqual([]);
    // 1:51 after receipt: the next turn would find it past 2 minutes, so both names are asked again, once each.
    const due = chainAsks(rows, held, 111_000, OPRA_POLL_MS, false);
    expect(due.map((a) => a.symbol).sort()).toEqual(["QQQ", "SPY"]);
    // Indicative answers stand for the document.
    const ind = { chain: { ...opraAnswer(0), feed: "indicative" as const, delay_min: 15 }, receivedPerf: 0 };
    expect(chainAsks(rows, Object.fromEntries(rows.map((r) => [r.contract, ind])), 10 * 60_000, OPRA_POLL_MS, false)).toEqual([]);
    expect(anyOpra(held)).toBe(true);
    expect(anyOpra({ x: ind })).toBe(false);
  });

  it("carries the name's position whose quote is missing, else the oldest, so every contract is quoted in turn", () => {
    const old = { chain: opraAnswer(0), receivedPerf: 0 };
    const newer = { chain: opraAnswer(0), receivedPerf: 5_000 };
    const [a, b, c] = rows;
    expect(chainAsks(rows, { [a!.contract]: newer, [b!.contract]: old }, 0, OPRA_POLL_MS, true).find((x) => x.symbol === "SPY")!.keep).toBe(c);
    expect(chainAsks(rows, { [a!.contract]: newer, [b!.contract]: old, [c!.contract]: newer }, 0, OPRA_POLL_MS, true).find((x) => x.symbol === "SPY")!.keep).toBe(b);
    expect(quotes(opraAnswer(0), pos("SPY", 780))).toBe(true);
    expect(quotes(opraAnswer(0), pos("SPY", 785))).toBe(false);
  });
});

describe("a rate limit waits the full 30 s, even on opra", () => {
  it("keeps CHAIN_RETRY_CAP_MS for a 429 while other failures cap at 10 s", async () => {
    vi.useFakeTimers();
    try {
      const page = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
      const sent: number[] = [];
      const t0 = Date.now();
      const p = startPoll({
        run: async (): Promise<PollResult> => {
          sent.push(Date.now() - t0);
          return "limited";
        },
        page,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        pollMs: OPRA_POLL_MS,
        backoff: () => ({ capMs: chainRetryCapMs(OPRA_POLL_MS), rand: () => 0 }),
        limitedCapMs: CHAIN_RETRY_CAP_MS,
      });
      await vi.advanceTimersByTimeAsync(65_000);
      expect(sent).toEqual([0, 30_000, 60_000]);
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the cache's lag is counted", () => {
  it("a quote 1:58 old at fetch, served 5 s later from the cache, reads stale", async () => {
    const quoted = new Date(NOW.getTime() - 118_000).toISOString();
    const f = vi.fn<typeof fetch>(async () => body({ [occ("2026-10-12", "C", 780)]: snap({ t: quoted }) }));
    await fetchChain("SPY", 780, KEYS, NOW, f, BASE, null, "opra");
    const hit = await fetchChain("SPY", 780, KEYS, at(OPRA_CACHE_MS - 1), f, BASE, null, "opra");
    expect(f).toHaveBeenCalledTimes(2); // the second came from the cache
    expect(hit.as_of).toBe(NOW.toISOString());
    expect(hit.served_at).toBe(at(OPRA_CACHE_MS - 1).toISOString());
    // Received just now: the age is the quote's age at serving, past 2 minutes.
    expect(chainFresh(hit, 0, 0)).toBe(false);
    expect(chainFresh({ ...hit, served_at: undefined }, 0, 0)).toBe(true); // without served_at the lag was missed
  });
});
