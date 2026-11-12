// The Options desk's signal word (DEC-0051): for one focus name and one side, CALL (or PUT), WAIT or NO TRADE, from the
// board's own state for that side and a fixed list of gates, with the reasons for and against, and a lifecycle word
// read from the session's own earlier sealed records. The record governs; its section numbers are cited below.
//
// Pure rules only: no I/O, no clock, no route, nothing drawn and nothing logged. Every input is plain data the caller
// passes: the slot's DEC-0044 record and the board's state for that same slot (trade-state.ts and desk-eval.ts,
// imported, never changed), the flow answer and its checked age (SPY's and QQQ's readings are worked out here from that
// same answer, context.ts direction), the OPRA chain and its checked age, the calendars, and the session's own earlier
// sealed signal records. The slot clock is the flow answer's own `as_of`, never a device's.
//
// No caller can loosen it. The numbers are this module's SIGNAL_PARAMS only, the frozen hashes are signal-freeze.ts's
// constants only, and the feeds are read from the answers themselves. While Amendment 1 has frozen nothing (both
// hashes null), every word is NO TRADE (data).
//
// It never changes a state, a level, a rule or an alert. A word is the lab's advisory reading, marked Testing, display
// only: nothing here places, stages, routes or sizes an order. Nothing is worked out for a name that is not one of the
// session edition's focus names (EXP-0032's blind). The board's alternatives and the runner exit line are never read.
// No percentage, score or confidence: a word's strength is its list of gates, each pass or fail with its value.
import { boardEvents, type EventCalendar, REPO_CALENDAR } from "./board-events";
import type { ChainResponse } from "./chain";
import { direction, type Direction, indexInput, type IndexReading, spreadWords, STALE_MS, whyWords } from "./context";
import { type Candidate, type ContractPick, nearestFailure, noContractWords, pickContract } from "./contract-pick";
import { focusSymbols, type RowSide, type ServerRecord, settledSlotEnd, stateRows } from "./desk-eval";
import type { Caution } from "./entry-checks";
import {
  barRange,
  barSurge,
  completedBars,
  type FlowBar,
  type FlowCalendar,
  MARKET_CALENDAR,
  nameBaseline,
  type NameStats,
  type RangeWhy,
  type SlotClock,
  SLOT_MS,
  slotClockFromAsOf,
  spreadBps,
} from "./flow";
import { nyInstant, type Options } from "./options";
import { FROZEN_CODE_HASH, FROZEN_PARAMS_HASH } from "./signal-freeze";
import { paramsHash, SIGNAL_PARAMS } from "./signal-params";
import { SIGNAL_CODE_HASH } from "./signal-version.gen";
import { FIRST_ENTRY_MIN, MAX_BARS_TO_RETEST, type NameState, type NameStateName, type SideState } from "./trade-state";

export type SignalWordName = "CALL" | "PUT" | "WAIT" | "NO TRADE";
export type GateId = "market_direction" | "volume" | "stock_bid_ask" | "shock" | "contract";
/** The four market gates of section 2, in the record's order. The contract check is not one of them. */
export const MARKET_GATES: readonly GateId[] = ["market_direction", "volume", "stock_bid_ask", "shock"];
/** The test's groups (section 8): the class a slot would take were it a break's scoring slot. */
export type ScoringClass = "a" | "b" | "not_usable" | "gate_unavailable" | "contract_only";

/** What each gate read: the value that produced its pass or fail. */
export interface GateValues {
  market_direction: { SPY: Direction | null; QQQ: Direction | null };
  /** The break bar's volume over its slot's median. */
  volume: number | null;
  /** The name's own bid–ask in basis points, and the quote's checked age (ms). */
  stock_bid_ask: { bps: number | null; ageMs: number | null };
  /** Each of the last three completed bars' range over its slot's median range (oldest first), and a release in the window. */
  shock: { ranges: (number | null)[]; release: string | null };
  contract: ContractPick;
}

