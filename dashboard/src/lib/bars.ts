import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { type DataFeed, requireFeed } from "./alpaca-feed";
import { logEvent } from "./log";
import { UpstreamError } from "./upstream";
import { closeMinute, nyClock, nyInstant, OPEN_MIN } from "./options";
import { type Bar2, CLOSE_GRACE_MS } from "./trade-state";

// The session's 2-minute bars for the Options page's "Trade now" board: Alpaca's stock feed (ALPACA_FEED,
// alpaca-feed.ts; the free IEX one by default), read on the server so the browser keeps its connect-src 'self' policy
// and never sees the keys. Research only; nothing here can place an
// order. The page polls every 30 s; between polls its own 2-second prices fill in the newest bar.

export interface BarsResponse {
  as_of: string;
  /** The feed these bars were read from. */
  feed: DataFeed;
  /** Today's regular-session 2-minute bars per name, oldest first; the bar still forming may be last. */
  bars: Record<string, Bar2[]>;
  /** When the server read each name's bars upstream (ms, the server's clock): a bar that had not ended
   * CLOSE_GRACE_MS before it was still forming then. */
  fetchedAt: Record<string, number>;
  /** Symbols asked for that came back with no bars. */
  missing: string[];
  fixture?: true;
}

const DEFAULT_DATA_URL = "https://data.alpaca.markets";
const BAR_MS = 2 * 60_000;
/** The bar size asked for upstream: the board's 2-minute bars. */
const TIMEFRAME = "2Min";
/** Each name's bars are shared on one instance for this long; the page polls every 30 s. */
export const BARS_CACHE_MS = 10_000;
/** Names remembered at once: a bound, so a stream of odd symbols cannot grow the cache. */
export const MAX_CACHED_BARS = 64;
/** Pages read for one answer at most. Alpaca pages early; a session of 2-minute bars for 60 names is under 12,000. */
export const MAX_PAGES = 20;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type RawBar = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown } | null | undefined;

/** One Alpaca bar -> Bar2, or null when it is unusable or outside the regular session of its own New York day
 * (to 13:00 on a half day). */
