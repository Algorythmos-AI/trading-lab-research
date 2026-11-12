// The feed watch: one table of every document a cloud routine (or the desk's own cron) must publish, when it is due,
// how to tell which session a stored document is for, and what to do when it does not arrive. The Operations page's
// "Your feeds" panel, the Options page's health strip and the watchdog's feed alerts all read this table and this
// evaluator, so the pages and the alerts cannot disagree.
//
// Pure: no I/O, the clock is passed in. Every New York time goes through the exchange calendar (market-calendar.ts)
// and nyInstant, never a fixed offset: weekends, holidays and half days come from the session list, "the next
// session" is the next day the market opens, and both clock changes are right for New York and UTC schedules alike.
// A run on a day outside the calendar file's range is assumed (a weekday is taken for a session) and every result says
// so, but nothing pages on it: the day may be a holiday the file does not know. "Assumed" is decided by the run's own
// day: a run on the file's last session is judged and pages as usual, and when the session it is for lies past the
// file, it says so rather than naming a guessed day. The calendar's own end is warned and paged ahead of time, once a
// day, by the pipeline check's calendar.sessions (wt.options.pipeline_check), and the Operations panel says when today
// itself is outside the file (calendarNotice).
//
// This module is outside the shadow evaluator's engine (scripts/gen-engine.mjs walks the imports of desk-eval.ts):
// it imports from the engine's files, and nothing in the engine imports it.
//
// What is published from here (the ntfy topic is public): feed names, state words, minutes, New York times and
// session dates. Never a symbol, a price, a level, an error text, a URL, a host or a commit subject.
import { BAR_MS, sessionBounds } from "./desk-eval";
import { JOURNAL_PATHS, LEDGER_PATHS, OPTIONS_PATHS, RADAR_PATHS } from "./desk";
import { DAILY_GRACE_MIN, INTRADAY_MAX_AGE_MIN, JOURNAL_SLOT_UTC, OPTIONS_SLOT_UTC, RADAR_SLOT_UTC } from "./feeds";
import type { IngestRejectKind } from "./ingest-reject";
import { addDays, nyNow, RANGE, sessionOf } from "./market-calendar";
import type { Notice } from "./ntfy";
import { nyInstant } from "./options";
import { journalCurrent } from "./trade-rules";
import { SERVER_SETTLE_MS } from "./trade-state";

// ---- the table ------------------------------------------------------------------------------------------------------

export type FeedStateName = "on_time" | "waiting" | "late" | "failed" | "not_expected" | "unknown";
/** alert: pages through ntfy when the owner has switched alerts on. display: shown on the pages only. */
export type Severity = "alert" | "display";
export type Zone = "UTC" | "America/New_York";

export interface Schedule {
  /** The zone the routine's own cron uses. Its days are Monday to Friday in that zone. */
  zone: Zone;
  /** Run times, HH:MM in `zone`. */
  times: readonly string[];
  /** Minutes after a run's time by which its document must be stored. */
  grace_min: number;
  /** since-slot only: a stamp this many minutes before the run's time still counts for it (a run that stamps early). */
  early_min?: number;
  /** When a run stops being the one in force: at the next run (default), or at the session's close. */
  until?: "next" | "close";
  /** Only runs before the session's close count (the live journal reads). */
  in_session?: boolean;
  /**
   * false: this schedule's rule could not be checked from this repository (the routine's zone, how it stamps, how
   * early it may fire). Its runs are shown as assumed and a miss of one never pages, as for an unverified row.
   */
  verified?: boolean;
}

/** What a stored document must say to count for a run. */
export type Want =
  /** Its session is the next session after the run's day (the after-close edition is built for tomorrow). */
  | "next-session"
  /** Its session is the run's day or later. */
  | "this-session"
  /** Its session is the last session before the run's day, or later. */
  | "previous-session"
  /** It was stamped at or after the run's time (less early_min). */
  | "since-slot";

/** Which session a stored document is for, and when it was stamped (ms). Either may be unknown. */
export interface Stamp {
  session: string | null;
  at: number | null;
}

interface RowBase {
  /** A stable id: the alert state is kept under it. */
  id: string;
  /** The feed's name as the pages and the alerts say it. Plain words: no symbol, no setup name. */
  name: string;
  /** A short name for a chip. */
  short: string;
  severity: Severity;
  /** The schedule and its zone were checked against docs/runbooks/cloud-routines.md or this repository's own code. An
   * unverified row is shown as "assumed" and never pages, whatever its severity. */
  verified: boolean;
}

/** A document a routine publishes on a schedule. */
export interface DocFeed extends RowBase {
  type: "doc";
  /** Where the document is stored. */
  path: string;
  /** Its ingest kind: a refusal still standing for it turns a late feed into a failed one. */
  ingest_kind?: IngestRejectKind;
  /** Reads the stored document's session and stamp. Anything it cannot read is null. */
  stamp: (doc: unknown) => Stamp;
  want: Want;
  schedules: readonly Schedule[];
  /** How many runs in a row must be missed before it pages (the journal and the ledger: two). */
  misses_to_alert: 1 | 2;
}

/** The shadow evaluator's records: one per settled slot while its switch says "log" (desk-run.ts). */
export interface ShadowFeed extends RowBase {
  type: "shadow";
  /** Minutes without a record, in the session, before it is late. */
  grace_min: number;
}

/** The last refusal /api/ingest recorded for a kind (ingest-reject.ts): failed while no good edition replaced it. */
export interface RefusalFeed extends RowBase {
  type: "refusal";
  kind: IngestRejectKind;
}

export type FeedRow = DocFeed | ShadowFeed | RefusalFeed;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => (typeof v === "string" && DAY_RE.test(v) ? v : null);
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const nyDayOf = (t: number): string => nyNow(new Date(t)).day;

