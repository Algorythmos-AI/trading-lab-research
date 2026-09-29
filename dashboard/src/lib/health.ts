import { freshness, type Freshness } from "./freshness";
import { num } from "./format";
import { jobName, sortJobKeys } from "./labels";
import { DISK_FLOOR_GB, DISK_TARGET_GB } from "./thresholds.gen";
import { entries, list, type Snapshot } from "./types";

export type HealthLevel = "green" | "amber" | "red";

export interface HealthReason {
  level: "red" | "amber";
  code: string;
  text: string;
}

export interface Health {
  level: HealthLevel;
  reasons: HealthReason[];
  freshness: Freshness;
}

export const RED_ALERT_PREFIXES = [
  "paper-b:not-flat",
  "paper-b:unknown-position",
  "paper-b:latched",
  "paper-b:close-unknown",
];
const PROBLEM_JOB_STATUSES = new Set(["failed", "refused", "timeout"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Overall status for the banner. RED needs action now; AMBER needs a look; GREEN is quiet. */
export function computeHealth(s: Snapshot | null, now: Date): Health {
  const reasons: HealthReason[] = [];
  const red = (code: string, text: string) => reasons.push({ level: "red", code, text });
  const amber = (code: string, text: string) => reasons.push({ level: "amber", code, text });

  if (!s) {
    const f = freshness(null, [], now.getTime());
    return {
      level: "amber",
      reasons: [{ level: "amber", code: "no-snapshot", text: "No status snapshot has been received yet." }],
      freshness: f,
    };
  }
  const f = freshness(s.as_of, s.expected_windows, now.getTime());
  const age = f.ageMin === null ? null : Math.floor(f.ageMin);

  // RED
  for (const a of list(s.alerts?.firing)) {
    const key = a.key ?? "";
    if (RED_ALERT_PREFIXES.some((p) => key.startsWith(p))) {
      red(`alert:${key}`, `Alert firing: ${a.title || key}.`);
    }
  }
  if (s.ops?.account?.trading_blocked === true) {
    red("trading-blocked", "The paper broker account reports that trading is blocked.");
  }
  for (const p of list(s.ops?.account?.positions)) {
    if (p.in_mandate === false && p.legacy !== true && p.qty) {
      red(
        `mandate:${p.symbol ?? "?"}`,
        `The paper account holds ${p.symbol ?? "a symbol"} outside strategy B's mandate. Close it in the Alpaca UI or record it as legacy.`,
      );
    }
  }
  const host0 = s.ops?.host;
  if (isNum(host0?.disk_free_gb) && host0.disk_free_gb < DISK_FLOOR_GB) {
    red("disk-floor", `Disk free (${num(host0.disk_free_gb, 1)} GB) is below the ${num(DISK_FLOOR_GB, 0)} GB floor: tonight's jobs refuse.`);
  }
  if (f.state === "stopped") {
    red("stopped", `No update for ${age} min during a trading window. The Mac or its jobs may have stopped.`);
  }

  // AMBER
  if (s.kill?.on === true) amber("kill", "Kill switch is on: paper B makes no new entries.");
  const last = Object.fromEntries(entries(s.jobs?.last));
  for (const key of sortJobKeys(Object.keys(last))) {
    const job = last[key];
    const status = String(job?.status ?? "").toLowerCase();
    if (PROBLEM_JOB_STATUSES.has(status)) {
      const exit = isNum(job?.exit) ? ` (exit ${job.exit})` : "";
      const verb = status === "timeout" ? "timed out" : status === "refused" ? "was refused" : "failed";
      amber(`job:${key}`, `${jobName(key)} ${verb}${exit}.`);
    }
  }
  if (f.state === "late") amber("late", `The snapshot is ${age} min old during a trading window.`);
  if (s.collector?.exit_code === 1) {
    amber("collector", "The status collector finished with errors (exit 1); some sections may be stale.");
  }
  const host = s.ops?.host;
  if (isNum(host?.disk_free_gb) && host.disk_free_gb >= DISK_FLOOR_GB && host.disk_free_gb < DISK_TARGET_GB) {
    amber("disk", `Disk free (${num(host.disk_free_gb, 1)} GB) is under the ${num(DISK_TARGET_GB, 0)} GB to keep free.`);
  }
  if (s.collector?.sources?.account?.stale === true || s.collector?.sources?.account?.ok === false) {
    amber("account-stale", "The paper account could not be read in this snapshot: positions and balances may be out of date.");
  }
  const swapPct = host?.swap?.used_pct;
  if (isNum(swapPct) && isNum(host?.swap_warn_pct) && swapPct >= host.swap_warn_pct) {
    amber("swap", `Swap is ${num(swapPct, 1)}% used (warning at ${num(host.swap_warn_pct, 0)}%).`);
  }
  const failing = list(s.preflight).filter((c) => c.ok === false);
  if (failing.length > 0) {
    const names = failing.map((c) => c.name || "unnamed").join(", ");
    amber("preflight", `${failing.length} preflight check${failing.length === 1 ? "" : "s"} failing: ${names}.`);
  }

  const level: HealthLevel = reasons.some((r) => r.level === "red") ? "red" : reasons.length > 0 ? "amber" : "green";
  reasons.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1));
  return { level, reasons, freshness: f };
}
