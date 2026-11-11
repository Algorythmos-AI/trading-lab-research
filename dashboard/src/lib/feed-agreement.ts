// The feed agreement (docs/runbooks/feed-agreement.md): one finished session replayed slot by slot twice, once on IEX
// 2-minute bars and once on SIP 2-minute bars, through the server's own evaluation (desk-eval.ts evaluateSlot, which
// runs the board's boardMode and boardRows unchanged), and the two compared. A data-quality measurement only: it reads
// no trade, no P&L and no outcome of any setup, and it is not evidence that either feed gives better trades.
//
// Pure: no I/O and no clock. Nothing in the engine imports this file, so the engine's label does not change with it.
// What it returns holds counts, state words, New York slot times, symbols and the engine's label: no level, no price.
import { ENGINE_VERSION, type EvalInput, type Evaluation, evaluateSlot, expectedSlots, focusSymbols, type NameWhy, nyHhmm, type RowSide, SIDES } from "./desk-eval";
import { focusPlan } from "./focus-plan";
import { closeMinute, isHalfDay, type LiveQuote, nyClock, type Options } from "./options";
import { type Bar2, CLOSE_GRACE_MS, FIRST_ENTRY_MIN, flatMinute, LUNCH_FROM_MIN, LUNCH_TO_MIN, lunchBlock, type NameStateName, SERVER_SETTLE_MS } from "./trade-state";

export const FEEDS = ["iex", "sip"] as const;
export type Feed = (typeof FEEDS)[number];

// ---- the fixed reading (the runbook's thresholds; changing one needs a new dated version of the runbook) ----------
/** Sessions needed before the summary gives a reading. */
export const MIN_SESSIONS = 5;
/** The share of comparable units that must carry the identical state word, in percent. */
export const MATCH_PCT = 98;
/** An enter-zone event on one feed matches one on the other at most this many slots away. */
export const MATCH_WITHIN_SLOTS = 1;
/** The report's own version. */
export const REPORT_V = 2;

const ENTER: NameStateName = "enter_zone";

/** The neutral inputs every replay is given, the same for both feeds (the runbook's table). */
export const NEUTRAL_INPUTS: readonly string[] = [
  "edition: the session's edition file given to the runner, for every slot",
  "bars: that session's historical 2-minute bars of the feed named, read once after the session",
  "fetchedAt: the slot's settle instant (end + SERVER_SETTLE_MS) for every name",
  "snapshots: dated the session, last trade at the slot's end, no high or low: settledQuote takes the quote's time, high and low from the bars",
  "journal: none (null), as the server reads a missing journal",
  "done: false (it sets the record's day.done flag only, never a state)",
];

/** What the replay cannot reproduce (the runbook's limitations), written into every report. */
export const LIMITATIONS: readonly string[] = [
  "the run-time snapshot is not reproduced, both ways: it removes pauses (a slot with its own bar is dated inside it, never stale, though live its only trade can be over 120 s old) and adds pauses (a slot without its own bar is dated at the last bar's start, older than the true last trade); a missed read only from a snapshot high or low printed after the slot does not appear",
  "historical bars read after the session, not the bars the live server read a minute after each slot; both feeds are read alike",
  "no journal: a day-limit no_trade is not reproduced, and today's wins read as unknown (cautions only)",
  "one edition per session: an edition replaced during the session is not followed",
  "the page's own 2-second prices are not replayed (the server's evaluation has none either)",
  "a leader's quote is read only when the leader is itself a focus name, as on the server",
];

// ---- one feed's replay ------------------------------------------------------------------------------------------------
/** The snapshot every replay gives a name: dated the session, its last trade at the slot's end, no high or low. */
export function neutralSnapshot(day: string, end: number): LiveQuote {
  // `price` is never read by evaluateSlot (settledQuote takes the last settled close); the time is not before the
  // slot's end, so settledQuote dates the quote from the bars; no high and no low, so they come from the bars only.
  return { price: 0, at: new Date(end).toISOString(), open: null, high: null, low: null, day, prev_close: null, vwap: null };
}

