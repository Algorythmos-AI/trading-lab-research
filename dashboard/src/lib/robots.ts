// The one place the site names its robots and the host's keys for them. Pure: no I/O.
//
// Job names used to live in lib/labels.ts. That file is inside the desk engine's import closure (its hash is
// frozen: scripts/gen-engine.mjs, scripts/gen-signal.mjs), so it is left as it stands and nothing on a page reads a
// job's name from it any more. This file is outside both closures and must stay there: import nothing from the
// engine here, and never import this file from lib/labels.ts.
//
// The host publishes ids it chose for itself (the job `paper-s`, alert keys `paper-s:*`, the strategy tag `S`) and
// those never change here. Every page, sentence and chart that shows one reads its words from this file, so a rename
// is one edit and the host's own wording for a robot never reaches a page.

export interface Robot {
  key: "clone" | "gap-hunter" | "arms";
  name: string;
  /** What it is, in a few words, for a summary row. */
  what: string;
  href: string;
}

/** The three robots, in the order every summary lists them. */
export const ROBOTS: readonly Robot[] = [
  { key: "clone", name: "Options clone", what: "One call or put at a time, by your rules", href: "/paper#clone-bot" },
  { key: "gap-hunter", name: "Gap Hunter", what: "Stocks: scans the whole market before the open, trades the day's best names", href: "/gap-hunter" },
  { key: "arms", name: "Research arms", what: "Variations of the clone's rules, simulated", href: "/paper#research-arms" },
];

/** Gap Hunter, the stock robot: what the host calls its parts, and the records that register its rule. */
export const GAP_HUNTER = {
  name: "Gap Hunter",
  href: "/gap-hunter",
  /** The host's session job. */
  job: "paper-s",
  /** Every alert the session job raises starts with this. */
  alertPrefix: "paper-s:",
  /** The strategy tag on its orders and journal rows. */
  tag: "S",
  decision: "DEC-0068",
  hypothesis: "HYP-0071",
} as const;

/** The stock rule that ran before Gap Hunter. Its job may still report for a while; nothing expects it to. */
export const RETIRED_RULE = {
  name: "QQQ rule (retired)",
  job: "paper-b",
  alertPrefix: "paper-b:",
  /** The verdict, and the record that retires the rule. */
  records: ["DEC-0062", "DEC-0069"],
} as const;

/**
 * What the host still publishes about the retired rule, by the ids it uses: the paper-evidence tile, and the digest
 * lines about its virtual account. Pages leave these out; the rule's history is on the Strategies page, collapsed.
 */
export const RETIRED_KPI_IDS: ReadonlySet<string> = new Set(["g2"]);
export const RETIRED_DIGEST_KEYS: ReadonlySet<string> = new Set(["equity_pct", "cum_r", "trades"]);
/** The gate whose progress line the host still writes from the retired rule's paper trades. */
export const RETIRED_PROGRESS_GATE = "G2";

/**
 * Is this line of host text about the retired rule? The host still writes a "best candidate" line and others from it;
 * a summary leaves such a line out rather than put the rule back into the main story.
 */
export function aboutRetiredRule(text: string | null | undefined): boolean {
  return /\bQQQM?\b|\bRobot B\b|\bstrategy B\b|\bpaper B\b|\bB · /i.test(String(text ?? ""));
}

/** A job's name in full and in a word or two (chart lanes, table rows, the summary sentence). */
const JOBS: Record<string, { name: string; short: string; said: string }> = {
  routine: { name: "Pre-market routine", short: "Routine", said: "routine" },
  [GAP_HUNTER.job]: { name: "Gap Hunter session", short: "Gap Hunter", said: "Gap Hunter" },
  [RETIRED_RULE.job]: { name: "QQQ rule session (retired)", short: "QQQ rule", said: "the retired QQQ rule" },
  forward: { name: "Forward test", short: "Forward", said: "forward test" },
  weekly: { name: "Weekly scorecard", short: "Weekly", said: "weekly scorecard" },
  dashboard: { name: "Dashboard publish", short: "Dashboard", said: "dashboard publish" },
  "paper-o": { name: "Options clone session", short: "Options clone", said: "options clone" },
  "options-live": { name: "Options positions publish", short: "Options live", said: "options positions publish" },
  "options-review": { name: "Options nightly review", short: "Options review", said: "options nightly review" },
  "pipeline-check": { name: "Pipeline check", short: "Pipeline", said: "pipeline check" },
  "deploy-notify": { name: "Deploy notice", short: "Deploy notice", said: "deploy notice" },
  "deploy-auto": { name: "Automatic deploy", short: "Deploy", said: "automatic deploy" },
};

/** "com.wt.paper-s" and "paper-s" are the same job. */
export function jobKey(labelOrKey: string | null | undefined): string {
  return String(labelOrKey ?? "").replace(/^com\.wt\./, "");
}

export function jobName(labelOrKey: string | null | undefined): string {
  const key = jobKey(labelOrKey);
  return JOBS[key]?.name ?? (key || "Unknown job");
}

