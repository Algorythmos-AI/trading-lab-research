// Shared by the server (health, watchdog) and the header pill in the browser. Pure: no I/O, no clock.
import type { ExpectedWindow } from "./types";

export const LATE_MIN = 35;
export const STOPPED_MIN = 90;
export const OFFLINE_HOURS = 48;
/** Assumed window on ET weekdays once the host's published windows have run out: 07:30 ET (the routine starts)
 * to 18:00 ET (the 16:00 close + 2 h). */
export const ASSUMED_START_ET_MIN = 7 * 60 + 30;
export const ASSUMED_END_ET_MIN = 18 * 60;

export type FreshState = "fresh" | "late" | "stopped" | "asleep" | "unknown";

export interface Freshness {
  state: FreshState;
  /** Minutes since the snapshot's as_of (never negative), or null when as_of is missing. */
  ageMin: number | null;
  inWindow: boolean;
  window: ExpectedWindow | null;
  /** True when every expected window has ended (or none were announced). */
  allWindowsEnded: boolean;
  /** True when `window` is an assumed ET weekday window, not one the host published. */
  assumed: boolean;
}

export function parseTime(s: string | null | undefined): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function activeWindow(
  windows: readonly (ExpectedWindow | null | undefined)[] | null | undefined,
  nowMs: number,
): ExpectedWindow | null {
  for (const w of windows ?? []) {
    const start = parseTime(w?.start);
    const end = parseTime(w?.end);
    if (w && start !== null && end !== null && start <= nowMs && nowMs <= end) return w;
  }
  return null;
}

export function allWindowsEnded(
  windows: readonly (ExpectedWindow | null | undefined)[] | null | undefined,
  nowMs: number,
): boolean {
  return (windows ?? []).every((w) => {
    const end = parseTime(w?.end);
    return end === null || end < nowMs;
  });
}

/** America/New_York's UTC offset in minutes at `ms` (e.g. -240), or null without time-zone data. */
export function etOffsetMin(ms: number): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
      .formatToParts(new Date(ms))
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? "");
    if (!m) return null;
    const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === "-" ? -v : v;
  } catch {
    return null;
  }
}

/**
 * The window a trading host would be expected in on an ET weekday, used only after every published window has
 * ended: a host silent for longer than its published horizon must still page on trading days (plan R8).
 * Holidays can't be known here, so a long outage may also page on one. US clocks change on Sundays at 02:00,
 * so the offset is constant through any weekday window.
 */
export function assumedWindow(nowMs: number): ExpectedWindow | null {
  const off = etOffsetMin(nowMs);
  if (off === null) return null;
  const wall = new Date(nowMs + off * 60_000); // its UTC fields read as New York wall time
  const dow = wall.getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const mins = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  if (mins < ASSUMED_START_ET_MIN || mins > ASSUMED_END_ET_MIN) return null;
  const ymd = wall.toISOString().slice(0, 10);
  const midnightUtc = Date.parse(`${ymd}T00:00:00Z`) - off * 60_000;
  return {
    session: ymd,
    start: new Date(midnightUtc + ASSUMED_START_ET_MIN * 60_000).toISOString(),
    end: new Date(midnightUtc + ASSUMED_END_ET_MIN * 60_000).toISOString(),
  };
}

export function freshness(
  asOf: string | null | undefined,
  windows: readonly (ExpectedWindow | null | undefined)[] | null | undefined,
  nowMs: number,
): Freshness {
  const t = parseTime(asOf);
  const published = activeWindow(windows, nowMs);
  const ended = allWindowsEnded(windows, nowMs);
  const fallback = published === null && ended ? assumedWindow(nowMs) : null;
  const window = published ?? fallback;
  const inWindow = window !== null;
  const assumed = fallback !== null;
  if (t === null) return { state: "unknown", ageMin: null, inWindow, window, allWindowsEnded: ended, assumed };
  const ageMin = Math.max(0, (nowMs - t) / 60_000);
  let state: FreshState = "fresh";
  if (ageMin > LATE_MIN) {
    if (!inWindow) state = "asleep";
    else state = ageMin > STOPPED_MIN ? "stopped" : "late";
  }
  return { state, ageMin, inWindow, window, allWindowsEnded: ended, assumed };
}

export function describeAge(ageMin: number): string {
  const m = Math.floor(ageMin);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}
