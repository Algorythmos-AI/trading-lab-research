// The desk cron's signal step (DEC-0051 section 3, signal-run.ts) and its record (signal-record.ts), on in-memory
// stores and synthetic SIP and OPRA answers built by the fixture helpers: the switch, the DEC-0044 record left
// byte-identical in every mode, the step's own budget and errors, the board-feed stamp's covering rule at its edges,
// the blind (no name outside the focus list is asked for or stored), dry records with no word, create-only writes and
// their retry, `follow`, and the words while nothing is frozen. Nothing here reads a journal, a ledger or an outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeBlobSdk } from "./blob-sdk";
import { PreconditionFailed } from "@/lib/blob";
import type { BarsResponse } from "@/lib/bars";
import { fixtureChain } from "@/lib/chain-route";
import { BAR_MS } from "@/lib/desk-eval";
import { type DeskRunDeps, type LoggedSlot, runDeskEval } from "@/lib/desk-run";
import { focusOptions } from "@/lib/fixture-variants";
import { fixtureBars, fixtureBaseline, resetFlowCache, type ServerFlow, serverFlow, FlowUnavailable } from "@/lib/flow-route";
import type { Options } from "@/lib/options";
import { resetQuoteCache } from "@/lib/quote";
import { parseSignalRecord, parseSignalSwitch, signalLogPath, type LogSignalRecord, type SignalRecord, writeMode } from "@/lib/signal-record";
import { buildSignalRecord, HISTORY_UNUSABLE, judgeStamp, runSignalStep, type SignalDeps, type StampRead, stampKeysFor } from "@/lib/signal-run";
import type { Bar2 } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, EDT
const OPEN = Date.parse(`${S}T13:30:00Z`);
const ny = (hhmmss: string) => Date.parse(`${S}T${hhmmss}-04:00`);
const FOCUS = E.focus!.items.map((i) => i.symbol); // SPY, QQQ, AAPL
const OTHERS = E.tickers.map((t) => t.symbol).filter((s) => !FOCUS.includes(s));
const EVAL_ON = '{"v":1,"eval":"log"}';
const sw = (v: string) => `{"v":1,"signal":"${v}"}`;
const RUN_AT = ny("10:31:01");
const SLOT = ny("10:30:00");

// ---- DEC-0044's run, as desk-run.test.ts drives it ------------------------------------------------------------------
function bars(at: number, ed: Options = E): Record<string, Bar2[]> {
  const out: Record<string, Bar2[]> = {};
  for (const s of ed.focus!.items.map((i) => i.symbol)) {
    const c = ed.focus!.items.find((i) => i.symbol === s)!.close ?? 100;
    const list: Bar2[] = [];
    for (let start = OPEN; start < at; start += BAR_MS) list.push({ start, end: start + BAR_MS, o: c, h: c + 0.1, l: c - 0.1, c });
    out[s] = list;
  }
  return out;
}

function deskDeps(store: Map<string, string>, clock: number = RUN_AT, ed: Options = E): DeskRunDeps {
  return {
    now: () => clock,
    dry: false,
    readSwitch: async () => store.get("desk/eval.json") ?? null,
    exists: async (p) => store.has(p),
    write: async (p, body) => {
      if (store.has(p)) throw new PreconditionFailed();
      store.set(p, body);
    },
    loadEdition: async () => ({ status: "ok", edition: ed }),
    loadJournal: async () => null,
    readDone: async () => ({ status: "ok", doc: { v: 1, done: null }, memory: false }),
    fetchBars: async (symbols, o): Promise<BarsResponse> => {
      const t = o.now.getTime();
      const b = bars(t, ed);
      return { as_of: o.now.toISOString(), feed: "sip", bars: Object.fromEntries(symbols.map((s) => [s, b[s]!])), fetchedAt: Object.fromEntries(symbols.map((s) => [s, t])), missing: [] };
    },
    fetchSnapshots: async (symbols, o) => {
      const t = o.now.getTime();
      const b = bars(t, ed);
      const quotes = Object.fromEntries(
        symbols.map((s) => {
          const last = b[s]!.at(-1)!;
          return [s, { price: last.c, at: new Date(t - 1_000).toISOString(), open: last.o, high: last.h, low: last.l, day: S, prev_close: null, vwap: null }];
        }),
      );
      return { as_of: o.now.toISOString(), feed: "sip", quotes, missing: [] };
    },
  };
}

/** DEC-0044's run for the slot, and what it handed over. */
async function deskRun(store: Map<string, string>, clock: number = RUN_AT, ed: Options = E): Promise<{ logged: LoggedSlot | null; outcome: string }> {
  let logged = null as LoggedSlot | null;
  const r = await runDeskEval(deskDeps(store, clock, ed), (x) => {
    logged = x;
  });
  return { logged, outcome: r.outcome };
}

