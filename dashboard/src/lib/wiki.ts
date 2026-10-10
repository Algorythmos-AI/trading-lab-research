// The Engineering wikis' live state: pure functions that turn snapshot fields into the colours and words the
// diagrams draw. The pictures themselves are written in the page code; only these dots and strips move.
import { ciTone, jobTone, type Tone } from "./labels";

/** The repo's workflows in the order a change meets them, with the words the diagrams use. */
export const WORKFLOWS: readonly { key: string; label: string; what: string }[] = [
  { key: "ci", label: "ci", what: "tests, types, schema, dashboard gate" },
  { key: "dashboard", label: "dashboard", what: "checks, then deploys the site" },
  { key: "infra", label: "infra", what: "terraform and shell scripts" },
  { key: "security", label: "security", what: "dependency audits" },
  { key: "CodeQL", label: "CodeQL", what: "code scanning" },
];

export interface CiRunLike {
  workflow?: string | null;
  conclusion?: string | null;
  created?: string | null;
  branch?: string | null;
}

export interface StripCell {
  tone: Tone;
  /** In progress: a run with no conclusion yet. */
  running: boolean;
  main: boolean;
  branch: string;
  created: string | null;
  conclusion: string;
}

export interface Lane {
  workflow: string;
  label: string;
  what: string;
  /** Oldest first, so the newest run is on the right. */
  cells: StripCell[];
  /** The newest run on main, if any: what the path diagram colours its node with. */
  latestMain: StripCell | null;
}

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const cell = (r: CiRunLike): StripCell => {
  const conclusion = String(r.conclusion ?? "").trim();
  return {
    tone: ciTone(conclusion),
    running: conclusion === "",
    main: r.branch === "main",
    branch: r.branch ?? "",
    created: r.created ?? null,
    conclusion: conclusion || "in progress",
  };
};

/**
 * One lane per workflow, known workflows first in the order a change meets them, then any others by name. Runs
 * without a workflow name are dropped; at most `max` runs per lane, the newest.
 */
export function ciLanes(runs: readonly (CiRunLike | null | undefined)[] | null | undefined, max = 30): Lane[] {
  const by = new Map<string, CiRunLike[]>();
  for (const r of runs ?? []) {
    const w = r?.workflow?.trim();
    if (!r || !w) continue;
    by.set(w, [...(by.get(w) ?? []), r]);
  }
  const known = WORKFLOWS.map((w) => w.key);
  const keys = [...by.keys()].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    return (ia === -1 ? known.length : ia) - (ib === -1 ? known.length : ib) || a.localeCompare(b);
  });
  return keys.map((k) => {
    const sorted = [...by.get(k)!].sort((a, b) => time(a.created) - time(b.created)).slice(-max);
    const cells = sorted.map(cell);
    const meta = WORKFLOWS.find((w) => w.key === k);
    return {
      workflow: k,
      label: meta?.label ?? k,
      what: meta?.what ?? "",
      cells,
      latestMain: [...cells].reverse().find((c) => c.main) ?? null,
    };
  });
}

/** The tone of a workflow's newest run on main, neutral when it has none in the snapshot. */
export function laneTone(lanes: Lane[], workflow: string): Tone {
  return lanes.find((l) => l.workflow === workflow)?.latestMain?.tone ?? "neutral";
}

export interface JobRunLike {
  status?: string | null;
  exit?: number | null;
  started?: string | null;
  ended?: string | null;
}

/** A job's dot: its last run's tone, pulsing while it runs. */
export function jobDot(run: JobRunLike | null | undefined): { tone: Tone; pulse: boolean; word: string } {
  if (!run) return { tone: "neutral", pulse: false, word: "no run yet" };
  const status = String(run.status ?? "").trim().toLowerCase();
  return { tone: jobTone(status), pulse: status === "running", word: status || "unknown" };
}

