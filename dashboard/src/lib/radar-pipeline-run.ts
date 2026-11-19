import "server-only";
import { listPaths, readText, writeText } from "./blob";
import { FUNNEL_PATHS, LEDGER_PATHS, OPTIONS_PATHS, RADAR_DESK_PATHS, RADAR_PATHS } from "./desk";
import { adjacentSession } from "./feed-watch";
import { readIngestRejectStatus } from "./ingest-reject";
import { logEvent } from "./log";
import { nyNow } from "./market-calendar";
import { premarketPath } from "./premarket";
import {
  BEACON_STAGES,
  beaconObs,
  emptyObs,
  firstReceipt,
  funnelObs,
  levelsStamp,
  mergeObs,
  parsePipelineFile,
  type PipelineFile,
  pipelineDays,
  serializePipelineFile,
  sessionDocAt,
  type SessionObs,
  stampedOn,
} from "./radar-pipeline";
import { fixturePipeline, RADAR_HOLIDAY_NOW } from "./radar-pipeline-fixture";
import { RADAR_PIPELINE_PATH } from "./radar-pipeline-slots";
import { fixtureFlags, fixtureMode, loadRadarRun } from "./snapshot";

// The Radar pipeline's summary (ops/radar-pipeline.json): written beside the 10-minute watchdog, read by the Radar
// page. One small document, so the page makes one read and a slow or missing source cannot break it.
//
// Each run reads the summary it wrote last, looks again only at the session in view and the one before it (and at
// any session the summary does not hold yet), and keeps every time it has already seen (radar-pipeline.ts mergeObs):
// the ledger's and the options edition's documents are replaced later in the day, so a time not caught on the day is
// "no record" for good. What it reads, per session: the run beacons, the first receipt of the radar edition and of
// the options edition (from their copies' paths, the store's own receipt times), the desk file, the kept pre-market
// check, the ledger's morning document, the funnel's health document, and for the session in view the ingest's last
// refusal. Times, ids, closed codes and counts only (PRIVATE; nothing of any document's content).

/** How long a run may take before it is reported as an error; the cron never waits for it. */
export const PIPELINE_BUDGET_MS = 20_000;
/** Each read's own limit. */
export const PIPELINE_READ_MS = 4_000;
/** How many sessions are read side by side. */
const BATCH = 3;
/** How many sessions beyond the one in view and the one before it a run looks at: a first run fills in over a few ticks. */
export const PIPELINE_CATCH_UP = 6;

export interface PipelineDeps {
  /** A stored document's text, or null when there is none. Throws when the store fails. */
  read(path: string): Promise<string | null>;
  /** The paths under a prefix. Throws when the store fails. */
  list(prefix: string): Promise<string[]>;
  write(path: string, body: string): Promise<void>;
  /** A session's run beacons, newest of each stage. Throws when the store fails. */
  beacons(session: string): Promise<unknown[]>;
  /** The ingest's last refusal of a radar edition and whether it still stands. Throws when the store fails. */
  refusal(): Promise<{ at: string | null; current: boolean }>;
  clock(): number;
  log(evt: string, fields: Record<string, unknown>): void;
}

export function blobPipelineDeps(): PipelineDeps {
  return {
    read: async (path) => (await readText(path))?.text ?? null,
    list: async (prefix) => (await listPaths(prefix)).map((p) => p.pathname),
    write: async (path, body) => {
      await writeText(path, body);
    },
    beacons: async (session) => {
      const r = await loadRadarRun(session);
      if (r.status === "error") throw new Error("radar-run read failed");
      return r.status === "ok" ? r.stages : [];
    },
    refusal: async () => {
      const s = await readIngestRejectStatus("radar");
      return { at: s.reject?.at ?? null, current: s.current };
    },
    clock: () => Date.now(),
    log: logEvent,
  };
}

