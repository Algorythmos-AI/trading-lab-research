// The Options desk's states worked out on the server (DEC-0044, sections 1 and 2), in shadow: this module only says
// what the board would show for a settled 2-minute slot. It sends nothing, places no order and suggests none.
//
// Pure: no I/O and no clock; the caller passes the instant. The board itself is not re-implemented here: every state
// comes from trade-now.ts's boardRows (and boardMode, boardDay) over trade-state.ts, called unchanged, with the
// slot's settled bars as the server's bars and a quote read off those bars and the same snapshot the page's quote
// route reads. A record holds enum values,
// booleans, symbols and instants only: no price, no level, no amount, no journal trade, no free text.
import { ENGINE_VERSION } from "./engine-version.gen";
import { isHalfDay, nyClock, nyInstant, OPEN_MIN, type LiveQuote, type Options } from "./options";
import { sessionView, type JournalDoc } from "./journal";
import { sessionOf } from "./market-calendar";
import { boardDay, boardMode, type BoardMode, boardRows } from "./trade-now";
import type { GuardReason } from "./quote-guards";
import { dayCheck } from "./trade-rules";
import { BAR_MINUTES, type Bar2, CLOSE_GRACE_MS, type NameState, type NameStateName, SERVER_SETTLE_MS } from "./trade-state";

/**
 * The engine's label, written into every record: generated (`pnpm gen:engine`) from a hash of every file this module
 * imports within src/lib, comments and spacing stripped, so any change to the engine's code gives a new label and a
 * unit test fails while the generated file is stale. Nobody keeps it by hand.
 */
export { ENGINE_VERSION };

export const BAR_MS = BAR_MINUTES * 60_000;
/** The record's own version. */
export const RECORD_V = 1;

/** The state words a row may carry: the engine's own (NameStateName), nothing else. */
export const ROW_STATES: readonly NameStateName[] = ["no_trade", "watch", "get_ready", "enter_zone", "plan_off", "missed", "paused"];
export const SIDES = ["call", "put"] as const;
export type RowSide = (typeof SIDES)[number];
/** A ticker symbol as a record may hold it. */
export const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

// ---- the slot -------------------------------------------------------------------------------------------------------
/** The end (ms) of the last 2-minute bar that has settled by `nowMs`: its end + SERVER_SETTLE_MS ≤ now. */
export function settledSlotEnd(nowMs: number): number {
  return Math.floor((nowMs - SERVER_SETTLE_MS) / BAR_MS) * BAR_MS;
}

export interface SessionBounds {
  day: string;
  /** 09:30 and the close (16:00, or 13:00 on a half day) New York, ms. */
  open: number;
  close: number;
  halfDay: boolean;
}

/** The regular session of a New York day from the exchange calendar, or null when the market does not open. */
export function sessionBounds(day: string): SessionBounds | null {
  const s = sessionOf(day);
  if ((s.kind !== "open" && s.kind !== "half") || s.open === null || s.close === null) return null;
  const open = nyInstant(day, s.open);
  const close = nyInstant(day, s.close);
  return open === null || close === null ? null : { day, open, close, halfDay: s.kind === "half" };
}

export type IdleWhy = "closed-day" | "outside-hours" | "no-slot-yet";
export type SlotAt = { kind: "idle"; why: IdleWhy } | { kind: "slot"; day: string; end: number; bounds: SessionBounds };

/**
 * The slot a run at `nowMs` evaluates. Idle on a weekend or holiday, outside the regular session (09:30 to the close,
 * from the exchange calendar), and in the session before its first bar (09:30 to 09:32) has settled.
 */
export function slotAt(nowMs: number): SlotAt {
  const day = nyClock(new Date(nowMs).toISOString())?.day ?? null;
  const bounds = day ? sessionBounds(day) : null;
  if (!day || !bounds) return { kind: "idle", why: "closed-day" };
  if (nowMs < bounds.open || nowMs >= bounds.close) return { kind: "idle", why: "outside-hours" };
  const end = settledSlotEnd(nowMs);
  if (end < bounds.open + BAR_MS) return { kind: "idle", why: "no-slot-yet" };
  return { kind: "slot", day, end, bounds };
}

