// Whether the Reference Registry's index is current: pure, no I/O (the GitHub reads are ./registry-github).
//
// The index names the commit it was built from. GitHub, read on the server, names the branch head and the registry
// job's recent runs. Five answers, in this order:
//   Can't check  GitHub could not be asked (no token, refused, unreachable, rate-limited) or the store failed. Never
//                Synced: what is on file may be current, but nothing here can say so.
//   Synced       the index's commit is the branch head.
//   Syncing      a run of the job for this branch is queued or running.
//   Sync failed  the newest finished run for this branch did not succeed (the job's build or the ingest refused).
//   Out of date  the head has moved and no run is under way or has failed: the run has not started yet, or it was
//                skipped. Refresh starts one.

export type SyncState = "synced" | "syncing" | "out_of_date" | "sync_failed" | "cant_check";

export const SYNC_LABEL: Record<SyncState, string> = {
  synced: "Synced",
  syncing: "Syncing",
  out_of_date: "Out of date",
  sync_failed: "Sync failed",
  cant_check: "Can't check",
};

export interface RunInfo {
  /** GitHub's run status: queued, in_progress, waiting, requested, pending or completed. */
  status: string;
  /** success, failure, cancelled, timed_out, skipped, startup_failure, action_required, neutral or null. */
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  event: string;
}

export type GithubView =
  | { ok: true; head: string; headAt: string | null; runs: readonly RunInfo[] }
  | { ok: false; reason: "no-token" | "unauthorized" | "unreachable" | "rate-limited" | "not-found" };

export type IndexView =
  | { status: "ok"; sha: string; as_of: string; storedAt: string | null; checkedAt: string | null }
  | { status: "missing" }
  | { status: "error" };

export interface SyncStatus {
  state: SyncState;
  label: string;
  /** A closed code for the line under the badge. */
  reason:
    | "head"
    | "run-active"
    | "run-failed"
    | "head-moved"
    | "no-index"
    | "no-token"
    | "unauthorized"
    | "unreachable"
    | "rate-limited"
    | "not-found"
    | "store";
  /** The index's own commit, and the head GitHub reported (null when it could not be asked). */
  indexSha: string | null;
  headSha: string | null;
  headAt: string | null;
  /** The last time the job confirmed an index for this branch: the later of its store and its last repeat. */
  lastSync: string | null;
  /** When the newest failed run started, for "Sync failed". */
  failedAt: string | null;
}

const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function syncStatus(index: IndexView, gh: GithubView): SyncStatus {
  const indexSha = index.status === "ok" ? index.sha : null;
  const lastSync = index.status === "ok" ? later(index.storedAt, index.checkedAt) : null;
  const base = { indexSha, lastSync, failedAt: null as string | null };
  const out = (state: SyncState, reason: SyncStatus["reason"], extra: Partial<SyncStatus> = {}): SyncStatus => ({
    state,
    label: SYNC_LABEL[state],
    reason,
    headSha: gh.ok ? gh.head : null,
    headAt: gh.ok ? gh.headAt : null,
    ...base,
    ...extra,
  });
  if (index.status === "error") return out("cant_check", "store");
  if (!gh.ok) return out("cant_check", gh.reason);
  if (index.status === "ok" && index.sha === gh.head) return out("synced", "head");
  const runs = [...gh.runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (runs.some((r) => ACTIVE.has(r.status))) return out("syncing", "run-active");
  const finished = runs.find((r) => r.status === "completed" && r.conclusion !== "skipped");
  if (finished && FAILED.has(finished.conclusion ?? "")) return out("sync_failed", "run-failed", { failedAt: finished.created_at });
  return out("out_of_date", index.status === "missing" ? "no-index" : "head-moved");
}

/** The sentence under the badge. Times are formatted by the caller; this names what is known. */
export function syncSentence(s: SyncStatus): string {
  switch (s.reason) {
    case "head":
      return "The index is built from the branch head.";
    case "run-active":
      return "A run of the registry job is under way; the page updates when it lands.";
    case "run-failed":
      return "The newest run of the registry job failed. What is shown is the last index that arrived.";
    case "head-moved":
      return "The branch has moved since this index was built, and no run is under way. Refresh starts one.";
    case "no-index":
      return "No index has arrived for this branch yet. Refresh starts the job.";
    case "no-token":
      return "GitHub cannot be asked: the server has no token. What is shown may not be current.";
    case "unauthorized":
      return "GitHub refused the server's token (expired or revoked). What is shown may not be current.";
    case "rate-limited":
      return "GitHub is rate-limiting the server. What is shown may not be current.";
    case "not-found":
      return "GitHub does not know the branch or the registry job. What is shown may not be current.";
    case "store":
      return "The dashboard's store could not be read.";
    default:
      return "GitHub could not be reached. What is shown may not be current.";
  }
}
