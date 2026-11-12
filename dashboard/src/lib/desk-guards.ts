// The owner's switches for the board's bad-data guards (quote-guards.ts), the observe-mode log the server check
// writes for them, and its summary. Pure: no I/O; the store is read by desk-guards-run.ts and desk-run.ts.
//
// The switches live in the site's own store, read every evaluated run and by the page, like the server check's own
// switch (desk/eval.json, DEC-0044 section 4), so a guard is turned on, and off again, without a deploy. Every guard is
// off until the owner writes it on: a missing, unreadable or malformed document is all off.
import { isDataFeed } from "./feed-provenance";
import { GUARD_REASONS, type GuardReason } from "./quote-guards";

/** The one place the switches are stored: exactly `{ "v": 1, "on": [<guard reason>, ...] }`. */
export const DESK_GUARDS_PATH = "desk/guards.json";
/** The largest stored document the parser reads. */
const MAX_TEXT = 512;

/** How the switches were read: "ok", "missing" (no document), "malformed" (not exactly the document), "error" (the read failed). */
export const SWITCH_READS = ["ok", "missing", "malformed", "error"] as const;
export type SwitchRead = (typeof SWITCH_READS)[number];

export interface GuardSwitches {
  status: SwitchRead;
  /** The guards switched on, in GUARD_REASONS order; [] unless `status` is "ok". */
  on: GuardReason[];
}

export const ALL_OFF = (status: Exclude<SwitchRead, "ok">): GuardSwitches => ({ status, on: [] });

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isGuard = (v: unknown): v is GuardReason => typeof v === "string" && (GUARD_REASONS as readonly string[]).includes(v);

/** A list of guard reasons, each known and at most once, in GUARD_REASONS order; null for anything else. */
export function parseGuardList(v: unknown): GuardReason[] | null {
  if (!Array.isArray(v) || v.length > GUARD_REASONS.length) return null;
  if (!v.every(isGuard) || new Set(v).size !== v.length) return null;
  return GUARD_REASONS.filter((r) => v.includes(r));
}

/**
 * The stored switches, strictly: exactly `{ "v": 1, "on": [...] }` with known guard reasons, each once. Null or
 * undefined (no document) is "missing"; anything else that is not exactly it is "malformed". Both are all off. Never
 * throws.
 */
export function parseGuardSwitches(text: unknown): GuardSwitches {
  if (text === null || text === undefined) return ALL_OFF("missing");
  if (typeof text !== "string" || text.length > MAX_TEXT) return ALL_OFF("malformed");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return ALL_OFF("malformed");
  }
  if (!plain(v) || Object.keys(v).length !== 2 || !Object.hasOwn(v, "v") || !Object.hasOwn(v, "on") || v.v !== 1) return ALL_OFF("malformed");
  const on = parseGuardList(v.on);
  return on === null ? ALL_OFF("malformed") : { status: "ok", on };
}

/** The browser's check of /api/desk/guards: exactly `{ on, status }`, or null. */
export function parseGuardAnswer(v: unknown): GuardSwitches | null {
  if (!plain(v)) return null;
  const on = parseGuardList(v.on);
  if (on === null || typeof v.status !== "string" || !(SWITCH_READS as readonly string[]).includes(v.status)) return null;
  const status = v.status as SwitchRead;
  if (status !== "ok" && on.length > 0) return null;
  return { status, on };
}

// ---- the observe-mode log ----------------------------------------------------------------------------------------------
export const GUARD_LOG_V = 1;
export type PausedWhy = "stale" | "guard";

export interface GuardLogName {
  symbol: string;
  /** The guard reasons that would pause this name, whatever the switches say: its snapshot read this run, today's. */
  would: GuardReason[];
  /**
   * The last trade is more than 25% from the prior close, on its own (quote-guards' farFromPriorClose): the bad-print
   * guard also needs the print outside the day's range, so a real gap shows here and not in `would`.
   */
  far_from_prior_close: boolean;
  /** Whether the board's row for the name was paused this slot, and by what: no fresh price, or a switched-on guard. */
  paused: PausedWhy | null;
}

