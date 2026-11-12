"use client";

// The page's side of the server's shadow check (DEC-0044, section 2); the rules are in lib/desk-shadow-client.ts.
// The server render says whether the store's switch is on. While it is off (the default) nothing here is built,
// nothing is drawn and no request is made. While it is on, the open Options page reads the status at most once a
// minute and sends its own states once per settled slot, and the rail says when the server has stopped logging.
//
// What is sent: the slot, the engine's label, when the page took its states and whether its session bars were late,
// and per focus name and side the state word (as of the slot, and again at settle), or `hidden: true`. Never a price,
// a level, a typed value, a note or a fill.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { BAR_MS, expectedSlots } from "@/lib/desk-eval";
import { DeskShadowCore, type EvalStatus, STATUS_EVERY_MS } from "@/lib/desk-shadow-client";
import { newYork } from "@/lib/format";
import { nyInstant, OPEN_MIN } from "@/lib/options";
import type { GuardReason } from "@/lib/quote-guards";
import type { NameState } from "@/lib/trade-state";
import { SERVER_SETTLE_MS } from "@/lib/trade-state";
import { useBoard } from "./trade-now";

export { parseEvalStatus, type EvalStatus } from "@/lib/desk-shadow-client";

/** The server's check is paused once its last slot settled this long before the status was read. */
export const PAUSED_AFTER_MS = 3 * 60_000;
/** A status read older than this is not trusted to say anything. */
const STATUS_TRUST_MS = 3 * STATUS_EVERY_MS;

/**
 * The rail's line, or null when there is nothing to say: the switch is off, the read is unknown or old, or the
 * server's last slot settled less than PAUSED_AFTER_MS before the read. Only in the session of `session`.
 */
export function pausedLine(st: EvalStatus | null, session: string, now: number | null): string | null {
  if (!st || st.eval !== "log" || now === null || now - st.readAt > STATUS_TRUST_MS) return null;
  const slots = expectedSlots(session);
  const open = nyInstant(session, OPEN_MIN);
  if (!slots.length || open === null) return null;
  const close = slots[slots.length - 1]! + BAR_MS + SERVER_SETTLE_MS;
  if (st.readAt < open || st.readAt >= close) return null;
  // Before the first slot, as if one had ended at the open: the first is due a minute after it settles.
  const base = st.last ?? open;
  if (st.readAt - (base + SERVER_SETTLE_MS) <= PAUSED_AFTER_MS) return null;
  return st.last === null ? "Server check paused: no recent slot logged" : `Server check paused since ${newYork(new Date(st.last).toISOString(), false)} NY`;
}

// One status for the page, written by the board's core and read by the rail's line.
let status: EvalStatus | null = null;
const listeners = new Set<() => void>();
const publish = (s: EvalStatus) => {
  status = s;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useEvalStatus(): EvalStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => null,
  );
}

/**
 * The board's hook (BoardProvider). `enabled`: the switch as the server render read it; off, nothing is built and no
 * request is made. `reading`: the session's board is drawn (status reads run only then). `live`: the board is live
 * and its bars have answered. `now` is the board's (server) clock, `browserNow` the browser's.
 */
export function useDeskShadow({
  enabled,
  reading,
  live,
  session,
  states,
  now,
  browserNow,
  barsDelayed,
  guards = [],
  guardsUnsure = false,
}: {
  enabled: boolean;
  reading: boolean;
  live: boolean;
  session: string;
  states: readonly NameState[];
  now: number | null;
  browserNow: number | null;
  barsDelayed: boolean;
  /** The bad-data guards the board's states were worked out with: sent beside them, so a slot is compared only against a server record with the same switches. */
  guards?: readonly GuardReason[];
  /** The page holds switches it could not confirm (use-guards.ts): the slot is sent marked so. */
  guardsUnsure?: boolean;
}): void {
  const core = useRef<DeskShadowCore | null>(null);
  const on = enabled && reading;
  useEffect(() => {
    if (!on) return;
    const c = new DeskShadowCore({
      fetch: (url, init) => fetch(url, init),
      browserNow: () => Date.now(),
      visible: () => document.visibilityState === "visible",
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id as number),
      publish,
    });
    core.current = c;
    c.start();
    const onVis = () => c.onVisibility();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      c.stop();
      document.removeEventListener("visibilitychange", onVis);
      core.current = null;
    };
  }, [on]);
  useEffect(() => {
    core.current?.tick({ live, session, states, now, browserNow, barsDelayed, guards, guardsUnsure });
  });
}

/** "Server check paused since 10:42 NY" on the rail's status line; nothing at all while the check is fine or off. */
export function ServerCheckNote() {
  const b = useBoard();
  const st = useEvalStatus();
  if (!b || !b.on || (b.mode.kind !== "live" && b.mode.kind !== "opening")) return null;
  const line = pausedLine(st, b.session, b.now);
  if (!line) return null;
  return (
    <p role="status" data-rail-server-check className="text-explain text-warn font-medium max-sm:col-span-2">
      {line}
    </p>
  );
}
