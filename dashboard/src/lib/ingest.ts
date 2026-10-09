import "server-only";
import { HISTORY_PREFIX, PreconditionFailed, readForUpdate, writeText } from "./blob";
import { DESK_PATHS, RADAR_PATHS } from "./desk";
import { verify } from "./hmac";
import { logEvent } from "./log";
import { parseTime } from "./freshness";
import { deskOf, isRadar, validateCryptoSnapshot, validateRadarEdition, validateSnapshot } from "./validate";

export const MAX_BODY_BYTES = 3_500_000;

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
      asOf: typeof cur.as_of === "string" ? parseTime(cur.as_of) : null,
    };
  } catch {
    return { runId: null, asOf: null };
  }
}

/** The id a host signs with (x-wt-key-id); the Mac's publisher predates ids and is "default". */
export const DEFAULT_KEY_ID = "default";

/**
 * The key the pre-market radar signs with. It lives in a cloud research environment, not on a trading host, so
 * it may only publish radar editions: a stocks or crypto snapshot signed with it is refused.
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

/**
 * POST /api/ingest. Order: environment gate, size cap, HMAC, JSON, schema + denylist, then a
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
  const keyId = keyIdHeader && /^[A-Za-z0-9._-]{1,40}$/.test(keyIdHeader) ? keyIdHeader : DEFAULT_KEY_ID;
  if (!process.env.DASHBOARD_INGEST_SECRET && !process.env.DASHBOARD_INGEST_KEYS && !process.env.RADAR_INGEST_SECRET) {
    return done(503, "not-configured", { error: "ingest is not configured" });
  }
  const secret = secretFor(keyId);
  // Only the primary host's snapshot is the dashboard's; any other valid host (the OCI host in its shadow run)
  // lands in shadow/latest.json, which no page and no watchdog reads.
  const primary = (process.env.PRIMARY_HOST || DEFAULT_KEY_ID) === keyId;

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

  if (isRadar(data)) return storeRadar(text, data, done);
  if (keyId === RADAR_KEY_ID) {
    return done(403, "radar-key-scope", { error: "this key may only publish radar editions" });
  }

  // The desk comes from the signed body (its `schema`), never from a header: ADR 0005.
  const desk = deskOf(data);
  const paths = DESK_PATHS[desk];
  const target = primary ? paths.latest : paths.shadow;
  const result = desk === "crypto" ? validateCryptoSnapshot(data) : validateSnapshot(data);
  if (!result.ok) {
    return done(422, "invalid", { error: "invalid", errors: result.errors }, { bytes: bytes.byteLength, n_errors: result.errors.length });
  }
  const runId = result.snapshot.run_id;
  const asOf = parseTime(result.snapshot.as_of ?? null);
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
 * A radar edition: the same duplicate / older / etag rules as a desk snapshot, written to radar/latest.json, plus
 * one copy per edition date. A same-day refresh (a later as_of) replaces both. Any valid key may publish one.
 */
async function storeRadar(text: string, data: unknown, done: Done): Promise<Response> {
  const result = validateRadarEdition(data);
  if (!result.ok) return done(422, "invalid", { error: "invalid", errors: result.errors }, { desk: "radar", n_errors: result.errors.length });
  const { run_id: runId, edition_date: date } = result.edition;
  const asOf = parseTime(result.edition.as_of ?? null);
  if (!runId || asOf === null) {
    return done(422, "invalid", { error: "invalid", errors: ["/run_id and /as_of must be set; as_of must be a timestamp"] });
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readForUpdate(RADAR_PATHS.latest);
      if (current) {
        const meta = currentMeta(current.text);
        if (meta.runId === runId) return done(200, "duplicate", { status: "duplicate", run_id: runId }, { run_id: runId, desk: "radar" });
        if (meta.asOf !== null && asOf <= meta.asOf) {
          return done(409, "older", { status: "older", run_id: runId }, { run_id: runId, desk: "radar" });
        }
      }
      try {
        await writeText(RADAR_PATHS.latest, text, current ? { ifMatch: current.etag } : { createOnly: true });
      } catch (e) {
        if (e instanceof PreconditionFailed && attempt === 0) continue;
        if (e instanceof PreconditionFailed) return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId, desk: "radar" });
        throw e;
      }
      try {
        await writeDatedRadar(`${RADAR_PATHS.history}${date}.json`, text, asOf);
      } catch (e) {
        logEvent("ingest.history", { outcome: "error", run_id: runId, desk: "radar", error: e instanceof Error ? e.name : "unknown" });
      }
      return done(200, "stored", { status: "stored", run_id: runId }, { run_id: runId, bytes: text.length, attempt, desk: "radar" });
    }
  } catch (e) {
    return done(502, "storage-error", { error: "storage unavailable" }, { error: e instanceof Error ? e.name : "unknown", desk: "radar" });
  }
  return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId, desk: "radar" });
}

/**
 * The dated copy, written only while nothing newer is there: two overlapping publishes for one date are ordered
 * by latest.json, and this keeps the dated copy from being overwritten by the older of the two.
 */
async function writeDatedRadar(path: string, text: string, asOf: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readForUpdate(path);
    const stored = current ? currentMeta(current.text).asOf : null;
    if (stored !== null && stored >= asOf) return;
    try {
      await writeText(path, text, current ? { ifMatch: current.etag } : { createOnly: true });
      return;
    } catch (e) {
      if (!(e instanceof PreconditionFailed) || attempt === 1) throw e;
    }
  }
}
