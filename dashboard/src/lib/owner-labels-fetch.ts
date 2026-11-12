import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { labelFeed, type BarsRequest, type LabelBar, type LabelFeed, type LabelSessionBounds } from "./owner-labels";

// The labels' bars (DEC-0049 point 1): one finished session's settled 2-minute bars from the stock feed the caller
// names (iex or sip), a required argument with no default: the experiment's own config names it. Its own request,
// built by alpacaDataUrl with that feed. It never uses the board's bars fetch (bars.ts) and never reads the site's feed
// setting, so a change of the board's feed cannot reach the labels. Read-only GETs of
// historical bars. Alpaca's volume (`v`) and VWAP (`vw`) are kept: the leader quote's VWAP is built from them.
//
// The keys are passed in and go only into Alpaca's headers, to an https alpaca.markets host, with redirects refused.
// A key, a page token or a response body is never logged, kept or put in an error. Retrying is the caller's business.
//
// Wired to nothing in this release (DEC-0045 point 5).

export const DEFAULT_DATA_URL = "https://data.alpaca.markets";
/** The longest one call may take. */
export const CALL_TIMEOUT_MS = 15_000;
/** Bars per page: Alpaca's largest. */
export const PAGE_LIMIT = 10_000;
/** Pages read at most: a session of 2-minute bars for a focus card and its leaders fits in one. */
export const MAX_PAGES = 20;
const BAR_MS = 2 * 60_000;

/**
 * The data URL, if it may carry the keys: https on data.alpaca.markets or another alpaca.markets host, with no user,
 * password or port (the rule of feed-agreement-fetch.ts alpacaHost). Null otherwise.
 */
export function dataBase(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!(h === "data.alpaca.markets" || h.endsWith(".alpaca.markets"))) return null;
  return url.replace(/\/+$/, "");
}

/** One page's query: the feed named by the caller. */
function labelBarsParams(feed: LabelFeed, symbols: readonly string[], bounds: Pick<LabelSessionBounds, "open" | "close">, token: string | null): Record<string, string> {
  const q: Record<string, string> = {
    symbols: symbols.join(","),
    timeframe: "2Min",
    start: new Date(bounds.open).toISOString(),
    end: new Date(bounds.close).toISOString(),
    feed: labelFeed(feed),
    limit: String(PAGE_LIMIT),
    adjustment: "raw",
    sort: "asc",
  };
  if (token) q.page_token = token;
  return q;
}