// ---- the signal step's inputs ---------------------------------------------------------------------------------------
/** A SIP flow answer for the names at `now`: the fixture's bars and a 20-session baseline with ranges. */
function flowAt(symbols: readonly string[], now: number): ServerFlow {
  const names: ServerFlow["names"] = {};
  symbols.forEach((sym, i) => {
    const b = fixtureBars(sym, i, S, now);
    const price = b.at(-1)!.c;
    names[sym] = {
      price,
      trade_at: new Date(now - 1_000).toISOString(),
      bid: Math.round((price - 0.01) * 100) / 100,
      ask: Math.round((price + 0.01) * 100) / 100,
      bid_size: 3,
      ask_size: 4,
      quote_at: new Date(now - 1_000).toISOString(),
      day_volume: null,
      bars: b,
    };
  });
  return { as_of: new Date(now).toISOString(), feed: "sip", baseline: fixtureBaseline(symbols, S, new Set()), names, missing: [] };
}

interface Calls {
  switch: number;
  exists: number;
  write: number;
  list: number;
  read: number;
  stamps: number;
  flow: string[][];
  chain: { symbol: string; keep: unknown }[];
}

/** A signal step on an in-memory store, its clock running from the slot's run on. */
function signalDeps(store: Map<string, string>, over: Partial<SignalDeps> & { at?: number } = {}) {
  const base = over.at ?? RUN_AT + 4_000;
  const real0 = Date.now();
  const calls: Calls = { switch: 0, exists: 0, write: 0, list: 0, read: 0, stamps: 0, flow: [], chain: [] };
  const now = () => base + (Date.now() - real0);
  const deps: SignalDeps = {
    now,
    readSwitch: async () => {
      calls.switch++;
      return store.get("desk/signal.json") ?? null;
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
    list: async (prefix) => {
      calls.list++;
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    read: async (p) => {
      calls.read++;
      return store.get(p) ?? null;
    },
    readStamps: async (_day, keys) => {
      calls.stamps++;
      return keys.flatMap((key) => (store.has(key) ? [{ key, ...(JSON.parse(store.get(key)!) as Omit<StampRead, "key">) }] : []));
    },
    fetchFlow: async (symbols) => {
      calls.flow.push([...symbols]);
      return flowAt(symbols, now() - 500);
    },
    fetchChain: async (symbol, _px, keep) => {
      calls.chain.push({ symbol, keep });
      return fixtureChain(symbol, new Date(now() - 200), false, keep, "opra");
    },
    ...over,
  };
  return { deps, calls };
}

/** The stamp the run's first step writes, in the store. */
const putStamp = (store: Map<string, string>, at: number, feed = "sip", answered = "ok") => {
  const m = new Date(at);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(m).replace(":", "");
  store.set(`desk/feeds/board/${S}/${hhmm}.json`, JSON.stringify({ feed, answered, at: m.toISOString() }));
};

const signalOf = (store: Map<string, string>, end = SLOT): SignalRecord | null => {
  const t = store.get(signalLogPath(S, end));
  return t ? parseSignalRecord(t) : null;
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  resetFlowCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetQuoteCache();
});

// ---- the switch -----------------------------------------------------------------------------------------------------
describe("the switch, desk/signal.json", () => {
  it("is off when missing or malformed, and reads exactly the four words otherwise", () => {
    for (const bad of [null, undefined, "", "{", "[]", "null", '{"v":1}', '{"v":2,"signal":"log"}', '{"v":1,"signal":"on"}', '{"v":1,"signal":"log","why":"x"}', '{"signal":"log"}', `{"v":1,"signal":"log"${" ".repeat(260)}}`, 42])
      expect(parseSignalSwitch(bad)).toBe("off");
    for (const v of ["off", "dry", "log", "show"] as const) expect(parseSignalSwitch(sw(v))).toBe(v);
    expect(writeMode("off")).toBeNull();
    expect(writeMode("dry")).toBe("dry");
    expect(writeMode("log")).toBe("log");
    expect(writeMode("show")).toBe("log"); // show writes exactly what log writes; nothing is shown by this step
  });

  it("missing, off or unreadable writes nothing and asks for nothing else", async () => {
    for (const v of [undefined, sw("off"), "{"]) {
      const store = new Map([["desk/eval.json", EVAL_ON]]);
      if (v !== undefined) store.set("desk/signal.json", v);
      const { logged } = await deskRun(store);
      const { deps, calls } = signalDeps(store);
      expect(await runSignalStep(logged, deps)).toBe("off");
      expect({ ...calls, switch: 0 }).toEqual({ switch: 0, exists: 0, write: 0, list: 0, read: 0, stamps: 0, flow: [], chain: [] });
      expect([...store.keys()].some((k) => k.startsWith("desk/signal/"))).toBe(false);
    }
    const store = new Map([["desk/eval.json", EVAL_ON]]);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store, { readSwitch: () => Promise.reject(new Error("store down")) });
    expect(await runSignalStep(logged, deps)).toBe("off");
  });

  it("the deployed step touches nothing outside production or in fixture mode", async () => {
    const { defaultSignalDeps } = await import("@/lib/signal-run");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const d = defaultSignalDeps();
    expect(await d.readSwitch()).toBeNull();
    await expect(d.write("x", "y")).rejects.toThrow();
    await expect(d.fetchFlow(["SPY"], E)).rejects.toThrow();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    expect(await defaultSignalDeps().readSwitch()).toBeNull();
  });
});

