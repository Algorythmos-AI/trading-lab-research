import "server-only";
import { verify } from "./hmac";
import { DEFAULT_KEY_ID, REGISTRY_KEY_ID, secretFor } from "./ingest";
import { KEY_ID_RE } from "./ingest-scope";
import { logEvent } from "./log";
import type { OptionsEdition } from "./options.types";
import { loadOptions } from "./snapshot";

/**
 * The route signs no body: the method and path stand in for it, with the same timestamp and HMAC as /api/ingest
 * (`sha256=` + hex(HMAC_SHA256(secret, `${ts}.GET /api/focus`))). A signature is good for this route only, and for
 * five minutes. Matches wt.options.clone_site.focus_signature.
 */
export const FOCUS_SIGNED = "GET /api/focus";

export interface FocusItem {
  symbol: string;
  rank: number;
  bias: "breakout" | "support" | "range";
}

/** What the clone needs from an options edition: its focus names by rank, and the session they are for. */
export function focusOf(e: OptionsEdition): { session: string; items: FocusItem[] } {
  const items = (e.focus?.items ?? []).map(({ symbol, rank, bias }) => ({ symbol, rank, bias }));
  return { session: e.session, items: items.sort((a, b) => a.rank - b.rank) };
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/focus, for the trading host's options clone. Signed with a host's ingest key (x-wt-key-id), refused
 * unsigned, wrongly signed or stale, with one answer for every refusal. Returns only the latest options edition's
 * focus names (symbol, rank, bias) and its session date: nothing else of the edition leaves through here.
 */
export async function handleFocus(req: Request, now: Date = new Date()): Promise<Response> {
  const started = Date.now();
  const done = (status: number, outcome: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    logEvent("focus", { outcome, status, ms: Date.now() - started, ...extra });
    return json(status, body);
  };
  if (!process.env.DASHBOARD_INGEST_SECRET && !process.env.DASHBOARD_INGEST_KEYS) {
    return done(503, "not-configured", { error: "not configured" });
  }
  const keyIdHeader = req.headers.get("x-wt-key-id");
  const keyId = keyIdHeader && KEY_ID_RE.test(keyIdHeader) ? keyIdHeader : DEFAULT_KEY_ID;
  // The registry's CI key publishes its index and reads nothing.
  const secret = keyId === REGISTRY_KEY_ID ? null : secretFor(keyId);
  const auth = secret
    ? verify(secret, req.headers.get("x-wt-timestamp"), req.headers.get("x-wt-signature"), FOCUS_SIGNED, now)
    : { ok: false as const, reason: keyId === REGISTRY_KEY_ID ? "registry-key" : "unknown-key-id" };
  // The reason is logged, never returned.
  if (!auth.ok) return done(401, "unauthorized", { error: "unauthorized" }, { reason: auth.reason });

  const r = await loadOptions();
  if (r.status === "missing") return done(404, "missing", { error: "no options edition" }, { key_id: keyId });
  if (r.status !== "ok") return done(502, "storage-error", { error: "storage unavailable" }, { key_id: keyId });
  const out = focusOf(r.edition);
  return done(200, "ok", { ...out }, { key_id: keyId, session: out.session, n: out.items.length });
}
