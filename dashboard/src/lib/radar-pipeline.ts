// The Radar pipeline: for one session, the stages of the morning's run, when each was due, when it happened and who
// did it. Pure: no I/O, the clock is passed in. The loader (radar-pipeline-run.ts) gathers what the store holds into
// one observation per session; everything a page draws is worked out here from an observation and the time, on the
// server, in the browser as the clock moves, and in the tests, by the same code.
//
// What is kept is what was seen, never a verdict: times, a trigger, closed codes and counts (SAFE class; no symbol,
// no price, nothing of an edition's content). A stage nothing was seen for says so ("no record"); it is never
// filled in from the schedule. Session days and deadlines come from the exchange calendar and the feed watch's own
// rows (feed-watch.ts), so a US holiday is "no session" and this page, Operations and the alerts agree.
import { adjacentSession, type DocFeed, feedById, marketDay, slotsAround } from "./feed-watch";
import { nyNow } from "./market-calendar";
import { nyInstant } from "./options";
import {
  BUILD_NY,
  BUILD_QUIET_MIN,
  CARD_NY,
  LEVELS_NY,
  OPEN_NY_MIN,
  PIPELINE_SESSIONS,
  PIPELINE_STALE_MIN,
  PREOPEN_NY_MIN,
  SEND_NY,
  STAGE_GRACE_MIN,
  STORED_NY,
} from "./radar-pipeline-slots";

const MIN = 60_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- what was seen --------------------------------------------------------------------------------------------------

export type Trigger = "scheduled" | "catch-up" | "manual";
export type Who = Trigger | "unknown";
export const BEACON_STAGES = ["build", "send", "evidence", "desk"] as const;
export type BeaconStage = (typeof BEACON_STAGES)[number];

/** The newest run beacon of one stage (stocksdelta/radar-run), cut down to what the page reads. */
export interface BeaconObs {
  state: "started" | "finished" | "failed" | "skipped";
  trigger: Trigger;
  started_at: string;
  ended_at: string | null;
  /** The beacon's closed reason code, or null. */
  reason: string | null;
}

/** One stage of the selection funnel's health document: statuses and counts only. */
export interface FunnelStageObs {
  evidence: "present" | "missing" | "broken";
  /** When the stage's evidence was kept. */
  kept_at: string | null;
  judged: number | null;
  kept: number | null;
  /** How many names carried a record flag, over every flag. */
  flagged: number;
  replay: "match" | "mismatch" | "not_run";
}
export interface FunnelObs {
  radar: FunnelStageObs | null;
  focus: FunnelStageObs | null;
}

/** Everything seen for one session. Every time is ISO, or null when nothing was seen. */
export interface SessionObs {
  session: string;
  /** The options edition built for the session was first stored. */
  levels_at: string | null;
  beacons: Partial<Record<BeaconStage, BeaconObs>>;
  /** The session's radar edition was first received by the store. */
  stored_at: string | null;
  /** A radar edition for the session is on file (its receipt time may still be unknown). */
  edition_on_file: boolean;
  /** The ingest refused a radar edition on the session's day and nothing has been stored since. */
  refused_at: string | null;
  /** The session's desk file was stamped. */
  desk_at: string | null;
  /** The session's pre-open prices were stamped. */
  preopen_at: string | null;
  /** The ledger's morning document was stamped. */
  card_at: string | null;
  funnel: FunnelObs | null;
  /**
   * Some look at the session read everything it asked for. False while every look so far had a read that failed: what
   * is missing may then be there unseen, so the session is looked at again and is never said to have missed.
   */
  complete: boolean;
}

export interface PipelineFile {
  v: 1;
  generated_at: string;
  /** Oldest first. */
  sessions: SessionObs[];
}

export function emptyObs(session: string): SessionObs {
  return { session, levels_at: null, beacons: {}, stored_at: null, edition_on_file: false, refused_at: null, desk_at: null, preopen_at: null, card_at: null, funnel: null, complete: true };
}

