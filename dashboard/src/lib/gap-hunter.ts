// The Gap Hunter page's arithmetic. Pure: no I/O; the clock is passed in.
//
// Gap Hunter is the stock robot: it scans the whole market before the open, narrows it to the day's best names and
// trades what comes out, with paper money. The host's ids for it (the job `paper-s`, alert keys `paper-s:*`) are in
// lib/robots.ts.
//
// Everything here is read from the stocks snapshot. What the snapshot does not carry yet is said to be missing, never
// filled in: the host publishes the session job's runs, its alerts, the research registries and the pre-market scan,
// and not yet the robot's own switch, selection, trades or results. Those arrive in an optional `gap_hunter` block
// (GapHunterBlock below); until the host sends it, each part reads "not sent yet".
import { alertTitle, GAP_HUNTER, isGapHunterAlert, isRedAlert, jobKey } from "./robots";
import { scan } from "./today";
import { entries, list, type Snapshot } from "./types";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOr = (v: unknown): number | null => (isNum(v) ? v : null);
const countOr = (v: unknown): number | null => (isNum(v) && v >= 0 ? Math.round(v) : null);
const boolOr = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const dayOr = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// ---------------------------------------------------------------- the optional block

/** Gap Hunter's own selection for one morning, in counts. Never a symbol. */
export interface GapHunterFunnel {
  session: string | null;
  /** Names in the morning pool. */
  kept: number | null;
  /** Names that pass every hard filter. */
  passed: number | null;
  tier1: number | null;
  tier2: number | null;
  /** Was there a first pick? */
  primary: boolean | null;
}

/**
 * What the host is to publish for Gap Hunter, as `gap_hunter` at the top of the stocks snapshot. Every field is
 * optional and each is read on its own, so a host that sends some of them shows those and nothing else changes.
 * Counts, dates, statuses and R only: no symbol, no setup name, no headline.
 */
export interface GapHunterBlock {
  /** Is any rule switched on for it? False while its hypothesis is paused. */
  enabled: boolean | null;
  /** Its own kill switch (not the lab's). */
  kill: boolean | null;
  /** Latched by its loss limits or stop rule. */
  latched: boolean | null;
  /** Armed sessions so far, and the last one (New York date). */
  sessions: number | null;
  lastSession: string | null;
  /** Closed trades, their total and average in R. */
  trades: number | null;
  totalR: number | null;
  meanR: number | null;
  /** Positions open now. */
  open: number | null;
  funnel: GapHunterFunnel | null;
}

/** The block as the host sent it, or null when it sent none (every host, until the publisher carries it). */
export function gapHunterBlock(s: Snapshot | null): GapHunterBlock | null {
  const raw = (s as Record<string, unknown> | null)?.gap_hunter;
  if (!isObj(raw)) return null;
  const f = isObj(raw.funnel) ? raw.funnel : null;
  return {
    enabled: boolOr(raw.enabled),
    kill: boolOr(raw.kill),
    latched: boolOr(raw.latched),
    sessions: countOr(raw.sessions),
    lastSession: dayOr(raw.last_session),
    trades: countOr(raw.trades),
    totalR: numOr(raw.total_r),
    meanR: numOr(raw.mean_r),
    open: countOr(raw.open),
    funnel: f
      ? { session: dayOr(f.session), kept: countOr(f.kept), passed: countOr(f.passed), tier1: countOr(f.tier1), tier2: countOr(f.tier2), primary: boolOr(f.primary) }
      : null,
  };
}

// ---------------------------------------------------------------- the records that register its rule

export interface RecordState {
  id: string;
  /** The registry's own status word, or null when this snapshot's registry does not list the record. */
  status: string | null;
  date: string | null;
}

/** A status is a word or two from the registry. Anything longer is prose, which this site never shows. */
const statusWord = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.length <= 40 ? v.trim() : null);

