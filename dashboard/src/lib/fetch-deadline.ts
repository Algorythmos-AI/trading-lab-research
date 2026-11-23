// The longest the browser waits for each of the page's own routes before it counts the request as failed, so a hung
// request can never hold a poll forever (lib/quote-poll.ts runs one request at a time: while one is out, nothing else
// is asked, and the prices would stop without a word). A timeout is an error like any other: the poll's doubling wait
// and Retry take over. Each is set above what the route itself may take upstream, so a slow but working answer is
// never cut off.

/** /api/quote: one upstream call of at most 8 s (lib/quote.ts). */
export const QUOTE_DEADLINE_MS = 15_000;
/** /api/chain: up to 3 pages of at most 8 s each (lib/chain.ts). */
export const CHAIN_DEADLINE_MS = 30_000;
/** /api/bars: several pages of at most 8 s each (lib/bars.ts); a session's 2-minute bars are one or two. */
export const BARS_DEADLINE_MS = 60_000;
/** /api/desk/flags: one storage read or write. */
export const FLAGS_DEADLINE_MS = 10_000;

/**
 * A signal that aborts after `ms`, or as soon as `cancel` is called (an effect's cleanup: a request whose answer
 * nobody will read is not left running). Plain AbortController and setTimeout, for browsers without AbortSignal.any.
 */
export function deadline(ms: number): { signal: AbortSignal; cancel: () => void; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return {
    signal: c.signal,
    cancel: () => {
      clearTimeout(t);
      c.abort();
    },
    done: () => clearTimeout(t),
  };
}