// ---- reading, defensively -------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
/** A time as it is kept: ISO with Z, or null when `v` is not a time. */
const iso = (v: unknown): string | null => {
  const t = ms(v);
  return t === null ? null : new Date(t).toISOString();
};
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | null => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);
const nyDayOf = (t: number): string => nyNow(new Date(t)).day;

const TRIGGERS = ["scheduled", "catch-up", "manual"] as const;
const BEACON_STATES = ["started", "finished", "failed", "skipped"] as const;
const REASONS = ["no-session", "already-stored", "tools-missing", "blocked", "not-stored", "late-start", "lock-held", "ok"] as const;

function parseBeacon(v: unknown): BeaconObs | null {
  if (!isObj(v)) return null;
  const state = oneOf(v.state, BEACON_STATES);
  const trigger = oneOf(v.trigger, TRIGGERS);
  const started = iso(v.started_at);
  if (!state || !trigger || !started) return null;
  return { state, trigger, started_at: started, ended_at: iso(v.ended_at), reason: oneOf(v.reason, REASONS) };
}

/** A run beacon as the page reads it, or null when `doc` is not one for `session` and `stage`. */
export function beaconObs(doc: unknown, session: string, stage: BeaconStage): BeaconObs | null {
  return isObj(doc) && doc.session === session && doc.stage === stage ? parseBeacon(doc) : null;
}

const COPY_RE = /\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[^/]+\.json$/;
/**
 * When the store first received an edition for `session`, from the paths of its copies (edition-copy.ts:
 * `<prefix><session>/<receipt, compact UTC>-<run>.json`; a lost marker ends `.lost.json` and counts, it was received
 * too). The receipt time is the store's own, never the edition's stamp. Null when no path is a copy of the session.
 */
export function firstReceipt(paths: readonly string[], prefix: string, session: string): string | null {
  let first: number | null = null;
  for (const p of paths) {
    if (!p.startsWith(`${prefix}${session}/`)) continue;
    const m = COPY_RE.exec(p);
    if (!m) continue;
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    if (Number.isFinite(t) && (first === null || t < first)) first = t;
  }
  return first === null ? null : new Date(first).toISOString();
}

/** A document's `as_of` when its `session` is `session`. */
export function sessionDocAt(doc: unknown, session: string): string | null {
  return isObj(doc) && doc.session === session ? iso(doc.as_of) : null;
}

/** A document's `as_of` when it was stamped on the New York day `session`, before `beforeNy` (minutes after midnight). */
export function stampedOn(doc: unknown, session: string, beforeNy = 24 * 60): string | null {
  const t = isObj(doc) ? ms(doc.as_of) : null;
  if (t === null) return null;
  const ny = nyNow(new Date(t));
  return ny.day === session && ny.minute < beforeNy ? new Date(t).toISOString() : null;
}

/** The options edition's own stamp when it was built before its session's day: the evening build, not a later refresh. */
export function levelsStamp(doc: unknown, session: string): string | null {
  if (!isObj(doc) || doc.session !== session) return null;
  const t = ms(doc.as_of);
  return t !== null && nyDayOf(t) < session ? new Date(t).toISOString() : null;
}

const EVIDENCE = ["present", "missing", "broken"] as const;
const REPLAY = ["match", "mismatch", "not_run"] as const;
function funnelStage(v: unknown): FunnelStageObs | null {
  if (!isObj(v)) return null;
  const evidence = oneOf(v.evidence, EVIDENCE);
  if (!evidence) return null;
  const flags = Array.isArray(v.flags) ? v.flags : [];
  const flagged = flags.reduce<number>((n, f) => n + (isObj(f) ? (count(f.names) ?? 0) : 0), 0);
  // The document's own key for the time is read here and nowhere else.
  return { evidence, kept_at: iso(v["sealed_at"]), judged: count(v.names_judged), kept: count(v.names_kept), flagged, replay: oneOf(v.replay, REPLAY) ?? "not_run" };
}
/** The funnel's health document for `session` as the page reads it: statuses and counts. Null when it is not one. */
export function funnelObs(doc: unknown, session: string): FunnelObs | null {
  if (!isObj(doc) || doc.session !== session || !Array.isArray(doc.stages)) return null;
  const stages: unknown[] = doc.stages;
  const stage = (name: string) => funnelStage(stages.find((s) => isObj(s) && s.stage === name));
  const out = { radar: stage("radar"), focus: stage("focus_pick") };
  return out.radar || out.focus ? out : null;
}

