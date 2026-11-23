// When the page's minute refresh (AutoRefresh) may go out, apart from React so it can be tested: never a second one
// while the last is still being drawn, and not while the owner is in the middle of clicking or typing (a refresh
// redraws the whole page from the server, and on the Options page that work can hold a click up). The wait for the
// owner is bounded, so the page can never go stale behind a busy hand.

/** A click or a key this recently holds the refresh back. */
export const QUIET_MS = 3_000;
/** At most this many holds in a row; the next turn refreshes whatever the owner is doing. */
export const MAX_HOLDS = 2;

export type RefreshTurn = "refresh" | "hold" | "skip";

/**
 * One turn of the minute timer. `pending`: the last refresh has not been drawn yet. `sinceInputMs`: how long since the
 * owner last clicked or typed (Infinity when never). `holds`: turns held back in a row so far.
 */
export function refreshTurn(pending: boolean, sinceInputMs: number, holds: number): RefreshTurn {
  if (pending) return "skip";
  if (sinceInputMs < QUIET_MS && holds < MAX_HOLDS) return "hold";
  return "refresh";
}
