"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { QUIET_MS, refreshTurn } from "@/lib/refresh-guard";

/**
 * Re-fetches the server components every minute while the tab is visible, and when it is shown again. The refresh is
 * a transition, so the page keeps answering clicks while it is drawn; a turn that finds the last one still being
 * drawn skips, and one that lands while the owner is clicking or typing waits QUIET_MS (at most MAX_HOLDS times in a
 * row, so the page never goes stale). lib/refresh-guard.ts.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    let lastInput = -Infinity;
    let holds = 0;
    let retry: number | undefined;
    const onInput = () => {
      lastInput = performance.now();
    };
    const turn = () => {
      if (document.visibilityState !== "visible") return;
      const t = refreshTurn(pendingRef.current, performance.now() - lastInput, holds);
      if (t === "skip") return;
      if (t === "hold") {
        holds++;
        window.clearTimeout(retry);
        retry = window.setTimeout(turn, QUIET_MS);
        return;
      }
      holds = 0;
      startTransition(() => router.refresh());
    };
    const id = window.setInterval(turn, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") turn();
    };
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    };
  }, [router, intervalMs]);
  return null;
}
