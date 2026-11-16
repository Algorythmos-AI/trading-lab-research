import "server-only";
import { HISTORY_PREFIX, PreconditionFailed, exists, readForUpdate, storedMeta, writeText } from "./blob";
import { CALENDAR_PATHS, DESK_PATHS, JOURNAL_PATHS, LEDGER_PATHS, OPTIONS_CLONE_PATHS, OPTIONS_LIVE_PATHS, OPTIONS_PATHS, RADAR_PATHS } from "./desk";
import { editionCopyFor, etagShape, runAndSession } from "./edition-copy";
import { verify } from "./hmac";
import { KEY_ID_RE, decideScope, parseScopes } from "./ingest-scope";
import { recordIngestReject, type IngestRejectKind } from "./ingest-reject";
import { logEvent } from "./log";
import { parseTime } from "./freshness";
import type { OptionsEdition } from "./options.types";
import {
  focusFrozen,
  parseStoredPremarket,
  premarketIsNewer,
  premarketOf,
  premarketPath,
  sameApartFromPremarket,
  storedPremarketText,
  within,
} from "./premarket";
import {
  contractOf,
  isCalendar,
  isJournal,
  isLedger,
  isOptions,
  isOptionsClone,
  isOptionsLive,
  isRadar,
  validateCalendar,
  validateJournal,
  validateLedger,
  validateOptionsClone,
  validateOptionsEdition,
  validateOptionsLive,
  validateRadarEdition,
} from "./validate";

export const MAX_BODY_BYTES = 3_500_000;
/** How far ahead of this server's clock a document from the trading host may be dated: clock drift, not more. */
export const OPTIONS_LIVE_AHEAD_MS = 10 * 60_000;
/**
 * The same allowance for every document stored as an edition. Each kind's as_of is the time its publisher built or
 * read it (the session or edition date is a field of its own), so nothing legitimate is ever dated later than the
 * publisher's clock, and two clocks differ by drift, not more.
 */
