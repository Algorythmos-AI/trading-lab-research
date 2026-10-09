// The crypto tournament (DEC-0015) as the pages read it: one row per sleeve, never pooled. Pure helpers.
// A challenger that passed its backtest (DEC-0016) is a sleeve like the others; `challengers` lists every idea tried.
import { items, type Crypto } from "./crypto";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown): number | null => (isNum(v) ? v : null);

/** What each sleeve is, in plain words. An unknown sleeve is shown by its own name. */
const SLEEVE: Record<string, { label: string; does: string }> = {
  trend: { label: "Trend", does: "Buys a new 20-bar high in an uptrend; trails its stop; leaves when the trend ends" },
  break: { label: "Breakout", does: "Buys a close above the 30-bar high on strong volume; fixed stop and target" },
  dip: { label: "Dip", does: "Buys the first recovery after a sell-off, while the daily trend is up" },
};
export const sleeveLabel = (name: string | null | undefined): string =>
  SLEEVE[name ?? ""]?.label ?? (name?.startsWith("ch-") ? `Challenger ${name.slice(3)}` : (name ?? "—"));

export interface SleeveRow {
  name: string;
  label: string;
  does: string;
  hypothesis: string | null;
  stage: string;
  equity: number | null;
  start: number | null;
  returnPct: number | null;
  openPnl: number | null;
  today: number | null;
  week: number | null;
  month: number | null;
  total: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  meanR: number | null;
  maxDd: number | null;
  open: number;
  latched: boolean;
}

export interface SleevePosition {
  sleeve: string;
  pair: string;
  qty: number | null;
  entry: number | null;
  entryAt: string | null;
  stop: number | null;
  target: number | null;
  mark: number | null;
  markAt: string | null;
  openPnl: number | null;
  openPct: number | null;
  openR: number | null;
}

export interface SleeveTrade {
  sleeve: string;
  pair: string;
  entryAt: string | null;
  exitAt: string | null;
  entry: number | null;
  exit: number | null;
  qty: number | null;
  pnl: number | null;
  r: number | null;
  reason: string | null;
  heldMin: number | null;
}

export interface SleeveSignal {
  sleeve: string;
  at: string | null;
  pair: string;
  entered: boolean;
  why: string[];
}

export interface Tournament {
  /** False until the host publishes the section. */
  available: boolean;
  rows: SleeveRow[];
  positions: SleevePosition[];
  /** Newest first, across sleeves. */
  trades: SleeveTrade[];
  signals: SleeveSignal[];
  /** Per pair, what each sleeve said about its newest bar. */
  checks: { pair: string; bar: string | null; by: Record<string, { fire: boolean; why: string[] }> }[];
  curves: { name: string; label: string; points: number[] }[];
}

const byTime = <T,>(key: (x: T) => string | null) => (a: T, b: T) => (key(b) ?? "").localeCompare(key(a) ?? "");

