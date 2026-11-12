import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { delayMin, nyDate, OPRA_RETRY_MS } from "./chain";
import { fixtureChain, FIXTURE_OPRA_AGE_MS } from "./chain-route";
import { SCRIPT_ANSWER_LAG_MS, scriptStep, stepFromCookieHeader, stepInstant } from "./fixture-script";
import { FROZEN_NOW, flagsFromCookieHeader, type VariantFlag } from "./fixture-variants";
import type { OptionsEdition } from "./options.types";
import { logEvent } from "./log";
import { configuredOptionFeed, DEFAULT_OPTION_FEED, OPTION_FEED_REFUSED, type OptionFeed, opraAnswered, opraFallback, opraRefused } from "./option-feed";
import { type ContractQuote, type ContractResponse, MAX_CONTRACT_SYMBOLS, parseOccSymbol } from "./option-value";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";
import { upstreamBody, upstreamStatus, UpstreamError } from "./upstream";

// The latest quote and trade of a few named option contracts, for the manage card's live value and the ticket's price
// check (option-value.ts), read on the server so the browser keeps its connect-src 'self' policy and never sees the
// keys. The feed is the chain's (ALPACA_OPTION_FEED, option-feed.ts), read the same way and refused the same way; on
// indicative the answer says so, and the page shows no live value from it. One Alpaca call (the option snapshots of
// the due contracts) per refresh, each contract's answer shared for CONTRACT_CACHE_MS on an instance. Market data
// only: nothing here can place an order or read an account.

export type { ContractQuote, ContractResponse };

/**
 * A contract's answer is shared on one instance for this long: longer than the page's 2-second poll, so pages asking
 * for the same contract on one instance share one call (one page on its own asks upstream every 4 s).
 */
export const CONTRACT_CACHE_MS = 3_000;
/** Contracts remembered at once: a bound, so a stream of odd symbols cannot grow the cache. */
export const CONTRACT_MAX_CACHED = 256;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";

/**
 * The contracts from `?s=SPY261019P00760000,QQQ...`: every one a standard OCC symbol (option-value.ts parseOccSymbol),
 * at most MAX_CONTRACT_SYMBOLS, repeats dropped. Null when there is none, too many, or any one is not a symbol: the
 * request is refused whole, never answered in part.
 */
