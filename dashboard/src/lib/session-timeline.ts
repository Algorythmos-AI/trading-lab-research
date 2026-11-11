// The Options page's status rail, its pure parts: the session's no-entry windows as a thin bar from the open to the
// close, the clock's next boundary in words ("First entries in 3:12", "Lunch block 11:30–13:00 in 14 min"), and the
// day's limits in one short line ("Clear · 0/5 trades · $0 of $100").
//
// Every minute is the engine's own (trade-state's FIRST_ENTRY_MIN, the lunch block, the flat time, options' OPEN_MIN
// and closeMinute), so the rail can never say a window the board does not keep. All times are New York. Pure: no I/O
// and no clock; the caller passes `now` (the board's server clock).
import { newYork, weekDate } from "./format";
import { journalStale } from "./journal";
import { openPositions, tradeCount } from "./manage-stop";
import type { Lot } from "./journal";
import { sessionOf } from "./market-calendar";
import { closeMinute, nyClock, OPEN_MIN } from "./options";
import { DAY_LOSS_LIMIT, type DayCheck, journalCurrent, MAX_TRADES_PER_DAY } from "./trade-rules";
import { FIRST_ENTRY_MIN, flatMinute, LUNCH_FROM_MIN, LUNCH_TO_MIN, lunchBlock } from "./trade-state";
import type { Tone } from "./labels";
import { dayRoom } from "./what-if";

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ---- the bar -------------------------------------------------------------------------------------------------------
export type WindowKind = "opening" | "lunch" | "flat";

export interface TimelineWindow {
  kind: WindowKind;
  /** Minutes after New York midnight. */
  from: number;
  to: number;
  /** "09:30–09:35" */
  label: string;
  /** Where it sits on the bar, in % of the session from the open. */
  left: number;
  width: number;
}

export interface Timeline {
  open: number;
  close: number;
  /** The session's no-entry windows, in time order. */
  windows: TimelineWindow[];
  /** The "now" tick in % of the session, or null outside it (or on another day). */
  now: number | null;
  /** The hour marks between the open and the close, for light ticks under the bar. */
  hours: { minute: number; at: number }[];
}

const pct = (m: number, open: number, close: number) => Math.round(((m - open) / (close - open)) * 10_000) / 100;

/**
 * The session as a bar: 09:30 to 16:00 (13:00 on a half day), with the windows where the engine allows no new entry:
 * the opening range to the first entry, the lunch block on a full day, and from the flat time to the close.
 * `minute` is the New York minute (with its fraction) on the session day, or null on another day.
 */
export function sessionTimeline(halfDay: boolean, minute: number | null): Timeline {
  const open = OPEN_MIN;
  const close = closeMinute(halfDay);
  const flat = flatMinute(halfDay);
  const raw: { kind: WindowKind; from: number; to: number }[] = [{ kind: "opening", from: open, to: FIRST_ENTRY_MIN }];
  if (lunchBlock(halfDay)) raw.push({ kind: "lunch", from: LUNCH_FROM_MIN, to: LUNCH_TO_MIN });
  raw.push({ kind: "flat", from: flat, to: close });
  const windows = raw.map((w) => {
    const left = pct(w.from, open, close);
    return { ...w, label: `${hhmm(w.from)}–${hhmm(w.to)}`, left, width: Math.round((pct(w.to, open, close) - left) * 100) / 100 };
  });
  const now = minute !== null && minute >= open && minute <= close ? pct(minute, open, close) : null;
  const hours: Timeline["hours"] = [];
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push({ minute: m, at: pct(m, open, close) });
  return { open, close, windows, now, hours };
}

// ---- the clock -----------------------------------------------------------------------------------------------------
export type ClockPhase = "next" | "before" | "opening" | "open" | "lunch" | "flat" | "closed";

export interface SessionClock {
  phase: ClockPhase;
  /** One line: what comes next and when. */
  line: string;
  /** New entries are allowed now, by the clock alone (the board's states still decide). */
  entries: boolean;
  /** The New York minute with its fraction on the day the clock is worked for, or null on another day: the timeline's now. */
  minute: number | null;
  /** The day's half-day answer the clock was worked with: the edition's, or today's calendar for an older card. */
  halfDay: boolean;
}