export interface Gate<K extends GateId = GateId> {
  id: K;
  /** true passed, false read and failed, null could not be read (the record's gate_unavailable): null fails the word. */
  pass: boolean | null;
  /** The volume gate before the break bar exists: "not yet", not a fail for WAIT (section 1). */
  notYet: boolean;
  value: GateValues[K];
  why: string;
}

export type Gates = { [K in GateId]: Gate<K> };

/** One name's row of the flow answer (flow-route.ts FlowRow): the fields read here. */
export interface FlowRowInput {
  price: number | null;
  trade_at: string | null;
  bid: number | null;
  ask: number | null;
  quote_at: string | null;
  bars: FlowBar[] | null;
}

/** The /api/flow answer as far as the signal reads it (flow-route.ts FlowAnswer), server side, ranges included. */
export interface FlowInput {
  as_of: string;
  /** The feed the answer names: only "sip" is usable (section 4). */
  feed: string;
  baseline: { for_session: string; names: Readonly<Record<string, NameStats>> } | null;
  names: Readonly<Record<string, FlowRowInput>>;
}

export interface GateInput {
  symbol: string;
  side: RowSide;
  /** The session edition's focus names: a name not among them gets no gates at all. */
  focus: readonly string[];
  /** The side's own state (trade-state.ts SideState): its `brokeAt` names the break bar. */
  sideState: Pick<SideState, "brokeAt">;
  flow: FlowInput | null;
  /** The flow answer's checked age (flow-request.ts), ms; null when it cannot be judged. */
  flowAgeMs: number | null;
  chain: ChainResponse | null;
  /** The chain answer's checked age (option-value.ts checkedAgeMs), ms. */
  chainAgeMs: number | null;
  calendar?: EventCalendar;
  sessions?: FlowCalendar;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const at = (iso: string | null | undefined): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const fmt = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const rangeWhyWords = (why: RangeWhy, clock: SlotClock | null) => (why === "no-range-baseline" ? "no range baseline" : whyWords(why, clock));
const rowOf = (flow: FlowInput | null, symbol: string) => (flow && Object.hasOwn(flow.names, symbol) ? flow.names[symbol]! : null);

// ---- the gates (section 2) ------------------------------------------------------------------------------------------

/** SPY's or QQQ's reading, worked out from the same flow answer as the name's (so from the same SIP feed). */
export function indexReading(flow: FlowInput | null, symbol: "SPY" | "QQQ", flowAgeMs: number | null): IndexReading | null {
  return flow ? direction(indexInput(flow, symbol, flowAgeMs)) : null;
}

/**
 * 2.1 Market direction. The call side fails when SPY and QQQ both read down, the put side when both read up; for SPY
 * or QQQ itself the other index alone is read. A reading with no direction, or one older than STALE_MS by its own
 * age, cannot be read: null, and so a fail.
 */
function directionGate(x: GateInput): Gate<"market_direction"> {
  const read = (sym: "SPY" | "QQQ") => indexReading(x.flow, sym, x.flowAgeMs);
  const readings = { SPY: read("SPY"), QQQ: read("QQQ") };
  const fresh = (r: IndexReading | null) => r !== null && r.direction !== null && isNum(r.ageMs) && r.ageMs <= STALE_MS;
  const value = { SPY: fresh(readings.SPY) ? readings.SPY!.direction : null, QQQ: fresh(readings.QQQ) ? readings.QQQ!.direction : null };
  const context: ("SPY" | "QQQ")[] = x.symbol === "SPY" ? ["QQQ"] : x.symbol === "QQQ" ? ["SPY"] : ["SPY", "QQQ"];
  const missing = context.filter((s) => value[s] === null);
  if (missing.length) {
    const why = missing.map((s) => `${s}: ${readings[s]?.why ? whyWords(readings[s]!.why!) : readings[s] ? "prices are stale" : "no reading"}`).join("; ");
    return { id: "market_direction", pass: null, notYet: false, value, why: `market direction not available (${why})` };
  }
  const against: Direction = x.side === "call" ? "down" : "up";
  const words = context.map((s) => `${s} ${value[s]}`).join(", ");
  const fails = context.every((s) => value[s] === against);
  return { id: "market_direction", pass: !fails, notYet: false, value, why: fails ? `the market leans against the ${x.side}: ${words}` : `the market does not lean against the ${x.side}: ${words}` };
}

/**
 * 2.2 Volume: the bar ending at `brokeAt` (the break bar), its volume over its slot's median, at least the number.
 * "Before 09:35" is judged on the break bar's own time: a break bar that starts before 09:35 New York is not
 * available, whenever it is read (barSurge also refuses a clock before 09:35).
 */
function volumeGate(x: GateInput, clock: SlotClock | null): Gate<"volume"> {
  const p = SIGNAL_PARAMS;
  const brokeAt = x.sideState.brokeAt;
  if (!isNum(brokeAt)) return { id: "volume", pass: null, notYet: true, value: null, why: "volume: not yet (no break bar)" };
  const first = clock ? nyInstant(clock.day, FIRST_ENTRY_MIN) : null;
  if (first === null || brokeAt - SLOT_MS < first) return { id: "volume", pass: null, notYet: false, value: null, why: "break bar volume not available (the break bar starts before 09:35)" };
  const bar = rowOf(x.flow, x.symbol)?.bars?.find((b) => b.start === brokeAt - SLOT_MS && b.end === brokeAt) ?? null;
  const r = barSurge(bar, nameBaseline(x.flow?.baseline ?? null, x.symbol), clock);
  if (r.value === null) return { id: "volume", pass: null, notYet: false, value: null, why: `break bar volume not available (${whyWords(r.why, clock)})` };
  const pass = r.value >= p.volume_min_ratio;
  return { id: "volume", pass, notYet: false, value: r.value, why: `break bar volume ${fmt(r.value)}× its usual, ${pass ? "at least" : "under"} ${p.volume_min_ratio}×` };
}

/** 2.3 The name's own bid–ask: at most the number, on a quote no older than 20 s by checked age. */
function bidAskGate(x: GateInput): Gate<"stock_bid_ask"> {
  const p = SIGNAL_PARAMS;
  const row = rowOf(x.flow, x.symbol);
  const asOf = at(x.flow?.as_of);
  const quoteAt = at(row?.quote_at);
  const ageMs = isNum(x.flowAgeMs) && asOf !== null && quoteAt !== null ? x.flowAgeMs + Math.max(0, asOf - quoteAt) : null;
  const s = spreadBps(row?.bid ?? null, row?.ask ?? null);
  const value = { bps: s.bps, ageMs };
  // Stale first: a quote that cannot be trusted is not read at all, whatever its shape.
  if (!row || ageMs === null || ageMs > STALE_MS) return { id: "stock_bid_ask", pass: null, notYet: false, value, why: "stock bid–ask not available (the quote is stale)" };
  if (s.bps === null) return { id: "stock_bid_ask", pass: false, notYet: false, value, why: `stock quote ${spreadWords(s)}` };
  // The limit compared in whole ten-thousandths of a dollar, so a quote on the edge passes exactly: (ask − bid) ÷ mid ×
  // 10,000 ≤ max is 2 × (ask − bid) × 10,000 ≤ max × (ask + bid). The value shown is flow.ts spreadBps.
  const b = Math.round(row.bid! * 10_000);
  const a = Math.round(row.ask! * 10_000);
  const pass = 2 * (a - b) * 10_000 <= p.stock_spread_max_bps * (a + b);
  return { id: "stock_bid_ask", pass, notYet: false, value, why: `stock ${spreadWords(s)}, ${pass ? "within" : "over"} ${p.stock_spread_max_bps} bp` };
}

const minutesOf = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * 2.4 Shock: none of the last three completed bars with a range above the multiple of its slot's median range, and
 * no listed release from the window before the slot's end to the window after it, and no earnings for the name during
 * the session.
 *
 * Any part that cannot be read leaves the whole gate null, even when another part reads a fail. DEC-0051 section 2: "A
 * gate whose value cannot be worked out ("not available", for any reason) fails for the word"; and EXP-0034's config,
 * unit.group_order: gate_unavailable is "a market gate could not be read (thin, stale or missing baseline, stale quote,
 * calendar gap, lagging)". A gate with a part unread has a value that cannot be worked out, so it is that group.
 *
 * A focus name whose earnings dates the calendar does not keep (or has let run out) can therefore never reach CALL or
 * PUT: its shock gate is never readable, and its breaks score gate_unavailable.
 */
