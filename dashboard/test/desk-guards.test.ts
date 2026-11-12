// The bad-data guards' switches (desk-guards.ts), their store reads and route (desk-guards-run.ts), the observe-mode
// summary, the Operations panel's line for a low data-plan limit, and the `quotes-suspect` fixture.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedsPanel } from "@/components/operations/feeds-panel";
import { serverLogPath } from "@/lib/desk-eval";
import { ALL_OFF, DESK_GUARDS_PATH, LOW_RATE_LIMIT, parseGuardAnswer, parseGuardList, parseGuardSwitches, rateLimitLine, summariseGuards } from "@/lib/desk-guards";
import { defaultGuardReadDeps, handleGuards, loadDataPlanLimit, readGuardSwitches } from "@/lib/desk-guards-run";
import { suspectQuote, suspectReasonFor } from "@/lib/fixture-suspect";
import { VARIANT_FLAGS } from "@/lib/fixture-variants";
import { GUARD_REASONS, quoteGuards } from "@/lib/quote-guards";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the switches", () => {
  it("live at one fixed path, and are all off until the owner writes them on", () => {
    expect(DESK_GUARDS_PATH).toBe("desk/guards.json");
    expect(parseGuardSwitches(null)).toEqual({ status: "missing", on: [] });
    expect(parseGuardSwitches(undefined)).toEqual({ status: "missing", on: [] });
    expect(parseGuardSwitches('{"v":1,"on":[]}')).toEqual({ status: "ok", on: [] });
  });

  it("turn one guard on, or several, in the board's order whatever the stored order", () => {
    expect(parseGuardSwitches('{"v":1,"on":["quote-crossed"]}')).toEqual({ status: "ok", on: ["quote-crossed"] });
    expect(parseGuardSwitches('{"v":1,"on":["quote-crossed","bar-high-below-low"]}')).toEqual({ status: "ok", on: ["bar-high-below-low", "quote-crossed"] });
    expect(parseGuardSwitches(JSON.stringify({ v: 1, on: [...GUARD_REASONS].reverse() }))).toEqual({ status: "ok", on: [...GUARD_REASONS] });
  });

  it("anything that is not exactly the document is malformed, and every guard off", () => {
    for (const text of [
      "",
      "{",
      "[]",
      "null",
      '"on"',
      '{"v":2,"on":["quote-crossed"]}',
      '{"on":["quote-crossed"]}',
      '{"v":1}',
      '{"v":1,"on":"quote-crossed"}',
      '{"v":1,"on":["quote-crossed"],"why":"x"}',
      '{"v":1,"on":["quote-crossed","quote-crossed"]}',
      '{"v":1,"on":["quote-crossed","trade-outside-range"]}',
      '{"v":1,"on":["QUOTE-CROSSED"]}',
      '{"v":1,"on":[1]}',
      JSON.stringify({ v: 1, on: [...GUARD_REASONS, "quote-crossed"] }),
      `{"v":1,"on":[],"pad":"${"x".repeat(600)}"}`,
    ])
      expect(parseGuardSwitches(text), text).toEqual({ status: "malformed", on: [] });
    expect(parseGuardSwitches(42)).toEqual({ status: "malformed", on: [] });
    expect(ALL_OFF("error")).toEqual({ status: "error", on: [] });
  });

  it("the page's check of the route's answer", () => {
    expect(parseGuardAnswer({ on: ["quote-crossed"], status: "ok" })).toEqual({ status: "ok", on: ["quote-crossed"] });
    expect(parseGuardAnswer({ on: [], status: "error" })).toEqual({ status: "error", on: [] });
    for (const v of [null, [], "x", { on: ["quote-crossed"] }, { on: ["nope"], status: "ok" }, { on: ["quote-crossed"], status: "error" }, { on: [], status: "later" }])
      expect(parseGuardAnswer(v), JSON.stringify(v)).toBeNull();
    expect(parseGuardList(["quote-crossed", "bar-high-below-low"])).toEqual(["bar-high-below-low", "quote-crossed"]);
    expect(parseGuardList(undefined)).toBeNull();
  });
});

