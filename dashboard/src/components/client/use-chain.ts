"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainResponse } from "@/lib/chain";
import { type Poll, type PollResult, startPoll, statusResult } from "@/lib/quote-poll";

/** The feed is 15 minutes behind the market, so asking twice a minute loses nothing. */
export const CHAIN_POLL_MS = 30_000;
/** After failures in a row it asks again in 2, 4, 8, 16 s, then never later than its own interval. */
export const CHAIN_RETRY_CAP_MS = CHAIN_POLL_MS;

/** A good answer this young (the monotonic clock, ms) stands when the tab is shown again: nothing is asked for. */
export function chainFresh(lastOkAt: number, now: number): boolean {
  return now - lastOkAt < CHAIN_POLL_MS;
}

export type ChainFeed =
  | { status: "idle" }
  | { status: "loading" }
  /** The site has no keys for the option feed. */
  | { status: "off" }
  | { status: "error" }
  /**
   * `receivedAt`: when the answer reached the browser (its wall clock, ms). `receivedPerf`: the same moment on the
   * browser's monotonic clock (`performance.now()`), which the answer's age is measured on (what-if's chainAgeMin), so
   * a wall clock set back cannot make an old answer look new.
   */
  | { status: "ok"; chain: ChainResponse; receivedAt: number; receivedPerf: number };

/** The answer as kept, with the name it was asked for: a feed for another name is never handed back. */
interface Held {
  symbol: string;
  feed: ChainFeed;
}

/**
 * One name's option chain from /api/chain (same origin, so the page's connect-src 'self' holds), asked for again
 * every 30 seconds while the tab is visible, and at once when a hidden tab comes back; after a failure in 2 s, doubling
 * up to 30 s while the failures go on (lib/quote-poll.ts, which also runs the live prices). Nothing is fetched until
 * `enabled`: the contract pane asks only for the name it is open on. A failure after a good answer keeps the good
 * answer; its quotes then read as old. When `symbol` changes the last name's answer is dropped at once: until the new
 * name answers, the feed reads as loading, never as the old name's chain.
 */
export function useChain(
  symbol: string,
  px: number | null,
  enabled: boolean,
  /** The reader's own contract, as `2026-10-30:785`, so the answer always carries it. Empty when there is none. */
  keep = "",
): { feed: ChainFeed; retry: () => void; reset: () => void } {
  const [held, setHeld] = useState<Held>({ symbol, feed: { status: "idle" } });
  const [attempt, setAttempt] = useState(0);
  const poll = useRef<Poll | null>(null);
  const retry = useCallback(() => {
    // In a run of failures the poll's own Retry now (at most once a second, never inside a rate limit's wait): a fresh
    // poll here would forget the failures and ask at once. Otherwise start again from loading.
    if (poll.current?.failing()) return poll.current.retryNow();
    setHeld({ symbol, feed: { status: "loading" } });
    setAttempt((n) => n + 1);
  }, [symbol]);
  /** Forget the last answer, for when the pane is shut: reopened later, it must not start from old quotes. */
  const reset = useCallback(() => setHeld({ symbol, feed: { status: "idle" } }), [symbol]);

  useEffect(() => {
    if (!enabled || px === null) return;
    let stopped = false;
    /** When this poll last had a good answer (the monotonic clock). */
    let lastOk = -Infinity;
    // A good answer is kept through a failure only for the name it was asked for.
    const failed = () => {
      if (!stopped) setHeld((h) => (h.symbol === symbol && h.feed.status === "ok" ? h : { symbol, feed: { status: "error" } }));
    };
    const run = async (): Promise<PollResult> => {
      try {
        const [x, k] = keep.split(":");
        const own = x && k ? `&x=${encodeURIComponent(x)}&k=${encodeURIComponent(k)}` : "";
        const res = await fetch(`/api/chain?s=${encodeURIComponent(symbol)}&px=${px.toFixed(2)}${own}`, { cache: "no-store" });
        const r = statusResult(res.status);
        if (r === "off") {
          if (!stopped) setHeld({ symbol, feed: { status: "off" } });
          return "off"; // not configured: no point asking again until the page is reloaded
        }
        if (r !== "ok") {
          failed();
          return r; // "limited" (429) waits the longest; anything else the doubling wait
        }
        const chain = (await res.json()) as ChainResponse;
        if (!stopped) setHeld({ symbol, feed: { status: "ok", chain, receivedAt: Date.now(), receivedPerf: performance.now() } });
        lastOk = performance.now();
        return "ok";
      } catch {
        failed();
        return "error";
      }
    };
    // While the tab is hidden nothing is asked for, and a reader coming back to it gets a fresh answer at once rather
    // than a wait for the next half minute to come round (lib/quote-poll.ts).
    const p = startPoll({
      run,
      page: document,
      show: window,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: CHAIN_POLL_MS,
      backoff: { capMs: CHAIN_RETRY_CAP_MS },
      // A tab shown again within the half minute of a good answer asks for nothing: the quotes are 15 minutes behind.
      fresh: () => chainFresh(lastOk, performance.now()),
    });
    poll.current = p;
    return () => {
      stopped = true;
      p.stop();
      if (poll.current === p) poll.current = null;
    };
  }, [symbol, px, enabled, keep, attempt]);

  // Asked for but not yet answered reads as loading, without the effect having to say so; so does an answer kept for
  // another name, which is never shown.
  const feed: ChainFeed = held.symbol === symbol ? held.feed : { status: "idle" };
  return { feed: !enabled || px === null ? { status: "idle" } : feed.status === "idle" ? { status: "loading" } : feed, retry, reset };
}
