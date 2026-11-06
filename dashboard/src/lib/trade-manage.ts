// The "In a trade" card on the Trade now board: the open trades on focus names, from the owner's journal (their own
// broker fills, read by the host) or from the owner's own "I'm in" note kept in this browser, each with one instruction
// from trade-state's `manage`. Advisory and read only: nothing here places or changes an order.
//
// Pure: no I/O and no clock. The caller passes `now`, the feed's (server) clock (trade-state's serverNow).
import type { Side } from "./entry-checks";
import { focusPlan, type SidePlan } from "./focus-plan";
import type { Lot } from "./journal";
import type { Tone } from "./labels";
import { type LiveQuote, nyClock, type Options, type TrailPoint } from "./options";
import { MIN_ROOM_MULTIPLE, TIME_STOP_MINUTES } from "./trade-rules";
import { type AltTrigger, type Bar2, bars2m, EMA_FAST, type Entry, flatMinute, type Manage, manage, mergeBars } from "./trade-state";

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
    if (out.some((o) => o.symbol === n.symbol)) continue; // one note a name
    out.push({ symbol: n.symbol, side: n.side, price: n.price, at: n.at, kind: n.kind as NoteKind, plan });
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

// ---- the trades to manage -------------------------------------------------------------------------------------------
export interface OpenTrade {
  symbol: string;
  side: Side;
  entry: Entry;
  plan: SidePlan | null;
  kind: NoteKind;
}

/**
 * The open trades on focus names, one a name and side: the owner's note where there is one (it has the fill price),
 * else the journal's open long option lots opened on the session (or with no opening time). A journal lot has no
 * underlying fill price, so the card's entry stands in for it.
 */
export function openTrades(items: readonly Item[], lots: readonly Lot[], notes: readonly ManualNote[], session: string): OpenTrade[] {
  const names = new Set(items.map((i) => i.symbol));
  const out: OpenTrade[] = [];
  for (const n of notes) {
    if (!names.has(n.symbol)) continue;
    out.push({ symbol: n.symbol, side: n.side, kind: n.kind, plan: n.plan, entry: { side: n.side, price: n.price, at: n.at, source: "manual" } });
  }
  for (const l of lots) {
    if (!names.has(l.symbol) || l.side !== "long" || (l.kind !== "call" && l.kind !== "put")) continue;
    if (l.opened_at && nyClock(l.opened_at)?.day !== session) continue;
    if (out.some((o) => o.symbol === l.symbol && o.side === l.kind)) continue;
    const item = items.find((i) => i.symbol === l.symbol)!;
    const plan = focusPlan(item)[l.kind];
    const ref = plan ? (plan.entry ?? plan.level) : null;
    if (ref === null) continue;
    out.push({ symbol: l.symbol, side: l.kind, kind: "plan", plan, entry: { side: l.kind, price: ref, at: l.opened_at ?? "", source: "journal" } });
  }
  return out;
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

export interface ManageView {
  key: string;
  symbol: string;
  side: Side;
  source: Entry["source"];
  kind: NoteKind;
  action: ManageAction;
  tone: Tone;
  line: string;
  m: Manage;
  /** The trail level; "after target 1", or "after 9 bars" once target 1 is hit and the trail has too few bars. */
  trailText: string;
  /** "4:59", "now", "working", "done" or "–". */
  notWorkingText: string;
  /** "4 h 46 min", "12 min", "now". */
  flatText: string;
  /** "15:10", or "12:10" on a half day. */
  flatAt: string;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

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
  /** Every row reads PRICES PAUSED: the card says to manage on the platform. */
  paused: boolean;
}

/** One open trade's card, from `manage` on the session's bars (the server's joined to the page's). */
export function manageView(t: OpenTrade, x: ManageInput): ManageView {
  const now = new Date(x.now);
  const own = bars2m(x.trail, x.quote, now, x.halfDay, x.session);
  // mergeBars takes a server bar only once it had settled when the server read it (SERVER_SETTLE_MS), as the rows do.
  const bars = mergeBars(x.serverBars, own, x.serverFetchedAt);
  const m = manage(t.entry, t.plan, bars, x.quote, now, x.halfDay, x.trail);
  const paused = x.paused && m.tone !== "bad";
  const line = paused ? "Prices paused: manage this one on your platform" : m.line;
  const tone: Tone = paused ? "warn" : m.tone;
  const mm = paused ? { ...m, tone } : m;
  // After target 1 `manage` moves the stop to the entry: that is how the card knows it was hit.
  const hit = t.plan?.target1 != null && m.stop === t.entry.price && t.plan.stop !== t.entry.price;
  return {
    key: `${t.symbol}|${t.side}`,
    symbol: t.symbol,
    side: t.side,
    source: t.entry.source,
    kind: t.kind,
    action: actionOf(mm),
    tone,
    line,
    m,
    trailText: m.trail !== null ? p2(m.trail) : hit ? `after ${EMA_FAST} bars` : "after target 1",
    notWorkingText:
      m.notWorkingSecLeft === null ? (hit ? "done" : Number.isFinite(Date.parse(t.entry.at)) ? "working" : "–") : m.notWorkingSecLeft === 0 ? "now" : mmss(Math.min(m.notWorkingSecLeft, TIME_STOP_MINUTES * 60)),
    flatText: m.minToFlat === null ? "–" : hoursMin(m.minToFlat),
    flatAt: hhmm(flatMinute(x.halfDay)),
  };
}
