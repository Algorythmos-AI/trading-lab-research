// The Overview page's arithmetic on the owner's own trades. Pure: no I/O; the clock is passed in. Built on the
// journal helpers, so every figure matches the Trades page.
import { closeDay, daily, groupBy, HOUR_ORDER, hourKey, holdMinutes, nyTime, type DayRow, type GroupRow, type Lot, type Trade } from "./journal";
import { DAY_LOSS_LIMIT, MAX_TRADES_PER_DAY, TIME_STOP_MINUTES } from "./trade-rules";

export interface PeriodTotal {
  key: "week" | "month" | "year" | "all";
  label: string;
  pnl: number;
  trades: number;
  /** The New York day the period starts on; null for all time. */
  from: string | null;
}

/** Monday of the New York week that holds `day` (YYYY-MM-DD). */
export function weekStart(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** This week, this month, this year and all time, by the New York day each trade closed on. */
export function periodTotals(trades: readonly Trade[], now: Date): PeriodTotal[] {
  const today = nyTime(now.toISOString()).day;
  const month = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const periods: PeriodTotal[] = [
    { key: "week", label: "This week", pnl: 0, trades: 0, from: weekStart(today) },
    { key: "month", label: month, pnl: 0, trades: 0, from: `${today.slice(0, 7)}-01` },
    { key: "year", label: today.slice(0, 4), pnl: 0, trades: 0, from: `${today.slice(0, 4)}-01-01` },
    { key: "all", label: "All time", pnl: 0, trades: 0, from: null },
  ];
  for (const t of trades) {
    const d = closeDay(t);
    for (const p of periods) {
      if (p.from === null || d >= p.from) {
        p.pnl += t.pnl;
        p.trades++;
      }
    }
  }
  return periods;
}

export interface RuleDay extends DayRow {
  /** True when the day stayed inside both day rules: at most the trade limit, and no worse than the day loss limit. */
  kept: boolean;
  /** Which day rule broke, if one did. */
  broke: "loss" | "count" | "both" | null;
}

/** The latest `count` trading days, oldest first, each marked kept or broken against the two day rules. */
export function ruleDays(trades: readonly Trade[], count = 20): RuleDay[] {
  return daily(trades)
    .slice(-count)
    .map((d) => {
      const loss = d.pnl <= -DAY_LOSS_LIMIT;
      const many = d.trades > MAX_TRADES_PER_DAY;
      return { ...d, kept: !loss && !many, broke: loss && many ? "both" : loss ? "loss" : many ? "count" : null };
    });
}

/** The days with a running total across just these days, for a chart of a recent stretch. */
export function withRun(days: readonly RuleDay[]): (RuleDay & { run: number })[] {
  let run = 0;
  return days.map((d) => ({ ...d, run: (run += d.pnl) }));
}

/** Trading days in a row, ending with the latest, that stayed inside the day rules. */
export function keptStreak(days: readonly RuleDay[]): number {
  let n = 0;
  for (let i = days.length - 1; i >= 0 && days[i]!.kept; i--) n++;
  return n;
}

/** What rule-keeping days made against the days that broke a rule, across `days`. */
export function keptVsBroken(days: readonly RuleDay[]): { kept: number; keptPnl: number; broken: number; brokenPnl: number } {
  const out = { kept: 0, keptPnl: 0, broken: 0, brokenPnl: 0 };
  for (const d of days) {
    if (d.kept) {
      out.kept++;
      out.keptPnl += d.pnl;
    } else {
      out.broken++;
      out.brokenPnl += d.pnl;
    }
  }
  return out;
}

export interface NextOpen {
  /** True while the regular session is open now. */
  open: boolean;
  /** Minutes until the next regular open (or until the close, while open). */
  minutes: number;
  /** The New York day of that open. */
  day: string;
}

/** The next 9:30 New York open on a weekday, or the close while the session is open. Holidays are not known here. */
export function nextOpen(now: Date): NextOpen {
  const t = nyTime(now.toISOString());
  const weekend = t.weekday === "Sat" || t.weekday === "Sun";
  if (!weekend && t.minute >= 570 && t.minute < 960) return { open: true, minutes: 960 - t.minute, day: t.day };
  let ahead = !weekend && t.minute < 570 ? 0 : 1;
  const d = new Date(`${t.day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
    ahead++;
  }
  return { open: false, minutes: ahead * 1440 + 570 - t.minute, day: d.toISOString().slice(0, 10) };
}

/** "2 d 4 h", "3 h 10 min" or "25 min". */
export function untilText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m >= 1440) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${m} min`;
}

/** Trades closed on or after `from` (YYYY-MM-DD, New York). */
export const since = (trades: readonly Trade[], from: string) => trades.filter((t) => closeDay(t) >= from);

/** The biggest winners and losers by symbol, best first: up to `n` of each, with no symbol twice. */
export function tickerEnds(trades: readonly Trade[], n = 4): GroupRow[] {
  const rows = groupBy(trades, (t) => t.symbol).filter((g) => g.pnl !== 0);
  const winners = rows.filter((g) => g.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, n);
  const losers = rows.filter((g) => g.pnl < 0).sort((a, b) => b.pnl - a.pnl).slice(-n);
  return [...winners, ...losers];
}

/** Result by the hour the trade was opened, in session order, with the best and the worst band named. */
export function hourBands(trades: readonly Trade[]): { rows: GroupRow[]; best: GroupRow | null; worst: GroupRow | null } {
  const rows = groupBy(trades, hourKey, HOUR_ORDER).filter((r) => r.trades > 0 || (r.key !== "pre" && r.key !== "post"));
  const traded = rows.filter((r) => r.trades > 0);
  const best = traded.length ? traded.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worst = traded.length ? traded.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  return { rows, best: best && best.pnl > 0 ? best : null, worst: worst && worst.pnl < 0 ? worst : null };
}

/** Trades closed inside the time stop against those held longer: the evidence behind the five-minute rule. */
export function quickVsSlow(trades: readonly Trade[]): { quick: { trades: number; pnl: number }; slow: { trades: number; pnl: number } } {
  const out = { quick: { trades: 0, pnl: 0 }, slow: { trades: 0, pnl: 0 } };
  for (const t of trades) {
    const side = holdMinutes(t) <= TIME_STOP_MINUTES ? out.quick : out.slow;
    side.trades++;
    side.pnl += t.pnl;
  }
  return out;
}

export interface ClockTrade {
  id: string;
  label: string;
  /** Minutes after midnight, New York. */
  from: number;
  to: number;
  pnl: number | null;
  /** The row it is drawn on, so that trades held at the same time do not overlap. */
  lane: number;
  /** True for a lot still held: it runs to now. */
  open: boolean;
}

/**
 * One trading day's trades as spans on the New York clock, each on the first lane free at its start, plus the day's
 * running result after each close. Open lots run to `nowMinute` (or their own start when that is unknown).
 */
export function dayClock(
  trades: readonly Trade[],
  open: readonly Lot[],
  day: string,
  nowMinute: number | null,
  labelOf: (t: Pick<Trade, "symbol" | "kind" | "strike" | "expiry">) => string,
): { items: ClockTrade[]; lanes: number; steps: { at: number; cum: number }[] } {
  const spans: Omit<ClockTrade, "lane">[] = [];
  for (const t of trades) {
    const o = nyTime(t.opened_at);
    const c = nyTime(t.closed_at);
    if (c.day !== day) continue;
    // A trade carried in from an earlier day is drawn from the open.
    spans.push({ id: t.id, label: labelOf(t), from: o.day === day ? o.minute : Math.min(570, c.minute), to: c.minute, pnl: t.pnl, open: false });
  }
  open.forEach((l, i) => {
    if (!l.opened_at) return;
    const o = nyTime(l.opened_at);
    const from = o.day === day ? o.minute : 570;
    spans.push({ id: `open-${i}`, label: labelOf(l), from, to: Math.max(from, nowMinute ?? from), pnl: null, open: true });
  });
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const ends: number[] = [];
  const items = spans.map((s) => {
    let lane = ends.findIndex((e) => e < s.from);
    if (lane === -1) lane = ends.push(0) - 1;
    ends[lane] = Math.max(s.to, s.from + 4);
    return { ...s, lane };
  });
  let cum = 0;
  const steps = items
    .filter((i) => !i.open && i.pnl !== null)
    .sort((a, b) => a.to - b.to)
    .map((i) => ({ at: i.to, cum: (cum += i.pnl ?? 0) }));
  return { items, lanes: ends.length, steps };
}
