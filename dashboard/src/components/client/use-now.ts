"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The current time, re-read every `intervalMs`. Null during server render and hydration, so
 * time-dependent text is only ever produced in the browser (no hydration mismatch).
 */
export function useNow(intervalMs = 1000): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const id = window.setInterval(onChange, intervalMs);
      return () => window.clearInterval(id);
    },
    [intervalMs],
  );
  const bucket = useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / intervalMs),
    () => null,
  );
  return bucket === null ? null : bucket * intervalMs;
}
