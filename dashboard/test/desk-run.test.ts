// The server's shadow run (desk-run.ts) on an in-memory store with create-only rules, and the bars read it uses
// (bars.ts' minFetchedAt): idle outside the session, off by default, one record per slot, never overwritten, never
// a store call in fixture mode or outside production, and degraded rather than guessed when an upstream fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import { fetchBars, fetchSettledBars, resetBarsCache, type BarsResponse } from "@/lib/bars";
import { resetQuoteCache } from "@/lib/quote";
import { BAR_MS, type ServerRecord } from "@/lib/desk-eval";
import { BarsOff, defaultDeskRunDeps, type DeskRunDeps, runDeskEval, TIMEOUT_MS } from "@/lib/desk-run";
import { shadowSummary } from "@/lib/desk-shadow";
import { recordFeed } from "@/lib/feed-provenance";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import { type Bar2, SERVER_SETTLE_MS } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, EDT
const OPEN = Date.parse(`${S}T13:30:00Z`);
const ny = (hhmmss: string) => Date.parse(`${S}T${hhmmss}-04:00`);
const SYMS = E.focus!.items.map((i) => i.symbol);
const LOG = '{"v":1,"eval":"log"}';

/** A flat session of bars for each focus name up to `at` (the last one forming). */
function bars(at: number): Record<string, Bar2[]> {
  const out: Record<string, Bar2[]> = {};
  for (const s of SYMS) {
    const c = E.focus!.items.find((i) => i.symbol === s)!.close ?? 100;
    const list: Bar2[] = [];
    for (let start = OPEN; start < at; start += BAR_MS) list.push({ start, end: start + BAR_MS, o: c, h: c + 0.1, l: c - 0.1, c });
    out[s] = list;
  }
  return out;
}

function fakeDeps(over: Partial<DeskRunDeps> & { clock?: number[] } = {}) {
  const store = new Map<string, string>();
  const clock = over.clock ?? [ny("10:31:01")];
  let tick = 0;
  const calls = { switch: 0, exists: 0, write: 0, edition: 0, journal: 0, done: 0, bars: 0, snapshots: 0 };
  const deps: DeskRunDeps = {
    now: () => clock[Math.min(tick++, clock.length - 1)]!,
    dry: false,
    readSwitch: async () => {
      calls.switch++;
      return store.get("desk/eval.json") ?? null;
    },
    exists: async (p) => {
      calls.exists++;
      return store.has(p);
    },
    write: async (p, body) => {
      calls.write++;
      if (store.has(p)) throw new PreconditionFailed();
      store.set(p, body);
    },
    loadEdition: async () => {
      calls.edition++;
      return { status: "ok", edition: E };
    },
    loadJournal: async () => {
      calls.journal++;
      return null;
    },
    readDone: async () => {
      calls.done++;
      return { status: "ok", doc: { v: 1, done: null }, memory: false };
    },
    fetchBars: async (symbols, o): Promise<BarsResponse> => {
      calls.bars++;
      const t = o.now.getTime();
      const b = bars(t);
      return { as_of: o.now.toISOString(), feed: "iex", bars: Object.fromEntries(symbols.map((s) => [s, b[s]!])), fetchedAt: Object.fromEntries(symbols.map((s) => [s, t])), missing: [] };
    },
    fetchSnapshots: async (symbols, o) => {
      calls.snapshots++;
      const t = o.now.getTime();
      const b = bars(t);
      const quotes = Object.fromEntries(
        symbols.map((s) => {
          const last = b[s]!.at(-1)!;
          return [s, { price: last.c, at: new Date(t - 1_000).toISOString(), open: last.o, high: last.h, low: last.l, day: S, prev_close: null, vwap: null }];
        }),
      );
      return { as_of: o.now.toISOString(), feed: "iex", quotes, missing: [] };
    },
    ...over,
  };
  const records = () => [...store.entries()].filter(([k]) => k.startsWith("desk/log/")).map(([k, v]) => [k, JSON.parse(v) as ServerRecord] as const);
  return { deps, store, calls, records };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetQuoteCache();
});

