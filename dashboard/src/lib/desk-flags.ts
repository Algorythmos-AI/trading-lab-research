// The owner's "done for today" flag: the desk's own state, set by the owner on either device and read by both. Pure: no
// I/O; the clock is always passed in. The server stores it at DESK_FLAGS_PATH (desk-flags-run.ts).
//
// The day is New York's calendar day, the one a session belongs to, so the flag clears itself when New York's next day
// begins: no job resets it. A Sydney clock never enters into it.
import { dayIn, NEW_YORK } from "./format";

/** The one place the flag is stored. Nothing from a request ever reaches a path. */
export const DESK_FLAGS_PATH = "desk/flags.json";

/**
 * Undo is allowed only within this long of the moment the day was marked done: it is there for a mis-tap. After it,
 * the day stays done until New York's next day; the owner's own rule (stop for the day) is not taken back.
 * Strictly less than: at 60 s exactly the window has closed.
 */
export const UNDO_MS = 60_000;

/** The largest stored document the parser reads; anything longer is not this document. */
const MAX_TEXT = 1_024;

export interface DoneMark {
  /** New York's day the mark is for, YYYY-MM-DD. */
  day: string;
  /** When it was set, an ISO instant (the server's clock). */
  at: string;
}

export interface DeskFlagsDoc {
  v: 1;
  done: DoneMark | null;
}

export const EMPTY_FLAGS: DeskFlagsDoc = { v: 1, done: null };

/** New York's calendar day at `now`, YYYY-MM-DD. */
export function nyDay(now: Date): string {
  return dayIn(now.toISOString(), NEW_YORK) ?? "";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

function parseMark(v: unknown): DoneMark | null | undefined {
  if (v === null) return null;
  if (!plain(v) || !onlyKeys(v, ["day", "at"])) return undefined;
  const { day, at } = v;
  if (typeof day !== "string" || typeof at !== "string" || !DAY_RE.test(day) || !ISO_RE.test(at)) return undefined;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return undefined;
  // The day must be the one the instant falls on in New York: a mark cannot claim another day than its own.
  if (nyDay(new Date(t)) !== day) return undefined;
  return { day, at };
}

/**
 * The stored document, or null for anything that is not exactly it: not JSON, not an object, another version, a field
 * of the wrong type, or any field it does not know. Never throws. The result is built from the known fields only, so
 * nothing unknown is ever carried on.
 */
export function parseDeskFlags(text: unknown): DeskFlagsDoc | null {
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plain(v) || !onlyKeys(v, ["v", "done"]) || v.v !== 1) return null;
  const done = parseMark(v.done);
  if (done === undefined) return null;
  return { v: 1, done };
}

/** True only when the mark is for New York's day at `now`. Yesterday's mark, or none, is not done. */
export function isDoneToday(doc: DeskFlagsDoc | null, now: Date): boolean {
  return !!doc?.done && doc.done.day === nyDay(now);
}

/** Milliseconds of the undo window left at `now`; 0 when the day is not done or the window has closed. */
export function undoLeftMs(doc: DeskFlagsDoc | null, now: Date): number {
  if (!doc?.done || !isDoneToday(doc, now)) return 0;
  const elapsed = Math.max(0, now.getTime() - Date.parse(doc.done.at));
  return elapsed < UNDO_MS ? UNDO_MS - elapsed : 0;
}

export type Transition = { ok: true; changed: boolean; doc: DeskFlagsDoc } | { ok: false; reason: "not-done" | "undo-closed" };

/** Mark today done. Already done today: unchanged (the first time stands, and so does its undo window). */
export function markDone(doc: DeskFlagsDoc | null, now: Date): Transition {
  if (doc && isDoneToday(doc, now)) return { ok: true, changed: false, doc };
  return { ok: true, changed: true, doc: { v: 1, done: { day: nyDay(now), at: now.toISOString() } } };
}

/** Take back today's mark, within UNDO_MS of setting it only (see UNDO_MS). */
export function undo(doc: DeskFlagsDoc | null, now: Date): Transition {
  if (!doc || !isDoneToday(doc, now)) return { ok: false, reason: "not-done" };
  if (undoLeftMs(doc, now) <= 0) return { ok: false, reason: "undo-closed" };
  return { ok: true, changed: true, doc: { v: 1, done: null } };
}

/** What the browser is told: enum values, a day, an instant and whole seconds only. */
export interface FlagsView {
  done: boolean;
  day: string | null;
  at: string | null;
  canUndo: boolean;
  /** Whole seconds of the undo window left (rounded up); 0 when there is none. */
  undoLeftS: number;
}

export function flagsView(doc: DeskFlagsDoc | null, now: Date): FlagsView {
  const done = isDoneToday(doc, now);
  const left = undoLeftMs(doc, now);
  return {
    done,
    day: done ? doc!.done!.day : null,
    at: done ? doc!.done!.at : null,
    canUndo: left > 0,
    undoLeftS: Math.ceil(left / 1000),
  };
}

/** The browser's check of an answer: exactly a FlagsView, or null. */
export function parseFlagsView(v: unknown): FlagsView | null {
  if (!plain(v)) return null;
  const { done, day, at, canUndo, undoLeftS } = v;
  if (typeof done !== "boolean" || typeof canUndo !== "boolean") return null;
  if (typeof undoLeftS !== "number" || !Number.isInteger(undoLeftS) || undoLeftS < 0 || undoLeftS > UNDO_MS / 1000) return null;
  if (done) {
    if (typeof day !== "string" || !DAY_RE.test(day) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
    return { done, day, at, canUndo, undoLeftS };
  }
  return { done: false, day: null, at: null, canUndo: false, undoLeftS: 0 };
}
