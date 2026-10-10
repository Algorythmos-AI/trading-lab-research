// What /api/health says about the research editions on file. Pure: no I/O.
import type { OptionsResult, RadarResult } from "./snapshot";

/**
 * The newest edition format this build's schema validates. A publisher reads it from /api/health and sends
 * nothing newer: the schemas refuse unknown fields, so a newer edition sent to an older site is rejected whole
 * and that day has no edition. Raise it in the same change that teaches the schema the new fields.
 */
export const OPTIONS_ACCEPTS = 2;
export const RADAR_ACCEPTS = 1;

export interface EditionHealth {
  /** "ok" when an edition is stored and readable, "missing" before the first one, "error" when storage failed. */
  status: "ok" | "missing" | "error";
  accepts: number;
  run_id: string | null;
  as_of: string | null;
  schema_version: number | null;
}

/** The stored options edition: the session its levels are for, and the run that built it. */
export function optionsHealth(r: OptionsResult): EditionHealth & { session: string | null } {
  const e = r.status === "ok" ? r.edition : null;
  return {
    status: r.status,
    accepts: OPTIONS_ACCEPTS,
    session: e?.session ?? null,
    run_id: e?.run_id ?? null,
    as_of: e?.as_of ?? null,
    schema_version: e?.schema_version ?? null,
  };
}

/** The stored radar edition: its date, and the run that built it. */
export function radarHealth(r: RadarResult): EditionHealth & { edition_date: string | null } {
  const e = r.status === "ok" ? r.edition : null;
  return {
    status: r.status,
    accepts: RADAR_ACCEPTS,
    edition_date: e?.edition_date ?? null,
    run_id: e?.run_id ?? null,
    as_of: e?.as_of ?? null,
    schema_version: e?.schema_version ?? null,
  };
}