describe("a run", () => {
  it("outside the session is idle and touches nothing: before the open, after the close, a weekend, a holiday", async () => {
    for (const t of [ny("09:29:00"), ny("16:00:00"), ny("20:00:00"), Date.parse("2026-11-14T15:00:00Z"), Date.parse("2026-11-26T16:00:00Z"), ny("09:31:00")]) {
      const f = fakeDeps({ clock: [t] });
      f.store.set("desk/eval.json", LOG);
      const r = await runDeskEval(f.deps);
      expect(r.outcome).toBe("idle");
      expect(Object.values(f.calls).every((n) => n === 0)).toBe(true);
    }
  });

  it("with the switch off, missing or malformed does nothing at all after reading it", async () => {
    for (const sw of [undefined, '{"v":1,"eval":"off"}', "{", '{"v":1,"eval":"log","why":"x"}', '{"v":1,"eval":"on"}']) {
      const f = fakeDeps();
      if (sw !== undefined) f.store.set("desk/eval.json", sw);
      expect(await runDeskEval(f.deps)).toEqual({ ok: true, outcome: "off" });
      expect(f.calls).toEqual({ switch: 1, exists: 0, write: 0, edition: 0, journal: 0, done: 0, bars: 0, snapshots: 0 });
    }
    // a switch read that throws is off too
    const f = fakeDeps({ readSwitch: () => Promise.reject(new Error("store down")) });
    expect((await runDeskEval(f.deps)).outcome).toBe("off");
    expect(f.calls.write).toBe(0);
  });

  it("logs one private create-only record for the last settled slot", async () => {
    const f = fakeDeps();
    f.store.set("desk/eval.json", LOG);
    const r = await runDeskEval(f.deps);
    expect(r).toEqual({ ok: true, outcome: "logged", slot: "1030", status: "ok", reason: null });
    const recs = f.records();
    expect(recs.map(([k]) => k)).toEqual([`desk/log/${S}/1030.json`]);
    expect(recs[0]![1]).toMatchObject({ v: 1, source: "server", status: "ok", slot_end: new Date(ny("10:30:00")).toISOString(), board: "live" });
    expect(recs[0]![1].rows).toHaveLength(SYMS.length * 2);
  });

  it("a second run in the same slot, or a double fire, is a no-op success: never a second record, never an overwrite", async () => {
    const f = fakeDeps({ clock: [ny("10:31:01"), ny("10:31:02"), ny("10:32:59"), ny("10:32:59")] });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    const first = f.store.get(`desk/log/${S}/1030.json`);
    const again = await runDeskEval(f.deps);
    expect(again).toEqual({ ok: true, outcome: "already-logged", slot: "1030" });
    expect(f.calls.write).toBe(1);
    expect(f.calls.edition).toBe(1); // the second run stopped at the head()
    expect(f.store.get(`desk/log/${S}/1030.json`)).toBe(first);
  });

  it("a create-only conflict (two runs racing past the head) is a no-op success", async () => {
    const f = fakeDeps({ exists: async () => false });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    const r = await runDeskEval({ ...f.deps, now: () => ny("10:32:00") });
    expect(r).toEqual({ ok: true, outcome: "already-logged", slot: "1030" });
    expect(f.records()).toHaveLength(1);
  });

  it("after a missed run logs only its own slot: no record is invented for the slot it missed", async () => {
    const f = fakeDeps({ clock: [ny("10:31:01")] });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    // the 10:33 and 10:34 runs never came; 10:35 evaluates 10:34 only
    await runDeskEval({ ...f.deps, now: () => ny("10:35:10") });
    expect(f.records().map(([k]) => k)).toEqual([`desk/log/${S}/1030.json`, `desk/log/${S}/1034.json`]);
  });

  it("the cron route answers 401 without the bearer CRON_SECRET, and runs nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const { GET } = await import("@/app/api/cron/desk/route");
    for (const auth of [null, "Bearer wrong", "s3cret", "bearer s3cret", "Bearer s3cret2"]) {
      const res = await GET(new Request("https://desk.example/api/cron/desk", { headers: auth ? { authorization: auth } : {} }));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    // the right bearer reaches the run (here a dry one: off, nothing touched)
    const ok = await GET(new Request("https://desk.example/api/cron/desk", { headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new Request("https://desk.example/api/cron/desk", { headers: { authorization: "Bearer " } }))).status).toBe(401);
  });

  it("asks for bars read at or after the slot's settle instant", async () => {
    const seen: number[] = [];
    const f = fakeDeps();
    f.store.set("desk/eval.json", LOG);
    const inner = f.deps.fetchBars;
    await runDeskEval({ ...f.deps, fetchBars: (s, o) => (seen.push(o.minFetchedAt), inner(s, o)) });
    expect(seen).toEqual([ny("10:30:00") + SERVER_SETTLE_MS]);
  });

  it("an edition for another day logs wrong-day, with no rows and no bars asked for", async () => {
    const f = fakeDeps({ loadEdition: async () => ({ status: "ok", edition: { ...E, session: "2026-10-09" } }) });
    f.store.set("desk/eval.json", LOG);
    expect(await runDeskEval(f.deps)).toMatchObject({ outcome: "logged", status: "wrong-day" });
    expect(f.records()[0]![1]).toMatchObject({ status: "wrong-day", rows: [], edition_session: "2026-10-09" });
    expect(f.calls.bars).toBe(0);
    expect(f.calls.snapshots).toBe(0);
  });

  it("a bars failure, a timeout, missing keys or a gap is degraded with its reason, and no state is guessed", async () => {
    const cases: [Partial<DeskRunDeps>, string][] = [
      [{ fetchBars: () => Promise.reject(new Error("alpaca 500")) }, "bars-failed"],
      [{ fetchBars: () => Promise.reject(new BarsOff()) }, "bars-off"],
      [{ fetchBars: () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })) }, "bars-timeout"],
      [{ loadEdition: async () => ({ status: "missing" }) }, "edition-missing"],
      [{ loadEdition: async () => ({ status: "error" }) }, "edition-error"],
      // never the bars alone: without the snapshot nothing is evaluated
      [{ fetchSnapshots: () => Promise.reject(new Error("alpaca 500")) }, "snapshot-failed"],
      [{ fetchSnapshots: () => Promise.reject(new BarsOff()) }, "snapshot-off"],
      [{ fetchSnapshots: () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })) }, "snapshot-timeout"],
    ];
    for (const [over, reason] of cases) {
      const f = fakeDeps(over);
      f.store.set("desk/eval.json", LOG);
      expect(await runDeskEval(f.deps)).toMatchObject({ outcome: "logged", status: "degraded", reason });
      expect(f.records()[0]![1].rows).toEqual([]);
      expect(f.records()[0]![1].snapshot_ok).toBe(!reason.startsWith("snapshot") && !reason.startsWith("edition") ? true : false);
    }
    const holed = fakeDeps();
    holed.store.set("desk/eval.json", LOG);
    const inner = holed.deps.fetchBars;
    await runDeskEval({
      ...holed.deps,
      fetchBars: async (s, o) => {
        const r = await inner(s, o);
        return { ...r, bars: { ...r.bars, SPY: r.bars.SPY!.filter((b) => b.start !== ny("10:00:00")) } };
      },
    });
    // a gap before any break is the page's to ignore too: SPY keeps its rows
    expect(holed.records()[0]![1]).toMatchObject({ status: "ok", degraded_names: [], snapshot_ok: true });
    expect(holed.records()[0]![1].rows.filter((r) => r.symbol === "SPY")).toHaveLength(2);
  });

  it("a hung upstream is cut off by its own timeout and written as degraded", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeDeps({ fetchBars: () => new Promise(() => undefined) });
      f.store.set("desk/eval.json", LOG);
      const p = runDeskEval(f.deps);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatchObject({ outcome: "logged", status: "degraded", reason: "bars-timeout" });
      const g = fakeDeps({ loadEdition: () => new Promise(() => undefined) });
      g.store.set("desk/eval.json", LOG);
      const q = runDeskEval(g.deps);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await q).toMatchObject({ outcome: "logged", status: "degraded", reason: "store-timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a run under 10 s even when every step hits its timeout (the reads run side by side)", () => {
    const t = TIMEOUT_MS;
    expect(t.switch + t.exists + t.edition + t.reads + t.write).toBeLessThan(10_000);
    expect(t.barsPage).toBeLessThan(t.reads);
  });

  it("a done flag that could not be read counts as done", async () => {
    const f = fakeDeps({ readDone: async () => ({ status: "error" }) });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    expect(f.records()[0]![1].day.done).toBe(true);
  });

  it("a dry run (fixture or not production) never writes, never asks whether a record exists, and returns the record", async () => {
    const f = fakeDeps({ dry: true });
    f.store.set("desk/eval.json", LOG);
    const r = await runDeskEval(f.deps);
    expect(r).toMatchObject({ ok: true, outcome: "dry", slot: "1030", path: `desk/log/${S}/1030.json` });
    expect(r.outcome === "dry" && r.record.status).toBe("ok");
    expect(f.calls.write).toBe(0);
    expect(f.calls.exists).toBe(0);
  });

  it("the deployed dependencies never touch the store outside production or in fixture mode", async () => {
    // (fixture mode is refused on production itself: snapshot.ts' fixtureMode)
    const envs: Record<string, string>[] = [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: "" }, { VERCEL_ENV: "preview", DASHBOARD_FIXTURE: "1" }];
    for (const env of envs) {
      vi.unstubAllEnvs();
      vi.stubEnv("DASHBOARD_FIXTURE", "");
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const d = defaultDeskRunDeps();
      expect(d.dry).toBe(true);
      expect(await d.readSwitch()).toBeNull();
      await expect(d.write("x", "y")).rejects.toThrow(/dry run/);
      await expect(d.exists("x")).rejects.toThrow(/dry run/);
      expect(await runDeskEval({ ...d, now: () => ny("10:31:01") })).toEqual({ ok: true, outcome: "off" });
    }
    vi.unstubAllEnvs();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    expect(defaultDeskRunDeps().dry).toBe(false);
  });
});

