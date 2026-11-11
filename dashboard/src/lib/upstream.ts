// Alpaca's answer when it is not a success, kept as its HTTP status so a route can tell a rate limit (429) from any
// other failure. The message stays `alpaca <status>` and the name stays "Error", so logs read as before; the body and
// the keys are never kept.

export class UpstreamError extends Error {
  constructor(readonly status: number) {
    super(`alpaca ${status}`);
  }
}

/**
 * The status a route answers for a failed upstream call: 429 when Alpaca asked us to slow down, so the page waits
 * its longest before asking again; 502 for anything else (a transport error, a timeout, any other status).
 */
export function upstreamStatus(e: unknown): 429 | 502 {
  return e instanceof UpstreamError && e.status === 429 ? 429 : 502;
}

/** The body that goes with it: a word, never upstream's own text. */
export function upstreamBody(status: 429 | 502): { error: "rate-limited" | "upstream" } {
  return { error: status === 429 ? "rate-limited" : "upstream" };
}
