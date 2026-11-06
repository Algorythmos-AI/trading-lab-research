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

/**
 * The browser's monotonic clock (`performance.now()`, ms), re-read every `intervalMs`: for measuring how long ago
 * something reached the page. Unlike the wall clock it never steps back when the computer's time is changed, so an
 * old answer cannot be made to look new. Null during server render and hydration.
 */
export function usePerfNow(intervalMs = 1000): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const id = window.setInterval(onChange, intervalMs);
      return () => window.clearInterval(id);
    },
    [intervalMs],
  );
  const bucket = useSyncExternalStore(
    subscribe,
    () => Math.floor(performance.now() / intervalMs),
    () => null,
  );
  return bucket === null ? null : bucket * intervalMs;
}
