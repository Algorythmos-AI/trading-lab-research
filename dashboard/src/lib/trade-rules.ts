// The rules before every trade, and the evidence behind each one. Pure: no I/O; any clock is passed in.
// The thresholds live here; every number about the owner's own trading is measured from the journal at render time,
// so none of it is written into this repository. The market numbers are EXP-0023's, held equal to its record by a test.
import { INTRADAY_MAX_AGE_MIN, inUsSession, journalCheck } from "./feeds";
import { etOffsetMin } from "./freshness";
import { closeDay, daily, holdMinutes, nyTime, type SessionView, type Trade } from "./journal";

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

/** The owner's worked example of a plan written before entry: premium, the planned loss and the target as shares of it. */
export const PLAN_EXAMPLE = { premium: 165, stopShare: 0.1, targetShare: 0.2 } as const;

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

/**
 * The rules each trade broke, keyed by trade id; a trade that kept them all is left out. Judged from the record alone:
 * the premium paid and the loss (4), a loss past the premium stop (5), a loser held past the time stop (6), an entry
 * after the day was down the limit or after an earlier break (7), the entries past the day's cap (8), and an option
 * held overnight (9). The setup rules (1 to 3) are yours to check. Kept apart from losing: a winner can break a rule
 * and a loser can keep them all.
 */
export function tradeBreaks(trades: readonly Trade[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byDay = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = nyTime(t.opened_at).day;
    const list = byDay.get(d) ?? [];
    list.push(t);
    byDay.set(d, list);
  }
  for (const list of byDay.values()) {
    const day = [...list].sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id));
    const own = new Map<Trade, string[]>();
    for (const t of day) {
      const ids: string[] = [];
      const option = isOption(t);
      if (t.pnl < -RISK_PER_TRADE || (option && t.side === "long" && t.entry * t.multiplier * t.qty > MAX_PREMIUM + 1e-9)) ids.push("risk");
      if (option && t.side === "long" && t.entry > 0 && 1 - t.exit / t.entry > PREMIUM_STOP + 1e-9) ids.push("stop");
      if (t.pnl < 0 && holdMinutes(t) > TIME_STOP_MINUTES) ids.push("time");
      if (option && closeDay(t) !== nyTime(t.opened_at).day) ids.push("flat");
      own.set(t, ids);
    }
    day.forEach((t, i) => {
      const ids = [...own.get(t)!];
      if (i >= MAX_TRADES_PER_DAY) ids.push("day-cap");
      const at = Date.parse(t.opened_at);
      const before = day.filter((p) => p !== t && Date.parse(p.closed_at) <= at);
      // An entry past the cap is itself a break, so every entry after the first one past it is past rule 7 too.
      if (i > MAX_TRADES_PER_DAY || before.reduce((s, p) => s + p.pnl, 0) <= -DAY_LOSS_LIMIT || before.some((p) => own.get(p)!.length > 0)) ids.push("day-stop");
      if (ids.length) out.set(t.id, ids);
    });
  }
  return out;
}

export interface BreakSummary {
  sessions: number;
  /** Trades that broke at least one rule. */
  trades: number;
  /** Breaks per rule id. */
  byRule: Record<string, number>;
  /** What the trades that broke a rule made, and what the trades that kept them all made. */
  brokeNet: number;
  keptNet: number;
  keptLosers: number;
  keptLosersNet: number;
}

/** The rule breaks of the last `sessions` trading days (New York, by the day opened). */
export function breakSummary(trades: readonly Trade[], sessions = 20): BreakSummary {
  const days = [...new Set(trades.map((t) => nyTime(t.opened_at).day))].sort().slice(-sessions);
  const keep = new Set(days);
  const recent = trades.filter((t) => keep.has(nyTime(t.opened_at).day));
  const breaks = tradeBreaks(recent);
  const byRule: Record<string, number> = {};
  for (const ids of breaks.values()) for (const id of ids) byRule[id] = (byRule[id] ?? 0) + 1;
  const broke = recent.filter((t) => breaks.has(t.id));
  const kept = recent.filter((t) => !breaks.has(t.id));
  const keptLosers = kept.filter((t) => t.pnl < 0);
  return { sessions: days.length, trades: broke.length, byRule, brokeNet: sumOf(broke), keptNet: sumOf(kept), keptLosers: keptLosers.length, keptLosersNet: sumOf(keptLosers) };
}

