// The fill-time check of DEC-0049 point 4: are the journal's opened_at and closed_at the times the owner's orders
// filled? Each unit is matched to Alpaca's historical option trade prints of the same contract, at the true time and
// in two control windows five minutes away. Pure: no I/O and no clock; `now` is always passed in.
//
// It is a check of timestamps, not a trial: it works out no P&L, R, win or loss, and its result (FillCheckResult)
// holds only session dates, counts, rates, seconds, reasons and the verdict. The units below carry the contract and
// the price for the match; they live only while a run is in progress and are never stored or logged.
import { nyTime } from "./journal";
import { nyNow, type SessionDay } from "./market-calendar";

/** The stored result's shape; a change to it is a new number. */
export const FILL_CHECK_FORMAT = 1;

/** Point 4: the 10 most recent full New York sessions that hold an opening side. */
export const MAX_SESSIONS = 10;
/** Point 4's pass rule, frozen there: opening sides checked, sessions, and the margin of the true rate over control. */
export const MIN_OPENING_CHECKED = 30;
export const MIN_SESSIONS = 3;

const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;
/** Matched: a print within 10 s either side of the journal time (point 4). Inclusive: 10.000 s matches. */
export const MATCH_NS = 10n * NS_PER_S;
/** The control windows are centred 5 minutes earlier and 5 minutes later (point 4). */
export const CONTROL_SHIFT_NS = 300n * NS_PER_S;
/** Prints are asked for from 5 min 10 s before to 5 min 10 s after the unit's own time, and never wider (point 4). */
export const SPAN_NS = CONTROL_SHIFT_NS + MATCH_NS;
/** Prices are compared in millionths of a dollar, as whole numbers; $0.01 is 10 000 of them (point 4). */
export const MICRO_PER_DOLLAR = 1_000_000;
export const PRICE_TOLERANCE_MICRO = 10_000;

export type Side = "opening" | "closing";

/**
 * Why a unit was not checked. Point 4 names open lot, no time, adjusted contract, no prints for the contract and
 * Alpaca's answer incomplete. Two are added so nothing is dropped without a trace: `unreadable`, a long option piece
 * whose price or close field cannot be read, and `no_times`, a piece with neither time usable (counted once, overall).
 */
export const REASONS = ["open_lot", "no_time", "no_times", "adjusted", "no_prints", "incomplete", "unreadable"] as const;
export type Reason = (typeof REASONS)[number];

/** One side to be matched. Held in memory during a run only: never stored, never logged. */
export interface Unit {
  side: Side;
  /** New York day of the unit's time. */
  day: string;
  /** The standard OCC symbol Alpaca names the contract by. */
  occ: string;
  /** The journal time in nanoseconds since the epoch. */
  atNs: bigint;
  /** The journal price in millionths of a dollar. */
  priceMicro: number;
}

/** A side left out before any print is asked for. `day` is null when the side has no usable time. */
export interface Excluded {
  side: Side;
  day: string | null;
  reason: Reason;
}

export interface UnitSet {
  units: Unit[];
  excluded: Excluded[];
}

// ── Times and prices as whole numbers ───────────────────────────────────────────────────────────────────────────

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * An ISO time with an explicit zone (Z or ±hh:mm), as the journal's schema and Alpaca write it, in nanoseconds since
 * the epoch; null for anything else. Digits past the ninth are dropped. A time with no zone is refused, as
 * owner-positions.ts refuses it, since JavaScript would read it as the machine's local time. Every field must be a
 * real one: a date that does not exist (30 February), hour 24, minute or second 60, or a zone past ±23:59 is refused
 * rather than rolled over into another time.
 */
export function stampNs(v: unknown): bigint | null {
  if (typeof v !== "string") return null;
  const m = STAMP.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (h > 23 || mi > 59 || sec > 59) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  let zoneMin = 0;
  if (!m[8]) {
    const zh = Number(m[10]);
    const zm = Number(m[11]);
    if (zh > 23 || zm > 59) return null;
    zoneMin = (m[9] === "-" ? -1 : 1) * (zh * 60 + zm);
  }
  const whole = Date.UTC(y, mo - 1, d, h, mi, sec) - zoneMin * 60_000;
  const frac = (m[7] ?? "").slice(0, 9).padEnd(9, "0");
  return BigInt(whole) * NS_PER_MS + BigInt(frac);
}