/** One page's request URL, built by alpacaDataUrl. */
export function labelBarsUrl(base: string, feed: LabelFeed, symbols: readonly string[], bounds: Pick<LabelSessionBounds, "open" | "close">, token: string | null): string {
  return alpacaDataUrl(base, "/v2/stocks/bars", labelBarsParams(feed, symbols, bounds, token));
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One Alpaca bar as a LabelBar, or null when it is unusable or not inside the session on the 2-minute grid. */
export function normaliseLabelBar(raw: unknown, bounds: Pick<LabelSessionBounds, "open" | "close">): LabelBar | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  const start = Date.parse(raw.t);
  const { o, h, l, c, v, vw } = raw;
  if (!Number.isFinite(start) || !isNum(o) || !isNum(h) || !isNum(l) || !isNum(c) || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  if (start % BAR_MS !== 0 || start < bounds.open || start + BAR_MS > bounds.close) return null;
  return { start, end: start + BAR_MS, o, h, l, c, v: isNum(v) && v >= 0 ? v : null, vw: isNum(vw) && vw > 0 ? vw : null };
}

export type LabelBarsFailure = "bad_host" | "transport" | "timeout" | "rate_limited" | "refused" | "http" | "malformed";

export type LabelBarsAnswer =
  /**
   * `fetchedAt`: when the last page arrived, ISO 8601. A symbol with no bar has an empty list. `requests`: one per
   * request, with `complete` false when it was still paging at MAX_PAGES (its bars are then cut short, and the answer
   * is not full under EXP-0033 `labeller_rules.fetch`).
   */
  | { ok: true; feed: LabelFeed; bars: Record<string, LabelBar[]>; fetchedAt: string; requests: (BarsRequest & { pages: number })[] }
  /** No bars: the session's positions are no_record (DEC-0049 point 1). `status` and `retryAfterMs` only, nothing else
   * from the answer. */
  | { ok: false; feed: LabelFeed; reason: LabelBarsFailure; status: number | null; retryAfterMs: number | null };

export interface LabelBarsOpts {
  keys: { id: string; secret: string };
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
  /** The clock the fetch time is read from. */
  now?: () => Date;
}

/** Retry-After as seconds or an HTTP date, in ms from `now`; null when absent or unreadable. */
function retryAfter(h: string | null, now: number): number | null {
  if (!h) return null;
  const s = Number(h.trim());
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The session's 2-minute bars from `feed` for `symbols`, oldest first, one per slot: every next_page_token page read up to
 * MAX_PAGES, each bar kept only inside the session, in one request. An answer says per request whether its last page
 * came back with no next page token; a transport or HTTP failure is a typed failure with no bars.
 */
export async function fetchLabelBars(feed: LabelFeed, symbols: readonly string[], bounds: Pick<LabelSessionBounds, "open" | "close">, o: LabelBarsOpts): Promise<LabelBarsAnswer> {
  // Anything but "iex" or "sip" throws here, before any request.
  const named = labelFeed(feed);
  const fail = (reason: LabelBarsFailure, status: number | null = null, retryAfterMs: number | null = null): LabelBarsAnswer => ({ ok: false, feed: named, reason, status, retryAfterMs });
  const base = dataBase(o.baseUrl ?? DEFAULT_DATA_URL);
  // A data URL that is not Alpaca's never gets the keys.
  if (base === null) return fail("bad_host");
  const clock = o.now ?? (() => new Date());
  const fetchImpl = o.fetchImpl ?? fetch;
  const got = new Map<string, Map<number, LabelBar>>(symbols.map((s) => [s, new Map()]));
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = alpacaDataUrl(base, "/v2/stocks/bars", labelBarsParams(named, symbols, bounds, token));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "APCA-API-KEY-ID": o.keys.id, "APCA-API-SECRET-KEY": o.keys.secret, accept: "application/json" },
        cache: "no-store",
        // The keys go to Alpaca only: a redirect anywhere else is refused, never followed.
        redirect: "error",
        signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      return fail(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "transport");
    }
    if (res.status === 429) return fail("rate_limited", 429, retryAfter(res.headers.get("retry-after"), clock().getTime()));
    if (res.status === 401 || res.status === 403) return fail("refused", res.status);
    if (!res.ok) return fail("http", res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return fail(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "malformed", res.status);
    }
    if (!isObj(body)) return fail("malformed", res.status);
    const bars = body.bars;
    if (bars !== undefined && bars !== null && !isObj(bars)) return fail("malformed", res.status);
    for (const [s, list] of Object.entries(isObj(bars) ? bars : {})) {
      const into = got.get(s);
      if (!into) continue;
      if (list !== null && !Array.isArray(list)) return fail("malformed", res.status);
      for (const raw of list ?? []) {
        const b = normaliseLabelBar(raw, bounds);
        if (b) into.set(b.start, b);
      }
    }
    token = typeof body.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token || page === MAX_PAGES - 1) {
      const out: Record<string, LabelBar[]> = {};
      for (const [s, m] of got) out[s] = [...m.values()].sort((a, b) => a.start - b.start);
      return { ok: true, feed: named, bars: out, fetchedAt: clock().toISOString(), requests: [{ pages: page + 1, complete: !token }] };
    }
  }
  throw new Error("unreachable: MAX_PAGES must be at least 1");
}