export const EDITION_AHEAD_MS = OPTIONS_LIVE_AHEAD_MS;
/** UTC+14 (the Line Islands): no wall time anywhere on Earth is further ahead of UTC than this. */
const WIDEST_ZONE_AHEAD_MS = 14 * 3_600_000;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A wall time with no zone, with "T" or a space between date and time (Python's str(datetime)). */
const ZONELESS_ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/i;

/** Whether an as_of names no instant of its own: a date alone, or a wall time with no zone. */
function zoneless(asOf: string): boolean {
  return DATE_ONLY_RE.test(asOf) || ZONELESS_ISO_RE.test(asOf);
}

/**
 * The instant editions are ordered by, and the only one this file compares. A date alone or a zoneless wall time is
 * read as UTC, never in this server's zone, so the order does not depend on where it runs. Every other form
 * Date.parse takes (a zone written as Z, z, +00:00 or +0000, with "T" or a space) is its exact instant.
 */
export function orderInstant(asOf: string | null | undefined): number | null {
  if (typeof asOf !== "string" || asOf.length === 0) return null;
  if (DATE_ONLY_RE.test(asOf)) return parseTime(`${asOf}T00:00:00Z`);
  if (ZONELESS_ISO_RE.test(asOf)) return parseTime(`${asOf.slice(0, 10)}T${asOf.slice(11)}Z`);
  return parseTime(asOf);
}

/**
 * The earliest real instant an as_of can stand for; null when it stands for none. A value with its zone is exact.
 * Only a date alone or a zoneless wall time is given the widest offset: it names a different instant in every
 * zone, so it counts as ahead only when no publisher anywhere could have written it yet.
 */
export function earliestInstant(asOf: string): number | null {
  const at = orderInstant(asOf);
  return at === null || !zoneless(asOf) ? at : at - WIDEST_ZONE_AHEAD_MS;
}

/** Whether an incoming as_of is dated later than this clock allows (EDITION_AHEAD_MS). Exactly at it is not. */
export function isAheadOfClock(asOf: string | null, nowMs: number): boolean {
  const at = asOf === null ? null : earliestInstant(asOf);
  return at !== null && at > nowMs + EDITION_AHEAD_MS;
}

/**
 * Whether a stored document's ordering instant is beyond the allowance, so that it gives way to a newer edition
 * whatever their order. Decided on the very instant the "older" rule compares, which is what guarantees the
 * invariant: a stored document can refuse an edition as older only while its ordering instant is within
 * now + EDITION_AHEAD_MS, so it can hold up a true edition for no longer than the allowance. (A zoneless value the
 * lenient guard took, ordered as UTC, may be stored ahead: it then gives way to the next edition.)
 */
function storedAhead(storedAsOf: number | null, nowMs: number): boolean {
  return storedAsOf !== null && storedAsOf > nowMs + EDITION_AHEAD_MS;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Reads at most `max` bytes of the request body; null when it is larger. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** snapshots/history/YYYY-MM-DD/HH.json for the snapshot's UTC hour. */
export function historyPath(asOfMs: number, prefix: string = HISTORY_PREFIX): string {
  const iso = new Date(asOfMs).toISOString();
  return `${prefix}${iso.slice(0, 10)}/${iso.slice(11, 13)}.json`;
}

function currentMeta(text: string): { runId: string | null; asOf: number | null } {
  try {
    const cur = JSON.parse(text) as { run_id?: unknown; as_of?: unknown };
    return {
      runId: typeof cur.run_id === "string" ? cur.run_id : null,
      asOf: typeof cur.as_of === "string" ? orderInstant(cur.as_of) : null,
    };
  } catch {
    return { runId: null, asOf: null };
  }
}

const AHEAD_ERROR = "/as_of: is ahead of the server's clock";

/** The id a host signs with (x-wt-key-id); the Mac's publisher predates ids and is "default". */
export const DEFAULT_KEY_ID = "default";

/**
 * The key the pre-market radar signs with. It lives in a cloud research environment, not on a trading host, so
 * it may only publish research editions (radar and options levels): a stocks or crypto snapshot signed with it is
 * refused.
 */
export const RADAR_KEY_ID = "radar";

/**
 * The secret for a key id. DASHBOARD_INGEST_KEYS is a JSON map {id: secret} (one key per host, ADR 0004);
 * DASHBOARD_INGEST_SECRET is the "default" key. Unknown ids get nothing, so they fail the HMAC check.
 */
export function secretFor(keyId: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.DASHBOARD_INGEST_KEYS) {
    try {
      const map = JSON.parse(env.DASHBOARD_INGEST_KEYS) as Record<string, unknown>;
      const v = map[keyId];
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // a malformed map is ignored: the default key still works
    }
  }
  if (keyId === RADAR_KEY_ID) return env.RADAR_INGEST_SECRET || null;
  return keyId === DEFAULT_KEY_ID ? (env.DASHBOARD_INGEST_SECRET ?? null) : null;
}

/** The optional per-key scopes: a JSON map {"<key id>": {"desks": ["hft"]}}. Read by ./ingest-scope. */
export const SCOPES_ENV = "DASHBOARD_INGEST_SCOPES";

/**
 * POST /api/ingest. Order: environment gate, size cap, HMAC, JSON, the key's scope, schema + denylist, then a
 * conditional write of snapshots/latest.json (retried once on an etag conflict) and the hourly copy.
 */
export async function handleIngest(req: Request, now: Date = new Date()): Promise<Response> {
  const started = Date.now();
  const done = (status: number, outcome: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    logEvent("ingest", { outcome, status, ms: Date.now() - started, ...extra });
    return json(status, body);
  };

  if (process.env.VERCEL_ENV !== "production") {
    return done(403, "not-production", { error: "ingest is disabled on this deployment" });
  }
  const keyIdHeader = req.headers.get("x-wt-key-id");
  const keyId = keyIdHeader && KEY_ID_RE.test(keyIdHeader) ? keyIdHeader : DEFAULT_KEY_ID;
  if (!process.env.DASHBOARD_INGEST_SECRET && !process.env.DASHBOARD_INGEST_KEYS && !process.env.RADAR_INGEST_SECRET) {
    return done(503, "not-configured", { error: "ingest is not configured" });
  }
  const secret = secretFor(keyId);

  const bytes = await readCapped(req, MAX_BODY_BYTES);
  if (!bytes) return done(413, "too-large", { error: `body exceeds ${MAX_BODY_BYTES} bytes` });

  const auth = secret
    ? verify(secret, req.headers.get("x-wt-timestamp"), req.headers.get("x-wt-signature"), bytes, now)
    : { ok: false as const, reason: "unknown-key-id" };
  if (!auth.ok) {
    // The reason is logged, never returned: a caller probing the endpoint learns nothing.
    return done(401, "unauthorized", { error: "unauthorized" }, { reason: auth.reason, bytes: bytes.byteLength });
  }

  let text: string;
  let data: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    data = JSON.parse(text);
  } catch {
    return done(422, "bad-json", { error: "invalid", errors: ["body is not valid UTF-8 JSON"] }, { bytes: bytes.byteLength });
  }

  // Only the primary host's snapshot is the dashboard's; any other valid host (the OCI host in its shadow run)
  // lands in shadow/latest.json, which no page and no watchdog reads. PRIMARY_HOST names the primary for every
  // desk, unless a key is scoped to a desk: that key is then the desk's primary and may publish nothing else.
  // Decided here, after the signature and before anything is routed or stored, so a wrong signature is answered
  // the same whether or not its key id is scoped.
  const scopes = parseScopes(process.env[SCOPES_ENV], [RADAR_KEY_ID]);
  if (!scopes.ok) logEvent("ingest.scopes", { outcome: "malformed", reason: scopes.reason });
  // The desk whose snapshot this body is, by the same routing as below; null for every other document kind.
  const snapshotOf = isRadar(data) || isOptions(data) || isOptionsLive(data) || isOptionsClone(data) || isCalendar(data) || isJournal(data) || isLedger(data) ? null : contractOf(data).desk;
  const scope = decideScope(scopes, keyId, snapshotOf, process.env.PRIMARY_HOST || DEFAULT_KEY_ID);
  if (!scope.allow && scope.outcome === "key-scope-config") {
    return done(503, "key-scope-config", { error: "ingest is not configured for this key" }, { key_id: keyId });
  }
  if (!scope.allow) {
    return done(403, "key-scope", { error: "this key may not publish this document" }, { key_id: keyId, desk: snapshotOf ?? "none" });
  }
  const primary = scope.primary;

  if (isRadar(data)) return storeEdition(RADAR_EDITION, text, data, done, now);
  if (isOptions(data)) return storeEdition(OPTIONS_EDITION, text, data, done, now);
  if (isLedger(data)) return storeEdition(LEDGER_EDITION, text, data, done, now);
  // The owner's journal is read from their own broker in the research environment, where the radar is built.
  if (isJournal(data)) return storeEdition(JOURNAL, text, data, done, now);
  if (keyId === RADAR_KEY_ID) {
    return done(403, "radar-key-scope", { error: "this key may only publish research editions" });
  }
  // After the radar key's refusal on purpose: positions and the clone's trades come from the trading host, never
  // from the research environment, whatever the body says it is.
  const hostDoc = isOptionsLive(data) ? OPTIONS_LIVE : isOptionsClone(data) ? OPTIONS_CLONE : isCalendar(data) ? CALENDAR : null;
  if (hostDoc) {
    // One slot, one account: a second host (a shadow run) would take turns with the primary in it. Its document
    // is acknowledged and dropped, so its job does not fail.
    if (!primary) return done(200, "ignored-shadow", { status: "ignored", shadow: true }, { key_id: keyId, desk: hostDoc.desk });
    // A document dated ahead of this clock would be shown as fresh, and refuse every true one as older, until
    // real time caught up with it.
    const at = Date.parse(String((data as { as_of?: unknown }).as_of ?? ""));
    if (Number.isFinite(at) && at > now.getTime() + OPTIONS_LIVE_AHEAD_MS) {
      await recordIngestReject({ at: now.toISOString(), kind: hostDoc.desk, outcome: "ahead-of-clock", n_errors: 1 });
      return done(422, "ahead-of-clock", { error: "invalid", errors: [AHEAD_ERROR] }, { desk: hostDoc.desk });
    }
    return storeEdition(hostDoc, text, data, done, now);
  }

  // The desk comes from the signed body (its `schema`), never from a header: ADR 0005. The slot and the validator
  // are read from the same contract, so the body is filed where it was validated.
  const contract = contractOf(data);
  const desk = contract.desk;
  const paths = DESK_PATHS[desk];
  const target = primary ? paths.latest : paths.shadow;
  const result = contract.validate(data);
  if (!result.ok) {
    return done(422, "invalid", { error: "invalid", errors: result.errors }, { bytes: bytes.byteLength, n_errors: result.errors.length });
  }
  const runId = result.snapshot.run_id;
  const asOf = orderInstant(result.snapshot.as_of);
  if (!runId || asOf === null) {
    return done(422, "invalid", { error: "invalid", errors: ["/run_id and /as_of must be set; as_of must be a timestamp"] });
  }

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readForUpdate(target);
      if (current) {
        const meta = currentMeta(current.text);
        if (meta.runId === runId) return done(200, "duplicate", { status: "duplicate", run_id: runId }, { run_id: runId });
        if (meta.asOf !== null && asOf <= meta.asOf) {
          return done(409, "older", { status: "older", run_id: runId }, { run_id: runId });
        }
      }
      try {
        await writeText(target, text, current ? { ifMatch: current.etag } : { createOnly: true });
      } catch (e) {
        if (e instanceof PreconditionFailed && attempt === 0) continue;
        if (e instanceof PreconditionFailed) {
          return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId });
        }
        throw e;
      }
      if (!primary) {
        return done(200, "stored-shadow", { status: "stored", run_id: runId, shadow: true }, { run_id: runId, key_id: keyId, desk });
      }
      try {
        await writeText(historyPath(asOf, paths.history), text);
      } catch (e) {
        logEvent("ingest.history", { outcome: "error", run_id: runId, error: e instanceof Error ? e.name : "unknown" });
      }
      return done(200, "stored", { status: "stored", run_id: runId }, { run_id: runId, bytes: bytes.byteLength, attempt, desk });
    }
  } catch (e) {
    return done(502, "storage-error", { error: "storage unavailable" }, { error: e instanceof Error ? e.name : "unknown" });
  }
  return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId });
}

