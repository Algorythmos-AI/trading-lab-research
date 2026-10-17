// The trade journal's arithmetic. Pure: no I/O; any clock is passed in. Every number on the Trades page comes from
// here, from the closed trades the publisher matched (first in, first out) out of the broker's filled orders.
import type { JournalDoc, Lot, Trade } from "./journal.types";

export type { JournalDoc, Lot, Trade };

const NY = "America/New_York";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface NyTime {
  /** YYYY-MM-DD in New York. */
  day: string;
  /** Minutes after midnight in New York. */
  minute: number;
  weekday: string;
}

const nyCache = new Map<string, NyTime>();

/** A trade time as New York sees it: the trading day, the minute of that day and the weekday. */
export function nyTime(iso: string): NyTime {
  const hit = nyCache.get(iso);
  if (hit) return hit;
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const out = { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), weekday: String(p.weekday) };
  if (nyCache.size > 50_000) nyCache.clear();
  nyCache.set(iso, out);
  return out;
}

/** The New York day a trade closed on: the day its result is booked to. */
export const closeDay = (t: Trade) => nyTime(t.closed_at).day;

/** How long the trade was held, in minutes. */
export function holdMinutes(t: Trade): number {
  return Math.max(0, (Date.parse(t.closed_at) - Date.parse(t.opened_at)) / 60_000);
}

/** Calendar days from the day it was opened (New York) to its expiry; null for shares. 0 is a same-day option. */
export function daysToExpiry(t: Trade): number | null {
  if (!t.expiry) return null;
  const open = Date.parse(`${nyTime(t.opened_at).day}T00:00:00Z`);
  const exp = Date.parse(`${t.expiry}T00:00:00Z`);
  return Number.isFinite(open) && Number.isFinite(exp) ? Math.round((exp - open) / 86_400_000) : null;
}

/** "SPY 759 put · 19 Oct" or "GRAB shares". */
export function contractLabel(t: Pick<Trade, "symbol" | "kind" | "strike" | "expiry">): string {
  if (t.kind === "stock") return `${t.symbol} shares`;
  const strike = isNum(t.strike) ? `${Number(t.strike.toFixed(2))}` : "";
  const exp = t.expiry ? ` · ${shortDay(t.expiry)}` : "";
  return `${t.symbol} ${strike} ${t.kind}${exp}`;
}

// ── Filters ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Period = "all" | "30d" | "90d" | "ytd" | `${number}`;

export interface Filter {
  period: Period;
  symbol: string | null;
  kind: "call" | "put" | "stock" | null;
}

export const ALL: Filter = { period: "all", symbol: null, kind: null };

/** Reads the page's address into a filter. Anything it does not recognise falls back to "everything". */
export function parseFilter(q: Record<string, string | string[] | undefined>): Filter {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const p = one(q.p);
  const period: Period = p === "30d" || p === "90d" || p === "ytd" || (p !== undefined && /^20\d\d$/.test(p)) ? (p as Period) : "all";
  const s = one(q.s);
  const symbol = s && /^[A-Z][A-Z0-9.]{0,9}$/.test(s) ? s : null;
  const k = one(q.k);
  const kind = k === "call" || k === "put" || k === "stock" ? k : null;
  return { period, symbol, kind };
}

/** The address for a filter, keeping only what differs from "everything". */
export function filterHref(f: Filter, base = "/trades"): string {
  const q = new URLSearchParams();
  if (f.period !== "all") q.set("p", f.period);
  if (f.symbol) q.set("s", f.symbol);
  if (f.kind) q.set("k", f.kind);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** The trades a filter keeps, oldest close first. */
export function applyFilter(trades: readonly Trade[], f: Filter, now: Date): Trade[] {
  const today = nyTime(now.toISOString()).day;
  let from: string | null = null;
  let to: string | null = null;
  if (f.period === "30d" || f.period === "90d") {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (f.period === "30d" ? 30 : 90));
    from = d.toISOString().slice(0, 10);
  } else if (f.period === "ytd") {
    from = `${today.slice(0, 4)}-01-01`;
  } else if (/^20\d\d$/.test(f.period)) {
    from = `${f.period}-01-01`;
    to = `${f.period}-12-31`;
  }
  return sortByClose(
    trades.filter((t) => {
      if (f.symbol && t.symbol !== f.symbol) return false;
      if (f.kind && t.kind !== f.kind) return false;
      const d = closeDay(t);
      return (from === null || d >= from) && (to === null || d <= to);
    }),
  );
}

