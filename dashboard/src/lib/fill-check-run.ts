import "server-only";
import { PreconditionFailed, readText, writeText } from "./blob";
import { isJson, presentsBypass, readCapped, sameOrigin } from "./desk-flags-run";
import { ALPACA_CALLS_PER_MIN, CallLimiter, DEFAULT_RETRY_MS } from "./feed-agreement-fetch";
import {
  checkUnits,
  FILL_CHECK_FORMAT,
  matchUnit,
  MAX_SESSIONS,
  pickSessions,
  requestSpan,
  summarise,
  verdict,
  type FillCheckResult,
  type Outcome,
  type RawPrint,
  type Unit,
} from "./fill-check";
import { dataBase, DEFAULT_DATA_URL, fetchOptionTrades, TradesFetchError, type TradeAnswer, type TradeFetcher } from "./fill-check-fetch";
import { logEvent } from "./log";
import { sessionOf } from "./market-calendar";
import { alpacaKeys } from "./quote";
import { fixtureMode, loadJournal } from "./snapshot";

// The fill-time check's run and its route (DEC-0049 point 4): one owner-triggered job, run once. GET answers the
// stored result or "not_run"; POST with exactly {"confirm":"run-once"} starts it. What protects it is what protects
// /api/desk/flags (desk-flags-run.ts): Vercel Authentication in front, same origin only, JSON only, a tiny body, the
// deployment-protection bypass refused in every documented form, and no-store on every answer.
//
// Run once: a stored result is returned and nothing else is done. The result is written with createOnly, so two runs
// racing store one result and the loser answers the stored one, never its own. Its output is PRIVATE (it is derived
// from the journal); it holds counts, rates, seconds, reasons, session dates and the verdict, never a price, a contract
// or a result in money. The raw prints are matched in memory and dropped: never stored, never logged.
//
// The sessions are fixed at the first attempt (point 4: "fixed in advance"): the picked dates are written, create-only,
// to SESSIONS_PATH before any print is asked for, and every later attempt reads them back and never picks again.
//
// An attempt's outcome is never visible unless it is the stored result: the counts and the verdict are logged and
// answered only after the result's create-only write succeeded. An attempt that fails on transport, a rate limit or
// time stores no result, is not a run, and logs its outcome word only.
//
// In fixture mode and anywhere but production, Alpaca is never called and the store is never touched: the fixture
// journal is checked against a synthetic, deterministic print source, and the result, marked fixture, stays in this
// process's memory.

/** The one place the result is stored. Nothing from a request ever reaches a path. */
export const FILL_CHECK_PATH = "desk/fill-check/run-1.json";
/** The session dates fixed at the first attempt. */
export const SESSIONS_PATH = "desk/fill-check/sessions-1.json";
/** Requests in flight at once. */
export const CONCURRENCY = 5;
/** Retries of one request after a transport error or a 5xx, after BACKOFF_MS × 1, then × 2. */
export const RETRIES = 2;
export const BACKOFF_MS = 250;
/**
 * A 429 is retried for as long as the run's budget allows, each time after Alpaca's Retry-After (DEFAULT_RETRY_MS
 * without one), never more than this; requests are paced under ALPACA_CALLS_PER_MIN, as feed-agreement-fetch.ts paces.
 */
export const MAX_RETRY_AFTER_MS = 30_000;
/** The run stops asking once this long has passed (the route's limit is 300 s), and stores nothing. */
export const RUN_BUDGET_MS = 280_000;
export const MAX_BODY = 64;
const ALLOW = "GET, HEAD, POST";

export interface FillCheckDeps {
  /** Fixture mode or anywhere but production: memory store, fixture journal, synthetic prints. */
  memory: boolean;
  /** Whether prints can be asked for: Alpaca's keys are set and the data URL is Alpaca's. */
  configured(): boolean;
  /** The journal as the Trades page reads it, or not ok when it is missing or unreadable. */
  readJournal(): Promise<{ ok: true; doc: unknown } | { ok: false }>;
  /** The print source for these units. */
  trades(units: readonly Unit[]): TradeFetcher;
  /** The stored result's text, or null when there is none. */
  readStored(): Promise<string | null>;
  /** Writes the result once; throws PreconditionFailed when a result is already there. */
  writeStored(body: string): Promise<void>;
  /** The fixed session list's text, or null when there is none. */
  readSessions(): Promise<string | null>;
  /** Writes the session list once; throws PreconditionFailed when one is already there. */
  writeSessions(body: string): Promise<void>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** The run's budget in ms; RUN_BUDGET_MS when absent. */
  budgetMs?: number;
}

