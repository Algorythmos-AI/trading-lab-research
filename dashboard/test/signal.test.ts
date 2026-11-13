// signal.ts: DEC-0051's signal word, gates and lifecycle, as pure rules on synthetic board states, flow answers and
// OPRA chains. Nothing here reads a journal, a ledger, a log or any outcome.
//
// The frozen hashes are mocked to the code's own here, as Amendment 1 would set them, so every rule past "not usable"
// can be reached. signal-freeze.test.ts runs with the real (null) ones: every word NO TRADE.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { REPO_CALENDAR } from "@/lib/board-events";
import type { ChainContract, ChainResponse } from "@/lib/chain";
import type { ContractPick } from "@/lib/contract-pick";
import { stateRows } from "@/lib/desk-eval";
import type { FlowBar, NameStats } from "@/lib/flow";
import { FULL_SESSION_SLOTS, SLOT_MS } from "@/lib/flow";
import type { Options } from "@/lib/options";
import {
  type FlowInput,
  type FlowRowInput,
  type Gate,
  type GateId,
  type Gates,
  gates,
  type GateInput,
  lifecycle,
  type LifecycleInput,
  MARKET_GATES,
  type ScoringClass,
  type SealedSignal,
  signalFor,
  type SignalInput,
  signalWord,
  type SignalWordName,
  type SlotRecord,
  slotsLeft,
  unusable,
  type UsableInput,
  type WordInput,
} from "@/lib/signal";
import { paramsHash, SIGNAL_PARAMS } from "@/lib/signal-params";
import { SIGNAL_CODE_HASH } from "@/lib/signal-version.gen";
import type { NameState, NameStateName, SideState } from "@/lib/trade-state";

vi.mock("@/lib/signal-freeze", async () => {
  const p = await import("@/lib/signal-params");
  const g = await import("@/lib/signal-version.gen");
  return { FROZEN_PARAMS_HASH: p.paramsHash(), FROZEN_CODE_HASH: g.SIGNAL_CODE_HASH };
});

// ---- the scene ------------------------------------------------------------------------------------------------------
// 2026-11-12, a Thursday on EST: 09:30 New York is 14:30Z. Evaluated at 15:31:30Z, 30 slots have settled (0 to 29) and
// the last ends 15:30Z (10:30 New York). The break bar is slot 27, 15:24Z to 15:26Z.
const DAY = "2026-11-12";
const OPEN = Date.parse("2026-11-12T14:30:00Z");
const AS_OF = "2026-11-12T15:31:30.000Z";
const NOW = Date.parse(AS_OF);
const SLOT = OPEN + 30 * SLOT_MS;
const BROKE_AT = OPEN + 28 * SLOT_MS;
const iso = (ms: number) => new Date(ms).toISOString();

const flowBar = (k: number, over: Partial<FlowBar> = {}): FlowBar => ({ start: OPEN + k * SLOT_MS, end: OPEN + (k + 1) * SLOT_MS, o: 100, h: 100.5, l: 99.5, c: 100, v: 1_000, vw: 100, n: 10, ...over });

/** 20 sessions, every slot's median volume 1,000 and median range 0.5; the name's bars' range is 1 (2× the usual). */
const stats = (over: Partial<NameStats> = {}): NameStats => ({
  slot_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 1_000),
  cum_median: Array.from({ length: FULL_SESSION_SLOTS }, (_, k) => 1_000 * (k + 1)),
  range_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 0.5),
  n: 20,
  ...over,
});

const nameBars = (over: (k: number) => Partial<FlowBar> = () => ({})) => Array.from({ length: 30 }, (_, k) => flowBar(k, { ...(k === 27 ? { v: 2_000 } : {}), ...over(k) }));

const row = (bars: FlowBar[] = nameBars(), over: Partial<FlowRowInput> = {}): FlowRowInput => ({
  price: 100.2,
  trade_at: iso(NOW - 1_000),
  bid: 100.19,
  ask: 100.21,
  quote_at: iso(NOW - 1_000),
  bars,
  ...over,
});

/** An index's row whose readings come out up, down or range: steady closes, the price beyond VWAP. */
const indexRow = (dir: "up" | "down" | "range"): FlowRowInput => {
  const step = dir === "up" ? 0.01 : dir === "down" ? -0.01 : 0;
  const bars = Array.from({ length: 30 }, (_, k) => {
    const c = 100 + step * k;
    return flowBar(k, { o: c, h: c + 0.05, l: c - 0.05, c, vw: c });
  });
  const price = dir === "up" ? 100.5 : dir === "down" ? 99.5 : 100;
  return row(bars, { price, bid: price - 0.01, ask: price + 0.01 });
};

const flow = (over: Partial<FlowInput> = {}, idx: { SPY?: "up" | "down" | "range"; QQQ?: "up" | "down" | "range" } = {}): FlowInput => ({
  as_of: AS_OF,
  feed: "sip",
  baseline: { for_session: DAY, names: { AAPL: stats(), SPY: stats(), QQQ: stats() } },
  names: { AAPL: row(), SPY: indexRow(idx.SPY ?? "up"), QQQ: indexRow(idx.QQQ ?? "up") },
  ...over,
});
const withAapl = (r: FlowRowInput, over: Partial<FlowInput> = {}) => flow({ ...over, names: { ...flow().names, AAPL: r } });

