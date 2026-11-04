// The Calendar page's arithmetic. Pure: no I/O; the clock is passed in. The market days come from
// market-calendar.json, which scripts/build_market_calendar.py builds from the XNYS exchange calendar and checks
// against NYSE's published list; nothing here guesses a holiday, and a day outside the file's range says so.
import { daily, nyTime, type Trade } from "./journal";
import data from "./market-calendar.json";
import { EVENT_LABEL, eventLabel, nyInstant } from "./options";
import { judgeDay } from "./overview";
import { RULES, tradeBreaks } from "./trade-rules";

const SYD = "Australia/Sydney";
const NY = "America/New_York";

export const RANGE: { start: string; end: string } = data.range;
/** The years the page can draw: every year the file covers in full. */
export const YEARS: number[] = (() => {
  const out: number[] = [];
  for (let y = Number(RANGE.start.slice(0, 4)); y <= Number(RANGE.end.slice(0, 4)); y++) out.push(y);
  return out;
})();
export const OPTIONS_NAMES: string[] = data.options_names;

const SESSIONS = new Set<string>(data.sessions);
const HOLIDAYS = new Map<string, string>(data.holidays.map((h) => [h.date, h.name]));
const HALF_DAYS = new Map<string, { label: string; close: number }>(data.half_days.map((h) => [h.date, { label: h.label, close: hhmm(h.close_et) }]));
const OPEN_MIN = hhmm(data.open_et);
const CLOSE_MIN = hhmm(data.close_et);

function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
}

/** YYYY-MM-DD plus `n` days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Days spelt out by hand, not by the locale, so the server and the browser print a day the same way.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function parts(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  return { w: WEEKDAYS[d.getUTCDay()]!, d: d.getUTCDate(), m: MONTHS[d.getUTCMonth()]!, y: d.getUTCFullYear() };
}
export const longDay = (day: string) => {
  const p = parts(day);
  return `${p.w} ${p.d} ${p.m} ${p.y}`;
};
export const shortDay = (day: string) => {
  const p = parts(day);
  return `${p.w.slice(0, 3)} ${p.d} ${p.m.slice(0, 3)} ${p.y}`;
};

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

export type DayKind = "open" | "half" | "closed" | "weekend" | "out_of_range";

export interface SessionDay {
  kind: DayKind;
  /** The holiday's name, or the half day's label. */
  name: string | null;
  /** Minutes after midnight in New York; null when the market does not open. */
  open: number | null;
  close: number | null;
}

/** What the market does on a New York day. Outside the file's range it says so rather than guess. */
export function sessionOf(day: string): SessionDay {
  if (day < RANGE.start || day > RANGE.end) return { kind: "out_of_range", name: null, open: null, close: null };
  const w = weekday(day);
  if (w === 0 || w === 6) return { kind: "weekend", name: null, open: null, close: null };
  const hol = HOLIDAYS.get(day);
  if (hol) return { kind: "closed", name: hol, open: null, close: null };
  const half = HALF_DAYS.get(day);
  if (half) return { kind: "half", name: half.label, open: OPEN_MIN, close: half.close };
  if (SESSIONS.has(day)) return { kind: "open", name: null, open: OPEN_MIN, close: CLOSE_MIN };
  // A weekday that is neither a session nor a holiday cannot come from the generator (its test checks every day).
  return { kind: "out_of_range", name: null, open: null, close: null };
}

const isSession = (day: string) => {
  const k = sessionOf(day).kind;
  return k === "open" || k === "half";
};

/** New York's day and minute at `now`. */
export function nyNow(now: Date): { day: string; minute: number } {
  const t = nyTime(now.toISOString());
  return { day: t.day, minute: t.minute };
}

/**
 * Trading days left in the year, counting today until its close (13:00 on a half day). Null when the year runs past
 * the file, so a count is never short by days it cannot see.
 */
