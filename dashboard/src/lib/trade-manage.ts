// The "In a trade" card on the Trade now board: the open trades on focus names, from the owner's journal (their own
// broker fills, read by the host) or from the owner's own "I'm in" note kept in this browser, each with one instruction
// from trade-state's `manage`. Advisory and read only: nothing here places or changes an order.
//
// Pure: no I/O and no clock. The caller passes `now`, the feed's (server) clock (trade-state's serverNow).
import type { Side } from "./entry-checks";
import { focusPlan, type SidePlan } from "./focus-plan";
import type { Lot, Trade } from "./journal";
import type { Tone } from "./labels";
import { closeMinute, type LiveQuote, nyClock, nyInstant, OPEN_MIN, type Options, type TrailPoint } from "./options";
import { MIN_ROOM_MULTIPLE, TIME_STOP_MINUTES } from "./trade-rules";
import {
  type AltTrigger,
  type Bar2,
  bars2m,
  EMA_FAST,
  type Entry,
  flatMinute,
  type Manage,
  manage,
  mergeBars,
  type NameState,
  type NameStateName,
  TRADE_STALE_MS,
} from "./trade-state";

type Item = NonNullable<Options["focus"]>["items"][number];

const p2 = (v: number) => v.toFixed(2);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---- the owner's own note -------------------------------------------------------------------------------------------
/** The browser's storage key for a session day's notes: one key per day, and the other days' keys are dropped. */
export const NOTE_PREFIX = "trade-now-in:";
export const noteKey = (day: string) => `${NOTE_PREFIX}${day}`;
/** A typed fill price must be within this share of the live price. */
export const FILL_MAX_OFF = 0.05;

/** What a note was entered on: the card's own plan, or one of the two other triggers under test. */
export type NoteKind = "plan" | AltTrigger["kind"];

export interface ManualNote {
  symbol: string;
  side: Side;
  /** The underlying's price at the fill, as the owner typed it. */
  price: number;
  /** ISO 8601, the feed's clock when it was saved. */
  at: string;
  kind: NoteKind;
  /** The levels it is managed against, kept with the note so an alternative that ends on the board still has them. */
  plan: SidePlan;
}

const isSide = (v: unknown): v is Side => v === "call" || v === "put";

/** A note's identity: several notes may be kept, one per name, side and fill time. */
export const noteId = (n: Pick<ManualNote, "symbol" | "side" | "at">) => `${n.symbol}|${n.side}|${n.at}`;
const KINDS: readonly NoteKind[] = ["plan", "failed_break", "sweep_reclaim"];

function parsePlan(v: unknown): SidePlan | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (!isSide(p.side) || !isNum(p.level)) return null;
  const opt = (x: unknown) => (isNum(x) ? x : null);
  const t2 = p.target2 as { price?: unknown; name?: unknown } | null | undefined;
  return {
    side: p.side,
    level: p.level,
    levelName: typeof p.levelName === "string" ? p.levelName : "",
    entry: opt(p.entry),
    stop: opt(p.stop),
    target1: opt(p.target1),
    target2: t2 && isNum(t2.price) ? { price: t2.price, name: typeof t2.name === "string" ? t2.name : "" } : null,
  };
}

/** The notes stored for a day, from the stored text. Anything malformed is dropped, never thrown. */
export function parseNotes(raw: string | null | undefined): ManualNote[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: ManualNote[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const n = x as Record<string, unknown>;
    const plan = parsePlan(n.plan);
    if (typeof n.symbol !== "string" || !isSide(n.side) || !isNum(n.price) || !(n.price > 0) || typeof n.at !== "string" || !Number.isFinite(Date.parse(n.at))) continue;
    if (!KINDS.includes(n.kind as NoteKind) || !plan || plan.side !== n.side) continue;
    const note: ManualNote = { symbol: n.symbol, side: n.side, price: n.price, at: n.at, kind: n.kind as NoteKind, plan };
    if (out.some((o) => noteId(o) === noteId(note))) continue; // one note a name, side and fill time
    out.push(note);
  }
  return out;
}

