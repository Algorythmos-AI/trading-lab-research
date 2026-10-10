// The Today page: what the stocks desk did in its latest session, in the order it happened. Pure helpers over
// fields the snapshot already carries; no I/O and no clock.
import { jobTone, type Tone } from "./labels";
import { nyClock } from "./options";
import { entries, list, type Snapshot } from "./types";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): number | null => (isNum(v) ? v : null);

/** What each scan stage is, in the order the routine runs them. The 11:31 file carries no stage name. */
const STAGE: Record<string, { label: string; does: string }> = {
  tier1: { label: "First scan", does: "Finds stocks gapping up before the open and ranks them" },
  charts: { label: "Chart checks", does: "Re-scans, then checks each candidate's chart" },
  tier2: { label: "Short list", does: "Re-scans and picks the few names worth a plan" },
  tickets: { label: "Trade plans", does: "Writes a dry-run plan for each short-listed name" },
  signals: { label: "Signals", does: "Checks whether any plan would have triggered after the open" },
};

export interface ScanStage {
  key: string;
  label: string;
  does: string;
  /** "08:30" New York, or null for the signals check. */
  at: string | null;
  universe: number | null;
  traded: number | null;
  gapping: number | null;
  candidates: number | null;
  shortList: number | null;
  tickets: number | null;
  signals: number | null;
}

export interface Candidate {
  symbol: string;
  score: number | null;
  shortListed: boolean;
  primary: boolean;
}

export interface Scan {
  /** The session the scan belongs to (New York date), or null when no scan has ever been published. */
  date: string | null;
  /** False when the newest scan is from an earlier session than the market's current trading day. */
  current: boolean;
  stages: ScanStage[];
  /** The newest stage that ran a scan (not the signals check). */
  latest: ScanStage | null;
  candidates: Candidate[];
  /** Why names went no further, as the newest scan saw it. Null until the host publishes these counts. */
  why: Why | null;
  /** True when the newest scan had no data to scan: an empty universe, or no stock with a pre-market bar. That
   * is a data failure, never a quiet morning. False for an older host that does not say. */
  failed: boolean;
  /** The feed the newest scan read ("hybrid", "sip", "iex"), when the host says. */
  feed: string | null;
}

export interface NearRow {
  symbol: string;
  price: number | null;
  /** The one filter this name failed, in words. */
  label: string;
}

/** Names that failed exactly one filter in the newest scan. Null until the host publishes them. */
export interface Near {
  total: number;
  rows: NearRow[];
}

export interface WhyRow {
  code: string;
  label: string;
  count: number;
}

/** The funnel record of one scan stage (the host's wt.scanner.explain), in counts. */
export interface Why {
  /** "09:15" New York: the stage these counts are from. */
  at: string | null;
  /** Nested: each step is a subset of the one before it. */
  steps: WhyRow[];
  /** Hard filters: how many names failed each one (a name can fail several), and how many failed only that one. */
  reasons: (WhyRow & { only: number })[];
  /** Candidates that the chart checks stopped, by check (a name can fail several). */
  chart: WhyRow[];
  /** The same steps for names priced US$2 to US$20. A count beside the registered bands: it selects nothing. */
  band: WhyRow[];
  /** True when the host could not build the record for this stage. */
  failed: boolean;
}

const STEP: [string, string][] = [
  ["kept", "Gapping up"],
  ["passed", "Passed every filter"],
  ["tier1", "Candidates"],
  ["chart_ok", "Passed the chart checks"],
  ["tier2", "Short list"],
  ["primary", "First pick"],
];
const REASON: Record<string, string> = {
  price: "Price outside the band",
  gap: "Gap too small",
  float: "Too many shares",
  float_unknown: "Share count not known",
  pm_volume: "Too little pre-market volume",
  rvol: "Volume not unusual enough",
  catalyst_excluded: "News of an excluded kind",
  catalyst_missing: "No qualifying news",
};
const CHART: Record<string, string> = {
  history: "Too little price history",
  trend: "Not in an uptrend",
  window: "No room above the price",
  pm_consolidation: "Not holding near its pre-market high",
  suspect_split: "Looks like an unadjusted split",
  chart: "Chart checks",
};