/** A positive price in millionths of a dollar, or null. Every price the journal or Alpaca gives has at most six decimals. */
export function priceMicro(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const m = Math.round(v * MICRO_PER_DOLLAR);
  return Number.isSafeInteger(m) && m > 0 ? m : null;
}

const nsToMs = (ns: bigint) => Number(ns / NS_PER_MS);
const absNs = (v: bigint) => (v < 0n ? -v : v);

// ── The contract ────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT = /^[A-Z]{1,6}$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The largest strike the OCC form holds: 8 digits of thousandths. */
const MAX_STRIKE_MILLI = 99_999_999;

/**
 * The standard OCC symbol as Alpaca writes it: the root unpadded, the expiry as YYMMDD, C or P, and the strike in
 * thousandths of a dollar as 8 digits (AAPL 2026-01-16 call 172.5 is AAPL260116C00172500). Null for anything that does
 * not fit the form exactly: a root that is not 1 to 6 capital letters, a date that is not real or not in 2000-2099, a
 * strike that is not positive, does not fit 8 digits, or is not a whole number of thousandths (the strike × 1000 must
 * round-trip to the same number).
 */
export function occSymbol(symbol: unknown, expiry: unknown, kind: unknown, strike: unknown): string | null {
  if (typeof symbol !== "string" || !ROOT.test(symbol)) return null;
  if (kind !== "call" && kind !== "put") return null;
  if (typeof expiry !== "string") return null;
  const d = YMD.exec(expiry);
  if (!d) return null;
  const t = Date.parse(`${expiry}T12:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== expiry) return null;
  if (d[1]!.slice(0, 2) !== "20") return null;
  if (typeof strike !== "number" || !Number.isFinite(strike) || strike <= 0) return null;
  const milli = Math.round(strike * 1000);
  if (!Number.isSafeInteger(milli) || milli <= 0 || milli > MAX_STRIKE_MILLI || milli / 1000 !== strike) return null;
  return `${symbol}${d[1]!.slice(2)}${d[2]}${d[3]}${kind === "call" ? "C" : "P"}${String(milli).padStart(8, "0")}`;
}

/**
 * Adjusted (non-standard) contracts, decided from what the journal holds and on the safe side (point 4): a contract is
 * adjusted when its multiplier is not 100, or when its symbol is not 1 to 6 capital letters (a corporate action's
 * root such as one ending in a digit, or a class share written with a dot), or when it cannot be written in the
 * standard OCC form at all (no strike, no expiry, a strike off the thousandths). Such a contract is not checked, and
 * is counted.
 */
export function standardContract(p: { symbol?: unknown; kind?: unknown; strike?: unknown; expiry?: unknown; multiplier?: unknown }): string | null {
  if (p.multiplier !== 100) return null;
  return occSymbol(p.symbol, p.expiry, p.kind, p.strike);
}

// ── Units ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const longOption = (r: Row) => (r.kind === "call" || r.kind === "put") && r.side === "long";
const nyDayOf = (ns: bigint) => nyTime(new Date(nsToMs(ns)).toISOString()).day;

/**
 * The units of DEC-0049 point 4, from the journal as stored (rows are read one by one; a row that is not a long call
 * or put is not in scope and is passed over).
 *  - Opening units: each distinct (contract, opened_at, entry) among the closed long single-leg option pieces, so one
 *    buy sold in parts counts once and two buys of one contract at different times count twice.
 *  - Closing units: each distinct (contract, closed_at, exit) of a piece closed by an order. A piece left to expire
 *    has no closing side, and is not counted as left out either.
 *  - Left out and counted: every long option lot in `open` (an open lot), a side whose time is missing or unreadable
 *    (no time), a side whose price or close field cannot be read (unreadable), and an adjusted contract (adjusted).
 *    An adjusted side is counted once per distinct (contract fields, time, price), like a unit; the others once per row.
 *  - A side with no usable time is placed on the New York day of the piece's other time, and so counted only when
 *    that day is a picked session. A piece with neither time usable is counted once, as `no_times` on the opening
 *    side, with no day: it belongs to no session and is in the overall count only. An open lot with no opening time
 *    likewise has no day and is counted overall only.
 *
 * With `sessions`, only the units and left-out sides on those New York days are kept, and those with no day.
 */
export function checkUnits(journal: unknown, sessions: readonly string[] | null): UnitSet {
  const doc = isRow(journal) ? journal : {};
  const trades = Array.isArray(doc.trades) ? doc.trades : [];
  const open = Array.isArray(doc.open) ? doc.open : [];
  const inScope = sessions ? new Set(sessions) : null;
  const keep = (day: string | null) => day === null || !inScope || inScope.has(day);

  const units: Unit[] = [];
  const excluded: Excluded[] = [];
  const seen = new Set<string>();
  const seenAdjusted = new Set<string>();

  const side = (r: Row, which: Side, atNs: bigint | null, otherNs: bigint | null) => {
    if (atNs === null) {
      // Only reached with the other time usable (a piece with neither is counted as no_times by the caller).
      const day = otherNs === null ? null : nyDayOf(otherNs);
      if (keep(day)) excluded.push({ side: which, day, reason: "no_time" });
      return;
    }
    const day = nyDayOf(atNs);
    if (!keep(day)) return;
    const price = priceMicro(which === "opening" ? r.entry : r.exit);
    if (price === null) {
      excluded.push({ side: which, day, reason: "unreadable" });
      return;
    }
    const occ = standardContract(r);
    if (occ === null) {
      const key = JSON.stringify([which, r.symbol ?? null, r.kind, r.strike ?? null, r.expiry ?? null, r.multiplier ?? null, String(atNs), price]);
      if (!seenAdjusted.has(key)) {
        seenAdjusted.add(key);
        excluded.push({ side: which, day, reason: "adjusted" });
      }
      return;
    }
    const key = `${which}|${occ}|${atNs}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);
    units.push({ side: which, day, occ, atNs, priceMicro: price });
  };

  for (const r of trades) {
    if (!isRow(r) || !longOption(r)) continue;
    const openNs = stampNs(r.opened_at);
    const closeNs = stampNs(r.closed_at);
    if (openNs === null && closeNs === null) {
      excluded.push({ side: "opening", day: null, reason: "no_times" });
      continue;
    }
    side(r, "opening", openNs, closeNs);
    if (r.close === "expired") continue;
    if (r.close !== "order") {
      const at = closeNs ?? openNs!;
      const day = nyDayOf(at);
      if (keep(day)) excluded.push({ side: "closing", day, reason: "unreadable" });
      continue;
    }
    side(r, "closing", closeNs, openNs);
  }
  for (const l of open) {
    if (!isRow(l) || !longOption(l)) continue;
    const at = stampNs(l.opened_at);
    const day = at === null ? null : nyDayOf(at);
    if (keep(day)) excluded.push({ side: "opening", day, reason: "open_lot" });
  }
  units.sort((a, b) => (a.atNs < b.atNs ? -1 : a.atNs > b.atNs ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : a.occ < b.occ ? -1 : a.occ > b.occ ? 1 : a.priceMicro - b.priceMicro));
  return { units, excluded };
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The sessions of point 4, fixed at the first run: the 10 most recent full New York sessions, as of `now`, that hold
 * at least one opening unit. Full means the calendar's kind is "open": a half day, a holiday, a weekend and a day
 * outside the calendar's range are skipped. A session counts only once it has ended: before today, or today at or
 * after its close. Newest first.
 */
