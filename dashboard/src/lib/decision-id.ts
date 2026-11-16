// The decision id: one stable name for one side of one focus name at one settled 2-minute slot of the Options desk's
// signal log (DEC-0051), `dec-<yyyymmdd>-<hhmm>-<SYMBOL>-<C|P>`.
//
// The id is DERIVED, never stored. The DEC-0051 record (signal-record.ts, version 1) holds no id and gains none: its
// format is frozen for the forward-test window, so the id is worked out at read time from what every record already
// holds (`session`, `slot_end`, and each `names[].symbol` with its `sides[].side`). It is the join key the Lab, the
// ledger scorer and the Webull match will use later; nothing here reads or writes any of them.
//
// The date and the hhmm are exactly the ones the record's own path names (signal-record.ts signalLogPath:
// desk/signal/<New York date>/<HHMM New York of the slot's end>.json), so an id points at the one file it came from.
// Inside a regular session New York's clock never repeats or skips a minute (DST changes at 02:00 on a Sunday), so the
// hhmm names exactly one instant and the id reads back to the same slot end on either side of a DST change.
//
// The id does not encode the record's mode. A `dry` record implies ids too, but they name a slot, a name and a side
// with no word (no CALL, PUT, WAIT or NO TRADE): only the gate inputs. A consumer that scores signals or matches trades
// must keep only ids read off records with `mode === "log"`; the id alone cannot tell them apart.
//
// Pure: no I/O and no clock. Not imported by the signal's or the DEC-0044 engine's code, so it moves neither hash; and
// it imports none of the signal's modules (not even signal-record.ts's types: signal.test.ts keeps that list closed),
// so the record's shape it reads is stated here structurally, and a parsed SignalRecord fits it as it is.
import { expectedSlots, nyHhmm, type RowSide, SIDES, SYMBOL_RE } from "./desk-eval";

/** Why an input makes no id. */
export type DecisionIdWhy =
  /** The session is not a YYYY-MM-DD calendar date (2026-02-30 is not one). */
  | "bad-session"
  /** The session is a valid date, but the market has no regular session that day (weekend, holiday, out of range). */
  | "closed-day"
  /** The slot end is not a canonical ISO instant or a finite whole number of ms. */
  | "bad-slot-end"
  /** The slot end is not one of the session's slot ends (desk-eval.ts expectedSlots: 2-minute bars from 09:30). */
  | "off-slot"
  | "bad-symbol"
  | "bad-side"
  /** A string that is not of the id's form, or whose date is not a calendar date. */
  | "bad-id";

export class DecisionIdError extends Error {
  readonly why: DecisionIdWhy;
  constructor(why: DecisionIdWhy, detail: string) {
    super(`decision id: ${why}: ${detail}`);
    this.name = "DecisionIdError";
    this.why = why;
  }
}

export interface DecisionKey {
  /** The New York session date, YYYY-MM-DD (the record's `session`). */
  session: string;
  /** The slot's end: the record's `slot_end` (canonical ISO) or the same instant in ms. */
  slotEnd: string | number;
  symbol: string;
  side: RowSide;
}

/** A parsed id: the slot end always as the canonical ISO instant the record's `slot_end` holds. */
export interface ParsedDecisionId {
  session: string;
  slotEnd: string;
  symbol: string;
  side: RowSide;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** desk-eval.ts SYMBOL_RE without its anchors, so the id takes exactly the symbols a record may hold. */
const SYMBOL_BODY = ((src: string): string => {
  if (!src.startsWith("^") || !src.endsWith("$") || SYMBOL_RE.flags !== "") throw new Error("decision id: SYMBOL_RE is no longer an anchored pattern");
  return src.slice(1, -1);
})(SYMBOL_RE.source);
const ID_RE = new RegExp(`^dec-(\\d{4})(\\d{2})(\\d{2})-(\\d{4})-(${SYMBOL_BODY})-([CP])$`);
const SIDE_LETTER: Readonly<Record<RowSide, "C" | "P">> = { call: "C", put: "P" };

function slotEndMs(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new DecisionIdError("bad-slot-end", String(v));
    return v;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t) && new Date(t).toISOString() === v) return t;
  }
  throw new DecisionIdError("bad-slot-end", String(v));
}

