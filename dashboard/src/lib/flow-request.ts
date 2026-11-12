// One /api/flow request from the page, and how old its answer is: apart from React so the freshness rules can be tested
// with plain numbers. Pure apart from the fetch it is handed.
//
// The rules (learned the hard way: an answer must never look younger than it is):
//  * The request is stamped BEFORE the fetch goes out, on both clocks: `sentPerf` (performance.now(), monotonic) and
//    `sentWall` (Date.now()). The checked age counts from the send, never from the arrival, so a slow answer is as old
//    as the moment it was asked for.
//  * An answer to a request sent before the tab was last shown is never fresh: it may have been asked for long before
//    a sleep, and the monotonic clock can stand still while a laptop sleeps.
//  * The wall clock is checked too: an answer whose `as_of` is older than the limit by the device's clock is withheld,
//    so a monotonic clock that stood still cannot keep an old answer fresh. Either clock can only make it older.
//  * The fetch gives up after FLOW_TIMEOUT_MS; a failure drops the last answer (the caller's job: see use-flow.ts).
import { statusResult } from "./quote-poll";
import type { FlowAnswer } from "./flow-route";
import { nextOpenAfter, sessionOpenAt, STALE_MS } from "./context";

/** The fetch gives up after this long. */
export const FLOW_TIMEOUT_MS = 5_000;
/** An answer older than this by either clock is not fresh. Exactly the limit still is. */
export const FLOW_FRESH_MS = STALE_MS;

/** When a request was sent, on both clocks. */
export interface FlowStamp {
  sentPerf: number;
  sentWall: number;
}

/** An answer kept with its request's stamp. */
export interface HeldFlow {
  body: FlowAnswer;
  /** The answer's `as_of`, ms. */
  asOf: number;
  stamp: FlowStamp;
  /** When it arrived, on the monotonic clock. */
  receivedPerf: number;
  /** When it arrived, on the device's wall clock. */
  receivedWall: number;
}

export function stampRequest(perf: number, wall: number): FlowStamp {
  return { sentPerf: perf, sentWall: wall };
}

export type FlowJudgeWhy = "before-show" | "no-as-of" | "device-clock" | "clock-jump" | "old" | "wall-old";

export type FlowJudged =
  | { fresh: true; ageMs: number; checkedMs: number }
  /**
   * `ageMs` null: the answer cannot be given an age that counts (sent before the tab was shown, no `as_of`, the device's
   * clock off against the server's at arrival, or the two clocks disagreeing since the send).
   */
  | { fresh: false; why: FlowJudgeWhy; ageMs: number | null; checkedMs: number };

/**
 * How old a held answer is at `perfNow` / `wallNow`, and whether it may be shown as fresh. `checkedMs` counts from the
 * send on the monotonic clock; `ageMs` is the largest of that, the time since arrival on the same clock and the wall
 * clock's age of `as_of` (each can only make it older). `shownPerf` is when the tab was last shown (monotonic),
 * -Infinity when it never was hidden. Not fresh, in this order: sent before the tab was shown; no `as_of`; the device's
 * wall clock more than the limit away from `as_of` when the answer arrived ("device-clock": the page says so); the wall
 * clock now more than the limit away from `sentWall` plus the monotonic time since the send ("clock-jump": a sleep with
 * the monotonic clock stood still, or the clock set by hand); older than the limit by either clock.
 */
export function judgeFlow(held: HeldFlow, perfNow: number, wallNow: number, shownPerf: number, limitMs: number = FLOW_FRESH_MS): FlowJudged {
  const checkedMs = Math.max(0, perfNow - held.stamp.sentPerf);
  const no = (why: FlowJudgeWhy, ageMs: number | null = null): FlowJudged => ({ fresh: false, why, ageMs, checkedMs });
  if (held.stamp.sentPerf < shownPerf) return no("before-show");
  if (!Number.isFinite(held.asOf)) return no("no-as-of");
  if (Math.abs(held.receivedWall - held.asOf) > limitMs) return no("device-clock");
  if (Math.abs(wallNow - (held.stamp.sentWall + checkedMs)) > limitMs) return no("clock-jump");
  const wallMs = wallNow - held.asOf;
  const ageMs = Math.max(checkedMs, perfNow - held.receivedPerf, wallMs);
  if (checkedMs > limitMs) return no("old", ageMs);
  if (wallMs > limitMs) return no("wall-old", ageMs);
  return { fresh: true, ageMs, checkedMs };
}

/** In the session the bar asks every 5 s; outside it, at most every 5 minutes. */
export const FLOW_POLL_MS = 5_000;
export const FLOW_CLOSED_POLL_MS = 5 * 60_000;

/**
 * The wait before the next request after an answer stamped `asOf` (ms; null when there is none to go by): 5 s while
 * that answer's clock is in the regular session; otherwise the earlier of 5 minutes and the next 09:30 New York open
 * (at least a second), so the first bars after the open are asked for at once.
 */
export function flowPollMs(asOf: number | null): number {
  if (asOf === null || !Number.isFinite(asOf) || sessionOpenAt(asOf)) return FLOW_POLL_MS;
  const next = nextOpenAfter(asOf);
  return next === null ? FLOW_CLOSED_POLL_MS : Math.max(1_000, Math.min(FLOW_CLOSED_POLL_MS, next - asOf));
}

export type FlowFetch = { result: "ok"; held: HeldFlow } | { result: "off"; plan: boolean } | { result: "error" } | { result: "limited" };

export interface FlowFetchDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  perf: () => number;
  wall: () => number;
  /** The request's abort signal: AbortSignal.timeout(FLOW_TIMEOUT_MS) unless a test passes its own. */
  signal?: () => AbortSignal;
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * One request, stamped before it goes out. Our own 503 not-configured is "off" (the poll stops; `plan` when SIP is not
 * on the data plan); a 503 that is not ours, any other failure, a timeout or an answer without `as_of` and `names` is
 * "error"; a 429 is "limited".
 */
export async function fetchFlow(url: string, d: FlowFetchDeps): Promise<FlowFetch> {
  const stamp = stampRequest(d.perf(), d.wall());
  try {
    const res = await d.fetch(url, { cache: "no-store", signal: (d.signal ?? (() => AbortSignal.timeout(FLOW_TIMEOUT_MS)))() });
    const r = statusResult(res.status);
    if (r === "off") {
      const b = rec(await res.json().catch(() => null));
      return b?.error === "not-configured" ? { result: "off", plan: b.why === "plan" } : { result: "error" };
    }
    if (r !== "ok") return { result: r };
    const body = rec(await res.json());
    if (!body || typeof body.as_of !== "string" || !rec(body.names)) return { result: "error" };
    return { result: "ok", held: { body: body as unknown as FlowAnswer, asOf: Date.parse(body.as_of), stamp, receivedPerf: d.perf(), receivedWall: d.wall() } };
  } catch {
    return { result: "error" };
  }
}

export type FlowFeed =
  | { status: "loading" }
  /** Our own 503: no keys, or (`plan`) SIP is not on the data plan. The poll has stopped. */
  | { status: "off"; plan: boolean }
  /** The last request failed (`limited`: upstream asked us to slow down). The last answer is dropped with it. */
  | { status: "error"; limited: boolean }
  | { status: "ok"; held: HeldFlow };
