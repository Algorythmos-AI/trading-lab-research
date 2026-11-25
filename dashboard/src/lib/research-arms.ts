// The research arms' story (DEC-0041, EXP-0030): the fixed facts of the records, and the pure arithmetic the
// Research arms page draws from the Paper options document. No I/O, no clock of its own.
//
// Every fact here is read from a record and names it. The arms are identified by hypothesis id with short neutral
// words of this page's own (a trial's registered name names its setup, which never reaches the dashboard). The
// figures are the shadow arms' simulated trades only, inside DEC-0041's window, one book per arm, never added up.
import { daily, nyTime, type Trade } from "./journal";
import { withTrades, type ArmBook } from "./paper";
import calendar from "./market-calendar.json";
import type { PaperOptions } from "./paper-options.types";

/** The window and the close (DEC-0041 point 5 and 6, DEC-0056 point 5 and 6, DEC-0059 point 2). */
export const WINDOW = {
  /** The owner switched booking on (`research_arms.enabled: true`) on 2026-11-05 (DEC-0059). */
  from: "2026-11-05",
  /** The last session under EXP-0029's config (`review.SPREAD5_END`): the end of every arm. */
  last: "2026-11-17",
  /** DEC-0056's change gave the control a new config hash from this session. */
  ended: "2026-11-18",
  /** The first session run with booking off: DEC-0059's switch reached the host in Release #509 (18 Nov evening). */
  bookingOff: "2026-11-19",
  /** Every trial closes with no verdict on this date (`arms_verdict.CLOSE_DATE`). */
  close: "2027-11-05",
  /** EXP-0029 closed with 9 sessions, 2026-11-05 to 2026-11-17 (DEC-0056 point 5): no arm can hold more. */
  maxSessions: 9,
} as const;

/** What a trial needs before its verdict is worked out (DEC-0030 section 6, `arms_verdict.MIN_UNITS/MIN_SESSIONS`). */
export const COUNT = { units: 30, sessions: 20 } as const;
/** The bootstrap of `arms_verdict` (`N_BOOT`) and its range (EXP-0030 "Verdict"). */
export const BOOTSTRAP = { draws: 5000, level: 0.95 } as const;

export type ArmKind = "tag" | "shadow";

export interface ArmTrial {
  hyp: string;
  kind: ArmKind;
  /** The control trial the arm rides on, or null for an arm with its own trigger. */
  base: "HYP-0029" | "HYP-0030" | null;
  /** This page's own neutral words for what the arm varies. */
  label: string;
  /** The quantity its verdict tests (EXP-0030 "Compared"). */
  compares: string;
}

const tag = (hyp: string, base: ArmTrial["base"], label: string): ArmTrial => ({ hyp, kind: "tag", base, label, compares: "difference in means, with and without the flag" });

/**
 * The fourteen trials, HYP-0034 to HYP-0047, in the order of EXP-0030's table. The labels are categories only: a
 * pair of tag trials shares a number, so a reader can match the pair without the label saying what the flag is.
 */
export const TRIALS: readonly ArmTrial[] = [
  tag("HYP-0034", "HYP-0029", "Entry flag 1"),
  tag("HYP-0035", "HYP-0030", "Entry flag 1"),
  tag("HYP-0036", "HYP-0029", "Entry flag 2"),
  tag("HYP-0037", "HYP-0030", "Entry flag 2"),
  tag("HYP-0038", "HYP-0029", "Entry flag 3"),
  tag("HYP-0039", "HYP-0030", "Entry flag 3"),
  tag("HYP-0040", "HYP-0029", "Entry flag 4"),
  tag("HYP-0041", "HYP-0030", "Entry flag 4"),
  tag("HYP-0042", "HYP-0029", "Entry flag 5"),
  tag("HYP-0043", "HYP-0030", "Entry flag 5"),
  { hyp: "HYP-0044", kind: "shadow", base: "HYP-0029", label: "Exit variant", compares: "paired difference against the control's own trade" },
  { hyp: "HYP-0045", kind: "shadow", base: "HYP-0030", label: "Exit variant", compares: "paired difference against the control's own trade" },
  { hyp: "HYP-0046", kind: "shadow", base: null, label: "New entry A", compares: "mean of its own trades" },
  { hyp: "HYP-0047", kind: "shadow", base: null, label: "New entry B", compares: "mean of its own trades" },
];

export const SHADOW_HYPS = TRIALS.filter((t) => t.kind === "shadow").map((t) => t.hyp);

