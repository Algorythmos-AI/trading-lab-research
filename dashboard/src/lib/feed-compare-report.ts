import "server-only";
import { BlobNotFoundError, get, head, list } from "@vercel/blob";
import { PreconditionFailed } from "./blob";
import { OPTIONS_PATHS } from "./desk";
import { focusSymbols, type SessionBounds, sessionBounds, SYMBOL_RE } from "./desk-eval";
import { parseEdition } from "./desk-run";
import { type Feed, feedAgreement } from "./feed-agreement";
import { alpacaHost, CallLimiter, DEFAULT_DATA_URL, type FetchSessionOpts, fetchSessionBars, FetchStop } from "./feed-agreement-fetch";
import { fetchMinuteBars } from "./feed-compare-bars";
import { putCreateOnly } from "./feed-compare-sample";
import {
  type BarsInput,
  type BarsWhy,
  type BoardFeed,
  buildReport,
  COMPARE_PREFIX,
  type CompareFeed,
  type CompareReportView,
  editionInForce,
  type MinBar,
  parseReport,
  parseSample,
  REPORT_AFTER_CLOSE_MS,
  REPORT_DEADLINE_UTC_MIN,
  REPORT_LAST_TICK_UTC_MIN,
  REPORT_PATH_RE,
  reportPath,
  reportView,
  type ReportInput,
  type Sample,
  SAMPLE_PATH_RE,
} from "./feed-compare";
import { logEvent } from "./log";
import { nyClock, type Options } from "./options";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";
import type { Bar2 } from "./trade-state";

// GET /api/cron/feeds-report: the day's comparison report (DEC-0050 point 5; docs/runbooks/feed-agreement.md,
// "Server comparison"). Every 10 minutes from 20:00 to 23:50 UTC on weekdays: once the session's close + 20 min has
// passed and the day has no report, it builds desk/feeds/compare/<day>/report.json, create-only, from the day's
// samples, the session's settled bars on iex and on sip (2-minute bars for the feed-agreement replay through
// feed-agreement-fetch.ts fetchSessionBars, and 1-minute bars for the bars measures through feed-compare-bars.ts,
// one call limiter and one time budget for all four reads) and the replay on the edition in force at the open. It
// never overwrites; a failed build logs one line and is tried again on the next tick; a bars failure that may heal is
// built as no_bars from the 23:50 tick, and nothing is built after 23:59 UTC. Data quality only, PRIVATE. Read-only
// upstream: no order route.

/** The bars' whole budget (four reads), inside the route's 300 s. */
export const BARS_BUDGET_MS = 150_000;
/** The whole run's limit inside the route's maxDuration (300 s): the bars reads never run past it. */
export const RUN_BUDGET_MS = 270_000;
export const WRITE_TIMEOUT_MS = 5_000;
/** Each Blob read (head, list page, get) is aborted after this long. */
export const BLOB_TIMEOUT_MS = 5_000;
/** Sample reads in flight at once. */
export const READ_CONCURRENCY = 16;

export type Read<T> = { ok: true; bars: Record<CompareFeed, Record<string, T[]>> } | { ok: false; final: boolean; why: Exclude<BarsWhy, "no_focus_names"> };
export interface BarsRead {
  /** The 2-minute bars the replay reads. */
  two: Read<Bar2>;
  /** The settled 1-minute bars the bars measures read. */
  one: Read<MinBar>;
}

export interface ReportDeps {
  now(): number;
  dry: boolean;
  exists(path: string): Promise<boolean>;
  /** The pathnames under a prefix. */
  list(prefix: string): Promise<string[]>;
  readText(path: string): Promise<string | null>;
  /** The stored candidates for `day`'s edition (options/editions/<day>.json and options/latest.json), unparsed ones as null. */
  loadEditions(day: string): Promise<(Options | null)[]>;
  /** The session's bars on iex and on sip, sharing one limiter and one deadline. */
  fetchBars(symbols: string[], bounds: SessionBounds): Promise<BarsRead>;
  /** Create-only: throws PreconditionFailed when the report is already there. */
  write(path: string, body: string): Promise<void>;
}

export type ReportResult =
  | { ok: true; outcome: "not-production" | "idle" | "too-early" | "past-deadline" }
  | { ok: true; outcome: "already-built"; day: string }
  | { ok: true; outcome: "built"; day: string; minutes: number; signals: string; bars: string }
  | { ok: false; outcome: "retry" | "error"; day?: string; why: string };

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/** Read every path, a few at a time. */
async function readAll(paths: readonly string[], read: (p: string) => Promise<string | null>): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(paths.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      out[i] = await read(paths[i]!).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  return out;
}

/** The day's samples in its session, by their own `at`; those at or after the close counted apart; the unreadable ones counted. */
export async function readDaySamples(day: string, deps: Pick<ReportDeps, "list" | "readText">): Promise<{ samples: Sample[]; unreadable: number; afterClose: number }> {
  const bounds = sessionBounds(day);
  const paths = (await deps.list(`${COMPARE_PREFIX}${day}/`)).filter((p) => SAMPLE_PATH_RE.exec(p)?.[1] === day).sort();
  const texts = await readAll(paths, deps.readText);
  const samples: Sample[] = [];
  let unreadable = 0;
  let afterClose = 0;
  for (const t of texts) {
    const s = parseSample(t);
    if (!s || !bounds || s.at < bounds.open) unreadable++;
    else if (s.at >= bounds.close) afterClose++;
    else samples.push(s);
  }
  return { samples, unreadable, afterClose };
}