function shockGate(x: GateInput, clock: SlotClock | null, calendar: EventCalendar): Gate<"shock"> {
  const p = SIGNAL_PARAMS;
  const value: GateValues["shock"] = { ranges: [], release: null };
  const fails: string[] = [];
  const unread: string[] = [];

  // The bars, compared in whole ten-thousandths so a range on the edge passes exactly: range > multiple × median is
  // range × 10 > (multiple × 10) × median, the multiple on its grid of halves.
  const row = rowOf(x.flow, x.symbol);
  if (!clock || clock.completed < 3) unread.push(clock ? "fewer than three completed bars" : "market closed");
  else {
    const base = nameBaseline(x.flow?.baseline ?? null, x.symbol);
    const done = new Map(completedBars(row?.bars ?? [], clock).map((b) => [b.slot, b.bar]));
    const mult = Math.round(p.shock_range_multiple * 10);
    for (let k = clock.completed - 3; k < clock.completed; k++) {
      const bar = done.get(k) ?? null;
      const r = barRange(bar, base, clock);
      value.ranges.push(r.value);
      if (r.value === null) {
        unread.push(`bar range not available (${rangeWhyWords(r.why, clock)})`);
        continue;
      }
      const range = Math.round((bar!.h - bar!.l) * 10_000);
      const median = Math.round(base!.range_median![k]! * 10_000);
      if (range * 10 > mult * median) fails.push(`a bar's range is ${fmt(r.value)}× its usual, over ${p.shock_range_multiple}×`);
    }
  }

  // The calendar: releases in the window, and the name's earnings during the session.
  if (!clock) unread.push("no session clock");
  else {
    const ev = boardEvents({ session: clock.day, now: clock.now, names: [x.symbol], calendar });
    if (ev.some((e) => e.kind === "not_covered")) unread.push("the event calendar does not cover the day");
    if (ev.some((e) => e.kind === "earnings_not_kept" || e.kind === "earnings_not_listed")) unread.push("the event calendar has no earnings dates for this name");
    if (ev.some((e) => e.symbol === x.symbol && e.kind === "earnings_today")) unread.push("earnings today, time not listed");
    if (ev.some((e) => e.symbol === x.symbol && e.kind === "earnings_during")) fails.push("earnings during the session");
    const slotEnd = clock.open + clock.completed * SLOT_MS;
    for (const r of calendar.macro.filter((m) => m.date === clock.day)) {
      const min = minutesOf(r.time_et);
      const when = min === null ? null : nyInstant(clock.day, min);
      if (when === null) {
        unread.push("a release with no time listed");
        continue;
      }
      if (when >= slotEnd - p.event_window_before_min * 60_000 && when <= slotEnd + p.event_window_after_min * 60_000) {
        value.release = `${r.code} ${r.time_et}`;
        fails.push(`a scheduled release at ${r.time_et} New York`);
      }
    }
  }

  if (unread.length) return { id: "shock", pass: null, notYet: false, value, why: `shock not available (${unread.join("; ")})` };
  if (fails.length) return { id: "shock", pass: false, notYet: false, value, why: fails.join("; ") };
  return { id: "shock", pass: true, notYet: false, value, why: `no shock: bars inside ${p.shock_range_multiple}× their usual range, no release within ${p.event_window_before_min} min` };
}

