// Paper B's trades and profit and loss as a person reads them, from the snapshot's `today` section. Pure helpers:
// no I/O and no clock. Money is the US$600 paper ledger's; nothing here is a real order.
import { detailLabel } from "./today";
import { list, type Snapshot } from "./types";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown): number | null => (isNum(v) ? v : null);

export interface PnlPeriod {
  key: "today" | "week" | "month" | "total";
  label: string;
  money: number | null;
  r: number | null;
  /** Closed trades in the period; null for the all-time row's own count field (see `trades`). */
  trades: number | null;
}

export interface OpenPosition {
  symbol: string;
  /** "in_position" once filled, "entry_working" while the order waits for its trigger. */
  state: string;
  qty: number | null;
  entry: number | null;
  entryAt: string | null;
  trigger: number | null;
  stop: number | null;
  target: number | null;
  /** From the broker's paper account, as of the snapshot. Null while the order is still working. */
  mark: number | null;
  openPnl: number | null;
  openR: number | null;
}

export interface Trade {
  session: string;
  symbol: string;
  qty: number | null;
  entry: number | null;
  entryAt: string | null;
  exit: number | null;
  exitAt: string | null;
  stop: number | null;
  target: number | null;
  pnl: number | null;
  r: number | null;
  reason: string | null;
  heldMin: number | null;
  estimated: boolean;
}

export interface Signal {
  at: string | null;
  trigger: number | null;
  stop: number | null;
  blockers: string;
  acted: boolean;
}

export interface Trading {
  /** False until the host publishes the section: the page then keeps its older panels only. */
  available: boolean;
  session: string | null;
  /** True when `session` is the market's current trading day, so an older day is never called today. */
  current: boolean;
  ended: boolean;
  outcome: string | null;
  periods: PnlPeriod[];
  equity: number | null;
  start: number | null;
  returnPct: number | null;
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    profitFactor: number | null;
    best: number | null;
    worst: number | null;
    maxDd: number | null;
  };
  position: OpenPosition | null;
  /** Newest first. */
  trades: Trade[];
  days: { date: string; pnl: number | null; r: number | null; trades: number }[];
  signals: Signal[];
}

const returnOf = (equity: number | null, start: number | null): number | null =>
  equity !== null && start !== null && start > 0 ? (equity / start - 1) * 100 : null;

export function trading(s: Snapshot): Trading {
  const t = s.today;
  const p = t?.pnl;
  const session = t?.session ?? null;
  const tradingDay = s.market?.trading_day_et ?? null;
  const raw = t?.position ?? null;
  let position: OpenPosition | null = null;
  if (raw && typeof raw.symbol === "string") {
    const held = list(s.ops?.account?.positions).find((x) => x.symbol === raw.symbol && isNum(x.qty) && x.qty !== 0);
    const qty = n(raw.qty);
    const entry = n(raw.entry);
    const stop = n(raw.stop);
    const mark = held && isNum(held.market_value) && isNum(held.qty) ? held.market_value / held.qty : null;
    const filled = raw.state === "in_position" && entry !== null && qty !== null;
    const openPnl = filled && mark !== null ? (mark - entry) * qty : null;
    const risk = filled && stop !== null && entry - stop > 0 ? (entry - stop) * qty : null;
    position = {
      symbol: raw.symbol,
      state: raw.state ?? "entry_working",
      qty,
      entry,
      entryAt: raw.entry_at ?? null,
      trigger: n(raw.trigger),
      stop,
      target: n(raw.target),
      mark: filled ? mark : null,
      openPnl,
      openR: openPnl !== null && risk !== null ? openPnl / risk : null,
    };
  }
  const trades: Trade[] = list(t?.trades)
    .filter((x) => typeof x.session === "string" && typeof x.symbol === "string")
    .map((x) => ({
      session: x.session as string,
      symbol: x.symbol as string,
      qty: n(x.qty),
      entry: n(x.entry),
      entryAt: x.entry_at ?? null,
      exit: n(x.exit),
      exitAt: x.exit_at ?? null,
      stop: n(x.stop),
      target: n(x.target),
      pnl: n(x.pnl),
      r: n(x.r),
      reason: x.reason ?? null,
      heldMin: n(x.held_min),
      estimated: x.estimated === true,
    }))
    .reverse();
  return {
    available: t !== undefined && t !== null,
    session,
    current: session !== null && tradingDay !== null && session === tradingDay,
    ended: t?.ended === true,
    outcome: t?.outcome ?? null,
    periods: [
      { key: "today", label: "Today", money: n(p?.today), r: n(p?.today_r), trades: n(p?.today_trades) },
      { key: "week", label: "This week", money: n(p?.week), r: n(p?.week_r), trades: n(p?.week_trades) },
      { key: "month", label: "This month", money: n(p?.month), r: n(p?.month_r), trades: n(p?.month_trades) },
      { key: "total", label: "All time", money: n(p?.total), r: n(p?.total_r), trades: n(p?.trades) },
    ],
    // Before the first trade the ledger file does not exist yet: the runner's own figures stand in for it.
    equity: n(p?.equity) ?? n(s.ops?.paper?.virtual?.equity),
    start: n(p?.start) ?? n(s.ops?.paper?.virtual?.start),
    returnPct: n(p?.return_pct) ?? returnOf(n(s.ops?.paper?.virtual?.equity), n(s.ops?.paper?.virtual?.start)),
    stats: {
      trades: n(p?.trades) ?? 0,
      wins: n(p?.wins) ?? 0,
      losses: n(p?.losses) ?? 0,
      winRate: n(p?.win_rate),
      avgWin: n(p?.avg_win),
      avgLoss: n(p?.avg_loss),
      profitFactor: n(p?.profit_factor),
      best: n(p?.best),
      worst: n(p?.worst),
      maxDd: n(p?.max_dd),
    },
    position,
    trades,
    days: list(t?.days)
      .filter((d) => typeof d.date === "string")
      .map((d) => ({ date: d.date as string, pnl: n(d.pnl), r: n(d.r), trades: n(d.trades) ?? 0 })),
    signals: list(t?.signals).map((x) => ({
      at: x.at ?? null,
      trigger: n(x.trigger),
      stop: n(x.stop),
      blockers: detailLabel(x.blockers),
      acted: x.acted === true,
    })),
  };
}