/** The server's evaluation input for one slot of a replay, from one feed's bars and the neutral values. */
export function replayInput(edition: Options, day: string, end: number, bars: Readonly<Record<string, readonly Bar2[]>>): EvalInput {
  const symbols = focusSymbols(edition);
  const settle = end + SERVER_SETTLE_MS;
  return {
    slot: { day, end },
    edition,
    journal: null,
    done: false,
    bars,
    fetchedAt: Object.fromEntries(symbols.map((s) => [s, settle])),
    snapshots: Object.fromEntries(symbols.map((s) => [s, neutralSnapshot(day, end)])),
  };
}

/** One feed's session: the server's evaluation at every slot, in slot order. */
export function replayFeed(edition: Options, day: string, slots: readonly number[], bars: Readonly<Record<string, readonly Bar2[]>>): Evaluation[] {
  return slots.map((end) => evaluateSlot(replayInput(edition, day, end, bars)));
}

// ---- the sets a unit falls in -------------------------------------------------------------------------------------------
/** A feed's word for a unit: its state word, or "none" when it carries no state. */
export type Word = NameStateName | "none";
export const NONE: Word = "none";

/**
 * The board's clock alone holds every name at no trade in this slot: judged at end + CLOSE_GRACE_MS in New York, as
 * nameState judges it, from the engine's own constants and helpers: before the first entry or from the close, the
 * lunch block (lunchBlock), and from the flat time (flatMinute).
 */
export function clockFixed(end: number, halfDay: boolean): boolean {
  const m = nyClock(new Date(end + CLOSE_GRACE_MS).toISOString())?.minutes ?? null;
  if (m === null || m < FIRST_ENTRY_MIN || m >= closeMinute(halfDay)) return true;
  if (lunchBlock(halfDay) && m >= LUNCH_FROM_MIN && m < LUNCH_TO_MIN) return true;
  return m >= flatMinute(halfDay);
}

/** The sides the focus card gives no plan, per name ("SYM|side"): the board holds them at no trade whatever the price. */
export function noPlanSides(edition: Options): Set<string> {
  const out = new Set<string>();
  for (const item of Array.isArray(edition.focus?.items) ? edition.focus.items : []) {
    const plan = focusPlan(item);
    for (const side of SIDES) if (plan[side] === null) out.add(key(item.symbol, side));
  }
  return out;
}

// ---- the comparison ---------------------------------------------------------------------------------------------------
export interface Disagreement {
  symbol: string;
  side: RowSide;
  slot: string;
  iex: Word;
  sip: Word;
}

export interface EventPair {
  symbol: string;
  side: RowSide;
  /** The event's slot on each feed (New York HHMM), null on the feed it is missing from. */
  iex: string | null;
  sip: string | null;
  /** SIP's slot minus IEX's, in slots; null when unmatched. */
  offset: number | null;
}

export interface SessionReport {
  v: typeof REPORT_V;
  kind: "feed-agreement";
  day: string;
  engine: string;
  feeds: typeof FEEDS;
  /** isHalfDay(edition), as evaluateSlot uses it. */
  half_day: boolean;
  /** The edition named by its session and build time only. */
  edition_session: string;
  edition_as_of: string | null;
  names: string[];
  slots: number;
  live_slots: number;
  units: {
    /** Every (name, side, live slot). */
    total: number;
    /** Held at no trade by the clock alone: never in the share. */
    clock_fixed: number;
    /** A side the card gives no plan: never in the share. */
    no_plan: number;
    /** Neither feed has the slot's bar: never in the share. */
    both_lack: number;
    /** The price-dependent units: everything else, one feed lacking the slot's bar included. */
    comparable: number;
    identical: number;
    /** Of the comparable units, those where only IEX, or only SIP, lacked the slot's bar. Facts, beside the share. */
    iex_lacks: number;
    sip_lacks: number;
  };
  /** identical / comparable, or null with no comparable unit. Shown, never read on one session. */
  share: number | null;
  /** "IEX word|SIP word" -> count, over the comparable units. */
  pairs: Record<string, number>;
  /** The same over the clock-fixed units (a pause there shows here, outside the share). */
  clock_fixed_pairs: Record<string, number>;
  disagreements: Disagreement[];
  events: {
    iex: number;
    sip: number;
    matched: number;
    iex_only: number;
    sip_only: number;
    median_offset: number | null;
    worst_offset: number | null;
    by_offset: Record<string, number>;
    list: EventPair[];
  };
  /** The focus names with no bar at all that session, per feed. */
  names_without_bars: Record<Feed, string[]>;
  /** Per feed, over the live slots: (name, slot) evaluations with no state by the engine's reason; slots not "ok". */
  no_state: Record<Feed, { names: Record<NameWhy, number>; slots_not_ok: number }>;
  bars_missing: { iex: number; sip: number; by_slot: { slot: string; iex: number; sip: number }[] };
  inputs: readonly string[];
  limitations: readonly string[];
}

