import "server-only";
import { logEvent } from "./log";
import { closeMinute, nyClock, nyInstant, OPEN_MIN } from "./options";
import type { Bar2 } from "./trade-state";

// The session's 2-minute bars for the Options page's "Trade now" board: Alpaca's free IEX feed, read on the server so
// the browser keeps its connect-src 'self' policy and never sees the keys. Research only; nothing here can place an
// order. The page polls every 30 s; between polls its own 2-second prices fill in the newest bar.

export interface BarsResponse {
  as_of: string;
  feed: "iex";
  /** Today's regular-session 2-minute bars per name, oldest first; the bar still forming may be last. */
  bars: Record<string, Bar2[]>;
  /** Symbols asked for that came back with no bars. */
  missing: string[];
  fixture?: true;
}

const DEFAULT_DATA_URL = "https://data.alpaca.markets";
const BAR_MS = 2 * 60_000;
/** Each name's bars are shared on one instance for this long; the page polls every 30 s. */
export const BARS_CACHE_MS = 10_000;
/** Names remembered at once: a bound, so a stream of odd symbols cannot grow the cache. */
export const MAX_CACHED_BARS = 64;
/** Pages read for one answer at most. Alpaca pages early; a session of 2-minute bars for 60 names is under 12,000. */
export const MAX_PAGES = 20;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type RawBar = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown } | null | undefined;

/** One Alpaca bar -> Bar2, or null when it is unusable or outside the regular session of its own New York day. */
export function normaliseBar(raw: RawBar): Bar2 | null {
  if (!raw || typeof raw.t !== "string") return null;
  const start = Date.parse(raw.t);
  const { o, h, l, c } = raw;
  if (!Number.isFinite(start) || !isNum(o) || !isNum(h) || !isNum(l) || !isNum(c) || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  const clock = nyClock(new Date(start).toISOString());
  if (!clock || clock.minutes < OPEN_MIN || clock.minutes >= closeMinute(false)) return null;
  return { start, end: start + BAR_MS, o, h, l, c };
}

/** The ISO instant of today's 09:30 New York, and whether `now` is past it. */
export function sessionStart(now: Date): { iso: string; ms: number } | null {
  const c = nyClock(now.toISOString());
  if (!c) return null;
  const ms = nyInstant(c.day, OPEN_MIN);
  return ms === null ? null : { iso: new Date(ms).toISOString(), ms };
}

const cache = new Map<string, { at: number; open: number; bars: Bar2[] }>();

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
 * Today's regular-session 2-minute bars for `symbols` from Alpaca's IEX feed, every `next_page_token` page read.
 * Before 09:30 New York there is nothing to ask for, and nothing goes upstream. Each name is cached for
 * BARS_CACHE_MS on its own. Throws on a transport or HTTP error (the route answers 502) and caches nothing from it;
 * the keys and the response body are never logged.
 */
export async function fetchBars(
  symbols: string[],
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
): Promise<BarsResponse> {
  const t = now.getTime();
  const open = sessionStart(now);
  const bars: Record<string, Bar2[]> = {};
  if (!open || t < open.ms) return { as_of: now.toISOString(), feed: "iex", bars: {}, missing: [...symbols] };
  const due = symbols.filter((s) => {
    const hit = cache.get(s);
    return !hit || hit.open !== open.ms || t < hit.at || t - hit.at >= BARS_CACHE_MS;
  });
  if (due.length > 0) {
    const got: Record<string, Bar2[]> = Object.fromEntries(due.map((s) => [s, []]));
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ symbols: due.join(","), timeframe: "2Min", start: open.iso, feed: "iex", limit: "10000", adjustment: "raw" });
      if (token) q.set("page_token", token);
      const res = await fetchImpl(`${baseUrl}/v2/stocks/bars?${q.toString()}`, {
        headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        logEvent("bars.fetch", { outcome: "http-error", status: res.status });
        throw new Error(`alpaca ${res.status}`);
      }
      const body = (await res.json()) as { bars?: Record<string, RawBar[]> | null; next_page_token?: unknown };
      for (const [s, list] of Object.entries(body?.bars ?? {})) {
        if (!got[s] || !Array.isArray(list)) continue;
        for (const raw of list) {
          const b = normaliseBar(raw);
          if (b && b.start >= open.ms && b.start <= t) got[s]!.push(b);
        }
      }
      token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
      if (!token) break;
    }
    for (const s of due) {
      // One slot once, oldest first: a page boundary can repeat a bar.
      const bySlot = new Map(got[s]!.map((b) => [b.start, b]));
      cache.delete(s);
      cache.set(s, { at: t, open: open.ms, bars: [...bySlot.values()].sort((a, b) => a.start - b.start) });
    }
  }
  const missing: string[] = [];
  let oldest = t;
  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit) oldest = Math.min(oldest, hit.at);
    if (hit && hit.bars.length) bars[s] = hit.bars;
    else missing.push(s);
  }
  prune();
  return { as_of: new Date(oldest).toISOString(), feed: "iex", bars, missing };
}