export function pickSessions(journal: unknown, calendar: (day: string) => SessionDay, now: Date): string[] {
  const today = nyNow(now);
  const days = new Set<string>();
  for (const u of checkUnits(journal, null).units) if (u.side === "opening") days.add(u.day);
  const full = [...days].filter((day) => {
    const s = calendar(day);
    if (s.kind !== "open" || s.close === null) return false;
    return day < today.day || (day === today.day && today.minute >= s.close);
  });
  return full.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, MAX_SESSIONS);
}

// ── Prints ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One of Alpaca's historical option trades as it came: t (RFC 3339, to the nanosecond), p (price), c (condition). */
export interface RawPrint {
  t?: unknown;
  p?: unknown;
  c?: unknown;
}

/**
 * A condition code's class (point 4). Alpaca lists A to G, f to m and n to s as cancels, late or out-of-sequence
 * reports, multi-leg trades and stock-option combinations: those are "excluded". Any other single letter, and a
 * missing or empty code, is "eligible". Anything else (more than one character, a character that is not a letter, a
 * value that is not a string) is "unknown": not eligible, and counted. Letters are compared case-sensitively.
 */
export function codeClass(c: unknown): "eligible" | "excluded" | "unknown" {
  if (c === undefined || c === null || c === "") return "eligible";
  if (typeof c !== "string" || c.length !== 1 || !/^[A-Za-z]$/.test(c)) return "unknown";
  return /^[A-G]$/.test(c) || /^[f-m]$/.test(c) || /^[n-s]$/.test(c) ? "excluded" : "eligible";
}

