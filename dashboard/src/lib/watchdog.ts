// Pure watchdog state machine: given the latest snapshot, the previous alert state and `now`,
// decide what to page and what to persist. No I/O here; see watchdog-run.ts for the effects.
import { assumedWindow, freshness, LATE_MIN, OFFLINE_HOURS, STOPPED_MIN, type Freshness } from "./freshness";
import type { Notice } from "./ntfy";
import type { Snapshot } from "./types";

export type AlertLevel = "ok" | "late" | "stopped";

export interface AlertState {
  level: AlertLevel;
  /** Session id of the expected window in which `level` was raised. */
  window: string | null;
  since: string | null;
  last_offline_day: string | null;
  last_prune_day: string | null;
}

export const INITIAL_STATE: AlertState = {
  level: "ok",
  window: null,
  since: null,
  last_offline_day: null,
  last_prune_day: null,
};

export const HISTORY_KEEP_DAYS = 90;

const RANK: Record<AlertLevel, number> = { ok: 0, late: 1, stopped: 2 };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseState(text: string | null | undefined): AlertState {
  if (!text) return { ...INITIAL_STATE };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const level = raw.level === "late" || raw.level === "stopped" ? raw.level : "ok";
    return {
      level,
      window: str(raw.window),
      since: str(raw.since),
      last_offline_day: str(raw.last_offline_day),
      last_prune_day: str(raw.last_prune_day),
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export function sameState(a: AlertState, b: AlertState): boolean {
  return (
    a.level === b.level &&
    a.window === b.window &&
    a.since === b.since &&
    a.last_offline_day === b.last_offline_day &&
    a.last_prune_day === b.last_prune_day
  );
}

export interface WatchdogDecision {
  next: AlertState;
  notices: Notice[];
  /** True once per UTC day: prune the desk's history older than HISTORY_KEEP_DAYS. */
  prune: boolean;
  fresh: Freshness | null;
}

/** Said when the window is assumed: the host's own schedule ran out, which only happens after a long silence. */
const ASSUMED_NOTE = " The host's published schedule has run out, so a weekday window is assumed.";

function late(min: number, session: string, assumed = false): Notice {
  return {
    kind: "late",
    title: `Dashboard late: no update for ${min} min`,
    message: `No status snapshot for ${min} min during the ${session} trading window. Check that the trading host is up and the publisher job is loaded.${assumed ? ASSUMED_NOTE : ""}`,
    priority: 4,
    tags: ["warning"],
  };
}

function stopped(min: number, session: string, assumed = false): Notice {
  return {
    kind: "stopped",
    title: `Dashboard stopped: no update for ${min} min`,
    message: `No status snapshot for ${min} min (over ${STOPPED_MIN}) during the ${session} trading window. The nightly jobs may not be running.${assumed ? ASSUMED_NOTE : ""}`,
    priority: 4,
    tags: ["rotating_light"],
  };
}

function unreadable(session: string): Notice {
  return {
    kind: "stopped",
    title: "Dashboard has no readable snapshot",
    message: `The latest status snapshot is missing or has no readable time during the ${session} trading window, so nothing can say the host is alive. Check the publisher and the Blob store.`,
    priority: 4,
    tags: ["rotating_light"],
  };
}

function recovered(min: number): Notice {
  return {
    kind: "recovered",
    title: "Dashboard recovered",
    message: `A fresh status snapshot arrived (${min} min old). The earlier alert is cleared.`,
    priority: 2,
    tags: ["white_check_mark"],
  };
}

function offline(days: number): Notice {
  return {
    kind: "offline",
    title: `Trading host offline for ${days} days`,
    message: `No status snapshot for ${days} days. Outside trading windows this reminder repeats at most once a day; inside them the late and stopped pages apply.`,
    priority: 3,
    tags: ["zzz"],
  };
}

export function evaluate(snapshot: Snapshot | null, prev: AlertState, now: Date): WatchdogDecision {
  const day = now.toISOString().slice(0, 10);
  const next: AlertState = { ...prev };
  const prune = prev.last_prune_day !== day;
  if (prune) next.last_prune_day = day;
  const notices: Notice[] = [];

  const fresh = snapshot ? freshness(snapshot.as_of, snapshot.expected_windows, now.getTime()) : null;
  if (!snapshot || !fresh || fresh.ageMin === null) {
    // No snapshot, or no readable time in it: the dead-man's switch can't see the host, which is itself a page
    // on a weekday (review of R8). Once per window episode, like "stopped".
    const w = fresh?.window ?? assumedWindow(now.getTime());
    if (w) {
      const session = w.session || w.start || "current";
      const baseline: AlertLevel = prev.window === session ? prev.level : "ok";
      if (baseline !== "stopped") {
        notices.push(unreadable(session));
        if (baseline === "ok") next.since = now.toISOString();
      }
      next.level = "stopped";
      next.window = session;
    }
    return { next, notices, prune, fresh };
  }
  const minutes = Math.floor(fresh.ageMin);

  if (fresh.ageMin <= LATE_MIN) {
    // Fresh again. Recovery is announced only if an alert fired before.
    if (prev.level !== "ok") notices.push(recovered(minutes));
    next.level = "ok";
    next.window = null;
    next.since = null;
  } else if (fresh.inWindow && fresh.window) {
    const session = fresh.window.session || fresh.window.start || "current";
    const level: AlertLevel = fresh.ageMin > STOPPED_MIN ? "stopped" : "late";
    // A new trading window starts a new episode: page again even if the last one never recovered.
    const baseline: AlertLevel = prev.window === session ? prev.level : "ok";
    if (RANK[level] > RANK[baseline]) {
      notices.push(
        level === "stopped" ? stopped(minutes, session, fresh.assumed) : late(minutes, session, fresh.assumed),
      );
      next.level = level;
      if (baseline === "ok") next.since = now.toISOString();
    } else {
      next.level = baseline;
    }
    next.window = session;
  } else if (fresh.allWindowsEnded && fresh.ageMin > OFFLINE_HOURS * 60 && prev.last_offline_day !== day) {
    // Outside every window nothing pages; a long silence gets one note per UTC day.
    notices.push(offline(Math.floor(fresh.ageMin / (24 * 60))));
    next.last_offline_day = day;
  }
  return { next, notices, prune, fresh };
}

// Each desk keeps its own history: snapshots/history/ (stocks) and snapshots/<desk>/history/ (DESK_PATHS).
const HISTORY_RE = /^snapshots\/(?:[a-z0-9-]+\/)?history\/(\d{4}-\d{2}-\d{2})\//;

/** History objects whose UTC date folder is more than `keepDays` days before `now`. */
export function historyToPrune<T extends { pathname: string }>(
  blobs: readonly T[],
  now: Date,
  keepDays = HISTORY_KEEP_DAYS,
): T[] {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const cutoff = today - keepDays * 86_400_000;
  return blobs.filter((b) => {
    const m = HISTORY_RE.exec(b.pathname);
    if (!m?.[1]) return false;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    return Number.isFinite(t) && t < cutoff;
  });
}
