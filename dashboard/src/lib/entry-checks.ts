// The cautions beside an entry on the Options desk: the DEC-0041 research checks, computed live in the browser.
// Advisory only. They never hide an entry and never change the 9 rules; each one is still under test (its HYP id).
//
// Pure: no I/O and no clock. The caller passes `now`, the feed's (server) clock: trade-state's `serverNow`, never the
// browser's own. Each check mirrors `wt.options.setups.tag_decision` (and its
// helpers `_mid_third` and `broken_marks`), read at the moment the owner would enter instead of at a 2-minute close:
// the entry price is the live price, the session's open, high and low come from the quote, and the closes come from
// the 2-minute bars the page has built since it opened. dashboard/test/fixtures/entry-checks.vectors.json holds the
// clone's own answers for a set of sessions (scripts/gen_entry_check_vectors.py), and both languages' tests assert
// them. A check whose input the page does not have is left out (never
// shown as clear) and named in `unknown`, so the page can say why.
import { type LiveQuote, nyClock, nyInstant, OPEN_MIN, type OptionsTicker } from "./options";
import type { Tone } from "./labels";

// ---- config/options_clone.yaml (tests/unit/test_entry_checks_parity.py holds these equal to the file) ----------------
/** research_arms.tags.iv_cap_index: the IV above which an index name's options are rich (HYP-0040/41). */
export const IV_CAP_INDEX = 0.35;
/** research_arms.tags.iv_cap_single: the same for every other name. */
export const IV_CAP_SINGLE = 0.7;
/** research_arms.tags.early_from / early_before / late_to, New York: early is [10:00, 11:00), late [11:00, 14:30]. */
export const EARLY_FROM = "10:00";
export const EARLY_BEFORE = "11:00";
export const LATE_TO = "14:30";
/** fail_within_bars of the failed-break arm (HYP-0046, research_arms.shadow): a break that closes back inside within this many bars has failed. */
export const FAIL_WITHIN_BARS = 3;
/** sweep_min_atr of the fast-reclaim arm (HYP-0047, research_arms.shadow): how far past a level (in ATRs) a sweep must reach. */
export const SWEEP_MIN_ATR = 0.25;
/** contract.index_names: the names priced against IV_CAP_INDEX. */
export const INDEX_NAMES: readonly string[] = ["SPY", "QQQ"];
/** research_arms.tags.leaders: a name and the name that leads it (HYP-0038/39). */
export const LEADERS: Readonly<Record<string, string>> = { QQQ: "SMH" };
/** levels.names: the marked levels whose break today ends the middle-of-range check (with the pre-market high and low). */
export const MARK_NAMES: readonly string[] = ["PDH", "PDL", "PWH", "PWL", "PMH", "PML", "MA20", "MA50", "PMKH", "PMKL"];
/** The five-session range: the high and low of the five finished sessions before today (levels.SWING_SESSIONS). */
export const SWING_SESSIONS = 5;
/** bars.minutes: the bar every state and check is read on. */
export const BAR_MINUTES = 2;
/** setups.retest.max_bars_to_retest (HYP-0029): the touch must come within this many bars after the break bar, and
 * the entry by the bar after that (the retest's window, `last - ia <= n_max + 1`). */
export const MAX_BARS_TO_RETEST = 6;

// ---- the desk's own numbers (not the clone's) ----------------------------------------------------------------------
/** A quote whose last trade is older than this is stale: the row pauses, and the leader check is left out. */
export const TRADE_STALE_MS = 120_000;
const BAR_MS = BAR_MINUTES * 60_000;

/** The leaders' plain names, for the caution's word. */
const LEADER_WORD: Readonly<Record<string, string>> = { SMH: "Semis" };

/** The symbols with each present name's leader added after them: no repeats, the order kept. For the quote feed. */
export function withLeaders(symbols: readonly string[]): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const s of symbols) add(s);
  for (const s of symbols) {
    const lead = LEADERS[s];
    if (lead) add(lead);
  }
  return out;
}

export type CheckId = "range" | "gap" | "leader" | "iv" | "late" | "winner";
export type Side = "call" | "put";

/** Which DEC-0041 hypothesis tests each check, for the break-and-hold entry the desk shows (the retest arm). */
export const CHECK_HYP: Readonly<Record<CheckId, string | null>> = {
  range: "HYP-0034",
  gap: "HYP-0036",
  leader: "HYP-0038",
  iv: "HYP-0040",
  late: "HYP-0042",
  winner: null,
};
/** The other arm of each pair (the rejection entries), for a link that names both. */
export const CHECK_HYP_PAIR: Readonly<Record<CheckId, string | null>> = {
  range: "HYP-0035",
  gap: "HYP-0037",
  leader: "HYP-0039",
  iv: "HYP-0041",
  late: "HYP-0043",
  winner: null,
};

export interface Caution {
  id: CheckId;
  /** Set when the caution is about one side only. */
  side?: Side;
  tone: Tone;
  /** At most three words. */
  word: string;
  /** One plain sentence with the numbers. */
  why: string;
  hyp: string | null;
}

