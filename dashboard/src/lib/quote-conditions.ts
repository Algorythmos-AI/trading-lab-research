// Which stock trade conditions update a bar, as data: Alpaca's market-data FAQ, "How are bars aggregated?"
// (https://docs.alpaca.markets/docs/market-data-faq), its table "the following table contains all the updating rules",
// read from the page's HTML on 2026-11-12. One row per condition code, tape set and bar type, exactly as the table
// gives it; a test pins the whole table, so a change here is deliberate. Pure: used only by the log-only snapshot
// probe (quote-probe.ts).
//
// The FAQ's own reading rules: the tape is the trade's (A, B: NYSE; C: Nasdaq; O: OTC); "first-only" (the table's
// yellow circle) updates open/close only when the trade is the bar's first; and "a trade can have more than one
// condition. In this case the strictest rule is applied."

export type OpenClose = "yes" | "first-only" | "no";
export type YesNo = "yes" | "no";
export interface BarRule {
  open_close: OpenClose;
  high_low: YesNo;
  volume: YesNo;
}
export interface ConditionRow {
  code: string;
  /** The tapes the row is for, as the table writes them ("AB", "ABCO", ...). */
  tapes: string;
  minute: BarRule;
  daily: BarRule;
}

const Y: BarRule = { open_close: "yes", high_low: "yes", volume: "yes" };
const VOL_ONLY: BarRule = { open_close: "no", high_low: "no", volume: "yes" };
const NONE: BarRule = { open_close: "no", high_low: "no", volume: "no" };
const FIRST: BarRule = { open_close: "first-only", high_low: "yes", volume: "yes" };
const PRICE_NO_VOL: BarRule = { open_close: "yes", high_low: "yes", volume: "no" };
const row = (code: string, tapes: string, minute: BarRule, daily: BarRule = minute): ConditionRow => ({ code, tapes, minute, daily });

/** The table, row for row (a row the table marks "MD" has one rule for both bar types). */
export const CONDITION_TABLE: readonly ConditionRow[] = [
  row(" ", "AB", Y), // Regular Sale
  row("@", "CO", Y), // Regular Sale
  row("A", "C", Y), // Acquisition
  row("B", "AB", VOL_ONLY), // Average Price Trade
  row("B", "C", Y), // Bunched Trade
  row("C", "ABCO", VOL_ONLY), // Cash Sale
  row("D", "C", Y), // Distribution
  row("E", "AB", Y), // Automatic Execution
  row("F", "ABC", Y), // Intermarket Sweep
  row("G", "C", VOL_ONLY, FIRST), // Bunched Sold Trade
  row("H", "ABC", VOL_ONLY), // Price Variation Trade
  row("I", "ABCO", VOL_ONLY), // Odd Lot Trade
  row("K", "ABC", Y), // Rule 127 or Rule 155
  row("L", "ABC", Y), // Sold Last
  row("M", "ABC", NONE), // Market Center Official Close
  row("N", "ABCO", VOL_ONLY), // Next Day
  row("O", "ABC", Y), // Market Center Opening Trade
  row("P", "ABCO", VOL_ONLY, FIRST), // Prior Reference Price
  row("Q", "ABC", NONE), // Market Center Official Open
  row("R", "ABCO", VOL_ONLY), // Seller
  row("T", "ABCO", Y, VOL_ONLY), // Extended Hours Trade
  row("U", "ABCO", VOL_ONLY), // Extended Trading Hours
  row("V", "ABC", VOL_ONLY), // Contingent Trade
  row("W", "CO", VOL_ONLY), // Average Price Trade
  row("X", "ABC", Y), // Cross Trade
  row("Y", "C", Y), // Yellow Flag Regular Trade
  row("Z", "ABC", VOL_ONLY, FIRST), // Sold Out Of Sequence
  row("4", "ABC", VOL_ONLY, FIRST), // Derivatively Priced
  row("5", "ABC", Y), // Market Center Reopening Trade
  row("6", "ABC", Y), // Market Center Closing Trade
  row("7", "ABC", VOL_ONLY), // Qualified Contingent Trade
  row("9", "ABC", NONE, PRICE_NO_VOL), // Corrected Consolidated Close
];

/**
 * Whether a trade sets a bar's price: "yes" when it updates the high/low and the open/close; "first-only" when it
 * updates the high/low but the open/close only as the bar's first trade; "no" when it does not update the high/low.
 * (The table has no row that updates the high/low with open/close "no".) "unknown" when it cannot be told.
 */
export type SetsPrice = "yes" | "first-only" | "no" | "unknown";
export const SETS_PRICE = ["yes", "first-only", "no", "unknown"] as const;

/** The table's rule for one code on one tape, or null when the table has no row for that code and tape. */
export function ruleFor(code: string, tape: unknown, bar: "minute" | "daily"): BarRule | null {
  if (typeof tape !== "string" || tape.length !== 1) return null;
  const r = CONDITION_TABLE.find((x) => x.code === code && x.tapes.includes(tape));
  return r ? r[bar] : null;
}

const OC_RANK: Record<OpenClose, number> = { no: 0, "first-only": 1, yes: 2 };

/**
 * What a trade's conditions say about one bar type's price, the strictest rule across its codes (the FAQ's rule).
 * Any code the table has no row for on the trade's tape, a dropped (unsafe) code, or no code at all gives "unknown",
 * unless a known code already makes it "no".
 */
export function setsPrice(codes: readonly string[], dropped: number, tape: unknown, bar: "minute" | "daily"): SetsPrice {
  let oc: OpenClose = "yes";
  let hl: YesNo = "yes";
  let unknown = dropped !== 0 || codes.length === 0;
  for (const c of codes) {
    const r = ruleFor(c, tape, bar);
    if (!r) {
      unknown = true;
      continue;
    }
    if (OC_RANK[r.open_close] < OC_RANK[oc]) oc = r.open_close;
    if (r.high_low === "no") hl = "no";
  }
  if (hl === "no") return "no";
  if (unknown) return "unknown";
  return oc === "yes" ? "yes" : "first-only";
}