export interface CompareInput {
  edition: Options;
  day: string;
  /** The session's slot ends (expectedSlots(day) unless a test gives its own). */
  slots: readonly number[];
  evals: Record<Feed, readonly Evaluation[]>;
  bars: Record<Feed, Readonly<Record<string, readonly Bar2[]>>>;
}

function key(symbol: string, side: RowSide): string {
  return `${symbol}|${side}`;
}

/** The state per (name, side) of one evaluation, when it is ok; empty otherwise (every word then reads "none"). */
function statesOf(ev: Evaluation | undefined): Map<string, NameStateName> {
  const out = new Map<string, NameStateName>();
  if (!ev || ev.status !== "ok") return out;
  for (const r of ev.rows) out.set(key(r.symbol, r.side), r.state);
  return out;
}

/** Each name's set of bar ends on one feed. */
function barEnds(bars: Readonly<Record<string, readonly Bar2[]>>, symbols: readonly string[]): Map<string, Set<number>> {
  return new Map(symbols.map((s) => [s, new Set((bars[s] ?? []).map((b) => b.end))]));
}

/** The middle value of sorted numbers (the mean of the two middle ones for an even count), or null for none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * One-to-one matching of two lists of event slot indices within MATCH_WITHIN_SLOTS: the closest pairs first (offset 0
 * before plus or minus 1), then the earliest. Returns the matched pairs (as indices into each list) and the unmatched.
 */
export function matchEvents(iex: readonly number[], sip: readonly number[]): { pairs: [number, number][]; iexOnly: number[]; sipOnly: number[] } {
  const cands: [number, number][] = [];
  iex.forEach((a, i) => sip.forEach((b, j) => Math.abs(b - a) <= MATCH_WITHIN_SLOTS && cands.push([i, j])));
  cands.sort(([i1, j1], [i2, j2]) => Math.abs(sip[j1]! - iex[i1]!) - Math.abs(sip[j2]! - iex[i2]!) || Math.min(iex[i1]!, sip[j1]!) - Math.min(iex[i2]!, sip[j2]!) || iex[i1]! - iex[i2]!);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  const pairs: [number, number][] = [];
  for (const [i, j] of cands) {
    if (usedI.has(i) || usedJ.has(j)) continue;
    usedI.add(i);
    usedJ.add(j);
    pairs.push([i, j]);
  }
  return { pairs, iexOnly: iex.map((_, i) => i).filter((i) => !usedI.has(i)), sipOnly: sip.map((_, j) => j).filter((j) => !usedJ.has(j)) };
}

const bump = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);

