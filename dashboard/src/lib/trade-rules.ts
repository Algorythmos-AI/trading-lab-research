// The rules before every trade, and the evidence behind each one. Pure: no I/O; any clock is passed in.
// The thresholds live here; every number about the owner's own trading is measured from the journal at render time,
// so none of it is written into this repository. The market numbers are EXP-0023's, held equal to its record by a test.
import { INTRADAY_MAX_AGE_MIN, inUsSession, journalCheck } from "./feeds";
import { etOffsetMin } from "./freshness";
import { closeDay, daily, holdMinutes, nyTime, type Lot, type SessionView, type Trade } from "./journal";
import { partPastStop, peakPremium, premiumOverAt, tradeUnits, type TradeUnit } from "./owner-positions";

/** The most a single trade may lose, in dollars. */
export const RISK_PER_TRADE = 50;
/** The most premium a single option may cost, in dollars. With the 25% stop it caps the loss at RISK_PER_TRADE. */
export const MAX_PREMIUM = 200;
/** Close an option once it has lost this share of what it cost. */
export const PREMIUM_STOP = 0.25;
/** A trade not working after this many minutes is closed. */
export const TIME_STOP_MINUTES = 5;
/** Stop trading for the day once the day's closed trades are down this much. */
export const DAY_LOSS_LIMIT = 100;
/** The most entries in one day. */
export const MAX_TRADES_PER_DAY = 5;
/** Next level at least this many times the stop distance away. */
export const MIN_ROOM_MULTIPLE = 2;
/** The bar the entry is confirmed on, in minutes. */
export const CONFIRM_BAR_MINUTES = 2;

/**
 * The gain, as a share of the premium, that the evidence counts a winning option as having run to (20% up). Once the
 * target share of the owner's worked $165 example; the example itself is now the trade ticket on the Options desk.
 */
export const WIN_SHARE_MARK = 0.2;

/** What a plan comes to in dollars: the planned loss, the target and reward to risk. Before fees and slippage. */
export function planNumbers(premium: number, stopShare: number, targetShare: number): { risk: number; reward: number; ratio: number; ok: boolean } {
  const risk = premium * stopShare;
  const reward = premium * targetShare;
  const ratio = risk > 0 ? reward / risk : 0;
  return { risk, reward, ratio, ok: ratio >= MIN_ROOM_MULTIPLE - 1e-9 && risk <= RISK_PER_TRADE };
}

/** The checks before every order, ticked in order. */
export const PRE_TRADE_CHECKS: string[] = [
  `Setup and a ${CONFIRM_BAR_MINUTES}-minute close confirming it`,
  "Chart invalidation and the premium stop written down",
  `Target at least ${MIN_ROOM_MULTIPLE}:1 on the plan`,
  "Bid/ask spread tight and the contract liquid",
  "Limit order at your price, no chasing",
  "Trades and day loss still inside today's limits",
];

export type RuleGroup = "setup" | "risk" | "day";

/**
 * Who holds a rule. Nothing in this app can block a broker order: its broker access is read only.
 * "you": only you can check it, before the order. "flagged": the journal sees a break once the broker reports the
 * trade, and counts it. "broker": a Webull order can hold it for you (a stop order placed as soon as you are filled).
 */
export type RuleCheck = "you" | "flagged" | "broker";

export interface Rule {
  n: number;
  id: string;
  group: RuleGroup;
  /** The rule as a short command. */
  title: string;
  /** One line on how to apply it. */
  detail: string;
  check: RuleCheck;
}

export const GROUPS: { id: RuleGroup; title: string; means: string }[] = [
  { id: "setup", title: "The setup", means: "Where you enter" },
  { id: "risk", title: "The risk", means: "What one trade may cost" },
  { id: "day", title: "The day", means: "When you stop" },
];

