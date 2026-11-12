import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPRA_RETRY_MS } from "@/lib/chain";
import { fixtureChain } from "@/lib/chain-route";
import {
  CONTRACT_CACHE_MS,
  fetchContracts,
  fixtureContracts,
  fixtureStampClock,
  handleContract,
  normaliseContractQuote,
  parseContractSymbols,
  resetContractCache,
} from "@/lib/contract-quote";
import { resetOptionFeedWarning } from "@/lib/option-feed";
import { FROZEN_NOW, fixtureOptionLot } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, stepInstant } from "@/lib/fixture-script";
import { chainMatches, judgeQuote, MAX_CONTRACT_SYMBOLS, occSymbol } from "@/lib/option-value";
import edition from "./fixtures/options.v1.json";
import type { OptionsEdition } from "@/lib/options.types";

// GET /api/contract (contract-quote.ts): strict OCC symbols or 400, the option feed read and refused as the chain's,
// one upstream call per refresh shared for 2 s, opra refused by the plan answered from indicative and labelled, and
// the fixture bent by the chain's own flags.

const NOW = new Date("2026-10-12T16:00:00Z");
const KEYS = { id: "test-key-id", secret: "test-key-secret" };
const BASE = "https://data.example";
const A = "SPY261016C00660000";
const B = "SPY261016P00650000";
const snap = (bp: unknown = 1.2, ap: unknown = 1.25) => ({ latestQuote: { bp, ap, bs: 10, as: 12, t: "2026-10-12T15:59:58.1234Z" }, latestTrade: { p: 1.22, t: "2026-10-12T15:59:50Z" }, greeks: { delta: 0.5 } });

/** Answers every feed; `refuse` lists the feeds that get a 403. Records each URL asked. */
function upstream(refuse: string[] = [], body: (symbols: string[]) => unknown = (s) => ({ snapshots: Object.fromEntries(s.map((x) => [x, snap()])) })) {
  return vi.fn(async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    if (refuse.includes(q.get("feed") ?? "")) return new Response("upstream-secret-body", { status: 403 });
    return Response.json(body((q.get("symbols") ?? "").split(",")));
  });
}
const urls = (f: ReturnType<typeof upstream>) => f.mock.calls.map((c) => new URL(String(c[0])));
const at = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  resetContractCache();
  resetOptionFeedWarning();
});
afterEach(() => vi.unstubAllGlobals());

describe("what the route is asked for", () => {
  it("takes 1 to 20 OCC symbols, repeats dropped", () => {
    expect(parseContractSymbols(A)).toEqual([A]);
    expect(parseContractSymbols(`${A},${B},${A}`)).toEqual([A, B]);
    const twenty = Array.from({ length: MAX_CONTRACT_SYMBOLS }, (_, i) => occSymbol("SPY", "2026-10-16", "call", 600 + i)!);
    expect(parseContractSymbols(twenty.join(","))).toEqual(twenty);
  });

  it("refuses the whole request for anything else", () => {
    const many = Array.from({ length: MAX_CONTRACT_SYMBOLS + 1 }, (_, i) => occSymbol("SPY", "2026-10-16", "call", 600 + i)!);
    for (const bad of [null, "", many.join(","), `${A},`, `${A},SPY`, "SPY", "spy261016c00660000", `${A};DROP`, ` ${A}`, "SPY1261016C00660000", "SPY260231C00660000"])
      expect(parseContractSymbols(bad), String(bad).slice(0, 40)).toBeNull();
  });
});

describe("normalising a contract's snapshot", () => {
  it("keeps the quote's sides, sizes and time, and the last trade", () => {
    expect(normaliseContractQuote(snap())).toEqual({
      bid: 1.2,
      ask: 1.25,
      bid_size: 10,
      ask_size: 12,
      quote_at: "2026-10-12T15:59:58.123Z",
      last: 1.22,
      last_at: "2026-10-12T15:59:50.000Z",
    });
  });

  it("keeps a zero bid, drops what cannot be read, and is nothing without a quote or a trade", () => {
    expect(normaliseContractQuote(snap(0, 0.05))).toMatchObject({ bid: 0, ask: 0.05 });
    expect(normaliseContractQuote({ latestQuote: { bp: "1", ap: -1, bs: 1.5, t: "soon" }, latestTrade: { p: 0 } })).toBeNull();
    expect(normaliseContractQuote({ latestQuote: { bp: "1", ap: 1.1, bs: 1.5, t: "soon" } })).toEqual({ bid: null, ask: 1.1, bid_size: null, ask_size: null, quote_at: null, last: null, last_at: null });
    expect(normaliseContractQuote(null)).toBeNull();
    expect(normaliseContractQuote({})).toBeNull();
  });
});

