// The shadow period's numbers (DEC-0044, section 2), for the owner before any alert may be switched on: the share of
// slots the server logged, how often its states match the open page's, and the delay from a bar's end to its
// evaluation. Pure: the records come in, the numbers go out; nothing here reads the store or draws anything.
import { expectedSlots, type PageRecord, type ServerRecord, type StateRow } from "./desk-eval";
import { parseGuardList } from "./desk-guards";
import type { NameStateName } from "./trade-state";

export type CriticalBucket = "get_ready" | "plan_off" | "missed" | "paused" | "other";
export interface Critical {
  /** Rows where the server said enter zone and the page did not. */
  total: number;
  /** By what the page said instead ("other": any other word, or no row for that name and side). */
  byPage: Record<CriticalBucket, number>;
}

export interface ShadowSummary {
  /** Slots the sessions could log (desk-eval's expectedSlots). */
  expected: number;
  /** Slots with any server record, and by status. */
  logged: number;
  byStatus: Record<ServerRecord["status"], number>;
  /** Slots with an OK server record, and their share of the expected ones, in %. */
  ok: number;
  okPct: number;
  /** Of the OK slots: how many have a visible page record of the same engine (compared), and why the rest have not. */
  compared: number;
  coveragePct: number;
  noPage: number;
  hiddenOnly: number;
  engineMismatch: number;
  /**
   * Of the OK slots with a visible page record of the same engine: those whose bad-data guards switched on differ
   * between the page and the server (one read the switches before the owner changed them, the other after), or that
   * the page took while it could not confirm its switches (`guards_unsure`: its last read failed). Not
   * compared: a guard can pause one and not the other for a reason that is not the data.
   */
  guardsMismatch: number;
  /** Of the compared slots, those where every row matches and neither side has a row the other lacks. */
  agreed: number;
  agreedPct: number;
  rowsCompared: number;
  rowsAgreed: number;
  /** A row on one side with no row for the same name and side on the other. */
  rowsUnmatched: number;
  /** Disagreeing rows by kind, "server>page": "enter_zone>get_ready" (the page as of the slot). */
  disagreements: Record<string, number>;
  /** Server enter zone where the page as of the slot (the fidelity number) did not say it. */
  critical: Critical;
  /** The same against the page's states when it sent them, about a minute later: what the owner was looking at. */
  criticalAtSettle: Critical;
  /** evaluated_at − slot_end over the server's records, ms; null with none. */
  delayMedianMs: number | null;
  delayWorstMs: number | null;
}

const key = (r: Pick<StateRow, "symbol" | "side">) => `${r.symbol}|${r.side}`;
/** The guards switched on as one comparable word: none (or unreadable) is "". */
const guardsKey = (v: unknown) => (parseGuardList(v) ?? []).join(",");
/** The guards a server record ran with: its observe-mode log's `on` (desk-run.ts); none on a record without one. */
const guardsOnServer = (r: ServerRecord): unknown => {
  const g = (r as { guards?: unknown }).guards;
  return g !== null && typeof g === "object" ? (g as { on?: unknown }).on : undefined;
};
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const BUCKETS: readonly CriticalBucket[] = ["get_ready", "plan_off", "missed", "paused"];
const noCritical = (): Critical => ({ total: 0, byPage: { get_ready: 0, plan_off: 0, missed: 0, paused: 0, other: 0 } });

/** The median of a non-empty list (the mean of the middle two for an even count). */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function countCritical(c: Critical, server: ReadonlyMap<string, NameStateName>, page: readonly StateRow[]): void {
  const p = new Map(page.map((r) => [key(r), r.state]));
  for (const [k, st] of server) {
    if (st !== "enter_zone") continue;
    const ps = p.get(k);
    if (ps === "enter_zone") continue;
    c.total++;
    c.byPage[ps !== undefined && (BUCKETS as readonly string[]).includes(ps) ? (ps as CriticalBucket) : "other"]++;
  }
}