/** 2.5 The contract check (contract-pick.ts): not a market gate. */
function contractGate(x: GateInput, clock: SlotClock | null, sessions: FlowCalendar): Gate<"contract"> {
  const pick = pickContract({ symbol: x.symbol, kind: x.side, spot: rowOf(x.flow, x.symbol)?.price ?? null, chain: x.chain, checkedAgeMs: x.chainAgeMs, today: clock?.day ?? "", calendar: sessions });
  if (pick.picked) return { id: "contract", pass: true, notYet: false, value: pick, why: contractWords(pick.picked) };
  const near = nearestFailure(pick);
  const tail = near ? `: nearest strike ${near.strike}, ${near.check.why}` : "";
  return { id: "contract", pass: false, notYet: false, value: pick, why: `${noContractWords(pick.why ?? "none-passed")}${tail}` };
}

const contractWords = (c: Candidate) => `contract ${c.expiry} ${c.strike} ${c.kind}: every check passes`;

/**
 * Every gate of section 2 for one focus name and side, each with the value that produced it. Null for a name that is
 * not one of the focus names: nothing is worked out for it.
 */
export function gates(x: GateInput): Gates | null {
  if (!x.focus.includes(x.symbol)) return null;
  const sessions = x.sessions ?? MARKET_CALENDAR;
  const clock = x.flow ? slotClockFromAsOf(x.flow.as_of, sessions) : null;
  return {
    market_direction: directionGate(x),
    volume: volumeGate(x, clock),
    stock_bid_ask: bidAskGate(x),
    shock: shockGate(x, clock, x.calendar ?? REPO_CALENDAR),
    contract: contractGate(x, clock, sessions),
  };
}

