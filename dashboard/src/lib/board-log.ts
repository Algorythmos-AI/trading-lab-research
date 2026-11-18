// The "Today" log's rules, with no React and no DOM: what one line is, how a saved log is read back, how two copies of
// it (two tabs, or the page and its storage) merge, and what counts as unread.
//
//  * A line is a name's state word changing on the board ("board"), or a manage card's new word ("manage": SELL HALF,
//    EXIT). A line saved before kinds existed reads as "board".
//  * The same line is never kept twice: lines are keyed by when, what kind, which name (and trade), word and side.
//    Two tabs see one change a few seconds apart, each on its own poll: a line repeating the word just before it for
//    the same name (and trade) within SAME_CHANGE_MS is that change seen again, and only the first is kept.
//  * The newest first, at most BOARD_LOG_MAX lines.
//  * Read only: a log of what the board said, nothing else.
import type { Tone } from "./labels";

export type LogKind = "board" | "manage";

/** One line of the "Today" log, at the board's (server) clock. */
export interface BoardLogEntry {
  at: number;
  symbol: string;
  word: string;
  side: "call" | "put" | null;
  tone: Tone;
  kind: LogKind;
  /** A manage line's trade (the card's id): two cards on one name never merge. */
  ref?: string;
}

/** Within this long, the same word again for the same name (and trade) is one change seen twice. */
export const SAME_CHANGE_MS = 60_000;

/** The log keeps this many lines, the newest first: a whole busy session. */
export const BOARD_LOG_MAX = 200;

// The tones a line may carry (labels.ts Tone): a line with any other is dropped, never drawn in a guessed colour.
const LOG_TONES: ReadonlySet<string> = new Set<Tone>(["good", "warn", "bad", "neutral", "info"]);

/** One saved line, checked field by field: the storage is the browser's, and anything may be in it. */
function asLogEntry(x: unknown): BoardLogEntry | null {
  if (!x || typeof x !== "object") return null;
  const e = x as Record<string, unknown>;
  const ok =
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    typeof e.symbol === "string" &&
    typeof e.word === "string" &&
    (e.side === "call" || e.side === "put" || e.side === null) &&
    typeof e.tone === "string" &&
    LOG_TONES.has(e.tone) &&
    (e.kind === undefined || e.kind === "board" || e.kind === "manage") &&
    (e.ref === undefined || typeof e.ref === "string");
  if (!ok) return null;
  const line: BoardLogEntry = { at: e.at as number, symbol: e.symbol as string, word: e.word as string, side: e.side as BoardLogEntry["side"], tone: e.tone as Tone, kind: (e.kind as LogKind | undefined) ?? "board" };
  if (typeof e.ref === "string") line.ref = e.ref;
  return line;
}

/** The log saved in this browser for the session, if any; [] when storage is off or the text is not a log. */
export function parseBoardLog(raw: string | null): BoardLogEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return mergeLogs(v.map(asLogEntry).filter((e): e is BoardLogEntry => e !== null));
  } catch {
    return [];
  }
}

/** What makes two lines the same line. */
export const logKey = (e: BoardLogEntry): string => `${e.at}|${e.kind}|${e.symbol}|${e.ref ?? ""}|${e.word}|${e.side ?? ""}`;
/** Whose sequence of words a line belongs to: a name on the board, or one trade's card. */
const streamOf = (e: BoardLogEntry): string => `${e.kind}|${e.symbol}|${e.ref ?? ""}`;

/**
 * Several copies of a log made one: each line once, the newest first (ties in a fixed order, so two tabs merging the
 * same lines write the same text), at most BOARD_LOG_MAX.
 */
export function mergeLogs(...logs: readonly (readonly BoardLogEntry[])[]): BoardLogEntry[] {
  const seen = new Map<string, BoardLogEntry>();
  for (const log of logs) for (const e of log) if (!seen.has(logKey(e))) seen.set(logKey(e), e);
  const order = (a: BoardLogEntry, b: BoardLogEntry) => b.at - a.at || (logKey(a) < logKey(b) ? -1 : logKey(a) > logKey(b) ? 1 : 0);
  const all = [...seen.values()].sort(order);
  // Oldest first, per name (and trade): the same word and side again soon after is one change seen twice (two tabs).
  const last = new Map<string, BoardLogEntry>();
  const kept: BoardLogEntry[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    const prev = last.get(streamOf(e));
    if (prev && prev.word === e.word && prev.side === e.side && e.at - prev.at <= SAME_CHANGE_MS) continue;
    last.set(streamOf(e), e);
    kept.push(e);
  }
  return kept.reverse().slice(0, BOARD_LOG_MAX);
}

/** True when the two logs hold the same lines (in the same order). */
export const sameLog = (a: readonly BoardLogEntry[], b: readonly BoardLogEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => logKey(e) === logKey(b[i]!));

/** Lines not yet seen in the open log: by the line itself, so a late line with an older time still counts as new. */
export function unreadCount(log: readonly BoardLogEntry[], seen: ReadonlySet<string>): number {
  return log.filter((e) => !seen.has(logKey(e))).length;
}

/** The lines seen in the open log, as stored; none when there is nothing or it is not a list of keys. */
export function parseSeen(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** The seen set with these lines added, kept to the keys still in the log (so it never grows past it). */
export function withSeen(seen: ReadonlySet<string>, lines: readonly BoardLogEntry[], log: readonly BoardLogEntry[]): string[] {
  const now = new Set(log.map(logKey));
  return [...new Set([...seen, ...lines.map(logKey)])].filter((k) => now.has(k)).sort();
}

/** The keys this browser holds for the log of other sessions than `session`: older days, to be removed. */
export function staleLogKeys(keys: readonly string[], session: string): string[] {
  const mine = new Set([`trade-now-log:${session}`, `trade-now-log-seen:${session}`]);
  return keys.filter((k) => (k.startsWith("trade-now-log:") || k.startsWith("trade-now-log-seen:")) && !mine.has(k));
}

/** The lines grouped by the hour they fall in, newest hour first; `hourOf` names an instant's hour ("10:00"). */
export function byHour(log: readonly BoardLogEntry[], hourOf: (at: number) => string): { hour: string; lines: BoardLogEntry[] }[] {
  const out: { hour: string; lines: BoardLogEntry[] }[] = [];
  for (const e of log) {
    const h = hourOf(e.at);
    const last = out[out.length - 1];
    if (last && last.hour === h) last.lines.push(e);
    else out.push({ hour: h, lines: [e] });
  }
  return out;
}

/** The names in the log, in the order they first appear (the newest first). */
export const logNames = (log: readonly BoardLogEntry[]): string[] => [...new Set(log.map((e) => e.symbol))];