/** `session` and `as_of`: the options edition, the ledger. */
export function sessionStamp(doc: unknown): Stamp {
  if (!isObj(doc)) return { session: null, at: null };
  return { session: day(doc.session), at: ms(doc.as_of) };
}
/** `as_of` alone: the journal, the radar. Its session is the New York day it was stamped. */
export function asOfStamp(doc: unknown): Stamp {
  if (!isObj(doc)) return { session: null, at: null };
  const at = ms(doc.as_of);
  return { session: at === null ? null : nyDayOf(at), at };
}
/** The pre-open refresh: `focus.premarket.as_of`, and the New York day of it. */
export function premarketStamp(doc: unknown): Stamp {
  const focus = isObj(doc) ? doc.focus : null;
  const pre = isObj(focus) ? focus.premarket : null;
  const at = isObj(pre) ? ms(pre.as_of) : null;
  return { session: at === null ? null : nyDayOf(at), at };
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
/** The live journal runs: :24 every hour from 09:24 to 15:24 New York (docs/runbooks/cloud-routines.md). */
const JOURNAL_LIVE_NY = [9, 10, 11, 12, 13, 14, 15].map((h) => hhmm(h * 60 + 24));

/** How early a stamp may be and still be the journal's evening sync (21:38 UTC): ten minutes. */
export const JOURNAL_EVENING_EARLY_MIN = 10;

/** The pre-open refresh runs at 08:50 New York; its prices must be in by 09:05. */
export const PREOPEN_NY = "08:50";
export const PREOPEN_GRACE_MIN = 15;
/** The shadow evaluator: late after this long in the session with no record. */
export const SHADOW_GRACE_MIN = 10;

/**
 * Every feed watched. A new feed is one more row: the runner reads its `path`, evaluates and alerts it, and the pages'
 * loader reads what any requested row needs, with no change elsewhere. Which rows a page draws is that page's choice
 * (STRIP_FEED_IDS for the Options page's strip; the Operations panel's cards).
 */
export const FEEDS: readonly FeedRow[] = [
  {
    type: "doc",
    id: "options-edition",
    name: "Options edition",
    short: "Levels",
    path: OPTIONS_PATHS.latest,
    ingest_kind: "options",
    stamp: sessionStamp,
    want: "next-session",
    schedules: [{ zone: "UTC", times: [hhmm(OPTIONS_SLOT_UTC)], grace_min: DAILY_GRACE_MIN }],
    severity: "alert",
    verified: true,
    misses_to_alert: 1,
  },
  {
    type: "doc",
    id: "pre-open",
    name: "Pre-open refresh",
    short: "Pre-open",
    path: OPTIONS_PATHS.latest,
    ingest_kind: "options",
    stamp: premarketStamp,
    want: "this-session",
    schedules: [{ zone: "America/New_York", times: [PREOPEN_NY], grace_min: PREOPEN_GRACE_MIN, until: "close" }],
    severity: "alert",
    verified: true,
    misses_to_alert: 1,
  },
  {
    type: "doc",
    id: "journal",
    name: "Trade journal",
    short: "Journal",
    path: JOURNAL_PATHS.latest,
    ingest_kind: "journal",
    stamp: asOfStamp,
    want: "since-slot",
    schedules: [
      { zone: "America/New_York", times: JOURNAL_LIVE_NY, grace_min: INTRADAY_MAX_AGE_MIN, in_session: true },
      // Only the evening routine's own read counts for it: at most 10 minutes before 21:38 UTC. The last live run reads
      // until about 16:20:30 New York (21:20 UTC in winter, 20:20 in summer), always earlier than that. Assumed: that
      // the routine stamps its own read time and never fires over 10 minutes early cannot be checked from here, so a
      // missed evening sync is shown, not paged, until the owner confirms it (docs/runbooks/cloud-routines.md).
      { zone: "UTC", times: [hhmm(JOURNAL_SLOT_UTC)], grace_min: DAILY_GRACE_MIN, early_min: JOURNAL_EVENING_EARLY_MIN, verified: false },
    ],
    severity: "alert",
    verified: true,
    misses_to_alert: 2,
  },
  {
    type: "doc",
    id: "ledger-morning",
    name: "Card ledger, morning",
    short: "Ledger am",
    path: LEDGER_PATHS.latest,
    ingest_kind: "ledger",
    stamp: sessionStamp,
    want: "previous-session",
    schedules: [{ zone: "America/New_York", times: ["09:11"], grace_min: DAILY_GRACE_MIN }],
    severity: "display",
    verified: false,
    misses_to_alert: 2,
  },
  {
    type: "doc",
    id: "ledger-afternoon",
    name: "Card ledger, after close",
    short: "Ledger pm",
    path: LEDGER_PATHS.latest,
    ingest_kind: "ledger",
    stamp: sessionStamp,
    want: "this-session",
    schedules: [{ zone: "America/New_York", times: ["16:21"], grace_min: DAILY_GRACE_MIN }],
    severity: "display",
    verified: false,
    misses_to_alert: 2,
  },
  {
    type: "doc",
    id: "radar",
    name: "Radar edition",
    short: "Radar",
    path: RADAR_PATHS.latest,
    ingest_kind: "radar",
    stamp: asOfStamp,
    want: "since-slot",
    schedules: [{ zone: "UTC", times: [hhmm(RADAR_SLOT_UTC)], grace_min: DAILY_GRACE_MIN, early_min: 60 }],
    severity: "alert",
    verified: true,
    misses_to_alert: 1,
  },
  { type: "shadow", id: "shadow", name: "Server check", short: "Server check", grace_min: SHADOW_GRACE_MIN, severity: "alert", verified: true },
  { type: "refusal", id: "refusal-options", name: "Options edition or pre-open refresh", short: "Levels", kind: "options", severity: "alert", verified: true },
  { type: "refusal", id: "refusal-journal", name: "Trade journal", short: "Journal", kind: "journal", severity: "alert", verified: true },
  { type: "refusal", id: "refusal-radar", name: "Radar edition", short: "Radar", kind: "radar", severity: "alert", verified: true },
  { type: "refusal", id: "refusal-ledger", name: "Card ledger", short: "Ledger", kind: "ledger", severity: "display", verified: true },
  { type: "refusal", id: "refusal-options-live", name: "Options live data", short: "Live data", kind: "options-live", severity: "display", verified: true },
  { type: "refusal", id: "refusal-options-clone", name: "Options clone", short: "Clone", kind: "options-clone", severity: "display", verified: true },
  { type: "refusal", id: "refusal-calendar", name: "Economic calendar", short: "Calendar", kind: "calendar", severity: "display", verified: true },
];

/** The feeds the Options page's health strip draws from the server (the prices and the bars are the page's own). */
export const STRIP_FEED_IDS = ["options-edition", "pre-open", "journal", "shadow"] as const;

export function feedById(id: string, table: readonly FeedRow[] = FEEDS): FeedRow | undefined {
  return table.find((f) => f.id === id);
}

// ---- inputs ---------------------------------------------------------------------------------------------------------

/** One read of the store: a value, nothing there, something there that cannot be read, or the store failed. */
export type Read<T> = { status: "ok"; value: T } | { status: "missing" } | { status: "unreadable" } | { status: "error" };

export interface RefusalRead {
  /** A refusal is recorded and nothing of its kind was stored since (ingest-reject.ts rejectIsCurrent). */
  current: boolean;
  /** When it was refused (ISO), or null when none is recorded. */
  at: string | null;
  outcome: "invalid" | "ahead-of-clock" | null;
}

export interface ShadowRead {
  /** The switch, desk/eval.json, parsed strictly (desk-eval.ts parseEvalSwitch): exactly "log". */
  on: boolean;
  /** When the switch was last written (ms), or null when not known. */
  switched_at: number | null;
  /** The end (ms) of the newest server record among the latest settled slots, or null when none of them is there. */
  last_slot_end: number | null;
}

/** Everything the evaluator reads: each document by its path, each kind's refusal, the shadow evaluator's records. */
export interface FeedInputs {
  docs: Readonly<Record<string, Read<unknown>>>;
  refusals: Readonly<Partial<Record<IngestRejectKind, Read<RefusalRead>>>>;
  /** Read only in the session; null when it was not read (the evaluator says "not expected" outside the session). */
  shadow: Read<ShadowRead> | null;
}

/** The stamps alone, per doc feed: what a browser needs to redraw a server-known feed as the clock moves on. */
export type StampRead = Read<Stamp>;
export interface StampedInputs {
  stamps: Readonly<Record<string, StampRead>>;
  refusals: FeedInputs["refusals"];
  shadow: FeedInputs["shadow"];
}

/** Each doc feed's document read into its stamp. A feed whose path was not read is not in `stamps` (unknown). */
export function stampInputs(inputs: FeedInputs, table: readonly FeedRow[] = FEEDS): StampedInputs {
  const stamps: Record<string, StampRead> = {};
  for (const f of table) {
    if (f.type !== "doc") continue;
    const r = inputs.docs[f.path];
    if (!r) continue;
    stamps[f.id] = r.status === "ok" ? { status: "ok", value: f.stamp(r.value) } : r;
  }
  return { stamps, refusals: inputs.refusals, shadow: inputs.shadow };
}

// ---- the calendar ---------------------------------------------------------------------------------------------------

const MIN = 60_000;
const weekdayOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const isWeekdayDay = (d: string) => {
  const w = weekdayOf(d);
  return w >= 1 && w <= 5;
};
const toMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
};

/** Whether the market opens on a New York day, from the calendar; outside its range a weekday is assumed. */
export function marketDay(d: string): { open: boolean; assumed: boolean } {
  const k = sessionOf(d).kind;
  if (k === "out_of_range") return { open: isWeekdayDay(d), assumed: true };
  return { open: k === "open" || k === "half", assumed: false };
}

