// Shared helpers for the validation suite's pure tests: the synthetic scene copied from test/signal.test.ts (lines
// 52-209: a 2026-11-12 session, a clean AAPL break, SPY and QQQ rows, an OPRA chain), each helper exported unchanged.
// Not a test file: nothing runs here. A test that needs words past "not usable" mocks @/lib/signal-freeze itself.
import type { ChainContract, ChainResponse } from "@/lib/chain";
import { stateRows } from "@/lib/desk-eval";
import type { FlowBar, NameStats } from "@/lib/flow";
import { FULL_SESSION_SLOTS, SLOT_MS } from "@/lib/flow";
import type { Options } from "@/lib/options";
import type { FlowInput, FlowRowInput, Gate, GateId, GateInput, Gates, SignalInput, SignalWordName, SlotRecord, WordInput } from "@/lib/signal";
import { MARKET_GATES, signalWord } from "@/lib/signal";
import type { NameState, NameStateName, SideState } from "@/lib/trade-state";

// 2026-11-12, a Thursday on EST: 09:30 New York is 14:30Z. Evaluated at 15:31:30Z, 30 slots have settled (0 to 29) and
// the last ends 15:30Z (10:30 New York). The break bar is slot 27, 15:24Z to 15:26Z.
export const DAY = "2026-11-12";
export const OPEN = Date.parse("2026-11-12T14:30:00Z");
export const AS_OF = "2026-11-12T15:31:30.000Z";
export const NOW = Date.parse(AS_OF);
export const SLOT = OPEN + 30 * SLOT_MS;
export const BROKE_AT = OPEN + 28 * SLOT_MS;
export const iso = (ms: number) => new Date(ms).toISOString();

export const flowBar = (k: number, over: Partial<FlowBar> = {}): FlowBar => ({ start: OPEN + k * SLOT_MS, end: OPEN + (k + 1) * SLOT_MS, o: 100, h: 100.5, l: 99.5, c: 100, v: 1_000, vw: 100, n: 10, ...over });

/** 20 sessions, every slot's median volume 1,000 and median range 0.5; the name's bars' range is 1 (2× the usual). */
export const stats = (over: Partial<NameStats> = {}): NameStats => ({
  slot_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 1_000),
  cum_median: Array.from({ length: FULL_SESSION_SLOTS }, (_, k) => 1_000 * (k + 1)),
  range_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 0.5),
  n: 20,
  ...over,
});

export const nameBars = (over: (k: number) => Partial<FlowBar> = () => ({})) => Array.from({ length: 30 }, (_, k) => flowBar(k, { ...(k === 27 ? { v: 2_000 } : {}), ...over(k) }));

export const row = (bars: FlowBar[] = nameBars(), over: Partial<FlowRowInput> = {}): FlowRowInput => ({
  price: 100.2,
  trade_at: iso(NOW - 1_000),
  bid: 100.19,
  ask: 100.21,
  quote_at: iso(NOW - 1_000),
  bars,
  ...over,
});

/** An index's row whose readings come out up, down or range: steady closes, the price beyond VWAP. */
export const indexRow = (dir: "up" | "down" | "range"): FlowRowInput => {
  const step = dir === "up" ? 0.01 : dir === "down" ? -0.01 : 0;
  const bars = Array.from({ length: 30 }, (_, k) => {
    const c = 100 + step * k;
    return flowBar(k, { o: c, h: c + 0.05, l: c - 0.05, c, vw: c });
  });
  const price = dir === "up" ? 100.5 : dir === "down" ? 99.5 : 100;
  return row(bars, { price, bid: price - 0.01, ask: price + 0.01 });
};

export const flow = (over: Partial<FlowInput> = {}, idx: { SPY?: "up" | "down" | "range"; QQQ?: "up" | "down" | "range" } = {}): FlowInput => ({
  as_of: AS_OF,
  feed: "sip",
  baseline: { for_session: DAY, names: { AAPL: stats(), SPY: stats(), QQQ: stats() } },
  names: { AAPL: row(), SPY: indexRow(idx.SPY ?? "up"), QQQ: indexRow(idx.QQQ ?? "up") },
  ...over,
});
export const withAapl = (r: FlowRowInput, over: Partial<FlowInput> = {}) => flow({ ...over, names: { ...flow().names, AAPL: r } });

export const quoted = (kind: "call" | "put", strike: number, over: Partial<ChainContract> = {}): ChainContract => ({
  kind,
  strike,
  bid: 0.78,
  ask: 0.82,
  last: 0.8,
  at: iso(NOW - 2_000),
  iv: 0.3,
  delta: kind === "call" ? 0.5 : -0.5,
  volume: 500,
  bid_size: 5,
  ask_size: 5,
  ...over,
});

export const chain = (over: (c: ChainContract) => Partial<ChainContract> = () => ({}), extra: Partial<ChainResponse> = {}): ChainResponse => ({
  as_of: AS_OF,
  served_at: AS_OF,
  feed: "opra",
  delay_min: 0,
  symbol: "AAPL",
  expiries: [{ date: "2026-11-13", contracts: [99, 100, 101].flatMap((k) => (["call", "put"] as const).map((kind) => quoted(kind, k))).map((c) => ({ ...c, ...over(c) })) }],
  ...extra,
});