export function tournament(s: Crypto): Tournament {
  const sleeves = items(s.sleeves).filter((x) => typeof x.name === "string");
  const rows: SleeveRow[] = sleeves.map((x) => ({
    name: x.name as string,
    label: sleeveLabel(x.name),
    does: SLEEVE[x.name as string]?.does ?? x.strategy ?? "",
    hypothesis: x.strategy ?? null,
    stage: x.stage ?? "incubation",
    equity: n(x.equity),
    start: n(x.start_equity),
    returnPct: n(x.return_pct),
    openPnl: n(x.open_pnl),
    today: n(x.pnl?.today),
    week: n(x.pnl?.week),
    month: n(x.pnl?.month),
    total: n(x.pnl?.total),
    trades: n(x.trades) ?? 0,
    wins: n(x.wins) ?? 0,
    losses: n(x.losses) ?? 0,
    winRate: n(x.win_rate),
    meanR: n(x.mean_r),
    maxDd: n(x.max_dd),
    open: items(x.positions).length,
    latched: x.latched === true,
  }));
  const positions: SleevePosition[] = sleeves.flatMap((x) =>
    items(x.positions)
      .filter((p) => typeof p.pair === "string")
      .map((p) => ({
        sleeve: x.name as string,
        pair: p.pair as string,
        qty: n(p.qty),
        entry: n(p.entry_price),
        entryAt: p.entry_time ?? null,
        stop: n(p.stop),
        target: n(p.target),
        mark: n(p.mark),
        markAt: p.mark_time ?? null,
        openPnl: n(p.unrealised),
        openPct: n(p.unrealised_pct),
        openR: n(p.unrealised_r),
      })),
  );
  const trades: SleeveTrade[] = sleeves
    .flatMap((x) =>
      items(x.recent)
        .filter((t) => typeof t.pair === "string")
        .map((t) => ({
          sleeve: x.name as string,
          pair: t.pair as string,
          entryAt: t.entry_time ?? null,
          exitAt: t.exit_time ?? null,
          entry: n(t.entry_price),
          exit: n(t.exit_price),
          qty: n(t.qty),
          pnl: n(t.pnl),
          r: n(t.r),
          reason: t.reason ?? null,
          heldMin: n(t.held_min),
        })),
    )
    .sort(byTime((t) => t.exitAt));
  const signals: SleeveSignal[] = sleeves
    .flatMap((x) =>
      items(x.signals)
        .filter((g) => typeof g.pair === "string")
        .map((g) => ({ sleeve: x.name as string, at: g.t ?? null, pair: g.pair as string, entered: g.outcome === "entered", why: items(g.why) })),
    )
    .sort(byTime((g) => g.at));
  const pairs = new Map<string, Tournament["checks"][number]>();
  for (const x of sleeves) {
    for (const w of items(x.why_not)) {
      if (typeof w.pair !== "string") continue;
      const row = pairs.get(w.pair) ?? { pair: w.pair, bar: w.bar ?? null, by: {} };
      row.by[x.name as string] = { fire: w.fire === true, why: items(w.why) };
      pairs.set(w.pair, row);
    }
  }
  return {
    available: Array.isArray(s.sleeves) && sleeves.length > 0,
    rows,
    positions,
    trades,
    signals,
    checks: [...pairs.values()],
    curves: sleeves.map((x) => ({
      name: x.name as string,
      label: sleeveLabel(x.name),
      points: items(x.equity_curve)
        .map((p) => (isNum(p.equity) && isNum(x.start_equity) ? p.equity - x.start_equity : null))
        .filter((v): v is number => v !== null),
    })),
  };
}

/** "2 positions open across 2 sleeves" style one-liner for the page heading; statuses and counts only. */
export function tournamentLine(t: Tournament): string {
  if (!t.available) return "The tournament has not published yet.";
  const open = t.positions.length;
  const closed = t.rows.reduce((a, r) => a + r.trades, 0);
  const holders = new Set(t.positions.map((p) => p.sleeve)).size;
  const openPart = open === 0 ? "No position is open" : `${open} ${open === 1 ? "position is" : "positions are"} open in ${holders} ${holders === 1 ? "sleeve" : "sleeves"}`;
  return `${openPart}; ${closed} ${closed === 1 ? "trade has" : "trades have"} been closed.`;
}

export interface ChallengerRow {
  id: string;
  label: string;
  /** Its rules in one line, as the host recorded them before the backtest. */
  rules: string;
  /** "neighbour" (one step from the best current sleeve) or "random". */
  slot: string | null;
  of: string | null;
  registeredAt: string | null;
  /** registered | failed | passed | live | retired */
  status: string;
  trades: number | null;
  perMonth: number | null;
  winRate: number | null;
  meanR: number | null;
  /** 95% interval for the mean R with slippage raised by half: the one the gate reads. */
  ciLow: number | null;
  ciHigh: number | null;
  profitFactor: number | null;
  controlP: number | null;
  failedOn: string[];
  retiredWhy: string | null;
  /** The same rules on the two years before the backtest's span (DEC-0021). Null when that run has not happened. */
  confirm: { passed: boolean; trades: number | null; meanR: number | null; profitFactor: number | null } | null;
  /** What its backtest's trades cost in R, and what they made before costs (DEC-0022). For reading the verdict, never part of it. */
  cost: { meanR: number; grossR: number; grossSe: number | null } | null;
}

