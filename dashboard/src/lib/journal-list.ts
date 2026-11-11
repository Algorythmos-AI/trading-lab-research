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
  pieces: { id: string; text: string; n: Piece }[];
  /** "3 min" */
  held: string;
  holdMin: number;
  expired: boolean;
}

/** One matched piece in numbers: what `pieceText` writes out. `closedAt` is null for a piece left to expire. */
export interface Piece {
  qty: number;
  entry: number;
  exit: number;
  closedAt: number | null;
  /** Before fees. */
  pnl: number;
}

// Only numbers come from Intl (they read the same in every engine); the month's name is our own, since engines differ
// on it ("Sep" in one, "Sept" in another) and a piece written in the browser must read as the column the server wrote.
const WHEN_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** "16 Oct 26 · 14:07" in New York, the same in every engine. */
export function whenText(ms: number): string {
  const p = Object.fromEntries(WHEN_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = String(Number(p.hour) % 24).padStart(2, "0");
  return `${Number(p.day)} ${MONTH_ABBR[Number(p.month) - 1]} ${String(p.year).slice(-2)} · ${hour}:${p.minute}`;
}
const price = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** Signed dollars to the cent with the sign held to the number (a word joiner), as the Trades page writes them. */
const signed2 = (v: number) => `${v > 0 ? "+\u2060" : v < 0 ? "−\u2060" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "2 × 1.25 → 1.80, sold 16 Oct 26 · 14:07: +$110.00 before fees". */
export function pieceText(p: Piece): string {
  return `${p.qty.toLocaleString("en-US")} × ${price(p.entry)} → ${price(p.exit)}, ${p.closedAt === null ? "expired" : `sold ${whenText(p.closedAt)}`}: ${signed2(p.pnl)} before fees`;
}

export type SortKey = "at" | "pnl" | "holdMin" | "qty";
export type Sort = { key: SortKey; dir: 1 | -1 };
export type Only = "all" | "win" | "loss";

/** What the search, the filter and the sort read of a row. */
type Listed = Pick<JournalRow, "what" | "when" | "pnl" | SortKey>;

/** The rows the search and the filter keep, in the sort's order. A new array: the input is left as it is. */
export function listRows<R extends Listed>(rows: readonly R[], q: string, only: Only, sort: Sort): R[] {
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

// ── The list as it is sent to the browser ─────────────────────────────────────────────────────────────────────────
// The table and the cards need every row of the view for the search and the sort, but not every field: each row goes
// as one short tuple with its words already written (rowWords, on the server), and each piece as five numbers, written
// out (pieceText) only when its disclosure is opened. About a third of the size of the rows as objects with their
// pieces in words, for the owner's whole history, and nothing is asked of the server when a box is typed in.

/** A piece as sent: qty, entry, exit, close time (ms; null when it expired), result before fees. */
export type PackedPiece = [qty: number, entry: number, exit: number, closedAt: number | null, pnl: number];

/** A row as sent. Its words are rowWords' own, written on the server. */
export type PackedRow = [
  id: string,
  when: string,
  at: number,
  what: string,
  pnl: number,
  holdMin: number,
  qty: number,
  held: string,
  expired: 0 | 1,
  result: string,
  beforeFees: string | null,
  fees: string,
  onPremium: string,
  r25: string,
  r50: string,
  inOut: string,
  pieces: PackedPiece[] | 0,
];

/** A row as the browser draws it, unpacked: what the list reads and the words, no pieces in words. */
export interface ListRow {
  id: string;
  when: string;
  at: number;
  what: string;
  pnl: number;
  holdMin: number;
  qty: number;
  held: string;
  expired: boolean;
  words: RowWords;
  pieces: Piece[];
}

export function packRow(r: JournalRow): PackedRow {
  const w = rowWords(r);
  return [
    r.id,
    r.when,
    r.at,
    r.what,
    r.pnl,
    r.holdMin,
    r.qty,
    r.held,
    r.expired ? 1 : 0,
    w.result,
    w.beforeFees,
    w.fees,
    w.onPremium,
    w.r25,
    w.r50,
    w.inOut,
    r.pieces.length ? r.pieces.map(({ n }) => [n.qty, n.entry, n.exit, n.closedAt, n.pnl]) : 0,
  ];
}

export function unpackRow(p: PackedRow): ListRow {
  const [id, when, at, what, pnl, holdMin, qty, held, expired, result, beforeFees, fees, onPremium, r25, r50, inOut, pieces] = p;
  return {
    id,
    when,
    at,
    what,
    pnl,
    holdMin,
    qty,
    held,
    expired: expired === 1,
    words: { result, beforeFees, tone: pnl > 0 ? "good" : pnl < 0 ? "bad" : "flat", qty: qty.toLocaleString("en-US"), inOut, fees, onPremium, r25, r50 },
    pieces: pieces ? pieces.map(([q, entry, exit, closedAt, pp]) => ({ qty: q, entry, exit, closedAt, pnl: pp })) : [],
  };
}
