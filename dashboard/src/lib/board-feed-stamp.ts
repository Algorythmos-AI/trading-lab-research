import "server-only";
import { BlobNotFoundError, BlobPreconditionFailedError, get, head, list, put } from "@vercel/blob";
import { alpacaDataUrl } from "./alpaca-data-url";
import { type DataFeed, feedSetting, planRefused } from "./alpaca-feed";
import { alreadyThere, listPaths, PreconditionFailed, readText } from "./blob";
import {
  BOARD_FEED_PREFIX,
  type BoardFeedManifest,
  type BoardFeedStamp,
  bodyHash,
  type ChainBody,
  type JudgeStamp,
  manifestKey,
  minuteOf,
  parseManifest,
  parseStamp,
  type StampAnswer,
  stampKey,
} from "./board-feed-judge";
import { logEvent } from "./log";
import { addDays, nyNow, sessionOf } from "./market-calendar";
import { nyInstant } from "./options";
import { alpacaKeys } from "./quote";
import { UpstreamError } from "./upstream";

// The board-feed stamp (EXP-0033, DEC-0050): once a minute in the regular session, the production deployment writes
// which stock feed its board reads (ALPACA_FEED, alpaca-feed.ts) and whether that feed answered one read of SPY's latest
// trade in the same minute, so a session can later be counted only if the board read SIP from the open to the close
// (board-feed-judge.ts sessionEnds, covered, boardOff). Called by the desk cron before its shadow run, whatever the
// run's switch (desk/eval.json) says. Advisory and read-only: one market-data read and one small private object a
// minute; it places nothing anywhere.
//
//  * Only where VERCEL_ENV is "production": preview, staging and local runs write nothing and read nothing.
//  * Only in the regular session of a session day by the market calendar (market-calendar.ts sessionOf), half-open:
//    from the open up to, not including, the close; a half day closes early. Weekends, holidays and days past the
//    calendar's end write no stamp.
//  * `answered`: one direct read of SPY's latest trade on the resolved feed (probeSpy; never quote.ts's cache): "ok"
//    with a trade within 60 s of the stamp's `at`, "stale" with an older (or newer) one, "plan" when Alpaca refuses SIP
//    on the plan (alpaca-feed.ts planRefused), "error" for anything else (no keys, a timeout, no trade). With the feed
//    refused nothing is read and it is "error".
//  * One object per New York minute, desk/feeds/board/<YYYY-MM-DD>/<HHMM>.json, create-only: a second run in the same
//    minute is refused by the store and reports "duplicate". Each carries `prev`, the SHA-256 of the exact stored body
//    of the day's nearest earlier stamp, null for the first. It is found key by key, one head per minute, from the
//    minute before back to 15 minutes (never before the open), all at once, the latest that is there winning; only when
//    none of those is there is the day's prefix listed. The store's list can lag behind its writes, and a lagging list is NOT safe for the chain: it can name an
//    older stamp than the nearest, and a prev written from it breaks the chain for good (verifyChain then reads
//    prev_mismatch for the day). The walk-back makes that rare (a gap of over 15 minutes and a lagging list together);
//    it cannot make it impossible. A stamp that is there but cannot be read leaves the minute unstamped.
//  * Every store call carries an abort signal at the run's deadline (timeoutMs). Just before the write the deadline
//    and the New York minute are checked again, and the write is not started past second 45 of the minute: past the
//    deadline, past second 45, or once the clock has moved into another minute, nothing is written ("late"), so a slow
//    run never writes a stamp at a key its `at` does not belong to.
//  * Seal: from 2 minutes after a session day's close, and on any later run before the next session's open (pre-open
//    runs included), the most recent session day still unsealed gets desk/feeds/board/<day>/manifest.json, {v, count,
//    last, at}: create-only, so written once and never overwritten. It has its own limit (SEAL_TIMEOUT_MS, 20 s). Before
//    it is written, the keys after the last listed stamp up to the close (its last 15 minutes) are headed, and every
//    listed stamp is read (25 at a time) and each prev must link to the body before it. When a tail key is there
//    unlisted, or the links do not hold (a listing that lags, a body not yet readable), the seal waits ("seal-wait")
//    and the next run tries again, until the next open. Just before the write the next open
//    is checked again: at or past it, nothing is written ("late").
//  * In production with VERCEL_DEPLOYMENT_ID empty, the stamp is still written (deployment null) and one line,
//    outcome "no-deployment-id", is logged once per instance.
//  * It never throws to its caller: a failure logs one line, board-feed.stamp, with an outcome word, and returns.