export const RULES: Rule[] = [
  {
    n: 1,
    id: "levels",
    group: "setup",
    title: "Mark the levels before the open",
    detail: "Yesterday's, last week's and last month's highs and lows. Wait for price to reach one; in between, no trade.",
    check: "you",
  },
  {
    n: 2,
    id: "retest",
    group: "setup",
    title: `Wait for the ${CONFIRM_BAR_MINUTES}-minute close`,
    detail: `Put: a candle at resistance is rejected (a long upper wick, or it closes back under the level), then a ${CONFIRM_BAR_MINUTES}-minute candle closes below it. Call: the mirror at support, then a close above. A wick is not a close.`,
    check: "you",
  },
  {
    n: 3,
    id: "room",
    group: "setup",
    title: `Plan it in dollars: target ${MIN_ROOM_MULTIPLE}× the risk`,
    detail: "Risk is entry to where the chart proves you wrong; the target is the next level. Under 2:1, skip it.",
    check: "you",
  },
  {
    n: 4,
    id: "risk",
    group: "risk",
    title: `Risk $${RISK_PER_TRADE} at most`,
    detail: `Premium of $${MAX_PREMIUM} or less, so the stop costs no more than $${RISK_PER_TRADE}.`,
    check: "flagged",
  },
  {
    n: 5,
    id: "stop",
    group: "risk",
    title: `Stop at the chart, −${Math.round(PREMIUM_STOP * 100)}% at most`,
    detail: `Out on a ${CONFIRM_BAR_MINUTES}-minute close back through the level. Place the stop order in Webull as soon as you are filled; never move it down.`,
    check: "broker",
  },
  {
    n: 6,
    id: "time",
    group: "risk",
    title: `${TIME_STOP_MINUTES} minutes in and not working? Out.`,
    detail: "Not working: the option is not above your entry, or the setup has failed. Being tested in your journal.",
    check: "flagged",
  },
  {
    n: 7,
    id: "day-stop",
    group: "day",
    title: `Broke a rule or down $${DAY_LOSS_LIMIT}? Done.`,
    detail: "For the day. Open losses count too. No trade to win it back.",
    check: "flagged",
  },
  {
    n: 8,
    id: "day-cap",
    group: "day",
    title: `${MAX_TRADES_PER_DAY} trades a day, no more`,
    detail: "Every entry counts, the winners too.",
    check: "flagged",
  },
  {
    n: 9,
    id: "flat",
    group: "day",
    title: "Flat by the close",
    detail: "No option is held overnight.",
    check: "flagged",
  },
];

// ── Evidence ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Evidence {
  /** One or two plain sentences with the numbers in them. */
  finding: string;
  /** Where the numbers come from: the owner's trades, a registered experiment, or nothing measured yet. */
  source: "yours" | "backtest" | "none";
  /** Two sides for a small bar pair. */
  compare?: { unit: string; a: { label: string; value: number }; b: { label: string; value: number } };
}

/**
 * EXP-0023, the replication of the four level rules registered by DEC-0028 (research/experiments/
 * EXP-0023-options-rules-replication/result.json): cases and mean R on the stock, before option costs.
 * test/trade-rules.test.ts holds these equal to the record, so a figure here cannot drift from it.
 */
export const EXP_0023 = {
  id: "EXP-0023",
  period: "30-minute bars, 10 names, 3 Mar to 9 Oct 2026",
  breakHigh: { n: 636, avgR: -0.0015 },
  breakLow: { n: 547, avgR: -0.0067 },
  reclaimLow: { n: 187, avgR: 0.0081 },
  rejectHigh: { n: 228, avgR: 0.0265 },
} as const;

