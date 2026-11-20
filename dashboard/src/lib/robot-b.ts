// The retired QQQ rule's evidence (DEC-0062, DEC-0069). Its page is gone: Gap Hunter is the stock robot now
// (lib/gap-hunter.ts), and the only reader left is the collapsed "Retired" section at the foot of the Strategies page,
// which uses the verdict and the decision records. The rest is kept, with its tests, while
// scripts/robot_b_evidence.py still builds the file and CI holds the two equal; it goes when that script does.
//
// Pure: no I/O; the clock is passed in. Two sources and nothing typed by hand:
//  * robot-b-evidence.json, built by scripts/robot_b_evidence.py from EXP-0042 (DEC-0061) and checked in CI against a
//    fresh build: the research evidence, numbers only (ids, statuses, counts, R, intervals, statistics);
//  * the published stocks snapshot: the paper desk now (G2, the stop rule, the account, the kill switch, the job).
// Every state on the page is derived here, so a passed step, a failed one, a pending one and one that cannot start yet
// read differently, and a backtest that made money is never shown as a validated strategy.
import data from "./robot-b-evidence.json";
import type { Snapshot } from "./types";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export interface Evidence {
  schema: number;
  source: { experiment: string; decision: string; decision_status: string; run_date: string; results_sha256: string; corrected_sha256?: Record<string, string> };
  rule: { version: string; frozen: boolean; record: string; signal: string; orders: string };
  evidence: { label: string; corrective_reruns_done: number; corrective_reruns_owed: number; corrupted_trades_found: number; trades_reading_corrupted_days: number };
  verdict: { word: string; record: string; status: string; row?: string };
  backtest: {
    span: string[];
    trades: number;
    expectancy_r: number;
    ci95: (number | null)[];
    sd_r: number;
    win_rate: number;
    profit_factor: number;
    max_drawdown_r: number;
    longest_losing_run: number;
    total_r: number;
    expectancy_without_top10: number | null;
    years: { year: number; trades: number; expectancy_r: number }[];
  };
  walk_forward: { trades: number; expectancy_r: number; ci95: (number | null)[] };
  holdout: { span: string[]; trades: number; expectancy_r: number; ci95: (number | null)[]; consumed: boolean };
  g1: { trials: number; series: string; items: { id: string; pass: boolean; value: number | null; line: number }[]; passed: number; of: number; dsr_at_65: number };
  exits: { kind: string; trades: number; expectancy_r: number }[];
  runner_parity: { untradable_trades: number; untradable_expectancy_r: number; tradable_expectancy_r: number };
  power: {
    alpha: number;
    target_power: number;
    trades_per_session: number;
    full_edge: { edge_r: number; trades: number; years: number; power_at_g2b: number };
    half_edge: { edge_r: number; trades: number; years: number; power_at_g2b: number };
    g2b_trades: number;
    min_track_record_trades: number;
    rate_95: number[];
    dsr_needs_trades: number | null;
  };
  trail: { id: string; kind: string; status: string; date: string | null }[];
  owed: { id: string; status: string }[];
}

const ID = /^(HYP|EXP|DEC)-\d{4}[a-z]?$/;

/** The evidence file's shape, checked at run time as well as by the compiler: a wrong file shows as missing. */
export function isEvidence(v: unknown): v is Evidence {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<Evidence>;
  const fin = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  return (
    e.schema === 1 &&
    !!e.backtest && fin(e.backtest.trades) && fin(e.backtest.expectancy_r) && Array.isArray(e.backtest.ci95) &&
    !!e.holdout && fin(e.holdout.trades) && fin(e.holdout.expectancy_r) &&
    !!e.g1 && Array.isArray(e.g1.items) && e.g1.items.every((i) => typeof i.pass === "boolean") &&
    !!e.power && fin(e.power.full_edge?.trades) && fin(e.power.trades_per_session) &&
    Array.isArray(e.trail) && e.trail.every((t) => ID.test(t.id)) &&
    Array.isArray(e.owed) && e.owed.every((t) => ID.test(t.id))
  );
}

export const EVIDENCE: Evidence | null = isEvidence(data) ? data : null;

