// The poll behind the "Trade now" board's session bars (/api/bars), with no React and no DOM in it, so it can be run
// in a test: the hook in components/client/use-bars.ts hands it the browser's fetch, clock, timers and visibility.
// Kept apart from lib/bars-feed.ts (what the board reads) so the desk engine never imports it. Research only; nothing
// here places an order.
import { type BackoffOptions, capDelay, retryDelay } from "./backoff";
import { BARS_DEADLINE_MS } from "./fetch-deadline";
import type { BarsFeed } from "./bars-feed";
import type { Bar2 } from "./trade-state";

export const BARS_POLL_MS = 30_000;
/** After failures in a row the poll waits 2, 4, 8, 16 s, then never longer than its own interval. */
export const BARS_RETRY_CAP_MS = BARS_POLL_MS;

/** The bars route for these names; `half=1` on a half day, so no bar after 13:00 is a session bar. */
export function barsUrl(symbols: string, halfDay: boolean): string {
  return `/api/bars?s=${encodeURIComponent(symbols)}${halfDay ? "&half=1" : ""}`;
}

export interface BarsPollerDeps {
  url: string;
  fetch: typeof fetch;
  now: () => number;
  visible: () => boolean;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number | undefined) => void;
  onFeed: (feed: BarsFeed) => void;
  /** Optional: true to keep polling (at the usual interval) while the page is hidden; asked again at each turn. */
  background?: () => boolean;
  /** For tests: the jitter's random number (lib/backoff.ts). */
  rand?: () => number;
}

/**
 * Polls every BARS_POLL_MS while visible; a hidden page parks the poll, unless `background` says to keep going. After a failure it waits 2 s, doubling with
 * each failure in a row up to BARS_RETRY_CAP_MS, and the cap at once after a rate limit (429); the first answer puts
 * it back on its interval. A 503 means not configured: it stops. A failure after good bars keeps them marked `failed`,
 * so the board can stop using them. `kick` fetches now; a kick while a fetch is in flight is not dropped: one more
 * fetch follows straight after it, unless that fetch failed (then the wait stands). While waiting after a failure,
 * only the first kick of the run of failures fetches early (a tab shown again, or a new slot); the rest leave the wait,
 * and after a rate limit none does.
 */
export function barsPoller(d: BarsPollerDeps): { start: () => void; stop: () => void; kick: () => void } {
  const backoff: BackoffOptions = { capMs: BARS_RETRY_CAP_MS, rand: d.rand };
  let timer: number | undefined;
  let stopped = false;
  let busy = false;
  let again = false;
  let failures = 0;
  /** After a failure, no fetch before this (the `now` clock), except one early kick. */
  let retryAt = -Infinity;
  let earlyUsed = false;
  /** The last failure was upstream's rate limit: its wait always stands. */
  let limited = false;
  let feed: BarsFeed = { status: "loading" };
  const emit = (f: BarsFeed) => {
    feed = f;
    if (!stopped) d.onFeed(f);
  };
  const load = async (): Promise<void> => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    d.clearTimer(timer);
    if (!d.visible() && !d.background?.()) {
      timer = d.setTimer(() => void load(), BARS_POLL_MS);
      return;
    }
    busy = true;
    let next = BARS_POLL_MS;
    limited = false; // a transport failure below is not a rate limit
    try {
      // Never longer than BARS_DEADLINE_MS: while one read is out no other goes, so a hung one would stop the bars.
      const res = await d.fetch(d.url, { cache: "no-store", signal: AbortSignal.timeout(BARS_DEADLINE_MS) });
      if (res.status === 503) {
        emit({ status: "off" });
        again = false;
        return; // not configured: no point polling until the page is reloaded
      }
      limited = res.status === 429;
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { as_of: string; bars?: Record<string, Bar2[]>; fetchedAt?: Record<string, number> };
      emit({ status: "ok", asOf: body.as_of, bars: body.bars ?? {}, fetchedAt: body.fetchedAt ?? {}, receivedAt: d.now(), failed: false });
      failures = 0;
      earlyUsed = false;
      retryAt = -Infinity;
    } catch {
      emit(feed.status === "ok" ? { ...feed, failed: true } : { status: "error" });
      failures++;
      next = limited ? capDelay(backoff) : retryDelay(failures, backoff);
      retryAt = d.now() + next;
      again = false; // a kick during a failed fetch waits like everything else
    } finally {
      busy = false;
    }
    if (stopped) return;
    if (again) {
      again = false;
      return load();
    }
    timer = d.setTimer(() => void load(), next);
  };
  return {
    start: () => void load(),
    stop: () => {
      stopped = true;
      d.clearTimer(timer);
    },
    kick: () => {
      if (stopped) return;
      if (!busy && d.now() < retryAt) {
        // Waiting after a failure: one early fetch per run of failures, only for a page that can be seen, and never
        // while waiting out a rate limit.
        if (limited || earlyUsed || !d.visible()) return;
        earlyUsed = true;
      }
      void load();
    },
  };
}
