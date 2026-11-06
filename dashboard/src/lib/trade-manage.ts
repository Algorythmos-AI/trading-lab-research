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
 * The fill time as typed, HH:MM New York: a minute of today's session (from the open to the close), not after `now`
 * (the feed's clock). The note's time is the start of that minute.
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
  return { ok: true, at: new Date(at).toISOString() };
}

// ---- the trades to manage -------------------------------------------------------------------------------------------
/** A journal lot opened more than this long after a note's fill time is a new trade: the note yields to it. */
export const NEW_TRADE_MIN = 10;
const NEW_TRADE_MS = NEW_TRADE_MIN * 60_000;

export interface OpenTrade {
  /** One trade: name, side, fill time and where it comes from. */
  id: string;
  symbol: string;
  side: Side;
  entry: Entry;
  plan: SidePlan | null;
  kind: NoteKind;
  /** The note it is managed from; null for a journal lot. */
  note: ManualNote | null;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** The journal's open long option lots on a name and side opened on the session (or with no opening time). */
function lotsOn(lots: readonly Lot[], symbol: string, side: Side, session: string): Lot[] {
  return lots.filter((l) => l.symbol === symbol && l.side === "long" && l.kind === side && (!l.opened_at || nyClock(l.opened_at)?.day === session));
}

/** A lot provably from a note's trade: opened no later than NEW_TRADE_MIN after its fill time. A lot with no time is not. */
const fromNote = (l: Lot, n: ManualNote) => ms(l.opened_at) <= ms(n.at) + NEW_TRADE_MS;

/**
 * The notes the journal has closed out: a closed long option trade on the same name and side that closed after the
 * note's fill time, with no lot from the note's own time still open (selling half leaves the rest open). They are
 * removed from the browser, and their card goes.
 */
export function retiredNotes(notes: readonly ManualNote[], lots: readonly Lot[], closed: readonly Trade[], session: string): ManualNote[] {
  return notes.filter((n) => {
    const at = ms(n.at);
    const closedAfter = closed.some((t) => t.symbol === n.symbol && t.side === "long" && t.kind === n.side && ms(t.closed_at) > at);
    return closedAfter && !lotsOn(lots, n.symbol, n.side, session).some((l) => fromNote(l, n));
  });
}

/**
 * The open trades on focus names, one a name and side. The owner's newest note on it, unless the journal has retired
 * it or shows a lot opened more than NEW_TRADE_MIN after its fill (a new trade: the note yields to it, and its entry is
 * never applied to that trade). Else the journal's open long option lots (`lots`: one per fill, as the journal has
 * them, not merged), opened on the session or with no opening time, from the oldest fill. A journal lot has no
 * underlying fill price, so the card's entry stands in for it: a live alternative's on that side when the board has
 * one for the name (`alts`), else the focus plan's.
 */
export function openTrades(
  items: readonly Item[],
  lots: readonly Lot[],
  notes: readonly ManualNote[],
  session: string,
  closed: readonly Trade[] = [],
  alts: Readonly<Record<string, AltTrigger | null | undefined>> = {},
): OpenTrade[] {
  const names = new Set(items.map((i) => i.symbol));
  const gone = new Set(retiredNotes(notes, lots, closed, session).map(noteId));
  const pairs: { symbol: string; side: Side }[] = [];
  const add = (symbol: string, side: Side) => {
    if (names.has(symbol) && !pairs.some((p) => p.symbol === symbol && p.side === side)) pairs.push({ symbol, side });
  };
  for (const n of notes) if (!gone.has(noteId(n))) add(n.symbol, n.side);
  for (const l of lots) if (l.side === "long" && (l.kind === "call" || l.kind === "put") && lotsOn([l], l.symbol, l.kind, session).length) add(l.symbol, l.kind);

  const out: OpenTrade[] = [];
  for (const { symbol, side } of pairs) {
    const mine = lotsOn(lots, symbol, side, session);
    const note = notes
      .filter((n) => n.symbol === symbol && n.side === side && !gone.has(noteId(n)))
      .sort((a, b) => ms(b.at) - ms(a.at))[0];
    const later = note ? mine.filter((l) => !fromNote(l, note)) : mine;
    if (note && later.length === 0) {
      out.push({ id: `${noteId(note)}|manual`, symbol, side, kind: note.kind, plan: note.plan, note, entry: { side, price: note.price, at: note.at, source: "manual" } });
      continue;
    }
    if (later.length === 0) continue;
    const times = later.map((l) => ms(l.opened_at));
    const at = times.every(Number.isFinite) ? new Date(Math.min(...times)).toISOString() : "";
    const item = items.find((i) => i.symbol === symbol)!;
    const alt = alts[symbol];
    const useAlt = alt && alt.side === side ? alt : null;
    const plan = useAlt ? altPlan(useAlt) : focusPlan(item)[side];
    const ref = plan ? (plan.entry ?? plan.level) : null;
    if (ref === null) continue;
    out.push({ id: `${symbol}|${side}|${at}|journal`, symbol, side, kind: useAlt ? useAlt.kind : "plan", plan, note: null, entry: { side, price: ref, at, source: "journal" } });
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

export interface ManageView {
  /** The trade (OpenTrade.id): the notices' memory. */
  id: string;
  /** The name and side: one card, and one notice, each. */
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
  const line = off ? OFF_LINE : paused ? PAUSED_LINE : ownLine;
  const tone: Tone = off || paused ? "warn" : m.tone;
  return {
    id: t.id,
    key: `${t.symbol}|${t.side}`,
    symbol: t.symbol,
    side: t.side,
    source: t.entry.source,
    kind: t.kind,
    action: off || paused ? "check" : actionOf(m),
    tone,
    line,
    m,
    cardEntry,
    fillLine: cardEntry ? FILLS_LINE : null,
    stopAtEntry: hit,
    trailText: m.trail !== null ? p2(m.trail) : hit ? `after ${EMA_FAST} bars` : "after target 1",
    notWorkingText:
      m.notWorkingSecLeft === null ? (hit ? "done" : Number.isFinite(Date.parse(t.entry.at)) ? "working" : "–") : m.notWorkingSecLeft === 0 ? "now" : mmss(Math.min(m.notWorkingSecLeft, TIME_STOP_MINUTES * 60)),
    flatText: m.minToFlat === null ? "–" : hoursMin(m.minToFlat),
    flatAt: hhmm(flatMinute(x.halfDay)),
  };
}

// ---- the notices ----------------------------------------------------------------------------------------------------
export interface ManageNotice {
  id: string;
  /** The name and side. */
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
      fresh.push({ id: `${v.key}:${v.action}:${seq}`, key: v.key, symbol: v.symbol, action: v.action, title: `${v.symbol} ${v.side}: ${ACTION_WORD[v.action]}`, line: v.line, tone: v.tone });
    next[v.id] = v.action;
  }
  return { last: next, fresh };
}

/** The new notices first, each replacing the older one for its name and side. */
export function mergeNotices(old: readonly ManageNotice[], fresh: readonly ManageNotice[]): ManageNotice[] {
  return [...fresh, ...old.filter((n) => !fresh.some((f) => f.key === n.key))];
}

/** The notices to show: only while their card still says their word. */
export function shownNotices(notices: readonly ManageNotice[], views: readonly ManageView[]): ManageNotice[] {
  return notices.filter((n) => views.some((v) => v.key === n.key && v.action === n.action));
}
