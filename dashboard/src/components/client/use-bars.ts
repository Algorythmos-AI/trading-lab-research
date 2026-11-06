"use client";

import { useEffect, useRef, useState } from "react";
import { type BarsFeed, barsPoller, barsUrl } from "@/lib/bars-feed";

export { BARS_POLL_MS, BARS_STALE_MS, type BarsFeed } from "@/lib/bars-feed";

/**
 * Polls /api/bars (same origin, so the page's connect-src 'self' holds) every 30 seconds while the tab is visible,
 * for the session's 2-minute bars since 09:30 (to 13:00 on a half day). A hidden tab parks the poll; coming back
 * fetches at once. `slot` (the 2-minute slot of the newest quote) fetches again as soon as it moves on, so a bar
 * that has just closed comes from the server and not only from the page's own prices; a kick during a fetch is
 * queued, not dropped. `enabled` false never polls. The poll itself is lib/bars-feed.ts. Research only.
 */
export function useBars(symbols: string, enabled = true, slot: number | null = null, halfDay = false): BarsFeed {
  // Loading until the first answer, however late the board turns the poll on.
  const [feed, setFeed] = useState<BarsFeed>({ status: "loading" });
  const kick = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const poll = barsPoller({
      url: barsUrl(symbols, halfDay),
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      visible: () => document.visibilityState === "visible",
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
      onFeed: setFeed,
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") poll.kick();
    };
    kick.current = poll.kick;
    document.addEventListener("visibilitychange", onVisible);
    poll.start();
    return () => {
      poll.stop();
      kick.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [symbols, enabled, halfDay]);

  // A new 2-minute slot on the quote's clock: the bar before it has closed.
  const lastSlot = useRef<number | null>(slot);
  useEffect(() => {
    if (slot === null || slot === lastSlot.current) return;
    const first = lastSlot.current === null;
    lastSlot.current = slot;
    if (!first) kick.current?.();
  }, [slot]);

  return enabled ? feed : { status: "off" };
}
