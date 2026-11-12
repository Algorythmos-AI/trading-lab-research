"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { PriceStatus } from "@/lib/price-pill";

// One page-wide reading of the Options page's price poll, so the site header (outside the page's tree) can show it.
// The live layer publishes; the header reads. Null whenever no page is polling, and on the server.

let current: PriceStatus | null = null;
const listeners = new Set<() => void>();

function set(next: PriceStatus | null) {
  current = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Publishes the poll's state while the caller is mounted and `active`; clears it on unmount or when inactive. */
export function usePublishPriceStatus(active: boolean, status: PriceStatus["status"], source: PriceStatus["source"], receivedAt: number | null, retrying: boolean) {
  useEffect(() => {
    if (!active) return;
    set({ status, source, receivedAt, retrying });
  }, [active, status, source, receivedAt, retrying]);
  useEffect(() => {
    if (!active) return;
    return () => set(null);
  }, [active]);
}

/** The published poll state, or null when no page is polling. */
export function usePriceStatus(): PriceStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
