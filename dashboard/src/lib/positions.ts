// The paper account's open option positions, read for the Options desk. Pure: no I/O.
//
// They come from the options live document, which the trading host publishes from the paper account kept for
// manual option trades. The desk shows them; it never places, changes or closes one.
import type { OptionKind } from "./bs";
import type { Pick } from "./contract";
import { MAX_CONTRACTS, daysToExpiry, minutesToExpiry } from "./contract";
import { MULTIPLIER } from "./longopt";
import type { OptionsLive } from "./options-live.types";

export type LivePosition = OptionsLive["positions"][number];

/** A contract's parts from its OCC symbol (`SPY261016C00780000`), or null when it is not one. */
export function parseContract(occ: string): { symbol: string; expiry: string; kind: OptionKind; strike: number } | null {
  const m = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (!m) return null;
  const expiry = `20${m[2]}-${m[3]}-${m[4]}`;
  const at = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== expiry) return null;
  const strike = Number(m[6]) / 1000;
  return strike > 0 ? { symbol: m[1]!, expiry, kind: m[5] === "C" ? "call" : "put", strike } : null;
}

export interface PositionRow {
  contract: string;
  symbol: string;
  kind: OptionKind;
  strike: number;
  expiry: string;
  /** Calendar days to expiry from New York's today; null for a date that could not be read. */
  days: number | null;
  /** True once the contract's closing bell has rung: the broker has not yet removed it. */
  expired: boolean;
  /** Contracts held; negative is short. */
  qty: number;
  /** Paid per share: the broker's figure, or worked out from market value less the unrealised result. */
  avgPrice: number | null;
  /** The broker's mark per share. */
  price: number | null;
  /** Unrealised profit or loss for the whole position, in dollars. */
  unrealized: number | null;
  /** Whether the name is one the desk carries, so the row can open it. */
  onDesk: boolean;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The document's positions as rows for the desk: the desk's own names first, then by expiry, then by name. A row
 * the broker sent that is not an option contract, or holds nothing, is left out.
 */
export function positionRows(doc: OptionsLive, names: ReadonlySet<string>, now: number): PositionRow[] {
  const rows: PositionRow[] = [];
  for (const p of doc.positions ?? []) {
    const c = typeof p?.contract === "string" ? parseContract(p.contract) : null;
    if (!c || !Number.isInteger(p.qty) || p.qty === 0) continue;
    const shares = Math.abs(p.qty) * MULTIPLIER;
    const unrealized = finite(p.unrealized_pl) ? p.unrealized_pl : null;
    const value = finite(p.market_value) ? Math.abs(p.market_value) : null;
    // Cost is value less the result for a long position, and value plus the result for a short one.
    const cost = value !== null && unrealized !== null ? value - Math.sign(p.qty) * unrealized : null;
    const avgPrice = finite(p.avg_price) ? p.avg_price : cost !== null && cost >= 0 ? cost / shares : null;
    const price = finite(p.price) ? p.price : value !== null ? value / shares : null;
    rows.push({
      contract: p.contract,
      ...c,
      days: daysToExpiry(c.expiry, now),
      expired: (minutesToExpiry(c.expiry, now) ?? 0) <= 0,
      qty: p.qty,
      avgPrice,
      price,
      unrealized,
      onDesk: names.has(c.symbol),
    });
  }
  return rows.sort((a, b) => Number(b.onDesk) - Number(a.onDesk) || a.expiry.localeCompare(b.expiry) || a.symbol.localeCompare(b.symbol) || a.strike - b.strike);
}

/** The positions' unrealised result added up, or null when no row has one. */
export function positionsTotal(rows: readonly PositionRow[]): number | null {
  const known = rows.filter((r) => r.unrealized !== null);
  return known.length > 0 ? known.reduce((a, r) => a + r.unrealized!, 0) : null;
}

/** In session, positions older than this are shown greyed: the host has stopped publishing. */
export const POSITIONS_OLD_MIN = 30;
/** Older than this they are not shown at all: a day and a half covers one session and the night after it. */
export const POSITIONS_GONE_MIN = 36 * 60;

/**
 * How far to trust the document by its age. `fresh`; `old`, while the market is open and the document has not
 * been renewed for half an hour; `gone`, when it is from before the last session and says nothing about now.
 */
export function positionsAge(asOf: string | null | undefined, now: number, marketOpen: boolean): { minutes: number | null; state: "fresh" | "old" | "gone" } {
  const at = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(at)) return { minutes: null, state: "gone" };
  const minutes = Math.max(0, (now - at) / 60_000);
  return { minutes, state: minutes > POSITIONS_GONE_MIN ? "gone" : marketOpen && minutes > POSITIONS_OLD_MIN ? "old" : "fresh" };
}

/**
 * A position as a contract for the contract pane, so opening a position prices what is actually held. Null for a
 * short position or an expired one: the pane prices one long call or put and nothing else.
 */
export function pickFor(row: PositionRow): Pick | null {
  if (row.qty <= 0 || row.expired) return null;
  const paid = row.avgPrice !== null && row.avgPrice > 0 ? Math.round(row.avgPrice * 100) / 100 : null;
  return { kind: row.kind, expiry: row.expiry, strike: row.strike, contracts: Math.min(row.qty, MAX_CONTRACTS), paid: paid !== null && paid >= 0.01 ? paid : null };
}
