// Tones, labels and small derivations for the v3 sections (risk, perf, sla, digest, audit). Pure, unit-tested.
import type { Tone } from "./labels";
import type { LimitState, PerfStats, SlaStatus, Snapshot } from "./types";

/** True when this snapshot came from a v3 publisher. A v2 host sends none of the v3 sections. */
export function hasV3(s: Snapshot): boolean {
  return typeof s.schema_version === "number" && s.schema_version >= 3;
}

export const LIMIT_TONE: Record<LimitState, Tone> = { ok: "good", warn: "warn", at_limit: "bad", "n/a": "neutral" };
export const LIMIT_LABEL: Record<LimitState, string> = {
  ok: "Within limit",
  warn: "Over half used",
  at_limit: "At limit",
  "n/a": "Not measured",
};

export function limitTone(state: LimitState | null | undefined): Tone {
  return state ? LIMIT_TONE[state] : "neutral";
}

export const SLA_TONE: Record<SlaStatus, Tone> = {
  ok: "good",
  refused: "warn",
  failed: "bad",
  partial: "warn",
  missed: "bad",
  none: "neutral",
  "n/a": "neutral",
};
export const SLA_LABEL: Record<SlaStatus, string> = {
  ok: "Ran OK",
  refused: "Refused (preflight)",
  failed: "Failed",
  partial: "Some runs failed",
  missed: "Expected, did not run",
  none: "Not scheduled",
  "n/a": "No record",
};
/** One character per cell so a 14-day row fits a phone; the full label goes in the title and the legend. */
export const SLA_GLYPH: Record<SlaStatus, string> = {
  ok: "✓",
  refused: "R",
  failed: "✗",
  partial: "~",
  missed: "!",
  none: "·",
  "n/a": " ",
};

export function slaStatus(v: string | null | undefined): SlaStatus {
  return v && v in SLA_TONE ? (v as SlaStatus) : "n/a";
}

/** Why a statistic is blank: the sample is too small, or it can't be defined (no losses). */
export function suppressedReason(stats: PerfStats | null | undefined, minTrades: number | null | undefined): string {
  const n = stats?.n ?? 0;
  const need = minTrades ?? 20;
  if (!stats || n === 0) return "No closed trades yet.";
  if (stats.sample_ok !== true) return `Shown from ${need} trades (now ${n}): smaller samples mislead.`;
  return "";
}

export function profitFactorText(stats: PerfStats | null | undefined): string | null {
  if (!stats || stats.sample_ok !== true) return null;
  if (stats.pf_no_losses === true) return "No losing trades yet";
  return typeof stats.profit_factor === "number" ? stats.profit_factor.toFixed(2) : null;
}

/** Audit event kinds in plain words. Unknown kinds are shown humanized. */
export const AUDIT_LABEL: Record<string, string> = {
  deploy: "Deployed",
  latch_reset: "Latch reset by owner",
  job_refused: "Job refused",
  job_failed: "Job failed",
  job_killed: "Job killed",
  job_timeout: "Job timed out",
  alert_fired: "Alert fired",
  alert_resolved: "Alert resolved",
  kill_on: "Kill switch on",
  kill_off: "Kill switch off",
  override: "Owner override",
  note: "Note",
};

export function auditTone(kind: string | null | undefined): Tone {
  switch (kind) {
    case "job_failed":
    case "job_killed":
    case "job_timeout":
    case "alert_fired":
      return "bad";
    case "job_refused":
    case "kill_on":
    case "latch_reset":
    case "override":
      return "warn";
    case "alert_resolved":
    case "kill_off":
      return "good";
    default:
      return "info";
  }
}