export type RunAnswer =
  | { state: "done"; result: FillCheckResult; fresh: boolean }
  | { state: "retry" }
  | { state: "error"; reason: "journal" | "store" | "not_configured" };

// ── The memory store and the synthetic prints ───────────────────────────────────────────────────────────────────

const MEMORY_KEY = Symbol.for("wt.fill-check.memory");
type MemoryHolder = { [MEMORY_KEY]?: Map<string, string> };
const memory = (): Map<string, string> => ((globalThis as MemoryHolder)[MEMORY_KEY] ??= new Map());
const memoryCreate = async (path: string, body: string) => {
  if (memory().has(path)) throw new PreconditionFailed();
  memory().set(path, body);
};
/** For tests: forget the in-memory result and session list. */
export function resetMemoryFillCheck(): void {
  delete (globalThis as MemoryHolder)[MEMORY_KEY];
}

/** A small deterministic hash (FNV-1a) of a string, for the synthetic prints. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const isoNs = (ns: bigint) => {
  const ms = ns / 1_000_000n;
  const sub = ns % 1_000_000n;
  return `${new Date(Number(ms)).toISOString().slice(0, -1)}${String(sub).padStart(6, "0")}Z`;
};

/**
 * The fixture's print source: for each unit, the same answer on every run. Most units get an eligible print a few
 * seconds from their time at their own price; some also get one five minutes later (a control match); one in nine
 * gets no print at all. It never touches the network.
 */
export function syntheticTrades(units: readonly Unit[]): TradeFetcher {
  const byQuery = new Map<string, Unit>();
  for (const u of units) {
    const s = requestSpan(u);
    byQuery.set(`${u.occ}|${s.startMs}|${s.endMs}`, u);
  }
  return async (q) => {
    const u = byQuery.get(`${q.symbol}|${q.startMs}|${q.endMs}`);
    if (!u) return { kind: "prints", prints: [] };
    const h = fnv(`${u.occ}|${u.atNs}|${u.side}`);
    if (h % 9 === 0) return { kind: "prints", prints: [] };
    const dollars = u.priceMicro / 1_000_000;
    const prints: RawPrint[] = [{ t: isoNs(u.atNs + BigInt((h % 7) - 3) * 1_000_000_000n + BigInt(h % 1000) * 1_000_000n), p: dollars, c: h % 2 ? "I" : "" }];
    if (h % 5 === 0) prints.push({ t: isoNs(u.atNs + 300_000_000_000n), p: dollars, c: "I" });
    if (h % 4 === 0) prints.push({ t: isoNs(u.atNs + 1_000_000_000n), p: dollars, c: "f" });
    return { kind: "prints", prints };
  };
}

async function fixtureJournal(): Promise<{ ok: true; doc: unknown }> {
  const mod = await import("../../test/fixtures/journal.v1.json");
  return { ok: true, doc: (mod as { default?: unknown }).default ?? mod };
}

/** The deployed dependencies: the private store and Alpaca in production; memory and synthetic prints elsewhere. */
export function defaultFillCheckDeps(): FillCheckDeps {
  const now = () => new Date();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  if (fixtureMode() || process.env.VERCEL_ENV !== "production") {
    return {
      memory: true,
      configured: () => true,
      readJournal: fixtureJournal,
      trades: (units) => syntheticTrades(units),
      readStored: async () => memory().get(FILL_CHECK_PATH) ?? null,
      writeStored: (body) => memoryCreate(FILL_CHECK_PATH, body),
      readSessions: async () => memory().get(SESSIONS_PATH) ?? null,
      writeSessions: (body) => memoryCreate(SESSIONS_PATH, body),
      now,
      sleep,
    };
  }
  const baseUrl = dataBase(process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL);
  const keys = alpacaKeys();
  return {
    memory: false,
    configured: () => keys !== null && baseUrl !== null,
    readJournal: async () => {
      const r = await loadJournal();
      return r.status === "ok" ? { ok: true, doc: r.doc } : { ok: false };
    },
    trades: () => (q, signal) => {
      if (!keys || !baseUrl) return Promise.reject(new TradesFetchError(false, null));
      return fetchOptionTrades(q, { keys, baseUrl, signal });
    },
    readStored: async () => (await readText(FILL_CHECK_PATH))?.text ?? null,
    writeStored: async (body) => {
      await writeText(FILL_CHECK_PATH, body, { createOnly: true });
    },
    readSessions: async () => (await readText(SESSIONS_PATH))?.text ?? null,
    writeSessions: async (body) => {
      await writeText(SESSIONS_PATH, body, { createOnly: true });
    },
    now,
    sleep,
  };
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The stored text as a result, or null when it is not one. */
export function parseStored(text: string): FillCheckResult | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.state !== "done" || v.format !== FILL_CHECK_FORMAT || typeof v.run_at !== "string" || !Array.isArray(v.sessions) || !isObj(v.overall)) return null;
  return v as unknown as FillCheckResult;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (d: unknown): d is string => typeof d === "string" && DAY_RE.test(d) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

