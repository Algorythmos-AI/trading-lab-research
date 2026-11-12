// The Feeds page's live section (/options/feeds, DEC-0050 point 5): the board's own stock feed only, per focus name
// plus SPY. The answer's shape, reading it back defensively, and the view helpers for ages, the spread and staleness.
// Pure and safe in the browser: no I/O, and the clock is always passed in.
//
// Ages are on the server's clock carried forward by the browser's monotonic clock: the answer's `served_at` plus the
// time since it arrived (performance.now), minus the trade's or the quote's own time. The device's wall clock never
// enters, so a phone set minutes fast or slow reads the same ages.
import { TRADE_STALE_MS } from "./entry-checks";
import { ageSeconds, feedLabel } from "./feed-provenance";

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
  /** The last trade: price and time (epoch ms). */
  trade: { p: number | null; t: number | null };
  /** The top of the book: bid and ask with their sizes, and the quote's time (epoch ms). */
  quote: { bp: number | null; bs: number | null; ap: number | null; as: number | null; t: number | null };
  /** The session's regular-hours 2-minute bars so far, oldest first. */
  bars: LiveBar[];
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
    const tr = obj(r.trade);
    const q = obj(r.quote);
    const bars = Array.isArray(r.bars) ? r.bars : [];
    rows[s] = {
      trade: { p: num(tr?.p), t: num(tr?.t) },
      quote: { bp: num(q?.bp), bs: num(q?.bs), ap: num(q?.ap), as: num(q?.as), t: num(q?.t) },
      bars: bars.map((x) => {
        const o = obj(x);
        return { t: num(o?.t), o: num(o?.o), h: num(o?.h), l: num(o?.l), c: num(o?.c), v: num(o?.v) };
      }),
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
 * Whether a row's last trade is stale: older than TRADE_STALE_MS, as the board reads it (at the limit itself it is
 * not yet). With no trade time known it is stale too: nothing vouches for the price.
 */
export function tradeStale(age: number | null): boolean {
  return age === null || age > TRADE_STALE_MS;
}

export type Spread = { kind: "bp"; bp: number } | { kind: "locked" } | { kind: "crossed" } | { kind: "none"; why: string };

/**
 * The quoted spread in basis points of the mid. A locked book (ask equal to bid) and a crossed one (ask below bid) are
 * named, never given a number; a side missing or not above zero is "not available" with the reason.
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

/** The feed's name for a label, "IEX" or "SIP"; never a guess. */
export const liveFeedName = (feed: LiveAnswer["feed"]): "IEX" | "SIP" => feedLabel(feed) ?? (feed === "sip" ? "SIP" : "IEX");

export interface RowView {
  symbol: string;
  /** The feed name every number is labelled with. */
  feed: "IEX" | "SIP";
  price: number | null;
  tradeAgeMs: number | null;
  quoteAgeMs: number | null;
  spread: Spread;
  stale: boolean;
  /** "No new price for N s" when stale with a trade time; "No price on <feed>" when there is none. */
  staleLine: string | null;
  bars: { t: number; o: number; h: number; l: number; c: number; v: number | null }[];
}

/** One name's view at the clock `clock` (serverClock), from its row in the answer (undefined when the answer has none). */
export function rowView(symbol: string, feed: LiveAnswer["feed"], row: LiveRow | undefined, clock: number | null): RowView {
  const name = liveFeedName(feed);
  const tradeAge = ageMs(row?.trade.t ?? null, clock);
  const price = row?.trade.p ?? null;
  const usable = price !== null && price > 0 ? price : null;
  const stale = usable === null || tradeStale(tradeAge);
  const staleLine = !stale ? null : usable === null || tradeAge === null ? `No price on ${name}` : `No new price for ${ageSeconds(tradeAge)} s`;
  const bars = (row?.bars ?? []).flatMap((b) =>
    b.t !== null && b.o !== null && b.h !== null && b.l !== null && b.c !== null && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0
      ? [{ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v !== null && b.v >= 0 ? b.v : null }]
      : [],
  );
  return {
    symbol,
    feed: name,
    price: usable,
    tradeAgeMs: tradeAge,
    quoteAgeMs: ageMs(row?.quote.t ?? null, clock),
    spread: spreadOf(row?.quote.bp ?? null, row?.quote.ap ?? null),
    stale,
    staleLine,
    bars,
  };
}

export interface CandleGeometry {
  width: number;
  height: number;
  priceHeight: number;
  candles: { x: number; w: number; wickTop: number; wickBottom: number; bodyTop: number; bodyHeight: number; up: boolean; volTop: number | null; volHeight: number }[];
  low: number;
  high: number;
}

/**
 * Where each candle and its volume bar sit in a `width` × `height` box: the upper part for prices (scaled to the bars'
 * own low and high), the lower VOLUME_SHARE for volume (scaled to the largest). A bar with no volume draws none.
 */
export const VOLUME_SHARE = 0.25;
export function candleGeometry(bars: RowView["bars"], width: number, height: number): CandleGeometry | null {
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
    return { x, w, wickTop: y(b.h), wickBottom: y(b.l), bodyTop: top, bodyHeight: Math.max(1, bottom - top), up: b.c >= b.o, volTop: b.v === null ? null : volBase - vh, volHeight: vh };
  });
  return { width, height, priceHeight, candles, low, high };
}

// ---- the Feeds page's own fixture switch -----------------------------------------------------------------------------
// Fixture mode only (DASHBOARD_FIXTURE=1, never production), read by the page and its live route, and kept here rather
// than among the shared `fx` variants. The cookie FEEDS_FX_COOKIE holds dot-separated words:
//  * `row-stale`: the last name in the live section has had no new trade for longer than the board allows;
//  * `after-close`: the page's clock (and its route's) stands at FEEDS_AFTER_CLOSE_NOW, after the fixture session's
//    close, so the sessions compared are shown.
// The shared `fx` cookie's `frozen` still stands the clock at 11:01 New York when `after-close` is not given.

export const FEEDS_FX_COOKIE = "fxfeeds";
export const FEEDS_FX_WORDS = ["row-stale", "after-close"] as const;
export type FeedsFxWord = (typeof FEEDS_FX_WORDS)[number];
/** `after-close`: 16:30 New York on the fixture's session, half an hour after its close. */
export const FEEDS_AFTER_CLOSE_NOW = "2026-10-12T20:30:00Z";

/** The words in a cookie value such as `row-stale.after-close`; unknown words are ignored. */
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
