import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  CHAIN_CACHE_MS,
  fetchChain,
  NEAR_EXPIRIES,
  normaliseContract,
  nyDate,
  parseOcc,
  parsePrice,
  parseSymbol,
  resetChainCache,
  selectChain,
  STRIKES_PER_EXPIRY,
} from "@/lib/chain";
import { fixtureChain, fixtureExpiries, handleChain } from "@/lib/chain-route";
import { readQuote } from "@/lib/contract";
import { VARIANT_FLAGS } from "@/lib/fixture-variants";

const NOW = new Date("2026-10-12T16:00:00Z"); // Monday, 12:00 in New York
const KEYS = { id: "test-key-id", secret: "test-key-secret" };
const occ = (date: string, kind: "C" | "P", strike: number, root = "SPY") => `${root}${date.slice(2).replace(/-/g, "")}${kind}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const snap = (bid = 1, ask = 1.1) => ({
  latestQuote: { bp: bid, ap: ask, t: "2026-10-12T15:45:00.123456789Z" },
  latestTrade: { p: 1.05 },
  greeks: { delta: 0.5, gamma: 0.01 },
  impliedVolatility: 0.14,
  dailyBar: { v: 1200 },
});

beforeEach(() => resetChainCache());
afterEach(() => vi.unstubAllGlobals());

describe("what the route is asked for", () => {
  it("takes one ticker symbol", () => {
    expect(parseSymbol(" spy ")).toBe("SPY");
    expect(parseSymbol("BRK.B")).toBe("BRK.B");
    for (const bad of [null, "", "SPY,QQQ", "1SPY", "TOOLONGSYMBOL", "SPY;DROP"]) expect(parseSymbol(bad)).toBeNull();
  });

  it("takes a plain positive price and nothing else", () => {
    expect(parsePrice("780.43")).toBe(780.43);
    expect(parsePrice("5")).toBe(5);
    for (const bad of [null, "", "0", "0.00", "-5", "1e3", "abc", "780.43.1", "1234567", "780,43", "NaN"]) expect(parsePrice(bad)).toBeNull();
  });
});

describe("dates", () => {
  it("reads the date in New York, not in UTC", () => {
    expect(nyDate(new Date("2026-10-13T01:00:00Z"))).toBe("2026-10-12");
    expect(nyDate(new Date("2026-10-13T05:00:00Z"))).toBe("2026-10-13");
  });

  it("adds days across a month end and a clock change", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-10-12", 0)).toBe("2026-10-12");
  });
});

describe("a contract's symbol", () => {
  it("gives the expiry, the kind and the strike of a standard contract", () => {
    expect(parseOcc("SPY261019P00760000", "SPY")).toEqual({ expiry: "2026-10-19", kind: "put", strike: 760 });
    expect(parseOcc("NVDA261016C00232500", "NVDA")).toEqual({ expiry: "2026-10-16", kind: "call", strike: 232.5 });
    expect(parseOcc("BRKB261016C00500000", "BRK.B")).toEqual({ expiry: "2026-10-16", kind: "call", strike: 500 });
  });

  it("leaves out a contract adjusted for a split or a merger, which trades under another root", () => {
    expect(parseOcc("SPY1261019P00760000", "SPY")).toBeNull();
    expect(parseOcc("SPYX261019P00760000", "SPY")).toBeNull();
  });

  it.each(["QQQ261019P00760000", "SPY261019X00760000", "SPY261319P00760000", "SPY260631P00760000", "SPY261019P0076000", "SPY261019P00000000", "SPY", ""])("refuses %s", (bad) => {
    expect(parseOcc(bad, "SPY")).toBeNull();
  });
});

describe("normalising a contract", () => {
  it("keeps what is usable", () => {
    expect(normaliseContract("call", 780, snap(2.95, 3.1))).toEqual({
      kind: "call", strike: 780, bid: 2.95, ask: 3.1, last: 1.05, at: "2026-10-12T15:45:00.123Z", iv: 0.14, delta: 0.5, volume: 1200,
    });
  });

  it("keeps a bid of zero, which is a real quote", () => {
    expect(normaliseContract("put", 700, snap(0, 0.01)).bid).toBe(0);
  });

  it("turns anything unusable into null, never into a number", () => {
    const junk = { latestQuote: { bp: -1, ap: "3.1", t: "yesterday" }, latestTrade: { p: 0 }, greeks: { delta: 7 }, impliedVolatility: -0.2, dailyBar: { v: -5 } };
    expect(normaliseContract("call", 780, junk)).toEqual({ kind: "call", strike: 780, bid: null, ask: null, last: null, at: null, iv: null, delta: null, volume: null });
    expect(normaliseContract("call", 780, null).ask).toBeNull();
    expect(normaliseContract("call", 780, { impliedVolatility: NaN, greeks: null }).iv).toBeNull();
    expect(normaliseContract("call", 780, { impliedVolatility: 25 }).iv).toBeNull();
  });
});

describe("what the page is offered", () => {
  const TODAY = "2026-10-12";
  const all: Record<string, ReturnType<typeof snap>> = {};
  // Dailies for a fortnight, then two weeklies; forty strikes a dollar apart; one expiry already gone.
  const dates = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-23", "2026-10-30"];
  for (const d of dates) for (let k = 760; k < 800; k++) for (const kind of ["C", "P"] as const) all[occ(d, kind, k)] = snap();
  const picked = selectChain(all, "SPY", 780.4, TODAY);

  it("is the nearest expiries that have not passed, and the first a fortnight or more out", () => {
    expect(picked.map((x) => x.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-30"]);
    expect(picked).toHaveLength(NEAR_EXPIRIES + 1);
  });

  it("carries the strikes nearest the price, calls then puts, each rising", () => {
    const first = picked[0]!.contracts;
    expect(first).toHaveLength(STRIKES_PER_EXPIRY * 2);
    const calls = first.filter((c) => c.kind === "call").map((c) => c.strike);
    expect(calls).toEqual(Array.from({ length: STRIKES_PER_EXPIRY }, (_, i) => 770 + i));
    expect(first.slice(0, STRIKES_PER_EXPIRY).every((c) => c.kind === "call")).toBe(true);
    expect(first.slice(STRIKES_PER_EXPIRY).every((c) => c.kind === "put")).toBe(true);
  });

  it("does not repeat the swing expiry when it is already among the nearest, and copes with few or none", () => {
    const few = { [occ("2026-10-16", "C", 780)]: snap(), [occ("2026-10-30", "C", 780)]: snap(), [occ("2026-10-30", "P", 775)]: snap() };
    expect(selectChain(few, "SPY", 780, TODAY).map((x) => x.date)).toEqual(["2026-10-16", "2026-10-30"]);
    expect(selectChain(few, "SPY", 780, TODAY)[1]!.contracts.map((c) => `${c.kind} ${c.strike}`)).toEqual(["call 780", "put 775"]);
    expect(selectChain({}, "SPY", 780, TODAY)).toEqual([]);
    expect(selectChain({ [occ("2026-10-16", "C", 780, "SPY1")]: snap(), nonsense: snap() }, "SPY", 780, TODAY)).toEqual([]);
  });
});

describe("fetching a chain", () => {
  const body = (snapshots: Record<string, unknown>, next: string | null = null) => new Response(JSON.stringify({ snapshots, next_page_token: next }), { status: 200 });
  const near = { [occ("2026-10-12", "C", 780)]: snap(), [occ("2026-10-12", "P", 780)]: snap() };
  const far = { [occ("2026-10-30", "C", 780)]: snap() };
  const upstream = () =>
    vi.fn<typeof fetch>(async (input) => (new URL(String(input)).searchParams.get("expiration_date_gte") === "2026-10-12" ? body(near) : body(far)));

  it("asks Alpaca's indicative feed for the coming week and for a fortnight out, around the price, with the keys in headers only", async () => {
    const f = upstream();
    const got = await fetchChain("SPY", 780, KEYS, NOW, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
    const urls = f.mock.calls.map((c) => new URL(String(c[0])));
    for (const u of urls) {
      expect(u.origin + u.pathname).toBe("https://data.example/v1beta1/options/snapshots/SPY");
      expect(u.searchParams.get("feed")).toBe("indicative");
      expect(u.searchParams.get("strike_price_gte")).toBe("741.00");
      expect(u.searchParams.get("strike_price_lte")).toBe("819.00");
      expect(u.toString()).not.toContain("test-key");
    }
    expect(urls.map((u) => [u.searchParams.get("expiration_date_gte"), u.searchParams.get("expiration_date_lte")]).sort()).toEqual([
      ["2026-10-12", "2026-10-20"],
      ["2026-10-26", "2026-11-05"],
    ]);
    const headers = new Headers(f.mock.calls[0]![1]?.headers);
    expect(headers.get("APCA-API-KEY-ID")).toBe("test-key-id");
    expect(headers.get("APCA-API-SECRET-KEY")).toBe("test-key-secret");
    expect(got).toMatchObject({ feed: "indicative", delay_min: 15, symbol: "SPY", as_of: NOW.toISOString() });
    expect(got.expiries.map((x) => [x.date, x.contracts.length])).toEqual([
      ["2026-10-12", 2],
      ["2026-10-30", 1],
    ]);
  });

  it("shares an answer for a short while, then asks again", async () => {
    const f = upstream();
    await fetchChain("SPY", 780, KEYS, NOW, f);
    await fetchChain("SPY", 780.5, KEYS, new Date(NOW.getTime() + CHAIN_CACHE_MS - 1), f);
    expect(f).toHaveBeenCalledTimes(2);
    await fetchChain("SPY", 780, KEYS, new Date(NOW.getTime() + CHAIN_CACHE_MS), f);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("asks again at once when the price has moved more than a percent, or the clock has stepped back", async () => {
    const f = upstream();
    await fetchChain("SPY", 780, KEYS, NOW, f);
    await fetchChain("SPY", 790, KEYS, new Date(NOW.getTime() + 1000), f);
    expect(f).toHaveBeenCalledTimes(4);
    await fetchChain("SPY", 790, KEYS, new Date(NOW.getTime() - 60_000), f);
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("follows further pages, but not for ever", async () => {
    let n = 0;
    const f = vi.fn<typeof fetch>(async () => body({ [occ("2026-10-12", "C", 770 + n++)]: snap() }, "more"));
    const got = await fetchChain("SPY", 780, KEYS, NOW, f);
    // Three pages for each of the two calls, then it stops asking.
    expect(f).toHaveBeenCalledTimes(6);
    expect(new URL(String(f.mock.calls[2]![0])).searchParams.get("page_token")).toBe("more");
    expect(got.expiries[0]!.contracts).toHaveLength(6);
  });

  it("throws on an HTTP error and remembers nothing from it", async () => {
    const bad = vi.fn<typeof fetch>(async () => new Response("upstream-secret-body", { status: 403 }));
    await expect(fetchChain("SPY", 780, KEYS, NOW, bad)).rejects.toThrow("alpaca 403");
    const f = upstream();
    await fetchChain("SPY", 780, KEYS, NOW, f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("answers with no expiries when Alpaca has none, rather than failing", async () => {
    const got = await fetchChain("SPY", 780, KEYS, NOW, vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })));
    expect(got.expiries).toEqual([]);
  });
});

describe("the fixture chain", () => {
  it("expires on the coming weekdays and on a Friday a fortnight out, never in the past", () => {
    expect(fixtureExpiries("2026-10-12")).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-30"]);
    // From a Saturday: Monday is the first.
    expect(fixtureExpiries("2026-10-10")).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-30"]);
    for (const day of ["2026-12-30", "2027-03-12", "2026-10-16"]) {
      const got = fixtureExpiries(day);
      expect(got.every((d) => d >= day)).toBe(true);
      expect(new Set(got).size).toBe(got.length);
      expect([...got].sort()).toEqual(got);
    }
  });

  it("carries sane quotes for a fixture name, dated a quarter of an hour ago", async () => {
    const chain = await fixtureChain("SPY", NOW);
    expect(chain.fixture).toBe(true);
    expect(chain.expiries).toHaveLength(5);
    for (const x of chain.expiries) {
      expect(x.contracts).toHaveLength(STRIKES_PER_EXPIRY * 2);
      for (const c of x.contracts) {
        expect(c.at).toBe("2026-10-12T15:45:00.000Z");
        expect(readQuote(c).state === "ok" || readQuote(c).state === "no-bid").toBe(true);
        expect(c.iv).toBeGreaterThan(0);
        expect(Math.abs(c.delta!)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is empty for a name the fixture does not have, and damaged three ways when asked", async () => {
    expect((await fixtureChain("ZZZZ", NOW)).expiries).toEqual([]);
    const thin = (await fixtureChain("SPY", NOW, true)).expiries[0]!.contracts;
    expect(thin[0]!.iv).toBeNull();
    expect(readQuote(thin[1]!).state).toBe("no-market");
    expect(readQuote(thin[2]!).state).toBe("crossed");
  });
});

describe("GET /api/chain", () => {
  const get = (q: string, cookie = "") => handleChain(new Request(`https://lab.example/api/chain${q}`, { headers: cookie ? { cookie } : {} }), NOW);

  it("refuses a request without one symbol and a price", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    for (const q of ["", "?s=SPY", "?px=780", "?s=SPY,QQQ&px=780", "?s=SPY&px=abc", "?s=SPY&px=-1"]) expect((await get(q)).status).toBe(400);
  });

  it("answers 503 without keys and never calls upstream", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) vi.stubEnv(k, "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await get("?s=SPY&px=780");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(f).not.toHaveBeenCalled();
  });

  it("answers 502 when upstream fails, without passing its body on", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key-id");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-key-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream-secret-body", { status: 500 })));
    const res = await get("?s=SPY&px=780");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("upstream-secret-body");
  });

  it("serves the fixture chain in fixture mode, bent by the cookie, and never in production", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    const ok = await get("?s=SPY&px=780");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { fixture?: boolean; expiries: unknown[] }).expiries).toHaveLength(5);
    expect((await get("?s=SPY&px=780", "fx=chain-off")).status).toBe(503);
    expect((await get("?s=SPY&px=780", "fx=chain-error")).status).toBe(502);
    const thin = (await (await get("?s=SPY&px=780", "fx=partial.chain-thin")).json()) as { expiries: { contracts: { iv: number | null }[] }[] };
    expect(thin.expiries[0]!.contracts[0]!.iv).toBeNull();
    expect(VARIANT_FLAGS).toEqual(expect.arrayContaining(["chain-off", "chain-error", "chain-thin"]));
    // On a production deployment fixture mode is refused, so the cookie means nothing and the keys decide.
    vi.stubEnv("VERCEL_ENV", "production");
    for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) vi.stubEnv(k, "");
    expect((await get("?s=SPY&px=780")).status).toBe(503);
  });
});
