// The comparison report's settled 1-minute bars (docs/runbooks/feed-agreement.md, "Server comparison"): one finished
// session's 1-minute bars [open, close) for the focus names from one named Alpaca stock feed, read once after the
// close. Read-only GETs of historical bars only, every URL built by alpacaDataUrl naming its feed. It shares the
// report run's call limiter and time budget (feed-agreement-fetch's CallLimiter and deadline), waits for Retry-After
// on a 429, and never goes past its deadline. The keys go only into Alpaca's headers; a key, a page token or a body is
// never logged or put in an error.
import { alpacaDataUrl } from "./alpaca-data-url";
import type { SessionBounds } from "./desk-eval";
import { CALL_TIMEOUT_MS, DEFAULT_DATA_URL, DEFAULT_RETRY_MS, FetchStop, type FetchSessionOpts, MAX_PAGES, MAX_RETRIES, MIN_SIP_RATE_LIMIT, rateLimitOf, retryAfterMs } from "./feed-agreement-fetch";
import { type CompareFeed, type MinBar, timeMs } from "./feed-compare";

/** One page's URL: always naming the feed, the session [open, close), raw prices, oldest first. */
export function minuteBarsUrl(base: string, feed: CompareFeed, symbols: readonly string[], bounds: SessionBounds, token: string | null): string {
  const q: Record<string, string> = {
    symbols: symbols.join(","),
    timeframe: "1Min",
    start: new Date(bounds.open).toISOString(),
    end: new Date(bounds.close).toISOString(),
    feed,
    limit: "10000",
    adjustment: "raw",
    sort: "asc",
  };
  if (token) q.page_token = token;
  return alpacaDataUrl(base, "/v2/stocks/bars", q);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A raw bar inside [open, close) with its start and prices, or null. */
export function minBar(raw: unknown, bounds: SessionBounds): MinBar | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const t = timeMs(r.t);
  const o = num(r.o);
  const h = num(r.h);
  const l = num(r.l);
  const c = num(r.c);
  if (t === null || o === null || h === null || l === null || c === null || t < bounds.open || t >= bounds.close) return null;
  return { t, o, h, l, c, v: num(r.v) };
}

async function wait(ms: number, o: FetchSessionOpts, what: string): Promise<void> {
  if (ms <= 0) return;
  if (o.clock.now() + ms >= o.deadline) throw new FetchStop("time-budget", `time budget: ${what}`);
  await o.clock.sleep(ms);
}

async function page(url: string, feed: CompareFeed, o: FetchSessionOpts): Promise<{ body: unknown; rateLimit: number | null }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  for (let attempt = 0; ; attempt++) {
    await wait(o.limiter.waitMs(o.clock.now()), o, "the call limit");
    const left = o.deadline - o.clock.now();
    if (left <= 0) throw new FetchStop("time-budget", `time budget: spent before the ${feed} minute bars were read`);
    o.limiter.record(o.clock.now());
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "APCA-API-KEY-ID": o.keys.id, "APCA-API-SECRET-KEY": o.keys.secret, accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, left)),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "unknown";
      throw new FetchStop(name === "TimeoutError" || name === "AbortError" ? "time-budget" : "upstream", `upstream: the ${feed} minute bars could not be read (${name})`);
    }
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new FetchStop("upstream", `upstream: ${feed} minute bars still rate-limited after ${MAX_RETRIES} retries`);
      await wait(retryAfterMs(res.headers.get("retry-after"), o.clock.now()) ?? DEFAULT_RETRY_MS, o, `a 429 Retry-After on ${feed}`);
      continue;
    }
    if (res.status === 403) throw feed === "sip" ? new FetchStop("sip-not-entitled", "sip not entitled: 403 on the minute bars") : new FetchStop("iex-refused", "iex refused: 403 on the minute bars");
    if (!res.ok) throw new FetchStop("upstream", `upstream: ${feed} minute bars answered HTTP ${res.status}`);
    try {
      return { body: await res.json(), rateLimit: rateLimitOf(res.headers.get("x-ratelimit-limit")) };
    } catch (e) {
      throw new FetchStop("upstream", `upstream: ${feed} minute bars' body could not be read (${e instanceof Error ? e.name : "unknown"})`);
    }
  }
}

/**
 * The session's settled 1-minute bars per symbol from `feed`, oldest first, one per start time: every
 * next_page_token page read (at most MAX_PAGES). Throws FetchStop, never a partial answer; no bar for any symbol is
 * "no-bars".
 */
export async function fetchMinuteBars(feed: CompareFeed, symbols: readonly string[], bounds: SessionBounds, o: FetchSessionOpts): Promise<Record<string, MinBar[]>> {
  const base = o.baseUrl ?? DEFAULT_DATA_URL;
  const got: Record<string, Map<number, MinBar>> = Object.fromEntries(symbols.map((s) => [s, new Map()]));
  let token: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const answer = await page(minuteBarsUrl(base, feed, symbols, bounds, token), feed, o);
    if (n === 0 && feed === "sip" && answer.rateLimit !== null && answer.rateLimit < MIN_SIP_RATE_LIMIT)
      throw new FetchStop("sip-plan", `sip plan: X-RateLimit-Limit under ${MIN_SIP_RATE_LIMIT}`);
    const body = answer.body as { bars?: Record<string, unknown[]> | null; next_page_token?: unknown } | null;
    for (const [s, list] of Object.entries(body?.bars ?? {})) {
      const into = got[s];
      if (!into || !Array.isArray(list)) continue;
      for (const raw of list) {
        const b = minBar(raw, bounds);
        if (b) into.set(b.t, b);
      }
    }
    token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token) break;
  }
  if (token) throw new FetchStop("upstream", `upstream: ${feed} minute bars still paging after ${MAX_PAGES} pages`);
  const out: Record<string, MinBar[]> = {};
  for (const s of symbols) out[s] = [...got[s]!.values()].sort((a, b) => a.t - b.t);
  if (symbols.every((s) => out[s]!.length === 0)) throw new FetchStop("no-bars", `no bars: the ${feed} feed returned no minute bars on ${bounds.day}`);
  return out;
}
