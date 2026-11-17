import "server-only";
import { createHash } from "node:crypto";

// One copy of an accepted edition, kept for the labeller (EXP-0033 `labeller_rules.edition`): every edition that
// became latest.json, once, with the moment the store received it. PRIVATE like the edition itself: the private
// store only, and nothing of it in a log line.
//
//   <prefix><session>/<receipt, compact UTC to the ms>-<run>.json
//
// The path is fixed by the session, the receipt time and the run, so a retry of the same run computes the same path,
// and every write is create-only: a copy is never overwritten and its receipt time cannot change. Paths sort in
// receipt order. The envelope repeats the three and wraps the edition's exact published bytes.

export const EDITION_COPY_SCHEMA = "stocksdelta/edition-copy";
export const EDITION_COPY_VERSION = 1;

const SESSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MS_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_SAFE_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** A receipt time as it is kept: ISO 8601 with milliseconds and Z. Null when `at` is not a time. */
export function receiptIso(at: string): string | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 2026-10-12T21:30:00.123Z -> 20261012T213000123Z: no separators a path would have to escape, still sortable. */
function compact(iso: string): string {
  return iso.replace(/[-:.]/g, "");
}

/** The run id as a path segment: itself when it is plain, otherwise a hash of it (still one per run). */
export function runSegment(runId: string): string {
  return RUN_SAFE_RE.test(runId) ? runId : `h${createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 32)}`;
}

/** Where the copy of `runId`, received at `receivedAt` (ISO with ms and Z), for `session` is kept. */
export function editionCopyPath(prefix: string, session: string, receivedAt: string, runId: string): string {
  if (!SESSION_RE.test(session)) throw new Error("edition copy: session is not a date");
  if (!ISO_MS_Z_RE.test(receivedAt)) throw new Error("edition copy: receipt time is not ISO with ms and Z");
  return `${prefix}${session}/${compact(receivedAt)}-${runSegment(runId)}.json`;
}

/**
 * The copy's text: the envelope, then the edition exactly as it was stored in latest.json. `editionText` is JSON the
 * ingest has parsed and validated, so the result is JSON; nothing of the request but those bytes enters it.
 */
export function editionCopyText(receivedAt: string, session: string, runId: string, editionText: string): string {
  const head = JSON.stringify({ schema: EDITION_COPY_SCHEMA, version: EDITION_COPY_VERSION, received_at: receivedAt, session, run_id: runId });
  return `${head.slice(0, -1)},"edition":${editionText}}`;
}

export interface ParsedEditionCopy {
  receivedAt: string;
  session: string;
  runId: string;
  edition: unknown;
}

/** The envelope in `text`, or null when it is not one (the edition itself is the caller's to validate). */
export function parseEditionCopy(text: string): ParsedEditionCopy | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "edition,received_at,run_id,schema,session,version") return null;
  if (r.schema !== EDITION_COPY_SCHEMA || r.version !== EDITION_COPY_VERSION) return null;
  const { received_at, session, run_id, edition } = r;
  if (typeof received_at !== "string" || !ISO_MS_Z_RE.test(received_at) || receiptIso(received_at) !== received_at) return null;
  if (typeof session !== "string" || !SESSION_RE.test(session)) return null;
  if (typeof run_id !== "string" || run_id.length === 0) return null;
  return { receivedAt: received_at, session, runId: run_id, edition };
}

/**
 * The copy of the edition `editionText` (run `runId`, session `session`) that latest.json took at `uploadedAt` (the
 * store's own time of that write): its path and text. Null when the time or the session is not usable, so that no
 * copy is ever made with a time that is not the store's.
 */
export function editionCopyFor(
  prefix: string,
  session: string | null,
  uploadedAt: string,
  runId: string,
  editionText: string,
): { path: string; body: string; receivedAt: string } | null {
  const receivedAt = receiptIso(uploadedAt);
  if (receivedAt === null || session === null || !SESSION_RE.test(session) || runId.length === 0) return null;
  return { path: editionCopyPath(prefix, session, receivedAt, runId), body: editionCopyText(receivedAt, session, runId, editionText), receivedAt };
}

/** The run id and session a stored Options edition names, without its values being logged; null fields when absent. */
export function runAndSession(text: string): { runId: string | null; session: string | null } {
  try {
    // The Options edition names its date `session`; the radar edition names it `edition_date`.
    const v = JSON.parse(text) as { run_id?: unknown; session?: unknown; edition_date?: unknown };
    const day = v.session !== undefined ? v.session : v.edition_date;
    return {
      runId: typeof v.run_id === "string" && v.run_id.length > 0 ? v.run_id : null,
      session: typeof day === "string" && SESSION_RE.test(day) ? day : null,
    };
  } catch {
    return { runId: null, session: null };
  }
}

/** An etag's form, never its value: its length, whether it is quoted, whether it is weak-prefixed (W/). */
export function etagShape(etag: string | null | undefined): { len: number; quoted: boolean; weak: boolean } | null {
  if (typeof etag !== "string") return null;
  const weak = etag.startsWith("W/");
  const bare = weak ? etag.slice(2) : etag;
  return { len: etag.length, quoted: bare.length >= 2 && bare.startsWith('"') && bare.endsWith('"'), weak };
}

// A lost copy: an edition that became latest and was replaced before its copy was made (ingest's "lost"). Kept for the
// radar only (DEC-0055), create-only, beside the copies, so the gap is in the store and not only in a log line:
//   <prefix><session>/<receipt>-<run>.lost.json  holding schema, version, received_at, session and run_id.
export const EDITION_LOST_SCHEMA = "stocksdelta/edition-copy-lost";

/** Where the lost marker of `runId`, received at `receivedAt`, for `session` is kept, and its text. */
export function lostMarkerFor(prefix: string, session: string, uploadedAt: string, runId: string): { path: string; body: string } | null {
  const receivedAt = receiptIso(uploadedAt);
  if (receivedAt === null || !SESSION_RE.test(session) || runId.length === 0) return null;
  const path = editionCopyPath(prefix, session, receivedAt, runId).replace(/\.json$/, ".lost.json");
  const body = JSON.stringify({ schema: EDITION_LOST_SCHEMA, version: 1, received_at: receivedAt, session, run_id: runId });
  return { path, body };
}

/** The lost marker in `text`, or null when it is not one. */
export function parseLostMarker(text: string): { receivedAt: string; session: string; runId: string } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "received_at,run_id,schema,session,version") return null;
  if (r.schema !== EDITION_LOST_SCHEMA || r.version !== 1) return null;
  if (typeof r.received_at !== "string" || !ISO_MS_Z_RE.test(r.received_at)) return null;
  if (typeof r.session !== "string" || !SESSION_RE.test(r.session) || typeof r.run_id !== "string" || r.run_id.length === 0) return null;
  return { receivedAt: r.received_at, session: r.session, runId: r.run_id };
}