/** The newest scan stage's funnel record. Every key is optional: an older host sends none, and then this is null. */
export function why(stats: Record<string, unknown> | null | undefined, at: string | null): Why | null {
  const st = stats ?? {};
  const failed = isNum(st.explain_error) && st.explain_error > 0;
  if (!isNum(st.n_kept)) return failed ? { at, steps: [], reasons: [], chart: [], band: [], failed } : null;
  const n = (k: string) => (isNum(st[k]) ? (st[k] as number) : 0);
  const rows = (prefix: string, labels: Record<string, string>): WhyRow[] =>
    Object.keys(st)
      .filter((k) => k.startsWith(prefix) && isNum(st[k]))
      .map((k) => ({ code: k.slice(prefix.length), label: labels[k.slice(prefix.length)] ?? k.slice(prefix.length), count: n(k) }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return {
    at,
    steps: STEP.map(([code, label]) => ({ code, label, count: n(`n_${code}`) })),
    reasons: rows("drop_", REASON).map((r) => ({ ...r, only: n(`sole_${r.code}`) })),
    chart: rows("chart_", CHART),
    band: STEP.filter(([code]) => isNum(st[`band2_20_${code}`])).map(([code, label]) => ({ code, label, count: n(`band2_20_${code}`) })),
    failed,
  };
}

export function near(s: Snapshot): Near | null {
  const n = s.ops?.routine?.near;
  if (!n || !isNum(n.total)) return null;
  const rows = list(n.rows)
    .filter((r): r is { symbol: string; price?: number | null; reason?: string | null } => typeof r.symbol === "string" && r.symbol.length > 0)
    .map((r) => ({ symbol: r.symbol, price: count(r.price), label: REASON[r.reason ?? ""] ?? "Another filter" }));
  return { total: n.total, rows };
}

/** The forward test's own funnel for its newest session: the after-close pool, in counts. Kept apart from the
 * dry run's (`scan().why`): the two read different data at different times and are never merged. */
export function ofRecord(s: Snapshot): { session: string | null; kept: number | null; universe: number | null; why: Why } | null {
  const f = s.ops?.forward?.funnel;
  const w = f ? why(f.counts as Record<string, unknown> | undefined, null) : null;
  if (!f || !w || w.steps.length === 0) return null;
  return { session: f.session ?? null, kept: count(f.pool?.kept), universe: count(f.pool?.universe), why: w };
}

export function scan(s: Snapshot): Scan {
  const r = s.ops?.routine;
  const date = r?.date ?? null;
  const tradingDay = s.market?.trading_day_et ?? null;
  const raw = list(r?.stages);
  const stages: ScanStage[] = raw.map((st) => {
    const key = st.stage ?? "signals";
    const meta = STAGE[key] ?? { label: key, does: "" };
    const c = st.counts ?? {};
    return {
      key,
      label: meta.label,
      does: meta.does,
      at: st.as_of_et ?? null,
      universe: count(st.stats?.universe),
      traded: count(st.stats?.snapshot_symbols),
      gapping: count(st.stats?.kept),
      candidates: count(c.tier1),
      shortList: count(c.tier2),
      tickets: count(c.tickets),
      signals: count(c.signals),
    };
  });
  const scans = stages.filter((x) => x.key !== "signals");
  const latest = scans.length > 0 ? scans[scans.length - 1]! : null;
  // Candidates as of the newest stage that listed any: later stages re-rank, so the newest list wins.
  const withNames = [...raw].reverse().find((st) => list(st.tier1).length > 0);
  const shortList = new Set(list([...raw].reverse().find((st) => list(st.tier2).length > 0)?.tier2));
  const primary = [...raw].reverse().find((st) => st.primary)?.primary ?? null;
  const candidates: Candidate[] = list(withNames?.tier1)
    .filter((c): c is { symbol: string; score?: number | null } => typeof c.symbol === "string" && c.symbol.length > 0)
    .map((c) => ({
      symbol: c.symbol,
      score: count(c.score),
      shortListed: shortList.has(c.symbol),
      primary: primary === c.symbol,
    }));
  const newest = [...raw].reverse().find((st) => (st.stage ?? "signals") !== "signals");
  return {
    date,
    current: date !== null && tradingDay !== null && date === tradingDay,
    stages,
    latest,
    candidates,
    why: why(newest?.stats as Record<string, unknown> | undefined, newest?.as_of_et ?? null),
    failed: newest?.scan_failed === true || (latest !== null && (latest.universe === 0 || latest.traded === 0)),
    feed: typeof newest?.feed === "string" ? newest.feed : null,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "Pre-market: 801 scanned, 47 gapping, 1 candidate, 0 trade plans." Counts only. Null when there is no
 * scan for the current trading day, so an older session is never described as today's. */
export function scanSentence(s: Snapshot): string | null {
  const v = scan(s);
  if (!v.current || !v.latest || v.latest.traded === null) return null;
  const parts = [`${v.latest.traded.toLocaleString("en-US")} scanned`];
  if (v.latest.gapping !== null) parts.push(`${v.latest.gapping.toLocaleString("en-US")} gapping`);
  if (v.latest.candidates !== null) parts.push(plural(v.latest.candidates, "candidate"));
  const tickets = v.stages.find((x) => x.key === "tickets")?.tickets;
  if (isNum(tickets)) parts.push(plural(tickets, "trade plan"));
  return `Pre-market: ${parts.join(", ")}.`;
}

/** Plain words for the paper runner's journal events. An unknown event is shown as it is. */
const EVENT: Record<string, string> = {
  armed: "Armed for the session",
  lease: "Took the primary lease",
  no_session: "No session today",
  too_early: "Started too early; waiting for the scheduled start",
  refuse_to_arm: "Refused to arm",
  decision: "Looked at a bar",
  decision_summary: "End-of-day summary of what it would have done",
  blocked: "Entries blocked",
  kill_state: "Kill switch changed",
  entry_placed: "Entry order placed",
  entry_not_placed: "Entry not placed",
  entry_filled: "Entry filled",
  trade_closed: "Trade closed",
  signal_skipped_size: "Signal skipped: size too small",
  signal_skipped_no_quote: "Signal skipped: no quote to price it",
  decision_inputs_missing: "Could not check the signal: prices missing",
  reconcile: "Checked orders against the broker",
  reconcile_startup: "Checked orders against the broker at start",
  data_timeout: "Market data timed out",
  loop_error: "Error in the session loop",
  clock_skew: "Clock out of step with the broker",
  session_end: "Session ended",
  END_OF_DAY_NOT_FLAT: "Not flat at the close",
};

/** Plain words for the codes that follow an event (blocker kinds, exception classes). */
const DETAIL: Record<string, string> = {
  kill_file: "kill switch on",
  latched: "loss latch set",
  entries_off: "entries switched off",
  max_1_trade_per_day: "one trade a day already taken",
  exposure_exists: "already in a position",
  stale_signal_data: "signal data too old",
  spread_or_no_quote: "no quote, or spread too wide",
  plan_not_persisted: "plan could not be saved",
  account_not_persisted: "account could not be saved",
  event: "macro event window",
  refused: "refused",
};

export function eventLabel(event: string | null | undefined): string {
  return typeof event === "string" && event ? (EVENT[event] ?? event) : "—";
}

/** "kill_file, stale_signal_data" -> "kill switch on, signal data too old". Dates and unknown codes pass through. */
export function detailLabel(detail: string | null | undefined): string {
  if (typeof detail !== "string" || !detail) return "";
  return detail
    .split(/,\s*/)
    .map((d) => DETAIL[d] ?? d)
    .join(", ");
}

/** The jobs that make up a session, with the last run of each. */
export function sessionJobs(s: Snapshot): { key: string; status: string | null; started: string | null; ended: string | null }[] {
  const last = Object.fromEntries(entries(s.jobs?.last));
  return ["routine", "paper-b", "forward"].map((key) => ({
    key,
    status: last[key]?.status ?? null,
    started: last[key]?.started ?? null,
    ended: last[key]?.ended ?? null,
  }));
}

/** The New York day the session clock draws: 04:00 to 20:00, in minutes after midnight. */
export const CLOCK_FROM = 4 * 60;
export const CLOCK_TO = 20 * 60;
export const BELL_OPEN = 9 * 60 + 30;
export const BELL_CLOSE = 16 * 60;

/** When each session job is scheduled to start, New York minutes (the host's systemd timers). */
export const SCHEDULE: Record<string, number> = { routine: 7 * 60 + 30, "paper-b": 8 * 60 + 30, forward: 15 * 60 + 40 };

export interface ClockRun {
  key: string;
  status: string | null;
  tone: Tone;
  /** Scheduled start, New York minutes. */
  at: number;
  /** The last run on the clock's day, New York minutes; null when the last run was on another day. */
  from: number | null;
  /** Null while it is still running (the bar then reaches "now"), or when it did not run that day. */
  to: number | null;
  running: boolean;
  started: string | null;
  ended: string | null;
}

/**
 * The session as one New York day: each job's scheduled start and, when its last run was on that day, the span it
 * actually ran. The day is the market's trading day. Pure: "now" is drawn by the browser.
 */
export function sessionClock(s: Snapshot): { day: string | null; runs: ClockRun[] } {
  const day = s.market?.trading_day_et ?? null;
  const runs = sessionJobs(s).map((j) => {
    const start = j.started ? nyClock(j.started) : null;
    const end = j.ended ? nyClock(j.ended) : null;
    const onDay = start !== null && start.day === day;
    const running = onDay && j.status === "running";
    return {
      key: j.key,
      status: j.status,
      tone: running ? ("warn" as Tone) : jobTone(j.status),
      at: SCHEDULE[j.key] ?? CLOCK_FROM,
      from: onDay ? start.minutes : null,
      // A run that ends after midnight is drawn to the end of the day.
      to: onDay && !running && end ? (end.day === day ? end.minutes : CLOCK_TO) : null,
      running,
      started: j.started,
      ended: j.ended,
    };
  });
  return { day, runs };
}
