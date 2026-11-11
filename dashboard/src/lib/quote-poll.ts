// The live polls' loop (quotes and the option chain), apart from React so its timing can be tested with fake timers:
// one request at a time, one timer at a time, a fetch straight away when the tab is shown again rather than at the
// next tick, and after a failure a wait that doubles with each failure in a row (lib/backoff.ts).
//
// The clock and the page are passed in; nothing here reads them itself.
import { type BackoffOptions, capDelay, retryDelay } from "./backoff";

/**
 * What one request came to: an answer, the feed not configured (stop polling), a failure (try again soon), or upstream
 * asking us to slow down (HTTP 429: try again after the longest wait).
 */
export type PollResult = "ok" | "off" | "error" | "limited";

/** The poll is waiting to try again after failing. */
export interface Backoff {
  /** Failures in a row so far. */
  failures: number;
  /** When the next attempt is due (the `now` clock); null while an attempt is in flight. */
  at: number | null;
  /** The last failure was upstream's rate limit. */
  limited: boolean;
}

export interface PollPage {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/** Where a back-forward cache restore is heard (`pageshow` with `persisted`): the window. */
export interface PollShow {
  addEventListener(type: "pageshow", fn: (e: { persisted?: boolean }) => void): void;
  removeEventListener(type: "pageshow", fn: (e: { persisted?: boolean }) => void): void;
}

export interface PollDeps {
  /** One request; it updates the feed itself and says how it went. A throw counts as an error. */
  run: () => Promise<PollResult>;
  page: PollPage;
  /** Optional: a page restored from the back-forward cache counts as shown again. */
  show?: PollShow;
  /** The clock the retry wait is measured on, ms. */
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  pollMs: number;
  /** The waits after failures in a row (lib/backoff.ts). */
  backoff: BackoffOptions;
  /** Told when a wait after a failure starts, when its attempt goes out, and (null) when the poll is healthy again. */
  onBackoff?: (b: Backoff | null) => void;
}

export interface Poll {
  stop: () => void;
  /** While waiting after a failure: one attempt now, keeping the count of failures. Otherwise nothing. */
  retryNow: () => void;
}

/**
 * Starts the loop. While the tab is hidden it only looks again every `pollMs`, fetching nothing. When the tab becomes
 * visible it fetches at once (the pending timer is dropped, so no second one runs), unless a request is already in
 * flight (that one's answer schedules the next). While it waits after a failure, showing the tab makes one attempt at
 * once, only one for each run of failures however often the tab is flipped; after that the wait stands. A page
 * restored from the back-forward cache is treated the same way. Each failure in a row doubles the wait, from
 * `backoff.firstMs` to `backoff.capMs`; a rate limit waits the cap; the first answer resets it to `pollMs`. After
 * "off" it stops for good.
 */
export function startPoll(d: PollDeps): Poll {
  let timer: unknown = undefined;
  let stopped = false;
  let done = false;
  let inFlight = false;
  let failures = 0;
  let limited = false;
  /** After a failure, no fetch before this (the `now` clock), except the one early attempt below. */
  let retryAt = -Infinity;
  /** This run of failures has had its one early attempt from the tab being shown. */
  let earlyUsed = false;

  const emit = (b: Backoff | null) => {
    if (!stopped) d.onBackoff?.(b);
  };
  const schedule = (ms: number) => {
    if (timer !== undefined) d.clearTimer(timer);
    timer = d.setTimer(tick, ms);
  };
  const healthy = () => {
    const was = failures > 0;
    failures = 0;
    limited = false;
    earlyUsed = false;
    retryAt = -Infinity;
    if (was) emit(null);
  };

  async function tick(): Promise<void> {
    timer = undefined;
    if (stopped || done || inFlight) return;
    if (d.page.visibilityState !== "visible") return schedule(d.pollMs);
    inFlight = true;
    if (failures > 0) emit({ failures, at: null, limited });
    let r: PollResult;
    try {
      r = await d.run();
    } catch {
      r = "error";
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (r === "off") {
      done = true;
      healthy();
      return;
    }
    if (r === "ok") {
      healthy();
      return schedule(d.pollMs);
    }
    failures++;
    limited = r === "limited";
    const wait = limited ? capDelay(d.backoff) : retryDelay(failures, d.backoff);
    retryAt = d.now() + wait;
    emit({ failures, at: retryAt, limited });
    schedule(wait);
  }

  /** Drop the pending timer and fetch now. */
  const now = () => {
    if (timer !== undefined) d.clearTimer(timer);
    timer = undefined;
    void tick();
  };

  const onVisible = () => {
    if (stopped || done || inFlight || d.page.visibilityState !== "visible") return;
    if (d.now() < retryAt) {
      // Waiting after a failure: one attempt at once per run of failures, then the wait stands.
      if (earlyUsed) return;
      earlyUsed = true;
    }
    now();
  };

  const onShow = (e: { persisted?: boolean }) => {
    if (e.persisted) onVisible();
  };
  d.page.addEventListener("visibilitychange", onVisible);
  d.show?.addEventListener("pageshow", onShow);
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) d.clearTimer(timer);
      timer = undefined;
      d.page.removeEventListener("visibilitychange", onVisible);
      d.show?.removeEventListener("pageshow", onShow);
    },
    retryNow: () => {
      if (stopped || done || inFlight || failures === 0 || d.page.visibilityState !== "visible") return;
      now();
    },
  };
}