type Done = (status: number, outcome: string, body: Record<string, unknown>, extra?: Record<string, unknown>) => Response;

/**
 * A document kind stored like a research edition: where it is stored, how it is validated, and which field names
 * its dated copy. A kind with no `history` path keeps only its latest.
 */
interface EditionKind {
  desk: IngestRejectKind;
  /** `copies`: every edition that became latest is also kept once, with the store's receipt time (writeCopy). */
  paths: { latest: string; history?: string; copies?: string };
  validate: (data: unknown) => { ok: true; runId: string | null; asOf: string | null; date: string } | { ok: false; errors: string[] };
  /**
   * The Options edition only (./premarket): its pre-market check is also kept on its own, and from 09:25 New York on
   * its session it may replace that session's edition only when nothing but its run, time and check differ.
   */
  focus?: true;
}

const RADAR_EDITION: EditionKind = {
  desk: "radar",
  paths: RADAR_PATHS,
  validate: (data) => {
    const r = validateRadarEdition(data);
    return r.ok ? { ok: true, runId: r.edition.run_id ?? null, asOf: r.edition.as_of ?? null, date: r.edition.edition_date } : r;
  },
};

const OPTIONS_EDITION: EditionKind = {
  desk: "options",
  paths: OPTIONS_PATHS,
  focus: true,
  validate: (data) => {
    const r = validateOptionsEdition(data);
    return r.ok ? { ok: true, runId: r.edition.run_id ?? null, asOf: r.edition.as_of ?? null, date: r.edition.session } : r;
  },
};