/** Where a record's own page is (the Reference Registry's drill-down). */
export const recordHref = (id: string) => `/research/records/${encodeURIComponent(id)}`;

/** The New York session a simulated trade was opened in: the arms trade inside one session. */
export const sessionOf = (t: Pick<Trade, "opened_at">): string => nyTime(t.opened_at).day;

/** True for a session inside DEC-0041's window, 5 to 17 Nov 2026. */
export const inWindow = (session: string) => session >= WINDOW.from && session <= WINDOW.last;

/**
 * The book cut to DEC-0041's window: sessions from 2026-11-05 (booking began) to 2026-11-17. The host already cuts
 * the end (`paper_site.arms_block`, DEC-0059 point 2); the page cuts both ends, so no row outside the window can be
 * shown or counted toward a trial even if one arrives.
 */
export function insideWindow<B extends ArmBook>(book: B): B {
  const kept = book.trades.filter((t) => inWindow(sessionOf(t)));
  return kept.length === book.trades.length ? book : (withTrades(book, kept) as B);
}

export interface Progress {
  trades: number;
  sessions: number;
  /** Share of the count reached, 0..1. */
  tradeShare: number;
  sessionShare: number;
}

const share = (n: number, of: number) => Math.min(1, Math.max(0, n / of));

/** An arm's simulated trades and the sessions they fall in, against the count a verdict needs. */
export function armProgress(trades: readonly Trade[]): Progress {
  const sessions = new Set(trades.map(sessionOf)).size;
  return { trades: trades.length, sessions, tradeShare: share(trades.length, COUNT.units), sessionShare: share(sessions, COUNT.sessions) };
}

/** The running total of one arm, day by day, led by 0: its sparkline. */
export const armCurve = (trades: readonly Trade[]): number[] => [0, ...daily(trades).map((d) => d.cum)];

// ── The lab ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** EXP-0052's first read point: tables are worked out at 20 counted sessions (`read_points_counted_sessions`). */
export const FIRST_READ = 20;

