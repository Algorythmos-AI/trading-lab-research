// The Radar's pre-market brief: the day's verdict, SPY against its levels, and the names the owner trades. Pure: no
// I/O; any clock is passed in. Levels come from the options edition only, so the Radar and /options never show two
// different numbers for one line; prices, events and gauges come from the radar edition.
import { ALL, applyFilter, daysToExpiry, groupBy, HOUR_ORDER, hourKey, type GroupRow, type JournalDoc, type Trade } from "./journal";
import { levelName, type Options, type OptionsTicker } from "./options";
import { tickersOf, type Radar, type RadarEvent, type RadarGauge, type RadarTicker } from "./radar";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The list the radar puts the index-moving mega caps on. */
export const MEGA_LIST = "MEGA CAP OPTIONS";

/** The verdict's thresholds, printed on the page with the rules so the call can be checked. */
export const VIX_JUMP_PCT = 10;
export const GAP_SHARE = 0.8;

/** Releases that make a day red. Matched on the event's label, case-insensitive. */
const RED_RELEASE = /\b(fomc|fed (rate |interest rate )?decision|cpi|consumer price|payrolls?|nfp|non-?farm|pce)\b/i;

export type VerdictLevel = "red" | "amber" | "green" | "unchecked";
export interface VerdictReason {
  level: "red" | "amber";
  text: string;
}
export interface Verdict {
  level: VerdictLevel;
  reasons: VerdictReason[];
  /** Inputs the call could not check. With any of these the day is never called green. */
  unknown: string[];
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The month's standard options expiry: the third Friday, or the Thursday before it when that Friday is a holiday. */
export function monthlyExpiry(ymd: string, holidays: ReadonlySet<string> = new Set()): string {
  const first = `${ymd.slice(0, 7)}-01`;
  const wd = new Date(`${first}T12:00:00Z`).getUTCDay();
  const friday = addDays(first, ((5 - wd + 7) % 7) + 14);
  return holidays.has(friday) ? addDays(friday, -1) : friday;
}

/** The dates the radar's calendar marks as market holidays. */
export function holidaysOf(r: Radar): Set<string> {
  return new Set((r.calendar ?? []).filter((e) => e.kind === "holiday").map((e) => e.date));
}

/** The VIX gauge's change in percent. A change in points is turned into percent of the prior level. */
export function vixChangePct(gauges: readonly RadarGauge[] | null | undefined): number | null {
  const g = (gauges ?? []).find((x) => /^vix\b/i.test(x.label.trim()));
  if (!g || !isNum(g.change)) return null;
  if (g.change_unit === "pct") return g.change;
  if (g.change_unit !== "pts") return null;
  const level = Number.parseFloat(String(g.value ?? "").replace(/,/g, ""));
  const prior = level - g.change;
  return Number.isFinite(level) && prior > 0 ? (g.change / prior) * 100 : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when an earnings row is about this symbol: the symbol appears in its label as a whole word. */
export function earningsFor(e: RadarEvent, symbol: string): boolean {
  return e.kind === "earnings" && new RegExp(`(^|[^A-Z0-9.])${escapeRe(symbol.toUpperCase())}([^A-Z0-9]|$)`).test(e.label.toUpperCase());
}

/** The earnings rows for these names from a date on, nearest first. */
export function earningsAhead(r: Radar, symbols: readonly string[], from: string): { symbol: string; event: RadarEvent }[] {
  const out: { symbol: string; event: RadarEvent }[] = [];
  for (const e of r.calendar ?? []) {
    if (e.kind !== "earnings" || e.date < from) continue;
    for (const s of symbols) if (earningsFor(e, s)) out.push({ symbol: s, event: e });
  }
  return out.sort((a, b) => a.event.date.localeCompare(b.event.date));
}

/** True when the radar's calendar carries any earnings row at all; without one, "no earnings" cannot be claimed. */
export const hasEarningsData = (r: Radar) => (r.calendar ?? []).some((e) => e.kind === "earnings");

/**
 * The options edition when it is for the radar's session, else null. Levels and expected moves from another
 * session would put the gap against the wrong close.
 */
export function matchingOptions(r: Radar, o: Options | null): Options | null {
  return o && o.session === r.edition_date ? o : null;
}

/** A name's pre-market gap from the options edition's close, in one-day expected moves. Null without all three. */
export function gapInMoves(t: RadarTicker | undefined, o: OptionsTicker | undefined): number | null {
  const pre = t?.premarket_price;
  const close = o?.last?.close;
  const day = o?.expected_move?.day;
  if (!isNum(pre) || !isNum(close) || !isNum(day) || day <= 0) return null;
  return (pre - close) / day;
}

const fmtMoves = (v: number) => `${Math.abs(v).toFixed(1)}×`;

/**
 * The day's call. Red on an FOMC, CPI, payrolls or PCE day. Amber on the monthly expiry, another high-impact
 * release, an earnings report today on one of the names, a VIX rise over VIX_JUMP_PCT percent, or a name's gap past
 * GAP_SHARE of its daily expected move. Green only when every input was there and none fired.
 */
export function dayVerdict(r: Radar, options: Options | null, names: readonly string[]): Verdict {
  const today = r.edition_date;
  const reasons: VerdictReason[] = [];
  const unknown: string[] = [];
  const events = (r.calendar ?? []).filter((e) => e.date === today);

  if ((r.calendar ?? []).length === 0) unknown.push("the event calendar");
  for (const e of events) {
    if (e.kind !== "macro") continue;
    const when = e.time_et ? ` at ${e.time_et} NY` : "";
    if (RED_RELEASE.test(e.label)) reasons.push({ level: "red", text: `${e.label}${when}` });
    else if (e.impact === "high") reasons.push({ level: "amber", text: `${e.label}${when} (high impact)` });
  }

  if (monthlyExpiry(today, holidaysOf(r)) === today) reasons.push({ level: "amber", text: "Monthly options expiry" });

  if (hasEarningsData(r)) {
    for (const { symbol, event } of earningsAhead(r, names, today).filter((x) => x.event.date === today)) {
      reasons.push({ level: "amber", text: `${symbol} reports earnings today${event.time_et ? ` (${event.time_et} NY)` : ""}` });
    }
  } else if (names.length > 0) {
    unknown.push("earnings dates (not in today's calendar)");
  }

  const vix = vixChangePct(r.gauges);
  if (vix === null) unknown.push("the VIX change");
  else if (vix > VIX_JUMP_PCT) reasons.push({ level: "amber", text: `VIX up ${vix.toFixed(1)}%` });

  const o = matchingOptions(r, options);
  if (!o) {
    unknown.push("pre-market gaps (no options levels for this session)");
  } else {
    const bySym = new Map((r.tickers ?? []).map((t) => [t.symbol, t]));
    const opt = new Map(o.tickers.map((t) => [t.symbol, t]));
    let checked = 0;
    for (const s of names) {
      const g = gapInMoves(bySym.get(s), opt.get(s));
      if (g === null) continue;
      checked++;
      if (Math.abs(g) > GAP_SHARE) reasons.push({ level: "amber", text: `${s} gapped ${g > 0 ? "up" : "down"} ${fmtMoves(g)} its daily move` });
    }
    if (checked === 0 && names.length > 0) unknown.push("pre-market gaps (no pre-market prices)");
  }

  const level: VerdictLevel = reasons.some((x) => x.level === "red")
    ? "red"
    : reasons.length > 0
      ? "amber"
      : unknown.length > 0
        ? "unchecked"
        : "green";
  return { level, reasons: [...reasons.filter((x) => x.level === "red"), ...reasons.filter((x) => x.level === "amber")], unknown };
}

/** The levels the SPY map draws, in the trader's names. PDC is the close marker, not a rung. */
export const LADDER_LEVELS = ["PDH", "PDL", "PWH", "PWL", "PMH", "PML"] as const;

export interface LadderRung {
  code: string;
  label: string;
  price: number;
  /** Whether the level sits above or below the reference price (pre-market when there is one, else the close). */
  side: "above" | "below";
}
export interface Ladder {
  close: number;
  pre: number | null;
  /** The price the rungs are judged against. */
  ref: number;
  band: [number, number] | null;
  rungs: LadderRung[];
  /** The nearest rung above and below the reference price. */
  up: LadderRung | null;
  down: LadderRung | null;
}

/** A name's named levels around its pre-market price (or its close), with the day's expected-move band. */
export function levelLadder(t: OptionsTicker, pre: number | null | undefined): Ladder | null {
  const close = t.last?.close;
  if (!isNum(close) || close <= 0) return null;
  const p = isNum(pre) && pre > 0 ? pre : null;
  const ref = p ?? close;
  const rungs: LadderRung[] = [];
  for (const code of LADDER_LEVELS) {
    const l = t.levels?.find((x) => x.name === code);
    if (!l || !isNum(l.price)) continue;
    rungs.push({ code, label: levelName(code), price: l.price, side: l.price > ref ? "above" : "below" });
  }
  rungs.sort((a, b) => a.price - b.price);
  const day = t.expected_move?.day;
  const above = rungs.filter((x) => x.side === "above");
  const below = rungs.filter((x) => x.side === "below");
  return {
    close,
    pre: p,
    ref,
    band: isNum(day) && day > 0 ? [close - day, close + day] : null,
    rungs,
    up: above[0] ?? null,
    down: below[below.length - 1] ?? null,
  };
}

/** The year's trades, or every trade when the year has none yet (early January). */
function yearTrades(j: JournalDoc, now: Date): Trade[] {
  const year = applyFilter(j.trades, { ...ALL, period: "ytd" }, now);
  return year.length > 0 ? year : applyFilter(j.trades, ALL, now);
}

/** The names the owner trades most this year, by trade count, with their result. Read from the journal, never typed in. */
export function yourNames(j: JournalDoc | null, now: Date, n = 5): GroupRow[] {
  if (!j) return [];
  return groupBy(yearTrades(j, now), (t) => t.symbol)
    .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key))
    .slice(0, n);
}

