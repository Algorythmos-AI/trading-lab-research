import "server-only";
import { PreconditionFailed, exists, readText, storedMeta, writeText } from "./blob";
import { OPTIONS_PATHS, RADAR_PATHS } from "./desk";
import { editionCopyFor, runAndSession } from "./edition-copy";
import { logEvent } from "./log";

// The repair of the Options and radar edition copies (./edition-copy), run beside the 10-minute watchdog. The ingest makes the
// copy best effort and answers the same whether or not it did; this makes it from the store's own read of latest,
// so that a copy never depends on a publisher retrying. It also gives a copy to the edition that is latest when the
// release deploys.
//
// One consistent read: head (etag and uploadedAt), get, head again. Etags change on every write, so when both heads
// name the same etag no write landed between them, and the text read between them is that write's. Head is compared
// with head only (one API, one form), so no put's etag is involved. Then one existence check on the one path the
// run, the session and that uploadedAt fix (never a listing), and a create-only write when it is missing (a refused
// write counts as present). A warm instance that has already seen this etag's copy present stops after the first
// head. One `edition-copy.repair` line per run: present, repaired, no-latest, error (with the error's class); never
// anything of the edition.

/** What the repair needs of the store, injectable so tests run it on memory. */
export interface CopyRepairDeps {
  meta(path: string): Promise<{ etag: string; uploadedAt: string } | null>;
  read(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Create-only; throws PreconditionFailed when the blob is already there. */
  create(path: string, body: string): Promise<void>;
  log(evt: string, fields: Record<string, unknown>): void;
}

export const blobCopyRepairDeps: CopyRepairDeps = {
  meta: (path) => storedMeta(path),
  read: async (path) => (await readText(path))?.text ?? null,
  exists: (path) => exists(path),
  create: async (path, body) => {
    await writeText(path, body, { createOnly: true });
  },
  log: logEvent,
};

/** How long the repair may take before it is reported as an error; the cron never waits for it. */
export const COPY_REPAIR_BUDGET_MS = 8_000;

export type CopyRepairOutcome = "present" | "repaired" | "no-latest" | "error";

/** A named failure, so that the log line carries a class name and nothing else. */
class RepairError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

/** An edition kind whose copies are repaired: where its latest and its copies are. */
interface CopyKind {
  latest: string;
  copies: string;
}
const OPTIONS_KIND: CopyKind = { latest: OPTIONS_PATHS.latest, copies: OPTIONS_PATHS.copies };
const RADAR_KIND: CopyKind = { latest: RADAR_PATHS.latest, copies: RADAR_PATHS.copies };

// Per kind, the etag whose copy this instance last saw present: the next run with the same etag needs one head only.
const confirmed = new Map<string, string>();

/** For tests: forget what this instance has confirmed. */
export function resetCopyRepairMemo(): void {
  confirmed.clear();
}

async function repairOnce(deps: CopyRepairDeps, kind: CopyKind): Promise<{ outcome: CopyRepairOutcome; run_id?: string; session?: string; bytes?: number }> {
  const latest = kind.latest;
  const first = await deps.meta(latest);
  if (!first) return { outcome: "no-latest" };
  if (first.etag === confirmed.get(latest)) return { outcome: "present" };
  const text = await deps.read(latest);
  const second = await deps.meta(latest);
  if (text === null || !second) return { outcome: "no-latest" };
  if (second.etag !== first.etag || second.uploadedAt !== first.uploadedAt) throw new RepairError("LatestMoved");
  const { runId, session } = runAndSession(text);
  if (!runId || !session) throw new RepairError("UnreadableLatest");
  const copy = editionCopyFor(kind.copies, session, first.uploadedAt, runId, text);
  if (!copy) throw new RepairError("UnusableTime");
  const ids = { run_id: runId, session };
  if (await deps.exists(copy.path)) {
    confirmed.set(latest, first.etag);
    return { outcome: "present", ...ids };
  }
  try {
    await deps.create(copy.path, copy.body);
  } catch (e) {
    if (!(e instanceof PreconditionFailed)) throw e;
    confirmed.set(latest, first.etag);
    return { outcome: "present", ...ids };
  }
  confirmed.set(latest, first.etag);
  return { outcome: "repaired", ...ids, bytes: copy.body.length };
}

/** One repair run of the Options edition's copy. Never rejects, never takes longer than `budgetMs`; one log line. */
export function repairOptionsCopy(deps: CopyRepairDeps = blobCopyRepairDeps, budgetMs: number = COPY_REPAIR_BUDGET_MS): Promise<CopyRepairOutcome> {
  return repairKind(deps, budgetMs, OPTIONS_KIND, {});
}

/** One repair run of the radar edition's copy: the same, its log line marked desk radar. */
export function repairRadarCopy(deps: CopyRepairDeps = blobCopyRepairDeps, budgetMs: number = COPY_REPAIR_BUDGET_MS): Promise<CopyRepairOutcome> {
  return repairKind(deps, budgetMs, RADAR_KIND, { desk: "radar" });
}

async function repairKind(deps: CopyRepairDeps, budgetMs: number, kind: CopyKind, mark: Record<string, string>): Promise<CopyRepairOutcome> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => {
    timer = setTimeout(() => r("late"), budgetMs);
  });
  const work = Promise.resolve()
    .then(() => repairOnce(deps, kind))
    .catch((e: unknown) => ({ outcome: "error" as const, error: e instanceof Error ? e.name : "unknown" }));
  try {
    const r = await Promise.race([work, late]);
    const fields = r === "late" ? { outcome: "error" as const, error: "Timeout" } : r;
    try {
      deps.log("edition-copy.repair", { ...mark, ...fields, ms: Date.now() - started });
    } catch {
      // a log that throws must not reach the cron
    }
    return fields.outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts a repair run beside the watchdog's ticks and hands it to `keepAlive` (Next's `after`) so the platform keeps
 * the function alive for it; returns at once and never throws, so the cron's own ticks, answer and log lines are the
 * same whether the repair succeeds, fails, hangs or is absent. Outside a request (tests), `after` throws: the run still
 * goes on.
 */
export function startOptionsCopyRepair(
  keepAlive: (work: Promise<unknown>) => void,
  run: () => Promise<unknown> = () => Promise.all([repairOptionsCopy(), repairRadarCopy()]),
): void {
  let work: Promise<unknown>;
  try {
    work = Promise.resolve().then(run).catch(() => undefined);
  } catch {
    return;
  }
  try {
    keepAlive(work);
  } catch {
    // no request scope to keep alive in: the run goes on regardless
  }
}