// ---------------------------------------------------------------- formatting

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** R with an explicit sign; a true minus sign for negatives; zero unsigned. */
export function rSigned(v: number | null | undefined, digits = 3): string {
  if (!finite(v)) return "—";
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}R`;
  return `${v > 0 ? "+" : "−"}${s}R`;
}

export function ciText(ci: (number | null)[] | null | undefined, digits = 3): string {
  if (!ci || ci.length < 2 || !finite(ci[0]) || !finite(ci[1])) return "—";
  return `[${rSigned(ci[0], digits)}, ${rSigned(ci[1], digits)}]`;
}

/** True when an interval contains zero (the estimate cannot be told from no edge at 95%). */
export function crossesZero(ci: (number | null)[] | null | undefined): boolean | null {
  if (!ci || !finite(ci[0]) || !finite(ci[1])) return null;
  return ci[0] <= 0 && ci[1] >= 0;
}

// ---------------------------------------------------------------- the ladder

export type RungState = "passed" | "failed" | "pending" | "blocked" | "never";

export interface Rung {
  key: string;
  name: string;
  state: RungState;
  /** Numbers only: what the rung measured against its line. */
  detail: string;
  record: string;
}

export const RUNG_WORD: Record<RungState, string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "In progress",
  blocked: "Cannot start",
  never: "Never from this lab",
};

export const RUNG_TONE: Record<RungState, Tone> = { passed: "good", failed: "bad", pending: "info", blocked: "neutral", never: "neutral" };

const G1_LINE: Record<string, string> = {
  ci_lower: "CI lower bound",
  dsr: "Deflated Sharpe",
  profit_factor: "Profit factor",
  random_control_p: "Random-control p",
  trades: "Trades",
};

function itemText(i: Evidence["g1"]["items"][number]): string {
  const name = G1_LINE[i.id] ?? i.id;
  if (i.id === "trades") return `${name} ${i.value ?? "—"} (needs ≥ ${i.line})`;
  if (i.id === "ci_lower") return `${name} ${rSigned(i.value)} (needs > 0)`;
  if (i.id === "random_control_p") return `${name} ${finite(i.value) ? i.value.toFixed(3) : "—"} (needs < ${i.line})`;
  if (i.id === "profit_factor") return `${name} ${finite(i.value) ? i.value.toFixed(2) : "—"} (needs ≥ ${i.line})`;
  return `${name} ${finite(i.value) ? i.value.toFixed(3) : "—"} (needs > ${i.line})`;
}

export function g1Lines(e: Evidence): { text: string; pass: boolean }[] {
  return e.g1.items.map((i) => ({ text: itemText(i), pass: i.pass }));
}

export function ladder(e: Evidence | null, s: Snapshot | null): Rung[] {
  const g = s?.ops?.paper?.g2 ?? null;
  const g1Pass = e ? e.g1.items.every((i) => i.pass) : null;
  const holdoutCross = e ? crossesZero(e.holdout.ci95) : null;
  const corrected = e ? e.evidence.corrective_reruns_done >= e.evidence.corrective_reruns_owed : null;
  const g2a =
    g && finite(g.sessions) && finite(g.sessions_needed) && finite(g.incident_free_streak) && finite(g.incident_free_needed)
      ? g.sessions >= g.sessions_needed && g.incident_free_streak >= g.incident_free_needed && agreementOk(s)
      : null;
  const g2b = g && finite(g.trades) && finite(g.trades_needed) ? g.trades >= g.trades_needed : null;
  const rungs: Rung[] = [
    {
      key: "data",
      name: "Clean data",
      state: corrected === null ? "pending" : corrected ? "passed" : "failed",
      detail: e
        ? corrected
          ? `${e.evidence.corrective_reruns_done} of ${e.evidence.corrective_reruns_owed} corrective re-runs done · ${e.evidence.corrupted_trades_found} impossible entries removed`
          : `${e.evidence.corrective_reruns_done} of ${e.evidence.corrective_reruns_owed} corrective re-runs done · ${e.evidence.corrupted_trades_found} impossible entries · ${e.evidence.trades_reading_corrupted_days} trades read a corrupted day`
        : "Evidence file missing",
      record: "DEC-0011",
    },
    {
      key: "g1",
      name: "Backtest gate (G1)",
      state: g1Pass === null ? "pending" : g1Pass ? "passed" : "failed",
      detail: e ? `${e.g1.passed} of ${e.g1.of} items pass at ${e.g1.trials} trials (walk-forward, out of sample)` : "Evidence file missing",
      record: "DEC-0007",
    },
    {
      key: "holdout",
      name: "Holdout",
      state: holdoutCross === null ? "pending" : holdoutCross ? "failed" : "passed",
      detail: e ? `${e.holdout.trades} trades · ${rSigned(e.holdout.expectancy_r)} · CI ${ciText(e.holdout.ci95)}` : "Evidence file missing",
      record: "EXP-0011",
    },
    {
      key: "g2a",
      name: "Paper: the desk runs the rule (G2a)",
      state: g2a === null ? "pending" : g2a ? "passed" : "pending",
      detail: g ? `${g.sessions ?? "—"} of ${g.sessions_needed ?? "—"} sessions · ${g.incident_free_streak ?? "—"} of ${g.incident_free_needed ?? "—"} incident-free` : "Not in this snapshot",
      record: "DEC-0037",
    },
    {
      key: "g2b",
      name: "Paper: the rule earns (G2b)",
      state: stopFired(s) ? "failed" : g2b === null ? "pending" : g2b ? "passed" : "pending",
      detail: g ? `${g.trades ?? "—"} of ${g.trades_needed ?? "—"} trades` : "Not in this snapshot",
      record: "DEC-0037",
    },
  ];
  const before = rungs.every((r) => r.state === "passed");
  rungs.push({
    key: "promotion",
    name: "Promotion review",
    state: before ? "pending" : "blocked",
    detail: before ? "Every step above passed" : `${rungs.filter((r) => r.state !== "passed").length} step(s) above not passed`,
    record: "—",
  });
  rungs.push({ key: "live", name: "Real money", state: "never", detail: "Paper only: this repository never trades real money", record: "AGENTS.md" });
  return rungs;
}

function agreementOk(s: Snapshot | null): boolean {
  const g = s?.ops?.paper?.g2;
  if (!g || g.agreement_level !== "bar" || !finite(g.agreement_days) || g.agreement_days === 0) return false;
  return (g.agreement_agree ?? 0) / g.agreement_days >= 0.9;
}

function stopFired(s: Snapshot | null): boolean {
  return !!s?.ops?.paper?.stop_rule?.fired;
}

// ---------------------------------------------------------------- the blockers

/** Why B cannot move forward, as numbers. Empty only when every evidence step passed. */
export function blockers(e: Evidence | null, s: Snapshot | null): string[] {
  const out: string[] = [];
  if (!e) return ["The research evidence file is missing"];
  if (e.evidence.corrective_reruns_done < e.evidence.corrective_reruns_owed) {
    out.push(`Evidence is ${e.evidence.label}: ${e.evidence.corrective_reruns_done} of ${e.evidence.corrective_reruns_owed} corrective re-runs done (DEC-0011)`);
  }
  for (const i of e.g1.items) if (!i.pass) out.push(`G1 · ${itemText(i)}`);
  if (crossesZero(e.holdout.ci95)) out.push(`Holdout CI ${ciText(e.holdout.ci95)} includes zero`);
  const g = s?.ops?.paper?.g2;
  if (g && finite(g.trades) && g.trades < e.power.full_edge.trades) {
    out.push(`Paper has ${g.trades} trades; telling the backtest edge from zero needs about ${e.power.full_edge.trades}`);
  }
  if (stopFired(s)) out.push("The stop rule fired: no new entries until a decision record resets it");
  return out;
}

// ---------------------------------------------------------------- the paper desk now

export interface PaperNow {
  trades: number | null;
  meanR: number | null;
  cumR: number | null;
  stopLine: number | null;
  /** Share of the stop line used, 0..1. */
  stopUsed: number | null;
  reviewAt: number | null;
  stopDate: string | null;
  fired: string | null;
  killOn: boolean | null;
  latched: boolean | null;
  equity: number | null;
  start: number | null;
  job: { status: string | null; ended: string | null } | null;
  asOf: string | null;
  /** Hours since the snapshot was taken; null when it has no time. */
  ageHours: number | null;
}

export function paperNow(s: Snapshot | null, now: Date): PaperNow {
  const p = s?.ops?.paper;
  const rule = p?.stop_rule ?? null;
  const trades = finite(rule?.trades) ? rule.trades : finite(p?.g2?.trades) ? p.g2.trades : finite(p?.trades) ? p.trades : null;
  const cumR = finite(rule?.cum_r) ? rule.cum_r : finite(p?.total_r) ? p.total_r : null;
  const meanR = finite(p?.mean_r) ? p.mean_r : trades && cumR !== null ? cumR / trades : null;
  const stopLine = finite(rule?.cum_r_max_loss) ? rule.cum_r_max_loss : null;
  const stopUsed = stopLine !== null && stopLine < 0 && cumR !== null ? Math.min(1, Math.max(0, cumR / stopLine)) : null;
  const job = s?.jobs?.last?.["paper-b"];
  const asOf = s?.as_of ?? null;
  const t = asOf ? Date.parse(asOf) : NaN;
  return {
    trades,
    meanR,
    cumR,
    stopLine,
    stopUsed,
    reviewAt: finite(rule?.review_at_trades) ? rule.review_at_trades : null,
    stopDate: rule?.stop_date ?? null,
    fired: rule?.fired ?? null,
    killOn: typeof s?.kill?.on === "boolean" ? s.kill.on : null,
    latched: typeof p?.virtual?.latched === "boolean" ? p.virtual.latched : null,
    equity: finite(p?.virtual?.equity) ? p.virtual.equity : null,
    start: finite(p?.virtual?.start) ? p.virtual.start : null,
    job: job ? { status: job.status ?? null, ended: job.ended ?? null } : null,
    asOf,
    ageHours: Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3_600_000) : null,
  };
}

/** A snapshot older than this is called stale on the page (two missed hourly publishes and a margin). */
export const STALE_HOURS = 3;

/** One state word for the top of the page. Never says "live": B only ever trades paper. */
export function deskState(p: PaperNow): { word: string; tone: Tone } {
  if (p.fired) return { word: "Stopped by its rule", tone: "bad" };
  if (p.latched) return { word: "Latched", tone: "bad" };
  if (p.killOn) return { word: "Paused: kill switch on", tone: "warn" };
  if (p.job?.status && p.job.status !== "ok") return { word: "Last run did not finish normally", tone: "warn" };
  return { word: "Paper trading", tone: "info" };
}

// ---------------------------------------------------------------- one axis for every estimate

export interface Estimate {
  key: string;
  label: string;
  trades: number | null;
  mean: number | null;
  lo: number | null;
  hi: number | null;
}

export function estimates(e: Evidence | null, p: PaperNow): Estimate[] {
  const out: Estimate[] = [];
  if (e) {
    out.push({ key: "backtest", label: "Backtest (in sample, pre-correction)", trades: e.backtest.trades, mean: e.backtest.expectancy_r, lo: e.backtest.ci95[0] ?? null, hi: e.backtest.ci95[1] ?? null });
    out.push({ key: "walk_forward", label: "Walk-forward (G1, corrected)", trades: e.walk_forward.trades, mean: e.walk_forward.expectancy_r, lo: e.walk_forward.ci95[0] ?? null, hi: e.walk_forward.ci95[1] ?? null });
    out.push({ key: "holdout", label: "Holdout (re-scored)", trades: e.holdout.trades, mean: e.holdout.expectancy_r, lo: e.holdout.ci95[0] ?? null, hi: e.holdout.ci95[1] ?? null });
  }
  if (p.trades && p.meanR !== null) {
    // A normal-approximation interval using the backtest's spread: paper has too few trades to estimate its own.
    const sd = e?.backtest.sd_r ?? null;
    const half = sd !== null ? (1.96 * sd) / Math.sqrt(p.trades) : null;
    out.push({ key: "paper", label: "Paper", trades: p.trades, mean: p.meanR, lo: half !== null ? p.meanR - half : null, hi: half !== null ? p.meanR + half : null });
  }
  return out;
}

/** The shared axis for `estimates`: symmetric enough to include zero, padded, rounded to 0.1R. */
export function axis(rows: Estimate[]): { min: number; max: number } {
  const vals = rows.flatMap((r) => [r.lo, r.hi, r.mean]).filter(finite);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const pad = Math.max(0.05, (hi - lo) * 0.08);
  return { min: Math.floor((lo - pad) * 10) / 10, max: Math.ceil((hi + pad) * 10) / 10 };
}