/** The fill price as typed: a positive number within FILL_MAX_OFF of the live price. */
export function checkFill(raw: string, live: number | null): { ok: true; price: number } | { ok: false; error: string } {
  const t = raw.trim();
  const v = Number(t);
  if (t === "" || !Number.isFinite(v)) return { ok: false, error: "Type the price you got, like 752.95" };
  if (!(v > 0)) return { ok: false, error: "The price must be above 0" };
  if (live !== null && live > 0 && Math.abs(v - live) / live > FILL_MAX_OFF)
    return { ok: false, error: `That is more than ${Math.round(FILL_MAX_OFF * 100)}% from the live price ${p2(live)}: check it` };
  return { ok: true, price: Math.round(v * 100) / 100 };
}

/** The levels a live alternative trigger is managed against: its entry and stop, and a first target at 2:1. */
export function altPlan(a: AltTrigger): SidePlan {
  const dir = a.side === "call" ? 1 : -1;
  const target1 = Math.round((a.entry + dir * MIN_ROOM_MULTIPLE * Math.abs(a.entry - a.stop)) * 100) / 100;
  return { side: a.side, level: a.level, levelName: "", entry: a.entry, stop: a.stop, target1, target2: null };
}

// ---- the fill time ---------------------------------------------------------------------------------------------------
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "10:28": an instant's New York minute; "" when unreadable. */
export function nyHhmm(ms: number): string {
  const c = Number.isFinite(ms) ? nyClock(new Date(ms).toISOString()) : null;
  return c ? hhmm(c.minutes) : "";
}

/**
 * The fill time as typed, HH:MM New York, to the minute: a minute of today's session (from the open to the close) that
 * has begun by `now` (the feed's clock). The note's time is the END of that minute (the fill was at or before it): no
 * price before it counts toward target 1, and rule 6 comes due at most 60 s late, never early.
 */
export function checkFillTime(raw: string, now: number, session: string, halfDay: boolean): { ok: true; at: string } | { ok: false; error: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  if (!m || h > 23 || mi > 59) return { ok: false, error: "Type the time of your fill, like 10:28" };
  const min = h * 60 + mi;
  const close = closeMinute(halfDay);
  if (nyClock(new Date(now).toISOString())?.day !== session) return { ok: false, error: "A note is for today's session only" };
  if (min < OPEN_MIN || min >= close) return { ok: false, error: `The fill must be in today's session, ${hhmm(OPEN_MIN)} to ${hhmm(close)} New York` };
  const at = nyInstant(session, min);
  if (at === null) return { ok: false, error: "Type the time of your fill, like 10:28" };
  if (at > now) return { ok: false, error: "That time is still to come: type the time of your fill" };
  return { ok: true, at: new Date(at + 60_000).toISOString() };
}

// ---- the trades to manage -------------------------------------------------------------------------------------------
/** A note is its trade's when the broker's fill (the journal's `opened_at`) is within this of the note's fill time. */
export const NOTE_MATCH_MS = 2 * 60_000;
/** The journal is taken to have caught up with a fill this long after it: a note it still doesn't show is unmatched. */
export const JOURNAL_CATCH_UP_MS = 3 * 60_000;
/** A lot this close to an unmatched note's time is offered as the fill time the owner meant. */
export const NOTE_HINT_MS = 10 * 60_000;

export interface OpenTrade {
  /** One trade: name, side, the plan's kind, fill time (and contract) and where it comes from. */
  id: string;
  symbol: string;
  side: Side;
  entry: Entry;
  plan: SidePlan | null;
  kind: NoteKind;
  /** The note it is managed from; null for a journal lot. */
  note: ManualNote | null;
  /** A note the journal has caught up with but shows no trade for: its card says CHECK, never an instruction. */
  unmatched: boolean;
  /** For an unmatched note: the opening time of a journal lot near it, the fill time the owner may have meant. */
  hintAt: string | null;
  /** The contract held, when the journal's lot names it (a note's own lot, or the journal trade's first); else null. */
  contract?: { expiry: string; strike: number } | null;
}

/** A lot's contract, when it names both its expiry and its strike. */
const lotContract = (l: Lot | undefined): { expiry: string; strike: number } | null =>
  l && typeof l.expiry === "string" && typeof l.strike === "number" && l.strike > 0 ? { expiry: l.expiry, strike: l.strike } : null;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const onSide = (x: { symbol: string; side: string; kind: string }, symbol: string, side: Side) => x.symbol === symbol && x.side === "long" && x.kind === side;
