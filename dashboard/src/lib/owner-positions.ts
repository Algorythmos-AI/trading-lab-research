// The owner's journal pieces grouped into positions, and each position's cost, fees, result and R. Pure: no I/O.
// The definitions are DEC-0045 sections 1 and 2 (EXP-0031 config.yaml `positions` and `unit`), frozen there; the
// Python twin is src/wt/owner/positions.py, and the two are held to the same vectors
// (dashboard/test/fixtures/owner.vectors.json, written by scripts/gen_owner_vectors.py).
//
// The journal's `trades` are matched pieces, first in, first out, not trades: a buy of 2 closed by two sells of 1 is
// two pieces. A position is the long call or put pieces of one contract opened on one New York day that overlap in
// time: a piece joins while it opens strictly before the latest close so far, so a re-entry after a full exit is a
// position of its own. Stock and short pieces are not positions.
import { nyTime, type JournalDoc, type Lot, type Trade } from "./journal";
import { PREMIUM_STOP } from "./premium-stop";

/**
 * The owner's own Webull costs per option contract, given by the owner in session on 2026-11-11 (commission $0.50
 * plus the regulatory, OCC and SEC fees, about $1.11 a round trip). DEC-0045 section 2 freezes them; a change is a
 * dated amendment to that record. They are today's rates, applied to every piece back to 2023: what was charged in
 * earlier years has not been established, so every figure after them is an estimate and the page says so. A piece
 * left to expire pays no closing fee.
 */
export const OWNER_FEES = { openPerContract: 0.55, closePerContract: 0.56, expiredClose: 0 } as const;

/** R25 measures a result in units of a quarter of the premium (rule 5's −25% stop, the same number), so −1 is the stop. */
export const R25_SHARE = PREMIUM_STOP;
/** R50 measures a result in units of $50 (rule 4's risk per trade). */
export const R50_DOLLARS = 50;

export type PositionKind = "call" | "put";

export interface PositionFlags {
  /** A piece whose symbol and New York day (opened or closed) the journal lists in `gaps`. */
  gapPiece: boolean;
  /** The pieces cost nothing: no R can be worked out. */
  zeroCost: boolean;
  /** A lot of this contract opened this New York day, or with no open time, is still in the journal's `open`. */
  openLot: boolean;
  /** The journal says its results already carry fees, so none are taken off. */
  feesIncluded: boolean;
}

export interface OwnerPosition {
  /** The first piece's id. */
  id: string;
  symbol: string;
  kind: PositionKind;
  strike: number | null;
  expiry: string | null;
  /** The New York day of t0. */
  day: string;
  /** The pieces, in the order they were grouped (opened_at, then id). */
  pieces: Trade[];
  /** The first piece's opened_at. */
  t0: string;
  /** The latest closed_at of its pieces. */
  lastClose: string;
  /** From t0 to the last close, in minutes. */
  holdMinutes: number;
  contractsOpened: number;
  /** Contracts closed by an order: those left to expire are counted apart and pay no closing fee. */
  contractsClosed: number;
  contractsExpired: number;
  /** Premium paid: entry × multiplier × qty over the pieces. Fees are not in it. */
  cost: number;
  /** What the pieces were sold for: exit × multiplier × qty. */
  proceeds: number;
  /** The pieces' pnl as the journal reports it: before fees. */
  gross: number;
  fees: number;
  net: number;
  /** net / cost; null at cost 0. */
  optionPct: number | null;
  grossPct: number | null;
  /** net / (0.25 × cost); null at cost 0. */
  r25: number | null;
  /** net / $50. */
  r50: number;
  r25Gross: number | null;
  r50Gross: number;
  /** A piece closed on a later New York day than t0's. */
  closedLaterDay: boolean;
  flags: PositionFlags;
  /** False when DEC-0045 section 1 leaves it out of a verdict: cost 0, a gap piece, or a lot still open. */
  counts: boolean;
}

