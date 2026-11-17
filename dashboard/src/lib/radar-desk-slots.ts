// When the Radar desk file is due. Kept out of feeds.ts, which is inside the engine and signal hash closures
// (gen-engine.mjs, gen-signal.mjs): a constant there would move both hashes.

/**
 * The desk file is built and sealed each morning after the radar's own seal step, from files sealed the night before,
 * and must be on file by 09:15 New York on each regular session, before the open. The feed watch counts the run from
 * 09:00 New York with 15 minutes' grace, so the deadline is 09:15.
 */
export const RADAR_DESK_NY = "09:00";
export const RADAR_DESK_GRACE_MIN = 15;
/** The deadline as the pages say it: RADAR_DESK_NY plus RADAR_DESK_GRACE_MIN (a unit test holds the two together). */
export const RADAR_DESK_DUE_NY = "09:15";
