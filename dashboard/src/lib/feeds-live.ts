// The Feeds page's live section (/options/feeds, DEC-0050 point 5): the board's own stock feed only, per focus name
// plus SPY. Pure and safe in the browser: no I/O, and the clock is always passed in.
//
// Two sources, never mixed up:
//  * the price, the last trade's time, the feed's name and the stale verdict come from the board's own live quotes
//    (live-layer.tsx LiveQuotes, /api/quote): the verdict is options.ts liveRead, the read behind the board's per-name
//    state chip, and the age is feedAges with the session, as the board's own line reads it;
//  * the top of the book (bid, ask, sizes, the quote's time) and the session's 2-minute bars with volume, which the
//    board does not carry, come from /api/feeds/live every 5 s. Their ages are on the server's clock carried forward by
//    the monotonic clock (serverClock), never the device's wall clock.
// After the tab was hidden (or the timers stood still) neither clock is trusted until a new answer comes (`slept`).
import { TRADE_STALE_MS } from "./entry-checks";
import { ageStale, ageText, feedLabel } from "./feed-provenance";
import type { LiveRead } from "./options";

export { TRADE_STALE_MS };

/** One 2-minute bar as the route answers it: start (epoch ms), prices and volume, numbers or null. */
export interface LiveBar {
  t: number | null;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
}

export interface LiveRow {
  /** The top of the book: bid and ask with their sizes, and the quote's time (epoch ms). */
  quote: { bp: number | null; bs: number | null; ap: number | null; as: number | null; t: number | null };
  /** The session's regular-hours 2-minute bars so far, oldest first; null when the read was cut short by paging. */
  bars: LiveBar[] | null;
}