function parseFunnelStage(v: unknown): FunnelStageObs | null {
  if (!isObj(v)) return null;
  const evidence = oneOf(v.evidence, EVIDENCE);
  if (!evidence) return null;
  return { evidence, kept_at: iso(v.kept_at), judged: count(v.judged), kept: count(v.kept), flagged: count(v.flagged) ?? 0, replay: oneOf(v.replay, REPLAY) ?? "not_run" };
}
function parseObs(v: unknown): SessionObs | null {
  if (!isObj(v) || typeof v.session !== "string" || !DAY_RE.test(v.session)) return null;
  const beacons: SessionObs["beacons"] = {};
  if (isObj(v.beacons)) {
    for (const s of BEACON_STAGES) {
      const b = parseBeacon(v.beacons[s]);
      if (b) beacons[s] = b;
    }
  }
  const funnel = isObj(v.funnel) ? { radar: parseFunnelStage(v.funnel.radar), focus: parseFunnelStage(v.funnel.focus) } : null;
  return {
    session: v.session,
    levels_at: iso(v.levels_at),
    beacons,
    stored_at: iso(v.stored_at),
    edition_on_file: v.edition_on_file === true,
    refused_at: iso(v.refused_at),
    desk_at: iso(v.desk_at),
    preopen_at: iso(v.preopen_at),
    card_at: iso(v.card_at),
    funnel: funnel && (funnel.radar || funnel.focus) ? funnel : null,
    complete: v.complete === true,
  };
}

/**
 * The summary in `text`, or null when it is not one. Every field is read on its own: a field that is not what it
 * should be is dropped (that time reads "no record"), a session that cannot be read is left out, and the rest stands.
 */
export function parsePipelineFile(text: string | null | undefined): PipelineFile | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.sessions)) return null;
  const generated = iso(v.generated_at);
  if (!generated) return null;
  const seen = new Set<string>();
  const sessions: SessionObs[] = [];
  for (const raw of v.sessions.slice(0, 200)) {
    const o = parseObs(raw);
    if (!o || seen.has(o.session)) continue;
    seen.add(o.session);
    sessions.push(o);
  }
  sessions.sort((a, b) => (a.session < b.session ? -1 : 1));
  return { v: 1, generated_at: generated, sessions };
}

export function serializePipelineFile(f: PipelineFile): string {
  return JSON.stringify(f);
}

/**
 * What is kept after a new look at a session. A time, once seen, stays: the documents it was read from are replaced
 * later in the day (the ledger's and the options edition's latest), so the first sighting is the only one. Beacons
 * are the newest read, kept when this look could not read them; a refusal is as this look found it; the funnel's
 * document is the newest read.
 */
export function mergeObs(prev: SessionObs | null, next: SessionObs, read: { beacons: boolean; refusal: boolean } = { beacons: true, refusal: true }): SessionObs {
  if (!prev) return next;
  return {
    session: next.session,
    levels_at: prev.levels_at ?? next.levels_at,
    beacons: read.beacons ? { ...prev.beacons, ...next.beacons } : prev.beacons,
    stored_at: prev.stored_at ?? next.stored_at,
    edition_on_file: prev.edition_on_file || next.edition_on_file,
    refused_at: read.refusal ? next.refused_at : prev.refused_at,
    desk_at: prev.desk_at ?? next.desk_at,
    preopen_at: prev.preopen_at ?? next.preopen_at,
    card_at: prev.card_at ?? next.card_at,
    funnel: next.funnel ?? prev.funnel,
    complete: prev.complete || next.complete,
  };
}

// ---- the calendar and the schedule ----------------------------------------------------------------------------------

