// The Radar's pre-market brief: the morning radar read against the owner's own trading. Pure: no I/O; the radar
// edition, the options levels for the same session and the trade journal are passed in.
import { daysToExpiry, nyTime, type Trade } from "./journal";
import type { OptionsEdition } from "./options.types";
import { calendarWeek, tickersOf, type Radar, type RadarEvent, type RadarTicker } from "./radar";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type OptionsTicker = OptionsEdition["tickers"][number];
export type BriefTone = "good" | "warn" | "bad";

/** The day, week and month highs and lows the owner marks before the open, in the order they are drawn. */
export const KEY_LEVELS = ["PDL", "PDH", "PWL", "PWH", "PML", "PMH"] as const;
export type KeyLevel = (typeof KEY_LEVELS)[number];

export interface Level {
  name: KeyLevel;
  price: number;
}

/** A name's marked levels from its options edition, lowest first. Missing ones are left out. */
export function keyLevels(t: OptionsTicker | undefined): Level[] {
  const out: Level[] = [];
  for (const name of KEY_LEVELS) {
    const l = (t?.levels ?? []).find((x) => x.name === name);
    if (l && isNum(l.price)) out.push({ name, price: l.price });
  }
  return out.sort((a, b) => a.price - b.price);
}

/** Levels that sit at the same price (PDL and PWL often do) merged into one mark: "PDL/PWL". */
export function mergedLevels(levels: readonly Level[]): { names: string; price: number }[] {
  const out: { names: string; price: number }[] = [];
  for (const l of levels) {
    const prev = out.at(-1);
    if (prev && Math.abs(prev.price - l.price) < 0.005) prev.names += `/${l.name}`;
    else out.push({ names: l.name, price: l.price });
  }
  return out;
}

// ── The names the owner trades ───────────────────────────────────────────────────────────────────────────────────

export interface YourName {
  symbol: string;
  /** Closed trades in the edition's calendar year, and their result before fees. */
  yearTrades: number;
  yearPnl: number;
  /** Closed trades over the whole journal, and their result. */
  allTrades: number;
  allPnl: number;
}

const DAY_MS = 86_400_000;

/**
 * The names the owner actually trades: the most-traded symbols over the 180 days before `asOf` (YYYY-MM-DD), or over
 * the whole journal when that window is empty. SPY always comes first. At most `n` names.
 */
export function yourNames(trades: readonly Trade[], asOf: string, n = 5): YourName[] {
  const end = Date.parse(`${asOf}T23:59:59Z`);
  const recent = trades.filter((t) => {
    const c = Date.parse(t.closed_at);
    return c <= end && c > end - 180 * DAY_MS;
  });
  const pool = recent.length > 0 ? recent : trades;
  const count = new Map<string, number>();
  for (const t of pool) count.set(t.symbol, (count.get(t.symbol) ?? 0) + 1);
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
  const symbols = ["SPY", ...ranked.filter((s) => s !== "SPY")].slice(0, n);
  const year = asOf.slice(0, 4);
  return symbols.map((symbol) => {
    const mine = trades.filter((t) => t.symbol === symbol);
    const inYear = mine.filter((t) => nyTime(t.closed_at).day.startsWith(year));
    return {
      symbol,
      yearTrades: inYear.length,
      yearPnl: inYear.reduce((s, t) => s + t.pnl, 0),
      allTrades: mine.length,
      allPnl: mine.reduce((s, t) => s + t.pnl, 0),
    };
  });
}

// ── Where each name opens ────────────────────────────────────────────────────────────────────────────────────────

export interface OpenRead {
  symbol: string;
  /** The close the levels were built from. */
  close: number | null;
  premarket: number | null;
  /** Pre-market against the close, in percent. */
  gapPct: number | null;
  /** The gap as a multiple of the name's one-day expected move. */
  gapVsMove: number | null;
  /** The one-day expected move in points, from implied vol. */
  move: number | null;
  levels: Level[];
  below: Level | null;
  above: Level | null;
  /** inside: between the previous day's low and high. above / below: outside that range. */
  where: "above" | "below" | "inside" | null;
  /** The radar's dated one-line reason, when it carries the name. */
  why: string | null;
}

