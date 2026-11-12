"use client";

// The bad-data guards' switches for the open Options page (desk-guards.ts): the server render's read first, then, while
// the live board is on, /api/desk/guards again every GUARDS_REREAD_MS and whenever the tab comes back, so a switch the
// owner turns on or off reaches the page without a reload.
//
// A read that fails, answers anything but the switches, says the store could not be read, or takes longer than
// GUARDS_READ_TIMEOUT_MS keeps the last good switches: a store that blinks does not drop a guard the owner turned on.
// Until a good read there is none to keep, and every guard is off (the server check reads a failed read that way too).
// While the page holds switches it could not confirm, `unsure` is true, and the page's shadow post says so, so the
// comparison counts that slot as a switch mismatch rather than a disagreement about the data.
import { useEffect, useState } from "react";
import { type GuardSwitches, parseGuardAnswer, type SwitchRead } from "@/lib/desk-guards";
import type { GuardReason } from "@/lib/quote-guards";

const URL_GUARDS = "/api/desk/guards";
export const GUARDS_REREAD_MS = 60_000;
export const GUARDS_READ_TIMEOUT_MS = 5_000;
const NONE: readonly GuardReason[] = [];

export interface GuardHold {
  on: readonly GuardReason[];
  /** There has been a good read (the render's or the page's). */
  good: boolean;
  /** The last read failed after a good one: `on` is the last good read's, not confirmed. */
  unsure: boolean;
}

/** A read that gave the switches: anything but "error". */
export const goodRead = (status: SwitchRead | null | undefined): boolean => status === "ok" || status === "missing" || status === "malformed";

/**
 * The next hold after one read. `read` null: the read failed (transport, timeout, an answer that is not the switches).
 * Pure, so its rules are tested without a browser.
 */
export function nextHold(cur: GuardHold, read: GuardSwitches | null): GuardHold {
  if (read && goodRead(read.status)) {
    const same = cur.on.length === read.on.length && cur.on.every((g, i) => g === read.on[i]);
    return same && cur.good && !cur.unsure ? cur : { on: same ? cur.on : read.on, good: true, unsure: false };
  }
  if (!cur.good) return cur.on.length === 0 && !cur.unsure ? cur : { on: NONE, good: false, unsure: false };
  return cur.unsure ? cur : { ...cur, unsure: true };
}

/** The first hold, from the server render's read. */
export const firstHold = (on: readonly GuardReason[], status: SwitchRead | null | undefined): GuardHold =>
  goodRead(status) ? { on, good: true, unsure: false } : { on: NONE, good: false, unsure: false };

async function readGuards(): Promise<GuardSwitches | null> {
  try {
    const res = await fetch(URL_GUARDS, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(GUARDS_READ_TIMEOUT_MS) });
    return res.ok ? parseGuardAnswer(await res.json()) : null;
  } catch {
    return null;
  }
}

/** The guards switched on, and whether they are unconfirmed: the render's read until the page's first, then the latest. */
export function useGuardSwitches(initial: readonly GuardReason[], initialStatus: SwitchRead | null | undefined, polling: boolean): GuardHold {
  const [hold, setHold] = useState<GuardHold>(() => firstHold(initial, initialStatus));
  useEffect(() => {
    if (!polling) return;
    let live = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      void readGuards().then((s) => {
        if (live) setHold((cur) => nextHold(cur, s));
      });
    };
    read();
    const id = window.setInterval(read, GUARDS_REREAD_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", read);
    };
  }, [polling]);
  return hold;
}
