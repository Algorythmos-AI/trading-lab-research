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
} from "./blob";
import { logEvent } from "./log";
import { sendNtfy } from "./ntfy";
import type { Snapshot } from "./types";
import { evaluate, historyToPrune, parseState, sameState } from "./watchdog";

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
export async function runWatchdog(now: Date = new Date()): Promise<Record<string, unknown>> {
  const [latest, stored] = await Promise.all([
    readText(LATEST_PATH),
    readForUpdate(ALERT_STATE_PATH).catch((e: unknown) => {
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
        await writeText(
          ALERT_STATE_PATH,
          JSON.stringify(decision.next),
          stored ? { ifMatch: stored.etag } : { createOnly: true },
        )
      ).etag;
      committed = true;
    } catch (e) {
      if (e instanceof PreconditionFailed) {
        // Another tick wrote first. If it committed this same transition it has paged: stay quiet.
        const now2 = await readForUpdate(ALERT_STATE_PATH).catch(() => null);
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
    const r = await sendNtfy(notice);
    if (r === "failed") failed++;
    else if (r === "sent") sent++;
  }
  if (failed > 0 && committed && etag) {
    // Put the alert level back so the next tick retries the page (prune bookkeeping is kept).
    const rollback = { ...prev, last_prune_day: decision.next.last_prune_day };
    await writeText(ALERT_STATE_PATH, JSON.stringify(rollback), { ifMatch: etag }).catch(() => undefined);
  }

  let pruned = 0;
  if (decision.prune) {
    try {
      const doomed = historyToPrune(await listPaths(HISTORY_PREFIX), now);
      await deleteUrls(doomed.map((b) => b.url));
      pruned = doomed.length;
    } catch (e) {
      logEvent("watchdog.prune", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    }
  }

  const result = { ...summary, notices: decision.notices.map((n) => n.kind), sent, failed, pruned, committed };
  logEvent("watchdog", result);
  return result;
}
