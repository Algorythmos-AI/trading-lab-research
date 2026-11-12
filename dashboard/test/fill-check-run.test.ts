// The fill-time check's run and route (DEC-0049 point 4): run once, nothing stored on a failed transport, a lost
// create-only race, the fetch's span and page cap, fixture mode with no network, the result's keys, and every refusal
// of the route. Injected dependencies and synthetic journals only: no network, no store.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import { requestSpan, stampNs, type RawPrint, type Unit } from "@/lib/fill-check";
import { fetchOptionTrades, MAX_PAGES, PAGE_LIMIT, TradesFetchError, tradesUrl, type TradeAnswer, type TradeFetcher, type TradeQuery } from "@/lib/fill-check-fetch";
import {
  CONCURRENCY,
  defaultFillCheckDeps,
  FILL_CHECK_PATH,
  handleFillCheck,
  MAX_RETRY_AFTER_MS,
  parseConfirm,
  parseSessions,
  resetMemoryFillCheck,
  RUN_BUDGET_MS,
  runFillCheck,
  SESSIONS_PATH,
  syntheticTrades,
  type FillCheckDeps,
} from "@/lib/fill-check-run";
import { maxDuration } from "@/app/api/desk/fill-check/route";

afterEach(() => {
  resetMemoryFillCheck();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- a synthetic journal: one opening unit per session over `days` sessions, `per` units each ---------------------
const DAYS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
function journal(days = 4, per = 10) {
  const trades: Record<string, unknown>[] = [];
  for (const d of DAYS.slice(0, days))
    for (let i = 0; i < per; i++) {
      const min = String(10 + i * 2).padStart(2, "0");
      trades.push({ id: `${d}-${i}`, symbol: "ABC", kind: i % 2 ? "put" : "call", strike: 50 + i, expiry: "2026-12-18", side: "long", qty: 1, opened_at: `${d}T15:${min}:00.000Z`, closed_at: `${d}T16:${min}:00.000Z`, entry: 1.2, exit: 1.5, multiplier: 100, pnl: 30, close: "order" });
    }
  return { schema: "stocksdelta/journal", trades, open: [] };
}
const NOW = new Date("2026-11-20T00:00:00.000Z");

const iso = (ns: bigint) => `${new Date(Number(ns / 1_000_000n)).toISOString().slice(0, -1)}${String(ns % 1_000_000n).padStart(6, "0")}Z`;
/** A print source that answers each span with a print `offsetS` from its centre, at the unit's own price. */
function printsAt(offsetS: number, price = 1.2): TradeFetcher {
  return async (q) => {
    const centre = (BigInt(q.startMs) + BigInt(q.endMs)) * 500_000n;
    return { kind: "prints", prints: [{ t: iso(centre + BigInt(Math.round(offsetS * 1e9))), p: price, c: "I" }] };
  };
}

interface Harness {
  deps: FillCheckDeps;
  stored: () => string | null;
  sessions: () => string | null;
  queries: TradeQuery[];
  sleeps: number[];
  writes: number;
  /** The harness clock, in ms: it moves only when the run sleeps. */
  clock: { ms: number };
}
type HarnessOpts = { fetcher?: TradeFetcher; doc?: unknown; journalOk?: boolean; stored?: string | null; sessions?: string | null; writeError?: unknown; memory?: boolean; keys?: boolean };
function harness(o: HarnessOpts = {}): Harness {
  let stored: string | null = o.stored ?? null;
  let sessions: string | null = o.sessions ?? null;
  const h: Harness = {
    stored: () => stored,
    sessions: () => sessions,
    queries: [],
    sleeps: [],
    writes: 0,
    clock: { ms: NOW.getTime() },
    deps: {
      memory: o.memory ?? false,
      configured: () => o.keys !== false,
      readJournal: async () => (o.journalOk === false ? { ok: false } : { ok: true, doc: o.doc ?? journal() }),
      trades: () => {
        const f = o.fetcher ?? printsAt(2);
        return (q, signal) => {
          h.queries.push(q);
          return f(q, signal);
        };
      },
      readStored: async () => stored,
      writeStored: async (body) => {
        h.writes++;
        if (o.writeError) throw o.writeError;
        if (stored !== null) throw new PreconditionFailed();
        stored = body;
      },
      readSessions: async () => sessions,
      writeSessions: async (body) => {
        if (sessions !== null) throw new PreconditionFailed();
        sessions = body;
      },
      now: () => new Date(h.clock.ms),
      sleep: async (ms) => {
        h.sleeps.push(ms);
        h.clock.ms += ms;
      },
    },
  };
  return h;
}
/** The fill-check.run log lines written while `f` runs. */
async function logged(f: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await f();
  const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.evt === "fill-check.run");
  spy.mockRestore();
  return lines;
}

describe("the run", () => {
  it("a full run: 40 opening and 40 closing units over 4 sessions, a pass, stored once", async () => {
    const h = harness();
    const r = await runFillCheck(h.deps);
    expect(r.state).toBe("done");
    if (r.state !== "done") return;
    expect(r.fresh).toBe(true);
    expect(r.result.overall.opening).toMatchObject({ checked: 40, matched: 40, early: 0, late: 0 });
    expect(r.result.overall.opening.offset_s).toEqual({ n: 40, median: 2, p10: 2, p90: 2 });
    expect(r.result.overall.closing.checked).toBe(40);
    expect(r.result.sessions.map((s) => s.day)).toEqual(["2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02"]);
    expect(r.result.verdict).toBe("pass");
    expect(r.result.fixture).toBe(false);
    expect(h.writes).toBe(1);
    expect(JSON.parse(h.stored()!)).toEqual(r.result);
  });

  it("matches only in the control windows: a fail", async () => {
    const r = await runFillCheck(harness({ fetcher: printsAt(300) }).deps);
    expect(r.state === "done" && r.result.verdict).toBe("fail");
  });

  it("too few: 2 sessions", async () => {
    const r = await runFillCheck(harness({ doc: journal(2, 20) }).deps);
    expect(r.state === "done" && r.result.verdict).toBe("too_few");
  });

  it("every requested span ends at the unit's time + 5 min 10 s, and starts 5 min 10 s before", async () => {
    const h = harness();
    await runFillCheck(h.deps);
    expect(h.queries).toHaveLength(80);
    for (const q of h.queries) expect(q.endMs - q.startMs).toBe(620_000);
    const first = h.queries.find((q) => q.symbol === "ABC261218C00050000" && q.startMs < Date.parse("2026-11-02T16:00:00Z"))!;
    expect(new Date(first.endMs).toISOString()).toBe("2026-11-02T15:15:10.000Z");
    expect(new Date(first.startMs).toISOString()).toBe("2026-11-02T15:04:50.000Z");
  });

  it("a second run returns the first result without fetching", async () => {
    const h = harness();
    const first = await runFillCheck(h.deps);
    const asked = h.queries.length;
    const second = await runFillCheck(h.deps);
    expect(h.queries.length).toBe(asked);
    expect(h.writes).toBe(1);
    expect(second.state === "done" && second.fresh).toBe(false);
    expect(second.state === "done" && second.result).toEqual(first.state === "done" && first.result);
  });

  it("a stored document that is not a result is never replaced", async () => {
    const h = harness({ stored: '{"hello":1}' });
    expect(await runFillCheck(h.deps)).toEqual({ state: "error", reason: "store" });
    expect(h.queries).toHaveLength(0);
    expect(h.stored()).toBe('{"hello":1}');
  });

  it("a transport failure after its retries: nothing stored, retry", async () => {
    let calls = 0;
    const flaky: TradeFetcher = async (q) => {
      calls++;
      if (q.symbol === "ABC261218P00051000") throw new TradesFetchError(true, 503);
      return printsAt(2)(q);
    };
    const h = harness({ fetcher: flaky });
    expect(await runFillCheck(h.deps)).toEqual({ state: "retry" });
    expect(h.stored()).toBeNull();
    expect(h.writes).toBe(0);
    expect(calls).toBeLessThan(80 + 3);
  });

  it("a failure that is not retryable stops at once, and a transient one is retried", async () => {
    let n = 0;
    const once: TradeFetcher = async (q) => {
      if (n++ === 0) throw new TradesFetchError(true, 429);
      return printsAt(2)(q);
    };
    expect((await runFillCheck(harness({ fetcher: once }).deps)).state).toBe("done");
    let m = 0;
    const refused: TradeFetcher = async () => {
      m++;
      throw new TradesFetchError(false, 403);
    };
    const h = harness({ fetcher: refused });
    expect(await runFillCheck(h.deps)).toEqual({ state: "retry" });
    expect(m).toBeLessThanOrEqual(CONCURRENCY);
    expect(h.stored()).toBeNull();
  });

  it("the abort depends on transport only: a run with no match at all still stores", async () => {
    const h = harness({ fetcher: async () => ({ kind: "prints", prints: [] }) });
    const r = await runFillCheck(h.deps);
    expect(r.state === "done" && r.result.overall.opening.not_checked.no_prints).toBe(40);
    expect(r.state === "done" && r.result.verdict).toBe("too_few");
    expect(h.stored()).not.toBeNull();
  });

  it("the page cap: the unit is not checked, answer incomplete", async () => {
    const r = await runFillCheck(harness({ fetcher: async () => ({ kind: "incomplete" }) }).deps);
    expect(r.state === "done" && r.result.overall.opening.not_checked.incomplete).toBe(40);
  });

  it("a lost create-only race returns the stored result", async () => {
    const other = await runFillCheck(harness({ fetcher: printsAt(300) }).deps);
    const theirs = JSON.stringify(other.state === "done" && other.result);
    const h = harness();
    // The other run lands between this run's first read and its write.
    let reads = 0;
    h.deps.readStored = async () => (reads++ === 0 ? null : theirs);
    h.deps.writeStored = async () => {
      throw new PreconditionFailed();
    };
    const lines = await logged(async () => {
      const r = await runFillCheck(h.deps);
      expect(r.state === "done" && r.fresh).toBe(false);
      // The stored document, never this run's own (which would have passed).
      expect(r.state === "done" && r.result.verdict).toBe("fail");
    });
    expect(lines).toEqual([expect.objectContaining({ outcome: "lost-race" })]);
    expect(Object.keys(lines[0]!).sort()).toEqual(["at", "evt", "outcome"]);
  });

  it("a write that fails for another reason: retry", async () => {
    expect(await runFillCheck(harness({ writeError: new Error("boom") }).deps)).toEqual({ state: "retry" });
  });

  it("an unreadable journal stores nothing", async () => {
    const h = harness({ journalOk: false });
    expect(await runFillCheck(h.deps)).toEqual({ state: "error", reason: "journal" });
    expect(h.writes).toBe(0);
  });

  it("no keys: not configured, nothing stored", async () => {
    const h = harness({ keys: false });
    expect(await runFillCheck(h.deps)).toEqual({ state: "error", reason: "not_configured" });
    expect(h.writes).toBe(0);
  });

  it("the result's keys are exactly these, all the way down", async () => {
    // Prints at both the entry and the exit price, so every side has offsets and every key is present.
    const both: TradeFetcher = async (q) => {
      const a = (await printsAt(2, 1.2)(q)) as Extract<TradeAnswer, { kind: "prints" }>;
      const b = (await printsAt(3, 1.5)(q)) as Extract<TradeAnswer, { kind: "prints" }>;
      return { kind: "prints", prints: [...a.prints, ...b.prints] };
    };
    const h = harness({ fetcher: both });
    await runFillCheck(h.deps);
    const paths = new Set<string>();
    const walk = (v: unknown, at: string) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, `${at}[]`));
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          const p = at ? `${at}.${k}` : k;
          paths.add(p);
          walk(x, p);
        }
    };
    walk(JSON.parse(h.stored()!), "");
    const reasons = ["open_lot", "no_time", "no_times", "adjusted", "no_prints", "incomplete", "unreadable"];
    const side = (at: string) => [
      at,
      ...["checked", "matched", "early", "late", "true_rate", "control_rate", "offset_s", "not_checked"].map((k) => `${at}.${k}`),
      ...["n", "median", "p10", "p90"].map((k) => `${at}.offset_s.${k}`),
      ...reasons.map((r) => `${at}.not_checked.${r}`),
    ];
    const want = [
      "state", "format", "run_at", "fixture", "unknown_codes", "verdict",
      "sessions", "sessions[].day", ...side("sessions[].opening"), ...side("sessions[].closing"),
      "overall", "overall.sessions_checked", ...side("overall.opening"), ...side("overall.closing"),
    ];
    expect([...paths].sort()).toEqual([...new Set(want)].sort());
    const banned = /price|pnl|profit|loss|win|strike|expiry|symbol|contract|entry|exit|^r(25|50)?$/i;
    expect([...paths].filter((p) => banned.test(p.split(".").at(-1)!))).toEqual([]);
  });

  it("no value of the result carries the journal's symbol, strike, prices, contract or pnl", async () => {
    const trades = DAYS.slice(0, 4).flatMap((d, k) =>
      [0, 1, 2].map((i) => ({ id: `${d}-${i}`, symbol: "ZQXW", kind: "call", strike: 987.5, expiry: "2026-12-18", side: "long", qty: 1, opened_at: `${d}T15:1${i}:00.000Z`, closed_at: `${d}T16:1${i}:00.000Z`, entry: 3.21, exit: 4.32, multiplier: 100, pnl: 111 + k, close: "order" })),
    );
    const h = harness({ doc: { schema: "stocksdelta/journal", trades, open: [] }, fetcher: printsAt(2, 3.21) });
    const r = await runFillCheck(h.deps);
    expect(r.state === "done" && r.result.overall.opening.checked).toBe(12);
    const strings: string[] = [];
    const numbers: number[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "number") numbers.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(h.stored()!));
    const occ = "ZQXW261218C00987500";
    for (const t of strings) for (const bad of ["ZQXW", occ, "987.5", "987500", "3.21", "4.32", "321", "432", "111", "112", "113", "114"]) expect(t).not.toContain(bad);
    for (const x of numbers) expect([987.5, 987_500, 3.21, 4.32, 3_210_000, 4_320_000, 321, 432, 111, 112, 113, 114, 11_100]).not.toContain(x);
    expect(h.stored()).not.toContain("ZQXW");
  });
});