/**
 * The numbers for a set of New York days from their server and page records. Only records for those days' loggable
 * slots count, one per slot (the first given wins, as the store's create-only write does); a visible page's record
 * is preferred over a hidden one's for the same slot. Nothing is left out quietly: every OK slot is compared, or
 * counted as having no page record, only a hidden one, or one from another engine.
 */
export function shadowSummary(days: readonly string[], server: readonly ServerRecord[], page: readonly PageRecord[]): ShadowSummary {
  const slots = new Set(days.flatMap((d) => expectedSlots(d)));
  const first = <T extends { slot_end: string }>(list: readonly T[]) => {
    const m = new Map<number, T>();
    for (const r of list) {
      const t = Date.parse(r.slot_end);
      if (slots.has(t) && !m.has(t)) m.set(t, r);
    }
    return m;
  };
  const srv = first(server);
  const visible = first(page.filter((r) => !r.hidden));
  const hiddenPg = first(page.filter((r) => r.hidden));
  const byStatus: ShadowSummary["byStatus"] = { ok: 0, "wrong-day": 0, "no-focus": 0, degraded: 0 };
  const delays: number[] = [];
  for (const [t, r] of srv) {
    byStatus[r.status]++;
    const d = Date.parse(r.evaluated_at) - t;
    if (Number.isFinite(d)) delays.push(d);
  }

  let compared = 0;
  let noPage = 0;
  let hiddenOnly = 0;
  let engineMismatch = 0;
  let guardsMismatch = 0;
  let agreed = 0;
  let rowsCompared = 0;
  let rowsAgreed = 0;
  let rowsUnmatched = 0;
  const critical = noCritical();
  const criticalAtSettle = noCritical();
  const disagreements: Record<string, number> = {};
  for (const [t, s] of srv) {
    if (s.status !== "ok") continue;
    const p = visible.get(t);
    if (!p) {
      if (hiddenPg.has(t)) hiddenOnly++;
      else noPage++;
      continue;
    }
    if (p.engine !== s.engine) {
      engineMismatch++;
      continue;
    }
    if (p.guards_unsure === true || guardsKey(guardsOnServer(s)) !== guardsKey(p.guards)) {
      guardsMismatch++;
      continue;
    }
    compared++;
    const sRows = new Map(s.rows.map((r) => [key(r), r.state]));
    // The names the server carries no state for are not the page's to disagree with.
    const skip = new Set(s.degraded_names.map((d) => d.symbol));
    const pRows = new Map(p.rows.filter((r) => !skip.has(r.symbol)).map((r) => [key(r), r.state]));
    let same = true;
    for (const [k, ss] of sRows) {
      const ps = pRows.get(k);
      if (ps === undefined) {
        rowsUnmatched++;
        same = false;
        continue;
      }
      rowsCompared++;
      if (ss === ps) rowsAgreed++;
      else {
        same = false;
        const kind = `${ss}>${ps}`;
        disagreements[kind] = (disagreements[kind] ?? 0) + 1;
      }
    }
    for (const k of pRows.keys())
      if (!sRows.has(k)) {
        rowsUnmatched++;
        same = false;
      }
    if (same) agreed++;
    countCritical(critical, sRows, p.rows);
    countCritical(criticalAtSettle, sRows, p.rows_at_settle);
  }
  return {
    expected: slots.size,
    logged: srv.size,
    byStatus,
    ok: byStatus.ok,
    okPct: pct(byStatus.ok, slots.size),
    compared,
    coveragePct: pct(compared, byStatus.ok),
    noPage,
    hiddenOnly,
    engineMismatch,
    guardsMismatch,
    agreed,
    agreedPct: pct(agreed, compared),
    rowsCompared,
    rowsAgreed,
    rowsUnmatched,
    disagreements,
    critical,
    criticalAtSettle,
    delayMedianMs: median(delays),
    delayWorstMs: delays.length ? Math.max(...delays) : null,
  };
}