export function eligible(print: RawPrint): boolean {
  return codeClass(print.c) === "eligible";
}

/** The request span of point 4 for a unit: from 5 min 10 s before to 5 min 10 s after its time, in whole ms, never wider. */
export function requestSpan(unit: Pick<Unit, "atNs">): { startMs: number; endMs: number } {
  const start = unit.atNs - SPAN_NS;
  const end = unit.atNs + SPAN_NS;
  // Rounded inwards to the millisecond, so the span asked for never reaches past either bound.
  const startMs = Number(start / NS_PER_MS) + (start % NS_PER_MS === 0n ? 0 : 1);
  return { startMs, endMs: Number(end / NS_PER_MS) };
}

export interface UnitMatch {
  /** Prints Alpaca returned for the contract inside the request span, of any condition. */
  prints: number;
  /** Prints whose condition code had an unknown shape. */
  unknownCodes: number;
  /** An eligible print within 10 s of the time at a price within $0.01. */
  truth: boolean;
  /** The same test centred 5 minutes earlier, and 5 minutes later. */
  early: boolean;
  late: boolean;
  /** The nearest true-time match's time minus the unit's time, in ms (rounded to the ms; sign kept). Null without one. */
  offsetMs: number | null;
}

/**
 * Matches one unit against the prints of its contract (point 4). Times are compared in nanoseconds and prices in
 * millionths of a dollar, all whole numbers, so the bounds are exact: 10.000 s and $0.01 match, 10.001 s and $0.010001
 * do not. A print outside the request span, or whose time or price cannot be read, is not counted at all. The
 * nearest match is the one with the smallest distance in time; between two equally near, the earlier.
 */
export function matchUnit(unit: Pick<Unit, "atNs" | "priceMicro">, prints: readonly RawPrint[]): UnitMatch {
  const out: UnitMatch = { prints: 0, unknownCodes: 0, truth: false, early: false, late: false, offsetMs: null };
  let best: bigint | null = null;
  for (const p of prints) {
    const t = stampNs(p.t);
    const price = priceMicro(p.p);
    if (t === null || price === null) continue;
    const d = t - unit.atNs;
    if (absNs(d) > SPAN_NS) continue;
    out.prints++;
    const cls = codeClass(p.c);
    if (cls === "unknown") out.unknownCodes++;
    if (cls !== "eligible" || Math.abs(price - unit.priceMicro) > PRICE_TOLERANCE_MICRO) continue;
    if (absNs(d) <= MATCH_NS) {
      out.truth = true;
      if (best === null || absNs(d) < absNs(best) || (absNs(d) === absNs(best) && d < best)) best = d;
    }
    if (absNs(d + CONTROL_SHIFT_NS) <= MATCH_NS) out.early = true;
    if (absNs(d - CONTROL_SHIFT_NS) <= MATCH_NS) out.late = true;
  }
  // Within ±10 s the difference in ns is far inside a double's exact range; rounded half away from zero to the ms.
  if (best !== null) out.offsetMs = Math.sign(Number(best)) * Math.round(Math.abs(Number(best)) / 1e6);
  return out;
}

// ── The summary ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One side's outcome in a run: matched (with its result) or not checked (with its reason). */
export type Outcome =
  | { side: Side; day: string; checked: true; match: Pick<UnitMatch, "truth" | "early" | "late" | "offsetMs"> }
  | { side: Side; day: string | null; checked: false; reason: Reason };

export interface OffsetStats {
  /** Units matched at the true time. */
  n: number;
  /** In seconds, to the millisecond. */
  median: number;
  p10: number;
  p90: number;
}

export interface SideStats {
  checked: number;
  /** Units matched at the true time, and in each control window. */
  matched: number;
  early: number;
  late: number;
  /** matched / checked; null with none checked. Stored rates are for reading; the verdict is decided in whole counts. */
  true_rate: number | null;
  /** The mean of the two control rates: (early + late) / (2 × checked); null with none checked. */
  control_rate: number | null;
  offset_s: OffsetStats | null;
  not_checked: Record<Reason, number>;
}

