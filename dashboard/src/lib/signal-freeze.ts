// The two hashes DEC-0051 Amendment 1 freezes: the signal's numbers (signal-params.ts paramsHash) and the signal's own
// code (signal-version.gen.ts SIGNAL_CODE_HASH, from scripts/gen-signal.mjs). Both null until Amendment 1 is written:
// while either is null, or differs from the one in force, every word is NO TRADE (data), whatever any caller passes.
//
// Both stay null until DEC-0051 Amendment 1 writes them. After the freeze, a change to ANY file in the signal's import
// closure (scripts/gen-signal.mjs: signal.ts and everything it imports within src/lib, flow.ts, context.ts,
// option-value.ts, board-events.ts and the rest) gives a new SIGNAL_CODE_HASH, and every word is NO TRADE (data) until
// a record re-freezes it.
//
// Kept apart from the hashed files on purpose: writing a frozen code hash into a file the hash is taken over would
// change that hash. Amendment 1's pull request sets these two lines and nothing else here.
export const FROZEN_PARAMS_HASH: string | null = null;
export const FROZEN_CODE_HASH: string | null = null;
