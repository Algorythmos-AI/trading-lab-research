// Rule 5's option stop as one number, in a module of its own so both the rules (trade-rules.ts) and the owner's R25
// (owner-positions.ts) read the same value without importing each other.

/** Close an option once it has lost this share of what it cost: rule 5's −25% stop. */
export const PREMIUM_STOP = 0.25;