export interface SessionStats {
  day: string;
  opening: SideStats;
  closing: SideStats;
}

export interface FillCheckSummary {
  sessions: SessionStats[];
  overall: {
    opening: SideStats;
    closing: SideStats;
    /** Sessions with at least one opening unit checked: the pass rule's session count. */
    sessions_checked: number;
  };
}

export type Verdict = "pass" | "fail" | "too_few";

/** The stored result. Dates of sessions, counts, rates, seconds, reasons, the verdict, the run time and the format only. */
export interface FillCheckResult extends FillCheckSummary {
  state: "done";
  format: typeof FILL_CHECK_FORMAT;
  run_at: string;
  /** True for a run on the fixture journal and synthetic prints (fixture mode or anywhere but production). */
  fixture: boolean;
  /** Prints whose condition code had an unknown shape, over every answer read. */
  unknown_codes: number;
  verdict: Verdict;
}

const zeroReasons = (): Record<Reason, number> => Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<Reason, number>;

/**
 * The p-th percentile (0 to 1) of sorted values, by linear interpolation between the two nearest ranks: the value at
 * rank h = (n − 1) × p, counting from 0, taking the fractional part of h between ranks floor(h) and floor(h) + 1. (The
 * method numpy and R use by default, "type 7".) One value is every percentile; for two the median is their mean.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of no values");
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

const toSeconds = (ms: number) => Math.round(ms) / 1000;

function sideStats(list: readonly Outcome[]): SideStats {
  const not_checked = zeroReasons();
  let checked = 0;
  let matched = 0;
  let early = 0;
  let late = 0;
  const offsets: number[] = [];
  for (const o of list) {
    if (!o.checked) {
      not_checked[o.reason]++;
      continue;
    }
    checked++;
    if (o.match.early) early++;
    if (o.match.late) late++;
    if (o.match.truth) {
      matched++;
      if (o.match.offsetMs !== null) offsets.push(o.match.offsetMs);
    }
  }
  offsets.sort((a, b) => a - b);
  return {
    checked,
    matched,
    early,
    late,
    true_rate: checked > 0 ? matched / checked : null,
    control_rate: checked > 0 ? (early + late) / (2 * checked) : null,
    offset_s: offsets.length > 0 ? { n: offsets.length, median: toSeconds(percentile(offsets, 0.5)), p10: toSeconds(percentile(offsets, 0.1)), p90: toSeconds(percentile(offsets, 0.9)) } : null,
    not_checked,
  };
}

/**
 * Per session (newest first, in the order given) and overall: the units checked, the true-time and control rates
 * over them, the offsets of the units matched at the true time, and the units not checked by reason (point 4). The
 * overall figures also count the sides with no usable time, which belong to no session.
 */
export function summarise(sessions: readonly string[], outcomes: readonly Outcome[]): FillCheckSummary {
  const per = sessions.map((day) => {
    const mine = outcomes.filter((o) => o.day === day);
    return { day, opening: sideStats(mine.filter((o) => o.side === "opening")), closing: sideStats(mine.filter((o) => o.side === "closing")) };
  });
  const inRun = new Set(sessions);
  const counted = outcomes.filter((o) => o.day === null || inRun.has(o.day));
  return {
    sessions: per,
    overall: {
      opening: sideStats(counted.filter((o) => o.side === "opening")),
      closing: sideStats(counted.filter((o) => o.side === "closing")),
      sessions_checked: per.filter((s) => s.opening.checked > 0).length,
    },
  };
}

/**
 * Point 4's rule, frozen there: "too_few" with fewer than 30 opening units checked or fewer than 3 sessions with one;
 * otherwise "pass" when the true-time rate is at least 50 percentage points above the control rate, else "fail".
 * Closing sides never enter it. Decided on whole counts so exactly 50 points is a pass with no rounding:
 * matched/n − (early + late)/(2n) ≥ 1/2 is 2 × matched − (early + late) ≥ n.
 */
export function verdict(summary: FillCheckSummary): Verdict {
  const o = summary.overall.opening;
  if (o.checked < MIN_OPENING_CHECKED || summary.overall.sessions_checked < MIN_SESSIONS) return "too_few";
  return 2 * o.matched - (o.early + o.late) >= o.checked ? "pass" : "fail";
}