/** True for a real calendar date YYYY-MM-DD (no 2026-02-30, no month 13). */
function calendarDate(day: string): boolean {
  const m = DAY_RE.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** The session's slot ends, or why it has none. */
function slotsOf(session: unknown): number[] {
  if (typeof session !== "string" || !calendarDate(session)) throw new DecisionIdError("bad-session", String(session));
  const slots = expectedSlots(session);
  if (slots.length === 0) throw new DecisionIdError("closed-day", session);
  return slots;
}

/**
 * The id of one side of one name at one slot: `dec-<yyyymmdd>-<hhmm>-<SYMBOL>-<C|P>`, the date the New York session
 * and the hhmm the slot's end in New York, as the record's path names them. The same input gives the same id, always.
 * Throws a DecisionIdError when the session has no regular session, the slot end is not one of its 2-minute slot ends,
 * the symbol is not one a record may hold (desk-eval.ts SYMBOL_RE) or the side is neither call nor put.
 */
export function decisionId(k: DecisionKey): string {
  const slots = slotsOf(k.session);
  const end = slotEndMs(k.slotEnd);
  if (!slots.includes(end)) throw new DecisionIdError("off-slot", `${new Date(end).toISOString()} is not a slot end of ${k.session}`);
  if (typeof k.symbol !== "string" || !SYMBOL_RE.test(k.symbol)) throw new DecisionIdError("bad-symbol", String(k.symbol));
  if (!SIDES.includes(k.side)) throw new DecisionIdError("bad-side", String(k.side));
  return `dec-${k.session.replaceAll("-", "")}-${nyHhmm(end)}-${k.symbol}-${SIDE_LETTER[k.side]}`;
}

/**
 * The inverse of decisionId: the session, the slot end (canonical ISO), the symbol and the side an id names. Throws a
 * DecisionIdError for anything decisionId could not have made (a closed day, a minute that is not a slot end, ...).
 */
export function parseDecisionId(id: string): ParsedDecisionId {
  const m = typeof id === "string" ? ID_RE.exec(id) : null;
  if (!m) throw new DecisionIdError("bad-id", String(id));
  const [, y, mo, d, hhmm, symbol, letter] = m as unknown as [string, string, string, string, string, string, "C" | "P"];
  const session = `${y}-${mo}-${d}`;
  if (!calendarDate(session)) throw new DecisionIdError("bad-id", `${id}: ${session} is not a calendar date`);
  const end = slotsOf(session).find((t) => nyHhmm(t) === hhmm);
  if (end === undefined) throw new DecisionIdError("off-slot", `${hhmm} is not a slot end of ${session}`);
  const side: RowSide = letter === "C" ? "call" : "put";
  return { session, slotEnd: new Date(end).toISOString(), symbol, side };
}

/** What decisionIdsOf reads off a record (signal-record.ts SignalRecord): its session and slot end, each name with its sides. */
export interface DecisionRecord {
  session: string;
  slot_end: string;
  names: readonly { symbol: string; sides: readonly { side: RowSide }[] }[];
}

/**
 * The ids a stored signal record implies: one per name worked out and side, in the record's order (names, then sides).
 * The writer (signal-run.ts buildSignalRecord) works out every focus name of the session's edition with both sides,
 * in dry and log mode alike, so this is the focus names × call and put; a record with no edition for its session holds
 * no names and implies no ids. Read the record through parseSignalRecord first; keep `mode === "log"` records only
 * where a word matters (see the header).
 *
 * An edition may list a focus name twice (desk-eval.ts focusSymbols does not dedupe), and the record then holds the
 * name twice: `ids` keeps each id once, at its first place, and `duplicates` lists each id seen more than once (once,
 * in the order its first repeat was met), so a page listing every record can show it rather than fail. Throws a
 * DecisionIdError only when the record's session and slot end make no id (checked even when it holds no names), or a
 * name or side is not one a record may hold.
 */
export function decisionIdsOf(record: DecisionRecord): { ids: string[]; duplicates: string[] } {
  const end = slotEndMs(record.slot_end);
  if (!slotsOf(record.session).includes(end)) throw new DecisionIdError("off-slot", `${record.slot_end} is not a slot end of ${record.session}`);
  const ids: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const n of record.names)
    for (const s of n.sides) {
      const id = decisionId({ session: record.session, slotEnd: record.slot_end, symbol: n.symbol, side: s.side });
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      } else if (!duplicates.includes(id)) duplicates.push(id);
    }
  return { ids, duplicates };
}
