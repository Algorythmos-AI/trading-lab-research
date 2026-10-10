import Ajv, { type ErrorObject } from "ajv";
import type { DeskName } from "./desk";
import cryptoSchema from "./crypto.schema.json";
import type { CryptoSnapshot } from "./crypto.types";
import hftSchema from "./hft.schema.json";
import type { HftSnapshot } from "./hft.types";
import optionsLiveSchema from "./options-live.schema.json";
import type { OptionsLive } from "./options-live.types";
import optionsSchema from "./options.schema.json";
import type { OptionsEdition } from "./options.types";
import radarSchema from "./radar.schema.json";
import type { RadarEdition } from "./radar.types";
import schema from "./snapshot.schema.json";
import type { Snapshot } from "./types";

// Draft-07, compiled once per server instance. strict:false tolerates the schema's non-URI $id.
const ajv = new Ajv({ strict: false, allErrors: true });
const validateSchema = ajv.compile<Snapshot>(schema);
const validateCryptoSchema = ajv.compile<CryptoSnapshot>(cryptoSchema);
const validateHftSchema = ajv.compile<HftSnapshot>(hftSchema);
const validateRadarSchema = ajv.compile<RadarEdition>(radarSchema);
const validateOptionsSchema = ajv.compile<OptionsEdition>(optionsSchema);
const validateOptionsLiveSchema = ajv.compile<OptionsLive>(optionsLiveSchema);

export const STOCKS_SCHEMA = "trading-lab/snapshot";
export const CRYPTO_SCHEMA = "trading-lab/crypto-snapshot";
/** The HFT desk's snapshot (ADR 0006). The contract belongs to hft-lab; hft.schema.json is a pinned copy of it. */
export const HFT_SCHEMA = "hft-lab/snapshot";
/** The daily pre-market radar's edition: research notes, not a desk. It has no windows and no watchdog. */
export const RADAR_SCHEMA = "stocksdelta/radar";
/** The after-close options levels edition: research for the next session's calls and puts. No desk, no watchdog. */
export const OPTIONS_SCHEMA = "stocksdelta/options";

/** True when the signed body names the radar schema. Like deskOf, the body decides, never a header. */
export function isRadar(data: unknown): boolean {
  return data !== null && typeof data === "object" && (data as { schema?: unknown }).schema === RADAR_SCHEMA;
}

/**
 * What the Options desk needs between editions: the paper option positions and open interest. It comes from the
 * trading host, not from the research environment, so the radar's key may not publish it.
 */
export const OPTIONS_LIVE_SCHEMA = "stocksdelta/options-live";

/** True when the signed body names the options live schema. */
export function isOptionsLive(data: unknown): boolean {
  return data !== null && typeof data === "object" && (data as { schema?: unknown }).schema === OPTIONS_LIVE_SCHEMA;
}

/** True when the signed body names the options levels schema. */
export function isOptions(data: unknown): boolean {
  return data !== null && typeof data === "object" && (data as { schema?: unknown }).schema === OPTIONS_SCHEMA;
}

/** What every desk's validator returns: the snapshot's own id and time, or the paths that failed. */
export type DeskValidation = { ok: true; snapshot: { run_id?: string | null; as_of?: string | null } } | { ok: false; errors: string[] };

/**
 * What ingest knows about a schema id: the desk whose slot the body is filed in, and the validator it must pass.
 * Both come from the one entry, so a body can never be validated as one desk's and filed as another's.
 */
export interface DeskContract {
  kind: "desk";
  desk: DeskName;
  validate: (data: unknown) => DeskValidation;
}

const STOCKS_CONTRACT: DeskContract = { kind: "desk", desk: "stocks", validate: validateSnapshot };

/**
 * The snapshot contracts, keyed by the `schema` id a body names. A new desk is one more entry. The research
 * editions (RADAR_SCHEMA, OPTIONS_SCHEMA) are routed before this is consulted; they could become entries of another
 * `kind` here instead of a second registry.
 */
export const CONTRACTS: ReadonlyMap<string, DeskContract> = new Map<string, DeskContract>([
  [STOCKS_SCHEMA, STOCKS_CONTRACT],
  [CRYPTO_SCHEMA, { kind: "desk", desk: "crypto", validate: validateCryptoSnapshot }],
  [HFT_SCHEMA, { kind: "desk", desk: "hft", validate: validateHftSnapshot }],
]);

/**
 * The contract a body is held to, from its own `schema` field. The field is inside the signed body, so the desk
 * cannot be chosen by a header: one desk's snapshot can never be filed as another's. A body that names no desk's
 * schema is held to the stocks contract (the original behaviour), which refuses it unless it is a stocks snapshot.
 */
export function contractOf(data: unknown): DeskContract {
  const id = data !== null && typeof data === "object" ? (data as { schema?: unknown }).schema : undefined;
  return (typeof id === "string" ? CONTRACTS.get(id) : undefined) ?? STOCKS_CONTRACT;
}

/** Which desk a body belongs to: the desk of the contract its `schema` field names. */
export function deskOf(data: unknown): DeskName {
  return contractOf(data).desk;
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
export const DENY_KEYS: ReadonlySet<string> = new Set(["headlines", "review_url", "subject", "statement", "setup", "catalyst_headline", "catalyst_category"]);

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

export type HftValidationResult = { ok: true; snapshot: HftSnapshot } | { ok: false; errors: string[] };

/** The HFT desk's snapshot: its own schema, the same denylist. */
export function validateHftSnapshot(data: unknown): HftValidationResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["/: must be an object"] };
  }
  const errors = findDenied(data).map((p) => `${p}: key is not allowed to be published`);
  if (!validateHftSchema(data)) {
    errors.push(...(validateHftSchema.errors ?? []).map(describe));
  }
  if ((data as { schema?: unknown }).schema !== HFT_SCHEMA) errors.push("/schema: not the HFT snapshot schema");
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, snapshot: data as HftSnapshot };
}

export type RadarValidationResult = { ok: true; edition: RadarEdition } | { ok: false; errors: string[] };

/** A radar edition: its own schema, the same denylist. */
export function validateRadarEdition(data: unknown): RadarValidationResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["/: must be an object"] };
  }
  const errors = findDenied(data).map((p) => `${p}: key is not allowed to be published`);
  if (!validateRadarSchema(data)) {
    errors.push(...(validateRadarSchema.errors ?? []).map(describe));
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, edition: data as RadarEdition };
}

export type OptionsValidationResult = { ok: true; edition: OptionsEdition } | { ok: false; errors: string[] };

/** An options levels edition: its own schema, the same denylist. */
export function validateOptionsEdition(data: unknown): OptionsValidationResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["/: must be an object"] };
  }
  const errors = findDenied(data).map((p) => `${p}: key is not allowed to be published`);
  if (!validateOptionsSchema(data)) {
    errors.push(...(validateOptionsSchema.errors ?? []).map(describe));
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, edition: data as OptionsEdition };
}

export type OptionsLiveValidationResult = { ok: true; doc: OptionsLive } | { ok: false; errors: string[] };

/** An options live document: its own schema, the same denylist. Paper only, by the schema's own `paper: true`. */
export function validateOptionsLive(data: unknown): OptionsLiveValidationResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["/: must be an object"] };
  }
  const errors = findDenied(data).map((p) => `${p}: key is not allowed to be published`);
  if (!validateOptionsLiveSchema(data)) {
    errors.push(...(validateOptionsLiveSchema.errors ?? []).map(describe));
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, doc: data as OptionsLive };
}
