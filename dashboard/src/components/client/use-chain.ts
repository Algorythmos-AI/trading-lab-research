"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainResponse } from "@/lib/chain";
import { CHAIN_DEADLINE_MS, deadline } from "@/lib/fetch-deadline";
import { type Poll, type PollResult, startPoll, statusResult } from "@/lib/quote-poll";

/** The indicative feed is 15 minutes behind the market, so asking twice a minute loses nothing. */
export const CHAIN_POLL_MS = 30_000;
/** On OPRA, the real-time tape, the chain is asked for every 10 seconds. */
export const OPRA_POLL_MS = 10_000;
/**
 * After failures in a row it asks again in 2, 4, 8, 16 s, then never later than its own interval: this cap on
 * indicative, OPRA_POLL_MS while the last good answer was opra's (chainRetryCapMs).
 */
export const CHAIN_RETRY_CAP_MS = CHAIN_POLL_MS;

/**
 * The longest wait after failures: the current interval, so a run of failures on opra never waits past 10 s. A rate
 * limit (429) is not shortened: it always waits CHAIN_RETRY_CAP_MS.
 */
export function chainRetryCapMs(pollMs: number): number {
  return Math.min(CHAIN_RETRY_CAP_MS, pollMs);
}

/** How often to ask while the last good answer came from `feed`: every 10 s on opra, every 30 s otherwise. */
export function chainPollMs(feed: ChainResponse["feed"] | null | undefined): number {
  return feed === "opra" ? OPRA_POLL_MS : CHAIN_POLL_MS;
}

/**
 * A good answer this young (the monotonic clock, ms) stands when the tab is shown again: nothing is asked for. The
 * window is the poll's own interval (`pollMs`, chainPollMs of the last good answer's feed).
 */
export function chainFresh(lastOkAt: number, now: number, pollMs: number = CHAIN_POLL_MS): boolean {
  return now - lastOkAt < pollMs;
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
 * every 30 seconds while the tab is visible (every 10 while the last good answer came from OPRA), and at once when a
 * hidden tab comes back; after a failure in 2 s, doubling up to that interval while the failures go on (lib/quote-poll.ts, which also runs the live prices). Nothing is fetched until
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
    /** The request out now, cancelled with the effect: a new price bucket, name or contract never leaves the old one running. */
    let out: ReturnType<typeof deadline> | null = null;
    /** When this poll last had a good answer (the monotonic clock). */
    let lastOk = -Infinity;
    /** The interval the last good answer's feed calls for; indicative's until one has come. */
    let every = CHAIN_POLL_MS;
    // A good answer is kept through a failure only for the name it was asked for.
    const failed = () => {
      if (!stopped) setHeld((h) => (h.symbol === symbol && h.feed.status === "ok" ? h : { symbol, feed: { status: "error" } }));
    };
    const run = async (): Promise<PollResult> => {
      try {
        const [x, k] = keep.split(":");
        const own = x && k ? `&x=${encodeURIComponent(x)}&k=${encodeURIComponent(k)}` : "";
        out = deadline(CHAIN_DEADLINE_MS);
        const res = await fetch(`/api/chain?s=${encodeURIComponent(symbol)}&px=${px.toFixed(2)}${own}`, { cache: "no-store", signal: out.signal });
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
        out.done();
        if (!stopped) setHeld({ symbol, feed: { status: "ok", chain, receivedAt: Date.now(), receivedPerf: performance.now() } });
        lastOk = performance.now();
        every = chainPollMs(chain.feed);
        return "ok";
      } catch {
        failed();
        return "error";
      }
    };
    // While the tab is hidden nothing is asked for, and a reader coming back to it gets a fresh answer at once rather
    // than a wait for the next turn to come round (lib/quote-poll.ts).
    const p = startPoll({
      run,
      page: document,
      show: window,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: () => every,
      backoff: () => ({ capMs: chainRetryCapMs(every) }),
      // A rate limit waits the full cap on either feed: upstream asked us to slow down.
      limitedCapMs: CHAIN_RETRY_CAP_MS,
      // A tab shown again within one interval of a good answer asks for nothing: the next turn is no further away.
      fresh: () => chainFresh(lastOk, performance.now(), every),
    });
    poll.current = p;
    return () => {
      stopped = true;
      out?.cancel();
      p.stop();
      if (poll.current === p) poll.current = null;
    };
  }, [symbol, px, enabled, keep, attempt]);

  // Asked for but not yet answered reads as loading, without the effect having to say so; so does an answer kept for
  // another name, which is never shown.
  const feed: ChainFeed = held.symbol === symbol ? held.feed : { status: "idle" };
  return { feed: !enabled || px === null ? { status: "idle" } : feed.status === "idle" ? { status: "loading" } : feed, retry, reset };
}