export function sortByClose(trades: readonly Trade[]): Trade[] {
  return [...trades].sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at) || a.id.localeCompare(b.id));
}

/** The years trades closed in, newest first. */
export function yearsOf(trades: readonly Trade[]): string[] {
  return [...new Set(trades.map((t) => closeDay(t).slice(0, 4)))].sort().reverse();
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Summary {
  trades: number;
  net: number;
  wins: number;
  losses: number;
  /** Share of trades that made money, 0..1; null with no trades. */
  winRate: number | null;
  grossWin: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Average win over the size of the average loss. */
  payoff: number | null;
  /** Everything won over everything lost. Above 1 makes money. */
  profitFactor: number | null;
  /** Average result per trade. */
  expectancy: number | null;
  best: Trade | null;
  worst: Trade | null;
  /** The deepest fall of the running total below its earlier high, in dollars (zero or below). */
  maxDrawdown: number;
  /** Most losing trades in a row. */
  lossStreak: number;
  days: number;
  greenDays: number;
  bestDay: { day: string; pnl: number } | null;
  worstDay: { day: string; pnl: number } | null;
  first: string | null;
  last: string | null;
}

export function summarize(trades: readonly Trade[]): Summary {
  const sorted = sortByClose(trades);
  let net = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let best: Trade | null = null;
  let worst: Trade | null = null;
  let streak = 0;
  let lossStreak = 0;
  for (const t of sorted) {
    net += t.pnl;
    if (t.pnl > 0) {
      wins++;
      grossWin += t.pnl;
      streak = 0;
    } else if (t.pnl < 0) {
      losses++;
      grossLoss += t.pnl;
      streak++;
      lossStreak = Math.max(lossStreak, streak);
    }
    if (!best || t.pnl > best.pnl) best = t;
    if (!worst || t.pnl < worst.pnl) worst = t;
  }
  const days = daily(sorted);
  const n = sorted.length;
  return {
    trades: n,
    net,
    wins,
    losses,
    winRate: n ? wins / n : null,
    grossWin,
    grossLoss,
    avgWin: wins ? grossWin / wins : null,
    avgLoss: losses ? grossLoss / losses : null,
    payoff: wins && losses ? grossWin / wins / Math.abs(grossLoss / losses) : null,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    expectancy: n ? net / n : null,
    best,
    worst,
    maxDrawdown: Math.min(0, ...days.map((d) => d.dd)),
    lossStreak,
    days: days.length,
    greenDays: days.filter((d) => d.pnl > 0).length,
    bestDay: days.length ? days.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null,
    worstDay: days.length ? days.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,
    first: days[0]?.day ?? null,
    last: days.at(-1)?.day ?? null,
  };
}

// ── Series ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DayRow {
  day: string;
  pnl: number;
  trades: number;
  wins: number;
  /** The running total after this day. */
  cum: number;
  /** How far the running total stands below its earlier high (zero or below). */
  dd: number;
}

/** One row per New York day with a closed trade, oldest first, with the running total and its fall from the high. */
export function daily(trades: readonly Trade[]): DayRow[] {
  const by = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const d = closeDay(t);
    const row = by.get(d) ?? { pnl: 0, trades: 0, wins: 0 };
    row.pnl += t.pnl;
    row.trades++;
    if (t.pnl > 0) row.wins++;
    by.set(d, row);
  }
  let cum = 0;
  let peak = 0;
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, r]) => {
      cum += r.pnl;
      peak = Math.max(peak, cum);
      return { day, ...r, cum, dd: cum - peak };
    });
}