/** A countdown in words: "3:12" under ten minutes, "14 min" under an hour, then "1 h 05 min". */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * Where the clock stands against the edition's session, and the next boundary: before the open, "Opens 09:30 · first
 * entries 09:35"; in the opening range, "First entries in 3:12"; before lunch, "Lunch block 11:30–13:00 in 14 min";
 * in it, "No new entries until 13:00"; to the flat time, "New entries end 15:10 in 1 h 20 min"; after it,
 * "No new entries · close 16:00 in 42 min"; then "Closed". A half day closes at 13:00 with no lunch block.
 *
 * With an older focus card (the edition's session before today) the clock is worked for today's New York trading day
 * from the market calendar, with today's own half day: the market is open even though the card is old, and the rail
 * must never say "Closed" at 10:30. A weekend or holiday is "Closed"; a day the calendar does not cover says "Old focus
 * card" rather than guess a session state.
 */
export function sessionClock(session: string, halfDay: boolean, nowMs: number): SessionClock {
  const c = nyClock(new Date(nowMs).toISOString());
  if (!c) return { phase: "closed", line: "Closed", entries: false, minute: null, halfDay };
  if (session > c.day)
    return { phase: "next", line: `Next session ${weekDate(session)} · opens ${hhmm(OPEN_MIN)} · first entries ${hhmm(FIRST_ENTRY_MIN)}`, entries: false, minute: null, halfDay };
  if (session < c.day) {
    const today = sessionOf(c.day);
    if (today.kind === "open" || today.kind === "half") return dayClock(c.minutes, nowMs, today.kind === "half");
    if (today.kind === "out_of_range") return { phase: "closed", line: "Old focus card", entries: false, minute: null, halfDay };
    return { phase: "closed", line: "Closed", entries: false, minute: null, halfDay };
  }
  return dayClock(c.minutes, nowMs, halfDay);
}

/** The clock on a trading day, at New York's whole `minutes` and the instant's own seconds. */
function dayClock(minutes: number, nowMs: number, halfDay: boolean): SessionClock {
  const first = `first entries ${hhmm(FIRST_ENTRY_MIN)}`;
  // nyClock gives whole minutes; New York is a whole number of hours from UTC, so the seconds are the instant's own.
  const sec = Math.floor(nowMs / 1000) % 60;
  const minute = minutes + sec / 60;
  // In whole seconds, so a countdown never reads a second long from a rounding error.
  const until = (m: number) => m * 60 - (minutes * 60 + sec);
  const close = closeMinute(halfDay);
  const flat = flatMinute(halfDay);
  const at = (phase: ClockPhase, line: string, entries: boolean): SessionClock => ({ phase, line, entries, minute, halfDay });
  if (minute < OPEN_MIN) return at("before", `Opens ${hhmm(OPEN_MIN)} in ${countdown(until(OPEN_MIN))} · ${first}`, false);
  if (minute < FIRST_ENTRY_MIN) return at("opening", `First entries in ${countdown(until(FIRST_ENTRY_MIN))}`, false);
  if (minute >= close) return at("closed", "Closed", false);
  if (minute >= flat) return at("flat", `No new entries · close ${hhmm(close)} in ${countdown(until(close))}`, false);
  if (lunchBlock(halfDay)) {
    if (minute < LUNCH_FROM_MIN) return at("open", `Lunch block ${hhmm(LUNCH_FROM_MIN)}–${hhmm(LUNCH_TO_MIN)} in ${countdown(until(LUNCH_FROM_MIN))}`, true);
    if (minute < LUNCH_TO_MIN) return at("lunch", `No new entries until ${hhmm(LUNCH_TO_MIN)}`, false);
  }
  return at("open", `New entries end ${hhmm(flat)} in ${countdown(until(flat))}`, true);
}

// ---- the day's limits ----------------------------------------------------------------------------------------------
export interface RailDay {
  word: string;
  tone: Tone;
  /** "Clear · 0/5 trades · $0 of $100" */
  line: string;
  /** The open positions' caution (rule 7 counts their open loss), or null. */
  open: string | null;
  /** "A stop now leaves $50 of $100 and 4 trades" (what-if's dayRoom), or null when it cannot be said. */
  room: string | null;
  /** "2 journal rows could not be read: …" (unreadLine), or null when every row was read. */
  unread?: string | null;
}

/** The rail's warning when rows of the journal could not be read (readableJournal's `skipped`); null with none. */
export function unreadLine(skipped: number): string | null {
  if (!(skipped > 0)) return null;
  return `${skipped} journal row${skipped === 1 ? "" : "s"} could not be read: today's count and loss may be short; check Webull.`;
}

/**
 * The day check with rows of the journal left out: it cannot be judged, exactly as a journal that is not current, so
 * the room and the trades left (rail, hero, manage card) are withheld wherever they show.
 */
export function withUnread<C extends { current: boolean }>(c: C, skipped: number): C {
  return skipped > 0 ? { ...c, current: false } : c;
}

const DAY_WORD: Record<DayCheck["status"], { word: string; tone: Tone }> = {
  clear: { word: "Clear", tone: "good" },
  careful: { word: "Careful", tone: "warn" },
  stop: { word: "Stop for today", tone: "bad" },
  unknown: { word: "Journal not current", tone: "warn" },
};

/** The day's limits in one short line, from the server's dayCheck: the same words and tones as the day bar. */
export function railDay(c: Pick<DayCheck, "status" | "isToday" | "current" | "used" | "net" | "openLine">): RailDay {
  const s = DAY_WORD[c.status];
  const word = c.isToday || !c.current ? s.word : "New day";
  const loss = Math.max(0, -c.net);
  return {
    word,
    tone: s.tone,
    line: `${word} · ${c.used}/${MAX_TRADES_PER_DAY} trades · $${loss.toFixed(0)} of $${DAY_LOSS_LIMIT}`,
    open: c.openLine ? c.openLine : null,
    room: dayRoom(c),
  };
}

// ---- the day's facts for the browser --------------------------------------------------------------------------------
/**
 * What the browser needs of the server's day check to count its own notes and to say the room after a stop: the
 * journal's count and closed result, whether it can be judged now (the day check's `current`, and never a journal that
 * is journalStale), and when the fills were last read from the broker.
 */
export interface DayFacts {
  status: DayCheck["status"];
  isToday: boolean;
  used: number;
  net: number;
  current: boolean;
  /** "Fills read 10:21 New York" (with the day when not read today), or null with no read time. */
  readLine: string | null;
  /** The same, shorter, for the phone's rail: "Fills read 10:21 NY", "Fills read 17:05 NY, Fri 16 Oct". */
  readShort: string | null;
  /** When the fills were read, for the browser's own re-check of `current` (journalLive). */
  asOf: string | null;
  /** The journal's open positions, one per contract held, any name and any day. */
  openLots: number;
}

export function dayFacts(
  c: Pick<DayCheck, "status" | "isToday" | "current" | "used" | "net">,
  asOf: string | null | undefined,
  now: Date,
  lots: readonly Lot[] = [],
): DayFacts {
  const read = asOf && Number.isFinite(Date.parse(asOf)) ? asOf : null;
  const sameDay = read !== null && nyClock(read)?.day === nyClock(now.toISOString())?.day;
  return {
    status: c.status,
    isToday: c.isToday,
    used: c.used,
    net: c.net,
    current: c.current && read !== null && !journalStale({ as_of: read }, now),
    readLine: read ? `Fills read ${newYork(read, !sameDay)} New York` : null,
    readShort: read ? readShortLine(read, sameDay) : null,
    asOf: read,
    openLots: openPositions(lots).length,
  };
}

/** "Fills read 10:21 NY", or with the New York day when the read was not today: "Fills read 17:05 NY, Fri 16 Oct". */
export function readShortLine(read: string, sameDay: boolean): string {
  const day = sameDay ? null : nyClock(read)?.day;
  return `Fills read ${newYork(read, false)} NY${day ? `, ${weekDate(day)}` : ""}`;
}

/**
 * Whether the journal can still be judged now, on the browser's own clock (`nowMs`): the server's verdict when the
 * page was drawn, and the same test again since (journalCurrent, journalStale). A phone that stops refreshing loses it
 * once the read is too old. Null `nowMs` (before mount) keeps the server's verdict.
 */
export function journalLive(facts: Pick<DayFacts, "current" | "asOf"> | null | undefined, nowMs: number | null): boolean {
  if (!facts || !facts.current || !facts.asOf) return false;
  if (nowMs === null) return true;
  const now = new Date(nowMs);
  return journalCurrent(facts.asOf, now) && !journalStale({ as_of: facts.asOf }, now);
}

export type RailWithNotes = RailDay & {
  /** "1 not yet in the journal", or null. */
  notes: string | null;
  /** The plain line once the count with the notes reaches the cap, or null. */
  usedUp: string | null;
};

/**
 * The rail's day with this browser's notes that the journal does not show yet: they add to the count, so they can
 * only make it more cautious, never less. With none, the server's line as it is. At the cap with them, the word says
 * the day's trades are used up (his own count, his own rule); one short of it, a clear day reads careful.
 */
export function railWithNotes(day: RailDay, facts: Pick<DayFacts, "used" | "net" | "status">, provisional: number): RailWithNotes {
  const n = tradeCount(facts.used, provisional);
  if (n.provisional === 0) return { ...day, notes: null, usedUp: null };
  const already = facts.status === "stop";
  const careful = !already && !n.usedUp && n.total >= MAX_TRADES_PER_DAY - 1 && day.tone === "good";
  const word = already ? day.word : n.usedUp ? "Trades used up" : careful ? "Careful" : day.word === "New day" ? "Clear" : day.word;
  const tone: Tone = already || n.usedUp ? "bad" : careful ? "warn" : day.tone;
  const loss = Math.max(0, -facts.net);
  return {
    ...day,
    word,
    tone,
    line: `${word} · ${n.total}/${MAX_TRADES_PER_DAY} trades · $${loss.toFixed(0)} of $${DAY_LOSS_LIMIT} · ${n.note}`,
    // The server's "a stop now leaves … and N trades" counted without these: never shown beside them.
    room: null,
    notes: n.note,
    usedUp: n.usedUpLine,
  };
}