export type StampOutcome =
  | "written"
  | "manifest-written"
  | "not-production"
  | "closed"
  | "duplicate"
  | "late"
  | "seal-wait"
  | "store-failed"
  | "timeout"
  | "failed";

/** The store as the stamp uses it; every call takes the run's abort signal. */
export interface StampStore {
  /** The pathnames under a prefix. */
  list: (prefix: string, signal: AbortSignal) => Promise<string[]>;
  /** A stored body's exact text; null when there is none. */
  read: (pathname: string, signal: AbortSignal) => Promise<string | null>;
  exists: (pathname: string, signal: AbortSignal) => Promise<boolean>;
  /** A create-only write: throws PreconditionFailed when the object is already there. */
  create: (pathname: string, body: string, signal: AbortSignal) => Promise<void>;
}

export interface StampDeps {
  env: Record<string, string | undefined>;
  /** The build's commit (BUILD_SHA, else VERCEL_GIT_COMMIT_SHA); the stamp keeps its first 12 characters. */
  commitSha: string | null;
  now: () => Date;
  store: StampStore;
  /** The store's limit for the whole stamp or seal: past it the run gives up (and its calls are aborted), so a slow
   *  store never holds back the shadow run after it. */
  timeoutMs: number;
  /** The seal's own limit (and abort signal): it reads the whole day's stamps, up to about 390. */
  sealTimeoutMs: number;
  /** One SPY latest-trade read on `feed` for a stamp at `at`; may throw or reject (it is caught). */
  probe: (feed: DataFeed, at: Date) => Promise<StampAnswer>;
}

/** The SPY read's upstream limit. */
export const PROBE_TIMEOUT_MS = 2_500;
/** A latest trade further than this from the stamp's `at` is "stale". */
export const TRADE_FRESH_MS = 60_000;
/** The store's part of a stamp or a seal slower than this is given up on: the minute goes unstamped. */
export const STAMP_TIMEOUT_MS = 3_000;
/**
 * The seal's limit. It runs only outside the session (from close + 2 min, or before the next open), where the desk's
 * shadow run after it is idle and answers at once, so it and the run stay inside the route's maxDuration (30 s).
 */
export const SEAL_TIMEOUT_MS = 20_000;
/** The seal reads the day's stamps this many at a time. */
export const SEAL_READS_AT_ONCE = 25;
/** The seal heads the keys after the last listed stamp, up to the close, within this many final minutes. */
export const SEAL_TAIL_MIN = 15;
/** The seal waits this long past the close, so the last minute's stamp has landed. */
export const SEAL_AFTER_CLOSE_MIN = 2;
const MINUTE_MS = 60_000;
/** A stamp's write is not started at or past this second of its minute (New York minutes start on UTC minutes). */
export const PUT_CUTOFF_MS = 45_000;
/** How far back the previous stamp is looked for key by key (one head each) before the day is listed. */
export const PREV_WALK_MIN = 15;

let warnedNoDeployment = false;
/** Test hook: let the next stamp without VERCEL_DEPLOYMENT_ID log again. */
export function resetStampWarnings(): void {
  warnedNoDeployment = false;
}

/** The private store, every call bounded by the run's signal (blob.ts's options, with an abort signal). */
export const blobStampStore: StampStore = {
  async list(prefix, signal) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000, abortSignal: signal });
      out.push(...page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
  async read(pathname, signal) {
    const res = await get(pathname, { access: "private", useCache: false, abortSignal: signal });
    if (!res || res.statusCode !== 200) return null;
    return await new Response(res.stream).text();
  },
  async exists(pathname, signal) {
    try {
      await head(pathname, { abortSignal: signal });
      return true;
    } catch (e) {
      if (e instanceof BlobNotFoundError) return false;
      throw e;
    }
  },
  async create(pathname, body, signal) {
    try {
      await put(pathname, body, {
        access: "private",
        allowOverwrite: false,
        addRandomSuffix: false,
        contentType: "application/json",
        cacheControlMaxAge: 60,
        abortSignal: signal,
      });
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || alreadyThere(e)) throw new PreconditionFailed();
      throw e;
    }
  },
};

export const defaultStampDeps = (): StampDeps => ({
  env: process.env,
  // Read as literals, so the build can inline them.
  commitSha: process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null,
  now: () => new Date(),
  store: blobStampStore,
  timeoutMs: STAMP_TIMEOUT_MS,
  sealTimeoutMs: SEAL_TIMEOUT_MS,
  probe: (feed, at) => probeSpy(feed, at),
});

/** Where the probe reads when ALPACA_DATA_URL is unset (as the other market-data readers do). */
const DEFAULT_DATA_URL = "https://data.alpaca.markets";