export interface GroupRow {
  key: string;
  label: string;
  trades: number;
  pnl: number;
  winRate: number;
  avg: number;
}

/** Totals per group, in `order` when it is given (groups with no trades are kept, empty), else by result. */
export function groupBy(trades: readonly Trade[], keyOf: (t: Trade) => string | null, order?: readonly { key: string; label: string }[]): GroupRow[] {
  const by = new Map<string, { trades: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const k = keyOf(t);
    if (k === null) continue;
    const row = by.get(k) ?? { trades: 0, pnl: 0, wins: 0 };
    row.trades++;
    row.pnl += t.pnl;
    if (t.pnl > 0) row.wins++;
    by.set(k, row);
  }
  const make = (key: string, label: string): GroupRow => {
    const r = by.get(key) ?? { trades: 0, pnl: 0, wins: 0 };
    return { key, label, trades: r.trades, pnl: r.pnl, winRate: r.trades ? r.wins / r.trades : 0, avg: r.trades ? r.pnl / r.trades : 0 };
  };
  if (order) return order.map((o) => make(o.key, o.label));
  return [...by.keys()].map((k) => make(k, k)).sort((a, b) => a.pnl - b.pnl);
}

export const MONTH = (t: Trade) => closeDay(t).slice(0, 7);
export const KIND_ORDER = [
  { key: "call", label: "Calls" },
  { key: "put", label: "Puts" },
  { key: "stock", label: "Shares" },
] as const;

/** When in the New York session the trade was opened, in bands. */
export const HOUR_ORDER = [
  { key: "pre", label: "Before 9:30" },
  { key: "open", label: "9:30–10:00" },
  { key: "10", label: "10–11" },
  { key: "11", label: "11–12" },
  { key: "12", label: "12–1" },
  { key: "13", label: "1–2" },
  { key: "14", label: "2–3" },
  { key: "15", label: "3–4" },
  { key: "post", label: "After 4" },
] as const;

export function hourKey(t: Trade): string {
  const m = nyTime(t.opened_at).minute;
  if (m < 570) return "pre";
  if (m < 600) return "open";
  if (m >= 960) return "post";
  return String(Math.floor(m / 60));
}

export const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => ({ key: d, label: d }));
export const weekdayKey = (t: Trade) => nyTime(t.opened_at).weekday;

export const HOLD_ORDER = [
  { key: "a", label: "Under 1 min" },
  { key: "b", label: "1–5 min" },
  { key: "c", label: "5–30 min" },
  { key: "d", label: "30 min–2 h" },
  { key: "e", label: "Over 2 h, same day" },
  { key: "f", label: "Overnight or longer" },
] as const;

export function holdKey(t: Trade): string {
  if (closeDay(t) !== nyTime(t.opened_at).day) return "f";
  const m = holdMinutes(t);
  return m < 1 ? "a" : m < 5 ? "b" : m < 30 ? "c" : m < 120 ? "d" : "e";
}

export const DTE_ORDER = [
  { key: "0", label: "Expires that day" },
  { key: "1", label: "1–2 days" },
  { key: "3", label: "3–7 days" },
  { key: "8", label: "8–30 days" },
  { key: "31", label: "Over 30 days" },
] as const;

export function dteKey(t: Trade): string | null {
  const d = daysToExpiry(t);
  if (d === null) return null;
  return d <= 0 ? "0" : d <= 2 ? "1" : d <= 7 ? "3" : d <= 30 ? "8" : "31";
}

export const SIZE_ORDER = [
  { key: "1", label: "1 contract" },
  { key: "2", label: "2–3" },
  { key: "4", label: "4–9" },
  { key: "10", label: "10 or more" },
] as const;

/** Contracts per matched piece; null for shares, whose counts are not comparable. */
export function sizeKey(t: Trade): string | null {
  if (t.kind === "stock") return null;
  return t.qty <= 1 ? "1" : t.qty <= 3 ? "2" : t.qty <= 9 ? "4" : "10";
}