/** The next (or, with step -1, the last) market day after `d`, from the session list. */
export function adjacentSession(d: string, step: 1 | -1): { day: string; assumed: boolean } {
  let assumed = false;
  let cur = d;
  for (let i = 0; i < 14; i++) {
    cur = addDays(cur, step);
    const m = marketDay(cur);
    assumed ||= m.assumed;
    if (m.open) return { day: cur, assumed };
  }
  return { day: cur, assumed: true };
}

/** The close of a market day (ms): the calendar's, or 16:00 New York when the day is outside its range. */
function closeOf(d: string): number | null {
  const b = sessionBounds(d);
  if (b) return b.close;
  return sessionOf(d).kind === "out_of_range" ? nyInstant(d, 16 * 60) : null;
}

export interface Slot {
  /** When the run is scheduled (ms). */
  due: number;
  /** The document must be stored by this instant (ms). */
  deadline: number;
  /** When this run stops being the one in force (ms). */
  expires: number;
  /** The New York market day the run belongs to. */
  day: string;
  /** The session the document must be for (next-session: the day after; otherwise the run's day). Null when the next
   * session lies past the calendar file: then any session after the run's day will do, and none is named. */
  for_session: string | null;
  schedule: Schedule;
  /** The calendar ran out for this run's own day: it was taken to be a market day because it is a weekday. */
  assumed: boolean;
}

/** Every run of `feed` whose day is within the days around `nowMs`, oldest first. */
export function slotsAround(feed: DocFeed, nowMs: number, back = 12, ahead = 8): Slot[] {
  const today = nyDayOf(nowMs);
  const raw: Omit<Slot, "expires">[] = [];
  for (let i = -back; i <= ahead; i++) {
    const d = addDays(today, i);
    // The cron fires Monday to Friday in its own zone; `d` is a date in that zone.
    if (!isWeekdayDay(d)) continue;
    for (const s of feed.schedules) {
      for (const t of s.times) {
        const minute = toMin(t);
        const due = s.zone === "UTC" ? Date.parse(`${d}T${t}:00Z`) : nyInstant(d, minute);
        if (due === null || !Number.isFinite(due)) continue;
        const sday = nyDayOf(due);
        const m = marketDay(sday);
        if (!m.open) continue;
        const assumed = m.assumed;
        if (s.in_session) {
          const close = closeOf(sday);
          if (close === null || due >= close) continue;
        }
        let forSession: string | null = sday;
        if (feed.want === "next-session") {
          const n = adjacentSession(sday, 1);
          // Past the file the next session is not known (2030-01-01 is a holiday a weekday guess would name).
          forSession = n.assumed ? null : n.day;
        }
        // A run on a day past the file names no session either: its day is only taken to be one.
        if (assumed) forSession = null;
        raw.push({ due, deadline: due + s.grace_min * MIN, day: sday, for_session: forSession, schedule: s, assumed });
      }
    }
  }
  raw.sort((a, b) => a.due - b.due);
  return raw.map((s, i) => {
    const next = raw[i + 1]?.due ?? Number.POSITIVE_INFINITY;
    const expires = s.schedule.until === "close" ? Math.min(closeOf(s.day) ?? next, next) : next;
    return { ...s, expires };
  });
}

/** The next run of a doc feed after `nowMs` (of one of its schedules, by index, when given), or null. */
export function nextDueOf(feed: DocFeed, nowMs: number, schedule?: number): number | null {
  const want = schedule === undefined ? null : feed.schedules[schedule];
  return slotsAround(feed, nowMs).find((s) => s.due > nowMs && (want === null || s.schedule === want))?.due ?? null;
}

/** Whether a stamp counts for a run. */
export function satisfies(feed: DocFeed, stamp: Stamp | null, slot: Slot): boolean {
  if (!stamp) return false;
  switch (feed.want) {
    case "next-session":
      return stamp.session !== null && stamp.session >= (slot.for_session ?? addDays(slot.day, 1));
    case "this-session":
      return stamp.session !== null && stamp.session >= slot.day;
    case "previous-session": {
      const prev = adjacentSession(slot.day, -1).day;
      return stamp.session !== null && stamp.session >= prev;
    }
    case "since-slot":
      return stamp.at !== null && stamp.at >= slot.due - (slot.schedule.early_min ?? 0) * MIN;
  }
}

// ---- the evaluator --------------------------------------------------------------------------------------------------

/** Short, SAFE reason codes: the pages turn them into words, the logs keep them as they are. */
export type Reason =
  | "arrived"
  | "running"
  | "no-document"
  | "unreadable"
  | "no-stamp"
  | "wrong-session"
  | "old-stamp"
  | "refused"
  | "storage-error"
  | "not-read"
  | "no-run-now"
  | "switch-off"
  | "outside-session"
  | "before-first-slot"
  | "recording"
  | "no-record"
  | "no-refusal"
  | "refusal-replaced"
  | "refusal-current";

export interface FeedView {
  id: string;
  type: FeedRow["type"];
  name: string;
  short: string;
  state: FeedStateName;
  reason: Reason;
  /** Minutes since the stored document was stamped, or null when not known. */
  age_min: number | null;
  /** Minutes past the deadline of the first missed run, or null when nothing is late. */
  late_min: number | null;
  /** The run in force: its time, deadline and session. Null when none is. */
  due: number | null;
  deadline: number | null;
  for_session: string | null;
  /** The next scheduled run after now (ms), or null when the feed has no schedule. */
  next_due: number | null;
  /** Runs missed in a row. */
  misses: number;
  /** The incident this belongs to: a new one starts with a new session day (or a new refusal day). */
  episode: string | null;
  severity: Severity;
  verified: boolean;
  /** The calendar ran out, or the schedule is not verified: shown as "assumed". */
  assumed: boolean;
  /** Late or failed enough to page (before the alert switch and the state machine). */
  alerting: boolean;
  /** A next-session run whose next session lies past the calendar file (for_session is then null). */
  next_past_end?: boolean;
  /** Refusal rows: the refusal's outcome code. */
  outcome?: RefusalRead["outcome"];
}

const minutesSince = (from: number | null, nowMs: number) => (from === null ? null : Math.max(0, Math.floor((nowMs - from) / MIN)));

function viewBase(f: FeedRow): Pick<FeedView, "id" | "type" | "name" | "short" | "severity" | "verified"> {
  return { id: f.id, type: f.type, name: f.name, short: f.short, severity: f.severity, verified: f.verified };
}

function nothing(f: FeedRow, state: FeedStateName, reason: Reason, extra: Partial<FeedView> = {}): FeedView {
  return {
    ...viewBase(f),
    state,
    reason,
    age_min: null,
    late_min: null,
    due: null,
    deadline: null,
    for_session: null,
    next_due: null,
    misses: 0,
    episode: null,
    assumed: !f.verified,
    alerting: false,
    ...extra,
  };
}

