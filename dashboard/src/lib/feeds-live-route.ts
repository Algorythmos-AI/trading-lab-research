import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { configuredFeed, type DataFeed, FEED_PLAN_REFUSED, FEED_REFUSED, planRefused } from "./alpaca-feed";
import { presentsBypass } from "./desk-flags-run";
import { feedsFixtureClock, feedsFxFromCookieHeader, type LiveAnswer, type LiveBar, type LiveRow } from "./feeds-live";
import { flagsFromCookieHeader, FROZEN_NOW } from "./fixture-variants";
import { logEvent } from "./log";
import { nyNow, sessionOf } from "./market-calendar";
import { nyInstant } from "./options";
import { alpacaKeys, parseSymbols } from "./quote";
import { fixtureMode } from "./snapshot";
import { UpstreamError, upstreamBody, upstreamStatus } from "./upstream";

// GET /api/feeds/live?s=SPY,QQQ: what the Feeds page shows beside the board's own live prices (DEC-0050 point 5) and
// the board does not carry: the top of the book (bid, ask, sizes, the quote's time) and today's regular-session
// 2-minute bars with volume. The price and the last trade come from /api/quote, the board's own source, never from
// here. The board's own stock feed only (ALPACA_FEED, alpaca-feed.ts): one snapshots read and one bars read, both on
// that feed and both built by alpacaDataUrl, so neither can leave its feed out.
//
//  * Its own cache, per instance, CACHE_MS long (the page's poll) and keyed by feed and the sorted names, and one
//    upstream read in flight per key: concurrent misses share it. quote.ts's and bars.ts's caches are never read or
//    written from here. Budget: at most 2 upstream calls per key per CACHE_MS on an instance (bars: up to
//    MAX_BAR_PAGES pages, one in practice; none before the open).
//  * Signed in only: Vercel Authentication is in front of every path. A request presenting the deployment-protection
//    bypass (the publisher's secret) is refused, as /api/desk/probe does; so is a cross-site one. GET and HEAD only,
//    and HEAD gives the same refusals as GET, without reading upstream.
//  * 503 while ALPACA_FEED is refused, without keys, or when Alpaca refuses SIP on the plan: the page stops asking.
//    429 for upstream's rate limit, 502 for any other failure. Answers are no-store and carry numbers or null only.
//  * A bars read still paging after MAX_BAR_PAGES answers bars null for every name ("cut short"), never a partial day.
// Advisory and read-only: market data, nothing placed anywhere.

/** One answer is shared on an instance for this long, per feed and set of names: the page's 5 s poll. */
export const CACHE_MS = 5_000;
/** Answers remembered at once (a bound). */
export const MAX_CACHED = 16;
/** Names in one request at most: the four focus names, SPY and room to spare. */
export const MAX_NAMES = 8;
/** Bar pages read for one answer at most; a session of 2-minute bars for eight names is one page. */
export const MAX_BAR_PAGES = 4;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";
const NO_STORE = { "cache-control": "no-store" } as const;

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

export interface FeedsLiveDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  baseUrl: string;
  fixture: boolean;
}

/** Alpaca's market-data host, or ALPACA_DATA_URL when set (a function, so the deps object is not itself a URL). */
function dataBase(): string {
  return process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL;
}

export const defaultFeedsLiveDeps = (): FeedsLiveDeps => ({
  env: process.env,
  fetch,
  now: () => new Date(),
  baseUrl: dataBase(),
  fixture: fixtureMode(),
});

type Body = Omit<LiveAnswer, "served_at">;
const cache = new Map<string, { at: number; body: Body }>();
const inFlight = new Map<string, Promise<Body>>();

