import "server-only";
import { logEvent } from "./log";

// Live prices for the Options page: Alpaca's free IEX feed, read on the server so the browser keeps its
// connect-src 'self' policy and never sees the keys. Research only; nothing here can place an order.

/** One name's live snapshot, normalised from Alpaca's. Prices in US dollars; times ISO 8601. */
export interface Quote {
  price: number;
  /** When the last trade printed. */
  at: string;
  /** The current (or most recent) session's open, high and low on IEX, and its date in New York. */
  open: number | null;
  high: number | null;
  low: number | null;
  day: string | null;
  prev_close: number | null;
}

export interface QuoteResponse {
  as_of: string;
  feed: "iex";
  quotes: Record<string, Quote>;
  /** Symbols asked for that came back without a usable price. */
  missing: string[];
  fixture?: true;
}

/** As many names as one options edition may carry (options.schema.json), so the board never loses a price to the cap. */
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

function nyDay(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(t),
  );
}

type Bar = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown } | null | undefined;
type RawSnapshot = { latestTrade?: { t?: unknown; p?: unknown } | null; dailyBar?: Bar; prevDailyBar?: Bar } | null;

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
  };
}

/** One name's last answer: its quote (null when Alpaca had no usable price) and when it was fetched. */
const cache = new Map<string, { at: number; quote: Quote | null }>();

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
 * Snapshots for `symbols` from Alpaca's IEX feed. Each name is cached for CACHE_MS on its own, so two pages asking
 * for different names share what overlaps instead of evicting each other; only the names past their time go
 * upstream, in one call. `as_of` is the oldest fetch among the names answered. Throws on a transport or HTTP error
 * (the route answers 502) and caches nothing from it; the keys and the response body are never logged.
 */
export async function fetchQuotes(
  symbols: string[],
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
): Promise<QuoteResponse> {
  const t = now.getTime();
  // An entry stamped after `now` (a clock that stepped back) is not trusted either.
  const due = symbols.filter((s) => {
    const hit = cache.get(s);
    return !hit || t < hit.at || t - hit.at >= CACHE_MS;
  });
  if (due.length > 0) {
    const url = `${baseUrl}/v2/stocks/snapshots?symbols=${encodeURIComponent(due.join(","))}&feed=iex`;
    const res = await fetchImpl(url, {
      headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logEvent("quote.fetch", { outcome: "http-error", status: res.status });
      throw new Error(`alpaca ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    // Older API versions nest the map under "snapshots"; current ones return it at the top level.
    const map = (body && typeof body.snapshots === "object" && body.snapshots !== null ? body.snapshots : body) as Record<string, RawSnapshot>;
    for (const s of due) {
      cache.delete(s);
      cache.set(s, { at: t, quote: normalise(map[s] ?? null) });
    }
    prune();
  }
  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];
  let oldest = t;
  for (const s of symbols) {
    // Every asked name was fresh or has just been written; a name pruned in between reads as missing.
    const hit = cache.get(s);
    if (hit) oldest = Math.min(oldest, hit.at);
    if (hit?.quote) quotes[s] = hit.quote;
    else missing.push(s);
  }
  return { as_of: new Date(oldest).toISOString(), feed: "iex", quotes, missing };
}
