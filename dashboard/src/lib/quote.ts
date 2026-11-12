import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { type DataFeed, requireFeed } from "./alpaca-feed";
import { logEvent } from "./log";
import { readBar, readStamp, type SnapshotQuoteFields } from "./quote-guards";
import type { RawSnapshots } from "./quote-probe";
import { quoteShape } from "./quote-shape";
import { UpstreamError } from "./upstream";

// Live prices for the Options page: Alpaca's stock feed (ALPACA_FEED, alpaca-feed.ts; the free IEX one by default),
// read on the server so the browser keeps its connect-src 'self' policy and never sees the keys. Research only;
// nothing here can place an order.

/**
 * One name's live snapshot, normalised from Alpaca's. Prices in US dollars; times ISO 8601. The optional fields
 * (quote-guards.ts SnapshotQuoteFields) are what the board's bad-data guards read: the quote's two sides and whether
 * the day's and the prior day's bars are readable as the snapshot probe reads them.
 */
export interface Quote extends SnapshotQuoteFields {
  price: number;
  /** When the last trade printed. */
  at: string;
  /** The current (or most recent) session's open, high and low on the feed, and its date in New York. */
  open: number | null;
  high: number | null;
  low: number | null;
  day: string | null;
  prev_close: number | null;
  /** The session's volume-weighted average price so far on the feed (the day bar's `vw`), or null when Alpaca gives none. */
  vwap: number | null;
}

export interface QuoteResponse {
  as_of: string;
  /** The feed these prices were read from: what the page names, never a constant of its own. */
  feed: DataFeed;
  quotes: Record<string, Quote>;
  /** Symbols asked for that came back without a usable price. */
  missing: string[];
  fixture?: true;
}

/** As many names as one options edition may carry (options.schema.json; a test holds the two equal), so the board never loses a price to the cap. */
export const MAX_SYMBOLS = 60;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";
/** Each name's answer is shared on one instance for this long, just under the page's 2-second poll; the free plan allows 200 calls a minute. */
export const CACHE_MS = 1_500;
/** Names remembered at once. Far above what the pages ask for; a bound, so a stream of odd symbols cannot grow the cache. */
export const MAX_CACHED = 256;

/** The symbols from `?s=SPY,QQQ`: upper-cased, valid, unique, at most MAX_SYMBOLS. Null when none are valid. */
export function parseSymbols(raw: string | null): string[] | null {
  if (!raw) return null;
  const out = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()))].filter((s) => SYMBOL.test(s));
  return out.length > 0 ? out.slice(0, MAX_SYMBOLS) : null;
}

/** The Alpaca keys from ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY, or Alpaca's own APCA_API_KEY_ID / APCA_API_SECRET_KEY. */
export function alpacaKeys(env: Record<string, string | undefined> = process.env): { id: string; secret: string } | null {
  const pairs: [string | undefined, string | undefined][] = [
    [env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY],
    [env.APCA_API_KEY_ID, env.APCA_API_SECRET_KEY],
  ];
  for (const [id, secret] of pairs) if (id && secret) return { id, secret };
  return null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function nyDay(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return NY_DAY_FMT.format(new Date(t));
}

type Bar = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; vw?: unknown } | null | undefined;
type RawQuote = { t?: unknown; bp?: unknown; ap?: unknown; bs?: unknown; as?: unknown } | null | undefined;
type RawSnapshot = { latestTrade?: { t?: unknown; p?: unknown } | null; latestQuote?: RawQuote; dailyBar?: Bar; prevDailyBar?: Bar } | null;

/**
 * The snapshot's quote as the guards read it: its two sides only when quote-shape.ts can read them (an object whose
 * prices and sizes are not "invalid"), each size only when Alpaca sent one, and its time only when readable. Nothing
 * otherwise, so an unreadable quote can never trip a guard.
 */
function quoteSides(q: RawQuote): Pick<SnapshotQuoteFields, "bid" | "ask" | "bid_size" | "ask_size" | "quote_at"> {
  if (q === null || typeof q !== "object" || Array.isArray(q)) return {};
  if (quoteShape(q.bp, q.ap, q.bs, q.as).shape === "invalid") return {};
  const t = readStamp(q.t).t;
  return {
    bid: q.bp as number,
    ask: q.ap as number,
    ...(isNum(q.bs) ? { bid_size: q.bs } : {}),
    ...(isNum(q.as) ? { ask_size: q.as } : {}),
    ...(t !== null ? { quote_at: new Date(t).toISOString() } : {}),
  };
}

