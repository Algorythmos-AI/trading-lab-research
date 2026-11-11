// The feed agreement (docs/runbooks/feed-agreement.md): one finished session replayed slot by slot twice, once on IEX
// 2-minute bars and once on SIP 2-minute bars, through the server's own evaluation (desk-eval.ts evaluateSlot, which
// runs the board's boardMode and boardRows unchanged), and the two compared. A data-quality measurement only: it reads
// no trade, no P&L and no outcome of any setup, and it is not evidence that either feed gives better trades.
//
// Pure: no I/O and no clock. Nothing in the engine imports this file, so the engine's label does not change with it.
// What it returns holds counts, state words, New York slot times, symbols and the engine's label: no level, no price.
import { ENGINE_VERSION, type EvalInput, type Evaluation, evaluateSlot, expectedSlots, focusSymbols, type NameWhy, nyHhmm, type RowSide, sessionBounds, SIDES } from "./desk-eval";
import type { LiveQuote, Options } from "./options";
import { type Bar2, type NameStateName, SERVER_SETTLE_MS } from "./trade-state";

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
export const REPORT_V = 1;

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
  "the run-time snapshot is not reproduced: a paused read from a stale last trade, or a missed read from a high or low printed after the slot, does not appear",
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

// ---- the comparison ---------------------------------------------------------------------------------------------------
export interface Disagreement {
  symbol: string;
  side: RowSide;
  slot: string;
  iex: NameStateName;
  sip: NameStateName;
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
    comparable: number;
    identical: number;
    /** A state and a bar on one feed only: never agreement, never disagreement. */
    one_sided: { iex_lacks: number; sip_lacks: number };
    both_lack: number;
  };
  /** identical / comparable, or null with no comparable unit. Shown, never read on one session. */
  share: number | null;
  /** (IEX state, SIP state) -> count, over the comparable units. */
  pairs: Record<string, number>;
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
  /** Per feed: how many (name, slot) evaluations carried no state, by the engine's reason; slots not evaluated "ok". */
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

const key = (symbol: string, side: RowSide) => `${symbol}|${side}`;

