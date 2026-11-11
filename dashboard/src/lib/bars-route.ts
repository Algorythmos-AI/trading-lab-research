import "server-only";
import { configuredFeed, type DataFeed, FEED_REFUSED } from "./alpaca-feed";
import { type BarsResponse, fetchBars } from "./bars";
import { FIXTURE_OFFSET_ATR, flagsFromCookieHeader } from "./fixture-variants";
import { scriptBars, scriptStep, stepFromCookieHeader, stepInstant } from "./fixture-script";
import { SERVER_SETTLE_MS } from "./trade-state";
import { logEvent } from "./log";
import { upstreamBody, upstreamStatus } from "./upstream";
import { nyInstant, OPEN_MIN } from "./options";
import type { OptionsEdition } from "./options.types";
import { alpacaKeys, parseSymbols } from "./quote";
import { fixtureMode } from "./snapshot";
import type { Bar2 } from "./trade-state";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Fixture mode: each fixture name's bars from 09:30 to 11:00 New York on the fixture's session, a straight walk from
 * its close to the fixture quote's price (a fixed fraction of an ATR above it), so the bars meet the quote. With
 * `quotes-script`, the scripted names' bars up to the step instead. No network and no keys.
 */
async function fixtureBars(symbols: string[], now: Date, script: { step: number } | null, feed: DataFeed): Promise<BarsResponse> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const e = (mod.default ?? mod) as unknown as OptionsEdition;
  const bars: Record<string, Bar2[]> = {};
  const missing: string[] = [];
  const open = nyInstant(e.session, OPEN_MIN) ?? 0;
  for (const s of symbols) {
    if (script) {
      const got = scriptBars(s, e.session, script.step);
      if (got.length) bars[s] = got;
      else missing.push(s);
      continue;
    }
    const t = e.tickers.find((x) => x.symbol === s);
    const close = t?.last?.close;
    if (typeof close !== "number") {
      missing.push(s);
      continue;
    }
    const target = close + FIXTURE_OFFSET_ATR * (t?.atr14 ?? 0);
    const n = 45; // 09:30 to 11:00
    const at = (i: number) => r2(close + ((target - close) * i) / n);
    bars[s] = Array.from({ length: n }, (_, i) => {
      const o = at(i);
      const c = at(i + 1);
      const start = open + i * 120_000;
      return { start, end: start + 120_000, o, h: r2(Math.max(o, c) + 0.05), l: r2(Math.min(o, c) - 0.05), c };
    });
  }
  const asOf = script ? stepInstant(e.session, script.step) : now.getTime();
  // The scripted bars are the session as it was, final: they read as settled (SERVER_SETTLE_MS) at the step's clock.
  const fetchedAt = Object.fromEntries(Object.keys(bars).map((s) => [s, asOf + SERVER_SETTLE_MS]));
  return { as_of: new Date(asOf).toISOString(), feed, bars, fetchedAt, missing, fixture: true };
}

/**
 * GET /api/bars?s=SPY,QQQ[&half=1]: today's regular-session 2-minute bars from the configured Alpaca feed
 * (alpaca-feed.ts), to 13:00 New York with `half=1` (the edition's half-day flag). 503 until the keys are set, or
 * while ALPACA_FEED is not a feed (in fixture mode too).
 */
export async function handleBars(req: Request, now: Date = new Date()): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const symbols = parseSymbols(params.get("s"));
  if (!symbols) return json(400, { error: "give ?s= with one or more ticker symbols" });
  const half = params.get("half");
  if (half !== null && half !== "1") return json(400, { error: "half is 1 or absent" });
  const halfDay = half === "1";
  const feed = configuredFeed();
  if (feed === null) return json(503, FEED_REFUSED);
  if (fixtureMode()) {
    const cookie = req.headers.get("cookie");
    const flags = flagsFromCookieHeader(cookie);
    if (flags.has("quotes-off")) return json(503, { error: "not-configured" });
    if (flags.has("quotes-error")) return json(502, { error: "upstream" });
    const script = flags.has("quotes-script") ? { step: scriptStep(stepFromCookieHeader(cookie), now.getTime()) } : null;
    return json(200, await fixtureBars(symbols, now, script, feed));
  }
  const keys = alpacaKeys();
  if (!keys) return json(503, { error: "not-configured" });
  try {
    return json(200, await fetchBars(symbols, keys, now, fetch, undefined, halfDay, { feed }));
  } catch (e) {
    logEvent("bars.fetch", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    // A rate limit is passed on as one, so the page waits its longest; anything else is 502.
    const status = upstreamStatus(e);
    return json(status, upstreamBody(status));
  }
}
