// Every Alpaca market-data request URL the dashboard sends is built here, and none can be built without naming its
// feed (docs/runbooks/keys-and-feeds.md). When a request leaves `feed` out, Alpaca picks "the best one the
// subscription allows": IEX on the free plan, SIP on a paid one, IEX again if the subscription lapses. A request
// without a feed would change its data source with the plan, with no code change and no record.
//
// Stock paths (/v2/stocks/...) take iex or sip; option quote paths (/v1beta1/options/snapshots, .../latest) take
// indicative or opra. Historical option trades and bars (/v1beta1/options/trades, /v1beta1/options/bars) take no feed
// parameter: they are built by alpacaNoFeedUrl, which serves those two exact paths and nothing else, and refuses a
// `feed` in its query. The news takes no feed either and is not built here.
// The query keeps the order of `params`, so a URL built here is the same string the caller built before.

export const STOCK_FEEDS: readonly string[] = ["iex", "sip"];
export const OPTION_FEEDS: readonly string[] = ["indicative", "opra"];
/** Alpaca's reference for the stock auctions: "Only `sip` is valid for auctions". */
export const AUCTION_FEEDS: readonly string[] = ["sip"];

const AUCTIONS = /^\/v2\/stocks\/(?:[^/]+\/)?auctions\/?$/;
const STOCK_DATA = /^\/v2\/stocks\/(?:(?:bars|trades|quotes)(?:\/latest)?|snapshots|(?!meta\/)[^/]+\/(?:(?:bars|trades|quotes)(?:\/latest)?|snapshot))\/?$/;
const OPTION_QUOTES = /^\/v1beta1\/options\/(?:snapshots(?:\/[^/]+)?|(?:quotes|trades|bars)\/latest)\/?$/;

/**
 * Which feeds a data path takes: the stock ones (bars, trades, quotes, snapshots, latest), sip for auctions, the option ones (option
 * snapshots and latest), or null for a path this builder does not serve (metadata, news, option bars).
 */
export function feedsFor(path: string): readonly string[] | null {
  if (AUCTIONS.test(path)) return AUCTION_FEEDS;
  if (STOCK_DATA.test(path)) return STOCK_FEEDS;
  if (OPTION_QUOTES.test(path)) return OPTION_FEEDS;
  return null;
}

/**
 * `${base}${path}?${query}` for an Alpaca market-data request. Throws when the path is not one that takes a feed, or
 * when `params.feed` is missing or not one of that path's feeds: a request is never sent on Alpaca's default.
 */
export function alpacaDataUrl(base: string, path: string, params: Readonly<Record<string, string>>): string {
  const feeds = feedsFor(path);
  if (feeds === null) throw new Error(`not an Alpaca market-data path that takes a feed: ${path}`);
  const feed = params.feed;
  if (typeof feed !== "string" || !feeds.includes(feed)) throw new Error(`an Alpaca data request must name its feed (${feeds.join(" or ")})`);
  return `${base}${path}?${new URLSearchParams(params).toString()}`;
}

/** The data paths Alpaca gives no feed parameter, served by alpacaNoFeedUrl. Exact paths only. */
export const NO_FEED_PATHS: readonly string[] = ["/v1beta1/options/trades", "/v1beta1/options/bars"];

/**
 * `${base}${path}?${query}` for an Alpaca market-data request whose path takes no feed: one of NO_FEED_PATHS exactly.
 * Throws for any other path (a path that takes a feed can never be built here, so it cannot leave its feed out) and
 * when `params` holds a `feed` key, which these paths do not read.
 */
export function alpacaNoFeedUrl(base: string, path: string, params: Readonly<Record<string, string>>): string {
  if (!NO_FEED_PATHS.includes(path) || feedsFor(path) !== null) throw new Error(`not an Alpaca market-data path that takes no feed: ${path}`);
  if (Object.hasOwn(params, "feed")) throw new Error(`${path} takes no feed parameter`);
  return `${base}${path}?${new URLSearchParams(params).toString()}`;
}
