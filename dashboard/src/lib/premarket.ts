import { nyNow } from "./market-calendar";
import type { OptionsEdition } from "./options.types";

// The Options edition's pre-market check, kept apart from the edition, and the 09:25 focus freeze.
//
// The focus routine posts the whole edition twice for a session: after the close (the pick, with no pre-market
// check) and before the open (the same edition with `focus.premarket` added). One latest.json holds whichever came
// last, so a re-run of the evening pick after the pre-open pass wiped the check, and a late pass replaced the edition
// while the session was trading. Two rules close that:
//   - every pre-market check that reaches /api/ingest is also kept in options/premarket/<session>.json, the latest
//     check (by its own as_of) winning, and the pages put it back on an edition of the same session that lacks it
//     or holds an older one (snapshot.ts loadOptions);
//   - from 09:25 New York on its session, an edition may replace the session's edition only when nothing but its
//     run, its time and its pre-market check differ (ingest.ts): the names and levels the desk opens with stay.
// The feed watch's cron reads the edition the same way (feed-watch-run.ts), so it and the pages agree on the pre-open
// row. Display and monitoring only: the server's own reads (desk-run.ts, signal-run.ts) take latest.json as it is, and
// no file here is in the signal's or the engine's hashed code.
//
// DEC-0046 section 5 plans a second pre-open pass (Pass B, due by 09:25, looked for until 09:27). It is not built. When
// it is, it must publish beside the edition (as this check is), never as a replacement of it, or this freeze refuses a
// late Pass B: the boundary and that rule are the owner's to confirm.

export const PREMARKET_PREFIX = "options/premarket/";

/** 09:25 New York: after it, a session's names and levels no longer change (the owner's decision, 2026-11-16). */
export const FOCUS_FREEZE_MIN = 9 * 60 + 25;

type Focus = NonNullable<OptionsEdition["focus"]>;
type Premarket = NonNullable<Focus["premarket"]>;
export type PremarketItem = Premarket["items"][number];

/** The stored check: the session it is for and the check exactly as the edition carried it. */
export interface StoredPremarket {
  session: string;
  as_of: string;
  items: PremarketItem[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WHERE = ["above_resistance", "near_resistance", "between", "near_support", "below_support"] as const;
const MAX_ITEMS = 24;
/** How long the side file's read or write may take before the caller goes on without it. */
export const PREMARKET_IO_MS = 2_000;

export function premarketPath(session: string): string {
  return `${PREMARKET_PREFIX}${session}.json`;
}

const instant = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};

/** The edition's pre-market check with its session, or null when it carries none (or no usable session or time). */
export function premarketOf(e: OptionsEdition): StoredPremarket | null {
  const p = e.focus?.premarket;
  if (!p || typeof e.session !== "string" || !DAY_RE.test(e.session) || !Number.isFinite(instant(p.as_of))) return null;
  return { session: e.session, as_of: p.as_of, items: p.items };
}

const optNum = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));
const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";

export function isItem(v: unknown): v is PremarketItem {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const known = new Set(["symbol", "price", "gap_pct", "where", "note"]);
  if (Object.keys(o).some((k) => !known.has(k))) return false;
  return (
    typeof o.symbol === "string" &&
    o.symbol.length > 0 &&
    optNum(o.price) &&
    optNum(o.gap_pct) &&
    (o.where === undefined || o.where === null || (WHERE as readonly unknown[]).includes(o.where)) &&
    optStr(o.note)
  );
}

/** The stored check in `text`, or null when it is not one: bad JSON, a missing or extra field, a bad item. */
export function parseStoredPremarket(text: string): StoredPremarket | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 3) return null;
  if (typeof o.session !== "string" || !DAY_RE.test(o.session)) return null;
  if (typeof o.as_of !== "string" || !Number.isFinite(instant(o.as_of))) return null;
  if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS || !o.items.every(isItem)) return null;
  return { session: o.session, as_of: o.as_of, items: o.items };
}

/** The text stored for a check: fixed key order. */
export function storedPremarketText(p: StoredPremarket): string {
  return JSON.stringify({ session: p.session, as_of: p.as_of, items: p.items });
}

/** Whether `next` should replace `stored`: none stored, or a strictly later check. */
export function premarketIsNewer(next: StoredPremarket, stored: StoredPremarket | null): boolean {
  return stored === null || instant(next.as_of) > instant(stored.as_of);
}

/**
 * The edition with the stored check put back, when the stored check is for the same session, names only the
 * edition's focus names, and is later than the check the edition carries (or the edition carries none). Otherwise
 * the edition itself, unchanged.
 */
export function withPremarket(e: OptionsEdition, stored: StoredPremarket | null): OptionsEdition {
  const focus = e.focus;
  if (!stored || !focus || stored.session !== e.session || !Array.isArray(focus.items)) return e;
  const names = new Set(focus.items.map((i) => i?.symbol));
  if (!stored.items.every((i) => names.has(i.symbol))) return e;
  const own = focus.premarket;
  if (own && Number.isFinite(instant(own.as_of)) && instant(own.as_of) >= instant(stored.as_of)) return e;
  return { ...e, focus: { ...focus, premarket: { as_of: stored.as_of, items: stored.items } } };
}

/** `p`, or a rejection once `ms` have passed. */
export function within<T>(p: Promise<T>, ms: number = PREMARKET_IO_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("premarket store timed out"), { name: "Timeout" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The edition with its session's kept check put back (withPremarket), reading the side file with `read`. Never throws:
 * a missing, unreadable or slow side file leaves the edition as it is, and `onError` hears of a failed read.
 */
export async function withStoredPremarket(
  e: OptionsEdition,
  read: (path: string) => Promise<{ text: string } | null>,
  onError: (err: unknown) => void = () => undefined,
): Promise<OptionsEdition> {
  if (!e.focus || typeof e.session !== "string" || !DAY_RE.test(e.session)) return e;
  try {
    const stored = await within(read(premarketPath(e.session)));
    return stored ? withPremarket(e, parseStoredPremarket(stored.text)) : e;
  } catch (err) {
    onError(err);
    return e;
  }
}

/** Whether `session`'s names and levels are frozen at `now`: from 09:25 New York on the session, and every day after. */
export function focusFrozen(session: string, now: Date): boolean {
  const { day, minute } = nyNow(now);
  return day > session || (day === session && minute >= FOCUS_FREEZE_MIN);
}

/** A check made after the freeze: shown, but said to be late. */
export function premarketLate(p: { as_of: string }, session: string): boolean {
  const t = instant(p.as_of);
  return Number.isFinite(t) && focusFrozen(session, new Date(t));
}

const IGNORED_TOP = new Set(["run_id", "as_of"]);

function strip(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (IGNORED_TOP.has(k)) continue;
    if (k === "focus" && x !== null && typeof x === "object" && !Array.isArray(x)) {
      out[k] = Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([key]) => key !== "premarket"));
    } else out[k] = x;
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * Whether two editions are the same apart from their run, their time and their pre-market check: the only change a
 * late pre-open pass may make once the session's focus is frozen. Key order does not matter.
 */
export function sameApartFromPremarket(a: unknown, b: unknown): boolean {
  return deepEqual(strip(a), strip(b));
}
