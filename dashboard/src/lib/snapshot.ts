import "server-only";
import { cache } from "react";
import { LATEST_PATH, readText } from "./blob";
import { logEvent } from "./log";
import type { Snapshot } from "./types";

export type SnapshotResult =
  | { status: "ok"; snapshot: Snapshot; etag: string | null; source: "fixture" | "blob" }
  | { status: "missing" }
  | { status: "error" };

/** Fixture mode serves the synthetic v3 test snapshot. It is refused on production deployments. */
export function fixtureMode(): boolean {
  return process.env.DASHBOARD_FIXTURE === "1" && process.env.VERCEL_ENV !== "production";
}

async function loadFixture(): Promise<Snapshot> {
  const mod = await import("../../test/fixtures/snapshot.v3.json");
  return (mod.default ?? mod) as unknown as Snapshot;
}

/** Reads the latest snapshot. Deduplicated per request; never cached across requests. */
export const loadSnapshot = cache(async (): Promise<SnapshotResult> => {
  if (fixtureMode()) {
    return { status: "ok", snapshot: await loadFixture(), etag: null, source: "fixture" };
  }
  try {
    const stored = await readText(LATEST_PATH);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logEvent("snapshot.read", { outcome: "not-an-object" });
      return { status: "error" };
    }
    return { status: "ok", snapshot: parsed as Snapshot, etag: stored.etag, source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

/** `{snapshot, etag}` or null, for callers that only care whether a snapshot exists. */
export async function getSnapshot(): Promise<{ snapshot: Snapshot; etag: string | null } | null> {
  const r = await loadSnapshot();
  return r.status === "ok" ? { snapshot: r.snapshot, etag: r.etag } : null;
}