const quoted = (kind: "call" | "put", strike: number, over: Partial<ChainContract> = {}): ChainContract => ({
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

const chain = (over: (c: ChainContract) => Partial<ChainContract> = () => ({}), extra: Partial<ChainResponse> = {}): ChainResponse => ({
  as_of: AS_OF,
  served_at: AS_OF,
  feed: "opra",
  delay_min: 0,
  symbol: "AAPL",
  expiries: [{ date: "2026-11-13", contracts: [99, 100, 101].flatMap((k) => (["call", "put"] as const).map((kind) => quoted(kind, k))).map((c) => ({ ...c, ...over(c) })) }],
  ...extra,
});

const gateInput = (over: Partial<GateInput> = {}): GateInput => ({
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

const side = (s: SideState["side"], state: SideState["state"], over: Partial<SideState> = {}): SideState => ({
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

const nameState = (call: SideState, put: SideState = side("put", "watch"), over: Partial<NameState> = {}): NameState => ({
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

const edition = (symbols = ["AAPL"], session = DAY) => ({ session, focus: { items: symbols.map((symbol, i) => ({ symbol, rank: i + 1, bias: "range" })) } }) as unknown as Pick<Options, "session" | "focus">;

/** The slot's DEC-0044 record, holding the rows the state gives. */
const record = (s: NameState, over: Partial<SlotRecord> = {}): SlotRecord => ({
  status: "ok",
  session: DAY,
  slot_end: iso(SLOT),
  degraded_names: [],
  rows: stateRows(s).map((r) => ({ ...r, bar_end: iso(SLOT) })),
  ...over,
});

const signalInput = (s: NameState, over: Partial<SignalInput> = {}): SignalInput => ({
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
const g = <K extends GateId>(id: K, pass: boolean | null, notYet = false): Gate<K> => ({ id, pass, notYet, value: null as never, why: `${id} ${pass}` });
type GateSet = Partial<Record<GateId, boolean | null | "not_yet">>;
const allGates = (over: GateSet = {}): Gates => {
  const one = <K extends GateId>(id: K) => {
    const v = id in over ? over[id]! : true;
    return v === "not_yet" ? g(id, null, true) : g(id, v);
  };
  return { market_direction: one("market_direction"), volume: one("volume"), stock_bid_ask: one("stock_bid_ask"), shock: one("shock"), contract: one("contract") };
};
const word = (over: Partial<WordInput> = {}) => signalWord({ side: "call", rowState: "enter_zone", sideState: { brokeEarlier: false, gap: false }, gates: allGates(), unusable: [], ...over });

// ---- the gates ------------------------------------------------------------------------------------------------------

describe("gates: only the focus names", () => {
  it("a name outside the picked list gets nothing at all; no edition, nothing", () => {
    expect(gates(gateInput({ symbol: "MSFT" }))).toBeNull();
    expect(gates(gateInput({ focus: [] }))).toBeNull();
    const s = nameState(side("call", "enter_zone"));
    expect(signalFor(signalInput(s, { edition: edition(["MSFT"]) }))).toBeNull();
    expect(signalFor(signalInput(s, { edition: null }))).toBeNull();
  });
});

describe("gate: market direction, read from the same flow answer", () => {
  const run = (spy: "up" | "down" | "range", qqq: "up" | "down" | "range", s: "call" | "put" = "call", symbol = "AAPL") =>
    gates(gateInput({ symbol, side: s, focus: [symbol], flow: flow({}, { SPY: spy, QQQ: qqq }) }))!.market_direction;
  it("the scene's index rows read as built", () => {
    expect(run("up", "down").value).toEqual({ SPY: "up", QQQ: "down" });
    expect(run("range", "range").value).toEqual({ SPY: "range", QQQ: "range" });
  });
  it.each([
    ["call", "up", "up", true],
    ["call", "down", "up", true],
    ["call", "range", "down", true],
    ["call", "down", "down", false],
    ["put", "up", "up", false],
    ["put", "up", "down", true],
    ["put", "down", "down", true],
  ] as const)("%s side, SPY %s, QQQ %s: %s", (s, spy, qqq, pass) => {
    expect(run(spy, qqq, s).pass).toBe(pass);
  });
  it("SPY reads QQQ alone, QQQ reads SPY alone", () => {
    expect(run("up", "down", "call", "SPY").pass).toBe(false);
    expect(run("down", "up", "call", "SPY").pass).toBe(true);
    expect(run("up", "down", "put", "QQQ").pass).toBe(false);
  });
  it("an index the answer does not carry, or a stale answer, is not available", () => {
    const noQqq = flow();
    const names = { ...noQqq.names } as Record<string, FlowRowInput>;
    delete names.QQQ;
    expect(gates(gateInput({ flow: { ...noQqq, names } }))!.market_direction.pass).toBeNull();
    expect(gates(gateInput({ flowAgeMs: 20_001 }))!.market_direction.pass).toBeNull();
    expect(gates(gateInput({ flowAgeMs: null }))!.market_direction.pass).toBeNull();
  });
  it("a reading whose own price is older than 20 s is not available", () => {
    const old = flow({ names: { ...flow().names, SPY: { ...indexRow("up"), trade_at: iso(NOW - 19_501) } } });
    expect(gates(gateInput({ flow: old, flowAgeMs: 500 }))!.market_direction.pass).toBeNull();
    const edge = flow({ names: { ...flow().names, SPY: { ...indexRow("up"), trade_at: iso(NOW - 19_500) } } });
    expect(gates(gateInput({ flow: edge, flowAgeMs: 500 }))!.market_direction.pass).toBe(true);
  });
});

describe("gate: volume on the break bar", () => {
  it.each([
    [1_500, true], // exactly 1.5x
    [1_499, false],
    [3_000, true],
  ])("break bar volume %d over a median of 1,000: %s", (v, pass) => {
    const x = gates(gateInput({ flow: withAapl(row(nameBars((k) => (k === 27 ? { v } : {})))) }))!.volume;
    expect(x.pass).toBe(pass);
    expect(x.value).toBe(v / 1_000);
  });
  it("before the break bar exists: not yet, not a fail", () => {
    expect(gates(gateInput({ sideState: { brokeAt: null } }))!.volume).toMatchObject({ pass: null, notYet: true });
  });
  it("not available: no baseline, a thin or stale one, the bar missing", () => {
    const thin = flow({ baseline: { for_session: DAY, names: { AAPL: stats({ n: 9 }) } } });
    const stale = flow({ baseline: { for_session: "2026-11-11", names: { AAPL: stats() } } });
    const missing = withAapl(row(nameBars().filter((b) => b.start !== BROKE_AT - SLOT_MS)));
    for (const f of [flow({ baseline: null }), thin, stale, missing]) expect(gates(gateInput({ flow: f }))!.volume).toMatchObject({ pass: null, notYet: false });
    expect(gates(gateInput({ flow: null }))!.volume.pass).toBeNull();
  });
  it("before 09:35 is judged on the break bar's own time: a bar from 09:34 is not available, one from 09:36 is read", () => {
    const early = gates(gateInput({ sideState: { brokeAt: OPEN + 3 * SLOT_MS } }))!.volume;
    expect(early).toMatchObject({ pass: null, notYet: false });
    expect(early.why).toContain("before 09:35");
    expect(gates(gateInput({ sideState: { brokeAt: OPEN + 4 * SLOT_MS } }))!.volume.pass).toBe(false); // 1,000 over 1,000: read, under 1.5×
  });
});

describe("gate: stock bid–ask", () => {
  const quote = (bid: number | null, ask: number | null, quoteAt = iso(NOW - 1_000)) => withAapl(row(undefined, { bid, ask, quote_at: quoteAt }));
  it("at most 5 bp passes, wider fails", () => {
    expect(gates(gateInput({ flow: quote(199.95, 200.05) }))!.stock_bid_ask.pass).toBe(true); // exactly 5 bp
    expect(gates(gateInput({ flow: quote(199.94, 200.05) }))!.stock_bid_ask.pass).toBe(false); // a cent wider
    expect(gates(gateInput({ flow: quote(99.97, 100.03) }))!.stock_bid_ask.pass).toBe(false); // 6 bp
  });
  it("a locked, crossed or one-sided quote is read and fails", () => {
    for (const [b, a] of [
      [100, 100],
      [100.1, 100],
      [null, 100],
    ] as const)
      expect(gates(gateInput({ flow: quote(b, a) }))!.stock_bid_ask.pass).toBe(false);
  });
  it("a quote older than 20 s by checked age is not available; exactly 20 s still counts", () => {
    expect(gates(gateInput({ flow: quote(100.19, 100.21, iso(NOW - 19_500)), flowAgeMs: 500 }))!.stock_bid_ask.pass).toBe(true);
    expect(gates(gateInput({ flow: quote(100.19, 100.21, iso(NOW - 19_501)), flowAgeMs: 500 }))!.stock_bid_ask.pass).toBeNull();
    expect(gates(gateInput({ flowAgeMs: null }))!.stock_bid_ask.pass).toBeNull();
  });
  it("its reasons say bid–ask, never the other word", () => {
    const x = gates(gateInput({ flow: quote(99.97, 100.03) }))!.stock_bid_ask;
    expect(x.why).toContain("bid–ask");
    expect(x.why).not.toMatch(/spread/i);
  });
});

describe("gate: shock", () => {
  const withRange = (k: number, h: number, l: number) => withAapl(row(nameBars((i) => (i === k ? { h, l } : {}))));
  it("a bar's range at exactly 3× its usual passes; a hundredth of a cent more fails; only the last three bars count", () => {
    expect(gates(gateInput({ flow: withRange(29, 100.75, 99.25) }))!.shock.pass).toBe(true); // 1.5 / 0.5 = 3
    expect(gates(gateInput({ flow: withRange(29, 100.7501, 99.25) }))!.shock.pass).toBe(false);
    expect(gates(gateInput({ flow: withRange(26, 105, 95) }))!.shock.pass).toBe(true); // slot 26 is four bars back
    expect(gates(gateInput())!.shock.value.ranges).toEqual([2, 2, 2]);
  });
  it("exactly 3× on binary-awkward numbers: 0.3 over a median of 0.1", () => {
    const f = withAapl(row(nameBars((i) => (i === 29 ? { h: 100.3, l: 100 } : {}))), { baseline: { for_session: DAY, names: { AAPL: stats({ range_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 0.1) }) } } });
    // the other bars (range 1) are 10× and fail; the bar on the edge alone is asked about
    expect(gates(gateInput({ flow: f }))!.shock.why).toBe("a bar's range is 10.0× its usual, over 3×; a bar's range is 10.0× its usual, over 3×");
    const only = withAapl(row(nameBars((i) => (i >= 27 ? { h: 100.3, l: 100 } : {}))), { baseline: { for_session: DAY, names: { AAPL: stats({ range_median: Array.from({ length: FULL_SESSION_SLOTS }, () => 0.1) }) } } });
    expect(gates(gateInput({ flow: only }))!.shock.pass).toBe(true);
  });
  it("an old baseline with no ranges, or a bar missing, is not available: never a pass", () => {
    const v1: Partial<NameStats> = { ...stats() };
    delete v1.range_median;
    expect(gates(gateInput({ flow: flow({ baseline: { for_session: DAY, names: { AAPL: v1 as NameStats } } }) }))!.shock.pass).toBeNull();
    expect(gates(gateInput({ flow: withAapl(row(nameBars().slice(0, 29))) }))!.shock.pass).toBeNull();
  });
  it("a part that cannot be read leaves the gate not available even when another part fails", () => {
    const v1: Partial<NameStats> = { ...stats() };
    delete v1.range_median;
    const cal = { ...REPO_CALENDAR, macro: [...REPO_CALENDAR.macro, { date: DAY, time_et: "10:45", code: "cpi", quality: "exact" }] };
    expect(gates(gateInput({ calendar: cal }))!.shock.pass).toBe(false);
    expect(gates(gateInput({ calendar: cal, flow: flow({ baseline: { for_session: DAY, names: { AAPL: v1 as NameStats } } }) }))!.shock.pass).toBeNull();
  });
  it("a listed release inside 30 minutes of the slot's end fails, edges included; outside passes", () => {
    const cal = (time: string) => ({ ...REPO_CALENDAR, macro: [...REPO_CALENDAR.macro, { date: DAY, time_et: time, code: "cpi", quality: "exact" }] });
    // the slot ends 10:30 New York
    expect(gates(gateInput({ calendar: cal("11:00") }))!.shock.pass).toBe(false);
    expect(gates(gateInput({ calendar: cal("10:00") }))!.shock.pass).toBe(false);
    expect(gates(gateInput({ calendar: cal("11:01") }))!.shock.pass).toBe(true);
    expect(gates(gateInput({ calendar: cal("09:59") }))!.shock.pass).toBe(true);
    expect(gates(gateInput({ calendar: cal("??") }))!.shock.pass).toBeNull();
  });
  it("earnings during the session fail; with no time listed not available; after the close passes", () => {
    const earn = (when: string | null) => ({ ...REPO_CALENDAR, earnings: [...REPO_CALENDAR.earnings, { date: DAY, symbol: "AAPL", when, quality: "confirmed" }] });
    expect(gates(gateInput({ calendar: earn("during") }))!.shock.pass).toBe(false);
    const untimed = gates(gateInput({ calendar: earn(null) }))!.shock;
    expect(untimed.pass).toBeNull();
    expect(untimed.why).toContain("earnings today, time not listed");
    expect(gates(gateInput({ calendar: earn("amc") }))!.shock.pass).toBe(true);
  });
  it("a day the calendar does not cover is not available", () => {
    expect(gates(gateInput({ flow: flow({ as_of: "2030-01-03T15:31:30.000Z" }) }))!.shock.pass).toBeNull();
  });
  it("a focus name whose earnings the calendar does not keep can never reach CALL: shock not available, gate_unavailable", () => {
    const notKept = { ...REPO_CALENDAR, options_names: ["SPY", "QQQ"] };
    expect(gates(gateInput({ calendar: notKept }))!.shock.pass).toBeNull();
    const s = signalFor(signalInput(nameState(side("call", "enter_zone")), { calendar: notKept }))!;
    expect(s.word).not.toBe("CALL");
    expect(s.scoring).toBe("gate_unavailable");
  });
});

describe("gate: contract", () => {
  it("passes with a named contract, fails with none and names the nearest strike's failed check", () => {
    expect(gates(gateInput())!.contract.pass).toBe(true);
    const none = gates(gateInput({ chain: chain(() => ({ volume: 10 })) }))!.contract;
    expect(none.pass).toBe(false);
    expect(none.why).toBe("no contract inside your rules: nearest strike 100, 10 contracts traded today, under 100");
    expect(gates(gateInput({ chain: null }))!.contract.pass).toBe(false);
  });
});

// ---- usable inputs ----------------------------------------------------------------------------------------------------

describe("unusable inputs", () => {
  const s = nameState(side("call", "enter_zone"));
  const u = (over: Partial<UsableInput> = {}): UsableInput => ({ symbol: "AAPL", side: "call", record: record(s), state: { slotEnd: SLOT, rowState: "enter_zone" }, edition: edition(), flow: flow(), chain: chain(), stamp: { feed: "sip", answered: "ok" }, ...over });
  it("all usable: no reason", () => {
    expect(unusable(u())).toEqual([]);
  });
  it("a board-feed stamp is required, reading SIP that SPY answered", () => {
    expect(unusable(u({ stamp: null }))).toEqual(["no board-feed stamp for the slot"]);
    expect(unusable(u({ stamp: { feed: "iex", answered: "ok" } }))).toEqual(["the board-feed stamp does not show SIP answering"]);
    expect(unusable(u({ stamp: { feed: "sip", answered: "stale" } }))).toEqual(["the board-feed stamp does not show SIP answering"]);
    expect(unusable(u({ stamp: { feed: "sip", answered: "error" } }))).toEqual(["the board-feed stamp does not show SIP answering"]);
  });
  it.each([
    ["no record", { record: null }],
    ["a degraded record", { record: record(s, { status: "degraded" }) }],
    ["the name degraded", { record: record(s, { degraded_names: [{ symbol: "AAPL", reason: "bars-gap" }] }) }],
    ["another session's record", { record: record(s, { session: "2026-11-11" }) }],
    ["another slot's record", { record: record(s, { slot_end: iso(SLOT - SLOT_MS) }) }],
    ["a state from another slot", { state: { slotEnd: SLOT - SLOT_MS, rowState: "enter_zone" as const } }],
    ["a state the record does not hold", { state: { slotEnd: SLOT, rowState: "get_ready" as const } }],
    ["no edition", { edition: null }],
    ["another session's edition", { edition: edition(["AAPL"], "2026-11-11") }],
    ["IEX stock prices", { flow: flow({ feed: "iex" }) }],
    ["no flow answer", { flow: null }],
    ["indicative option quotes", { chain: chain(undefined, { feed: "indicative", delay_min: 15 }) }],
    ["a refused OPRA", { chain: chain(undefined, { feed: "indicative", delay_min: 15, fallback: "opra-refused" }) }],
    ["no chain answer", { chain: null }],
  ])("%s", (_, over) => {
    expect(unusable(u(over as Partial<UsableInput>)).length).toBeGreaterThan(0);
  });
  it("flow feed iex: NO TRADE (data), whatever else is passed", () => {
    const sig = signalFor(signalInput(s, { flow: flow({ feed: "iex" }), stockFeed: "sip" } as unknown as Partial<SignalInput>))!;
    expect(sig).toMatchObject({ word: "NO TRADE", scoring: "not_usable" });
    expect(sig.against).toContain("data: stock prices are not from SIP");
  });
  it("a state the record does not hold for the side is refused: the board said get ready, the caller says enter zone", () => {
    const rec = record(nameState(side("call", "get_ready")));
    const sig = signalFor(signalInput(s, { record: rec }))!;
    expect(sig).toMatchObject({ word: "NO TRADE", scoring: "not_usable" });
    expect(sig.against).toContain("data: the board state is not the record's");
  });
});

// ---- the word: every rule of DEC-0051 section 1 -----------------------------------------------------------------------

type Rule = [string, Partial<WordInput> & { set?: GateSet }, SignalWordName, ScoringClass | null];
const RULES: Rule[] = [
  ["clean enter zone, every gate and a contract: CALL", {}, "CALL", "a"],
  ["clean enter zone on the put side: PUT", { side: "put" }, "PUT", "a"],
  ["no_trade", { rowState: "no_trade" }, "NO TRADE", null],
  ["watch", { rowState: "watch" }, "NO TRADE", null],
  ["plan_off", { rowState: "plan_off" }, "NO TRADE", null],
  ["missed", { rowState: "missed" }, "NO TRADE", null],
  ["paused", { rowState: "paused" }, "NO TRADE", null],
  ["get_ready with brokeEarlier", { rowState: "get_ready", sideState: { brokeEarlier: true, gap: false } }, "NO TRADE", null],
  ["get_ready with gap", { rowState: "get_ready", sideState: { brokeEarlier: false, gap: true } }, "NO TRADE", null],
  ["volume read and failed, enter zone", { set: { volume: false } }, "NO TRADE", "b"],
  ["volume read and failed, get ready", { rowState: "get_ready", set: { volume: false } }, "NO TRADE", "b"],
  ["volume failed on an earlier record of the break", { volumeFailedEarlier: true }, "NO TRADE", "b"],
  ["two market gates failing", { set: { market_direction: false, shock: false } }, "NO TRADE", "b"],
  ["one failing, one not available", { set: { stock_bid_ask: null, shock: false } }, "NO TRADE", "gate_unavailable"],
  ["two failing in get ready", { rowState: "get_ready", set: { market_direction: false, stock_bid_ask: false } }, "NO TRADE", "b"],
  ["no contract, every market gate passing", { set: { contract: false } }, "NO TRADE", "contract_failed"],
  ["no contract and a market gate failing: counted, not scored (second round)", { set: { contract: false, shock: false } }, "NO TRADE", "contract_failed"],
  ["no contract in get ready", { rowState: "get_ready", set: { contract: false } }, "NO TRADE", "contract_failed"],
  ["an input not usable", { unusable: ["x"] }, "NO TRADE", "not_usable"],
  ["get ready, every gate passing: WAIT", { rowState: "get_ready" }, "WAIT", null],
  ["get ready, volume not yet: WAIT", { rowState: "get_ready", set: { volume: "not_yet" } }, "WAIT", null],
  ["get ready, one gate failing: WAIT", { rowState: "get_ready", set: { shock: false } }, "WAIT", "b"],
  ["enter zone, market direction failing: WAIT", { set: { market_direction: false } }, "WAIT", "b"],
  ["enter zone, stock bid–ask failing: WAIT", { set: { stock_bid_ask: false } }, "WAIT", "b"],
  ["enter zone, shock failing: WAIT", { set: { shock: false } }, "WAIT", "b"],
  ["enter zone, shock not available: WAIT", { set: { shock: null } }, "WAIT", "gate_unavailable"],
  ["enter zone, only volume not available: NO TRADE", { set: { volume: null } }, "NO TRADE", "gate_unavailable"],
  ["enter zone with brokeEarlier", { sideState: { brokeEarlier: true, gap: false } }, "NO TRADE", null],
  ["enter zone with gap and a failing gate", { sideState: { brokeEarlier: false, gap: true }, set: { shock: false } }, "NO TRADE", "b"],
];

describe("signalWord: the rule table of section 1", () => {
  it.each(RULES)("%s", (_, x, want, scoring) => {
    const { set, ...rest } = x;
    expect(word({ ...rest, gates: allGates(set) })).toMatchObject({ word: want, scoring });
  });

  it("WAIT names the first missing condition: the retest on get ready, the failing gate in the entry zone", () => {
    expect(word({ rowState: "get_ready" }).missing).toBe("enter_zone");
    const gr = word({ rowState: "get_ready", gates: allGates({ shock: false }) });
    expect(gr.missing).toBe("enter_zone");
    expect(gr.against).toEqual(["not in the entry zone yet", "shock false"]);
    for (const id of ["market_direction", "stock_bid_ask", "shock"] as const) expect(word({ gates: allGates({ [id]: false }) }).missing).toBe(id);
  });
  it("no contract with every market gate passing reads the record's reason", () => {
    expect(word({ gates: allGates({ contract: false }) }).against[0]).toBe("no contract inside your rules");
  });
  it("an unusable input reads data first", () => {
    expect(word({ unusable: ["option quotes are not from OPRA"] }).against[0]).toBe("data: option quotes are not from OPRA");
  });
  it("the reasons: passing gates for, failing gates and the board's cautions against; the other side's cautions are not read", () => {
    const w = word({
      gates: allGates({ shock: false }),
      cautions: [{ why: "a caution on both sides" }, { side: "call", why: "a caution on the call" }, { side: "put", why: "a caution on the put" }],
    });
    expect(w.for).toEqual(["market_direction true", "volume true", "stock_bid_ask true", "contract true"]);
    expect(w.against).toEqual(["shock false", "a caution on both sides", "a caution on the call"]);
  });
  it("cautions change no word", () => {
    expect(word({ cautions: [{ why: "x" }, { side: "call", why: "y" }] }).word).toBe("CALL");
  });
});

describe("signalFor: the board's state as desk-eval reads it", () => {
  it("a clean enter zone with every gate passing: CALL, with each gate's value and both hashes", () => {
    const s = signalFor(signalInput(nameState(side("call", "enter_zone"))))!;
    expect(s).toMatchObject({ word: "CALL", symbol: "AAPL", side: "call", rowState: "enter_zone", brokeAt: BROKE_AT, scoring: "a" });
    expect(s.gates.volume.value).toBe(2);
    expect(s.gates.stock_bid_ask.value.bps).toBeCloseTo(1.996, 3);
    expect((s.gates.contract.value as ContractPick).picked!.occ).toBe("AAPL261113C00100000");
    expect(s.paramsHash).toBe(paramsHash(SIGNAL_PARAMS));
    expect(s.codeHash).toBe(SIGNAL_CODE_HASH);
  });
  it("a row the board holds at no trade or paused reads so on both sides, whatever the side's own state", () => {
    const held = nameState(side("call", "enter_zone"), side("put", "watch"), { state: "no_trade" });
    expect(signalFor(signalInput(held))!).toMatchObject({ word: "NO TRADE", rowState: "no_trade" });
    const paused = nameState(side("call", "enter_zone"), side("put", "watch"), { state: "paused" });
    expect(signalFor(signalInput(paused))!.rowState).toBe("paused");
  });
  it("the put side reads the put's own state", () => {
    const s = nameState(side("call", "watch"), side("put", "enter_zone"));
    expect(signalFor(signalInput(s, { side: "put", flow: flow({}, { SPY: "down", QQQ: "down" }) }))!.word).toBe("PUT");
  });
  it("the alternative triggers are never read: a live one on a watch side is still NO TRADE", () => {
    const alt = { kind: "failed_break" as const, side: "call" as const, level: 100, stop: 101, entry: 99.9, at: BROKE_AT };
    expect(signalFor(signalInput(nameState(side("call", "watch", { alt }), side("put", "watch"), { alt })))!.word).toBe("NO TRADE");
  });

  it("a read volume fail is final for the break: 1,400 earlier, 1,600 now, still NO TRADE", () => {
    const s = nameState(side("call", "enter_zone"));
    const now = withAapl(row(nameBars((k) => (k === 27 ? { v: 1_600 } : {}))));
    expect(signalFor(signalInput(s, { flow: now }))!.word).toBe("CALL"); // 1.6×, with no earlier record
    const earlier: SealedSignal = { session: DAY, symbol: "AAPL", side: "call", brokeAt: BROKE_AT, word: "NO TRADE", volumePass: false, slotEnd: SLOT - SLOT_MS };
    const sig = signalFor(signalInput(s, { flow: now, earlier: [earlier] }))!;
    expect(sig).toMatchObject({ word: "NO TRADE", scoring: "b" });
    expect(sig.against[0]).toBe("the break bar's volume read under the limit earlier: final for this break");
    // another break's, a later slot's, a volume not available, or another side's: not this break's read fail
    for (const other of [
      { ...earlier, brokeAt: BROKE_AT - SLOT_MS },
      { ...earlier, slotEnd: SLOT },
      { ...earlier, volumePass: null },
      { ...earlier, side: "put" as const },
      { ...earlier, session: "2026-11-11" },
    ])
      expect(signalFor(signalInput(s, { flow: now, earlier: [other] }))!.word).toBe("CALL");
  });
});

// ---- the property ---------------------------------------------------------------------------------------------------

/** mulberry32, as EXP-0034's config gives it: a seeded generator, so a failing case can be found again. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const STATES: NameStateName[] = ["no_trade", "watch", "get_ready", "enter_zone", "plan_off", "missed", "paused"];

/** What section 1 says the word is, written out apart from signal.ts, for the property to compare with. */
function expected(x: WordInput): SignalWordName {
  const m = MARKET_GATES.map((id) => x.gates[id]);
  const volFail = x.gates.volume.pass === false || x.volumeFailedEarlier === true;
  const failing = m.filter((gt) => (gt.pass !== true && !gt.notYet) || (gt.id === "volume" && volFail));
  const flagged = x.sideState.brokeEarlier || x.sideState.gap;
  if (x.unusable.length) return "NO TRADE";
  if (["no_trade", "watch", "plan_off", "missed", "paused"].includes(x.rowState)) return "NO TRADE";
  if (x.rowState === "get_ready" && flagged) return "NO TRADE";
  if (volFail || failing.length >= 2 || x.gates.contract.pass !== true) return "NO TRADE";
  // all four must pass: a volume "not yet" is not a fail, but it is not a pass either
  if (x.rowState === "enter_zone" && !flagged && m.every((gt) => gt.pass === true)) return x.side === "call" ? "CALL" : "PUT";
  if (x.rowState === "get_ready") return "WAIT";
  if (x.rowState === "enter_zone" && !flagged && failing.length === 1 && failing[0]!.id !== "volume") return "WAIT";
  return "NO TRADE";
}

describe("the property: CALL or PUT only on a clean entry zone with every gate and a contract passing", () => {
  it("the generator matches the record's test vectors", () => {
    const r = mulberry32(20261159);
    expect([r(), r(), r()].map((u) => Math.round(u * 2 ** 32))).toEqual([552456640, 1000368668, 1413907767]);
  });

  it("holds over 5,000 seeded cases, at least a fifth of them clean enter zones with everything passing", () => {
    const r = mulberry32(51);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const results = [true, true, true, false, null] as const;
    const seen = new Map<SignalWordName, number>();
    let clean = 0;
    for (let i = 0; i < 5_000; i++) {
      const s = pick(["call", "put"] as const);
      const x: WordInput =
        r() < 0.25
          ? { side: s, rowState: "enter_zone", sideState: { brokeEarlier: false, gap: false }, gates: allGates(), unusable: [] }
          : (() => {
              const over: GateSet = {};
              for (const id of [...MARKET_GATES, "contract"] as GateId[]) over[id] = pick(results);
              if (r() < 0.1) over.volume = "not_yet";
              return { side: s, rowState: pick(STATES), sideState: { brokeEarlier: r() < 0.15, gap: r() < 0.15 }, gates: allGates(over), unusable: r() < 0.1 ? ["data"] : [], volumeFailedEarlier: r() < 0.05 };
            })();
      const w = signalWord(x);
      seen.set(w.word, (seen.get(w.word) ?? 0) + 1);
      expect(w.word).toBe(expected(x));
      if (w.word === "CALL" || w.word === "PUT") {
        clean++;
        expect(w.word).toBe(s === "call" ? "CALL" : "PUT");
        expect(x.rowState).toBe("enter_zone");
        expect(x.sideState).toEqual({ brokeEarlier: false, gap: false });
        expect(x.unusable).toEqual([]);
        expect(x.volumeFailedEarlier ?? false).toBe(false);
        for (const id of [...MARKET_GATES, "contract"] as GateId[]) expect(x.gates[id].pass).toBe(true);
        expect(w.scoring).toBe("a");
      } else expect(w.scoring).not.toBe("a");
      if (w.word === "WAIT") expect(["get_ready", "enter_zone"]).toContain(x.rowState);
    }
    expect(clean).toBeGreaterThanOrEqual(1_000);
    for (const wd of ["CALL", "PUT", "WAIT", "NO TRADE"] as const) expect(seen.get(wd) ?? 0).toBeGreaterThan(100);
  });

  it("holds through the real gate functions on 600 seeded scenes", () => {
    const r = mulberry32(7);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const words = new Set<SignalWordName>();
    for (let i = 0; i < 600; i++) {
      const sd = pick(["call", "put"] as const);
      const st = r() < 0.4 ? "enter_zone" : pick(STATES);
      const clean = r() < 0.3;
      const name = nameState(sd === "call" ? side("call", st === "paused" ? "watch" : st) : side("call", "watch"), sd === "put" ? side("put", st === "paused" ? "watch" : st) : side("put", "watch"), { state: st });
      const v = clean ? 2_000 : pick([1_000, 1_500, 2_000, 3_000]);
      const f = flow(
        {
          feed: clean || r() < 0.9 ? "sip" : "iex",
          names: {
            ...flow({}, { SPY: clean ? (sd === "call" ? "up" : "down") : pick(["up", "down", "range"] as const), QQQ: clean ? (sd === "call" ? "up" : "down") : pick(["up", "down", "range"] as const) }).names,
            AAPL: row(nameBars((k) => (k === 27 ? { v } : k === 29 && !clean && r() < 0.2 ? { h: 102, l: 99 } : {})), { bid: 100.19, ask: clean || r() < 0.8 ? 100.21 : 100.4 }),
          },
        },
        {},
      );
      const c = chain(() => (clean || r() < 0.8 ? {} : { volume: 5 }));
      const x = signalInput(name, { side: sd, flow: f, chain: c, flowAgeMs: clean || r() < 0.9 ? 500 : 30_000 });
      const sig = signalFor(x)!;
      words.add(sig.word);
      if (sig.word === "CALL" || sig.word === "PUT") {
        expect(sig.rowState).toBe("enter_zone");
        for (const id of [...MARKET_GATES, "contract"] as GateId[]) expect(sig.gates[id].pass).toBe(true);
        expect(f.feed).toBe("sip");
      }
    }
    expect(words.has("CALL") || words.has("PUT")).toBe(true);
    expect(words.has("NO TRADE")).toBe(true);
  });
});

// ---- the lifecycle --------------------------------------------------------------------------------------------------

describe("lifecycle", () => {
  const slot = (k: number) => OPEN + k * SLOT_MS;
  const now = (k: number, w: SignalWordName, rowState: NameStateName = "enter_zone", brokeAt: number | null = BROKE_AT): LifecycleInput => ({
    session: DAY,
    symbol: "AAPL",
    side: "call",
    brokeAt,
    rowState,
    word: w,
    slotEnd: slot(k),
    evaluatedAt: slot(k) + 90_000,
  });
  const sealed = (k: number, w: SignalWordName, over: Partial<SealedSignal> = {}): SealedSignal => ({ session: DAY, symbol: "AAPL", side: "call", brokeAt: BROKE_AT, word: w, volumePass: true, slotEnd: slot(k), ...over });

  it("counts the retest window as trade-state does: the break bar's start to the forming bar's start", () => {
    expect(slotsLeft(BROKE_AT, slot(30) + 30_000)).toBe(4);
    expect(slotsLeft(BROKE_AT, slot(32) + 30_000)).toBe(2);
  });

  it("a walk: developing, confirmed, weakening, invalidated", () => {
    const log: SealedSignal[] = [];
    const step = (k: number, w: SignalWordName, rowState: NameStateName = "enter_zone") => {
      const l = lifecycle(now(k, w, rowState), log);
      log.push(sealed(k, w));
      return l;
    };
    expect(step(28, "WAIT", "get_ready")).toBe("developing");
    expect(step(29, "CALL")).toBe("confirmed");
    expect(step(30, "WAIT")).toBe("weakening");
    expect(step(31, "CALL")).toBe("confirmed"); // three slots left
    expect(step(32, "CALL")).toBe("weakening"); // two slots left
    expect(step(33, "NO TRADE", "plan_off")).toBe("invalidated");
  });

  it("CALL with two slots or fewer left is weakening", () => {
    expect(lifecycle(now(31, "CALL"), [])).toBe("confirmed");
    expect(lifecycle(now(32, "CALL"), [])).toBe("weakening");
    expect(lifecycle(now(33, "CALL"), [])).toBe("weakening");
  });

  it("a break that never confirmed is never invalidated", () => {
    const log = [sealed(28, "WAIT"), sealed(29, "WAIT")];
    expect(lifecycle(now(30, "NO TRADE", "plan_off"), log)).toBeNull();
    expect(lifecycle(now(30, "NO TRADE", "missed"), log)).toBeNull();
    expect(lifecycle(now(30, "NO TRADE"), [])).toBeNull();
  });

  it("only the same break's own earlier records count", () => {
    const other = [
      sealed(28, "CALL", { brokeAt: BROKE_AT - SLOT_MS }),
      sealed(28, "CALL", { side: "put" }),
      sealed(28, "CALL", { symbol: "MSFT" }),
      sealed(28, "CALL", { session: "2026-11-11" }),
      sealed(31, "CALL"),
      sealed(30, "CALL"),
    ];
    expect(lifecycle(now(30, "NO TRADE"), other)).toBeNull();
    expect(lifecycle(now(30, "WAIT"), other)).toBe("developing");
    expect(lifecycle(now(30, "NO TRADE"), [sealed(29, "PUT")])).toBe("invalidated");
  });

  it("no break: a WAIT is developing, nothing else has a word", () => {
    expect(lifecycle(now(30, "WAIT", "get_ready", null), [sealed(29, "CALL", { brokeAt: null })])).toBe("developing");
    expect(lifecycle(now(30, "NO TRADE", "watch", null), [sealed(29, "CALL", { brokeAt: null })])).toBeNull();
  });
});

// ---- wiring ---------------------------------------------------------------------------------------------------------

describe("the signal is wired to the desk cron's signal step only (stage C2b)", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return files(p);
      return /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : [];
    });
  const specifiers = (file: string): string[] => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };
  const NEW = /(?:^|\/)(?:signal|contract-pick|signal-params|signal-freeze|signal-version\.gen|signal-run|signal-record)$/;
  const importsSignal = (f: string) => specifiers(f).some((s) => NEW.test(s));

  it("under src/app only the desk cron imports the signal's modules, and nothing under src/components does", () => {
    const scanned = [...files(join(ROOT, "src/app")), ...files(join(ROOT, "src/components"))];
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.filter(importsSignal).map((f) => relative(ROOT, f))).toEqual(["src/app/api/cron/desk/route.ts"]);
  });

  it("inside src/lib, only the signal's own modules import one another", () => {
    const users = files(join(ROOT, "src/lib"))
      .filter(importsSignal)
      .map((f) => relative(ROOT, f))
      .sort();
    expect(users).toEqual(["src/lib/contract-pick.ts", "src/lib/signal-record.ts", "src/lib/signal-run.ts", "src/lib/signal.ts"]);
  });

  it("the cron route imports only the step, never the rules", () => {
    const route = join(ROOT, "src/app/api/cron/desk/route.ts");
    expect(specifiers(route).filter((s) => NEW.test(s))).toEqual(["@/lib/signal-run"]);
  });
});
