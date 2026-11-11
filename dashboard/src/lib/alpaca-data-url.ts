// Every Alpaca market-data request URL the dashboard sends is built here, and none can be built without naming its
// feed (docs/runbooks/keys-and-feeds.md). When a request leaves `feed` out, Alpaca picks "the best one the
// subscription allows": IEX on the free plan, SIP on a paid one, IEX again if the subscription lapses. A request
// without a feed would change its data source with the plan, with no code change and no record.
//
// Stock paths (/v2/stocks/...) take iex or sip; option quote paths (/v1beta1/options/snapshots, .../latest) take
// indicative or opra. Option bars and trades and the news take no feed parameter and are not built here.
// The query keeps the order of `params`, so a URL built here is the same string the caller built before.

export const STOCK_FEEDS: readonly string[] = ["iex", "sip"];
export const OPTION_FEEDS: readonly string[] = ["indicative", "opra"];

/** Which feeds a data path takes: the stock ones, the option ones, or null for a path this builder does not serve. */
export function feedsFor(path: string): readonly string[] | null {
  if (path.startsWith("/v2/stocks/")) return STOCK_FEEDS;
  if (path.startsWith("/v1beta1/options/snapshots") || /^\/v1beta1\/options\/(quotes|trades|bars)\/latest/.test(path)) return OPTION_FEEDS;
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