export function records(s: Snapshot | null): { decision: RecordState; hypothesis: RecordState } {
  const d = list(s?.research?.decisions).find((x) => x.id === GAP_HUNTER.decision);
  const h = list(s?.research?.hypotheses).find((x) => x.id === GAP_HUNTER.hypothesis);
  return {
    decision: { id: GAP_HUNTER.decision, status: statusWord(d?.status), date: dayOr(d?.date) },
    hypothesis: { id: GAP_HUNTER.hypothesis, status: statusWord(h?.status), date: null },
  };
}

// ---------------------------------------------------------------- the session job

export interface SessionJob {
  status: string | null;
  exit: number | null;
  started: string | null;
  ended: string | null;
}

export interface JobDay {
  started: string;
  ended: string | null;
  status: string | null;
  exit: number | null;
}

export interface Reliability {
  expected: number;
  ok: number;
  refused: number;
  failed: number;
  missed: number;
}

/** The session job's last run, or null when the host has never reported one. */
export function sessionJob(s: Snapshot | null): SessionJob | null {
  const j = Object.fromEntries(entries(s?.jobs?.last))[GAP_HUNTER.job];
  if (!j) return null;
  return { status: j.status ?? null, exit: numOr(j.exit), started: j.started ?? null, ended: j.ended ?? null };
}

/** Its runs in the snapshot's fortnight, newest first. */
export function sessionRuns(s: Snapshot | null, limit = 10): JobDay[] {
  return list(s?.jobs?.runs)
    .filter((r) => jobKey(r.job) === GAP_HUNTER.job && typeof r.started === "string" && r.started)
    .map((r) => ({ started: r.started as string, ended: r.ended ?? null, status: r.status ?? null, exit: numOr(r.exit) }))
    .sort((a, b) => b.started.localeCompare(a.started))
    .slice(0, limit);
}

/** How often the session job ran as planned over the snapshot's fortnight; null until the host counts it. */
export function reliability(s: Snapshot | null): Reliability | null {
  const row = list(s?.sla?.summary).find((r) => jobKey(r.job) === GAP_HUNTER.job);
  if (!row || !isNum(row.expected)) return null;
  return { expected: row.expected, ok: row.ok ?? 0, refused: row.refused ?? 0, failed: row.failed ?? 0, missed: row.missed ?? 0 };
}

// ---------------------------------------------------------------- alerts

export interface RobotAlert {
  key: string;
  title: string;
  since: string | null;
  red: boolean;
}