/**
 * What one run of the server check stores beside its record (desk-run.ts `guards`): enum words and symbols only. It
 * never changes the engine's record; it is computed from what the run already read, with no further call or read.
 */
export interface GuardLog {
  v: typeof GUARD_LOG_V;
  /** How the switches were read this run, and which were on. */
  switches: SwitchRead;
  on: GuardReason[];
  /** Each focus name with a snapshot this run, in the card's order. */
  names: GuardLogName[];
}

// ---- the summary --------------------------------------------------------------------------------------------------------
/** A data plan's limit below this reads as the plan lapsed or the wrong keys (the plan's L7). */
export const LOW_RATE_LIMIT = 1_000;

export interface GuardCounts {
  /** Names observed (a snapshot that run). */
  names: number;
  /** Per guard, the observations it would have paused; and those any guard would have. */
  would: Record<GuardReason, number>;
  would_any: number;
  /**
   * Per guard, the separate runs of consecutive observations it would have paused (a name's observations in slot
   * order, per feed): many runs for few slots is a guard that would flap between paused and live.
   */
  runs: Record<GuardReason, number>;
  /** Observations more than 25% from the prior close on their own, whether or not outside the day's range. */
  far_from_prior_close: number;
  /** Observations whose row was paused, by why. */
  paused: Record<PausedWhy, number>;
}

/** One feed's guard counts: never pooled with another feed's. */
export interface GuardFeedGroup {
  /** Records of this feed carrying a guard log. */
  records: number;
  /** How the switches read, per record. */
  switches: Record<SwitchRead | "invalid-record", number>;
  /** Per guard, the records it was switched on in. */
  on: Record<GuardReason, number>;
  total: GuardCounts;
  by_symbol: Record<string, GuardCounts>;
  /** HTTP 429 answers the runs counted (the bars and the snapshot), over every record of this feed. */
  http_429: number;
  /** Records whose snapshot answered with a rate limit below LOW_RATE_LIMIT, and the smallest limit seen. */
  rate_limit_low: number;
  rate_limit_min: number | null;
}

