// Tones, labels and small derivations for the v3 sections (risk, perf, sla, digest, audit). Pure, unit-tested.
import type { Tone } from "./labels";
import type { LimitState, PerfStats, SlaStatus, Snapshot } from "./types";

/** True when this snapshot came from a v3 publisher. A v2 host sends none of the v3 sections. */
export function hasV3(s: Snapshot): boolean {
  return typeof s.schema_version === "number" && s.schema_version >= 3;
}

/** Limits that are counts (entries a day): using the whole allowance is normal on a trading day, not a breach. */
export const COUNT_LIMITS: ReadonlySet<string> = new Set(["entries_per_day"]);

export const LIMIT_TONE: Record<LimitState, Tone> = { ok: "good", warn: "warn", at_limit: "bad", "n/a": "neutral" };
export const LIMIT_LABEL: Record<LimitState, string> = {
  ok: "Within limit",
  warn: "Over half used",
  at_limit: "At limit",
  "n/a": "Not measured",
};

export function limitTone(state: LimitState | null | undefined, id?: string | null): Tone {
  if (id && COUNT_LIMITS.has(id)) return state === "n/a" || !state ? "neutral" : "info";
  return state ? LIMIT_TONE[state] : "neutral";
}

export function limitLabel(state: LimitState | null | undefined, id?: string | null): string {
  if (id && COUNT_LIMITS.has(id) && state === "at_limit") return "Used for today";
  if (id && COUNT_LIMITS.has(id) && (state === "ok" || state === "warn")) return "Available";
  return state ? LIMIT_LABEL[state] : "Unknown";
}

/** v2: the host predates this section. missing: a v3 host sent no value (it failed to build it). */
export type SectionState = "v2" | "missing" | "ok";

export function sectionState(s: Snapshot, value: unknown): SectionState {
  if (!hasV3(s)) return "v2";
  return value === null || value === undefined ? "missing" : "ok";
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

/** Which side of zero an R band such as "-2 to -1", "< -3", "0 to 1" or "> 3" lies on. */
export function binSide(bin: string | null | undefined): "loss" | "gain" | "flat" {
  const nums = (bin ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return "flat";
  if (nums.every((v) => v <= 0) && nums.some((v) => v < 0)) return "loss";
  if (nums.every((v) => v >= 0) && nums.some((v) => v > 0)) return "gain";
  return "flat";
}