export interface LiveAnswer {
  /** The board's stock feed that answered. */
  feed: "iex" | "sip";
  /** When the server last read upstream for this answer (ISO); older than `served_at` when it came from the cache. */
  as_of: string;
  /** The server's clock when it sent this answer (ISO). */
  served_at: string;
  rows: Record<string, LiveRow>;
  fixture?: true;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The route's answer read back, every number checked: null when it is not one (no feed, no server time). */
export function parseLiveAnswer(body: unknown): LiveAnswer | null {
  const b = obj(body);
  if (!b || (b.feed !== "iex" && b.feed !== "sip")) return null;
  if (typeof b.as_of !== "string" || typeof b.served_at !== "string" || !Number.isFinite(Date.parse(b.served_at))) return null;
  const rows: Record<string, LiveRow> = {};
  for (const [s, raw] of Object.entries(obj(b.rows) ?? {})) {
    const r = obj(raw);
    if (!r) continue;
    const q = obj(r.quote);
    rows[s] = {
      quote: { bp: num(q?.bp), bs: num(q?.bs), ap: num(q?.ap), as: num(q?.as), t: num(q?.t) },
      bars: Array.isArray(r.bars)
        ? r.bars.map((x) => {
            const o = obj(x);
            return { t: num(o?.t), o: num(o?.o), h: num(o?.h), l: num(o?.l), c: num(o?.c), v: num(o?.v) };
          })
        : null,
    };
  }
  return { feed: b.feed, as_of: b.as_of, served_at: b.served_at, rows, ...(b.fixture === true ? { fixture: true as const } : {}) };
}

/**
 * The server's clock now: `served_at` carried forward by the monotonic time since the answer arrived. Null when the
 * answer's time cannot be read. A monotonic reading behind the receipt (it cannot be) counts as no time passed.
 */
export function serverClock(servedAt: string, perfReceived: number, perfNow: number): number | null {
  const t = Date.parse(servedAt);
  if (!Number.isFinite(t) || !Number.isFinite(perfReceived) || !Number.isFinite(perfNow)) return null;
  return t + Math.max(0, perfNow - perfReceived);
}

/** How old a time (epoch ms) is on that clock; null when either is not known. A time after the clock reads 0. */
export function ageMs(at: number | null, clock: number | null): number | null {
  if (at === null || clock === null) return null;
  return Math.max(0, clock - at);
}

/**
 * Whether a name's price is stale as the board reads it (feed-provenance ageStale): its last trade older than
 * TRADE_STALE_MS, or the quotes' last answer older than the board's feed limit. At a limit itself it is not yet. With
 * no trade time or no clock it is stale too: nothing vouches for the price.
 */
export function tradeStale(tradeAgeMs: number | null, checkedMs: number | null = 0): boolean {
  return tradeAgeMs === null || checkedMs === null || ageStale("trade", tradeAgeMs) || ageStale("checked", checkedMs);
}

export type Spread = { kind: "bp"; bp: number } | { kind: "locked" } | { kind: "crossed" } | { kind: "none"; why: string };

/**
 * The quoted spread in basis points of the mid. A locked book (ask equal to bid) and a crossed one (ask below bid) are
 * named, never given a number; a side missing or not above zero is "not available" with the reason. Kept here on its
 * own: a shared quote-shape module will replace it later.
 */
export function spreadOf(bp: number | null, ap: number | null): Spread {
  if (bp === null || ap === null) return { kind: "none", why: "no bid or no ask" };
  if (!(bp > 0) || !(ap > 0)) return { kind: "none", why: "a side at zero" };
  if (ap === bp) return { kind: "locked" };
  if (ap < bp) return { kind: "crossed" };
  const mid = (ap + bp) / 2;
  return { kind: "bp", bp: ((ap - bp) / mid) * 10_000 };
}

/** The spread as the page writes it: "3.2 bp", "locked", "crossed", or "not available (why)". */
export function spreadText(s: Spread): string {
  switch (s.kind) {
    case "bp":
      return `${s.bp < 10 ? s.bp.toFixed(1) : Math.round(s.bp)} bp`;
    case "locked":
      return "locked";
    case "crossed":
      return "crossed";
    default:
      return `not available (${s.why})`;
  }
}

/** The feed's name for a label, "IEX" or "SIP"; null when not known, never a guess. */
export const liveFeedName = (feed: unknown): "IEX" | "SIP" | null => feedLabel(feed);

export const ROUTE_FAILED = "not available: the live route did not answer";
export const CLOCK_UNKNOWN = "not available: the tab was hidden, waiting for a new answer";
const BAR_MS = 120_000;

/**
 * The board's live price for one name. `read` is the board's own per-name read (options.ts liveRead, the function its
 * state chip uses: STALE_MS, aware of the session), null when there is no quote or no edition row for the name.
 * `tradeAgeMs` is feedAges' age on the board's clock with the edition's session passed, so a trade from another New
 * York day is "no trade today" (`noTradeToday`), as the board's own line says.
 */
export interface PriceIn {
  feed: "IEX" | "SIP" | null;
  read: LiveRead | null;
  tradeAgeMs: number | null;
  noTradeToday: boolean;
  /** The quotes are failing (retrying, or no answer to stand on). */
  failing: boolean;
  /** The tab was hidden (or a clock jumped) since the last quotes answer: the clock is not known. */
  slept: boolean;
}

/** This page's own 5 s read for the name: its row, the server clock (serverClock), and whether it is failing. */
export interface BookIn {
  feed: "IEX" | "SIP" | null;
  row: LiveRow | undefined;
  clock: number | null;
  /** The answer's served_at (epoch ms), for the forming bar. */
  servedAt: number | null;
  failing: boolean;
  slept: boolean;
}

export interface ViewBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  /** The last bar, still forming when the answer was sent. */
  forming: boolean;
}

export interface RowView {
  symbol: string;
  priceFeed: "IEX" | "SIP" | null;
  bookFeed: "IEX" | "SIP" | null;
  price: string;
  tradeAgeMs: number | null;
  tradeAge: string;
  quoteAge: string;
  spread: Spread;
  /** Grey the row: a stale price, a failing source, or an unknown clock. */
  stale: boolean;
  staleLine: string | null;
  /** null: "bars not available (cut short)"; [] none yet. */
  bars: ViewBar[] | null;
}

