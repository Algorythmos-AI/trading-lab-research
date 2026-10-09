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

export const MAX_SYMBOLS = 12;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";
/** Shared by every open tab on an instance: IEX prices barely move in this long, and the free plan is rate-limited. */
export const CACHE_MS = 10_000;

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

let cache: { key: string; at: number; value: QuoteResponse } | null = null;

/** Test hook: forget the shared cache. */
export function resetQuoteCache(): void {
  cache = null;
}

/**
 * Snapshots for `symbols` from Alpaca's IEX feed, cached for CACHE_MS per symbol set. Throws on a transport or
 * HTTP error (the route answers 502); the keys and the response body are never logged.
 */
export async function fetchQuotes(
  symbols: string[],
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
): Promise<QuoteResponse> {
  const key = [...symbols].sort().join(",");
  if (cache && cache.key === key && now.getTime() - cache.at < CACHE_MS) return cache.value;
  const url = `${baseUrl}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(","))}&feed=iex`;
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
  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];
  for (const s of symbols) {
    const q = normalise(map[s] ?? null);
    if (q) quotes[s] = q;
    else missing.push(s);
  }
  const value: QuoteResponse = { as_of: now.toISOString(), feed: "iex", quotes, missing };
  cache = { key, at: now.getTime(), value };
  return value;
}
