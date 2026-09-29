"use client";

import { describeAge } from "@/lib/freshness";
import { useNow } from "./use-now";

/** "12 min ago" computed in the browser; the server-rendered `fallback` shows until then. */
export function RelativeTime({ iso, fallback }: { iso: string | null | undefined; fallback: string }) {
  const nowMs = useNow(30_000);
  const t = iso ? Date.parse(iso) : NaN;
  const text = nowMs !== null && Number.isFinite(t) ? describeAge(Math.max(0, (nowMs - t) / 60_000)) : fallback;
  return (
    <time dateTime={iso ?? undefined} title={iso ?? undefined}>
      {text}
    </time>
  );
}