describe("the store read", () => {
  it("is never made in fixture mode or outside production: every guard off", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(defaultGuardReadDeps().dry).toBe(true);
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    expect(defaultGuardReadDeps().dry).toBe(true);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    expect(defaultGuardReadDeps().dry).toBe(false);
    const read = vi.fn(async () => '{"v":1,"on":["quote-crossed"]}');
    expect(await readGuardSwitches({ dry: true, read })).toEqual({ status: "missing", on: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it("a store that cannot be reached is every guard off, said as an error and logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await readGuardSwitches({ dry: false, read: () => Promise.reject(new Error("store down")) })).toEqual({ status: "error", on: [] });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("desk-guards.read");
    expect(await readGuardSwitches({ dry: false, read: async () => '{"v":1,"on":["quote-crossed"]}' })).toEqual({ status: "ok", on: ["quote-crossed"] });
  });
});

describe("GET /api/desk/guards", () => {
  const HOST = "desk.example";
  const req = (method = "GET", headers: Record<string, string> = {}, q = "") => new Request(`https://${HOST}/api/desk/guards${q}`, { method, headers: { "sec-fetch-site": "same-origin", host: HOST, ...headers } });
  const on = { dry: false, read: async () => '{"v":1,"on":["quote-crossed"]}' };

  it("answers the switches and how they were read, no-store, and nothing else", async () => {
    const res = await handleGuards(req(), on);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ on: ["quote-crossed"], status: "ok" });
    expect(await (await handleGuards(req(), { dry: false, read: () => Promise.reject(new Error("down")) })).json()).toEqual({ on: [], status: "error" });
    expect(await (await handleGuards(req(), { dry: true, read: on.read })).json()).toEqual({ on: [], status: "missing" });
    const head = await handleGuards(req("HEAD"), on);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("refuses other methods, other sites and the protection bypass in every form", async () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await handleGuards(req(m), on);
      expect(res.status, m).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    expect((await handleGuards(req("GET", { "sec-fetch-site": "cross-site" }), on)).status).toBe(403);
    expect((await handleGuards(req("GET", { "x-vercel-protection-bypass": "s" }), on)).status).toBe(403);
    expect((await handleGuards(req("GET", {}, "?x-vercel-protection-bypass=s"), on)).status).toBe(403);
    expect((await handleGuards(req("GET", { "x-vercel-set-bypass-cookie": "true" }), on)).status).toBe(403);
  });
});

// ---- the observe-mode summary ---------------------------------------------------------------------------------------------
const rec = (feed: string | undefined, guards: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, status: "ok", ...(feed ? { feed } : {}), probe: null, guards, ...extra });
const log = (names: unknown[], on: string[] = [], switches = "ok") => ({ v: 1, switches, on, names });

