"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar2 } from "@/lib/trade-state";

export const BARS_POLL_MS = 30_000;
const RETRY_MS = 60_000;

export type BarsFeed =
  | { status: "loading" }
  | { status: "off" }
  | { status: "error" }
  | { status: "ok"; asOf: string; bars: Record<string, Bar2[]>; receivedAt: number };

/**
 * Polls /api/bars (same origin, so the page's connect-src 'self' holds) every 30 seconds while the tab is visible,
 * for the session's 2-minute bars since 09:30. A hidden tab parks the poll; coming back fetches at once. `slot`
 * (the 2-minute slot of the newest quote) fetches again as soon as it moves on, so a bar that has just closed comes
 * from the server and not only from the page's own prices. `enabled` false never polls. Research only.
 */
export function useBars(symbols: string, enabled = true, slot: number | null = null): BarsFeed {
  // Loading until the first answer, however late the board turns the poll on.
  const [feed, setFeed] = useState<BarsFeed>({ status: "loading" });
  const kick = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let stopped = false;
    let busy = false;
    const load = async () => {
      if (stopped) return;
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(load, BARS_POLL_MS);
        return;
      }
      if (busy) return;
      busy = true;
      let next = BARS_POLL_MS;
      try {
        const res = await fetch(`/api/bars?s=${encodeURIComponent(symbols)}`, { cache: "no-store" });
        if (res.status === 503) {
          if (!stopped) setFeed({ status: "off" });
          return; // not configured: no point polling until the page is reloaded
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { as_of: string; bars?: Record<string, Bar2[]> };
        if (!stopped) setFeed({ status: "ok", asOf: body.as_of, bars: body.bars ?? {}, receivedAt: Date.now() });
      } catch {
        if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
        next = RETRY_MS;
      } finally {
        busy = false;
      }
      if (!stopped) timer = window.setTimeout(load, next);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    kick.current = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      stopped = true;
      kick.current = null;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [symbols, enabled]);

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