// ---- DEC-0044 untouched ---------------------------------------------------------------------------------------------
describe("DEC-0044's record", () => {
  // Every edition fixture the desk tests build (the fixture edition with and without its scripted focus card, and with
  // the plain edition's empty focus list), over slots across the session: the open, mid-morning, the lunch block, the
  // close, and a half-day-free late slot, for every switch value.
  const EDITIONS: Options[] = [E, focusOptions(optionsJson as unknown as Options, false), { ...(optionsJson as unknown as Options) }, { ...E, session: "2026-10-09" }];
  const CLOCKS = ["09:33:01", "10:31:01", "12:15:01", "15:57:01"].map(ny);
  it("is byte-identical, with the same evaluated_at, whatever the signal switch says, over every fixture and slot", async () => {
    let runs = 0;
    for (const ed of EDITIONS)
      for (const clock of CLOCKS) {
        const bare = new Map([["desk/eval.json", EVAL_ON]]);
        const r0 = await runDeskEval(deskDeps(bare, clock, ed));
        expect(r0.outcome).toBe("logged");
        const key = [...bare.keys()].find((k) => k.startsWith("desk/log/"))!;
        const want = bare.get(key)!;
        for (const v of [undefined, "off", "dry", "log", "show", "junk"]) {
          const store = new Map([["desk/eval.json", EVAL_ON]]);
          if (v !== undefined) store.set("desk/signal.json", v === "junk" ? "{" : sw(v));
          putStamp(store, clock);
          const { logged, outcome } = await deskRun(store, clock, ed);
          expect(outcome).toBe("logged");
          expect(logged!.body).toBe(want);
          const { deps } = signalDeps(store, { at: clock + 4_000 });
          const got = await runSignalStep(logged, deps);
          expect(got).toBe(writeMode(parseSignalSwitch(store.get("desk/signal.json") ?? null)) ? "written" : "off");
          expect(store.get(key)).toBe(want);
          expect(JSON.parse(store.get(key)!).evaluated_at).toBe(new Date(clock).toISOString());
          const sig = [...store.entries()].find(([k]) => k.startsWith("desk/signal/"));
          if (sig) {
            const rec = parseSignalRecord(sig[1])!;
            expect(rec.dec0044.key).toBe(key);
            expect(rec.dec0044.evaluated_at).toBe(new Date(clock).toISOString());
          }
          runs++;
        }
      }
    expect(runs).toBe(EDITIONS.length * CLOCKS.length * 6);
  });

  it("the handover never changes the run: a throwing receiver leaves the outcome and the record as they are", async () => {
    const a = new Map([["desk/eval.json", EVAL_ON]]);
    const b = new Map([["desk/eval.json", EVAL_ON]]);
    const ra = await runDeskEval(deskDeps(a));
    const rb = await runDeskEval(deskDeps(b), () => {
      throw new Error("boom");
    });
    expect(rb).toEqual(ra);
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it("only a run that wrote the record hands it over: a second run of the slot, or an eval switch off, hands nothing", async () => {
    const store = new Map([["desk/eval.json", EVAL_ON]]);
    expect((await deskRun(store)).logged).not.toBeNull();
    expect(await deskRun(store, RUN_AT + 60_000)).toEqual({ logged: null, outcome: "already-logged" });
    const off = new Map<string, string>();
    expect(await deskRun(off)).toEqual({ logged: null, outcome: "off" });
    const { deps, calls } = signalDeps(off);
    expect(await runSignalStep(null, deps)).toBe("nothing");
    expect(calls.switch).toBe(0);
  });
});

describe("the real route, with the Blob SDK faked", { timeout: 30_000 }, () => {
  it("answers the same and writes the same DEC-0044 bytes with the signal switch in every mode", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("ALPACA_FEED", "sip");
    for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) vi.stubEnv(k, "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(RUN_AT));
    const { GET } = await import("@/app/api/cron/desk/route");
    const { resetReadCache } = await import("@/lib/blob");
    const seen: { answer: unknown; dec: string; signal: string | undefined }[] = [];
    for (const v of [null, "off", "dry", "log", "show"]) {
      sdk.current.reset();
      resetReadCache();
          sdk.current.write("desk/eval.json", EVAL_ON);
      sdk.current.write("options/latest.json", JSON.stringify(E));
      if (v) sdk.current.write("desk/signal.json", sw(v));
      const res = await GET(new Request("https://desk.example/api/cron/desk", { headers: { authorization: "Bearer s3cret" } }));
      // the step runs after the answer: give it its moment
      await new Promise((r) => setTimeout(r, 100));
      seen.push({ answer: { status: res.status, body: await res.json() }, dec: sdk.current.store.get(`desk/log/${S}/1030.json`)!.text, signal: sdk.current.store.get(signalLogPath(S, SLOT))?.text });
    }
    expect(seen[0]!.dec).toBeDefined();
    for (const s of seen) {
      expect(s.answer).toEqual(seen[0]!.answer);
      expect(s.dec).toBe(seen[0]!.dec);
    }
    expect(seen.map((s) => (s.signal ? parseSignalRecord(s.signal)?.mode : null))).toEqual([null, null, "dry", "log", "log"]);
    // without keys the flow answer is not configured: written as such, never guessed
    expect(parseSignalRecord(seen[2]!.signal!)!.flow_why).toBe("not-configured");
  });

  it("answers before a hung signal step, and a throwing one changes nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.resetModules();
    const result = { ok: true, outcome: "logged", slot: "1030", status: "ok", reason: null };
    vi.doMock("@/lib/desk-run", () => ({ runDeskEval: vi.fn(async (_d: unknown, on: (x: unknown) => void) => (on({}), result)) }));
    vi.doMock("@/lib/board-feed-stamp", () => ({ stampBoardFeed: vi.fn(async () => "closed") }));
    for (const step of [() => new Promise(() => undefined), () => Promise.reject(new Error("boom"))]) {
      vi.doMock("@/lib/signal-run", () => ({ runSignalStep: vi.fn(step) }));
      const { GET } = await import("@/app/api/cron/desk/route");
      const t = Date.now();
      const res = await GET(new Request("https://desk.example/api/cron/desk", { headers: { authorization: "Bearer s3cret" } }));
      expect(Date.now() - t).toBeLessThan(1_000);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
      vi.resetModules();
    }
    vi.doUnmock("@/lib/desk-run");
    vi.doUnmock("@/lib/board-feed-stamp");
    vi.doUnmock("@/lib/signal-run");
  });
});