/** The focus card ledger: one dated copy per scored session. */
const LEDGER_EDITION: EditionKind = {
  desk: "ledger",
  paths: LEDGER_PATHS,
  validate: (data) => {
    const r = validateLedger(data);
    return r.ok ? { ok: true, runId: r.edition.run_id, asOf: r.edition.as_of, date: r.edition.session } : r;
  },
};

/** The options live document. Latest only; the date it returns is never used to file a copy. */
const OPTIONS_LIVE: EditionKind = {
  desk: "options-live",
  paths: OPTIONS_LIVE_PATHS,
  validate: (data) => {
    const r = validateOptionsLive(data);
    return r.ok ? { ok: true, runId: r.doc.run_id, asOf: r.doc.as_of, date: r.doc.as_of.slice(0, 10) } : r;
  },
};

/** The options clone's document. Latest only: every document carries the figures of every trade so far. */
const OPTIONS_CLONE: EditionKind = {
  desk: "options-clone",
  paths: OPTIONS_CLONE_PATHS,
  validate: (data) => {
    const r = validateOptionsClone(data);
    return r.ok ? { ok: true, runId: r.doc.run_id, asOf: r.doc.as_of, date: r.doc.session } : r;
  },
};

/** The economic calendar, from the trading host's weekly econ-calendar job. Latest only: it carries the whole range. */
const CALENDAR: EditionKind = {
  desk: "calendar",
  paths: CALENDAR_PATHS,
  validate: (data) => {
    const r = validateCalendar(data);
    return r.ok ? { ok: true, runId: r.doc.run_id, asOf: r.doc.as_of, date: r.doc.as_of.slice(0, 10) } : r;
  },
};