/** The state per (name, side) of one evaluation, when the board is live and the evaluation ok; empty otherwise. */
function statesOf(ev: Evaluation | undefined): Map<string, NameStateName> {
  const out = new Map<string, NameStateName>();
  if (!ev || ev.status !== "ok" || ev.board !== "live") return out;
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

/** The two replays of one session compared: the runbook's measures. */
export function compareFeeds(input: CompareInput): SessionReport {
  const { edition, day, slots } = input;
  const names = focusSymbols(edition);
  const ends = { iex: barEnds(input.bars.iex, names), sip: barEnds(input.bars.sip, names) };
  const states = { iex: slots.map((_, i) => statesOf(input.evals.iex[i])), sip: slots.map((_, i) => statesOf(input.evals.sip[i])) };
  const live = slots.map((_, i) => input.evals.iex[i]?.board === "live" || input.evals.sip[i]?.board === "live");
  const hhmm = slots.map((end) => nyHhmm(end));

  let total = 0;
  let comparable = 0;
  let identical = 0;
  let iexLacks = 0;
  let sipLacks = 0;
  let bothLack = 0;
  const pairs: Record<string, number> = {};
  const disagreements: Disagreement[] = [];
  const events: Record<Feed, Map<string, number[]>> = { iex: new Map(), sip: new Map() };

  for (const symbol of names) {
    for (const side of SIDES) {
      const k = key(symbol, side);
      const prev: Record<Feed, NameStateName | null> = { iex: null, sip: null };
      for (let i = 0; i < slots.length; i++) {
        if (!live[i]) continue;
        total++;
        const end = slots[i]!;
        const got = {} as Record<Feed, NameStateName | null>;
        const ok = {} as Record<Feed, boolean>;
        for (const f of FEEDS) {
          const s = states[f][i]!.get(k) ?? null;
          got[f] = s;
          ok[f] = s !== null && (ends[f].get(symbol)?.has(end) ?? false);
          if (s === ENTER && prev[f] !== ENTER) {
            const list = events[f].get(k) ?? [];
            list.push(i);
            events[f].set(k, list);
          }
          prev[f] = s;
        }
        if (ok.iex && ok.sip) {
          comparable++;
          const pk = `${got.iex}|${got.sip}`;
          pairs[pk] = (pairs[pk] ?? 0) + 1;
          if (got.iex === got.sip) identical++;
          else disagreements.push({ symbol, side, slot: hhmm[i]!, iex: got.iex!, sip: got.sip! });
        } else if (ok.iex) sipLacks++;
        else if (ok.sip) iexLacks++;
        else bothLack++;
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

  // No-state reasons per feed, and slots the evaluation did not answer "ok".
  const noState = {} as SessionReport["no_state"];
  for (const f of FEEDS) {
    const why: Record<NameWhy, number> = { "bars-missing": 0, "bars-gap": 0, "snapshot-missing": 0 };
    let notOk = 0;
    for (const ev of input.evals[f]) {
      if (ev.status !== "ok") notOk++;
      for (const d of ev.degraded_names) why[d.reason]++;
    }
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

  return {
    v: REPORT_V,
    kind: "feed-agreement",
    day,
    engine: ENGINE_VERSION,
    feeds: FEEDS,
    half_day: sessionBounds(day)?.halfDay ?? false,
    edition_session: edition.session,
    edition_as_of: typeof edition.as_of === "string" && Number.isFinite(Date.parse(edition.as_of)) ? new Date(Date.parse(edition.as_of)).toISOString() : null,
    names,
    slots: slots.length,
    live_slots: live.filter(Boolean).length,
    units: { total, comparable, identical, one_sided: { iex_lacks: iexLacks, sip_lacks: sipLacks }, both_lack: bothLack },
    share: comparable > 0 ? identical / comparable : null,
    pairs,
    disagreements,
    events: { iex: nIex, sip: nSip, matched: offsets.length, iex_only: nIex - offsets.length, sip_only: nSip - offsets.length, median_offset: median(offsets), worst_offset: worst, by_offset: byOffset, list },
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
export interface SummaryRow {
  v: typeof REPORT_V;
  day: string;
  engine: string;
  run_at: string;
  comparable: number;
  identical: number;
  events_iex: number;
  events_sip: number;
  matched: number;
  iex_only: number;
  sip_only: number;
  iex_lacks: number;
  sip_lacks: number;
  both_lack: number;
  bars_missing_iex: number;
  bars_missing_sip: number;
}

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
    iex_lacks: r.units.one_sided.iex_lacks,
    sip_lacks: r.units.one_sided.sip_lacks,
    both_lack: r.units.both_lack,
    bars_missing_iex: r.bars_missing.iex,
    bars_missing_sip: r.bars_missing.sip,
  };
}

const COUNT_KEYS = ["comparable", "identical", "events_iex", "events_sip", "matched", "iex_only", "sip_only", "iex_lacks", "sip_lacks", "both_lack", "bars_missing_iex", "bars_missing_sip"] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A summary line as read back: a row with every count a whole number, or null. */
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
  return o as unknown as SummaryRow;
}

/** At least MATCH_PCT percent, in whole numbers: identical x 100 >= MATCH_PCT x comparable, so exactly 98.000% passes. */
export function shareMeets(identical: number, comparable: number): boolean {
  return comparable > 0 && identical * 100 >= MATCH_PCT * comparable;
}

export type Reading = "not-enough-sessions" | "equivalent" | "different";
export const READING_WORDS: Record<Reading, string> = {
  "not-enough-sessions": "not enough sessions",
  equivalent: "equivalent for the board",
  different: "different",
};

export interface SummaryReading {
  reading: Reading;
  sessions: number;
  days: string[];
  engines: string[];
  totals: Record<(typeof COUNT_KEYS)[number], number>;
  share: number | null;
  /** Lines that could not be read (never counted). */
  unreadable: number;
}

/** The runbook's reading over the running summary: the latest run of each session day, pooled. */
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
  const totals = Object.fromEntries(COUNT_KEYS.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) as SummaryReading["totals"];
  const sessions = rows.length;
  const reading: Reading =
    sessions < MIN_SESSIONS ? "not-enough-sessions" : shareMeets(totals.identical, totals.comparable) && totals.iex_only + totals.sip_only === 0 ? "equivalent" : "different";
  return {
    reading,
    sessions,
    days: rows.map((r) => r.day),
    engines: [...new Set(rows.map((r) => r.engine))],
    totals,
    share: totals.comparable > 0 ? totals.identical / totals.comparable : null,
    unreadable,
  };
}

// ---- text ---------------------------------------------------------------------------------------------------------------
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(3)}%`);

/** The session's short table. */
export function reportText(r: SessionReport): string {
  const u = r.units;
  const e = r.events;
  const lines = [
    `Feed agreement ${r.day}${r.half_day ? " (half day)" : ""}: IEX against SIP, engine ${r.engine}`,
    `names ${r.names.join(" ")} · slots ${r.slots}, live ${r.live_slots}`,
    `units ${u.total} · comparable ${u.comparable} · identical ${u.identical} (${pct(r.share)}; one session is never read)`,
    `not comparable: IEX lacks ${u.one_sided.iex_lacks} · SIP lacks ${u.one_sided.sip_lacks} · both lack ${u.both_lack}`,
    `enter-zone events: IEX ${e.iex} · SIP ${e.sip} · matched ${e.matched} · IEX-only ${e.iex_only} · SIP-only ${e.sip_only}`,
    `matched offsets (SIP minus IEX, slots): median ${e.median_offset ?? "n/a"} · worst ${e.worst_offset ?? "n/a"} · ${Object.entries(e.by_offset).map(([d, n]) => `${d}: ${n}`).join(", ")}`,
    `bars missing (name-slots): IEX ${r.bars_missing.iex} · SIP ${r.bars_missing.sip}`,
    `no state (name-slots): IEX ${fmtWhy(r.no_state.iex.names)} · SIP ${fmtWhy(r.no_state.sip.names)}`,
  ];
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

function fmtWhy(w: Record<NameWhy, number>): string {
  return Object.entries(w)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

/** The running summary's reading in words. */
export function summaryText(s: SummaryReading): string {
  const t = s.totals;
  return [
    `Summary over ${s.sessions} session${s.sessions === 1 ? "" : "s"} (${MIN_SESSIONS} needed): ${s.days.join(" ") || "none"}`,
    `comparable ${t.comparable} · identical ${t.identical} (${pct(s.share)}, at least ${MATCH_PCT}% needed)`,
    `enter-zone events: IEX ${t.events_iex} · SIP ${t.events_sip} · matched ${t.matched} · unmatched ${t.iex_only + t.sip_only} (0 allowed)`,
    `not comparable: IEX lacks ${t.iex_lacks} · SIP lacks ${t.sip_lacks} · both lack ${t.both_lack} · bars missing IEX ${t.bars_missing_iex}, SIP ${t.bars_missing_sip}`,
    `engines: ${s.engines.join(" ") || "none"}${s.unreadable ? ` · ${s.unreadable} unreadable line(s) not counted` : ""}`,
    `reading: ${READING_WORDS[s.reading]}`,
  ].join("\n");
}