/** One name's row from the board's price and this page's book; never a number that nothing vouches for. */
export function rowView(symbol: string, p: PriceIn, b: BookIn): RowView {
  const r = p.read;
  const priceKnown = !p.failing && !p.slept;
  // The board's own verdict for the name first; outside the session the price is the board's (the close) and not live.
  const notLive = r !== null && !r.inSession;
  const priceStale = !priceKnown || r === null || r.price === null || notLive || r.stale;
  const tradeAge = p.failing ? ROUTE_FAILED : p.slept ? CLOCK_UNKNOWN : p.noTradeToday ? "no trade today" : p.tradeAgeMs === null ? "not available" : ageText(p.tradeAgeMs);
  const priceLine = p.failing
    ? `Price ${ROUTE_FAILED}`
    : p.slept
      ? `Price ${CLOCK_UNKNOWN}`
      : r === null || r.price === null
        ? `No price on ${p.feed ?? "the board feed"}`
        : notLive
          ? p.noTradeToday
            ? "Not live: no trade today"
            : "Not live: outside the session"
          : r.stale
            ? `No new price for ${r.ageS ?? "?"} s`
            : null;
  const bookKnown = !b.failing && !b.slept;
  const bookLine = b.failing ? `Quote and bars ${ROUTE_FAILED}` : b.slept ? `Quote and bars ${CLOCK_UNKNOWN}` : null;
  const qAge = bookKnown ? ageMs(b.row?.quote.t ?? null, b.clock) : null;
  const rawBars = b.row ? b.row.bars : [];
  const whole = (rawBars ?? []).flatMap((x) =>
    x.t !== null && x.o !== null && x.h !== null && x.l !== null && x.c !== null && x.o > 0 && x.h > 0 && x.l > 0 && x.c > 0
      ? [{ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v !== null && x.v >= 0 ? x.v : null, forming: false }]
      : [],
  );
  const last = whole[whole.length - 1];
  if (last && b.servedAt !== null && last.t + BAR_MS > b.servedAt) last.forming = true;
  return {
    symbol,
    priceFeed: p.feed,
    bookFeed: b.feed,
    price: !priceKnown ? (p.failing ? ROUTE_FAILED : CLOCK_UNKNOWN) : r === null || r.price === null ? "not available" : r.price.toFixed(2),
    tradeAgeMs: priceKnown && !p.noTradeToday ? p.tradeAgeMs : null,
    tradeAge,
    quoteAge: b.failing ? ROUTE_FAILED : b.slept ? CLOCK_UNKNOWN : qAge === null ? "not available" : ageText(qAge),
    spread: b.failing ? { kind: "none", why: "the live route did not answer" } : b.slept ? { kind: "none", why: "the tab was hidden" } : spreadOf(b.row?.quote.bp ?? null, b.row?.quote.ap ?? null),
    stale: priceStale || !bookKnown,
    staleLine: priceLine ?? bookLine,
    bars: rawBars === null ? null : whole,
  };
}


export interface CandleGeometry {
  width: number;
  height: number;
  priceHeight: number;
  candles: { x: number; w: number; wickTop: number; wickBottom: number; bodyTop: number; bodyHeight: number; up: boolean; volTop: number | null; volHeight: number; forming: boolean }[];
  low: number;
  high: number;
}

/**
 * Where each candle and its volume bar sit in a `width` × `height` box: the upper part for prices (scaled to the bars'
 * own low and high), the lower VOLUME_SHARE for volume (scaled to the largest). A bar with no volume draws none.
 */
export const VOLUME_SHARE = 0.25;
export function candleGeometry(bars: readonly ViewBar[], width: number, height: number): CandleGeometry | null {
  if (bars.length === 0) return null;
  const priceHeight = Math.round(height * (1 - VOLUME_SHARE)) - 2;
  const volBase = height;
  const volSpan = height - priceHeight - 4;
  const low = Math.min(...bars.map((b) => b.l));
  const high = Math.max(...bars.map((b) => b.h));
  const span = high - low || 1;
  const y = (p: number) => 1 + ((high - p) / span) * (priceHeight - 2);
  const maxV = Math.max(0, ...bars.map((b) => b.v ?? 0));
  const step = width / Math.max(bars.length, 1);
  const w = Math.max(1, Math.min(8, step * 0.7));
  const candles = bars.map((b, i) => {
    const x = i * step + (step - w) / 2;
    const top = y(Math.max(b.o, b.c));
    const bottom = y(Math.min(b.o, b.c));
    const vh = b.v !== null && maxV > 0 ? (b.v / maxV) * volSpan : 0;
    return { x, w, wickTop: y(b.h), wickBottom: y(b.l), bodyTop: top, bodyHeight: Math.max(1, bottom - top), up: b.c >= b.o, volTop: b.v === null ? null : volBase - vh, volHeight: vh, forming: b.forming };
  });
  return { width, height, priceHeight, candles, low, high };
}

