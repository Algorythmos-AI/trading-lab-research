import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { exists, PreconditionFailed, readTextIfChanged, writeText } from "./blob";
import { OPTIONS_PATHS } from "./desk";
import { focusSymbols, SYMBOL_RE } from "./desk-eval";
import { parseEdition } from "./desk-run";
import { alpacaHost, DEFAULT_DATA_URL } from "./feed-agreement-fetch";
import { baselineSessions, buildBaseline, flowBarOf, type FlowBar, sessionSlots } from "./flow";
import { logEvent } from "./log";
import { nyNow } from "./market-calendar";
import type { Options } from "./options";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";

// GET /api/cron/flow-baseline: the day's volume baseline for /api/flow (flow.ts's Baseline), built before the open.
// On a session day, before 09:30 New York, in production only: when flow/baseline/<session>.json is not in the private
// store, it reads the 2-minute SIP bars of the previous 20 full sessions for the day's allowed names (flow-route.ts's
// flowNames, below: the edition's focus names when it is today's, then SPY and QQQ), builds the baseline and writes it,
// create-only. One bars request per session, every page read (Alpaca may page early whatever `limit` says), on sip
// named literally (never ALPACA_FEED), split-adjusted (see fetchSessionBars). It does not use bars.ts or its cache.
//
// Idempotent: a stored baseline ends the run after one head(), with nothing asked upstream. Anything short of every
// session read in full (a failed or timed-out request, a page limit, the run's time budget) writes nothing and logs
// one count-only line, so the next tick tries again. Log lines carry counts and statuses, never a symbol.

/** Always allowed, whatever the focus list says. */
export const MARKET_NAMES: readonly string[] = ["SPY", "QQQ"];

/**
 * The names /api/flow may answer and the baseline is built for on `day` (EXP-0032's blind): the edition's focus names
 * when it is that day's, then SPY and QQQ, each once. Any other name is never fetched or computed.
 */
export function flowNames(edition: Pick<Options, "session" | "focus"> | null, day: string): string[] {
  const focus = edition && edition.session === day ? focusSymbols(edition).filter((s) => SYMBOL_RE.test(s)) : [];
  return [...new Set([...focus, ...MARKET_NAMES])];
}

export const BASELINE_PREFIX = "flow/baseline/";
export const baselinePath = (session: string): string => `${BASELINE_PREFIX}${session}.json`;
/** The whole run's upstream reading stops after this long; maxDuration is 60 s. */
export const RUN_BUDGET_MS = 40_000;
export const REQUEST_TIMEOUT_MS = 8_000;
/** Pages read for one session at most; a session for six names fits one page. */
export const MAX_PAGES = 20;
/** Sessions read side by side. */
export const CONCURRENCY = 4;
export const TIMEOUT_MS = { exists: 2_000, edition: 2_000, write: 5_000 } as const;

export interface BaselineDeps {
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

export type BaselineResult =
  | { ok: true; outcome: "not-production" }
  | { ok: true; outcome: "idle"; why: "closed-day" | "session-open" }
  | { ok: true; outcome: "exists" }
  | { ok: true; outcome: "retry"; why: "edition-not-ready" | "partial" }
  | { ok: true; outcome: "written"; names: number; sessions: number; calls: number }
  | { ok: false; outcome: "no-keys" | "data-url" | "calendar" | "write-failed" | "error" };

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

class ShortRead extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = "ShortRead";
  }
}

/**
 * One session's bars for `symbols`, every page, or a ShortRead thrown: a status that is not a success, a page limit, or
 * the run's deadline. `calls` counts every request sent.
 */
export async function fetchSessionBars(
  symbols: readonly string[],
  day: string,
  keys: { id: string; secret: string },
  base: string,
  deadline: number,
  deps: Pick<BaselineDeps, "now" | "fetchImpl">,
  calls: { n: number },
): Promise<Record<string, FlowBar[]>> {
  const s = sessionSlots(day);
  if (!s) throw new ShortRead("calendar");
  const out: Record<string, FlowBar[]> = Object.fromEntries(symbols.map((x) => [x, []]));
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const left = deadline - deps.now();
    if (left <= 0) throw new ShortRead("time-budget");
    const q: Record<string, string> = {
      symbols: symbols.join(","),
      timeframe: "2Min",
      start: new Date(s.open).toISOString(),
      end: new Date(s.close).toISOString(),
      feed: "sip",
      // Split-adjusted, unlike today's bars (raw, in /api/flow): a split inside the 20 sessions would otherwise leave
      // the volumes before it in old shares, not comparable with today's. Today has no later split to adjust for.
      adjustment: "split",
      limit: "10000",
    };
    if (token) q.page_token = token;
    calls.n++;
    const res = await deps.fetchImpl(alpacaDataUrl(base, "/v2/stocks/bars", q), {
      headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left)),
    });
    if (!res.ok) throw new ShortRead(`status-${res.status}`);
    const body = rec(await res.json());
    for (const [sym, list] of Object.entries(rec(body?.bars) ?? {})) {
      if (!out[sym] || !Array.isArray(list)) continue;
      for (const raw of list) {
        const b = flowBarOf(raw);
        if (b) out[sym]!.push(b);
      }
    }
    token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token) return out;
  }
  throw new ShortRead("page-limit");
}

