"use client";

import { useEffect, useState } from "react";
import { fetchFlow, type FlowFeed, flowPollMs } from "@/lib/flow-request";
import { type PollResult, startPoll } from "@/lib/quote-poll";

export type { FlowFeed } from "@/lib/flow-request";

export { FLOW_POLL_MS } from "@/lib/flow-request";
/** The longest wait after failures in a row (2, 4, 8, 16 s, then this); a rate limit waits it at once. */
export const FLOW_RETRY_CAP_MS = 30_000;
export const FLOW_URL = "/api/flow?s=SPY,QQQ";

export interface FlowState {
  feed: FlowFeed;
  /** When the tab was last shown, on the monotonic clock; -Infinity while it has not been hidden. */
  shownPerf: number;
}

/**
 * Polls /api/flow (same origin, so the page's connect-src 'self' holds) for SPY and QQQ every 5 s in the session (every
 * 5 minutes, or at the next open if sooner, while the last answer says the market is closed: flowPollMs) with the live polls'
 * loop (lib/quote-poll.ts): one request at a time, parked while the tab is hidden, a fetch at once when it is shown
 * again, the doubling wait after a failure, the cap after a 429, and a stop for good on our own 503 not-configured.
 * Each request is stamped before it goes out (lib/flow-request.ts); a failure drops the last answer, so an old one is
 * never shown as if it still stood. Facts only.
 */
export function useFlow(enabled = true): FlowState {
  const [feed, setFeed] = useState<FlowFeed>({ status: "loading" });
  const [shownPerf, setShownPerf] = useState(-Infinity);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    // The last answer's as_of: in the session the poll runs every 5 s, outside it every 5 minutes or at the open.
    let lastAsOf: number | null = null;
    const onVisible = () => {
      if (document.visibilityState === "visible") setShownPerf(performance.now());
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setShownPerf(performance.now());
    };
    // Heard before the poll's own listener, so an answer to the fetch the show starts is stamped after it.
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    const run = async (): Promise<PollResult> => {
      const r = await fetchFlow(FLOW_URL, { fetch: (input, init) => fetch(input, init), perf: () => performance.now(), wall: () => Date.now() });
      if (stopped) return r.result === "ok" ? "ok" : r.result;
      lastAsOf = r.result === "ok" ? r.held.asOf : null;
      if (r.result === "ok") setFeed({ status: "ok", held: r.held });
      else if (r.result === "off") setFeed({ status: "off", plan: r.plan });
      else setFeed({ status: "error", limited: r.result === "limited" });
      return r.result;
    };
    const p = startPoll({
      run,
      page: document,
      show: window,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: () => flowPollMs(lastAsOf),
      backoff: { capMs: FLOW_RETRY_CAP_MS },
    });
    return () => {
      stopped = true;
      p.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
    };
  }, [enabled]);

  return { feed, shownPerf };
}