export interface Challengers {
  /** False until the host publishes the section. */
  available: boolean;
  learningOn: boolean;
  drawnThisWeek: number;
  perWeek: number | null;
  live: number;
  maxLive: number | null;
  registered: number;
  maxRegistered: number | null;
  failed: number;
  retired: number;
  /** Newest first. */
  rows: ChallengerRow[];
}

export function challengers(s: Crypto): Challengers {
  const c = s.challengers;
  const rows: ChallengerRow[] = items(c?.list)
    .filter((x) => typeof x.id === "string")
    .map((x) => ({
      id: x.id as string,
      label: sleeveLabel(x.id),
      rules: x.rules ?? "",
      slot: x.slot ?? null,
      of: x.of ?? null,
      registeredAt: x.registered ?? null,
      status: x.status ?? "registered",
      trades: n(x.trades),
      perMonth: n(x.trades_per_month),
      winRate: n(x.win_rate),
      meanR: n(x.mean_r),
      ciLow: n(x.ci_low),
      ciHigh: n(x.ci_high),
      profitFactor: n(x.profit_factor),
      controlP: n(x.control_p),
      failedOn: items(x.failed_on).filter((v): v is string => typeof v === "string"),
      retiredWhy: x.retired_why ?? null,
      cost: isNum(x.cost_mean_r) && isNum(x.gross_mean_r) ? { meanR: x.cost_mean_r, grossR: x.gross_mean_r, grossSe: n(x.gross_se_r) } : null,
      confirm:
        typeof x.confirm_passed === "boolean"
          ? { passed: x.confirm_passed, trades: n(x.confirm_trades), meanR: n(x.confirm_mean_r), profitFactor: n(x.confirm_profit_factor) }
          : null,
    }));
  return {
    available: c != null,
    learningOn: c?.learning !== "off",
    drawnThisWeek: n(c?.drawn_this_week) ?? 0,
    perWeek: n(c?.per_week),
    live: n(c?.live) ?? 0,
    maxLive: n(c?.max_live),
    registered: n(c?.registered) ?? 0,
    maxRegistered: n(c?.max_registered),
    failed: n(c?.failed) ?? 0,
    retired: n(c?.retired) ?? 0,
    rows,
  };
}

/** "3 ideas tried: 1 trading, 1 failed its backtest, 1 waiting for its backtest." Counts only. */
export function challengersLine(c: Challengers): string {
  if (!c.available) return "The challengers have not published yet.";
  if (c.registered === 0) return c.learningOn ? "No idea has been tried yet." : "Learning is switched off; no idea has been tried.";
  const waiting = c.rows.filter((r) => r.status === "registered" || r.status === "passed").length;
  const parts = [
    c.live > 0 ? `${c.live} trading` : null,
    c.failed > 0 ? `${c.failed} failed ${c.failed === 1 ? "its" : "their"} backtest` : null,
    c.retired > 0 ? `${c.retired} retired` : null,
    waiting > 0 ? `${waiting} waiting for ${waiting === 1 ? "its" : "their"} backtest` : null,
  ].filter((x): x is string => x !== null);
  return `${c.registered} ${c.registered === 1 ? "idea" : "ideas"} tried: ${parts.join(", ")}.${c.learningOn ? "" : " Learning is switched off."}`;
}

// ---- pictures of the tournament: pure helpers for the charts ----

export interface EquityLine {
  name: string;
  label: string;
  /** The original 15-minute rule's own book, drawn beside the tournament for comparison. */
  baseline: boolean;
  /** Return since the book's start, in percent, at each published mark (epoch ms). */
  points: { t: number; pct: number }[];
  lastPct: number | null;
  /** The deepest fall from an earlier high, in percent of that high (zero or below). Null with fewer than two marks. */
  worstDrawdownPct: number | null;
}