/** The stored session list: `{format, sessions}` with at most MAX_SESSIONS distinct real dates; null otherwise. */
export function parseSessions(text: string): string[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.format !== FILL_CHECK_FORMAT || !Array.isArray(v.sessions)) return null;
  const list: unknown[] = v.sessions;
  if (list.length > MAX_SESSIONS || !list.every(realDay) || new Set(list).size !== list.length) return null;
  return list as string[];
}

/** Why an attempt stopped asking: a request failed after its retries, or the run's budget ran out. */
class Abort extends Error {}

function logRun(outcome: string, fields: Record<string, number | string> = {}): void {
  logEvent("fill-check.run", { outcome, ...fields });
}

/** The fixed sessions: the stored list, or the one picked now and stored first. Null when the store fails. */
async function fixedSessions(doc: unknown, deps: FillCheckDeps, now: Date): Promise<string[] | null> {
  try {
    const kept = await deps.readSessions();
    if (kept !== null) return parseSessions(kept);
    const picked = pickSessions(doc, sessionOf, now);
    try {
      await deps.writeSessions(JSON.stringify({ format: FILL_CHECK_FORMAT, sessions: picked }));
      return picked;
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) return null;
      // Another attempt fixed the list first: that one is the list.
      const theirs = await deps.readSessions();
      return theirs === null ? null : parseSessions(theirs);
    }
  } catch {
    return null;
  }
}

/** The stored result after a write did not go through: it, if there is one, else retry. */
async function storedOrRetry(deps: FillCheckDeps): Promise<RunAnswer> {
  const text = await deps.readStored().catch(() => null);
  const parsed = text === null ? null : parseStored(text);
  return parsed ? { state: "done", result: parsed, fresh: false } : { state: "retry" };
}

/**
 * The run of DEC-0049 point 4. A stored result is returned untouched. Otherwise: the journal, the fixed sessions, the
 * units, the prints for each (CONCURRENCY at a time, paced, inside one deadline), the summary and the verdict,
 * written once.
 */