export function parseContractSymbols(raw: string | null): string[] | null {
  if (raw === null || raw === "") return null;
  const parts = raw.split(",");
  if (parts.length > MAX_CONTRACT_SYMBOLS) return null;
  if (parts.some((s) => parseOccSymbol(s) === null)) return null;
  return [...new Set(parts)];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const price = (v: unknown): number | null => (isNum(v) && v >= 0 ? v : null);
const size = (v: unknown): number | null => (isNum(v) && Number.isInteger(v) && v >= 0 ? v : null);
const stamp = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

type RawSnapshot = { latestQuote?: { bp?: unknown; ap?: unknown; bs?: unknown; as?: unknown; t?: unknown } | null; latestTrade?: { p?: unknown; t?: unknown } | null } | null | undefined;

/** Alpaca's option snapshot -> ContractQuote, or null when it carries neither a quote nor a trade. Unknown fields are ignored. */
export function normaliseContractQuote(raw: RawSnapshot): ContractQuote | null {
  const q = raw?.latestQuote;
  const t = raw?.latestTrade;
  const out: ContractQuote = {
    bid: price(q?.bp),
    ask: price(q?.ap),
    bid_size: size(q?.bs),
    ask_size: size(q?.as),
    quote_at: stamp(q?.t),
    last: price(t?.p) !== null && (t!.p as number) > 0 ? (t!.p as number) : null,
    last_at: stamp(t?.t),
  };
  return out.bid === null && out.ask === null && out.last === null ? null : out;
}

/** One contract's last answer on one feed, keyed `feed:symbol`: its quote (null when Alpaca had none) and when it was fetched. */
const cache = new Map<string, { at: number; quote: ContractQuote | null }>();
const cacheKey = (feed: OptionFeed, occ: string) => `${feed}:${occ}`;
/** When Alpaca last refused opra on this instance, and until when these quotes stay on indicative for it. */
let opraRefusedAt = -Infinity;
let opraRefusedUntil = -Infinity;

/** Test hook: forget the shared cache and any refusal of opra. */
export function resetContractCache(): void {
  cache.clear();
  opraRefusedAt = -Infinity;
  opraRefusedUntil = -Infinity;
}

/** The due contracts' snapshots from Alpaca on `feed`, into the cache. Throws UpstreamError on an HTTP error. */
async function load(due: readonly string[], keys: { id: string; secret: string }, t: number, fetchImpl: typeof fetch, baseUrl: string, feed: OptionFeed): Promise<void> {
  if (due.length === 0) return;
  const res = await fetchImpl(alpacaDataUrl(baseUrl, "/v1beta1/options/snapshots", { symbols: due.join(","), feed, limit: String(MAX_CONTRACT_SYMBOLS) }), {
    headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    logEvent("contract.fetch", { outcome: "http-error", status: res.status });
    throw new UpstreamError(res.status);
  }
  const body = (await res.json()) as { snapshots?: unknown };
  const map = (body && typeof body.snapshots === "object" && body.snapshots !== null ? body.snapshots : {}) as Record<string, RawSnapshot>;
  for (const s of due) {
    const key = cacheKey(feed, s);
    cache.delete(key);
    cache.set(key, { at: t, quote: normaliseContractQuote(Object.hasOwn(map, s) ? map[s] : null) });
  }
  // A Map iterates in insertion order, and a refreshed contract was just re-inserted: the first keys are the oldest.
  for (const k of cache.keys()) {
    if (cache.size <= CONTRACT_MAX_CACHED) break;
    cache.delete(k);
  }
}

/** The contracts due on `feed` at `t`: never fetched, past their time, or stamped after `t` (a clock that stepped back). */
const dueOn = (symbols: readonly string[], feed: OptionFeed, t: number) =>
  symbols.filter((s) => {
    const hit = cache.get(cacheKey(feed, s));
    return !hit || t < hit.at || t - hit.at >= CONTRACT_CACHE_MS;
  });

/**
 * The latest quote and trade of each contract on the option feed `feed`. A 403 on opra (not on the plan) is answered
 * from indicative instead, labelled `fallback: "opra-refused"`, and these quotes stay on indicative for OPRA_RETRY_MS
 * before trying opra again, as the chain does. Throws on any other transport or HTTP error (the route answers 502 or
 * 429) and caches nothing from it; the keys and the response body are never logged.
 */
export async function fetchContracts(
  symbols: readonly string[],
  keys: { id: string; secret: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
  feed: OptionFeed = DEFAULT_OPTION_FEED,
): Promise<ContractResponse> {
  const t = now.getTime();
  const refused = feed === "opra" && t >= opraRefusedAt && t < opraRefusedUntil;
  let used: OptionFeed = refused ? "indicative" : feed;
  try {
    await load(dueOn(symbols, used, t), keys, t, fetchImpl, baseUrl, used);
  } catch (e) {
    if (!opraRefused(used, e)) throw e;
    opraRefusedAt = t;
    opraRefusedUntil = t + OPRA_RETRY_MS;
    used = "indicative";
    try {
      await load(dueOn(symbols, used, t), keys, t, fetchImpl, baseUrl, used);
    } catch (e2) {
      opraFallback("error", e2);
      throw e2;
    }
    opraFallback("indicative");
  }
  if (used === "opra") opraAnswered();
  const contracts: Record<string, ContractQuote> = {};
  const missing: string[] = [];
  let oldest = t;
  for (const s of symbols) {
    const hit = cache.get(cacheKey(used, s));
    if (hit) oldest = Math.min(oldest, hit.at);
    if (hit?.quote) contracts[s] = hit.quote;
    else missing.push(s);
  }
  const answer: ContractResponse = { as_of: new Date(oldest).toISOString(), served_at: new Date(t).toISOString(), feed: used, delay_min: delayMin(used), contracts, missing };
  if (feed === "opra" && used !== "opra") answer.fallback = "opra-refused";
  return answer;
}

/**
 * Fixture mode: each contract's quote from the fixture chain of its name (chain-route.ts fixtureChain), priced at
 * `priceNow` as the chain route prices it (the server's clock), so the card, the ticket and the contract pane agree
 * on prices. Its times are the board's clock (`stampNow`, fixtureStampClock): served then, quoted a few seconds
 * before on opra (15 minutes on indicative), so the page's session checks read the fixture's session. Opra with the
 * `chain-opra` flag, indicative otherwise; `chain-thin` damages the same contracts as in the chain. A name the fixture
 * does not carry, an expiry already past, or a contract not in the chain is missing.
 */
export async function fixtureContracts(symbols: readonly string[], priceNow: Date, thin: boolean, feed: OptionFeed, stampNow: Date = priceNow): Promise<ContractResponse> {
  const contracts: Record<string, ContractQuote> = {};
  const missing: string[] = [];
  const today = nyDate(priceNow);
  const quoted = new Date(stampNow.getTime() - (feed === "opra" ? FIXTURE_OPRA_AGE_MS : delayMin(feed) * 60_000)).toISOString();
  for (const s of symbols) {
    const p = parseOccSymbol(s)!;
    const chain = p.expiry >= today ? await fixtureChain(p.root, priceNow, thin, { expiry: p.expiry, strike: p.strike }, feed) : null;
    const c = chain?.expiries.find((x) => x.date === p.expiry)?.contracts.find((x) => x.kind === p.kind && x.strike === p.strike);
    if (!c || (c.bid === null && c.ask === null && c.last === null)) {
      missing.push(s);
      continue;
    }
    contracts[s] = { bid: c.bid, ask: c.ask, bid_size: c.bid_size, ask_size: c.ask_size, quote_at: quoted, last: c.last, last_at: c.last !== null ? quoted : null };
  }
  const at = stampNow.toISOString();
  return { as_of: at, served_at: at, feed, delay_min: delayMin(feed), contracts, missing, fixture: true };
}

/**
 * The board's clock in fixture mode, as the quote route keeps it: the scripted step's answer time with
 * `quotes-script` (the `fxstep` cookie's step, or the one the server's clock is on), the stood-still instant with
 * `frozen`, else the server's clock.
 */
export async function fixtureStampClock(flags: ReadonlySet<VariantFlag>, cookie: string | null, now: Date): Promise<Date> {
  if (flags.has("quotes-script")) {
    const mod = await import("../../test/fixtures/options.v1.json");
    const e = (mod.default ?? mod) as unknown as OptionsEdition;
    return new Date(stepInstant(e.session, scriptStep(stepFromCookieHeader(cookie), now.getTime())) + SCRIPT_ANSWER_LAG_MS);
  }
  return flags.has("frozen") ? new Date(FROZEN_NOW) : now;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * GET /api/contract?s=SPY261019P00760000[,...]: up to MAX_CONTRACT_SYMBOLS option contracts' latest quote and trade,
 * from the option feed ALPACA_OPTION_FEED names (option-feed.ts; indicative unless the owner has chosen opra), named
 * in the answer. 400 for anything that is not a list of OCC symbols. 503 until the keys are set, and while
 * ALPACA_OPTION_FEED is not a feed. In fixture mode the setting is not read: the chain's fixture flags apply
 * (`chain-off` 503, `chain-error` 502, `chain-thin`, `chain-opra`).
 */
export async function handleContract(req: Request, now: Date = new Date()): Promise<Response> {
  const symbols = parseContractSymbols(new URL(req.url).searchParams.get("s"));
  if (!symbols) return json(400, { error: `give ?s= with 1 to ${MAX_CONTRACT_SYMBOLS} option contract symbols, comma separated` });
  if (fixtureMode()) {
    const flags = flagsFromCookieHeader(req.headers.get("cookie"));
    if (flags.has("chain-off")) return json(503, { error: "not-configured" });
    if (flags.has("chain-error")) return json(502, { error: "upstream" });
    const cookie = req.headers.get("cookie");
    const stamp = await fixtureStampClock(flags, cookie, now);
    return json(200, await fixtureContracts(symbols, now, flags.has("chain-thin"), flags.has("chain-opra") ? "opra" : "indicative", stamp));
  }
  const feed = configuredOptionFeed();
  if (feed === null) return json(503, OPTION_FEED_REFUSED);
  const keys = alpacaKeys();
  if (!keys) return json(503, { error: "not-configured" });
  try {
    return json(200, await fetchContracts(symbols, keys, now, fetch, undefined, feed));
  } catch (e) {
    logEvent("contract.fetch", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    const status = upstreamStatus(e);
    return json(status, upstreamBody(status));
  }
}