export function tradingDaysLeft(now: Date): number | null {
  const { day, minute } = nyNow(now);
  const year = day.slice(0, 4);
  if (`${year}-01-01` < RANGE.start || `${year}-12-31` > RANGE.end) return null;
  let n = 0;
  for (const s of data.sessions) if (s.startsWith(year) && s >= day) n++;
  const today = sessionOf(day);
  if (today.close !== null && minute >= today.close) n--;
  return n;
}

export interface Upcoming {
  day: string;
  name: string;
  /** Whole days from today (New York) to it: 0 is today. */
  inDays: number;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** The next full closure from today on; null when none is left in the file. */
export function nextHoliday(now: Date): Upcoming | null {
  const { day } = nyNow(now);
  const h = data.holidays.find((x) => x.date >= day);
  return h ? { day: h.date, name: h.name, inDays: daysBetween(day, h.date) } : null;
}

/** The next 1 pm close that has not happened yet; today counts until its close. */
export function nextHalfDay(now: Date): Upcoming | null {
  const { day, minute } = nyNow(now);
  const h = data.half_days.find((x) => x.date > day || (x.date === day && minute < hhmm(x.close_et)));
  return h ? { day: h.date, name: h.label, inDays: daysBetween(day, h.date) } : null;
}

/**
 * The month's standard options expiry: its third Friday, or the session before it when that Friday is closed (as
 * on Good Friday). Null outside the file.
 */
export function monthlyExpiry(year: number, month: number, open: (day: string) => boolean = isSession): string | null {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  if (first < RANGE.start || first > RANGE.end) return null;
  const offset = (5 - weekday(first) + 7) % 7;
  let day = addDays(first, offset + 14);
  for (let i = 0; i < 5 && !open(day); i++) day = addDays(day, -1);
  return open(day) ? day : null;
}

// ── Sydney ───────────────────────────────────────────────────────────────────────────────────────────────────────

const sydFmt = new Intl.DateTimeFormat("en-AU", { timeZone: SYD, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export interface SydneyTime {
  /** "Fri" */
  weekday: string;
  /** "01:30" */
  time: string;
  /** The Sydney calendar day, YYYY-MM-DD. */
  day: string;
}

function sydney(ms: number): SydneyTime {
  const p = Object.fromEntries(sydFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const d = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: SYD, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: String(p.weekday), time: `${p.hour}:${p.minute}`, day: `${d.year}-${d.month}-${d.day}` };
}

/** The session's open and close in Sydney time; null when the market is shut that day. */
export function sydneySession(day: string): { open: SydneyTime; close: SydneyTime } | null {
  const s = sessionOf(day);
  if (s.open === null || s.close === null) return null;
  const o = nyInstant(day, s.open);
  const c = nyInstant(day, s.close);
  return o === null || c === null ? null : { open: sydney(o), close: sydney(c) };
}

function offsetMin(tz: string, ms: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - ms) / 60_000;
}

export interface ClockSwitch {
  /** The local day the clocks change: a Sunday in both places. */
  day: string;
  where: "New York" | "Sydney";
  direction: "forward" | "back";
}

/**
 * The daylight-saving switches in a year, in New York and in Sydney. Found from the zones themselves (the offset at
 * noon UTC, day by day), not from a rule: each switch happens before noon UTC on its local day in both zones.
 */
export function clockSwitches(year: number): ClockSwitch[] {
  const out: ClockSwitch[] = [];
  for (const [tz, where] of [[NY, "New York"], [SYD, "Sydney"]] as const) {
    let prev = offsetMin(tz, Date.UTC(year - 1, 11, 31, 12));
    for (let day = `${year}-01-01`; day.startsWith(String(year)); day = addDays(day, 1)) {
      const cur = offsetMin(tz, Date.parse(`${day}T12:00:00Z`));
      if (cur !== prev) out.push({ day, where, direction: cur > prev ? "forward" : "back" });
      prev = cur;
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export interface SessionMove {
  /** The first session at the new Sydney times. */
  day: string;
  from: string;
  to: string;
  /** The switch that moved it. */
  cause: ClockSwitch;
}

/** Each session whose Sydney open differs from the session before it, with the clock switch that moved it. */
export function sessionMoves(year: number): SessionMove[] {
  const switches = [...clockSwitches(year - 1), ...clockSwitches(year)];
  const out: SessionMove[] = [];
  let prev: { day: string; time: string } | null = null;
  for (let day = `${year - 1}-12-01`; day <= `${year}-12-31`; day = addDays(day, 1)) {
    const s = day >= RANGE.start && day <= RANGE.end ? sydneySession(day) : null;
    if (!s) continue;
    if (prev && prev.time !== s.open.time && day.startsWith(String(year))) {
      const cause = [...switches].reverse().find((w) => w.day > prev!.day && w.day <= day);
      if (cause) out.push({ day, from: prev.time, to: s.open.time, cause });
    }
    prev = { day, time: s.open.time };
  }
  return out;
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type EventGroup = "fed" | "inflation" | "growth" | "expiry" | "earnings";

export interface DayEvent {
  code: string;
  label: string;
  group: EventGroup;
  /** New York wall clock, HH:MM, when known. */
  timeEt: string | null;
  /** The same moment in Sydney, "Fri 00:30", when the time is known. */
  timeSyd: string | null;
  /** "expected" for a date the company or agency has not confirmed. */
  expected: boolean;
  /** Where the date comes from, in words ("FRED", "the trading calendar"); null for one worked out here. */
  source: string | null;
  /** The other official sources that list the same date. */
  checkedBy: string[];
}

/** One release date from the published economic calendar (stocksdelta/calendar). */
export interface OfficialEvent {
  date: string;
  code: string;
  time_et: string;
  source: string;
  checked_by: readonly string[];
}

/** Each source in words. */
export const SOURCE_NAME: Readonly<Record<string, string>> = { fred: "FRED", fed: "Federal Reserve", bls: "BLS", bea: "BEA", csv: "the trading calendar" };
/** Each release's short name, for lists of months and differences. */
export const SHORT_LABEL: Readonly<Record<string, string>> = {
  cpi: "CPI",
  ppi: "PPI",
  pce: "PCE",
  gdp: "GDP",
  retail_sales: "Retail sales",
  nfp: "Jobs report",
  jolts: "JOLTS",
  fomc_decision: "Fed decisions",
};

const GROUP: Readonly<Record<string, EventGroup>> = {
  fomc_decision: "fed",
  fomc_minutes: "fed",
  fomc_emergency: "fed",
  cpi: "inflation",
  ppi: "inflation",
  pce: "inflation",
  nfp: "growth",
  jolts: "growth",
  gdp: "growth",
  retail_sales: "growth",
  quad_witching: "expiry",
};
const RANK: Readonly<Record<EventGroup, number>> = { fed: 0, inflation: 1, growth: 2, earnings: 3, expiry: 4 };

const WHEN: Readonly<Record<string, string>> = { bmo: "before the open", amc: "after the close", during: "during the session" };

export interface EarningsRow {
  date: string;
  symbol: string;
  when: string | null;
  expected: boolean;
}

/**
 * Every event by New York day: the official release dates when the economic calendar is published, the repo's own
 * macro calendar for what it does not cover (by code and month), the month's expiry, and earnings for the Options
 * names. Codes are drawn through EVENT_LABEL, never as written.
 */
export function eventsByDay(earnings: readonly EarningsRow[], official: readonly OfficialEvent[] = []): Map<string, DayEvent[]> {
  const by = new Map<string, DayEvent[]>();
  const add = (day: string, e: DayEvent) => {
    const list = by.get(day) ?? [];
    if (!list.some((x) => x.code === e.code && x.label === e.label)) list.push(e);
    by.set(day, list);
  };
  const timed = (day: string, t: string) => {
    const at = nyInstant(day, hhmm(t));
    const syd = at === null ? null : sydney(at);
    return syd && `${syd.weekday} ${syd.time}`;
  };
  const covered = new Set<string>();
  for (const e of official) {
    if (!(e.code in EVENT_LABEL)) continue;
    covered.add(`${e.code}|${e.date.slice(0, 7)}`);
    add(e.date, {
      code: e.code,
      label: eventLabel(e.code),
      group: GROUP[e.code] ?? "growth",
      timeEt: e.time_et,
      timeSyd: timed(e.date, e.time_et),
      expected: false,
      source: SOURCE_NAME[e.source] ?? null,
      checkedBy: e.checked_by.map((s) => SOURCE_NAME[s]).filter((s): s is string => Boolean(s)),
    });
  }
  for (const e of data.macro) {
    if (!(e.code in EVENT_LABEL) || covered.has(`${e.code}|${e.date.slice(0, 7)}`)) continue;
    add(e.date, { code: e.code, label: eventLabel(e.code), group: GROUP[e.code] ?? "growth", timeEt: e.time_et, timeSyd: timed(e.date, e.time_et), expected: e.quality !== "exact", source: SOURCE_NAME.csv!, checkedBy: [] });
  }
  for (const y of YEARS) {
    for (let m = 1; m <= 12; m++) {
      const d = monthlyExpiry(y, m);
      if (d) add(d, { code: "opex", label: "Monthly options expiry", group: "expiry", timeEt: null, timeSyd: null, expected: false, source: null, checkedBy: [] });
    }
  }
  const names = new Set(OPTIONS_NAMES);
  for (const e of earnings) {
    if (!names.has(e.symbol)) continue;
    add(e.date, { code: "earnings", label: `${e.symbol} earnings${e.when && WHEN[e.when] ? `, ${WHEN[e.when]}` : ""}`, group: "earnings", timeEt: null, timeSyd: null, expected: e.expected, source: null, checkedBy: [] });
  }
  for (const list of by.values()) list.sort((a, b) => RANK[a.group] - RANK[b.group] || (a.timeEt ?? "99").localeCompare(b.timeEt ?? "99") || a.label.localeCompare(b.label));
  return by;
}

export interface TradingDiff {
  code: string;
  month: string;
  official: string[];
  trading: string[];
}

/**
 * Where the calendar the paper runners trade around (config/events/macro_events.csv, as built into this page)
 * differs from the official dates: each month the official calendar lists a release and the trading one has other
 * dates or none. The page only says so; that file is changed by hand, under its own record.
 */
export function tradingCalendarDiffs(official: readonly OfficialEvent[]): TradingDiff[] {
  const shared = new Set(data.macro.map((e) => e.code));
  const byKey = (rows: readonly { code: string; date: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of rows) if (shared.has(r.code)) m.set(`${r.code}|${r.date.slice(0, 7)}`, [...(m.get(`${r.code}|${r.date.slice(0, 7)}`) ?? []), r.date].sort());
    return m;
  };
  const off = byKey(official);
  const csv = byKey(data.macro);
  const out: TradingDiff[] = [];
  for (const [key, dates] of off) {
    const mine = csv.get(key) ?? [];
    if (mine.join() !== dates.join()) {
      const [code, month] = key.split("|") as [string, string];
      out.push({ code, month, official: dates, trading: mine });
    }
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.code.localeCompare(b.code));
}

/** The repo's earnings rows and the editions' rows, one per name and day; the editions' word wins on a clash. */
export function mergeEarnings(fromEditions: readonly { date: string; symbol: string; when: string | null }[]): EarningsRow[] {
  const rows = new Map<string, EarningsRow>();
  for (const e of data.earnings) rows.set(`${e.date}|${e.symbol}`, { date: e.date, symbol: e.symbol, when: e.when, expected: e.quality !== "confirmed" });
  for (const e of fromEditions) {
    const key = `${e.date}|${e.symbol}`;
    const had = rows.get(key);
    rows.set(key, { date: e.date, symbol: e.symbol, when: e.when ?? had?.when ?? null, expected: had?.expected ?? false });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

/** Each Options name's next earnings date from today on, or null when none is known. */
export function nextEarnings(rows: readonly EarningsRow[], now: Date): { symbol: string; row: EarningsRow | null }[] {
  const { day } = nyNow(now);
  return OPTIONS_NAMES.map((symbol) => ({ symbol, row: rows.find((r) => r.symbol === symbol && r.date >= day) ?? null }));
}

// ── Your days ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface YourDay {
  pnl: number;
  trades: number;
  wins: number;
  /** Which day rule broke, if one did: the Overview strip's test, and what the page's "!" and its counts mean. */
  broke: "loss" | "count" | "both" | null;
  /** The numbered trade rules broken by trades opened this day, as the Overview card counts them. */
  rules: number[];
}

/** Your closed results by New York close day, with the day rules and the trade rules each day broke. */
export function yourDays(trades: readonly Trade[]): Map<string, YourDay> {
  const breaks = tradeBreaks(trades);
  const rulesByOpenDay = new Map<string, Set<string>>();
  for (const t of trades) {
    const ids = breaks.get(t.id);
    if (!ids) continue;
    const d = nyTime(t.opened_at).day;
    const set = rulesByOpenDay.get(d) ?? new Set<string>();
    for (const id of ids) set.add(id);
    rulesByOpenDay.set(d, set);
  }
  const out = new Map<string, YourDay>();
  for (const d of daily(trades)) {
    const j = judgeDay(d);
    out.set(d.day, { pnl: d.pnl, trades: d.trades, wins: d.wins, broke: j.broke, rules: [] });
  }
  for (const [day, ids] of rulesByOpenDay) {
    const row = out.get(day) ?? { pnl: 0, trades: 0, wins: 0, broke: null, rules: [] };
    row.rules = RULES.filter((r) => ids.has(r.id)).map((r) => r.n);
    out.set(day, row);
  }
  return out;
}

// ── The year ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DayCell {
  day: string;
  kind: DayKind;
  name: string | null;
  isToday: boolean;
  isPast: boolean;
  events: DayEvent[];
  you: YourDay | null;
  /** The New York hours, "09:30–16:00", on a trading day. */
  nyHours: string | null;
  sydney: { open: SydneyTime; close: SydneyTime } | null;
  /** A clock switch on this day. */
  clocks: ClockSwitch | null;
  /** The first session at new Sydney times. */
  move: SessionMove | null;
}

export interface MonthView {
  key: string;
  label: string;
  /** Monday-first weeks; null pads the days outside the month. */
  weeks: (DayCell | null)[][];
  marketDays: number;
  daysTraded: number;
  ruleDays: number;
  pnl: number;
  /** Holidays, half days and clock moves, one line each, for the foot of the month. */
  notes: string[];
}

const fmtTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const monthName = (key: string) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

/** The year laid out month by month, with every figure the page shows. */
export function yearView(year: number, now: Date, you: ReadonlyMap<string, YourDay>, events: ReadonlyMap<string, DayEvent[]>): MonthView[] {
  const today = nyNow(now).day;
  const switches = new Map(clockSwitches(year).map((s) => [s.day, s]));
  const moves = new Map(sessionMoves(year).map((m) => [m.day, m]));
  const months: MonthView[] = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const first = `${key}-01`;
    const cells: (DayCell | null)[] = Array.from({ length: (weekday(first) + 6) % 7 }, () => null);
    const view: MonthView = { key, label: monthName(key), weeks: [], marketDays: 0, daysTraded: 0, ruleDays: 0, pnl: 0, notes: [] };
    for (let day = first; day.startsWith(key); day = addDays(day, 1)) {
      const s = sessionOf(day);
      const trading = s.kind === "open" || s.kind === "half";
      const mine = trading || s.kind === "closed" ? (you.get(day) ?? null) : null;
      const cell: DayCell = {
        day,
        kind: s.kind,
        name: s.name,
        isToday: day === today,
        isPast: day < today,
        events: events.get(day) ?? [],
        you: mine,
        nyHours: s.open !== null && s.close !== null ? `${fmtTime(s.open)}–${fmtTime(s.close)}` : null,
        sydney: trading ? sydneySession(day) : null,
        clocks: switches.get(day) ?? null,
        move: moves.get(day) ?? null,
      };
      if (trading) view.marketDays++;
      if (mine && mine.trades > 0) {
        view.daysTraded++;
        view.pnl += mine.pnl;
        if (mine.broke) view.ruleDays++;
      }
      const d = Number(day.slice(8));
      if (s.kind === "closed") view.notes.push(`${d}: ${s.name}, closed`);
      if (s.kind === "half") view.notes.push(`${d}: ${s.name}, closes 1 pm New York`);
      if (cell.clocks) view.notes.push(`${d}: ${cell.clocks.where} clocks go ${cell.clocks.direction}`);
      if (cell.move) view.notes.push(`${d}: the open moves to ${cell.move.to} Sydney (was ${cell.move.from})`);
      cells.push(cell);
    }
    while (cells.length % 7) cells.push(null);
    for (let i = 0; i < cells.length; i += 7) view.weeks.push(cells.slice(i, i + 7));
    months.push(view);
  }
  return months;
}

/** The year's totals across its months. */
export function yearTotals(months: readonly MonthView[]): { marketDays: number; daysTraded: number; ruleDays: number; pnl: number } {
  return months.reduce((t, m) => ({ marketDays: t.marketDays + m.marketDays, daysTraded: t.daysTraded + m.daysTraded, ruleDays: t.ruleDays + m.ruleDays, pnl: t.pnl + m.pnl }), { marketDays: 0, daysTraded: 0, ruleDays: 0, pnl: 0 });
}

/** The page's year from the address: a year the file covers, else this year (when covered), else the first one. */
export function pickYear(raw: string | string[] | undefined, now: Date): number {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  if (YEARS.includes(v)) return v;
  const y = Number(nyNow(now).day.slice(0, 4));
  return YEARS.includes(y) ? y : YEARS[0]!;
}

/** The monthly and Fed releases the page expects to see each month, and how to name them when a month has none. */
const EXPECTED: readonly { code: string; label: string }[] = [
  { code: "cpi", label: "CPI" },
  { code: "nfp", label: "Jobs report" },
  { code: "fomc_decision", label: "Fed decisions" },
];

/**
 * By month, the releases with no date published yet. With the economic calendar, its own "not yet announced"
 * months. Without it, from the repo's macro calendar: every month after a release's last listed date, to the end of
 * the range. Months before that date with no release are left alone (the Fed meets eight times a year).
 */
export function unlistedByMonth(notAnnounced?: readonly { code: string; month: string }[]): Map<string, string[]> {
  if (notAnnounced) {
    const out = new Map<string, string[]>();
    for (const n of notAnnounced) {
      const label = SHORT_LABEL[n.code];
      if (label && n.month >= RANGE.start.slice(0, 7) && n.month <= RANGE.end.slice(0, 7)) out.set(n.month, [...(out.get(n.month) ?? []), label]);
    }
    return out;
  }
  const out = new Map<string, string[]>();
  for (const { code, label } of EXPECTED) {
    const last = data.macro.filter((e) => e.code === code).reduce((m, e) => (e.date > m ? e.date : m), "");
    let month = last ? last.slice(0, 7) : RANGE.start.slice(0, 7);
    if (last) month = addDays(`${month}-28`, 7).slice(0, 7);
    for (; `${month}-01` <= RANGE.end; month = addDays(`${month}-28`, 7).slice(0, 7)) out.set(month, [...(out.get(month) ?? []), label]);
  }
  return out;
}

// ── The economic calendar's state ────────────────────────────────────────────────────────────────────────────────

/** Older than this, the published calendar is called out of date: the job runs weekly, so two runs were missed. */
export const CALENDAR_STALE_DAYS = 9;

export interface ReleaseNote {
  tone: "warn" | "info";
  text: string;
}

const monthWords = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const dayWords = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  return `${WEEKDAYS[x.getUTCDay()]!.slice(0, 3)} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]!.slice(0, 3)}`;
};
const list = (ds: readonly string[]) => (ds.length ? ds.map(dayWords).join(" and ") : "no date");

/** The minimum a page needs of the published calendar to say how far to trust it. */
export interface CalendarState {
  as_of: string;
  sources: readonly { id: string; configured: boolean; ok: boolean; fetched_at: string | null; stale_since: string | null }[];
  disagreements: readonly { code: string; month: string; source: string; dates: readonly string[]; other_source: string; other_dates: readonly string[] }[];
}

/**
 * What the page says about its release dates: whether the weekly calendar is there and current, which sources it
 * could not read or that are not set up, where two official sources disagree, and where the trading calendar
 * differs from the official dates. Warnings first.
 */
export function releaseNotes(status: "ok" | "missing" | "error", doc: CalendarState | null, diffs: readonly TradingDiff[], now: Date): ReleaseNote[] {
  const out: ReleaseNote[] = [];
  if (status !== "ok" || !doc) {
    out.push({
      tone: status === "error" ? "warn" : "info",
      text: `${status === "error" ? "The economic calendar could not be read" : "The weekly economic calendar has not been published yet"}, so release dates come from the repo's own calendar: Fed, CPI and jobs only.`,
    });
    return out;
  }
  const age = (now.getTime() - Date.parse(doc.as_of)) / 86_400_000;
  if (!(age <= CALENDAR_STALE_DAYS)) out.push({ tone: "warn", text: `The economic calendar was last refreshed ${Number.isFinite(age) ? `${Math.floor(age)} days ago` : "at an unknown time"}; the weekly job may have stopped.` });
  for (const s of doc.sources) {
    const name = SOURCE_NAME[s.id] ?? s.id;
    if (s.configured && !s.ok) {
      out.push({
        tone: "warn",
        text: s.fetched_at ? `${name} could not be read on the last run; its dates from ${dayWords(s.fetched_at.slice(0, 10))} are shown.` : `${name} could not be read, and has never been: its releases are missing.`,
      });
    }
  }
  for (const d of doc.disagreements) {
    out.push({ tone: "warn", text: `${SHORT_LABEL[d.code] ?? d.code}, ${monthWords(d.month)}: ${SOURCE_NAME[d.source] ?? d.source} gives ${list(d.dates)}, ${SOURCE_NAME[d.other_source] ?? d.other_source} gives ${list(d.other_dates)}. Check before trading around it.` });
  }
  for (const d of diffs) {
    out.push({ tone: "warn", text: `${SHORT_LABEL[d.code] ?? d.code}, ${monthWords(d.month)}: the official date is ${list(d.official)}, but the calendar the paper runners trade around has ${list(d.trading)}.` });
  }
  const unset = doc.sources.filter((s) => !s.configured).map((s) => s.id);
  if (unset.includes("fred")) out.push({ tone: "info", text: "FRED is not set up yet (FRED_API_KEY on the host), so BLS and BEA stand in and retail sales has no dates." });
  if (unset.includes("bls")) out.push({ tone: "info", text: "BLS is not asked yet: it answers only a caller that leaves a contact address (WT_CONTACT_EMAIL on the host)." });
  return out;
}