export function firing(s: Snapshot | null): RobotAlert[] {
  return list(s?.alerts?.firing)
    .filter((a) => isGapHunterAlert(a.key))
    .map((a) => ({ key: a.key ?? "", title: alertTitle(a.key, a.title), since: a.since ?? null, red: isRedAlert(a.key) }))
    .sort((a, b) => Number(b.red) - Number(a.red) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- the state, in one word

export interface Standing {
  word: string;
  tone: Tone;
  /** One line under the word: what the word rests on. */
  detail: string;
}

const RUN_WORD: Record<string, string> = { ok: "finished normally", failed: "failed", refused: "was refused", timeout: "timed out", running: "is running now" };

/** How the last session run reads in a sentence. */
export function runWords(j: SessionJob | null): string {
  if (!j) return "No session reported yet";
  const w = RUN_WORD[String(j.status ?? "").toLowerCase()];
  return w ? `Last session ${w}` : j.status ? `Last session reported "${j.status}"` : "Last session has no status";
}

/**
 * Where Gap Hunter stands, from what the snapshot says and nothing else. It never says "trading" unless the host
 * says a rule is switched on: a session job that runs is not a robot that trades.
 */
export function standing(s: Snapshot | null): Standing {
  if (!s) return { word: "No data", tone: "neutral", detail: "No status snapshot has been received yet." };
  const alerts = firing(s);
  const red = alerts.filter((a) => a.red).length;
  if (red > 0) return { word: "Needs you now", tone: "bad", detail: `${red} urgent alert${red === 1 ? "" : "s"} firing.` };
  const b = gapHunterBlock(s);
  const j = sessionJob(s);
  const status = String(j?.status ?? "").toLowerCase();
  if (b?.latched === true) return { word: "Latched", tone: "bad", detail: "Its own limits have stopped new entries." };
  if (b?.kill === true) return { word: "Paused: its kill switch is on", tone: "warn", detail: "No new entries until the switch is removed on the host." };
  // The root file is the master switch: it stops Gap Hunter too, even with its own file off.
  if (s.kill?.on === true) return { word: "Paused: the root kill switch is on", tone: "warn", detail: "The root file stops every desk. No new entries until it is removed on the host." };
  if (status === "failed" || status === "timeout") return { word: "Last session did not finish", tone: "warn", detail: `${runWords(j)}.` };
  if (status === "refused") return { word: "Did not start", tone: "warn", detail: "The host refused to start the last session." };
  if (alerts.length > 0) return { word: "Needs a look", tone: "warn", detail: `${alerts.length} alert${alerts.length === 1 ? "" : "s"} firing.` };
  if (b?.enabled === true) return { word: "Paper trading", tone: "info", detail: "A rule is switched on. Paper money only." };
  if (b?.enabled === false) return { word: "Not switched on", tone: "neutral", detail: "The session runs, but no rule is switched on, so it places no order." };
  if (!j) return { word: "No session reported yet", tone: "neutral", detail: "The host has not reported a Gap Hunter session." };
  return { word: "Session runs", tone: "neutral", detail: "Whether a rule is switched on is not sent yet." };
}

// ---------------------------------------------------------------- the morning funnel

export interface FunnelStep {
  key: string;
  label: string;
  /** A count, or for the first pick whether there was one. Null when not known. */
  value: number | boolean | null;
}

export interface MorningFunnel {
  /**
   * `own`: Gap Hunter's own selection, sent by the host. `scan`: the pre-market scan's counts under the filter the
   * routine runs today, which is not Gap Hunter's rule. `none`: nothing to show.
   */
  source: "own" | "scan" | "none";
  session: string | null;
  /** False when the counts are from an earlier session than the market's trading day. */
  current: boolean;
  /** The whole market narrowing to the morning pool. */
  market: FunnelStep[];
  /** The pool narrowing to the day's names. */
  selection: FunnelStep[];
}

const step = (key: string, label: string, value: number | boolean | null): FunnelStep => ({ key, label, value });

export function morningFunnel(s: Snapshot | null): MorningFunnel {
  if (!s) return { source: "none", session: null, current: false, market: [], selection: [] };
  const v = scan(s);
  const l = v.latest;
  const market = l ? [step("universe", "Listed stocks", l.universe), step("traded", "Trading before the open", l.traded), step("kept", "Gapping up", l.gapping)] : [];
  const own = gapHunterBlock(s)?.funnel ?? null;
  const day = s.market?.trading_day_et ?? null;
  if (own) {
    return {
      source: "own",
      session: own.session,
      current: own.session !== null && own.session === day,
      market: own.session !== null && own.session === v.date ? market : [],
      selection: [step("kept", "In the morning pool", own.kept), step("passed", "Passed every filter", own.passed), step("tier1", "Tier 1", own.tier1), step("tier2", "Tier 2", own.tier2), step("primary", "First pick", own.primary)],
    };
  }
  const w = v.why;
  const n = (code: string) => w?.steps.find((x) => x.code === code)?.count ?? null;
  if (!l || !w || w.steps.length === 0) return { source: market.length > 0 ? "scan" : "none", session: v.date, current: v.current, market, selection: [] };
  const primary = n("primary");
  return {
    source: "scan",
    session: v.date,
    current: v.current,
    market,
    selection: [step("passed", "Passed every filter", n("passed")), step("tier1", "Tier 1", n("tier1")), step("tier2", "Tier 2", n("tier2")), step("primary", "First pick", primary === null ? null : primary > 0)],
  };
}