describe("rate limits, the budget and the fixed sessions", () => {
  it("a 429 is retried after its Retry-After, bounded, for as long as the budget allows", async () => {
    let n = 0;
    const limited: TradeFetcher = async (q) => {
      n++;
      if (n <= 6) throw new TradesFetchError(true, 429, n === 1 ? 3_600_000 : n === 2 ? null : 7000);
      return printsAt(2)(q);
    };
    const h = harness({ fetcher: limited });
    const r = await runFillCheck(h.deps);
    expect(r.state).toBe("done");
    expect(h.sleeps).toContain(MAX_RETRY_AFTER_MS);
    expect(h.sleeps).toContain(5_000);
    expect(h.sleeps).toContain(7000);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
  });

  it("a 429 that never ends: retry once the budget is spent, nothing stored, no outcome logged", async () => {
    const h = harness({ fetcher: async () => Promise.reject(new TradesFetchError(true, 429, 10_000)) });
    const lines = await logged(async () => expect(await runFillCheck(h.deps)).toEqual({ state: "retry" }));
    expect(h.queries.length).toBeGreaterThan(3);
    expect(h.clock.ms - NOW.getTime()).toBeLessThanOrEqual(RUN_BUDGET_MS);
    expect(h.stored()).toBeNull();
    expect(lines.map((l) => Object.keys(l).sort())).toEqual([["at", "evt", "outcome"]]);
  });

  it("requests are paced under the per-minute limit", async () => {
    const h = harness({ doc: journal(10, 10) });
    const r = await runFillCheck(h.deps);
    expect(r.state).toBe("done");
    expect(h.queries).toHaveLength(200);
    // 200 calls at 180 a minute: the last 20 wait for the first minute to pass.
    expect(h.clock.ms - NOW.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  it("one signal at the deadline: a request still open when the budget ends is cut, and nothing is stored", async () => {
    const hang: TradeFetcher = (_q, signal) => new Promise((_res, rej) => signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    const h = harness({ fetcher: hang });
    h.deps.budgetMs = 30;
    expect(await runFillCheck(h.deps)).toEqual({ state: "retry" });
    expect(h.stored()).toBeNull();
  });

  it("the route allows 300 s and the run's budget stays inside it", () => {
    expect(maxDuration).toBe(300);
    expect(RUN_BUDGET_MS).toBeLessThan(maxDuration * 1000);
    expect(RUN_BUDGET_MS).toBeGreaterThanOrEqual(270_000);
  });

  it("the sessions are stored at the first attempt, before any print, and reused after a retry", async () => {
    let fail = true;
    const sometimes: TradeFetcher = async (q) => {
      if (fail) throw new TradesFetchError(false, 403);
      return printsAt(2)(q);
    };
    const h = harness({ fetcher: sometimes, doc: journal(3, 10) });
    let sessionsWhenFirstAsked: string | null = null;
    const inner = h.deps.trades;
    h.deps.trades = (units) => {
      const f = inner(units);
      return (q, sig) => {
        sessionsWhenFirstAsked ??= h.sessions();
        return f(q, sig);
      };
    };
    expect(await runFillCheck(h.deps)).toEqual({ state: "retry" });
    expect(sessionsWhenFirstAsked).not.toBeNull();
    expect(parseSessions(h.sessions()!)).toEqual(["2026-11-04", "2026-11-03", "2026-11-02"]);
    // A newer session is now in the journal; the next attempt checks the same dates.
    fail = false;
    const later = harness({ doc: journal(5, 10), sessions: h.sessions() });
    const r = await runFillCheck(later.deps);
    expect(r.state === "done" && r.result.sessions.map((x) => x.day)).toEqual(["2026-11-04", "2026-11-03", "2026-11-02"]);
    expect(r.state === "done" && r.result.overall.opening.checked).toBe(30);
  });

  it("a lost race on the session list uses the stored list", async () => {
    const h = harness();
    const theirs = JSON.stringify({ format: 1, sessions: ["2026-11-02"] });
    let reads = 0;
    h.deps.readSessions = async () => (reads++ === 0 ? null : theirs);
    h.deps.writeSessions = async () => {
      throw new PreconditionFailed();
    };
    const r = await runFillCheck(h.deps);
    expect(r.state === "done" && r.result.sessions.map((x) => x.day)).toEqual(["2026-11-02"]);
  });

  it("an unreadable session list stops the run with nothing fetched", async () => {
    const h = harness({ sessions: '{"format":1,"sessions":["2026-02-30"]}' });
    expect(await runFillCheck(h.deps)).toEqual({ state: "error", reason: "store" });
    expect(h.queries).toHaveLength(0);
    expect(parseSessions('{"format":1,"sessions":["2026-11-02","2026-11-02"]}')).toBeNull();
    expect(parseSessions('{"format":1,"sessions":[]}')).toEqual([]);
  });

  it("the outcome is logged only once stored; a failed write logs the word alone and answers no result of its own", async () => {
    const ok = harness();
    const done = await logged(() => runFillCheck(ok.deps));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ outcome: "done", verdict: "pass", opening_checked: 40 });
    const bad = harness({ writeError: new Error("boom") });
    const lines = await logged(async () => expect(await runFillCheck(bad.deps)).toEqual({ state: "retry" }));
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!).sort()).toEqual(["at", "evt", "outcome"]);
    expect(lines[0]!.outcome).toBe("write-error");
  });

  it("a write that fails while another run's result is stored answers that one", async () => {
    const other = await runFillCheck(harness({ fetcher: printsAt(300) }).deps);
    const theirs = JSON.stringify(other.state === "done" && other.result);
    const h = harness({ writeError: new Error("boom") });
    let reads = 0;
    h.deps.readStored = async () => (reads++ === 0 ? null : theirs);
    const lines = await logged(async () => {
      const r = await runFillCheck(h.deps);
      expect(r.state === "done" && r.result.verdict).toBe("fail");
    });
    expect(lines.map((l) => Object.keys(l).sort())).toEqual([["at", "evt", "outcome"]]);
  });
});

