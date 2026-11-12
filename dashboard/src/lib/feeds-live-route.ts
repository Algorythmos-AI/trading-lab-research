import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { configuredFeed, type DataFeed, FEED_PLAN_REFUSED, FEED_REFUSED, planRefused } from "./alpaca-feed";
import { presentsBypass } from "./desk-flags-run";
import { feedsFixtureClock, type FeedsFxWord, feedsFxFromCookieHeader, type LiveAnswer, type LiveBar, type LiveRow } from "./feeds-live";
import { flagsFromCookieHeader, FROZEN_NOW } from "./fixture-variants";
import { TRADE_STALE_MS } from "./entry-checks";
import { logEvent } from "./log";
import { nyNow, sessionOf } from "./market-calendar";
import { nyInstant } from "./options";
import type { OptionsEdition } from "./options.types";
import { alpacaKeys, parseSymbols } from "./quote";
import { fixtureMode } from "./snapshot";
import { UpstreamError, upstreamBody, upstreamStatus } from "./upstream";

// GET /api/feeds/live?s=SPY,QQQ: the Feeds page's live section (DEC-0050 point 5). The board's own stock feed only
// (ALPACA_FEED, alpaca-feed.ts): one snapshots read for the names and one read of today's regular-session 2-minute
// bars with volume, both on that feed and both built by alpacaDataUrl, so neither can leave its feed out. Never the
// other feed: IEX is drawn only while it is the board's own feed, and then labelled so.
//
//  * Its own cache, per instance, CACHE_MS long and keyed by feed and names. quote.ts's and bars.ts's caches are never
//    read or written from here.
//  * Signed in only: Vercel Authentication is in front of every path. A request presenting the deployment-protection
//    bypass (the publisher's secret) is refused, as /api/desk/probe does; so is a cross-site one. GET and HEAD only.
//  * 503 while ALPACA_FEED is refused, without keys, or when Alpaca refuses SIP on the plan: the page stops asking.
//    429 for upstream's rate limit, 502 for any other failure. Answers are no-store and carry numbers or null only.
// Advisory and read-only: market data, nothing placed anywhere.

/** One answer is shared on an instance for this long, per feed and set of names. */
export const CACHE_MS = 1_500;
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

const cache = new Map<string, { at: number; body: Omit<LiveAnswer, "served_at"> }>();

/** Test hook: forget this route's cache. */
export function resetFeedsLiveCache(): void {
  cache.clear();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
type Raw = Record<string, unknown> | null | undefined;
const rec = (v: unknown): Raw => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Alpaca's snapshot for one name, as the row's trade and quote: numbers (times as epoch ms) or null. */
export function snapshotRow(raw: unknown): Pick<LiveRow, "trade" | "quote"> {
  const r = rec(raw);
  const t = rec(r?.latestTrade);
  const q = rec(r?.latestQuote);
  return {
    trade: { p: num(t?.p), t: ms(t?.t) },
    quote: { bp: num(q?.bp), bs: num(q?.bs), ap: num(q?.ap), as: num(q?.as), t: ms(q?.t) },
  };
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
  const barsRead = async (): Promise<Record<string, LiveBar[]>> => {
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
    // A cut-short session is not drawn as a whole one.
    if (token) for (const s of symbols) out[s] = [];
    for (const s of symbols) out[s] = [...new Map(out[s]!.map((b) => [b.t, b])).values()].sort((a, b) => a.t! - b.t!);
    return out;
  };
  const [snapRes, bars] = await Promise.all([d.fetch(snapUrl, init), barsRead()]);
  if (!snapRes.ok) throw new UpstreamError(snapRes.status);
  const body = rec(await snapRes.json());
  const map = rec(body?.snapshots) ?? body ?? {};
  const rows: Record<string, LiveRow> = {};
  for (const s of symbols) rows[s] = { ...snapshotRow(map[s]), bars: bars[s] ?? [] };
  return rows;
}

/** Fixture mode: the fixture's closes as prices, a few seconds old, and a made-up session of bars. No network. */
async function fixtureRows(symbols: string[], now: Date, words: ReadonlySet<FeedsFxWord>): Promise<Record<string, LiveRow>> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const e = (mod.default ?? mod) as unknown as OptionsEdition;
  const t = now.getTime();
  const { day } = nyNow(now);
  const s = sessionOf(day);
  const open = s.open !== null ? nyInstant(day, s.open) : null;
  const close = s.close !== null ? nyInstant(day, s.close) : null;
  const rows: Record<string, LiveRow> = {};
  symbols.forEach((sym, i) => {
    const base = e.tickers.find((x) => x.symbol === sym)?.last?.close ?? 100 + 10 * i;
    const stale = words.has("row-stale") && i === symbols.length - 1;
    const tradeAt = stale ? t - TRADE_STALE_MS - 25_000 : t - 3_000 - i * 1_000;
    const price = Math.round(base * 1.002 * 100) / 100;
    const bars: LiveBar[] = [];
    if (open !== null && close !== null && t >= open) {
      const end = Math.min(t, close);
      let c = base;
      for (let at = open, k = 0; at + 120_000 <= end; at += 120_000, k++) {
        const o = c;
        c = Math.round((base * (1 + 0.004 * Math.sin((k + i) / 5))) * 100) / 100;
        const h = Math.max(o, c) + 0.05 * (1 + (k % 3));
        const l = Math.min(o, c) - 0.05 * (1 + ((k + 1) % 3));
        bars.push({ t: at, o, h: Math.round(h * 100) / 100, l: Math.round(l * 100) / 100, c, v: 20_000 + ((k * 7_919 + i * 104_729) % 60_000) });
      }
    }
    rows[sym] = {
      trade: { p: price, t: tradeAt },
      quote: { bp: Math.round((price - 0.01) * 100) / 100, bs: 3, ap: Math.round((price + 0.01) * 100) / 100, as: 4, t: tradeAt + 500 },
      bars,
    };
  });
  return rows;
}

