import Ajv, { type ErrorObject } from "ajv";
import type { DeskName } from "./desk";
import cryptoSchema from "./crypto.schema.json";
import type { CryptoSnapshot } from "./crypto.types";
import schema from "./snapshot.schema.json";
import type { Snapshot } from "./types";

// Draft-07, compiled once per server instance. strict:false tolerates the schema's non-URI $id.
const ajv = new Ajv({ strict: false, allErrors: true });
const validateSchema = ajv.compile<Snapshot>(schema);
const validateCryptoSchema = ajv.compile<CryptoSnapshot>(cryptoSchema);

export const STOCKS_SCHEMA = "trading-lab/snapshot";
export const CRYPTO_SCHEMA = "trading-lab/crypto-snapshot";

/**
 * Which desk a body belongs to, from its own `schema` field. The field is inside the signed body, so the
 * desk cannot be chosen by a header: a stocks snapshot can never be filed as the crypto desk's, or the reverse.
 * Anything that does not name the crypto schema is validated as a stocks snapshot (the original behaviour).
 */
export function deskOf(data: unknown): DeskName {
  const id = data !== null && typeof data === "object" ? (data as { schema?: unknown }).schema : undefined;
  return id === CRYPTO_SCHEMA ? "crypto" : "stocks";
}

const MAX_ERRORS = 10;

/**
 * Defense in depth: fields that must never be published, even if a future schema allowed them.
 * Paths use "[]" for any array index. Keys in DENY_KEYS are refused at any depth.
 */
export const DENY_PATHS: readonly string[] = [
  "research.decisions[].title",
  "research.hypotheses[].name",
  "research.hypotheses[].statement",
  "spec.title",
  "spec.open",
];
export const DENY_KEYS: ReadonlySet<string> = new Set(["headlines", "review_url", "subject", "statement"]);

const denyPathSet = new Set(DENY_PATHS);

/** Returns the JSON-pointer paths of every denylisted key found in `data`. */
export function findDenied(data: unknown): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, pattern: string, pointer: string) => {
    if (hits.length >= MAX_ERRORS) return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${pattern}[]`, `${pointer}/${i}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPattern = pattern ? `${pattern}.${key}` : key;
      const childPointer = `${pointer}/${key.slice(0, 60)}`;
      if (DENY_KEYS.has(key) || denyPathSet.has(childPattern)) hits.push(childPointer);
      walk(child, childPattern, childPointer);
    }
  };
  walk(data, "", "");
  return hits;
}

function describe(e: ErrorObject): string {
  const at = e.instancePath || "/";
  if (e.keyword === "additionalProperties") {
    const extra = String((e.params as { additionalProperty?: unknown }).additionalProperty ?? "").slice(0, 60);
    return `${at}: unknown key "${extra}"`;
  }
  return `${at}: ${e.message ?? e.keyword}`;
}

export type ValidationResult = { ok: true; snapshot: Snapshot } | { ok: false; errors: string[] };

/** Schema (draft-07) + denylist. Error strings name paths and keys only, never values. */
export function validateSnapshot(data: unknown): ValidationResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["/: must be an object"] };
  }
  const denied = findDenied(data);
  const errors = denied.map((p) => `${p}: key is not allowed to be published`);
  if (!validateSchema(data)) {
    errors.push(...(validateSchema.errors ?? []).map(describe));
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, snapshot: data as Snapshot };
}

export type CryptoValidationResult = { ok: true; snapshot: CryptoSnapshot } | { ok: false; errors: string[] };

/** The crypto desk's snapshot: its own schema, the same denylist. */
export function validateCryptoSnapshot(data: unknown): CryptoValidationResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["/: must be an object"] };
  }
  const errors = findDenied(data).map((p) => `${p}: key is not allowed to be published`);
  if (!validateCryptoSchema(data)) {
    errors.push(...(validateCryptoSchema.errors ?? []).map(describe));
  }
  if ((data as { schema?: unknown }).schema !== CRYPTO_SCHEMA) errors.push("/schema: not the crypto snapshot schema");
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, snapshot: data as CryptoSnapshot };
}
