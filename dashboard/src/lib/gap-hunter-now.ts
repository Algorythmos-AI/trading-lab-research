// What Gap Hunter is doing now (DEC-0078): the robot's own block, read from whichever copy is newer, the stocks
// snapshot's (every 5 minutes) or its own live document (every minute in session). Pure: no I/O; the clock is passed
// in.
//
// The block names rules by code (e1 to e4) and gives each row's reason as a code. The words here say what state a
// rule or a row is in ("waiting", "order resting", "window over"), never what a rule looks for: no setup name, no
// rule text. A code this file does not know is shown as itself.
//
// Symbols and prices are PRIVATE (AGENTS.md data classes): this page is behind the owner's login, in a paper frame.
import type { GapHunterLiveResult } from "./snapshot";
import { nyNow, sessionOf } from "./market-calendar";
import type { RailStep } from "@/components/step-rail";
import type { Snapshot } from "./types";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";
type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const stamp = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : null);
const rule = (v: unknown): string | null => (typeof v === "string" && /^e[1-9]$/.test(v) ? v : null);
/** A stock symbol, or null: anything else the host could send is not shown. */
const symbol = (v: unknown): string | null => (typeof v === "string" && /^[A-Z][A-Z0-9.]{0,9}$/.test(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------- which copy

export type SourceKind = "live" | "snapshot" | "none";

export interface Source {
  raw: Raw | null;
  from: SourceKind;
  /** When the host built the block. */
  asOf: string | null;
  /** Minutes after which, in the publish window, the copy is late: about three publishes of its own rhythm. */
  lateAfterMin: number;
}

const LATE_LIVE_MIN = 3;
const LATE_SNAPSHOT_MIN = 12;

/** The newer of the two copies, by the block's own `as_of`. The live document is absent until its unit is installed. */
export function pickSource(s: Snapshot | null, live: GapHunterLiveResult | null): Source {
  const fromSnap = (s as unknown as Raw | null)?.gap_hunter;
  const snap = isObj(fromSnap) ? fromSnap : null;
  const liveRaw = live?.status === "ok" && isObj(live.doc.gap_hunter) ? (live.doc.gap_hunter as Raw) : null;
  const at = (r: Raw | null, fallback: unknown) => stamp(r?.as_of) ?? stamp(fallback);
  const snapAt = at(snap, s?.as_of);
  const liveAt = at(liveRaw, live?.status === "ok" ? live.doc.as_of : null);
  const t = (x: string | null) => (x ? Date.parse(x) : -Infinity);
  if (liveRaw && (!snap || t(liveAt) >= t(snapAt))) return { raw: liveRaw, from: "live", asOf: liveAt, lateAfterMin: LATE_LIVE_MIN };
  if (snap) return { raw: snap, from: "snapshot", asOf: snapAt, lateAfterMin: LATE_SNAPSHOT_MIN };
  return { raw: null, from: "none", asOf: null, lateAfterMin: LATE_SNAPSHOT_MIN };
}

// ---------------------------------------------------------------- the block, read field by field

export interface Heartbeat {
  session: string | null;
  armedAt: string | null;
  lastRow: string | null;
  rowsToday: number | null;
  ended: boolean | null;
}
export interface Pick {
  symbol: string | null;
  rank: number | null;
  why: string | null;
  tier2: string[];
}
export interface RuleNow {
  rule: string;
  why: string | null;
  trigger: number | null;
  stop: number | null;
}
export interface Row {
  t: string;
  event: string;
  code: string | null;
  why: string | null;
  symbol: string | null;
  r: number | null;
}
export interface Position {
  symbol: string | null;
  code: string | null;
  state: string | null;
  origin: string | null;
  shares: number | null;
  soldAtTarget: number | null;
  entry: number | null;
  trigger: number | null;
  stop: number | null;
  stop0: number | null;
  target: number | null;
}
export interface Closed {
  day: string | null;
  symbol: string | null;
  code: string | null;
  reason: string | null;
  r: number | null;
  booked: boolean | null;
  h1: number | null;
  h2: number | null;
}
export interface StopRule {
  decision: string | null;
  trades: number | null;
  sumR: number | null;
  maxLossR: number | null;
  reviewAt: number | null;
  stopDate: string | null;
}
export interface Live {
  enabled: boolean | null;
  kill: boolean | null;
  latched: boolean | null;
  heartbeat: Heartbeat | null;
  pick: Pick | null;
  rules: RuleNow[];
  timeline: Row[];
  position: Position | null;
  closed: Closed[];
  xLatched: string[];
  stopRule: StopRule | null;
  rotation: { names: number | null; changes: number | null; live: boolean; done: string | null } | null;
}

export function readLive(raw: Raw | null): Live | null {
  if (!raw) return null;
  const hb = isObj(raw.heartbeat) ? raw.heartbeat : null;
  const pk = isObj(raw.pick) ? raw.pick : null;
  const pos = isObj(raw.position) ? raw.position : null;
  const saf = isObj(raw.safety) ? raw.safety : null;
  const sr = isObj(saf?.stop_rule) ? (saf.stop_rule as Raw) : null;
  const rot = isObj(raw.rotation) ? raw.rotation : null;
  return {
    enabled: bool(raw.enabled),
    kill: bool(raw.kill),
    latched: bool(raw.latched),
    heartbeat: hb ? { session: day(hb.session), armedAt: stamp(hb.armed_at), lastRow: stamp(hb.last_row), rowsToday: count(hb.rows_today), ended: bool(hb.ended) } : null,
    pick: pk ? { symbol: symbol(pk.symbol), rank: count(pk.rank), why: code(pk.why), tier2: arr(pk.tier2).map(symbol).filter((x): x is string => x !== null) } : null,
    rules: arr(raw.rules).flatMap((x) => {
      if (!isObj(x)) return [];
      const r = rule(x.rule);
      return r ? [{ rule: r, why: code(x.why), trigger: num(x.trigger), stop: num(x.stop) }] : [];
    }),
    timeline: arr(raw.timeline).flatMap((x) => {
      if (!isObj(x)) return [];
      const t = stamp(x.t);
      const e = typeof x.event === "string" && /^[A-Za-z_]{1,40}$/.test(x.event) ? x.event : null;
      return t && e ? [{ t, event: e, code: code(x.code), why: code(x.why), symbol: symbol(x.symbol), r: num(x.r) }] : [];
    }),
    position: pos
      ? {
          symbol: symbol(pos.symbol),
          code: rule(pos.code) ?? code(pos.code),
          state: code(pos.state),
          origin: code(pos.origin),
          shares: count(pos.shares),
          soldAtTarget: count(pos.sold_at_target),
          entry: num(pos.entry),
          trigger: num(pos.trigger),
          stop: num(pos.stop),
          stop0: num(pos.stop0),
          target: num(pos.target),
        }
      : null,
    closed: arr(raw.closed).flatMap((x) =>
      isObj(x) ? [{ day: day(x.day), symbol: symbol(x.symbol), code: rule(x.code) ?? code(x.code), reason: code(x.reason), r: num(x.r), booked: bool(x.booked), h1: num(x.h1_r), h2: num(x.h2_r) }] : [],
    ),
    xLatched: arr(saf?.x_latched).filter((x): x is string => typeof x === "string" && /^X[1-9]$/.test(x)),
    stopRule: sr ? { decision: typeof sr.decision === "string" && /^DEC-\d{4}$/.test(sr.decision) ? sr.decision : null, trades: count(sr.trades), sumR: num(sr.sum_r), maxLossR: num(sr.max_loss_r), reviewAt: count(sr.review_at), stopDate: day(sr.stop_date) } : null,
    rotation: rot ? { names: count(rot.names), changes: count(rot.changes), live: bool(rot.live) === true, done: code(rot.done) } : null,
  };
}

// ---------------------------------------------------------------- the codes, in words

/** What each rule's minute says, as a state. Never what the rule looks for. */
export const RULE_WORDS: Readonly<Record<string, { words: string; tone: Tone }>> = {
  ok: { words: "Order ready", tone: "info" },
  waiting: { words: "Waiting for its window", tone: "neutral" },
  not_opened: { words: "Did not open", tone: "neutral" },
  no_level: { words: "No level today", tone: "neutral" },
  no_pattern: { words: "Nothing yet", tone: "neutral" },
  never_red: { words: "Nothing yet", tone: "neutral" },
  no_room: { words: "Not enough room to its target", tone: "neutral" },
  spent: { words: "Used for today", tone: "neutral" },
  closed: { words: "Window over", tone: "neutral" },
};

export const ruleWords = (why: string | null) => (why ? RULE_WORDS[why] ?? { words: why, tone: "neutral" as Tone } : { words: "No answer this minute", tone: "neutral" as Tone });

/** Why there was no pick. */
const PICK_WHY: Readonly<Record<string, string>> = {
  pool_missing: "the morning pool was not there",
  pool_unreadable: "the morning pool could not be read",
  pool_empty: "the morning pool was empty",
  pool_stale: "the morning pool was not today's",
  pool_changed: "the morning pool changed after it was read",
  selection_failed: "the selection failed",
  no_name_passed: "no name passed every filter",
  pm_bars_unreadable: "pre-market bars could not be read",
  pm_bars_stale: "pre-market bars were not today's",
};
export const pickWhy = (why: string | null) => (why ? PICK_WHY[why] ?? why : "no reason was sent");

/** Each journal row the timeline shows, as a plain sentence and a tone. */
const EVENT_WORDS: Readonly<Record<string, { words: string; tone: Tone }>> = {
  armed: { words: "Armed for the session", tone: "info" },
  refuse_to_arm: { words: "Armed with new entries off", tone: "warn" },
  gap_primary: { words: "Picked the day's name", tone: "info" },
  entry_placed: { words: "Entry order placed", tone: "info" },
  entry_not_placed: { words: "Entry order not placed", tone: "warn" },
  entry_cancelled: { words: "Entry order cancelled", tone: "neutral" },
  entry_filled: { words: "Entry filled", tone: "good" },
  partial_filled: { words: "Sold part at the first target", tone: "good" },
  exit_signal: { words: "Exit signal", tone: "info" },
  stop_moved: { words: "Stop moved", tone: "info" },
  stop_move_failed: { words: "Stop could not be moved", tone: "warn" },
  trade_closed: { words: "Trade closed", tone: "info" },
  signal_blocked: { words: "Signal blocked", tone: "warn" },
  data_timeout: { words: "Market data timed out", tone: "warn" },
  loop_error: { words: "A poll failed", tone: "warn" },
  protect_failed: { words: "Could not protect the position", tone: "bad" },
  unprotected: { words: "Position without a stop", tone: "bad" },
  execution_stop: { words: "Safety stop latched", tone: "bad" },
  adopted_orphan: { words: "Took over a position it found", tone: "warn" },
  gap_day_done: { words: "Done trading for the day", tone: "neutral" },
  kill_state: { words: "Kill switch changed", tone: "warn" },
  END_OF_DAY_NOT_FLAT: { words: "Not flat at the close", tone: "bad" },
  session_end: { words: "Session ended", tone: "neutral" },
};
const WHY_WORDS: Readonly<Record<string, string>> = {
  target: "first target",
  breakeven: "to break-even",
  stop: "stop",
  stop_under_market: "stop under the market",
  eod: "end of day",
  flatten: "end of day",
  bars_unread: "bars unreadable",
};
export const whyWords = (why: string | null) => (why ? WHY_WORDS[why] ?? why.replaceAll("_", " ") : null);

export function eventWords(r: Row): { words: string; tone: Tone } {
  const base = EVENT_WORDS[r.event] ?? { words: r.event.replaceAll("_", " "), tone: "neutral" as Tone };
  if (r.event === "trade_closed" && r.r !== null) return { words: base.words, tone: r.r > 0 ? "good" : r.r < 0 ? "bad" : "neutral" };
  return base;
}

const STATE_WORDS: Readonly<Record<string, string>> = { entry_working: "Order resting", in_position: "In a trade", exiting: "Exiting", flat: "Flat" };
const REASON_WORDS: Readonly<Record<string, string>> = { stop: "Stopped out", target: "At target", eod: "End of day", flatten: "End of day", exit_signal: "Exit signal", manual: "By hand" };
export const reasonWords = (r: string | null) => (r ? REASON_WORDS[r] ?? r.replaceAll("_", " ") : "Not sent");

// ---------------------------------------------------------------- the day

export interface Clock {
  /** New York date at `now`. */
  today: string;
  /** Minutes after midnight in New York. */
  minute: number;
  open: number | null;
  close: number | null;
  /** 08:30 New York to the close + 15: the minutes the host publishes this block every minute. */
  inWindow: boolean;
}

export function clockAt(now: Date): Clock {
  const { day: today, minute } = nyNow(now);
  const s = sessionOf(today);
  const inWindow = s.open !== null && s.close !== null && minute >= 8 * 60 + 30 && minute <= s.close + 15;
  return { today, minute, open: s.open, close: s.close, inWindow };
}

export type FreshState = "fresh" | "late" | "stopped" | "asleep" | "unknown";

export interface Freshness {
  state: FreshState;
  ageMin: number | null;
}

/** How old the copy is, judged against its own rhythm, and only in the minutes the host publishes it. */
export function freshnessOf(src: Source, now: Date): Freshness {
  const t = src.asOf ? Date.parse(src.asOf) : NaN;
  if (!Number.isFinite(t)) return { state: "unknown", ageMin: null };
  const ageMin = Math.max(0, (now.getTime() - t) / 60_000);
  if (!clockAt(now).inWindow) return { state: "asleep", ageMin };
  return { state: ageMin > src.lateAfterMin * 3 ? "stopped" : ageMin > src.lateAfterMin ? "late" : "fresh", ageMin };
}

// ---------------------------------------------------------------- now, in one sentence

export interface Hero {
  word: string;
  tone: Tone;
  line: string;
  /** The symbol the sentence is about, if any, shown large beside it. */
  symbol: string | null;
}

const px = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const rTxt = (v: number | null) => (v === null ? "?R" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`);
const isToday = (l: Live, c: Clock) => l.heartbeat?.session === c.today;
const holding = (p: Position | null) => p !== null && (p.state === "in_position" || p.state === "exiting");
const resting = (p: Position | null) => p !== null && p.state === "entry_working";
const minutesText = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** R of a price against the trade's first risk (entry less its first stop), or null when unknowable. */
export function rAt(p: Position, price: number | null): number | null {
  if (price === null || p.entry === null || p.stop0 === null) return null;
  const risk = p.entry - p.stop0;
  return risk > 0 ? (price - p.entry) / risk : null;
}

export function hero(l: Live | null, c: Clock): Hero {
  if (!l) return { word: "Not sent yet", tone: "neutral", line: "The host has not sent Gap Hunter's state to this site yet.", symbol: null };
  const today = isToday(l, c);
  const p = l.position;
  if (l.latched === true || l.xLatched.length > 0) {
    const what = l.xLatched.length > 0 ? ` (${l.xLatched.join(", ")})` : "";
    return { word: "Stopped by its safety rules", tone: "bad", line: `Its own limits${what} have stopped new entries. Open positions are still managed.`, symbol: p?.symbol ?? null };
  }
  if (holding(p)) {
    const parts = [`${p!.shares ?? "?"} shares`];
    if (p!.soldAtTarget) parts.push(`${p!.soldAtTarget} sold at the first target`);
    const line = `${parts.join(", ")} on ${p!.code ?? "its rule"}. Stop ${px(p!.stop)} (${rTxt(rAt(p!, p!.stop))} if hit), target ${px(p!.target)} (${rTxt(rAt(p!, p!.target))}).`;
    if (!today) return { word: "Holding from an earlier session", tone: "warn", line: `${line} It should have been flat by the close of ${l.heartbeat?.session ?? "its last session"}.`, symbol: p!.symbol };
    return { word: p!.state === "exiting" ? "Exiting its trade" : "In a trade", tone: "info", line, symbol: p!.symbol };
  }
  if (resting(p) && today) {
    return { word: "Order resting", tone: "info", line: `${p!.code ?? "A rule"}'s entry rests at ${px(p!.trigger)}, stop ${px(p!.stop)}. It fills only if the price reaches it.`, symbol: p!.symbol };
  }
  if (l.kill === true) return { word: "Kill switch on", tone: "warn", line: "No new entries until the switch is removed on the host. Exits are still managed.", symbol: null };
  const doneRow = l.timeline.some((r) => r.event === "gap_day_done" || r.event === "session_end");
  if (today && l.heartbeat?.ended !== true && !doneRow) {
    if (l.pick && l.pick.symbol) {
      const ready = l.rules.filter((r) => r.why === "ok").map((r) => r.rule);
      const line = ready.length > 0 ? `${ready.join(" and ")} ${ready.length === 1 ? "has" : "have"} an order ready. Nothing has filled yet.` : "No rule has an order this minute. It checks again every minute.";
      return { word: "Watching", tone: "info", line, symbol: l.pick.symbol };
    }
    if (l.pick) return { word: "No pick today", tone: "neutral", line: `No name was picked: ${pickWhy(l.pick.why)}. It places no order today.`, symbol: null };
    return { word: "Armed", tone: "info", line: "Armed and waiting for the morning pick.", symbol: null };
  }
  if (today) {
    const mine = l.closed.filter((x) => x.day === c.today);
    const sum = mine.reduce((a, x) => a + (x.r ?? 0), 0);
    return { word: "Done for the day", tone: "neutral", line: mine.length > 0 ? `${mine.length} trade${mine.length === 1 ? "" : "s"} today, ${rTxt(sum)} on paper. Flat.` : "No trade today. Flat.", symbol: null };
  }
  if (c.open !== null && c.minute < c.open) return { word: "Before the session", tone: "neutral", line: `It arms before the ${minutesText(c.open)} open New York. Last session: ${l.heartbeat?.session ?? "none yet"}.`, symbol: null };
  if (c.open !== null && c.close !== null && c.minute <= c.close) return { word: "Not armed today", tone: "warn", line: "The market is open and today's session has not armed. The alerts panel says why.", symbol: null };
  return { word: "Market closed", tone: "neutral", line: `Last session: ${l.heartbeat?.session ?? "none yet"}.`, symbol: null };
}

// ---------------------------------------------------------------- the day rail

const first = (rows: Row[], ...events: string[]) => rows.find((r) => events.includes(r.event)) ?? null;

/** The session's steps in order: armed, pick, order, fill, managing, closed, done. Times are New York. */
export function dayRail(l: Live | null, timeNy: (iso: string) => string): RailStep[] {
  const rows = l?.timeline ?? [];
  const at = (r: Row | null) => (r ? timeNy(r.t) : undefined);
  const armed = first(rows, "armed", "refuse_to_arm");
  const pick = first(rows, "gap_primary");
  const placed = first(rows, "entry_placed");
  const filled = first(rows, "entry_filled", "adopted_orphan");
  const managed = first(rows, "partial_filled", "stop_moved", "exit_signal");
  const closed = first(rows, "trade_closed");
  const done = first(rows, "session_end", "gap_day_done");
  const noPick = l?.pick !== null && l?.pick !== undefined && l.pick.symbol === null;
  const s = (key: string, label: string, row: Row | null, after: boolean, skip = false): RailStep =>
    row ? { key, label, state: "done", detail: at(row) } : skip ? { key, label, state: "failed", words: "None" } : { key, label, state: after ? "current" : "todo" };
  const ended = done !== null;
  return [
    s("armed", "Armed", armed, true),
    s("pick", "Pick", pick, armed !== null, noPick),
    s("order", "Order", placed, pick !== null && !ended, ended && !placed),
    s("filled", "Fill", filled, placed !== null && !ended, ended && placed !== null && !filled),
    s("managing", "Manage", managed, filled !== null && !closed),
    s("closed", "Close", closed, filled !== null && !ended),
    s("done", "End", done, false),
  ].map((x, i, all) => (x.state === "current" && all.slice(0, i).some((y) => y.state === "current") ? { ...x, state: "todo" } : x));
}

// ---------------------------------------------------------------- the position, as a price ladder

export interface Rung {
  key: string;
  label: string;
  price: number;
  r: number | null;
  tone: Tone;
}

export function ladder(p: Position | null): Rung[] {
  if (!p) return [];
  const rungs: Rung[] = [];
  const add = (key: string, label: string, price: number | null, tone: Tone) => {
    if (price !== null) rungs.push({ key, label, price, r: rAt(p, price), tone });
  };
  add("target", "First target", p.target, "good");
  if (p.state === "entry_working") add("trigger", "Entry order", p.trigger, "info");
  else add("entry", "Entry", p.entry, "info");
  add("stop", p.stop !== null && p.stop0 !== null && p.stop !== p.stop0 ? "Stop now" : "Stop", p.stop, "bad");
  if (p.stop !== null && p.stop0 !== null && p.stop !== p.stop0) add("stop0", "First stop", p.stop0, "neutral");
  return rungs.sort((a, b) => b.price - a.price);
}

export const stateWords = (s: string | null) => (s ? STATE_WORDS[s] ?? s.replaceAll("_", " ") : "Not sent");

// ---------------------------------------------------------------- orders, from the timeline

export interface OrderRow {
  t: string;
  what: string;
  tone: Tone;
  symbol: string | null;
  code: string | null;
  why: string | null;
  r: number | null;
}

const ORDER_EVENTS = new Set(["entry_placed", "entry_not_placed", "entry_cancelled", "entry_filled", "partial_filled", "stop_moved", "stop_move_failed", "signal_blocked", "trade_closed"]);

export function orders(l: Live | null): OrderRow[] {
  return (l?.timeline ?? [])
    .filter((r) => ORDER_EVENTS.has(r.event))
    .map((r) => ({ t: r.t, what: eventWords(r).words, tone: eventWords(r).tone, symbol: r.symbol, code: r.code, why: whyWords(r.why), r: r.r }));
}

// ---------------------------------------------------------------- results

export interface Results {
  trades: number;
  sumR: number;
  sumH1: number | null;
  sumH2: number | null;
  wins: number;
}

/** Booked trades only (the stop rule's count); the haircut totals only when every trade has one. */
export function results(l: Live | null): Results {
  const b = (l?.closed ?? []).filter((x) => x.booked !== false && x.r !== null);
  const sum = (f: (x: Closed) => number | null) => (b.every((x) => f(x) !== null) ? b.reduce((a, x) => a + (f(x) ?? 0), 0) : null);
  return { trades: b.length, sumR: b.reduce((a, x) => a + (x.r ?? 0), 0), sumH1: b.length ? sum((x) => x.h1) : null, sumH2: b.length ? sum((x) => x.h2) : null, wins: b.filter((x) => (x.r ?? 0) > 0).length };
}

/** How far the stop rule's count and loss have gone, each as a share of its limit (0 to 1), or null. */
export function stopRuleProgress(sr: StopRule | null): { trades: number | null; loss: number | null } {
  if (!sr) return { trades: null, loss: null };
  const trades = sr.trades !== null && sr.reviewAt ? Math.min(1, sr.trades / sr.reviewAt) : null;
  const loss = sr.sumR !== null && sr.maxLossR !== null && sr.maxLossR < 0 ? Math.min(1, Math.max(0, sr.sumR / sr.maxLossR)) : null;
  return { trades, loss };
}
