// The Today page: what the stocks desk did in its latest session, in the order it happened. Pure helpers over
// fields the snapshot already carries; no I/O and no clock.
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
  return { date, current: date !== null && tradingDay !== null && date === tradingDay, stages, latest, candidates };
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