/** Test hook: forget this route's cache and anything in flight. */
export function resetFeedsLiveCache(): void {
  cache.clear();
  inFlight.clear();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
type Raw = Record<string, unknown> | null | undefined;
const rec = (v: unknown): Raw => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Alpaca's snapshot for one name, as the row's quote: numbers (the time as epoch ms) or null. */
export function snapshotQuote(raw: unknown): LiveRow["quote"] {
  const q = rec(rec(raw)?.latestQuote);
  return { bp: num(q?.bp), bs: num(q?.bs), ap: num(q?.ap), as: num(q?.as), t: ms(q?.t) };
}

/** One Alpaca bar as a LiveBar, or null when its start cannot be read or lies outside [open, close). */
export function liveBar(raw: unknown, open: number, close: number): LiveBar | null {
  const b = rec(raw);
  const t = ms(b?.t);
  if (t === null || t < open || t >= close) return null;
  return { t, o: num(b?.o), h: num(b?.h), l: num(b?.l), c: num(b?.c), v: num(b?.v) };
}

/** Today's regular session as instants, when `now` is on a session day at or past its open; else null. */
export function sessionWindow(now: Date): { open: number; close: number } | null {
  const { day } = nyNow(now);
  const s = sessionOf(day);
  if (s.open === null || s.close === null) return null;
  const open = nyInstant(day, s.open);
  const close = nyInstant(day, s.close);
  if (open === null || close === null || now.getTime() < open) return null;
  return { open, close };
}

const headers = (keys: { id: string; secret: string }) => ({ "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" });

async function readUpstream(symbols: string[], feed: DataFeed, keys: { id: string; secret: string }, now: Date, d: FeedsLiveDeps): Promise<Record<string, LiveRow>> {
  const init = { headers: headers(keys), cache: "no-store" as const, signal: AbortSignal.timeout(6_000) };
  const snapUrl = alpacaDataUrl(d.baseUrl, "/v2/stocks/snapshots", { symbols: symbols.join(","), feed });
  const win = sessionWindow(now);
  const barsRead = async (): Promise<Record<string, LiveBar[]> | null> => {
    const out: Record<string, LiveBar[]> = Object.fromEntries(symbols.map((s) => [s, []]));
    if (!win) return out;
    let token: string | null = null;
    for (let page = 0; page < MAX_BAR_PAGES; page++) {
      const q: Record<string, string> = { symbols: symbols.join(","), timeframe: "2Min", start: new Date(win.open).toISOString(), feed, limit: "10000", adjustment: "raw" };
      if (token) q.page_token = token;
      const res = await d.fetch(alpacaDataUrl(d.baseUrl, "/v2/stocks/bars", q), init);
      if (!res.ok) throw new UpstreamError(res.status);
      const body = rec(await res.json());
      for (const [s, list] of Object.entries(rec(body?.bars) ?? {})) {
        if (!out[s] || !Array.isArray(list)) continue;
        for (const raw of list) {
          const b = liveBar(raw, win.open, win.close);
          if (b) out[s]!.push(b);
        }
      }
      token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
      if (!token) break;
    }
    // Still paging: a cut-short session is never drawn as a whole one.
    if (token) {
      logEvent("feeds-live.fetch", { outcome: "page-limit", pages: MAX_BAR_PAGES, names: symbols.length });
      return null;
    }
    for (const s of symbols) out[s] = [...new Map(out[s]!.map((b) => [b.t, b])).values()].sort((a, b) => a.t! - b.t!);
    return out;
  };
  const [snapRes, bars] = await Promise.all([d.fetch(snapUrl, init), barsRead()]);
  if (!snapRes.ok) throw new UpstreamError(snapRes.status);
  const body = rec(await snapRes.json());
  const map = rec(body?.snapshots) ?? body ?? {};
  const rows: Record<string, LiveRow> = {};
  for (const s of symbols) rows[s] = { quote: snapshotQuote(map[s]), bars: bars ? (bars[s] ?? []) : null };
  return rows;
}

/** Fixture prices: about the fixture edition's closes, inlined so nothing under test/ is read from here. */
const FIXTURE_BASE: Readonly<Record<string, number>> = { SPY: 778.55, QQQ: 751.24, AAPL: 336.62, MSFT: 535.08, NVDA: 229.36, SMH: 330 };

/** Fixture mode: a quote a few seconds old and a made-up session of bars. No network. */
export function fixtureRows(symbols: string[], now: Date): Record<string, LiveRow> {
  const t = now.getTime();
  const { day } = nyNow(now);
  const s = sessionOf(day);
  const open = s.open !== null ? nyInstant(day, s.open) : null;
  const close = s.close !== null ? nyInstant(day, s.close) : null;
  const rows: Record<string, LiveRow> = {};
  symbols.forEach((sym, i) => {
    const base = FIXTURE_BASE[sym] ?? 100 + 10 * i;
    const bars: LiveBar[] = [];
    if (open !== null && close !== null && t >= open) {
      const end = Math.min(t, close);
      let c = base;
      // Every bar that has started, the last one still forming while the session runs.
      for (let at = open, k = 0; at < end; at += 120_000, k++) {
        const o = c;
        c = Math.round(base * (1 + 0.004 * Math.sin((k + i) / 5)) * 100) / 100;
        const h = Math.max(o, c) + 0.05 * (1 + (k % 3));
        const l = Math.min(o, c) - 0.05 * (1 + ((k + 1) % 3));
        bars.push({ t: at, o, h: Math.round(h * 100) / 100, l: Math.round(l * 100) / 100, c, v: 20_000 + ((k * 7_919 + i * 104_729) % 60_000) });
      }
    }
    rows[sym] = { quote: { bp: Math.round((base - 0.01) * 100) / 100, bs: 3, ap: Math.round((base + 0.01) * 100) / 100, as: 4, t: t - 2_500 - i * 500 }, bars };
  });
  return rows;
}

/** The answer for a key: the cache when young enough, else one upstream read shared by every request waiting on it. */
async function answerFor(key: string, symbols: string[], feed: DataFeed, keys: { id: string; secret: string }, now: Date, d: FeedsLiveDeps): Promise<Body> {
  const t = now.getTime();
  const hit = cache.get(key);
  // An entry stamped after `now` (a clock that stepped back) is not trusted either.
  if (hit && hit.body.feed === feed && t >= hit.at && t - hit.at < CACHE_MS) return hit.body;
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    const body: Body = { feed, as_of: now.toISOString(), rows: await readUpstream(symbols, feed, keys, now, d) };
    cache.delete(key);
    cache.set(key, { at: t, body });
    for (const k of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(k);
    }
    return body;
  })();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    if (inFlight.get(key) === p) inFlight.delete(key);
  }
}

