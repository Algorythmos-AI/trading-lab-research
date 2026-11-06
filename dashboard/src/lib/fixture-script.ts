// Fixture only: the `quotes-script` price path. A fixed walk through one morning of the fixture's session, so the
// browser tests and the design screenshots can show every state of the "Trade now" board with no network. Synthetic
// numbers; nothing here is market data. Pure: no I/O and no clock (the caller passes the step).
//
// Five steps, each a New York time on the fixture's session:
//   0 09:45  the opening range is forming
//   1 10:10  QQQ and SPY watch their ceilings; AAPL sits in the middle of yesterday's range
//   2 10:22:30  QQQ has broken its ceiling and waits for a dip; SPY is above its ceiling with no 2-min close yet
//   3 10:28:30  QQQ's dip held inside the retest window (enter zone, with SMH below its VWAP against calls); SPY fell
//               back (plan off, with a live failed break)
//   4 10:41  QQQ ran past target 1 without you (missed); SPY's failed break has expired
// AAPL stays in the middle third of yesterday's range throughout.
import { nyInstant } from "./options";
import type { Bar2 } from "./trade-state";

/** The cookie that holds the step; without it the step follows the server's clock, one step every SCRIPT_STEP_MS. */
export const STEP_COOKIE = "fxstep";
export const SCRIPT_STEP_MS = 6_000;
/** Seconds after New York midnight of each step. */
export const SCRIPT_STEPS: readonly number[] = [9 * 3600 + 45 * 60, 10 * 3600 + 10 * 60, 10 * 3600 + 22 * 60 + 30, 10 * 3600 + 28 * 60 + 30, 10 * 3600 + 41 * 60];
/** The feed answers this long after the step's last trade. */
export const SCRIPT_ANSWER_LAG_MS = 3_000;
/** The focus names the script adds beside the fixture's SPY and QQQ. */
export const SCRIPT_EXTRA_FOCUS = "AAPL";

const OPEN_S = 9 * 3600 + 30 * 60;
const hms = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;

/** Way points (seconds after midnight, price); the price runs in a straight line between them. */
const PATHS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  QQQ: [
    [hms(9, 30), 751.6],
    [hms(10, 0), 752.0],
    [hms(10, 10), 752.3],
    [hms(10, 14), 752.5],
    [hms(10, 15), 752.6],
    [hms(10, 16), 754.0],
    [hms(10, 22), 754.3],
    [hms(10, 26), 753.3],
    [hms(10, 30), 753.5],
    [hms(10, 36), 754.6],
    [hms(10, 40), 755.2],
    [hms(10, 50), 755.0],
  ],
  SPY: [
    [hms(9, 30), 778.3],
    [hms(10, 10), 778.7],
    [hms(10, 21), 779.2],
    [hms(10, 22), 779.3],
    [hms(10, 22, 20), 779.7],
    [hms(10, 24), 780.0],
    [hms(10, 25), 779.6],
    [hms(10, 26), 779.0],
    [hms(10, 30), 778.8],
    [hms(10, 40), 778.6],
    [hms(11, 0), 778.5],
  ],
  AAPL: [
    [hms(9, 30), 334.2],
    [hms(10, 20), 334.8],
    [hms(10, 45), 334.3],
    [hms(11, 0), 334.6],
  ],
};

/** The leader is quoted flat, below its VWAP: against calls on QQQ. */
const SMH = { price: 300.0, vwap: 301.2, open: 301.5, high: 302.0, low: 299.6 } as const;

export const SCRIPT_SYMBOLS: readonly string[] = [...Object.keys(PATHS), "SMH"];

const r2 = (v: number) => Math.round(v * 100) / 100;
const SAMPLE_S = 15;
const BAR_S = 120;

/** The step from the cookie's value, or from the server's clock. Out-of-range or junk values follow the clock. */
export function scriptStep(cookie: string | null | undefined, nowMs: number): number {
  const n = cookie !== null && cookie !== undefined && /^\d+$/.test(cookie) ? Number(cookie) : NaN;
  if (Number.isInteger(n) && n >= 0 && n < SCRIPT_STEPS.length) return n;
  return Math.floor(nowMs / SCRIPT_STEP_MS) % SCRIPT_STEPS.length;
}

/** The step's cookie value from a request's `Cookie` header. */
export function stepFromCookieHeader(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === STEP_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The instant (ms) of a step on a session. */
export function stepInstant(session: string, step: number): number {
  const sec = SCRIPT_STEPS[step] ?? SCRIPT_STEPS[0]!;
  return (nyInstant(session, Math.floor(sec / 60)) ?? 0) + (sec % 60) * 1000;
}

function priceAt(path: readonly (readonly [number, number])[], sec: number): number {
  if (sec <= path[0]![0]) return path[0]![1];
  for (let i = 1; i < path.length; i++) {
    const [s1, p1] = path[i]!;
    const [s0, p0] = path[i - 1]!;
    if (sec <= s1) return p0 + ((p1 - p0) * (sec - s0)) / (s1 - s0);
  }
  return path[path.length - 1]![1];
}

/** The prices seen every SAMPLE_S seconds from the open up to `sec` (with `sec` itself last). */
function samples(path: readonly (readonly [number, number])[], sec: number): number[] {
  const out: number[] = [];
  for (let s = OPEN_S; s < sec; s += SAMPLE_S) out.push(r2(priceAt(path, s)));
  out.push(r2(priceAt(path, sec)));
  return out;
}

export interface ScriptQuote {
  price: number;
  at: string;
  open: number;
  high: number;
  low: number;
  day: string;
  prev_close: number | null;
  vwap: number;
}

/** A scripted name's quote at a step, or null for a name the script does not move. */
export function scriptQuote(symbol: string, session: string, step: number, prevClose: number | null = null): ScriptQuote | null {
  const at = new Date(stepInstant(session, step)).toISOString();
  if (symbol === "SMH") return { ...SMH, at, day: session, prev_close: SMH.open };
  const path = PATHS[symbol];
  if (!path) return null;
  const sec = SCRIPT_STEPS[step]!;
  const seen = samples(path, sec);
  return {
    price: seen[seen.length - 1]!,
    at,
    open: seen[0]!,
    high: Math.max(...seen),
    low: Math.min(...seen),
    day: session,
    prev_close: prevClose,
    vwap: r2(seen.reduce((s, v) => s + v, 0) / seen.length),
  };
}

/**
 * A scripted name's 2-minute bars from 09:30 up to a step, oldest first, with the bar still forming last (as Alpaca
 * answers). Each bar is built from the samples inside it that the step has reached. Empty for other names.
 */
export function scriptBars(symbol: string, session: string, step: number): Bar2[] {
  const path = PATHS[symbol];
  if (!path) return [];
  const sec = SCRIPT_STEPS[step]!;
  const open = nyInstant(session, OPEN_S / 60) ?? 0;
  const out: Bar2[] = [];
  for (let s = OPEN_S; s <= sec; s += BAR_S) {
    const pts: number[] = [];
    for (let x = s; x < s + BAR_S && x <= sec; x += SAMPLE_S) pts.push(r2(priceAt(path, x)));
    if (pts.length === 0) continue;
    const start = open + (s - OPEN_S) * 1000;
    out.push({ start, end: start + BAR_S * 1000, o: pts[0]!, h: Math.max(...pts), l: Math.min(...pts), c: pts[pts.length - 1]! });
  }
  return out;
}
