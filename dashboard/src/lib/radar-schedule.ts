// When the Radar updates: the day's timeline of the cloud routine that builds it, and whether the newest edition is
// the one the schedule says should be out. Pure: no I/O, the clock is passed in.
// The build and the send run on UTC schedules on UTC weekdays; the pre-market refresh and the open follow New York.
import { DAILY_GRACE_MIN, RADAR_SLOT_UTC } from "./feeds";
import { etOffsetMin } from "./freshness";

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** The radar routine starts at 10:30 UTC. */
export const RADAR_BUILD_UTC = 10 * 60 + 30;
/** Editions stamp about 15 minutes later: 10:44 to 10:46 UTC on every edition so far. */
export const RADAR_LANDS_UTC = 10 * 60 + 45;
/** The options desk's pre-open refresh (08:50 New York) lands its pre-market prices about two minutes later. */
export const PREMARKET_NY = 8 * 60 + 52;
/** The regular session opens; from here an older edition shows the stale notice. */
export const OPEN_NY = 9 * 60 + 30;

/** The jobs behind the Radar, in the order the data moves. Ids are the routines' own (docs/runbooks/cloud-routines.md). */
export interface RadarJob {
  key: "build" | "send" | "premarket";
  name: string;
  kind: string;
  id: string | null;
  /** UTC or New York minute after midnight, for the label. */
  slot: { zone: "UTC" | "NY"; minute: number };
  does: string;
}
export const RADAR_JOBS: readonly RadarJob[] = [
  {
    key: "build",
    name: "Radar build",
    kind: "Scheduled task in the cloud",
    id: null,
    slot: { zone: "UTC", minute: RADAR_BUILD_UTC },
    does: "Pulls the watch lists and prices from IBKR, works out the day, the levels and the names, and leaves the edition in an outbox.",
  },
  {
    key: "send",
    name: "Radar edition",
    kind: "Claude routine",
    id: "trig_01B1TN3d4x7dZ3Wxad2LmYgb",
    slot: { zone: "UTC", minute: RADAR_SLOT_UTC },
    does: "Sends the newest outbox file to this site's signed ingest, and retries once if the build ran late.",
  },
  {
    key: "premarket",
    name: "Options focus, pre-open",
    kind: "Claude routine",
    id: "trig_01WyzH7k8xAUgj8RZsakUDW7",
    slot: { zone: "NY", minute: 8 * 60 + 50 },
    does: "Prices the focus names before the open; the Radar shows those as the refreshed pre-market prices.",
  },
];

export type ScheduleKey = "build" | "lands" | "send" | "late" | "premarket" | "open";

export interface ScheduleStep {
  key: ScheduleKey;
  label: string;
  /** The instant, ISO. */
  at: string;
  /** "about" for a time the run usually hits rather than a fixed clock time. */
  approx: boolean;
}

export type RadarScheduleState = "current" | "building" | "late";

export interface RadarScheduleStatus {
  state: RadarScheduleState;
  /** The New York day of the edition the schedule expects next (or is waiting for), YYYY-MM-DD. */
  day: string;
  /** About when it lands, ISO. */
  expected: string;
  /** After this it counts as late, ISO: the send slot plus the feed grace. */
  lateAfter: string;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`);
const isWeekday = (ms: number) => {
  const d = new Date(ms).getUTCDay();
  return d >= 1 && d <= 5;
};

/** The instant `minute` after midnight New York on `day`, whatever the offset that day. */
export function nyAt(day: string, minute: number): number {
  for (const off of [-240, -300]) {
    const at = midnight(day) + (minute - off) * MIN_MS;
    if (etOffsetMin(at) === off) return at;
  }
  return midnight(day) + (minute + 300) * MIN_MS;
}

/** The first weekday after `editionDate`: the next edition the routine owes. */
export function nextEditionDay(editionDate: string): string {
  let d = midnight(editionDate) + DAY_MS;
  while (!isWeekday(d)) d += DAY_MS;
  return ymd(d);
}

/**
 * Where the newest edition stands against the schedule. `current` until the next edition's build starts, `building`
 * from then until the send slot's grace runs out, `late` after that. A US holiday can show as late.
 */
export function radarScheduleStatus(latestEdition: string, nowMs: number): RadarScheduleStatus {
  const day = nextEditionDay(latestEdition);
  const base = midnight(day);
  const build = base + RADAR_BUILD_UTC * MIN_MS;
  const lateAfter = base + (RADAR_SLOT_UTC + DAILY_GRACE_MIN) * MIN_MS;
  const state: RadarScheduleState = nowMs < build ? "current" : nowMs < lateAfter ? "building" : "late";
  return { state, day, expected: new Date(base + RADAR_LANDS_UTC * MIN_MS).toISOString(), lateAfter: new Date(lateAfter).toISOString() };
}

/** One edition day's timeline, in order: build, lands, backstop send, late after, pre-market refresh, open. */
export function radarSchedule(day: string): ScheduleStep[] {
  const base = midnight(day);
  const utc = (m: number) => new Date(base + m * MIN_MS).toISOString();
  const ny = (m: number) => new Date(nyAt(day, m)).toISOString();
  return [
    { key: "build", label: "Build starts", at: utc(RADAR_BUILD_UTC), approx: false },
    { key: "lands", label: "New edition", at: utc(RADAR_LANDS_UTC), approx: true },
    { key: "send", label: "Backstop send", at: utc(RADAR_SLOT_UTC), approx: false },
    { key: "late", label: "Late if not in by", at: utc(RADAR_SLOT_UTC + DAILY_GRACE_MIN), approx: false },
    { key: "premarket", label: "Pre-market prices", at: ny(PREMARKET_NY), approx: true },
    { key: "open", label: "Session opens", at: ny(OPEN_NY), approx: false },
  ];
}