describe("summariseGuards", () => {
  it("counts, per feed and never pooled, how often each guard would have paused a name, and how often a row was paused and why", () => {
    const s = summariseGuards([
      rec("iex", log([
        { symbol: "SPY", would: ["quote-crossed"], paused: null },
        { symbol: "QQQ", would: [], paused: "stale" },
      ])),
      rec("iex", log([{ symbol: "SPY", would: ["bar-high-below-low", "bar-open-outside-range"], paused: "guard" }], ["bar-high-below-low"])),
      rec("sip", log([{ symbol: "SPY", would: ["price-far-from-prior-close"], paused: null }], [], "error")),
      rec(undefined, log([{ symbol: "SPY", would: ["quote-crossed"], paused: null }], [], "missing")),
    ]);
    expect(s).toMatchObject({ records: 4, with_guards: 4, without_guards: 0 });
    const iex = s.by_feed.iex;
    expect(iex.records).toBe(2);
    expect(iex.switches).toEqual({ ok: 2, missing: 0, malformed: 0, error: 0, "invalid-record": 0 });
    expect(iex.on).toEqual({ "bar-high-below-low": 1, "bar-open-outside-range": 0, "price-far-from-prior-close": 0, "quote-crossed": 0 });
    expect(iex.total).toEqual({ names: 3, would: { "bar-high-below-low": 1, "bar-open-outside-range": 1, "price-far-from-prior-close": 0, "quote-crossed": 1 }, would_any: 2, paused: { stale: 1, guard: 1 } });
    expect(iex.by_symbol.SPY!.would_any).toBe(2);
    expect(iex.by_symbol.QQQ).toEqual({ names: 1, would: { "bar-high-below-low": 0, "bar-open-outside-range": 0, "price-far-from-prior-close": 0, "quote-crossed": 0 }, would_any: 0, paused: { stale: 1, guard: 0 } });
    expect(s.by_feed.sip.total.would["price-far-from-prior-close"]).toBe(1);
    expect(s.by_feed.sip.total.would["quote-crossed"]).toBe(0);
    expect(s.by_feed.sip.switches.error).toBe(1);
    expect(s.by_feed.unknown.total.would["quote-crossed"]).toBe(1);
    expect(s.by_feed.unknown.switches.missing).toBe(1);
  });

  it("counts the runs' 429 answers and the low rate limits per feed, from every record", () => {
    const s = summariseGuards([
      rec("iex", null, { http_429: 1, probe: { v: 1, rate_limit: 200 } }),
      rec("iex", null, { http_429: 2, probe: { v: 1, rate_limit: 180 } }),
      rec("sip", null, { http_429: 0, probe: { v: 1, rate_limit: 10_000 } }),
      rec(undefined, null, { http_429: 2 }),
      rec("sip", null, { http_429: 7, probe: { v: 1, rate_limit: "200" } }),
      rec("sip", null, { http_429: -1, probe: { v: 1, rate_limit: 999.5 } }),
    ]);
    expect(s.by_feed.iex).toMatchObject({ http_429: 3, rate_limit_low: 2, rate_limit_min: 180 });
    expect(s.by_feed.sip).toMatchObject({ http_429: 0, rate_limit_low: 0, rate_limit_min: null });
    expect(s.by_feed.unknown.http_429).toBe(2);
    expect(s.without_guards).toBe(6);
  });

  it("is lenient: anything unreadable is without a log, or skipped, and nothing throws", () => {
    const s = summariseGuards([
      null,
      5,
      "x",
      { feed: "iex", guards: { v: 2, names: [] } },
      { feed: "iex", guards: { v: 1, names: "x" } },
      rec("iex", log([null, 5, { symbol: "bad sym", would: [] }, { symbol: "__proto__", would: [] }, { symbol: "SPY", would: ["nope"] }, { symbol: "SPY", would: "quote-crossed" }, { symbol: "QQQ", would: [], paused: "why" }], ["nope"], "weird")),
    ]);
    expect(s).toMatchObject({ records: 6, with_guards: 1, without_guards: 5 });
    expect(s.by_feed.iex.total.names).toBe(1);
    expect(s.by_feed.iex.total.paused).toEqual({ stale: 0, guard: 0 });
    expect(s.by_feed.iex.switches["invalid-record"]).toBe(1);
    expect(Object.keys(s.by_feed.iex.by_symbol)).toEqual(["QQQ"]);
  });
});