export interface PipelineDays {
  /** New York's day at the time asked about. */
  ny_day: string;
  /** Whether the market opens on it. */
  today_is_session: boolean;
  /** The session in view: today when the market opens today, otherwise the next session. */
  focus: string;
  /** The session before the one in view. */
  previous: string;
  /** The sessions the summary keeps, oldest first: PIPELINE_SESSIONS before the one in view, then it. */
  sessions: string[];
}

export function pipelineDays(nowMs: number, back: number = PIPELINE_SESSIONS): PipelineDays {
  const nyDay = nyDayOf(nowMs);
  const todayIsSession = marketDay(nyDay).open;
  const focus = todayIsSession ? nyDay : adjacentSession(nyDay, 1).day;
  const sessions = [focus];
  for (let i = 0; i < back; i++) sessions.unshift(adjacentSession(sessions[0]!, -1).day);
  return { ny_day: nyDay, today_is_session: todayIsSession, focus, previous: sessions[sessions.length - 2] ?? adjacentSession(focus, -1).day, sessions };
}

export const STAGE_KEYS = ["levels", "build", "stored", "evidence", "preopen", "card", "open"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_NAME: Record<StageKey, { label: string; short: string }> = {
  levels: { label: "Levels and focus pick", short: "Levels" },
  build: { label: "Radar build", short: "Build" },
  stored: { label: "Edition stored", short: "Stored" },
  evidence: { label: "Evidence kept and desk file", short: "Kept" },
  preopen: { label: "Pre-open prices", short: "Prices" },
  card: { label: "Card saved", short: "Card" },
  open: { label: "Session opens", short: "Open" },
};

export interface StageTimes {
  scheduled: number;
  deadline: number;
  /** False where the stage's document has no verified schedule in the feed watch: a miss is "no record", not "late". */
  verified: boolean;
}

const docFeed = (id: string): DocFeed | null => {
  const f = feedById(id);
  return f?.type === "doc" ? f : null;
};

/** The feed watch's run of `id` for `session`: by the run's own day, or (next-session rows) by the session it is for. */
function feedRun(id: string, session: string, by: "day" | "for"): { due: number; deadline: number; verified: boolean } | null {
  const f = docFeed(id);
  const noon = nyInstant(session, 12 * 60);
  if (!f || noon === null) return null;
  const s = slotsAround(f, noon, 7, 1).find((x) => (by === "day" ? x.day === session : x.match_session === session));
  return s ? { due: s.due, deadline: s.deadline, verified: f.verified && s.schedule.verified !== false && !s.assumed } : null;
}

const scheduleCache = new Map<string, Record<StageKey, StageTimes>>();

/**
 * When each stage of `session` is scheduled (New York clock times, radar-pipeline-slots.ts) and the instant by which
 * it must be done: the feed watch's own deadline for the stage's document where it has a row, otherwise the stage's
 * time plus STAGE_GRACE_MIN.
 */
export function scheduleOf(session: string): Record<StageKey, StageTimes> {
  const hit = scheduleCache.get(session);
  if (hit) return hit;
  const at = (day: string, minute: number) => nyInstant(day, minute) ?? Date.parse(`${day}T00:00:00Z`) + (minute + 300) * MIN;
  const own = (scheduled: number): StageTimes => ({ scheduled, deadline: scheduled + STAGE_GRACE_MIN * MIN, verified: true });
  const withFeed = (scheduled: number, run: ReturnType<typeof feedRun>): StageTimes =>
    run ? { scheduled, deadline: Math.max(run.deadline, scheduled), verified: run.verified } : own(scheduled);
  const previous = adjacentSession(session, -1).day;
  const radar = feedRun("radar", session, "day");
  const out: Record<StageKey, StageTimes> = {
    levels: withFeed(at(previous, LEVELS_NY), feedRun("options-edition", session, "for")),
    build: own(at(session, BUILD_NY)),
    stored: withFeed(at(session, STORED_NY), radar),
    evidence: withFeed(radar?.due ?? at(session, SEND_NY), feedRun("radar-desk", session, "day")),
    preopen: withFeed(at(session, PREOPEN_NY_MIN), feedRun("pre-open", session, "day")),
    card: withFeed(at(session, CARD_NY), feedRun("ledger-morning", session, "day")),
    open: { scheduled: at(session, OPEN_NY_MIN), deadline: at(session, OPEN_NY_MIN), verified: true },
  };
  if (scheduleCache.size > 400) scheduleCache.clear();
  scheduleCache.set(session, out);
  return out;
}

// ---- the rows -------------------------------------------------------------------------------------------------------

/**
 * done: it happened. running: it said it started. waiting: its time has come and its deadline has not. late: the
 * deadline passed with nothing. failed: it said it failed, or the ingest refused it. not_due: its time has not come.
 * no_record: nothing was seen and nothing can be said (no run beacon; a stage whose schedule is not verified).
 */
export type StageState = "done" | "running" | "waiting" | "late" | "failed" | "not_due" | "no_record";

export interface StageRow {
  key: StageKey;
  label: string;
  short: string;
  state: StageState;
  scheduled: number;
  deadline: number;
  /** When it happened (ms), or null. */
  at: number | null;
  /** Minutes after (positive) or before (negative) its scheduled time, when it happened. */
  delta_min: number | null;
  who: Who;
  /** A closed code that says more: a beacon's reason, "refused", "no-beacon", "no-receipt", "quiet". */
  code: string | null;
}

function byClock(at: number | null, t: StageTimes, nowMs: number): StageState {
  if (at !== null) return "done";
  if (nowMs < t.scheduled) return "not_due";
  if (nowMs <= t.deadline) return "waiting";
  return t.verified ? "late" : "no_record";
}

/**
 * The seven rows of a session at `nowMs`. With no observation (`obs` null: the summary has not been written, or does
 * not hold the session) it is the schedule alone: a stage whose time has passed reads "no record", never "late".
 */
export function stageRows(session: string, obs: SessionObs | null, nowMs: number): StageRow[] {
  const times = scheduleOf(session);
  const row = (key: StageKey, state: StageState, at: number | null, who: Who = "unknown", code: string | null = null): StageRow => ({
    key,
    ...STAGE_NAME[key],
    state,
    scheduled: times[key].scheduled,
    deadline: times[key].deadline,
    at,
    delta_min: at === null ? null : Math.round((at - times[key].scheduled) / MIN),
    who,
    code,
  });
  const openAt = times.open.scheduled;
  const open = nowMs >= openAt ? row("open", "done", openAt) : row("open", "not_due", null);
  if (!obs) {
    return STAGE_KEYS.map((k) => (k === "open" ? open : row(k, nowMs < times[k].scheduled ? "not_due" : "no_record", null, "unknown", nowMs < times[k].scheduled ? null : "not-read")));
  }
  const simple = (key: StageKey, iso8601: string | null) => {
    const at = ms(iso8601);
    return row(key, byClock(at, times[key], nowMs), at);
  };
  const stored = ms(obs.stored_at);
  const b = obs.beacons;

  // The build is only ever known from its beacon.
  let build: StageRow;
  const bb = b.build;
  if (!bb) build = nowMs < times.build.scheduled ? row("build", "not_due", null) : row("build", "no_record", null, "unknown", "no-beacon");
  else {
    const started = ms(bb.started_at)!;
    const ended = ms(bb.ended_at);
    // A build's minutes against its time are its start's: how long it then ran is not lateness.
    if (bb.state === "finished") build = { ...row("build", "done", ended ?? started, bb.trigger, bb.reason === "ok" ? null : bb.reason), delta_min: Math.round((started - times.build.scheduled) / MIN) };
    else if (bb.state === "failed") build = row("build", "failed", ended ?? started, bb.trigger, bb.reason);
    else if (bb.state === "skipped") {
      if (bb.reason === "no-session") build = row("build", "not_due", null, bb.trigger, bb.reason);
      else if (bb.reason === "already-stored") build = row("build", stored !== null ? "done" : "no_record", null, "unknown", bb.reason);
      else if (bb.reason === "lock-held") build = row("build", "running", null, "unknown", bb.reason);
      else build = row("build", "failed", ended ?? started, bb.trigger, bb.reason);
    } else if (stored !== null && stored >= started) build = row("build", "done", null, bb.trigger, "no-end");
    else if (nowMs - started > BUILD_QUIET_MIN * MIN) build = row("build", "late", null, bb.trigger, "quiet");
    else build = row("build", "running", null, bb.trigger);
  }

  // Stored: the store's own receipt time. Who sent it is the send beacon's word, else the build's.
  const sender: Who = b.send && b.send.state !== "skipped" ? b.send.trigger : bb && (bb.state === "finished" || bb.state === "started") ? bb.trigger : "unknown";
  let storedRow: StageRow;
  if (stored !== null) storedRow = row("stored", "done", stored, sender);
  else if (obs.edition_on_file && nowMs >= times.stored.scheduled) storedRow = row("stored", "no_record", null, sender, "no-receipt");
  else if (obs.refused_at) storedRow = row("stored", "failed", ms(obs.refused_at), sender, "refused");
  else if (b.send?.state === "failed") storedRow = row("stored", "failed", ms(b.send.ended_at) ?? ms(b.send.started_at), b.send.trigger, b.send.reason);
  else if (b.send?.state === "started") storedRow = row("stored", "running", null, b.send.trigger);
  else storedRow = row("stored", byClock(null, times.stored, nowMs), null);

  // Evidence kept and the desk file: done when the desk file is on file.
  const desk = ms(obs.desk_at);
  const after = b.desk ?? b.evidence;
  let evidence: StageRow;
  if (desk !== null) evidence = row("evidence", "done", desk, after && after.state !== "skipped" ? after.trigger : "unknown");
  else if (b.desk?.state === "failed" || b.evidence?.state === "failed") {
    const f = b.desk?.state === "failed" ? b.desk : b.evidence!;
    evidence = row("evidence", "failed", ms(f.ended_at) ?? ms(f.started_at), f.trigger, f.reason);
  } else if (b.evidence?.state === "started" || b.evidence?.state === "finished" || b.desk?.state === "started") evidence = row("evidence", "running", null, (b.desk ?? b.evidence)!.trigger);
  else evidence = row("evidence", byClock(null, times.evidence, nowMs), null);

  return [simple("levels", obs.levels_at), build, storedRow, evidence, simple("preopen", obs.preopen_at), simple("card", obs.card_at), open];
}

/** The index of the first stage the clock has not reached: the "now" marker sits before it. Null when all are reached. */
export function nowBefore(rows: readonly StageRow[], nowMs: number): number | null {
  const i = rows.findIndex((r) => r.scheduled > nowMs);
  return i < 0 ? null : i;
}

// ---- the headline ---------------------------------------------------------------------------------------------------

/** "3 h 7 min", "42 min", "1 h". */
export function spanWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h === 0 ? `${r} min` : r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export type HeadlineKind = "no_session" | "schedule_only" | "not_due" | "waiting" | "building" | "on_time" | "late" | "by_hand" | "failed";
export interface Headline {
  kind: HeadlineKind;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
  /** The badge: "On time", "Late by 3 h 7 min", "Built by hand", "Building now", "No session today". */
  word: string;
  /** Minutes the edition was (or is) behind its scheduled time, when it is late. */
  late_min: number | null;
}

/** Whether a person started the run that built or sent the session's edition. */
export function byHand(obs: SessionObs | null): boolean {
  const b = obs?.beacons;
  return b?.build?.trigger === "manual" || b?.send?.trigger === "manual";
}

/**
 * The one line that says where the session's edition stands. It goes by the store's receipt time and the run beacons
 * only: on time is "stored by the deadline", never "stored"; an edition a person built says so whenever it arrived;
 * with no beacon nothing is said about who built it.
 */
export function headlineOf(days: PipelineDays, obs: SessionObs | null, rows: readonly StageRow[], nowMs: number, scheduleOnly = false): Headline {
  if (!days.today_is_session) return { kind: "no_session", tone: "neutral", word: "No session today", late_min: null };
  if (scheduleOnly) return { kind: "schedule_only", tone: "neutral", word: "Schedule only", late_min: null };
  const build = rows.find((r) => r.key === "build")!;
  const stored = rows.find((r) => r.key === "stored")!;
  if (stored.state === "done" && stored.at !== null) {
    const late = stored.at > stored.deadline;
    const lateMin = late ? Math.max(0, Math.round((stored.at - stored.scheduled) / MIN)) : null;
    if (byHand(obs)) return { kind: "by_hand", tone: "warn", word: "Built by hand", late_min: lateMin };
    if (late) return { kind: "late", tone: "bad", word: `Late by ${spanWords(lateMin!)}`, late_min: lateMin };
    return { kind: "on_time", tone: "good", word: "On time", late_min: null };
  }
  if (stored.state === "failed") return { kind: "failed", tone: "bad", word: stored.code === "refused" ? "Edition refused" : "Send failed", late_min: null };
  if (build.state === "failed") return { kind: "failed", tone: "bad", word: "Build failed", late_min: null };
  if (nowMs > stored.deadline && stored.state !== "no_record") {
    const lateMin = Math.max(0, Math.round((nowMs - stored.scheduled) / MIN));
    return { kind: "late", tone: "bad", word: `Late by ${spanWords(lateMin)}`, late_min: lateMin };
  }
  if (build.state === "running" || stored.state === "running") return { kind: "building", tone: "info", word: "Building now", late_min: null };
  if (stored.state === "no_record") return { kind: "waiting", tone: "neutral", word: "No record", late_min: null };
  if (nowMs < build.scheduled) return { kind: "not_due", tone: "neutral", word: "Not due yet", late_min: null };
  return { kind: "waiting", tone: "info", word: "Waiting for the edition", late_min: null };
}

/** Whether the summary is too old to vouch for: three missed cron ticks. */
export function pipelineStale(file: PipelineFile | null, nowMs: number): boolean {
  const t = ms(file?.generated_at);
  return t !== null && nowMs - t > PIPELINE_STALE_MIN * MIN;
}

// ---- the last sessions ----------------------------------------------------------------------------------------------

/** on_time and late go by the receipt time against the deadline; by_hand whenever a person started the run; missed:
 * the deadline passed and a look that read everything found no edition; no_record: stored with its receipt time
 * unknown, never read, or not yet read whole; pending: the deadline has not passed. */
export type SessionMark = "on_time" | "late" | "by_hand" | "missed" | "no_record" | "pending";

export function sessionMark(session: string, obs: SessionObs | null, nowMs: number): SessionMark {
  const t = scheduleOf(session).stored;
  if (!obs) return nowMs <= t.deadline ? "pending" : "no_record";
  const stored = ms(obs.stored_at);
  if (stored !== null) return byHand(obs) ? "by_hand" : stored <= t.deadline ? "on_time" : "late";
  if (nowMs <= t.deadline) return obs.edition_on_file ? "no_record" : "pending";
  return obs.edition_on_file || !obs.complete ? "no_record" : "missed";
}

export interface Reliability {
  /** Oldest first: the sessions before the one in view. */
  marks: { session: string; mark: SessionMark }[];
  on_time: number;
  late: number;
  by_hand: number;
  missed: number;
  no_record: number;
  /** The sessions the rate is worked out over: on time, late, by hand and missed. "No record" sessions are left out. */
  counted: number;
  /** on_time over `counted`; null when there are none. */
  rate: number | null;
}

export function reliabilityOf(days: PipelineDays, file: PipelineFile | null, nowMs: number): Reliability {
  const by = new Map((file?.sessions ?? []).map((s) => [s.session, s]));
  const marks = days.sessions.slice(0, -1).map((session) => ({ session, mark: sessionMark(session, by.get(session) ?? null, nowMs) }));
  const n = (m: SessionMark) => marks.filter((x) => x.mark === m).length;
  const counted = n("on_time") + n("late") + n("by_hand") + n("missed");
  return { marks, on_time: n("on_time"), late: n("late"), by_hand: n("by_hand"), missed: n("missed"), no_record: n("no_record"), counted, rate: counted === 0 ? null : n("on_time") / counted };
}
