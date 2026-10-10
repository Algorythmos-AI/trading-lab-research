import "server-only";
import { cache } from "react";
import { LATEST_PATH, listPaths, readText } from "./blob";
import type { CryptoSnapshot } from "./crypto.types";
import { DESK_PATHS, OPTIONS_LIVE_PATHS, OPTIONS_PATHS, RADAR_PATHS } from "./desk";
import { fixtureOptionsLive, parseFlags, partialOptions, poisonedOptions, v2Options, VARIANT_COOKIE, type VariantFlag } from "./fixture-variants";
import type { HftSnapshot } from "./hft.types";
import { logEvent } from "./log";
import type { OptionsLive } from "./options-live.types";
import type { OptionsEdition } from "./options.types";
import { radarDates } from "./radar";
import type { RadarEdition } from "./radar.types";
import type { Snapshot } from "./types";

export type SnapshotResult =
  | { status: "ok"; snapshot: Snapshot; etag: string | null; source: "fixture" | "blob" }
  | { status: "missing" }
  | { status: "error" };

/** Fixture mode serves the synthetic v3 test snapshot. It is refused on production deployments. */
export function fixtureMode(): boolean {
  return process.env.DASHBOARD_FIXTURE === "1" && process.env.VERCEL_ENV !== "production";
}

/**
 * The fixture variant flags for this request, from the `fx` cookie (see fixture-variants.ts). Always empty outside
 * fixture mode, so production never reads the cookie, and empty where there is no request (a unit test).
 */
