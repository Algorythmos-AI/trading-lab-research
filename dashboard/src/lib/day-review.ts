// The Day review page's figures: one New York day of the owner's own option positions against his rules. Pure: no
// I/O; the clock is passed in. Nothing here is worked out afresh: every number comes from the functions the Trades page
// already uses (tradesView, judgeDays, exitStats, dayCheck, daysWithEntries), so the two pages can never disagree
// about the same day. What the page may show is DEC-0045 point 8 and DEC-0049 point 5: over all of the day's positions
// together, never split by a label, a caution or a time window, and no exit that was not taken beyond the −25% figure.
import { newYork } from "./format";
import { ALL, closeDay, contractLabel, daily, MIN_SAMPLE, nyTime, readableJournal, sessionView, type JournalDoc, type Lot } from "./journal";
import { sessionOf } from "./market-calendar";
import { daysWithEntries, judgeDay } from "./overview";
import { exitStats, isPositionPiece, R25_SHARE, R50_DOLLARS, tradeUnits, type OwnerPosition } from "./owner-positions";
import { dayCheck, judgeDays, RULES } from "./trade-rules";
import { tradesView } from "./trades-view";

/** The one line the page says about the board's labels until they are recorded (a later release). */
export const BOARD_LABEL_LINE = "Board labels are not being recorded yet.";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-9;

