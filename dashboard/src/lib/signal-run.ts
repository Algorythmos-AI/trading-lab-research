import "server-only";
import { createHash } from "node:crypto";
import { exists, listPaths, PreconditionFailed, readText, writeText } from "./blob";
import { type BoardFeedStamp, minuteOf, stampKey } from "./board-feed-judge";
import { readBoardFeedDay } from "./board-feed-stamp";
import { type ChainContract, type ChainResponse, fetchChain, type Keep } from "./chain";
import { chainAge } from "./contract";
import type { Candidate, ContractPick } from "./contract-pick";
import { barSurge, type FlowBar, nameBaseline, slotClockFromAsOf } from "./flow";
import { BAR_MS, ENGINE_VERSION, expectedSlots, focusSymbols, type RowSide, settledSlotEnd, SIDES, SYMBOL_RE } from "./desk-eval";
import type { LoggedSlot } from "./desk-run";
import { focusPlan } from "./focus-plan";
import { type ServerFlow, serverFlow, FlowUnavailable } from "./flow-route";
import { logEvent } from "./log";
import { nyNow } from "./market-calendar";
import { parseOccSymbol } from "./option-value";
import type { Options } from "./options";
import { alpacaKeys } from "./quote";
import {
  type FlowInput,
  type Gate,
  type Gates,
  gates as workGates,
  indexReading,
  lifecycle,
  type SealedSignal,
  signalFor,
  signalWord,
  unusable,
} from "./signal";
import { FROZEN_CODE_HASH, FROZEN_PARAMS_HASH } from "./signal-freeze";
import { paramsHash, SIGNAL_PARAMS } from "./signal-params";
import {
  type BreakEntry,
  type CandidateEntry,
  type ChainEntry,
  type ContractEntry,
  type DrySide,
  type FollowEntry,
  type IndexEntry,
  type LogSide,
  type NameEntry,
  parseSignalRecord,
  parseSignalSwitch,
  type SideGates,
  signalDayPrefix,
  signalLogPath,
  type SignalRecord,
  SIGNAL_RECORD_V,
  SIGNAL_SWITCH_PATH,
  type SignalSwitch,
  type StockEntry,
  writeMode,
} from "./signal-record";
import { SIGNAL_CODE_HASH } from "./signal-version.gen";
import { fixtureMode } from "./snapshot";
import type { NameState } from "./trade-state";

// The signal step of the desk cron (DEC-0051 section 3, stage C2b): once the run has written a slot's DEC-0044 record,
// and only in that run, this works out the slot's signal record and writes it once, create-only, to
// desk/signal/<New York date>/<HHMM>.json in the private store, under its own switch, desk/signal.json. It shows
// nothing on any page and sends no alert; nothing here places, stages, routes or sizes an order.
//
//  * DEC-0044 is untouched: the step starts after the record's write has settled, reads only what the run handed over
//    (the record's key and exact bytes, the edition, the board's states), and the route ignores what it answers. It
//    catches every error of its own.
//  * Its own budget, SIGNAL_BUDGET_MS (DEC-0051 names none, so 5 s): every read has its own limit inside it, and a
//    record that cannot be written inside it, or inside the slot, is not written at all: a gap, never back-filled.
//  * Inputs, all read on the server, never through HTTP: the flow answer (flow-route.ts serverFlow: SIP by name, the
//    edition's focus names, SPY and QQQ only); one OPRA chain per focus name (chain.ts fetchChain, opra by name, never
//    ALPACA_OPTION_FEED); the board-feed stamps of the minutes that can lie in [t0 − 2 min, t0], t0 the DEC-0044
//    record's evaluated_at (board-feed-stamp.ts readBoardFeedDay, the writer untouched); and the session's latest
//    earlier log record (found through the newest earlier record), whose carried breaks give, in log mode, the
//    lifecycle, the final volume fail and `follow`; a dry record keeps only that record's key (`last_log`).
//  * Picked names only (EXP-0032's blind): a name outside the edition's focus list is never asked for, worked out or
//    stored; SPY and QQQ appear only as the context readings.
//  * Create-only, with its own exists-check. A write that fails or misses the budget is a gap: never tried again.
//  * The switch is read only by a run that can write (one that has just written the slot's DEC-0044 record), not by
//    every run: a run with nothing to write has nothing the switch could change.
//  * Log lines carry counts and outcome words only: never a symbol, a price or a word.