export interface PositionBook {
  /** Ordered by t0, then id. */
  positions: OwnerPosition[];
  /** Pieces that are not positions: shares, anything sold first, and a long piece of some other kind. */
  excluded: { stock: number; short: number; other: number };
  /** Positions DEC-0045 section 1 leaves out, by reason (one position can have several). */
  leftOut: { zeroCost: number; gapPiece: number; openLot: number };
  /** The journal's `fees_included` was true: no fee was taken off. */
  feesIncluded: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A time with an explicit zone (a trailing Z or ±hh:mm), as the journal's schema writes it. JavaScript would read one
 * without a zone as the machine's local time, so such a time is not read at all, as the Python twin does. */
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Milliseconds since the epoch, or NaN for a time not written as the schema's stamp (extended format, a zone of Z
 * or ±hh:mm): the Python twin's `stamp_ms` refuses exactly the same. */
export const ms = (iso: string) => (ZONED.test(iso) ? Date.parse(iso) : NaN);

/** A usable matched piece: the journal may be malformed, and a bad entry is skipped rather than thrown on. */
function usable(t: unknown): t is Trade {
  if (!t || typeof t !== "object") return false;
  const p = t as Partial<Trade>;
  return (
    typeof p.id === "string" &&
    typeof p.symbol === "string" &&
    typeof p.opened_at === "string" &&
    typeof p.closed_at === "string" &&
    Number.isFinite(ms(p.opened_at)) &&
    Number.isFinite(ms(p.closed_at)) &&
    isNum(p.qty) &&
    isNum(p.entry) &&
    isNum(p.exit) &&
    isNum(p.multiplier) &&
    isNum(p.pnl)
  );
}

/** A long call or put piece: the pieces positions are made of. */
export function isPositionPiece(t: Trade): boolean {
  return (t.kind === "call" || t.kind === "put") && t.side === "long";
}

