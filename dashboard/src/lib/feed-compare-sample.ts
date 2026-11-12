import "server-only";
import { put } from "@vercel/blob";
import { feedSetting } from "./alpaca-feed";
import { alpacaDataUrl } from "./alpaca-data-url";
import { alreadyThere, exists, PreconditionFailed, readTextIfChanged } from "./blob";
import { OPTIONS_PATHS } from "./desk";
import { focusSymbols, nyHhmm, sessionBounds, SYMBOL_RE } from "./desk-eval";
import { parseEdition } from "./desk-run";
import { alpacaHost, DEFAULT_DATA_URL } from "./feed-agreement-fetch";
import { type BoardFeed, type CompareFeed, COMPARE_V, type FeedAnswer, MARKET_SYMBOL, type Sample, samplePath, snapRows } from "./feed-compare";
import { logEvent } from "./log";
import { nyClock, type Options } from "./options";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";

// GET /api/cron/feeds: the paired sampler (DEC-0050 point 5; docs/runbooks/feed-agreement.md, "Server comparison").
// Once a minute in the regular session, in production only, it sends ONE /v2/stocks/snapshots request on iex and then
// ONE on sip for the stored edition's focus names plus SPY, and writes both answers, reduced to the kept fields, to
// desk/feeds/compare/<NY day>/<HHMM>.json in the private store, create-only. Read-only upstream: no order route.
//
// It does not use fetchQuotes or its cache (quote.ts): each request is its own, uncached, with its own 4 s timeout, so
// the board's prices and this measurement never share an answer. It never throws: each failure outcome logs one line
// (secret-free fields only: no key, no body).

export const REQUEST_TIMEOUT_MS = 4_000;
export const TIMEOUT_MS = { edition: 1_500, exists: 1_500, write: 2_000 } as const;

export interface SampleDeps {
  now(): number;
  /** Fixture mode or anywhere but production: nothing is read or written. */
  dry: boolean;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  /** The stored edition (options/latest.json), or null when missing or unreadable. */
  loadEdition(): Promise<Options | null>;
  exists(path: string): Promise<boolean>;
  /** Create-only: throws PreconditionFailed when the blob is already there. */
  write(path: string, body: string): Promise<void>;
}

export type SampleResult =
  | { ok: true; outcome: "not-production" }
  | { ok: true; outcome: "idle"; why: "closed-day" | "outside-hours" }
  | { ok: true; outcome: "duplicate"; minute: string }
  | { ok: true; outcome: "written"; minute: string; iex: number | null; sip: number | null }
  | { ok: false; outcome: "no-keys" | "data-url" | "write-failed" | "error"; minute?: string };

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** The symbols one minute asks for: the edition's focus names when it is that day's, then SPY, each once. */
export function sampleSymbols(edition: Options | null, day: string): string[] {
  const focus = edition && edition.session === day ? focusSymbols(edition).filter((s) => SYMBOL_RE.test(s)) : [];
  return [...new Set([...focus, MARKET_SYMBOL])];
}

/**
 * One direct snapshots request on one named feed: its start, finish, status and rows. Never throws. A 400 (Alpaca
 * refusing a symbol) is asked again once, without any symbol that is not a ticker (SYMBOL_RE), and logged as
 * `symbol-rejected`; the answer then records the retry's status.
 */