// ---- usable inputs (section 1, section 4) ---------------------------------------------------------------------------

/** Why the frozen numbers or code are not in force; empty only once Amendment 1 has frozen both and they match. */
export function freezeReasons(): string[] {
  const out: string[] = [];
  if (FROZEN_PARAMS_HASH === null || paramsHash(SIGNAL_PARAMS) !== FROZEN_PARAMS_HASH) out.push("the signal's numbers are not the frozen ones");
  if (FROZEN_CODE_HASH === null || SIGNAL_CODE_HASH !== FROZEN_CODE_HASH) out.push("the signal's code is not the frozen one");
  return out;
}

/** The slot's DEC-0044 server record, as far as the signal reads it. */
export type SlotRecord = Pick<ServerRecord, "status" | "session" | "slot_end" | "degraded_names" | "rows">;

export interface UsableInput {
  symbol: string;
  side: RowSide;
  /** The slot's DEC-0044 server record (desk-eval.ts serverRecord); null when there is none. */
  record: SlotRecord | null;
  /** The board's state the caller passes, with the end of the slot it was evaluated for. */
  state: { slotEnd: number; rowState: NameStateName };
  edition: Pick<Options, "session" | "focus"> | null;
  flow: FlowInput | null;
  chain: Pick<ChainResponse, "feed" | "fallback"> | null;
}

/**
 * Why an input is not usable, in plain words; empty when every input is. The signal's slot is the flow answer's last
 * settled slot. The record must be that slot's, the state must be the one that record holds for the side, and the
 * feeds are the answers' own: SIP for the stock (the index readings come from the same answer), OPRA for the option.
 */
