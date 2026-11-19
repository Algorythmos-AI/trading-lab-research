// The Radar pipeline's own clock times and routine ids. Kept out of feeds.ts, which is inside the engine and signal
// hash closures (gen-engine.mjs, gen-signal.mjs): a constant there would move both hashes.
//
// The times are New York minutes after midnight, as the routines' schedules are meant (docs/runbooks/cloud-routines.md).
// A stage's deadline is not kept here: where the feed watch has a row for the stage's document, the deadline is that
// row's (feed-watch.ts), so this page, Operations and the alerts go by one rule.

/** The after-close routine builds the next session's levels and picks its focus names, the session day before. */
export const LEVELS_NY = 16 * 60 + 52;
/** The Radar build routine starts. */
export const BUILD_NY = 5 * 60 + 30;
/** An edition is usually stored about a quarter of an hour after the build starts. */
export const STORED_NY = 5 * 60 + 45;
/** The send routine, where the feed watch's radar row cannot say when it runs (11:12 UTC is 06:12 in New York's winter). */
export const SEND_NY = 6 * 60 + 12;
/** The pre-open routine prices the focus names. */
export const PREOPEN_NY_MIN = 8 * 60 + 50;
/** The ledger's morning routine saves the day's card. */
export const CARD_NY = 9 * 60 + 11;
/** The regular session opens. */
export const OPEN_NY_MIN = 9 * 60 + 30;

/** Minutes after a stage's time by which it must be done, where the feed watch has no row to take it from. */
export const STAGE_GRACE_MIN = 60;
/** A build that said it started and has said nothing since, this many minutes on, is no longer "running". */
export const BUILD_QUIET_MIN = 60;

/** How many sessions before the one in view the summary keeps: the reliability strip's length. */
export const PIPELINE_SESSIONS = 20;
/** The summary the 10-minute cron writes and the Radar page reads. PRIVATE: times, ids, closed codes and counts only. */
export const RADAR_PIPELINE_PATH = "ops/radar-pipeline.json";
/** Older than this, the summary is said to be old: three missed cron ticks. */
export const PIPELINE_STALE_MIN = 30;

/** The cloud routines behind the Radar, in the order the data moves. The ids are the routines' own. */
export interface RadarRoutine {
  key: "build" | "catch-up" | "send" | "pre-open";
  name: string;
  id: string;
  /** When it fires, for the label: a UTC or New York minute after midnight. Null when it has no one time to show. */
  slot: { zone: "UTC" | "NY"; minute: number } | null;
  does: string;
}
export const RADAR_ROUTINES: readonly RadarRoutine[] = [
  {
    key: "build",
    name: "Radar build",
    id: "trig_01PW2UvCBejb4UxCEB58PEVp",
    slot: { zone: "NY", minute: BUILD_NY },
    does: "Reads the watch lists and prices, works out the day, the levels and the names, and leaves the edition in an outbox.",
  },
  {
    key: "catch-up",
    name: "Radar catch-up",
    id: "trig_015qsK3nrRQgscNZh6strL4F",
    slot: null,
    does: "Runs after the build. When today's edition is already stored it stops at once; when it is not, it does the build's work.",
  },
  {
    key: "send",
    name: "Radar edition",
    id: "trig_01B1TN3d4x7dZ3Wxad2LmYgb",
    slot: { zone: "UTC", minute: 11 * 60 + 12 },
    does: "Sends the newest outbox file to this site's signed ingest, and retries every 20 minutes until 13:45 UTC if the build ran late.",
  },
  {
    key: "pre-open",
    name: "Options focus, pre-open",
    id: "trig_01WyzH7k8xAUgj8RZsakUDW7",
    slot: { zone: "NY", minute: PREOPEN_NY_MIN },
    does: "Prices the focus names before the open; the Radar shows those as the refreshed pre-market prices.",
  },
];