/** What the record says about each rule, keyed by rule id. A rule is missing when its sample is too small. */
export function ruleEvidence(trades: readonly Trade[]): Record<string, Evidence> {
  const out: Record<string, Evidence> = {};
  const x = EXP_0023;
  const r = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(4)}R`;
  out.levels = {
    source: "none",
    finding: "Not measured yet: no registered experiment has counted how often price reaches yesterday's high or low. The levels are the map because every entry rule is written against them.",
  };
  out.retest = {
    source: "backtest",
    finding: `In ${x.id} (${x.period}), a close through yesterday's high averaged ${r(x.breakHigh.avgR)} over ${count(x.breakHigh.n)} cases and through the low ${r(x.breakLow.avgR)} over ${count(x.breakLow.n)}; a reclaim of the low ${r(x.reclaimLow.avgR)} over ${count(x.reclaimLow.n)} and a rejection at the high ${r(x.rejectHigh.avgR)} over ${count(x.rejectHigh.n)}. Every 95% range spans zero: no entry here is an edge, so the risk rules are what protect the account.`,
  };
  if (trades.length < MIN_SAMPLE) return out;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  if (wins.length >= MIN_SAMPLE && losses.length >= MIN_SAMPLE) {
    const w = avgOf(wins);
    const l = avgOf(losses);
    const share = Math.round((wins.length / trades.length) * 100);
    const optionWins = wins.filter((t) => isOption(t) && t.side === "long" && t.entry > 0);
    const ran = optionWins.filter((t) => t.exit / t.entry - 1 >= PLAN_EXAMPLE.targetShare - 1e-9).length;
    out.room = {
      source: "yours",
      finding: `You won ${share}% of your trades, but the average win was ${money(w)} and the average loss ${money(l)}. Winning often does not pay when losses are ${(Math.abs(l) / w).toFixed(1)}× the wins; a target twice the risk turns that around. Only ${count(ran)} of your ${count(optionWins.length)} winning options were closed ${Math.round(PLAN_EXAMPLE.targetShare * 100)}% or more up, so 2:1 means letting the winner reach the target.`,
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

  const days = daily(trades);
  const breaks = tradeBreaks(trades);
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
  /** Entries today: trades closed today that were opened today, plus lots opened today and still held. */
  used: number;
  /** The day's closed result, before fees. */
  net: number;
  /** Trades closed today that were held longer than the time stop and lost. */
  slowLosers: number;
  /** Today's trades that broke a rule, and the numbers of the rules broken, lowest first. */
  breaks: number;
  brokenRules: number[];
  status: DayStatus;
  /** One plain line on what the status means. */
  line: string;
  /** False when the journal was not read recently enough to judge today (see `journalCheck`). */
  current: boolean;
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

/** The open positions' note: the journal has no current price, so an open loss is not in the day's figure. */
function openNote(view: SessionView | null): string {
  const n = view?.open.length ?? 0;
  return n ? ` ${n} position${n === 1 ? "" : "s"} still open: an open loss is not counted until it closes.` : "";
}

/** Today's trading measured against the day rules. */
export function dayCheck(view: SessionView | null, journal?: JournalAge): DayCheck {
  const judged = baseCheck(view);
  if (journal && !journalCurrent(journal.asOf, journal.now)) {
    // A journal that is not current can only be missing trades, so a stop it already shows stands.
    if (judged.status === "stop") return { ...judged, current: false, line: `${judged.line} Your Webull trades ${staleRead(journal.asOf, journal.now)}.` };
    // Anything short of a stop cannot be judged: no trade from today may only mean today was not read yet.
    return { ...judged, status: "unknown", current: false, line: staleLine(journal.asOf, journal.now) + openNote(view) };
  }
  return { ...judged, line: judged.line + (judged.status === "stop" ? "" : openNote(view)) + readNote(journal) };
}

function baseCheck(view: SessionView | null): DayCheck {
  if (!view || !view.isToday) {
    return { isToday: false, used: 0, net: 0, slowLosers: 0, breaks: 0, brokenRules: [], status: "clear", current: true, line: `A fresh day: ${MAX_TRADES_PER_DAY} trades and $${DAY_LOSS_LIMIT} of room.` };
  }
  const openedToday = (iso: string | null | undefined) => !!iso && nyTime(iso).day === view.day;
  const used = view.trades.filter((t) => openedToday(t.opened_at)).length + view.open.filter((l) => openedToday(l.opened_at)).length;
  const net = view.summary.net;
  const slowLosers = view.trades.filter((t) => t.pnl < 0 && holdMinutes(t) > TIME_STOP_MINUTES).length;
  const found = tradeBreaks(view.trades.filter((t) => openedToday(t.opened_at)));
  const broken = new Set<string>([...found.values()].flat());
  if (used > MAX_TRADES_PER_DAY) broken.add("day-cap");
  // A lot still held already shows its premium: one over the cap has broken rule 4 before it closes.
  if (view.open.some((l) => openedToday(l.opened_at) && l.kind !== "stock" && l.side === "long" && l.entry * 100 * l.qty > MAX_PREMIUM + 1e-9)) broken.add("risk");
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
