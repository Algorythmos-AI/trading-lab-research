"use client";

import { useEffect, useState } from "react";
import { extendTrail, type LiveQuote, type TrailPoint } from "@/lib/options";

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
 * Polls /api/quote (same origin, so the page's connect-src 'self' holds) every 2 seconds while the tab is visible.
 * `enabled` false (an old edition) never polls. Research only.
 */
export function useQuotes(symbols: string, enabled = true): Feed {
  const [feed, setFeed] = useState<Feed>({ status: enabled ? "loading" : "off" });

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let stopped = false;
    const load = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(load, POLL_MS);
        return;
      }
      let next = POLL_MS;
      try {
        const res = await fetch(`/api/quote?s=${encodeURIComponent(symbols)}`, { cache: "no-store" });
        if (res.status === 503) {
          if (!stopped) setFeed({ status: "off" });
          return; // not configured: no point polling until the page is reloaded
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
      } catch {
        if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
        next = RETRY_MS;
      }
      if (!stopped) timer = window.setTimeout(load, next);
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [symbols, enabled]);

  return feed;
}
