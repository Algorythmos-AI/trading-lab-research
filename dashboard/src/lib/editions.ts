// What /api/health says about the research editions on file. Pure: no I/O.
import type { CalendarResult, FunnelResult, JournalResult, LedgerResult, OptionsCloneResult, OptionsLiveResult, OptionsResult, PaperOptionsResult, RadarDeskResult, RadarResult, RadarRunLatestResult } from "./snapshot";

/**
 * The newest edition format this build's schema validates. A publisher reads it from /api/health and sends
 * nothing newer: the schemas refuse unknown fields, so a newer edition sent to an older site is rejected whole
 * and that day has no edition. Raise it in the same change that teaches the schema the new fields.
 */
export const OPTIONS_ACCEPTS = 2;
export const RADAR_ACCEPTS = 1;
/** 2 adds `rules`: where each probation rule stands in the session so far. */
export const OPTIONS_LIVE_ACCEPTS = 3;
export const OPTIONS_CLONE_ACCEPTS = 1;
/** The paper options history (DEC-0057): the newest format this build validates. */
export const PAPER_OPTIONS_ACCEPTS = 5;                     // 2: the options lab's tape status (`lab`); 3: upload delay and rate-limit headroom; 4: the Radar → Options shadow (`select`); 5: its progress and each run's check
/** 2 adds `money`: deposits, withdrawals and the account value. */
export const JOURNAL_ACCEPTS = 2;
export const LEDGER_ACCEPTS = 1;
export const FUNNEL_ACCEPTS = 1;
export const RADAR_DESK_ACCEPTS = 1;
/** The Radar run beacon: the newest format this build validates. */
export const RADAR_RUN_ACCEPTS = 1;
/** The newest economic calendar format this build validates. */
export const CALENDAR_ACCEPTS = 1;

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

/**
 * The stored options live document: the run that built it and when. Nothing about what it holds: a count of open
 * positions is the account's business, and this endpoint is read by machines.
 */
export function optionsLiveHealth(r: OptionsLiveResult): EditionHealth {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: OPTIONS_LIVE_ACCEPTS,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The stored economic calendar: the run that built it and when. Nothing of its dates. */
export function calendarHealth(r: CalendarResult): EditionHealth {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: CALENDAR_ACCEPTS,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The stored trade journal: the run that built it and when. Nothing about the trades: this endpoint is read by machines. */
export function journalHealth(r: JournalResult): EditionHealth {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: JOURNAL_ACCEPTS,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The stored options clone document: its session, the run that built it and when. Nothing about its trades. */
export function optionsCloneHealth(r: OptionsCloneResult): EditionHealth & { session: string | null } {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: OPTIONS_CLONE_ACCEPTS,
    session: d?.session ?? null,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The stored paper options history: the run that built it and when. Nothing about its trades. */
export function paperOptionsHealth(r: PaperOptionsResult): EditionHealth {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: PAPER_OPTIONS_ACCEPTS,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The stored ledger edition: the session it scored, and the run that built it. */
export function ledgerHealth(r: LedgerResult): EditionHealth & { session: string | null } {
  const e = r.status === "ok" ? r.edition : null;
  return {
    status: r.status,
    accepts: LEDGER_ACCEPTS,
    session: e?.session ?? null,
    run_id: e?.run_id ?? null,
    as_of: e?.as_of ?? null,
    schema_version: e?.schema_version ?? null,
  };
}

/** The stored funnel health document: the session it is for, and the run that built it. */
export function funnelHealth(r: FunnelResult): EditionHealth & { session: string | null } {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: FUNNEL_ACCEPTS,
    session: d?.session ?? null,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The stored Radar desk file: the session it is for, and the run that built it. No names, flags or coverage. */
export function radarDeskHealth(r: RadarDeskResult): EditionHealth & { session: string | null } {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: RADAR_DESK_ACCEPTS,
    session: d?.session ?? null,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}

/** The newest Radar run beacon on file: the session it is for, and the run that sent it. Not its stage or state. */
export function radarRunHealth(r: RadarRunLatestResult): EditionHealth & { session: string | null } {
  const d = r.status === "ok" ? r.doc : null;
  return {
    status: r.status,
    accepts: RADAR_RUN_ACCEPTS,
    session: d?.session ?? null,
    run_id: d?.run_id ?? null,
    as_of: d?.as_of ?? null,
    schema_version: d?.schema_version ?? null,
  };
}
