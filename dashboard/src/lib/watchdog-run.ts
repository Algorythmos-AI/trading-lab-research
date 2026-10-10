import "server-only";
import {
  ALERT_STATE_PATH,
  HISTORY_PREFIX,
  LATEST_PATH,
  PreconditionFailed,
  deleteUrls,
  listPaths,
  readForUpdate,
  readText,
  writeText,
  type StoredText,
} from "./blob";
import { DESK_LABEL, DESK_PATHS, type DeskName } from "./desk";
import { logEvent } from "./log";
import { sendNtfy, type Notice } from "./ntfy";
import type { Snapshot } from "./types";
import { evaluate, historyToPrune, parseState, sameState } from "./watchdog";

/** Everything a watchdog tick touches, injectable so the drill can run the real logic on in-memory state. */
export interface WatchdogDeps {
  readLatest(): Promise<{ text: string } | null>;
  readState(): Promise<StoredText | null>;
  writeState(body: string, opts: { ifMatch?: string; createOnly?: boolean }): Promise<{ etag: string }>;
  listHistory(): Promise<{ pathname: string; url: string }[]>;
  deleteHistory(urls: string[]): Promise<void>;
  send(notice: Notice): Promise<"sent" | "skipped" | "failed">;
  /** Daily history pruning; off for the drill. */
  prune: boolean;
}

/** The production dependencies: private Blob storage and ntfy. */
export const blobDeps: WatchdogDeps = {
  readLatest: () => readText(LATEST_PATH),
  readState: () => readForUpdate(ALERT_STATE_PATH),
  writeState: (body, opts) => writeText(ALERT_STATE_PATH, body, opts),
  listHistory: () => listPaths(HISTORY_PREFIX),
  deleteHistory: (urls) => deleteUrls(urls),
  send: (notice) => sendNtfy(notice),
  prune: true,
};

/** The desks added after the stocks desk (ADR 0005). Each has its own tick, which a "new" desk skips. */
export type AddedDesk = Exclude<DeskName, "stocks">;

/**
 * An added desk's dependencies: its own latest snapshot, alert state and history, and pages that say which desk
 * they are about. A desk is watched inside the windows its own snapshot publishes: the crypto desk publishes one
 * always-open window, so an outage at any hour pages.
 */
function deskDeps(desk: AddedDesk): WatchdogDeps {
  const paths = DESK_PATHS[desk];
  return {
    readLatest: () => readText(paths.latest),
    readState: () => readForUpdate(paths.alertState),
    writeState: (body, opts) => writeText(paths.alertState, body, opts),
    listHistory: () => listPaths(paths.history),
    deleteHistory: (urls) => deleteUrls(urls),
    send: (notice) => sendNtfy({ ...notice, title: `${DESK_LABEL[desk]} desk: ${notice.title}` }),
    prune: true,
  };
}

export const cryptoDeps: WatchdogDeps = deskDeps("crypto");
export const hftDeps: WatchdogDeps = deskDeps("hft");

/** The added desks in the order the cron runs their ticks. A new desk is one more entry. */
export const DESK_DEPS: Record<AddedDesk, WatchdogDeps> = { crypto: cryptoDeps, hft: hftDeps };

/**
 * One tick for an added desk, or a skip while the desk is "new": it has never published and has no alert
 * state, so there is nothing to be late. Deploying the dashboard before the desk exists pages nobody.
 */
export async function runDeskWatchdog(
  desk: AddedDesk,
  now: Date = new Date(),
  deps: WatchdogDeps = DESK_DEPS[desk],
): Promise<Record<string, unknown>> {
  const [latest, state] = await Promise.all([
    deps.readLatest().catch(() => undefined),
    deps.readState().catch(() => undefined),
  ]);
  if (latest === null && state === null) return { ok: true, desk, skipped: "never published" };
  return { ...(await runWatchdog(now, deps)), desk };
}

/** The crypto desk's tick. */
export function runCryptoWatchdog(now: Date = new Date(), deps: WatchdogDeps = cryptoDeps): Promise<Record<string, unknown>> {
  return runDeskWatchdog("crypto", now, deps);
}

function parseSnapshot(text: string): Snapshot | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Snapshot) : null;
  } catch {
    return null;
  }
}

/**
 * One watchdog tick: evaluate, try to commit the new state (ifMatch), then page.
 *
 * Paging fails open. A state write that fails for any reason other than "another tick already committed
 * this very transition" still pages: a duplicate page is acceptable, a silent dead-man's switch is not.
 * (Before this, a rejected etag skipped every page, and the daily prune bookkeeping changed the state on
 * the first tick of each UTC day, so the watchdog never paged at all.)
 */