export function normaliseBar(raw: RawBar, halfDay = false): Bar2 | null {
  if (!raw || typeof raw.t !== "string") return null;
  const start = Date.parse(raw.t);
  const { o, h, l, c } = raw;
  if (!Number.isFinite(start) || !isNum(o) || !isNum(h) || !isNum(l) || !isNum(c) || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  const clock = nyClock(new Date(start).toISOString());
  if (!clock || clock.minutes < OPEN_MIN || clock.minutes >= closeMinute(halfDay)) return null;
  return { start, end: start + BAR_MS, o, h, l, c };
}

/** The ISO instant of today's 09:30 New York, and whether `now` is past it. */
export function sessionStart(now: Date): { iso: string; ms: number } | null {
  const c = nyClock(now.toISOString());
  if (!c) return null;
  const ms = nyInstant(c.day, OPEN_MIN);
  return ms === null ? null : { iso: new Date(ms).toISOString(), ms };
}

const cache = new Map<string, { at: number; feed: DataFeed; open: number; half: boolean; bars: Bar2[] }>();

/** Test hook: forget the shared cache. */
export function resetBarsCache(): void {
  cache.clear();
}

function prune(): void {
  for (const s of cache.keys()) {
    if (cache.size <= MAX_CACHED_BARS) return;
    cache.delete(s);
  }
}

/**
 * A cached read is due again after BARS_CACHE_MS, at each 2-minute boundary (the bar that has just ended must come
 * fresh), and once more when CLOSE_GRACE_MS have passed since that boundary if it was read inside the grace (the bar
 * was not complete then).
 */
function cacheDue(at: number, t: number): boolean {
  if (t < at || t - at >= BARS_CACHE_MS) return true;
  const slot = Math.floor(t / BAR_MS) * BAR_MS;
  return at < slot || (t >= slot + CLOSE_GRACE_MS && at < slot + CLOSE_GRACE_MS);
}

/**
 * Today's regular-session 2-minute bars for `symbols` from the configured Alpaca feed, every `next_page_token` page read
 * (to 13:00 New York on a half day). Before 09:30 New York there is nothing to ask for, and nothing goes upstream.
 * Each name is cached on its own (cacheDue), with the time it was read (`fetchedAt`). Throws on a transport or HTTP
 * error (the route answers 502) and caches nothing from it. When Alpaca is still paging after MAX_PAGES, the names
 * asked for are reported missing and nothing is cached: their bars may be cut short. The keys, the page token and the
 * response body are never logged. A cached read from another feed is never served. Throws FeedMisconfigured when
 * ALPACA_FEED is refused (alpaca-feed.ts), before anything else.
 *
 * `opts.feed` is the feed to read (the routes pass the one they checked; the configured one when not given). The rest
 * of `opts` is for the server's desk evaluator only (desk-run.ts, through fetchSettledBars). `minFetchedAt` refetches a cached name read before that instant, so a bar that
 * has just settled is never hidden by a read taken before it had; `timeoutMs` bounds each upstream page.
 */
export async function fetchBars(
  symbols: string[],
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
  halfDay = false,
  opts: { minFetchedAt?: number; timeoutMs?: number; feed?: DataFeed } = {},
): Promise<BarsResponse> {
  const feed = opts.feed ?? requireFeed();
  const t = now.getTime();
  const open = sessionStart(now);
  const bars: Record<string, Bar2[]> = {};
  let cut = new Set<string>();
  if (!open || t < open.ms) return { as_of: now.toISOString(), feed, bars: {}, fetchedAt: {}, missing: [...symbols] };
  const due = symbols.filter((s) => {
    const hit = cache.get(s);
    return !hit || hit.feed !== feed || hit.open !== open.ms || hit.half !== halfDay || cacheDue(hit.at, t) || (opts.minFetchedAt !== undefined && hit.at < opts.minFetchedAt);
  });
  if (due.length > 0) {
    const got: Record<string, Bar2[]> = Object.fromEntries(due.map((s) => [s, []]));
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q: Record<string, string> = { symbols: due.join(","), timeframe: TIMEFRAME, start: open.iso, feed, limit: "10000", adjustment: "raw" };
      if (token) q.page_token = token;
      const res = await fetchImpl(alpacaDataUrl(baseUrl, "/v2/stocks/bars", q), {
        headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      });
      if (!res.ok) {
        logEvent("bars.fetch", { outcome: "http-error", status: res.status });
        throw new UpstreamError(res.status);
      }
      const body = (await res.json()) as { bars?: Record<string, RawBar[]> | null; next_page_token?: unknown };
      for (const [s, list] of Object.entries(body?.bars ?? {})) {
        if (!got[s] || !Array.isArray(list)) continue;
        for (const raw of list) {
          const b = normaliseBar(raw, halfDay);
          if (b && b.start >= open.ms && b.start <= t) got[s]!.push(b);
        }
      }
      token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
      if (!token) break;
    }
    if (token) {
      // Still paging: any of these names may be cut short. Report them missing rather than cache a partial session.
      logEvent("bars.fetch", { outcome: "page-limit", pages: MAX_PAGES, names: due.length });
      for (const s of due) cache.delete(s);
      cut = new Set(due);
    } else {
      for (const s of due) {
        // One slot once, oldest first: a page boundary can repeat a bar.
        const bySlot = new Map(got[s]!.map((b) => [b.start, b]));
        cache.delete(s);
        cache.set(s, { at: t, feed, open: open.ms, half: halfDay, bars: [...bySlot.values()].sort((a, b) => a.start - b.start) });
      }
    }
  }
  const missing: string[] = [];
  const fetchedAt: Record<string, number> = {};
  let oldest = t;
  for (const s of symbols) {
    const hit = cut.has(s) ? undefined : cache.get(s);
    if (hit) oldest = Math.min(oldest, hit.at);
    if (hit && hit.bars.length) {
      bars[s] = hit.bars;
      fetchedAt[s] = hit.at;
    } else missing.push(s);
  }
  prune();
  return { as_of: new Date(oldest).toISOString(), feed, bars, fetchedAt, missing };
}

/**
 * The desk evaluator's read (DEC-0044): the same bars and cache, but `minFetchedAt` is required, so a cached answer
 * read before the slot's settle instant is always fetched again, and every upstream page is bounded by `timeoutMs`.
 */
export function fetchSettledBars(
  symbols: string[],
  keys: { id: string; secret: string },
  now: Date,
  minFetchedAt: number,
  timeoutMs: number,
  halfDay: boolean,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
  /** The feed to read; the configured one (alpaca-feed.ts) when not given. */
  feed?: DataFeed,
): Promise<BarsResponse> {
  return fetchBars(symbols, keys, now, fetchImpl, baseUrl, halfDay, { minFetchedAt, timeoutMs, ...(feed ? { feed } : {}) });
}