/** The step's whole budget: DEC-0051 section 3 gives the step its own limit and names no number, so 5 s. */
export const SIGNAL_BUDGET_MS = 5_000;
/** Each part's own limit, inside the budget (they add up to it). */
export const SIGNAL_TIMEOUT_MS = { switch: 700, inputs: 2_000, chains: 1_300, write: 1_000 } as const;

export type SignalOutcome =
  | "nothing"
  | "off"
  | "written"
  | "exists"
  | "late"
  | "timeout"
  | "write-failed"
  | "write-timeout"
  | "error";

export interface StampRead {
  key: string;
  feed: string;
  answered: string;
  at: string;
}

export interface ChainRead {
  chain: ChainResponse;
  /** When the answer was received, on the server's clock (ms). */
  receivedAt: number;
}

/** Everything the step touches, injectable so tests run the real logic with no store and no network. */
export interface SignalDeps {
  now(): number;
  readSwitch(): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Create-only: throws PreconditionFailed when the record is already there. */
  write(path: string, body: string): Promise<void>;
  /** The pathnames under a prefix. */
  list(prefix: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** The readable stamps at these keys of the day (missing keys are simply absent). */
  readStamps(day: string, keys: readonly string[]): Promise<StampRead[]>;
  fetchFlow(symbols: readonly string[], edition: Pick<Options, "session" | "focus">): Promise<ServerFlow>;
  /** One name's OPRA chain around `px`, quoting `keep` wherever it sits. */
  fetchChain(symbol: string, px: number, keep: Keep | null): Promise<ChainResponse>;
  /** Tests only: a shorter budget, or shorter limits for its parts. */
  budgetMs?: number;
  timeoutsMs?: Partial<Record<keyof typeof SIGNAL_TIMEOUT_MS, number>>;
}

class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimedOut";
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new TimedOut());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const refuse = () => Promise.reject(new Error("not production: the store and the feeds are not touched"));

/** The deployed dependencies: the private store, Alpaca's SIP and OPRA in production; nothing at all anywhere else. */
export function defaultSignalDeps(): SignalDeps {
  if (fixtureMode() || process.env.VERCEL_ENV !== "production")
    return {
      now: () => Date.now(),
      readSwitch: async () => null, // off: nothing is read, nothing is written
      exists: refuse,
      write: refuse,
      list: refuse,
      read: refuse,
      readStamps: refuse,
      fetchFlow: refuse,
      fetchChain: refuse,
    };
  return {
    now: () => Date.now(),
    readSwitch: async () => (await readText(SIGNAL_SWITCH_PATH))?.text ?? null,
    exists: (path) => exists(path),
    write: async (path, body) => {
      await writeText(path, body, { createOnly: true });
    },
    list: async (prefix) => (await listPaths(prefix)).map((p) => p.pathname).filter((p) => p.startsWith(prefix)),
    read: async (path) => (await readText(path))?.text ?? null,
    // The existing reader, given only the keys asked for: no listing of the day.
    readStamps: async (day, keys) => {
      const got = await readBoardFeedDay(day, { list: async () => keys.map((pathname) => ({ pathname })) });
      return got.stamps.map((s) => ({ key: stampKey(day, minuteOf(s.hhmm)!), feed: s.feed, answered: s.answered, at: s.at }));
    },
    fetchFlow: (symbols, edition) => serverFlow(symbols, edition),
    fetchChain: (symbol, px, keep) => {
      const keys = alpacaKeys();
      if (!keys) return Promise.reject(new Error("no keys"));
      return fetchChain(symbol, px, keys, new Date(), fetch, undefined, keep, "opra");
    },
  };
}

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isoOf = (ms: number | null | undefined) => (isNum(ms) ? new Date(ms).toISOString() : null);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const EDGE_MS = 2 * 60_000;

// ---- the stamp ------------------------------------------------------------------------------------------------------
/** The keys of the minutes whose stamps can have an `at` in [t0 − 2 min, t0]: t0's New York minute and the two before. */
export function stampKeysFor(day: string, t0: number): string[] {
  const m = nyNow(new Date(t0)).minute;
  return [m - 2, m - 1, m].filter((x) => x >= 0).map((x) => stampKey(day, x));
}

