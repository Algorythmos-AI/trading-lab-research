// The feed agreement's bars (docs/runbooks/feed-agreement.md): one finished session's 2-minute bars for the focus
// names from one named Alpaca stock feed, read once after the session. Read-only GETs of historical bars only. It has
// no cache and shares nothing with the board's or the evaluator's reads (bars.ts fetchBars and its cache are not
// used); it reuses only bars.ts's normaliseBar, so a bar counts exactly as it does for the board.
//
// It keeps under ALPACA_CALLS_PER_MIN, waits for Retry-After on a 429, and never goes past its deadline. The keys go
// only into Alpaca's headers; a key, a page token or a response body is never logged or put in an error.
import { normaliseBar } from "./bars";
import type { SessionBounds } from "./desk-eval";
import type { Feed } from "./feed-agreement";
import type { Bar2 } from "./trade-state";

export const DEFAULT_DATA_URL = "https://data.alpaca.markets";
/** Alpaca's limit is 200 calls a minute; this stays under it. */
export const ALPACA_CALLS_PER_MIN = 180;
/** The longest one call may take (less when the deadline is nearer). */
export const CALL_TIMEOUT_MS = 15_000;
/** Pages read for one feed at most: a session of 2-minute bars for a focus card fits in one. */
export const MAX_PAGES = 20;
/** 429 answers retried at most, each after its Retry-After. */
export const MAX_RETRIES = 5;
/** The wait after a 429 without a readable Retry-After. */
export const DEFAULT_RETRY_MS = 5_000;

export type StopKind = "sip-not-entitled" | "iex-refused" | "no-bars" | "time-budget" | "upstream";

/** Why the runner stops without a report: its kind and a line safe to print (no key, no token, no body). */
export class FetchStop extends Error {
  constructor(
    readonly kind: StopKind,
    readonly line: string,
  ) {
    super(line);
    this.name = "FetchStop";
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Calls made in the last minute, shared by every read of one run. */
export class CallLimiter {
  private readonly calls: number[] = [];
  constructor(private readonly perMin = ALPACA_CALLS_PER_MIN) {}
  /** The wait (ms) before the next call may go. */
  waitMs(now: number): number {
    while (this.calls.length && now - this.calls[0]! >= 60_000) this.calls.shift();
    return this.calls.length < this.perMin ? 0 : this.calls[0]! + 60_000 - now;
  }
  record(now: number): void {
    this.calls.push(now);
  }
}

/** Retry-After as seconds or an HTTP date, in ms from now; null when absent or unreadable. */
export function retryAfterMs(h: string | null, now: number): number | null {
  if (!h) return null;
  const s = Number(h.trim());
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface FetchSessionOpts {
  keys: { id: string; secret: string };
  clock: Clock;
  /** The hard deadline (ms on `clock`). */
  deadline: number;
  limiter: CallLimiter;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

type RawBar = Parameters<typeof normaliseBar>[0];

async function waitWithin(ms: number, o: FetchSessionOpts, what: string): Promise<void> {
  if (ms <= 0) return;
  if (o.clock.now() + ms >= o.deadline) throw new FetchStop("time-budget", `time budget: ${what} needs ${Math.ceil(ms / 1000)} s and the budget has less left; no report written`);
  await o.clock.sleep(ms);
}

/** One GET, inside the limiter and the deadline, retrying a 429 after its Retry-After. */
async function getJson(url: string, feed: Feed, o: FetchSessionOpts): Promise<unknown> {
  const fetchImpl = o.fetchImpl ?? fetch;
  for (let attempt = 0; ; attempt++) {
    await waitWithin(o.limiter.waitMs(o.clock.now()), o, "the call limit");
    const left = o.deadline - o.clock.now();
    if (left <= 0) throw new FetchStop("time-budget", `time budget: spent before the ${feed} bars were read; no report written`);
    o.limiter.record(o.clock.now());
    // When the deadline is nearer than a call's own limit, the call's timeout is the deadline: its firing is the budget.
    const budgetBound = left <= CALL_TIMEOUT_MS;
    const timedOut = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "APCA-API-KEY-ID": o.keys.id, "APCA-API-SECRET-KEY": o.keys.secret, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, left)),
      });
    } catch (e) {
      if (timedOut(e) && (budgetBound || o.deadline - o.clock.now() <= 0)) throw new FetchStop("time-budget", `time budget: the ${feed} bars did not arrive in time; no report written`);
      throw new FetchStop("upstream", `upstream: the ${feed} bars could not be read (${e instanceof Error ? e.name : "unknown"}); no report written`);
    }
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new FetchStop("upstream", `upstream: ${feed} bars still rate-limited (429) after ${MAX_RETRIES} retries; no report written`);
      await waitWithin(retryAfterMs(res.headers.get("retry-after"), o.clock.now()) ?? DEFAULT_RETRY_MS, o, `a 429 Retry-After on ${feed}`);
      continue;
    }
    if (res.status === 403)
      throw feed === "sip"
        ? new FetchStop("sip-not-entitled", "sip not entitled: Alpaca answered 403 (not entitled, or recent data not permitted on this plan) for the SIP feed; no report written")
        : new FetchStop("iex-refused", "iex refused: Alpaca answered 403 (not entitled, or recent data not permitted on this plan) for the IEX feed; no report written");
    if (!res.ok) throw new FetchStop("upstream", `upstream: ${feed} bars answered HTTP ${res.status}${res.status === 401 ? " (keys rejected)" : ""}; no report written`);
    try {
      return await res.json();
    } catch (e) {
      // The call's own timeout (bounded by the deadline) can fire while the body is still arriving: that is the budget.
      if (timedOut(e) && (budgetBound || o.deadline - o.clock.now() <= 0))
        throw new FetchStop("time-budget", `time budget: the ${feed} bars' body was still arriving when the budget ran out; no report written`);
      if (timedOut(e)) throw new FetchStop("upstream", `upstream: the ${feed} bars' body timed out; no report written`);
      throw new FetchStop("upstream", `upstream: ${feed} bars answered with a body that is not JSON; no report written`);
    }
  }
}

