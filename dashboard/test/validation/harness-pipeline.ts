// Shared helpers for the validation suite's pipeline tests: copied from test/signal-run.test.ts (DEC-0044's run on an
// in-memory store and the signal step's injectable deps), unchanged in behaviour. Not a test file: nothing runs here.
import { PreconditionFailed } from "@/lib/blob";
import type { BarsResponse } from "@/lib/bars";
import { fixtureChain } from "@/lib/chain-route";
import { BAR_MS } from "@/lib/desk-eval";
import { type DeskRunDeps, type LoggedSlot, runDeskEval } from "@/lib/desk-run";
import { focusOptions } from "@/lib/fixture-variants";
import { fixtureBars, fixtureBaseline, type ServerFlow } from "@/lib/flow-route";
import type { Options } from "@/lib/options";
import { parseSignalRecord, signalLogPath, type SignalRecord } from "@/lib/signal-record";
import type { SignalDeps, StampRead } from "@/lib/signal-run";
import type { Bar2 } from "@/lib/trade-state";
import optionsJson from "../fixtures/options.v1.json";

export const E = focusOptions(optionsJson as unknown as Options, true);
export const S = E.session; // 2026-10-12, EDT
export const OPEN = Date.parse(`${S}T13:30:00Z`);
export const ny = (hhmmss: string, day = S) => Date.parse(`${day}T${hhmmss}-04:00`);
export const FOCUS = E.focus!.items.map((i) => i.symbol); // SPY, QQQ, AAPL
export const EVAL_ON = '{"v":1,"eval":"log"}';
export const sw = (v: string) => `{"v":1,"signal":"${v}"}`;
export const RUN_AT = ny("10:31:01");
export const SLOT = ny("10:30:00");

export function bars(at: number, ed: Options = E): Record<string, Bar2[]> {
  const out: Record<string, Bar2[]> = {};
  const open = Date.parse(`${ed.session}T13:30:00Z`);
  for (const s of ed.focus!.items.map((i) => i.symbol)) {
    const c = ed.focus!.items.find((i) => i.symbol === s)!.close ?? 100;
    const list: Bar2[] = [];
    for (let start = open; start < at; start += BAR_MS) list.push({ start, end: start + BAR_MS, o: c, h: c + 0.1, l: c - 0.1, c });
    out[s] = list;
  }
  return out;
}

export function deskDeps(store: Map<string, string>, clock: number = RUN_AT, ed: Options = E): DeskRunDeps {
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
          return [s, { price: last.c, at: new Date(t - 1_000).toISOString(), open: last.o, high: last.h, low: last.l, day: ed.session, prev_close: null, vwap: null }];
        }),
      );
      return { as_of: o.now.toISOString(), feed: "sip", quotes, missing: [] };
    },
  };
}

/** DEC-0044's run for the slot, and what it handed over. */
export async function deskRun(store: Map<string, string>, clock: number = RUN_AT, ed: Options = E, over: Partial<DeskRunDeps> = {}): Promise<{ logged: LoggedSlot | null; outcome: string }> {
  let logged = null as LoggedSlot | null;
  const r = await runDeskEval({ ...deskDeps(store, clock, ed), ...over }, (x) => {
    logged = x;
  });
  return { logged, outcome: r.outcome };
}

/** A SIP flow answer for the names at `now`: the fixture's bars and a 20-session baseline with ranges. */
export function flowAt(symbols: readonly string[], now: number, day = S): ServerFlow {
  const names: ServerFlow["names"] = {};
  symbols.forEach((sym, i) => {
    const b = fixtureBars(sym, i, day, now);
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
  return { as_of: new Date(now).toISOString(), feed: "sip", baseline: fixtureBaseline(symbols, day, new Set()), names, missing: [] };
}

export interface Calls {
  switch: number;
  exists: number;
  write: number;
  list: number;
  read: number;
  stamps: number;
  flow: string[][];
  chain: { symbol: string; keep: unknown }[];
}

/** A signal step on an in-memory store, its clock running from the slot's run on (Date.now, real or faked). */
export function signalDeps(store: Map<string, string>, over: Partial<SignalDeps> & { at?: number } = {}) {
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
  delete (deps as { at?: number }).at;
  return { deps, calls };
}

/** The stamp the run's first step writes, in the store. */
export const putStamp = (store: Map<string, string>, at: number, feed = "sip", answered = "ok", day = S) => {
  const m = new Date(at);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(m).replace(":", "");
  store.set(`desk/feeds/board/${day}/${hhmm}.json`, JSON.stringify({ feed, answered, at: m.toISOString() }));
};

export const signalOf = (store: Map<string, string>, end = SLOT, day = S): SignalRecord | null => {
  const t = store.get(signalLogPath(day, end));
  return t ? parseSignalRecord(t) : null;
};

/** A store with DEC-0044's switch on and the signal switch at `mode` (none when undefined). */
export const storeWith = (mode?: string): Map<string, string> => {
  const m = new Map([["desk/eval.json", EVAL_ON]]);
  if (mode !== undefined) m.set("desk/signal.json", mode.startsWith("{") || mode === "" ? mode : sw(mode));
  return m;
};

export const signalKeys = (store: Map<string, string>) => [...store.keys()].filter((k) => k.startsWith("desk/signal/"));