/** Within NOTE_MATCH_MS of a note's fill time: a lot or trade with no opening time never is. */
const near = (opened: string | null | undefined, n: ManualNote) => Math.abs(ms(opened) - ms(n.at)) <= NOTE_MATCH_MS;

/**
 * The journal's open long option lots on a name and side for the session: opened on it, or with no opening time when
 * the journal's own reading (`asOf`) is of the session (it says the lot is open today). Any other is ignored.
 */
function lotsOn(lots: readonly Lot[], symbol: string, side: Side, session: string, asOf: string | null): Lot[] {
  const today = asOf ? nyClock(asOf)?.day === session : false;
  return lots.filter((l) => onSide(l, symbol, side) && (l.opened_at ? nyClock(l.opened_at)?.day === session : today));
}

/**
 * A note's own trade in the journal: the EARLIEST lot or closed trade on its name and side opened within NOTE_MATCH_MS
 * of its fill time. Once that first fill shows closed (with none of it still open), the trade ended at its close, and
 * a lot opened at or after that close is a new trade even inside the window. `lots` are the trade's lots still open;
 * `closed` tells it showed a close. Null: the journal shows nothing near the note.
 */
function noteTrade(n: ManualNote, lots: readonly Lot[], closed: readonly Trade[]): { lots: Lot[]; closed: boolean } | null {
  const ls0 = lots.filter((l) => onSide(l, n.symbol, n.side) && near(l.opened_at, n));
  const cs0 = closed.filter((t) => onSide(t, n.symbol, n.side) && near(t.opened_at, n));
  if (ls0.length === 0 && cs0.length === 0) return null;
  // The note's contract is the one filled nearest its time: another contract opened inside the window is another,
  // un-noted trade, never this note's.
  const gap = (x: { opened_at?: string | null }) => Math.abs(ms(x.opened_at) - ms(n.at));
  const anchor = [...ls0, ...cs0].sort((a, b) => gap(a) - gap(b))[0]!;
  const same = (x: { strike?: number | null; expiry?: string | null }) => (x.strike ?? null) === (anchor.strike ?? null) && (x.expiry ?? null) === (anchor.expiry ?? null);
  const ls = ls0.filter(same);
  const cs = cs0.filter(same);
  const first = Math.min(...ls.map((l) => ms(l.opened_at)), ...cs.map((t) => ms(t.opened_at)));
  const firstClosed = cs.filter((t) => ms(t.opened_at) === first);
  const firstOpen = ls.some((l) => ms(l.opened_at) === first);
  const end = firstClosed.length && !firstOpen ? Math.max(...firstClosed.map((t) => ms(t.closed_at))) : Infinity;
  return { lots: ls.filter((l) => ms(l.opened_at) < end), closed: cs.length > 0 };
}

/**
 * The notes the journal has closed out: their own trade (noteTrade) shows CLOSED and no lot of it is still open
 * (selling half leaves the rest open). No other trade's close retires a note, and a note the journal has not shown
 * yet stays. Retired notes leave the browser, and their card goes.
 */
export function retiredNotes(notes: readonly ManualNote[], lots: readonly Lot[], closed: readonly Trade[], session: string, asOf: string | null = null): ManualNote[] {
  return notes.filter((n) => {
    const t = noteTrade(n, lotsOn(lots, n.symbol, n.side, session, asOf), closed);
    return t !== null && t.closed && t.lots.length === 0;
  });
}

const sameContract = (a: Lot, b: Lot) => (a.strike ?? null) === (b.strike ?? null) && (a.expiry ?? null) === (b.expiry ?? null);

/**
 * Lots on one name and side, as trades: each lot its own, except lots of the same contract opened within
 * NOTE_MATCH_MS of the trade's first fill (one position added to). Lots with no opening time make one trade together.
 */
function lotTrades(lots: readonly Lot[]): Lot[][] {
  const timed = lots.filter((l) => Number.isFinite(ms(l.opened_at))).sort((a, b) => ms(a.opened_at) - ms(b.opened_at));
  const out: Lot[][] = [];
  for (const l of timed) {
    const g = out.find((x) => sameContract(x[0]!, l) && ms(l.opened_at) - ms(x[0]!.opened_at) <= NOTE_MATCH_MS);
    if (g) g.push(l);
    else out.push([l]);
  }
  const untimed = lots.filter((l) => !Number.isFinite(ms(l.opened_at)));
  if (untimed.length) out.push(untimed);
  return out;
}

