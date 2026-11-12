import "server-only";
import { configuredFeed, type DataFeed, planRefused } from "./alpaca-feed";
import { exists, PreconditionFailed, readText, readTextIfChanged, writeText } from "./blob";
import { type BarsResponse, fetchSettledBars } from "./bars";
import { JOURNAL_PATHS, OPTIONS_PATHS } from "./desk";
import { defaultDeps as flagsDeps, doneForAlerts, readFlags, type FlagsRead } from "./desk-flags-run";
import { ALL_OFF, DESK_GUARDS_PATH, GUARD_LOG_V, type GuardLog, type GuardSwitches, parseGuardSwitches } from "./desk-guards";
import {
  DESK_EVAL_PATH,
  type DegradedWhy,
  type Evaluation,
  evaluateSlotStates,
  focusSymbols,
  notEvaluated,
  nyHhmm,
  parseEvalSwitch,
  type ServerRecord,
  serverLogPath,
  serverRecord,
  slotAt,
  SYMBOL_RE,
} from "./desk-eval";
import type { JournalDoc } from "./journal";
import { logEvent } from "./log";
import { isHalfDay, type Options } from "./options";
import { alpacaKeys, fetchQuotes, type Quote, type QuoteResponse } from "./quote";
import { farFromPriorClose, quoteGuards } from "./quote-guards";
import { type ProbeRecord, probeSnapshots, type RawSnapshots } from "./quote-probe";
import { fixtureMode } from "./snapshot";
import { CLOSE_GRACE_MS, type NameState, SERVER_SETTLE_MS } from "./trade-state";
import { UpstreamError } from "./upstream";

// GET /api/cron/desk: the server's shadow evaluation of the Options desk (DEC-0044, sections 1 and 2). Once a minute
// in the New York session it works out the board for the last settled 2-minute slot (desk-eval.ts) and writes one
// private, create-only record per slot to desk/log/YYYY-MM-DD/HHMM.json. It logs only: nothing here sends an alert,
// a push or any message, and nothing places, stages or suggests an order.
//
// What one run does, cheapest first, and what it costs in store operations:
//  * outside the session (weekend, holiday, before 09:30, from the close, or before the first bar has settled): idle,
//    no store operation at all;
//  * the switch, desk/eval.json: one read every run. Off, missing or malformed: nothing else happens;
//  * the slot's record: one head(). Already there (the run a minute later in the same slot, a double fire, a late
//    retry): a no-op success, nothing more read;
//  * otherwise the edition and the journal (one read each, a bodiless 304 when unchanged on a warm instance), the
//    done-for-today flag (one read), two upstream calls to Alpaca side by side (the 2-minute bars, and the same
//    snapshot the page's quote route reads), and one create-only put.
// About 390 runs a session: 390 switch reads and 390 heads, then for about 194 slots four reads (the fourth is the
// bad-data guards' switches, desk/guards.json, read beside the journal and the done flag), two upstream calls and one
// put. The snapshot probe (quote-probe.ts) and the guards' observe-mode log add none: they read the snapshot answer
// already fetched and ride on the same put.
//
// Every upstream call has its own hard timeout inside RUN_BUDGET_MS; a timed-out edition or bars read is written as a
// degraded record, never guessed. In fixture mode and anywhere but production it never touches the store: the switch
// reads as off, and a test's injected dry run returns the record it would have written.

/** The most one step may take; the steps together stay under 10 s. */
export const TIMEOUT_MS = { switch: 1_500, exists: 1_500, edition: 1_500, reads: 3_000, barsPage: 2_500, write: 1_500 } as const;

