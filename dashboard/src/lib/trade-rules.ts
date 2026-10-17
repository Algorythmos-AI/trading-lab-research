// The rules before every trade, and the evidence behind each one. Pure: no I/O; any clock is passed in.
// The thresholds live here; every number about the owner's own trading is measured from the journal at render time,
// so none of it is written into this repository. The market numbers are backtest statistics of the levels engine.
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

export type RuleGroup = "setup" | "risk" | "day";

export interface Rule {
  n: number;
  id: string;
  group: RuleGroup;
  /** The rule as a short command. */
  title: string;
  /** One line on how to apply it. */
  detail: string;
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
    detail: "Yesterday's, last week's and last month's highs and lows. No level close by, no trade.",
  },
  {
    n: 2,
    id: "retest",
    group: "setup",
    title: "Break, retest, then enter",
    detail: "A candle closes through the level, comes back to it and closes holding it. Never buy the first cross.",
  },
  {
    n: 3,
    id: "room",
    group: "setup",
    title: `Room of ${MIN_ROOM_MULTIPLE}× your stop to the next level`,
    detail: "The next level is the target. Closer than twice the stop away? Skip it.",
  },
  {
    n: 4,
    id: "risk",
    group: "risk",
    title: `Risk $${RISK_PER_TRADE} at most`,
    detail: `Premium of $${MAX_PREMIUM} or less, so the stop costs no more than $${RISK_PER_TRADE}.`,
  },
  {
    n: 5,
    id: "stop",
    group: "risk",
    title: `Stop at −${Math.round(PREMIUM_STOP * 100)}% or a close back through the level`,
    detail: "Whichever comes first. Set it before you buy and never move it down.",
  },
  {
    n: 6,
    id: "time",
    group: "risk",
    title: `Not working in ${TIME_STOP_MINUTES} minutes? Out.`,
    detail: "A trade that has not moved your way is a loser that has not finished yet.",
  },
  {
    n: 7,
    id: "day-stop",
    group: "day",
    title: `Down $${DAY_LOSS_LIMIT} on the day? Done.`,
    detail: "Open losses count too. Close the app; no trade to win it back.",
  },
  {
    n: 8,
    id: "day-cap",
    group: "day",
    title: `${MAX_TRADES_PER_DAY} trades a day, no more`,
    detail: "Every entry counts, the winners too.",
  },
  {
    n: 9,
    id: "flat",
    group: "day",
    title: "Flat by the close",
    detail: "No option is held overnight.",
  },
];

// ── Evidence ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Evidence {
  /** One or two plain sentences with the numbers in them. */
  finding: string;
  /** Where the numbers come from. */
  source: "yours" | "backtest";
  /** Two sides for a small bar pair. */
  compare?: { unit: string; a: { label: string; value: number }; b: { label: string; value: number } };
}

/**
 * Backtest statistics of the levels engine (hourly and daily bars of 10 large names), stock moves in R before option
 * costs. SAFE statistics only: counts, shares and R-multiples.
 */
