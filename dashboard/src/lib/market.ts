// The crypto desk's market monitor as the pages read it: where each coin stands, the market they share, how they
// move together, what the books hold between them, and each sleeve's closed trades by their result in R.
// Everything here is a reading of what the host published. No rule, gate or model reads any of it.
import { items, type Crypto } from "@/lib/crypto";
import type { Tone } from "@/lib/labels";
import { sleeveLabel } from "@/lib/tournament";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOr = (v: unknown): number | null => (isNum(v) ? v : null);
const boolOr = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** "BTC/USD" is shown as "BTC": every pair on the desk is quoted in the same currency. */
export const coinOf = (pair: string | null | undefined): string => (typeof pair === "string" && pair ? (pair.split("/")[0] as string) : "—");

/** Decimals a price needs to be readable: a coin worth cents needs more of them than Bitcoin does. */
export const priceDigits = (v: number | null | undefined): number => (!isNum(v) ? 2 : Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4);

export interface RuleState {
  sleeve: string;
  label: string;
  fires: boolean;
  /** Conditions of the rule the coin did not meet on its last bar. Zero when it fires. */
  unmet: number;
}

export interface CoinRow {
  pair: string;
  coin: string;
  /** Place by 30-bar return, strongest first. Null when the coin has too few bars for it. */
  rank: number | null;
  close: number | null;
  bar: string | null;
  stale: boolean;
  retDay: number | null;
  ret30: number | null;
  toHigh20: number | null;
  toHigh30: number | null;
  aboveEma20: boolean | null;
  aboveEma50: boolean | null;
  rsi: number | null;
  atrPct: number | null;
  volumeRatio: number | null;
  /** What each registered sleeve made of the coin on its last evaluation. */
  rules: RuleState[];
  /** Books of the tournament holding the coin now. */
  heldBy: string[];
}

/** One row per coin the host published, in the host's order: strongest 30-bar return first. */
export function coinRows(s: Crypto): CoinRow[] {
  const held = new Map<string, string[]>();
  for (const c of items(s.exposure?.coins)) if (typeof c.pair === "string") held.set(c.pair, items(c.books).map(sleeveLabel));
  const rules = new Map<string, RuleState[]>();
  for (const x of items(s.sleeves)) {
    if (typeof x.name !== "string" || x.name.startsWith("ch-")) continue;
    for (const w of items(x.why_not)) {
      if (typeof w.pair !== "string") continue;
      const fires = w.fire === true;
      rules.set(w.pair, [...(rules.get(w.pair) ?? []), { sleeve: x.name, label: sleeveLabel(x.name), fires, unmet: fires ? 0 : items(w.why).length }]);
    }
  }
  return items(s.monitor?.pairs)
    .filter((r) => typeof r.pair === "string")
    .map((r) => ({
      pair: r.pair as string,
      coin: coinOf(r.pair),
      rank: numOr(r.rank),
      close: numOr(r.close),
      bar: r.bar ?? null,
      stale: r.stale === true,
      retDay: numOr(r.ret_day),
      ret30: numOr(r.ret_30),
      toHigh20: numOr(r.to_high_20_pct),
      toHigh30: numOr(r.to_high_30_pct),
      aboveEma20: boolOr(r.above_ema20),
      aboveEma50: boolOr(r.above_ema50),
      rsi: numOr(r.rsi),
      atrPct: numOr(r.atr_pct),
      volumeRatio: numOr(r.volume_ratio),
      rules: rules.get(r.pair as string) ?? [],
      heldBy: held.get(r.pair as string) ?? [],
    }));
}

/** The trend of a coin in two words, from its two averages. */
export function trendOf(r: Pick<CoinRow, "aboveEma20" | "aboveEma50">): { label: string; tone: Tone } {
  if (r.aboveEma20 === null || r.aboveEma50 === null) return { label: "Too few bars", tone: "neutral" };
  if (r.aboveEma20 && r.aboveEma50) return { label: "Above both", tone: "good" };
  if (!r.aboveEma20 && !r.aboveEma50) return { label: "Below both", tone: "bad" };
  return { label: r.aboveEma50 ? "Pulling back" : "Recovering", tone: "warn" };
}