export function evaluateDoc(f: DocFeed, read: StampRead | undefined, refusal: Read<RefusalRead> | undefined, nowMs: number): FeedView {
  const slots = slotsAround(f, nowMs);
  const nextDue = slots.find((s) => s.due > nowMs)?.due ?? null;
  const ci = slots.findLastIndex((s) => s.due <= nowMs && nowMs < s.expires);
  const stamp = read?.status === "ok" ? read.value : null;
  const age = minutesSince(stamp?.at ?? null, nowMs);
  // A store that could not be read is unknown, never "not due": with no run in force it pages nothing (no episode),
  // but the page says it cannot check.
  if (ci < 0 && read?.status === "error") return nothing(f, "unknown", "storage-error", { next_due: nextDue });
  if (ci < 0) return nothing(f, "not_expected", "no-run-now", { age_min: age, next_due: nextDue });
  const cur = slots[ci]!;
  const at = { due: cur.due, deadline: cur.deadline, for_session: cur.for_session, next_due: nextDue, age_min: age, ...(f.want === "next-session" && cur.for_session === null ? { next_past_end: true } : {}) };
  const assumed = !f.verified || cur.assumed || cur.schedule.verified === false;
  // Past the calendar's end no incident is opened (no episode): the run may be on a holiday the file does not know.
  const unknownEpisode = cur.assumed ? null : `unknown:${cur.day}`;
  if (!read) return nothing(f, "unknown", "not-read", { ...at, assumed, episode: unknownEpisode });
  if (read.status === "error") return nothing(f, "unknown", "storage-error", { ...at, assumed, episode: unknownEpisode });

  // Runs missed in a row, newest first, while each one hands over straight to the next (a run that lapses at the
  // close, like the pre-open refresh, does not carry yesterday's miss into today).
  let misses = 0;
  let firstMissedDeadline: number | null = null;
  let latestMissed: number | null = null;
  for (let i = ci; i >= 0; i--) {
    const s = slots[i]!;
    if (i < ci && s.expires < slots[i + 1]!.due) break;
    if (satisfies(f, stamp, s)) break;
    if (nowMs > s.deadline) {
      misses++;
      firstMissedDeadline = s.deadline;
      latestMissed ??= i;
    }
  }
  if (satisfies(f, stamp, cur)) return { ...nothing(f, "on_time", "arrived", at), assumed };

  let why: Reason;
  if (read.status === "missing") why = "no-document";
  else if (read.status === "unreadable") why = "unreadable";
  else if (!stamp || (stamp.at === null && stamp.session === null)) why = "no-stamp";
  else if (f.want === "since-slot" || stamp.session === null) why = "old-stamp";
  else why = "wrong-session";
  if (misses === 0) return { ...nothing(f, "waiting", "running", at), assumed };
  const m = slots[latestMissed!]!;
  const refused = refusalForSlot(refusal, m.due, slots[latestMissed! + 1]?.due ?? Number.POSITIVE_INFINITY);
  const state: FeedStateName = refused ? "failed" : "late";
  const lateMin = firstMissedDeadline === null ? null : Math.max(0, Math.floor((nowMs - firstMissedDeadline) / MIN));
  // A refusal of THIS run's document pages on its own row (refusal-*), so this row stays quiet for this run only:
  // every later run that is missed pages as late in its own right, refusal or not.
  // Outside the calendar's range a weekday schedule stands in and is shown, saying so, but never pages (the day may be
  // a holiday the file does not know); an unverified row never pages either.
  const alerting = !refused && !m.assumed && f.severity === "alert" && f.verified && m.schedule.verified !== false && misses >= f.misses_to_alert;
  return {
    ...nothing(f, state, refused ? "refused" : why, at),
    late_min: lateMin,
    misses,
    episode: m.day,
    assumed,
    alerting,
  };
}

/**
 * The refusal suppression rule. A refusal still standing quietens a document row's lateness alert only for the run it
 * belongs to: refused at or after that run's time and before the row's next run. One refusal of the shared `options`
 * kind (the pre-open refresh posts a whole edition) therefore covers the refresh it refused, never the evening's
 * build or the next morning's refresh. A run whose document did not arrive always has a page: the refusal's or its own.
 */
export function refusalForSlot(refusal: Read<RefusalRead> | undefined, slotDue: number, nextDue: number): boolean {
  if (refusal?.status !== "ok" || !refusal.value.current || refusal.value.at === null) return false;
  const at = Date.parse(refusal.value.at);
  return Number.isFinite(at) && at >= slotDue && at < nextDue;
}

/**
 * The regular session around `nowMs`, or null outside it: from the exchange calendar, and past the calendar file's end
 * 09:30 to 16:00 New York on a weekday, marked assumed.
 */
export function shadowWindow(nowMs: number): { open: number; close: number; day: string; assumed: boolean } | null {
  const d = nyDayOf(nowMs);
  const b = sessionBounds(d);
  let w: { open: number; close: number; assumed: boolean } | null = b ? { open: b.open, close: b.close, assumed: false } : null;
  if (!w && sessionOf(d).kind === "out_of_range" && isWeekdayDay(d)) {
    const open = nyInstant(d, 9 * 60 + 30);
    const close = nyInstant(d, 16 * 60);
    if (open !== null && close !== null) w = { open, close, assumed: true };
  }
  if (!w || nowMs < w.open || nowMs >= w.close) return null;
  return { ...w, day: d };
}

export function evaluateShadow(f: ShadowFeed, read: Read<ShadowRead> | null, nowMs: number): FeedView {
  const w = shadowWindow(nowMs);
  if (!w && (read?.status === "error" || read?.status === "unreadable")) return nothing(f, "unknown", "storage-error");
  if (!w) return nothing(f, "not_expected", "outside-session");
  const assumed = w.assumed || !f.verified;
  // A day past the calendar file is only taken to be a session: it is not named as one.
  const forDay = w.assumed ? null : w.day;
  if (!read || read.status === "error" || read.status === "unreadable")
    return nothing(f, "unknown", read ? "storage-error" : "not-read", { for_session: forDay, episode: w.assumed ? null : `unknown:${w.day}`, assumed });
  if (read.status === "missing" || !read.value.on) return nothing(f, "not_expected", "switch-off", { for_session: forDay, assumed });
  const v = read.value;
  // The first record is written once the first 2-minute bar has settled; a switch turned on later starts its clock.
  const first = w.open + BAR_MS + SERVER_SETTLE_MS;
  const base = Math.max(first, v.switched_at ?? first);
  if (nowMs < base && v.last_slot_end === null) return nothing(f, "not_expected", "before-first-slot", { for_session: forDay, next_due: base, assumed });
  const lastWrite = v.last_slot_end === null ? null : v.last_slot_end + SERVER_SETTLE_MS;
  const ref = Math.max(base, lastWrite ?? base);
  const deadline = ref + f.grace_min * MIN;
  const age = minutesSince(v.last_slot_end, nowMs);
  const at = { due: ref, deadline, for_session: forDay, age_min: age, assumed };
  if (nowMs <= deadline) return nothing(f, lastWrite === null ? "waiting" : "on_time", lastWrite === null ? "running" : "recording", at);
  return {
    ...nothing(f, "late", "no-record", at),
    late_min: Math.floor((nowMs - deadline) / MIN),
    misses: 1,
    episode: w.day,
    // Past the calendar's end the session is assumed: shown late, never paged.
    alerting: f.severity === "alert" && f.verified && !w.assumed,
  };
}

export function evaluateRefusal(f: RefusalFeed, read: Read<RefusalRead> | undefined, nowMs: number): FeedView {
  if (!read) return nothing(f, "unknown", "not-read");
  if (read.status === "error" || read.status === "unreadable") return nothing(f, "unknown", "storage-error");
  if (read.status === "missing" || read.value.at === null) return nothing(f, "on_time", "no-refusal");
  const at = Date.parse(read.value.at);
  if (!read.value.current) return nothing(f, "on_time", "refusal-replaced", { outcome: read.value.outcome, age_min: minutesSince(at, nowMs) });
  return {
    ...nothing(f, "failed", "refusal-current", { outcome: read.value.outcome, age_min: minutesSince(at, nowMs) }),
    late_min: minutesSince(at, nowMs),
    misses: 1,
    // Each refusal is its own incident: a second one, even the same day, pages again.
    episode: Number.isFinite(at) ? `refusal:${new Date(at).toISOString()}` : null,
    for_session: Number.isFinite(at) ? nyDayOf(at) : null,
    due: Number.isFinite(at) ? at : null,
    alerting: f.severity === "alert" && f.verified,
  };
}

/** Every feed's state at `nowMs`, from the stamps (the pages' path: a browser redraws from these). */
export function evaluateStamped(inputs: StampedInputs, nowMs: number, table: readonly FeedRow[] = FEEDS): FeedView[] {
  return table.map((f) => {
    if (f.type === "doc") return evaluateDoc(f, inputs.stamps[f.id], f.ingest_kind ? inputs.refusals[f.ingest_kind] : undefined, nowMs);
    if (f.type === "shadow") return evaluateShadow(f, inputs.shadow, nowMs);
    return evaluateRefusal(f, inputs.refusals[f.kind], nowMs);
  });
}

