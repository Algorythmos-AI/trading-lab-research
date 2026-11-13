// The Options desk's signal log (DEC-0051 section 3, EXP-0034's config.yaml `log:`): its switch, where each slot's
// record lives, the record's shape (version 1) and a strict reader for it. The writer is signal-run.ts; the page and
// the read script, later, read records only through parseSignalRecord.
//
// Pure: no I/O and no clock. The switch is read as strictly as desk/eval.json (desk-eval.ts parseEvalSwitch). A
// record is PRIVATE: it names focus names, prices and option contracts, so it lives behind the owner's login only.
//
// Two modes write a record. `dry` holds the gate inputs only, for DEC-0051 Amendment 1's fail shares: every focus name
// and side, whatever the board's state, worked out with no break bar (no `brokeAt`, so nothing conditions on an entry
// zone), the slot's own last bar's volume beside them, and the OPRA quotes of every strike considered. It holds no
// word, no lifecycle, no board state and no card. `log` (and `show`, which writes the same record) holds the full
// record: per side the board's state, the break, the card, the gates, the word, its reasons, the test's class and the
// lifecycle; and the session's carried breaks with the `follow` quotes of every break confirmed earlier.
import type { ContractCheckId, NoContractWhy } from "./contract-pick";
import type { Direction } from "./context";
import { type DegradedWhy, type EvalStatus, nyHhmm, ROW_STATES, type RowSide, SIDES } from "./desk-eval";
import type { GateId, LifecycleWord, ScoringClass, SignalWordName } from "./signal";
import type { NameStateName } from "./trade-state";

// ---- the switch -----------------------------------------------------------------------------------------------------
/** The signal log's switch, read every run that could write: desk/signal.json, `{ "v": 1, "signal": ... }`. */
export const SIGNAL_SWITCH_PATH = "desk/signal.json";
export type SignalSwitch = "off" | "dry" | "log" | "show";
export const SIGNAL_SWITCHES: readonly SignalSwitch[] = ["off", "dry", "log", "show"];

/**
 * The switch, strictly: exactly `{ v: 1, signal: "off" | "dry" | "log" | "show" }` as a plain JSON object of at most
 * 256 characters. Anything else, or nothing, is off. Never throws.
 */
export function parseSignalSwitch(text: unknown): SignalSwitch {
  if (typeof text !== "string" || text.length > 256) return "off";
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "off";
  }
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return "off";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes("v") || !keys.includes("signal") || o.v !== 1) return "off";
  return SIGNAL_SWITCHES.includes(o.signal as SignalSwitch) ? (o.signal as SignalSwitch) : "off";
}

/** What a switch value writes: nothing, the dry record, or the full one (`show` writes exactly what `log` writes). */
export function writeMode(s: SignalSwitch): "dry" | "log" | null {
  return s === "dry" ? "dry" : s === "log" || s === "show" ? "log" : null;
}

// ---- where ----------------------------------------------------------------------------------------------------------
export const SIGNAL_LOG_PREFIX = "desk/signal/";
/** The day's folder: desk/signal/<New York date>/. */
export const signalDayPrefix = (day: string): string => `${SIGNAL_LOG_PREFIX}${day}/`;
/** The one place a slot's signal record lives: desk/signal/<New York date>/<HHMM New York of the slot's end>.json. */
export function signalLogPath(day: string, end: number): string {
  return `${signalDayPrefix(day)}${nyHhmm(end)}.json`;
}

// ---- the record -----------------------------------------------------------------------------------------------------
export const SIGNAL_RECORD_V = 1 as const;

/** One gate as worked out: true passed, false read and failed, null not available (a fail for the word). */
export interface GateEntry<V> {
  pass: boolean | null;
  /** The volume gate before the break bar exists ("not yet", not a fail for WAIT). */
  not_yet: boolean;
  why: string;
  value: V;
}

/** One strike tried by the contract check: the chain's own quote for it, and every check with its value. */
export interface CandidateEntry {
  occ: string | null;
  expiry: string;
  strike: number;
  kind: RowSide;
  /** The chain's quote as given (dollars per share), its own time, day volume and the feed's delta; null when absent. */
  bid: number | null;
  ask: number | null;
  at: string | null;
  volume: number | null;
  delta: number | null;
  /** The first check it failed; null when it passed every one. */
  failed: ContractCheckId | null;
  checks: { id: ContractCheckId; pass: boolean; value: number | null; why: string }[];
}

export interface ContractEntry {
  /** The expiry the rule chose; null when none is listed in range. */
  expiry: string | null;
  /** Why none was named; null when one was. */
  why: NoContractWhy | null;
  /** The named contract's OCC symbol; null when none passed. */
  picked: string | null;
  candidates: CandidateEntry[];
}

