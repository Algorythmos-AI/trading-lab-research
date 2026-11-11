// The Trades page's list of every closed trade, its pure parts: one row model for both renderings (the table from sm
// up, a card per trade on a phone), the search, the winners/losers filter and the sort they share, and the words
// each row shows. Pure: no I/O and no clock.

export interface JournalRow {
  id: string;
  /** "16 Oct 26 · 14:07" in New York. */
  when: string;
  /** Milliseconds, for sorting. */
  at: number;
  symbol: string;
  what: string;
  kind: "call" | "put" | "stock";
  qty: number;
  entry: number;
  exit: number;
  /** After fees, for an option position; before fees for shares, which carry no known fee. */
  pnl: number;
  /** Before fees. */
  gross: number;
  /** Fees taken off; null for shares. */
  fees: number | null;
  /** The result as a share of the premium, after fees; null for shares or a trade that cost nothing. */
  optionPct: number | null;
  /** The result in quarters of the premium (−1 is the −25% stop) and in $50s, after fees; null for shares. */
  r25: number | null;
  r50: number | null;
  /** The matched pieces of a position bought or sold in more than one fill, in words; empty for a single piece. */
  pieces: { id: string; text: string }[];
  /** "3 min" */
  held: string;
  holdMin: number;
  expired: boolean;
}

export type SortKey = "at" | "pnl" | "holdMin" | "qty";
export type Sort = { key: SortKey; dir: 1 | -1 };
export type Only = "all" | "win" | "loss";

/** The rows the search and the filter keep, in the sort's order. A new array: the input is left as it is. */
export function listRows(rows: readonly JournalRow[], q: string, only: Only, sort: Sort): JournalRow[] {
  const needle = q.trim().toUpperCase();
  const kept = rows.filter((r) => {
    if (only === "win" && r.pnl <= 0) return false;
    if (only === "loss" && r.pnl >= 0) return false;
    return !needle || r.what.toUpperCase().includes(needle) || r.when.toUpperCase().includes(needle);
  });
  return kept.sort((a, b) => (a[sort.key] - b[sort.key]) * sort.dir);
}

/** A header's click: the same column flips its direction, another starts high to low. */
export const nextSort = (s: Sort, key: SortKey): Sort => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 });

/** The phone's sort menu: each choice is one of the table's column sorts. */
export const SORT_CHOICES: readonly { value: string; label: string; sort: Sort }[] = [
  { value: "at:-1", label: "Newest first", sort: { key: "at", dir: -1 } },
  { value: "at:1", label: "Oldest first", sort: { key: "at", dir: 1 } },
  { value: "pnl:-1", label: "Best result first", sort: { key: "pnl", dir: -1 } },
  { value: "pnl:1", label: "Worst result first", sort: { key: "pnl", dir: 1 } },
  { value: "holdMin:-1", label: "Longest held first", sort: { key: "holdMin", dir: -1 } },
  { value: "holdMin:1", label: "Shortest held first", sort: { key: "holdMin", dir: 1 } },
  { value: "qty:-1", label: "Most contracts first", sort: { key: "qty", dir: -1 } },
  { value: "qty:1", label: "Fewest contracts first", sort: { key: "qty", dir: 1 } },
];

export const sortValue = (s: Sort) => `${s.key}:${s.dir}`;
export const sortOf = (value: string): Sort | null => SORT_CHOICES.find((c) => c.value === value)?.sort ?? null;

/** The real minus sign, never a hyphen, and the sign kept on the number. */
const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
export const usd2 = (v: number) => `${sign(v)}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pctOf = (v: number | null) => (v === null ? "—" : `${sign(v)}${Math.abs(Math.round(v * 100))}%`);
export const rOf = (v: number | null) => (v === null ? "—" : `${sign(v)}${Math.abs(v).toFixed(2)}`);

export interface RowWords {
  result: string;
  /** "+$41.00 before fees", only when fees were taken off. */
  beforeFees: string | null;
  tone: "good" | "bad" | "flat";
  qty: string;
  inOut: string;
  fees: string;
  onPremium: string;
  r25: string;
  r50: string;
}

/** What one row says, the same words in the table and on a card. */
export function rowWords(r: JournalRow): RowWords {
  return {
    result: usd2(r.pnl),
    beforeFees: r.fees !== null && r.fees > 0 ? `${usd2(r.gross)} before fees` : null,
    tone: r.pnl > 0 ? "good" : r.pnl < 0 ? "bad" : "flat",
    qty: r.qty.toLocaleString("en-US"),
    inOut: `${r.entry.toFixed(2)} → ${r.exit.toFixed(2)}`,
    fees: r.fees === null ? "—" : `$${r.fees.toFixed(2)}`,
    onPremium: pctOf(r.optionPct),
    r25: rOf(r.r25),
    r50: rOf(r.r50),
  };
}