// ---- the alert state ------------------------------------------------------------------------------------------------

/** One feed's alert: an incident open since `since` for `episode`, and whether its page was actually sent. */
export interface FeedAlert {
  open: boolean;
  episode: string | null;
  since: string | null;
  /** The page went out (alerts were on). A recovery is only announced for a page that was sent. */
  sent: boolean;
  /** Runs in a row the feed could not be read. */
  unknown_runs: number;
  /** The "cannot be checked" incident, apart from the late one so an outage never replaces (and re-pages) it. */
  unknown_episode: string | null;
  unknown_sent: boolean;
}
export interface FeedAlertState {
  v: 1;
  /** Whether the last run ran with alerts on: the first run with them on after a run with them off sends the summary. */
  alerts: "on" | "off" | null;
  feeds: Record<string, FeedAlert>;
  /** Pages decided and not yet confirmed sent (the two-phase record: see feed-watch-run.ts runFeedWatch). */
  outbox: Outgoing[];
}

/**
 * A page in the outbox. Phase 1 stores it as `pending` together with the decision that made it, and claims each send
 * before it is made (claims + 1, last_tick = this run's tick, claimed_by = this run); phase 2 records the outcome: a
 * page that went leaves the outbox, a failed send counts as a try (tries + 1, tried = that tick).
 *
 * The send rules. A claim that was never followed by a recorded try (its run could not confirm phase 1, or died) does
 * not use up a try: only recorded tries count. Quick tries, one per tick, until OUTBOX_QUICK_TRIES (3) have failed; the
 * page is then `sent_failed` (logged, shown on the Operations page) and still tried once every OUTBOX_SLOW_EVERY_TICKS
 * (30 minutes) until OUTBOX_MAX_AGE_MS (2 hours) after it was decided: 3 quick (0, 10, 20 min) + 3 slow (50, 80,
 * 110 min) = at most 6 recorded tries. Every send follows a stored claim and claims stop at OUTBOX_MAX_CLAIMS (10), so a page is sent at most 10
 * times even if every phase-2 record were lost. A page that reaches its age or the claim cap unsent is marked
 * sent_failed and logged, never dropped silently. Records are kept OUTBOX_KEEP_FAILED_MS (24 hours).
 */
export interface Outgoing {
  /** feed id(s) | episode | kind: one page per incident and kind. */
  key: string;
  feeds: string[];
  notice: Notice;
  /** Claims made for it (each one before a send). */
  attempts: number;
  /** Sends that were made and recorded as failed. */
  tries: number;
  last_tick: number | null;
  /** The tick of the last recorded try, or null. */
  tried: number | null;
  /** The run that made the last claim: two runs that decide alike still tell their own claim from the other's. */
  claimed_by: string | null;
  status: "pending" | "sent_failed";
  /** When it was decided (ISO). */
  since: string;
}

export const OUTBOX_QUICK_TRIES = 3;
/** Kept for the callers that name the quick tries by their old name. */
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_QUICK_TRIES;
export const OUTBOX_SLOW_EVERY_TICKS = 3;
export const OUTBOX_MAX_CLAIMS = 10;
/** Past this age (from its decision) a page is no longer tried: it would no longer be news. */
export const OUTBOX_MAX_AGE_MS = 2 * 3_600_000;
/** Records (sent_failed, or pending while alerts are off) are kept this long. */
export const OUTBOX_KEEP_FAILED_MS = 24 * 3_600_000;

export const FEED_ALERT_INITIAL: FeedAlert = { open: false, episode: null, since: null, sent: false, unknown_runs: 0, unknown_episode: null, unknown_sent: false };
export const EMPTY_FEED_STATE: FeedAlertState = { v: 1, alerts: null, feeds: {}, outbox: [] };

/**
 * Runs in a row a feed must be unreadable before it pages: three, i.e. 20 to 30 minutes at the watchdog's 10-minute
 * cadence. One failed read of the store is common and clears itself; three in a row is an outage worth a page, and it
 * still comes before any routine's grace has run out twice.
 */
export const UNKNOWN_RUNS_TO_ALERT = 3;

/** The id a switch-on summary is filed under in FeedDecision.noticeFeeds. */
export const SUMMARY_ID = "*switch-on-summary*";

const str = (v: unknown) => (typeof v === "string" ? v : null);

export function parseFeedState(text: string | null | undefined): FeedAlertState {
  const empty = (): FeedAlertState => ({ v: 1, alerts: null, feeds: {}, outbox: [] });
  if (!text) return empty();
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw) || !isObj(raw.feeds)) return empty();
    const feeds: Record<string, FeedAlert> = {};
    for (const [id, v] of Object.entries(raw.feeds)) {
      if (!isObj(v)) continue;
      feeds[id] = {
        open: v.open === true,
        episode: str(v.episode),
        since: str(v.since),
        sent: v.sent === true,
        unknown_runs: typeof v.unknown_runs === "number" && Number.isInteger(v.unknown_runs) && v.unknown_runs >= 0 ? v.unknown_runs : 0,
        unknown_episode: str(v.unknown_episode),
        unknown_sent: v.unknown_sent === true,
      };
    }
    const outbox: Outgoing[] = Array.isArray(raw.outbox) ? raw.outbox.flatMap((o) => parseOutgoing(o)) : [];
    return { v: 1, alerts: raw.alerts === "on" || raw.alerts === "off" ? raw.alerts : null, feeds, outbox };
  } catch {
    return empty();
  }
}

const FIELDS = ["open", "episode", "since", "sent", "unknown_runs", "unknown_episode", "unknown_sent"] as const;

/** The state as stored: keys sorted, so two runs that decide alike write the same bytes. */
const NOTICE_KINDS = new Set(["late", "stopped", "recovered", "offline", "feed-late", "feed-recovered", "rejected"]);
function parseOutgoing(o: unknown): Outgoing[] {
  if (!isObj(o) || !isObj(o.notice)) return [];
  const n = o.notice;
  const okNotice =
    typeof n.kind === "string" && NOTICE_KINDS.has(n.kind) && typeof n.title === "string" && typeof n.message === "string" &&
    typeof n.priority === "number" && [1, 2, 3, 4, 5].includes(n.priority) && Array.isArray(n.tags) && n.tags.every((t) => typeof t === "string");
  if (!okNotice || typeof o.key !== "string" || typeof o.since !== "string") return [];
  if (!Array.isArray(o.feeds) || !o.feeds.every((f) => typeof f === "string")) return [];
  if (typeof o.attempts !== "number" || !Number.isInteger(o.attempts) || o.attempts < 0) return [];
  if (o.status !== "pending" && o.status !== "sent_failed") return [];
  const lastTick = typeof o.last_tick === "number" && Number.isInteger(o.last_tick) ? o.last_tick : null;
  const claimedBy = typeof o.claimed_by === "string" ? o.claimed_by : null;
  const tries = typeof o.tries === "number" && Number.isInteger(o.tries) && o.tries >= 0 ? o.tries : 0;
  const tried = typeof o.tried === "number" && Number.isInteger(o.tried) ? o.tried : null;
  return [{ key: o.key, feeds: o.feeds as string[], notice: n as unknown as Notice, attempts: o.attempts, tries, last_tick: lastTick, tried, claimed_by: claimedBy, status: o.status, since: o.since }];
}

/** A page about a feed alone (not the summary), late or refused: what a recovery answers. */
const aboutAlone = (o: Outgoing, id: string) => o.feeds.length === 1 && o.feeds[0] === id && o.notice.kind !== "feed-recovered";