export function unusable(u: UsableInput): string[] {
  const out: string[] = [];
  const asOf = at(u.flow?.as_of);
  const slot = asOf === null ? null : settledSlotEnd(asOf);
  if (!u.record) out.push("no board record for the slot");
  else {
    const recordEnd = at(u.record.slot_end);
    if (slot === null || recordEnd !== slot) out.push("the board record is for another slot");
    if (u.edition && u.record.session !== u.edition.session) out.push("the board record is for another session");
    if (u.record.status !== "ok") out.push("the board record is not complete");
    if (u.record.degraded_names.some((d) => d.symbol === u.symbol)) out.push("the board has no state for this name");
    const row = u.record.rows.find((r) => r.symbol === u.symbol && r.side === u.side);
    if (!row || row.state !== u.state.rowState) out.push("the board state is not the record's");
  }
  if (slot === null || u.state.slotEnd !== slot) out.push("the board state is for another slot");
  if (!u.edition) out.push("no edition");
  else if (u.flow && asOf !== null && slotClockFromAsOf(u.flow.as_of)?.day !== u.edition.session) out.push("the edition is for another session");
  if (!u.flow || u.flow.feed !== "sip") out.push("stock prices are not from SIP");
  if (!u.chain || u.chain.feed !== "opra" || u.chain.fallback !== undefined) out.push("option quotes are not from OPRA");
  return out;
}

// ---- the word (section 1) -------------------------------------------------------------------------------------------

export interface WordInput {
  side: RowSide;
  /** The state DEC-0044's record holds for the side (desk-eval.ts stateRows). */
  rowState: NameStateName;
  /** The side's own flags (trade-state.ts SideState). */
  sideState: Pick<SideState, "brokeEarlier" | "gap">;
  gates: Gates;
  /** unusable()'s reasons: any one makes the word NO TRADE. The freeze is always checked here as well. */
  unusable: readonly string[];
  /** An earlier sealed record of this break read its volume and it failed: final for the break (section 1). */
  volumeFailedEarlier?: boolean;
  /** The board's cautions (entry-checks), shown as reasons against. Not gates: they change no word. */
  cautions?: readonly Pick<Caution, "side" | "why">[];
}

export interface SignalWord {
  word: SignalWordName;
  for: string[];
  against: string[];
  /** For WAIT, the first condition still missing: a market gate's id, or "enter_zone" (the retest). Null otherwise. */
  missing: GateId | "enter_zone" | null;
  /** The test's group were this slot a break's scoring slot (section 8); null when none applies. */
  scoring: ScoringClass | null;
}

const STATE_AGAINST: Partial<Record<NameStateName, string>> = {
  no_trade: "the board reads no trade",
  watch: "the break has not happened",
  plan_off: "the plan is off",
  missed: "the move was missed",
  paused: "prices are paused",
};

const VOLUME_FINAL = "the break bar's volume read under the limit earlier: final for this break";

/** A market gate that fails the word: read and failed, or not available. "Not yet" is not a fail. */
const fails = (g: Gate) => g.pass !== true && !g.notYet;

/**
 * Section 1, the first that applies: NO TRADE (an input not usable or the numbers and code not frozen, a state that
 * cannot signal, a break the page did not see whole, a volume fail on the break bar now or earlier, two or more market
 * gates failing, no contract); CALL or PUT (a clean enter_zone, all four market gates and a contract passing); WAIT
 * (get_ready, or enter_zone with exactly one of market direction, stock bid–ask and shock failing). Anything else is
 * NO TRADE.
 */