// ---- the budget and the errors --------------------------------------------------------------------------------------
describe("its own budget and errors", () => {
  it("a hanging flow read is cut at its own limit; the record says so; DEC-0044 is as it was", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    const { logged } = await deskRun(store);
    const before = store.get(logged!.path);
    const { deps, calls } = signalDeps(store, { fetchFlow: () => new Promise(() => undefined), timeoutsMs: { inputs: 40 } });
    const t = Date.now();
    expect(await runSignalStep(logged, deps)).toBe("written");
    expect(Date.now() - t).toBeLessThan(1_000);
    const rec = signalOf(store)!;
    expect(rec.flow).toBeNull();
    expect(rec.flow_why).toBe("timeout");
    expect(calls.chain).toEqual([]); // no price, so no chain is asked for
    expect(rec.names.every((n) => n.sides.every((s) => s.gates.market_direction.pass === null))).toBe(true);
    expect(store.get(logged!.path)).toBe(before);
  });

  it("a step that cannot finish inside its budget writes nothing: a gap", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    const { logged } = await deskRun(store);
    const hang = () => new Promise<never>(() => undefined);
    const { deps, calls } = signalDeps(store, { fetchFlow: hang, readStamps: hang, exists: hang, list: hang, budgetMs: 120 });
    const t = Date.now();
    expect(await runSignalStep(logged, deps)).not.toBe("written");
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(calls.write).toBe(0);
    expect(signalOf(store)).toBeNull();
  });

  it("a throwing chain read leaves that name with no contract and the rest of the record as it is", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store);
    const ok = deps.fetchChain;
    deps.fetchChain = (symbol, px, keep) => (symbol === "AAPL" ? Promise.reject(new Error("upstream 500")) : ok(symbol, px, keep));
    expect(await runSignalStep(logged, deps)).toBe("written");
    const rec = signalOf(store)!;
    const aapl = rec.names.find((n) => n.symbol === "AAPL")!;
    expect(aapl.chain).toBeNull();
    expect(aapl.sides.map((s) => s.gates.contract.value.why)).toEqual(["no-chain", "no-chain"]);
    expect(rec.names.find((n) => n.symbol === "SPY")!.chain).not.toBeNull();
  });

  it("never throws, whatever a dependency does", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    const { logged } = await deskRun(store);
    let n = 0;
    const { deps } = signalDeps(store);
    const real = deps.now;
    deps.now = () => {
      if (++n > 3) throw new Error("clock gone");
      return real();
    };
    expect(await runSignalStep(logged, deps)).toBe("error");
  });

  it("a slot that is no longer the current settled slot is not written", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    const { logged } = await deskRun(store);
    const { deps, calls } = signalDeps(store, { at: SLOT + 3 * 60_000 });
    expect(await runSignalStep(logged, deps)).toBe("late");
    expect(calls.write).toBe(0);
  });
});

