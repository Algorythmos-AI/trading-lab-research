import "server-only";
import { verify } from "./hmac";
import { DEFAULT_KEY_ID, RADAR_KEY_ID, secretFor } from "./ingest";
import { KEY_ID_RE } from "./ingest-scope";
import { logEvent } from "./log";
import { loadOptions, loadRadar } from "./snapshot";

/**
 * GET /api/editions/<kind>, for the trading host's pipeline check (wt.options.pipeline_check): the latest stored
 * radar or options edition, exactly as the site shows it to the owner. Signed like /api/focus: no body, so the
 * method and path stand in for it (`sha256=` + hex(HMAC_SHA256(secret, `${ts}.GET /api/editions/<kind>`))), good for
 * this one path and five minutes. A trading host's key only: the radar's own key may publish, never read back.
 */
export const EDITION_KINDS = ["radar", "options"] as const;
export type EditionKind = (typeof EDITION_KINDS)[number];
export const editionSigned = (kind: EditionKind) => `GET /api/editions/${kind}`;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function handleEdition(req: Request, kind: string, now: Date = new Date()): Promise<Response> {
  const started = Date.now();
  const done = (status: number, outcome: string, body: unknown, extra: Record<string, unknown> = {}) => {
    logEvent("edition-read", { outcome, status, kind, ms: Date.now() - started, ...extra });
    return json(status, body);
  };
  if (!(EDITION_KINDS as readonly string[]).includes(kind)) return done(404, "unknown-kind", { error: "not found" });
  if (!process.env.DASHBOARD_INGEST_SECRET && !process.env.DASHBOARD_INGEST_KEYS) {
    return done(503, "not-configured", { error: "not configured" });
  }
  const header = req.headers.get("x-wt-key-id");
  const keyId = header && KEY_ID_RE.test(header) ? header : DEFAULT_KEY_ID;
  const secret = keyId === RADAR_KEY_ID ? null : secretFor(keyId);
  const auth = secret
    ? verify(secret, req.headers.get("x-wt-timestamp"), req.headers.get("x-wt-signature"), editionSigned(kind as EditionKind), now)
    : { ok: false as const, reason: keyId === RADAR_KEY_ID ? "radar-key" : "unknown-key-id" };
  if (!auth.ok) return done(401, "unauthorized", { error: "unauthorized" }, { reason: auth.reason });
  const r = kind === "radar" ? await loadRadar() : await loadOptions();
  if (r.status === "missing") return done(404, "missing", { error: "no edition" }, { key_id: keyId });
  if (r.status !== "ok") return done(502, "storage-error", { error: "storage unavailable" }, { key_id: keyId });
  return done(200, "ok", { kind, edition: r.edition }, { key_id: keyId });
}