/** A real calendar day written YYYY-MM-DD, or null: anything else in the address is ignored. */
export function parseDay(raw: string | string[] | undefined | null): string | null {
  if (typeof raw !== "string" || !DAY.test(raw)) return null;
  const d = new Date(`${raw}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : null;
}

/**
 * The day on show and its neighbours. `days` are the New York days with a closed long option position, oldest first.
 * A valid `?day=` is shown as asked, even with nothing on it; otherwise the latest day in `days`. Previous and next are
 * the nearest days in `days` either side, or null: a link is only drawn to a day that has positions.
 */
export function pickDay(days: readonly string[], raw: string | string[] | undefined | null): { day: string | null; prev: string | null; next: string | null } {
  const day = parseDay(raw) ?? days[days.length - 1] ?? null;
  if (day === null) return { day, prev: null, next: null };
  const prev = [...days].reverse().find((d) => d < day) ?? null;
  const next = days.find((d) => d > day) ?? null;
  return { day, prev, next };
}

/** One position of the day, as the page lists it. Results are after fees; R25 and R50 are the position's own. */
export interface ReviewRow {
  id: string;
  /** The contract in the house style (contractLabel). */
  contract: string;
  openedAt: string;
  /** The last close; null while contracts of it are still held. */
  closedAt: string | null;
  contracts: number;
  /** Premium paid, fees not in it. */
  cost: number;
  /** Contracts of it are still held (see `heldBy`): no result is shown. */
  open: boolean;
  net: number | null;
  gross: number | null;
  r25: number | null;
  r50: number | null;
  /** The numbers of the rules it broke, lowest first (judgeDays); empty when it kept them. */
  rules: number[];
  /** A counted loser closed past the −25% stop by at least a cent (exitStats' test and replay, on this one position). */
  pastStop: boolean;
  /** What it lost beyond 25% of its cost, in dollars; 0 unless pastStop. */
  beyondPlan: number;
  /** A counted loser with rule 4's loss break, as judgeUnit reports it apart from the premium: before fees, the
   * position or a piece of it lost more than $50. */
  overRisk: boolean;
  /** A closed loser the Loss size figures leave out (no cost, or a gap in the broker's history). */
  leftOut: boolean;
}

export interface DayReview {
  day: string;
  /** The day is today in New York. */
  isToday: boolean;
  /** Today, between the open and the close of the session (a half day's close included): the day so far. */
  sessionOpen: boolean;
  /** In order of open time. */
  rows: ReviewRow[];
  rules: {
    /** Positions with no rule broken, of the positions judged (those with a closed part). */
    kept: number;
    of: number;
    /** Entries against the day's cap: today as the Trades page's rules strip counts them (held lots included), any
     * other day as the Calendar does (closed trades only). */
    entries: number;
    entriesKept: boolean;
    /** Rows still held that the entry count above leaves out (another day than today only). */
    heldOpen: number;
    /** The day's closed result before fees, which the day loss limit reads at the end of the day. */
    dayNet: number;
    dayLossKept: boolean;
    /** False when today cannot be judged from the journal (dayCheck's `current`): the figures are as last read. */
    current: boolean;
    /** The journal's read time, HH:MM New York. */
    readAt: string;
  };
  loss: {
    /** Positions the Loss size figures count (cost above 0, no gap piece, nothing still held). */
    counted: number;
    /** Losers, past the stop and over $50, all over the counted positions. */
    losers: number;
    pastStop: number;
    /** Dollars lost beyond the −25% stop, added up over the counted losers (zero or above). */
    beyondStop: number;
    overRisk: number;
    /** Closed losers left out of the counted positions. */
    leftOut: number;
  };
  /** The day's result as the Trades page books it: each part on the day it was sold. Null with nothing sold that day.
   * `carried`: it is not exactly the listed positions' (a part sold on another day, or something else sold this day). */
  result: { net: number; gross: number; r50: number; feesIncluded: boolean; carried: boolean } | null;
  trades: { taken: number; winners: number; losers: number; open: number };
  /** Stock or short pieces sold this day: in the result, not in the list. */
  otherSold: number;
}

export interface ReviewView {
  /** The days with a closed long option position, up to today, oldest first. */
  days: string[];
  day: string | null;
  prev: string | null;
  next: string | null;
  review: DayReview | null;
  /** Rows of the journal that could not be read and are left out of every figure. */
  skipped: number;
  asOf: string;
  /** Today in New York. */
  today: string;
}

const ruleNumbers = (ids: readonly string[] | undefined) => RULES.filter((r) => ids?.includes(r.id)).map((r) => r.n);
const lotKey = (l: Pick<Lot, "symbol" | "kind" | "strike" | "expiry">) => JSON.stringify([l.symbol, l.kind, l.strike ?? null, l.expiry ?? null]);
const isOptionLot = (l: Lot) => (l.kind === "call" || l.kind === "put") && l.side === "long";

/**
 * exitStats' rule 5 test and replay, on one counted loser: past the stop, and the dollars beyond it. An overshoot that
 * rounds to under a cent is not shown as one.
 */
export function beyondPlan(p: OwnerPosition): { pastStop: boolean; beyond: number } {
  if (!p.counts || !(p.net < 0)) return { pastStop: false, beyond: 0 };
  const beyond = Math.max(0, (1 - R25_SHARE) * p.cost - p.proceeds);
  const past = 1 - p.proceeds / p.cost > R25_SHARE + EPS && Math.round(beyond * 100) >= 1;
  return { pastStop: past, beyond: past ? beyond : 0 };
}

/**
 * Whether a still-held lot is part of this position: it shares one of the position's entry fills, or it was bought
 * before the position's last close. A lot with no open time may be its rest, so it is read as one (the cautious
 * reading, as owner-positions does). A lot bought after the last close is a trade of its own.
 */
export function heldBy(p: Pick<OwnerPosition, "symbol" | "kind" | "strike" | "expiry" | "pieces" | "lastClose">, lots: readonly Lot[]): Lot[] {
  const key = lotKey(p);
  const entries = new Set(p.pieces.map((q) => Date.parse(q.opened_at)));
  const last = Date.parse(p.lastClose);
  return lots.filter((l) => {
    if (!isOptionLot(l) || lotKey(l) !== key) return false;
    if (typeof l.opened_at !== "string" || !Number.isFinite(Date.parse(l.opened_at))) return true;
    const at = Date.parse(l.opened_at);
    return entries.has(at) || at < last;
  });
}

/** The whole page's figures for one journal, address and clock. */
export function reviewView(raw: JournalDoc, rawDay: string | string[] | undefined | null, now: Date): ReviewView {
  const { doc, skipped } = readableJournal(raw);
  const view = tradesView(doc, ALL, now);
  const today = nyTime(now.toISOString()).day;
  const days = [...new Set(view.positions.map((p) => p.day))].filter((d) => d <= today).sort();
  const { day, prev, next } = pickDay(days, rawDay);
  return { days, day, prev, next, review: day ? dayReview(doc, view, day, now) : null, skipped, asOf: doc.as_of, today };
}

function dayReview(doc: JournalDoc, view: ReturnType<typeof tradesView>, day: string, now: Date): DayReview {
  const nowNy = nyTime(now.toISOString());
  const isToday = day === nowNy.day;
  const s = sessionOf(day);
  const sessionOpen = isToday && (s.kind === "open" || s.kind === "half") && s.open !== null && s.close !== null && nowNy.minute >= s.open && nowNy.minute < s.close;
  const lots = (doc.open ?? []).filter(isOptionLot);
  // A position is open only when a held lot is part of it (heldBy): a rebuy after a full exit leaves it closed.
  const positions = view.positions
    .filter((p) => p.day === day)
    .map((p) => {
      const openLot = heldBy(p, lots).length > 0;
      return openLot === p.flags.openLot ? p : { ...p, flags: { ...p.flags, openLot }, counts: !p.flags.gapPiece && !p.flags.zeroCost && !openLot };
    });
  // The rules as the Trades page judges them, keyed by the position's id. judgeDays judges each day by the trades
  // opened on it, so the day's own pieces give the same breaks as the whole journal (a test holds them equal).
  const { verdicts, breaks } = judgeDays(tradeUnits(doc.trades.filter((t) => nyTime(t.opened_at).day === day)));
  const lossBreak = new Map(verdicts.map((v) => [v.unit.unit.id, v.loss]));
  const claimed = new Set(positions.flatMap((p) => heldBy(p, lots)));
  const rows: ReviewRow[] = positions.map((p) => {
    const open = p.flags.openLot;
    const b = beyondPlan(p);
    return {
      id: p.id,
      contract: contractLabel(p),
      openedAt: p.t0,
      closedAt: open ? null : p.lastClose,
      contracts: p.contractsOpened,
      cost: p.cost,
      open,
      net: open ? null : p.net,
      gross: open ? null : p.gross,
      r25: open ? null : p.r25,
      r50: open ? null : p.r50,
      rules: ruleNumbers(breaks.get(p.id)),
      pastStop: b.pastStop,
      beyondPlan: b.beyond,
      overRisk: p.counts && p.net < 0 && lossBreak.get(p.id) === true,
      leftOut: !open && !p.counts && p.net < 0,
    };
  });
  // Lots bought this day, still held and part of no position above: one open row per contract, no result.
  const own = new Map<string, { lot: Lot; qty: number; cost: number }>();
  for (const l of lots) {
    if (claimed.has(l) || typeof l.opened_at !== "string" || !Number.isFinite(Date.parse(l.opened_at)) || nyTime(l.opened_at).day !== day) continue;
    const key = lotKey(l);
    const had = own.get(key) ?? { lot: l, qty: 0, cost: 0 };
    had.qty += l.qty;
    had.cost += l.entry * 100 * l.qty;
    if (l.opened_at < (had.lot.opened_at ?? "")) had.lot = l;
    own.set(key, had);
  }
  for (const [key, { lot, qty, cost }] of own)
    rows.push({ id: `open:${key}`, contract: contractLabel(lot), openedAt: lot.opened_at!, closedAt: null, contracts: qty, cost, open: true, net: null, gross: null, r25: null, r50: null, rules: [], pastStop: false, beyondPlan: 0, overRisk: false, leftOut: false });
  rows.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.id.localeCompare(b.id));

  // The day rules: today as the Trades page's strip counts it (dayCheck), any other day as the Calendar does.
  const sv = isToday ? sessionView(doc, now) : null;
  const check = sv && sv.isToday && sv.day === day ? dayCheck(sv, { asOf: doc.as_of, now }) : null;
  const dayRow = check ? null : daysWithEntries(doc.trades).find((d) => d.day === day);
  const entries = check ? check.used : (dayRow?.entries ?? 0);
  const dayNet = check ? check.net : (dayRow?.pnl ?? 0);
  const judged = judgeDay({ pnl: dayNet, entries });

  const x = exitStats(positions, MIN_SAMPLE);
  const netDay = view.days.find((d) => d.day === day);
  const grossDay = daily(doc.trades).find((d) => d.day === day);
  // The day's dollars and the list differ when a part of a listed position was sold on another day, or something not
  // listed (a position opened earlier, shares) was sold on this one.
  const listed = new Set(positions.flatMap((p) => p.pieces.map((q) => q.id)));
  const carried = positions.some((p) => p.closedLaterDay) || doc.trades.some((t) => closeDay(t) === day && !listed.has(t.id));
  const closed = rows.filter((r) => !r.open);
  return {
    day,
    isToday,
    sessionOpen,
    rows,
    rules: {
      kept: positions.filter((p) => !breaks.has(p.id)).length,
      of: positions.length,
      entries,
      entriesKept: judged.broke !== "count" && judged.broke !== "both",
      heldOpen: check ? 0 : own.size,
      dayNet,
      dayLossKept: judged.broke !== "loss" && judged.broke !== "both",
      current: check ? check.current : true,
      readAt: newYork(doc.as_of, false),
    },
    loss: {
      counted: x.n,
      losers: x.losers,
      pastStop: rows.filter((r) => r.pastStop).length,
      beyondStop: rows.reduce((sum, r) => sum + r.beyondPlan, 0),
      overRisk: rows.filter((r) => r.overRisk).length,
      leftOut: rows.filter((r) => r.leftOut).length,
    },
    result: netDay ? { net: netDay.pnl, gross: grossDay?.pnl ?? 0, r50: netDay.pnl / R50_DOLLARS, feesIncluded: view.fees.included, carried } : null,
    trades: { taken: rows.length, winners: closed.filter((r) => r.net! > 0).length, losers: closed.filter((r) => r.net! < 0).length, open: rows.filter((r) => r.open).length },
    otherSold: doc.trades.filter((t) => closeDay(t) === day && !isPositionPiece(t)).length,
  };
}