// ---- the stamp ------------------------------------------------------------------------------------------------------
describe("the board-feed stamp's covering rule", () => {
  const t0 = RUN_AT;
  const at = (ms: number, feed = "sip", answered = "ok"): StampRead => ({ key: "k", feed, answered, at: new Date(ms).toISOString() });

  it("covers [t0 − 2 min, t0], both ends included, and nothing outside", () => {
    expect(judgeStamp([at(t0 - 120_000)], t0)).toMatchObject({ usable: true });
    expect(judgeStamp([at(t0)], t0)).toMatchObject({ usable: true });
    expect(judgeStamp([at(t0 + 1)], t0)).toEqual({ stamp: null, usable: false });
    expect(judgeStamp([at(t0 - 120_001)], t0)).toEqual({ stamp: null, usable: false });
  });

  it("needs sip with SPY answering ok; a stamp in the window that does not is kept, unusable", () => {
    expect(judgeStamp([at(t0 - 1_000, "iex")], t0)).toMatchObject({ usable: false, stamp: { feed: "iex" } });
    expect(judgeStamp([at(t0 - 1_000, "sip", "stale")], t0)).toMatchObject({ usable: false, stamp: { answered: "stale" } });
    expect(judgeStamp([at(t0 - 1_000, "iex"), at(t0 - 61_000)], t0)).toMatchObject({ usable: true, stamp: { feed: "sip" } });
  });

  it("asks for the keys of t0's minute and the two before only", () => {
    expect(stampKeysFor(S, ny("10:31:01"))).toEqual([`desk/feeds/board/${S}/1029.json`, `desk/feeds/board/${S}/1030.json`, `desk/feeds/board/${S}/1031.json`]);
  });

  it("the record stores the stamp it was judged by, with t0 the DEC-0044 record's evaluated_at", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    putStamp(store, RUN_AT - 200);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store);
    await runSignalStep(logged, deps);
    const rec = signalOf(store)!;
    expect(rec.stamp).toEqual({ key: `desk/feeds/board/${S}/1031.json`, feed: "sip", answered: "ok", at: new Date(RUN_AT - 200).toISOString() });
    expect(rec.stamp_usable).toBe(true);
  });
});

