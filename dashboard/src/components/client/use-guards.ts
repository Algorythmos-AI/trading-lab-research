"use client";

// The bad-data guards' switches for the open Options page (desk-guards.ts): the server render's read first, then, while
// the live board is on, /api/desk/guards again every GUARDS_REREAD_MS and whenever the tab comes back, so a switch the
// owner turns on or off reaches the page without a reload. A read that fails, or answers anything but the switches,
// is every guard off: the server check reads a failed read the same way, so the two never differ by it.
import { useEffect, useState } from "react";
import { type GuardSwitches, parseGuardAnswer } from "@/lib/desk-guards";
import type { GuardReason } from "@/lib/quote-guards";

const URL_GUARDS = "/api/desk/guards";
export const GUARDS_REREAD_MS = 60_000;
const NONE: readonly GuardReason[] = [];

async function readGuards(): Promise<GuardSwitches | null> {
  try {
    const res = await fetch(URL_GUARDS, { cache: "no-store", credentials: "same-origin" });
    return res.ok ? parseGuardAnswer(await res.json()) : null;
  } catch {
    return null;
  }
}

/** The guards switched on: `initial` (the server render's) until the first read, then the latest read's. */
export function useGuardSwitches(initial: readonly GuardReason[], polling: boolean): readonly GuardReason[] {
  const [on, setOn] = useState<readonly GuardReason[]>(initial);
  useEffect(() => {
    if (!polling) return;
    let live = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      void readGuards().then((s) => {
        if (!live) return;
        const next = s?.on ?? NONE;
        // The same switches keep the same array, so the board does not redraw for a read that changed nothing.
        setOn((cur) => (cur.length === next.length && cur.every((g, i) => g === next[i]) ? cur : next));
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
  return on;
}
