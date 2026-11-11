import "server-only";
import { exists, PreconditionFailed, readForUpdate, readText, readTextIfChanged, storedAt, writeText, type StoredText } from "./blob";
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
  serializeFeedState,
  shadowWindow,
  type ShadowRead,
  type StampedInputs,
  stampInputs,
  storeNotice,
  claimOutbox,
  type FeedAlertState,
  settleOutbox,
  unsentFeeds,
  withOutbox,
} from "./feed-watch";
import { feedVariant } from "./fixture-variants";
import { type IngestRejectKind, readIngestRejectStatus } from "./ingest-reject";
import { logEvent } from "./log";
import { sendNtfy, type Notice } from "./ntfy";
import { fixtureFlags, fixtureMode, type JournalResult, type LedgerResult, type OptionsResult, type RadarResult } from "./snapshot";

// The feed watch's tick (GET /api/cron/watchdog, after the desks' ticks): read every document the feed table names,
// each kind's refusal record and, in the session, the shadow evaluator's switch and newest records; evaluate them
// (feed-watch.ts); commit the alert state; page. One state document for every feed, committed with ifMatch in two
// phases (phase1 below: decide and claim, then send and settle), so two overlapping runs page once and a decided page
// is never lost while the store works.
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
  /** A short pause between two tries of the state read (injected so tests run instantly). */
  sleep?(ms: number): Promise<void>;
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
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** A run's states as the cron's answer and the log carry them: ids and state words only. */
function statesOf(views: readonly FeedView[]): Record<string, string> {
  return Object.fromEntries(views.map((v) => [v.id, v.state]));
}

/**
 * The store-outage rule, which needs no stored state. When the alert state cannot be read (two tries, a short pause
 * between them) or this run's decision cannot be confirmed in the store (phase 1 below), the run sends no feed page at
 * all: it cannot know what was already sent. Instead, with alerts on, a run in either of the first two 10-minute ticks
 * of each fixed 2-hour UTC block (tick index floor(t / 10 min) mod 12 is 0 or 1) sends one "Feed watch cannot read
 * its store". `t` is the run's execution time: Vercel's cron sends no scheduled time with its request, and a run starts
 * within seconds of its tick, so two overlapping invocations of one tick decide alike.
 *
 * Worst cases: a total outage pages within 2 hours 10 minutes of starting, even if one of the two notice runs of a
 * block is skipped; at most 2 notices per 2-hour block (4 if the cron delivers both of those ticks twice), so 24 ticks
 * over 4 hours send 4; no late, refused or recovered page is ever sent from a run that cannot see its state, so an
 * incident paged before the outage is not paged again after it.
 */
export const STORE_NOTICE_EVERY_TICKS = 12;
export const TICK_MS = 10 * 60_000;
export function tickOf(nowMs: number): number {
  return Math.floor(nowMs / TICK_MS);
}
export function storeNoticeTick(nowMs: number): boolean {
  return tickOf(nowMs) % STORE_NOTICE_EVERY_TICKS <= 1;
}
/** The pause between the two tries of a read. */
export const STATE_RETRY_MS = 500;

