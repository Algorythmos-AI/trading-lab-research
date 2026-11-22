// Display-only checks that say when what a page shows is not today's: the Radar before the open, and the Options
// focus card against the board's session. Pure: no I/O, the clock is passed in.
//
// Kept apart on purpose: this file is outside the desk engine's and the signal's import closures (ENGINE_VERSION,
// SIGNAL_CODE_HASH). It reads from those modules and nothing there reads it, so no label moves when it changes.
import { addDays, nyNow, sessionOf } from "./market-calendar";
import { nyClock, OPEN_MIN, editionState } from "./options";

const isSession = (day: string): boolean => {
  const k = sessionOf(day).kind;
  return k === "open" || k === "half";
};

/**
 * Before 09:30 New York on a session day, with an edition from an earlier day on show: that morning's Radar has not
 * published yet (it builds about 05:30). From 09:30 the page's red notice (radarStale) takes over, so this is false
 * then. False on a weekend or a holiday, where the last session's edition is the right one to show.
 */
export function radarNotTodayYet(editionDate: string, now: Date): boolean {
  const { day, minute } = nyNow(now);
  if (!isSession(day)) return false;
  return editionDate < day && minute < OPEN_MIN;
}

/**
 * The session a focus pick was made for: the New York day it was picked on when that is a session and the pick came
 * before its open, otherwise the next session after it (an evening pick is for the next day). Null when the time
 * cannot be read or no session is found within two weeks (past the calendar's end).
 */
export function pickedForSession(pickedAt: string | null | undefined): string | null {
  if (!pickedAt) return null;
  const c = nyClock(pickedAt);
  if (!c) return null;
  if (isSession(c.day) && c.minutes < OPEN_MIN) return c.day;
  let d = c.day;
  for (let i = 0; i < 14; i++) {
    d = addDays(d, 1);
    if (isSession(d)) return d;
  }
  return null;
}

export type FocusStaleness = { kind: "other_session"; pickedFor: string } | { kind: "stale_edition" };

/**
 * Why the focus card may not be this session's, or null when it is. `live` is false when an older edition was
 * opened on purpose: the edition being from an earlier day is then expected, and only a pick made for a different
 * session than the edition's is said.
 */
export function focusStaleness(pickedAt: string | null | undefined, session: string, now: Date, live: boolean): FocusStaleness | null {
  const pickedFor = pickedForSession(pickedAt);
  if (pickedFor !== null && pickedFor !== session) return { kind: "other_session", pickedFor };
  if (live && editionState(session, now) === "stale") return { kind: "stale_edition" };
  return null;
}