/** A 2-minute bar the page built (trade-state's bars2m), as far as the checks read it. */
export interface CheckBar {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface CheckInput {
  symbol: string;
  /** The edition's ticker: its levels (PDH, PDL and the marks), daily bars and expected move. */
  ticker: Pick<OptionsTicker, "levels" | "bars" | "expected_move">;
  /** The edition's session (New York date). */
  session: string;
  quote: LiveQuote | null | undefined;
  /** The leader's quote, for a name in LEADERS. */
  leaderQuote?: LiveQuote | null;
  /** The finished 2-minute bars the page has built today. */
  bars?: readonly CheckBar[];
  /** The start of the page's first 2-minute bar today (ms, trade-state's `Bars2m.since`). */
  since?: number | null;
  /** The 2-minute slots with no bar since then (`Bars2m.gaps`). The bars are complete only from the session's open
   * with no gap: anything else, or a missing count, leaves a crossed mark unknown. */
  gaps?: number | null;
  halfDay: boolean;
  /** The feed's (server) clock. */
  now: Date;
  /** Whether a trade has closed green today; null when the journal cannot say. */
  wonToday: boolean | null;
}

export interface CheckResult {
  cautions: Caution[];
  /** Why each check that could not run was left out, in plain words. */
  unknown: string[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const p2 = (v: number) => v.toFixed(2);

/** The middle third of a range, ends included (setups._mid_third). False for an empty or inverted range. */
export function midThird(x: number, hi: number, lo: number): boolean {
  const third = (hi - lo) / 3;
  return hi > lo && lo + third <= x && x <= hi - third;
}

/** The five-session range: the highest high and lowest low of the five daily bars before `session`, or null. */
export function fiveSessionRange(bars: OptionsTicker["bars"], session: string): { hi: number; lo: number } | null {
  const hist = (bars ?? []).filter((b) => b.d < session).slice(-SWING_SESSIONS);
  if (hist.length !== SWING_SESSIONS) return null;
  return { hi: Math.max(...hist.map((b) => b.h)), lo: Math.min(...hist.map((b) => b.l)) };
}

export function levelOf(ticker: Pick<OptionsTicker, "levels">, name: string): number | null {
  const v = ticker.levels?.find((l) => l.name === name)?.price;
  return isNum(v) ? v : null;
}

/**
 * The marks broken today (setups.broken_marks): a finished bar closed across a mark from the session's open. Known
 * true from the page's own bars; known false when no print today reached the mark (the day's high and low); unknown
 * (null) when a print crossed it but the page did not see the closes.
 */
export function brokenMarks(
  ticker: Pick<OptionsTicker, "levels">,
  quote: Pick<LiveQuote, "open" | "high" | "low">,
  bars: readonly CheckBar[],
  complete: boolean,
): string[] | null {
  const op = quote.open;
  if (!isNum(op)) return null;
  const out: string[] = [];
  let unsure = false;
  for (const m of ticker.levels ?? []) {
    if (!MARK_NAMES.includes(m.name) || !isNum(m.price)) continue;
    const p = m.price;
    const seen = (op > p && bars.some((b) => b.c < p)) || (op < p && bars.some((b) => b.c > p));
    if (seen) {
      out.push(m.name);
      continue;
    }
    if (complete) continue;
    const reached = op > p ? (isNum(quote.low) ? quote.low < p : null) : op < p ? (isNum(quote.high) ? quote.high > p : null) : false;
    if (reached !== false) unsure = true;
  }
  return unsure && out.length === 0 ? null : out;
}

/** New York HH:MM of an instant, or null. `now` is the feed's (server) clock. */
export function nyHhmm(now: Date): string | null {
  const c = nyClock(now.toISOString());
  if (!c) return null;
  return `${String(Math.floor(c.minutes / 60)).padStart(2, "0")}:${String(c.minutes % 60).padStart(2, "0")}`;
}

/** The end (ms) of the 2-minute bar forming at `now`: the bar an entry now would complete, as the clone reads its
 * signal bar's end. */
export function barEndAt(now: Date): number {
  return Math.floor(now.getTime() / BAR_MS) * BAR_MS + BAR_MS;
}

/** The cautions for entering `side` now, ordered by importance, and the checks that could not run. `input.now` is
 * the feed's (server) clock. */
export function entryChecks(input: CheckInput, side: Side): CheckResult {
  const cautions: Caution[] = [];
  const unknown: string[] = [];
  const { ticker, session, symbol } = input;
  const q = input.quote && input.quote.day === session ? input.quote : null;
  const pdh = levelOf(ticker, "PDH");
  const pdl = levelOf(ticker, "PDL");
  const add = (id: CheckId, word: string, why: string, tone: Tone = "warn", oneSide = false) =>
    cautions.push({ id, ...(oneSide ? { side } : {}), tone, word, why, hyp: CHECK_HYP[id] });

  // Range (HYP-0034/35): the price in the middle third of yesterday's range or of the five sessions', nothing broken.
  if (!q) unknown.push("No live price for today yet: the range, gap and semis checks are off.");
  else {
    const x = q.price;
    const prior = pdh !== null && pdl !== null ? midThird(x, pdh, pdl) : null;
    const fiveR = fiveSessionRange(ticker.bars, session);
    const five = fiveR ? midThird(x, fiveR.hi, fiveR.lo) : null;
    const inZone = prior || five ? true : prior === null || five === null ? null : false;
    // Complete: the page's first bar starts at the session's open and no 2-minute slot since has no bar.
    const complete = isNum(input.since) && input.gaps === 0 && isNum(q.open) ? input.since <= (nyInstant(session, OPEN_MIN) ?? -Infinity) : false;
    const broken = brokenMarks(ticker, q, input.bars ?? [], complete);
    if (inZone === null) unknown.push("Yesterday's or the five-day range is missing: the middle-of-range check is off.");
    else if (inZone && broken === null) unknown.push("A level was crossed before the page opened: confirm on your chart whether it closed through.");
    else if (inZone && broken !== null && broken.length === 0) {
      const which =
        prior && pdh !== null && pdl !== null
          ? `yesterday's range (${p2(pdl)} to ${p2(pdh)})`
          : `the five-day range (${p2(fiveR!.lo)} to ${p2(fiveR!.hi)})`;
      add("range", "Middle of range", `${p2(x)} is in the middle third of ${which} and no level has broken today.`);
    }

    // Gap (HYP-0036/37): a call on a gap up while no low has reached PDH, a put on a gap down while no high has reached PDL.
    const op = q.open;
    if (!isNum(op) || pdh === null || pdl === null) unknown.push("No open or no yesterday's high and low: the gap check is off.");
    else if (side === "call" && op > pdh) {
      if (!isNum(q.low)) unknown.push("No day low yet: the gap check is off.");
      else if (q.low > pdh) add("gap", "Gap not filled", `Opened at ${p2(op)} above yesterday's high ${p2(pdh)}, and the low ${p2(q.low)} has not come back to it.`, "warn", true);
    } else if (side === "put" && op < pdl) {
      if (!isNum(q.high)) unknown.push("No day high yet: the gap check is off.");
      else if (q.high < pdl) add("gap", "Gap not filled", `Opened at ${p2(op)} below yesterday's low ${p2(pdl)}, and the high ${p2(q.high)} has not come back to it.`, "warn", true);
    }
  }

  // Leader (HYP-0038/39): a call with the leader below its VWAP, a put with it above. Equal is not against.
  const lead = LEADERS[symbol];
  if (lead) {
    const lq = input.leaderQuote && input.leaderQuote.day === session ? input.leaderQuote : null;
    const lqAge = lq ? input.now.getTime() - Date.parse(lq.at) : NaN;
    if (!lq || !isNum(lq.vwap)) unknown.push(`No live ${lead} price or VWAP: the ${lead} check is off.`);
    else if (!(lqAge <= TRADE_STALE_MS)) unknown.push(`The ${lead} quote is stale: the ${lead} check is off.`);
    else {
      const d = lq.price - lq.vwap;
      const against = side === "call" ? d < 0 : d > 0;
      if (against)
        add(
          "leader",
          `${LEADER_WORD[lead] ?? lead} against`,
          `${lead} is at ${p2(lq.price)}, ${side === "call" ? "below" : "above"} its VWAP ${p2(lq.vwap)}.`,
          "warn",
          true,
        );
    }
  }

  // IV (HYP-0040/41): above the cap is rich; at the cap is not.
  const iv = ticker.expected_move?.annual_iv;
  const cap = INDEX_NAMES.includes(symbol) ? IV_CAP_INDEX : IV_CAP_SINGLE;
  if (!isNum(iv)) unknown.push("No implied volatility in the edition: the IV check is off.");
  else if (iv > cap) add("iv", "IV high", `Implied volatility ${Math.round(iv * 100)}% is above the ${Math.round(cap * 100)}% cap for ${symbol}.`);

  // Time (HYP-0042/43): late is [11:00, 14:30] New York, read on the end of the 2-minute bar forming now (the clone
  // reads its signal bar's end); neither early nor late on a half day.
  const t = nyHhmm(new Date(barEndAt(input.now)));
  if (!input.halfDay && t !== null && EARLY_BEFORE <= t && t <= LATE_TO)
    add("late", `Late: after ${EARLY_BEFORE}`, `This 2-min bar ends at ${t} New York, past the ${EARLY_FROM} to ${EARLY_BEFORE} window under test.`);

  // A winner already closed today.
  if (input.wonToday === null) unknown.push("Today's closed trades are not known: the winner check is off.");
  else if (input.wonToday) add("winner", "Winner already today", "You already closed a winning trade today: done for the day?", "info");

  return { cautions, unknown };
}