/** GET and HEAD /api/feeds/live?s=SPY,QQQ. */
export async function handleFeedsLive(req: Request, over: Partial<FeedsLiveDeps> = {}): Promise<Response> {
  if (presentsBypass(req)) return json(403, { error: "forbidden" });
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return json(403, { error: "forbidden" });
  const d = { ...defaultFeedsLiveDeps(), ...over };
  const symbols = parseSymbols(new URL(req.url).searchParams.get("s"));
  if (!symbols) return json(400, { error: "give ?s= with one or more ticker symbols" });
  if (symbols.length > MAX_NAMES) return json(400, { error: "too-many-names" });
  const feed = configuredFeed(d.env);
  if (feed === null) return json(503, FEED_REFUSED);
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: NO_STORE });

  if (d.fixture) {
    const cookie = req.headers.get("cookie");
    const flags = flagsFromCookieHeader(cookie);
    if (flags.has("quotes-off")) return json(503, { error: "not-configured" });
    if (flags.has("quotes-error")) return json(502, { error: "upstream" });
    const words = feedsFxFromCookieHeader(cookie);
    const now = feedsFixtureClock(words, flags.has("frozen") ? new Date(FROZEN_NOW) : d.now());
    const answer: LiveAnswer = { feed, as_of: now.toISOString(), served_at: now.toISOString(), rows: await fixtureRows(symbols, now, words), fixture: true };
    return json(200, answer);
  }

  const keys = alpacaKeys(d.env);
  if (!keys) return json(503, { error: "not-configured" });
  const now = d.now();
  const t = now.getTime();
  const key = `${feed}|${symbols.join(",")}`;
  const hit = cache.get(key);
  // An entry stamped after `now` (a clock that stepped back) is not trusted either.
  if (hit && hit.body.feed === feed && t >= hit.at && t - hit.at < CACHE_MS) return json(200, { ...hit.body, served_at: now.toISOString() });
  try {
    const rows = await readUpstream(symbols, feed, keys, now, d);
    const body = { feed, as_of: now.toISOString(), rows };
    cache.delete(key);
    cache.set(key, { at: t, body });
    for (const k of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(k);
    }
    return json(200, { ...body, served_at: now.toISOString() });
  } catch (e) {
    if (planRefused(feed, e)) return json(503, FEED_PLAN_REFUSED);
    logEvent("feeds-live.fetch", { outcome: "error", error: e instanceof UpstreamError ? `status-${e.status}` : e instanceof Error ? e.name : "unknown" });
    const status = upstreamStatus(e);
    return json(status, upstreamBody(status));
  }
}