/** The two replays of one session compared: the runbook's measures. */
export function compareFeeds(input: CompareInput): SessionReport {
  const { edition, day, slots } = input;
  const halfDay = isHalfDay(edition);
  const names = focusSymbols(edition);
  const noPlan = noPlanSides(edition);
  const ends = { iex: barEnds(input.bars.iex, names), sip: barEnds(input.bars.sip, names) };
  const states = { iex: slots.map((_, i) => statesOf(input.evals.iex[i])), sip: slots.map((_, i) => statesOf(input.evals.sip[i])) };
  // The board's mode comes from the clock alone, the same on both feeds.
  const live = slots.map((_, i) => input.evals.iex[i]?.board === "live" || input.evals.sip[i]?.board === "live");
  const fixed = slots.map((end) => clockFixed(end, halfDay));
  const hhmm = slots.map((end) => nyHhmm(end));

  const u = { total: 0, clock_fixed: 0, no_plan: 0, both_lack: 0, comparable: 0, identical: 0, iex_lacks: 0, sip_lacks: 0 };
  const pairs: Record<string, number> = {};
  const fixedPairs: Record<string, number> = {};
  const disagreements: Disagreement[] = [];
  const events: Record<Feed, Map<string, number[]>> = { iex: new Map(), sip: new Map() };

  for (const symbol of names) {
    for (const side of SIDES) {
      const k = key(symbol, side);
      const prev: Record<Feed, Word | null> = { iex: null, sip: null };
      for (let i = 0; i < slots.length; i++) {
        if (!live[i]) continue;
        u.total++;
        const end = slots[i]!;
        const word = {} as Record<Feed, Word>;
        const bar = {} as Record<Feed, boolean>;
        for (const f of FEEDS) {
          word[f] = states[f][i]!.get(k) ?? NONE;
          bar[f] = ends[f].get(symbol)?.has(end) ?? false;
          if (word[f] === ENTER && prev[f] !== ENTER) {
            const list = events[f].get(k) ?? [];
            list.push(i);
            events[f].set(k, list);
          }
          prev[f] = word[f];
        }
        const pk = `${word.iex}|${word.sip}`;
        if (fixed[i]) {
          u.clock_fixed++;
          bump(fixedPairs, pk);
        } else if (noPlan.has(k)) u.no_plan++;
        else if (!bar.iex && !bar.sip) u.both_lack++;
        else {
          u.comparable++;
          if (!bar.iex) u.iex_lacks++;
          if (!bar.sip) u.sip_lacks++;
          bump(pairs, pk);
          if (word.iex === word.sip) u.identical++;
          else disagreements.push({ symbol, side, slot: hhmm[i]!, iex: word.iex, sip: word.sip });
        }
      }
    }
  }

  // Events: matched per (name, side) within one slot.
  const list: EventPair[] = [];
  const offsets: number[] = [];
  let nIex = 0;
  let nSip = 0;
  for (const symbol of names) {
    for (const side of SIDES) {
      const k = key(symbol, side);
      const a = events.iex.get(k) ?? [];
      const b = events.sip.get(k) ?? [];
      nIex += a.length;
      nSip += b.length;
      const m = matchEvents(a, b);
      for (const [i, j] of m.pairs) {
        const off = b[j]! - a[i]!;
        offsets.push(off);
        list.push({ symbol, side, iex: hhmm[a[i]!]!, sip: hhmm[b[j]!]!, offset: off });
      }
      for (const i of m.iexOnly) list.push({ symbol, side, iex: hhmm[a[i]!]!, sip: null, offset: null });
      for (const j of m.sipOnly) list.push({ symbol, side, iex: null, sip: hhmm[b[j]!]!, offset: null });
    }
  }
  const slotOf = (p: EventPair) => p.iex ?? p.sip ?? "";
  list.sort((x, y) => slotOf(x).localeCompare(slotOf(y)) || x.symbol.localeCompare(y.symbol) || x.side.localeCompare(y.side));
  const byOffset: Record<string, number> = {};
  for (let d = -MATCH_WITHIN_SLOTS; d <= MATCH_WITHIN_SLOTS; d++) byOffset[String(d)] = offsets.filter((o) => o === d).length;
  const worst = offsets.length ? offsets.reduce((w, o) => (Math.abs(o) > Math.abs(w) ? o : w), 0) : null;

  // No-state reasons per feed, over the live slots only (the slots that have units).
  const noState = {} as SessionReport["no_state"];
  for (const f of FEEDS) {
    const why: Record<NameWhy, number> = { "bars-missing": 0, "bars-gap": 0, "snapshot-missing": 0 };
    let notOk = 0;
    input.evals[f].forEach((ev, i) => {
      if (!live[i]) return;
      if (ev.status !== "ok") notOk++;
      for (const d of ev.degraded_names) why[d.reason]++;
    });
    noState[f] = { names: why, slots_not_ok: notOk };
  }

  // Bars missing per slot, every slot of the session.
  const bySlot: { slot: string; iex: number; sip: number }[] = [];
  let missIex = 0;
  let missSip = 0;
  slots.forEach((end, i) => {
    const iex = names.filter((s) => !ends.iex.get(s)!.has(end)).length;
    const sip = names.filter((s) => !ends.sip.get(s)!.has(end)).length;
    missIex += iex;
    missSip += sip;
    if (iex || sip) bySlot.push({ slot: hhmm[i]!, iex, sip });
  });
  const without = (f: Feed) => names.filter((s) => (input.bars[f][s] ?? []).length === 0);

  return {
    v: REPORT_V,
    kind: "feed-agreement",
    day,
    engine: ENGINE_VERSION,
    feeds: FEEDS,
    half_day: halfDay,
    edition_session: edition.session,
    edition_as_of: typeof edition.as_of === "string" && Number.isFinite(Date.parse(edition.as_of)) ? new Date(Date.parse(edition.as_of)).toISOString() : null,
    names,
    slots: slots.length,
    live_slots: live.filter(Boolean).length,
    units: u,
    share: u.comparable > 0 ? u.identical / u.comparable : null,
    pairs,
    clock_fixed_pairs: fixedPairs,
    disagreements,
    events: { iex: nIex, sip: nSip, matched: offsets.length, iex_only: nIex - offsets.length, sip_only: nSip - offsets.length, median_offset: median(offsets), worst_offset: worst, by_offset: byOffset, list },
    names_without_bars: { iex: without("iex"), sip: without("sip") },
    no_state: noState,
    bars_missing: { iex: missIex, sip: missSip, by_slot: bySlot },
    inputs: NEUTRAL_INPUTS,
    limitations: LIMITATIONS,
  };
}