/**
 * What a run writes for its slot: the engine's record (desk-eval.ts serverRecord, whose code the engine label hashes)
 * and, after it, the stock feed an upstream read of the run answered from (alpaca-feed.ts), so shadow sessions can be
 * counted per feed. `feed` is null whenever nothing was read: no keys, ALPACA_FEED refused or not on the data plan,
 * both reads failed or timed out, no edition, a wrong day or no focus names. Records written before it existed have
 * no `feed`; read them with feed-provenance's recordFeed, which gives null for those.
 *
 * `probe`, last, is the log-only snapshot probe (quote-probe.ts): facts about the raw snapshot answer this run read,
 * as enums and numbers, temporary evidence for the board's bad-data guards. Nothing reads it but summariseProbe; it
 * never changes the engine's record or the feed. Null when the snapshot read did not answer, every name came from
 * quote.ts' cache, or the probe failed. Records written before it existed have no `probe`.
 *
 * `guards`, after it, is the bad-data guards' observe-mode log (desk-guards.ts GuardLog): how the switches read, which
 * were on, and per focus name with a snapshot the guards that would pause it whatever the switches say, and whether
 * its row was paused and why. Enum words and symbols only, from what the run already read. Null when the snapshot read
 * did not answer or the log failed; a failure here never fails the run. `http_429`, last, counts the run's upstream
 * answers that were HTTP 429 (the bars and the snapshot: 0 to 2). Records written before them have neither.
 */
export type DeskLogRecord = ServerRecord & { feed: DataFeed | null; probe: ProbeRecord | null; guards: GuardLog | null; http_429: number };

/** The bars or the snapshots cannot be read at all: no keys, ALPACA_FEED is not a feed, or its feed is not on the plan. */
export class BarsOff extends Error {
  constructor() {
    super("bars not configured");
    this.name = "BarsOff";
  }
}
class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimedOut";
  }
}

export type EditionRead = { status: "ok"; edition: Options } | { status: "missing" } | { status: "error" };

/** Everything a run touches, injectable so tests run the real logic with no store and no network. */
export interface DeskRunDeps {
  now(): number;
  /** Fixture mode or anywhere but production: the store is never read or written. */
  dry: boolean;
  readSwitch(): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Create-only: throws PreconditionFailed when the record is already there. Never overwrites. */
  write(path: string, body: string): Promise<void>;
  loadEdition(): Promise<EditionRead>;
  loadJournal(): Promise<JournalDoc | null>;
  readDone(): Promise<FlagsRead>;
  /** The settled bars: a cached read older than `minFetchedAt` is fetched again. Throws BarsOff without keys. */
  fetchBars(symbols: string[], opts: { now: Date; minFetchedAt: number; timeoutMs: number; halfDay: boolean }): Promise<BarsResponse>;
  /**
   * The snapshot per name, as the page's quote route reads it (last trade, day high and low). Throws BarsOff without
   * keys. `onRaw` is handed the raw answer for the probe (fetchQuotes' own `onRaw`); the answer is the same without it.
   */
  fetchSnapshots(symbols: string[], opts: { now: Date; timeoutMs: number; onRaw?: (raw: RawSnapshots) => void }): Promise<QuoteResponse>;
  /** The probe over the raw answer; quote-probe's probeSnapshots unless a test puts another. Whatever it throws is caught. */
  probe?: (symbols: readonly string[], raw: RawSnapshots | null) => ProbeRecord | null;
  /**
   * The bad-data guards' switches, desk/guards.json, as stored (null when there is none). Missing (a test's deps, a dry
   * run): no document, so every guard is off. A failed read is every guard off too, logged and written on the record.
   */
  readGuards?: () => Promise<string | null>;
  /** The observe-mode log; guardLogOf unless a test puts another. Whatever it throws is caught. */
  guardLog?: typeof guardLogOf;
}

export type DeskRunResult =
  | { ok: true; outcome: "idle"; why: string }
  | { ok: true; outcome: "off" }
  | { ok: true; outcome: "already-logged"; slot: string }
  | { ok: true; outcome: "logged"; slot: string; status: ServerRecord["status"]; reason: DegradedWhy | null }
  | { ok: true; outcome: "dry"; slot: string; path: string; record: DeskLogRecord }
  | { ok: false; outcome: "write-failed"; slot: string };

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A stored edition the board can read: an object with a session and tickers. */
export function parseEdition(text: string): EditionRead {
  try {
    const v: unknown = JSON.parse(text);
    if (!isObj(v) || typeof v.session !== "string" || !Array.isArray(v.tickers)) return { status: "error" };
    return { status: "ok", edition: v as unknown as Options };
  } catch {
    return { status: "error" };
  }
}

function parseJournal(text: string): JournalDoc | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) && Array.isArray(v.trades) ? (v as unknown as JournalDoc) : null;
  } catch {
    return null;
  }
}