export async function runFillCheck(deps: FillCheckDeps): Promise<RunAnswer> {
  let stored: string | null;
  try {
    stored = await deps.readStored();
  } catch {
    logRun("store-error");
    return { state: "error", reason: "store" };
  }
  if (stored !== null) {
    const result = parseStored(stored);
    if (!result) {
      // Something is stored that is not a result: it is never replaced, since the check runs once.
      logRun("store-malformed");
      return { state: "error", reason: "store" };
    }
    logRun("stored", { verdict: result.verdict });
    return { state: "done", result, fresh: false };
  }
  if (!deps.configured()) {
    logRun("not-configured");
    return { state: "error", reason: "not_configured" };
  }

  const journal = await deps.readJournal().catch(() => ({ ok: false }) as const);
  if (!journal.ok) {
    logRun("journal-error");
    return { state: "error", reason: "journal" };
  }
  const started = deps.now();
  const sessions = await fixedSessions(journal.doc, deps, started);
  if (sessions === null) {
    logRun("sessions-error");
    return { state: "error", reason: "store" };
  }
  const { units, excluded } = checkUnits(journal.doc, sessions);
  const fetcher = deps.trades(units);

  // Any request that still fails after its retries (other than the page cap, which is an answer), or the budget
  // running out, stops the attempt, and nothing is stored: the check runs once, and a failed transport must not use
  // that one run up. The abort depends only on how the requests went, never on what any unit matched. One signal at
  // the deadline is handed to every request, so none outlives the budget.
  const budget = deps.budgetMs ?? RUN_BUDGET_MS;
  const deadline = started.getTime() + budget;
  const run = new AbortController();
  const timer = setTimeout(() => run.abort(), budget);
  const limiter = new CallLimiter(ALPACA_CALLS_PER_MIN);
  const nowMs = () => deps.now().getTime();
  const waitWithin = async (ms: number) => {
    if (run.signal.aborted || nowMs() + ms >= deadline) throw new Abort("budget");
    if (ms > 0) await deps.sleep(ms);
  };
  const ask = async (u: Unit): Promise<TradeAnswer> => {
    for (let transient = 0; ; ) {
      for (let w = limiter.waitMs(nowMs()); w > 0; w = limiter.waitMs(nowMs())) await waitWithin(w);
      if (run.signal.aborted || nowMs() >= deadline) throw new Abort("budget");
      limiter.record(nowMs());
      try {
        return await fetcher({ symbol: u.occ, ...requestSpan(u) }, run.signal);
      } catch (e) {
        if (run.signal.aborted) throw new Abort("budget");
        if (e instanceof TradesFetchError && e.status === 429) {
          await waitWithin(Math.min(e.retryAfter ?? DEFAULT_RETRY_MS, MAX_RETRY_AFTER_MS));
          continue;
        }
        const retryable = !(e instanceof TradesFetchError) || e.retryable;
        if (!retryable || transient >= RETRIES) throw new Abort("fetch");
        await waitWithin(BACKOFF_MS * 2 ** transient++);
      }
    }
  };

  const outcomes: Outcome[] = excluded.map((x) => ({ side: x.side, day: x.day, checked: false, reason: x.reason }));
  let unknownCodes = 0;
  let next = 0;
  let aborted = false;
  const worker = async () => {
    while (!aborted && next < units.length) {
      const u = units[next++]!;
      let answer: TradeAnswer;
      try {
        answer = await ask(u);
      } catch {
        aborted = true;
        run.abort();
        return;
      }
      if (answer.kind === "incomplete") {
        outcomes.push({ side: u.side, day: u.day, checked: false, reason: "incomplete" });
        continue;
      }
      const m = matchUnit(u, answer.prints);
      unknownCodes += m.unknownCodes;
      if (m.prints === 0) outcomes.push({ side: u.side, day: u.day, checked: false, reason: "no_prints" });
      else outcomes.push({ side: u.side, day: u.day, checked: true, match: { truth: m.truth, early: m.early, late: m.late, offsetMs: m.offsetMs } });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(units.length, 1)) }, worker));
  } finally {
    clearTimeout(timer);
  }
  if (aborted) {
    logRun("retry");
    return { state: "retry" };
  }

  const summary = summarise(sessions, outcomes);
  const result: FillCheckResult = {
    state: "done",
    format: FILL_CHECK_FORMAT,
    run_at: started.toISOString(),
    fixture: deps.memory,
    ...summary,
    unknown_codes: unknownCodes,
    verdict: verdict(summary),
  };
  try {
    await deps.writeStored(JSON.stringify(result));
  } catch (e) {
    // Not stored, so this attempt's outcome is not shown or logged: only the stored result, if any, is answered.
    logRun(e instanceof PreconditionFailed ? "lost-race" : "write-error");
    return storedOrRetry(deps);
  }
  logRun("done", { sessions: sessions.length, opening_checked: summary.overall.opening.checked, closing_checked: summary.overall.closing.checked, verdict: result.verdict });
  return { state: "done", result, fresh: true };
}

// ── The route ───────────────────────────────────────────────────────────────────────────────────────────────────

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });
}
const fail = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);

/** Exactly `{ "confirm": "run-once" }`. */
export function parseConfirm(text: string): boolean {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === "confirm" && v.confirm === "run-once";
}

async function handleGet(req: Request, deps: FillCheckDeps): Promise<Response> {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return fail(403, "forbidden");
  let text: string | null;
  try {
    text = await deps.readStored();
  } catch {
    return fail(503, "read-failed");
  }
  if (text === null) return json(200, { state: "not_run" });
  const result = parseStored(text);
  if (!result) return fail(503, "read-failed");
  return json(200, { ...result });
}

async function handlePost(req: Request, deps: FillCheckDeps): Promise<Response> {
  if (!sameOrigin(req)) return fail(403, "forbidden");
  if (!isJson(req.headers.get("content-type"))) return fail(415, "json-only");
  const body = await readCapped(req, MAX_BODY);
  if (body === "too-large") return fail(413, "too-large");
  if (body === "bad" || !parseConfirm(body.text)) return fail(400, "bad-request");
  const r = await runFillCheck(deps);
  if (r.state === "done") return json(200, { ...r.result });
  if (r.state === "retry") return json(503, { state: "retry" });
  return json(503, { state: "error", reason: r.reason });
}

/** The route: GET reads, POST runs, every other method is refused. */
export async function handleFillCheck(req: Request, deps: FillCheckDeps = defaultFillCheckDeps()): Promise<Response> {
  if (presentsBypass(req)) return fail(403, "forbidden");
  if (req.method === "GET") return handleGet(req, deps);
  if (req.method === "HEAD") {
    const res = await handleGet(req, deps);
    return new Response(null, { status: res.status, headers: res.headers });
  }
  if (req.method === "POST") return handlePost(req, deps);
  return fail(405, "method-not-allowed", { allow: ALLOW });
}
