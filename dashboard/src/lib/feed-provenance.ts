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
// The stock feed here (IEX or SIP) is not the option chain's (chain.ts asks Alpaca's `indicative` option feed, a
// separate thing ALPACA_FEED does not touch).
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

/** The newest last-trade time (ms) among `symbols` (every quote when null), or null when none has a readable one. */
export function newestTradeAt(quotes: Readonly<Record<string, { at: string } | undefined>>, symbols: readonly string[] | null): number | null {
  let newest: number | null = null;
  for (const s of symbols ?? Object.keys(quotes)) {
    const t = Date.parse(quotes[s]?.at ?? "");
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

export interface FeedAges {
  /** ms since the newest trade printed, on the server's clock; null when not known. */
  lastTradeMs: number | null;
  /** ms since the page last got an answer; null when not known. */
  checkedMs: number | null;
}

/**
 * Both ages from the page's last answer and the browser's clock. The board's clock is the browser's shifted by the
 * server-minus-browser offset seen at that answer (serverNow), so the last trade's age is the server's now minus
 * Alpaca's trade time, whatever the device's clock says; "checked" is the server's now minus the answer's `as_of`,
 * which is the browser's time since the answer arrived. Neither goes below 0.
 */
export function feedAges(
  answer: { asOf: string; receivedAt: number; quotes: Readonly<Record<string, { at: string } | undefined>> },
  symbols: readonly string[] | null,
  browserNow: number | null,
): FeedAges {
  const asOf = Date.parse(answer.asOf);
  if (browserNow === null || !Number.isFinite(asOf) || !Number.isFinite(answer.receivedAt)) return { lastTradeMs: null, checkedMs: null };
  const now = serverNow(answer.asOf, answer.receivedAt, browserNow).getTime();
  const trade = newestTradeAt(answer.quotes, symbols);
  return { lastTradeMs: trade === null ? null : Math.max(0, now - trade), checkedMs: Math.max(0, now - asOf) };
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
