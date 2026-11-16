import { fillStop } from "./manage-stop";
import { askToCents, bidToCents, CROSSED, type Held, type HeldValue, NO_ASK, NO_BID, tooWide, ZERO_BID } from "./option-value";
import type { RailDay } from "./session-timeline";
import { usd } from "./ticket";
import { DAY_LOSS_LIMIT } from "./trade-rules";
import { type ManageView, PAUSED_LINE } from "./trade-manage";

// The owner's −25% premium stop on the manage card, and the open options' loss in the day pill (rule 7: "Open losses
// count too"). Owner decisions, 2026-11-17:
//   - the card says EXIT once the held contract's bid is at or under the −25% stop on PREMIUM_CONFIRM fresh OPRA
//     quotes in a row, and keeps saying it (latched for the session, kept in this browser);
//   - the day pill and its open-position line count each losing open option at the bid, after fees. Display only:
//     the board's own entry rules (dayCheck, boardDay) are unchanged.
// Page-only on purpose: no file in the signal's or the engine's hashed code imports this module (a test checks), so
// neither SIGNAL_CODE_HASH nor ENGINE_VERSION moves. The card's own logic (trade-state.ts manage, trade-manage.ts
// manageView) is read, never changed: these functions only lay a word and a line over its answer.

/** Fresh quotes in a row at or under the stop before the card says EXIT. */
export const PREMIUM_CONFIRM = 2;

/** The premium stop's count for one trade: fresh quotes in a row at or under it, and whether it has fired. */
export interface PremiumStop {
  under: number;
  hit: boolean;
}

export const NO_STOP: PremiumStop = { under: 0, hit: false };

/**
 * One fresh quote's step. A quote at or under the stop adds one; one above it starts the count again; once fired the
 * stop stays fired. A quote with no stop to measure (too cheap a contract for one) changes nothing.
 */
export function premiumStep(prev: PremiumStop, toStopCents: number | null): PremiumStop {
  if (prev.hit || toStopCents === null) return prev;
  if (toStopCents > 0) return NO_STOP;
  const under = prev.under + 1;
  return { under, hit: under >= PREMIUM_CONFIRM };
}

/** "Bid $0.40 under your −25% stop $3.00: exit", or "Bid at your −25% stop $3.00: exit". */
export function premiumExitLine(v: Pick<HeldValue, "stopCents" | "toStopCents">): string {
  if (v.stopCents === null || v.toStopCents === null) return "Under your −25% stop: exit";
  if (v.toStopCents === 0) return `Bid at your −25% stop ${usd(v.stopCents)}: exit`;
  return `Bid ${usd(Math.abs(v.toStopCents))} ${v.toStopCents < 0 ? "under" : "above"} your −25% stop ${usd(v.stopCents)}: exit`;
}

/** The trade's −25% stop, cents a share, as the card's value works it out (heldValue); null for an entry too cheap for one. */
export function stopCentsOf(h: Pick<Held, "paidCents" | "qty">): number | null {
  const stop = fillStop({ priceCents: h.paidCents, contracts: h.qty });
  return stop.noStop ? null : stop.stopCents;
}

/** The wide-spread reason's fixed start ("the spread is "): a test pins it, so a change of wording fails loudly. */
export const WIDE_PREFIX = tooWide(0).slice(0, tooWide(0).indexOf("0%"));

/**
 * A fresh quote withheld from the value (judgeQuote: one-sided, a zero bid, crossed, too wide) read against the stop:
 * - "under": even the ask is at or under the stop, so the option is worth no more than the stop: it counts, as a
 *   valued quote under the stop does (a collapsing option is where the stop matters most);
 * - "above": a real bid above the stop (a buyer at that price): it counts as above, as a valued quote does;
 * - "thin": the stop sits inside a quote that cannot say which side it is on (no bid, or a bid under the stop with no
 *   ask or an ask above it; an empty quote, as in a halt; a crossed one): it never fires the stop, it never resets the
 *   count, and the card says CHECK, never a reassuring word;
 * - null: withheld for its age, its session or its day, or no stop to read: left as the card already says.
 */