/** The whole session: both replays over the session's own slots (expectedSlots, New York time), then compared. */
export function feedAgreement(edition: Options, day: string, bars: Record<Feed, Readonly<Record<string, readonly Bar2[]>>>, slots: readonly number[] = expectedSlots(day)): SessionReport {
  const evals = { iex: replayFeed(edition, day, slots, bars.iex), sip: replayFeed(edition, day, slots, bars.sip) };
  return compareFeeds({ edition, day, slots, evals, bars });
}

// ---- the running summary ------------------------------------------------------------------------------------------------
const COUNT_KEYS = [
  "comparable",
  "identical",
  "events_iex",
  "events_sip",
  "matched",
  "iex_only",
  "sip_only",
  "iex_lacks",
  "sip_lacks",
  "both_lack",
  "clock_fixed",
  "no_plan",
  "bars_missing_iex",
  "bars_missing_sip",
] as const;
type CountKey = (typeof COUNT_KEYS)[number];

export type SummaryRow = { v: typeof REPORT_V; day: string; engine: string; run_at: string; names_without_bars: Record<Feed, string[]> } & Record<CountKey, number>;

export function summaryRow(r: SessionReport, runAt: number): SummaryRow {
  return {
    v: REPORT_V,
    day: r.day,
    engine: r.engine,
    run_at: new Date(runAt).toISOString(),
    comparable: r.units.comparable,
    identical: r.units.identical,
    events_iex: r.events.iex,
    events_sip: r.events.sip,
    matched: r.events.matched,
    iex_only: r.events.iex_only,
    sip_only: r.events.sip_only,
    iex_lacks: r.units.iex_lacks,
    sip_lacks: r.units.sip_lacks,
    both_lack: r.units.both_lack,
    clock_fixed: r.units.clock_fixed,
    no_plan: r.units.no_plan,
    bars_missing_iex: r.bars_missing.iex,
    bars_missing_sip: r.bars_missing.sip,
    names_without_bars: r.names_without_bars,
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_LIST = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && /^[A-Z][A-Z0-9.]{0,9}$/.test(s));

/** A summary line as read back: a row of this version with every count a whole number, or null. */
export function parseSummaryRow(line: string): SummaryRow | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== REPORT_V || typeof o.day !== "string" || !DAY_RE.test(o.day) || typeof o.engine !== "string" || typeof o.run_at !== "string") return null;
  if (!COUNT_KEYS.every((k) => Number.isInteger(o[k]) && (o[k] as number) >= 0)) return null;
  const nb = o.names_without_bars as Record<string, unknown> | null | undefined;
  if (!nb || typeof nb !== "object" || !SYMBOL_LIST(nb.iex) || !SYMBOL_LIST(nb.sip)) return null;
  return o as unknown as SummaryRow;
}