// ---- the bars it reads ----------------------------------------------------------------------------------------------
describe("the settled bars read", () => {
  const KEYS = { id: "k", secret: "s" };
  const raw = (start: number, c: number) => ({ t: new Date(start).toISOString(), o: c, h: c, l: c, c });
  beforeEach(() => resetBarsCache());

  it("refetches a cached answer read before the slot settled; the page's read keeps its 10 s cache", async () => {
    const end = ny("10:30:00");
    let version = 1;
    const f = vi.fn(async () => Response.json({ bars: { SPY: [raw(end - BAR_MS, version === 1 ? 100 : 101)] }, next_page_token: null }));
    // the page polls at 10:30:55: the bar ending 10:30 may not hold its last minute yet
    await fetchBars(["SPY"], KEYS, new Date(end + 55_000), f, "https://data.example");
    version = 2; // upstream now holds the complete bar
    // the page's own read at 10:31:01 is still inside BARS_CACHE_MS: it keeps the cached answer
    const page = await fetchBars(["SPY"], KEYS, new Date(end + 61_000), f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(1);
    expect(page.bars.SPY!.at(-1)!.c).toBe(100);
    // the desk's read at the same instant must not be hidden by it
    const desk = await fetchSettledBars(["SPY"], KEYS, new Date(end + 61_000), end + SERVER_SETTLE_MS, 2_500, false, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
    expect(desk.bars.SPY!.at(-1)!.c).toBe(101);
    expect(desk.fetchedAt.SPY).toBe(end + 61_000);
    // and a read already at or after the settle instant is shared, not fetched again
    await fetchSettledBars(["SPY"], KEYS, new Date(end + 65_000), end + SERVER_SETTLE_MS, 2_500, false, f, "https://data.example");
    expect(f).toHaveBeenCalledTimes(2);
  });
});

// ---- the feed on the record -----------------------------------------------------------------------------------------
describe("the record's feed", () => {
  it("is written after the engine's record, as the snapshot answer named it, so slots can be counted per feed", async () => {
    const f = fakeDeps();
    const inner = f.deps.fetchSnapshots;
    f.deps.fetchSnapshots = async (s, o) => ({ ...(await inner(s, o)), feed: "sip" });
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    const [path, rec] = f.records()[0]!;
    const raw = JSON.parse(f.store.get(path)!) as Record<string, unknown>;
    expect(recordFeed(raw)).toBe("sip");
    // the engine's fields come first and are unchanged; the feed is the key after them, then the snapshot probe, the
    // guards' observe-mode log and the 429 count
    const keys = Object.keys(raw);
    expect(keys.slice(-4)).toEqual(["feed", "probe", "guards", "http_429"]);
    const { feed: _feed, probe: _probe, guards: _guards, http_429: _n429, ...engine } = raw;
    void _feed;
    void _probe;
    void _guards;
    void _n429;
    expect(Object.keys(engine)).toEqual(["v", "engine", "source", "status", "reason", "slot_end", "evaluated_at", "session", "edition_session", "edition_as_of", "board", "rows", "degraded_names", "snapshot_ok", "day"]);
    expect(rec.status).toBe("ok");
  });

  it("is the bars' feed when only the bars answered, and null whenever nothing was read", async () => {
    const noSnap = fakeDeps({ fetchSnapshots: () => Promise.reject(new Error("alpaca 500")) });
    noSnap.store.set("desk/eval.json", LOG);
    await runDeskEval(noSnap.deps);
    expect(recordFeed(noSnap.records()[0]![1])).toBe("iex"); // the bars answered, from iex
    const timeout = () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const cases: [string, Partial<DeskRunDeps>][] = [
      ["no keys, or the setting refused", { fetchBars: () => Promise.reject(new BarsOff()), fetchSnapshots: () => Promise.reject(new BarsOff()) }],
      ["both reads timed out", { fetchBars: timeout, fetchSnapshots: timeout }],
      ["both reads failed", { fetchBars: () => Promise.reject(new Error("alpaca 500")), fetchSnapshots: () => Promise.reject(new Error("alpaca 500")) }],
      ["no edition", { loadEdition: async () => ({ status: "missing" }) }],
      ["an unreadable edition", { loadEdition: async () => ({ status: "error" }) }],
      ["an edition for another day", { loadEdition: async () => ({ status: "ok", edition: { ...E, session: "2026-10-09" } }) }],
      ["no focus names", { loadEdition: async () => ({ status: "ok", edition: { ...E, focus: { ...E.focus!, items: [] } } }) }],
    ];
    for (const [what, over] of cases) {
      const f = fakeDeps(over);
      f.store.set("desk/eval.json", LOG);
      await runDeskEval(f.deps);
      const raw = JSON.parse([...f.store.entries()].find(([k]) => k.startsWith("desk/log/"))![1]) as Record<string, unknown>;
      expect(raw, what).toHaveProperty("feed", null);
    }
  });

  it("the deployed reads refuse a bad ALPACA_FEED as not configured, before anything goes upstream", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "k");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "s");
    vi.stubEnv("ALPACA_FEED", "nonsense");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const d = defaultDeskRunDeps();
    await expect(d.fetchBars(["SPY"], { now: new Date(ny("10:31:01")), minFetchedAt: 0, timeoutMs: 100, halfDay: false })).rejects.toBeInstanceOf(BarsOff);
    await expect(d.fetchSnapshots(["SPY"], { now: new Date(ny("10:31:01")), timeoutMs: 100 })).rejects.toBeInstanceOf(BarsOff);
    expect(f).not.toHaveBeenCalled();
  });

  // DEC-0064: a 403 on iex can no longer be read (ALPACA_FEED=iex is refused before any read), so that case now checks
  // iex is refused as not configured with nothing asked upstream; a 401 on sip still stays a failure.
  it("the deployed reads take sip refused by the plan (403) as not configured; iex (paused) is refused unread; a 401 stays a failure", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "k");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "s");
    const now = new Date(ny("10:31:01"));
    const read = async (feed: string, status: number) => {
      resetBarsCache();
      resetQuoteCache();
      vi.stubEnv("ALPACA_FEED", feed);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status })));
      const d = defaultDeskRunDeps();
      const errs = await Promise.all([
        d.fetchBars(["SPY"], { now, minFetchedAt: 0, timeoutMs: 1_000, halfDay: false }).catch((e: unknown) => e),
        d.fetchSnapshots(["SPY"], { now, timeoutMs: 1_000 }).catch((e: unknown) => e),
      ]);
      return errs.map((e) => (e instanceof BarsOff ? "off" : "failed"));
    };
    expect(await read("sip", 403)).toEqual(["off", "off"]);
    expect(await read("iex", 403)).toEqual(["off", "off"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await read("sip", 401)).toEqual(["failed", "failed"]);
    expect(await read("sip", 500)).toEqual(["failed", "failed"]);
  });

  it("the shadow numbers read records with and without the field alike", async () => {
    const f = fakeDeps();
    f.store.set("desk/eval.json", LOG);
    await runDeskEval(f.deps);
    const withFeed = f.records().map(([, r]) => r);
    const old = withFeed.map((r) => {
      const { feed: _feed, ...rest } = r as ServerRecord & { feed?: unknown };
      void _feed;
      return rest as ServerRecord;
    });
    expect(old.every((r) => recordFeed(r) === null)).toBe(true);
    expect(shadowSummary([S], withFeed, [])).toEqual(shadowSummary([S], old, []));
    expect(shadowSummary([S], withFeed, []).logged).toBe(1);
  });
});