/** The trade journal. Latest only: every document carries the whole history. */
const JOURNAL: EditionKind = {
  desk: "journal",
  paths: JOURNAL_PATHS,
  validate: (data) => {
    const r = validateJournal(data);
    return r.ok ? { ok: true, runId: r.doc.run_id, asOf: r.doc.as_of, date: r.doc.as_of.slice(0, 10) } : r;
  },
};

/**
 * A research edition (radar or options levels): the same duplicate / older / etag rules as a desk snapshot,
 * written to its latest.json, plus one copy per edition date. A same-day refresh (a later as_of) replaces both.
 * A kind with `copies` (the Options edition) also keeps each edition that became latest, never replaced (writeCopy).
 * Any valid key may publish one.
 *
 * An edition dated ahead of the clock is refused: stored, it would refuse every true edition after it as older
 * until real time caught up. One stored before this guard (or under a wider allowance) is not "newer": a valid
 * edition that is not ahead replaces it whatever its as_of ("superseded-ahead"). A refusal for content is recorded
 * for the monitoring (./ingest-reject); a duplicate or an older edition is an ordinary answer and is not.
 */
async function storeEdition(kind: EditionKind, text: string, data: unknown, done: Done, now: Date): Promise<Response> {
  const { desk, paths } = kind;
  const nowMs = now.getTime();
  const refuse = async (outcome: "invalid" | "ahead-of-clock", errors: string[], extra: Record<string, unknown>) => {
    await recordIngestReject({ at: now.toISOString(), kind: desk, outcome, n_errors: errors.length });
    return done(422, outcome, { error: "invalid", errors }, extra);
  };
  const result = kind.validate(data);
  if (!result.ok) return refuse("invalid", result.errors, { desk, n_errors: result.errors.length });
  const { runId, date } = result;
  const asOf = orderInstant(result.asOf);
  if (!runId || asOf === null) {
    return refuse("invalid", ["/run_id and /as_of must be set; as_of must be a timestamp"], {});
  }
  if (isAheadOfClock(result.asOf, nowMs)) return refuse("ahead-of-clock", [AHEAD_ERROR], { desk });
  // Before the edition's own write and whatever its answer, so that a check the freeze refuses with its edition is
  // still kept, and a re-run of the evening pick cannot take it away.
  if (kind.focus) await keepPremarket(data as OptionsEdition, nowMs);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readForUpdate(paths.latest);
      let supersedes = false;
      if (current) {
        const meta = currentMeta(current.text);
        if (meta.runId === runId) {
          // A retry of the run on latest: make its copy if it is missing, from what latest holds and when latest took
          // it (the original write's time, never the retry's). Best effort: the answer is a duplicate whatever happens.
          if (paths.copies) await writeCopy(paths.latest, paths.copies, runAndSession(current.text).session ?? date, runId, current.text, current.etag);
          return done(200, "duplicate", { status: "duplicate", run_id: runId }, { run_id: runId, desk });
        }
        if (meta.asOf !== null && asOf <= meta.asOf) {
          // Only a stored document ordered beyond the clock's allowance gives way; every other older edition is refused.
          if (!storedAhead(meta.asOf, nowMs)) return done(409, "older", { status: "older", run_id: runId }, { run_id: runId, desk });
          supersedes = true;
        }
      }
      if (kind.focus && focusFrozen(date, now)) {
        // The session's edition as the desk opened with it: latest when it is that session's, else the session's own
        // dated file (latest may hold another session's edition, from a manual send or a backfill).
        const fromLatest = current ? parsedObject(current.text) : null;
        const held =
          fromLatest && fromLatest.session === date
            ? fromLatest
            : paths.history
              ? parsedObject((await readForUpdate(`${paths.history}${date}.json`))?.text ?? "")
              : null;
        if (held && held.session === date && !sameApartFromPremarket(held, data)) {
          await recordIngestReject({ at: now.toISOString(), kind: desk, outcome: "frozen", n_errors: 1 });
          return done(409, "frozen", { status: "frozen", run_id: runId }, { run_id: runId, desk, session: date });
        }
      }
      // Started beside the write, never awaited before it: whether the edition this write replaces has a copy.
      const lost = paths.copies && current ? copyMissing(paths.copies, current) : null;
      let written: { etag: string };
      try {
        written = await writeText(paths.latest, text, current ? { ifMatch: current.etag } : { createOnly: true });
      } catch (e) {
        if (e instanceof PreconditionFailed && attempt === 0) continue;
        if (e instanceof PreconditionFailed) return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId, desk });
        throw e;
      }
      if (paths.copies) {
        // Only now that a write conditioned on current.etag has succeeded is current.text known to be that write's
        // text, so only now may the replaced edition be called lost.
        const gone = await lost;
        if (gone) logEvent("ingest.copy", { outcome: "lost", run_id: gone.runId, session: gone.session });
        // Right after the write, so that latest is least likely to have moved on before its time is read.
        await writeCopy(paths.latest, paths.copies, date, runId, text, written.etag);
      }
      if (paths.history) {
        try {
          await writeDated(`${paths.history}${date}.json`, text, asOf, nowMs);
        } catch (e) {
          logEvent("ingest.history", { outcome: "error", run_id: runId, desk, error: e instanceof Error ? e.name : "unknown" });
        }
      }
      return done(200, supersedes ? "superseded-ahead" : "stored", { status: "stored", run_id: runId }, { run_id: runId, bytes: text.length, attempt, desk });
    }
  } catch (e) {
    return done(502, "storage-error", { error: "storage unavailable" }, { error: e instanceof Error ? e.name : "unknown", desk });
  }
  return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId, desk });
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the edition's pre-market check in options/premarket/<session>.json when it is later than the one kept (by
 * the check's own as_of; one dated ahead of the clock is not kept). Best effort: never throws, each store call is
 * capped at PREMARKET_IO_MS, one log line per outcome, and it never changes what the ingest answers.
 */