/** At least MATCH_PCT percent, in whole numbers: identical x 100 >= MATCH_PCT x comparable, so exactly 98.000% passes. */
export function shareMeets(identical: number, comparable: number): boolean {
  return comparable > 0 && identical * 100 >= MATCH_PCT * comparable;
}

export type Reading = "not-enough-sessions" | "not-enough-sessions-labels-differ" | "equivalent" | "different";
export const READING_WORDS: Record<Reading, string> = {
  "not-enough-sessions": "not enough sessions",
  "not-enough-sessions-labels-differ": "not enough sessions (labels differ)",
  equivalent: "equivalent for the board",
  different: "different",
};

export interface LabelGroup {
  engine: string;
  sessions: number;
  days: string[];
  totals: Record<CountKey, number>;
  share: number | null;
  /** "SYM day" for each name with no bars all day, per feed. */
  names_without_bars: Record<Feed, string[]>;
}

export interface SummaryReading {
  reading: Reading;
  /** The label read: the most recent session's. Null with no session. */
  engine: string | null;
  /** Every label seen, in order of its first session; never added together. */
  labels: LabelGroup[];
  /** Lines that could not be read (never counted). */
  unreadable: number;
}

function group(engine: string, rows: readonly SummaryRow[]): LabelGroup {
  const totals = Object.fromEntries(COUNT_KEYS.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) as Record<CountKey, number>;
  return {
    engine,
    sessions: rows.length,
    days: rows.map((r) => r.day),
    totals,
    share: totals.comparable > 0 ? totals.identical / totals.comparable : null,
    names_without_bars: {
      iex: rows.flatMap((r) => r.names_without_bars.iex.map((s) => `${s} ${r.day}`)),
      sip: rows.flatMap((r) => r.names_without_bars.sip.map((s) => `${s} ${r.day}`)),
    },
  };
}

/** The runbook's reading over the running summary: the latest run of each day, read per engine label, never pooled. */
export function readSummary(lines: readonly string[]): SummaryReading {
  const byDay = new Map<string, SummaryRow>();
  let unreadable = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = parseSummaryRow(line);
    if (!r) {
      unreadable++;
      continue;
    }
    byDay.set(r.day, r); // a later run of the same day replaces the earlier one
  }
  const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const engines = [...new Set(rows.map((r) => r.engine))];
  const labels = engines.map((e) => group(e, rows.filter((r) => r.engine === e)));
  const engine = rows.at(-1)?.engine ?? null;
  const current = labels.find((g) => g.engine === engine);
  let reading: Reading;
  if (!current || current.sessions < MIN_SESSIONS) reading = labels.length > 1 ? "not-enough-sessions-labels-differ" : "not-enough-sessions";
  else reading = shareMeets(current.totals.identical, current.totals.comparable) && current.totals.iex_only + current.totals.sip_only === 0 ? "equivalent" : "different";
  return { reading, engine, labels, unreadable };
}