const refuse = () => Promise.reject(new Error("dry run: the store is not touched"));

/** The deployed dependencies: the private store and Alpaca in production; nothing at all anywhere else. */
export function defaultDeskRunDeps(): DeskRunDeps {
  const dry = fixtureMode() || process.env.VERCEL_ENV !== "production";
  if (dry)
    return {
      now: () => Date.now(),
      dry: true,
      readSwitch: async () => null, // off: nothing is read, nothing is written
      readGuards: async () => null,
      exists: refuse,
      write: refuse,
      loadEdition: refuse,
      loadJournal: refuse,
      readDone: refuse,
      fetchBars: refuse,
      fetchSnapshots: refuse,
    };
  return {
    now: () => Date.now(),
    dry: false,
    readSwitch: async () => (await readText(DESK_EVAL_PATH))?.text ?? null,
    readGuards: async () => (await readText(DESK_GUARDS_PATH))?.text ?? null,
    exists: (path) => exists(path),
    write: async (path, body) => {
      await writeText(path, body, { createOnly: true });
    },
    loadEdition: async () => {
      const r = await readTextIfChanged(OPTIONS_PATHS.latest);
      return r ? parseEdition(r.text) : { status: "missing" };
    },
    loadJournal: async () => {
      const r = await readTextIfChanged(JOURNAL_PATHS.latest);
      return r ? parseJournal(r.text) : null;
    },
    readDone: () => readFlags(flagsDeps()),
    fetchBars: (symbols, o) => {
      const keys = alpacaKeys();
      const feed = configuredFeed();
      if (!keys || !feed) return Promise.reject(new BarsOff());
      return fetchSettledBars(symbols, keys, o.now, o.minFetchedAt, o.timeoutMs, o.halfDay, fetch, undefined, feed).catch(offOnPlan(feed));
    },
    fetchSnapshots: (symbols, o) => {
      const keys = alpacaKeys();
      const feed = configuredFeed();
      if (!keys || !feed) return Promise.reject(new BarsOff());
      return fetchQuotes(symbols, keys, o.now, fetch, undefined, { timeoutMs: o.timeoutMs, feed, onRaw: o.onRaw }).catch(offOnPlan(feed));
    },
  };
}

/** SIP refused by the data plan (alpaca-feed's planRefused) reads as not configured, like a refused ALPACA_FEED. */
const offOnPlan =
  (feed: DataFeed) =>
  (e: unknown): never => {
    throw planRefused(feed, e) ? new BarsOff() : e;
  };

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/**
 * The observe-mode log of the bad-data guards for one run: per focus name with a snapshot (in the card's order), the
 * guards that would pause it (quote-guards.ts on that snapshot, when it is the slot's day's, judged at `now`, the
 * evaluation's own instant), whatever the switches say; the prior-close fact on its own (the bad-print guard also needs
 * the print outside the day's range); and whether its row was paused and why. Pure.
 */
export function guardLogOf(
  switches: GuardSwitches,
  symbols: readonly string[],
  snapshots: Readonly<Record<string, Quote>>,
  day: string,
  states: readonly NameState[],
  now: number,
): GuardLog {
  const paused = new Map(states.filter((st) => st.state === "paused").map((st) => [st.symbol, st.guards?.length ? ("guard" as const) : ("stale" as const)]));
  const names = symbols
    .filter((sym) => Object.hasOwn(snapshots, sym))
    .map((sym) => {
      const q = snapshots[sym]!;
      const today = q.day === day;
      return { symbol: sym, would: today ? quoteGuards(q, { today: day, now }) : [], far_from_prior_close: today && farFromPriorClose(q), paused: paused.get(sym) ?? null };
    });
  return { v: GUARD_LOG_V, switches: switches.status, on: switches.on, names };
}