/** One run of the report: idle, too early, past the deadline, already built, built, or to be retried. */
export async function runFeedReport(deps: ReportDeps = defaultReportDeps()): Promise<ReportResult> {
  try {
    if (deps.dry) return { ok: true, outcome: "not-production" };
    const now = deps.now();
    const day = nyClock(new Date(now).toISOString())?.day ?? null;
    const bounds = day ? sessionBounds(day) : null;
    if (!day || !bounds) return { ok: true, outcome: "idle" };
    if (now < bounds.close + REPORT_AFTER_CLOSE_MS) return { ok: true, outcome: "too-early" };
    // The UTC day the session's evening falls in: its 23:50 tick is the last, 23:59 the last minute a build may start.
    const utcDay0 = Date.parse(`${day}T00:00:00Z`);
    if (now >= utcDay0 + (REPORT_DEADLINE_UTC_MIN + 1) * 60_000) return { ok: true, outcome: "past-deadline" };
    const lastTick = now >= utcDay0 + REPORT_LAST_TICK_UTC_MIN * 60_000;
    const path = reportPath(day);
    if (await deps.exists(path)) return { ok: true, outcome: "already-built", day };

    const { samples, unreadable, afterClose } = await readDaySamples(day, deps);
    const ed = editionInForce(await deps.loadEditions(day), day, bounds.open);
    let signals: ReportInput["signals"];
    let bars: BarsInput;
    if (!ed) {
      signals = { status: "no_edition" };
      bars = { status: "no_edition" };
    } else {
      const symbols = focusSymbols(ed).filter((s) => SYMBOL_RE.test(s));
      if (symbols.length === 0) {
        signals = { status: "no_bars", why: "no_focus_names" };
        bars = { status: "no_bars", why: "no_focus_names" };
      } else {
        const got = await deps.fetchBars(symbols, bounds);
        const healing = [got.two, got.one].find((r) => !r.ok && !r.final);
        if (healing && !healing.ok && !lastTick) {
          logEvent("feed-compare.report", { outcome: "retry", day, why: healing.why });
          return { ok: false, outcome: "retry", day, why: healing.why };
        }
        const asOf = typeof ed.as_of === "string" && Number.isFinite(Date.parse(ed.as_of)) ? new Date(Date.parse(ed.as_of)).toISOString() : null;
        signals = got.two.ok ? { status: "ok", report: feedAgreement(ed, day, got.two.bars as Record<Feed, Record<string, Bar2[]>>), editionAsOf: asOf } : { status: "no_bars", why: got.two.why };
        bars = got.one.ok ? { status: "ok", bars: got.one.bars } : { status: "no_bars", why: got.one.why };
      }
    }
    const report = buildReport({ day, expected: (bounds.close - bounds.open) / 60_000, builtAt: deps.now(), samples, unreadable, afterClose, signals, bars });
    try {
      await deps.write(path, JSON.stringify(report));
    } catch (e) {
      if (e instanceof PreconditionFailed) return { ok: true, outcome: "already-built", day };
      logEvent("feed-compare.report", { outcome: "retry", day, why: "write-failed", error: errName(e) });
      return { ok: false, outcome: "retry", day, why: "write-failed" };
    }
    logEvent("feed-compare.report", { outcome: "built", day, minutes: report.samples.minutes, signals: report.signals.status, bars: report.bars.status });
    return { ok: true, outcome: "built", day, minutes: report.samples.minutes, signals: report.signals.status, bars: report.bars.status };
  } catch (e) {
    logEvent("feed-compare.report", { outcome: "error", error: errName(e) });
    return { ok: false, outcome: "error", why: errName(e) };
  }
}

// ---- the reader (F4) ----------------------------------------------------------------------------------------------
export interface StoredReports {
  /** The newest `days` reports, newest first, without the replay's per-slot disagreements (the site never shows them). */
  reports: CompareReportView[];
  /** report.json files that are not v1 reports of the compare, or could not be read. */
  bad: number;
}

/** The newest `days` day reports under desk/feeds/compare/ (v1 only; the bad ones counted, never shown). */
export async function readCompareReports(days: number, deps: Pick<ReportDeps, "list" | "readText"> = defaultReaderDeps()): Promise<StoredReports> {
  const paths = (await deps.list(COMPARE_PREFIX))
    .filter((p) => REPORT_PATH_RE.test(p))
    .sort()
    .reverse()
    .slice(0, Math.max(0, Math.floor(days)));
  const texts = await readAll(paths, deps.readText);
  const reports: CompareReportView[] = [];
  let bad = 0;
  texts.forEach((t, i) => {
    const r = parseReport(t);
    if (r && r.day === REPORT_PATH_RE.exec(paths[i]!)?.[1]) reports.push(reportView(r));
    else bad++;
  });
  return { reports, bad };
}

