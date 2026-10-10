import "server-only";
import { logEvent } from "./log";

// Option quotes for the Options desk's contract pane: Alpaca's indicative feed, which is 15 minutes behind the
// market, read on the server so the browser keeps its connect-src 'self' policy and never sees the keys. Market
// data only; nothing here can place an order or read an account.

/** One call or put, normalised from Alpaca's snapshot. Prices per share in US dollars; `at` is the quote's time. */
export interface ChainContract {
  kind: "call" | "put";
  strike: number;
  /** Null when the feed gave none. A bid of 0 is kept: it is a real quote for an option nobody will pay for. */
  bid: number | null;
  ask: number | null;
  last: number | null;
  at: string | null;
  /** Annualised, as a fraction. Alpaca gives none for a few contracts; the page then works one out or leaves a dash. */
  iv: number | null;
  delta: number | null;
  /** Contracts traded in the current (or most recent) session. */
  volume: number | null;
}

export interface ChainExpiry {
  /** The expiration date, YYYY-MM-DD. Options stop trading at that day's New York close. */
  date: string;
  contracts: ChainContract[];
}

export interface ChainResponse {
  as_of: string;
  feed: "indicative";
  /** How far behind the market the feed runs, in minutes. */
  delay_min: number;
  symbol: string;
  expiries: ChainExpiry[];
  fixture?: true;
}

export const CHAIN_DELAY_MIN = 15;
/** A name's chain is shared on one instance for this long. The feed itself is 15 minutes behind, so sooner buys nothing. */
export const CHAIN_CACHE_MS = 20_000;
/** Names remembered at once: a bound, so a stream of odd symbols cannot grow the cache. */
export const CHAIN_MAX_CACHED = 64;
/** Expiries offered: the nearest few for same-day and next-day trades, and one a fortnight or more out for a swing. */
export const NEAR_EXPIRIES = 4;
export const SWING_MIN_DAYS = 14;
/** Strikes offered per expiry: the ones nearest the stock's price. */
export const STRIKES_PER_EXPIRY = 21;
/** How far either side of the price the strikes are asked for, as a fraction of it. */
const STRIKE_WINDOW = 0.05;
const NEAR_DAYS = 8;
const FAR_DAYS = 24;
const MAX_PAGES = 3;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";
const DAY_MS = 86_400_000;

/** The one symbol from `?s=SPY`: upper-cased and valid, or null. */
export function parseSymbol(raw: string | null): string | null {
  const s = (raw ?? "").trim().toUpperCase();
  return SYMBOL.test(s) ? s : null;
}

/** The price the strikes are chosen around, from `?px=780.43`: a positive number under a million, or null. */
export function parsePrice(raw: string | null): number | null {
  if (raw === null || !/^\d{1,6}(\.\d{1,4})?$/.test(raw.trim())) return null;
  const px = Number(raw);
  return px > 0 ? px : null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const price = (v: unknown): number | null => (isNum(v) && v >= 0 ? v : null);

/** The date in New York at `at`, YYYY-MM-DD. */
export function nyDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** `days` calendar days after a YYYY-MM-DD date. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A standard contract's parts from its OCC symbol (`SPY261019P00760000`), or null. The root must be the name
 * itself: a contract adjusted for a split or a merger trades under another root (`SPY1…`) and delivers something
 * other than 100 shares, so it is left out here and never reaches the page.
 */
export function parseOcc(occ: string, symbol: string): { expiry: string; kind: "call" | "put"; strike: number } | null {
  const root = symbol.replace(/\./g, "");
  if (!occ.startsWith(root)) return null;
  const m = /^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ.slice(root.length));
  if (!m) return null;
  const expiry = `20${m[1]}-${m[2]}-${m[3]}`;
  // A month 13 does not parse at all; a 31 June parses as 1 July. Neither is a date.
  const parsed = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== expiry) return null;
  const strike = Number(m[5]) / 1000;
  return strike > 0 ? { expiry, kind: m[4] === "C" ? "call" : "put", strike } : null;
}

type RawSnapshot = {
  latestQuote?: { bp?: unknown; ap?: unknown; t?: unknown } | null;
  latestTrade?: { p?: unknown } | null;
  greeks?: { delta?: unknown } | null;
  impliedVolatility?: unknown;
  dailyBar?: { v?: unknown } | null;
} | null;

/** Alpaca's option snapshot -> ChainContract. Unknown fields are ignored; anything unusable becomes null. */
export function normaliseContract(kind: "call" | "put", strike: number, raw: RawSnapshot): ChainContract {
  const q = raw?.latestQuote;
  const t = typeof q?.t === "string" ? Date.parse(q.t) : NaN;
  const iv = raw?.impliedVolatility;
  const delta = raw?.greeks?.delta;
  const last = price(raw?.latestTrade?.p);
  return {
    kind,
    strike,
    bid: price(q?.bp),
    ask: price(q?.ap),
    last: last !== null && last > 0 ? last : null,
    at: Number.isFinite(t) ? new Date(t).toISOString() : null,
    iv: isNum(iv) && iv > 0 && iv < 20 ? iv : null,
    delta: isNum(delta) && Math.abs(delta) <= 1 ? delta : null,
    volume: isNum(raw?.dailyBar?.v) && raw.dailyBar.v >= 0 ? raw.dailyBar.v : null,
  };
}

