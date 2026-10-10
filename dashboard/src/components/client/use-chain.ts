"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChainResponse } from "@/lib/chain";

/** The feed is 15 minutes behind the market, so asking twice a minute loses nothing. */
export const CHAIN_POLL_MS = 30_000;
const RETRY_MS = 60_000;

export type ChainFeed =
  | { status: "idle" }
  | { status: "loading" }
  /** The site has no keys for the option feed. */
  | { status: "off" }
  | { status: "error" }
  | { status: "ok"; chain: ChainResponse };

/**
 * One name's option chain from /api/chain (same origin, so the page's connect-src 'self' holds), asked for again
 * every 30 seconds while the tab is visible, and at once when a hidden tab comes back. Nothing is fetched until `enabled`: the contract pane asks only for
 * the name it is open on. A failure after a good answer keeps the good answer; its quotes then read as old.
 */
export function useChain(symbol: string, px: number | null, enabled: boolean): { feed: ChainFeed; retry: () => void } {
  const [feed, setFeed] = useState<ChainFeed>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setFeed({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || px === null) return;
    let timer: number | undefined;
    let stopped = false;
    // While the tab is hidden nothing is asked for. It waits here, not on a timer, so the first thing a reader
    // coming back to the tab sees is a fresh answer and not a wait for the next half minute to come round.
    let parked = false;
    const load = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        parked = true;
        return;
      }
      let next = CHAIN_POLL_MS;
      try {
        const res = await fetch(`/api/chain?s=${encodeURIComponent(symbol)}&px=${px.toFixed(2)}`, { cache: "no-store" });
        if (res.status === 503) {
          if (!stopped) setFeed({ status: "off" });
          return; // not configured: no point asking again until the page is reloaded
        }
        if (!res.ok) throw new Error(String(res.status));
        const chain = (await res.json()) as ChainResponse;
        if (!stopped) setFeed({ status: "ok", chain });
      } catch {
        if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
        next = RETRY_MS;
      }
      if (!stopped) timer = window.setTimeout(load, next);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !parked) return;
      parked = false;
      void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [symbol, px, enabled, attempt]);

  // Asked for but not yet answered reads as loading, without the effect having to say so.
  return { feed: !enabled || px === null ? { status: "idle" } : feed.status === "idle" ? { status: "loading" } : feed, retry };
}
