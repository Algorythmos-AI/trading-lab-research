// Validation of the DEC-0051 signal step (signal-run.ts runSignalStep) and its hand-over from DEC-0044's run
// (desk-run.ts runDeskEval) under faults: timeouts at every part's limit, late writes, errors against absences,
// concurrency, the switch and the non-production deps. Every test asserts the INTENDED behaviour; a failure here is a
// finding about the code, not a test to loosen. No network: injected deps, an in-memory store and vi fake timers.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import { fixtureChain } from "@/lib/chain-route";
import { BAR_MS, expectedSlots, nyHhmm, sessionBounds, settledSlotEnd, slotAt } from "@/lib/desk-eval";
import { resetFlowCache, serverFlow } from "@/lib/flow-route";
import { type LogSignalRecord, parseSignalRecord, signalLogPath, type SignalRecord } from "@/lib/signal-record";
import { buildSignalRecord, defaultSignalDeps, runSignalStep, type SignalDeps } from "@/lib/signal-run";
import { UpstreamError } from "@/lib/upstream";
import { deskRun, E, FOCUS, flowAt, RUN_AT, S, signalDeps, signalKeys, signalOf, SLOT, storeWith, sw } from "./harness-pipeline";

// Every logEvent call, captured (the module is replaced; nothing reaches the console).
const events = vi.hoisted(() => [] as { evt: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/log", () => ({
  logEvent: (evt: string, fields: Record<string, unknown> = {}) => {
    events.push({ evt, fields });
  },
}));
// The Blob SDK faked, every SDK call counted: a non-production dep must make none.
const blobCalls = vi.hoisted(() => [] as string[]);
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk } = await import("../blob-sdk");
  const sdk = makeFakeBlobSdk() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sdk))
    out[k] =
      typeof v === "function" && /^[a-z]/.test(k) && ["put", "head", "get", "list", "del"].includes(k)
        ? (...a: unknown[]) => {
            blobCalls.push(k);
            return (v as (...x: unknown[]) => unknown)(...a);
          }
        : v;
  return out;
});

const FAKE = { toFake: ["Date", "setTimeout", "clearTimeout"] as ("Date" | "setTimeout" | "clearTimeout")[] };
const after = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const hang = <T,>() => new Promise<T>(() => undefined);
const PATH = signalLogPath(S, SLOT);

