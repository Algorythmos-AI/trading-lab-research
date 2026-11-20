import { GAP_HUNTER, jobSaid, SESSION_JOBS, sortJobKeys } from "./robots";
import { scanSentence } from "./today";
import { entries, list, type JobResult, type Snapshot } from "./types";

/** The session's own jobs are worth a clause when they finish normally; every other job only when it did not. */
const CORE = new Set(SESSION_JOBS);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function clause(key: string, job: JobResult, s: Snapshot): string | null {
  const name = jobSaid(key);
  const status = String(job.status ?? "").toLowerCase();
  const exit = typeof job.exit === "number" ? ` (exit ${job.exit})` : "";
  switch (status) {
    case "ok": {
      if (key === GAP_HUNTER.job) return `${GAP_HUNTER.name} finished normally`;
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
  if (s.kill?.on === true) parts.push("the kill switch is on");

  const head = parts.length > 0 ? `Tonight: ${parts.join(", ")}.` : "No job results in this snapshot.";
  const n = list(s.overview?.needs_you).length;
  const tail = n === 0 ? "Nothing needs you." : n === 1 ? "1 thing needs you." : `${n} things need you.`;
  const middle = scanSentence(s) ?? "";
  return middle ? `${head} ${middle} ${tail}` : `${head} ${tail}`;
}
