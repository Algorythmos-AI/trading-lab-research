// The owner's own account measured against the risk limits in trade-rules.ts. Pure: no I/O; the clock is passed in.
// Every number is computed from the journal at render time, so none of the owner's results is written into the repo.
import { closeDay, daily, nyTime, sessionView, type DayRow, type JournalDoc, type Lot, type Trade } from "./journal";
import { daysWithEntries } from "./overview";
import { tradeUnits } from "./owner-positions";
import { dayCheck, DAY_LOSS_LIMIT, entriesByDay, judgeDays, MAX_PREMIUM, MAX_TRADES_PER_DAY, PREMIUM_STOP, RISK_PER_TRADE, TIME_STOP_MINUTES, type DayCheck } from "./trade-rules";

/** How many recent trading days the usage counts and the day chart cover. */
export const RECENT_SESSIONS = 20;

/**
 * Who holds a limit. Nothing on this site can place, block or cancel an order: its broker access is read only.
 * "broker": a Webull order holds it once you place it (a stop order). "flagged": the page counts it once the broker
 * reports the trade, after the fact. "you": nobody else can, before the order.
 */
export type HeldBy = "broker" | "flagged" | "you";

export interface LimitRow {
  id: string;
  /** The rule number in "Rules before every trade". */
  rule: number;
  label: string;
  setAt: string;
  /** Today's reading, already written out; null when the limit has no daily reading. */
  today: string | null;
  /** 0..1 of the limit used today, for a meter; null with no reading. */
  todayShare: number | null;
  /** Times the limit was broken over the recent sessions, and the unit counted. */
  broken: number;
  unit: "days" | "trades";
  /** The worst case behind the count, written out (e.g. the worst day). */
  worst: string | null;
  heldBy: HeldBy;
}

export interface OpenRisk {
  /** Open lots grouped by contract. */
  lots: { label: string; qty: number; cost: number; overnight: boolean; overPremium: boolean }[];
  /** What the long options open now cost: the most they can lose. */
  optionCost: number;
  /** Open option lots opened on an earlier New York day. */
  overnight: number;
  /** Stock and short lots, whose loss is not capped by what they cost. */
  uncapped: number;
}

export interface Drawdown {
  /** How far the running total of closed trades stands below its high now (zero or below). */
  now: number;
  /** The deepest it has been. */
  max: number;
  maxDay: string | null;
  /** The running total's high and the day it was set. */
  peak: number;
  peakDay: string | null;
}

export interface AccountRisk {
  check: DayCheck;
  /** The New York day today's reading is for, and whether it is today. */
  day: string | null;
  open: OpenRisk;
  limits: LimitRow[];
  /** The last RECENT_SESSIONS trading days, oldest first. */
  recent: DayRow[];
  drawdown: Drawdown;
  tradeCount: number;
}

const money0 = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const isOption = (k: Trade["kind"]) => k !== "stock";
const lotLabel = (l: Lot) => (l.kind === "stock" ? l.symbol : `${l.symbol} ${l.strike ?? ""}${l.kind === "call" ? "C" : "P"}${l.expiry ? ` ${l.expiry.slice(5)}` : ""}`);

/** Open lots: what they cost, which were held overnight and which cost more than the premium limit. */
export function openRisk(open: readonly Lot[], today: string): OpenRisk {
  const by = new Map<string, OpenRisk["lots"][number]>();
  let optionCost = 0;
  let overnight = 0;
  let uncapped = 0;
  for (const l of open) {
    const option = isOption(l.kind);
    const c = l.entry * l.qty * (option ? 100 : 1);
    const held = option && !!l.opened_at && nyTime(l.opened_at).day < today;
    if (option && l.side === "long") optionCost += c;
    else uncapped++;
    if (held) overnight++;
    const label = lotLabel(l);
    const row = by.get(label) ?? { label, qty: 0, cost: 0, overnight: false, overPremium: false };
    row.qty += l.qty;
    row.cost += c;
    row.overnight ||= held;
    row.overPremium = option && l.side === "long" && row.cost > MAX_PREMIUM + 1e-9;
    by.set(label, row);
  }
  return { lots: [...by.values()].sort((a, b) => b.cost - a.cost), optionCost, overnight, uncapped };
}