async function keepPremarket(e: OptionsEdition, nowMs: number): Promise<void> {
  const next = premarketOf(e);
  if (!next) return;
  if (isAheadOfClock(next.as_of, nowMs)) {
    logEvent("ingest.premarket", { outcome: "ahead-of-clock", session: next.session });
    return;
  }
  const text = storedPremarketText(next);
  // Only a check the reader can read back is kept: one it would drop must not replace a good one.
  if (parseStoredPremarket(text) === null) {
    logEvent("ingest.premarket", { outcome: "unreadable", session: next.session });
    return;
  }
  const path = premarketPath(next.session);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await within(readForUpdate(path));
      const stored = current ? parseStoredPremarket(current.text) : null;
      if (current && stored && !premarketIsNewer(next, stored)) {
        logEvent("ingest.premarket", { outcome: "not-newer", session: next.session });
        return;
      }
      try {
        await within(writeText(path, text, current ? { ifMatch: current.etag } : { createOnly: true }));
        logEvent("ingest.premarket", { outcome: "stored", session: next.session, n: next.items.length });
        return;
      } catch (err) {
        if (err instanceof PreconditionFailed && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    logEvent("ingest.premarket", { outcome: "error", session: next.session, error: err instanceof Error ? err.name : "unknown" });
  }
}

/**
 * The dated copy, written only while nothing newer is there: two overlapping publishes for one date are ordered
 * by latest.json, and this keeps the dated copy from being overwritten by the older of the two.
 */
async function writeDated(path: string, text: string, asOf: number, nowMs: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readForUpdate(path);
    const stored = current ? currentMeta(current.text) : null;
    // A copy dated ahead of the clock is not newer: it gives way, as latest.json does (storeEdition).
    if (stored && stored.asOf !== null && stored.asOf >= asOf && !storedAhead(stored.asOf, nowMs)) return;
    try {
      await writeText(path, text, current ? { ifMatch: current.etag } : { createOnly: true });
      return;
    } catch (e) {
      if (!(e instanceof PreconditionFailed) || attempt === 1) throw e;
    }
  }
}