export interface SideGates {
  market_direction: GateEntry<{ SPY: Direction | null; QQQ: Direction | null }>;
  volume: GateEntry<number | null>;
  stock_bid_ask: GateEntry<{ bps: number | null; age_ms: number | null }>;
  shock: GateEntry<{ ranges: (number | null)[]; release: string | null }>;
  contract: GateEntry<ContractEntry>;
}

export interface DrySide {
  side: RowSide;
  gates: SideGates;
}

export interface CardEntry {
  level: number | null;
  entry: number | null;
  stop: number | null;
  t1: number | null;
}

export interface LogSide extends DrySide {
  /** The state DEC-0044's record holds for the side; null when the board has none for the name. */
  state: NameStateName | null;
  broke_at: string | null;
  broke_earlier: boolean | null;
  gap: boolean | null;
  card: CardEntry | null;
  word: SignalWordName;
  lifecycle: LifecycleWord | null;
  scoring: ScoringClass | null;
  missing: GateId | "enter_zone" | null;
  for: string[];
  against: string[];
  /** Why an input is not usable (section 1); any one makes the word NO TRADE. */
  unusable: string[];
}

/** The name's own quote as the flow answer gave it; `age_ms` is its checked age (the answer's age plus the quote's). */
export interface StockEntry {
  price: number | null;
  bid: number | null;
  ask: number | null;
  trade_at: string | null;
  quote_at: string | null;
  age_ms: number | null;
}

/** The OPRA chain answer read for the name (calls and puts in one answer). */
export interface ChainEntry {
  as_of: string;
  served_at: string | null;
  feed: string;
  fallback: string | null;
  /** The chain's checked age (contract.ts chainAge on the server's clock), ms. */
  checked_age_ms: number | null;
}

export interface NameEntry<S> {
  symbol: string;
  stock: StockEntry | null;
  /** The slot's own last settled bar's volume over its slot median (flow.ts barSurge): the volume gate's input with no break bar. */
  volume_slot: { value: number | null; why: string | null };
  chain: ChainEntry | null;
  sides: S[];
}

/** SPY's or QQQ's reading with the values that produced it, and its quote. */
export interface IndexEntry {
  symbol: "SPY" | "QQQ";
  direction: Direction | null;
  why: string | null;
  price: number | null;
  vwap: number | null;
  closes: number[];
  bid: number | null;
  ask: number | null;
  spread_bps: number | null;
  age_ms: number | null;
}

/** A break the session's log records have seen, carried from record to record (sealed records only, no outcome). */
export interface BreakEntry {
  symbol: string;
  side: RowSide;
  broke_at: string;
  /** The slot end of the first record whose word was CALL or PUT for it; null while none. */
  confirmed_at: string | null;
  /** The contract named at that first confirmation. */
  occ: string | null;
  /** The slot end of the first record whose volume gate read a fail for it; null while none. */
  volume_failed_at: string | null;
}

/** A contract named by a break confirmed earlier, quoted again at this slot (section 3, `follow`). */
export interface FollowEntry {
  symbol: string;
  side: RowSide;
  broke_at: string;
  occ: string;
  bid: number | null;
  ask: number | null;
  /** The quote's own time, and its age against the chain answer's time. */
  at: string | null;
  age_ms: number | null;
  checked_age_ms: number | null;
  /** Why no quote; null when there is one. */
  why: string | null;
}

interface RecordCommon {
  v: typeof SIGNAL_RECORD_V;
  /** The switch as read for this record. */
  switch: Exclude<SignalSwitch, "off">;
  session: string;
  slot_end: string;
  /** When the signal step worked the record out, on the server's clock. */
  evaluated_at: string;
  engine: string;
  params_hash: string;
  params_status: "candidate" | "frozen";
  code_hash: string;
  /** The hashes Amendment 1 froze (signal-freeze.ts); null while it has frozen nothing. */
  frozen_params_hash: string | null;
  frozen_code_hash: string | null;
  /** The slot's DEC-0044 record as this run wrote it: its key, the SHA-256 of its exact bytes, its status and time. */
  dec0044: { key: string; sha256: string; status: EvalStatus; reason: DegradedWhy | null; evaluated_at: string };
  /** The board-feed stamp the slot was judged by (at in [t0 − 2 min, t0], t0 the DEC-0044 record's evaluated_at). */
  stamp: { key: string; feed: string; answered: string; at: string } | null;
  stamp_usable: boolean;
  /** The stock feed the flow answer named; null when there was none. */
  feed_stock: string | null;
  flow: { as_of: string; age_ms: number | null; missing: string[] } | null;
  /** Why there is no flow answer; null when there is one. */
  flow_why: string | null;
  baseline: { v: number; for_session: string; built_at: string; sessions: number } | null;
  context: { SPY: IndexEntry | null; QQQ: IndexEntry | null };
  edition: { session: string; as_of: string | null } | null;
  /** The edition's focus names worked out, in the card's order: none when there is no edition for the session. */
  focus: string[];
  /** Why nothing could be worked out for any name (no edition, another session's); empty otherwise. */
  unusable: string[];
}

