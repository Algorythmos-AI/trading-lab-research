// What the Trades page shows under its filters, worked out once. Pure: no I/O; the clock is passed in.
// Two kinds of figure, each dated its own way:
// - money (the net result before and after fees, the curve, the months, the calendar, the best and worst days) adds
//   up the journal's pieces closed in the view, each after its own fees, on the day it was sold;
// - per-trade figures (the trade count, win rate, the average per trade, profit factor, R, loss size) count each
//   trade once, a position for options, on the day it finished: its last close.
import { applyFilter, daily, summarize, type DayRow, type Filter, type JournalDoc, type Summary, type Trade } from "./journal";
import { netPieces, positionTrade, tradeUnits, type OwnerPosition, type TradeUnit } from "./owner-positions";

export interface TradesView {
  /** The trades in view, after fees, by last close. */
  trades: Trade[];
  units: TradeUnit[];
  positions: OwnerPosition[];
  /** The pieces closed in view, after fees, each on its own close day. */
  pieces: Trade[];
  days: DayRow[];
  /** After fees, and the same before them. */
  s: Summary;
  gross: Summary;
  fees: { included: boolean; total: number };
  /** Nothing in view at all: no trade finished and no piece sold in it. */
  empty: boolean;
}

export function tradesView(doc: Pick<JournalDoc, "trades" | "open" | "gaps" | "fees_included">, filter: Filter, now: Date): TradesView {
  const all = doc.trades;
  const included = doc.fees_included === true;
  const allUnits = tradeUnits(all, { basis: "net", open: doc.open, gaps: doc.gaps, feesIncluded: doc.fees_included });
  const byId = new Map(allUnits.map((u) => [u.unit.id, u]));
  const trades = applyFilter(
    allUnits.map((u) => u.unit),
    filter,
    now,
  );
  const units = trades.map((t) => byId.get(t.id)!);
  const pieces = applyFilter(netPieces(all, doc.fees_included), filter, now);
  const grossPieces = applyFilter(all, filter, now);
  // What the fees took off the money in view: the pieces before fees less the same pieces after them.
  const fees = grossPieces.reduce((sum, p) => sum + p.pnl, 0) - pieces.reduce((sum, p) => sum + p.pnl, 0);
  return {
    trades,
    units,
    positions: units.flatMap((u) => (u.position ? [u.position] : [])),
    pieces,
    days: daily(pieces),
    s: summarize(trades, pieces),
    gross: summarize(
      units.map((u) => (u.position ? positionTrade(u.position, "gross") : u.unit)),
      grossPieces,
    ),
    fees: { included, total: fees },
    empty: trades.length === 0 && pieces.length === 0,
  };
}