export const BACKTEST = {
  reachLevel: { pctLow: 87, pctHigh: 91, period: "daily bars, 10 names, 2 years to Oct 2026" },
  cross: { n: 1183, avgR: -0.005 },
  retestHolds: { n: 546, avgR: 0.012, stoppedPct: 38 },
  retestHoldsHigh: { n: 277, avgR: 0.068 },
  retestFails: { n: 185, stoppedPct: 55 },
  retestPeriod: "hourly bars, 10 names, Mar to Oct 2026",
  insideExpectedMovePct: 85,
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

/** What the record says about each rule, keyed by rule id. A rule is missing when its sample is too small. */
export function ruleEvidence(trades: readonly Trade[]): Record<string, Evidence> {
  const out: Record<string, Evidence> = {};
  const b = BACKTEST;
  out.levels = {
    source: "backtest",
    finding: `Price reached yesterday's high or low on ${b.reachLevel.pctLow}–${b.reachLevel.pctHigh}% of days (${b.reachLevel.period}). The levels are reliable targets, which is why they are the map.`,
  };
  out.retest = {
    source: "backtest",
    finding: `Entering on the first hourly close through yesterday's high or low averaged ${b.cross.avgR.toFixed(3)}R over ${count(b.cross.n)} trades: no edge. A retest that held did a little better (${b.retestHolds.avgR >= 0 ? "+" : ""}${b.retestHolds.avgR.toFixed(3)}R over ${count(b.retestHolds.n)}; +${b.retestHoldsHigh.avgR.toFixed(2)}R above yesterday's high), and a retest that failed was stopped out ${b.retestFails.stoppedPct}% of the time against ${b.retestHolds.stoppedPct}%. Neither is a proven edge (${b.retestPeriod}): the retest filters out bad entries, and the risk rules are what protect the account.`,
  };
  if (trades.length < MIN_SAMPLE) return out;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  if (wins.length >= MIN_SAMPLE && losses.length >= MIN_SAMPLE) {
    const w = avgOf(wins);
    const l = avgOf(losses);
    const share = Math.round((wins.length / trades.length) * 100);
    out.room = {
      source: "yours",
      finding: `You won ${share}% of your trades, but the average win was ${money(w)} and the average loss ${money(l)}. Winning often does not pay when losses are ${(Math.abs(l) / w).toFixed(1)}× the wins; a target twice the stop away turns that around.`,
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
      finding: `${count(deep.length)} losing options were held after they had lost more than ${Math.round(PREMIUM_STOP * 100)}% of what they cost: ${money(sumOf(deep))} in all, ${money(avgOf(deep))} each. The ${count(shallow.length)} cut sooner cost ${money(avgOf(shallow))} each.`,
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
  const worst = [...days].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  const replay = replayDayStop(trades);
  if (days.length >= MIN_SAMPLE * 3 && worst[worst.length - 1]!.pnl < -DAY_LOSS_LIMIT) {
    const total = sumOf(trades);
    const worstSum = worst.reduce((s, d) => s + d.pnl, 0);
    out["day-stop"] = {
      source: "yours",
      finding: `Your ${worst.length} worst days lost ${money(worstSum)} between them; the other ${count(days.length - worst.length)} days together came to ${money(total - worstSum)}. A bad day is what sinks the account, and on those days the losses kept coming after the first −$${DAY_LOSS_LIMIT}. ${replay.skippedNet < 0 ? `Counting only closed trades, stopping there would have saved ${money(-replay.skippedNet).replace("+\u2060", "")}; the rest came from losers left open, so count open losses too.` : "Counting only closed trades would not have stopped it: the damage came from losers left open, so count open losses too."}`,
      compare: { unit: "total", a: { label: `Other ${count(days.length - worst.length)} days`, value: total - worstSum }, b: { label: `${worst.length} worst days`, value: worstSum } },
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

export type DayStatus = "clear" | "careful" | "stop";

export interface DayCheck {
  /** False when the session on show is an earlier day: today has started fresh. */
  isToday: boolean;
  /** Entries today: trades closed today that were opened today, plus lots opened today and still held. */
  used: number;
  /** The day's closed result, before fees. */
  net: number;
  /** Trades closed today that were held longer than the time stop and lost. */
  slowLosers: number;
  status: DayStatus;
  /** One plain line on what the status means. */
  line: string;
}

/** Today's trading measured against the day rules. */
export function dayCheck(view: SessionView | null): DayCheck {
  if (!view || !view.isToday) {
    return { isToday: false, used: 0, net: 0, slowLosers: 0, status: "clear", line: `A fresh day: ${MAX_TRADES_PER_DAY} trades and $${DAY_LOSS_LIMIT} of room.` };
  }
  const openedToday = (iso: string | null | undefined) => !!iso && nyTime(iso).day === view.day;
  const used = view.trades.filter((t) => openedToday(t.opened_at)).length + view.open.filter((l) => openedToday(l.opened_at)).length;
  const net = view.summary.net;
  const slowLosers = view.trades.filter((t) => t.pnl < 0 && holdMinutes(t) > TIME_STOP_MINUTES).length;
  let status: DayStatus = "clear";
  let line = `${MAX_TRADES_PER_DAY - used} trade${MAX_TRADES_PER_DAY - used === 1 ? "" : "s"} and ${money(DAY_LOSS_LIMIT + Math.min(0, net)).replace("+⁠", "")} of room left today.`;
  if (net <= -DAY_LOSS_LIMIT || used >= MAX_TRADES_PER_DAY) {
    status = "stop";
    line = net <= -DAY_LOSS_LIMIT ? `Down ${money(net).replace("−⁠", "")} today: the day is over. Close the app.` : `${used} trades taken: that is the day's limit. No more entries.`;
  } else if (net <= -DAY_LOSS_LIMIT * 0.6 || used >= MAX_TRADES_PER_DAY - 1) {
    status = "careful";
    line = used >= MAX_TRADES_PER_DAY - 1 ? `One trade left today. Only an A+ setup.` : `Close to the day's limit: ${money(DAY_LOSS_LIMIT + net).replace("+⁠", "")} of room left.`;
  }
  return { isToday: true, used, net, slowLosers, status, line };
}