/** One run: nothing outside production, off a session day or from the open; else the baseline written once. */
export async function runFlowBaseline(deps: BaselineDeps = defaultBaselineDeps()): Promise<BaselineResult> {
  const startedAt = deps.now();
  try {
    if (deps.dry) return { ok: true, outcome: "not-production" };
    const day = nyNow(new Date(startedAt)).day;
    const today = sessionSlots(day);
    if (!today) return { ok: true, outcome: "idle", why: "closed-day" };
    if (startedAt >= today.open) return { ok: true, outcome: "idle", why: "session-open" };
    const path = baselinePath(day);
    try {
      if (await within(deps.exists(path), TIMEOUT_MS.exists)) return { ok: true, outcome: "exists" };
    } catch (e) {
      // Unknown: carry on; the create-only write still refuses a second baseline.
      logEvent("flow.baseline", { outcome: "exists-failed", error: errName(e) });
    }
    const keys = alpacaKeys(deps.env);
    if (!keys) {
      logEvent("flow.baseline", { outcome: "no-keys" });
      return { ok: false, outcome: "no-keys" };
    }
    const base = deps.env.ALPACA_DATA_URL || DEFAULT_DATA_URL;
    if (alpacaHost(base) === null) {
      logEvent("flow.baseline", { outcome: "data-url" });
      return { ok: false, outcome: "data-url" };
    }
    let edition: Options | null = null;
    try {
      edition = await within(deps.loadEdition(), TIMEOUT_MS.edition);
    } catch (e) {
      logEvent("flow.baseline", { outcome: "edition-failed", error: errName(e) });
    }
    // Built for today's names only: without today's edition the focus names are not known yet.
    if (!edition || edition.session !== day) {
      logEvent("flow.baseline", { outcome: "retry", why: "edition-not-ready", edition: edition === null ? "missing" : "stale" });
      return { ok: true, outcome: "retry", why: "edition-not-ready" };
    }
    const symbols = flowNames(edition, day);
    const sessions = baselineSessions(day);
    if (!sessions) {
      logEvent("flow.baseline", { outcome: "calendar" });
      return { ok: false, outcome: "calendar" };
    }
    const deadline = startedAt + RUN_BUDGET_MS;
    const calls = { n: 0 };
    const got: Record<string, Record<string, FlowBar[]>> = {};
    let failed: string | null = null;
    const queue = [...sessions];
    const worker = async () => {
      for (let d = queue.shift(); d !== undefined && failed === null; d = queue.shift()) {
        try {
          got[d] = await fetchSessionBars(symbols, d, keys, base, deadline, deps, calls);
        } catch (e) {
          failed ??= e instanceof ShortRead ? e.why : errName(e);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const read = Object.keys(got).length;
    if (failed !== null || read !== sessions.length) {
      logEvent("flow.baseline", { outcome: "partial", why: failed ?? "incomplete", sessions: sessions.length, read, calls: calls.n, names: symbols.length, ms: deps.now() - startedAt });
      return { ok: true, outcome: "retry", why: "partial" };
    }
    const doc = buildBaseline(got, day, undefined, new Date(deps.now()).toISOString(), symbols);
    if (!doc) {
      logEvent("flow.baseline", { outcome: "calendar" });
      return { ok: false, outcome: "calendar" };
    }
    try {
      await within(deps.write(path, JSON.stringify(doc)), TIMEOUT_MS.write);
    } catch (e) {
      if (e instanceof PreconditionFailed) return { ok: true, outcome: "exists" };
      logEvent("flow.baseline", { outcome: "write-failed", error: errName(e) });
      return { ok: false, outcome: "write-failed" };
    }
    const thin = Object.values(doc.names).filter((n) => n.n < sessions.length).length;
    logEvent("flow.baseline", { outcome: "written", names: symbols.length, sessions: sessions.length, short_names: thin, calls: calls.n, ms: deps.now() - startedAt });
    return { ok: true, outcome: "written", names: symbols.length, sessions: sessions.length, calls: calls.n };
  } catch (e) {
    logEvent("flow.baseline", { outcome: "error", error: errName(e) });
    return { ok: false, outcome: "error" };
  }
}

const refuse = () => Promise.reject(new Error("dry run: the store is not touched"));

/** The deployed dependencies: the private store and Alpaca in production; nothing at all anywhere else. */
export function defaultBaselineDeps(): BaselineDeps {
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
    write: async (path, body) => {
      await writeText(path, body, { createOnly: true });
    },
  };
}