export interface GuardSummary {
  records: number;
  with_guards: number;
  without_guards: number;
  /** Per feed the record names (feed-provenance's iex or sip; "unknown" for a record without one, as when every read failed). */
  by_feed: Record<"iex" | "sip" | "unknown", GuardFeedGroup>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const zeroGuards = (): Record<GuardReason, number> => Object.fromEntries(GUARD_REASONS.map((g) => [g, 0])) as Record<GuardReason, number>;
const emptyCounts = (): GuardCounts => ({ names: 0, would: zeroGuards(), would_any: 0, runs: zeroGuards(), far_from_prior_close: 0, paused: { stale: 0, guard: 0 } });
const emptyGroup = (): GuardFeedGroup => ({
  records: 0,
  switches: { ok: 0, missing: 0, malformed: 0, error: 0, "invalid-record": 0 },
  on: zeroGuards(),
  total: emptyCounts(),
  by_symbol: {},
  http_429: 0,
  rate_limit_low: 0,
  rate_limit_min: null,
});

function addName(c: GuardCounts, would: readonly GuardReason[], started: readonly GuardReason[], far: unknown, paused: unknown): void {
  c.names++;
  for (const g of would) c.would[g]++;
  for (const g of started) c.runs[g]++;
  if (would.length > 0) c.would_any++;
  if (far === true) c.far_from_prior_close++;
  if (paused === "stale" || paused === "guard") c.paused[paused]++;
}

/**
 * Stored server records -> per feed, how often each guard would have paused a name (whatever its switch said), how
 * often a row was paused and why, how the switches read, and the runs' 429 answers and low rate limits. Pure and
 * lenient: anything unreadable is counted as without a guard log, or skipped; nothing throws.
 */
export function summariseGuards(records: readonly unknown[]): GuardSummary {
  const out: GuardSummary = { records: 0, with_guards: 0, without_guards: 0, by_feed: { iex: emptyGroup(), sip: emptyGroup(), unknown: emptyGroup() } };
  // In slot order, so a run of consecutive tripped observations is counted once; a record without a slot goes last.
  const slotOf = (r: unknown) => (isObj(r) && typeof r.slot_end === "string" ? r.slot_end : "~");
  const ordered = records.map((r, i) => [r, i] as const).sort((a, b) => (slotOf(a[0]) < slotOf(b[0]) ? -1 : slotOf(a[0]) > slotOf(b[0]) ? 1 : a[1] - b[1]));
  /** Per feed and name, the guards its previous observation would have paused. */
  const prev = new Map<string, readonly GuardReason[]>();
  for (const [r] of ordered) {
    out.records++;
    const feed = isObj(r) && isDataFeed(r.feed) ? r.feed : "unknown";
    const g = out.by_feed[feed];
    if (isObj(r)) {
      const n429 = r.http_429;
      if (typeof n429 === "number" && Number.isInteger(n429) && n429 > 0 && n429 <= 2) g.http_429 += n429;
      const limit = isObj(r.probe) ? r.probe.rate_limit : undefined;
      if (typeof limit === "number" && Number.isInteger(limit) && limit >= 0 && limit < LOW_RATE_LIMIT) {
        g.rate_limit_low++;
        g.rate_limit_min = g.rate_limit_min === null ? limit : Math.min(g.rate_limit_min, limit);
      }
    }
    const log = isObj(r) ? r.guards : undefined;
    if (!isObj(log) || log.v !== GUARD_LOG_V || !Array.isArray(log.names)) {
      out.without_guards++;
      continue;
    }
    out.with_guards++;
    g.records++;
    const sw = typeof log.switches === "string" && (SWITCH_READS as readonly string[]).includes(log.switches) ? (log.switches as SwitchRead) : "invalid-record";
    g.switches[sw]++;
    for (const on of parseGuardList(log.on) ?? []) g.on[on]++;
    for (const n of log.names) {
      if (!isObj(n) || typeof n.symbol !== "string" || !SYMBOL_RE.test(n.symbol)) continue;
      const would = parseGuardList(n.would);
      if (would === null) continue;
      const key = `${feed}|${n.symbol}`;
      const before = prev.get(key) ?? [];
      const started = would.filter((w) => !before.includes(w));
      prev.set(key, would);
      addName(g.total, would, started, n.far_from_prior_close, n.paused);
      addName((g.by_symbol[n.symbol] ??= emptyCounts()), would, started, n.far_from_prior_close, n.paused);
    }
  }
  return out;
}

/**
 * The Operations panel's line for a data plan limit below LOW_RATE_LIMIT, or null. Display only. Alpaca's free plan
 * allows 200 calls a minute, so on it this line is expected and not an error; on a paid plan it means the plan lapsed
 * or the wrong keys are set.
 */
export function rateLimitLine(limit: number | null | undefined): string | null {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit >= LOW_RATE_LIMIT) return null;
  return `The data plan's limit reads ${limit.toLocaleString("en-US")} a minute: expected on the free plan; on a paid plan, check the plan and the keys`;
}

/**
 * The Operations panel's line for the guards' switches as the server check's newest record read them (its `guards`),
 * or null when there is nothing to say (no record, or no guard log on it). Display only.
 */
export function guardSwitchLine(log: { switches: unknown; on: unknown } | null | undefined): string | null {
  if (!log || typeof log.switches !== "string") return null;
  if (log.switches === "malformed" || log.switches === "error") return "The guard switches could not be read: every guard is off";
  if (log.switches === "missing") return "Bad-data guards: every guard is off (no switches stored)";
  if (log.switches !== "ok") return null;
  const on = parseGuardList(log.on);
  if (on === null) return "The guard switches could not be read: every guard is off";
  return on.length ? `Bad-data guards switched on: ${on.join(", ")}` : "Bad-data guards: every guard is off";
}