// ── Lessons ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type LessonTone = "good" | "bad" | "warn" | "info";

export interface Lesson {
  id: string;
  tone: LessonTone;
  title: string;
  /** One or two plain sentences with the numbers in them. */
  finding: string;
  /** The two sides being compared, for a small bar pair: average result per trade. */
  compare?: { a: { label: string; avg: number; trades: number }; b: { label: string; avg: number; trades: number } };
}

// The word joiner keeps the sign on the same line as the amount.
const money = (v: number) => `${v < 0 ? "−\u2060" : v > 0 ? "+\u2060" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pctOf = (v: number) => `${Math.round(v * 100)}%`;
const avgOf = (ts: readonly Trade[]) => (ts.length ? ts.reduce((s, t) => s + t.pnl, 0) / ts.length : 0);
const sumOf = (ts: readonly Trade[]) => ts.reduce((s, t) => s + t.pnl, 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Minutes after a losing close within which a new entry counts as "straight back in". */
export const REVENGE_MINUTES = 10;
const MIN_SAMPLE = 8;

/**
 * Patterns in the trades worth knowing, each measured, never guessed: a lesson is only drawn when its sample is big
 * enough, and it says what was compared. They describe the record; they predict nothing.
 */
export function lessons(input: readonly Trade[]): Lesson[] {
  const trades = sortByClose(input);
  if (trades.length < MIN_SAMPLE) return [];
  const out: Lesson[] = [];

  // 1. Straight back in after a loss.
  const byOpen = [...trades].sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at));
  const losingCloses = trades.filter((t) => t.pnl < 0).map((t) => Date.parse(t.closed_at));
  const after: Trade[] = [];
  const rest: Trade[] = [];
  let j = 0;
  for (const t of byOpen) {
    const at = Date.parse(t.opened_at);
    while (j < losingCloses.length && losingCloses[j]! < at - REVENGE_MINUTES * 60_000) j++;
    const k = losingCloses.findIndex((c, i) => i >= j && c <= at && c >= at - REVENGE_MINUTES * 60_000);
    (k >= 0 ? after : rest).push(t);
  }
  if (after.length >= MIN_SAMPLE && rest.length >= MIN_SAMPLE) {
    const a = avgOf(after);
    const b = avgOf(rest);
    out.push({
      id: "revenge",
      tone: a < b ? "bad" : "good",
      title: a < b ? "Trades taken straight after a loss do worse" : "Trades taken straight after a loss hold up",
      finding: `${after.length} trades were opened within ${REVENGE_MINUTES} minutes of closing a loser. Together they made ${money(sumOf(after))}, ${money(a)} a trade, against ${money(b)} a trade for the rest.`,
      compare: { a: { label: `Within ${REVENGE_MINUTES} min of a loss`, avg: a, trades: after.length }, b: { label: "All other trades", avg: b, trades: rest.length } },
    });
  }

  // 2. Busy days.
  const days = daily(trades);
  if (days.length >= 10) {
    const med = median(days.map((d) => d.trades));
    const cut = Math.max(4, med * 2);
    const busy = days.filter((d) => d.trades >= cut);
    const calm = days.filter((d) => d.trades < cut);
    if (busy.length >= 3 && calm.length >= 3) {
      const a = busy.reduce((s, d) => s + d.pnl, 0) / busy.length;
      const b = calm.reduce((s, d) => s + d.pnl, 0) / calm.length;
      out.push({
        id: "busy",
        tone: a < b ? "bad" : "good",
        title: a < b ? "The busiest days cost the most" : "Busy days have not hurt",
        finding: `On ${busy.length} days with ${cut} or more trades the result was ${money(busy.reduce((s, d) => s + d.pnl, 0))} in all, ${money(a)} a day, against ${money(b)} a day on the other ${calm.length} days.`,
        compare: { a: { label: `${cut}+ trades in a day`, avg: a, trades: busy.length }, b: { label: "Calmer days", avg: b, trades: calm.length } },
      });
    }
  }

  // 3. Holding losers longer than winners.
  const winHold = median(trades.filter((t) => t.pnl > 0 && t.close === "order").map(holdMinutes));
  const lossHold = median(trades.filter((t) => t.pnl < 0 && t.close === "order").map(holdMinutes));
  if (winHold > 0 && lossHold > 0) {
    const ratio = lossHold / winHold;
    out.push({
      id: "hold",
      tone: ratio > 1.25 ? "bad" : ratio < 0.8 ? "good" : "info",
      title: ratio > 1.25 ? "Losers are held longer than winners" : ratio < 0.8 ? "Losers are cut faster than winners" : "Winners and losers are held about as long",
      finding: `The typical winner was closed after ${fmtMinutes(winHold)} and the typical loser after ${fmtMinutes(lossHold)}.`,
    });
  }

  // 4. Size.
  const big = trades.filter((t) => t.kind !== "stock" && t.qty >= 3);
  const small = trades.filter((t) => t.kind !== "stock" && t.qty < 3);
  if (big.length >= MIN_SAMPLE && small.length >= MIN_SAMPLE) {
    const a = avgOf(big);
    const b = avgOf(small);
    out.push({
      id: "size",
      tone: a < b ? "bad" : "good",
      title: a < b ? "Bigger positions lost more per trade" : "Bigger positions did better",
      finding: `${big.length} option trades of 3 contracts or more made ${money(sumOf(big))}, ${money(a)} a trade, against ${money(b)} a trade at 1 or 2 contracts.`,
      compare: { a: { label: "3+ contracts", avg: a, trades: big.length }, b: { label: "1–2 contracts", avg: b, trades: small.length } },
    });
  }

  // 5. A few days carry the damage.
  const losers = days.filter((d) => d.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  const totalLoss = losers.reduce((s, d) => s + d.pnl, 0);
  if (losers.length >= 10 && totalLoss < 0) {
    const top = losers.slice(0, 5);
    const share = top.reduce((s, d) => s + d.pnl, 0) / totalLoss;
    out.push({
      id: "worst-days",
      tone: share >= 0.35 ? "bad" : "info",
      title: share >= 0.35 ? "A handful of days did most of the damage" : "Losses are spread across many days",
      finding: `The 5 worst days (${top.map((d) => shortDay(d.day)).join(", ")}) lost ${money(top.reduce((s, d) => s + d.pnl, 0))}: ${pctOf(share)} of everything lost on red days.`,
    });
  }

  // 6. Options left to expire.
  const expired = trades.filter((t) => t.close === "expired" && t.side === "long");
  if (expired.length >= 3) {
    out.push({
      id: "expired",
      tone: "warn",
      title: "Options left to expire worthless",
      finding: `${expired.length} options were held to expiry and expired worthless, costing ${money(sumOf(expired))}.`,
    });
  }

  // 7. Where the record is strongest.
  const groups = [
    ...groupBy(trades, hourKey, HOUR_ORDER).map((g) => ({ ...g, label: `opened ${g.label} (New York)` })),
    ...groupBy(trades, (t) => t.kind, KIND_ORDER).map((g) => ({ ...g, label: g.label.toLowerCase() })),
    ...groupBy(trades, holdKey, HOLD_ORDER).map((g) => ({ ...g, label: `held ${g.label.toLowerCase()}` })),
  ].filter((g) => g.trades >= Math.max(20, trades.length * 0.05));
  if (groups.length) {
    const best = groups.reduce((a, b) => (b.avg > a.avg ? b : a));
    const worst = groups.reduce((a, b) => (b.avg < a.avg ? b : a));
    if (best.avg > 0) {
      out.push({ id: "best", tone: "good", title: "Where the record is strongest", finding: `Trades ${best.label}: ${best.trades} of them, ${money(best.pnl)} in all, ${pctOf(best.winRate)} won.` });
    }
    if (worst.avg < 0 && worst.key !== best.key) {
      out.push({ id: "worst", tone: "bad", title: "Where the record is weakest", finding: `Trades ${worst.label}: ${worst.trades} of them, ${money(worst.pnl)} in all, ${pctOf(worst.winRate)} won.` });
    }
  }
  return out;
}

export function fmtMinutes(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 24) return `${Number((m / 60).toFixed(1))} h`;
  const d = m / 1440;
  return `${d < 10 ? Number(d.toFixed(1)) : Math.round(d)} day${d === 1 ? "" : "s"}`;
}

/** Three-letter months everywhere: the en-AU locale writes "June" and "Sept", which breaks the rhythm of a column. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "15 Mar 24" for a YYYY-MM-DD day. */
export function shortDay(ymd: string): string {
  return `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(2, 4)}`;
}

/** "Mar 24" for a YYYY-MM month. */
export function shortMonth(ym: string): string {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
}

// ── Calendar ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CalendarMonth {
  month: string;
  pnl: number;
  /** Weeks Monday to Friday; null where the day is outside the month. */
  weeks: ({ day: string; pnl: number | null; trades: number } | null)[][];
}

/** The last `count` months with trades, newest first, laid out Monday to Friday for a heat calendar. */
export function calendar(days: readonly DayRow[], count = 6): CalendarMonth[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const months = [...new Set(days.map((d) => d.day.slice(0, 7)))].sort().reverse().slice(0, count);
  return months.map((month) => {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const weeks: CalendarMonth["weeks"] = [];
    let week: CalendarMonth["weeks"][number] = [null, null, null, null, null];
    let any = false;
    for (let d = 1; d <= last; d++) {
      const date = new Date(Date.UTC(y, m - 1, d));
      const dow = date.getUTCDay(); // 0 Sun .. 6 Sat
      if (dow === 0 || dow === 6) continue;
      const day = date.toISOString().slice(0, 10);
      const row = byDay.get(day);
      week[dow - 1] = { day, pnl: row ? row.pnl : null, trades: row?.trades ?? 0 };
      any = true;
      if (dow === 5) {
        weeks.push(week);
        week = [null, null, null, null, null];
        any = false;
      }
    }
    if (any) weeks.push(week);
    return { month, pnl: days.filter((d) => d.day.startsWith(month)).reduce((s, d) => s + d.pnl, 0), weeks };
  });
}

/** True when the journal on show was read more than three and a half days ago (a weekend and a holiday). */
export function journalStale(doc: Pick<JournalDoc, "as_of">, now: Date): boolean {
  const at = Date.parse(doc.as_of);
  return Number.isFinite(at) && now.getTime() - at > 84 * 3_600_000;
}

// ── The session ──────────────────────────────────────────────────────────────────────────────────────────────────

export type MarketState = "open" | "pre" | "after" | "closed";

/** Where the regular US session stands in New York: 9:30 to 16:00 on weekdays, with the extended hours either side. Holidays are not known here. */
export function marketState(now: Date): MarketState {
  const t = nyTime(now.toISOString());
  if (t.weekday === "Sat" || t.weekday === "Sun") return "closed";
  if (t.minute >= 570 && t.minute < 960) return "open";
  if (t.minute >= 240 && t.minute < 570) return "pre";
  if (t.minute >= 960 && t.minute < 1200) return "after";
  return "closed";
}

/** Whole minutes from an ISO time to now; null when the time does not parse. */
export function minutesSince(iso: string, now: Date): number | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60_000)) : null;
}

export interface SessionView {
  /** The New York day on show. */
  day: string;
  /** True when that day is today in New York; otherwise it is the latest day with trades. */
  isToday: boolean;
  /** The day's closed trades, newest first. */
  trades: Trade[];
  summary: Summary;
  /** Lots still open now, newest first. */
  open: Lot[];
}

/** Today's trades in New York, or the latest session with trades when today has none yet. Null with no trades at all. */
export function sessionView(doc: Pick<JournalDoc, "trades" | "open">, now: Date): SessionView | null {
  const today = nyTime(now.toISOString()).day;
  const open = [...(doc.open ?? [])].sort((a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""));
  let day = today;
  let trades = doc.trades.filter((t) => closeDay(t) === today);
  if (trades.length === 0 && open.every((l) => !l.opened_at || nyTime(l.opened_at).day !== today)) {
    const last = doc.trades.reduce<string | null>((m, t) => (m === null || t.closed_at > m ? t.closed_at : m), null);
    if (last === null) return open.length ? { day, isToday: true, trades, summary: summarize(trades), open } : null;
    day = nyTime(last).day;
    trades = doc.trades.filter((t) => closeDay(t) === day);
  }
  trades = [...trades].sort((a, b) => b.closed_at.localeCompare(a.closed_at) || a.id.localeCompare(b.id));
  return { day, isToday: day === today, trades, summary: summarize(trades), open };
}

// ── Money in and out ─────────────────────────────────────────────────────────────────────────────────────────────

export type Money = NonNullable<JournalDoc["money"]>;

export interface MoneyPoint {
  date: string;
  /** Everything put in, up to and including this day. */
  putIn: number;
  /** Everything taken out, up to and including this day, as a positive amount. */
  takenOut: number;
  /** Everything put in less everything taken out, up to and including this day. */
  netIn: number;
  /** The account's value at the end of this day, when it was recorded. */
  value: number | null;
}

export interface MoneyView {
  currency: string;
  deposits: number;
  depositCount: number;
  withdrawals: number;
  withdrawalCount: number;
  netIn: number;
  value: number | null;
  /** What the account is worth over what was put in: zero or more is ahead. Null without a value or with nothing put in. */
  gain: number | null;
  gainPct: number | null;
  /** The trading result in the account's currency at today's rate; null without a rate. */
  tradingLocal: number | null;
  /** True when the transfer list is known to be complete. */
  complete: boolean;
  /** Transfers newest first. */
  transfers: Money["transfers"];
  series: MoneyPoint[];
}

/** Totals and a day-by-day series from the published money block and the trading result in US dollars. */
export function moneyView(m: Money, tradingUsd: number): MoneyView {
  let deposits = 0;
  let withdrawals = 0;
  let depositCount = 0;
  let withdrawalCount = 0;
  for (const t of m.transfers) {
    if (t.amount > 0) {
      deposits += t.amount;
      depositCount++;
    } else if (t.amount < 0) {
      withdrawals -= t.amount;
      withdrawalCount++;
    }
  }
  const netIn = deposits - withdrawals;
  const value = isNum(m.account_value) ? m.account_value : null;
  const gain = value !== null && netIn > 0 ? value - netIn : null;
  // Money in and money out run as separate totals, so a broker that dates a deposit after the withdrawals it paid
  // for never draws the account below zero.
  const days = new Map<string, { inflow: number; outflow: number; value: number | null }>();
  const day = (date: string) => days.get(date) ?? { inflow: 0, outflow: 0, value: null };
  for (const t of m.transfers) {
    const d = day(t.date);
    days.set(t.date, t.amount >= 0 ? { ...d, inflow: d.inflow + t.amount } : { ...d, outflow: d.outflow - t.amount });
  }
  for (const v of m.values ?? []) days.set(v.date, { ...day(v.date), value: v.value });
  let putIn = 0;
  let takenOut = 0;
  const series = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => {
      putIn += d.inflow;
      takenOut += d.outflow;
      return { date, putIn, takenOut, netIn: putIn - takenOut, value: d.value };
    });
  return {
    currency: m.currency,
    deposits,
    depositCount,
    withdrawals,
    withdrawalCount,
    netIn,
    value,
    gain,
    gainPct: gain !== null ? gain / netIn : null,
    tradingLocal: isNum(m.usd_rate) ? tradingUsd * m.usd_rate : null,
    complete: Boolean(m.complete_from),
    transfers: [...m.transfers].sort((a, b) => b.date.localeCompare(a.date)),
    series,
  };
}
