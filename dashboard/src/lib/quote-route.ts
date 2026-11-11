import "server-only";
import { configuredFeed, type DataFeed, FEED_REFUSED } from "./alpaca-feed";
import { FIXTURE_OFFSET_ATR, FLAKY_COOKIE, flagsFromCookieHeader, flakyCountFromCookieHeader, flakyFails, tickPrice, type VariantFlag } from "./fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, scriptQuote, scriptStep, stepFromCookieHeader, stepInstant } from "./fixture-script";
import { logEvent } from "./log";
import { upstreamBody, upstreamStatus } from "./upstream";
import type { OptionsEdition } from "./options.types";
import { alpacaKeys, fetchQuotes, parseSymbols, type Quote, type QuoteResponse } from "./quote";
import { fixtureMode } from "./snapshot";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Fixture mode: a quote for each fixture name, a fixed fraction of an ATR above its close, dated the fixture's
 * session at 11:00 New York. Lets the browser tests drive the live panel with no network and no keys. With `tick`
 * the price flips by a cent and its time advances every second, so a test can watch the page take live updates.
 */
async function fixtureQuotes(symbols: string[], now: Date, feed: DataFeed, tick = false): Promise<QuoteResponse> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const e = (mod.default ?? mod) as unknown as OptionsEdition;
  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];
  const second = tick ? Math.floor(now.getTime() / 1000) % 60 : 0;
  for (const s of symbols) {
    const t = e.tickers.find((x) => x.symbol === s);
    const close = t?.last?.close;
    const atr = t?.atr14 ?? 0;
    if (typeof close !== "number") {
      missing.push(s);
      continue;
    }
    const base = Math.round((close + FIXTURE_OFFSET_ATR * atr) * 100) / 100;
    const price = tick ? tickPrice(base, second) : base;
    quotes[s] = {
      price,
      at: `${e.session}T15:00:${String(second).padStart(2, "0")}.000Z`,
      open: close,
      high: Math.max(price, close),
      low: Math.min(price, close),
      day: e.session,
      prev_close: close,
      // Halfway between the open and the price: a VWAP that sits on the side the session has moved to.
      vwap: Math.round(((close + price) / 2) * 100) / 100,
    };
  }
  return { as_of: now.toISOString(), feed, quotes, missing, fixture: true };
}

/**
 * Fixture mode with `quotes-script`: the scripted names' quotes at the step (the `fxstep` cookie's, or one that
 * follows the server's clock), the leader SMH among them. The answer is dated the step, a few seconds after its last
 * trade, so the page's clock (the feed's `as_of`) stands at the step whatever the browser's clock says.
 */
async function scriptedQuotes(symbols: string[], step: number, feed: DataFeed): Promise<QuoteResponse> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const e = (mod.default ?? mod) as unknown as OptionsEdition;
  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];
  for (const s of symbols) {
    const q = scriptQuote(s, e.session, step, e.tickers.find((x) => x.symbol === s)?.last?.close ?? null);
    if (q) quotes[s] = q;
    else missing.push(s);
  }
  return { as_of: new Date(stepInstant(e.session, step) + SCRIPT_ANSWER_LAG_MS).toISOString(), feed, quotes, missing, fixture: true };
}

/** Fixture mode's answer: the scripted morning with `quotes-script`, else the fixture prices (ticking with `quotes-tick`). */
async function fixtureAnswer(symbols: string[], now: Date, flags: ReadonlySet<VariantFlag>, cookie: string | null, feed: DataFeed): Promise<Response> {
  if (flags.has("quotes-script")) return json(200, await scriptedQuotes(symbols, scriptStep(stepFromCookieHeader(cookie), now.getTime()), feed));
  return json(200, await fixtureQuotes(symbols, now, feed, flags.has("quotes-tick")));
}

/**
 * GET /api/quote?s=SPY,QQQ: live last trades from the configured Alpaca feed (alpaca-feed.ts), named in the answer's
 * `feed`. 503 until the keys are set, or while ALPACA_FEED is not a feed, in fixture mode too (the page then stops
 * asking), 429 when Alpaca rate-limits us (the page waits its longest), 502 for any other upstream failure.
 */
export async function handleQuote(req: Request, now: Date = new Date()): Promise<Response> {
  const symbols = parseSymbols(new URL(req.url).searchParams.get("s"));
  if (!symbols) return json(400, { error: "give ?s= with one or more ticker symbols" });
  const feed = configuredFeed();
  if (feed === null) return json(503, FEED_REFUSED);
  if (fixtureMode()) {
    const cookie = req.headers.get("cookie");
    const flags = flagsFromCookieHeader(cookie);
    if (flags.has("quotes-off")) return json(503, { error: "not-configured" });
    if (flags.has("quotes-error")) return json(502, { error: "upstream" });
    if (flags.has("quotes-flaky")) {
      // A short outage: this browser's count of requests rides in a cookie, so parallel tests never share it.
      const n = flakyCountFromCookieHeader(cookie);
      const res = flakyFails(n) ? json(502, { error: "upstream" }) : await fixtureAnswer(symbols, now, flags, cookie, feed);
      res.headers.append("set-cookie", `${FLAKY_COOKIE}=${n + 1}; Path=/; SameSite=Strict`);
      return res;
    }
    return fixtureAnswer(symbols, now, flags, cookie, feed);
  }
  const keys = alpacaKeys();
  if (!keys) return json(503, { error: "not-configured" });
  try {
    return json(200, await fetchQuotes(symbols, keys, now, fetch, undefined, { feed }));
  } catch (e) {
    logEvent("quote.fetch", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    // A rate limit is passed on as one, so the page waits its longest; anything else is 502.
    const status = upstreamStatus(e);
    return json(status, upstreamBody(status));
  }
}