/**
 * The next state's outbox: what was there before (records older than OUTBOX_KEEP_FAILED_MS dropped), plus this run's
 * new pages as pending, one per key. A recovery meets the page it answers:
 *  - never tried at all (no claim yet): neither is news, both are dropped;
 *  - sent_failed (it could not be sent): one combined page goes instead, "was late for N min, now back on time";
 *  - anything else (claimed, maybe delivered): both stay, and the recovery is sent.
 */
export function withOutbox(next: FeedAlertState, decision: FeedDecision, now: Date, table: readonly FeedRow[] = FEEDS): FeedAlertState {
  const t = now.getTime();
  let kept = (next.outbox ?? []).filter((o) => !(t - Date.parse(o.since) > OUTBOX_KEEP_FAILED_MS));
  const keys = new Set(kept.map((o) => o.key));
  const added: Outgoing[] = [];
  decision.notices.forEach((original, i) => {
    let notice = original;
    const id = decision.noticeFeeds[i]!;
    if (notice.kind === "feed-recovered") {
      if (kept.some((o) => aboutAlone(o, id) && o.status === "pending" && o.attempts === 0)) {
        kept = kept.filter((o) => !(aboutAlone(o, id) && o.status === "pending" && o.attempts === 0));
        return;
      }
      const failed = kept.find((o) => aboutAlone(o, id) && o.status === "sent_failed");
      if (failed) {
        kept = kept.filter((o) => o !== failed);
        notice = lateThenBackNotice(id, Math.max(0, Math.floor((t - Date.parse(failed.since)) / MIN)), now, table);
      }
    }
    const feeds = id === SUMMARY_ID ? decision.summaryFeeds : [id];
    const episode = id === SUMMARY_ID ? now.toISOString() : (next.feeds[id]?.episode ?? next.feeds[id]?.unknown_episode ?? now.toISOString());
    const key = `${feeds.join(",")}|${episode}|${notice.kind}`;
    if (keys.has(key)) return;
    keys.add(key);
    added.push({ key, feeds, notice, attempts: 0, tries: 0, last_tick: null, tried: null, claimed_by: null, status: "pending", since: now.toISOString() });
  });
  return { ...next, outbox: [...kept, ...added] };
}

/**
 * The sends this run may make, claimed (see Outgoing for the rules), and the pages given up this run (`gaveUp`: past
 * their age or their claims, never tried successfully), which become sent_failed. Nothing is claimed with alerts off.
 */
export function claimOutbox(
  state: FeedAlertState,
  tick: number,
  alertsOn: boolean,
  runId: string,
  nowMs: number = tick * 600_000,
): { state: FeedAlertState; claimed: string[]; gaveUp: string[] } {
  const claimed: string[] = [];
  const gaveUp: string[] = [];
  const outbox = state.outbox.map((o): Outgoing => {
    if (!alertsOn) return o;
    const old = nowMs - Date.parse(o.since) > OUTBOX_MAX_AGE_MS;
    if (old || o.attempts >= OUTBOX_MAX_CLAIMS) {
      if (o.status === "pending") {
        gaveUp.push(o.key);
        return { ...o, status: "sent_failed" };
      }
      return o;
    }
    // A claim from an earlier tick with no try recorded for it was never sent: it does not count as a try.
    const due = o.tries < OUTBOX_QUICK_TRIES ? o.last_tick === null || o.last_tick < tick : o.tried === null || tick - o.tried >= OUTBOX_SLOW_EVERY_TICKS;
    if (!due || (o.last_tick !== null && o.last_tick >= tick)) return o;
    claimed.push(o.key);
    return { ...o, attempts: o.attempts + 1, last_tick: tick, claimed_by: runId };
  });
  return { state: { ...state, outbox }, claimed, gaveUp };
}

/**
 * After the sends: a page that went leaves the outbox; a failed send is a recorded try, and the third makes the page
 * sent_failed (`failedNow`: the pages that became so here, for the log). Slow tries go on (claimOutbox).
 */
export function settleOutbox(
  state: FeedAlertState,
  results: Readonly<Record<string, "sent" | "skipped" | "failed">>,
): FeedAlertState & { failedNow?: string[] } {
  const failedNow: string[] = [];
  const outbox = state.outbox.flatMap((o) => {
    const r = results[o.key];
    if (r === undefined) return [o];
    if (r !== "failed") return [];
    const tries = o.tries + 1;
    const status = tries >= OUTBOX_QUICK_TRIES ? ("sent_failed" as const) : o.status;
    if (status === "sent_failed" && o.status !== "sent_failed") failedNow.push(o.key);
    return [{ ...o, tries, tried: o.last_tick, status }];
  });
  return { ...state, outbox, failedNow };
}

/** The feeds with a page that could not be sent (sent_failed and still kept): the Operations page says so. */
export function unsentFeeds(state: FeedAlertState): string[] {
  return [...new Set(state.outbox.filter((o) => o.status === "sent_failed").flatMap((o) => o.feeds))];
}

export function serializeFeedState(s: FeedAlertState): string {
  const feeds: Record<string, Partial<FeedAlert>> = {};
  for (const id of Object.keys(s.feeds).sort()) {
    const a = s.feeds[id]!;
    feeds[id] = Object.fromEntries(FIELDS.map((k) => [k, a[k]]));
  }
  const outbox = (s.outbox ?? []).map((o) => ({
    key: o.key,
    feeds: o.feeds,
    notice: { kind: o.notice.kind, title: o.notice.title, message: o.notice.message, priority: o.notice.priority, tags: o.notice.tags },
    attempts: o.attempts,
    tries: o.tries,
    last_tick: o.last_tick,
    tried: o.tried,
    claimed_by: o.claimed_by,
    status: o.status,
    since: o.since,
  }));
  return JSON.stringify({ v: 1, alerts: s.alerts, feeds, outbox });
}

/** Every byte the same (what decides whether a run writes at all). */
export function sameFeedState(a: FeedAlertState, b: FeedAlertState): boolean {
  return serializeFeedState(a) === serializeFeedState(b);
}

/**
 * Whether two decisions page the same: the alert switch and, per feed, what is open and what was sent. The times and
 * counters are left out, so two overlapping runs on clocks a few milliseconds apart see one another's commit as
 * "already handled" and the second sends nothing.
 */
export function sameFeedDecision(a: FeedAlertState, b: FeedAlertState): boolean {
  const key = (s: FeedAlertState) =>
    JSON.stringify([
      s.alerts,
      Object.keys(s.feeds)
        .sort()
        .map((id) => {
          const f = s.feeds[id]!;
          return [id, f.open, f.episode, f.sent, f.unknown_episode, f.unknown_sent];
        })
        .filter((x) => x[1] || x[4] !== null),
    ]);
  return key(a) === key(b);
}

export interface FeedDecision {
  next: FeedAlertState;
  notices: Notice[];
  /** The feed id each notice is for, index for index (SUMMARY_ID for the switch-on summary). */
  noticeFeeds: string[];
  /** The feeds the switch-on summary covered, if one was sent. */
  summaryFeeds: string[];
}

/**
 * The episode logic, mirroring the snapshot watchdog's (watchdog.ts evaluate): one page per feed per incident, one
 * "back on time" when it recovers, nothing repeated run after run, and a new incident only after a recovery or on a
 * new session day (a refusal: a new refusal). An outage of the store ("cannot be checked") is its own incident beside
 * a late one and never re-opens it.
 *
 * The switch-on rule. With alerts off every transition still happens and is stored, marked unsent, and nothing is
 * sent. The stored state says which way the last run ran (`alerts`). On the first run with alerts on after one with
 * them off (or after a state that predates the flag), every incident still open and unsent is listed in ONE summary
 * page, by feed name, and marked sent; from then on each recovers with its own "back on time" page, and each new
 * incident pages on its own. Switching off and on again later does the same: one summary of what opened meanwhile.
 * With nothing open at switch-on, nothing is sent.
 */