describe("fetching contracts", () => {
  it("asks the option snapshots once for every due contract, naming its feed", async () => {
    const f = upstream();
    const got = await fetchContracts([A, B], KEYS, NOW, f, BASE, "opra");
    expect(f).toHaveBeenCalledTimes(1);
    const u = urls(f)[0]!;
    expect(u.pathname).toBe("/v1beta1/options/snapshots");
    expect(u.searchParams.get("feed")).toBe("opra");
    expect(u.searchParams.get("symbols")).toBe(`${A},${B}`);
    expect(got).toMatchObject({ feed: "opra", delay_min: 0, missing: [], as_of: NOW.toISOString(), served_at: NOW.toISOString() });
    expect(Object.keys(got.contracts)).toEqual([A, B]);
    // the keys travel in headers, never in the address
    expect(String(f.mock.calls[0]![0])).not.toContain("test-key");
  });

  it("names a contract Alpaca had nothing for as missing", async () => {
    const f = upstream([], () => ({ snapshots: { [A]: snap() } }));
    const got = await fetchContracts([A, B], KEYS, NOW, f, BASE, "opra");
    expect(got.missing).toEqual([B]);
    expect(Object.keys(got.contracts)).toEqual([A]);
  });

  it("shares each contract's answer for 2 s, asking only for the ones past their time", async () => {
    const f = upstream();
    await fetchContracts([A], KEYS, NOW, f, BASE, "opra");
    const cached = await fetchContracts([A, B], KEYS, at(CONTRACT_CACHE_MS - 1), f, BASE, "opra");
    expect(urls(f).map((u) => u.searchParams.get("symbols"))).toEqual([A, B]);
    // the oldest fetch among the answered names is the answer's as_of; served_at is now
    expect(cached).toMatchObject({ as_of: NOW.toISOString(), served_at: at(CONTRACT_CACHE_MS - 1).toISOString() });
    await fetchContracts([A, B], KEYS, at(CONTRACT_CACHE_MS), f, BASE, "opra");
    expect(urls(f).map((u) => u.searchParams.get("symbols"))).toEqual([A, B, A]);
    // a clock that stepped back does not trust the cache
    await fetchContracts([A], KEYS, at(-1), f, BASE, "opra");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("never serves one feed's answer for another's", async () => {
    const f = upstream();
    await fetchContracts([A], KEYS, NOW, f, BASE, "indicative");
    const b = await fetchContracts([A], KEYS, at(10), f, BASE, "opra");
    expect(urls(f).map((u) => u.searchParams.get("feed"))).toEqual(["indicative", "opra"]);
    expect(b.feed).toBe("opra");
  });

  it("answers from indicative when the plan refuses opra, says so, and waits ten minutes before opra again", async () => {
    const f = upstream(["opra"]);
    const got = await fetchContracts([A], KEYS, NOW, f, BASE, "opra");
    expect(got).toMatchObject({ feed: "indicative", delay_min: 15, fallback: "opra-refused" });
    expect(urls(f).map((u) => u.searchParams.get("feed"))).toEqual(["opra", "indicative"]);
    await fetchContracts([A], KEYS, at(CONTRACT_CACHE_MS), f, BASE, "opra");
    expect(urls(f).map((u) => u.searchParams.get("feed"))).toEqual(["opra", "indicative", "indicative"]);
    await fetchContracts([A], KEYS, at(OPRA_RETRY_MS), f, BASE, "opra");
    expect(urls(f).map((u) => u.searchParams.get("feed")).slice(-2)).toEqual(["opra", "indicative"]);
  });

  it("throws on any other failure and caches nothing from it", async () => {
    const bad = vi.fn(async () => new Response("upstream-secret-body", { status: 500 }));
    await expect(fetchContracts([A], KEYS, NOW, bad, BASE, "opra")).rejects.toThrow("alpaca 500");
    const f = upstream();
    await fetchContracts([A], KEYS, at(1), f, BASE, "opra");
    expect(f).toHaveBeenCalledTimes(1);
    // a 403 on indicative is not a plan refusal of opra
    await expect(fetchContracts([B], KEYS, NOW, upstream(["indicative"]), BASE, "indicative")).rejects.toThrow("alpaca 403");
  });
});

describe("the fixture's contracts", () => {
  it("quote what the fixture chain quotes, on the feed asked for", async () => {
    const c = await fixtureChain("SPY", NOW, false, null, "opra");
    const x = c.expiries[0]!;
    const k = x.contracts.find((y) => y.kind === "call")!;
    const occ = occSymbol("SPY", x.date, "call", k.strike)!;
    const got = await fixtureContracts([occ], NOW, false, "opra");
    expect(got).toMatchObject({ feed: "opra", delay_min: 0, fixture: true, missing: [] });
    expect(got.contracts[occ]).toEqual({ bid: k.bid, ask: k.ask, bid_size: k.bid_size, ask_size: k.ask_size, quote_at: k.at, last: k.last, last_at: k.last !== null ? k.at : null });
    expect((await fixtureContracts([occ], NOW, false, "indicative")).feed).toBe("indicative");
  });

  it("prices as the chain does on the server's clock, and stamps its times on the board's clock", async () => {
    const stamp = new Date("2026-10-12T14:28:33Z");
    const c = await fixtureChain("SPY", NOW, false, null, "opra");
    const k = c.expiries[0]!.contracts[0]!;
    const occ = occSymbol("SPY", c.expiries[0]!.date, k.kind, k.strike)!;
    const got = await fixtureContracts([occ], NOW, false, "opra", stamp);
    expect(got).toMatchObject({ as_of: stamp.toISOString(), served_at: stamp.toISOString() });
    expect(got.contracts[occ]).toMatchObject({ bid: k.bid, ask: k.ask, quote_at: "2026-10-12T14:28:30.000Z" });
  });

  it("keeps the board's clock: the scripted step with quotes-script, the stood-still instant with frozen, else the server's", async () => {
    const e = edition as unknown as OptionsEdition;
    expect((await fixtureStampClock(new Set(["quotes-script"]), "fxstep=3", NOW)).getTime()).toBe(stepInstant(e.session, 3) + SCRIPT_ANSWER_LAG_MS);
    expect((await fixtureStampClock(new Set(["frozen", "quotes-script"]), "fxstep=2", NOW)).getTime()).toBe(stepInstant(e.session, 2) + SCRIPT_ANSWER_LAG_MS);
    expect((await fixtureStampClock(new Set(["frozen"]), null, NOW)).toISOString()).toBe(new Date(FROZEN_NOW).toISOString());
    expect(await fixtureStampClock(new Set(), null, NOW)).toEqual(NOW);
  });

  it("journal-option-lot: one contract listed once in the fixture chain, and quoted live under chain-opra at the scripted step", async () => {
    const e = edition as unknown as OptionsEdition;
    const lot = fixtureOptionLot(e, NOW, stepInstant(e.session, 2))!;
    expect(lot).toMatchObject({ symbol: "QQQ", kind: "call", side: "long", qty: 2, entry: 1.2, expiry: "2026-11-02" });
    const chain = await fixtureChain("QQQ", NOW, false, { expiry: lot.expiry!, strike: lot.strike! }, "opra");
    expect(chainMatches(chain, lot.expiry!, "call", lot.strike!)).toBe(1);
    const occ = occSymbol("QQQ", lot.expiry!, "call", lot.strike!)!;
    const stamp = new Date(stepInstant(e.session, 3) + SCRIPT_ANSWER_LAG_MS);
    const answer = await fixtureContracts([occ], NOW, false, "opra", stamp);
    const j = judgeQuote({ feed: { status: "ok", answer, sentPerf: 1_000, sentWall: 0 }, occ, perfNow: 1_500, wallNow: 500, shownPerf: null });
    expect(j).toMatchObject({ ok: true, q: { sample: true } });
    if (j.ok) expect(j.q.bidCents).toBeGreaterThanOrEqual(1);
    // indicative: withheld
    const ind = await fixtureContracts([occ], NOW, false, "indicative", stamp);
    expect(judgeQuote({ feed: { status: "ok", answer: ind, sentPerf: 1_000, sentWall: 0 }, occ, perfNow: 1_500, wallNow: 500, shownPerf: null }).ok).toBe(false);
  });

  it("names a contract of a name it does not carry, or past its expiry, as missing", async () => {
    const gone = occSymbol("SPY", "2026-10-09", "call", 660)!;
    const other = occSymbol("ZZZZ", "2026-10-16", "call", 10)!;
    expect((await fixtureContracts([gone, other], NOW, false, "opra")).missing).toEqual([gone, other]);
  });
});

describe("GET /api/contract", () => {
  const get = (q: string, cookie = "") => handleContract(new Request(`https://lab.example/api/contract${q}`, { headers: cookie ? { cookie } : {} }), NOW);
  const noKeys = () => {
    for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) vi.stubEnv(k, "");
  };
  const keys = () => {
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
  };

  it("refuses anything but a list of OCC symbols with 400, before reading a key", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const q of ["", "?s=", "?s=SPY", `?s=${A},nope`, `?x=${A}`]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("answers 503 without keys, and while ALPACA_OPTION_FEED is not a feed, and never calls upstream", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    noKeys();
    expect((await get(`?s=${A}`)).status).toBe(503);
    keys();
    vi.stubEnv("ALPACA_OPTION_FEED", "sip");
    const res = await get(`?s=${A}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not-configured", why: "feed" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reads the feed as the chain does: indicative when unset, opra when chosen", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    keys();
    vi.stubEnv("ALPACA_OPTION_FEED", "");
    const f = upstream();
    vi.stubGlobal("fetch", f);
    const a = await get(`?s=${A}`);
    expect(a.status).toBe(200);
    expect(((await a.json()) as { feed: string }).feed).toBe("indicative");
    vi.stubEnv("ALPACA_OPTION_FEED", " OPRA ");
    const b = await get(`?s=${A}`);
    expect(((await b.json()) as { feed: string }).feed).toBe("opra");
    expect(urls(f).map((u) => u.searchParams.get("feed"))).toEqual(["indicative", "opra"]);
  });

  it("maps upstream failures as the chain does, without passing the body on", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    keys();
    vi.stubEnv("ALPACA_OPTION_FEED", "opra");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream-secret-body", { status: 500 })));
    const e = await get(`?s=${A}`);
    expect(e.status).toBe(502);
    expect(await e.text()).not.toContain("upstream-secret-body");
    resetContractCache();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream-secret-body", { status: 429 })));
    const r = await get(`?s=${A}`);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "rate-limited" });
  });

  it("serves the fixture in fixture mode, bent by the chain's flags, and never in production", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    const c = await fixtureChain("SPY", NOW, false, null, "opra");
    const occ = occSymbol("SPY", c.expiries[0]!.date, "call", c.expiries[0]!.contracts[0]!.strike)!;
    const plain = (await (await get(`?s=${occ}`)).json()) as { feed: string; fixture?: boolean };
    expect(plain).toMatchObject({ feed: "indicative", fixture: true });
    expect(((await (await get(`?s=${occ}`, "fx=chain-opra")).json()) as { feed: string }).feed).toBe("opra");
    expect((await get(`?s=${occ}`, "fx=chain-off")).status).toBe(503);
    expect((await get(`?s=${occ}`, "fx=chain-error")).status).toBe(502);
    // chain-thin damages the same first calls as in the chain: the second has no market (a zero bid and ask)
    const thin = (await (await get(`?s=${occ}`, "fx=chain-thin")).json()) as { contracts: Record<string, unknown>; missing: string[] };
    expect(thin.contracts[occ]).toBeDefined();
    const second = occSymbol("SPY", c.expiries[0]!.date, "call", c.expiries[0]!.contracts[1]!.strike)!;
    const thin2 = (await (await get(`?s=${second}`, "fx=chain-thin")).json()) as { contracts: Record<string, { bid: number; ask: number; last: number | null }> };
    expect(thin2.contracts[second]).toMatchObject({ bid: 0, ask: 0, last: null });
    expect((await get("?s=SPY", "fx=chain-opra")).status).toBe(400);
    vi.stubEnv("VERCEL_ENV", "production");
    noKeys();
    expect((await get(`?s=${occ}`, "fx=chain-opra")).status).toBe(503);
  });
});
