// The feed watch: one table of every document a cloud routine (or the desk's own cron) must publish, when it is due,
// how to tell which session a stored document is for, and what to do when it does not arrive. The Operations page's
// "Your feeds" panel, the Options page's health strip and the watchdog's feed alerts all read this table and this
// evaluator, so the pages and the alerts cannot disagree.
//
// Pure: no I/O, the clock is passed in. Every New York time goes through the exchange calendar (market-calendar.ts)
// and nyInstant, never a fixed offset: weekends, holidays and half days come from the session list, "the next
// session" is the next day the market opens, and both clock changes are right for New York and UTC schedules alike.
// Outside the calendar file's range a weekday schedule is assumed and every result says so.
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
import { addDays, nyNow, sessionOf } from "./market-calendar";
import type { Notice } from "./ntfy";
import { nyInstant } from "./options";
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

/** The pre-open refresh runs at 08:50 New York; its prices must be in by 09:05. */
export const PREOPEN_NY = "08:50";
export const PREOPEN_GRACE_MIN = 15;
/** The shadow evaluator: late after this long in the session with no record. */
export const SHADOW_GRACE_MIN = 10;

/**
 * Every feed watched. A new feed is one more row: the runner reads each row's `path`, the pages draw each row, and
 * the evaluator needs nothing else.
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
      { zone: "UTC", times: [hhmm(JOURNAL_SLOT_UTC)], grace_min: DAILY_GRACE_MIN, early_min: 60 },
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
  { type: "refusal", id: "refusal-options", name: "Options edition", short: "Levels", kind: "options", severity: "alert", verified: true },
  { type: "refusal", id: "refusal-journal", name: "Trade journal", short: "Journal", kind: "journal", severity: "alert", verified: true },
  { type: "refusal", id: "refusal-radar", name: "Radar edition", short: "Radar", kind: "radar", severity: "alert", verified: true },
  { type: "refusal", id: "refusal-ledger", name: "Card ledger", short: "Ledger", kind: "ledger", severity: "display", verified: true },
  { type: "refusal", id: "refusal-options-live", name: "Options live data", short: "Live data", kind: "options-live", severity: "display", verified: true },
  { type: "refusal", id: "refusal-options-clone", name: "Options clone", short: "Clone", kind: "options-clone", severity: "display", verified: true },
  { type: "refusal", id: "refusal-calendar", name: "Economic calendar", short: "Calendar", kind: "calendar", severity: "display", verified: true },
];

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
  /** The session the document must be for (next-session: the day after; otherwise the run's day). */
  for_session: string;
  schedule: Schedule;
  /** The calendar ran out for this run: its day was taken to be a market day because it is a weekday. */
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
        let assumed = m.assumed;
        if (s.in_session) {
          const close = closeOf(sday);
          if (close === null || due >= close) continue;
        }
        let forSession = sday;
        if (feed.want === "next-session") {
          const n = adjacentSession(sday, 1);
          forSession = n.day;
          assumed ||= n.assumed;
        }
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
      return stamp.session !== null && stamp.session >= slot.for_session;
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
  if (ci < 0) return nothing(f, "not_expected", "no-run-now", { age_min: age, next_due: nextDue });
  const cur = slots[ci]!;
  const at = { due: cur.due, deadline: cur.deadline, for_session: cur.for_session, next_due: nextDue, age_min: age };
  const assumed = !f.verified || cur.assumed;
  if (!read) return nothing(f, "unknown", "not-read", { ...at, assumed, episode: `unknown:${cur.day}` });
  if (read.status === "error") return nothing(f, "unknown", "storage-error", { ...at, assumed, episode: `unknown:${cur.day}` });

  // Runs missed in a row, newest first, while each one hands over straight to the next (a run that lapses at the
  // close, like the pre-open refresh, does not carry yesterday's miss into today).
  let misses = 0;
  let firstMissedDeadline: number | null = null;
  let latestMissedDay: string | null = null;
  for (let i = ci; i >= 0; i--) {
    const s = slots[i]!;
    if (i < ci && s.expires < slots[i + 1]!.due) break;
    if (satisfies(f, stamp, s)) break;
    if (nowMs > s.deadline) {
      misses++;
      firstMissedDeadline = s.deadline;
      latestMissedDay ??= s.day;
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
  const refused = refusal?.status === "ok" && refusal.value.current;
  const state: FeedStateName = refused ? "failed" : "late";
  const lateMin = firstMissedDeadline === null ? null : Math.max(0, Math.floor((nowMs - firstMissedDeadline) / MIN));
  // A refusal that still stands pages on its own row (refusal-*): this row stays quiet until it is replaced, so one
  // incident pages once.
  // Outside the calendar's range a weekday schedule stands in and still pages, saying so; an unverified row never does.
  const alerting = !refused && f.severity === "alert" && f.verified && misses >= f.misses_to_alert;
  return {
    ...nothing(f, state, refused ? "refused" : why, at),
    late_min: lateMin,
    misses,
    episode: latestMissedDay,
    assumed,
    alerting,
  };
}

/** Whether the shadow evaluator is expected to be logging at `nowMs`: inside the regular session of a market day. */
export function shadowWindow(nowMs: number): { open: number; close: number; day: string } | null {
  const d = nyDayOf(nowMs);
  const b = sessionBounds(d);
  if (!b || nowMs < b.open || nowMs >= b.close) return null;
  return { open: b.open, close: b.close, day: d };
}

export function evaluateShadow(f: ShadowFeed, read: Read<ShadowRead> | null, nowMs: number): FeedView {
  const w = shadowWindow(nowMs);
  if (!w) return nothing(f, "not_expected", "outside-session");
  if (!read || read.status === "error" || read.status === "unreadable")
    return nothing(f, "unknown", read ? "storage-error" : "not-read", { for_session: w.day, episode: `unknown:${w.day}` });
  if (read.status === "missing" || !read.value.on) return nothing(f, "not_expected", "switch-off", { for_session: w.day });
  const v = read.value;
  // The first record is written once the first 2-minute bar has settled; a switch turned on later starts its clock.
  const first = w.open + BAR_MS + SERVER_SETTLE_MS;
  const base = Math.max(first, v.switched_at ?? first);
  if (nowMs < base && v.last_slot_end === null) return nothing(f, "not_expected", "before-first-slot", { for_session: w.day, next_due: base });
  const lastWrite = v.last_slot_end === null ? null : v.last_slot_end + SERVER_SETTLE_MS;
  const ref = Math.max(base, lastWrite ?? base);
  const deadline = ref + f.grace_min * MIN;
  const age = minutesSince(v.last_slot_end, nowMs);
  const at = { due: ref, deadline, for_session: w.day, age_min: age };
  if (nowMs <= deadline) return nothing(f, lastWrite === null ? "waiting" : "on_time", lastWrite === null ? "running" : "recording", at);
  return {
    ...nothing(f, "late", "no-record", at),
    late_min: Math.floor((nowMs - deadline) / MIN),
    misses: 1,
    episode: w.day,
    alerting: f.severity === "alert" && f.verified,
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
    episode: Number.isFinite(at) ? nyDayOf(at) : null,
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
}
export interface FeedAlertState {
  v: 1;
  feeds: Record<string, FeedAlert>;
}

export const FEED_ALERT_INITIAL: FeedAlert = { open: false, episode: null, since: null, sent: false, unknown_runs: 0 };
export const EMPTY_FEED_STATE: FeedAlertState = { v: 1, feeds: {} };

/**
 * Runs in a row a feed must be unreadable before it pages: three, i.e. 20 to 30 minutes at the watchdog's 10-minute
 * cadence. One failed read of the store is common and clears itself; three in a row is an outage worth a page, and it
 * still comes before any routine's grace has run out twice.
 */
export const UNKNOWN_RUNS_TO_ALERT = 3;

export function parseFeedState(text: string | null | undefined): FeedAlertState {
  if (!text) return { v: 1, feeds: {} };
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw) || !isObj(raw.feeds)) return { v: 1, feeds: {} };
    const feeds: Record<string, FeedAlert> = {};
    for (const [id, v] of Object.entries(raw.feeds)) {
      if (!isObj(v)) continue;
      feeds[id] = {
        open: v.open === true,
        episode: typeof v.episode === "string" ? v.episode : null,
        since: typeof v.since === "string" ? v.since : null,
        sent: v.sent === true,
        unknown_runs: typeof v.unknown_runs === "number" && Number.isInteger(v.unknown_runs) && v.unknown_runs >= 0 ? v.unknown_runs : 0,
      };
    }
    return { v: 1, feeds };
  } catch {
    return { v: 1, feeds: {} };
  }
}