class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimedOut";
  }
}
function within<T>(p: Promise<T>, msLimit: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), msLimit);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** One read that never throws: `ok` false when the store failed or was too slow (the value is then not known). */
async function attempt<T>(p: () => Promise<T>, failed: { n: number }): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await within(Promise.resolve().then(p), PIPELINE_READ_MS) };
  } catch {
    failed.n++;
    return { ok: false };
  }
}
function json(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * One look at one session. A time the summary already holds is not read again. `previous` is the session before it
 * (the ledger's morning document is filed under the session it scored); `inView` adds the refusal check.
 */
export async function observeSession(
  deps: PipelineDeps,
  session: string,
  previous: string,
  have: SessionObs | null,
  opts: { inView: boolean; editionDates: ReadonlySet<string> | null },
  total: { n: number } = { n: 0 },
): Promise<SessionObs> {
  // This look's own failed reads: one of them, and the look is not a whole one.
  const failed = { n: 0 };
  const doc = async (path: string) => {
    const r = await attempt(() => deps.read(path), failed);
    return r.ok ? json(r.value) : null;
  };
  const receipt = async (prefix: string) => {
    const r = await attempt(() => deps.list(`${prefix}${session}/`), failed);
    return r.ok ? firstReceipt(r.value, prefix, session) : null;
  };
  const [beacons, stored, levels, desk, pre, card, funnel, refusal] = await Promise.all([
    attempt(() => deps.beacons(session), failed),
    have?.stored_at ? null : receipt(RADAR_PATHS.copies),
    have?.levels_at ? null : receipt(OPTIONS_PATHS.copies),
    have?.desk_at ? null : doc(`${RADAR_DESK_PATHS.history}${session}.json`),
    have?.preopen_at ? null : doc(premarketPath(session)),
    have?.card_at ? null : doc(`${LEDGER_PATHS.history}${previous}.json`),
    doc(`${FUNNEL_PATHS.history}${session}.json`),
    opts.inView ? attempt(() => deps.refusal(), failed) : null,
  ]);
  const next = emptyObs(session);
  if (beacons.ok) {
    for (const stage of BEACON_STAGES) {
      const b = beacons.value.map((d) => beaconObs(d, session, stage)).find((x) => x !== null);
      if (b) next.beacons[stage] = b;
    }
  }
  next.stored_at = stored;
  // No copy of the options edition (it was stored before copies were kept): the edition's own stamp, when it is the
  // evening build's and not a later refresh.
  next.levels_at = levels ?? (have?.levels_at ? null : levelsStamp(await doc(`${OPTIONS_PATHS.history}${session}.json`), session));
  next.edition_on_file = stored !== null || (opts.editionDates?.has(session) ?? false);
  next.desk_at = sessionDocAt(desk, session);
  next.preopen_at = stampedOn(pre, session);
  // The morning document is stamped on the session's day before the close; the after-close one is the next day's.
  next.card_at = stampedOn(card, session, 16 * 60);
  next.funnel = funnelObs(funnel, session);
  if (refusal?.ok && refusal.value.current && refusal.value.at !== null) {
    const t = Date.parse(refusal.value.at);
    if (Number.isFinite(t) && nyNow(new Date(t)).day === session) next.refused_at = new Date(t).toISOString();
  }
  // Without the listing of the editions on file, "none on file" is not known either.
  next.complete = failed.n === 0 && opts.editionDates !== null;
  total.n += failed.n;
  return mergeObs(have, next, { beacons: beacons.ok, refusal: refusal === null ? false : refusal.ok });
}

export type PipelineOutcome = "written" | "error";

async function refreshOnce(deps: PipelineDeps): Promise<{ outcome: PipelineOutcome; sessions: number; looked: number; failed_reads: number }> {
  const nowMs = deps.clock();
  const days = pipelineDays(nowMs);
  const failed = { n: 0 };
  const prevText = await attempt(() => deps.read(RADAR_PIPELINE_PATH), failed);
  const prev = new Map((prevText.ok ? (parsePipelineFile(prevText.value)?.sessions ?? []) : []).map((s) => [s.session, s]));
  // The session in view and the one before it every time; then the newest of those not held, or never read whole.
  const owed = days.sessions.filter((s) => s !== days.focus && s !== days.previous && prev.get(s)?.complete !== true).reverse();
  const look = [...new Set([days.focus, days.previous, ...owed.slice(0, PIPELINE_CATCH_UP)])];
  // One listing says which sessions have an edition on file at all (radar/editions/<date>.json).
  const dated = await attempt(() => deps.list(RADAR_PATHS.history), failed);
  const editionDates = dated.ok ? new Set(dated.value.flatMap((p) => /(\d{4}-\d{2}-\d{2})\.json$/.exec(p)?.[1] ?? [])) : null;
  const seen = new Map<string, SessionObs>();
  for (let i = 0; i < look.length; i += BATCH) {
    const batch = look.slice(i, i + BATCH);
    const done = await Promise.all(
      batch.map((session) => {
        const at = days.sessions.indexOf(session);
        const previous = at > 0 ? days.sessions[at - 1]! : adjacentSession(session, -1).day;
        return observeSession(deps, session, previous, prev.get(session) ?? null, { inView: session === days.focus, editionDates }, failed);
      }),
    );
    for (const o of done) seen.set(o.session, o);
  }
  const sessions = days.sessions.flatMap((s) => seen.get(s) ?? prev.get(s) ?? []);
  const file: PipelineFile = { v: 1, generated_at: new Date(nowMs).toISOString(), sessions };
  await deps.write(RADAR_PIPELINE_PATH, serializePipelineFile(file));
  return { outcome: "written", sessions: sessions.length, looked: look.length, failed_reads: failed.n };
}

/** One run. Never rejects, never takes longer than `budgetMs`; one `radar-pipeline.refresh` log line. */
export async function refreshRadarPipeline(deps: PipelineDeps = blobPipelineDeps(), budgetMs: number = PIPELINE_BUDGET_MS): Promise<PipelineOutcome> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => {
    timer = setTimeout(() => r("late"), budgetMs);
  });
  const work = Promise.resolve()
    .then(() => refreshOnce(deps))
    .catch((e: unknown) => ({ outcome: "error" as const, error: e instanceof Error ? e.name : "unknown" }));
  try {
    const r = await Promise.race([work, late]);
    const fields = r === "late" ? { outcome: "error" as const, error: "Timeout" } : r;
    try {
      deps.log("radar-pipeline.refresh", { ...fields, ms: Date.now() - started });
    } catch {
      // a log that throws must not reach the cron
    }
    return fields.outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts a run beside the watchdog's ticks and hands it to `keepAlive` (Next's `after`) so the platform keeps the
 * function alive for it; returns at once and never throws, so the cron's own ticks, answer and log lines are the same
 * whether the run succeeds, fails, hangs or is absent. Outside a request (tests), `after` throws: the run still goes
 * on. In fixture mode there is no store, so the run it starts by default does nothing.
 */
export function startRadarPipelineRefresh(
  keepAlive: (work: Promise<unknown>) => void,
  run: () => Promise<unknown> = () => (fixtureMode() ? Promise.resolve() : refreshRadarPipeline()),
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

export interface PipelineView {
  /** The summary, or null when there is none to read: the page then draws the schedule alone. */
  file: PipelineFile | null;
  /** The time the pipeline is drawn for: the page's own, but for the `radar-holiday` fixture flag. */
  now: Date;
}

/**
 * The summary for the Radar page: one read. Null when none is stored yet, it cannot be read, or the store fails. In
 * fixture mode it is made in memory (radar-pipeline-fixture.ts); `empty` and `error` give none.
 */
export async function loadRadarPipeline(pageNow: Date): Promise<PipelineView> {
  if (fixtureMode()) {
    const flags = await fixtureFlags();
    const now = flags.has("radar-holiday") ? new Date(RADAR_HOLIDAY_NOW) : pageNow;
    if (flags.has("empty") || flags.has("error")) return { file: null, now };
    return { file: fixturePipeline(now.getTime(), flags), now };
  }
  try {
    const stored = await readText(RADAR_PIPELINE_PATH);
    const file = parsePipelineFile(stored?.text);
    if (stored && !file) logEvent("snapshot.read", { outcome: "not-a-summary", desk: "radar-pipeline" });
    return { file, now: pageNow };
  } catch (e) {
    logEvent("snapshot.read", { outcome: "error", desk: "radar-pipeline", error: e instanceof Error ? e.name : "unknown" });
    return { file: null, now: pageNow };
  }
}