function lineOf(name: string, label: string, baseline: boolean, start: number | null | undefined, curve: readonly ({ t?: string | null; equity?: number | null } | null)[] | null | undefined): EquityLine {
  if (!isNum(start) || start <= 0) return { name, label, baseline, points: [], lastPct: null, worstDrawdownPct: null };
  const marks = items(curve)
    .map((p) => ({ t: typeof p.t === "string" ? Date.parse(p.t) : NaN, equity: p.equity }))
    .filter((p): p is { t: number; equity: number } => Number.isFinite(p.t) && isNum(p.equity))
    .sort((a, b) => a.t - b.t);
  let peak = -Infinity;
  let worst = 0;
  for (const p of marks) {
    peak = Math.max(peak, p.equity);
    worst = Math.min(worst, (p.equity / peak - 1) * 100);
  }
  const points = marks.map((p) => ({ t: p.t, pct: (p.equity / start - 1) * 100 }));
  return { name, label, baseline, points, lastPct: points.at(-1)?.pct ?? null, worstDrawdownPct: points.length >= 2 ? worst : null };
}

/** One line per paper book: every sleeve, then the baseline rule. Books with no published mark are left out. */
export function equityLines(s: Crypto): EquityLine[] {
  const sleeves = items(s.sleeves)
    .filter((x) => typeof x.name === "string")
    .map((x) => lineOf(x.name as string, sleeveLabel(x.name), false, x.start_equity, x.equity_curve));
  const base = lineOf("baseline", "Baseline 15-minute rule", true, s.book?.start_equity, s.perf?.equity_curve);
  return [...sleeves, base].filter((l) => l.points.length > 0);
}

export interface DeskTotals {
  books: number;
  equity: number | null;
  returnPct: number | null;
  today: number | null;
  week: number | null;
  trades: number;
  winRate: number | null;
  open: number;
  /** The book with the best return so far, when any has moved. */
  leader: { label: string; returnPct: number } | null;
}

/** The tournament's books added up. Money is paper money; nothing here pools the books for trading. */
export function deskTotals(t: Tournament): DeskTotals {
  const sum = (pick: (r: SleeveRow) => number | null) => {
    const v = t.rows.map(pick).filter(isNum);
    return v.length > 0 ? v.reduce((a, b) => a + b, 0) : null;
  };
  const equity = sum((r) => r.equity);
  const start = sum((r) => r.start);
  const trades = t.rows.reduce((a, r) => a + r.trades, 0);
  const wins = t.rows.reduce((a, r) => a + r.wins, 0);
  const moved = t.rows.filter((r) => isNum(r.returnPct) && Math.abs(r.returnPct) >= 0.005).sort((a, b) => (b.returnPct as number) - (a.returnPct as number))[0];
  return {
    books: t.rows.length,
    equity,
    returnPct: isNum(equity) && isNum(start) && start > 0 ? (equity / start - 1) * 100 : null,
    today: sum((r) => r.today),
    week: sum((r) => r.week),
    trades,
    winRate: trades > 0 ? wins / trades : null,
    open: t.positions.length,
    leader: moved ? { label: moved.label, returnPct: moved.returnPct as number } : null,
  };
}

export interface TradeGroup {
  key: string;
  label: string;
  n: number;
  meanR: number | null;
}

export interface TradeStats {
  /** Oldest first: one bar per closed trade. */
  series: { i: number; r: number; label: string; pair: string; at: string | null; reason: string | null }[];
  bySleeve: TradeGroup[];
  byReason: TradeGroup[];
}

/** The published closed trades (the newest of each sleeve), in the order they ended, and grouped two ways. */
export function tradeStats(trades: SleeveTrade[]): TradeStats {
  const done = trades.filter((x) => isNum(x.r)).sort((a, b) => (a.exitAt ?? "").localeCompare(b.exitAt ?? ""));
  const group = (key: (x: SleeveTrade) => string, label: (k: string) => string): TradeGroup[] => {
    const by = new Map<string, number[]>();
    for (const x of done) by.set(key(x), [...(by.get(key(x)) ?? []), x.r as number]);
    return [...by.entries()]
      .map(([k, rs]) => ({ key: k, label: label(k), n: rs.length, meanR: rs.reduce((a, b) => a + b, 0) / rs.length }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  };
  return {
    series: done.map((x, i) => ({ i: i + 1, r: x.r as number, label: sleeveLabel(x.sleeve), pair: x.pair, at: x.exitAt, reason: x.reason })),
    bySleeve: group((x) => x.sleeve, sleeveLabel),
    byReason: group((x) => x.reason ?? "unknown", (k) => k),
  };
}