/**
 * Keeps, best effort, the copy of the edition that latest.json holds as `latestEtag` (./edition-copy): its exact text,
 * under a path fixed by the session, the store's receipt time and the run, written create-only. Never throws, and the
 * ingest's answer never depends on it: a published edition must never look unpublished because its copy failed, and
 * the edition's publishers are not all ones that retry. What this does not make, the watchdog's repair makes
 * (./edition-copy-repair) from the store's own read of latest, while that edition is still latest.
 *
 * The receipt time is the store's own: latest.json's uploadedAt, read with its etag in one head() (blob.ts
 * storedMeta), and used only when that etag is the one this write was given (the put's, or on a duplicate the
 * head's that the text was read with). Nothing from the request (as_of, headers, body fields) enters it. One
 * `ingest.copy` line per call, never anything of the edition:
 *  - "stored": the copy was written; "exists": it was already there (the create-only write was refused).
 *  - "unconfirmed": the head's etag is not this write's. Latest may have moved on to a newer run, or the store may
 *    give the put's etag and the head's in different forms, so only the two forms are logged (length, quoted,
 *    weak), never the values. No copy is made from it; the repair makes one while the edition is still latest.
 *  - "error": the store failed (the head or the put), named by the error's class.
 */
async function writeCopy(latestPath: string, prefix: string, session: string, runId: string, editionText: string, latestEtag: string): Promise<void> {
  let bytes = 0;
  try {
    const meta = await storedMeta(latestPath);
    if (!meta || meta.etag !== latestEtag) {
      logEvent("ingest.copy", { outcome: "unconfirmed", run_id: runId, session, bytes, written_etag: etagShape(latestEtag), head_etag: etagShape(meta?.etag) });
      return;
    }
    const copy = editionCopyFor(prefix, session, meta.uploadedAt, runId, editionText);
    if (!copy) {
      logEvent("ingest.copy", { outcome: "error", run_id: runId, session, bytes, error: "UnusableTime" });
      return;
    }
    bytes = copy.body.length;
    try {
      await writeText(copy.path, copy.body, { createOnly: true });
      logEvent("ingest.copy", { outcome: "stored", run_id: runId, session, bytes });
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
      logEvent("ingest.copy", { outcome: "exists", run_id: runId, session, bytes });
    }
  } catch (e) {
    logEvent("ingest.copy", { outcome: "error", run_id: runId, session, bytes, error: e instanceof Error ? e.name : "unknown" });
  }
}

/**
 * Whether the edition about to be replaced on latest (`current`, as read for this write) has no copy: one existence
 * check on the path its run, session and the store's time of its write fix. Resolves to that run and session when
 * the copy is missing, null when it is there or cannot be told (no time from the store, an unreadable text, a
 * storage error). Never rejects. Its answer counts only once the write conditioned on `current.etag` has succeeded:
 * an edition replaced with no copy can never be given one with a true receipt time, so it is said ("lost").
 */
async function copyMissing(prefix: string, current: { text: string; uploadedAt?: string }): Promise<{ runId: string; session: string } | null> {
  try {
    if (!current.uploadedAt) return null;
    const { runId, session } = runAndSession(current.text);
    if (!runId || !session) return null;
    const copy = editionCopyFor(prefix, session, current.uploadedAt, runId, "");
    if (!copy) return null;
    return (await exists(copy.path)) ? null : { runId, session };
  } catch {
    return null;
  }
}
