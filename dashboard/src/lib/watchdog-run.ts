import "server-only";
import {
  ALERT_STATE_PATH,
  HISTORY_PREFIX,
  LATEST_PATH,
  PreconditionFailed,
  deleteUrls,
  listPaths,
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

/** One watchdog tick: evaluate, commit the new state (ifMatch), then page, then prune once a day. */
export async function runWatchdog(now: Date = new Date()): Promise<Record<string, unknown>> {
  const [latest, stored] = await Promise.all([readText(LATEST_PATH), readText(ALERT_STATE_PATH)]);
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

  // Commit before paging: if Vercel fires the cron twice, the loser of the etag race sends nothing.
  let etag: string | null = stored?.etag ?? null;
  if (!sameState(prev, decision.next)) {
    try {
      etag = (
        await writeText(ALERT_STATE_PATH, JSON.stringify(decision.next), {
          ifMatch: stored?.etag ?? null,
          createOnly: !stored,
        })
      ).etag;
    } catch (e) {
      if (e instanceof PreconditionFailed || !stored) {
        logEvent("watchdog", { outcome: "skipped", reason: "concurrent run" });
        return { ...summary, skipped: "concurrent run" };
      }
      throw e;
    }
  }

  let sent = 0;
  let failed = 0;
  for (const notice of decision.notices) {
    const r = await sendNtfy(notice);
    if (r === "failed") failed++;
    else if (r === "sent") sent++;
  }
  if (failed > 0 && etag) {
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

  const result = { ...summary, notices: decision.notices.map((n) => n.kind), sent, failed, pruned };
  logEvent("watchdog", result);
  return result;
}