/** "20260929T043000Z" (a deploy record's stamp) as an ISO instant; ISO input passes through; anything else is null. */
export function stampIso(stamp: string | null | undefined): string | null {
  if (typeof stamp !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return Number.isFinite(Date.parse(stamp)) ? stamp : null;
}

export interface HostLike {
  behind?: number | null;
  smoke_ok?: boolean | null;
}

/** The trading host's node in the path: green when it runs main and passed its smoke test, amber when reviewed
 * commits are waiting for the gate, red when the last smoke test failed. */
export function hostTone({ behind, smoke_ok }: HostLike): { tone: Tone; word: string } {
  if (smoke_ok === false) return { tone: "bad", word: "last smoke test failed" };
  if (typeof behind === "number" && behind > 0) return { tone: "warn", word: `${behind} reviewed commit${behind === 1 ? "" : "s"} waiting` };
  if (smoke_ok === true && behind === 0) return { tone: "good", word: "on main, smoke test passed" };
  return { tone: "neutral", word: "not reported" };
}

/** Free disk against the floor the jobs refuse below and the target the dashboard warns under. */
export function diskTone(free: number | null | undefined, floor: number | null | undefined, target?: number | null): Tone {
  if (typeof free !== "number" || !Number.isFinite(free)) return "neutral";
  if (typeof floor === "number" && free < floor) return "bad";
  if (typeof target === "number" && free < target) return "warn";
  return "good";
}

/** The CSS colour each tone paints an SVG mark with. */
export const TONE_VAR: Record<Tone, string> = {
  good: "var(--good-fill)",
  warn: "var(--warn-fill)",
  bad: "var(--bad-fill)",
  info: "var(--info-fill)",
  neutral: "var(--neutral-fill)",
};

/** Minutes since midnight in a time zone for an instant. */
export function zoneMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return n("hour") * 60 + n("minute");
}

/** Minutes since midnight in New York: where the "now" line sits on the trading-night timeline. */
export const nyMinutes = (at: Date) => zoneMinutes(at, "America/New_York");

/** How far Sydney's clock is ahead of New York's at an instant, in minutes (14 to 16 hours, by the two DST rules). */
export function sydneyAheadOfNy(at: Date): number {
  return (((zoneMinutes(at, "Australia/Sydney") - nyMinutes(at)) % 1440) + 1440) % 1440;
}

export interface GateLike {
  id?: string | null;
  status?: string | null;
}

/** A research gate's colour: done green, failed red, in progress blue, not started grey. */
export function gateTone(status: string | null | undefined): Tone {
  switch (String(status ?? "").toLowerCase()) {
    case "done":
    case "passed":
      return "good";
    case "failed":
      return "bad";
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}

/** The gate the desk is working on: the first one that is not done, or null when all are. */
export function currentGate<T extends GateLike>(gates: readonly T[]): T | null {
  return gates.find((g) => gateTone(g.status) !== "good") ?? null;
}

/** How many of the jobs' last runs ended well, of how many reported. */
export function jobsHealthy(last: Iterable<JobRunLike>): { ok: number; total: number; tone: Tone } {
  let ok = 0;
  let total = 0;
  let worst: Tone = "good";
  for (const r of last) {
    total += 1;
    const t = jobDot(r).tone;
    if (t === "good") ok += 1;
    if (t === "bad") worst = "bad";
    else if (t !== "good" && t !== "info" && worst !== "bad") worst = "warn";
  }
  return { ok, total, tone: total === 0 ? "neutral" : worst };
}

/** How far UTC is ahead of New York at an instant, in minutes (240 in daylight time, 300 in standard time). */
export function utcAheadOfNy(at: Date): number {
  return (((zoneMinutes(at, "UTC") - nyMinutes(at)) % 1440) + 1440) % 1440;
}

/** A model lineage's state as a colour: acting green, shadow blue, suspended red, demoted grey. */
export function modelTone(state: string | null | undefined): Tone {
  switch (String(state ?? "").toLowerCase()) {
    case "acting":
      return "good";
    case "shadow":
      return "info";
    case "suspended":
      return "bad";
    default:
      return "neutral";
  }
}
