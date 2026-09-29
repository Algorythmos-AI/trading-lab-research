import "server-only";
import { HISTORY_PREFIX, LATEST_PATH, PreconditionFailed, readForUpdate, writeText } from "./blob";
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
  const secret = process.env.DASHBOARD_INGEST_SECRET;
  if (!secret) return done(503, "not-configured", { error: "ingest is not configured" });

  const bytes = await readCapped(req, MAX_BODY_BYTES);
  if (!bytes) return done(413, "too-large", { error: `body exceeds ${MAX_BODY_BYTES} bytes` });

  const auth = verify(secret, req.headers.get("x-wt-timestamp"), req.headers.get("x-wt-signature"), bytes, now);
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
      const current = await readForUpdate(LATEST_PATH);
      if (current) {
        const meta = currentMeta(current.text);
        if (meta.runId === runId) return done(200, "duplicate", { status: "duplicate", run_id: runId }, { run_id: runId });
        if (meta.asOf !== null && asOf <= meta.asOf) {
          return done(409, "older", { status: "older", run_id: runId }, { run_id: runId });
        }
      }
      try {
        await writeText(LATEST_PATH, text, current ? { ifMatch: current.etag } : { createOnly: true });
      } catch (e) {
        if (e instanceof PreconditionFailed && attempt === 0) continue;
        if (e instanceof PreconditionFailed) {
          return done(503, "conflict", { status: "conflict", run_id: runId }, { run_id: runId });
        }
        throw e;
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