// ---- text ---------------------------------------------------------------------------------------------------------------
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(3)}%`);
const listOr = (xs: readonly string[]) => (xs.length ? xs.join(" ") : "none");

function fmtWhy(w: Record<NameWhy, number>): string {
  return Object.entries(w)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

/** The session's short table. */
export function reportText(r: SessionReport): string {
  const u = r.units;
  const e = r.events;
  const lines = [
    `Feed agreement ${r.day}${r.half_day ? " (half day)" : ""}: IEX against SIP, engine ${r.engine}`,
    `names ${r.names.join(" ")} · slots ${r.slots}, live ${r.live_slots}`,
    `units ${u.total}: clock-fixed ${u.clock_fixed} · no plan ${u.no_plan} · both lack ${u.both_lack} · comparable ${u.comparable}`,
    `comparable ${u.comparable} · identical ${u.identical} (${pct(r.share)}; one session is never read) · of them IEX lacked the bar ${u.iex_lacks}, SIP ${u.sip_lacks}`,
    `names without bars: IEX ${listOr(r.names_without_bars.iex)} · SIP ${listOr(r.names_without_bars.sip)}`,
    `enter-zone events: IEX ${e.iex} · SIP ${e.sip} · matched ${e.matched} · IEX-only ${e.iex_only} · SIP-only ${e.sip_only}`,
    `matched offsets (SIP minus IEX, slots): median ${e.median_offset ?? "n/a"} · worst ${e.worst_offset ?? "n/a"} · ${Object.entries(e.by_offset)
      .map(([d, n]) => `${d}: ${n}`)
      .join(", ")}`,
    `bars missing (name-slots): IEX ${r.bars_missing.iex} · SIP ${r.bars_missing.sip}`,
    `no state (name-slots, live): IEX ${fmtWhy(r.no_state.iex.names)} · SIP ${fmtWhy(r.no_state.sip.names)}`,
  ];
  const fixedOff = Object.entries(r.clock_fixed_pairs).filter(([k]) => k.split("|")[0] !== k.split("|")[1]);
  if (fixedOff.length) lines.push(`clock-fixed units that differ (outside the share): ${fixedOff.map(([k, n]) => `${k.replace("|", " / ")} ${n}`).join(", ")}`);
  if (r.disagreements.length) {
    lines.push("disagreements (name side slot: IEX / SIP):");
    for (const d of r.disagreements.slice(0, 40)) lines.push(`  ${d.symbol} ${d.side} ${d.slot}: ${d.iex} / ${d.sip}`);
    if (r.disagreements.length > 40) lines.push(`  ... ${r.disagreements.length - 40} more in the JSON report`);
  }
  const unmatched = e.list.filter((p) => p.offset === null);
  if (unmatched.length) {
    lines.push("unmatched enter-zone events:");
    for (const p of unmatched) lines.push(`  ${p.symbol} ${p.side} ${p.iex ? `IEX ${p.iex}` : `SIP ${p.sip}`}`);
  }
  lines.push(`limitations: ${r.limitations.length} (listed in the JSON report and the runbook)`);
  return lines.join("\n");
}

/** The running summary's reading in words, one block per engine label. */
export function summaryText(s: SummaryReading): string {
  const out: string[] = [];
  if (s.labels.length === 0) out.push(`Summary: no sessions yet (${MIN_SESSIONS} of one engine label needed)`);
  for (const g of s.labels) {
    const t = g.totals;
    out.push(
      `Engine ${g.engine}${g.engine === s.engine ? " (read)" : " (not pooled)"}: ${g.sessions} session${g.sessions === 1 ? "" : "s"} (${MIN_SESSIONS} needed): ${g.days.join(" ")}`,
      `  comparable ${t.comparable} · identical ${t.identical} (${pct(g.share)}, at least ${MATCH_PCT}% needed) · IEX lacked the bar ${t.iex_lacks}, SIP ${t.sip_lacks}`,
      `  enter-zone events: IEX ${t.events_iex} · SIP ${t.events_sip} · matched ${t.matched} · unmatched ${t.iex_only + t.sip_only} (0 allowed)`,
      `  left out: clock-fixed ${t.clock_fixed} · no plan ${t.no_plan} · both lack ${t.both_lack} · bars missing IEX ${t.bars_missing_iex}, SIP ${t.bars_missing_sip}`,
      `  names without bars: IEX ${listOr(g.names_without_bars.iex)} · SIP ${listOr(g.names_without_bars.sip)}`,
    );
  }
  if (s.unreadable) out.push(`${s.unreadable} unreadable line(s) not counted`);
  out.push(`reading: ${READING_WORDS[s.reading]}`);
  return out.join("\n");
}