const MIN_SAMPLE = 8;
// The word joiner keeps the sign on the same line as the amount.
export const money = (v: number) => `${v < 0 ? "−⁠" : v > 0 ? "+⁠" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const count = (n: number) => n.toLocaleString("en-US");
const sumOf = (ts: readonly Trade[]) => ts.reduce((s, t) => s + t.pnl, 0);
const avgOf = (ts: readonly Trade[]) => (ts.length ? sumOf(ts) / ts.length : 0);
const isOption = (t: Trade) => t.kind !== "stock";
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmtMin = (m: number) => (m < 10 ? m.toFixed(1) : Math.round(m).toString());

/**
 * The account's result had it stopped opening trades once the day was down `limit`: the same trades, in the order
 * they were opened, skipping any opened after that day's earlier closes had already lost `limit`. A replay of the
 * record, not a forecast; the trades it skips might have gone either way.
 */
export function replayDayStop(trades: readonly Trade[], limit = DAY_LOSS_LIMIT): { kept: number; skipped: number; net: number; skippedNet: number } {
  const byDay = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = nyTime(t.opened_at).day;
    const list = byDay.get(d) ?? [];
    list.push(t);
    byDay.set(d, list);
  }
  let kept = 0;
  let skipped = 0;
  let net = 0;
  let skippedNet = 0;
  for (const list of byDay.values()) {
    for (const t of list) {
      const at = Date.parse(t.opened_at);
      const before = list.filter((p) => p !== t && Date.parse(p.closed_at) <= at).reduce((s, p) => s + p.pnl, 0);
      if (before <= -limit) {
        skipped++;
        skippedNet += t.pnl;
      } else {
        kept++;
        net += t.pnl;
      }
    }
  }
  return { kept, skipped, net, skippedNet };
}

// ── Rule breaks ──────────────────────────────────────────────────────────────────────────────────────────────────

// The rules judge trades, not the journal's matched pieces (DEC-0045 section 1): long calls and puts are grouped into
// positions (`tradeUnits` in owner-positions.ts). Grouping only stops a scale-out from counting as several entries
// against the day's cap (rule 8). For every other rule a position breaks a rule when the position as a whole does OR
// when any one of its pieces does by the per-piece test, so a position is never judged more kindly than its pieces
// were. Shares and short pieces are judged one piece at a time. Results here are before fees, as the rules have
// always been read.

const OWN_ORDER = ["risk", "stop", "time", "flat"] as const;

/** The per-piece tests of rules 4, 5, 6 and 9, each piece on its own entry, exit and hold. */
function pieceOwn(t: Trade): { ids: Set<string>; loss: boolean; premium: boolean } {
  const ids = new Set<string>();
  const option = isOption(t);
  const long = option && t.side === "long";
  const loss = t.pnl < -RISK_PER_TRADE;
  const premium = long && t.entry * t.multiplier * t.qty > MAX_PREMIUM + 1e-9;
  if (loss || premium) ids.add("risk");
  const exit = t.close === "expired" ? 0 : t.exit;
  if (long && t.entry > 0 && 1 - exit / t.entry > PREMIUM_STOP + 1e-9) ids.add("stop");
  if (t.pnl < 0 && holdMinutes(t) > TIME_STOP_MINUTES) ids.add("time");
  if (option && closeDay(t) !== nyTime(t.opened_at).day) ids.add("flat");
  return { ids, loss, premium };
}

/** One trade's verdict on rules 4, 5, 6 and 9, and when its first break was known. */
export interface TradeVerdict {
  unit: TradeUnit;
  /** Rule ids broken, in rule order: risk, stop, time, flat. */
  ids: string[];
  /** Rule 4, apart: the loss over RISK_PER_TRADE, and the premium over MAX_PREMIUM. */
  loss: boolean;
  premium: boolean;
  /** The most premium held at once (a position) or the piece's own cost (a long option piece); 0 for shares. */
  peak: number;
  /** When a break was first known, in ms: a piece's break at that piece's close, a break only the whole position shows
   * at its last close; Infinity with none. */
  knownAt: number;
  /** The entries against the day's cap, in ms: each distinct opened_at. */
  entries: number[];
}

/** A unit judged on its own (the day rules 7 and 8 need the day: see `judgeDay`). */
export function judgeUnit(u: TradeUnit): TradeVerdict {
  const t = u.unit;
  const ids = new Set<string>();
  let loss = false;
  let premium = false;
  let knownAt = Infinity;
  for (const p of u.pieces) {
    const own = pieceOwn(p);
    for (const id of own.ids) ids.add(id);
    loss ||= own.loss;
    premium ||= own.premium;
    if (own.ids.size) knownAt = Math.min(knownAt, Date.parse(p.closed_at));
  }
  const pieceIds = new Set(ids);
  let peak = 0;
  if (u.position) {
    peak = peakPremium(u.pieces);
    if (t.pnl < -RISK_PER_TRADE) loss = true;
    if (peak > MAX_PREMIUM + 1e-9) premium = true;
    if (loss || premium) ids.add("risk");
    if (t.entry > 0 && (1 - t.exit / t.entry > PREMIUM_STOP + 1e-9 || partPastStop(u.pieces, t.entry, PREMIUM_STOP))) ids.add("stop");
    if (t.pnl < 0 && holdMinutes(t) > TIME_STOP_MINUTES) ids.add("time");
    if (closeDay(t) !== nyTime(t.opened_at).day) ids.add("flat");
    // A break the pieces did not show is known when the whole shows it: a premium over the cap at the fill that took
    // it there, anything else at the last close.
    const added = [...ids].filter((id) => !pieceIds.has(id));
    const byPremium = added.includes("risk") && peak > MAX_PREMIUM + 1e-9;
    if (byPremium) knownAt = Math.min(knownAt, premiumOverAt(u.pieces, MAX_PREMIUM) ?? Infinity);
    if (added.some((id) => id !== "risk" || !byPremium)) knownAt = Math.min(knownAt, Date.parse(t.closed_at));
  } else if (isOption(t) && t.side === "long") {
    peak = t.entry * t.multiplier * t.qty;
  }
  const entries = [...new Set(u.pieces.map((p) => Date.parse(p.opened_at)))].sort((a, b) => a - b);
  return { unit: u, ids: OWN_ORDER.filter((id) => ids.has(id)), loss, premium, peak, knownAt, entries };
}

/**
 * Every trade's breaks, keyed by the trade's id (a position's is its first piece's); a trade that kept them all is
 * left out. Rules 4, 5, 6 and 9 as `judgeUnit` reads them; then the day, entry by entry in the order they were made:
 * an entry past the day's cap (8), and an entry made after the day was down the limit, after an earlier break was
 * known, or past the first entry over the cap (7). A position breaks a day rule when any of its entries does. The
 * setup rules (1 to 3) are yours to check. Kept apart from losing: a winner can break a rule and a loser can keep
 * them all.
 */
export function judgeDays(units: readonly TradeUnit[]): { verdicts: TradeVerdict[]; breaks: Map<string, string[]> } {
  const verdicts = units.map(judgeUnit);
  const out = new Map<string, string[]>();
  const byDay = new Map<string, TradeVerdict[]>();
  for (const v of verdicts) {
    const d = nyTime(v.unit.unit.opened_at).day;
    const list = byDay.get(d) ?? [];
    list.push(v);
    byDay.set(d, list);
  }
  for (const day of byDay.values()) {
    const entries = day
      .flatMap((v) => v.entries.map((at) => ({ v, at })))
      .sort((a, b) => a.at - b.at || a.v.unit.unit.id.localeCompare(b.v.unit.unit.id));
    const extra = new Map<TradeVerdict, Set<string>>();
    entries.forEach(({ v, at }, k) => {
      const set = extra.get(v) ?? new Set<string>();
      if (k >= MAX_TRADES_PER_DAY) set.add("day-cap");
      const mine = (p: Trade) => p.opened_at && Date.parse(p.opened_at) === at;
      // The day's closed result at the entry: every piece of the day closed by then but the entry's own.
      const lost = day.reduce((s, w) => s + w.unit.pieces.filter((p) => !(w === v && mine(p)) && Date.parse(p.closed_at) <= at).reduce((a, p) => a + p.pnl, 0), 0);
      // An earlier break: another trade's, once known; or one of this position's own earlier pieces'.
      const broke =
        day.some((w) => w !== v && w.knownAt <= at) || v.unit.pieces.some((p) => !mine(p) && Date.parse(p.closed_at) <= at && pieceOwn(p).ids.size > 0);
      // An entry past the cap is itself a break, so every entry after the first one past it is past rule 7 too.
      if (k > MAX_TRADES_PER_DAY || lost <= -DAY_LOSS_LIMIT || broke) set.add("day-stop");
      extra.set(v, set);
    });
    for (const v of day) {
      const more = extra.get(v) ?? new Set<string>();
      const ids = [...v.ids, ...(["day-cap", "day-stop"] as const).filter((id) => more.has(id))];
      if (ids.length) out.set(v.unit.unit.id, ids);
    }
  }
  return { verdicts, breaks: out };
}

/** Entries per New York day of opening, as the day's cap counts them (each distinct buy fill of a position). */
export function entriesByDay(trades: readonly Trade[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of tradeUnits(trades).map(judgeUnit)) {
    const d = nyTime(v.unit.unit.opened_at).day;
    out.set(d, (out.get(d) ?? 0) + v.entries.length);
  }
  return out;
}

/**
 * The rules each trade broke (see `judgeDays`), keyed by piece id: every piece of a position carries the breaks of
 * its position, so a caller that walks the journal's pieces finds them. A piece of a trade that kept them all is
 * left out.
 */
export function tradeBreaks(trades: readonly Trade[]): Map<string, string[]> {
  const units = tradeUnits(trades);
  const { breaks } = judgeDays(units);
  const out = new Map<string, string[]>();
  for (const u of units) {
    const ids = breaks.get(u.unit.id);
    if (ids) for (const p of u.pieces) out.set(p.id, ids);
  }
  return out;
}

export interface BreakSummary {
  sessions: number;
  /** Trades that broke at least one rule (positions, not pieces). */
  trades: number;
  /** Breaks per rule id, one per trade. */
  byRule: Record<string, number>;
  /** What the trades that broke a rule made, and what the trades that kept them all made. Before fees. */
  brokeNet: number;
  keptNet: number;
  keptLosers: number;
  keptLosersNet: number;
}

/** The rule breaks of the last `sessions` trading days (New York, by the day opened). */
export function breakSummary(trades: readonly Trade[], sessions = 20): BreakSummary {
  const days = [...new Set(trades.map((t) => nyTime(t.opened_at).day))].sort().slice(-sessions);
  const keep = new Set(days);
  const units = tradeUnits(trades.filter((t) => keep.has(nyTime(t.opened_at).day)));
  const { breaks } = judgeDays(units);
  const byRule: Record<string, number> = {};
  for (const ids of breaks.values()) for (const id of ids) byRule[id] = (byRule[id] ?? 0) + 1;
  const all = units.map((u) => u.unit);
  const broke = all.filter((t) => breaks.has(t.id));
  const kept = all.filter((t) => !breaks.has(t.id));
  const keptLosers = kept.filter((t) => t.pnl < 0);
  return { sessions: days.length, trades: broke.length, byRule, brokeNet: sumOf(broke), keptNet: sumOf(kept), keptLosers: keptLosers.length, keptLosersNet: sumOf(keptLosers) };
}

/** What the record says about each rule, keyed by rule id. A rule is missing when its sample is too small. */
export function ruleEvidence(pieces: readonly Trade[]): Record<string, Evidence> {
  const out: Record<string, Evidence> = {};
  // Every figure counts trades: long calls and puts as positions (see `tradeUnits`), before fees.
  const units = tradeUnits(pieces);
  const trades = units.map((u) => u.unit);
  const x = EXP_0023;
  const r = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(4)}R`;
  out.levels = {
    source: "none",
    finding: "Not measured yet: no registered experiment has counted how often price reaches yesterday's high or low. The levels are the map because every entry rule is written against them.",
  };
  out.retest = {
    source: "backtest",
    finding: `In ${x.id} (${x.period}), a close through yesterday's high averaged ${r(x.breakHigh.avgR)} over ${count(x.breakHigh.n)} cases and through the low ${r(x.breakLow.avgR)} over ${count(x.breakLow.n)}; a reclaim of the low ${r(x.reclaimLow.avgR)} over ${count(x.reclaimLow.n)} and a rejection at the high ${r(x.rejectHigh.avgR)} over ${count(x.rejectHigh.n)}. Every 95% range spans zero: none shows an edge, so the risk rules are what protect the account.`,
  };
  if (trades.length < MIN_SAMPLE) return out;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  if (wins.length >= MIN_SAMPLE && losses.length >= MIN_SAMPLE) {
    const w = avgOf(wins);
    const l = avgOf(losses);
    const share = Math.round((wins.length / trades.length) * 100);
    const optionWins = wins.filter((t) => isOption(t) && t.side === "long" && t.entry > 0);
    const ran = optionWins.filter((t) => t.exit / t.entry - 1 >= WIN_SHARE_MARK - 1e-9).length;
    out.room = {
      source: "yours",
      finding: `You won ${share}% of your trades, but the average win was ${money(w)} and the average loss ${money(l)}. Winning often does not pay when losses are ${(Math.abs(l) / w).toFixed(1)}× the wins; a target twice the risk turns that around. Only ${count(ran)} of your ${count(optionWins.length)} winning options were closed ${Math.round(WIN_SHARE_MARK * 100)}% or more up, so 2:1 means letting the winner reach the target.`,
      compare: { unit: "average per trade", a: { label: "Average win", value: w }, b: { label: "Average loss", value: l } },
    };
  }

  const big = losses.filter((t) => t.pnl < -RISK_PER_TRADE);
  if (big.length >= MIN_SAMPLE) {
    const total = sumOf(trades);
    const bigSum = sumOf(big);
    out.risk = {
      source: "yours",
      finding: `${count(big.length)} trades lost more than $${RISK_PER_TRADE} each, together ${money(bigSum)}. Your whole record is ${money(total)}: ${bigSum < total ? "those few trades cost more than everything" : "most of the damage came from them"}.`,
      compare: { unit: "total", a: { label: `${count(big.length)} trades over $${RISK_PER_TRADE}`, value: bigSum }, b: { label: `The other ${count(trades.length - big.length)}`, value: total - bigSum } },
    };
  }

  const deep = losses.filter((t) => isOption(t) && t.entry > 0 && 1 - t.exit / t.entry > PREMIUM_STOP);
  const shallow = losses.filter((t) => isOption(t) && t.entry > 0 && 1 - t.exit / t.entry <= PREMIUM_STOP);
  if (deep.length >= MIN_SAMPLE && shallow.length >= MIN_SAMPLE) {
    out.stop = {
      source: "yours",
      finding: `${count(deep.length)} losing options were held after they had lost more than ${Math.round(PREMIUM_STOP * 100)}% of what they cost: ${money(sumOf(deep))} in all, ${money(avgOf(deep))} each. The ${count(shallow.length)} cut sooner cost ${money(avgOf(shallow))} each. The stop sits where the chart says the trade is wrong, and −${Math.round(PREMIUM_STOP * 100)}% of the premium is the most it may cost.`,
      compare: { unit: "average per loser", a: { label: `Cut by −${Math.round(PREMIUM_STOP * 100)}%`, value: avgOf(shallow) }, b: { label: "Held past it", value: avgOf(deep) } },
    };
  }

  const quick = trades.filter((t) => holdMinutes(t) <= TIME_STOP_MINUTES);
  const slow = trades.filter((t) => holdMinutes(t) > TIME_STOP_MINUTES);
  if (quick.length >= MIN_SAMPLE && slow.length >= MIN_SAMPLE) {
    const wMed = median(wins.map(holdMinutes));
    const lMed = median(losses.map(holdMinutes));
    out.time = {
      source: "yours",
      finding: `Trades closed within ${TIME_STOP_MINUTES} minutes made ${money(sumOf(quick))} over ${count(quick.length)}; those held longer made ${money(sumOf(slow))} over ${count(slow.length)}. Your winners closed in a median ${fmtMin(wMed)} minutes, your losers in ${fmtMin(lMed)}: the losers were the ones you waited on.`,
      compare: { unit: "average per trade", a: { label: `Within ${TIME_STOP_MINUTES} min`, value: avgOf(quick) }, b: { label: "Held longer", value: avgOf(slow) } },
    };
  }

  // Days of trades by their last close, as this evidence has always been drawn (a description, not a verdict).
  const days = daily(trades);
  const breaks = judgeDays(units).breaks;
  const after = trades.filter((t) => breaks.get(t.id)?.includes("day-stop"));
  const rest = trades.filter((t) => !breaks.get(t.id)?.includes("day-stop"));
  if (days.length >= MIN_SAMPLE * 3 && after.length >= MIN_SAMPLE && rest.length >= MIN_SAMPLE) {
    const total = sumOf(trades);
    const brokenDays = new Set(after.map((t) => nyTime(t.opened_at).day)).size;
    const share = total < 0 && sumOf(after) < 0 ? Math.round((sumOf(after) / total) * 100) : null;
    out["day-stop"] = {
      source: "yours",
      finding: `On ${count(brokenDays)} of your ${count(days.length)} days you kept trading after the day was down $${DAY_LOSS_LIMIT} or after a rule was broken. Those ${count(after.length)} later trades made ${money(sumOf(after))}${share !== null && share <= 100 ? `, ${share}% of your whole record` : ""}. The first break is the signal the day is over.`,
      compare: { unit: "average per trade", a: { label: "Before that point", value: avgOf(rest) }, b: { label: "After it", value: avgOf(after) } },
    };
  }

  const calm = days.filter((d) => d.trades <= MAX_TRADES_PER_DAY);
  const busy = days.filter((d) => d.trades > MAX_TRADES_PER_DAY);
  if (calm.length >= MIN_SAMPLE && busy.length >= MIN_SAMPLE) {
    const calmAvg = calm.reduce((s, d) => s + d.pnl, 0) / calm.length;
    const busyAvg = busy.reduce((s, d) => s + d.pnl, 0) / busy.length;
    out["day-cap"] = {
      source: "yours",
      finding: `On ${count(calm.length)} days with ${MAX_TRADES_PER_DAY} trades or fewer you averaged ${money(calmAvg)} a day. On ${count(busy.length)} busier days you averaged ${money(busyAvg)} a day, ${money(busy.reduce((s, d) => s + d.pnl, 0))} in all.`,
      compare: { unit: "average per day", a: { label: `${MAX_TRADES_PER_DAY} or fewer`, value: calmAvg }, b: { label: `More than ${MAX_TRADES_PER_DAY}`, value: busyAvg } },
    };
  }

  const overnight = trades.filter((t) => isOption(t) && closeDay(t) !== nyTime(t.opened_at).day);
  const sameDay = trades.filter((t) => isOption(t) && closeDay(t) === nyTime(t.opened_at).day);
  if (overnight.length >= MIN_SAMPLE && sameDay.length >= MIN_SAMPLE) {
    const won = Math.round((overnight.filter((t) => t.pnl > 0).length / overnight.length) * 100);
    out.flat = {
      source: "yours",
      finding: `${count(overnight.length)} options held overnight made ${money(sumOf(overnight))}, and only ${won}% of them won. Options closed the same day averaged ${money(avgOf(sameDay))} each against ${money(avgOf(overnight))}.`,
      compare: { unit: "average per trade", a: { label: "Closed same day", value: avgOf(sameDay) }, b: { label: "Held overnight", value: avgOf(overnight) } },
    };
  }
  return out;
}