export function decideFeedAlerts(views: readonly FeedView[], prev: FeedAlertState, now: Date, alertsOn: boolean, table: readonly FeedRow[] = FEEDS): FeedDecision {
  const next: FeedAlertState = { v: 1, alerts: alertsOn ? "on" : "off", feeds: {}, outbox: prev.outbox ?? [] };
  const notices: Notice[] = [];
  const noticeFeeds: string[] = [];
  const iso = now.toISOString();
  const push = (id: string, n: Notice) => {
    if (!alertsOn) return;
    notices.push(n);
    noticeFeeds.push(id);
  };
  for (const v of views) {
    const p = prev.feeds[v.id] ?? FEED_ALERT_INITIAL;
    const a: FeedAlert = { ...p };
    if (v.state === "unknown") {
      // Unknown is not late: it pages only after UNKNOWN_RUNS_TO_ALERT runs in a row, for a feed that would page,
      // while a run is in force, and once per day. The count stops there, so a long outage writes no new state. A
      // late incident already open stays open, untouched: it is not paged again once the store reads again.
      const eligible = v.severity === "alert" && v.verified && v.episode !== null && v.type !== "refusal";
      a.unknown_runs = eligible ? Math.min(p.unknown_runs + 1, UNKNOWN_RUNS_TO_ALERT) : 0;
      if (eligible && a.unknown_runs >= UNKNOWN_RUNS_TO_ALERT && p.unknown_episode !== v.episode) {
        a.unknown_episode = v.episode;
        a.unknown_sent = alertsOn;
        push(v.id, unreadableNotice(v, a.unknown_runs, now, table));
      }
    } else {
      a.unknown_runs = 0;
      if (v.alerting && v.episode !== null) {
        if (!(p.open && p.episode === v.episode)) {
          a.open = true;
          a.episode = v.episode;
          a.since = iso;
          a.sent = alertsOn;
          push(v.id, v.type === "refusal" ? refusedNotice(v, now, table) : lateNotice(v, now, table));
        }
      } else if (v.state === "on_time" && (p.open || p.unknown_episode !== null)) {
        // One "back on time" for whatever was paged: the late page, the "cannot be checked" page, or both.
        if ((p.open && p.sent) || (p.unknown_episode !== null && p.unknown_sent)) push(v.id, recoveredNotice(v, now, table));
        Object.assign(a, FEED_ALERT_INITIAL);
      }
      // Anything else (waiting, not expected, late but not yet paging, display only) leaves the incident as it is.
    }
    if (a.open || a.unknown_runs > 0 || a.unknown_episode !== null) next.feeds[v.id] = a;
  }

  // The switch-on summary: the first run with alerts on after a run with them off.
  const summaryFeeds: string[] = [];
  if (alertsOn && prev.alerts !== "on") {
    for (const v of views) {
      const a = next.feeds[v.id];
      if (!a) continue;
      const unsent = (a.open && !a.sent) || (a.unknown_episode !== null && !a.unknown_sent);
      if (!unsent) continue;
      summaryFeeds.push(v.id);
      next.feeds[v.id] = { ...a, sent: a.open ? true : a.sent, unknown_sent: a.unknown_episode !== null ? true : a.unknown_sent };
    }
    if (summaryFeeds.length) {
      notices.push(summaryNotice(summaryFeeds, now, table));
      noticeFeeds.push(SUMMARY_ID);
    }
  }
  return { next, notices, noticeFeeds, summaryFeeds };
}

/**
 * The state to store when some pages failed: those feeds go back to how they were, so the next run pages again. A
 * failed summary puts its feeds back to unsent and the switch back to how the last run left it, so the next run sends
 * the summary again.
 */
export function rollbackFeeds(prev: FeedAlertState, next: FeedAlertState, failedIds: readonly string[], summaryFeeds: readonly string[] = []): FeedAlertState {
  const out: FeedAlertState = { v: 1, alerts: next.alerts, feeds: { ...next.feeds }, outbox: next.outbox };
  for (const id of failedIds) {
    if (id === SUMMARY_ID) {
      out.alerts = prev.alerts;
      for (const f of summaryFeeds) {
        const a = out.feeds[f];
        if (a) out.feeds[f] = { ...a, sent: a.open ? false : a.sent, unknown_sent: a.unknown_episode !== null ? false : a.unknown_sent };
      }
      continue;
    }
    const p = prev.feeds[id];
    if (p) out.feeds[id] = p;
    else delete out.feeds[id];
  }
  return out;
}

// ---- the notices ----------------------------------------------------------------------------------------------------
// Every value a page carries comes from a closed set: a feed's name from the table (by id, never the view's own
// text), a date that is a date, whole minutes, New York times worked out here, and fixed words for the reason and the
// outcome. Anything else is left out.

/** Said when the calendar file has run out and a weekday schedule stands in for it (the watchdog's ASSUMED_NOTE pattern). */
/** The Operations panel's line when today (New York) is outside the calendar file: runs on such a day are assumed and
 * never page, so a wrong clock must not silence the feed alerts out of sight. Null inside the file. */
export function calendarNotice(nowMs: number): string | null {
  const day = nyDayOf(nowMs);
  const words = (d: string) => {
    const x = new Date(`${d}T12:00:00Z`);
    return `${x.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][x.getUTCMonth()]} ${x.getUTCFullYear()}`;
  };
  if (day > RANGE.end) return `Today is outside the session calendar (ends ${words(RANGE.end)}): feed alerts for late runs are off.`;
  if (day < RANGE.start) return `Today is outside the session calendar (starts ${words(RANGE.start)}): feed alerts for late runs are off.`;
  return null;
}

export const FEED_ASSUMED_NOTE = " The market calendar has run out, so a weekday schedule is assumed.";

/** HH:MM New York of an instant. */
export function nyHm(t: number): string {
  const at = instant(t);
  return at === null ? "--:--" : hhmm(nyNow(new Date(at)).minute);
}

const nameOf = (id: string, table: readonly FeedRow[]) => table.find((f) => f.id === id)?.name ?? "A feed";
const dayOf = (d: string | null | undefined) => (typeof d === "string" && DAY_RE.test(d) ? d : null);
const whole = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
/** An instant a Date can hold (±8.64e15 ms); anything else is left out rather than thrown on. */
const instant = (t: number | null | undefined) => (typeof t === "number" && Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : null);

const REASON_WORDS: Partial<Record<Reason, string>> = {
  "no-document": "Nothing is stored for it.",
  unreadable: "The stored copy cannot be read.",
  "no-stamp": "The stored copy has no time for this run.",
  "wrong-session": "The stored copy is for an earlier session.",
  "old-stamp": "The stored copy is older than this run.",
  "no-record": "No record was written in that time.",
};

export function lateNotice(v: FeedView, now: Date, table: readonly FeedRow[] = FEEDS): Notice {
  const name = nameOf(v.id, table);
  const late = whole(v.late_min);
  const dl = instant(v.deadline);
  const day = dayOf(v.for_session);
  const runs = whole(v.misses) >= 2 ? ` ${whole(v.misses)} runs in a row were missed.` : "";
  const why = Object.hasOwn(REASON_WORDS, v.reason) ? ` ${REASON_WORDS[v.reason]}` : "";
  const session = day ? `, for the session of ${day}` : v.next_past_end ? ", for the session after it" : "";
  const by = dl !== null ? ` past its ${nyHm(dl)} New York deadline` : " past its deadline";
  const message =
    v.type === "shadow"
      ? `${name} is late: no record for ${SHADOW_GRACE_MIN + late} min${session}. Checked ${nyHm(now.getTime())} New York.${why}`
      : `${name} is late: ${late} min${by}${session}. Checked ${nyHm(now.getTime())} New York.${runs}${why}`;
  return {
    kind: "feed-late",
    title: `${name} late by ${late} min`,
    message: `${message}${v.assumed === true ? FEED_ASSUMED_NOTE : ""}`,
    priority: 4,
    tags: ["warning"],
  };
}

