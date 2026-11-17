import "server-only";
import { createHash } from "node:crypto";
import { listPaths, readText } from "./blob";
import { RADAR_PATHS } from "./desk";
import { editionCopyText, parseEditionCopy, parseLostMarker } from "./edition-copy";
import { verify } from "./hmac";
import { RADAR_KEY_ID, secretFor } from "./ingest";
import { logEvent } from "./log";

// GET /api/research/radar-copies?date=YYYY-MM-DD: the radar edition copies the store holds for one edition date, for
// DEC-0055's daily receipt listing (sealed by trading-options-funnel after the open). Only the radar (research) key
// may ask. It returns each copy's path, the store's receipt time, the run, and two sha256s (of the stored copy and of
// the edition bytes inside it), never the edition itself, so nothing of the radar's content leaves through here.

/** What is signed: method, path and the date, so a signature is good for one date of this route only, for 5 minutes. */
export function radarCopiesSigned(date: string): string {
  return `GET /api/research/radar-copies?date=${date}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** More copies than this for one date is not a normal day: answered as an error rather than truncated. */
export const MAX_COPIES = 200;

export interface RadarCopyRow {
  path: string;
  received_at: string;
  run_id: string;
  /** True for an edition that became latest and was replaced before its copy was made: no hashes. */
  lost: boolean;
  copy_sha256: string | null;
  edition_sha256: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The edition bytes inside a copy: the envelope is the head editionCopyText writes, `,"edition":`, the bytes, then one
 * `}`. Null unless the head is exactly that head, so a copy written any other way is never hashed wrongly.
 */
export function editionBytes(copyText: string): string | null {
  const parsed = parseEditionCopy(copyText);
  if (!parsed) return null;
  const head = editionCopyText(parsed.receivedAt, parsed.session, parsed.runId, "").slice(0, -1);
  if (!copyText.startsWith(head) || !copyText.endsWith("}")) return null;
  return copyText.slice(head.length, -1);
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export interface RadarCopiesDeps {
  list(prefix: string): Promise<{ pathname: string }[]>;
  read(path: string): Promise<string | null>;
}

const blobDeps: RadarCopiesDeps = {
  list: (prefix) => listPaths(prefix),
  read: async (path) => (await readText(path))?.text ?? null,
};

export async function handleRadarCopies(req: Request, now: Date = new Date(), deps: RadarCopiesDeps = blobDeps): Promise<Response> {
  const started = Date.now();
  const done = (status: number, outcome: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    logEvent("radar-copies", { outcome, status, ms: Date.now() - started, ...extra });
    return json(status, body);
  };
  const date = new URL(req.url).searchParams.get("date") ?? "";
  const asDate = new Date(`${date}T00:00:00Z`);
  if (!DATE_RE.test(date) || Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== date) {
    return done(400, "bad-date", { error: "date must be YYYY-MM-DD" });
  }
  // The research key only: the trading host's keys have no business reading the radar's receipts.
  if (req.headers.get("x-wt-key-id") !== RADAR_KEY_ID) return done(401, "unauthorized", { error: "unauthorized" }, { reason: "key-id" });
  const secret = secretFor(RADAR_KEY_ID);
  if (!secret) return done(503, "not-configured", { error: "not configured" });
  const auth = verify(secret, req.headers.get("x-wt-timestamp"), req.headers.get("x-wt-signature"), radarCopiesSigned(date), now);
  if (!auth.ok) return done(401, "unauthorized", { error: "unauthorized" }, { reason: auth.reason });

  let paths: string[];
  try {
    paths = (await deps.list(`${RADAR_PATHS.copies}${date}/`)).map((b) => b.pathname).sort();
  } catch (e) {
    return done(502, "storage-error", { error: "storage unavailable" }, { error_class: e instanceof Error ? e.name : "unknown" });
  }
  if (paths.length > MAX_COPIES) return done(502, "too-many", { error: "too many copies for one date" }, { n: paths.length });
  const copies: RadarCopyRow[] = [];
  for (const path of paths) {
    let text: string | null;
    try {
      text = await deps.read(path);
    } catch (e) {
      return done(502, "storage-error", { error: "storage unavailable" }, { error_class: e instanceof Error ? e.name : "unknown" });
    }
    if (text !== null && path.endsWith(".lost.json")) {
      const lost = parseLostMarker(text);
      if (!lost || lost.session !== date) return done(502, "unreadable-copy", { error: "a stored copy could not be read" }, { n: paths.length });
      copies.push({ path, received_at: lost.receivedAt, run_id: lost.runId, lost: true, copy_sha256: null, edition_sha256: null });
      continue;
    }
    const parsed = text === null ? null : parseEditionCopy(text);
    const bytes = text === null ? null : editionBytes(text);
    // A copy that cannot be read as one is reported as an error, never skipped: a listing must hold every copy.
    if (text === null || !parsed || bytes === null || parsed.session !== date) {
      return done(502, "unreadable-copy", { error: "a stored copy could not be read" }, { n: paths.length });
    }
    copies.push({ path, received_at: parsed.receivedAt, run_id: parsed.runId, lost: false, copy_sha256: sha256(text), edition_sha256: sha256(bytes) });
  }
  return done(200, "ok", { schema: "stocksdelta/radar-copies", version: 1, date, copies }, { n: copies.length });
}