/** Gaps bigger than this share of the day's expected move are flagged: the move may be spent before the open. */
export const GAP_LIMIT = 0.8;

/** A pre-market price newer than the radar's: the options desk's pre-open focus refresh (about 08:50 New York). */
export interface LaterPremarket {
  price: number;
  asOf: string;
}

/**
 * One source for the pre-market price: the focus refresh's price for a name when it was taken after the radar was
 * built, else nothing (the radar's own stands). The refresh runs nearer the open than the radar's build.
 */
export function laterPremarket(options: OptionsEdition | null, radarAsOf: string | null | undefined): Map<string, LaterPremarket> {
  const out = new Map<string, LaterPremarket>();
  const pre = options?.focus?.premarket;
  const at = pre ? Date.parse(pre.as_of) : NaN;
  const built = radarAsOf ? Date.parse(radarAsOf) : NaN;
  if (!pre || !Number.isFinite(at) || (Number.isFinite(built) && at <= built)) return out;
  for (const i of pre.items) if (isNum(i.price) && i.price > 0) out.set(i.symbol, { price: i.price, asOf: pre.as_of });
  return out;
}

export function openRead(
  symbol: string,
  opt: OptionsTicker | undefined,
  rt: RadarTicker | undefined,
  later?: LaterPremarket,
): OpenRead {
  const close = isNum(opt?.last?.close) ? opt.last.close : isNum(rt?.price) ? rt.price : null;
  const premarket = later ? later.price : isNum(rt?.premarket_price) ? rt.premarket_price : null;
  const ref = premarket ?? close;
  const move = isNum(opt?.expected_move?.day) && opt.expected_move.day > 0 ? opt.expected_move.day : null;
  const levels = keyLevels(opt);
  const pdh = levels.find((l) => l.name === "PDH");
  const pdl = levels.find((l) => l.name === "PDL");
  const gap = premarket !== null && close !== null ? premarket - close : null;
  return {
    symbol,
    close,
    premarket,
    gapPct: gap !== null && close ? (gap / close) * 100 : null,
    gapVsMove: gap !== null && move ? Math.abs(gap) / move : null,
    move,
    levels,
    below: ref === null ? null : ([...levels].reverse().find((l) => l.price <= ref) ?? null),
    above: ref === null ? null : (levels.find((l) => l.price > ref) ?? null),
    where: ref === null || !pdh || !pdl ? null : ref > pdh.price ? "above" : ref < pdl.price ? "below" : "inside",
    why: rt?.why ?? null,
  };
}

/** The plain-words plan for where SPY opens against the previous day's range. Null without a price or a range. */
export function openPlan(o: OpenRead): string | null {
  const pdh = o.levels.find((l) => l.name === "PDH");
  const pdl = o.levels.find((l) => l.name === "PDL");
  if (!o.where || !pdh || !pdl) return null;
  const at = o.premarket !== null ? `Pre-market ${o.premarket.toFixed(2)}` : `The close, ${o.close?.toFixed(2)},`;
  if (o.where === "above")
    return `${at} sits above yesterday's high (PDH ${pdh.price.toFixed(2)}). A pullback that holds ${pdh.price.toFixed(2)} on a 2-minute close is the call setup; a close back under it gives the level up.`;
  if (o.where === "below")
    return `${at} sits below yesterday's low (PDL ${pdl.price.toFixed(2)}). A bounce that fails at ${pdl.price.toFixed(2)} on a 2-minute close is the put setup; a close back above it gives the level up.`;
  return `${at} sits inside yesterday's range, ${pdl.price.toFixed(2)} to ${pdh.price.toFixed(2)}. Expect chop in the middle; wait for one side to break and retest.`;
}

// ── The day's verdict ────────────────────────────────────────────────────────────────────────────────────────────