export type ThinRead = { kind: "under" | "above"; toStopCents: number } | { kind: "thin" } | null;

export function readThinQuote(why: string, bid: number | null | undefined, ask: number | null | undefined, stopCents: number | null): ThinRead {
  if (stopCents === null) return null;
  const crossed = why === CROSSED;
  if (!crossed && why !== NO_BID && why !== ZERO_BID && why !== NO_ASK && !why.startsWith(WIDE_PREFIX)) return null;
  const real = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (!crossed && real(ask) && askToCents(ask) <= stopCents) return { kind: "under", toStopCents: askToCents(ask) - stopCents };
  if (!crossed && real(bid) && bidToCents(bid) > stopCents) return { kind: "above", toStopCents: bidToCents(bid) - stopCents };
  return { kind: "thin" };
}

/** The CHECK a thin quote puts on the card while its stop has not fired. */
export const THIN_LINE = "Option quotes too thin to read your −25% stop: check Webull";

/** HOLD, TRAIL and SELL HALF become CHECK while the held contract's quotes are too thin to read the stop. */
export function withThinQuote(v: ManageView, thin: boolean): ManageView {
  if (!thin || v.action === "exit" || v.action === "check") return v;
  return { ...v, action: "check", tone: "warn", line: THIN_LINE };
}

/**
 * The upstream quote's own identity: its time and prices. A quote the contract route re-serves from its cache, or
 * another server instance fetches again, has the same key, so it counts once. No quote time: no key, never counted.
 */
export function quoteKey(c: { quote_at?: string | null; bid?: number | null; ask?: number | null } | undefined): string | null {
  return c?.quote_at ? `${c.quote_at}|${c.bid ?? ""}|${c.ask ?? ""}` : null;
}

/** The bar's figure: "$0.31" above the stop, "at the stop", or "$0.43 under". */
export function roomText(toStopCents: number): string {
  return toStopCents > 0 ? usd(toStopCents) : toStopCents === 0 ? "at the stop" : `${usd(-toStopCents)} under`;
}

/** The bar's label: where the bid is against the stop, and the exit once it has fired. */
export function roomLabel(toStopCents: number, hit: boolean): string {
  if (hit) return toStopCents > 0 ? "Bid back above the −25% stop: the exit stands" : toStopCents === 0 ? "Bid at the −25% stop: exit" : "Bid under the −25% stop: exit";
  return toStopCents > 0 ? "Bid above the −25% stop" : toStopCents === 0 ? "Bid at the −25% stop" : "Bid under the −25% stop";
}

/**
 * The card with the premium stop laid over it, once fired: HOLD, TRAIL and SELL HALF become EXIT, with the stop's line.
 * An EXIT the card already says keeps its own line. A CHECK stays a CHECK, except one that says only that the
 * stock's prices are paused: the stop fired on the option's own quotes, so it stands, as manageView keeps a stock EXIT
 * through a pause. A CHECK for the feed off, an unmatched note or a bad-data guard is left as it is.
 */
export function withPremiumStop(v: ManageView, hit: boolean, value: Pick<HeldValue, "stopCents" | "toStopCents"> | null): ManageView {
  if (!hit || v.action === "exit") return v;
  if (v.action === "check" && v.line !== PAUSED_LINE) return v;
  return { ...v, action: "exit", tone: "bad", line: value ? premiumExitLine(value) : "Under your −25% stop: exit" };
}

/**
 * manage()'s stock-stop line (trade-state.ts): "Above the stop 101.25: exit"; on a journal card after target 1, when
 * the stop is the card's entry, manageView adds "(card entry)". test/held-marks.test.ts pins both.
 */
const STOCK_STOP_LINE = /^(Above|Below) the stop (\d+\.\d{2})( \(card entry\))?: exit$/;
const CLOSED_STOP_LINE = /^A 2-min close went (above|below) the stop \d+\.\d{2}( \(card entry\))?: exit$/;