describe("fixture mode and anywhere but production", () => {
  it("never calls the network and never touches the store; the result is marked fixture and kept in memory", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const net = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", net);
    const deps = defaultFillCheckDeps();
    expect(deps.memory).toBe(true);
    const r = await runFillCheck({ ...deps, now: () => NOW });
    expect(r.state).toBe("done");
    expect(r.state === "done" && r.result.fixture).toBe(true);
    expect(r.state === "done" && r.result.overall.opening.checked).toBeGreaterThan(0);
    expect(net).not.toHaveBeenCalled();
    const again = await runFillCheck(defaultFillCheckDeps());
    expect(again.state === "done" && again.fresh).toBe(false);
    expect(net).not.toHaveBeenCalled();
  });

  it("only production, outside fixture mode, uses the store", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(defaultFillCheckDeps().memory).toBe(false);
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    expect(defaultFillCheckDeps().memory).toBe(true);
  });

  it("in production, prints are asked for only with keys and Alpaca's own data URL", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ALPACA_API_KEY_ID", "kid");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "ksecret");
    vi.stubEnv("ALPACA_DATA_URL", "");
    expect(defaultFillCheckDeps().configured()).toBe(true);
    vi.stubEnv("ALPACA_DATA_URL", "https://data.example");
    expect(defaultFillCheckDeps().configured()).toBe(false);
    vi.stubEnv("ALPACA_DATA_URL", "https://data.sandbox.alpaca.markets");
    expect(defaultFillCheckDeps().configured()).toBe(true);
    vi.stubEnv("ALPACA_API_KEY_ID", "");
    vi.stubEnv("APCA_API_KEY_ID", "");
    expect(defaultFillCheckDeps().configured()).toBe(false);
  });

  it("the synthetic prints are the same on every run", async () => {
    const u: Unit = { side: "opening", day: "2026-11-10", occ: "ABC261218C00050000", atNs: stampNs("2026-11-10T15:00:00.000Z")!, priceMicro: 1_200_000 };
    const q = { symbol: u.occ, ...requestSpan(u) };
    const a = await syntheticTrades([u])(q);
    const b = await syntheticTrades([u])(q);
    expect(a).toEqual(b);
  });
});