/**
 * SPY's latest trade on `feed`, read directly (GET /v2/stocks/SPY/trades/latest, no-store), as the stamp's `answered`
 * for a stamp at `at`: "ok" for a 2xx with a trade within 60 s of `at`, "stale" for one further from it, "plan" for a
 * 403 on sip (alpaca-feed.ts planRefused, which logs once per instance), "error" for anything else, no keys included.
 * Its own read on purpose: quote.ts fetchQuotes would put SPY in its per-instance cache, and the shadow run straight
 * after would then answer SPY from it and skip SPY in its raw-snapshot probe (quote-probe.ts) every minute. Never throws.
 */
export async function probeSpy(
  feed: DataFeed,
  at: Date,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<StampAnswer> {
  const keys = alpacaKeys(env);
  if (!keys) return "error";
  try {
    const url = alpacaDataUrl(env.ALPACA_DATA_URL || DEFAULT_DATA_URL, "/v2/stocks/SPY/trades/latest", { feed });
    const res = await fetchImpl(url, {
      headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return planRefused(feed, new UpstreamError(res.status)) ? "plan" : "error";
    const body = (await res.json()) as { trade?: { t?: unknown; p?: unknown } | null } | null;
    const tr = body?.trade;
    const t = typeof tr?.t === "string" ? Date.parse(tr.t) : NaN;
    if (!tr || typeof tr.p !== "number" || !Number.isFinite(tr.p) || !Number.isFinite(t)) return "error";
    return Math.abs(at.getTime() - t) <= TRADE_FRESH_MS ? "ok" : "stale";
  } catch {
    return "error";
  }
}

/** The probe's answer, never a throw: a probe that throws or rejects answered "error". */
async function answeredBy(deps: StampDeps, feed: DataFeed | null, at: Date): Promise<StampAnswer> {
  if (feed === null) return "error";
  try {
    const a = await deps.probe(feed, at);
    return a === "ok" || a === "stale" || a === "plan" ? a : "error";
  } catch {
    return "error";
  }
}

/** The day's stamp keys (HHMM.json under its prefix), by minute; anything else under the prefix is left out. */
async function stampPaths(store: StampStore, day: string, signal: AbortSignal): Promise<{ path: string; minute: number }[]> {
  const prefix = `${BOARD_FEED_PREFIX}${day}/`;
  const out: { path: string; minute: number }[] = [];
  for (const path of await store.list(prefix, signal)) {
    if (!path.startsWith(prefix)) continue;
    const hhmm = /^(\d{4})\.json$/.exec(path.slice(prefix.length))?.[1];
    const minute = hhmm ? minuteOf(hhmm) : null;
    if (minute !== null) out.push({ path, minute });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

/** A stored body that should be there and is not (listed, then gone): the chain cannot be continued honestly. */
class ChainBroken extends Error {
  constructor() {
    super("a listed stamp could not be read");
    this.name = "ChainBroken";
  }
}

/** The listed stamps do not chain yet (a lagging list, a body not yet readable): the seal waits for a later run. */
class SealWait extends Error {
  constructor() {
    super("the day's listed stamps do not chain yet");
    this.name = "SealWait";
  }
}

/** The run passed its deadline, second 45 of its minute or the next open, or the clock moved into another minute,
 *  before the write: nothing is written. */
class Late extends Error {
  constructor() {
    super("the stamp's minute or deadline has passed");
    this.name = "Late";
  }
}

/**
 * The hash of the day's nearest earlier stamp: key by key (one head each) from the minute before back PREV_WALK_MIN
 * minutes, never before `open`; else by listing the day (which can lag); null for none.
 */
async function prevHash(store: StampStore, day: string, minute: number, open: number, signal: AbortSignal): Promise<string | null> {
  const minutes: number[] = [];
  for (let m = minute - 1; m >= Math.max(open, minute - PREV_WALK_MIN, 0); m--) minutes.push(m);
  // All at once, so a gap longer than the walk costs one round trip, not fifteen; the latest that exists wins.
  const there = await Promise.all(minutes.map((m) => store.exists(stampKey(day, m), signal)));
  const found = minutes.find((_, i) => there[i]);
  let path: string | null = found === undefined ? null : stampKey(day, found);
  if (path === null) {
    const earlier = (await stampPaths(store, day, signal)).filter((p) => p.minute < minute);
    path = earlier.length > 0 ? earlier[earlier.length - 1]!.path : null;
  }
  if (path === null) return null;
  const text = await store.read(path, signal);
  if (text === null) throw new ChainBroken();
  return bodyHash(text);
}

/** The next session's open (epoch ms) after New York day `day`; null past the calendar's end. */
export function nextOpenAfter(day: string): number | null {
  for (let d = addDays(day, 1), i = 0; i < 15; d = addDays(d, 1), i++) {
    const s = sessionOf(d);
    if (s.kind === "out_of_range") return null;
    if (s.open !== null) return nyInstant(d, s.open);
  }
  return null;
}

/** The most recent session day strictly before `day` (within two weeks); null when there is none in the calendar. */
function previousSession(day: string): string | null {
  for (let d = addDays(day, -1), i = 0; i < 15; d = addDays(d, -1), i++) {
    const s = sessionOf(d);
    if (s.kind === "out_of_range") return null;
    if (s.open !== null) return d;
  }
  return null;
}

/**
 * The session day a run at New York (day, minute) should seal, if any: today from 2 minutes after its close; otherwise
 * the most recent previous session while the next open after it has not come (on a non-session day, or before
 * today's open). Null in the session and in the 2 minutes after the close.
 */
export function dayToSeal(day: string, minute: number): string | null {
  const s = sessionOf(day);
  if (s.open !== null && s.close !== null) {
    if (minute >= s.close + SEAL_AFTER_CLOSE_MIN) return day;
    if (minute >= s.open) return null;
  }
  return previousSession(day);
}

/**
 * The day's seal, once: the count of stamps and the last one's hash, only once every listed stamp reads and each prev
 * links to the body before it (else SealWait). False when it was already there.
 */
async function writeManifest(deps: StampDeps, day: string, at: Date, signal: AbortSignal): Promise<boolean> {
  const store = deps.store;
  const key = manifestKey(day);
  if (await store.exists(key, signal)) return false;
  const paths = await stampPaths(store, day, signal);
  // A list that lags at the tail would seal a short count: any stamp key after the last listed one, up to the close's
  // last minute (the last SEAL_TAIL_MIN minutes at most), that is there makes the seal wait.
  const s = sessionOf(day);
  if (s.open !== null && s.close !== null) {
    const after = paths.length > 0 ? paths[paths.length - 1]!.minute + 1 : s.open;
    const tail: number[] = [];
    for (let m = Math.max(after, s.close - SEAL_TAIL_MIN); m < s.close; m++) tail.push(m);
    if ((await Promise.all(tail.map((m) => store.exists(stampKey(day, m), signal)))).some(Boolean)) throw new SealWait();
  }
  const texts = await mapLimit(paths, SEAL_READS_AT_ONCE, (p) => store.read(p.path, signal));
  let last: string | null = null;
  for (const text of texts) {
    const stamp = text === null ? null : parseStamp(text);
    if (text === null || !stamp || stamp.prev !== last) throw new SealWait();
    last = bodyHash(text);
  }
  const manifest: BoardFeedManifest = { v: 1, count: paths.length, last, at: at.toISOString() };
  const nextOpen = nextOpenAfter(day);
  if (signal.aborted || nextOpen === null || !(deps.now().getTime() < nextOpen)) throw new Late();
  try {
    await store.create(key, JSON.stringify(manifest), signal);
  } catch (e) {
    // Another run sealed it between the check and the write: written once, never overwritten.
    if (e instanceof PreconditionFailed) return false;
    throw e;
  }
  return true;
}

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * `work` under the store's limit: its signal aborts every store call at the deadline, and a race returns "timeout" if
 * the work has not settled by then. A refused create is "duplicate", a late write "late", any other failure
 * "store-failed"; each logs one line.
 */
async function withinLimit(
  deps: StampDeps,
  limitMs: number,
  work: (signal: AbortSignal, deadline: number) => Promise<StampOutcome>,
): Promise<StampOutcome> {
  const deadline = deps.now().getTime() + limitMs;
  const signal = AbortSignal.timeout(limitMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limitMs);
  });
  try {
    const got = await Promise.race([work(signal, deadline), late]);
    if (got === "timeout") logEvent("board-feed.stamp", { outcome: "timeout", timeout_ms: limitMs });
    return got;
  } catch (e) {
    const outcome: StampOutcome =
      e instanceof PreconditionFailed ? "duplicate" : e instanceof Late ? "late" : e instanceof SealWait ? "seal-wait" : signal.aborted ? "timeout" : "store-failed";
    logEvent("board-feed.stamp", { outcome, ...(outcome === "store-failed" ? { error: e instanceof Error ? e.name : "unknown" } : {}) });
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In the session, writes this minute's stamp; from 2 minutes after a close, or before the next open, seals the most
 * recent unsealed session day (once). The outcome word, never a throw.
 */
export async function stampBoardFeed(over: Partial<StampDeps> = {}): Promise<StampOutcome> {
  try {
    const deps = { ...defaultStampDeps(), ...over };
    if (deps.env.VERCEL_ENV !== "production") return "not-production";
    const at = deps.now();
    const { day, minute } = nyNow(at);
    const s = sessionOf(day);
    if (s.open === null || s.close === null || minute < s.open || minute >= s.close) {
      const seal = dayToSeal(day, minute);
      if (seal === null) return "closed";
      return await withinLimit(deps, deps.sealTimeoutMs, async (signal) => ((await writeManifest(deps, seal, at, signal)) ? "manifest-written" : "closed"));
    }
    const deployment = deps.env.VERCEL_DEPLOYMENT_ID || null;
    if (deployment === null && !warnedNoDeployment) {
      warnedNoDeployment = true;
      logEvent("board-feed.stamp", { outcome: "no-deployment-id" });
    }
    const setting = feedSetting(deps.env);
    const feed = setting.ok ? setting.feed : null;
    const answered = await answeredBy(deps, feed, at);
    return await withinLimit(deps, deps.timeoutMs, async (signal, deadline) => {
      const prev = await prevHash(deps.store, day, minute, s.open!, signal);
      const stamp: BoardFeedStamp = {
        v: 1,
        feed: feed ?? "refused",
        answered,
        at: at.toISOString(),
        deployment,
        commit: deps.commitSha ? deps.commitSha.slice(0, 12) : null,
        prev,
      };
      const now = deps.now();
      const still = nyNow(now);
      const second = ((now.getTime() % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
      if (signal.aborted || now.getTime() > deadline || second >= PUT_CUTOFF_MS || still.day !== day || still.minute !== minute) throw new Late();
      await deps.store.create(stampKey(day, minute), JSON.stringify(stamp), signal);
      return "written";
    });
  } catch (e) {
    logEvent("board-feed.stamp", { outcome: "failed", error: e instanceof Error ? e.name : "unknown" });
    return "failed";
  }
}

export interface BoardFeedDay {
  /** The day's readable stamps in key order, as the judges read them: `minute` is the key's New York minute as an
   *  instant (epoch ms), `hhmm` the key itself. */
  stamps: (JudgeStamp & { hhmm: string })[];
  /** Objects under the day's prefix that are neither a v1 stamp at a HHMM key nor the manifest: skipped, never guessed at. */
  malformed: number;
  /** The exact stored text at every HHMM key, readable or not, by minute: what verifyChain checks. */
  bodies: ChainBody[];
  /** The day's manifest; null when there is none (or it is not one). */
  manifest: BoardFeedManifest | null;
  /** The next session's open after the day (epoch ms), verifyChain's nextOpen; null past the calendar's end. */
  nextOpen: number | null;
}

export interface ReadDeps {
  list: (prefix: string) => Promise<{ pathname: string }[]>;
  read: (pathname: string) => Promise<{ text: string } | null>;
}

const readDeps = (): ReadDeps => ({ list: listPaths, read: readText });

/** Every stamp stored for a New York day (YYYY-MM-DD), malformed ones skipped and counted, with the chain's inputs. */
export async function readBoardFeedDay(day: string, over: Partial<ReadDeps> = {}): Promise<BoardFeedDay> {
  const deps = { ...readDeps(), ...over };
  const prefix = `${BOARD_FEED_PREFIX}${day}/`;
  const paths = (await deps.list(prefix))
    .map((p) => p.pathname)
    .filter((p) => p.startsWith(prefix))
    .sort();
  const stamps: BoardFeedDay["stamps"] = [];
  const bodies: ChainBody[] = [];
  let malformed = 0;
  let manifest: BoardFeedManifest | null = null;
  for (const p of paths) {
    if (p === manifestKey(day)) {
      const got = await deps.read(p);
      manifest = got ? parseManifest(got.text) : null;
      continue;
    }
    const hhmm = /^(\d{4})\.json$/.exec(p.slice(prefix.length))?.[1];
    const m = hhmm ? minuteOf(hhmm) : null;
    const minute = m === null ? null : nyInstant(day, m);
    const got = minute === null ? null : await deps.read(p);
    if (got && minute !== null) bodies.push({ minute, text: got.text });
    const stamp = got ? parseStamp(got.text) : null;
    if (!hhmm || minute === null || !stamp) {
      malformed++;
      continue;
    }
    stamps.push({ minute, hhmm, feed: stamp.feed, answered: stamp.answered, deployment: stamp.deployment, at: stamp.at });
  }
  return { stamps, malformed, bodies, manifest, nextOpen: nextOpenAfter(day) };
}
