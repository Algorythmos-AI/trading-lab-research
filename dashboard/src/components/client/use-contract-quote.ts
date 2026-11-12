"use client";

import { useEffect, useState } from "react";
import { requestContracts } from "@/lib/contract-request";
import { CONTRACT_POLL_MS, type ContractFeed } from "@/lib/option-value";
import { type PollResult, startPoll } from "@/lib/quote-poll";

/** After failures in a row it asks again in 2, 4, 8 s, then every 10 s at most; a rate limit waits 30 s. */
export const CONTRACT_RETRY_CAP_MS = 10_000;
export const CONTRACT_LIMITED_MS = 30_000;

/** The answer as kept, with the contracts it was asked for: an answer for other contracts is never handed back. */
interface Held {
  symbols: string;
  feed: ContractFeed;
}

/**
 * The latest quote and trade of a few contracts (`symbols`, OCC symbols joined by commas) from /api/contract (same
 * origin, so the page's connect-src 'self' holds), every 2 s while the tab is visible and at once when a hidden tab
 * comes back, with the poll's own backoff after failures (lib/quote-poll.ts). Nothing is fetched until `enabled`. A
 * failure (a timeout included) drops the last answer at once: a value is never shown from a quote the route could not
 * check again. `shownPerf` is when the tab was last shown again after being hidden (the monotonic clock): an answer to
 * a request sent before it gives no value (option-value.ts judgeQuote).
 */
export function useContractQuote(symbols: string, enabled: boolean): { feed: ContractFeed; shownPerf: number | null } {
  const [held, setHeld] = useState<Held>({ symbols, feed: { status: "idle" } });
  const [shownPerf, setShownPerf] = useState<number | null>(null);
  const on = enabled && symbols !== "";

  useEffect(() => {
    if (!on) return;
    // Shown again (or restored from the back-forward cache): whatever was held is older than this moment.
    const shown = () => {
      if (document.visibilityState === "visible") setShownPerf(performance.now());
    };
    const restored = (e: { persisted?: boolean }) => {
      if (e.persisted) shown();
    };
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("pageshow", restored);
    };
  }, [on]);

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    const set = (feed: ContractFeed) => {
      if (!stopped) setHeld({ symbols, feed });
    };
    // Stamped before the fetch and given up after 5 s (contract-request.ts): a failure of any kind drops the last answer.
    const run = async (): Promise<PollResult> => {
      const r = await requestContracts(symbols, { fetchImpl: (u, i) => fetch(u, i), perf: () => performance.now(), wall: () => Date.now() });
      set(r.feed);
      return r.result;
    };
    const p = startPoll({
      run,
      page: document,
      show: window,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: CONTRACT_POLL_MS,
      backoff: { capMs: CONTRACT_RETRY_CAP_MS },
      limitedCapMs: CONTRACT_LIMITED_MS,
    });
    return () => {
      stopped = true;
      p.stop();
    };
  }, [symbols, on]);

  const feed: ContractFeed = !on ? { status: "idle" } : held.symbols !== symbols || held.feed.status === "idle" ? { status: "loading" } : held.feed;
  return { feed, shownPerf };
}
