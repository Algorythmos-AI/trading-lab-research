// Where the Options page's live stock prices come from, and how old they are, in words the page can show. Pure, and
// safe in the browser: the server's choice of feed is read in alpaca-feed.ts (server only); the page only ever names
// the feed an answer reported.
//
// Two ages, both on the board's (server) clock, trade-state's serverNow:
//  * the last trade: how long ago the newest trade among the names printed, from Alpaca's own trade time. The
//    device's clock never enters it: a phone set five minutes fast or slow reads the same age.
//  * checked: how long ago the page last got an answer. A price fetched a second ago can still be a trade from a
//    minute ago, so the two are shown apart.
//
// The stock feed here (IEX or SIP) is not the option chain's (chain.ts asks Alpaca's option feed named by
// ALPACA_OPTION_FEED, indicative or opra, a separate setting ALPACA_FEED does not touch).
import { TRADE_STALE_MS } from "./entry-checks";
import { FEED_STALE_MS, serverNow } from "./trade-state";

/** The stock feeds the site may read: IEX (one exchange, free) or SIP (every US exchange, a paid plan). */
export const DATA_FEEDS = ["iex", "sip"] as const;
export type DataFeed = (typeof DATA_FEEDS)[number];

export function isDataFeed(v: unknown): v is DataFeed {
  return typeof v === "string" && (DATA_FEEDS as readonly string[]).includes(v);
}

/** The feed's name as the page writes it, or null when the answer named none (or something else): never a guess. */
export function feedLabel(v: unknown): "IEX" | "SIP" | null {
  return isDataFeed(v) ? (v === "iex" ? "IEX" : "SIP") : null;
}

/** A quote as the ages read it: its last trade's time. */
type TradeQuote = { at: string } | undefined;

const NY_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export interface TradeAgeRange {
  /** ms since the newest and the oldest last trade among the names that have one today; null when none has, or no clock. */
  newestMs: number | null;
  oldestMs: number | null;
  /** Names with a usable trade today. */
  traded: number;
  /** Names asked for with no usable trade today (no quote, an unreadable time, or a last trade on another New York day). */
  noTrade: number;
}

/**
 * The spread of last-trade ages across `symbols` on the server's clock `now`: the newest and the oldest, so one busy
 * name cannot make a quiet one read as fresh. A name with no trade today (its last trade on a New York day other than
 * `session`, when a session is given) is left out of the spread and counted apart, so it never makes the spread read fresher than it is. A trade
 * stamped after `now` reads 0.
 */
export function tradeAgeRange(quotes: Readonly<Record<string, TradeQuote>>, symbols: readonly string[], now: number | null, session: string | null): TradeAgeRange {
  let newest: number | null = null;
  let oldest: number | null = null;
  let traded = 0;
  for (const s of symbols) {
    const q = quotes[s];
    const t = Date.parse(q?.at ?? "");
    if (!q || !Number.isFinite(t) || (session !== null && NY_DAY.format(new Date(t)) !== session)) continue;
    traded++;
    if (newest === null || t > newest) newest = t;
    if (oldest === null || t < oldest) oldest = t;
  }
  const age = (t: number | null) => (t === null || now === null ? null : Math.max(0, now - t));
  return { newestMs: age(newest), oldestMs: age(oldest), traded, noTrade: symbols.length - traded };
}

export interface FeedAges {
  /** The last trades' ages across the names, on the server's clock. */
  trade: TradeAgeRange;
  /** ms since the page last got an answer; null when not known. */
  checkedMs: number | null;
}

/**
 * Both ages from the page's last answer and the browser's clock. The board's clock is the browser's shifted by the
 * server-minus-browser offset seen at that answer (serverNow), so a trade's age is the server's now minus Alpaca's
 * trade time, whatever the device's clock says; "checked" is the server's now minus the answer's `as_of`, which is the
 * browser's time since the answer arrived. Neither goes below 0. `symbols` null reads every quote in the answer.
 */
export function feedAges(
  answer: { asOf: string; receivedAt: number; quotes: Readonly<Record<string, TradeQuote>> },
  symbols: readonly string[] | null,
  browserNow: number | null,
  session: string | null = null,
): FeedAges {
  const names = symbols ?? Object.keys(answer.quotes);
  const asOf = Date.parse(answer.asOf);
  const known = browserNow !== null && Number.isFinite(asOf) && Number.isFinite(answer.receivedAt);
  const now = known ? serverNow(answer.asOf, answer.receivedAt, browserNow).getTime() : null;
  return { trade: tradeAgeRange(answer.quotes, names, now, session), checkedMs: now === null ? null : Math.max(0, now - asOf) };
}

/** Whole seconds, rounded as the board's other ages ("No new price for N s", "STALE Ns") are. */
export function ageSeconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

/** An age in at most six characters: "0 s" to "59 s", then "1 min" to "59 min", "1 h" to "23 h", then days. */
export function ageText(ms: number): string {
  const s = ageSeconds(ms);
  if (s < 60) return `${s} s`;
  if (s < 3_600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h`;
  return `${Math.min(999, Math.floor(s / 86_400))} d`;
}

/**
 * Past the board's own limits an age is drawn as a warning: the last trade past TRADE_STALE_MS (the row pauses), an
 * answer past FEED_STALE_MS (the board pauses). At the limit itself it is not yet stale, as the board reads it.
 */
export function ageStale(kind: "trade" | "checked", ms: number): boolean {
  return ms > (kind === "trade" ? TRADE_STALE_MS : FEED_STALE_MS);
}

/** A stored shadow record's feed (desk-run.ts): null for a record written before the field existed, or a bad value. */
export function recordFeed(r: unknown): DataFeed | null {
  const v = r !== null && typeof r === "object" ? (r as { feed?: unknown }).feed : undefined;
  return isDataFeed(v) ? v : null;
}