export async function fixtureFlags(): Promise<Set<VariantFlag>> {
  if (!fixtureMode()) return new Set();
  try {
    const { cookies } = await import("next/headers");
    return parseFlags((await cookies()).get(VARIANT_COOKIE)?.value);
  } catch {
    return new Set();
  }
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

export type CryptoResult =
  | { status: "ok"; snapshot: CryptoSnapshot; source: "fixture" | "blob" }
  | { status: "missing" }
  | { status: "error" };

/** The crypto desk's latest snapshot (ADR 0005). "missing" until the desk has published for the first time. */
export const loadCryptoSnapshot = cache(async (): Promise<CryptoResult> => {
  if (fixtureMode()) {
    const mod = await import("../../test/fixtures/crypto.v1.json");
    return { status: "ok", snapshot: (mod.default ?? mod) as unknown as CryptoSnapshot, source: "fixture" };
  }
  try {
    const stored = await readText(DESK_PATHS.crypto.latest);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logEvent("snapshot.read", { outcome: "not-an-object", desk: "crypto" });
      return { status: "error" };
    }
    return { status: "ok", snapshot: parsed as CryptoSnapshot, source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "crypto", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

export type HftResult =
  | { status: "ok"; snapshot: HftSnapshot; source: "fixture" | "blob" }
  | { status: "missing" }
  | { status: "error" };

/**
 * The HFT desk's latest snapshot (ADR 0006). "missing" until the desk has published for the first time. In fixture
 * mode the `empty` and `error` variants stand for that and for unreadable storage, so both states can be looked at.
 */
export const loadHftSnapshot = cache(async (): Promise<HftResult> => {
  if (fixtureMode()) {
    const flags = await fixtureFlags();
    if (flags.has("empty")) return { status: "missing" };
    if (flags.has("error")) return { status: "error" };
    const mod = await import("../../test/fixtures/hft.v1.json");
    return { status: "ok", snapshot: (mod.default ?? mod) as unknown as HftSnapshot, source: "fixture" };
  }
  try {
    const stored = await readText(DESK_PATHS.hft.latest);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logEvent("snapshot.read", { outcome: "not-an-object", desk: "hft" });
      return { status: "error" };
    }
    return { status: "ok", snapshot: parsed as HftSnapshot, source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "hft", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

export type RadarResult =
  | { status: "ok"; edition: RadarEdition; source: "fixture" | "blob" }
  | { status: "missing" }
  | { status: "error" };

/**
 * A pre-market radar edition: the newest one, or the one for `date` (YYYY-MM-DD). "missing" until the radar has
 * published, or when that date has no edition.
 */
export const loadRadar = cache(async (date?: string): Promise<RadarResult> => {
  if (fixtureMode()) {
    const mod = await import("../../test/fixtures/radar.v1.json");
    return { status: "ok", edition: (mod.default ?? mod) as unknown as RadarEdition, source: "fixture" };
  }
  const path = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${RADAR_PATHS.history}${date}.json` : RADAR_PATHS.latest;
  try {
    const stored = await readText(path);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logEvent("snapshot.read", { outcome: "not-an-object", desk: "radar" });
      return { status: "error" };
    }
    return { status: "ok", edition: parsed as RadarEdition, source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "radar", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

/** Edition dates on file, newest first (at most `max`). An empty list when storage cannot be listed. */
export async function listRadarDates(max = 30): Promise<string[]> {
  if (fixtureMode()) return [];
  try {
    const paths = await listPaths(RADAR_PATHS.history);
    return radarDates(paths.map((p) => p.pathname), RADAR_PATHS.history).slice(0, max);
  } catch (e) {
    logEvent("radar.list", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return [];
  }
}

export type OptionsResult =
  | { status: "ok"; edition: OptionsEdition; source: "fixture" | "blob" }
  | { status: "missing" }
  | { status: "error" };

/**
 * An options levels edition: the newest one, or the one built for session `date` (YYYY-MM-DD). "missing" until
 * the after-close run has published, or when that session has no edition.
 */
export const loadOptions = cache(async (date?: string): Promise<OptionsResult> => {
  if (fixtureMode()) {
    const flags = await fixtureFlags();
    if (flags.has("empty")) return { status: "missing" };
    if (flags.has("error")) return { status: "error" };
    const mod = await import("../../test/fixtures/options.v1.json");
    const base = (mod.default ?? mod) as unknown as OptionsEdition;
    const shaped = flags.has("v2") ? v2Options(base) : base;
    const edition = flags.has("poison") ? poisonedOptions(shaped) : flags.has("partial") ? partialOptions(shaped) : shaped;
    return { status: "ok", edition, source: "fixture" };
  }
  const path = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${OPTIONS_PATHS.history}${date}.json` : OPTIONS_PATHS.latest;
  try {
    const stored = await readText(path);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logEvent("snapshot.read", { outcome: "not-an-object", desk: "options" });
      return { status: "error" };
    }
    return { status: "ok", edition: parsed as OptionsEdition, source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "options", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

export type OptionsLiveResult = { status: "ok"; doc: OptionsLive; source: "fixture" | "blob" } | { status: "missing" } | { status: "error" };

/**
 * The options live document: the paper account's open option positions and open interest. "missing" until the
 * options-live job has published once.
 */
export const loadOptionsLive = cache(async (): Promise<OptionsLiveResult> => {
  if (fixtureMode()) {
    const flags = await fixtureFlags();
    if (flags.has("positions-off") || flags.has("empty") || flags.has("error")) return { status: "missing" };
    const mod = await import("../../test/fixtures/options.v1.json");
    return { status: "ok", doc: fixtureOptionsLive((mod.default ?? mod) as unknown as OptionsEdition, new Date(), flags), source: "fixture" };
  }
  try {
    const stored = await readText(OPTIONS_LIVE_PATHS.latest);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logEvent("snapshot.read", { outcome: "not-an-object", desk: "options-live" });
      return { status: "error" };
    }
    return { status: "ok", doc: parsed as OptionsLive, source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "options-live", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

/** Session dates with an options edition, newest first (at most `max`). Empty when storage cannot be listed. */
export async function listOptionsDates(max = 30): Promise<string[]> {
  if (fixtureMode()) return [];
  try {
    const paths = await listPaths(OPTIONS_PATHS.history);
    return radarDates(paths.map((p) => p.pathname), OPTIONS_PATHS.history).slice(0, max);
  } catch (e) {
    logEvent("options.list", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return [];
  }
}