/**
 * The open trades on focus names. Every note the journal has not retired is a card of its own, managed from its fill
 * price and time, with its own trade's lots (noteTrade). Once the journal has caught up with a note
 * (`asOf` on the session, JOURNAL_CATCH_UP_MS or more after its fill) and shows nothing near it, the note is unmatched: CHECK, and a lot
 * within NOTE_HINT_MS is offered as the time meant. Every other lot on a name and side (`lots`: one per fill, as the
 * journal has them, not merged) is a separate trade (lotTrades) with a journal card of its own, from its own first
 * fill, never a note's history. A lot with no opening time never overrides a note: with none on the name and side
 * it gives a card whose fill time is unknown (CHECK). A journal card has no underlying fill price: the focus plan's
 * entry on its side stands in for it ("card entry"), never a live alternative's.
 */
export function openTrades(
  items: readonly Item[],
  lots: readonly Lot[],
  notes: readonly ManualNote[],
  session: string,
  closed: readonly Trade[] = [],
  asOf: string | null = null,
): OpenTrade[] {
  const names = new Set(items.map((i) => i.symbol));
  const gone = new Set(retiredNotes(notes, lots, closed, session, asOf).map(noteId));
  const live = notes.filter((n) => names.has(n.symbol) && !gone.has(noteId(n))).sort((a, b) => ms(a.at) - ms(b.at));
  // a journal read on another day says nothing about this session's fills
  const asOfToday = asOf ? nyClock(asOf)?.day === session : false;
  const caughtUp = (n: ManualNote) => asOfToday && ms(asOf) >= ms(n.at) + JOURNAL_CATCH_UP_MS;
  // Every note's own lots first, so a note's hint can never offer a lot another note already manages.
  const own = new Map(live.map((n) => [noteId(n), noteTrade(n, lotsOn(lots, n.symbol, n.side, session, asOf), closed)] as const));
  const taken = new Set<Lot>([...own.values()].flatMap((t) => t?.lots ?? []));
  const out: OpenTrade[] = live.map((n) => {
    const mine = lotsOn(lots, n.symbol, n.side, session, asOf);
    const t = own.get(noteId(n)) ?? null;
    const unmatched = t === null && caughtUp(n);
    const hint = unmatched
      ? mine
          .filter((l) => !taken.has(l) && Math.abs(ms(l.opened_at) - ms(n.at)) <= NOTE_HINT_MS)
          .sort((a, b) => Math.abs(ms(a.opened_at) - ms(n.at)) - Math.abs(ms(b.opened_at) - ms(n.at)))[0]
      : undefined;
    return {
      id: `${noteId(n)}|${n.kind}|manual`,
      symbol: n.symbol,
      side: n.side,
      kind: n.kind,
      plan: n.plan,
      note: n,
      unmatched,
      hintAt: hint?.opened_at ?? null,
      contract: lotContract(t?.lots[0]),
      entry: { side: n.side, price: n.price, at: n.at, source: "manual" },
    };
  });

  const pairs: { symbol: string; side: Side }[] = [];
  for (const l of lots)
    if (names.has(l.symbol) && (l.kind === "call" || l.kind === "put") && !pairs.some((p) => p.symbol === l.symbol && p.side === l.kind)) pairs.push({ symbol: l.symbol, side: l.kind });
  for (const { symbol, side } of pairs) {
    const noted = live.some((n) => n.symbol === symbol && n.side === side);
    const own = lotsOn(lots, symbol, side, session, asOf).filter((l) => !taken.has(l));
    // a lot with no time never overrides a note
    const rest = noted ? own.filter((l) => l.opened_at) : own;
    const plan = focusPlan(items.find((i) => i.symbol === symbol)!)[side];
    const ref = plan ? (plan.entry ?? plan.level) : null;
    if (ref === null) continue;
    for (const g of lotTrades(rest)) {
      const at = g[0]!.opened_at ? new Date(ms(g[0]!.opened_at)).toISOString() : "";
      const contract = `${g[0]!.strike ?? ""}/${g[0]!.expiry ?? ""}`;
      out.push({
        id: `${symbol}|${side}|plan|${at}|${contract}|journal`,
        symbol,
        side,
        kind: "plan",
        plan,
        note: null,
        unmatched: false,
        hintAt: null,
        contract: lotContract(g[0]),
        entry: { side, price: ref, at, source: "journal" },
      });
    }
  }
  return out;
}

