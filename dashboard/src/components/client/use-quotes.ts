"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type DataFeed, isDataFeed } from "@/lib/feed-provenance";
import { extendTrail, type LiveQuote, type TrailPoint } from "@/lib/options";
import { type Backoff, type Poll, type PollResult, startPoll, statusResult } from "@/lib/quote-poll";

export const POLL_MS = 2_000;
/** The longest wait after failures in a row (2, 4, 8, 16 s, then this). */
export const QUOTES_RETRY_CAP_MS = 30_000;
/** While the tab is hidden and an alert is on: a fetch every this long, well inside the board's 20 s stale limit. */
export const HIDDEN_POLL_MS = 10_000;

export type Feed =
  | { status: "loading" }
  /** `why` "feed": the server refused its ALPACA_FEED setting; "plan": SIP is set but not on the data plan; otherwise
   * the keys are not set. */
  | { status: "off"; why?: "feed" | "plan" }
  | { status: "error" }
  | {
      status: "ok";
      asOf: string;
      /** The stock feed the answer says it was read from; null when it named none (an older answer): never guessed. */
      source: DataFeed | null;
      quotes: Record<string, LiveQuote>;
      missing: string[];
      /** Browser time of the last answer, so a feed that stops answering reads as stale. */
      receivedAt: number;
      /** Each name's prices seen on this page over the last few minutes, oldest first. */
      trails: Record<string, TrailPoint[]>;
    };

export interface QuoteFeed {
  feed: Feed;
  /** Waiting to try again after failing (the browser's clock); null while the feed is healthy. */
  backoff: Backoff | null;
  /** One attempt now while waiting after a failure; nothing otherwise. */
  retryNow: () => void;
}

/**
 * Polls /api/quote (same origin, so the page's connect-src 'self' holds) every 2 seconds while the tab is visible
 * (and, while `background.current` is true, every 10 s while it is hidden, so the board's alerts can still ring),
 * and at once when it is shown again (lib/quote-poll.ts: one request at a time). After a failure it tries again in
 * 2 s, then 4, 8, 16 and at most 30 s while the failures go on, and at the 30 s straight away when upstream asks it to
 * slow down (429); the first answer puts it back on 2 seconds. `enabled` false (an old edition) never polls.
 * Research only.
 */
export function useQuoteFeed(symbols: string, enabled = true, background?: { readonly current: boolean }): QuoteFeed {
  const [feed, setFeed] = useState<Feed>({ status: enabled ? "loading" : "off" });
  const [backoff, setBackoff] = useState<Backoff | null>(null);
  const poll = useRef<Poll | null>(null);
  const retryNow = useCallback(() => poll.current?.retryNow(), []);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const run = async (): Promise<PollResult> => {
      try {
        const res = await fetch(`/api/quote?s=${encodeURIComponent(symbols)}`, { cache: "no-store" });
        const r = statusResult(res.status);
        if (r === "off") {
          // not configured: no point polling until the page is reloaded. Any prices held are dropped with it.
          const why = await res
            .json()
            .then((b: { why?: unknown }) => (b?.why === "feed" || b?.why === "plan" ? (b.why as "feed" | "plan") : undefined))
            .catch(() => undefined);
          if (!stopped) setFeed(why ? { status: "off", why } : { status: "off" });
          return "off";
        }
        if (r !== "ok") {
          if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
          return r; // "limited" (429) waits the cap; anything else the doubling wait
        }
        const body = (await res.json()) as { as_of: string; feed?: unknown; quotes: Record<string, LiveQuote>; missing?: string[] };
        const quotes = body.quotes ?? {};
        if (!stopped)
          setFeed((f) => {
            const before = f.status === "ok" ? f.trails : {};
            const trails: Record<string, TrailPoint[]> = {};
            for (const [s, q] of Object.entries(quotes)) trails[s] = extendTrail(before[s] ?? [], q);
            const source = isDataFeed(body.feed) ? body.feed : null;
            return { status: "ok", asOf: body.as_of, source, quotes, missing: body.missing ?? [], receivedAt: Date.now(), trails };
          });
        return "ok";
      } catch {
        if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
        return "error";
      }
    };
    const p = startPoll({
      run,
      page: document,
      show: window,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: POLL_MS,
      backoff: { capMs: QUOTES_RETRY_CAP_MS },
      onBackoff: setBackoff,
      // Read by the poll at each turn, so turning an alert on or off never restarts it.
      hiddenMs: () => (background?.current ? HIDDEN_POLL_MS : null),
    });
    poll.current = p;
    return () => {
      stopped = true;
      p.stop();
      if (poll.current === p) poll.current = null;
      setBackoff(null);
    };
  }, [symbols, enabled]);

  return { feed, backoff: enabled ? backoff : null, retryNow };
}

/** The feed alone, for a part of a page that only reads prices. */
export function useQuotes(symbols: string, enabled = true): Feed {
  return useQuoteFeed(symbols, enabled).feed;
}
