// How long a poll waits before it asks again after failing, with no clock, timer or DOM in it.
//
// The wait doubles with each failure in a row, from `firstMs`, and never passes `capMs`:
//
//   failures  1    2    3    4     5     6 ...
//   wait      2 s  4 s  8 s  16 s  30 s  30 s ...   (firstMs 2 s, capMs 30 s)
//
// So three failures in a row are retried after about 2, 4 and 8 s: a short outage is over well inside the 20 s after
// which the "Trade now" board pauses (trade-state's FEED_STALE_MS). Jitter only ever shortens a wait, by up to
// `jitter` of it, so pages that failed together do not all ask again in the same instant; `rand` is injectable so a
// test can fix it. A rate limit from upstream (HTTP 429) waits the full cap at once (`capDelay`).

export interface BackoffOptions {
  /** The wait after the first failure, ms. */
  firstMs?: number;
  /** The longest wait, ms. */
  capMs: number;
  /** The share of a wait that jitter may take off it, 0 to 1. */
  jitter?: number;
  /** A number in [0, 1): Math.random unless a test passes its own. */
  rand?: () => number;
}

export const BACKOFF_FIRST_MS = 2_000;
export const BACKOFF_JITTER = 0.1;

function jittered(ms: number, o: BackoffOptions): number {
  const share = Math.min(1, Math.max(0, o.jitter ?? BACKOFF_JITTER));
  const r = Math.min(1, Math.max(0, (o.rand ?? Math.random)()));
  return Math.round(ms * (1 - share * r));
}

/** The wait before the next attempt after `failures` failures in a row; 0 when there has been none. */
export function retryDelay(failures: number, o: BackoffOptions): number {
  if (!(failures >= 1)) return 0;
  const first = Math.max(0, o.firstMs ?? BACKOFF_FIRST_MS);
  const cap = Math.max(0, o.capMs);
  // 2 ** n overflows to Infinity long before it matters, and min() then takes the cap.
  const base = Math.min(cap, first * 2 ** (Math.floor(failures) - 1));
  return jittered(base, o);
}

/** The wait after upstream said to slow down (429): the cap straight away. */
export function capDelay(o: BackoffOptions): number {
  return jittered(Math.max(0, o.capMs), o);
}
