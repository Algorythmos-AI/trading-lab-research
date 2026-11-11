import "server-only";
import { exists, readForUpdate, readText, readTextIfChanged, storedAt, writeText, type StoredText } from "./blob";
import { DESK_EVAL_PATH, parseEvalSwitch } from "./desk-eval";
import { lastLoggedSlot } from "./desk-page-run";
import {
  decideFeedAlerts,
  evaluateStamped,
  FEEDS,
  type FeedInputs,
  type FeedRow,
  type FeedView,
  parseFeedState,
  type Read,
  type RefusalRead,
  rollbackFeeds,
  sameFeedDecision,
  sameFeedState,
  serializeFeedState,
  shadowWindow,
  type ShadowRead,
  type StampedInputs,
  stampInputs,
  storeNotice,
} from "./feed-watch";
import { feedVariant } from "./fixture-variants";
import { type IngestRejectKind, readIngestRejectStatus } from "./ingest-reject";
import { logEvent } from "./log";
import { sendNtfy, type Notice } from "./ntfy";
import { fixtureFlags, fixtureMode, type JournalResult, type LedgerResult, type OptionsResult, type RadarResult } from "./snapshot";
import { commitThenSend } from "./watchdog-run";

// The feed watch's tick (GET /api/cron/watchdog, after the desks' ticks): read every document the feed table names,
// each kind's refusal record and, in the session, the shadow evaluator's switch and newest records; evaluate them
// (feed-watch.ts); commit the alert state; page. One state document for every feed, committed with ifMatch exactly
// like the snapshot watchdog's (commitThenSend), so two overlapping runs page once.
//
// Display only until the owner switches it on: FEED_WATCH_ALERTS=on. Off, the tick reads, evaluates and stores the
// state as it would with alerts on, and sends nothing (decideFeedAlerts says what happens at switch-on).

/** The feed watch's one state document. PRIVATE: feed ids, booleans, dates and session days only. */
export const FEED_ALERT_PATH = "ops/feeds-alert.json";

/** The longest a run may take: inside the cron function's 60 s with the desks' ticks before it. */
export const FEED_RUN_BUDGET_MS = 25_000;
/** Each read's own limit; the reads run side by side. */
export const FEED_READ_MS = 5_000;

export interface FeedWatchDeps {
  /** A stored document's text, or null when there is none. Throws when the store fails. */
  readDoc(path: string): Promise<string | null>;
  /** A kind's last refusal and whether it still stands. Throws when the store fails. */
  readRefusal(kind: IngestRejectKind): Promise<RefusalRead>;
  /** The shadow evaluator's switch and newest record. Throws when the store fails. */
  readShadow(nowMs: number): Promise<ShadowRead>;
  readState(): Promise<StoredText | null>;
  writeState(body: string, opts: { ifMatch?: string; createOnly?: boolean }): Promise<{ etag: string }>;
  send(notice: Notice): Promise<"sent" | "skipped" | "failed">;
  /** FEED_WATCH_ALERTS=on: pages are sent. Otherwise the state still advances and nothing is sent. */
  alertsOn: boolean;
  clock(): number;
}

/** The owner's switch for the feed watch's pages. Anything but exactly "on" is off. */
export function feedAlertsOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.FEED_WATCH_ALERTS === "on";
}