const contractKey = (t: Pick<Trade, "symbol" | "kind" | "strike" | "expiry">) => JSON.stringify([t.symbol, t.kind, isNum(t.strike) ? t.strike : null, t.expiry ?? null]);
const byOpen = (a: Trade, b: Trade) => ms(a.opened_at) - ms(b.opened_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The long option pieces grouped into positions (DEC-0045 section 1), ordered by t0 then id. Pieces of one contract
 * and New York day, sorted by opened_at (then id), join the current group while their opened_at is strictly before
 * the group's latest closed_at so far; one opened at or after it starts a new group.
 */
export function groupPieces(trades: readonly unknown[]): Trade[][] {
  const byKey = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!usable(t) || !isPositionPiece(t)) continue;
    const key = `${contractKey(t)}|${nyTime(t.opened_at).day}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }
  const groups: Trade[][] = [];
  for (const list of byKey.values()) {
    list.sort(byOpen);
    let current: Trade[] | null = null;
    let latest = -Infinity;
    for (const t of list) {
      if (current && ms(t.opened_at) < latest) {
        current.push(t);
        latest = Math.max(latest, ms(t.closed_at));
      } else {
        current = [t];
        latest = ms(t.closed_at);
        groups.push(current);
      }
    }
  }
  return groups.sort((a, b) => byOpen(a[0]!, b[0]!));
}

type Gap = NonNullable<JournalDoc["gaps"]>[number];

/** The arithmetic of one group of pieces. */
export function positionOf(pieces: readonly Trade[], ctx: { open?: readonly Lot[] | null; gaps?: readonly Gap[] | null; feesIncluded?: boolean | null } = {}): OwnerPosition {
  const first = pieces[0]!;
  const day = nyTime(first.opened_at).day;
  let last = first;
  let cost = 0;
  let proceeds = 0;
  let gross = 0;
  let opened = 0;
  let closed = 0;
  let expired = 0;
  let closedLaterDay = false;
  for (const p of pieces) {
    if (ms(p.closed_at) > ms(last.closed_at)) last = p;
    cost += p.entry * p.multiplier * p.qty;
    proceeds += p.exit * p.multiplier * p.qty;
    gross += p.pnl;
    opened += p.qty;
    if (p.close === "expired") expired += p.qty;
    else closed += p.qty;
    if (nyTime(p.closed_at).day !== day) closedLaterDay = true;
  }
  const feesIncluded = ctx.feesIncluded === true;
  const fees = feesIncluded ? 0 : OWNER_FEES.openPerContract * opened + OWNER_FEES.closePerContract * closed + OWNER_FEES.expiredClose * expired;
  const net = gross - fees;
  const key = contractKey(first);
  const gapPiece = (ctx.gaps ?? []).some(
    (g) => !!g && g.symbol === first.symbol && pieces.some((p) => nyTime(p.opened_at).day === g.date || nyTime(p.closed_at).day === g.date),
  );
  // A lot with no usable open time may be this position's rest, so it is counted as one (the cautious reading).
  const openLot = (ctx.open ?? []).some(
    (l) => !!l && contractKey(l) === key && (typeof l.opened_at !== "string" || !Number.isFinite(ms(l.opened_at)) || nyTime(l.opened_at).day === day),
  );
  const zeroCost = !(cost > 0);
  const per = (v: number, d: number) => (d > 0 ? v / d : null);
  return {
    id: first.id,
    symbol: first.symbol,
    kind: first.kind as PositionKind,
    strike: isNum(first.strike) ? first.strike : null,
    expiry: first.expiry ?? null,
    day,
    pieces: [...pieces],
    t0: first.opened_at,
    lastClose: last.closed_at,
    holdMinutes: Math.max(0, (ms(last.closed_at) - ms(first.opened_at)) / 60_000),
    contractsOpened: opened,
    contractsClosed: closed,
    contractsExpired: expired,
    cost,
    proceeds,
    gross,
    fees,
    net,
    optionPct: per(net, cost),
    grossPct: per(gross, cost),
    r25: per(net, R25_SHARE * cost),
    r50: net / R50_DOLLARS,
    r25Gross: per(gross, R25_SHARE * cost),
    r50Gross: gross / R50_DOLLARS,
    closedLaterDay,
    flags: { gapPiece, zeroCost, openLot, feesIncluded },
    counts: !gapPiece && !zeroCost && !openLot,
  };
}

/** Every position in a journal, with what was left out and why. */
export function ownerPositions(doc: { trades: readonly unknown[]; open?: readonly Lot[] | null; gaps?: readonly Gap[] | null; fees_included?: boolean | null }): PositionBook {
  const trades = Array.isArray(doc.trades) ? doc.trades : [];
  const ctx = { open: Array.isArray(doc.open) ? doc.open : null, gaps: Array.isArray(doc.gaps) ? doc.gaps : null, feesIncluded: doc.fees_included };
  const positions = groupPieces(trades).map((g) => positionOf(g, ctx));
  let stock = 0;
  let short = 0;
  let other = 0;
  for (const t of trades) {
    if (!usable(t) || isPositionPiece(t)) continue;
    if (t.kind === "stock") stock++;
    else if (t.side === "short") short++;
    else other++;
  }
  return {
    positions,
    excluded: { stock, short, other },
    leftOut: {
      zeroCost: positions.filter((p) => p.flags.zeroCost).length,
      gapPiece: positions.filter((p) => p.flags.gapPiece).length,
      openLot: positions.filter((p) => p.flags.openLot).length,
    },
    feesIncluded: doc.fees_included === true,
  };
}

/**
 * A position written as one journal record, so the record's arithmetic (totals, days, breakdowns, the rule checks)
 * can run on positions: qty is the contracts opened, entry and exit are averages per contract share, opened_at is t0
 * and closed_at the last close, and pnl is the gross or the net result. It ends "expired" only when every piece did.
 */
export function positionTrade(p: OwnerPosition, basis: "gross" | "net" = "gross"): Trade {
  const first = p.pieces[0]!;
  const shares = first.multiplier * p.contractsOpened;
  return {
    id: p.id,
    symbol: p.symbol,
    kind: p.kind,
    strike: p.strike,
    expiry: p.expiry,
    side: "long",
    qty: p.contractsOpened,
    opened_at: p.t0,
    closed_at: p.lastClose,
    entry: shares > 0 ? p.cost / shares : 0,
    exit: shares > 0 ? p.proceeds / shares : 0,
    multiplier: first.multiplier,
    pnl: basis === "net" ? p.net : p.gross,
    close: p.contractsClosed === 0 ? "expired" : "order",
  };
}

/**
 * True when some piece of a position was sold (or left to expire, at 0) more than `stop` below its own entry or below
 * the position's average entry: a part held past the stop, even when another sale makes the whole look inside it.
 */
export function partPastStop(pieces: readonly Trade[], avgEntry: number, stop: number): boolean {
  // Against the piece's own entry, as rule 5 judges a piece, or against the position's average entry.
  return pieces.some((p) => {
    const exit = p.close === "expired" ? 0 : p.exit;
    return (p.entry > 0 && 1 - exit / p.entry > stop + 1e-9) || (avgEntry > 0 && 1 - exit / avgEntry > stop + 1e-9);
  });
}

/**
 * The entries of a position: each distinct opened_at among its pieces is one buy fill (one buy sold in two halves is
 * one entry; adding while holding is another), as the day's trade cap counts them.
 */
export function entriesOf(p: Pick<OwnerPosition, "pieces">): number[] {
  return [...new Set(p.pieces.map((x) => ms(x.opened_at)))].sort((a, b) => a - b);
}

/**
 * The premium held over time: each piece adds its cost at its open and takes it off at its close, and `held` lots are
 * added at their open and never closed. At one instant, sales of pieces bought earlier come first, then buys, then the
 * sales of pieces bought at that same instant, so a sale and a rebuy at one instant net, and a piece bought and sold
 * at once still counts while it was held.
 */
function premiumSweep(pieces: readonly Trade[], held: readonly { at: number; cost: number }[]): [at: number, total: number][] {
  const events: [at: number, rank: number, delta: number][] = [];
  for (const p of pieces) {
    const c = p.entry * p.multiplier * p.qty;
    const open = ms(p.opened_at);
    const close = ms(p.closed_at);
    events.push([open, 1, c], [close, close > open ? 0 : 2, -c]);
  }
  for (const h of held) events.push([h.at, 1, h.cost]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  return events.map(([at, , d]) => [at, (now += d)]);
}

/** The most premium held at once (see `premiumSweep`). */
export function peakPremium(pieces: readonly Trade[], held: readonly { at: number; cost: number }[] = []): number {
  return Math.max(0, ...premiumSweep(pieces, held).map(([, total]) => total));
}

/** When the premium held first went over `cap`: the time of the fill that took it there; null if it never did. */
export function premiumOverAt(pieces: readonly Trade[], cap: number, held: readonly { at: number; cost: number }[] = []): number | null {
  return premiumSweep(pieces, held).find(([, total]) => total > cap + 1e-9)?.[0] ?? null;
}

/** A position's average entry per contract share: its cost over its shares. */
export const averageEntry = (p: OwnerPosition) => {
  const shares = p.pieces[0]!.multiplier * p.contractsOpened;
  return shares > 0 ? p.cost / shares : 0;
};

/**
 * One piece's share of its position's fees: its contracts' opening fee, and their closing fee unless it was left to
 * expire. A position's pieces' shares add up to the position's fees. None when the journal carries fees already.
 */
export function pieceFees(p: Trade, feesIncluded?: boolean | null): number {
  if (feesIncluded === true) return 0;
  return OWNER_FEES.openPerContract * p.qty + (p.close === "expired" ? OWNER_FEES.expiredClose : OWNER_FEES.closePerContract) * p.qty;
}

/**
 * The journal's pieces with each long option piece's result after its fees, so a day's total books every piece to
 * its own close day: a position sold half one day and half the next shows on both days. Shares and short pieces
 * are kept as they are (no fee of theirs is known).
 */
export function netPieces(trades: readonly Trade[], feesIncluded?: boolean | null): Trade[] {
  return trades.map((t) => (usable(t) && isPositionPiece(t) ? { ...t, pnl: t.pnl - pieceFees(t, feesIncluded) } : t));
}

export interface TradeUnit {
  /** The position as one record, or the piece itself for shares and short pieces. */
  unit: Trade;
  pieces: Trade[];
  /** The position, for long calls and puts. */
  position: OwnerPosition | null;
}

/**
 * Every piece in a unit the rules and the Trades page count as one trade: long calls and puts as positions, shares
 * and short pieces each on their own, as before. Ordered by opened_at, then id. Results are before fees unless
 * `basis` is "net" (fees are taken off positions only: none are known for shares).
 */
export function tradeUnits(trades: readonly Trade[], opts: { basis?: "gross" | "net"; open?: readonly Lot[] | null; gaps?: readonly Gap[] | null; feesIncluded?: boolean | null } = {}): TradeUnit[] {
  const ctx = { open: opts.open, gaps: opts.gaps, feesIncluded: opts.feesIncluded };
  const out: TradeUnit[] = groupPieces(trades).map((g) => {
    const position = positionOf(g, ctx);
    return { unit: positionTrade(position, opts.basis ?? "gross"), pieces: position.pieces, position };
  });
  // Anything that is not a whole long option piece stays one unit, as before, even when a field is missing.
  for (const t of trades) if (t && typeof t === "object" && !(usable(t) && isPositionPiece(t))) out.push({ unit: t, pieces: [t], position: null });
  return out.sort((a, b) => byOpen(a.unit, b.unit));
}

// ── What the Trades page may show before any verdict (DEC-0045 section 8) ─────────────────────────────────────────
// Over all positions together, never split by any label: how the exits kept the rules, and the overall mean R25.

/**
 * The Loss size panel's line for a small win: a winner (after fees) whose option was sold up less than +50% on its
 * premium, the position taken whole. Not the rules evidence's +20% mark (trade-rules' RAN_TO_MARK), which counts
 * winners that ran, piece by piece, before fees.
 */
export const SMALL_WIN_UNDER = 0.5;
/** The overall mean R25 is shown only from this many positions over this many New York sessions. */
export const MEAN_MIN_POSITIONS = 20;
export const MEAN_MIN_SESSIONS = 10;

export interface ExitStats {
  /** Positions counted: cost above 0, no gap piece and nothing still open. */
  n: number;
  /** Positions in view left out for one of those reasons. */
  leftOut: number;
  /** After fees. */
  losers: number;
  winners: number;
  /** Losers whose option fell more than 25% of its cost before the last piece was sold: rule 5 broken. */
  pastStop: number;
  /** For each loser, what it lost beyond 25% of its cost, summed: a replay of rule 5 (zero or above). */
  beyondStop: number;
  /** Positions with a part sold (or expired) more than 25% below the average entry, whole result aside. */
  partPastStop: number;
  /** Winners sold up less than SMALL_WIN_UNDER (+50%) of their cost. */
  smallWins: number;
  /** Mean R25 after fees of the losers and of the winners; null under `minSample` of them. */
  avgLoserR25: number | null;
  avgWinnerR25: number | null;
}

const EPS = 1e-9;

/**
 * How the exits of these positions kept the stop and the target, worked out mechanically from the record (a replay,
 * like the day stop's: the trades a rule would have changed might have gone either way). Price-based, as rule 5 is
 * written: the share is what the pieces were sold for against what they cost, so the fees, the same either way, do not
 * move it.
 */
export function exitStats(positions: readonly OwnerPosition[], minSample: number): ExitStats {
  const counted = positions.filter((p) => p.counts);
  const losers = counted.filter((p) => p.net < 0);
  const winners = counted.filter((p) => p.net > 0);
  const kept = (p: OwnerPosition) => p.proceeds / p.cost;
  const past = losers.filter((p) => 1 - kept(p) > R25_SHARE + EPS);
  const beyond = losers.reduce((s, p) => s + Math.max(0, (1 - R25_SHARE) * p.cost - p.proceeds), 0);
  const mean = (ps: readonly OwnerPosition[]) => (ps.length >= minSample ? ps.reduce((s, p) => s + p.r25!, 0) / ps.length : null);
  return {
    n: counted.length,
    leftOut: positions.length - counted.length,
    losers: losers.length,
    winners: winners.length,
    pastStop: past.length,
    partPastStop: counted.filter((p) => partPastStop(p.pieces, averageEntry(p), R25_SHARE)).length,
    beyondStop: beyond,
    smallWins: winners.filter((p) => kept(p) - 1 < SMALL_WIN_UNDER - EPS).length,
    avgLoserR25: mean(losers),
    avgWinnerR25: mean(winners),
  };
}

/** The overall mean R25 after fees, or null with fewer than 20 positions or fewer than 10 sessions (by t0's day). */
export function meanR25(positions: readonly OwnerPosition[]): { n: number; sessions: number; mean: number | null } {
  const counted = positions.filter((p) => p.counts);
  const sessions = new Set(counted.map((p) => p.day)).size;
  const enough = counted.length >= MEAN_MIN_POSITIONS && sessions >= MEAN_MIN_SESSIONS;
  return { n: counted.length, sessions, mean: enough ? counted.reduce((s, p) => s + p.r25!, 0) / counted.length : null };
}