/**
 * The stamp the slot is judged by (DEC-0051 section 1, EXP-0033's covering rule 1, EDGE_MS, no bracketing): of the
 * stamps whose `at` lies in [t0 − 2 min, t0], both ends included, the latest reading sip with SPY answering ok; else the
 * latest in the window (not usable); else none.
 */
export function judgeStamp(stamps: readonly StampRead[], t0: number): { stamp: StampRead | null; usable: boolean } {
  const inWindow = stamps
    .map((s) => ({ s, t: Date.parse(s.at) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= t0 && x.t >= t0 - EDGE_MS)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.s);
  const usable = inWindow.filter((s) => s.feed === "sip" && s.answered === "ok");
  if (usable.length) return { stamp: usable.at(-1)!, usable: true };
  return { stamp: inWindow.at(-1) ?? null, usable: false };
}

// ---- the record -----------------------------------------------------------------------------------------------------
export interface BuildInput {
  mode: "dry" | "log";
  switch: Exclude<SignalSwitch, "off">;
  logged: LoggedSlot;
  evaluatedAt: number;
  stamp: { stamp: StampRead | null; usable: boolean };
  flow: ServerFlow | null;
  flowWhy: string | null;
  chains: Readonly<Record<string, ChainRead | null>>;
  /** The session's breaks carried from its latest earlier log record, and that record's key. */
  history: History;
}

/**
 * The session's breaks as carried: from which log record, and whether this slot may read them. `usable` is false when
 * no readable log record of the session was found (and the slot is not the session's first), the newest earlier record
 * is dry, or a slot between the record carried from and this one has no log record: then the lifecycle and the final
 * volume fail are not read, and the slot's class is not_usable.
 */
export interface History {
  breaks: readonly BreakEntry[];
  from: string | null;
  usable: boolean;
}

/** The reason a side carries when its slot cannot read the session's earlier records. */
export const HISTORY_UNUSABLE = "the session's earlier signal records cannot be read in full: no lifecycle and no earlier volume fail";

const flowInputOf = (f: ServerFlow | null): FlowInput | null =>
  f ? { as_of: f.as_of, feed: f.feed, baseline: f.baseline ? { for_session: f.baseline.for_session, names: f.baseline.names } : null, names: f.names } : null;

function indexEntry(flow: FlowInput | null, sym: "SPY" | "QQQ", ageMs: number | null): IndexEntry | null {
  const r = indexReading(flow, sym, ageMs);
  if (!r) return null;
  const row = flow && Object.hasOwn(flow.names, sym) ? flow.names[sym]! : null;
  return {
    symbol: sym,
    direction: r.direction,
    why: r.why,
    price: r.price,
    vwap: r.vwap,
    closes: r.closes,
    bid: row?.bid ?? null,
    ask: row?.ask ?? null,
    spread_bps: r.spread.bps,
    age_ms: r.ageMs,
  };
}

const rawContract = (chain: ChainResponse | null, c: Candidate): ChainContract | null =>
  chain?.expiries
    .filter((e) => e.date === c.expiry)
    .flatMap((e) => (Array.isArray(e.contracts) ? e.contracts : []))
    .find((k) => k?.kind === c.kind && k.strike === c.strike) ?? null;

function contractEntry(p: ContractPick, chain: ChainResponse | null): ContractEntry {
  const candidates: CandidateEntry[] = p.candidates.map((c) => {
    const raw = rawContract(chain, c);
    return {
      occ: c.occ,
      expiry: c.expiry,
      strike: c.strike,
      kind: c.kind,
      bid: raw?.bid ?? null,
      ask: raw?.ask ?? null,
      at: raw?.at ?? null,
      volume: raw?.volume ?? null,
      delta: raw?.delta ?? null,
      failed: c.checks.find((k) => !k.pass)?.id ?? null,
      checks: c.checks.map((k) => ({ id: k.id, pass: k.pass, value: k.value, why: k.why })),
    };
  });
  return { expiry: p.expiry, why: p.why, picked: p.picked?.occ ?? null, candidates };
}

const entry = <V>(g: Gate, value: V) => ({ pass: g.pass, not_yet: g.notYet, why: g.why, value });

function sideGates(g: Gates, chain: ChainResponse | null): SideGates {
  return {
    market_direction: entry(g.market_direction, { SPY: g.market_direction.value.SPY, QQQ: g.market_direction.value.QQQ }),
    volume: entry(g.volume, g.volume.value),
    stock_bid_ask: entry(g.stock_bid_ask, { bps: g.stock_bid_ask.value.bps, age_ms: g.stock_bid_ask.value.ageMs }),
    shock: entry(g.shock, { ranges: [...g.shock.value.ranges], release: g.shock.value.release }),
    contract: entry(g.contract, contractEntry(g.contract.value, chain)),
  };
}

function stockEntry(flow: FlowInput | null, symbol: string, g: Gates | null): StockEntry | null {
  const row = flow && Object.hasOwn(flow.names, symbol) ? flow.names[symbol]! : null;
  if (!row) return null;
  return { price: row.price, bid: row.bid, ask: row.ask, trade_at: row.trade_at, quote_at: row.quote_at, age_ms: g?.stock_bid_ask.value.ageMs ?? null };
}

function volumeSlot(flow: FlowInput | null, symbol: string, slotEnd: number): { value: number | null; why: string | null } {
  if (!flow) return { value: null, why: "no flow answer" };
  const row = Object.hasOwn(flow.names, symbol) ? flow.names[symbol]! : null;
  const bar: FlowBar | null = row?.bars?.find((b) => b.end === slotEnd) ?? null;
  const r = barSurge(bar, nameBaseline(flow.baseline, symbol), slotClockFromAsOf(flow.as_of));
  return r.value === null ? { value: null, why: r.why } : { value: r.value, why: null };
}

function chainEntry(c: ChainRead | null, ageMs: number | null): ChainEntry | null {
  if (!c) return null;
  return { as_of: c.chain.as_of, served_at: c.chain.served_at ?? null, feed: c.chain.feed, fallback: c.chain.fallback ?? null, checked_age_ms: ageMs };
}

/** The chain's checked age at `at`: its newest quote against when it was served, plus the time since it arrived. */
const chainAgeMs = (c: ChainRead | null, at: number): number | null => {
  if (!c) return null;
  const m = chainAge(c.chain, c.receivedAt, at);
  return m === null ? null : Math.round(m * 60_000);
};

const breakKey = (symbol: string, side: RowSide, brokeAt: string) => `${symbol}|${side}|${brokeAt}`;

/** The carried breaks as the plain sealed records the core reads (signal.ts SealedSignal): only words, never an outcome. */
function sealedOf(session: string, breaks: readonly BreakEntry[]): SealedSignal[] {
  const out: SealedSignal[] = [];
  for (const b of breaks) {
    const brokeAt = Date.parse(b.broke_at);
    if (b.confirmed_at) out.push({ session, symbol: b.symbol, side: b.side, brokeAt, word: b.side === "call" ? "CALL" : "PUT", volumePass: null, slotEnd: Date.parse(b.confirmed_at) });
    if (b.volume_failed_at) out.push({ session, symbol: b.symbol, side: b.side, brokeAt, word: "NO TRADE", volumePass: false, slotEnd: Date.parse(b.volume_failed_at) });
  }
  return out;
}

function followOf(breaks: readonly BreakEntry[], chains: Readonly<Record<string, ChainRead | null>>, at: number): FollowEntry[] {
  const out: FollowEntry[] = [];
  for (const b of breaks) {
    if (!b.confirmed_at || !b.occ) continue;
    const c = chains[b.symbol] ?? null;
    const parts = parseOccSymbol(b.occ);
    const raw = c && parts ? c.chain.expiries.filter((e) => e.date === parts.expiry).flatMap((e) => e.contracts).find((k) => k.kind === parts.kind && k.strike === parts.strike) : null;
    const served = c ? Date.parse(c.chain.served_at ?? c.chain.as_of) : NaN;
    const quoteAt = raw?.at ? Date.parse(raw.at) : NaN;
    out.push({
      symbol: b.symbol,
      side: b.side,
      broke_at: b.broke_at,
      occ: b.occ,
      bid: raw?.bid ?? null,
      ask: raw?.ask ?? null,
      at: raw?.at ?? null,
      age_ms: Number.isFinite(served) && Number.isFinite(quoteAt) ? Math.max(0, served - quoteAt) : null,
      checked_age_ms: chainAgeMs(c, at),
      why: !c ? "no option chain" : !raw ? "the contract is not in the chain answer" : null,
    });
  }
  return out;
}

/**
 * The slot's record, from what the step read. Pure. Nothing is worked out for a name outside the edition's focus
 * names, or for any name without an edition for the session. Dry: the gates of every focus name and side with no
 * break bar, and nothing else per side. Log: signal.ts's word, reasons, class and lifecycle per side, from the board's
 * state DEC-0044's run evaluated for the same slot.
 */
export function buildSignalRecord(x: BuildInput): SignalRecord {
  const { logged } = x;
  const slotEnd = logged.slot.end;
  const session = logged.slot.day;
  const edition = logged.edition;
  const recordUnusable: string[] = [];
  if (!edition) recordUnusable.push("no edition");
  else if (edition.session !== session) recordUnusable.push("the edition is for another session");
  const focus = edition && edition.session === session ? focusSymbols(edition).filter((s) => SYMBOL_RE.test(s)) : [];
  const flow = flowInputOf(x.flow);
  const asOf = x.flow ? Date.parse(x.flow.as_of) : NaN;
  const flowAgeMs = Number.isFinite(asOf) ? Math.max(0, x.evaluatedAt - asOf) : null;
  const items = edition?.focus?.items ?? [];

  const common = {
    v: SIGNAL_RECORD_V,
    switch: x.switch,
    session,
    slot_end: new Date(slotEnd).toISOString(),
    evaluated_at: new Date(x.evaluatedAt).toISOString(),
    engine: ENGINE_VERSION,
    params_hash: paramsHash(SIGNAL_PARAMS),
    params_status: SIGNAL_PARAMS.status,
    code_hash: SIGNAL_CODE_HASH,
    frozen_params_hash: FROZEN_PARAMS_HASH,
    frozen_code_hash: FROZEN_CODE_HASH,
    dec0044: { key: logged.path, sha256: sha256(logged.body), status: logged.record.status, reason: logged.record.reason, evaluated_at: logged.record.evaluated_at },
    stamp: x.stamp.stamp ? { key: x.stamp.stamp.key, feed: x.stamp.stamp.feed, answered: x.stamp.stamp.answered, at: x.stamp.stamp.at } : null,
    stamp_usable: x.stamp.usable,
    feed_stock: x.flow?.feed ?? null,
    flow: x.flow ? { as_of: x.flow.as_of, age_ms: flowAgeMs, missing: [...x.flow.missing] } : null,
    flow_why: x.flow ? null : (x.flowWhy ?? "no flow answer"),
    baseline: x.flow?.baseline ? { v: x.flow.baseline.v, for_session: x.flow.baseline.for_session, built_at: x.flow.baseline.built_at, sessions: x.flow.baseline.sessions.length } : null,
    context: { SPY: indexEntry(flow, "SPY", flowAgeMs), QQQ: indexEntry(flow, "QQQ", flowAgeMs) },
    edition: edition ? { session: edition.session, as_of: typeof edition.as_of === "string" ? edition.as_of : null } : null,
    focus,
    unusable: recordUnusable,
  };

  const chainOf = (sym: string) => x.chains[sym] ?? null;
  const gatesFor = (symbol: string, side: RowSide, brokeAt: number | null): Gates => {
    const c = chainOf(symbol);
    return workGates({ symbol, side, focus, sideState: { brokeAt }, flow, flowAgeMs, chain: c?.chain ?? null, chainAgeMs: chainAgeMs(c, x.evaluatedAt) })!;
  };
  const nameBase = <S>(symbol: string, sides: S[], g: Gates | null): NameEntry<S> => ({
    symbol,
    stock: stockEntry(flow, symbol, g),
    volume_slot: volumeSlot(flow, symbol, slotEnd),
    chain: chainEntry(chainOf(symbol), chainAgeMs(chainOf(symbol), x.evaluatedAt)),
    sides,
  });

  if (x.mode === "dry") {
    const names = focus.map((symbol) => {
      // No break bar: the gate inputs do not depend on the board's state (Amendment 1 may not condition on it).
      const sides: DrySide[] = SIDES.map((side) => ({ side, gates: sideGates(gatesFor(symbol, side, null), chainOf(symbol)?.chain ?? null) }));
      return nameBase(symbol, sides, gatesFor(symbol, "call", null));
    });
    // The latest log record before it, by key only, so a later log record can find the session's breaks past dry ones.
    return { ...common, mode: "dry", names, last_log: x.history.from };
  }

  const earlier = x.history.usable ? sealedOf(session, x.history.breaks) : [];
  const states = new Map<string, NameState>(logged.states.map((s) => [s.symbol, s]));
  const evaluatedAt = Number.isFinite(asOf) ? asOf : x.evaluatedAt;
  const stamp = x.stamp.stamp ? { feed: x.stamp.stamp.feed as BoardFeedStamp["feed"], answered: x.stamp.stamp.answered as BoardFeedStamp["answered"] } : null;
  const names = focus.map((symbol) => {
    const st = states.get(symbol) ?? null;
    const item = items.find((i) => i.symbol === symbol) ?? null;
    const plan = item ? focusPlan(item) : null;
    let first: Gates | null = null;
    const sides: LogSide[] = SIDES.map((side) => {
      const c = chainOf(symbol);
      const cardOf = () => {
        const p = plan?.[side] ?? null;
        return p ? { level: p.level, entry: p.entry, stop: p.stop, t1: p.target1 } : null;
      };
      if (st) {
        const s = signalFor({
          side,
          state: { slotEnd, name: st },
          record: logged.record,
          stamp,
          edition,
          flow,
          flowAgeMs,
          chain: c?.chain ?? null,
          chainAgeMs: chainAgeMs(c, x.evaluatedAt),
          earlier,
        });
        if (s) {
          first ??= s.gates;
          const reasons = unusable({ symbol, side, record: logged.record, state: { slotEnd, rowState: s.rowState }, edition, flow, chain: c?.chain ?? null, stamp });
          if (!x.history.usable) reasons.push(HISTORY_UNUSABLE);
          const life = !x.history.usable ? null : lifecycle({ session, symbol, side, brokeAt: s.brokeAt, rowState: s.rowState, word: s.word, slotEnd, evaluatedAt }, earlier);
          return {
            side,
            gates: sideGates(s.gates, c?.chain ?? null),
            state: s.rowState,
            broke_at: isoOf(s.brokeAt),
            broke_earlier: st[side].brokeEarlier,
            gap: st[side].gap,
            card: cardOf(),
            word: s.word,
            lifecycle: life,
            scoring: x.history.usable ? s.scoring : "not_usable",
            missing: s.missing,
            for: s.for,
            against: s.against,
            unusable: reasons,
          };
        }
      }
      // The board has no state for the name (a degraded name, or a record that is not ok): its gates with no break
      // bar, and the word NO TRADE for data, never guessed.
      const g = gatesFor(symbol, side, null);
      first ??= g;
      const reasons = unusable({ symbol, side, record: logged.record, state: { slotEnd, rowState: "no_trade" }, edition, flow, chain: c?.chain ?? null, stamp });
      if (!reasons.includes("the board has no state for this name")) reasons.unshift("the board has no state for this name");
      const w = signalWord({ side, rowState: "no_trade", sideState: { brokeEarlier: false, gap: false }, gates: g, unusable: reasons });
      return {
        side,
        gates: sideGates(g, c?.chain ?? null),
        state: null,
        broke_at: null,
        broke_earlier: null,
        gap: null,
        card: cardOf(),
        word: w.word,
        lifecycle: null,
        scoring: w.scoring,
        missing: w.missing,
        for: w.for,
        against: w.against,
        unusable: reasons,
      };
    });
    return nameBase(symbol, sides, first);
  });

  // The session's breaks, this record's included: confirmations and volume fails are kept from their first record.
  const breaks = x.history.breaks.map((b) => ({ ...b }));
  const index = new Map(breaks.map((b, i) => [breakKey(b.symbol, b.side, b.broke_at), i]));
  const slotIso = new Date(slotEnd).toISOString();
  for (const n of names)
    for (const s of n.sides) {
      if (!s.broke_at) continue;
      const k = breakKey(n.symbol, s.side, s.broke_at);
      let i = index.get(k);
      if (i === undefined) {
        i = breaks.push({ symbol: n.symbol, side: s.side, broke_at: s.broke_at, confirmed_at: null, occ: null, volume_failed_at: null }) - 1;
        index.set(k, i);
      }
      const b = breaks[i]!;
      if ((s.word === "CALL" || s.word === "PUT") && b.confirmed_at === null) {
        b.confirmed_at = slotIso;
        b.occ = s.gates.contract.value.picked;
      }
      if (s.gates.volume.pass === false && b.volume_failed_at === null) b.volume_failed_at = slotIso;
    }
  // `follow`: every break confirmed in an earlier record, quoted again from this slot's chain.
  const follow = followOf(x.history.breaks, x.chains, x.evaluatedAt);
  return { ...common, mode: "log", names, breaks, breaks_from: x.history.from, history_usable: x.history.usable, follow };
}

// ---- the run --------------------------------------------------------------------------------------------------------

/**
 * The session's carried breaks for the slot at `path` (end `slotEnd`). The day's records are listed once and read
 * newest first, stepping back past any that cannot be read or are not this session's version 1 records, until a
 * readable one is found or `deadline` passes. Never throws: what it cannot establish reads as not usable (History).
 * A readable dry record gives its `last_log` key (for a dry record's own `last_log`) and makes the slot not usable.
 */
async function readHistory(deps: SignalDeps, day: string, path: string, slotEnd: number, deadline: number): Promise<History> {
  const none: History = { breaks: [], from: null, usable: false };
  let keys: string[];
  try {
    const prefix = signalDayPrefix(day);
    keys = (await within(deps.list(prefix), deadline - deps.now()))
      .filter((p) => /^\d{4}\.json$/.test(p.slice(prefix.length)) && p < path)
      .sort()
      .reverse();
  } catch {
    return none;
  }
  // The session's first slot has no earlier record to read: nothing carried, and nothing missing.
  if (keys.length === 0) return { breaks: [], from: null, usable: expectedSlots(day)[0] === slotEnd };
  for (const p of keys) {
    let r: SignalRecord | null = null;
    try {
      const text = await within(deps.read(p), deadline - deps.now());
      r = text === null ? null : parseSignalRecord(text);
    } catch (e) {
      if (e instanceof TimedOut) return none;
    }
    if (!r || r.session !== day) continue;
    if (r.mode === "dry") {
      // Not usable; the breaks are still carried (from the log record it names), so a later slot keeps them.
      if (r.last_log === null) return { breaks: [], from: null, usable: false };
      try {
        const t = await within(deps.read(r.last_log), deadline - deps.now());
        const l = t === null ? null : parseSignalRecord(t);
        return l && l.mode === "log" && l.session === day ? { breaks: l.breaks, from: r.last_log, usable: false } : { breaks: [], from: r.last_log, usable: false };
      } catch {
        return { breaks: [], from: r.last_log, usable: false };
      }
    }
    // Contiguous only when the record carried from is this slot's previous one: any slot between without a log record
    // could have held a confirmation or a volume fail.
    return { breaks: r.breaks, from: p, usable: p === keys[0] && Date.parse(r.slot_end) === slotEnd - BAR_MS };
  }
  return none;
}

/**
 * The signal step of one cron run, after the DEC-0044 step. `logged` is what that step handed over when it wrote the
 * slot's record (null otherwise: then nothing is read or written). Never throws.
 */
export async function runSignalStep(logged: LoggedSlot | null, deps: SignalDeps = defaultSignalDeps()): Promise<SignalOutcome> {
  const start = deps.now();
  const deadline = start + (deps.budgetMs ?? SIGNAL_BUDGET_MS);
  const T = { ...SIGNAL_TIMEOUT_MS, ...deps.timeoutsMs };
  const left = (limit: number) => Math.min(limit, deadline - deps.now());
  try {
    const current = settledSlotEnd(start);
    if (!logged) return "nothing";

    let raw: string | null = null;
    try {
      raw = await within(deps.readSwitch(), left(T.switch));
    } catch (e) {
      logEvent("desk-signal.switch", { outcome: "read-failed", error: errName(e) });
    }
    const sw = parseSignalSwitch(raw);
    const mode = writeMode(sw);
    if (mode === null || sw === "off") return "off";

    const { slot } = logged;
    if (slot.end !== current) return done("late", mode, 0, start, deps);
    const path = signalLogPath(slot.day, slot.end);
    const edition = logged.edition && logged.edition.session === slot.day ? logged.edition : null;
    const focus = edition ? focusSymbols(edition).filter((s) => SYMBOL_RE.test(s)) : [];
    const t0 = Date.parse(logged.record.evaluated_at);

    // The inputs side by side, each inside what is left of the inputs' limit.
    const inputsMs = left(T.inputs);
    const soft = <T,>(p: () => Promise<T>): Promise<{ ok: T } | { err: unknown }> =>
      within(p(), inputsMs).then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      );
    const [there, stamps, flowGot, hist] = await Promise.all([
      soft(() => deps.exists(path)),
      soft(() => deps.readStamps(slot.day, stampKeysFor(slot.day, t0))),
      focus.length ? soft(() => deps.fetchFlow([...new Set([...focus, "SPY", "QQQ"])], edition!)) : Promise.resolve({ err: new Error("no focus") }),
      readHistory(deps, slot.day, path, slot.end, deps.now() + inputsMs).then((ok) => ({ ok })),
    ]);
    if ("ok" in there && there.ok) return done("exists", mode, focus.length, start, deps);
    if (!hist.ok.usable && mode === "log") logEvent("desk-signal.history", { outcome: "not-usable" });
    const flow = "ok" in flowGot ? flowGot.ok : null;
    const flowWhy = "ok" in flowGot ? null : flowGot.err instanceof FlowUnavailable ? flowGot.err.why : flowGot.err instanceof TimedOut ? "timeout" : focus.length ? "failed" : "no focus names";
    if (!flow && focus.length) logEvent("desk-signal.flow", { outcome: flowWhy });

    // One OPRA chain per focus name with a price, side by side, quoting a followed contract wherever it sits.
    const keepOf = (sym: string): Keep | null => {
      if (mode === "dry") return null;
      for (const b of hist.ok.breaks) {
        if (b.symbol !== sym || !b.confirmed_at || !b.occ) continue;
        const p = parseOccSymbol(b.occ);
        if (p) return { expiry: p.expiry, strike: p.strike };
      }
      return null;
    };
    const chainsMs = left(T.chains);
    const chains: Record<string, ChainRead | null> = {};
    let chainFails = 0;
    await Promise.all(
      focus.map(async (sym) => {
        const px = flow && Object.hasOwn(flow.names, sym) ? flow.names[sym]!.price : null;
        if (!isNum(px) || px <= 0) {
          chains[sym] = null;
          return;
        }
        try {
          const chain = await within(deps.fetchChain(sym, px, keepOf(sym)), chainsMs);
          chains[sym] = { chain, receivedAt: deps.now() };
        } catch {
          chainFails++;
          chains[sym] = null;
        }
      }),
    );
    if (chainFails) logEvent("desk-signal.chain", { outcome: "failed", count: chainFails });

    const evaluatedAt = deps.now();
    const record = buildSignalRecord({
      mode,
      switch: sw,
      logged,
      evaluatedAt,
      stamp: "ok" in stamps ? judgeStamp(stamps.ok, t0) : { stamp: null, usable: false },
      flow,
      flowWhy,
      chains,
      history: hist.ok,
    });
    const body = JSON.stringify(record);

    // Inside the slot and the budget, or not at all.
    const now = deps.now();
    if (settledSlotEnd(now) !== slot.end) return done("late", mode, focus.length, start, deps);
    if (deadline - now < T.write) return done("timeout", mode, focus.length, start, deps);
    return await write(deps, path, body, mode, focus.length, start, T.write);
  } catch (e) {
    logEvent("desk-signal", { outcome: "error", error: errName(e) });
    return "error";
  }
}

/** One create-only put. A failure of any kind is a gap: it is never tried again (DEC-0051 section 3). */
async function write(deps: SignalDeps, path: string, body: string, mode: "dry" | "log", names: number, start: number, limitMs: number): Promise<SignalOutcome> {
  try {
    await within(deps.write(path, body), limitMs);
  } catch (e) {
    if (e instanceof PreconditionFailed) return done("exists", mode, names, start, deps);
    return done(e instanceof TimedOut ? "write-timeout" : "write-failed", mode, names, start, deps);
  }
  return done("written", mode, names, start, deps);
}

function done(outcome: SignalOutcome, mode: "dry" | "log", names: number, start: number, deps: SignalDeps): SignalOutcome {
  logEvent("desk-signal", { outcome, mode, names, ms: deps.now() - start });
  return outcome;
}