/** The state as stored: feeds in table order, keys sorted, so two runs that decide alike write the same bytes. */
export function serializeFeedState(s: FeedAlertState): string {
  const feeds: Record<string, FeedAlert> = {};
  for (const id of Object.keys(s.feeds).sort()) {
    const a = s.feeds[id]!;
    feeds[id] = { open: a.open, episode: a.episode, since: a.since, sent: a.sent, unknown_runs: a.unknown_runs };
  }
  return JSON.stringify({ v: 1, feeds });
}

export function sameFeedState(a: FeedAlertState, b: FeedAlertState): boolean {
  return serializeFeedState(a) === serializeFeedState(b);
}

export interface FeedDecision {
  next: FeedAlertState;
  notices: Notice[];
  /** The feed id each notice is for, index for index: a page that fails puts that feed's state back. */
  noticeFeeds: string[];
}

/**
 * The episode logic, mirroring the snapshot watchdog's (watchdog.ts evaluate): one page per feed per incident, one
 * "back on time" when it recovers, nothing repeated run after run, and a new incident only after a recovery or on a
 * new session day. With alerts off (`alertsOn` false) every transition still happens and is stored, but nothing is
 * sent and the incident is marked unsent: switching alerts on later never pages an incident already under way, and
 * never announces the recovery of a page nobody received. The first page after switch-on is the next new incident.
 */