/** GET and HEAD /api/feeds/live?s=SPY,QQQ. */
export async function handleFeedsLive(req: Request, over: Partial<FeedsLiveDeps> = {}): Promise<Response> {
  if (presentsBypass(req)) return json(403, { error: "forbidden" });
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return json(403, { error: "forbidden" });
  const d = { ...defaultFeedsLiveDeps(), ...over };
  const head = req.method === "HEAD";
  // HEAD: the same status and headers as GET would give, without a body and without reading upstream.
  const answer = (status: number, body: unknown): Response => (head ? new Response(null, { status, headers: NO_STORE }) : json(status, body));
  const parsed = parseSymbols(new URL(req.url).searchParams.get("s"));
  if (!parsed) return answer(400, { error: "give ?s= with one or more ticker symbols" });
  if (parsed.length > MAX_NAMES) return answer(400, { error: "too-many-names" });
  const symbols = [...new Set(parsed)].sort();
  const feed = configuredFeed(d.env);
  if (feed === null) return answer(503, FEED_REFUSED);

  if (d.fixture) {
    const cookie = req.headers.get("cookie");
    const flags = flagsFromCookieHeader(cookie);
    if (flags.has("quotes-off")) return answer(503, { error: "not-configured" });
    if (flags.has("quotes-error")) return answer(502, { error: "upstream" });
    if (head) return answer(200, null);
    const now = feedsFixtureClock(feedsFxFromCookieHeader(cookie), flags.has("frozen") ? new Date(FROZEN_NOW) : d.now());
    const out: LiveAnswer = { feed, as_of: now.toISOString(), served_at: now.toISOString(), rows: fixtureRows(symbols, now), fixture: true };
    return json(200, out);
  }

  const keys = alpacaKeys(d.env);
  if (!keys) return answer(503, { error: "not-configured" });
  if (head) return answer(200, null);
  const now = d.now();
  try {
    const body = await answerFor(`${feed}|${symbols.join(",")}`, symbols, feed, keys, now, d);
    return json(200, { ...body, served_at: d.now().toISOString() });
  } catch (e) {
    if (planRefused(feed, e)) return json(503, FEED_PLAN_REFUSED);
    logEvent("feeds-live.fetch", { outcome: "error", error: e instanceof UpstreamError ? `status-${e.status}` : e instanceof Error ? e.name : "unknown" });
    const status = upstreamStatus(e);
    return json(status, upstreamBody(status));
  }
}
