"use client";

import { useEffect, useState } from "react";
import { extendTrail, type LiveQuote, type TrailPoint } from "@/lib/options";
import { type PollResult, startPoll } from "@/lib/quote-poll";

export const POLL_MS = 2_000;
const RETRY_MS = 60_000;

export type Feed =
  | { status: "loading" }
  | { status: "off" }
  | { status: "error" }
  | {
      status: "ok";
      asOf: string;
      quotes: Record<string, LiveQuote>;
      missing: string[];
      /** Browser time of the last answer, so a feed that stops answering reads as stale. */
      receivedAt: number;
      /** Each name's prices seen on this page over the last few minutes, oldest first. */
      trails: Record<string, TrailPoint[]>;
    };

/**
 * Polls /api/quote (same origin, so the page's connect-src 'self' holds) every 2 seconds while the tab is visible,
 * and at once when it is shown again (lib/quote-poll.ts: one request at a time). `enabled` false (an old edition)
 * never polls. Research only.
 */
export function useQuotes(symbols: string, enabled = true): Feed {
  const [feed, setFeed] = useState<Feed>({ status: enabled ? "loading" : "off" });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const run = async (): Promise<PollResult> => {
      try {
        const res = await fetch(`/api/quote?s=${encodeURIComponent(symbols)}`, { cache: "no-store" });
        if (res.status === 503) {
          if (!stopped) setFeed({ status: "off" });
          return "off"; // not configured: no point polling until the page is reloaded
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { as_of: string; quotes: Record<string, LiveQuote>; missing?: string[] };
        const quotes = body.quotes ?? {};
        if (!stopped)
          setFeed((f) => {
            const before = f.status === "ok" ? f.trails : {};
            const trails: Record<string, TrailPoint[]> = {};
            for (const [s, q] of Object.entries(quotes)) trails[s] = extendTrail(before[s] ?? [], q);
            return { status: "ok", asOf: body.as_of, quotes, missing: body.missing ?? [], receivedAt: Date.now(), trails };
          });
        return "ok";
      } catch {
        if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
        return "error";
      }
    };
    const stop = startPoll({
      run,
      page: document,
      show: window,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: POLL_MS,
      retryMs: RETRY_MS,
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [symbols, enabled]);

  return feed;
}
