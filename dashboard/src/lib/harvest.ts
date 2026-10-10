// The crypto desk's data harvest (DEC-0027) as the pages read it, from the crypto snapshot's `harvest`. Pure helpers.
import { items, type Crypto } from "./crypto";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown): number | null => (isNum(v) ? v : null);
const count = (v: unknown): number => (isNum(v) ? v : 0);

const RULE: Record<string, string> = { trend: "Trend", break: "Breakout", dip: "Dip" };

/** A harvest book in plain words: "Trend, 4-hour", "Dip, 1-hour", "Random entries, 1-hour". */
export function harvestBookLabel(name: string | null | undefined, tfMin: number | null | undefined): string {
  const tf = isNum(tfMin) ? (tfMin % 60 === 0 ? `${tfMin / 60}-hour` : `${tfMin}-minute`) : "";
  const raw = (name ?? "").replace(/^h-/, "").replace(/-\d+m$/, "");
  const what = raw === "explore" ? "Random entries" : (RULE[raw] ?? (raw || "—"));
  return tf ? `${what}, ${tf}` : what;
}

export interface HarvestBook {
  name: string;
  label: string;
  tfMin: number | null;
  equity: number | null;
  returnPct: number | null;
  open: number;
  trades: number;
  signals: number;
  signals7d: number;
}

export interface HarvestDay {
  day: string;
  signals: number;
  entries: number;
  exits: number;
  labelled: number;
}

export interface Harvest {
  available: boolean;
  switchOn: boolean;
  coins: number;
  since: string | null;
  signalsToday: number;
  entriesToday: number;
  exitsToday: number;
  signals7d: number;
  entries7d: number;
  labelled: number;
  labelled7d: number;
  winRate: number | null;
  meanR: number | null;
  featureRows7d: number;
  perDay7d: number;
  days: HarvestDay[];
  books: HarvestBook[];
}

export function harvest(s: Crypto): Harvest {
  const h = s.harvest;
  const days: HarvestDay[] = items(h?.daily).map((d) => ({
    day: d.day ?? "",
    signals: count(d.signals),
    entries: count(d.entries),
    exits: count(d.exits),
    labelled: count(d.labelled),
  }));
  const books: HarvestBook[] = items(h?.books).map((b) => ({
    name: b.name ?? "",
    label: harvestBookLabel(b.name, b.tf_min),
    tfMin: n(b.tf_min),
    equity: n(b.equity),
    returnPct: n(b.return_pct),
    open: count(b.open),
    trades: count(b.trades),
    signals: count(b.signals),
    signals7d: count(b.signals_7d),
  }));
  const last7 = days.slice(-7);
  return {
    available: h != null,
    switchOn: h?.switch !== "off",
    coins: count(h?.coins),
    since: h?.since ?? null,
    signalsToday: count(h?.signals_today),
    entriesToday: count(h?.entries_today),
    exitsToday: count(h?.exits_today),
    signals7d: count(h?.signals_7d),
    entries7d: count(h?.entries_7d),
    labelled: count(h?.labelled),
    labelled7d: count(h?.labelled_7d),
    winRate: n(h?.win_rate),
    meanR: n(h?.mean_r),
    featureRows7d: count(h?.feature_rows_7d),
    perDay7d: last7.length ? last7.reduce((a, d) => a + d.signals, 0) / last7.length : 0,
    days,
    books,
  };
}

/** One line for the Overview: what the harvest collected. */
export function harvestLine(h: Harvest): string {
  if (!h.available) return "The data harvest has not recorded anything yet.";
  if (!h.switchOn) return "The data harvest is switched off: its books open nothing, and open positions are still managed.";
  return `${h.signalsToday} signals and ${h.entriesToday} paper entries today across ${h.coins} coins; ${h.labelled} trades labelled so far.`;
}