// ---- the snapshot probe on the record -------------------------------------------------------------------------------
describe("the snapshot probe", () => {
  /** A raw Alpaca snapshot per name, consistent with what fakeDeps' snapshot answer says. */
  const rawFor = (t: number) =>
    Object.fromEntries(
      SYMS.map((s) => {
        const c = E.focus!.items.find((i) => i.symbol === s)!.close ?? 100;
        return [
          s,
          {
            latestTrade: { t: new Date(t - 1_000).toISOString(), x: "V", p: c, s: 1, c: ["@"], i: 1, z: "B" },
            latestQuote: { t: new Date(t - 1_000).toISOString(), ax: "V", ap: c + 0.01, as: 1, bx: "V", bp: c - 0.01, bs: 1, c: ["R"], z: "B" },
            minuteBar: { t: new Date(t - (t % 60_000)).toISOString(), o: c, h: c, l: c, c, v: 1, n: 1, vw: c },
            dailyBar: { t: `${S}T04:00:00Z`, o: c, h: c + 0.1, l: c - 0.1, c, v: 1, n: 1, vw: c },
            prevDailyBar: { t: "2026-10-09T04:00:00Z", o: c, h: c, l: c, c, v: 1, n: 1, vw: c },
          },
        ];
      }),
    );
  /** fakeDeps whose snapshot read also hands the raw answer to the probe, as the deployed fetchQuotes does. */
  const tapped = (over: Partial<DeskRunDeps> = {}) => {
    const f = fakeDeps(over);
    const inner = f.deps.fetchSnapshots;
    f.deps.fetchSnapshots = async (s, o) => {
      const r = await inner(s, o);
      o.onRaw?.({ fetched: rawFor(o.now.getTime()), at: o.now.getTime() });
      return r;
    };
    f.store.set("desk/eval.json", LOG);
    return f;
  };
  const stored = (f: ReturnType<typeof fakeDeps>) => JSON.parse([...f.store.entries()].find(([k]) => k.startsWith("desk/log/"))![1]) as Record<string, unknown>;
  const withoutProbe = (r: Record<string, unknown>) => {
    const { probe: _p, ...rest } = r;
    void _p;
    return rest;
  };

  it("rides on the slot's one put: no extra store call and no extra upstream call", async () => {
    const plain = fakeDeps();
    plain.store.set("desk/eval.json", LOG);
    await runDeskEval(plain.deps);
    const f = tapped();
    await runDeskEval(f.deps);
    expect(f.calls).toEqual(plain.calls);
    expect([...f.store.keys()].sort()).toEqual([...plain.store.keys()].sort());
  });

  it("records the facts of each focus name, and leaves the engine's record and the feed exactly as they are without it", async () => {
    const plain = fakeDeps();
    plain.store.set("desk/eval.json", LOG);
    const a = await runDeskEval(plain.deps);
    const f = tapped();
    const b = await runDeskEval(f.deps);
    expect(b).toEqual(a);
    const rec = stored(f);
    expect(withoutProbe(rec)).toEqual(withoutProbe(stored(plain)));
    expect(stored(plain).probe).toBeNull();
    const probe = rec.probe as { v: number; names: { symbol: string; source: string; trade_vs_day: string; quote: string; minute: string }[] };
    expect(probe.v).toBe(1);
    expect(probe.names.map((n) => n.symbol)).toEqual(SYMS);
    for (const n of probe.names) expect(n).toMatchObject({ source: "fetched", trade_vs_day: "inside", quote: "normal" });
  });

  it("is null when the snapshot read failed, even though a raw answer was handed over first", async () => {
    const cases: [Error, string][] = [
      [new Error("alpaca 500"), "snapshot-failed"],
      [new BarsOff(), "snapshot-off"],
      [Object.assign(new Error("aborted"), { name: "TimeoutError" }), "snapshot-timeout"],
    ];
    for (const [err, reason] of cases) {
      let handed = 0;
      const f = fakeDeps({
        fetchSnapshots: async (_s, o) => {
          o.onRaw?.({ fetched: rawFor(o.now.getTime()), at: o.now.getTime() });
          handed++;
          throw err;
        },
      });
      f.store.set("desk/eval.json", LOG);
      await runDeskEval(f.deps);
      expect(handed, reason).toBe(1);
      expect(stored(f), reason).toMatchObject({ status: "degraded", reason, probe: null });
    }
  });

  it("is null when the raw answer was handed over and the read then hung past TIMEOUT_MS.reads", async () => {
    vi.useFakeTimers();
    let handed = 0;
    const f = fakeDeps({
      fetchSnapshots: (_s, o) => {
        o.onRaw?.({ fetched: rawFor(o.now.getTime()), at: o.now.getTime() });
        handed++;
        return new Promise(() => undefined); // never answers
      },
    });
    f.store.set("desk/eval.json", LOG);
    let settled = false;
    const run = runDeskEval(f.deps).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS.reads - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await run;
    expect(handed).toBe(1);
    expect(r).toMatchObject({ ok: true, outcome: "logged", status: "degraded", reason: "snapshot-timeout" });
    expect(stored(f)).toMatchObject({ status: "degraded", reason: "snapshot-timeout", probe: null });
  });

  it("a probe that throws, or gives something that cannot be written, leaves the run, its outcome and its record unchanged", async () => {
    const plain = fakeDeps();
    plain.store.set("desk/eval.json", LOG);
    const expected = await runDeskEval(plain.deps);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad: DeskRunDeps["probe"][] = [
      () => {
        throw new Error("probe bug");
      },
      () => {
        throw "not even an error";
      },
      () => circular as never,
      () => ({ v: 1, phase: "regular", rate_limit: null, rate_remaining: null, names: [{ symbol: "SPY", source: "cached", n: BigInt(1) as never }] }),
    ];
    for (const probe of bad) {
      const f = tapped({ probe });
      expect(await runDeskEval(f.deps)).toEqual(expected);
      expect(stored(f)).toEqual(stored(plain));
      expect(f.calls).toEqual(plain.calls);
    }
  });

  it("when the record's write rejects, the outcome is the same with or without the probe, and a throwing probe changes nothing", async () => {
    const rejecting = { write: () => Promise.reject(new Error("blob 500")) };
    const plain = fakeDeps(rejecting);
    plain.store.set("desk/eval.json", LOG);
    const expected = await runDeskEval(plain.deps);
    expect(expected).toEqual({ ok: false, outcome: "write-failed", slot: "1030" });
    expect(await runDeskEval(tapped(rejecting).deps)).toEqual(expected);
    const both = tapped({
      ...rejecting,
      probe: () => {
        throw new Error("probe bug");
      },
    });
    expect(await runDeskEval(both.deps)).toEqual(expected);
    expect(both.store.has(`desk/log/${S}/1030.json`)).toBe(false);
  });

  it("a dry run touches no store and carries no probe (its reads are refused)", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    const d = defaultDeskRunDeps();
    expect(d.dry).toBe(true);
    const r = await runDeskEval({ ...d, now: () => ny("10:31:01"), readSwitch: async () => LOG });
    expect(r.outcome).toBe("dry");
    expect(r.outcome === "dry" && r.record.probe).toBeNull();
  });

  it("the deployed snapshot read hands the raw answer of the names it fetched to the probe", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_API_KEY_ID", "k");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "s");
    // DEC-0064: run on sip, the only feed that can be configured now (this case read iex before).
    vi.stubEnv("ALPACA_FEED", "sip");
    const raw = rawFor(ny("10:31:01"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 })));
    const got: unknown[] = [];
    const now = new Date(ny("10:31:01"));
    const ans = await defaultDeskRunDeps().fetchSnapshots(SYMS, { now, timeoutMs: 1_000, onRaw: (r) => got.push(r) });
    expect(got).toEqual([{ fetched: raw, at: now.getTime(), rate: { limit: null, remaining: null } }]);
    expect(Object.keys(ans.quotes)).toEqual(SYMS);
  });
});