/** The running total's fall from its high, now and at its deepest, from the daily rows. */
export function drawdown(days: readonly DayRow[]): Drawdown {
  let max = 0;
  let maxDay: string | null = null;
  let peak = 0;
  let peakDay: string | null = null;
  for (const d of days) {
    if (d.dd < max) {
      max = d.dd;
      maxDay = d.day;
    }
    if (d.cum > peak) {
      peak = d.cum;
      peakDay = d.day;
    }
  }
  return { now: days.length ? days[days.length - 1]!.dd : 0, max, maxDay, peak, peakDay };
}

/**
 * Each limit with today's reading and how often it was broken over the recent sessions. Counted from the record
 * alone, the same tests the rules panel's evidence uses: a loss over the per-trade risk, premium over the cap, a long
 * option closed past the premium stop, a loser held past the time stop, a day past the loss limit or the trade cap,
 * and an option closed on a later day than it was opened.
 */
export function limitRows(trades: readonly Trade[], check: DayCheck, open: OpenRisk, todayTrades: readonly Trade[], sessions = RECENT_SESSIONS): { rows: LimitRow[]; recent: DayRow[] } {
  const recent = daily(trades).slice(-sessions);
  // The window starts at the first of the last `sessions` days with a close or an entry, so a day of entries that
  // all closed later is in it.
  const sessionDays = daysWithEntries(trades).slice(-sessions);
  const from = sessionDays[0]?.day ?? "9999";
  // The trade rules as the rules panel and the day check judge them: per trade (a position for options), a break when
  // the whole trade or any one of its pieces breaks the rule, and the cap on entries.
  const { verdicts, breaks } = judgeDays(tradeUnits(trades));
  const window = verdicts.filter((v) => closeDay(v.unit.unit) >= from);
  const has = (id: string) => window.filter((v) => breaks.get(v.unit.unit.id)?.includes(id));
  const pnlOf = (vs: readonly { unit: { unit: Trade } }[]) => vs.reduce((s, v) => s + v.unit.unit.pnl, 0);

  const bigLoss = window.filter((v) => v.loss);
  const worstTrade = window.reduce<Trade | null>((m, v) => (m === null || v.unit.unit.pnl < m.pnl ? v.unit.unit : m), null);
  const overPremium = window.filter((v) => v.premium);
  const pastStop = has("stop");
  const slow = has("time");
  const overnight = has("flat");
  const lossDays = recent.filter((d) => d.pnl <= -DAY_LOSS_LIMIT);
  const entries = entriesByDay(trades);
  // The cap is judged on the day the entries were made, which may have no close of its own.
  const entryDays = sessionDays.map((d): [string, number] => [d.day, entries.get(d.day) ?? 0]);
  const busyDays = entryDays.filter(([, c]) => c > MAX_TRADES_PER_DAY);
  const worstDay = recent.reduce<DayRow | null>((m, d) => (m === null || d.pnl < m.pnl ? d : m), null);
  const busiest = Math.max(0, ...entryDays.map(([, c]) => c));

  const today = check.isToday;
  const todayUnits = judgeDays(tradeUnits(todayTrades)).verdicts;
  const todayWorst = todayUnits.reduce<number | null>((m, v) => (m === null || v.unit.unit.pnl < m ? v.unit.unit.pnl : m), null);
  const todayMaxCost = Math.max(0, ...todayUnits.map((v) => v.peak), ...open.lots.map((l) => l.cost));
  const lossUsed = Math.max(0, -check.net);

  const rows: LimitRow[] = [
    {
      id: "day-stop",
      rule: 7,
      label: "Day loss limit",
      setAt: `−$${DAY_LOSS_LIMIT} on the day, open losses too`,
      today: today ? money0(check.net) : null,
      todayShare: today ? lossUsed / DAY_LOSS_LIMIT : null,
      broken: lossDays.length,
      unit: "days",
      worst: worstDay && worstDay.pnl < 0 ? `worst ${money0(worstDay.pnl)}` : null,
      heldBy: "flagged",
    },
    {
      id: "day-cap",
      rule: 8,
      label: "Trades a day",
      setAt: `${MAX_TRADES_PER_DAY} entries`,
      today: today ? `${check.used}` : null,
      todayShare: today ? check.used / MAX_TRADES_PER_DAY : null,
      broken: busyDays.length,
      unit: "days",
      worst: busiest > MAX_TRADES_PER_DAY ? `most ${busiest}` : null,
      heldBy: "flagged",
    },
    {
      id: "risk",
      rule: 4,
      label: "Loss on one trade",
      setAt: `$${RISK_PER_TRADE} at most`,
      today: today && todayWorst !== null ? `worst ${money0(todayWorst)}` : null,
      todayShare: today && todayWorst !== null ? Math.max(0, -todayWorst) / RISK_PER_TRADE : null,
      broken: bigLoss.length,
      unit: "trades",
      worst: worstTrade && worstTrade.pnl < 0 ? `worst ${money0(worstTrade.pnl)}` : null,
      heldBy: "flagged",
    },
    {
      id: "premium",
      rule: 4,
      label: "Premium on one option",
      setAt: `$${MAX_PREMIUM} at most`,
      today: today && todayMaxCost > 0 ? `largest ${money0(todayMaxCost)}` : null,
      todayShare: today && todayMaxCost > 0 ? todayMaxCost / MAX_PREMIUM : null,
      broken: overPremium.length,
      unit: "trades",
      worst: overPremium.length ? `largest ${money0(Math.max(...overPremium.map((v) => v.peak)))}` : null,
      heldBy: "you",
    },
    {
      id: "stop",
      rule: 5,
      label: "Stop on an option",
      setAt: `−${Math.round(PREMIUM_STOP * 100)}% of premium`,
      today: null,
      todayShare: null,
      broken: pastStop.length,
      unit: "trades",
      worst: pastStop.length ? `${money0(pnlOf(pastStop))} in all` : null,
      heldBy: "broker",
    },
    {
      id: "time",
      rule: 6,
      label: "Time stop",
      setAt: `${TIME_STOP_MINUTES} minutes`,
      today: today ? `${check.slowLosers} slow loser${check.slowLosers === 1 ? "" : "s"}` : null,
      todayShare: null,
      broken: slow.length,
      unit: "trades",
      worst: slow.length ? `${money0(pnlOf(slow))} in all` : null,
      heldBy: "flagged",
    },
    {
      id: "flat",
      rule: 9,
      label: "Flat by the close",
      setAt: "No option overnight",
      today: open.overnight > 0 ? `${open.overnight} held` : today ? "0 held" : null,
      todayShare: null,
      broken: overnight.length,
      unit: "trades",
      worst: overnight.length ? `${money0(pnlOf(overnight))} in all` : null,
      heldBy: "flagged",
    },
  ];
  return { rows, recent };
}

/** The whole account view for the Risk page. */
export function accountRisk(doc: Pick<JournalDoc, "trades" | "open"> & Partial<Pick<JournalDoc, "as_of">>, now: Date): AccountRisk {
  const view = sessionView(doc, now);
  const check = dayCheck(view, "as_of" in doc ? { asOf: doc.as_of, now } : undefined);
  const today = nyTime(now.toISOString()).day;
  const open = openRisk(doc.open ?? [], today);
  const todayTrades = view?.isToday ? view.trades.filter((t) => nyTime(t.opened_at).day === view.day) : [];
  const { rows, recent } = limitRows(doc.trades, check, open, todayTrades);
  return { check, day: view?.day ?? null, open, limits: rows, recent, drawdown: drawdown(daily(doc.trades)), tradeCount: doc.trades.length };
}