export function signalWord(x: WordInput): SignalWord {
  const why = [...new Set([...x.unusable, ...freezeReasons()])];
  const g = x.gates;
  const market = MARKET_GATES.map((id) => g[id]);
  const volumeFailed = g.volume.pass === false || x.volumeFailedEarlier === true;
  const failing = market.filter((m) => fails(m) || (m.id === "volume" && volumeFailed));
  const allMarket = !volumeFailed && market.every((m) => m.pass === true);
  const contractOk = g.contract.pass === true;
  const cautions = (x.cautions ?? []).filter((c) => !c.side || c.side === x.side).map((c) => c.why);
  const passed = [...market, g.contract].filter((m) => m.pass === true && !(m.id === "volume" && volumeFailed)).map((m) => m.why);
  const against = [...(x.volumeFailedEarlier ? [VOLUME_FINAL] : []), ...[...market, g.contract].filter((m) => m.pass !== true && !m.notYet).map((m) => m.why), ...cautions];

  const scoring = (word: SignalWordName): ScoringClass | null => {
    if (why.length) return "not_usable";
    if (market.some((m) => m.pass === null && !m.notYet && !(m.id === "volume" && volumeFailed))) return "gate_unavailable";
    if (word === "CALL" || word === "PUT") return "a";
    if (allMarket && !contractOk) return "contract_only";
    if (volumeFailed || market.some((m) => m.pass === false)) return "b";
    return null;
  };
  const out = (word: SignalWordName, extra: string[] = [], missing: SignalWord["missing"] = null): SignalWord => ({
    word,
    for: passed,
    against: [...extra, ...against],
    missing,
    scoring: scoring(word),
  });

  if (why.length) return out("NO TRADE", why.map((w) => `data: ${w}`));
  const s = x.rowState;
  const stateWhy = STATE_AGAINST[s];
  if (stateWhy) return out("NO TRADE", [stateWhy]);
  const flagged = x.sideState.brokeEarlier || x.sideState.gap;
  const flagWhy = x.sideState.brokeEarlier ? "the break came before the page could see it" : "the page missed prices since the break";
  if (s === "get_ready" && flagged) return out("NO TRADE", [flagWhy]);
  if (volumeFailed) return out("NO TRADE");
  if (failing.length >= 2) return out("NO TRADE");
  if (!contractOk) return out("NO TRADE", allMarket ? ["no contract inside your rules"] : []);
  if (s === "enter_zone" && !flagged && allMarket) return out(x.side === "call" ? "CALL" : "PUT");
  // get_ready: the retest is the first thing missing; any gate already failing is listed against.
  if (s === "get_ready") return out("WAIT", ["not in the entry zone yet"], "enter_zone");
  const waitable: GateId[] = ["market_direction", "stock_bid_ask", "shock"];
  if (s === "enter_zone" && !flagged && failing.length === 1 && waitable.includes(failing[0]!.id)) return out("WAIT", [], failing[0]!.id);
  // Not in the record's list: an enter zone read across a flag, or with only the volume gate not available. NO TRADE.
  return out("NO TRADE", flagged ? [flagWhy] : []);
}

// ---- one side, end to end -------------------------------------------------------------------------------------------

export interface SignalInput {
  side: RowSide;
  /**
   * The board's state for the name, from the SAME slot as the DEC-0044 record passed (trade-state.ts nameState, as
   * desk-eval.ts evaluates it), with that slot's end. A state from another slot, or one the record does not hold for
   * the side, is not usable.
   */
  state: { slotEnd: number; name: NameState };
  record: SlotRecord | null;
  edition: Pick<Options, "session" | "focus"> | null;
  flow: FlowInput | null;
  flowAgeMs: number | null;
  chain: ChainResponse | null;
  chainAgeMs: number | null;
  /** The session's own earlier sealed signal records (any break; only this break's are read). */
  earlier: readonly SealedSignal[];
  calendar?: EventCalendar;
  sessions?: FlowCalendar;
}

export interface Signal extends SignalWord {
  symbol: string;
  side: RowSide;
  rowState: NameStateName;
  brokeAt: number | null;
  gates: Gates;
  paramsHash: string;
  codeHash: string;
}

/**
 * The word for one focus name and side, with its gates. Null, with nothing worked out, when there is no edition (no
 * picked list exists to say which names may be worked out: EXP-0032's blind) or the name is not one of its focus names.
 */
