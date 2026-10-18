// Whether each of the owner's own feeds published when it should have. Pure: no I/O, the clock is passed in.
// Only what the stored editions say is used here: their `as_of` stamps and the dates on file. The schedules are the
// routines' own (Webull sync, options after-close, radar outbox send); a US holiday can show a feed as late.
import { etOffsetMin } from "./freshness";

export type FeedState = "ok" | "due" | "late" | "missing" | "error" | "info";

export interface FeedCheck {
  state: FeedState;
  /** The newest time the feed should have published by, or null when it has no fixed time. */
  lastDue: string | null;
  /** The next scheduled time, or null when it has no fixed time. */
  nextDue: string | null;
}

/** Minutes a run may take after its slot before the feed counts as late. */
export const DAILY_GRACE_MIN = 60;
/** How old the trade journal may get during US market hours: the sync publishes on change and every 30 minutes. */
export const INTRADAY_MAX_AGE_MIN = 45;

const DAY_MS = 86_400_000;
const isWeekday = (ms: number) => {
  const d = new Date(ms).getUTCDay();
  return d >= 1 && d <= 5;
};

/** The slot `hh:mm` UTC on UTC weekdays: the latest at or before `nowMs`, and the first after it. */
export function weekdaySlots(nowMs: number, utcMinute: number): { last: number; next: number } {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  let last = midnight + utcMinute * 60_000;
  if (last > nowMs) last -= DAY_MS;
  while (!isWeekday(last)) last -= DAY_MS;
  let next = last + DAY_MS;
  while (!isWeekday(next) || next <= nowMs) next += DAY_MS;
  return { last, next };
}

/** A feed that publishes once a weekday at `utcMinute`. Late once the slot plus the grace has passed without a newer stamp. */
export function dailyCheck(asOf: string | null | undefined, nowMs: number, utcMinute: number, graceMin = DAILY_GRACE_MIN): FeedCheck {
  const { last, next } = weekdaySlots(nowMs, utcMinute);
  const t = typeof asOf === "string" ? Date.parse(asOf) : NaN;
  const out = { lastDue: new Date(last).toISOString(), nextDue: new Date(next).toISOString() };
  // A run may stamp a little before its slot (it starts early, or the routine fired early): an hour of slack.
  if (Number.isFinite(t) && t >= last - 60 * 60_000) return { state: "ok", ...out };
  if (nowMs < last + graceMin * 60_000) {
    // This slot is still running; the feed is fine as long as the previous one landed.
    const prev = weekdaySlots(last - 1, utcMinute).last;
    return { state: Number.isFinite(t) && t >= prev - 60 * 60_000 ? "due" : "late", ...out };
  }
  return { state: "late", ...out };
}

/** True during the US regular session (09:30 to 16:00 New York) on a New York weekday. */
export function inUsSession(nowMs: number): boolean {
  const wall = new Date(nowMs + etOffsetMin(nowMs) * 60_000);
  const dow = wall.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return m >= 9 * 60 + 30 && m <= 16 * 60;
}

/** The Webull trade journal: every few minutes in US market hours, and the evening sync at 21:38 UTC on weekdays. */
export const JOURNAL_SLOT_UTC = 21 * 60 + 38;
export function journalCheck(asOf: string | null | undefined, nowMs: number): FeedCheck {
  const daily = dailyCheck(asOf, nowMs, JOURNAL_SLOT_UTC);
  if (!inUsSession(nowMs)) return daily;
  const t = typeof asOf === "string" ? Date.parse(asOf) : NaN;
  // The first half hour of the session gives the sync its first heartbeat.
  const sessionAge = (() => {
    const wall = new Date(nowMs + etOffsetMin(nowMs) * 60_000);
    return wall.getUTCHours() * 60 + wall.getUTCMinutes() - (9 * 60 + 30);
  })();
  const ageMin = Number.isFinite(t) ? (nowMs - t) / 60_000 : Infinity;
  if (ageMin <= INTRADAY_MAX_AGE_MIN || sessionAge < INTRADAY_MAX_AGE_MIN) return { ...daily, state: "ok" };
  return { ...daily, state: "late" };
}

/** The options levels: built after each close, 21:52 UTC on weekdays. */
export const OPTIONS_SLOT_UTC = 21 * 60 + 52;
/** The radar edition: the outbox send at 11:12 UTC on weekdays. */
export const RADAR_SLOT_UTC = 11 * 60 + 12;

/** The last `n` UTC weekdays up to and including the day of `nowMs`, oldest first, as YYYY-MM-DD. */
export function lastWeekdays(nowMs: number, n: number): string[] {
  const out: string[] = [];
  for (let d = Math.floor(nowMs / DAY_MS) * DAY_MS; out.length < n; d -= DAY_MS) {
    if (isWeekday(d)) out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out.reverse();
}