class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimedOut";
  }
}
function within<T>(p: Promise<T>, msLimit: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), msLimit);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/** A store read as the evaluator takes it: parsed JSON, missing, unreadable text, or an error (a timeout included). */
async function readJson(p: Promise<string | null>): Promise<Read<unknown>> {
  let text: string | null;
  try {
    text = await within(p, FEED_READ_MS);
  } catch (e) {
    logEvent("feed-watch.read", { outcome: "error", error: errName(e) });
    return { status: "error" };
  }
  if (text === null) return { status: "missing" };
  try {
    return { status: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { status: "unreadable" };
  }
}
async function readValue<T>(p: Promise<T>): Promise<Read<T>> {
  try {
    return { status: "ok", value: await within(p, FEED_READ_MS) };
  } catch (e) {
    logEvent("feed-watch.read", { outcome: "error", error: errName(e) });
    return { status: "error" };
  }
}

/** Every input the table needs: each distinct path once, each refusal kind once, the shadow records in the session. */
export async function readFeedInputs(deps: FeedWatchDeps, nowMs: number, table: readonly FeedRow[] = FEEDS): Promise<FeedInputs> {
  const paths = [...new Set(table.flatMap((f) => (f.type === "doc" ? [f.path] : [])))];
  const kinds = [...new Set(table.flatMap((f) => (f.type === "refusal" ? [f.kind] : f.type === "doc" && f.ingest_kind ? [f.ingest_kind] : [])))];
  const wantShadow = table.some((f) => f.type === "shadow") && shadowWindow(nowMs) !== null;
  const [docs, refusals, shadow] = await Promise.all([
    Promise.all(paths.map(async (p) => [p, await readJson(deps.readDoc(p))] as const)),
    Promise.all(kinds.map(async (k) => [k, await readValue(deps.readRefusal(k))] as const)),
    wantShadow ? readValue(deps.readShadow(nowMs)) : Promise.resolve(null),
  ]);
  return { docs: Object.fromEntries(docs), refusals: Object.fromEntries(refusals), shadow };
}

/** The production reads: the private store and ntfy. */
export async function readShadowFromStore(nowMs: number): Promise<ShadowRead> {
  const raw = (await readText(DESK_EVAL_PATH))?.text ?? null;
  const on = parseEvalSwitch(raw) === "log";
  if (!on) return { on, switched_at: null, last_slot_end: null };
  const [at, last] = await Promise.all([
    storedAt(DESK_EVAL_PATH),
    lastLoggedSlot({ now: () => nowMs, dry: false, readSwitch: async () => raw, exists: (p) => exists(p) }, nowMs),
  ]);
  const t = at === null ? NaN : Date.parse(at);
  return { on, switched_at: Number.isFinite(t) ? t : null, last_slot_end: last };
}

async function readRefusalFromStore(kind: IngestRejectKind): Promise<RefusalRead> {
  const s = await readIngestRejectStatus(kind);
  return { current: s.current, at: s.reject?.at ?? null, outcome: s.reject?.outcome ?? null };
}

export function blobFeedDeps(): FeedWatchDeps {
  return {
    readDoc: async (path) => (await readTextIfChanged(path))?.text ?? null,
    readRefusal: readRefusalFromStore,
    readShadow: readShadowFromStore,
    readState: () => readForUpdate(FEED_ALERT_PATH),
    writeState: (body, opts) => writeText(FEED_ALERT_PATH, body, opts),
    send: (notice) => sendNtfy(notice),
    alertsOn: feedAlertsOn(),
    clock: () => Date.now(),
  };
}

/** A run's states as the cron's answer and the log carry them: ids and state words only. */
function statesOf(views: readonly FeedView[]): Record<string, string> {
  return Object.fromEntries(views.map((v) => [v.id, v.state]));
}

/** One tick: read, evaluate, commit, page. Never throws for a store failure: an unreadable input is "unknown". */
/**
 * The store-outage rule, which needs no stored state. When the alert state cannot be read (after one retry in the run)
 * or the new state cannot be committed (fail closed: commitThenSend `failClosed`), the run sends no feed page at all:
 * it cannot know what was already sent. Instead, with alerts on, the run of the first 10-minute tick of each fixed
 * 2-hour UTC block (tick index floor(t / 10 min) ≡ 0 mod 12, from the run's own scheduled time, so overlapping
 * invocations of one tick decide alike) sends one "Feed watch cannot read its store".
 *
 * Worst cases: a total outage pages within 2 hours of starting and then once per 2-hour block (24 ticks of 10 minutes,
 * 4 hours: exactly 2 pages); one block never has more than one, or two if the cron delivers that very tick twice; no
 * late, refused or recovered page is ever sent from a run that cannot see its state, so an incident paged before the
 * outage is not paged again after it.
 */
export const STORE_NOTICE_EVERY_TICKS = 12;
export const TICK_MS = 10 * 60_000;
export function storeNoticeTick(nowMs: number): boolean {
  return Math.floor(nowMs / TICK_MS) % STORE_NOTICE_EVERY_TICKS === 0;
}

async function readStateTwice(deps: FeedWatchDeps): Promise<{ ok: true; stored: StoredText | null } | { ok: false }> {
  for (let i = 0; i < 2; i++) {
    try {
      return { ok: true, stored: await within(deps.readState(), FEED_READ_MS) };
    } catch (e) {
      logEvent("feed-watch.state", { outcome: "read-failed", attempt: i + 1, error: errName(e) });
    }
  }
  return { ok: false };
}

/** One tick: read, evaluate, commit, page. Never throws for a store failure: an unreadable input is "unknown". */
export async function runFeedWatch(
  now: Date = new Date(),
  deps: FeedWatchDeps = blobFeedDeps(),
  table: readonly FeedRow[] = FEEDS,
): Promise<Record<string, unknown>> {
  const startedAt = deps.clock();
  const [inputs, state] = await Promise.all([readFeedInputs(deps, now.getTime(), table), readStateTwice(deps)]);
  const views = evaluateStamped(stampInputs(inputs, table), now.getTime(), table);
  const summary = { ok: true, alerts: deps.alertsOn ? "on" : "off", states: statesOf(views) };
  const storeDown = async (why: "read" | "write") => {
    const due = deps.alertsOn && storeNoticeTick(now.getTime());
    const r = due ? await deps.send(storeNotice(now)) : null;
    const result = { ...summary, state: `${why}-failed`, notices: due ? ["feed-late"] : [], sent: r === "sent" ? 1 : 0, committed: false };
    logEvent("feed-watch", result);
    return result;
  };
  if (!state.ok) return storeDown("read");
  const stored = state.stored;
  const prev = parseFeedState(stored?.text);
  const decision = decideFeedAlerts(views, prev, now, deps.alertsOn, table);
  const r = await commitThenSend({
    deps,
    stored,
    unchanged: sameFeedState(prev, decision.next),
    nextText: serializeFeedState(decision.next),
    committedByOther: (text) => sameFeedDecision(parseFeedState(text), decision.next),
    notices: decision.notices,
    rollbackText: (failedAt) =>
      serializeFeedState(rollbackFeeds(prev, decision.next, failedAt.map((i) => decision.noticeFeeds[i]!), decision.summaryFeeds)),
    event: "feed-watch",
    deadline: startedAt + FEED_RUN_BUDGET_MS,
    clock: deps.clock,
    failClosed: true,
  });
  if (r.skipped) return { ...summary, skipped: r.skipped };
  if (r.blocked) return storeDown("write");
  const result = {
    ...summary,
    notices: decision.notices.map((n) => n.kind),
    noticeFeeds: decision.noticeFeeds,
    sent: r.sent,
    failed: r.failed,
    committed: r.committed,
    ms: deps.clock() - startedAt,
  };
  logEvent("feed-watch", result);
  return result;
}

/**
 * The feed watch drill, offline: two real ticks of runFeedWatch on in-memory state and synthetic documents, alerts on,
 * every page handed to `send` (the test records them; nothing reaches ntfy). Tick 1: the options edition is still the
 * one for today at 23:30 UTC on Thursday 12 November 2026, after its 22:52 UTC deadline (a "late" page). Tick 2: the
 * edition for Friday has arrived (a "back on time" page). Every title starts with "DRILL:".
 */
export async function runFeedDrill(
  send: (n: Notice) => Promise<"sent" | "skipped" | "failed">,
  now: Date = new Date("2026-11-12T23:30:00Z"),
): Promise<{ tick1: unknown; tick2: unknown; pages: Notice[] }> {
  const table = FEEDS.filter((f) => f.id === "options-edition");
  let edition: Record<string, unknown> = { session: "2026-11-12", as_of: "2026-11-11T22:30:00Z" };
  let state: StoredText | null = null;
  let seq = 0;
  const pages: Notice[] = [];
  const mem: FeedWatchDeps = {
    readDoc: async () => JSON.stringify(edition),
    readRefusal: async () => ({ current: false, at: null, outcome: null }),
    readShadow: async () => ({ on: false, switched_at: null, last_slot_end: null }),
    readState: async () => state,
    writeState: async (body) => {
      state = { text: body, etag: String(++seq) };
      return { etag: state.etag };
    },
    send: async (n) => {
      const page = { ...n, title: `DRILL: ${n.title}` };
      pages.push(page);
      return send(page);
    },
    alertsOn: true,
    clock: () => Date.now(),
  };
  const tick1 = await runFeedWatch(now, mem, table);
  const later = new Date(now.getTime() + 10 * 60_000);
  edition = { session: "2026-11-13", as_of: new Date(later.getTime() - 2 * 60_000).toISOString() };
  const tick2 = await runFeedWatch(later, mem, table);
  return { tick1, tick2, pages };
}

// ---- the pages ------------------------------------------------------------------------------------------------------

type DocResult = OptionsResult | JournalResult | LedgerResult | RadarResult;

/** A page loader's result as the evaluator reads it. A failed read is unknown, never "on time". */
function fromResult(r: DocResult | null | undefined): Read<unknown> | null {
  if (!r) return null;
  if (r.status === "ok") return { status: "ok", value: "edition" in r ? r.edition : r.doc };
  return r.status === "missing" ? { status: "missing" } : { status: "error" };
}

export interface PageFeedSources {
  /** The rows the page draws (feed-watch.ts FEEDS ids). Everything read follows from these rows. */
  ids: readonly string[];
  /** Documents the page has already loaded (snapshot.ts), by store path; any other row's document is read here. */
  loaded?: Readonly<Record<string, DocResult | null | undefined>>;
}

/**
 * The stamps a page draws its feeds from, all derived from the table: each requested doc row's document (the page's
 * own load when it has one, otherwise one read of the row's path), the refusal record of each kind those rows name,
 * and, in the session, the shadow evaluator's switch and newest records when a shadow row is asked for. In fixture
 * mode nothing is read from the store (no refusal, the switch off, any other document missing), and the `feeds-*`
 * variants bend the stamps (fixture-variants.ts feedVariant).
 */
export async function loadPageFeeds(src: PageFeedSources, now: Date, table: readonly FeedRow[] = FEEDS): Promise<StampedInputs> {
  const rows = table.filter((f) => src.ids.includes(f.id));
  const dry = fixtureMode();
  const paths = [...new Set(rows.flatMap((f) => (f.type === "doc" ? [f.path] : [])))];
  const kinds = [...new Set(rows.flatMap((f) => (f.type === "refusal" ? [f.kind] : f.type === "doc" && f.ingest_kind ? [f.ingest_kind] : [])))];
  const docs: Record<string, Read<unknown>> = Object.fromEntries(
    await Promise.all(
      paths.map(async (p) => {
        const mine = fromResult(src.loaded?.[p]);
        if (mine) return [p, mine] as const;
        return [p, dry ? ({ status: "missing" } as const) : await readJson(readTextIfChanged(p).then((r) => r?.text ?? null))] as const;
      }),
    ),
  );
  const refusals: FeedInputs["refusals"] = Object.fromEntries(
    await Promise.all(kinds.map(async (k) => [k, dry ? ({ status: "missing" } as const) : await readValue(readRefusalFromStore(k))] as const)),
  );
  const wantShadow = rows.some((f) => f.type === "shadow") && shadowWindow(now.getTime()) !== null;
  const shadow: FeedInputs["shadow"] = !wantShadow ? null : dry ? { status: "missing" } : await readValue(readShadowFromStore(now.getTime()));
  const stamped = stampInputs({ docs, refusals, shadow }, table);
  return dry ? feedVariant(stamped, await fixtureFlags(), now.getTime()) : stamped;
}