export function decideFeedAlerts(views: readonly FeedView[], prev: FeedAlertState, now: Date, alertsOn: boolean): FeedDecision {
  const next: FeedAlertState = { v: 1, feeds: {} };
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
      // while a run is in force, and once per day. The count stops there, so a long outage writes no new state.
      const eligible = v.severity === "alert" && v.verified && v.episode !== null && v.type !== "refusal";
      a.unknown_runs = eligible ? Math.min(p.unknown_runs + 1, UNKNOWN_RUNS_TO_ALERT) : 0;
      if (eligible && a.unknown_runs >= UNKNOWN_RUNS_TO_ALERT && !(p.open && p.episode === v.episode)) {
        a.open = true;
        a.episode = v.episode;
        a.since = iso;
        a.sent = alertsOn;
        push(v.id, unreadableNotice(v, a.unknown_runs, now));
      }
    } else {
      a.unknown_runs = 0;
      if (v.alerting && v.episode !== null) {
        if (!(p.open && p.episode === v.episode)) {
          a.open = true;
          a.episode = v.episode;
          a.since = iso;
          a.sent = alertsOn;
          push(v.id, v.type === "refusal" ? refusedNotice(v, now) : lateNotice(v, now));
        }
      } else if (v.state === "on_time" && p.open) {
        if (p.sent) push(v.id, recoveredNotice(v, now));
        a.open = false;
        a.episode = null;
        a.since = null;
        a.sent = false;
      }
      // Anything else (waiting, not expected, late but not yet paging, display only) leaves the incident as it is.
    }
    if (a.open || a.unknown_runs > 0) next.feeds[v.id] = a;
  }
  return { next, notices, noticeFeeds };
}

/** The state to store when some pages failed: those feeds go back to how they were, so the next run pages again. */
export function rollbackFeeds(prev: FeedAlertState, next: FeedAlertState, failedIds: readonly string[]): FeedAlertState {
  const out: FeedAlertState = { v: 1, feeds: { ...next.feeds } };
  for (const id of failedIds) {
    const p = prev.feeds[id];
    if (p) out.feeds[id] = p;
    else delete out.feeds[id];
  }
  return out;
}

// ---- the notices ----------------------------------------------------------------------------------------------------