/** One run: idle, off, already logged, or one record written for the last settled slot. */
export async function runDeskEval(deps: DeskRunDeps = defaultDeskRunDeps()): Promise<DeskRunResult> {
  const startedAt = deps.now();
  const at = slotAt(startedAt);
  if (at.kind === "idle") return { ok: true, outcome: "idle", why: at.why };

  // The switch, every run, from the store: anything but a readable "log" is off.
  let raw: string | null = null;
  try {
    raw = await within(deps.readSwitch(), TIMEOUT_MS.switch);
  } catch (e) {
    logEvent("desk-eval.switch", { outcome: "read-failed", error: errName(e) });
  }
  if (parseEvalSwitch(raw) !== "log") return { ok: true, outcome: "off" };

  const slot = { day: at.day, end: at.end };
  const hhmm = nyHhmm(slot.end);
  const path = serverLogPath(slot.day, slot.end);
  if (!deps.dry) {
    try {
      if (await within(deps.exists(path), TIMEOUT_MS.exists)) return { ok: true, outcome: "already-logged", slot: hhmm };
    } catch (e) {
      // Unknown: carry on; the create-only write still refuses a second record.
      logEvent("desk-eval.exists", { outcome: "error", error: errName(e) });
    }
  }

  // The day's facts are read at the slot's own instant, so two runs of the slot read them alike.
  const slotNow = new Date(slot.end + CLOSE_GRACE_MS);
  let edition: Options | null = null;
  let evaluation: Evaluation;
  /** The feed an upstream read reported: the snapshot's, else the bars'. */
  let readFeed: DataFeed | null = null;
  /** The raw snapshot answer for the probe, and the names it is about: set only when the snapshot read answered. */
  let probeRaw: RawSnapshots | null = null;
  let probeSymbols: string[] = [];
  /** For the guards' log: the switches read, the snapshot answer and the board's states, when the snapshot answered. */
  let guardInput: { switches: GuardSwitches; symbols: string[]; snapshots: Record<string, Quote>; states: NameState[] } | null = null;
  /** HTTP 429 answers from the bars and the snapshot reads. */
  let http429 = 0;
  let read: EditionRead | "timeout";
  try {
    read = await within(deps.loadEdition(), TIMEOUT_MS.edition);
  } catch (e) {
    read = e instanceof TimedOut ? "timeout" : { status: "error" };
  }
  if (read === "timeout") evaluation = notEvaluated("degraded", "store-timeout", at.bounds.halfDay, true);
  else if (read.status !== "ok") evaluation = notEvaluated("degraded", read.status === "missing" ? "edition-missing" : "edition-error", at.bounds.halfDay, true);
  else {
    const ed = read.edition;
    edition = ed;
    const symbols = focusSymbols(ed).filter((s) => SYMBOL_RE.test(s));
    const halfDay = isHalfDay(ed);
    // The journal, the done flag and the bars are read side by side, each within its own timeout.
    const facts = Promise.all([
      within(deps.loadJournal(), TIMEOUT_MS.reads).catch(() => null),
      within(deps.readDone(), TIMEOUT_MS.reads)
        .then((r) => doneForAlerts(r, slotNow))
        .catch(() => true), // could not read: counts as done, as doneForAlerts does
      // The guards' switches: missing, malformed or a failed read is every guard off; a failed read is logged.
      (deps.readGuards ? within(deps.readGuards(), TIMEOUT_MS.reads) : Promise.resolve(null)).then(parseGuardSwitches, (e: unknown) => {
        logEvent("desk-eval.guards", { outcome: "read-failed", error: errName(e) });
        return ALL_OFF("error");
      }),
    ]);
    // A wrong day or an empty card needs no bars: nothing is asked for upstream.
    const needsBars = ed.session === slot.day && symbols.length > 0;
    const upstream = <T,>(p: () => Promise<T>, kind: "bars" | "snapshot"): Promise<{ ok: T } | { why: DegradedWhy }> =>
      within(p(), TIMEOUT_MS.reads).then(
        (ok) => ({ ok }),
        (e: unknown) => {
          if (e instanceof UpstreamError && e.status === 429) http429++;
          const why: DegradedWhy = e instanceof BarsOff ? `${kind}-off` : e instanceof TimedOut || errName(e) === "TimeoutError" ? `${kind}-timeout` : `${kind}-failed`;
          logEvent("desk-eval.upstream", { outcome: why });
          return { why };
        },
      );
    const runAt = new Date(deps.now());
    let tapped: RawSnapshots | null = null;
    const onRaw = (r: RawSnapshots) => {
      tapped = r;
    };
    const [[journal, done, switches], barsGot, snapGot] = await Promise.all([
      facts,
      needsBars ? upstream(() => deps.fetchBars(symbols, { now: runAt, minFetchedAt: slot.end + SERVER_SETTLE_MS, timeoutMs: TIMEOUT_MS.barsPage, halfDay }), "bars") : null,
      needsBars ? upstream(() => deps.fetchSnapshots(symbols, { now: runAt, timeoutMs: TIMEOUT_MS.barsPage, onRaw }), "snapshot") : null,
    ]);
    readFeed = snapGot && "ok" in snapGot ? snapGot.ok.feed : barsGot && "ok" in barsGot ? barsGot.ok.feed : null;
    if (snapGot && "ok" in snapGot) {
      probeRaw = tapped;
      probeSymbols = symbols;
    }
    if (barsGot === null || snapGot === null) evaluation = evaluateSlotStates({ slot, edition: ed, journal, done, bars: {}, fetchedAt: {}, snapshots: {} }).evaluation; // wrong-day or no-focus
    else if ("why" in barsGot) evaluation = notEvaluated("degraded", barsGot.why, halfDay, done, !("why" in snapGot));
    // Never bars alone: without the snapshot an entry could be read past a high the page sees.
    else if ("why" in snapGot) evaluation = notEvaluated("degraded", snapGot.why, halfDay, done, false);
    else {
      // The guards switched on read every run; with none on, the evaluation is exactly as without guards.
      const got = evaluateSlotStates({
        slot,
        edition: ed,
        journal,
        done,
        bars: barsGot.ok.bars,
        fetchedAt: barsGot.ok.fetchedAt,
        snapshots: snapGot.ok.quotes,
        ...(switches.on.length > 0 ? { guardsOn: switches.on } : {}),
      });
      evaluation = got.evaluation;
      guardInput = { switches, symbols, snapshots: snapGot.ok.quotes, states: got.states };
    }
    // The snapshot answered but the board was not reached (the bars failed): the guards' log still counts the names.
    if (!guardInput && snapGot && "ok" in snapGot) guardInput = { switches, symbols, snapshots: snapGot.ok.quotes, states: [] };
  }

  // The probe is log-only: computed after the evaluation from what was already read, and any failure leaves it null.
  let probe: ProbeRecord | null = null;
  try {
    const p = (deps.probe ?? probeSnapshots)(probeSymbols, probeRaw);
    // Serialised once here, so a probe that cannot be written fails here and not in the record's write.
    JSON.stringify(p);
    probe = p ?? null;
  } catch (e) {
    logEvent("desk-eval.probe", { outcome: "error", error: errName(e) });
  }
  // The guards' observe-mode log, the same way: from what was already read, and any failure leaves it null.
  let guards: GuardLog | null = null;
  try {
    if (guardInput) {
      const g = (deps.guardLog ?? guardLogOf)(guardInput.switches, guardInput.symbols, guardInput.snapshots, slot.day, guardInput.states, slot.end + CLOSE_GRACE_MS);
      JSON.stringify(g);
      guards = g ?? null;
    }
  } catch (e) {
    logEvent("desk-eval.guards", { outcome: "log-error", error: errName(e) });
  }
  // The engine's record first, unchanged; the feed after it (outside the hashed code), only when a read answered;
  // the probe, the guards' log and the 429 count last.
  const record: DeskLogRecord = { ...serverRecord(evaluation, slot, deps.now(), edition), feed: readFeed, probe, guards, http_429: http429 };
  if (deps.dry) return { ok: true, outcome: "dry", slot: hhmm, path, record };
  try {
    await within(deps.write(path, JSON.stringify(record)), TIMEOUT_MS.write);
  } catch (e) {
    if (e instanceof PreconditionFailed) {
      logEvent("desk-eval", { outcome: "already-logged", slot: hhmm });
      return { ok: true, outcome: "already-logged", slot: hhmm };
    }
    logEvent("desk-eval", { outcome: "write-failed", slot: hhmm, error: errName(e) });
    return { ok: false, outcome: "write-failed", slot: hhmm };
  }
  logEvent("desk-eval", { outcome: "logged", slot: hhmm, status: record.status, reason: record.reason, rows: record.rows.length, ms: deps.now() - startedAt });
  return { ok: true, outcome: "logged", slot: hhmm, status: record.status, reason: record.reason };
}
