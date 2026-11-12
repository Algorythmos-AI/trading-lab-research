// One request to /api/contract as the page sends it, apart from React so its stamping and its reading of the answer
// can be tested without a browser: the send time on both clocks before the fetch, a timeout so a hung request cannot
// stall the poll (lib/quote-poll.ts), and the route's status read as the poll reads it. Pure apart from the injected
// fetch and clocks.
import type { ContractFeed, ContractResponse } from "./option-value";
import { type PollResult, statusResult } from "./quote-poll";

/** A request that has not answered in this long is given up, and counts as a failure. */
export const CONTRACT_FETCH_TIMEOUT_MS = 5_000;

export interface RequestDeps {
  fetchImpl: typeof fetch;
  /** The browser's monotonic clock (performance.now), ms. */
  perf: () => number;
  /** The browser's wall clock (Date.now), ms. */
  wall: () => number;
  /** The signal that ends the request after `ms`; AbortSignal.timeout unless a test passes its own. */
  timeout?: (ms: number) => AbortSignal;
}

/** Our own "not set up" answer: a 503 with this body. Any other 503 (a platform error page, say) is a failure to retry. */
function isNotConfigured(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { error?: unknown }).error === "not-configured";
}

/**
 * Ask for `symbols` (OCC symbols joined by commas). The send is stamped on both clocks BEFORE the fetch, and the
 * answer carries those stamps, so its age includes the time it was in flight (option-value.ts judgeQuote). "off" only
 * for our own not-configured 503; a timeout, a transport failure or any other failure is "error" (the caller drops
 * its last answer), a 429 "limited".
 */
export async function requestContracts(symbols: string, d: RequestDeps): Promise<{ result: PollResult; feed: ContractFeed }> {
  const sentPerf = d.perf();
  const sentWall = d.wall();
  try {
    const res = await d.fetchImpl(`/api/contract?s=${encodeURIComponent(symbols)}`, {
      cache: "no-store",
      signal: (d.timeout ?? ((ms) => AbortSignal.timeout(ms)))(CONTRACT_FETCH_TIMEOUT_MS),
    });
    if (res.status === 503) {
      const body: unknown = await res.json().catch(() => null);
      return isNotConfigured(body) ? { result: "off", feed: { status: "off" } } : { result: "error", feed: { status: "error" } };
    }
    const r = statusResult(res.status);
    if (r !== "ok") return { result: r, feed: { status: "error" } };
    const answer = (await res.json()) as ContractResponse;
    return { result: "ok", feed: { status: "ok", answer, sentPerf, sentWall } };
  } catch {
    return { result: "error", feed: { status: "error" } };
  }
}