async function readStateTwice(deps: FeedWatchDeps): Promise<{ ok: true; stored: StoredText | null } | { ok: false }> {
  for (let i = 0; i < 2; i++) {
    if (i > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(STATE_RETRY_MS);
    try {
      return { ok: true, stored: await within(deps.readState(), FEED_READ_MS) };
    } catch (e) {
      logEvent("feed-watch.state", { outcome: "read-failed", attempt: i + 1, error: errName(e) });
    }
  }
  return { ok: false };
}

type Phase1 = { kind: "committed"; etag: string; state: FeedAlertState } | { kind: "skipped" } | { kind: "unconfirmed" };

/**
 * The two-phase record (the feed watch only; the snapshot watchdog's commitThenSend is unchanged).
 *
 * Phase 1: the decision, with every page it makes stored as `pending` and each page this run will send claimed
 * (attempts + 1, last_tick = this tick), is committed with ifMatch before anything is sent. A write that throws is
 * not taken as failed: the state is read again, and if it holds exactly this run's decision, it was committed. A
 * PreconditionFailed means another run was here: the decision is made again once against what it stored, and if that
 * conflicts too, this run is skipped. Anything it cannot confirm, it does not send (fail closed).
 * Phase 2: the claimed pages are sent; each one sent leaves the outbox, and the new state is committed.
 *
 * The guarantee: while the store works, a decided page is never lost: if phase 2's commit is lost, or a run dies
 * between the two phases, the page is still pending in the store and a later run (no sooner than the next tick)
 * sends it again. Every send is preceded by a committed claim, so a page is sent at most OUTBOX_MAX_ATTEMPTS (3)
 * times: at most 2 duplicates in the worst case, when a send succeeds but its record does not. After 3 failed sends
 * it is marked sent_failed and never tried again. Overlapping runs cannot both claim one attempt (ifMatch).
 */
async function phase1(
  deps: FeedWatchDeps,
  stored: StoredText | null,
  decide: (prev: FeedAlertState) => FeedAlertState,
): Promise<Phase1> {
  let base = stored;
  for (let round = 0; round < 2; round++) {
    const next = decide(parseFeedState(base?.text));
    const text = serializeFeedState(next);
    if (base && base.text === text) return { kind: "committed", etag: base.etag, state: next };
    try {
      const { etag } = await within(deps.writeState(text, base ? { ifMatch: base.etag } : { createOnly: true }), FEED_READ_MS);
      return { kind: "committed", etag, state: next };
    } catch (e) {
      const again = await readStateTwice(deps);
      if (!again.ok) return { kind: "unconfirmed" };
      if (again.stored && again.stored.text === text) return { kind: "committed", etag: again.stored.etag, state: next };
      if (!(e instanceof PreconditionFailed)) {
        logEvent("feed-watch.state", { outcome: "write-failed", error: errName(e) });
        return { kind: "unconfirmed" };
      }
      // Another run was here: decide again on what it stored (once).
      base = again.stored;
    }
  }
  logEvent("feed-watch", { outcome: "skipped", reason: "concurrent run" });
  return { kind: "skipped" };
}

/** One tick: read, evaluate, commit, page. Never throws for a store failure: an unreadable input is "unknown". */
export async function runFeedWatch(
  now: Date = new Date(),
  deps: FeedWatchDeps = blobFeedDeps(),
  table: readonly FeedRow[] = FEEDS,
): Promise<Record<string, unknown>> {
  const startedAt = deps.clock();
  const tick = tickOf(now.getTime());
  // This run's own name for its claims (phase 1): never shown anywhere, only compared.
  const runId = globalThis.crypto.randomUUID();
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

  let claimed: string[] = [];
  let gaveUp: string[] = [];
  const p1 = await phase1(deps, state.stored, (prev) => {
    const decision = decideFeedAlerts(views, prev, now, deps.alertsOn, table);
    const next = withOutbox(decision.next, decision, now, table);
    const c = claimOutbox(next, tick, deps.alertsOn, runId, now.getTime());
    claimed = c.claimed;
    gaveUp = c.gaveUp;
    return c.state;
  });
  if (p1.kind === "skipped") return { ...summary, skipped: "concurrent run" };
  if (p1.kind === "unconfirmed") return storeDown("write");
  for (const key of gaveUp) logEvent("feed-watch.outbox", { outcome: "sent_failed", reason: "expired", feeds: outboxFeeds(p1.state, key) });

  // Phase 2: send what was claimed, within the run's budget; then record what went. A claim skipped for want of time
  // records no try, so it does not use one up.
  const results: Record<string, "sent" | "skipped" | "failed"> = {};
  const sentKinds: string[] = [];
  let retried = 0;
  for (const key of claimed) {
    const o = p1.state.outbox.find((x) => x.key === key)!;
    if (deps.clock() - startedAt >= FEED_RUN_BUDGET_MS) continue;
    if (o.attempts > 1) retried++;
    results[key] = await deps.send(o.notice);
    if (results[key] === "sent") sentKinds.push(o.notice.kind);
  }
  let recorded = Object.keys(results).length === 0;
  if (!recorded) {
    const settled = settleOutbox(p1.state, results);
    for (const key of settled.failedNow ?? []) logEvent("feed-watch.outbox", { outcome: "sent_failed", reason: "tries", feeds: outboxFeeds(settled, key) });
    try {
      await within(deps.writeState(serializeFeedState(settled), { ifMatch: p1.etag }), FEED_READ_MS);
      recorded = true;
    } catch (e) {
      // The claims are already stored: a later run sends what is still pending (bounded: see Outgoing in feed-watch.ts).
      logEvent("feed-watch.state", { outcome: "phase2-write-failed", error: errName(e) });
    }
  }
  const values = Object.values(results);
  const result = {
    ...summary,
    // What was actually sent this run, by kind, and how many of those sends were retries of an earlier claim.
    notices: sentKinds,
    sent: values.filter((r) => r === "sent").length,
    failed: values.filter((r) => r === "failed").length,
    retried,
    committed: true,
    recorded,
    ms: deps.clock() - startedAt,
  };
  logEvent("feed-watch", result);
  return result;
}

/** The feed ids of an outbox entry, for a log line (ids only, never text). */
function outboxFeeds(s: FeedAlertState, key: string): string[] {
  return s.outbox.find((o) => o.key === key)?.feeds ?? [];
}

/**
 * The feeds with a page that could not be sent, for the Operations page: one read of the state document. Empty in
 * fixture mode and when the state cannot be read (the panel then says nothing about it).
 */
export async function loadUnsentFeeds(): Promise<string[]> {
  if (fixtureMode()) return [];
  try {
    const stored = await within(readText(FEED_ALERT_PATH), FEED_READ_MS);
    return unsentFeeds(parseFeedState(stored?.text));
  } catch {
    return [];
  }
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