export interface Regime {
  available: boolean;
  code: "up" | "down" | "mixed" | null;
  label: string;
  tone: Tone;
  btcClose: number | null;
  btcSma50: number | null;
  btcVsSma50Pct: number | null;
  btcRet30d: number | null;
  vol30dPct: number | null;
  pairs: number;
  aboveEma50: number | null;
  breadth: number | null;
  rising: number | null;
  dailyBar: string | null;
  stale: boolean;
  /** Close time of the newest 4-hour bar any coin has. */
  bar: string | null;
  tfMin: number | null;
}

const REGIME: Record<string, { label: string; tone: Tone }> = {
  up: { label: "Rising", tone: "good" },
  down: { label: "Falling", tone: "bad" },
  mixed: { label: "Mixed", tone: "warn" },
};

export function regimeOf(s: Crypto): Regime {
  const m = s.monitor;
  const r = m?.regime;
  const code = r?.code === "up" || r?.code === "down" || r?.code === "mixed" ? r.code : null;
  return {
    available: Boolean(m && r),
    code,
    label: code ? (REGIME[code]?.label as string) : "Not enough bars",
    tone: code ? (REGIME[code]?.tone as Tone) : "neutral",
    btcClose: numOr(r?.btc_close),
    btcSma50: numOr(r?.btc_sma50),
    btcVsSma50Pct: numOr(r?.btc_vs_sma50_pct),
    btcRet30d: numOr(r?.btc_ret_30d),
    vol30dPct: numOr(r?.vol_30d_pct),
    pairs: numOr(r?.pairs) ?? 0,
    aboveEma50: numOr(r?.above_ema50),
    breadth: numOr(r?.breadth),
    rising: numOr(r?.rising),
    dailyBar: r?.daily_bar ?? null,
    stale: r?.stale === true,
    bar: m?.bar ?? null,
    tfMin: numOr(m?.tf_min),
  };
}

export interface CorrelationGrid {
  coins: string[];
  /** cells[i][j] is coin i with coin j: one on the diagonal, null where the two share too few bars. */
  cells: (number | null)[][];
  bars: number | null;
  mean: number | null;
  low: number | null;
  high: number | null;
  /** The two coins that moved together least and most, when there is a value for any pair. */
  loosest: { a: string; b: string; value: number } | null;
  tightest: { a: string; b: string; value: number } | null;
}

/** Null when the host published no correlation, or one that is not square. */
export function correlationGrid(s: Crypto): CorrelationGrid | null {
  const c = s.monitor?.correlation;
  const pairs = items(c?.pairs).filter((p): p is string => typeof p === "string");
  const by = new Map<string, (number | null)[]>();
  for (const r of items(c?.rows)) if (typeof r.pair === "string" && Array.isArray(r.with)) by.set(r.pair, r.with.map(numOr));
  if (pairs.length < 2 || pairs.some((p) => by.get(p)?.length !== pairs.length)) return null;
  const cells = pairs.map((p) => (by.get(p) as (number | null)[]).map((v) => (v === null ? null : Math.max(-1, Math.min(1, v)))));
  let loosest: CorrelationGrid["loosest"] = null;
  let tightest: CorrelationGrid["tightest"] = null;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const value = cells[i]?.[j];
      if (!isNum(value)) continue;
      const pair = { a: coinOf(pairs[i]), b: coinOf(pairs[j]), value };
      if (!loosest || value < loosest.value) loosest = pair;
      if (!tightest || value > tightest.value) tightest = pair;
    }
  }
  return { coins: pairs.map(coinOf), cells, bars: numOr(c?.bars), mean: numOr(c?.mean), low: numOr(c?.low), high: numOr(c?.high), loosest, tightest };
}

/** How strongly a correlation cell is shaded, 0 to 1, and on which side of zero. */
export function shade(v: number | null): { side: "with" | "against" | "none"; strength: number } {
  if (!isNum(v) || Math.abs(v) < 0.005) return { side: "none", strength: 0 };
  return { side: v > 0 ? "with" : "against", strength: Math.min(1, Math.abs(v)) };
}

