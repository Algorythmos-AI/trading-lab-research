// The board-feed stamp's pure parts (EXP-0033, DEC-0050): the stamp's and the manifest's shapes, their keys, reading
// them back, the frozen rules that say whether the production board read SIP, and answered, at an instant and over a
// session, and the chain check. No I/O and no clock: the writer and the reader are board-feed-stamp.ts (server only).
import { createHash } from "node:crypto";

/** What a stamp says the board's stock feed was: ALPACA_FEED read as iex or sip, or refused (not one of them). */
export type StampFeed = "iex" | "sip" | "refused";
export const STAMP_FEEDS: readonly StampFeed[] = ["iex", "sip", "refused"];

/**
 * How one read of SPY's latest trade on that feed went in the same minute: "ok", a trade within 60 s of the stamp's
 * `at`; "stale", a trade older (or newer) than that; "plan", refused by the data plan; "error", anything else.
 */
export type StampAnswer = "ok" | "stale" | "plan" | "error";
export const STAMP_ANSWERS: readonly StampAnswer[] = ["ok", "stale", "plan", "error"];

/** One minute's stamp as stored at desk/feeds/board/<YYYY-MM-DD NY>/<HHMM NY>.json. */
export interface BoardFeedStamp {
  v: 1;
  feed: StampFeed;
  answered: StampAnswer;
  /** The server's time when it was written (ISO). */
  at: string;
  deployment: string | null;
  /** The deployment's commit, its first 12 characters. */
  commit: string | null;
  /** SHA-256 (hex) of the exact stored body of the day's previous stamp; null for the day's first. */
  prev: string | null;
}

/** The day's seal, written once by the first run from 2 minutes after the close (or a later run before the next open):
 *  how many stamps, and the last one's hash. */
export interface BoardFeedManifest {
  v: 1;
  count: number;
  /** SHA-256 (hex) of the last stamp's exact stored body; null when the day has none. */
  last: string | null;
  at: string;
}

/** The day's manifest key. */
export const manifestKey = (day: string) => `${BOARD_FEED_PREFIX}${day}/manifest.json`;

/** SHA-256 hex of a stored body's exact text. */
export const bodyHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const isHash = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export const BOARD_FEED_PREFIX = "desk/feeds/board/";