/**
 * Whether "Sessions compared" may be on screen (DEC-0050 point 5). It fails closed and never trusts the render's own
 * server time after hydration (a back/forward restore can bring an old one): only a 5 s answer received after this
 * mount (`perfReceived >= mountPerf`) vouches for the time, carried forward on the monotonic clock. Hidden until one
 * comes, once that clock reaches `hideAt` (the next open), while the read is failing, and after a hidden period or a
 * clock jump (`wakePerf`) until a newer answer.
 */
export function compareShown(a: {
  hideAt: number | null;
  mountPerf: number | null;
  perfNow: number | null;
  answer: { servedAt: number; perfReceived: number; failing: boolean } | null;
  routeError: boolean;
  wakePerf: number | null;
}): boolean {
  const x = a.answer;
  if (a.hideAt === null || a.mountPerf === null || a.perfNow === null || !x || a.routeError || x.failing) return false;
  if (x.perfReceived < a.mountPerf || !Number.isFinite(x.servedAt)) return false;
  if (a.wakePerf !== null && x.perfReceived < a.wakePerf) return false;
  return x.servedAt + Math.max(0, a.perfNow - x.perfReceived) < a.hideAt;
}

/** A render's server time this far from the device's clock at mount is treated as an old page: the page refreshes. */
export const OLD_RENDER_MS = 2 * 60_000;
export function oldRender(serverNow: number, wallNow: number): boolean {
  return !Number.isFinite(serverNow) || Math.abs(wallNow - serverNow) > OLD_RENDER_MS;
}

/**
 * Whether the gap between two one-second ticks means the page slept or a clock jumped: more than `gapMs` on the
 * monotonic clock or on the wall clock, or the wall clock going backwards. Either clock can miss a sleep the other sees.
 */
export function tickWoke(prev: { perf: number; wall: number }, now: { perf: number; wall: number }, gapMs: number): boolean {
  const dPerf = now.perf - prev.perf;
  const dWall = now.wall - prev.wall;
  return dPerf > gapMs || dWall > gapMs || dWall < 0;
}

/** Past this long since the server render, the stamp panel says it is out of date until a refresh lands. */
export const PANEL_MAX_AGE_MS = 2 * 60_000;
/** Whether the stamp panel is out of date: over PANEL_MAX_AGE_MS on the monotonic clock, or the tab was hidden since. */
export function panelOutOfDate(sinceRenderMs: number | null, hiddenSinceRender: boolean): boolean {
  return hiddenSinceRender || sinceRenderMs === null || sinceRenderMs > PANEL_MAX_AGE_MS;
}

// ---- the Feeds page's own fixture switch -----------------------------------------------------------------------------
// Fixture mode only (DASHBOARD_FIXTURE=1, never production), read by the page and its live route, and kept here rather
// than among the shared `fx` variants. The cookie FEEDS_FX_COOKIE holds dot-separated words:
//  * `after-close`: the page's clock (and its route's) stands at FEEDS_AFTER_CLOSE_NOW, after the fixture session's
//    close, so the sessions compared are shown.
// The shared `fx` cookie's `frozen` still stands the clock at 11:01 New York when `after-close` is not given.

export const FEEDS_FX_COOKIE = "fxfeeds";
export const FEEDS_FX_WORDS = ["after-close"] as const;
export type FeedsFxWord = (typeof FEEDS_FX_WORDS)[number];
/** `after-close`: 16:30 New York on the fixture's session, half an hour after its close. */
export const FEEDS_AFTER_CLOSE_NOW = "2026-10-12T20:30:00Z";

/** The words in a cookie value such as `after-close`; unknown words are ignored. */
export function parseFeedsFx(raw: string | null | undefined): Set<FeedsFxWord> {
  const out = new Set<FeedsFxWord>();
  for (const w of (raw ?? "").split(".")) if ((FEEDS_FX_WORDS as readonly string[]).includes(w)) out.add(w as FeedsFxWord);
  return out;
}

/** The words from a request's `Cookie` header. */
export function feedsFxFromCookieHeader(header: string | null | undefined): Set<FeedsFxWord> {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === FEEDS_FX_COOKIE) return parseFeedsFx(part.slice(eq + 1).trim());
  }
  return new Set();
}

/** The Feeds page's fixture clock: after the close with `after-close`, else `fallback` (the frozen or real clock). */
export function feedsFixtureClock(words: ReadonlySet<FeedsFxWord>, fallback: Date): Date {
  return words.has("after-close") ? new Date(FEEDS_AFTER_CLOSE_NOW) : fallback;
}