/** Bands with fewer trades than this are drawn but never called the worst window. */
export const WINDOW_MIN_TRADES = 5;

/** Same-day options results by when in the New York session they were opened, this year, with the worst band. */
export function windowRecord(j: JournalDoc | null, now: Date): { rows: GroupRow[]; worst: string | null; trades: number } {
  if (!j) return { rows: [], worst: null, trades: 0 };
  const same = yearTrades(j, now).filter((t) => t.kind !== "stock" && daysToExpiry(t) === 0);
  const rows = groupBy(same, hourKey, HOUR_ORDER).filter((r) => r.key !== "pre" && r.key !== "post");
  const eligible = rows.filter((r) => r.trades >= WINDOW_MIN_TRADES && r.pnl < 0);
  const worst = eligible.length > 0 ? eligible.reduce((a, b) => (b.pnl < a.pnl ? b : a)).key : null;
  return { rows, worst, trades: same.length };
}

export interface NameRow {
  symbol: string;
  pre: number | null;
  /** Pre-market move from the radar's last price, in percent. */
  prePct: number | null;
  changePct: number | null;
  why: string | null;
  up: LadderRung | null;
  down: LadderRung | null;
  gap: number | null;
  move: number | null;
  earnings: RadarEvent | null;
  record: GroupRow | null;
}