/**
 * The stock stop's line says it was a close: "A 2-min close went above the stop 101.25: exit". The card keeps the
 * exit once any close since the fill crossed the stop, while the live distance beside it may read back on the right
 * side; this says why.
 */
export function withClosedStopLine(v: ManageView): ManageView {
  const m = STOCK_STOP_LINE.exec(v.line);
  if (!m) return v;
  return { ...v, line: `A 2-min close went ${m[1]!.toLowerCase()} the stop ${m[2]}${m[3] ?? ""}: exit` };
}

/** Whether the card's exit is the stock stop's (its line, either form). */
export function stockStopExit(v: Pick<ManageView, "action" | "line">): boolean {
  return v.action === "exit" && (STOCK_STOP_LINE.test(v.line) || CLOSED_STOP_LINE.test(v.line));
}

// ---- the open options' loss ------------------------------------------------------------------------------------------
/**
 * The open trades the page prices: how many, how many of them the journal already shows (a note's own lot is not yet
 * a journal position), and their losses at the bid after fees (a gain counts as nothing).
 */
export interface OpenMarks {
  priced: number;
  journalPriced: number;
  lossCents: number;
}

export const NO_MARKS: OpenMarks = { priced: 0, journalPriced: 0, lossCents: 0 };

/** Each priced trade's whole position at the bid, fees in (a contract's P&L times the contracts held). */
export function openMarks(trades: Iterable<{ value: Pick<HeldValue, "perContractCents" | "qty">; fromNote: boolean }>): OpenMarks {
  let priced = 0;
  let journalPriced = 0;
  let lossCents = 0;
  for (const t of trades) {
    priced += 1;
    if (!t.fromNote) journalPriced += 1;
    lossCents += Math.max(0, -t.value.perContractCents * t.value.qty);
  }
  return { priced, journalPriced, lossCents };
}

const dollars = (cents: number) => Math.round(cents / 100);

/**
 * The day pill with the open options' losses added (rule 7). The figure becomes closed plus open, with the open part
 * said ("$92 of $100 · $92 open"); at the day's limit or past it the word is the stop's, from 60% of it Careful, as
 * dayCheck reads a closed loss. Careful replaces only a clear day: a warning already shown (the journal not current,
 * one trade left) stays. The open-position line says the priced loss; journal positions it cannot price keep the old
 * caution. Nothing priced: the pill as it was.
 */
export function withOpenLoss(day: RailDay, closedNet: number, marks: OpenMarks, openPositions: number): RailDay {
  if (marks.priced === 0) return day;
  const closed = Math.round(Math.max(0, -closedNet));
  const open = dollars(marks.lossCents);
  const total = closed + open;
  const stop = total >= DAY_LOSS_LIMIT;
  const careful = !stop && total >= DAY_LOSS_LIMIT * 0.6 && day.tone === "good";
  const keep = day.tone === "bad" || (!stop && !careful);
  const word = keep ? day.word : stop ? "Stop for today" : "Careful";
  const tone = keep ? day.tone : stop ? "bad" : "warn";
  // A position in profit adds nothing, so the pill says nothing of it; its line still names it.
  const rest = open > 0 ? day.line.slice(day.word.length).replace(/\$\d+ of \$\d+/, `$${total} of $${DAY_LOSS_LIMIT} · $${open} open`) : day.line.slice(day.word.length);
  // The journal's positions less the ones priced here; a note's own lot is not one of them yet.
  const unpriced = Math.max(0, openPositions - marks.journalPriced);
  const n = marks.priced;
  const priced = `${n} position${n === 1 ? "" : "s"} open: ${open > 0 ? `−$${open} at the bid` : "no loss at the bid"}, counted toward the $${DAY_LOSS_LIMIT} day stop (rule 7).`;
  const rest2 = unpriced > 0 ? ` ${unpriced} more not priced here: check Webull.` : "";
  return { ...day, word, tone, line: `${word}${rest}`, open: `${priced}${rest2}`, room: null };
}