export interface DrySignalRecord extends RecordCommon {
  mode: "dry";
  names: NameEntry<DrySide>[];
  /** The key of the session's latest log record before this one (a key only, never its words); null when none. */
  last_log: string | null;
}

export interface LogSignalRecord extends RecordCommon {
  mode: "log";
  names: NameEntry<LogSide>[];
  /** The session's breaks so far, this record's included. */
  breaks: BreakEntry[];
  /** The earlier record the breaks were carried from; null for the session's first log record. */
  breaks_from: string | null;
  /** False when the session's earlier records could not be read in full: no lifecycle, no earlier volume fail. */
  history_usable: boolean;
  follow: FollowEntry[];
}

export type SignalRecord = DrySignalRecord | LogSignalRecord;

// ---- the strict reader ----------------------------------------------------------------------------------------------
const WORDS: readonly SignalWordName[] = ["CALL", "PUT", "WAIT", "NO TRADE"];
const LIFECYCLE: readonly LifecycleWord[] = ["developing", "confirmed", "weakening", "invalidated"];
const SCORING: readonly ScoringClass[] = ["a", "b", "not_usable", "gate_unavailable", "contract_failed"];
const MISSING: readonly (GateId | "enter_zone")[] = ["market_direction", "volume", "stock_bid_ask", "shock", "contract", "enter_zone"];
const DIRECTIONS: readonly Direction[] = ["up", "down", "range"];
const CHECKS: readonly ContractCheckId[] = ["listed", "quote", "premium", "bid_ask", "volume", "delta"];
const NO_CONTRACT: readonly NoContractWhy[] = ["no-chain", "other-name", "not-opra", "no-expiry", "no-strikes", "none-passed"];
const STATUSES: readonly EvalStatus[] = ["ok", "wrong-day", "no-focus", "degraded"];
const DEGRADED: readonly DegradedWhy[] = [
  "edition-missing",
  "edition-error",
  "store-timeout",
  "bad-symbol",
  "bars-off",
  "bars-failed",
  "bars-timeout",
  "bars-unsettled",
  "snapshot-off",
  "snapshot-failed",
  "snapshot-timeout",
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const HEX64 = /^[0-9a-f]{64}$/;

type O = Record<string, unknown>;
const obj = (v: unknown): v is O => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/** Exactly these keys, no more and no fewer. */
const exact = (v: unknown, keys: readonly string[]): v is O => obj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numN = (v: unknown) => v === null || num(v);
const strN = (v: unknown) => v === null || str(v);
const boolN = (v: unknown) => v === null || typeof v === "boolean";
const iso = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const isoN = (v: unknown) => v === null || iso(v);
const oneOf = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
const strs = (v: unknown) => Array.isArray(v) && v.every(str);
const all = <T>(v: unknown, ok: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every((x) => ok(x));

const gate = (v: unknown, value: (x: unknown) => boolean): boolean =>
  exact(v, ["pass", "not_yet", "why", "value"]) && boolN(v.pass) && typeof v.not_yet === "boolean" && str(v.why) && value(v.value);

const candidate = (v: unknown): v is CandidateEntry =>
  exact(v, ["occ", "expiry", "strike", "kind", "bid", "ask", "at", "volume", "delta", "failed", "checks"]) &&
  strN(v.occ) &&
  str(v.expiry) &&
  DAY_RE.test(v.expiry) &&
  num(v.strike) &&
  oneOf(SIDES, v.kind) &&
  numN(v.bid) &&
  numN(v.ask) &&
  isoN(v.at) &&
  numN(v.volume) &&
  numN(v.delta) &&
  (v.failed === null || oneOf(CHECKS, v.failed)) &&
  Array.isArray(v.checks) &&
  v.checks.every((c) => exact(c, ["id", "pass", "value", "why"]) && oneOf(CHECKS, c.id) && typeof c.pass === "boolean" && numN(c.value) && str(c.why));

const contract = (v: unknown): boolean =>
  exact(v, ["expiry", "why", "picked", "candidates"]) &&
  (v.expiry === null || (str(v.expiry) && DAY_RE.test(v.expiry))) &&
  (v.why === null || oneOf(NO_CONTRACT, v.why)) &&
  strN(v.picked) &&
  all(v.candidates, candidate);

const dirN = (v: unknown) => v === null || oneOf(DIRECTIONS, v);

const sideGates = (v: unknown): v is SideGates =>
  exact(v, ["market_direction", "volume", "stock_bid_ask", "shock", "contract"]) &&
  gate(v.market_direction, (x) => exact(x, ["SPY", "QQQ"]) && dirN(x.SPY) && dirN(x.QQQ)) &&
  gate(v.volume, numN) &&
  gate(v.stock_bid_ask, (x) => exact(x, ["bps", "age_ms"]) && numN(x.bps) && numN(x.age_ms)) &&
  gate(v.shock, (x) => exact(x, ["ranges", "release"]) && Array.isArray(x.ranges) && x.ranges.every(numN) && strN(x.release)) &&
  gate(v.contract, contract);

const drySide = (v: unknown): v is DrySide => exact(v, ["side", "gates"]) && oneOf(SIDES, v.side) && sideGates(v.gates);

const card = (v: unknown) => v === null || (exact(v, ["level", "entry", "stop", "t1"]) && numN(v.level) && numN(v.entry) && numN(v.stop) && numN(v.t1));

const LOG_SIDE_KEYS = ["side", "gates", "state", "broke_at", "broke_earlier", "gap", "card", "word", "lifecycle", "scoring", "missing", "for", "against", "unusable"];
const logSide = (v: unknown): v is LogSide =>
  exact(v, LOG_SIDE_KEYS) &&
  oneOf(SIDES, v.side) &&
  sideGates(v.gates) &&
  (v.state === null || oneOf(ROW_STATES, v.state)) &&
  isoN(v.broke_at) &&
  boolN(v.broke_earlier) &&
  boolN(v.gap) &&
  card(v.card) &&
  oneOf(WORDS, v.word) &&
  (v.lifecycle === null || oneOf(LIFECYCLE, v.lifecycle)) &&
  (v.scoring === null || oneOf(SCORING, v.scoring)) &&
  (v.missing === null || oneOf(MISSING, v.missing)) &&
  strs(v.for) &&
  strs(v.against) &&
  strs(v.unusable);

const stock = (v: unknown) =>
  v === null ||
  (exact(v, ["price", "bid", "ask", "trade_at", "quote_at", "age_ms"]) && numN(v.price) && numN(v.bid) && numN(v.ask) && strN(v.trade_at) && strN(v.quote_at) && numN(v.age_ms));

const chainEntry = (v: unknown) =>
  v === null || (exact(v, ["as_of", "served_at", "feed", "fallback", "checked_age_ms"]) && str(v.as_of) && strN(v.served_at) && str(v.feed) && strN(v.fallback) && numN(v.checked_age_ms));

const nameEntry =
  (side: (x: unknown) => boolean) =>
  (v: unknown): boolean =>
    exact(v, ["symbol", "stock", "volume_slot", "chain", "sides"]) &&
    str(v.symbol) &&
    SYMBOL.test(v.symbol) &&
    stock(v.stock) &&
    exact(v.volume_slot, ["value", "why"]) &&
    numN(v.volume_slot.value) &&
    strN(v.volume_slot.why) &&
    chainEntry(v.chain) &&
    Array.isArray(v.sides) &&
    v.sides.length <= 2 &&
    v.sides.every(side) &&
    new Set(v.sides.map((s) => (s as O).side)).size === v.sides.length;

const indexEntry = (sym: "SPY" | "QQQ") => (v: unknown) =>
  v === null ||
  (exact(v, ["symbol", "direction", "why", "price", "vwap", "closes", "bid", "ask", "spread_bps", "age_ms"]) &&
    v.symbol === sym &&
    dirN(v.direction) &&
    strN(v.why) &&
    numN(v.price) &&
    numN(v.vwap) &&
    Array.isArray(v.closes) &&
    v.closes.every(num) &&
    numN(v.bid) &&
    numN(v.ask) &&
    numN(v.spread_bps) &&
    numN(v.age_ms));

const breakEntry = (v: unknown): v is BreakEntry =>
  exact(v, ["symbol", "side", "broke_at", "confirmed_at", "occ", "volume_failed_at"]) &&
  str(v.symbol) &&
  SYMBOL.test(v.symbol) &&
  oneOf(SIDES, v.side) &&
  iso(v.broke_at) &&
  isoN(v.confirmed_at) &&
  strN(v.occ) &&
  isoN(v.volume_failed_at);

const followEntry = (v: unknown): v is FollowEntry =>
  exact(v, ["symbol", "side", "broke_at", "occ", "bid", "ask", "at", "age_ms", "checked_age_ms", "why"]) &&
  str(v.symbol) &&
  oneOf(SIDES, v.side) &&
  iso(v.broke_at) &&
  str(v.occ) &&
  numN(v.bid) &&
  numN(v.ask) &&
  isoN(v.at) &&
  numN(v.age_ms) &&
  numN(v.checked_age_ms) &&
  strN(v.why);

const COMMON_KEYS = [
  "v",
  "mode",
  "switch",
  "session",
  "slot_end",
  "evaluated_at",
  "engine",
  "params_hash",
  "params_status",
  "code_hash",
  "frozen_params_hash",
  "frozen_code_hash",
  "dec0044",
  "stamp",
  "stamp_usable",
  "feed_stock",
  "flow",
  "flow_why",
  "baseline",
  "context",
  "edition",
  "focus",
  "unusable",
  "names",
];
const DRY_KEYS = [...COMMON_KEYS, "last_log"];
const LOG_KEYS = [...COMMON_KEYS, "breaks", "breaks_from", "history_usable", "follow"];

function common(v: O): boolean {
  const d = v.dec0044;
  const s = v.stamp;
  const f = v.flow;
  const b = v.baseline;
  const c = v.context;
  const e = v.edition;
  return (
    v.v === SIGNAL_RECORD_V &&
    str(v.session) &&
    DAY_RE.test(v.session) &&
    iso(v.slot_end) &&
    iso(v.evaluated_at) &&
    str(v.engine) &&
    str(v.params_hash) &&
    HEX64.test(v.params_hash) &&
    oneOf(["candidate", "frozen"], v.params_status) &&
    str(v.code_hash) &&
    (v.frozen_params_hash === null || (str(v.frozen_params_hash) && HEX64.test(v.frozen_params_hash))) &&
    strN(v.frozen_code_hash) &&
    exact(d, ["key", "sha256", "status", "reason", "evaluated_at"]) &&
    str(d.key) &&
    str(d.sha256) &&
    HEX64.test(d.sha256) &&
    oneOf(STATUSES, d.status) &&
    (d.reason === null || oneOf(DEGRADED, d.reason)) &&
    iso(d.evaluated_at) &&
    (s === null || (exact(s, ["key", "feed", "answered", "at"]) && str(s.key) && str(s.feed) && str(s.answered) && str(s.at))) &&
    typeof v.stamp_usable === "boolean" &&
    strN(v.feed_stock) &&
    (f === null || (exact(f, ["as_of", "age_ms", "missing"]) && iso(f.as_of) && numN(f.age_ms) && strs(f.missing))) &&
    strN(v.flow_why) &&
    (b === null || (exact(b, ["v", "for_session", "built_at", "sessions"]) && num(b.v) && str(b.for_session) && str(b.built_at) && num(b.sessions))) &&
    exact(c, ["SPY", "QQQ"]) &&
    indexEntry("SPY")(c.SPY) &&
    indexEntry("QQQ")(c.QQQ) &&
    (e === null || (exact(e, ["session", "as_of"]) && str(e.session) && strN(e.as_of))) &&
    strs(v.focus) &&
    (v.focus as string[]).every((x) => SYMBOL.test(x)) &&
    strs(v.unusable)
  );
}

/**
 * A stored signal record read back, strictly: version 1, exactly the keys of its mode at every level, every enum one of
 * its own words, every instant a canonical ISO time. Null for anything else; never throws. A dry record can never carry
 * a word, a lifecycle, a state, a card or carried breaks: those keys are not in its shape.
 */
export function parseSignalRecord(text: string): SignalRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj(v)) return null;
  if (v.mode === "dry") {
    if (!exact(v, DRY_KEYS) || v.switch !== "dry" || !common(v) || !strN(v.last_log) || !Array.isArray(v.names) || !v.names.every(nameEntry(drySide))) return null;
    return v as unknown as DrySignalRecord;
  }
  if (v.mode === "log") {
    if (!exact(v, LOG_KEYS) || !oneOf(["log", "show"], v.switch) || !common(v) || !Array.isArray(v.names) || !v.names.every(nameEntry(logSide))) return null;
    if (!all(v.breaks, breakEntry) || strN(v.breaks_from) === false || typeof v.history_usable !== "boolean" || !all(v.follow, followEntry)) return null;
    return v as unknown as LogSignalRecord;
  }
  return null;
}
