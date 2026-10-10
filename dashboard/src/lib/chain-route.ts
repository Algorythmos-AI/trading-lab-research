import "server-only";
import { greeks, price } from "./bs";
import {
  addDays,
  CHAIN_DELAY_MIN,
  fetchChain,
  NEAR_EXPIRIES,
  nyDate,
  parseKeep,
  parsePrice,
  parseSymbol,
  STRIKES_PER_EXPIRY,
  SWING_MIN_DAYS,
  type ChainContract,
  type ChainExpiry,
  type ChainResponse,
  type Keep,
} from "./chain";
import { FIXTURE_OFFSET_ATR, flagsFromCookieHeader } from "./fixture-variants";
import { logEvent } from "./log";
import { nyInstant } from "./options";
import type { OptionsEdition } from "./options.types";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const cents = (v: number) => Math.round(v * 100) / 100;

/**
 * The expiries a fixture chain carries: the next few weekdays from `from`, and the first Friday a fortnight out.
 * `from` is today in New York until today's closing bell, and tomorrow after it, so the first expiry is always
 * one that can still be priced.
 */
export function fixtureExpiries(from: string): string[] {
  const out: string[] = [];
  for (let d = from; out.length < NEAR_EXPIRIES; d = addDays(d, 1)) if (weekday(d) >= 1 && weekday(d) <= 5) out.push(d);
  let swing = addDays(from, SWING_MIN_DAYS);
  while (weekday(swing) !== 5) swing = addDays(swing, 1);
  return out.includes(swing) ? out : [...out, swing];
}

/**
 * Fixture mode: a chain for a fixture name, priced by the desk's own arithmetic from that name's implied volatility
 * with a mild smile, around the price the fixture's live feed quotes. Dated from `now`, so no expiry in it has
 * passed, and its quotes are as old as the real feed's would be. Lets the browser tests drive the contract pane
 * with no network and no keys. `thin` damages the nearest expiry's first three calls, one way each.
 */
export async function fixtureChain(symbol: string, now: Date, thin = false, keep: Keep | null = null): Promise<ChainResponse> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const e = (mod.default ?? mod) as unknown as OptionsEdition;
  const t = e.tickers.find((x) => x.symbol === symbol);
  const close = t?.last?.close;
  const base: ChainResponse = { as_of: now.toISOString(), feed: "indicative", delay_min: CHAIN_DELAY_MIN, symbol, expiries: [], fixture: true };
  if (typeof close !== "number") return base;
  const spot = cents(close + FIXTURE_OFFSET_ATR * (t?.atr14 ?? 0));
  const vol = t?.expected_move?.annual_iv ?? 0.3;
  const step = spot < 50 ? 0.5 : spot < 300 ? 1 : 5;
  const centre = Math.round(spot / step) * step;
  const half = (STRIKES_PER_EXPIRY - 1) / 2;
  const quoted = new Date(now.getTime() - CHAIN_DELAY_MIN * 60_000);
  const today = nyDate(now);
  const rung = (nyInstant(today, 16 * 60) ?? Infinity) <= now.getTime();
  const dates = fixtureExpiries(rung ? addDays(today, 1) : today);
  // The reader's own contract is in the answer wherever it sits, as it is in the real one.
  if (keep && !dates.includes(keep.expiry)) dates.push(keep.expiry);
  const expiries: ChainExpiry[] = dates.sort().map((date) => {
    const bell = nyInstant(date, 16 * 60) ?? now.getTime();
    const minutes = (bell - quoted.getTime()) / 60_000;
    const contracts: ChainContract[] = [];
    const strikes = Array.from({ length: STRIKES_PER_EXPIRY }, (_, n) => cents(centre + (n - half) * step)).filter((x) => x > 0);
    if (keep && keep.expiry === date && !strikes.includes(keep.strike)) strikes.push(keep.strike);
    strikes.sort((a, b) => a - b);
    for (const kind of ["call", "put"] as const) {
      for (const strike of strikes) {
        const i = (strike - centre) / step;
        const sigma = vol * (1 + 0.6 * Math.abs(Math.log(strike / spot)));
        const value = price(spot, strike, minutes, sigma, kind);
        contracts.push({
          kind,
          strike,
          bid: Math.max(0, Math.floor((value * 0.98 - 0.01) * 100) / 100),
          ask: Math.ceil((value * 1.02 + 0.01) * 100) / 100,
          last: value >= 0.01 ? cents(value) : null,
          at: quoted.toISOString(),
          iv: sigma,
          delta: greeks(spot, strike, minutes, sigma, kind)?.delta ?? null,
          volume: Math.round(5000 / (1 + Math.abs(i))),
        });
      }
    }
    return { date, contracts };
  });
  const first = expiries[0]?.contracts;
  if (thin && first && first.length >= 3) {
    first[0] = { ...first[0]!, iv: null, delta: null };
    first[1] = { ...first[1]!, bid: 0, ask: 0, last: null };
    first[2] = { ...first[2]!, bid: (first[2]!.ask ?? 1) + 0.5 };
  }
  return { ...base, expiries };
}

/**
 * GET /api/chain?s=SPY&px=780.43[&x=2026-10-30&k=785]: calls and puts for one name around a price, from Alpaca's
 * indicative feed (15 minutes behind the market), always including the contract named by `x` and `k` when given.
 * 503 until the keys are set.
 */
export async function handleChain(req: Request, now: Date = new Date()): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const symbol = parseSymbol(params.get("s"));
  const px = parsePrice(params.get("px"));
  if (!symbol || px === null) return json(400, { error: "give ?s= with one ticker symbol and ?px= with its price" });
  // The reader's own contract, when they have one. A malformed one is simply not kept.
  const keep = parseKeep(params.get("x"), params.get("k"), nyDate(now));
  if (fixtureMode()) {
    const flags = flagsFromCookieHeader(req.headers.get("cookie"));
    if (flags.has("chain-off")) return json(503, { error: "not-configured" });
    if (flags.has("chain-error")) return json(502, { error: "upstream" });
    return json(200, await fixtureChain(symbol, now, flags.has("chain-thin"), keep));
  }
  const keys = alpacaKeys();
  if (!keys) return json(503, { error: "not-configured" });
  try {
    return json(200, await fetchChain(symbol, px, keys, now, fetch, undefined, keep));
  } catch (e) {
    logEvent("chain.fetch", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return json(502, { error: "upstream" });
  }
}