export function unreadableNotice(v: FeedView, runs: number, now: Date, table: readonly FeedRow[] = FEEDS): Notice {
  const name = nameOf(v.id, table);
  const day = dayOf(v.for_session);
  return {
    kind: "feed-late",
    title: `${name} cannot be checked`,
    message: `${name} is unknown: the store could not be read on ${whole(runs)} checks in a row${day ? `, for the session of ${day}` : ""}. Checked ${nyHm(now.getTime())} New York.`,
    priority: 4,
    tags: ["warning"],
  };
}

const OUTCOME_WORDS: Record<NonNullable<RefusalRead["outcome"]>, string> = {
  invalid: "it did not match its format",
  "ahead-of-clock": "its time was ahead of the clock",
};

export function refusedNotice(v: FeedView, now: Date, table: readonly FeedRow[] = FEEDS): Notice {
  const name = nameOf(v.id, table);
  const due = instant(v.due);
  const at = due === null ? "an unknown time" : `${nyHm(due)} New York`;
  const why = v.outcome && Object.hasOwn(OUTCOME_WORDS, v.outcome) ? OUTCOME_WORDS[v.outcome] : "it was not accepted";
  const day = dayOf(v.for_session);
  return {
    kind: "rejected",
    title: `${name} refused`,
    message: `${name} was refused at ${at} because ${why}, and nothing newer is stored${day ? `, on ${day}` : ""}. Checked ${nyHm(now.getTime())} New York.`,
    priority: 4,
    tags: ["no_entry"],
  };
}

export function recoveredNotice(v: FeedView, now: Date, table: readonly FeedRow[] = FEEDS): Notice {
  const name = nameOf(v.id, table);
  const age = v.age_min === null || !Number.isFinite(v.age_min) ? "" : ` (${whole(v.age_min)} min old)`;
  const what = v.type === "refusal" ? "a good copy is stored again" : `it is on time${age}`;
  const day = dayOf(v.for_session);
  return {
    kind: "feed-recovered",
    title: `${name} back on time`,
    message: `${name} recovered: ${what}${day ? `, for the session of ${day}` : ""}. Checked ${nyHm(now.getTime())} New York. The earlier alert is cleared.`,
    priority: 2,
    tags: ["white_check_mark"],
  };
}

/** A recovery whose late page could not be sent: what happened, in one page. */
export function lateThenBackNotice(id: string, lateMin: number, now: Date, table: readonly FeedRow[] = FEEDS): Notice {
  const name = nameOf(id, table);
  return {
    kind: "feed-recovered",
    title: `${name} was late, now back on time`,
    message: `${name} was late for ${whole(lateMin)} min and is back on time. The page about it could not be sent. Checked ${nyHm(now.getTime())} New York.`,
    priority: 3,
    tags: ["white_check_mark"],
  };
}

/** The one page at switch-on: how many incidents are already under way, by feed name (each name once). */
export function summaryNotice(ids: readonly string[], now: Date, table: readonly FeedRow[] = FEEDS): Notice {
  const names = [...new Set(ids.map((id) => nameOf(id, table)))];
  return {
    kind: "feed-late",
    title: `Feed alerts on: ${names.length} not on time`,
    message: `Feed alerts are on. Already late, refused or not checkable: ${names.join(", ")}. Each sends its own page when it is back on time. Checked ${nyHm(now.getTime())} New York.`,
    priority: 4,
    tags: ["warning"],
  };
}

// ---- the pages' words -----------------------------------------------------------------------------------------------

export const STATE_WORD: Record<FeedStateName, string> = {
  on_time: "On time",
  waiting: "Waiting",
  late: "Late",
  failed: "Failed",
  not_expected: "Not due",
  unknown: "Can't check",
};

/** A view's age in a few characters for a chip: "now", "12m", "5h", "3d", or "—". */
export function chipAge(ageMin: number | null): string {
  if (ageMin === null) return "—";
  if (ageMin < 1) return "now";
  if (ageMin < 60) return `${ageMin}m`;
  if (ageMin < 48 * 60) return `${Math.floor(ageMin / 60)}h`;
  return `${Math.floor(ageMin / 1440)}d`;
}

/** The worst of several views (for a card that covers two runs): failed, late, unknown, waiting, on time, not due. */
export function worstOf(views: readonly FeedView[]): FeedView | null {
  const rank: Record<FeedStateName, number> = { failed: 5, late: 4, unknown: 3, waiting: 2, on_time: 1, not_expected: 0 };
  return views.reduce<FeedView | null>((w, v) => (w === null || rank[v.state] > rank[w.state] ? v : w), null);
}

// ---- the browser's own feeds ----------------------------------------------------------------------------------------

/** A feed the Options page polls itself: the 2-second prices (use-quotes.ts) and the session bars (use-bars.ts). */
export interface PolledRead {
  status: "loading" | "off" | "error" | "ok";
  /** When the browser got the last good answer (ms, the browser's clock), or null. */
  receivedAt: number | null;
  /** The latest poll failed and the last good answer is kept for its age only. */
  failed?: boolean;
  /** The page is trying again after a failure (the retry line is up), or the board has paused on the prices. */
  failing?: boolean;
}

/**
 * A polled feed's state for the strip, on the same words as the server's feeds: not due outside the regular session
 * (the exchange calendar's, `serverNow` on the board's clock), waiting until the first answer, failed when it is
 * failing (or off, for the prices), late once its last good answer is older than `staleMs` (the board's own rule: prices STALE_MS, bars
 * BARS_STALE_MS), on time otherwise. Missing data is never on time.
 */
export function polledState(
  r: PolledRead,
  browserNow: number | null,
  serverNow: number,
  staleMs: number,
  /** What "off" means: the prices' keys are not set (failed); the bars are simply not asked for (not due). */
  offState: "failed" | "not_expected",
): { state: FeedStateName; age_s: number | null } {
  const age_s = r.status === "ok" && r.receivedAt !== null && browserNow !== null ? Math.max(0, Math.floor((browserNow - r.receivedAt) / 1000)) : null;
  // A failure always wins over "not due": whatever the clock says, a feed that is failing, being retried, paused on or
  // off for want of keys is shown so. Only then does the session decide whether a quiet feed is expected at all.
  if (r.failing || (r.status === "ok" && r.failed)) return { state: "late", age_s };
  if (r.status === "error") return { state: "failed", age_s };
  if (r.status === "off" && offState === "failed") return { state: "failed", age_s };
  if (shadowWindow(serverNow) === null) return { state: "not_expected", age_s };
  if (r.status === "loading") return { state: "waiting", age_s };
  if (r.status === "off") return { state: offState, age_s };
  if (age_s === null || age_s * 1000 > staleMs) return { state: "late", age_s };
  return { state: "on_time", age_s };
}

/**
 * The journal's state as a page shows it: the board's own day check (trade-rules.ts journalCurrent, read only), so the
 * strip and the day check can never give two answers. On time exactly when journalCurrent says the journal is
 * current; otherwise the feed watch's word (late, waiting, unknown...), and never "on time". The two-missed-runs rule
 * is for the alert alone (decideFeedAlerts).
 */
export function journalShown(v: FeedView, read: StampRead | undefined, nowMs: number): FeedStateName {
  if (v.state === "unknown") return "unknown";
  const at = read?.status === "ok" ? read.value.at : null;
  const current = at !== null && journalCurrent(new Date(at).toISOString(), new Date(nowMs));
  if (current) return "on_time";
  return v.state === "on_time" ? "late" : v.state;
}

/** The feed watch's own outage page (feed-watch-run.ts storeNoticeTick): plain words, nothing from any feed. */
export function storeNotice(now: Date): Notice {
  return {
    kind: "feed-late",
    title: "Feed watch cannot read its store",
    message: `Feed watch cannot read or write its own state, so it sends no feed alerts until the store answers. Checked ${nyHm(now.getTime())} New York.`,
    priority: 4,
    tags: ["warning"],
  };
}
