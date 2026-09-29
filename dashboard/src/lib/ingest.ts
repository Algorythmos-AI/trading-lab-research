import "server-only";
import { HISTORY_PREFIX, LATEST_PATH, PreconditionFailed, SHADOW_LATEST_PATH, readForUpdate, writeText } from "./blob";
import { verify } from "./hmac";
import { logEvent } from "./log";
import { parseTime } from "./freshness";
import { validateSnapshot } from "./validate";

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
export function historyPath(asOfMs: number): string {
  const iso = new Date(asOfMs).toISOString();
  return `${HISTORY_PREFIX}${iso.slice(0, 10)}/${iso.slice(11, 13)}.json`;
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
  if (!process.env.DASHBOARD_INGEST_SECRET && !process.env.DASHBOARD_INGEST_KEYS) {
    return done(503, "not-configured", { error: "ingest is not configured" });
  }
  const secret = secretFor(keyId);
  // Only the primary host's snapshot is the dashboard's; any other valid host (the OCI host in its shadow run)
  // lands in shadow/latest.json, which no page and no watchdog reads.
  const primary = (process.env.PRIMARY_HOST || DEFAULT_KEY_ID) === keyId;
  const target = primary ? LATEST_PATH : SHADOW_LATEST_PATH;

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

  const result = validateSnapshot(data);
  if (!result.ok) {
    return done(422, "invalid", { error: "invalid", errors: result.errors }, { bytes: bytes.byteLength, n_errors: result.errors.length });
  }
  const runId = result.snapshot.run_id;
  const asOf = parseTime(result.snapshot.as_of);
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
        return done(200, "stored-shadow", { status: "stored", run_id: runId, shadow: true }, { run_id: runId, key_id: keyId });
      }
      try {
        await writeText(historyPath(asOf), text);
      } catch (e) {
        logEvent("ingest.history", { outcome: "error", run_id: runId, error: e instanceof Error ? e.name : "unknown" });
      }
      return done(200, "stored", { status: "stored", run_id: runId }, { run_id: runId, bytes: bytes.byteLength, attempt });
    }
  } catch (e) {
    return done(502, "storage-error", { error: "storage unavailable" }, { error: e instanceof Error ? e.name : "unknown" });
  }
  return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId });
}