export async function askFeed(feed: CompareFeed, symbols: readonly string[], keys: { id: string; secret: string }, base: string, deps: Pick<SampleDeps, "now" | "fetchImpl">): Promise<FeedAnswer> {
  const started = deps.now();
  let status: number | null = null;
  let rows: FeedAnswer["rows"] = null;
  let retried = false;
  let asked = [...symbols];
  try {
    for (;;) {
      const url = alpacaDataUrl(base, "/v2/stocks/snapshots", { symbols: asked.join(","), feed });
      const res = await deps.fetchImpl(url, {
        headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) {
        rows = snapRows(await res.json(), asked);
        break;
      }
      const tickers = asked.filter((s) => SYMBOL_RE.test(s));
      if (res.status === 400 && !retried && tickers.length > 0) {
        logEvent("feed-compare.sample", { outcome: "symbol-rejected", feed, dropped: asked.length - tickers.length });
        retried = true;
        asked = tickers;
        continue;
      }
      logEvent("feed-compare.sample", { outcome: "http-error", feed, status });
      break;
    }
  } catch (e) {
    rows = null;
    logEvent("feed-compare.sample", { outcome: "request-failed", feed, status, error: errName(e) });
  }
  return { started, finished: deps.now(), status, rows, ...(retried ? { retried: true } : {}) };
}

/** One run: nothing outside production or the session; otherwise one sample written, create-only. */
export async function runFeedSample(deps: SampleDeps = defaultSampleDeps()): Promise<SampleResult> {
  try {
    if (deps.dry) return { ok: true, outcome: "not-production" };
    const at = deps.now();
    const day = nyClock(new Date(at).toISOString())?.day ?? null;
    const bounds = day ? sessionBounds(day) : null;
    if (!day || !bounds) return { ok: true, outcome: "idle", why: "closed-day" };
    if (at < bounds.open || at >= bounds.close) return { ok: true, outcome: "idle", why: "outside-hours" };
    const minute = nyHhmm(at);
    const path = samplePath(day, minute);
    try {
      if (await within(deps.exists(path), TIMEOUT_MS.exists)) return { ok: true, outcome: "duplicate", minute };
    } catch (e) {
      // Unknown: carry on; the create-only write still refuses a second sample.
      logEvent("feed-compare.sample", { outcome: "exists-failed", minute, error: errName(e) });
    }
    const keys = alpacaKeys(deps.env);
    if (!keys) {
      logEvent("feed-compare.sample", { outcome: "no-keys", minute });
      return { ok: false, outcome: "no-keys", minute };
    }
    const base = deps.env.ALPACA_DATA_URL || DEFAULT_DATA_URL;
    if (alpacaHost(base) === null) {
      logEvent("feed-compare.sample", { outcome: "data-url", minute });
      return { ok: false, outcome: "data-url", minute };
    }
    let edition: Options | null = null;
    try {
      edition = await within(deps.loadEdition(), TIMEOUT_MS.edition);
    } catch (e) {
      logEvent("feed-compare.sample", { outcome: "edition-failed", minute, error: errName(e) });
    }
    const symbols = sampleSymbols(edition, day);
    if (symbols.length === 1) logEvent("feed-compare.sample", { outcome: "spy-only", minute, edition: edition === null ? "missing" : edition.session === day ? "no-focus" : "stale" });
    const setting = feedSetting(deps.env);
    const board_feed: BoardFeed = setting.ok ? setting.feed : "refused";
    // One on iex, then at once one on sip: never side by side, never from a cache.
    const iex = await askFeed("iex", symbols, keys, base, deps);
    const sip = await askFeed("sip", symbols, keys, base, deps);
    const sample: Sample = { v: COMPARE_V, at, symbols, board_feed, iex, sip };
    try {
      await within(deps.write(path, JSON.stringify(sample)), TIMEOUT_MS.write);
    } catch (e) {
      if (e instanceof PreconditionFailed) {
        logEvent("feed-compare.sample", { outcome: "duplicate", minute });
        return { ok: true, outcome: "duplicate", minute };
      }
      logEvent("feed-compare.sample", { outcome: "write-failed", minute, error: errName(e) });
      return { ok: false, outcome: "write-failed", minute };
    }
    logEvent("feed-compare.sample", { outcome: "written", minute, symbols: symbols.length, iex: iex.status, sip: sip.status });
    return { ok: true, outcome: "written", minute, iex: iex.status, sip: sip.status };
  } catch (e) {
    logEvent("feed-compare.sample", { outcome: "error", error: errName(e) });
    return { ok: false, outcome: "error" };
  }
}

/**
 * A create-only put with the private options blob.ts writes with, bounded by an abort signal. A blob already there
 * throws PreconditionFailed, as blob.ts's create-only write does.
 */
export async function putCreateOnly(path: string, body: string, timeoutMs: number): Promise<void> {
  try {
    await put(path, body, {
      access: "private",
      allowOverwrite: false,
      addRandomSuffix: false,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (alreadyThere(e)) throw new PreconditionFailed();
    throw e;
  }
}

const refuse = () => Promise.reject(new Error("dry run: the store is not touched"));

/** The deployed dependencies: the private store and Alpaca in production; nothing at all anywhere else. */
export function defaultSampleDeps(): SampleDeps {
  const dry = fixtureMode() || process.env.VERCEL_ENV !== "production";
  if (dry) return { now: () => Date.now(), dry: true, env: {}, fetchImpl: refuse, loadEdition: refuse, exists: refuse, write: refuse };
  return {
    now: () => Date.now(),
    dry: false,
    env: process.env,
    fetchImpl: fetch,
    loadEdition: async () => {
      const r = await readTextIfChanged(OPTIONS_PATHS.latest);
      if (!r) return null;
      const e = parseEdition(r.text);
      return e.status === "ok" ? e.edition : null;
    },
    exists: (path) => exists(path),
    write: (path, body) => putCreateOnly(path, body, TIMEOUT_MS.write),
  };
}