/** Releases that move the whole market on their own. A day with one is an event day. */
const RED_EVENT = /\b(cpi|fomc|payrolls?|nfp|pce|jobs report|fed (rate )?decision)\b/i;

const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Good Friday (the exchanges shut): two days before Western Easter. */
function goodFriday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((8 * b + 13) / 25)) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return shiftDay(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, -2);
}

/** Market holidays that can land on a third Friday: Good Friday, Juneteenth, and any the radar's calendar lists. */
function shutOn(ymd: string, holidays: ReadonlySet<string>): boolean {
  return holidays.has(ymd) || ymd === goodFriday(Number(ymd.slice(0, 4))) || ymd.slice(5) === "06-19";
}

/** The monthly options expiry: the third Friday, or the Thursday before when that Friday is a market holiday. */
export function isMonthlyExpiry(ymd: string, holidays: ReadonlySet<string> = new Set()): boolean {
  const d = new Date(`${ymd}T12:00:00Z`);
  const thirdFriday = (x: Date) => x.getUTCDay() === 5 && x.getUTCDate() >= 15 && x.getUTCDate() <= 21;
  if (thirdFriday(d)) return !shutOn(ymd, holidays);
  const next = shiftDay(ymd, 1);
  return d.getUTCDay() === 4 && thirdFriday(new Date(`${next}T12:00:00Z`)) && shutOn(next, holidays);
}

/** The symbol an earnings row is about: the radar writes it as the label ("MU" or "MU earnings"). */
export function earningsSymbol(e: RadarEvent): string | null {
  if (e.kind !== "earnings") return null;
  const m = /^([A-Z][A-Z.]{0,5})\b/.exec(e.label.trim());
  return m?.[1] ?? null;
}

export interface Earnings {
  date: string;
  symbol: string;
  /** bmo, amc or during, when known. */
  when: string | null;
}