describe("the fetch", () => {
  const Q: TradeQuery = { symbol: "ABC261218C00050000", ...requestSpan({ atNs: stampNs("2026-11-10T15:00:00.000Z")! }) };
  const keys = { id: "kid", secret: "ksecret" };
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("asks for the span's own bounds, no feed, sorted, and sends the keys only in headers", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return answer({ trades: { [Q.symbol]: [{ t: "2026-11-10T15:00:01.123456789Z", x: "C", p: 1.2, s: 1, c: "I" }] }, next_page_token: null });
    });
    const r = await fetchOptionTrades(Q, { keys, fetchImpl: f as unknown as typeof fetch, baseUrl: "https://data.sandbox.alpaca.markets" });
    expect(r).toEqual({ kind: "prints", prints: [{ t: "2026-11-10T15:00:01.123456789Z", p: 1.2, c: "I" }] });
    const u = new URL(seen[0]!.url);
    expect(u.origin + u.pathname).toBe("https://data.sandbox.alpaca.markets/v1beta1/options/trades");
    expect(u.searchParams.get("end")).toBe("2026-11-10T15:05:10.000Z");
    expect(u.searchParams.get("start")).toBe("2026-11-10T14:54:50.000Z");
    expect(u.searchParams.get("symbols")).toBe(Q.symbol);
    expect(u.searchParams.get("sort")).toBe("asc");
    expect(u.searchParams.has("feed")).toBe(false);
    expect(seen[0]!.url).not.toMatch(/kid|ksecret/);
    expect(seen[0]!.init.redirect).toBe("error");
  });

  it("follows page tokens and stops at the cap: answer incomplete", async () => {
    const urls: string[] = [];
    const paging = async (url: string | URL | Request) => {
      urls.push(String(url));
      return answer({ trades: { [Q.symbol]: [] }, next_page_token: `tok${urls.length}` });
    };
    const r = await fetchOptionTrades(Q, { keys, fetchImpl: paging as unknown as typeof fetch });
    expect(r).toEqual({ kind: "incomplete" });
    expect(urls).toHaveLength(MAX_PAGES);
    expect(new URL(urls[1]!).searchParams.get("page_token")).toBe("tok1");
    for (const u of urls) expect(new URL(u).searchParams.get("end")).toBe("2026-11-10T15:05:10.000Z");
  });

  it("two pages then done", async () => {
    let k = 0;
    const two = async () => (k++ === 0 ? answer({ trades: { [Q.symbol]: [{ t: "a", p: 1 }] }, next_page_token: "n" }) : answer({ trades: { [Q.symbol]: [{ t: "b", p: 2 }] } }));
    const r = (await fetchOptionTrades(Q, { keys, fetchImpl: two as unknown as typeof fetch })) as Extract<TradeAnswer, { kind: "prints" }>;
    expect(r.prints.map((p: RawPrint) => p.t)).toEqual(["a", "b"]);
  });

  it("no trades for the contract is an empty answer", async () => {
    const r = await fetchOptionTrades(Q, { keys, fetchImpl: (async () => answer({ trades: {}, next_page_token: null })) as unknown as typeof fetch });
    expect(r).toEqual({ kind: "prints", prints: [] });
  });

  it("errors: transport, 429 and 5xx are retryable; 4xx and a wrong shape are not; nothing secret in the error", async () => {
    const run = (impl: () => Promise<Response>) => fetchOptionTrades(Q, { keys, fetchImpl: impl as unknown as typeof fetch }).catch((e: unknown) => e);
    const t = (await run(async () => Promise.reject(new TypeError("fetch failed")))) as TradesFetchError;
    expect([t.retryable, t.status]).toEqual([true, null]);
    expect(((await run(async () => answer({}, 429))) as TradesFetchError).retryable).toBe(true);
    expect(((await run(async () => answer({}, 502))) as TradesFetchError).retryable).toBe(true);
    const forbidden = (await run(async () => answer({ message: "ksecret" }, 403))) as TradesFetchError;
    expect(forbidden.retryable).toBe(false);
    expect(forbidden.message).not.toMatch(/ksecret|kid/);
    expect(((await run(async () => answer({ trades: [] }))) as TradesFetchError).retryable).toBe(false);
    expect(((await run(async () => new Response("not json"))) as TradesFetchError).retryable).toBe(true);
  });

  it("a data URL that is not Alpaca's never gets the keys", async () => {
    const f = vi.fn(async () => answer({ trades: {} }));
    for (const baseUrl of ["https://data.example", "http://data.alpaca.markets", "https://u:p@data.alpaca.markets", "https://data.alpaca.markets:8443", "https://alpaca.markets.evil.test"]) {
      const e = (await fetchOptionTrades(Q, { keys, fetchImpl: f as unknown as typeof fetch, baseUrl }).catch((x: unknown) => x)) as TradesFetchError;
      expect(e).toBeInstanceOf(TradesFetchError);
      expect(e.retryable).toBe(false);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("a 429 carries Alpaca's Retry-After", async () => {
    const e = (await fetchOptionTrades(Q, { keys, fetchImpl: (async () => new Response("{}", { status: 429, headers: { "retry-after": "7" } })) as unknown as typeof fetch }).catch((x: unknown) => x)) as TradesFetchError;
    expect([e.status, e.retryAfter, e.retryable]).toEqual([429, 7000, true]);
  });

  it("the run's signal reaches the request", async () => {
    const run = new AbortController();
    run.abort();
    const f = async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return answer({ trades: {} });
    };
    const e = (await fetchOptionTrades(Q, { keys, fetchImpl: f as unknown as typeof fetch, signal: run.signal }).catch((x: unknown) => x)) as TradesFetchError;
    expect(e).toBeInstanceOf(TradesFetchError);
  });

  it("the URL builder takes the span as given", () => {
    const u = new URL(tradesUrl("https://x.test", Q, "p"));
    expect(u.searchParams.get("page_token")).toBe("p");
    expect(u.searchParams.get("limit")).toBe("10000");
    expect(PAGE_LIMIT * MAX_PAGES).toBe(50_000);
  });
});

