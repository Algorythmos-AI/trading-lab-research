import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTITLEMENT_EVERY_MS,
  entitlement,
  entitlementForHealth,
  entitlementShort,
  HEALTH_WAIT_MS,
  entitlementWords,
  fixtureEntitlement,
  probeEntitlement,
  readLimit,
  readStatus,
  resetEntitlement,
} from "@/lib/entitlement";
import { entitlementRow } from "@/lib/feeds-page";

// The entitlement probe (entitlement.ts): SIP and OPRA asked of Alpaca by name, 403 a refusal and anything else an
// error, the rate limit read from its header, at most once per 10 minutes per instance, never the network in fixture
// mode or without keys; and its row on the Feeds page.

const NOW = new Date("2026-10-12T16:00:00Z");
const KEYS = { id: "test-key-id", secret: "test-key-secret" };
const ENV = { ALPACA_API_KEY_ID: "test-key-id", ALPACA_API_SECRET_KEY: "test-key-secret" };
const BASE = "https://data.example";

/** Answers the stock call with `stock` and the option call with `option`; a number is a status, "hang" never answers. */
function upstream(stock: number | "hang" | "throw" = 200, option: number | "hang" | "throw" = 200, limit: string | null = "10000") {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const want = u.pathname.startsWith("/v2/stocks") ? stock : option;
    if (want === "throw") throw new TypeError("fetch failed");
    if (want === "hang")
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    return new Response(want === 200 ? "{}" : "upstream-secret-body", { status: want, headers: limit ? { "x-ratelimit-limit": limit } : {} });
  });
}
const urls = (f: ReturnType<typeof upstream>) => f.mock.calls.map((c) => new URL(String(c[0])));