/**
 * What the page is offered from everything Alpaca returned: the nearest few expiries that have not passed, plus the
 * first one a fortnight or more out, each with the strikes nearest the stock's price. Calls before puts, strikes
 * rising, expiries rising.
 */
export function selectChain(snapshots: Record<string, RawSnapshot>, symbol: string, px: number, today: string): ChainExpiry[] {
  const byExpiry = new Map<string, Map<number, { call?: ChainContract; put?: ChainContract }>>();
  for (const [occ, raw] of Object.entries(snapshots)) {
    const parts = parseOcc(occ, symbol);
    if (!parts || parts.expiry < today) continue;
    const strikes = byExpiry.get(parts.expiry) ?? new Map<number, { call?: ChainContract; put?: ChainContract }>();
    byExpiry.set(parts.expiry, strikes);
    const pair = strikes.get(parts.strike) ?? {};
    strikes.set(parts.strike, pair);
    pair[parts.kind] = normaliseContract(parts.kind, parts.strike, raw);
  }
  const dates = [...byExpiry.keys()].sort();
  const keep = dates.slice(0, NEAR_EXPIRIES);
  const swing = dates.find((d) => d >= addDays(today, SWING_MIN_DAYS));
  if (swing && !keep.includes(swing)) keep.push(swing);
  return keep.map((date) => {
    const strikes = byExpiry.get(date)!;
    const nearest = [...strikes.keys()]
      .sort((a, b) => Math.abs(a - px) - Math.abs(b - px) || a - b)
      .slice(0, STRIKES_PER_EXPIRY)
      .sort((a, b) => a - b);
    const contracts: ChainContract[] = [];
    for (const kind of ["call", "put"] as const) for (const k of nearest) if (strikes.get(k)![kind]) contracts.push(strikes.get(k)![kind]!);
    return { date, contracts };
  });
}

/** One name's last answer: what was offered, the price it was chosen around, and when it was fetched. */
const cache = new Map<string, { at: number; px: number; expiries: ChainExpiry[] }>();

/** Test hook: forget the shared cache. */
export function resetChainCache(): void {
  cache.clear();
}

async function page(
  symbol: string,
  query: Record<string, string>,
  keys: { id: string; secret: string },
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<Record<string, RawSnapshot>> {
  const out: Record<string, RawSnapshot> = {};
  let token: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({ feed: "indicative", limit: "1000", ...query });
    if (token) params.set("page_token", token);
    const res = await fetchImpl(`${baseUrl}/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?${params}`, {
      headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logEvent("chain.fetch", { outcome: "http-error", status: res.status });
      throw new Error(`alpaca ${res.status}`);
    }
    const body = (await res.json()) as { snapshots?: unknown; next_page_token?: unknown };
    if (body && typeof body.snapshots === "object" && body.snapshots !== null) Object.assign(out, body.snapshots as Record<string, RawSnapshot>);
    token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token) break;
  }
  return out;
}

/**
 * The option chain for `symbol` around `px`, from Alpaca's indicative feed. Two calls upstream: the expiries of the
 * coming week, and those a fortnight to three weeks out. The answer is shared for CHAIN_CACHE_MS, unless the price
 * asked around has moved more than a percent since. Throws on a transport or HTTP error (the route answers 502)
 * and caches nothing from it; the keys and the response body are never logged.
 */
export async function fetchChain(
  symbol: string,
  px: number,
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
): Promise<ChainResponse> {
  const t = now.getTime();
  const hit = cache.get(symbol);
  // An entry stamped after `now` (a clock that stepped back) is not trusted either.
  const fresh = hit && t >= hit.at && t - hit.at < CHAIN_CACHE_MS && Math.abs(hit.px - px) <= 0.01 * px;
  if (!fresh) {
    const today = nyDate(now);
    const strikes = { strike_price_gte: (px * (1 - STRIKE_WINDOW)).toFixed(2), strike_price_lte: (px * (1 + STRIKE_WINDOW)).toFixed(2) };
    const [near, far] = await Promise.all([
      page(symbol, { ...strikes, expiration_date_gte: today, expiration_date_lte: addDays(today, NEAR_DAYS) }, keys, fetchImpl, baseUrl),
      page(symbol, { ...strikes, expiration_date_gte: addDays(today, SWING_MIN_DAYS), expiration_date_lte: addDays(today, FAR_DAYS) }, keys, fetchImpl, baseUrl),
    ]);
    cache.delete(symbol);
    cache.set(symbol, { at: t, px, expiries: selectChain({ ...near, ...far }, symbol, px, today) });
    // A Map iterates in insertion order, and a refreshed name was just re-inserted: the first keys are the oldest.
    for (const s of cache.keys()) {
      if (cache.size <= CHAIN_MAX_CACHED) break;
      cache.delete(s);
    }
  }
  const entry = cache.get(symbol)!;
  return { as_of: new Date(entry.at).toISOString(), feed: "indicative", delay_min: CHAIN_DELAY_MIN, symbol, expiries: entry.expiries };
}