describe("the route", () => {
  const URL_ = "https://site.test/api/desk/fill-check";
  const post = (body: string, headers: Record<string, string> = {}, url = URL_) =>
    new Request(url, { method: "POST", body, headers: { host: "site.test", origin: "https://site.test", "content-type": "application/json", ...headers } });
  const CONFIRM = '{"confirm":"run-once"}';

  it("GET before a run: not_run; after: the stored result; no-store", async () => {
    const h = harness();
    const g = await handleFillCheck(new Request(URL_), h.deps);
    expect(await g.json()).toEqual({ state: "not_run" });
    expect(g.headers.get("cache-control")).toBe("no-store");
    const p = await handleFillCheck(post(CONFIRM), h.deps);
    expect(p.status).toBe(200);
    expect(p.headers.get("cache-control")).toBe("no-store");
    const body = (await p.json()) as { state: string; verdict: string };
    expect(body).toMatchObject({ state: "done", verdict: "pass" });
    expect(await (await handleFillCheck(new Request(URL_), h.deps)).json()).toEqual(body);
  });

  it("POST refusals: cross-site, not JSON, too large, wrong body, the bypass; nothing is run", async () => {
    const h = harness();
    const cases: [Request, number][] = [
      [post(CONFIRM, { origin: "https://evil.test" }), 403],
      [post(CONFIRM, { "sec-fetch-site": "cross-site" }), 403],
      [new Request(URL_, { method: "POST", body: CONFIRM, headers: { host: "site.test", "content-type": "application/json" } }), 403],
      [post(CONFIRM, { "content-type": "text/plain" }), 415],
      [post(`{"confirm":"run-once","pad":"${"x".repeat(100)}"}`), 413],
      [post('{"confirm":"yes"}'), 400],
      [post('{"confirm":"run-once","also":1}'), 400],
      [post("[]"), 400],
      [post("not json"), 400],
      [post(""), 400],
      [post(CONFIRM, { "x-vercel-protection-bypass": "s" }), 403],
      [post(CONFIRM, {}, `${URL_}?x-vercel-protection-bypass=s`), 403],
      [post(CONFIRM, { "x-vercel-set-bypass-cookie": "true" }), 403],
    ];
    for (const [req, status] of cases) {
      const res = await handleFillCheck(req, h.deps);
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(h.queries).toHaveLength(0);
    expect(h.writes).toBe(0);
  });

  it("GET refusals: cross-site and the bypass; other methods 405", async () => {
    const h = harness();
    expect((await handleFillCheck(new Request(URL_, { headers: { "sec-fetch-site": "cross-site" } }), h.deps)).status).toBe(403);
    expect((await handleFillCheck(new Request(URL_, { headers: { "x-vercel-protection-bypass": "s" } }), h.deps)).status).toBe(403);
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await handleFillCheck(new Request(URL_, { method }), h.deps);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    }
    const head = await handleFillCheck(new Request(URL_, { method: "HEAD" }), h.deps);
    expect(head.status).toBe(200);
  });

  it("a transport failure answers 503 retry; an unreadable stored document answers 503 on GET", async () => {
    const h = harness({ fetcher: async () => Promise.reject(new TradesFetchError(true, null)) });
    const res = await handleFillCheck(post(CONFIRM), h.deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ state: "retry" });
    expect((await handleFillCheck(new Request(URL_), harness({ stored: "{" }).deps)).status).toBe(503);
  });

  it("the body is exactly the confirmation", () => {
    expect(parseConfirm(CONFIRM)).toBe(true);
    expect(parseConfirm('{"confirm":"RUN-ONCE"}')).toBe(false);
    expect(parseConfirm("null")).toBe(false);
  });

  it("stores at the one fixed path", () => {
    expect(FILL_CHECK_PATH).toBe("desk/fill-check/run-1.json");
    expect(SESSIONS_PATH).toBe("desk/fill-check/sessions-1.json");
  });
});
