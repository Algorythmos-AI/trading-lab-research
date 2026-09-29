// Shared by the server (health, watchdog) and the header pill in the browser. Pure: no I/O, no clock.
import type { ExpectedWindow } from "./types";

export const LATE_MIN = 35;
export const STOPPED_MIN = 90;
export const OFFLINE_HOURS = 48;

export type FreshState = "fresh" | "late" | "stopped" | "asleep" | "unknown";

export interface Freshness {
  state: FreshState;
  /** Minutes since the snapshot's as_of (never negative), or null when as_of is missing. */
  ageMin: number | null;
  inWindow: boolean;
  window: ExpectedWindow | null;
  /** True when every expected window has ended (or none were announced). */
  allWindowsEnded: boolean;
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

export function freshness(
  asOf: string | null | undefined,
  windows: readonly (ExpectedWindow | null | undefined)[] | null | undefined,
  nowMs: number,
): Freshness {
  const t = parseTime(asOf);
  const window = activeWindow(windows, nowMs);
  const inWindow = window !== null;
  const ended = allWindowsEnded(windows, nowMs);
  if (t === null) return { state: "unknown", ageMin: null, inWindow, window, allWindowsEnded: ended };
  const ageMin = Math.max(0, (nowMs - t) / 60_000);
  let state: FreshState = "fresh";
  if (ageMin > LATE_MIN) {
    if (!inWindow) state = "asleep";
    else state = ageMin > STOPPED_MIN ? "stopped" : "late";
  }
  return { state, ageMin, inWindow, window, allWindowsEnded: ended };
}

export function describeAge(ageMin: number): string {
  const m = Math.floor(ageMin);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}