/** Said when the calendar file has run out and a weekday schedule stands in for it (the watchdog's ASSUMED_NOTE pattern). */
export const FEED_ASSUMED_NOTE = " The market calendar has run out, so a weekday schedule is assumed.";

/** HH:MM New York of an instant. */
export function nyHm(t: number): string {
  return hhmm(nyNow(new Date(t)).minute);
}

const REASON_WORDS: Partial<Record<Reason, string>> = {
  "no-document": "Nothing is stored for it.",
  unreadable: "The stored copy cannot be read.",
  "no-stamp": "The stored copy has no time for this run.",
  "wrong-session": "The stored copy is for an earlier session.",
  "old-stamp": "The stored copy is older than this run.",
  "no-record": "No record was written in that time.",
};

export function lateNotice(v: FeedView, now: Date): Notice {
  const late = v.late_min ?? 0;
  const deadline = v.deadline === null ? null : nyHm(v.deadline);
  const runs = v.misses >= 2 ? ` ${v.misses} runs in a row were missed.` : "";
  const why = REASON_WORDS[v.reason] ? ` ${REASON_WORDS[v.reason]}` : "";
  const session = v.for_session ? `, for the session of ${v.for_session}` : "";
  const by = deadline ? ` past its ${deadline} New York deadline` : " past its deadline";
  const message =
    v.type === "shadow"
      ? `${v.name} is late: no record for ${SHADOW_GRACE_MIN + late} min${session}. Checked ${nyHm(now.getTime())} New York.${why}`
      : `${v.name} is late: ${late} min${by}${session}. Checked ${nyHm(now.getTime())} New York.${runs}${why}`;
  return {
    kind: "feed-late",
    title: `${v.name} late by ${late} min`,
    message: `${message}${v.assumed ? FEED_ASSUMED_NOTE : ""}`,
    priority: 4,
    tags: ["warning"],
  };
}

export function unreadableNotice(v: FeedView, runs: number, now: Date): Notice {
  return {
    kind: "feed-late",
    title: `${v.name} cannot be checked`,
    message: `${v.name} is unknown: the store could not be read on ${runs} checks in a row${v.for_session ? `, for the session of ${v.for_session}` : ""}. Checked ${nyHm(now.getTime())} New York.`,
    priority: 4,
    tags: ["warning"],
  };
}

const OUTCOME_WORDS: Record<NonNullable<RefusalRead["outcome"]>, string> = {
  invalid: "it did not match its format",
  "ahead-of-clock": "its time was ahead of the clock",
};

export function refusedNotice(v: FeedView, now: Date): Notice {
  const at = v.due === null ? "an unknown time" : `${nyHm(v.due)} New York`;
  const why = v.outcome ? OUTCOME_WORDS[v.outcome] : "it was not accepted";
  return {
    kind: "rejected",
    title: `${v.name} refused`,
    message: `${v.name} was refused at ${at} because ${why}, and nothing newer is stored${v.for_session ? `, on ${v.for_session}` : ""}. Checked ${nyHm(now.getTime())} New York.`,
    priority: 4,
    tags: ["no_entry"],
  };
}

export function recoveredNotice(v: FeedView, now: Date): Notice {
  const age = v.age_min === null ? "" : ` (${v.age_min} min old)`;
  const what = v.type === "refusal" ? "a good copy is stored again" : `it is on time${age}`;
  const session = v.for_session ? `, for the session of ${v.for_session}` : "";
  return {
    kind: "feed-recovered",
    title: `${v.name} back on time`,
    message: `${v.name} recovered: ${what}${session}. Checked ${nyHm(now.getTime())} New York. The earlier alert is cleared.`,
    priority: 2,
    tags: ["white_check_mark"],
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
  if (shadowWindow(serverNow) === null) return { state: "not_expected", age_s };
  if (r.status === "loading") return { state: "waiting", age_s };
  if (r.status === "off") return { state: offState, age_s };
  if (r.status === "error") return { state: "failed", age_s };
  if (r.failed || age_s === null || age_s * 1000 > staleMs) return { state: "late", age_s };
  return { state: "on_time", age_s };
}
