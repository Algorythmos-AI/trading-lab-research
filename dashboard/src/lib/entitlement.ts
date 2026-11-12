import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { logEvent } from "./log";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";

// What the site's Alpaca keys are entitled to, asked of Alpaca itself rather than read from a setting: the stock SIP
// feed (one latest quote for SPY), the OPRA option feed (one option snapshot), and the calls a minute Alpaca grants
// them (its X-RateLimit-Limit header). At most once per ENTITLEMENT_EVERY_MS on an instance, whoever asks; /api/health
// and the Feeds page show it. A 403 is the plan refusing that feed; anything else that is not a success, or no answer
// in time, is an error, never read as a refusal. Market data only: nothing here can place an order or read an
// account, and neither the keys nor a response body is kept or logged.

export interface Entitlement {
  /** When Alpaca was asked (the server's clock), ISO 8601. */
  checked_at: string;
  stock: "sip" | "refused" | "error";
  option: "opra" | "refused" | "error";
  /** Alpaca's X-RateLimit-Limit for these keys, or null when it sent none that reads as a whole number. */
  calls_per_min: number | null;
}

/** Alpaca is asked again after this long, at the earliest. */
export const ENTITLEMENT_EVERY_MS = 10 * 60_000;
/** Each of the two calls gives up after this long, and counts as an error. */
export const ENTITLEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";

/** Fixture mode's answer: the full plan, dated `now`. No network, no keys. */
export function fixtureEntitlement(now: Date): Entitlement {
  return { checked_at: now.toISOString(), stock: "sip", option: "opra", calls_per_min: 10_000 };
}

type Outcome = { status: number | null; limit: string | null };

async function ask(url: string, keys: { id: string; secret: string }, fetchImpl: typeof fetch): Promise<Outcome> {
  try {
    const res = await fetchImpl(url, {
      headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(ENTITLEMENT_TIMEOUT_MS),
    });
    // The body is not read: only whether the feed answered.
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, limit: res.headers.get("x-ratelimit-limit") };
  } catch {
    return { status: null, limit: null };
  }
}

/** A status as the probe reads it: 200 the feed, 403 the plan refusing it, anything else (or none) an error. */
export function readStatus<F extends string>(status: number | null, feed: F): F | "refused" | "error" {
  if (status === 200) return feed;
  if (status === 403) return "refused";
  return "error";
}

/** X-RateLimit-Limit as a whole number of calls a minute, or null. */
export function readLimit(raw: string | null): number | null {
  const v = (raw ?? "").trim();
  if (!/^\d{1,7}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/** Ask Alpaca now: the two calls at once, each naming its feed. */
export async function probeEntitlement(
  keys: { id: string; secret: string },
  now: Date,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
): Promise<Entitlement> {
  const [stock, option] = await Promise.all([
    ask(alpacaDataUrl(baseUrl, "/v2/stocks/SPY/quotes/latest", { feed: "sip" }), keys, fetchImpl),
    ask(alpacaDataUrl(baseUrl, "/v1beta1/options/snapshots/SPY", { feed: "opra", limit: "1" }), keys, fetchImpl),
  ]);
  const out: Entitlement = {
    checked_at: now.toISOString(),
    stock: readStatus(stock.status, "sip"),
    option: readStatus(option.status, "opra"),
    calls_per_min: readLimit(stock.limit) ?? readLimit(option.limit),
  };
  logEvent("alpaca.entitlement", { stock: out.stock, option: out.option, ...(stock.status !== null ? { stock_status: stock.status } : {}), ...(option.status !== null ? { option_status: option.status } : {}) });
  return out;
}

let last: { at: number; value: Entitlement } | null = null;
let inFlight: Promise<Entitlement> | null = null;

/** Test hook: forget the last answer. */
export function resetEntitlement(): void {
  last = null;
  inFlight = null;
}

/**
 * The keys' entitlement, from this instance's last answer while it is under ENTITLEMENT_EVERY_MS old (and not stamped
 * after `now`), else from Alpaca, with one probe in flight however many ask at once. Null without keys: nothing is
 * asked. In fixture mode the fixed answer, never the network.
 */
export async function entitlement(
  opts: { now?: Date; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; baseUrl?: string } = {},
): Promise<Entitlement | null> {
  const now = opts.now ?? new Date();
  if (fixtureMode()) return fixtureEntitlement(now);
  const keys = alpacaKeys(opts.env);
  if (!keys) return null;
  const t = now.getTime();
  if (last && t >= last.at && t - last.at < ENTITLEMENT_EVERY_MS) return last.value;
  if (inFlight) return inFlight;
  const p = probeEntitlement(keys, now, opts.fetchImpl, opts.baseUrl)
    .then((value) => {
      last = { at: t, value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = p;
  return p;
}

/** /api/health waits at most this long for a first probe; past it the field is left out of that answer. */
export const HEALTH_WAIT_MS = 300;

/**
 * For /api/health, which must not wait on Alpaca: this instance's last answer at once when it has one (and, once
 * that is ENTITLEMENT_EVERY_MS old, a refresh started for the next reader); with none yet, the probe raced against
 * `waitMs`, null when it loses. `pending` is a refresh still running, for the route to keep alive past its answer
 * (next/server `after`); it never rejects. Null without keys; fixed in fixture mode.
 */
export async function entitlementForHealth(
  opts: { now?: Date; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; baseUrl?: string; waitMs?: number } = {},
): Promise<{ value: Entitlement | null; pending: Promise<void> | null }> {
  const now = opts.now ?? new Date();
  if (fixtureMode()) return { value: fixtureEntitlement(now), pending: null };
  if (!alpacaKeys(opts.env)) return { value: null, pending: null };
  const t = now.getTime();
  const held = last;
  if (held && t >= held.at && t - held.at < ENTITLEMENT_EVERY_MS) return { value: held.value, pending: null };
  const run = entitlement(opts);
  const pending = run.then(
    () => undefined,
    () => undefined,
  );
  if (held) return { value: held.value, pending };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.waitMs ?? HEALTH_WAIT_MS);
  });
  const value = await Promise.race([run.catch(() => null), lost]);
  clearTimeout(timer);
  return value ? { value, pending: null } : { value: null, pending };
}

const WORD: Record<Entitlement["stock"] | Entitlement["option"], string> = { sip: "SIP", opra: "OPRA", refused: "refused by the plan", error: "could not be checked" };

/** The Feeds page's line: "Stock SIP · options OPRA · 10,000 calls a minute". */
export function entitlementWords(e: Entitlement): string {
  const calls = e.calls_per_min === null ? "calls a minute not given" : `${e.calls_per_min.toLocaleString("en-US")} calls a minute`;
  return `Stock ${WORD[e.stock]} · options ${WORD[e.option]} · ${calls}`;
}

/** Whether the line should read as a warning: either feed not answering as the full plan would. */
export function entitlementShort(e: Entitlement): boolean {
  return e.stock !== "sip" || e.option !== "opra";
}