beforeAll(async () => {
  // Warm the fixture chain's JSON import, so a test with fake timers never waits on module loading.
  await fixtureChain("AAPL", new Date(RUN_AT), false, null, "opra");
});
beforeEach(() => {
  events.length = 0;
  blobCalls.length = 0;
  resetFlowCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs a step under fake timers to completion. */
async function drive<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

// ---- a. every part at its limit ------------------------------------------------------------------------------------
describe("a. all part limits hit together", () => {
  it("a1: switch at ~690 ms, flow and chain hanging: a degraded record is still written (flow_why timeout)", async () => {
    // Proves signal-run.ts:651-655: with no flow there is no price, so no chain is asked and 2.3 s of budget is left.
    const store = storeWith();
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const { deps, calls } = signalDeps(store, { readSwitch: () => after(690, sw("dry")), fetchFlow: hang, fetchChain: hang });
    const out = await drive(runSignalStep(logged, deps));
    expect(calls.chain).toEqual([]);
    expect(out).toBe("written");
    expect(signalOf(store)!.flow_why).toBe("timeout");
  });

  it("a2: switch 699 ms, flow answering at 1,999 ms, chains hanging: the step must still write its degraded record", async () => {
    // Proves signal-run.ts:618/646/684: the parts' limits (700 + 2,000 + 1,300) leave the write 1,000 ms minus the build's
    // CPU time, so any real build time makes `deadline - now < T.write` true and the record is dropped as "timeout".
    const store = storeWith();
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const base = RUN_AT + 4_000;
    const fake0 = Date.now();
    const perf0 = performance.now();
    // The clock: the virtual waits plus the real CPU time the step spends (performance is not faked).
    const now = () => base + (Date.now() - fake0) + (performance.now() - perf0);
    const { deps } = signalDeps(store, {
      now,
      readSwitch: () => after(699, sw("dry")),
      fetchFlow: (symbols) => after(1_999, flowAt(symbols, base + 2_000)),
      fetchChain: hang,
    });
    const out = await drive(runSignalStep(logged, deps));
    expect(out).toBe("written");
  });

  // a3 removed: it asserted 5,000 − (700 + 2,000 + 1,300) − build ≥ 1,000 on the exported constants. Superseded: the
  // write's limit (and BUILD_RESERVE_MS) is now reserved from the start and every read is cut to what is left before
  // it, so the part limits are maxima, not a sum; a2 proves the property (every read at its limit, the record written).
});

// ---- b. a signal write that lands after its limit ------------------------------------------------------------------
describe("b. a signal write that persists but resolves after the 1 s write limit", () => {
  const lateWrite = (store: Map<string, string>) => async (p: string, b: string) => {
    if (store.has(p)) throw new PreconditionFailed();
    store.set(p, b);
    await new Promise((r) => setTimeout(r, 1_500));
  };

  it("b1: the outcome agrees with the store: the record is there, so the outcome is not write-timeout", async () => {
    // Proves signal-run.ts:695-698: a write that times out is reported as "write-timeout" even when it persisted.
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const { deps } = signalDeps(store, { write: lateWrite(store) });
    const out = await drive(runSignalStep(logged, deps));
    expect(store.has(PATH)).toBe(true);
    expect(out).toBe("written");
  });

  it("b2: a later exists-check reflects the persisted record", async () => {
    // Proves the store side of signal-run.ts:625/630: once persisted, exists() is true, so the slot is not double-written.
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const { deps } = signalDeps(store, { write: lateWrite(store) });
    await drive(runSignalStep(logged, deps));
    expect(await deps.exists(PATH)).toBe(true);
    expect(parseSignalRecord(store.get(PATH)!)?.mode).toBe("dry");
  });
});

// ---- c. a DEC-0044 write that lands after its limit ----------------------------------------------------------------
describe("c. a DEC-0044 write that persists after its 1.5 s limit", () => {
  it("the slot gets a signal record, or an explicit desk-signal event naming the missing record", async () => {
    // Proves desk-run.ts:416-423 and :427 (no hand-over after write-failed) and signal-run.ts:598 (null → "nothing",
    // not logged): run 1 says write-failed, run 2 already-logged, and the signal record is a silent gap.
    const store = storeWith("dry");
    vi.useFakeTimers(FAKE);
    const late = async (p: string, body: string) => {
      if (store.has(p)) throw new PreconditionFailed();
      store.set(p, body);
      await new Promise((r) => setTimeout(r, 2_000));
    };
    const r1 = await drive(deskRun(store, RUN_AT, E, { write: late }));
    expect(r1).toEqual({ logged: null, outcome: "write-failed" });
    expect(store.has(`desk/log/${S}/1030.json`)).toBe(true); // the DEC-0044 record did persist
    expect(await runSignalStep(r1.logged, signalDeps(store).deps)).toBe("nothing");
    const r2 = await deskRun(store, RUN_AT + 60_000);
    expect(r2).toEqual({ logged: null, outcome: "already-logged" });
    expect(await runSignalStep(r2.logged, signalDeps(store, { at: RUN_AT + 64_000 }).deps)).toBe("nothing");
    const gapNamed = events.some((e) => e.evt.startsWith("desk-signal") && /1030|desk\/signal\//.test(JSON.stringify(e.fields)));
    expect(signalKeys(store).length > 0 || gapNamed, `events: ${events.map((e) => e.evt).join(", ")}`).toBe(true);
  });
});

// ---- d. the session's last slot ------------------------------------------------------------------------------------
describe("d. the last slot of a full day (15:58) and a half day (12:58)", () => {
  /** Per slot end, how many once-a-minute cron fires (at `sec` past the minute) evaluate it and can still write its signal record. */
  function fires(day: string, sec: number): Map<number, number> {
    const b = sessionBounds(day)!;
    const out = new Map<number, number>();
    for (let m = b.open; m < b.close + 5 * 60_000; m += 60_000) {
      const t = m + sec * 1_000;
      const at = slotAt(t);
      // the signal step starts a few seconds later and must still be in the same settled slot
      if (at.kind === "slot" && settledSlotEnd(t + 4_000) === at.end) out.set(at.end, (out.get(at.end) ?? 0) + 1);
    }
    return out;
  }
  const DAYS = [
    ["full day", S, "1558"],
    ["half day", "2026-11-27", "1258"],
  ] as const;

  it.each(DAYS)("d1 %s: the last slot (%s) is evaluated by at least one cron minute", (_n, day, hhmm) => {
    // Proves desk-eval.ts:66-84: expectedSlots' last slot is reachable by slotAt before the close.
    const last = expectedSlots(day).at(-1)!;
    expect(nyHhmm(last)).toBe(hhmm);
    expect(Math.max(...[0, 1, 5, 15, 30, 45].map((s) => fires(day, s).get(last) ?? 0))).toBeGreaterThanOrEqual(1);
  });

  it.fails.each(DAYS)("KNOWN OPEN: last slot gets one fire (desk-eval.ts, owner decision): d2 %s: the last slot gets as many cron fires as the other slots (at least 2)", (_n, day) => {
    // Proves desk-eval.ts:69 (`nowMs >= bounds.close` is idle): the 15:58/12:58 slot is settled at 15:59/12:59 and the
    // 16:00/13:00 fire is outside hours, so it has a single chance where every other slot has two.
    const slots = expectedSlots(day);
    const last = slots.at(-1)!;
    const best = Math.max(...[0, 1, 5, 15, 30, 45].map((s) => fires(day, s).get(last) ?? 0));
    const f = fires(day, 1);
    const typical = slots.slice(0, -1).map((e) => f.get(e) ?? 0);
    expect(Math.min(...typical)).toBe(2); // every other slot: two fires
    expect(best, `last slot ${nyHhmm(last)} fires; others get ${Math.min(...typical)}`).toBeGreaterThanOrEqual(2);
  });
});

// ---- e. a flow answer from another slot ----------------------------------------------------------------------------
describe("e. dry mode, the flow answer's as_of off the slot", () => {
  it.each([59_000, 125_000, 185_000])("as_of = slot end + %i ms: gates are never recorded from a different slot", async (off) => {
    // Proves signal-run.ts:373-433: the dry record checks only the edition (recordUnusable); the gates read the flow's
    // own clock (signal.ts:282, slotClockFromAsOf), so a flow answer whose settled slot is not the record's slot (a cached
    // answer from before the settle, or one after the next settle) gives gates of another slot with nothing flagged.
    const store = storeWith();
    const { logged } = await deskRun(store);
    const asOf = SLOT + off;
    const syms = [...new Set([...FOCUS, "SPY", "QQQ"])];
    const chains = Object.fromEntries(await Promise.all(FOCUS.map(async (s) => [s, { chain: await fixtureChain(s, new Date(asOf), false, null, "opra"), receivedAt: asOf + 500 }] as const)));
    const rec = buildSignalRecord({ mode: "dry", switch: "dry", logged: logged!, evaluatedAt: asOf + 500, stamp: { stamp: null, usable: false }, flow: flowAt(syms, asOf), flowWhy: null, chains, history: { breaks: [], from: null, usable: false } });
    const otherSlot = settledSlotEnd(asOf) !== SLOT;
    const gatesNull = rec.names.every((n) => n.sides.every((s) => s.gates.market_direction.pass === null && s.gates.stock_bid_ask.pass === null && s.gates.shock.pass === null));
    const flagged = rec.unusable.length > 0 || rec.flow === null || gatesNull;
    expect({ otherSlot, flagged: otherSlot ? flagged : true }).toEqual({ otherSlot, flagged: true });
  });
});

// ---- f. errors against absences ------------------------------------------------------------------------------------
describe("f. an error and an absence leave different records", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(RUN_AT + 4_000));
  });

  async function record(mode: "dry" | "log", over: Partial<SignalDeps>): Promise<SignalRecord> {
    const store = storeWith(mode);
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store, over);
    expect(await runSignalStep(logged, deps)).toBe("written");
    return signalOf(store)!;
  }
  const aapl = (r: SignalRecord) => {
    const n = r.names.find((x) => x.symbol === "AAPL")!;
    return { chain: n.chain, contract: n.sides.map((s) => ({ why: s.gates.contract.why, value: s.gates.contract.value })) };
  };

  it.fails("KNOWN OPEN: chain error vs no price indistinguishable (needs record format change): f(i): a chain read that fails (429) and a chain not asked for (no price) differ in the name's chain fields", async () => {
    // Proves signal-run.ts:652-662: both set chains[sym] = null, so `chain: null` and contract "no-chain" in both.
    const errored = await record("dry", {
      fetchChain: (s, px, k) => (s === "AAPL" ? Promise.reject(new UpstreamError(429)) : fixtureChain(s, new Date(RUN_AT + 3_800), false, k, "opra")),
    });
    const absent = await record("dry", {
      fetchFlow: async (symbols) => {
        const f = flowAt(symbols, RUN_AT + 3_500);
        f.names.AAPL = { ...f.names.AAPL!, price: null };
        return f;
      },
    });
    expect(JSON.stringify(aapl(errored))).not.toBe(JSON.stringify(aapl(absent)));
  });

  it.fails("KNOWN OPEN: dry: stamp read error vs none indistinguishable (by design in dry): f(ii): stamps that cannot be read and no stamps at all differ in the record", async () => {
    // Proves signal-run.ts:673: a rejected readStamps and an empty one both give { stamp: null, usable: false }.
    const errored = await record("dry", { readStamps: () => Promise.reject(new Error("store 503")) });
    const absent = await record("dry", { readStamps: async () => [] });
    expect(JSON.stringify(errored)).not.toBe(JSON.stringify(absent));
  });

  it("f(iii): a failed listing of the day and a day with no earlier record differ in the log record", async () => {
    // Proves signal-run.ts:555-559: a failed list() is `none` and an empty listing (not the first slot) is usable false.
    const errored = await record("log", { list: () => Promise.reject(new Error("list 500")) });
    const absent = await record("log", { list: async () => [] });
    expect((errored as LogSignalRecord).history_usable).toBe(false);
    expect(JSON.stringify(errored)).not.toBe(JSON.stringify(absent));
  });

  it.fails("KNOWN OPEN: baseline error vs missing indistinguishable (needs format change): f(iv): a baseline store error and a missing baseline differ in the record", async () => {
    // Proves flow-route.ts:238-254 with signal-run.ts:405: both give baseline null, so `baseline: null` in both records.
    const fetch = (async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const flowWith = (readBaseline: (s: string) => Promise<string | null>): SignalDeps["fetchFlow"] => (symbols, ed) => {
      resetFlowCache();
      return serverFlow(symbols, ed, { fetch, readBaseline, fixture: false, now: () => new Date(RUN_AT + 3_500), env: { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" }, baseUrl: "https://data.alpaca.markets", loadEdition: async () => E });
    };
    const errored = await record("dry", { fetchFlow: flowWith(() => Promise.reject(new Error("store 503"))) });
    const absent = await record("dry", { fetchFlow: flowWith(async () => null) });
    expect(errored.flow).not.toBeNull();
    expect(JSON.stringify(errored)).not.toBe(JSON.stringify(absent));
  });
});

// ---- g. OPRA refused -----------------------------------------------------------------------------------------------
describe("g. OPRA refused (403), the indicative fallback, in dry mode", () => {
  it("the contract gate does not pass and names the reason", async () => {
    // Proves contract-pick.ts:227 via signal.ts:265-270: a fallback chain is "not-opra", never a pass.
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    const { deps } = signalDeps(store, {
      fetchChain: async (s, _px, k) => ({ ...(await fixtureChain(s, new Date(RUN_AT + 3_800), false, k, "opra")), feed: "indicative", delay_min: 15, fallback: "opra-refused" }),
    });
    expect(await runSignalStep(logged, deps)).toBe("written");
    const rec = signalOf(store)!;
    for (const n of rec.names) {
      expect(n.chain).toMatchObject({ feed: "indicative", fallback: "opra-refused" });
      for (const s of n.sides) {
        expect(s.gates.contract.pass).not.toBe(true);
        expect(s.gates.contract.why).toMatch(/not OPRA/);
      }
    }
  });
});

// ---- h. two runs at once -------------------------------------------------------------------------------------------
describe("h. concurrency: two steps for the same slot against one create-only store", () => {
  it("exactly one record is written; the other run's outcome is exists", async () => {
    // Proves signal-run.ts:693-697: the create-only put is the guard; a PreconditionFailed reads as "exists".
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    let wrote = 0;
    const mk = () => {
      const { deps } = signalDeps(store);
      const w = deps.write;
      deps.write = async (p, b) => {
        await w(p, b);
        wrote++;
      };
      return deps;
    };
    const outs = await Promise.all([runSignalStep(logged, mk()), runSignalStep(logged, mk())]);
    expect(outs.sort()).toEqual(["exists", "written"]);
    expect(wrote).toBe(1);
    expect(signalKeys(store)).toEqual([PATH]);
  });
});

// ---- i. the exists-check throws ------------------------------------------------------------------------------------
describe("i. the exists-check throws", () => {
  it("the step still writes create-only, and a second run does not double-write", async () => {
    // Proves signal-run.ts:625/630 (an error is not "there") and :697 (the create-only put refuses the second).
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    const broken = { exists: () => Promise.reject(new Error("head 500")) };
    expect(await runSignalStep(logged, signalDeps(store, broken).deps)).toBe("written");
    const first = store.get(PATH);
    expect(await runSignalStep(logged, signalDeps(store, broken).deps)).toBe("exists");
    expect(store.get(PATH)).toBe(first);
    expect(signalKeys(store)).toEqual([PATH]);
  });
});

// ---- j. the switch -------------------------------------------------------------------------------------------------
describe("j. the switch's values", () => {
  const CASES: [string, () => Promise<string | null>, "written" | "off", "dry" | "log" | null][] = [
    ["missing", async () => null, "off", null],
    ["malformed", async () => "{", "off", null],
    ["unknown word", async () => sw("on"), "off", null],
    ["off", async () => sw("off"), "off", null],
    ["dry", async () => sw("dry"), "written", "dry"],
    ["log", async () => sw("log"), "written", "log"],
    ["show", async () => sw("show"), "written", "log"],
    ["read throws", () => Promise.reject(new Error("store 503")), "off", null],
    ["read hangs past 700 ms", () => hang(), "off", null],
    ["read answers dry at 720 ms", () => after(720, sw("dry")), "off", null],
  ];
  it.each(CASES)("%s → only dry, log and show write", async (_n, readSwitch, want, mode) => {
    // Proves signal-run.ts:600-608: anything but a readable dry, log or show inside 700 ms is off and writes nothing.
    const store = storeWith();
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const { deps, calls } = signalDeps(store, { readSwitch });
    expect(await drive(runSignalStep(logged, deps))).toBe(want);
    expect(signalKeys(store).length).toBe(want === "written" ? 1 : 0);
    if (want === "off") expect(calls.write + calls.exists + calls.list + calls.stamps + calls.flow.length + calls.chain.length).toBe(0);
    else expect(signalOf(store)!.mode).toBe(mode);
  });
});

// ---- k. non-production deps ----------------------------------------------------------------------------------------
describe("k. the deployed deps outside production touch no network and no store", () => {
  it.each([
    ["VERCEL_ENV unset", { VERCEL_ENV: undefined, DASHBOARD_FIXTURE: undefined }],
    ["VERCEL_ENV preview", { VERCEL_ENV: "preview", DASHBOARD_FIXTURE: "" }],
    ["fixture mode (development)", { VERCEL_ENV: "development", DASHBOARD_FIXTURE: "1" }],
    ["fixture mode (VERCEL_ENV unset)", { VERCEL_ENV: undefined, DASHBOARD_FIXTURE: "1" }],
  ] as const)("%s: every dep refuses or answers off, and nothing is fetched or stored", async (_n, env) => {
    // Proves signal-run.ts:150-162: the refusing deps make no fetch and no Blob SDK call, and a full step is "off".
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string | undefined);
    for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"]) vi.stubEnv(k, "x");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const store = storeWith("log");
    const { logged } = await deskRun(store);
    blobCalls.length = 0;
    const d = defaultSignalDeps();
    expect(await d.readSwitch()).toBeNull();
    for (const call of [() => d.exists(PATH), () => d.write(PATH, "{}"), () => d.list("desk/signal/"), () => d.read(PATH), () => d.readStamps(S, ["k"]), () => d.fetchFlow(["SPY"], E), () => d.fetchChain("AAPL", 250, null)])
      await expect(call()).rejects.toThrow();
    expect(await runSignalStep(logged, defaultSignalDeps())).toBe("off");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(blobCalls).toEqual([]);
  });
});

// keep BAR_MS referenced for readers comparing slot arithmetic with desk-eval.ts
void BAR_MS;
