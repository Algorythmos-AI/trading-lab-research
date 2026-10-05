import { JOB_ORDER, sortJobKeys } from "./labels";
import { scanSentence } from "./today";
import { entries, list, type JobResult, type Snapshot } from "./types";

const SHORT: Record<string, string> = {
  routine: "routine",
  "paper-b": "paper B",
  forward: "forward test",
  weekly: "weekly scorecard",
  dashboard: "dashboard publish",
};
const CORE = new Set(JOB_ORDER.slice(0, 3));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function clause(key: string, job: JobResult, s: Snapshot): string | null {
  const name = SHORT[key] ?? key;
  const status = String(job.status ?? "").toLowerCase();
  const exit = typeof job.exit === "number" ? ` (exit ${job.exit})` : "";
  switch (status) {
    case "ok": {
      if (key === "paper-b") {
        return `paper B finished normally${s.kill?.on === true ? " with entries paused (kill switch)" : ""}`;
      }
      if (key === "forward") {
        const n = s.ops?.forward?.sessions;
        return typeof n === "number" ? `forward test recorded ${plural(n, "session", "sessions")}` : "forward test finished normally";
      }
      // Other jobs are only worth a mention when something went wrong.
      return CORE.has(key) ? `${name} finished normally` : null;
    }
    case "failed":
      return `${name} failed${exit}`;
    case "refused":
      return `${name} was refused${exit}`;
    case "timeout":
      return `${name} timed out`;
    case "running":
      return `${name} is still running`;
    default:
      return status ? `${name} reported "${status}"` : `${name} has no status`;
  }
}

/** One plain-English sentence for the top of the page. Counts and statuses only; never money. */
export function summarize(s: Snapshot | null): string {
  if (!s) return "No status snapshot has been received yet.";
  const last = Object.fromEntries(entries(s.jobs?.last));
  const parts: string[] = [];
  for (const key of sortJobKeys(Object.keys(last))) {
    const job = last[key];
    const c = job ? clause(key, job, s) : null;
    if (c) parts.push(c);
  }
  if (s.kill?.on === true && !last["paper-b"]) parts.push("the kill switch is on");

  const head = parts.length > 0 ? `Tonight: ${parts.join(", ")}.` : "No job results in this snapshot.";
  const n = list(s.overview?.needs_you).length;
  const tail = n === 0 ? "Nothing needs you." : n === 1 ? "1 thing needs you." : `${n} things need you.`;
  const pre = scanSentence(s);
  return pre ? `${head} ${pre} ${tail}` : `${head} ${tail}`;
}