/** Plain words for how a trade ended. An unknown code is shown as it is. */
const REASON: Record<string, string> = {
  target: "Target reached",
  stop: "Stopped out",
  eod_flatten: "Closed before the bell",
  eod_market: "Closed at the bell",
  eod_verify: "Closed at the bell",
  manual: "Closed by hand",
};
export const reasonLabel = (r: string | null | undefined): string => (typeof r === "string" && r ? (REASON[r] ?? r.replace(/_/g, " ")) : "—");

export type OutcomeTone = "good" | "warn" | "bad" | "info" | "neutral";

/** One plain answer to "did it trade, and if not, why": the session's recorded outcome in words. */
export function outcomeLine(v: Trading): { tone: OutcomeTone; title: string; detail: string } {
  const o = v.outcome ?? "";
  if (!v.available || v.session === null) {
    return { tone: "neutral", title: "No session recorded yet", detail: "Paper B arms at 08:30 New York on trading days." };
  }
  if (o === "traded") {
    return v.position
      ? { tone: "info", title: "In a trade now", detail: "It placed an entry this session. The open position is below." }
      : { tone: "good", title: "It traded", detail: "It placed an entry this session. The result is in the trades below." };
  }
  if (o === "no_signal") {
    return { tone: "neutral", title: "No trade: no signal", detail: "QQQ never closed a half-hour above its noise boundary and its average price, so the rule had nothing to act on. This is the usual outcome on most days." };
  }
  if (o === "no_inputs") {
    return { tone: "bad", title: "No trade: the signal could not be checked", detail: "The prices the rule needs were missing for the whole session, so it never ran. This is a data fault, not a quiet market." };
  }
  if (o === "signal_not_acted") {
    return { tone: "bad", title: "No trade: a signal fired and was not acted on", detail: "Nothing was blocking it and no entry was placed. This is a fault to look at before the next session." };
  }
  if (o.startsWith("blocked")) {
    const why = detailLabel(o.split(":")[1] ?? "") || "a safety check";
    return { tone: "warn", title: `No trade: blocked (${why})`, detail: "A signal fired, and a safety check stopped the entry." };
  }
  if (!v.ended) {
    return { tone: "info", title: "Session in progress", detail: "No entry yet. Paper B checks QQQ on each half-hour from 10:00 New York and takes at most one trade a day." };
  }
  return { tone: "neutral", title: "No trade", detail: "The session ended without an entry." };
}

/** "Paper B took a trade today." Statuses only, never money, and only for the current trading day. */
export function tradeSentence(s: Snapshot): string | null {
  const v = trading(s);
  if (!v.available || !v.current) return null;
  const o = v.outcome ?? "";
  if (o === "traded") return v.position ? "Paper B is in a trade." : "Paper B took a trade today.";
  if (o === "no_signal") return "Paper B had no signal today.";
  if (o === "no_inputs") return "Paper B could not check its signal today: the prices it needs were missing.";
  if (o === "signal_not_acted") return "Paper B had a signal and did not act on it.";
  if (o.startsWith("blocked")) return "Paper B had a signal that a safety check blocked.";
  return null;
}