// ---- L7: the data plan's limit ----------------------------------------------------------------------------------------------
describe("a low data plan limit", () => {
  it("reads as a line below 1,000, and nothing at or above it", () => {
    expect(LOW_RATE_LIMIT).toBe(1_000);
    expect(rateLimitLine(200)).toBe("The data plan's limit reads 200: check the plan and the keys");
    expect(rateLimitLine(999)).toBe("The data plan's limit reads 999: check the plan and the keys");
    expect(rateLimitLine(0)).toBe("The data plan's limit reads 0: check the plan and the keys");
    for (const v of [1_000, 10_000, null, undefined, -1, 1.5, Number.NaN]) expect(rateLimitLine(v), String(v)).toBeNull();
  });

  const panel = (dataPlanLimit?: number | null) =>
    renderToStaticMarkup(
      createElement(FeedsPanel, {
        now: new Date("2026-10-12T15:00:00Z"),
        snapshot: { status: "missing" },
        journal: { status: "missing" },
        options: { status: "missing" },
        optionsLive: { status: "missing" },
        radar: { status: "missing" },
        feeds: { stamps: {}, refusals: {}, shadow: null },
        optionsDates: [],
        radarDates: [],
        ...(dataPlanLimit === undefined ? {} : { dataPlanLimit }),
      }),
    );

  it("shows in the Operations panel's feed section, and only then", () => {
    const low = panel(200).replaceAll("&#x27;", "'");
    expect(low).toContain("data-rate-limit");
    expect(low).toContain("The data plan's limit reads 200: check the plan and the keys");
    expect(panel(10_000)).not.toContain("data-rate-limit");
    expect(panel(null)).not.toContain("data-rate-limit");
    // without the prop, the panel is as it was
    expect(panel()).toBe(panel(null));
  });

  it("is read from the server check's newest record today, and never outside production or with the check off", async () => {
    const day = "2026-10-12";
    const now = Date.parse(`${day}T10:31:30-04:00`);
    const store = new Map<string, string>([["desk/eval.json", '{"v":1,"eval":"log"}']]);
    const newest = Math.floor((now - 60_000) / 120_000) * 120_000;
    store.set(serverLogPath(day, newest), JSON.stringify({ v: 1, probe: { v: 1, rate_limit: 200 } }));
    const deps = {
      now: () => now,
      dry: false,
      readSwitch: async () => store.get("desk/eval.json") ?? null,
      exists: async (p: string) => store.has(p),
      readRecord: async (p: string) => store.get(p) ?? null,
    };
    expect(await loadDataPlanLimit(now, deps)).toBe(200);
    expect(await loadDataPlanLimit(now, { ...deps, dry: true })).toBeNull();
    expect(await loadDataPlanLimit(now, { ...deps, readSwitch: async () => '{"v":1,"eval":"off"}' })).toBeNull();
    expect(await loadDataPlanLimit(now, { ...deps, readRecord: async () => JSON.stringify({ v: 1, probe: null }) })).toBeNull();
    expect(await loadDataPlanLimit(now, { ...deps, readRecord: () => Promise.reject(new Error("down")) })).toBeNull();
    expect(await loadDataPlanLimit(now, { ...deps, exists: async () => false })).toBeNull();
  });
});

// ---- the quotes-suspect fixture -----------------------------------------------------------------------------------------------
describe("the quotes-suspect fixture", () => {
  const q = { price: 100, at: "2026-10-12T15:00:00.000Z", open: 99, high: 101, low: 98, day: "2026-10-12", prev_close: 99, vwap: 99.5 };
  it("is a known variant", () => {
    expect(VARIANT_FLAGS).toContain("quotes-suspect");
  });

  it("trips each guard in turn, the bar's high below its low with its open outside it, each other one alone", () => {
    expect(quoteGuards(suspectQuote(q, "bar-high-below-low"))).toEqual(["bar-high-below-low", "bar-open-outside-range"]);
    expect(quoteGuards(suspectQuote(q, "bar-open-outside-range"))).toEqual(["bar-open-outside-range"]);
    expect(quoteGuards(suspectQuote(q, "price-far-from-prior-close"))).toEqual(["price-far-from-prior-close"]);
    expect(quoteGuards(suspectQuote(q, "quote-crossed"))).toEqual(["quote-crossed"]);
    expect([0, 1, 2, 3, 4, 5, -1].map(suspectReasonFor)).toEqual([...GUARD_REASONS, "bar-high-below-low", "bar-open-outside-range", "quote-crossed"]);
    // the rest of the quote is the fixture's
    expect(suspectQuote(q, "quote-crossed")).toMatchObject({ price: 100, at: q.at, day: q.day, vwap: 99.5 });
  });
});