export async function runWatchdog(
  now: Date = new Date(),
  deps: WatchdogDeps = blobDeps,
): Promise<Record<string, unknown>> {
  const [latest, stored] = await Promise.all([
    deps.readLatest().catch((e: unknown) => {
      // An unreadable latest snapshot is judged like a missing one (evaluate pages in a window), instead of
      // failing the whole tick, which would page nobody.
      logEvent("watchdog.latest", { outcome: "read-failed", error: e instanceof Error ? e.name : "unknown" });
      return null;
    }),
    deps.readState().catch((e: unknown) => {
      logEvent("watchdog.state", { outcome: "read-failed", error: e instanceof Error ? e.name : "unknown" });
      return null; // page from the initial state: at worst a duplicate
    }),
  ]);
  const snapshot = latest ? parseSnapshot(latest.text) : null;
  const prev = parseState(stored?.text);
  const decision = evaluate(snapshot, prev, now);
  const summary: Record<string, unknown> = {
    ok: true,
    level: decision.next.level,
    age_min: decision.fresh?.ageMin === null || !decision.fresh ? null : Math.floor(decision.fresh.ageMin),
    in_window: decision.fresh?.inWindow ?? false,
    has_snapshot: snapshot !== null,
  };

  let etag: string | null = stored?.etag ?? null;
  let committed = sameState(prev, decision.next);
  if (!committed) {
    try {
      etag = (
        await deps.writeState(JSON.stringify(decision.next), stored ? { ifMatch: stored.etag } : { createOnly: true })
      ).etag;
      committed = true;
    } catch (e) {
      if (e instanceof PreconditionFailed) {
        // Another tick wrote first. If it committed this same transition it has paged: stay quiet.
        const now2 = await deps.readState().catch(() => null);
        if (now2 && sameState(parseState(now2.text), decision.next)) {
          logEvent("watchdog", { outcome: "skipped", reason: "concurrent run" });
          return { ...summary, skipped: "concurrent run" };
        }
      }
      logEvent("watchdog.state", { outcome: "write-failed", error: e instanceof Error ? e.name : "unknown" });
    }
  }

  let sent = 0;
  let failed = 0;
  for (const notice of decision.notices) {
    const r = await deps.send(notice);
    if (r === "failed") failed++;
    else if (r === "sent") sent++;
  }
  if (failed > 0 && committed && etag) {
    // Put the alert level back so the next tick retries the page (prune bookkeeping is kept).
    const rollback = { ...prev, last_prune_day: decision.next.last_prune_day };
    await deps.writeState(JSON.stringify(rollback), { ifMatch: etag }).catch(() => undefined);
  }

  let pruned = 0;
  if (decision.prune && deps.prune) {
    try {
      const doomed = historyToPrune(await deps.listHistory(), now);
      await deps.deleteHistory(doomed.map((b) => b.url));
      pruned = doomed.length;
    } catch (e) {
      logEvent("watchdog.prune", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    }
  }

  const result = { ...summary, notices: decision.notices.map((n) => n.kind), sent, failed, pruned, committed };
  logEvent("watchdog", result);
  return result;
}

/**
 * The watchdog drill: two real ticks of `runWatchdog` against a synthetic snapshot and in-memory state, so
 * evaluate(), fail-open paging and ntfy delivery are all exercised end to end without touching the stored alert
 * state, the latest snapshot or the history. Tick 1: 60 minutes stale inside a window around now (a "late" page,
 * priority 4). Tick 2: fresh (a "recovered" page, priority 2). Every page title starts with "DRILL:".
 */
export async function runDrill(
  now: Date = new Date(),
  send: (n: Notice) => Promise<"sent" | "skipped" | "failed"> = (n) => sendNtfy(n),
): Promise<Record<string, unknown>> {
  const hour = 3_600_000;
  const window = {
    session: "drill",
    start: new Date(now.getTime() - 2 * hour).toISOString(),
    end: new Date(now.getTime() + 2 * hour).toISOString(),
  };
  const snapshot = (asOf: Date): Snapshot =>
    ({ schema: "trading-lab/snapshot", schema_version: 2, run_id: "drill", as_of: asOf.toISOString(),
       expected_windows: [window] }) as Snapshot;
  let latest = snapshot(new Date(now.getTime() - 60 * 60_000));
  let state: StoredText | null = null;
  let seq = 0;
  const pages: { kind: string; priority: number; result: string }[] = [];
  const mem: WatchdogDeps = {
    readLatest: async () => ({ text: JSON.stringify(latest) }),
    readState: async () => state,
    writeState: async (body) => {
      state = { text: body, etag: String(++seq) };
      return { etag: state.etag };
    },
    listHistory: async () => [],
    deleteHistory: async () => undefined,
    send: async (notice) => {
      const result = await send({ ...notice, title: `DRILL: ${notice.title}` });
      pages.push({ kind: notice.kind, priority: notice.priority, result });
      return result;
    },
    prune: false,
  };
  const tick1 = await runWatchdog(now, mem);
  latest = snapshot(now);
  const tick2 = await runWatchdog(now, mem);
  const result = { ok: true, drill: true, tick1: tick1.notices, tick2: tick2.notices, pages };
  logEvent("watchdog.drill", result);
  return result;
}
