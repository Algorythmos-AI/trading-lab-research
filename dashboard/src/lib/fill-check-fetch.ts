import "server-only";
import { alpacaNoFeedUrl } from "./alpaca-data-url";
import { alpacaHost, retryAfterMs } from "./feed-agreement-fetch";
import type { RawPrint } from "./fill-check";

// Alpaca's historical option trades for the fill-time check (DEC-0049 point 4): one contract, one span of at most
// 5 min 10 s either side of a unit's time, read-only GETs. Alpaca has no historical option quotes, so trades are all
// there is. This endpoint takes no `feed` parameter: the option trades come from OPRA whatever ALPACA_FEED says, and
// nothing here reads that setting.
//
// The keys are read as quote.ts reads them (alpacaKeys) and go only into Alpaca's headers. A key, a page token or a
// response body is never logged, kept or put in an error; the prints returned are matched and dropped by the run.

export const DEFAULT_DATA_URL = "https://data.alpaca.markets";
/** The longest one call may take, as quote.ts allows a snapshot call. */
export const CALL_TIMEOUT_MS = 8_000;
/** Prints per page: Alpaca's largest page for this endpoint. */
export const PAGE_LIMIT = 10_000;
/**
 * Pages read for one span at most: 5 × 10 000 = 50 000 prints in a span of 10 min 20 s, far past any single contract's
 * tape. Past it the unit is "not checked: answer incomplete".
 */
export const MAX_PAGES = 5;

/**
 * A failed read: `retryable` for a transport error, a timeout, a 429 or a 5xx. Carries the HTTP status and, on a 429,
 * the wait Alpaca asked for (Retry-After, in ms; null when absent or unreadable). Nothing else from the answer.
 */
export class TradesFetchError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly status: number | null,
    readonly retryAfter: number | null = null,
  ) {
    super(status === null ? "alpaca option trades: transport" : `alpaca option trades ${status}`);
    this.name = "TradesFetchError";
  }
}

/** One span of one contract, in ms since the epoch (fill-check.ts requestSpan). */
export interface TradeQuery {
  symbol: string;
  startMs: number;
  endMs: number;
}

export type TradeAnswer = { kind: "prints"; prints: RawPrint[] } | { kind: "incomplete" };

/** `signal` is the run's own deadline: no request outlives the run's budget. */
export type TradeFetcher = (q: TradeQuery, signal?: AbortSignal) => Promise<TradeAnswer>;

export interface TradesFetchOpts {
  keys: { id: string; secret: string };
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * The data URL, if it may carry the keys: https on data.alpaca.markets or another alpaca.markets host, with no user,
 * password or port (feed-agreement-fetch.ts alpacaHost, the same rule). Null otherwise.
 */
export function dataBase(url: string): string | null {
  return alpacaHost(url) === null ? null : url.replace(/\/+$/, "");
}

/** The path of Alpaca's historical option trades: no feed parameter (alpaca-data-url.ts alpacaNoFeedUrl). */
export const TRADES_PATH = "/v1beta1/options/trades";

/** One page's query. `start` and `end` are the span's own bounds; nothing wider is ever asked for. */
function tradesParams(q: TradeQuery, token: string | null): Record<string, string> {
  return {
    symbols: q.symbol,
    start: new Date(q.startMs).toISOString(),
    end: new Date(q.endMs).toISOString(),
    limit: String(PAGE_LIMIT),
    sort: "asc",
    ...(token ? { page_token: token } : {}),
  };
}

/** The request URL for one page, built by alpacaNoFeedUrl. */
export function tradesUrl(base: string, q: TradeQuery, token: string | null): string {
  return alpacaNoFeedUrl(base, TRADES_PATH, tradesParams(q, token));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The prints of one contract in one span, every page followed up to MAX_PAGES; "incomplete" when Alpaca is still
 * paging after that. Throws TradesFetchError on a transport error, a timeout, an HTTP error, a body that is not JSON
 * or an answer of the wrong shape. Retrying is the run's business (fill-check-run.ts).
 */
export async function fetchOptionTrades(q: TradeQuery, o: TradesFetchOpts): Promise<TradeAnswer> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = dataBase(o.baseUrl ?? DEFAULT_DATA_URL);
  // A data URL that is not Alpaca's never gets the keys.
  if (base === null) throw new TradesFetchError(false, null);
  const prints: RawPrint[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = alpacaNoFeedUrl(base, TRADES_PATH, tradesParams(q, token));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "APCA-API-KEY-ID": o.keys.id, "APCA-API-SECRET-KEY": o.keys.secret, accept: "application/json" },
        cache: "no-store",
        // The keys go to Alpaca only: a redirect anywhere else is refused, never followed.
        redirect: "error",
        signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new TradesFetchError(true, null);
    }
    if (res.status === 429) throw new TradesFetchError(true, 429, retryAfterMs(res.headers.get("retry-after"), Date.now()));
    if (!res.ok) throw new TradesFetchError(res.status >= 500, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TradesFetchError(true, null);
    }
    if (!isObj(body)) throw new TradesFetchError(false, res.status);
    const trades = body.trades;
    if (trades !== undefined && trades !== null && !isObj(trades)) throw new TradesFetchError(false, res.status);
    const list = isObj(trades) ? trades[q.symbol] : undefined;
    if (list !== undefined && list !== null && !Array.isArray(list)) throw new TradesFetchError(false, res.status);
    for (const p of Array.isArray(list) ? list : []) if (isObj(p)) prints.push({ t: p.t, p: p.p, c: p.c });
    token = typeof body.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token) return { kind: "prints", prints };
  }
  return { kind: "incomplete" };
}
