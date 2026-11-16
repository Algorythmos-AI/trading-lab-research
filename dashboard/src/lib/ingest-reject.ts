import "server-only";
import { readText, storedAt, writeText } from "./blob";
import { CALENDAR_PATHS, JOURNAL_PATHS, LEDGER_PATHS, OPTIONS_CLONE_PATHS, OPTIONS_LIVE_PATHS, OPTIONS_PATHS, RADAR_PATHS } from "./desk";
import { logEvent } from "./log";

// The last edition /api/ingest refused for its content, one record per kind, for the monitoring to read. PRIVATE
// operational data: when, which kind, the outcome code and how many errors. Never the error text (it names keys
// that may be RESTRICTED), never anything from the body.

/** The kinds a refusal is recorded for: every document stored as an edition (ingest.ts's storeEdition). */
export const INGEST_REJECT_KINDS = ["radar", "options", "ledger", "journal", "options-live", "options-clone", "calendar"] as const;
export type IngestRejectKind = (typeof INGEST_REJECT_KINDS)[number];

/**
 * The refusals that are recorded: the body's content was not acceptable, or ("frozen", the Options edition only) it would
 * have replaced a session's edition after 09:25 New York with anything other than a later pre-market check
 * (./premarket). A duplicate or an older edition is not one.
 */
export const INGEST_REJECT_OUTCOMES = ["invalid", "ahead-of-clock", "frozen"] as const;
export type IngestRejectOutcome = (typeof INGEST_REJECT_OUTCOMES)[number];

export interface IngestReject {
  /** When it was refused: this server's clock, ISO with Z. */
  at: string;
  kind: IngestRejectKind;
  outcome: IngestRejectOutcome;
  /** How many validation errors the refusal named (1 for ahead-of-clock and for frozen). */
  n_errors: number;
}

export const INGEST_REJECT_PREFIX = "ops/ingest-rejects/";

export function ingestRejectPath(kind: IngestRejectKind): string {
  return `${INGEST_REJECT_PREFIX}${kind}.json`;
}

/**
 * How long a refusal waits for its record before answering anyway. The record is best effort: a store that hangs
 * must not hold the publisher's request until the function times out.
 */
export const INGEST_REJECT_WRITE_MS = 2_000;

/** Writes the record. Never throws and never waits longer than INGEST_REJECT_WRITE_MS: a failure is logged. */
export async function recordIngestReject(reject: IngestReject): Promise<void> {
  const body = JSON.stringify({ at: reject.at, kind: reject.kind, outcome: reject.outcome, n_errors: reject.n_errors });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), INGEST_REJECT_WRITE_MS);
  });
  try {
    const result = await Promise.race([writeText(ingestRejectPath(reject.kind), body).then(() => "written" as const), timeout]);
    if (result === "timeout") logEvent("ingest.reject-record", { outcome: "timeout", desk: reject.kind });
  } catch (e) {
    logEvent("ingest.reject-record", { outcome: "error", desk: reject.kind, error: e instanceof Error ? e.name : "unknown" });
  } finally {
    clearTimeout(timer);
  }
}

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The record in `text`, or null when it is not one: malformed JSON, a missing or unknown field, an extra field. */
export function parseIngestReject(text: string): IngestReject | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "at,kind,n_errors,outcome") return null;
  const { at, kind, outcome, n_errors } = r;
  if (typeof at !== "string" || !ISO_Z_RE.test(at) || !Number.isFinite(Date.parse(at))) return null;
  if (!(INGEST_REJECT_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!(INGEST_REJECT_OUTCOMES as readonly unknown[]).includes(outcome)) return null;
  if (typeof n_errors !== "number" || !Number.isInteger(n_errors) || n_errors < 0) return null;
  return { at, kind: kind as IngestRejectKind, outcome: outcome as IngestRejectOutcome, n_errors };
}

/**
 * The last refusal recorded for `kind`: null when none is stored or what is stored is not a record. A storage
 * failure is thrown, so a caller can tell "nothing refused" from "could not look".
 */
export async function readIngestReject(kind: IngestRejectKind): Promise<IngestReject | null> {
  const stored = await readText(ingestRejectPath(kind));
  return stored ? parseIngestReject(stored.text) : null;
}

/** Where each kind's accepted document is stored: the same latest.json ingest.ts writes. */
const LATEST_OF: Record<IngestRejectKind, string> = {
  radar: RADAR_PATHS.latest,
  options: OPTIONS_PATHS.latest,
  ledger: LEDGER_PATHS.latest,
  journal: JOURNAL_PATHS.latest,
  "options-live": OPTIONS_LIVE_PATHS.latest,
  "options-clone": OPTIONS_CLONE_PATHS.latest,
  calendar: CALENDAR_PATHS.latest,
};

export interface IngestRejectStatus {
  /** The last refusal recorded for the kind, or null. */
  reject: IngestReject | null;
  /** When the kind's latest document was last stored (the store's own upload time), or null before the first. */
  stored_at: string | null;
  /** True when a refusal is recorded and no document of the kind has been stored since it. */
  current: boolean;
}

/** Whether a refusal is still the latest word for its kind: nothing was stored at or after it. */
export function rejectIsCurrent(reject: IngestReject | null, storedAtIso: string | null): boolean {
  if (!reject) return false;
  if (storedAtIso === null) return true;
  return Date.parse(reject.at) > Date.parse(storedAtIso);
}

/**
 * The last refusal for `kind` with when its latest document was last stored, so a monitor can tell a refusal that
 * still stands from one a later good edition has since replaced. The stored-at time is the store's own metadata for
 * latest.json (one head() here, nothing written by ingest). A storage failure is thrown.
 */
export async function readIngestRejectStatus(kind: IngestRejectKind): Promise<IngestRejectStatus> {
  const [reject, stored_at] = await Promise.all([readIngestReject(kind), storedAt(LATEST_OF[kind])]);
  return { reject, stored_at, current: rejectIsCurrent(reject, stored_at) };
}
