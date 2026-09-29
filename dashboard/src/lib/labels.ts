// Plain-English names and status tones shared by pages and the summary sentence.

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

const JOB_NAMES: Record<string, string> = {
  routine: "Pre-market routine",
  "paper-b": "Paper B",
  forward: "Forward test",
  weekly: "Weekly scorecard",
  dashboard: "Dashboard publish",
};

/** "com.wt.paper-b" and "paper-b" both map to "paper-b". */
export function jobKey(labelOrKey: string | null | undefined): string {
  return String(labelOrKey ?? "").replace(/^com\.wt\./, "");
}

export function jobName(labelOrKey: string | null | undefined): string {
  const key = jobKey(labelOrKey);
  return JOB_NAMES[key] ?? (key || "Unknown job");
}

export const JOB_ORDER = ["routine", "paper-b", "forward", "weekly", "dashboard"];

export function sortJobKeys(keys: Iterable<string>): string[] {
  const rank = (k: string) => {
    const i = JOB_ORDER.indexOf(k);
    return i === -1 ? JOB_ORDER.length : i;
  };
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

export function jobTone(status: string | null | undefined): Tone {
  switch (norm(status)) {
    case "ok":
    case "success":
      return "good";
    case "failed":
    case "error":
      return "bad";
    case "refused":
    case "timeout":
      return "warn";
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

export function stateTone(state: string | null | undefined): Tone {
  switch (norm(state)) {
    case "good":
    case "ok":
    case "done":
    case "pass":
    case "passed":
    case "closed":
      return "good";
    case "warn":
    case "warning":
    case "partial":
      return "warn";
    case "bad":
    case "failed":
    case "error":
      return "bad";
    case "in_progress":
    case "active":
    case "open":
      return "info";
    default:
      return "neutral";
  }
}

export function verdictTone(verdict: string | null | undefined): Tone {
  const v = norm(verdict);
  if (["pass", "passed", "accepted", "proven"].includes(v)) return "good";
  if (v === "candidate") return "info";
  if (["error", "failed"].includes(v)) return "bad";
  return "neutral";
}

export function ciTone(conclusion: string | null | undefined): Tone {
  const c = norm(conclusion);
  if (c === "success") return "good";
  if (["failure", "timed_out", "startup_failure"].includes(c)) return "bad";
  if (c === "action_required") return "warn";
  if (c === "") return "info";
  return "neutral";
}

export function severityTone(severity: string | null | undefined): Tone {
  const s = norm(severity);
  if (s === "high" || s === "critical") return "bad";
  if (s === "medium") return "warn";
  return "neutral";
}

export function severityRank(severity: string | null | undefined): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[norm(severity)] ?? 4;
}

/** Sentence-case label from a snake/kebab identifier: "in_progress" -> "In progress". */
export function humanize(id: string | null | undefined): string {
  const s = String(id ?? "").replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "—";
}

/** Strategy B (any variant) is under re-evaluation. */
export function isStrategyB(name: string | null | undefined): boolean {
  return /^B(?:$|[_\s·:-])/.test(String(name ?? "").trim());
}
