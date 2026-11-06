// The poll behind the "Trade now" board's session bars (/api/bars), with no React and no DOM in it, so it can be run
// in a test: the hook in components/client/use-bars.ts hands it the browser's fetch, clock, timers and visibility.
// Research only; nothing here places an order.
import type { Bar2 } from "./trade-state";

export const BARS_POLL_MS = 30_000;
export const BARS_RETRY_MS = 60_000;
/** The board stops using the server's bars once its last good answer is older than this (browser clock). */
export const BARS_STALE_MS = 90_000;

export type BarsFeed =
  | { status: "loading" }
  | { status: "off" }
  | { status: "error" }
  | {
      status: "ok";
      asOf: string;
      bars: Record<string, Bar2[]>;
      /** When the server read each name's bars upstream (ms, the server's clock). */
      fetchedAt: Record<string, number>;
      /** When this browser got the answer (ms, the browser's clock). */
      receivedAt: number;
      /** The latest poll failed: these are the last good bars, kept for their age only. */
      failed: boolean;
    };

/** The bars route for these names; `half=1` on a half day, so no bar after 13:00 is a session bar. */
export function barsUrl(symbols: string, halfDay: boolean): string {
  return `/api/bars?s=${encodeURIComponent(symbols)}${halfDay ? "&half=1" : ""}`;
}

export interface BarsPollerDeps {
  url: string;
  fetch: typeof fetch;
  now: () => number;
  visible: () => boolean;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number | undefined) => void;
  onFeed: (feed: BarsFeed) => void;
}

/**
 * Polls every BARS_POLL_MS while visible (BARS_RETRY_MS after a failure); a hidden page parks the poll. A 503 means
 * not configured: it stops. A failure after good bars keeps them marked `failed`, so the board can stop using them.
 * `kick` fetches now; a kick while a fetch is in flight is not dropped: one more fetch follows straight after it.
 */
export function barsPoller(d: BarsPollerDeps): { start: () => void; stop: () => void; kick: () => void } {
  let timer: number | undefined;
  let stopped = false;
  let busy = false;
  let again = false;
  let feed: BarsFeed = { status: "loading" };
  const emit = (f: BarsFeed) => {
    feed = f;
    if (!stopped) d.onFeed(f);
  };
  const load = async (): Promise<void> => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    d.clearTimer(timer);
    if (!d.visible()) {
      timer = d.setTimer(() => void load(), BARS_POLL_MS);
      return;
    }
    busy = true;
    let next = BARS_POLL_MS;
    try {
      const res = await d.fetch(d.url, { cache: "no-store" });
      if (res.status === 503) {
        emit({ status: "off" });
        again = false;
        return; // not configured: no point polling until the page is reloaded
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { as_of: string; bars?: Record<string, Bar2[]>; fetchedAt?: Record<string, number> };
      emit({ status: "ok", asOf: body.as_of, bars: body.bars ?? {}, fetchedAt: body.fetchedAt ?? {}, receivedAt: d.now(), failed: false });
    } catch {
      emit(feed.status === "ok" ? { ...feed, failed: true } : { status: "error" });
      next = BARS_RETRY_MS;
    } finally {
      busy = false;
    }
    if (stopped) return;
    if (again) {
      again = false;
      return load();
    }
    timer = d.setTimer(() => void load(), next);
  };
  return {
    start: () => void load(),
    stop: () => {
      stopped = true;
      d.clearTimer(timer);
    },
    kick: () => void load(),
  };
}