export function signalFor(x: SignalInput): Signal | null {
  const edition = x.edition;
  if (!edition) return null;
  const focus = focusSymbols(edition);
  const symbol = x.state.name.symbol;
  if (!focus.includes(symbol)) return null;
  const row = stateRows(x.state.name).find((r) => r.side === x.side);
  if (!row) return null;
  const sideState = x.state.name[x.side];
  const g = gates({ symbol, side: x.side, focus, sideState, flow: x.flow, flowAgeMs: x.flowAgeMs, chain: x.chain, chainAgeMs: x.chainAgeMs, calendar: x.calendar, sessions: x.sessions });
  if (!g) return null;
  const why = unusable({ symbol, side: x.side, record: x.record, state: { slotEnd: x.state.slotEnd, rowState: row.state }, edition, flow: x.flow, chain: x.chain });
  const brokeAt = sideState.brokeAt;
  const session = x.record?.session ?? edition.session;
  const volumeFailedEarlier =
    isNum(brokeAt) && x.earlier.some((r) => r.session === session && r.symbol === symbol && r.side === x.side && r.brokeAt === brokeAt && r.slotEnd < x.state.slotEnd && r.volumePass === false);
  const w = signalWord({ side: x.side, rowState: row.state, sideState, gates: g, unusable: why, volumeFailedEarlier, cautions: x.state.name.cautions });
  return { ...w, symbol, side: x.side, rowState: row.state, brokeAt, gates: g, paramsHash: paramsHash(SIGNAL_PARAMS), codeHash: SIGNAL_CODE_HASH };
}

// ---- the lifecycle (section 1) --------------------------------------------------------------------------------------

export type LifecycleWord = "developing" | "confirmed" | "weakening" | "invalidated";

/** One of the session's own earlier sealed signal records, as plain data: never a bar, never an outcome. */
export interface SealedSignal {
  session: string;
  symbol: string;
  side: RowSide;
  brokeAt: number | null;
  word: SignalWordName;
  /** The volume gate as that record read it: false is a read fail, final for the break. */
  volumePass: boolean | null;
  /** The end of the slot the record was sealed for, ms. */
  slotEnd: number;
}

export interface LifecycleInput {
  session: string;
  symbol: string;
  side: RowSide;
  brokeAt: number | null;
  rowState: NameStateName;
  word: SignalWordName;
  slotEnd: number;
  /** When the slot was evaluated (the flow answer's `as_of`), ms: the bar forming then counts the retest window. */
  evaluatedAt: number;
}

/**
 * How many slots of the retest window are left: MAX_BARS_TO_RETEST + 1 − k, k the 2-minute bars from the start of the
 * break bar to the start of the bar forming at the evaluation (trade-state.ts counts the window the same way).
 */
export function slotsLeft(brokeAt: number, evaluatedAt: number): number {
  const forming = Math.floor(evaluatedAt / SLOT_MS) * SLOT_MS;
  const k = (forming - (brokeAt - SLOT_MS)) / SLOT_MS;
  return MAX_BARS_TO_RETEST + 1 - k;
}

/**
 * The lifecycle word, the first that applies: invalidated (only for a break confirmed earlier, now plan off, missed or
 * NO TRADE); weakening (confirmed earlier and now WAIT, or CALL or PUT with two slots or fewer left); confirmed (CALL
 * or PUT); developing (WAIT); none otherwise. "Confirmed earlier" reads only the session's own records of the same
 * break (name, side, brokeAt) sealed for an earlier slot; a missing record is not a confirmation.
 */
export function lifecycle(now: LifecycleInput, earlier: readonly SealedSignal[]): LifecycleWord | null {
  const confirmedEarlier =
    isNum(now.brokeAt) &&
    earlier.some((r) => r.session === now.session && r.symbol === now.symbol && r.side === now.side && r.brokeAt === now.brokeAt && r.slotEnd < now.slotEnd && (r.word === "CALL" || r.word === "PUT"));
  const signalled = now.word === "CALL" || now.word === "PUT";
  if (confirmedEarlier && (now.rowState === "plan_off" || now.rowState === "missed" || now.word === "NO TRADE")) return "invalidated";
  if (confirmedEarlier && now.word === "WAIT") return "weakening";
  if (signalled && isNum(now.brokeAt) && slotsLeft(now.brokeAt, now.evaluatedAt) <= 2) return "weakening";
  if (signalled) return "confirmed";
  if (now.word === "WAIT") return "developing";
  return null;
}
