// The Options page's status rail, its pure parts: the session's no-entry windows as a thin bar from the open to the
// close, the clock's next boundary in words ("First entries in 3:12", "Lunch block 11:30–13:00 in 14 min"), and the
// day's limits in one short line ("Clear · 0/5 trades · $0 of $100").
//
// Every minute is the engine's own (trade-state's FIRST_ENTRY_MIN, the lunch block, the flat time, options' OPEN_MIN
// and closeMinute), so the rail can never say a window the board does not keep. All times are New York. Pure: no I/O
// and no clock; the caller passes `now` (the board's server clock).
import { weekDate } from "./format";
import { closeMinute, nyClock, OPEN_MIN } from "./options";
import { DAY_LOSS_LIMIT, type DayCheck, MAX_TRADES_PER_DAY } from "./trade-rules";
import { FIRST_ENTRY_MIN, flatMinute, LUNCH_FROM_MIN, LUNCH_TO_MIN, lunchBlock } from "./trade-state";
import type { Tone } from "./labels";

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
  /** The New York minute with its fraction on the session day, or null on another day: the timeline's now. */
  minute: number | null;
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
 */
export function sessionClock(session: string, halfDay: boolean, nowMs: number): SessionClock {
  const c = nyClock(new Date(nowMs).toISOString());
  const first = `first entries ${hhmm(FIRST_ENTRY_MIN)}`;
  if (!c) return { phase: "closed", line: "Closed", entries: false, minute: null };
  if (session > c.day) return { phase: "next", line: `Next session ${weekDate(session)} · opens ${hhmm(OPEN_MIN)} · ${first}`, entries: false, minute: null };
  if (session < c.day) return { phase: "closed", line: "Closed", entries: false, minute: null };
  // nyClock gives whole minutes; New York is a whole number of hours from UTC, so the seconds are the instant's own.
  const sec = Math.floor(nowMs / 1000) % 60;
  const minute = c.minutes + sec / 60;
  // In whole seconds, so a countdown never reads a second long from a rounding error.
  const until = (m: number) => m * 60 - (c.minutes * 60 + sec);
  const close = closeMinute(halfDay);
  const flat = flatMinute(halfDay);
  if (minute < OPEN_MIN) return { phase: "before", line: `Opens ${hhmm(OPEN_MIN)} in ${countdown(until(OPEN_MIN))} · ${first}`, entries: false, minute };
  if (minute < FIRST_ENTRY_MIN) return { phase: "opening", line: `First entries in ${countdown(until(FIRST_ENTRY_MIN))}`, entries: false, minute };
  if (minute >= close) return { phase: "closed", line: "Closed", entries: false, minute };
  if (minute >= flat) return { phase: "flat", line: `No new entries · close ${hhmm(close)} in ${countdown(until(close))}`, entries: false, minute };
  if (lunchBlock(halfDay)) {
    if (minute < LUNCH_FROM_MIN)
      return { phase: "open", line: `Lunch block ${hhmm(LUNCH_FROM_MIN)}–${hhmm(LUNCH_TO_MIN)} in ${countdown(until(LUNCH_FROM_MIN))}`, entries: true, minute };
    if (minute < LUNCH_TO_MIN) return { phase: "lunch", line: `No new entries until ${hhmm(LUNCH_TO_MIN)}`, entries: false, minute };
  }
  return { phase: "open", line: `New entries end ${hhmm(flat)} in ${countdown(until(flat))}`, entries: true, minute };
}

// ---- the day's limits ----------------------------------------------------------------------------------------------
export interface RailDay {
  word: string;
  tone: Tone;
  /** "Clear · 0/5 trades · $0 of $100" */
  line: string;
  /** The open positions' caution (rule 7 counts their open loss), or null. */
  open: string | null;
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
  };
}