/**
 * The session's regular-hours 2-minute bars per focus name from `feed`, oldest first, one per slot: every
 * next_page_token page read, each bar through normaliseBar (the board's rule, to 13:00 on a half day) and kept only
 * when it lies inside the session. Throws FetchStop: "no-bars" when no name has a single bar, or when Alpaca is still
 * paging after MAX_PAGES ("upstream"), never a partial answer.
 */
export async function fetchSessionBars(feed: Feed, symbols: readonly string[], bounds: SessionBounds, o: FetchSessionOpts): Promise<Record<string, Bar2[]>> {
  const base = o.baseUrl ?? DEFAULT_DATA_URL;
  const got: Record<string, Map<number, Bar2>> = Object.fromEntries(symbols.map((s) => [s, new Map()]));
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      symbols: symbols.join(","),
      timeframe: "2Min",
      start: new Date(bounds.open).toISOString(),
      end: new Date(bounds.close).toISOString(),
      feed,
      limit: "10000",
      adjustment: "raw",
      sort: "asc",
    });
    if (token) q.set("page_token", token);
    const body = (await getJson(`${base}/v2/stocks/bars?${q.toString()}`, feed, o)) as { bars?: Record<string, RawBar[]> | null; next_page_token?: unknown } | null;
    for (const [s, list] of Object.entries(body?.bars ?? {})) {
      const into = got[s];
      if (!into || !Array.isArray(list)) continue;
      for (const raw of list) {
        const b = normaliseBar(raw, bounds.halfDay);
        if (b && b.start >= bounds.open && b.end <= bounds.close) into.set(b.start, b);
      }
    }
    token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token) break;
  }
  if (token) throw new FetchStop("upstream", `upstream: ${feed} bars still paging after ${MAX_PAGES} pages; no report written`);
  const out: Record<string, Bar2[]> = {};
  for (const s of symbols) out[s] = [...got[s]!.values()].sort((a, b) => a.start - b.start);
  if (symbols.every((s) => out[s]!.length === 0)) throw new FetchStop("no-bars", `no bars: the ${feed} feed returned no bars for any focus name on ${bounds.day}; no report written`);
  return out;
}