// The CI job runs this suite with DASHBOARD_FIXTURE=1, where the probe answers from the fixture and asks nothing: these
// tests are about the real probe, so fixture mode is switched off for each of them.
beforeEach(() => {
  resetEntitlement();
  vi.stubEnv("DASHBOARD_FIXTURE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("reading Alpaca's answers", () => {
  it("is the feed on 200, a refusal on 403, and an error on anything else or nothing", () => {
    expect(readStatus(200, "sip")).toBe("sip");
    expect(readStatus(200, "opra")).toBe("opra");
    expect(readStatus(403, "opra")).toBe("refused");
    for (const s of [201, 204, 401, 404, 429, 500, 503, null]) expect(readStatus(s, "opra"), String(s)).toBe("error");
  });

  it("reads the rate limit as a whole number of calls a minute", () => {
    expect(readLimit("200")).toBe(200);
    expect(readLimit(" 10000 ")).toBe(10_000);
    for (const bad of [null, "", "0", "-1", "1.5", "lots", "12345678"]) expect(readLimit(bad), String(bad)).toBeNull();
  });
});

describe("the probe", () => {
  it("asks SIP for SPY's latest quote and OPRA for one SPY option snapshot, each naming its feed", async () => {
    const f = upstream();
    const got = await probeEntitlement(KEYS, NOW, f, BASE);
    expect(got).toEqual({ checked_at: NOW.toISOString(), stock: "sip", option: "opra", calls_per_min: 10_000 });
    const [a, b] = urls(f);
    expect(a!.pathname).toBe("/v2/stocks/SPY/quotes/latest");
    expect(a!.searchParams.get("feed")).toBe("sip");
    expect(b!.pathname).toBe("/v1beta1/options/snapshots/SPY");
    expect(b!.searchParams.get("feed")).toBe("opra");
    expect(b!.searchParams.get("limit")).toBe("1");
    expect(f.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain("test-key");
  });

  it("tells a refusal from an error, feed by feed", async () => {
    expect(await probeEntitlement(KEYS, NOW, upstream(403, 403), BASE)).toMatchObject({ stock: "refused", option: "refused" });
    expect(await probeEntitlement(KEYS, NOW, upstream(200, 403), BASE)).toMatchObject({ stock: "sip", option: "refused" });
    expect(await probeEntitlement(KEYS, NOW, upstream(500, 401), BASE)).toMatchObject({ stock: "error", option: "error" });
    expect(await probeEntitlement(KEYS, NOW, upstream("throw", 200), BASE)).toMatchObject({ stock: "error", option: "opra" });
  });

  // AbortSignal.timeout runs on the real clock: this waits out ENTITLEMENT_TIMEOUT_MS.
  it("counts no answer in time as an error", async () => {
    expect(await probeEntitlement(KEYS, NOW, upstream("hang", 200), BASE)).toMatchObject({ stock: "error", option: "opra" });
  }, 10_000);

  it("takes the rate limit from either answer, or none", async () => {
    expect((await probeEntitlement(KEYS, NOW, upstream(200, 200, null), BASE)).calls_per_min).toBeNull();
    expect((await probeEntitlement(KEYS, NOW, upstream("throw", 200, "200"), BASE)).calls_per_min).toBe(200);
  });
});

describe("asking at most once per 10 minutes", () => {
  it("serves its last answer for 10 minutes, then asks again", async () => {
    const f = upstream();
    await entitlement({ now: NOW, fetchImpl: f, env: ENV, baseUrl: BASE });
    await entitlement({ now: new Date(NOW.getTime() + ENTITLEMENT_EVERY_MS - 1), fetchImpl: f, env: ENV, baseUrl: BASE });
    expect(f).toHaveBeenCalledTimes(2);
    const later = await entitlement({ now: new Date(NOW.getTime() + ENTITLEMENT_EVERY_MS), fetchImpl: f, env: ENV, baseUrl: BASE });
    expect(f).toHaveBeenCalledTimes(4);
    expect(later!.checked_at).toBe(new Date(NOW.getTime() + ENTITLEMENT_EVERY_MS).toISOString());
  });

  it("keeps a failed answer as long, and does not trust one stamped after now", async () => {
    const f = upstream(500, 500);
    await entitlement({ now: NOW, fetchImpl: f, env: ENV, baseUrl: BASE });
    expect((await entitlement({ now: new Date(NOW.getTime() + 60_000), fetchImpl: f, env: ENV, baseUrl: BASE }))!.stock).toBe("error");
    expect(f).toHaveBeenCalledTimes(2);
    await entitlement({ now: new Date(NOW.getTime() - 1), fetchImpl: f, env: ENV, baseUrl: BASE });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("sends one probe however many ask at once", async () => {
    const f = upstream();
    const [a, b] = await Promise.all([entitlement({ now: NOW, fetchImpl: f, env: ENV, baseUrl: BASE }), entitlement({ now: NOW, fetchImpl: f, env: ENV, baseUrl: BASE })]);
    expect(a).toEqual(b);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("asks nothing without keys, and never the network in fixture mode", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    const f = upstream();
    expect(await entitlement({ now: NOW, fetchImpl: f, env: {}, baseUrl: BASE })).toBeNull();
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    expect(await entitlement({ now: NOW, fetchImpl: f, env: ENV, baseUrl: BASE })).toEqual(fixtureEntitlement(NOW));
    expect(f).not.toHaveBeenCalled();
    expect(fixtureEntitlement(NOW)).toEqual({ checked_at: NOW.toISOString(), stock: "sip", option: "opra", calls_per_min: 10_000 });
  });
});

describe("for /api/health, never waiting on Alpaca", () => {
  const never = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  it("leaves the field out within the wait when the first probe does not answer, and keeps it running", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    const t0 = performance.now();
    const r = await entitlementForHealth({ now: NOW, fetchImpl: never, env: ENV, baseUrl: BASE });
    const took = performance.now() - t0;
    expect(r.value).toBeNull();
    expect(r.pending).not.toBeNull();
    expect(took).toBeGreaterThanOrEqual(HEALTH_WAIT_MS - 20);
    expect(took).toBeLessThan(HEALTH_WAIT_MS + 250);
  });

  it("answers at once from the last answer, starting a refresh only once it is 10 minutes old", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    const f = upstream();
    const first = await entitlementForHealth({ now: NOW, fetchImpl: f, env: ENV, baseUrl: BASE });
    expect(first).toEqual({ value: { checked_at: NOW.toISOString(), stock: "sip", option: "opra", calls_per_min: 10_000 }, pending: null });
    const cached = await entitlementForHealth({ now: new Date(NOW.getTime() + 60_000), fetchImpl: never, env: ENV, baseUrl: BASE });
    expect(cached).toEqual({ value: first.value, pending: null });
    const t0 = performance.now();
    const stale = await entitlementForHealth({ now: new Date(NOW.getTime() + ENTITLEMENT_EVERY_MS), fetchImpl: never, env: ENV, baseUrl: BASE });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(stale.value).toEqual(first.value);
    expect(stale.pending).not.toBeNull();
  });

  it("is nothing without keys, and the fixed answer in fixture mode", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    expect(await entitlementForHealth({ now: NOW, fetchImpl: never, env: {} })).toEqual({ value: null, pending: null });
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    expect(await entitlementForHealth({ now: NOW, fetchImpl: never, env: ENV })).toEqual({ value: fixtureEntitlement(NOW), pending: null });
  });

  it("holds no key and no account data, only the four fields", () => {
    expect(Object.keys(fixtureEntitlement(NOW))).toEqual(["checked_at", "stock", "option", "calls_per_min"]);
  });
});

describe("the Feeds page's row", () => {
  it("names each feed and the calls a minute, and warns unless both feeds answer", () => {
    expect(entitlementWords(fixtureEntitlement(NOW))).toBe("Stock SIP · options OPRA · 10,000 calls a minute");
    expect(entitlementShort(fixtureEntitlement(NOW))).toBe(false);
    const short = { checked_at: NOW.toISOString(), stock: "sip", option: "refused", calls_per_min: null } as const;
    expect(entitlementWords(short)).toBe("Stock SIP · options refused by the plan · calls a minute not given");
    expect(entitlementShort(short)).toBe(true);
    expect(entitlementWords({ ...short, stock: "error", option: "opra" })).toBe("Stock could not be checked · options OPRA · calls a minute not given");
  });

  it("says when it was checked, in New York, or that the site has no keys", () => {
    expect(entitlementRow(fixtureEntitlement(NOW))).toEqual({ label: "Alpaca data plan (checked 12:00 NY)", text: "Stock SIP · options OPRA · 10,000 calls a minute", warn: false });
    expect(entitlementRow(null)).toEqual({ label: "Alpaca data plan", text: "not available: the site has no Alpaca keys", warn: true });
  });
});