export interface ExposureMap {
  available: boolean;
  equity: number | null;
  gross: number | null;
  grossPct: number | null;
  risk: number | null;
  riskPct: number | null;
  largestSharePct: number | null;
  coins: { pair: string; coin: string; books: string[]; notional: number; sharePct: number; equityPct: number | null; risk: number | null; riskPct: number | null; unrealised: number | null }[];
  books: { name: string; label: string; equity: number | null; positions: number; notional: number; notionalPct: number | null; risk: number | null; riskPct: number | null }[];
}

export function exposureMap(s: Crypto): ExposureMap {
  const e = s.exposure;
  const equity = numOr(e?.equity);
  const risk = numOr(e?.risk);
  return {
    available: Boolean(e),
    equity,
    gross: numOr(e?.gross),
    grossPct: numOr(e?.gross_pct),
    risk,
    riskPct: isNum(risk) && isNum(equity) && equity > 0 ? (risk / equity) * 100 : null,
    largestSharePct: numOr(e?.largest_share_pct),
    coins: items(e?.coins)
      .filter((c) => typeof c.pair === "string" && isNum(c.notional) && c.notional > 0)
      .map((c) => ({
        pair: c.pair as string,
        coin: coinOf(c.pair),
        books: items(c.books).map(sleeveLabel),
        notional: c.notional as number,
        sharePct: Math.max(0, Math.min(100, numOr(c.share_pct) ?? 0)),
        equityPct: numOr(c.equity_pct),
        risk: numOr(c.risk),
        riskPct: numOr(c.risk_pct),
        unrealised: numOr(c.unrealised),
      }))
      .sort((a, b) => b.notional - a.notional || a.pair.localeCompare(b.pair)),
    books: items(e?.books)
      .filter((b) => typeof b.name === "string")
      .map((b) => ({
        name: b.name as string,
        label: sleeveLabel(b.name),
        equity: numOr(b.equity),
        positions: numOr(b.positions) ?? 0,
        notional: numOr(b.notional) ?? 0,
        notionalPct: numOr(b.notional_pct),
        risk: numOr(b.risk),
        riskPct: numOr(b.risk_pct),
      })),
  };
}

export interface RBand {
  key: string;
  /** The band's lower edge, or "under" its upper edge for the first band. */
  label: string;
  count: number;
  side: "loss" | "gain";
}

export interface SleeveResults {
  name: string;
  label: string;
  trades: number;
  bands: RBand[];
  meanWinR: number | null;
  meanLossR: number | null;
  /** The average win over the average loss, as a positive number. */
  payoff: number | null;
  winRate: number | null;
  /** The win rate at which this payoff breaks even: below it the sleeve loses however good its wins are. */
  breakevenWinRate: number | null;
  bestR: number | null;
  worstR: number | null;
  medianR: number | null;
}

const edge = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v)}`;

/** One entry per sleeve that has closed a trade and whose bands the host published. */
export function sleeveResults(s: Crypto): SleeveResults[] {
  return items(s.sleeves)
    .filter((x) => typeof x.name === "string")
    .map((x) => {
      const bands = items(x.r_bands)
        .filter((b) => isNum(b.n) && (isNum(b.lo) || isNum(b.hi)))
        .map((b, i) => ({
          key: String(i),
          label: isNum(b.lo) ? (isNum(b.hi) ? edge(b.lo) : `${edge(b.lo)}+`) : `under ${edge(b.hi as number)}`,
          count: b.n as number,
          side: (isNum(b.hi) && b.hi <= 0 ? "loss" : "gain") as "loss" | "gain",
        }));
      const payoff = numOr(x.payoff);
      return {
        name: x.name as string,
        label: sleeveLabel(x.name),
        trades: bands.reduce((a, b) => a + b.count, 0),
        bands,
        meanWinR: numOr(x.mean_win_r),
        meanLossR: numOr(x.mean_loss_r),
        payoff,
        winRate: numOr(x.win_rate),
        breakevenWinRate: isNum(payoff) && payoff > 0 ? 1 / (1 + payoff) : null,
        bestR: numOr(x.best_r),
        worstR: numOr(x.worst_r),
        medianR: numOr(x.median_r),
      };
    })
    .filter((x) => x.trades > 0);
}
