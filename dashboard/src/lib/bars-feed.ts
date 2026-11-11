// What the "Trade now" board reads from its session bars poll (/api/bars): the feed's shape and how long its last
// good answer may be used. The poll itself (timers, fetch, the waits after failures) is lib/bars-poller.ts, which the
// desk engine does not import, so a change to the poll's timing never changes the engine's version (DEC-0044).
// Research only; nothing here places an order.
import type { Bar2 } from "./trade-state";

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