export interface LabProgress {
  firstV2: string | null;
  shadowDone: number;
  shadowNeeded: number;
  shadowLeft: number;
  counted: number;
  recorded: number;
  archived: number;
  /** Counted sessions still needed before the first tables. */
  toFirstRead: number;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** The lab's progress from the document's `lab` block; null when the block is absent or unreadable. */
export function labProgress(doc: PaperOptions | null): LabProgress | null {
  const lab = doc?.lab;
  if (!lab || typeof lab !== "object") return null;
  const shadowDone = count(lab.shadow_done);
  const shadowNeeded = count(lab.shadow_needed);
  const counted = count(lab.counted);
  if (shadowDone === null || shadowNeeded === null || counted === null) return null;
  return {
    firstV2: typeof lab.first_v2 === "string" ? lab.first_v2 : null,
    shadowDone,
    shadowNeeded,
    shadowLeft: Math.max(0, shadowNeeded - shadowDone),
    counted,
    recorded: count(lab.recorded) ?? 0,
    archived: count(lab.archived) ?? 0,
    toFirstRead: Math.max(0, FIRST_READ - counted),
  };
}

// ── The timeline ─────────────────────────────────────────────────────────────────────────────────────────────────

export type MilestoneKey = "registered" | "window" | "last" | "switched-off" | "lab" | "v2" | "counting" | "tables" | "close";

export interface Milestone {
  key: MilestoneKey;
  /** The New York day it happened or is due; null for a step that moves with the lab's progress. */
  date: string | null;
  title: string;
  detail: string;
  records: readonly string[];
  /** The arms or the lab that replaced them. */
  track: "arms" | "lab";
}

export const MILESTONES: readonly Milestone[] = [
  { key: "registered", date: "2026-11-05", track: "arms", title: "Fourteen trials registered", detail: "Ten tag arms and four shadow arms, beside the options clone. Family O grows from 21 to 35 trials. Booking switched on the same day.", records: ["DEC-0041", "EXP-0030"] },
  { key: "window", date: "2026-11-05", track: "arms", title: "Booking window opens", detail: "Every session counts while the control keeps the config it had on the first day.", records: ["EXP-0030"] },
  { key: "last", date: "2026-11-17", track: "arms", title: "Last counted session", detail: "A rule change to the control from 18 Nov gives it a new config, which ends every arm with at most 9 sessions. The same day, a second record lets the Paper page show running figures.", records: ["DEC-0056", "DEC-0057"] },
  { key: "switched-off", date: "2026-11-18", track: "arms", title: "Booking switched off by record", detail: "The switch goes off and the Paper page shows each arm only up to 17 Nov. The change reached the host that evening, so booking is off from the 19 Nov session.", records: ["DEC-0059"] },
  { key: "lab", date: "2026-11-19", track: "lab", title: "The options lab starts recording", detail: "The focus names' option quotes are recorded on the host to measure real stop hits, costs and fills. No trade.", records: ["DEC-0060"] },
  { key: "v2", date: "2026-11-20", track: "lab", title: "Recorder v2: freshness counted", detail: "Stale quotes no longer count as coverage. The first v2 session opens five shadow sessions.", records: ["DEC-0067", "EXP-0052"] },
  { key: "counting", date: null, track: "lab", title: "Counting starts", detail: "From the sixth v2 session, each session that passes the counting rules counts.", records: ["EXP-0052"] },
  { key: "tables", date: null, track: "lab", title: "First tables", detail: "At 20 counted sessions: stop survival, round-trip cost, fill odds and model gap.", records: ["EXP-0052"] },
  { key: "close", date: "2027-11-05", track: "arms", title: "Every arm closes with no verdict", detail: "None can reach 20 sessions. Each stays counted in family O.", records: ["DEC-0041", "DEC-0056"] },
];

export type MilestoneState = "done" | "next" | "later" | "unknown";

/**
 * Done when its day has come, or, for the lab's undated steps, when the lab block says so. Without the lab block an
 * undated step is unknown, never guessed. The first step not done (and not unknown) after today is next.
 */
export function milestoneStates(today: string, lab: LabProgress | null): MilestoneState[] {
  let nextGiven = false;
  return MILESTONES.map((m) => {
    let done: boolean | null;
    if (m.date !== null) done = m.date <= today;
    else if (lab === null) done = null;
    else done = m.key === "counting" ? lab.shadowLeft === 0 : lab.toFirstRead === 0;
    if (done === null) return "unknown";
    if (done) return "done";
    if (!nextGiven) {
      nextGiven = true;
      return "next";
    }
    return "later";
  });
}

// ── The market's own sessions (market-calendar.json) ─────────────────────────────────────────────────────────────

const SESSIONS: readonly string[] = calendar.sessions;

/** The regular New York sessions from `from` to `to`, both included. */
export const sessionsBetween = (from: string, to: string): string[] => SESSIONS.filter((d) => d >= from && d <= to);

/** The sessions of the arms' window: 5 to 17 Nov 2026 (DEC-0056 point 5 counts 9). */
export const WINDOW_SESSIONS = sessionsBetween(WINDOW.from, WINDOW.last);
/** The sessions after the window up to the close, in which nothing can be booked: booking is off. */
export const RUNWAY_SESSIONS = sessionsBetween(WINDOW.ended, WINDOW.close);

// ── The session heatmap ──────────────────────────────────────────────────────────────────────────────────────────

export interface HeatRow {
  hyp: string;
  /** Simulated trades opened in each window session, in WINDOW_SESSIONS order. */
  cells: number[];
  /** Trades of the book whose session is not a window session (none in production; the fixtures' are older). */
  outside: number;
}

/** One row per shadow arm the document sends, in TRIALS order: its trades per window session. Counts, not results. */
export function heatmap(books: readonly ArmBook[]): HeatRow[] {
  const index = new Map(WINDOW_SESSIONS.map((d, i) => [d, i]));
  return SHADOW_HYPS.flatMap((hyp) => {
    const book = books.find((b) => b.hyp === hyp);
    if (!book) return [];
    const cells = WINDOW_SESSIONS.map(() => 0);
    let outside = 0;
    for (const t of book.trades) {
      const i = index.get(sessionOf(t));
      if (i === undefined) outside++;
      else cells[i]!++;
    }
    return [{ hyp, cells, outside }];
  });
}

// ── The lab's gate tracker ───────────────────────────────────────────────────────────────────────────────────────

export type GateCell = { state: "counted" | "would-count" | "failed" | "pending"; date: string | null; phase: "shadow" | "counting"; why: readonly string[] };

export interface GateTrack {
  shadow: GateCell[];
  counting: GateCell[];
  /** True when the document lists fewer sessions than were recorded (it keeps the newest 20). */
  partial: boolean;
}

/**
 * The road to the first tables, from the lab block: each shadow session (would it have counted?), then each later
 * v2 session in date order (counted or failed), then one pending cell per counted session still needed. The count
 * of counted sessions is the block's own (`counted`), so a session dropped from the capped list is not lost.
 */
export function gateTrack(doc: PaperOptions | null): GateTrack | null {
  const p = labProgress(doc);
  const lab = doc?.lab;
  if (!p || !lab || !Array.isArray(lab.sessions)) return null;
  const v2 = lab.sessions
    .filter((s) => s && s.recorder === 2 && s.recorded && typeof s.date === "string" && (!p.firstV2 || s.date >= p.firstV2))
    .sort((a, b) => a.date.localeCompare(b.date));
  const shadowRows = v2.filter((s) => s.shadow);
  const after = v2.filter((s) => !s.shadow);
  const shadow: GateCell[] = shadowRows.slice(0, p.shadowNeeded).map((s) => ({ state: s.counts ? "would-count" : "failed", date: s.date, phase: "shadow", why: s.why_not ?? [] }));
  while (shadow.length < p.shadowNeeded) shadow.push({ state: "pending", date: null, phase: "shadow", why: [] });
  const counting: GateCell[] = after.map((s) => ({ state: s.counts ? "counted" : "failed", date: s.date, phase: "counting", why: s.why_not ?? [] }));
  const listedCounted = counting.filter((c) => c.state === "counted").length;
  for (let i = 0; i < Math.max(0, FIRST_READ - Math.max(listedCounted, p.counted)); i++) counting.push({ state: "pending", date: null, phase: "counting", why: [] });
  return { shadow, counting, partial: p.recorded > lab.sessions.length };
}

/** EXP-0052's four tables, locked until the first read point. This page's own short words. */
export const NEXT_TABLES = [
  { key: "stop_survival", title: "Stop survival", what: "How often a premium stop is touched by ordinary movement, and what the loss is when it is." },
  { key: "round_trip_cost", title: "Round-trip cost", what: "What buying and selling a contract really costs: the spread plus fees, on the premium." },
  { key: "limit_fill_band", title: "Limit fill odds", what: "How often a limit at the mid or the ask fills, within half a minute to two minutes." },
  { key: "model_gap", title: "Model gap", what: "How far the Options page's price model is from where the contract really traded." },
] as const;

// ── The live wiring ──────────────────────────────────────────────────────────────────────────────────────────────

export type WireState = "live" | "stale" | "off" | "unknown";

export interface WireStates {
  /** The arms' booking: switched off since the 19 Nov session (DEC-0059). */
  booking: { state: "off"; seen: string };
  /** The paper options document: when the host built it. */
  document: { state: WireState; seen: string | null };
  /** The lab recorder: its latest listed session. */
  recorder: { state: WireState; seen: string | null };
  /** The archive: when the latest listed session's upload was verified, in minutes after its close. */
  upload: { state: WireState; seen: string | null; minutes: number | null };
}

/** The last regular session that has closed by `now` (16:00 New York; a half day is taken as closed by then too). */
export function lastClosedSession(now: Date): string | null {
  const ny = nyTime(now.toISOString());
  const today = ny.day;
  const closed = SESSIONS.filter((d) => d < today || (d === today && ny.minute >= 16 * 60));
  return closed.at(-1) ?? null;
}

/** Each box's last sign of life, and whether it is late. A document over 26 hours old is stale (`paperStale`). */
export function wireStates(doc: PaperOptions | null, now: Date, stale: (d: PaperOptions) => boolean): WireStates {
  const document: WireStates["document"] = doc ? { state: stale(doc) ? "stale" : "live", seen: doc.as_of } : { state: "unknown", seen: null };
  const sessions = Array.isArray(doc?.lab?.sessions) ? [...doc!.lab!.sessions].filter((s) => s && typeof s.date === "string").sort((a, b) => a.date.localeCompare(b.date)) : [];
  const latest = sessions.at(-1) ?? null;
  const last = lastClosedSession(now);
  // One missed session is a late upload or a day off; two or more is stale.
  const behind = latest && last ? sessionsBetween(latest.date, last).length - 1 : null;
  const recorder: WireStates["recorder"] = latest ? { state: behind !== null && behind >= 2 ? "stale" : "live", seen: latest.date } : { state: "unknown", seen: null };
  const archived = [...sessions].reverse().find((s) => s.archived) ?? null;
  const upload: WireStates["upload"] = archived
    ? { state: latest && !latest.archived && behind !== null && behind >= 1 ? "stale" : "live", seen: archived.date, minutes: typeof archived.upload_after_close_min === "number" ? archived.upload_after_close_min : null }
    : { state: "unknown", seen: null, minutes: null };
  return { booking: { state: "off", seen: WINDOW.last }, document, recorder, upload };
}
