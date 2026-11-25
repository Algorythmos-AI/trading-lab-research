// The Reference Registry's stored indexes: one per branch, written by /api/ingest (key id `registry`) and read by the
// Research records pages. See dashboard/README.md, "Reference Registry".
import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { PreconditionFailed, readForUpdate, readText, storedAt, writeText } from "./blob";
import { logEvent } from "./log";
import type { RegistryIndex } from "./registry.types";
import { validateRegistry } from "./validate";

export const REGISTRY_BRANCHES = ["integration", "main"] as const;
export type RegistryBranch = (typeof REGISTRY_BRANCHES)[number];

export function isRegistryBranch(v: unknown): v is RegistryBranch {
  return typeof v === "string" && (REGISTRY_BRANCHES as readonly string[]).includes(v);
}

/**
 * `latest`: the newest index for the branch. `checked`: the last time the job confirmed it (a stored index, or a
 * resend of the same commit's index), so a Refresh on an unchanged branch still moves "last successful sync".
 */
export function registryPaths(branch: RegistryBranch): { latest: string; checked: string } {
  return { latest: `registry/${branch}/latest.json`, checked: `registry/${branch}/checked.json` };
}

export type RegistryLoad =
  | { status: "ok"; doc: RegistryIndex; storedAt: string | null; checkedAt: string | null; source: "blob" | "fixture" }
  | { status: "missing" }
  | { status: "error" };

/** When the job last confirmed this branch's index. Best effort: a failure here never changes ingest's answer. */
export async function markChecked(branch: RegistryBranch, runId: string, at: string): Promise<void> {
  try {
    await writeText(registryPaths(branch).checked, JSON.stringify({ run_id: runId, at }));
  } catch (e) {
    logEvent("ingest.registry", { outcome: "checked-error", branch, error: e instanceof Error ? e.name : "unknown" });
  }
}

export type StoreOutcome =
  | { kind: "stored"; supersedes: boolean; attempt: number }
  | { kind: "duplicate" }
  | { kind: "older" }
  | { kind: "conflict" };

/**
 * Store one validated index in its branch's slot. The same run (branch and commit) is a `duplicate`; an index whose
 * `as_of` (its commit's time) is before the stored one is `older`; a stored one ordered beyond the clock's allowance
 * gives way. The write is conditional on the store's etag and retried once.
 */
export async function storeRegistryIndex(
  doc: RegistryIndex,
  text: string,
  asOf: number,
  isStoredAhead: (storedAsOf: number) => boolean,
  orderInstant: (s: string) => number | null,
): Promise<StoreOutcome> {
  const { latest } = registryPaths(doc.branch);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readForUpdate(latest);
    let supersedes = false;
    if (current) {
      let held: { run_id?: unknown; as_of?: unknown } | null = null;
      try {
        held = JSON.parse(current.text) as { run_id?: unknown; as_of?: unknown };
      } catch {
        held = null;
      }
      if (held?.run_id === doc.run_id) return { kind: "duplicate" };
      const heldAsOf = typeof held?.as_of === "string" ? orderInstant(held.as_of) : null;
      if (heldAsOf !== null && asOf < heldAsOf) {
        if (!isStoredAhead(heldAsOf)) return { kind: "older" };
        supersedes = true;
      }
    }
    try {
      await writeText(latest, text, current ? { ifMatch: current.etag } : { createOnly: true });
    } catch (e) {
      if (e instanceof PreconditionFailed && attempt === 0) continue;
      if (e instanceof PreconditionFailed) return { kind: "conflict" };
      throw e;
    }
    return { kind: "stored", supersedes, attempt };
  }
  return { kind: "conflict" };
}

/** The fixture variants of the records pages (fixture mode only; the `fx` cookie, words joined with dots). */
export const REGISTRY_FLAGS = ["registry-off", "registry-empty", "registry-poison", "registry-syncing", "registry-stale", "registry-failed", "registry-unknown", "registry-no-main"] as const;
export type RegistryFlag = (typeof REGISTRY_FLAGS)[number];

export function registryFlagsFrom(raw: string | null | undefined): Set<RegistryFlag> {
  const out = new Set<RegistryFlag>();
  for (const w of (raw ?? "").split(".")) if ((REGISTRY_FLAGS as readonly string[]).includes(w)) out.add(w as RegistryFlag);
  if ((raw ?? "").split(".").includes("empty")) out.add("registry-off");
  if ((raw ?? "").split(".").includes("error")) out.add("registry-poison");
  return out;
}

function fixtureMode(): boolean {
  return process.env.DASHBOARD_FIXTURE === "1" && process.env.VERCEL_ENV !== "production";
}

export async function registryFlags(): Promise<Set<RegistryFlag>> {
  if (!fixtureMode()) return new Set();
  try {
    return registryFlagsFrom((await cookies()).get("fx")?.value);
  } catch {
    return new Set();
  }
}

/** An empty index for a branch: what the page draws for "registry-empty" (a repository with no records yet). */
export function emptyIndex(doc: RegistryIndex): RegistryIndex {
  return { ...doc, records: [], tombstones: [], families: [], issues: [], counts: { dec: 0, hyp: 0, exp: 0, ll: 0, tombstones: 0, issues: 0, families: 0 } };
}

async function fixtureIndex(branch: RegistryBranch): Promise<RegistryIndex> {
  const mod = branch === "main" ? await import("../../test/fixtures/registry.main.v1.json") : await import("../../test/fixtures/registry.integration.v1.json");
  return (mod.default ?? mod) as unknown as RegistryIndex;
}

/** Reads one branch's index, checked against the schema again. Deduplicated per request; never cached across them. */
export const loadRegistry = cache(async (branch: RegistryBranch): Promise<RegistryLoad> => {
  if (fixtureMode()) {
    const flags = await registryFlags();
    if (flags.has("registry-off") || (branch === "main" && flags.has("registry-no-main"))) return { status: "missing" };
    if (flags.has("registry-poison")) return { status: "error" };
    const doc = await fixtureIndex(branch);
    return {
      status: "ok",
      doc: flags.has("registry-empty") ? emptyIndex(doc) : doc,
      storedAt: `${doc.built_at.slice(0, 17)}30Z`,
      checkedAt: `${doc.built_at.slice(0, 17)}30Z`,
      source: "fixture",
    };
  }
  const paths = registryPaths(branch);
  try {
    const [stored, at, checked] = await Promise.all([readText(paths.latest), storedAt(paths.latest), readText(paths.checked).catch(() => null)]);
    if (!stored) return { status: "missing" };
    const v = validateRegistry(JSON.parse(stored.text));
    if (!v.ok) {
      logEvent("snapshot.read", { outcome: "invalid", desk: "registry", branch });
      return { status: "error" };
    }
    return { status: "ok", doc: v.doc, storedAt: at, checkedAt: parseChecked(checked?.text, v.doc.run_id), source: "blob" };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "registry", branch, error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
});

/** The checked time, only when it names the very index on file (a stale record of an older run says nothing). */
export function parseChecked(text: string | undefined | null, runId: string): string | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { run_id?: unknown; at?: unknown };
    if (v.run_id !== runId || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
    return v.at;
  } catch {
    return null;
  }
}