export const gateInput = (over: Partial<GateInput> = {}): GateInput => ({
  symbol: "AAPL",
  side: "call",
  focus: ["AAPL"],
  sideState: { brokeAt: BROKE_AT },
  flow: flow(),
  flowAgeMs: 500,
  chain: chain(),
  chainAgeMs: 1_000,
  ...over,
});

export const side = (s: SideState["side"], state: SideState["state"], over: Partial<SideState> = {}): SideState => ({
  side: s,
  state,
  level: 100,
  brokeEarlier: false,
  waitingClose: false,
  gap: false,
  missedWhy: null,
  brokeAt: state === "watch" || state === "no_trade" ? null : BROKE_AT,
  alt: null,
  distAtr: 0.1,
  ...over,
});

export const nameState = (call: SideState, put: SideState = side("put", "watch"), over: Partial<NameState> = {}): NameState => ({
  symbol: "AAPL",
  state: call.state,
  tone: "good",
  line: "a line",
  plan: null,
  alt: null,
  brokeEarlier: false,
  cautions: [],
  moreCautions: 0,
  unknown: [],
  rank: 0,
  call,
  put,
  ...over,
});

export const edition = (symbols = ["AAPL"], session = DAY) => ({ session, focus: { items: symbols.map((symbol, i) => ({ symbol, rank: i + 1, bias: "range" })) } }) as unknown as Pick<Options, "session" | "focus">;

/** The slot's DEC-0044 record, holding the rows the state gives. */
export const record = (s: NameState, over: Partial<SlotRecord> = {}): SlotRecord => ({
  status: "ok",
  session: DAY,
  slot_end: iso(SLOT),
  degraded_names: [],
  rows: stateRows(s).map((r) => ({ ...r, bar_end: iso(SLOT) })),
  ...over,
});

export const signalInput = (s: NameState, over: Partial<SignalInput> = {}): SignalInput => ({
  side: "call",
  state: { slotEnd: SLOT, name: s },
  record: record(s),
  stamp: { feed: "sip", answered: "ok" },
  edition: edition(),
  flow: flow(),
  flowAgeMs: 500,
  chain: chain(),
  chainAgeMs: 1_000,
  earlier: [],
  ...over,
});

/** A gate with a given result, for the word's rule table. */
export const g = <K extends GateId>(id: K, pass: boolean | null, notYet = false): Gate<K> => ({ id, pass, notYet, value: null as never, why: `${id} ${pass}` });
export type GateSet = Partial<Record<GateId, boolean | null | "not_yet">>;
export const allGates = (over: GateSet = {}): Gates => {
  const one = <K extends GateId>(id: K) => {
    const v = id in over ? over[id]! : true;
    return v === "not_yet" ? g(id, null, true) : g(id, v);
  };
  return { market_direction: one("market_direction"), volume: one("volume"), stock_bid_ask: one("stock_bid_ask"), shock: one("shock"), contract: one("contract") };
};
export const word = (over: Partial<WordInput> = {}) => signalWord({ side: "call", rowState: "enter_zone", sideState: { brokeEarlier: false, gap: false }, gates: allGates(), unusable: [], ...over });

// ---- the property's pieces, copied from test/signal.test.ts (lines 543-571) ----------------------------------------
/** mulberry32, as EXP-0034's config gives it: a seeded generator, so a failing case can be found again. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export const STATES: NameStateName[] = ["no_trade", "watch", "get_ready", "enter_zone", "plan_off", "missed", "paused"];

/** What section 1 says the word is, written out apart from signal.ts, for the property to compare with. */
export function expected(x: WordInput): SignalWordName {
  const m = MARKET_GATES.map((id) => x.gates[id]);
  const volFail = x.gates.volume.pass === false || x.volumeFailedEarlier === true;
  const failing = m.filter((gt) => (gt.pass !== true && !gt.notYet) || (gt.id === "volume" && volFail));
  const flagged = x.sideState.brokeEarlier || x.sideState.gap;
  if (x.unusable.length) return "NO TRADE";
  if (["no_trade", "watch", "plan_off", "missed", "paused"].includes(x.rowState)) return "NO TRADE";
  if (x.rowState === "get_ready" && flagged) return "NO TRADE";
  if (volFail || failing.length >= 2 || x.gates.contract.pass !== true) return "NO TRADE";
  if (x.rowState === "enter_zone" && !flagged && m.every((gt) => gt.pass === true)) return x.side === "call" ? "CALL" : "PUT";
  if (x.rowState === "get_ready") return "WAIT";
  if (x.rowState === "enter_zone" && !flagged && failing.length === 1 && failing[0]!.id !== "volume") return "WAIT";
  return "NO TRADE";
}

/** "1-40" or "1,5,9-12": the seeds a sweep runs. */
export function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad seed spec: ${part}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let s = Math.min(a, b); s <= Math.max(a, b); s++) out.push(s);
  }
  return out;
}