/** A job the site names itself reads by that name; any other keeps the host's own, in the site's words. */
export function hostJobName(labelOrKey: string | null | undefined, hostName: string | null | undefined): string {
  const key = jobKey(labelOrKey);
  return JOBS[key]?.name ?? (siteWords(hostName) || key || "Unknown job");
}

/** A word or two, for a chart lane or a narrow column. */
export function jobShort(labelOrKey: string | null | undefined): string {
  const key = jobKey(labelOrKey);
  return JOBS[key]?.short ?? (key || "Unknown");
}

/** As it reads inside a sentence: "Gap Hunter", "forward test". */
export function jobSaid(labelOrKey: string | null | undefined): string {
  const key = jobKey(labelOrKey);
  return JOBS[key]?.said ?? (key || "a job");
}

/** The jobs every trading day is expected to run, in the order they start. The retired rule's job is not one. */
export const SESSION_JOBS: readonly string[] = ["routine", GAP_HUNTER.job, "forward"];

/** The order jobs are listed in; anything else follows by name. */
export const JOB_ORDER: readonly string[] = ["routine", GAP_HUNTER.job, "forward", "weekly", "dashboard"];

export function sortJobKeys(keys: Iterable<string>): string[] {
  const rank = (k: string) => {
    const i = JOB_ORDER.indexOf(k);
    return i === -1 ? JOB_ORDER.length : i;
  };
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Gap Hunter's alerts in the site's own words, by the part of the key after `paper-s:`. A key may carry more after
 * that (`paper-s:not-flat:ABCD`); only the first part is read. `red` means act now: a position is, or may be, open
 * when it should not be, or the account is not what it should be. The rest need a look and are amber.
 */
const GAP_HUNTER_ALERTS: Record<string, { title: string; red: boolean }> = {
  "not-flat": { title: "Gap Hunter is not flat after the close", red: true },
  short: { title: "Gap Hunter holds a short position", red: true },
  "short-at-close": { title: "Gap Hunter is short at the close", red: true },
  "over-caps": { title: "A Gap Hunter position is over its hard caps", red: true },
  orphan: { title: "Gap Hunter adopted a position it did not open", red: true },
  "close-unknown": { title: "Gap Hunter could not read the session close", red: true },
  "not-paper": { title: "Gap Hunter stopped: its account is not a paper account", red: true },
  "refused-keys": { title: "Gap Hunter did not start: its key pair is missing", red: false },
  "refused-account": { title: "Gap Hunter did not start: its account check failed", red: false },
  "second-runner": { title: "A second Gap Hunter session was refused", red: false },
  lease: { title: "Gap Hunter has no primary lease: entries are off", red: false },
  "clock-skew": { title: "Gap Hunter skipped an entry: the clock check failed", red: false },
  "stop-rule": { title: "Gap Hunter was stopped by its stop rule", red: false },
};

const gapHunterAlert = (key: string) => (key.startsWith(GAP_HUNTER.alertPrefix) ? key.slice(GAP_HUNTER.alertPrefix.length).split(":")[0]! : null);

export const isGapHunterAlert = (key: string | null | undefined): boolean => String(key ?? "").startsWith(GAP_HUNTER.alertPrefix);

/** The retired rule's alerts that mean act now, as before: its job can still raise them until it is switched off. */
const RETIRED_RED = ["not-flat", "unknown-position", "latched", "close-unknown", "signal-not-acted"].map((k) => `${RETIRED_RULE.alertPrefix}${k}`);

/** Does this firing alert turn the dashboard red? */
export function isRedAlert(key: string | null | undefined): boolean {
  const k = String(key ?? "");
  const part = gapHunterAlert(k);
  if (part !== null) return GAP_HUNTER_ALERTS[part]?.red === true;
  return RETIRED_RED.some((p) => k.startsWith(p));
}

/** A host name for a robot that must not reach a page, and what the site says instead. */
const HOST_WORDS: [RegExp, string][] = [
  [/\bRobot B(?:'s)? sleeve S\b/gi, GAP_HUNTER.name],
  [/\bsleeve S\b/gi, GAP_HUNTER.name],
  [/\bpaper-s\b/g, GAP_HUNTER.name],
  [/\bsleeves?\b/gi, "robot"],
];

/** A line of host text (an alert title, a job note) with the host's names for the robots put into the site's. */
export function siteWords(text: string | null | undefined): string {
  let out = String(text ?? "");
  for (const [re, to] of HOST_WORDS) out = out.replace(re, to);
  return out;
}

/** What a page calls an alert: the site's own title for a Gap Hunter key, else the host's title in the site's words. */
export function alertTitle(key: string | null | undefined, title: string | null | undefined): string {
  const k = String(key ?? "");
  const part = gapHunterAlert(k);
  if (part !== null) {
    const known = GAP_HUNTER_ALERTS[part];
    if (known) {
      const rest = k.slice(GAP_HUNTER.alertPrefix.length + part.length + 1);
      return rest ? `${known.title} (${rest})` : known.title;
    }
    return `${GAP_HUNTER.name} alert (${part || "unnamed"})`;
  }
  return siteWords(title) || k || "Alert";
}
