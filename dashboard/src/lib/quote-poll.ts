// The live quotes' poll loop, apart from React so its timing can be tested with fake timers: one request at a time,
// one timer at a time, and a fetch straight away when the tab is shown again rather than at the next tick.
//
// The clock and the page are passed in; nothing here reads them itself.

/** What one request came to: prices, the feed not configured (stop polling), or a failure (try again later). */
export type PollResult = "ok" | "off" | "error";

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
  retryMs: number;
}

/**
 * Starts the loop and returns its stop. While the tab is hidden it only looks again every `pollMs`, fetching nothing.
 * When the tab becomes visible it fetches at once (the pending timer is dropped, so no second one runs), unless a
 * request is already in flight (that one's answer schedules the next) or a failure's retry wait (`retryMs`) has not
 * run out: showing the tab never cuts the wait short. A page restored from the back-forward cache is treated the
 * same way. After "off" it stops for good.
 */
export function startPoll(d: PollDeps): () => void {
  let timer: unknown = undefined;
  let stopped = false;
  let done = false;
  let inFlight = false;
  /** After a failure, no fetch before this (the `now` clock). */
  let retryAt = -Infinity;

  const schedule = (ms: number) => {
    if (timer !== undefined) d.clearTimer(timer);
    timer = d.setTimer(tick, ms);
  };

  async function tick(): Promise<void> {
    timer = undefined;
    if (stopped || done || inFlight) return;
    if (d.page.visibilityState !== "visible") return schedule(d.pollMs);
    inFlight = true;
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
      return;
    }
    retryAt = r === "error" ? d.now() + d.retryMs : -Infinity;
    schedule(r === "error" ? d.retryMs : d.pollMs);
  }

  const onVisible = () => {
    if (stopped || done || inFlight || d.page.visibilityState !== "visible") return;
    if (d.now() < retryAt) return; // the retry timer stands
    if (timer !== undefined) d.clearTimer(timer);
    timer = undefined;
    void tick();
  };

  const onShow = (e: { persisted?: boolean }) => {
    if (e.persisted) onVisible();
  };
  d.page.addEventListener("visibilitychange", onVisible);
  d.show?.addEventListener("pageshow", onShow);
  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) d.clearTimer(timer);
    timer = undefined;
    d.page.removeEventListener("visibilitychange", onVisible);
    d.show?.removeEventListener("pageshow", onShow);
  };
}