/** One row per traded name: where it stands before the bell, its nearest levels, any earnings this week, its record. */
export function nameRows(r: Radar, options: Options | null, names: readonly GroupRow[]): NameRow[] {
  const o = matchingOptions(r, options);
  const bySym = new Map((r.tickers ?? []).map((t) => [t.symbol, t]));
  const opt = new Map((o?.tickers ?? []).map((t) => [t.symbol, t]));
  const weekEnd = addDays(r.edition_date, 7);
  const earnings = earningsAhead(r, names.map((x) => x.key), r.edition_date).filter((x) => x.event.date < weekEnd);
  return names.map((g) => {
    const t = bySym.get(g.key);
    const ot = opt.get(g.key);
    const pre = isNum(t?.premarket_price) ? t.premarket_price : null;
    const lad = ot ? levelLadder(ot, pre) : null;
    return {
      symbol: g.key,
      pre,
      prePct: pre !== null && isNum(t?.price) && t.price > 0 ? (pre / t.price - 1) * 100 : null,
      changePct: isNum(t?.change_pct) ? t.change_pct : null,
      why: t?.why ?? null,
      up: lad?.up ?? null,
      down: lad?.down ?? null,
      gap: gapInMoves(t, ot),
      move: isNum(ot?.expected_move?.day) ? ot.expected_move.day : null,
      earnings: earnings.find((x) => x.symbol === g.key)?.event ?? null,
      record: g,
    };
  });
}

/** The mega caps' pre-market moves, largest first. Names without a pre-market price are left out, not shown as flat. */
export function megaMovers(r: Radar): { symbol: string; pct: number; why: string | null }[] {
  return tickersOf(r, MEGA_LIST)
    .filter((t) => isNum(t.premarket_price) && isNum(t.price) && t.price > 0)
    .map((t) => ({ symbol: t.symbol, pct: ((t.premarket_price as number) / (t.price as number) - 1) * 100, why: t.why ?? null }))
    .sort((a, b) => b.pct - a.pct);
}