// ---- the blind ------------------------------------------------------------------------------------------------------
describe("picked focus names only (EXP-0032's blind)", () => {
  it("a name outside the focus list is never asked for, worked out or stored", async () => {
    expect(OTHERS.length).toBeGreaterThan(3);
    for (const mode of ["dry", "log"]) {
      const store = new Map([
        ["desk/eval.json", EVAL_ON],
        ["desk/signal.json", sw(mode)],
      ]);
      const { logged } = await deskRun(store);
      const { deps, calls } = signalDeps(store);
      await runSignalStep(logged, deps);
      expect(calls.flow).toEqual([["SPY", "QQQ", "AAPL"]]);
      expect(calls.chain.map((c) => c.symbol).sort()).toEqual([...FOCUS].sort());
      const text = store.get(signalLogPath(S, SLOT))!;
      expect(parseSignalRecord(text)!.names.map((n) => n.symbol)).toEqual(FOCUS);
      for (const o of OTHERS) expect(text).not.toContain(`"${o}`);
    }
  });

  it("the server's flow read refuses a name outside the allowed list before anything is fetched", async () => {
    const fetch = vi.fn();
    await expect(serverFlow(["SPY", "MSFT"], E, { fetch, now: () => new Date(RUN_AT), env: { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" }, baseUrl: "https://data.alpaca.markets" })).rejects.toBeInstanceOf(FlowUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an edition for another session gets no names at all, and nothing is fetched", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    const { logged } = await deskRun(store);
    const other = { ...logged!, edition: { ...E, session: "2026-10-09" } as Options };
    const { deps, calls } = signalDeps(store);
    expect(await runSignalStep(other, deps)).toBe("written");
    expect(calls.flow).toEqual([]);
    expect(calls.chain).toEqual([]);
    const rec = signalOf(store)!;
    expect(rec.names).toEqual([]);
    expect(rec.unusable).toEqual(["the edition is for another session"]);
  });

  it("the deployed reads ask for SIP and OPRA by name, whatever ALPACA_FEED and ALPACA_OPTION_FEED say", async () => {
    const { defaultSignalDeps } = await import("@/lib/signal-run");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("ALPACA_FEED", "iex");
    vi.stubEnv("ALPACA_OPTION_FEED", "indicative");
    vi.stubEnv("ALPACA_API_KEY_ID", "k");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "s");
    vi.stubEnv("ALPACA_DATA_URL", "");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(String(u));
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const d = defaultSignalDeps();
    await d.fetchFlow(["SPY", "QQQ", "AAPL"], { ...E, session: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()) } as Options).catch(() => null);
    await d.fetchChain("AAPL", 250, null).catch(() => null);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const feed = new URL(u).searchParams.get("feed");
      expect(feed).toBe(u.includes("/options/") ? "opra" : "sip");
    }
    expect(urls.some((u) => u.includes("/options/"))).toBe(true);
    expect(urls.some((u) => u.includes("/stocks/"))).toBe(true);
  });
});

// ---- dry and log ----------------------------------------------------------------------------------------------------
describe("the records", () => {
  it("dry holds the gate inputs only: no word, no lifecycle, no state, no break bar, no card", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    putStamp(store, RUN_AT - 1_000);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store);
    expect(await runSignalStep(logged, deps)).toBe("written");
    const text = store.get(signalLogPath(S, SLOT))!;
    const rec = parseSignalRecord(text)!;
    expect(rec.mode).toBe("dry");
    for (const k of ['"word"', '"lifecycle"', '"state"', '"broke_at"', '"card"', '"breaks"', '"follow"', '"scoring"']) expect(text).not.toContain(k);
    for (const n of rec.names) {
      expect(n.sides.map((s) => Object.keys(s))).toEqual([
        ["side", "gates"],
        ["side", "gates"],
      ]);
      // every focus name and side is worked out, whatever the board says, with no break bar
      for (const s of n.sides) expect(s.gates.volume.not_yet).toBe(true);
      expect(n.volume_slot).toBeDefined();
    }
    // the strikes considered keep their OPRA quotes, for Amendment 1's fail shares
    const c = rec.names[0]!.sides[0]!.gates.contract.value;
    expect(c.candidates.length).toBeGreaterThan(0);
    expect(c.candidates[0]).toMatchObject({ bid: expect.any(Number), ask: expect.any(Number), at: expect.any(String) });
    // both indexes' readings and quotes
    expect(rec.context.SPY).toMatchObject({ symbol: "SPY", bid: expect.any(Number), ask: expect.any(Number) });
    expect(rec.context.QQQ).toMatchObject({ symbol: "QQQ" });
    expect(rec.baseline).toMatchObject({ for_session: S, sessions: 20 });
  });

  it("every word is NO TRADE today, and the record says the numbers and the code are not frozen", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    putStamp(store, RUN_AT - 1_000);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store);
    expect(await runSignalStep(logged, deps)).toBe("written");
    const rec = signalOf(store) as LogSignalRecord;
    expect(rec.mode).toBe("log");
    expect(rec.frozen_params_hash).toBeNull();
    expect(rec.frozen_code_hash).toBeNull();
    expect(rec.params_status).toBe("candidate");
    const sides = rec.names.flatMap((n) => n.sides);
    expect(sides).toHaveLength(FOCUS.length * 2);
    for (const s of sides) {
      expect(s.word).toBe("NO TRADE");
      expect(s.against).toContain("data: the signal's numbers are not the frozen ones");
      expect(s.against).toContain("data: the signal's code is not the frozen one");
      expect(s.scoring).toBe("not_usable");
      expect(s.state).not.toBeNull();
    }
    expect(rec.breaks_from).toBeNull();
    expect(rec.follow).toEqual([]);
  });

  it("a slot whose record exists is not rewritten", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    const { logged } = await deskRun(store);
    store.set(signalLogPath(S, SLOT), "already here");
    const { deps, calls } = signalDeps(store);
    expect(await runSignalStep(logged, deps)).toBe("exists");
    expect(calls.write).toBe(0);
    expect(store.get(signalLogPath(S, SLOT))).toBe("already here");
    // and a create-only refusal at the write is the same no-op
    const s2 = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
    ]);
    const r2 = await deskRun(s2);
    const { deps: d2 } = signalDeps(s2, { exists: async () => false });
    const w = d2.write;
    d2.write = async (p, b) => {
      s2.set(p, "raced");
      return w(p, b);
    };
    expect(await runSignalStep(r2.logged, d2)).toBe("exists");
    expect(s2.get(signalLogPath(S, SLOT))).toBe("raced");
  });

  it("a failed or timed-out write is a gap: no later run tries it again", async () => {
    for (const write of [() => Promise.reject(new Error("store 503")), () => new Promise<void>(() => undefined)]) {
      const store = new Map([
        ["desk/eval.json", EVAL_ON],
        ["desk/signal.json", sw("dry")],
      ]);
      const { logged } = await deskRun(store);
      const { deps } = signalDeps(store, { write, timeoutsMs: { write: 30 } });
      expect(["write-failed", "write-timeout"]).toContain(await runSignalStep(logged, deps));
      const later = signalDeps(store, { at: RUN_AT + 60_000 });
      expect(await runSignalStep(null, later.deps)).toBe("nothing");
      expect(later.calls.write + later.calls.switch).toBe(0);
      expect(signalOf(store)).toBeNull();
    }
  });

  it("follow: a break confirmed in an earlier record has its contract quoted again, and the carried breaks stay", async () => {
    // The earlier record: this slot's own log record, re-keyed two minutes back, carrying one confirmed break.
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store);
    await runSignalStep(logged, deps);
    const base = signalOf(store) as LogSignalRecord;
    const chain = await fixtureChain("AAPL", new Date(RUN_AT), false, null, "opra");
    const c = chain.expiries[1]!.contracts.find((k) => k.kind === "call")!;
    const occ = `AAPL${chain.expiries[1]!.date.slice(2).replaceAll("-", "")}C${String(Math.round(c.strike * 1000)).padStart(8, "0")}`;
    const brokeAt = new Date(SLOT - 2 * BAR_MS).toISOString();
    const earlier: LogSignalRecord = {
      ...base,
      slot_end: new Date(SLOT - BAR_MS).toISOString(),
      breaks: [{ symbol: "AAPL", side: "call", broke_at: brokeAt, confirmed_at: new Date(SLOT - BAR_MS).toISOString(), occ, volume_failed_at: null }],
    };
    expect(parseSignalRecord(JSON.stringify(earlier))).not.toBeNull();
    const fresh = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
      [signalLogPath(S, SLOT - BAR_MS), JSON.stringify(earlier)],
      [signalLogPath(S, SLOT - 2 * BAR_MS), "an older record is never read when a newer log record is there"],
    ]);
    const again = await deskRun(fresh);
    const d2 = signalDeps(fresh);
    expect(await runSignalStep(again.logged, d2.deps)).toBe("written");
    const rec = signalOf(fresh) as LogSignalRecord;
    expect(rec.breaks_from).toBe(signalLogPath(S, SLOT - BAR_MS));
    expect(rec.breaks[0]).toEqual(earlier.breaks[0]);
    expect(rec.follow).toHaveLength(1);
    expect(rec.follow[0]).toMatchObject({ symbol: "AAPL", side: "call", occ, bid: expect.any(Number), ask: expect.any(Number), why: null });
    // the followed contract is asked for by name with the chain
    expect(d2.calls.chain.find((x) => x.symbol === "AAPL")!.keep).toEqual({ expiry: chain.expiries[1]!.date, strike: c.strike });
    expect(d2.calls.read).toBe(1);
  });

  it("a log record after dry ones finds the session's breaks through the dry record's last_log, reading no words into it", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    const { logged } = await deskRun(store);
    await runSignalStep(logged, signalDeps(store).deps);
    const base = signalOf(store) as LogSignalRecord;
    const brokeAt = new Date(SLOT - 3 * BAR_MS).toISOString();
    const logKey = signalLogPath(S, SLOT - 2 * BAR_MS);
    const old: LogSignalRecord = {
      ...base,
      slot_end: new Date(SLOT - 2 * BAR_MS).toISOString(),
      breaks: [{ symbol: "AAPL", side: "put", broke_at: brokeAt, confirmed_at: null, occ: null, volume_failed_at: new Date(SLOT - 2 * BAR_MS).toISOString() }],
    };
    // a dry record in between, as the step writes one when the switch is dry
    const dryStore = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
      [logKey, JSON.stringify(old)],
    ]);
    const r1 = await deskRun(dryStore, RUN_AT - BAR_MS);
    expect(await runSignalStep(r1.logged, signalDeps(dryStore, { at: RUN_AT - BAR_MS + 4_000 }).deps)).toBe("written");
    const dry = signalOf(dryStore, SLOT - BAR_MS)!;
    expect(dry.mode).toBe("dry");
    expect(dry.mode === "dry" && dry.last_log).toBe(logKey);
    expect(JSON.stringify(dry)).not.toContain('"volume_failed_at"');
    // then log again
    dryStore.set("desk/signal.json", sw("log"));
    const r2 = await deskRun(dryStore);
    const d = signalDeps(dryStore);
    expect(await runSignalStep(r2.logged, d.deps)).toBe("written");
    const rec = signalOf(dryStore) as LogSignalRecord;
    expect(rec.breaks_from).toBe(logKey);
    expect(rec.breaks[0]).toEqual(old.breaks[0]);
    // the previous record is dry: carried, but the lifecycle and the final volume fail are not read
    expect(rec.history_usable).toBe(false);
    expect(rec.names[0]!.sides[0]!.lifecycle).toBeNull();
    expect(d.calls.read).toBe(2);
  });

  it("earlier records that cannot be read never end the session: log steps back, dry writes last_log null", async () => {
    // log: an unreadable newest record, a readable log record behind it: carried, but not contiguous, so not usable
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    const { logged } = await deskRun(store);
    await runSignalStep(logged, signalDeps(store).deps);
    const base = signalOf(store) as LogSignalRecord;
    const brk = { symbol: "AAPL", side: "call" as const, broke_at: new Date(SLOT - 3 * BAR_MS).toISOString(), confirmed_at: null, occ: null, volume_failed_at: null };
    const s1 = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
      [signalLogPath(S, SLOT - 2 * BAR_MS), JSON.stringify({ ...base, slot_end: new Date(SLOT - 2 * BAR_MS).toISOString(), breaks: [brk] })],
      [signalLogPath(S, SLOT - BAR_MS), "{ not a record"],
    ]);
    const r1 = await deskRun(s1);
    expect(await runSignalStep(r1.logged, signalDeps(s1).deps)).toBe("written");
    const rec = signalOf(s1) as LogSignalRecord;
    expect(rec.history_usable).toBe(false);
    expect(rec.breaks_from).toBe(signalLogPath(S, SLOT - 2 * BAR_MS));
    expect(rec.breaks[0]).toEqual(brk);
    for (const sd of rec.names.flatMap((n) => n.sides)) {
      expect(sd.lifecycle).toBeNull();
      expect(sd.scoring).toBe("not_usable");
      expect(sd.unusable).toContain(HISTORY_UNUSABLE);
    }
    // log, nothing readable at all: still written, marked not usable
    const s2 = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
      [signalLogPath(S, SLOT - BAR_MS), "junk"],
    ]);
    const r2 = await deskRun(s2);
    const d2 = signalDeps(s2);
    d2.deps.list = () => Promise.reject(new Error("list down"));
    expect(await runSignalStep(r2.logged, d2.deps)).toBe("written");
    expect((signalOf(s2) as LogSignalRecord).history_usable).toBe(false);
    // dry: unreadable history gives last_log null and still writes
    const s3 = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("dry")],
      [signalLogPath(S, SLOT - BAR_MS), "junk"],
    ]);
    const r3 = await deskRun(s3);
    expect(await runSignalStep(r3.logged, signalDeps(s3).deps)).toBe("written");
    const dry = signalOf(s3)!;
    expect(dry.mode === "dry" && dry.last_log).toBeNull();
  });

  it("a gap between the record carried from and this slot makes the lifecycle and the final volume fail not usable", async () => {
    const store = new Map([
      ["desk/eval.json", EVAL_ON],
      ["desk/signal.json", sw("log")],
    ]);
    const { logged } = await deskRun(store);
    await runSignalStep(logged, signalDeps(store).deps);
    const base = signalOf(store) as LogSignalRecord;
    for (const [back, usable] of [
      [1, true],
      [2, false],
    ] as const) {
      const st = new Map([
        ["desk/eval.json", EVAL_ON],
        ["desk/signal.json", sw("log")],
        [signalLogPath(S, SLOT - back * BAR_MS), JSON.stringify({ ...base, slot_end: new Date(SLOT - back * BAR_MS).toISOString() })],
      ]);
      const r = await deskRun(st);
      await runSignalStep(r.logged, signalDeps(st).deps);
      const rec = signalOf(st) as LogSignalRecord;
      expect(rec.history_usable).toBe(usable);
      expect(rec.names[0]!.sides[0]!.unusable.includes(HISTORY_UNUSABLE)).toBe(!usable);
    }
  });
});

