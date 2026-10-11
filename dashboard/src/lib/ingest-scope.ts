// Per-key scopes for /api/ingest (ADR 0006, addendum of 2026-10-11). Pure: no environment, no request, no storage.
//
// DASHBOARD_INGEST_SCOPES is an optional JSON map {"<key id>": {"desks": ["hft"]}}. A key id listed there is the
// primary publisher of exactly those desks, whatever PRIMARY_HOST says, and may publish nothing else. A key id
// not listed keeps the PRIMARY_HOST rule, except for a desk some listed key owns: there it is never primary.
// Secrets are not here. They stay in DASHBOARD_INGEST_KEYS.

import { DESKS, type DeskName } from "./desk";

/** What a key id (the x-wt-key-id header, and a key of the scopes map) must look like. */
export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;

export type ScopeError =
  | "not-json"
  | "not-an-object"
  | "bad-key-id"
  | "reserved-key-id"
  | "bad-entry"
  | "empty-desks"
  | "unknown-desk"
  | "desk-claimed-twice";

export type Scopes =
  | {
      ok: true;
      /** The desks each scoped key id may publish, and is primary for. */
      byKey: ReadonlyMap<string, ReadonlySet<DeskName>>;
      /** The one scoped key id that owns a desk. A desk missing here follows PRIMARY_HOST. */
      owner: ReadonlyMap<DeskName, string>;
    }
  | {
      ok: false;
      /** Why the value was refused. A code, never a piece of the value. */
      reason: ScopeError;
      /** Every word of the refused text that could be a key id. A request signed with one of them is refused. */
      named: ReadonlySet<string>;
    };

const NONE: Scopes = { ok: true, byKey: new Map(), owner: new Map() };

function isDesk(v: unknown): v is DeskName {
  return typeof v === "string" && (DESKS as readonly string[]).includes(v);
}

/**
 * Reads the scopes map. Unset, blank and `{}` all mean "no scopes", which is the behaviour before scopes existed.
 *
 * Anything else that is not exactly the documented shape is refused whole: text that is not JSON, a value that is
 * not an object, a key id outside KEY_ID_RE or in `reserved`, an entry that is not `{"desks": [...]}` and nothing
 * more, an empty desk list, a desk name this site does not have, or one desk given to two key ids. No part of a
 * refused value is applied. Instead every word in it that could be a key id is remembered, and decideScope
 * refuses those ids outright: a key somebody meant to limit must not fall back to being unlimited because of a
 * typing mistake. The words are matched whole, so the match is wider than the map's keys (a desk name in the
 * text counts too); that errs on the side of refusing.
 */
export function parseScopes(raw: string | undefined | null, reserved: readonly string[] = []): Scopes {
  if (raw === undefined || raw === null || raw.trim() === "") return NONE;
  const bad = (reason: ScopeError): Scopes => ({
    ok: false,
    reason,
    named: new Set(raw.split(/[^A-Za-z0-9._-]+/).filter((w) => KEY_ID_RE.test(w))),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad("not-json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return bad("not-an-object");

  const byKey = new Map<string, ReadonlySet<DeskName>>();
  const owner = new Map<DeskName, string>();
  for (const [keyId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID_RE.test(keyId)) return bad("bad-key-id");
    if (reserved.includes(keyId)) return bad("reserved-key-id");
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return bad("bad-entry");
    const fields = Object.keys(entry);
    const desks = (entry as { desks?: unknown }).desks;
    if (fields.length !== 1 || fields[0] !== "desks" || !Array.isArray(desks)) return bad("bad-entry");
    if (desks.length === 0) return bad("empty-desks");
    const mine = new Set<DeskName>();
    for (const desk of desks as unknown[]) {
      if (!isDesk(desk)) return bad("unknown-desk");
      if (mine.has(desk) || owner.has(desk)) return bad("desk-claimed-twice");
      mine.add(desk);
      owner.set(desk, keyId);
    }
    byKey.set(keyId, mine);
  }
  return { ok: true, byKey, owner };
}

export type ScopeDecision =
  /** File the body: in the visible slot when `primary`, otherwise as a non-primary key's body is filed. */
  | { allow: true; primary: boolean }
  /** `key-scope`: outside what this key may publish. `key-scope-config`: the scopes map is unreadable and names this key. */
  | { allow: false; outcome: "key-scope" | "key-scope-config" };

/**
 * What ingest does with a body whose signature has already been checked.
 *
 * `desk` is the desk whose snapshot the body is (from its own `schema`), or null for every other document kind:
 * a research edition or the options live document. `primaryHost` is PRIMARY_HOST, or the default key id.
 *
 * - A scoped key: primary for a desk it lists; refused for everything else, so nothing of it is stored.
 * - An unscoped key: primary when it is `primaryHost`, except for a desk that a scoped key owns.
 * - An unreadable map: a key id it names is refused; every other key follows `primaryHost` alone.
 */
export function decideScope(scopes: Scopes, keyId: string, desk: DeskName | null, primaryHost: string): ScopeDecision {
  if (!scopes.ok) {
    if (scopes.named.has(keyId)) return { allow: false, outcome: "key-scope-config" };
    return { allow: true, primary: keyId === primaryHost };
  }
  const mine = scopes.byKey.get(keyId);
  if (mine) {
    return desk !== null && mine.has(desk) ? { allow: true, primary: true } : { allow: false, outcome: "key-scope" };
  }
  if (desk !== null && scopes.owner.has(desk)) return { allow: true, primary: false };
  return { allow: true, primary: keyId === primaryHost };
}
