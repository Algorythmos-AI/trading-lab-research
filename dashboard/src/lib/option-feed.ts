import "server-only";
import { logEvent } from "./log";
import { UpstreamError } from "./upstream";

// Which Alpaca option feed the contract pane's chain reads (/api/chain, chain.ts): ALPACA_OPTION_FEED, one place.
// `indicative` (free, 15 minutes behind the market) when unset or empty; `opra` (the real-time option tape) needs a
// paid Alpaca plan and is the owner's choice (DEC-0050, point 6). Any other value is refused, never guessed at: the
// route answers 503 as for missing keys, so the pane shows option quotes as off rather than quotes from a feed nobody
// chose. Case and surrounding spaces are not part of the choice ("OPRA", "opra\n" are opra). The stock feed
// (ALPACA_FEED, alpaca-feed.ts) is a different setting and is not read from here. Market data only: nothing here can
// place an order or read an account.

export type OptionFeed = "indicative" | "opra";

export type OptionFeedSetting = { ok: true; feed: OptionFeed } | { ok: false; length: number };

/** The option feed when ALPACA_OPTION_FEED is unset or empty. */
export const DEFAULT_OPTION_FEED: OptionFeed = "indicative";

export function isOptionFeed(v: unknown): v is OptionFeed {
  return v === "indicative" || v === "opra";
}

/** ALPACA_OPTION_FEED read: the feed, or refused with the raw value's length (the value itself is never kept or logged). */
export function optionFeedSetting(env: Record<string, string | undefined> = process.env): OptionFeedSetting {
  const raw = env.ALPACA_OPTION_FEED;
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { ok: true, feed: DEFAULT_OPTION_FEED };
  return isOptionFeed(v) ? { ok: true, feed: v } : { ok: false, length: raw!.length };
}

let warned = false;
let warnedRefused = false;

/** Test hook: let the next refusal (of the setting, or of opra by the plan) log again. */
export function resetOptionFeedWarning(): void {
  warned = false;
  warnedRefused = false;
}

/**
 * The configured option feed, or null when ALPACA_OPTION_FEED is not one of the allowed values. The first refusal on
 * an instance logs one line naming the bad value's length only; later ones are quiet.
 */
export function configuredOptionFeed(env: Record<string, string | undefined> = process.env): OptionFeed | null {
  const s = optionFeedSetting(env);
  if (s.ok) return s.feed;
  if (!warned) {
    warned = true;
    logEvent("alpaca.option_feed", { outcome: "invalid", length: s.length, allowed: "indicative or opra", answer: "not-configured" });
  }
  return null;
}

/** What /api/chain answers, with 503, while ALPACA_OPTION_FEED is refused: "not configured", as for missing keys. */
export const OPTION_FEED_REFUSED = { error: "not-configured", why: "feed" } as const;

/**
 * Alpaca refused the opra feed (HTTP 403): most likely the data plan does not include it, though a 403 can also be the
 * keys, which the indicative retry tells apart (opraFallback). Logs one line the first time in each lapse on an
 * instance: once opra answers again (opraAnswered), the next refusal logs again. A 403 on indicative, a 401 (bad keys)
 * and every other failure are not this, and keep their usual answers.
 */
export function opraRefused(feed: OptionFeed, e: unknown): boolean {
  if (feed !== "opra" || !(e instanceof UpstreamError) || e.status !== 403) return false;
  if (!warnedRefused) {
    warnedRefused = true;
    logEvent("alpaca.option_feed", { outcome: "plan", feed, status: 403, answer: "retry-indicative" });
  }
  return true;
}

/**
 * The outcome of the indicative retry after opra was refused, one line each time it runs (at most once per
 * OPRA_RETRY_MS on an instance): "indicative" when indicative answered, "error" with its status when it failed too, so
 * a problem with the keys does not read as a plan refusal only. Never the body or the keys.
 */
export function opraFallback(outcome: "indicative" | "error", e?: unknown): void {
  const status = e instanceof UpstreamError ? e.status : undefined;
  logEvent("alpaca.option_feed", { outcome: "fallback", answer: outcome, ...(status !== undefined ? { status } : {}), ...(outcome === "error" && status === undefined ? { error: e instanceof Error ? e.name : "unknown" } : {}) });
}

/** Opra answered: a later refusal is a new lapse, and logs again. */
export function opraAnswered(): void {
  warnedRefused = false;
}