// ---- the "I'm in" form ----------------------------------------------------------------------------------------------
/** What the form saves, fixed when it opens: a later change of the row never changes it. */
export interface FormCapture {
  symbol: string;
  side: Side;
  kind: NoteKind;
  plan: SidePlan;
  /** The row's state when it opened; null when opened from a card ("Set my fill"). */
  state: NameStateName | null;
  /** The fill time to start with, HH:MM New York. */
  time: string;
  origin: "row" | "card";
}

/** What an entry row (or a live alternative) offers to note: its side, the trigger and the levels. */
export function rowCapture(state: NameState | null | undefined, item: Item | undefined): { side: Side; kind: NoteKind; plan: SidePlan } | null {
  if (!state) return null;
  const alt = state.alt && (state.state === "plan_off" || state.state === "watch" || state.state === "missed") ? state.alt : null;
  if (alt) return { side: alt.side, kind: alt.kind, plan: altPlan(alt) };
  if (state.state !== "enter_zone" || !state.side) return null;
  const plan = item ? focusPlan(item)[state.side] : null;
  return plan ? { side: state.side, kind: "plan", plan } : null;
}

/** The form for a row, captured at the click: null when the row offers nothing to note. `now` is the feed's clock. */
export function formFromRow(symbol: string, state: NameState | null | undefined, item: Item | undefined, now: number): FormCapture | null {
  const c = rowCapture(state, item);
  return c ? { symbol, ...c, state: state!.state, time: nyHhmm(now), origin: "row" } : null;
}

/** The form for a journal card's "Set my fill": its side and levels, the fill time from the journal's oldest lot. */
export function formFromTrade(t: OpenTrade, now: number): FormCapture | null {
  if (!t.plan) return null;
  const at = ms(t.entry.at);
  return { symbol: t.symbol, side: t.side, kind: t.kind, plan: t.plan, state: null, time: nyHhmm(Number.isFinite(at) && at <= now ? at : now), origin: "card" };
}

/** The row has changed since the form opened: another state, side or trigger. */
export function formMovedOn(f: FormCapture, state: NameState | null | undefined, item: Item | undefined): boolean {
  if (f.origin !== "row") return false;
  const c = rowCapture(state, item);
  return (state?.state ?? null) !== f.state || !c || c.side !== f.side || c.kind !== f.kind;
}

export const movedOnLine = (f: FormCapture) => `The board has moved on: this note keeps the ${f.side} you opened`;

/** The note Save writes: what the form captured, the typed price and fill time. */
export function noteFromForm(f: FormCapture, price: number, at: string): ManualNote {
  return { symbol: f.symbol, side: f.side, price, at, kind: f.kind, plan: f.plan };
}

// ---- the card -------------------------------------------------------------------------------------------------------
/** The card's one word beside its instruction. */
export type ManageAction = "exit" | "sell_half" | "trail" | "hold" | "check";

export const ACTION_WORD: Record<ManageAction, string> = {
  exit: "EXIT",
  sell_half: "SELL HALF",
  trail: "TRAIL",
  hold: "HOLD",
  check: "CHECK",
};

export const PAUSED_LINE = "Prices paused: manage this one on your platform";
export const OFF_LINE = "Live prices off: manage this one on your platform";
export const FILLS_LINE = "From your fills: set your fill for exact levels";
export const CARD_ENTRY = "(card entry)";
export const FILL_MINUTE = "fill time to the minute";
export const UNMATCHED_LINE = "Your fills don't show this trade: check the fill time, or Clear";
/** The hint on an unmatched note's card: a journal lot near it. */
export const hintLine = (symbol: string, side: Side, at: string) => `Your fills show a ${symbol} ${side} at ${nyHhmm(Date.parse(at))}: use that time?`;

