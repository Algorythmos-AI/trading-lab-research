import "server-only";
import { type DataFeed, isDataFeed } from "./feed-provenance";
import { logEvent } from "./log";
import { UpstreamError } from "./upstream";

// Which Alpaca stock feed the live prices, the session bars and the server's shadow check read: ALPACA_FEED, one
// place for all of them (quote.ts, bars.ts, desk-run.ts). `sip` (every US exchange) when unset or empty; `iex` is
// paused (DEC-0064 point 10: SIP only, no fallback) and refused like any other value. Any other value is refused, never
// guessed at: the routes answer 503 as for missing keys, so the page shows live prices as off rather than prices
// from a feed nobody chose. Case and surrounding spaces are not part of the choice ("SIP", "sip\n" are sip), so a
// value pasted with a trailing newline does not take the prices off; anything else, "delayed_sip" included, is
// refused. The option chain's feed (ALPACA_OPTION_FEED, option-feed.ts) is a different setting and is not read from here.

export type { DataFeed };

export type FeedSetting = { ok: true; feed: DataFeed } | { ok: false; length: number };

/** The feed when ALPACA_FEED is unset or empty (DEC-0064). */
export const DEFAULT_FEED: DataFeed = "sip";

/** Feeds DEC-0064 pauses: named in ALPACA_FEED they are refused, as a value that is not a feed is. */
export const PAUSED_FEEDS: readonly DataFeed[] = ["iex"];

/** ALPACA_FEED read: the feed, or refused with the raw value's length (the value itself is never kept or logged). */
export function feedSetting(env: Record<string, string | undefined> = process.env): FeedSetting {
  const raw = env.ALPACA_FEED;
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { ok: true, feed: DEFAULT_FEED };
  return isDataFeed(v) && !PAUSED_FEEDS.includes(v) ? { ok: true, feed: v } : { ok: false, length: raw!.length };
}

let warned = false;
let warnedPlan = false;

/** Test hook: let the next refusal (of the setting, or by the plan) log again. */
export function resetFeedWarning(): void {
  warned = false;
  warnedPlan = false;
}

/**
 * The configured feed, or null when ALPACA_FEED is not one of the allowed values. The first refusal on an instance
 * logs one line naming the bad value's length only; later ones are quiet, since the page asks every 2 s.
 */
export function configuredFeed(env: Record<string, string | undefined> = process.env): DataFeed | null {
  const s = feedSetting(env);
  if (s.ok) return s.feed;
  if (!warned) {
    warned = true;
    logEvent("alpaca.feed", { outcome: "invalid", length: s.length, allowed: "sip (iex is paused)", answer: "not-configured" });
  }
  return null;
}

/**
 * What /api/quote and /api/bars answer, with 503, while ALPACA_FEED is refused: "not configured", as for missing keys.
 * A 503 makes the page drop the prices it holds and stop asking until it is reloaded (quote-poll's "off"); a 502 would
 * keep the last prices on screen, greying, while it retried every 30 s against a setting that cannot heal by itself.
 */
export const FEED_REFUSED = { error: "not-configured", why: "feed" } as const;

/**
 * The same answer, why "plan", when ALPACA_FEED is sip and Alpaca refuses it (403): the free plan has no recent SIP
 * data. Not configured either, so the page shows the prices as off and stops, rather than retry for ever.
 */
export const FEED_PLAN_REFUSED = { error: "not-configured", why: "plan" } as const;

/**
 * Alpaca refused the configured SIP feed (HTTP 403): the data plan does not include it. Logs one line the first time
 * on an instance. A 403 on iex, a 401 (bad keys) and every other failure are not this, and keep their usual answers.
 */
export function planRefused(feed: DataFeed, e: unknown): boolean {
  if (feed !== "sip" || !(e instanceof UpstreamError) || e.status !== 403) return false;
  if (!warnedPlan) {
    warnedPlan = true;
    logEvent("alpaca.feed", { outcome: "plan", feed, status: 403, answer: "not-configured" });
  }
  return true;
}

/** ALPACA_FEED holds a value that is not a feed: nothing may be read upstream. */
export class FeedMisconfigured extends Error {
  constructor() {
    super("ALPACA_FEED is not sip (iex is paused, DEC-0064)");
    this.name = "FeedMisconfigured";
  }
}

/** The configured feed; throws FeedMisconfigured when ALPACA_FEED is refused. */
export function requireFeed(env: Record<string, string | undefined> = process.env): DataFeed {
  const f = configuredFeed(env);
  if (f === null) throw new FeedMisconfigured();
  return f;
}