/** Earnings dates from both editions, one row per name and day, nearest first. */
export function earningsOf(r: Radar, opt: OptionsEdition | null): Earnings[] {
  const rows = new Map<string, Earnings>();
  for (const e of opt?.events ?? []) {
    if (e.kind === "earnings" && e.symbol) rows.set(`${e.date}|${e.symbol}`, { date: e.date, symbol: e.symbol, when: e.when ?? null });
  }
  for (const e of r.calendar ?? []) {
    const s = earningsSymbol(e);
    const when = /after (the )?close/i.test(e.label) ? "amc" : /before (the )?open/i.test(e.label) ? "bmo" : null;
    if (s && !rows.has(`${e.date}|${s}`)) rows.set(`${e.date}|${s}`, { date: e.date, symbol: s, when });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

export interface Verdict {
  tone: BriefTone;
  word: "Event day" | "Careful day" | "Normal day" | "Not fully checked";
  /** Why, one short line each, most serious first. */
  reasons: { tone: BriefTone; text: string }[];
  /** Checks the page could not run for want of data. A day with any is never called normal. */
  unchecked: string[];
}

const pctNum = (v: string | null | undefined) => {
  const n = Number.parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** The VIX gauge's move in percent, worked out from points when the radar gives points. */
export function vixJumpPct(r: Radar): number | null {
  const g = (r.gauges ?? []).find((x) => /\bvix\b/i.test(x.label));
  if (!g || !isNum(g.change)) return null;
  if (g.change_unit !== "pts") return g.change;
  const v = pctNum(g.value);
  return v !== null && v - g.change > 0 ? (g.change / (v - g.change)) * 100 : null;
}

/**
 * The day in one word. Red on a release that moves the whole market; amber on the monthly expiry, an earnings report
 * from one of the owner's names that day, a VIX jump over 10%, or a gap past 80% of a name's expected move; green
 * otherwise, but only when every check had its data: a missing calendar, VIX move or SPY level reads "Not fully
 * checked" instead. Every reason the page shows is one of these rules.
 */
export function dayVerdict(r: Radar, names: readonly string[], reads: readonly OpenRead[], earnings: readonly Earnings[]): Verdict {
  const day = r.edition_date;
  const reasons: Verdict["reasons"] = [];
  for (const e of (r.calendar ?? []).filter((x) => x.date === day && x.kind !== "earnings")) {
    if (RED_EVENT.test(e.label) || (e.impact === "high" && e.kind === "macro")) {
      reasons.push({ tone: "bad", text: `${e.label}${e.time_et ? ` ${e.time_et}` : ""}: no entries until 30 minutes after` });
    }
  }
  const holidays = new Set((r.calendar ?? []).filter((x) => x.kind === "holiday").map((x) => x.date));
  if (isMonthlyExpiry(day, holidays)) reasons.push({ tone: "warn", text: "Monthly options expiry" });
  for (const e of earnings.filter((x) => x.date === day && names.includes(x.symbol))) {
    reasons.push({ tone: "warn", text: `${e.symbol} reports today: no overnight holds` });
  }
  const vix = vixJumpPct(r);
  if (vix !== null && vix > 10) reasons.push({ tone: "warn", text: `VIX up ${vix.toFixed(0)}%` });
  for (const o of reads) {
    if (o.gapVsMove !== null && o.gapVsMove > GAP_LIMIT && o.gapPct !== null) {
      reasons.push({ tone: "warn", text: `${o.symbol} gapped ${o.gapVsMove.toFixed(1)}× its daily move: wait for a retest` });
    }
  }
  const unchecked: string[] = [];
  if (!(r.calendar ?? []).some((x) => x.kind !== "earnings")) unchecked.push("today's releases");
  if (vix === null) unchecked.push("the VIX move");
  // No earnings row in either calendar: "no report from your names" would be a guess.
  if (earnings.length === 0) unchecked.push("earnings dates");
  const spy = reads.find((o) => o.symbol === "SPY");
  if (!spy || spy.where === null) unchecked.push("SPY's levels");
  else if (spy.premarket === null) unchecked.push("SPY's pre-market gap");
  const tone: BriefTone = reasons.some((x) => x.tone === "bad") ? "bad" : reasons.length || unchecked.length ? "warn" : "good";
  const word = tone === "bad" ? "Event day" : reasons.length ? "Careful day" : unchecked.length ? "Not fully checked" : "Normal day";
  return { tone, word, reasons, unchecked };
}

// ── The session, against the owner's own record ──────────────────────────────────────────────────────────────────

export const SESSION_WINDOWS = [
  { key: "open", label: "9:30–10:30", from: 570, to: 630 },
  { key: "mid-am", label: "10:30–11:30", from: 630, to: 690 },
  { key: "lunch", label: "11:30–13:00", from: 690, to: 780 },
  { key: "pm", label: "13:00–15:00", from: 780, to: 900 },
  { key: "last", label: "15:00–16:00", from: 900, to: 960 },
] as const;

export interface WindowRow {
  key: string;
  label: string;
  from: number;
  to: number;
  trades: number;
  pnl: number;
}

export interface SessionRecord {
  /** What was counted: SPY same-day options, or every SPY option when there are too few of those. */
  scope: "SPY 0DTE" | "SPY options";
  rows: WindowRow[];
  /** The window with the worst result over at least 10 trades; null when none qualifies. */
  worst: WindowRow | null;
}

/** The owner's SPY option results by when in the session the trade was opened (New York). */
export function sessionRecord(trades: readonly Trade[]): SessionRecord {
  const spy = trades.filter((t) => t.symbol === "SPY" && t.kind !== "stock");
  const zero = spy.filter((t) => daysToExpiry(t) === 0);
  const scope = zero.length >= 20 ? "SPY 0DTE" : "SPY options";
  const pool = scope === "SPY 0DTE" ? zero : spy;
  const rows = SESSION_WINDOWS.map((w) => {
    const inW = pool.filter((t) => {
      const m = nyTime(t.opened_at).minute;
      return m >= w.from && m < w.to;
    });
    return { ...w, trades: inW.length, pnl: inW.reduce((s, t) => s + t.pnl, 0) };
  });
  const worst = rows.filter((x) => x.trades >= 10 && x.pnl < 0).sort((a, b) => a.pnl - b.pnl)[0] ?? null;
  return { scope, rows, worst };
}

/** Today's timed releases as minutes after midnight New York, for the clock. Untimed rows are left out. */
export function timedEvents(r: Radar): { minute: number; label: string; tone: BriefTone }[] {
  return (r.calendar ?? [])
    .filter((e) => e.date === r.edition_date && e.kind !== "earnings" && e.time_et)
    .map((e) => {
      const [h, m] = String(e.time_et).split(":").map(Number);
      return {
        minute: (h ?? 0) * 60 + (m ?? 0),
        label: e.label,
        tone: (RED_EVENT.test(e.label) || e.impact === "high" ? "bad" : "warn") as BriefTone,
      };
    })
    .filter((e) => Number.isFinite(e.minute))
    .sort((a, b) => a.minute - b.minute);
}

// ── The big names that move SPY ──────────────────────────────────────────────────────────────────────────────────

/** The index funds, which follow the big names rather than move them. */
const INDEX = new Set(["SPY", "QQQ", "IWM", "DIA"]);

export interface Mover {
  symbol: string;
  pct: number;
  why: string | null;
}

/**
 * The big names' pre-market moves against the close, biggest rise first: the MEGA CAP OPTIONS list without the index
 * funds. Closes come from the options edition when it has the name, so the move is measured from the same close as
 * the levels. Names without a pre-market price are left out.
 */
export function movers(r: Radar, opt: OptionsEdition | null): Mover[] {
  const closes = new Map((opt?.tickers ?? []).map((t) => [t.symbol, t.last?.close]));
  return tickersOf(r, "MEGA CAP OPTIONS")
    .filter((t) => !INDEX.has(t.symbol) && isNum(t.premarket_price))
    .map((t) => {
      const c = closes.get(t.symbol);
      const base = isNum(c) ? c : t.price;
      return isNum(base) && base > 0 ? { symbol: t.symbol, pct: ((t.premarket_price as number) / base - 1) * 100, why: t.why ?? null } : null;
    })
    .filter((m): m is Mover => m !== null)
    .sort((a, b) => b.pct - a.pct);
}

// ── The week ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WeekDay {
  date: string;
  /** Releases, timed first. */
  events: RadarEvent[];
  /** Earnings that day, the owner's names first. */
  earnings: (Earnings & { yours: boolean })[];
}

/** Five weekdays from the edition's day: the radar's releases plus earnings from both editions. */
export function briefWeek(r: Radar, earnings: readonly Earnings[], names: readonly string[]): { days: WeekDay[]; later: RadarEvent[] } {
  const w = calendarWeek(r);
  return {
    days: w.days.map((d) => ({
      date: d.date,
      events: d.events.filter((e) => e.kind !== "earnings"),
      earnings: earnings
        .filter((e) => e.date === d.date)
        .map((e) => ({ ...e, yours: names.includes(e.symbol) }))
        .sort((a, b) => Number(b.yours) - Number(a.yours) || a.symbol.localeCompare(b.symbol)),
    })),
    later: w.later.filter((e) => e.kind !== "earnings" && (e.impact === "high" || RED_EVENT.test(e.label))),
  };
}

/** The clock time in Sydney ("Sat 00:30") of a New York wall time on `ymd`, `minute` minutes after midnight. */
export function sydneyAt(ymd: string, minute: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  for (const off of [4, 5]) {
    const at = new Date(Date.UTC(y!, mo! - 1, d!, 0, minute + off * 60));
    const ny = nyTime(at.toISOString());
    if (ny.day === ymd && ny.minute === minute) {
      return new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .format(at)
        .replace(",", "");
    }
  }
  return "";
}
