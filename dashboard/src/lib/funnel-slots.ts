// When the selection funnel's health document is due. Kept out of feeds.ts, which is inside the engine and signal
// hash closures (gen-engine.mjs, gen-signal.mjs): a constant there would move both hashes.

/**
 * The after-close Options routine fires at 21:52 UTC; its seal step runs after the levels, the focus pick and the
 * shadow step, and publishes the funnel document at the end. 22:30 UTC (minutes after midnight, like feeds.ts) leaves
 * room for that whole firing.
 */
export const FUNNEL_SLOT_UTC = 22 * 60 + 30;