// ── Today ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "unknown": the journal on show is not current, so today's count and loss cannot be read from it. */
export type DayStatus = "clear" | "careful" | "stop" | "unknown";

export interface DayCheck {
  /** False when the session on show is an earlier day: today has started fresh. */
  isToday: boolean;
  /** Entries today: trades (positions, for options) closed today that were opened today, plus lots opened today and
   * still held that are not the rest of one of those positions. */
  used: number;
  /** The day's closed result, before fees. */
  net: number;
  /** Trades (positions, for options) closed today that were held longer than the time stop and lost. */
  slowLosers: number;
  /** Today's trades that broke a rule, and the numbers of the rules broken, lowest first. */
  breaks: number;
  brokenRules: number[];
  status: DayStatus;
  /** One plain line on what the status means. */
  line: string;
  /** False when the journal was not read recently enough to judge today (see `journalCheck`). */
  current: boolean;
  /** The open positions' note inside `line` (see `openNote`), on its own for a page that shows it as a caution; empty
   * or absent when there is none. */
  openLine?: string;
}

/** When the journal was last read, to judge whether today can be read from it. Absent: not judged (tests, previews). */
export interface JournalAge {
  asOf: string | null | undefined;
  now: Date;
}

const nyHm = new Intl.DateTimeFormat("en-AU", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const nyDay = new Intl.DateTimeFormat("en-AU", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" });

/** "1 h 20 min", "2 days": how long ago, in words. */
function agoWords(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
  const days = Math.round(min / 1440);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** The journal's read time in milliseconds, or NaN when it has none. */
function readMs(asOf: string | null | undefined): number {
  return typeof asOf === "string" ? Date.parse(asOf) : NaN;
}

/** "10:24 New York", or "Fri, 16 Oct, 17:38 New York" when it was not read today. */
function readAt(t: number, now: Date): string {
  const at = new Date(t);
  return nyDay.format(at) === nyDay.format(now) ? `${nyHm.format(at)} New York` : `${nyDay.format(at)}, ${nyHm.format(at)} New York`;
}

/** When a journal that is not current was read, in words; the sentence's subject is "Your Webull trades". */
function staleRead(asOf: string | null | undefined, now: Date): string {
  const t = readMs(asOf);
  if (!Number.isFinite(t)) return "have not been read";
  if (t > now.getTime() + FUTURE_SLACK_MIN * 60_000) return `carry a read time in the future (${readAt(t, now)})`;
  return `were last read ${agoWords(now.getTime() - t)} ago (${readAt(t, now)})`;
}

/** The line for a journal that is not current: when it was read, and what to do instead of trusting the meters. */
function staleLine(asOf: string | null | undefined, now: Date): string {
  return `Your Webull trades ${staleRead(asOf, now)}: today's count and loss may be missing. Check Webull before an entry.`;
}

/** Say when a current journal read the broker: a trade placed since is not in it yet. */
function readNote(journal: JournalAge | undefined): string {
  if (!journal) return "";
  const t = readMs(journal.asOf);
  return Number.isFinite(t) ? ` Trades read at ${readAt(t, journal.now)}.` : "";
}

/** A read stamped this far past the clock is not believed: the clocks disagree, or the stamp is wrong. */
const FUTURE_SLACK_MIN = 5;
/** After the close, the session's last reads must be in: the sync's last read is due by 16:00, so 15:15 at the latest. */
const LAST_READ_NY_MIN = 15 * 60 + 15;

/**
 * Whether today can be judged from a journal read at `asOf`. Stricter than the feed pill (`journalCheck`), because
 * here a missing read turns into "OK to trade": in the session the read must be under INTRADAY_MAX_AGE_MIN old with no
 * opening grace; after the close on a weekday it must include the session's last reads; a stamp in the future is not
 * believed. Outside those, the evening sync's slot decides, as for the pill (a slot still running counts as current).
 */
export function journalCurrent(asOf: string | null | undefined, now: Date): boolean {
  const t = readMs(asOf);
  const n = now.getTime();
  if (!Number.isFinite(t) || t > n + FUTURE_SLACK_MIN * 60_000) return false;
  if (inUsSession(n)) return n - t <= INTRADAY_MAX_AGE_MIN * 60_000;
  const state = journalCheck(asOf, n).state;
  if (state !== "ok" && state !== "due") return false;
  const wall = new Date(n + etOffsetMin(n) * 60_000);
  const dow = wall.getUTCDay();
  const minute = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  if (dow >= 1 && dow <= 5 && minute >= 16 * 60) return t >= n - (minute - LAST_READ_NY_MIN) * 60_000;
  return true;
}

/** A day meter's tone when the journal may be missing trades: only a limit already reached is certain. */
export function meterToneFor<T extends string>(tone: T, check: Pick<DayCheck, "current">): T | "neutral" {
  return check.current || tone === "bad" ? tone : "neutral";
}

/**
 * The open positions' note: the journal has no current price, so an open loss is not in the day's figure here, but
 * rule 7 counts it ("Open losses count too"). A caution to check the broker; the count itself is unchanged.
 */
function openNote(view: SessionView | null): string {
  const n = view?.open.length ?? 0;
  if (!n) return "";
  const rule = RULES.find((r) => r.id === "day-stop")!.n;
  return ` ${n} position${n === 1 ? "" : "s"} open: ${n === 1 ? "its" : "their"} open loss isn't priced here, and rule ${rule} counts it; check Webull.`;
}

/** Today's trading measured against the day rules. */
export function dayCheck(view: SessionView | null, journal?: JournalAge): DayCheck {
  const judged = baseCheck(view);
  if (journal && !journalCurrent(journal.asOf, journal.now)) {
    // A journal that is not current can only be missing trades, so a stop it already shows stands.
    if (judged.status === "stop") return { ...judged, current: false, line: `${judged.line} Your Webull trades ${staleRead(journal.asOf, journal.now)}.` };
    // Anything short of a stop cannot be judged: no trade from today may only mean today was not read yet.
    return { ...judged, status: "unknown", current: false, line: staleLine(journal.asOf, journal.now) + openNote(view), openLine: openNote(view).trim() };
  }
  const open = judged.status === "stop" ? "" : openNote(view);
  return { ...judged, line: judged.line + open + readNote(journal), openLine: open.trim() };
}

/** A lot and a trade of one contract: the same symbol, kind, strike and expiry. */
function sameContract(t: Pick<Trade, "symbol" | "kind" | "strike" | "expiry">, l: Pick<Lot, "symbol" | "kind" | "strike" | "expiry">): boolean {
  return t.symbol === l.symbol && t.kind === l.kind && (t.strike ?? null) === (l.strike ?? null) && (t.expiry ?? null) === (l.expiry ?? null);
}

function baseCheck(view: SessionView | null): DayCheck {
  if (!view || !view.isToday) {
    return { isToday: false, used: 0, net: 0, slowLosers: 0, breaks: 0, brokenRules: [], status: "clear", current: true, line: `A fresh day: ${MAX_TRADES_PER_DAY} trades and $${DAY_LOSS_LIMIT} of room.` };
  }
  const openedToday = (iso: string | null | undefined) => !!iso && nyTime(iso).day === view.day;
  // Trades, not pieces, and entries, not trades: each distinct buy fill of a position is one entry, so a buy sold in
  // two halves is one and an add while holding is another.
  const units = tradeUnits(view.trades.filter((t) => openedToday(t.opened_at)));
  const { verdicts, breaks: found } = judgeDays(units);
  // Held buy fills as the journal lists them, not merged into holdings: two buys of one contract are two entries.
  const lots = view.lots.filter((l) => openedToday(l.opened_at));
  const ofLot = (l: Lot) => verdicts.filter((v) => v.unit.position && l.side === "long" && sameContract(v.unit.unit, l));
  // A lot still held that was bought in the same fill as a piece already sold is that fill's rest: already counted.
  const counted = (l: Lot) => ofLot(l).some((v) => v.entries.includes(Date.parse(l.opened_at!)));
  const used = verdicts.reduce((s, v) => s + v.entries.length, 0) + lots.filter((l) => !counted(l)).length;
  const net = view.summary.net;
  const slowLosers = tradeUnits(view.trades)
    .map(judgeUnit)
    .filter((v) => v.ids.includes("time")).length;
  const broken = new Set<string>([...found.values()].flat());
  if (used > MAX_TRADES_PER_DAY) broken.add("day-cap");
  // A lot still held already shows its premium. Held with a position of its contract (bought while it was open, or in
  // one of its fills), it adds to the most that position held at once; on its own it is judged alone. Over the cap
  // either way, rule 4 is broken before it closes.
  const premium = (l: Lot) => l.entry * 100 * l.qty;
  const held = new Map<TradeVerdict, { at: number; cost: number }[]>();
  const alone: Lot[] = [];
  for (const l of lots) {
    if (l.kind === "stock" || l.side !== "long") continue;
    const at = Date.parse(l.opened_at!);
    const v = ofLot(l).find((x) => x.entries.includes(at) || (Date.parse(x.unit.unit.opened_at) <= at && at < Date.parse(x.unit.unit.closed_at)));
    if (v) held.set(v, [...(held.get(v) ?? []), { at, cost: premium(l) }]);
    else alone.push(l);
  }
  // Lots held on their own, one contract's together: never sold, so all of them are held at once.
  const aloneCost = new Map<string, number>();
  for (const l of alone) {
    const key = JSON.stringify([l.symbol, l.kind, l.strike ?? null, l.expiry ?? null]);
    aloneCost.set(key, (aloneCost.get(key) ?? 0) + premium(l));
  }
  if ([...aloneCost.values()].some((c) => c > MAX_PREMIUM + 1e-9) || [...held].some(([v, hs]) => peakPremium(v.unit.pieces, hs) > MAX_PREMIUM + 1e-9)) broken.add("risk");
  const brokenRules = RULES.filter((r) => broken.has(r.id)).map((r) => r.n);
  const breaks = found.size;
  let status: DayStatus = "clear";
  let line = `${MAX_TRADES_PER_DAY - used} trade${MAX_TRADES_PER_DAY - used === 1 ? "" : "s"} and ${money(DAY_LOSS_LIMIT + Math.min(0, net)).replace("+⁠", "")} of room left today.`;
  if (net <= -DAY_LOSS_LIMIT || used >= MAX_TRADES_PER_DAY || brokenRules.length) {
    status = "stop";
    line =
      net <= -DAY_LOSS_LIMIT
        ? `Down ${money(net).replace("−⁠", "")} today: the day is over. Close the app.`
        : brokenRules.length
          ? `${brokenRules.length > 1 ? "Rules" : "Rule"} ${brokenRules.join(", ")} broken today: the day is over. Close the app.`
          : `${used} trades taken: that is the day's limit. No more entries.`;
  } else if (net <= -DAY_LOSS_LIMIT * 0.6 || used >= MAX_TRADES_PER_DAY - 1) {
    status = "careful";
    line = used >= MAX_TRADES_PER_DAY - 1 ? `One trade left today. Only an A+ setup.` : `Close to the day's limit: ${money(DAY_LOSS_LIMIT + net).replace("+⁠", "")} of room left.`;
  }
  return { isToday: true, used, net, slowLosers, breaks, brokenRules, status, line, current: true };
}