/** "0931" for 09:31: New York minutes after midnight as four digits. */
export function hhmmOf(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}`;
}

/** Minutes after midnight from "HHMM"; null when it is not a time of day. */
export function minuteOf(hhmm: string): number | null {
  if (!/^\d{4}$/.test(hhmm)) return null;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(2));
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** The stamp's key: one object per New York minute of a session day. */
export function stampKey(day: string, minute: number): string {
  return `${BOARD_FEED_PREFIX}${day}/${hhmmOf(minute)}.json`;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nullOrString = (v: unknown) => v === null || typeof v === "string";

/** A stored stamp's text read back; null when it is not a v1 stamp (the reader counts it as malformed). */
export function parseStamp(text: string): BoardFeedStamp | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== 1 || !STAMP_FEEDS.includes(v.feed as StampFeed) || !STAMP_ANSWERS.includes(v.answered as StampAnswer)) return null;
  if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
  if (!nullOrString(v.deployment) || !nullOrString(v.commit) || !(v.prev === null || isHash(v.prev))) return null;
  return {
    v: 1,
    feed: v.feed as StampFeed,
    answered: v.answered as StampAnswer,
    at: v.at,
    deployment: v.deployment as string | null,
    commit: v.commit as string | null,
    prev: v.prev as string | null,
  };
}

/** A stored manifest's text read back; null when it is not a v1 manifest. */
export function parseManifest(text: string): BoardFeedManifest | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== 1 || !Number.isInteger(v.count) || (v.count as number) < 0) return null;
  if (!(v.last === null || isHash(v.last)) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
  return { v: 1, count: v.count as number, last: v.last as string | null, at: v.at };
}

/** A stamp as the judges read it: its key's minute as an instant (epoch ms), its feed, its answer, its build, and the
 *  server time written in it (ISO). Every rule places a stamp by `at`, never by its key's minute. */
export interface JudgeStamp {
  minute: number;
  feed: string;
  answered: string;
  deployment: string | null;
  at: string;
}

const MIN = 60_000;
/** Two stamps more than this far apart (by `at`), with different builds, hide a change. 10:00 apart does not; 10:01 does. */
export const MAX_GAP_MS = 10 * MIN;
/** How far back from t0 a stamp's `at` still speaks for it: [t0 − 2 min, t0]. */
export const EDGE_MS = 2 * MIN;
/** A run of not-ok answers whose `at` span (first to last stamp) is at least this takes the board off: 10:00 is, 9:59 is not. */
export const BOARD_OFF_SPAN_MS = 10 * MIN;

/** Two deployments are the same only when both are named and equal: null never matches anything, itself included. */
const sameDeployment = (a: string | null, b: string | null) => a !== null && b !== null && a === b;

type Placed = JudgeStamp & { t: number };
/** The stamps with a readable `at`, in `at` order. A stamp whose `at` cannot be read is not placed anywhere. */
const placed = (stamps: readonly JudgeStamp[]): Placed[] =>
  stamps
    .map((x) => ({ ...x, t: Date.parse(x.at) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

const NY_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const sameNyDay = (a: number, b: number) => NY_DAY.format(a) === NY_DAY.format(b);

// The rules below are frozen (EXP-0033). They read only the stamps they are given, each placed at its `at`; a minute
// with no stamp is never filled in, whether as sip or not, ok or not.

/**
 * What a set of stamps says about the sessions it spans:
 *  * not_sip: some stamp's feed is not "sip" (iex or refused).
 *  * hidden_change: two consecutive stamps (by `at`) of the same New York day are more than 10 minutes apart and name
 *    different deployments (null counts as differing), so the build could have changed in time nobody saw.
 */
export function sessionEnds(stamps: readonly JudgeStamp[]): { not_sip: boolean; hidden_change: boolean } {
  const s = placed(stamps);
  let hidden = false;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    if (!sameNyDay(a.t, b.t)) continue;
    if (b.t - a.t > MAX_GAP_MS && !sameDeployment(a.deployment, b.deployment)) hidden = true;
  }
  return { not_sip: stamps.some((x) => x.feed !== "sip"), hidden_change: hidden };
}

/**
 * Whether the stamps vouch that the board read SIP at t0 (epoch ms). True when either
 *  1. some "sip" stamp's `at` lies in [t0 − 2 min, t0]; or
 *  2. t0 lies between the `at` of two consecutive stamps of the same New York day (the last at or before t0 and the
 *     first after it) that both read "sip", however far apart and whatever their deployments (sessionEnds'
 *     hidden_change is what speaks to a build change in a long gap).
 * After the day's last stamp, only rule 1 can cover t0; before its first, nothing does.
 */
export function covered(stamps: readonly JudgeStamp[], t0: number): boolean {
  const s = placed(stamps);
  if (s.some((x) => x.feed === "sip" && x.t <= t0 && x.t >= t0 - EDGE_MS)) return true;
  const next = s.findIndex((x) => x.t > t0);
  if (next <= 0) return false;
  const before = s[next - 1]!;
  const after = s[next]!;
  return before.feed === "sip" && after.feed === "sip" && sameNyDay(before.t, after.t);
}

/**
 * Whether the board was off at t0 (epoch ms), from the stamps whose `at` is at or before t0 only: some run of
 * consecutive stamps that all answered other than "ok" ("stale", "plan" and "error" alike), within one New York day,
 * whose last `at` minus its first is at least 10 minutes, has its last `at` in [t0 − 2 min, t0]. A stamp answered
 * "ok" ends a run, and so does a New York day change; time between stamps is not filled in.
 */
export function boardOff(stamps: readonly JudgeStamp[], t0: number): boolean {
  const s = placed(stamps).filter((x) => x.t <= t0);
  let i = 0;
  while (i < s.length) {
    if (s[i]!.answered === "ok") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < s.length && s[j + 1]!.answered !== "ok" && sameNyDay(s[j]!.t, s[j + 1]!.t)) j++;
    if (s[j]!.t - s[i]!.t >= BOARD_OFF_SPAN_MS && s[j]!.t >= t0 - EDGE_MS) return true;
    i = j + 1;
  }
  return false;
}

export type ChainReason = "ok" | "late_manifest" | "prev_mismatch" | "misplaced" | "count_mismatch" | "no_manifest";

/** A stored stamp's exact text with its key's minute as an instant (epoch ms). */
export interface ChainBody {
  minute: number;
  text: string;
}

/**
 * Whether a day's stored stamps are the ones written. `bodies`: the exact stored text at every stamp key of the day,
 * sorted by key minute; `nextOpen`: the next session's open (epoch ms) after that day. The first failing check names
 * the reason:
 *   "no_manifest"     there is no manifest;
 *   "late_manifest"   the manifest's `at` is not before nextOpen;
 *   "prev_mismatch"   a body is not a stamp, the first stamp's prev is not null, a stamp's prev is not the previous
 *                     body's hash, or the manifest's `last` is not the last body's hash (null for none);
 *   "misplaced"       a stamp's `at`, floored to the minute, is not its key's minute, or the `at`s do not strictly
 *                     increase;
 *   "count_mismatch"  the manifest's count is not the number of bodies.
 * Bodies are checked in order, prev before place, so a deleted or edited stamp is a prev_mismatch.
 */
export function verifyChain(bodies: readonly ChainBody[], manifest: BoardFeedManifest | null, nextOpen: number): { ok: boolean; reason: ChainReason } {
  const bad = (reason: ChainReason) => ({ ok: false, reason });
  if (!manifest) return bad("no_manifest");
  if (!(Date.parse(manifest.at) < nextOpen)) return bad("late_manifest");
  let prevHash: string | null = null;
  let prevAt = -Infinity;
  for (const b of bodies) {
    const st = parseStamp(b.text);
    if (!st || st.prev !== prevHash) return bad("prev_mismatch");
    const t = Date.parse(st.at);
    if (Math.floor(t / MIN) * MIN !== b.minute || !(t > prevAt)) return bad("misplaced");
    prevHash = bodyHash(b.text);
    prevAt = t;
  }
  if (manifest.last !== prevHash) return bad("prev_mismatch");
  if (manifest.count !== bodies.length) return bad("count_mismatch");
  return { ok: true, reason: "ok" };
}