export interface ManageView {
  /** The trade (OpenTrade.id): the notices' memory. */
  id: string;
  /** The name and side (a name and side can have more than one card: a note and a separate trade). */
  key: string;
  symbol: string;
  side: Side;
  source: Entry["source"];
  kind: NoteKind;
  action: ManageAction;
  tone: Tone;
  line: string;
  m: Manage;
  /** A journal lot: the real fill is unknown, the card's entry stands in for it (rule 6, the stop after target 1). */
  cardEntry: boolean;
  /** The line under a journal card's instruction; null for a note. */
  fillLine: string | null;
  /** A note's fill time is typed to the minute: the card says so. */
  fillNote: string | null;
  /** An unmatched note's offer of a journal lot's time: the line and the time to use. */
  hint: { line: string; at: string } | null;
  /** The stop is the entry (target 1 hit). */
  stopAtEntry: boolean;
  /** The trail level; "after target 1", or "after 9 bars" once target 1 is hit and the trail has too few bars. */
  trailText: string;
  /** "4:59", "now", "working", "done" or "–". */
  notWorkingText: string;
  /** "4 h 46 min", "12 min", "now". */
  flatText: string;
  /** "15:10", or "12:10" on a half day. */
  flatAt: string;
  /** The live price the card read, only while it is fresh (feed live, quote of the session day, trade not stale); else null. */
  price: number | null;
  /** The contract held, when known (OpenTrade.contract). */
  contract: { expiry: string; strike: number } | null;
  /** The stock price the trade is managed from: the note's fill, or the card's entry for a journal lot (`cardEntry`). */
  entry: number;
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function hoursMin(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m === 0) return "now";
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

export function actionOf(m: Manage): ManageAction {
  if (m.tone === "bad") return "exit";
  if (m.tone === "good") return "sell_half";
  if (m.tone === "warn") return "check";
  return m.trail !== null ? "trail" : "hold";
}

/** What the cards read: live prices, or the feed off (or failing, or reconnecting) after they were live. */
export type CardFeed = "live" | "off";

/**
 * Whether the cards show, and on what. Live in the board's live mode once the bars have answered (or once the cards
 * have been live: a re-read of the bars is not a first read). After the cards were live, a feed that is off, failing
 * or reconnecting keeps them on screen as "off": CHECK, nothing from old prices. Null otherwise: no cards.
 */
export function cardFeed(mode: string, barsLoading: boolean, wasLive: boolean): CardFeed | null {
  if (mode === "live") return !barsLoading || wasLive ? "live" : null;
  if ((mode === "off" || mode === "loading") && wasLive) return "off";
  return null;
}

/**
 * The card cannot trust its prices: its own row is paused (or missing), or its quote is missing, of another day, or
 * its last trade is older than TRADE_STALE_MS on the feed's clock.
 */
export function cardPaused(rowState: NameStateName | null | undefined, quote: LiveQuote | null | undefined, now: number, session: string): boolean {
  if (!rowState || rowState === "paused") return true;
  if (!quote || !isNum(quote.price) || quote.day !== session) return true;
  const at = Date.parse(quote.at);
  return !Number.isFinite(at) || now - at > TRADE_STALE_MS;
}

export interface ManageInput {
  session: string;
  halfDay: boolean;
  quote: LiveQuote | null;
  trail: readonly TrailPoint[];
  /** The server's session bars for the name (`/api/bars`). */
  serverBars: readonly Bar2[];
  /** When the server read them (ms, the server's clock); null uses none (mergeBars). */
  serverFetchedAt: number | null;
  /** The feed's (server) clock, ms. */
  now: number;
  /** The name's own row state on the board; null without a row. */
  rowState: NameStateName | null;
  feed: CardFeed;
}

/**
 * One open trade's card, from `manage` on the session's bars (the server's joined to the page's). With the feed off it
 * says CHECK, from nothing old; with its own prices paused it says CHECK unless `manage` already says to exit.
 */
export function manageView(t: OpenTrade, x: ManageInput): ManageView {
  const now = new Date(x.now);
  const own = bars2m(x.trail, x.quote, now, x.halfDay, x.session);
  // mergeBars takes a server bar only once it had settled when the server read it (SERVER_SETTLE_MS), as the rows do.
  const bars = mergeBars(x.serverBars, own, x.serverFetchedAt);
  const m = manage(t.entry, t.plan, bars, x.quote, now, x.halfDay, x.trail);
  const off = x.feed === "off";
  const paused = !off && m.tone !== "bad" && cardPaused(x.rowState, x.quote, x.now, x.session);
  const cardEntry = t.entry.source === "journal";
  // After target 1 `manage` moves the stop to the entry: that is how the card knows it was hit.
  const hit = t.plan?.target1 != null && m.stop === t.entry.price && t.plan.stop !== t.entry.price;
  const ownLine = cardEntry && hit ? m.line.split(p2(t.entry.price)).join(`${p2(t.entry.price)} ${CARD_ENTRY}`) : m.line;
  const check = t.unmatched || off || paused;
  const line = t.unmatched ? UNMATCHED_LINE : off ? OFF_LINE : paused ? PAUSED_LINE : ownLine;
  const tone: Tone = check ? "warn" : m.tone;
  return {
    id: t.id,
    key: `${t.symbol}|${t.side}`,
    symbol: t.symbol,
    side: t.side,
    source: t.entry.source,
    kind: t.kind,
    action: check ? "check" : actionOf(m),
    tone,
    line,
    m,
    cardEntry,
    fillLine: cardEntry ? FILLS_LINE : null,
    fillNote: cardEntry ? null : FILL_MINUTE,
    hint: t.hintAt ? { line: hintLine(t.symbol, t.side, t.hintAt), at: t.hintAt } : null,
    stopAtEntry: hit,
    trailText: m.trail !== null ? p2(m.trail) : hit ? `after ${EMA_FAST} bars` : "after target 1",
    notWorkingText:
      m.notWorkingSecLeft === null ? (hit ? "done" : Number.isFinite(Date.parse(t.entry.at)) ? "working" : "–") : m.notWorkingSecLeft === 0 ? "now" : mmss(Math.min(m.notWorkingSecLeft, TIME_STOP_MINUTES * 60)),
    flatText: m.minToFlat === null ? "–" : hoursMin(m.minToFlat),
    flatAt: hhmm(flatMinute(x.halfDay)),
    // Never the price of a paused card, even one that says EXIT: a distance from it would be an old number.
    price: !off && !t.unmatched && !cardPaused(x.rowState, x.quote, x.now, x.session) ? x.quote!.price : null,
    contract: t.contract ?? null,
    entry: t.entry.price,
  };
}

// ---- the notices ----------------------------------------------------------------------------------------------------
export interface ManageNotice {
  id: string;
  /** The trade (ManageView.id): two cards on one name and side never replace each other's notice. */
  key: string;
  symbol: string;
  action: ManageAction;
  title: string;
  line: string;
  tone: Tone;
}

/**
 * A notice once a card's word changes: against the last word that was not CHECK, so a pause (or the feed off) in
 * between neither announces itself nor makes the next word look new, and a HOLD that turns EXIT across it is
 * announced. A trade's first word is not announced. The memory is by trade and outlives the cards going away.
 */
export function manageNotices(
  last: Readonly<Record<string, ManageAction>>,
  views: readonly ManageView[],
  seq: number,
): { last: Record<string, ManageAction>; fresh: ManageNotice[] } {
  const next: Record<string, ManageAction> = { ...last };
  const fresh: ManageNotice[] = [];
  for (const v of views) {
    if (v.action === "check") continue;
    const was = last[v.id];
    if (was !== undefined && was !== v.action)
      fresh.push({ id: `${v.id}:${v.action}:${seq}`, key: v.id, symbol: v.symbol, action: v.action, title: `${v.symbol} ${v.side}: ${ACTION_WORD[v.action]}`, line: v.line, tone: v.tone });
    next[v.id] = v.action;
  }
  return { last: next, fresh };
}

/** The new notices first, each replacing the older one for its trade. */
export function mergeNotices(old: readonly ManageNotice[], fresh: readonly ManageNotice[]): ManageNotice[] {
  return [...fresh, ...old.filter((n) => !fresh.some((f) => f.key === n.key))];
}

/** The notices to show: only while their card still says their word. */
export function shownNotices(notices: readonly ManageNotice[], views: readonly ManageView[]): ManageNotice[] {
  return notices.filter((n) => views.some((v) => v.id === n.key && v.action === n.action));
}