// ---- the strict reader ----------------------------------------------------------------------------------------------
describe("the strict reader", () => {
  async function both(): Promise<{ dry: string; log: string }> {
    const out: Record<string, string> = {};
    for (const mode of ["dry", "log"]) {
      const store = new Map([
        ["desk/eval.json", EVAL_ON],
        ["desk/signal.json", sw(mode)],
      ]);
      putStamp(store, RUN_AT - 1_000);
      const { logged } = await deskRun(store);
          await runSignalStep(logged, signalDeps(store).deps);
      out[mode] = store.get(signalLogPath(S, SLOT))!;
    }
    return out as { dry: string; log: string };
  }

  it("reads back what the step writes, and refuses anything off its shape", async () => {
    const { dry, log } = await both();
    expect(parseSignalRecord(dry)!.mode).toBe("dry");
    expect(parseSignalRecord(log)!.mode).toBe("log");
    const d = JSON.parse(dry);
    const l = JSON.parse(log);
    const bad = [
      { ...d, v: 2 },
      { ...d, extra: 1 },
      { ...d, mode: "show" },
      { ...d, switch: "log" },
      { ...d, names: [{ ...d.names[0], sides: [{ ...d.names[0].sides[0], word: "CALL" }] }] },
      { ...d, names: [{ ...d.names[0], symbol: "not a symbol" }] },
      { ...l, follow: undefined },
      { ...l, names: [{ ...l.names[0], sides: [{ ...l.names[0].sides[0], word: "BUY" }] }] },
      { ...l, slot_end: "yesterday" },
    ];
    for (const b of bad) expect(parseSignalRecord(JSON.stringify(b))).toBeNull();
    expect(parseSignalRecord("{")).toBeNull();
    expect(parseSignalRecord("[]")).toBeNull();
  });

  it("builds the same record from the same inputs (pure)", async () => {
    const store = new Map([["desk/eval.json", EVAL_ON]]);
    const { logged } = await deskRun(store);
    const input = {
      mode: "dry" as const,
      switch: "dry" as const,
      logged: logged!,
      evaluatedAt: RUN_AT + 3_000,
      stamp: { stamp: null, usable: false },
      flow: flowAt(["AAPL", "QQQ", "SPY"], RUN_AT + 2_000),
      flowWhy: null,
      chains: {},
      history: { breaks: [], from: null, usable: true },
    };
    expect(JSON.stringify(buildSignalRecord(input))).toBe(JSON.stringify(buildSignalRecord(input)));
  });
});