/** Alpaca's snapshot -> Quote, or null without a usable last trade. Unknown fields are ignored. */
export function normalise(raw: RawSnapshot): Quote | null {
  const trade = raw?.latestTrade;
  if (!trade || !isNum(trade.p) || trade.p <= 0 || typeof trade.t !== "string" || !Number.isFinite(Date.parse(trade.t))) return null;
  const d = raw?.dailyBar;
  const p = raw?.prevDailyBar;
  return {
    price: trade.p,
    at: new Date(Date.parse(trade.t)).toISOString(),
    open: isNum(d?.o) ? d.o : null,
    high: isNum(d?.h) ? d.h : null,
    low: isNum(d?.l) ? d.l : null,
    day: nyDay(d?.t),
    prev_close: isNum(p?.c) ? p.c : null,
    vwap: isNum(d?.vw) && d.vw > 0 ? d.vw : null,
    // For the guards (quote-guards.ts): the bars as the probe reads them, and the quote's sides.
    bar_ok: readBar(d).presence === "ok",
    prev_bar_ok: readBar(p).presence === "ok",
    ...quoteSides(raw?.latestQuote),
  };
}

/** One name's last answer: its quote (null when Alpaca had no usable price), when it was fetched, and from which feed. */
const cache = new Map<string, { at: number; feed: DataFeed; quote: Quote | null }>();

/** Test hook: forget the shared cache. */
export function resetQuoteCache(): void {
  cache.clear();
}

/** Drop the oldest names beyond MAX_CACHED. A Map iterates in insertion order, and a refreshed name is re-inserted. */
function prune(): void {
  for (const s of cache.keys()) {
    if (cache.size <= MAX_CACHED) return;
    cache.delete(s);
  }
}

/**
 * Snapshots for `symbols` from the configured Alpaca feed (or `opts.feed`). Each name is cached for CACHE_MS on its
 * own, so two pages asking for different names share what overlaps instead of evicting each other; only the names
 * past their time go upstream, in one call. `as_of` is the oldest fetch among the names answered. Throws on a transport or HTTP error
 * (the route answers 502) and caches nothing from it; the keys and the response body are never logged. A cached
 * answer from another feed is never served. Throws FeedMisconfigured when ALPACA_FEED is refused (alpaca-feed.ts).
 */
export async function fetchQuotes(
  symbols: string[],
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
  /**
   * For the server's desk evaluator only: a tighter bound on the upstream call, and `onRaw`, which is handed the raw
   * snapshot of each name this call fetched (not the cached ones) for the log-only probe (quote-probe.ts). It runs
   * after the cache is written; whatever it does or throws, the answer and the cache are the same. The page's route passes none.
   */
  opts: { timeoutMs?: number; feed?: DataFeed; onRaw?: (raw: RawSnapshots) => void } = {},
): Promise<QuoteResponse> {
  const feed = opts.feed ?? requireFeed();
  const t = now.getTime();
  // An entry stamped after `now` (a clock that stepped back) is not trusted either.
  const due = symbols.filter((s) => {
    const hit = cache.get(s);
    return !hit || hit.feed !== feed || t < hit.at || t - hit.at >= CACHE_MS;
  });
  if (due.length > 0) {
    const url = alpacaDataUrl(baseUrl, "/v2/stocks/snapshots", { symbols: due.join(","), feed });
    const res = await fetchImpl(url, {
      headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) {
      logEvent("quote.fetch", { outcome: "http-error", status: res.status });
      throw new UpstreamError(res.status);
    }
    const body = (await res.json()) as Record<string, unknown>;
    // Older API versions nest the map under "snapshots"; current ones return it at the top level.
    const map = (body && typeof body.snapshots === "object" && body.snapshots !== null ? body.snapshots : body) as Record<string, RawSnapshot>;
    for (const s of due) {
      cache.delete(s);
      cache.set(s, { at: t, feed, quote: normalise(map[s] ?? null) });
    }
    if (opts.onRaw) {
      try {
        const fetched: Record<string, unknown> = {};
        // A name Alpaca left out of its answer is handed over as null: fetched, with no snapshot.
        for (const s of due) fetched[s] = Object.hasOwn(map, s) ? map[s] : null;
        opts.onRaw({ fetched, at: t, rate: { limit: res.headers.get("x-ratelimit-limit"), remaining: res.headers.get("x-ratelimit-remaining") } });
      } catch {
        // The probe is log-only: its failure never touches the answer.
      }
    }
  }
  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];
  let oldest = t;
  for (const s of symbols) {
    // Every asked name was fresh or has just been written.
    const hit = cache.get(s);
    if (hit) oldest = Math.min(oldest, hit.at);
    if (hit?.quote) quotes[s] = hit.quote;
    else missing.push(s);
  }
  // Only after the answer is read: pruning first could drop a fresh name this answer still needs.
  prune();
  return { as_of: new Date(oldest).toISOString(), feed, quotes, missing };
}