/** So far today: the sample minutes in the session, those at or after the close, the unreadable ones, and the board's feed per minute. */
export async function readCompareToday(
  day: string,
  deps: Pick<ReportDeps, "list" | "readText"> = defaultReaderDeps(),
): Promise<{ minutes: number; after_close: number; unreadable: number; board_feed: Record<BoardFeed, number> }> {
  const { samples, unreadable, afterClose } = await readDaySamples(day, deps);
  const board: Record<BoardFeed, number> = { sip: 0, iex: 0, refused: 0 };
  for (const s of samples) board[s.board_feed]++;
  return { minutes: samples.length, after_close: afterClose, unreadable, board_feed: board };
}

// ---- the deployed dependencies ------------------------------------------------------------------------------------
const signal = () => AbortSignal.timeout(BLOB_TIMEOUT_MS);

/** Every pathname under a prefix, each page of the listing bounded by its own abort signal. */
async function listNames(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, abortSignal: signal() });
    out.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}
/** A private blob's text, read past the CDN, bounded by an abort signal; null when there is none. */
async function readBody(pathname: string): Promise<string | null> {
  const res = await get(pathname, { access: "private", useCache: false, abortSignal: signal() });
  if (!res || res.statusCode !== 200) return null;
  return await new Response(res.stream).text();
}
async function existsBounded(pathname: string): Promise<boolean> {
  try {
    await head(pathname, { abortSignal: signal() });
    return true;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return false;
    throw e;
  }
}

function defaultReaderDeps(): Pick<ReportDeps, "list" | "readText"> {
  return { list: listNames, readText: readBody };
}

const editionOf = (text: string | null): Options | null => {
  if (text === null) return null;
  const e = parseEdition(text);
  return e.status === "ok" ? e.edition : null;
};

/** The session's dated copy (options/editions/<day>.json, named by its session) and the latest edition. */
async function loadEditions(day: string): Promise<(Options | null)[]> {
  return (await readAll([`${OPTIONS_PATHS.history}${day}.json`, OPTIONS_PATHS.latest], readBody)).map(editionOf);
}

/** A FetchStop's kind as the report's why; `final` when a later tick cannot heal it. */
function stopOf(e: unknown): { ok: false; final: boolean; why: Exclude<BarsWhy, "no_focus_names"> } {
  if (e instanceof FetchStop) {
    if (e.kind === "sip-plan" || e.kind === "sip-not-entitled") return { ok: false, final: true, why: e.kind };
    if (e.kind === "time-budget") return { ok: false, final: false, why: "time-budget" };
    if (e.kind === "iex-refused" || e.kind === "no-bars") return { ok: false, final: true, why: e.kind };
    return { ok: false, final: false, why: "upstream" };
  }
  return { ok: false, final: false, why: "upstream" };
}

/** The four bars reads of one report run: one call limiter, one deadline; each read's failure is its own. */
export async function readReportBars(symbols: string[], bounds: SessionBounds, o: FetchSessionOpts): Promise<BarsRead> {
  let two: Read<Bar2>;
  let one: Read<MinBar>;
  try {
    const iex = await fetchSessionBars("iex", symbols, bounds, o);
    const sip = await fetchSessionBars("sip", symbols, bounds, o);
    two = { ok: true, bars: { iex: iex.bars, sip: sip.bars } };
  } catch (e) {
    two = stopOf(e);
  }
  try {
    const iex = await fetchMinuteBars("iex", symbols, bounds, o);
    const sip = await fetchMinuteBars("sip", symbols, bounds, o);
    one = { ok: true, bars: { iex, sip } };
  } catch (e) {
    one = stopOf(e);
  }
  return { two, one };
}

const refuse = () => Promise.reject(new Error("dry run: the store is not touched"));

export function defaultReportDeps(): ReportDeps {
  const runStarted = Date.now();
  const dry = fixtureMode() || process.env.VERCEL_ENV !== "production";
  if (dry) return { now: () => Date.now(), dry: true, exists: refuse, list: refuse, readText: refuse, loadEditions: refuse, fetchBars: refuse, write: refuse };
  return {
    now: () => Date.now(),
    dry: false,
    exists: existsBounded,
    list: listNames,
    readText: readBody,
    loadEditions,
    fetchBars: async (symbols, bounds) => {
      const keys = alpacaKeys();
      const base = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL;
      if (!keys || alpacaHost(base) === null) {
        logEvent("feed-compare.report", { outcome: keys ? "data-url" : "no-keys" });
        const off = { ok: false, final: false, why: "upstream" } as const;
        return { two: off, one: off };
      }
      const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
      const deadline = Math.min(Date.now() + BARS_BUDGET_MS, runStarted + RUN_BUDGET_MS);
      return readReportBars(symbols, bounds, { keys, clock, deadline, limiter: new CallLimiter(), baseUrl: base });
    },
    write: (p, body) => putCreateOnly(p, body, WRITE_TIMEOUT_MS),
  };
}