/** Every slot end a session can log: each bar from 09:30 whose settle instant falls before the close. */
export function expectedSlots(day: string): number[] {
  const b = sessionBounds(day);
  if (!b) return [];
  const out: number[] = [];
  for (let end = b.open + BAR_MS; end + SERVER_SETTLE_MS < b.close; end += BAR_MS) out.push(end);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "HHMM", New York, of an instant. */
export function nyHhmm(ms: number): string {
  const m = nyClock(new Date(ms).toISOString())?.minutes ?? 0;
  return `${pad(Math.floor(m / 60))}${pad(m % 60)}`;
}

/** The one place a slot's server record lives: desk/log/YYYY-MM-DD/HHMM.json (New York day and slot end). */
export function serverLogPath(day: string, end: number): string {
  return `desk/log/${day}/${nyHhmm(end)}.json`;
}
/** The open page's record for the same slot, beside it: a visible page's (the first visible page wins). */
export function pageLogPath(day: string, end: number): string {
  return `desk/log/${day}/${nyHhmm(end)}.page.json`;
}
/** A hidden page's record, apart, so a hidden tab sending first can never take a visible tab's place. */
export function pageHiddenLogPath(day: string, end: number): string {
  return `desk/log/${day}/${nyHhmm(end)}.page-hidden.json`;
}
export const LOG_PREFIX = "desk/log/";

// ---- the switch -----------------------------------------------------------------------------------------------------
/** The evaluator's switch, read every run: desk/eval.json, `{ "v": 1, "eval": "off" | "log" }`. */
export const DESK_EVAL_PATH = "desk/eval.json";
export type EvalSwitch = "off" | "log";

/** The switch, strictly: exactly `{ v: 1, eval: "off" | "log" }`. Anything else, or nothing, is off. Never throws. */
export function parseEvalSwitch(text: unknown): EvalSwitch {
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
  if (keys.length !== 2 || !keys.includes("v") || !keys.includes("eval") || o.v !== 1) return "off";
  return o.eval === "log" ? "log" : "off";
}

// ---- a row ----------------------------------------------------------------------------------------------------------
export interface StateRow {
  symbol: string;
  side: RowSide;
  state: NameStateName;
}

/**
 * The two rows of a name, one per side: a row the board has paused, or holds at no trade (the clock, the day's
 * limit, the middle of the range), says so on both sides; otherwise each side's own state. Shared with the page, so
 * both sides of the comparison read a NameState the same way.
 */
export function stateRows(s: NameState): StateRow[] {
  const gate = s.state === "paused" || s.state === "no_trade";
  return SIDES.map((side) => ({ symbol: s.symbol, side, state: gate ? s.state : s[side].state }));
}

// ---- the evaluation -------------------------------------------------------------------------------------------------
export type EvalStatus = "ok" | "wrong-day" | "no-focus" | "degraded";
export type DegradedWhy =
  | "edition-missing"
  | "edition-error"
  | "store-timeout"
  | "bad-symbol"
  | "bars-off"
  | "bars-failed"
  | "bars-timeout"
  | "bars-unsettled"
  | "snapshot-off"
  | "snapshot-failed"
  | "snapshot-timeout";
/** Why one focus name carries no state while the others keep theirs. */
export type NameWhy = "bars-missing" | "bars-gap" | "snapshot-missing";
export const NAME_WHYS: readonly NameWhy[] = ["bars-missing", "bars-gap", "snapshot-missing"];

export interface DayFlags {
  /** The journal is current by the board's own test (dayCheck / journalCurrent). */
  journal_current: boolean;
  /** A trade today broke a rule (dayCheck's breaks, from tradeBreaks' judgement). */
  break_today: boolean;
  /** Rule 7 or 8 has ended the day (boardDay). */
  day_limit_used: boolean;
  /** The owner set "done for today", or the flag could not be read (doneForAlerts). */
  done: boolean;
  half_day: boolean;
  /** A focus name has no bars, or a 2-minute slot missing since its break (the page's own gap test). */
  gap: boolean;
  /** A side reads a break the bars could not show the close of (brokeEarlier). */
  broke_earlier: boolean;
  /** A name is paused: no fresh price (a pause by a switched-on bad-data guard is not counted here). */
  stale: boolean;
}

export interface EvalRow extends StateRow {
  /** The end of the bar the state comes from: the slot's. */
  bar_end: string;
}

export interface Evaluation {
  status: EvalStatus;
  reason: DegradedWhy | null;
  /** The board's mode at the slot (live from 09:35); null when nothing was evaluated. */
  board: BoardMode["kind"] | null;
  rows: EvalRow[];
  /** The focus names that carry no state, and why; the other names keep their rows. */
  degraded_names: { symbol: string; reason: NameWhy }[];
  /** The snapshot (the page's quote source) was read for this evaluation. */
  snapshot_ok: boolean;
  day: DayFlags;
}

export interface EvalInput {
  slot: { day: string; end: number };
  edition: Options;
  journal: JournalDoc | null;
  /** doneForAlerts' answer: a failed read is done. */
  done: boolean;
  /** The server's bars per name as read (may hold the bar still forming); only those settled at the slot count. */
  bars: Readonly<Record<string, readonly Bar2[]>>;
  /** When each name's bars were read upstream (ms). Every focus name's must be at or after the slot's settle. */
  fetchedAt: Readonly<Record<string, number>>;
  /**
   * The snapshot per name as the page's quote route reads it (its last trade's time, the session's high and low).
   * Read at run time, so it can hold prints after the slot: only its last trade time (when before the slot's end)
   * and its high and low are used, never its price.
   */
  snapshots: Readonly<Record<string, LiveQuote>>;
  /**
   * The bad-data guards switched on (desk-guards.ts), read every run. They read `snapshots`, the quotes the page's
   * quote route reads, never the quote built from the bars. Missing or empty: the evaluation is exactly as without
   * guards.
   */
  guardsOn?: readonly GuardReason[];
}

const NO_DAY = (half: boolean, done: boolean): DayFlags => ({
  journal_current: false,
  break_today: false,
  day_limit_used: false,
  done,
  half_day: half,
  gap: false,
  broke_earlier: false,
  stale: false,
});

/** The edition's focus names in the card's order. */
export function focusSymbols(e: Pick<Options, "focus">): string[] {
  const items = Array.isArray(e.focus?.items) ? e.focus.items : [];
  return [...items].sort((a, b) => a.rank - b.rank).map((i) => i.symbol);
}

/** An evaluation that stopped before the board: nothing guessed, no rows. */
export function notEvaluated(status: Exclude<EvalStatus, "ok">, reason: DegradedWhy | null, halfDay: boolean, done: boolean, snapshotOk = false): Evaluation {
  return { status, reason, board: null, rows: [], degraded_names: [], snapshot_ok: snapshotOk, day: NO_DAY(halfDay, done) };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The quote the board reads at the slot. The price is the last settled close: the state is as of the slot. Its time
 * is the last print the server knows of before the slot's end: the snapshot's last trade when that is before the end
 * (no print since: a stale name reads paused, exactly as on the page); when the snapshot has printed since, a print
 * inside the slot's own bar (its end, the latest it can be) when that bar exists, else the last bar's start. The
 * high and low are the more extreme of the snapshot's and the bars': the conservative choice, which can only move a
 * state toward missed (target 1 reached), never toward an entry. No VWAP or previous close: cautions only.
 */
export function settledQuote(bars: readonly Bar2[], day: string, end: number, snap: LiveQuote): LiveQuote | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  const snapAt = Date.parse(snap.at);
  const at = Number.isFinite(snapAt) && snapAt < end ? snapAt : last.end === end ? end - 1 : last.start;
  const highs = [...bars.map((b) => b.h), ...(isNum(snap.high) ? [snap.high] : [])];
  const lows = [...bars.map((b) => b.l), ...(isNum(snap.low) ? [snap.low] : [])];
  return { price: last.c, at: new Date(at).toISOString(), open: bars[0]!.o, high: Math.max(...highs), low: Math.min(...lows), day, prev_close: null, vwap: null };
}

/**
 * The board as the page would draw it for the slot ending `slot.end`, read at that bar's close (end +
 * CLOSE_GRACE_MS, when the page's own bar for the slot completes) with the slot's last close as the live price. Two
 * calls for the same slot with the same inputs give the same answer: nothing here reads the run's own clock. (The
 * snapshot is read at run time, so a later run in the same slot could see a newer high, low or last trade; the
 * create-only write makes the first run's answer the record.)
 *
 * Gaps are judged per name, by the page's own rule: the engine's `gap` (trade-state's coveredSince, a slot missing
 * from the break on) or no bars at all puts that name, and only it, in `degraded_names` with no state. A name read
 * before the slot settled makes the whole evaluation degraded ("bars-unsettled").
 */
export function evaluateSlot(input: EvalInput): Evaluation {
  return evaluateSlotStates(input).evaluation;
}

/**
 * evaluateSlot, with the board's own states for the names it evaluated (none when it stopped before the board), for
 * the run's observe-mode log of the guards: which rows were paused, and by a guard or by no fresh price. The
 * evaluation is the same object evaluateSlot returns.
 */
export function evaluateSlotStates(input: EvalInput): { evaluation: Evaluation; states: NameState[] } {
  const stopped = (evaluation: Evaluation) => ({ evaluation, states: [] });
  const { slot, edition } = input;
  const halfDay = isHalfDay(edition);
  if (edition.session !== slot.day) return stopped(notEvaluated("wrong-day", null, halfDay, input.done));
  const items = Array.isArray(edition.focus?.items) ? edition.focus.items : [];
  if (items.length === 0) return stopped(notEvaluated("no-focus", null, halfDay, input.done));
  if (items.some((i) => typeof i.symbol !== "string" || !SYMBOL_RE.test(i.symbol))) return stopped(notEvaluated("degraded", "bad-symbol", halfDay, input.done));
  const open = nyInstant(slot.day, OPEN_MIN);
  if (open === null) return stopped(notEvaluated("degraded", "edition-error", halfDay, input.done));
  const settleAt = slot.end + SERVER_SETTLE_MS;

  const settled: Record<string, Bar2[]> = {};
  const quotes: Record<string, LiveQuote> = {};
  const out = new Map<string, NameWhy>();
  for (const sym of focusSymbols(edition)) {
    const mine = (input.bars[sym] ?? []).filter((b) => b.start >= open && b.end <= slot.end);
    if (mine.length === 0) {
      out.set(sym, "bars-missing");
      continue;
    }
    const at = input.fetchedAt[sym];
    if (!isNum(at) || at < settleAt) return stopped(notEvaluated("degraded", "bars-unsettled", halfDay, input.done, true));
    const snap = input.snapshots[sym];
    if (!snap || snap.day !== slot.day) {
      out.set(sym, "snapshot-missing");
      continue;
    }
    const bars = [...new Map(mine.map((b) => [b.start, b])).values()].sort((a, b) => a.start - b.start);
    settled[sym] = bars;
    const q = settledQuote(bars, slot.day, slot.end, snap);
    if (q) quotes[sym] = q;
  }

  const now = slot.end + CLOSE_GRACE_MS;
  const nowD = new Date(now);
  let day: ReturnType<typeof boardDay> = { dayLimitUsed: false, wonToday: null };
  let journalCurrent = false;
  let breakToday = false;
  try {
    day = boardDay(input.journal, nowD);
    if (input.journal) {
      const c = dayCheck(sessionView(input.journal, nowD), { asOf: input.journal.as_of ?? null, now: nowD });
      journalCurrent = c.current;
      breakToday = c.isToday && c.breaks > 0;
    }
  } catch {
    // A journal the board cannot read: not current, and the day's limits read as the board reads a missing one.
    day = boardDay(null, nowD);
  }
  const mode = boardMode(edition.session, halfDay, "ok", now);
  const live = mode.kind === "live";
  const rows = boardRows(
    {
      session: edition.session,
      halfDay,
      items: items.filter((i) => !out.has(i.symbol)),
      tickers: edition.tickers,
      quotes,
      trails: {},
      serverBars: settled,
      // The bars count as read at the slot's settle instant: exactly those settled then, whenever the run read them.
      serverFetchedAt: Object.fromEntries(Object.keys(settled).map((s) => [s, settleAt])),
      now,
      receivedAt: now,
      dayLimitUsed: day.dayLimitUsed,
      wonToday: day.wonToday,
      // The guards read the snapshot itself (the page's quote source), not the quote built from the bars.
      ...(input.guardsOn && input.guardsOn.length > 0 ? { guards: { on: input.guardsOn, quotes: input.snapshots } } : {}),
    },
    live,
  );
  const states: NameState[] = [];
  for (const s of rows.map((r) => r.state)) {
    if (!s) continue;
    // The page's rule: a slot missing from the break on is a gap, and no entry is read across it.
    if (s.call.gap || s.put.gap) out.set(s.symbol, "bars-gap");
    else states.push(s);
  }
  const barEnd = new Date(slot.end).toISOString();
  const degraded = focusSymbols(edition).filter((s) => out.has(s)).map((symbol) => ({ symbol, reason: out.get(symbol)! }));
  const evaluation: Evaluation = {
    status: "ok",
    reason: null,
    board: mode.kind,
    rows: states.flatMap((s) => stateRows(s).map((r) => ({ ...r, bar_end: barEnd }))),
    degraded_names: degraded,
    snapshot_ok: true,
    day: {
      journal_current: journalCurrent,
      break_today: breakToday,
      day_limit_used: day.dayLimitUsed,
      done: input.done,
      half_day: halfDay,
      gap: degraded.some((d) => d.reason !== "snapshot-missing"),
      broke_earlier: states.some((s) => s.call.brokeEarlier || s.put.brokeEarlier),
      stale: states.some((s) => s.state === "paused" && !s.guards && !s.offDesk),
    },
  };
  return { evaluation, states };
}

// ---- the record -----------------------------------------------------------------------------------------------------
export interface ServerRecord {
  v: typeof RECORD_V;
  engine: string;
  source: "server";
  status: EvalStatus;
  reason: DegradedWhy | null;
  slot_end: string;
  evaluated_at: string;
  /** The New York session the slot is in. */
  session: string;
  /** The edition read: its session and when it was built; null when none was read. */
  edition_session: string | null;
  edition_as_of: string | null;
  board: BoardMode["kind"] | null;
  rows: EvalRow[];
  degraded_names: { symbol: string; reason: NameWhy }[];
  snapshot_ok: boolean;
  day: DayFlags;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * The record a run writes for its slot. The edition is named by its session and build time only. A row or name
 * whose symbol is not a ticker is never dropped quietly: the record is degraded ("bad-symbol") and holds no rows.
 */
export function serverRecord(ev: Evaluation, slot: { day: string; end: number }, evaluatedAt: number, edition: Pick<Options, "session" | "as_of"> | null): ServerRecord {
  const session = edition && typeof edition.session === "string" && DAY_RE.test(edition.session) ? edition.session : null;
  const bad = ev.rows.some((r) => !SYMBOL_RE.test(r.symbol)) || ev.degraded_names.some((d) => !SYMBOL_RE.test(d.symbol));
  return {
    v: RECORD_V,
    engine: ENGINE_VERSION,
    source: "server",
    status: bad ? "degraded" : ev.status,
    reason: bad ? "bad-symbol" : ev.reason,
    slot_end: new Date(slot.end).toISOString(),
    evaluated_at: new Date(evaluatedAt).toISOString(),
    session: slot.day,
    edition_session: session,
    edition_as_of: edition ? isoOrNull(edition.as_of) : null,
    board: bad ? null : ev.board,
    rows: bad ? [] : ev.rows,
    degraded_names: bad ? [] : ev.degraded_names,
    snapshot_ok: ev.snapshot_ok,
    day: ev.day,
  };
}

export interface PageRecord {
  v: typeof RECORD_V;
  engine: string;
  source: "page";
  slot_end: string;
  received_at: string;
  /** The page was hidden during the slot (or opened inside it): no states, they would not be comparable. */
  hidden: boolean;
  /** When the page took `rows`: its first render at or after the slot's close (slot end + CLOSE_GRACE_MS). */
  as_of: string | null;
  /** The page's session bars were late or failing then: its states used its own prices only. */
  bars_delayed: boolean | null;
  /** The page's states as of the slot, the instant the server evaluates: the fidelity comparison. */
  rows: StateRow[];
  /** The page's states when it sent them, about a minute later, when an alert would arrive. */
  rows_at_settle: StateRow[];
  /**
   * The bad-data guards switched on when the page took its states (desk-guards.ts), only when there were any: the
   * shadow numbers compare a slot only against a server record with the same switches.
   */
  guards?: GuardReason[];
  /** The page held switches it could not confirm (its last read failed after a good one): only when so. */
  guards_unsure?: true;
}
