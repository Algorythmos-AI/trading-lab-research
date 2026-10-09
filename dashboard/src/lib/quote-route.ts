import "server-only";
import { logEvent } from "./log";
import type { OptionsEdition } from "./options.types";
import { alpacaKeys, fetchQuotes, parseSymbols, type Quote, type QuoteResponse } from "./quote";
import { fixtureMode } from "./snapshot";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Fixture mode: a quote for each fixture name, a fixed fraction of an ATR above its close, dated the fixture's
 * session at 11:00 New York. Lets the browser tests drive the live panel with no network and no keys.
 */
async function fixtureQuotes(symbols: string[], now: Date): Promise<QuoteResponse> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const e = (mod.default ?? mod) as unknown as OptionsEdition;
  const quotes: Record<string, Quote> = {};
  const missing: string[] = [];
  for (const s of symbols) {
    const t = e.tickers.find((x) => x.symbol === s);
    const close = t?.last?.close;
    const atr = t?.atr14 ?? 0;
    if (typeof close !== "number") {
      missing.push(s);
      continue;
    }
    const price = Math.round((close + 0.3 * atr) * 100) / 100;
    quotes[s] = {
      price,
      at: `${e.session}T15:00:00.000Z`,
      open: close,
      high: Math.max(price, close),
      low: Math.min(price, close),
      day: e.session,
      prev_close: close,
    };
  }
  return { as_of: now.toISOString(), feed: "iex", quotes, missing, fixture: true };
}

/** GET /api/quote?s=SPY,QQQ: live last trades from Alpaca's IEX feed. 503 until the keys are set. */
export async function handleQuote(req: Request, now: Date = new Date()): Promise<Response> {
  const symbols = parseSymbols(new URL(req.url).searchParams.get("s"));
  if (!symbols) return json(400, { error: "give ?s= with one or more ticker symbols" });
  if (fixtureMode()) return json(200, await fixtureQuotes(symbols, now));
  const keys = alpacaKeys();
  if (!keys) return json(503, { error: "not-configured" });
  try {
    return json(200, await fetchQuotes(symbols, keys, now));
  } catch (e) {
    logEvent("quote.fetch", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return json(502, { error: "upstream" });
  }
}
