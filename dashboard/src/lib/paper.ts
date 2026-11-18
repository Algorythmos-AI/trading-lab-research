// The Paper options page's arithmetic (DEC-0057). Pure: no I/O, no clock of its own.
//
// Each paper row is read into the trade journal's own `Trade` shape, so the page's totals, days, groups and lessons
// come from the same functions the Trades page uses (./journal) and cannot drift from them. What is here is only
// what the journal has no word for: the clone's rule windows and hypotheses, results on the premium and in R,
// rolling figures, and how the fills compared with the quotes.
//
// Three sources, never added together: the options clone (paper orders), the hand-placed paper account, and the
// research arms (simulated fills). A row that cannot be read is left out and counted, never guessed at; a clone row
// its own record does not count (`counts: false`) is listed and kept out of every figure.
import { closeDay, contractLabel, daily, fmtMinutes, holdMinutes, nyTime, sortByClose, type DayRow, type GroupRow, type Trade } from "./journal";
import type { ArmTrade, CloneTrade, ManualTrade, PaperOptions } from "./paper-options.types";
import { parseContract } from "./positions";

/** The clone's premium stop as a share of the premium: one R (DEC-0030). A result on the premium over this is in R. */
export const R_UNIT = 0.25;
/** Fewer rows than this and a rate or an average is not shown: it would be noise. The journal's own floor. */
export const MIN_SAMPLE = 8;
/** How many trades a rolling figure looks back over. */
export const ROLLING = 20;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is string => isStr(v) && Number.isFinite(Date.parse(v));
const optNum = (v: unknown) => v === undefined || v === null || isNum(v);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** What the page knows about a trade beyond the journal's shape, by trade id. */
export interface PaperMeta {
  /** Result over the premium paid (0.25 is +25%); null when it cannot be worked out. */
  rop: number | null;
  /** How it ended, as the source's own code; null when it has none. */
  reason: string | null;
  /** The clone and the arms: the hypothesis id. */
  hyp: string | null;
  /** The clone: the rule window its session falls in. */
  window: string | null;
  /** The clone: the ask when the entry was sent, and how old that quote was in seconds. */
  quotedAsk: number | null;
  quoteAgeS: number | null;
  bestBid: number | null;
  worstBid: number | null;
  /** The clone: true when a time came from the journal line, not the fill. */
  roughTime: boolean;
}

export interface PaperBook {
  /** The trades that count, oldest close first, in the journal's shape. */
  trades: Trade[];
  meta: Map<string, PaperMeta>;
  /** Clone rows its own record does not count: listed, in no figure. */
  uncounted: { id: string; contract: string; state: string }[];
  /** Rows that could not be read and are left out. */
  skipped: number;
  /** Older rows the host left out because its list is capped. */
  truncated: number;
}

const EMPTY_BOOK: PaperBook = { trades: [], meta: new Map(), uncounted: [], skipped: 0, truncated: 0 };

/** A clone row with an id, a contract and its `counts` flag: enough to list it. */
function cloneRow(v: unknown): CloneTrade | null {
  const r = obj(v);
  return r && isStr(r.trade_id) && isStr(r.contract) && typeof r.counts === "boolean" ? (r as unknown as CloneTrade) : null;
}

/** A clone row that counts: closed, with both fills, both times and a result. Anything less is in no figure. */
type CountedClone = CloneTrade & { opened_at: string; closed_at: string; fill: number; exit_fill: number; pnl_usd: number };
function counted(r: CloneTrade): r is CountedClone {
  return (
    r.counts &&
    (r.side === "call" || r.side === "put") &&
    isNum(r.qty) &&
    r.qty > 0 &&
    isTime(r.opened_at) &&
    isTime(r.closed_at) &&
    isNum(r.fill) &&
    isNum(r.exit_fill) &&
    isNum(r.pnl_usd) &&
    optNum(r.rop) &&
    optNum(r.quoted_ask) &&
    optNum(r.quote_age_s) &&
    optNum(r.best_bid) &&
    optNum(r.worst_bid)
  );
}

function manualRow(v: unknown): ManualTrade | null {
  const r = obj(v);
  if (!r) return null;
  const ok =
    isStr(r.id) &&
    isStr(r.contract) &&
    (r.side === "long" || r.side === "short") &&
    isNum(r.qty) &&
    r.qty > 0 &&
    isTime(r.opened_at) &&
    isTime(r.closed_at) &&
    isNum(r.entry) &&
    isNum(r.exit) &&
    isNum(r.pnl_usd);
  return ok ? (r as unknown as ManualTrade) : null;
}

function armRow(v: unknown): ArmTrade | null {
  const r = obj(v);
  if (!r) return null;
  const ok =
    isStr(r.vid) && isStr(r.contract) && (r.side === "call" || r.side === "put") && isTime(r.opened_at) && isTime(r.closed_at) && isNum(r.fill) && isNum(r.exit_fill) && isNum(r.pnl_usd) && optNum(r.rop);
  return ok ? (r as unknown as ArmTrade) : null;
}

const str = (v: unknown): string | null => (isStr(v) && v ? v : null);
const numOr = (v: unknown): number | null => (isNum(v) ? v : null);

/** The options clone's book. Ids are unique: a second row of one id is left out and counted. */
export function cloneBook(doc: PaperOptions): PaperBook {
  const src = obj(obj(doc)?.clone);
  if (!src) return EMPTY_BOOK;
  const trades: Trade[] = [];
  const meta = new Map<string, PaperMeta>();
  const uncounted: PaperBook["uncounted"] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const v of list(src.trades)) {
    const r = cloneRow(v);
    const c = r ? parseContract(r.contract) : null;
    if (!r || !c || seen.has(r.trade_id)) {
      skipped++;
      continue;
    }
    seen.add(r.trade_id);
    if (!r.counts) {
      uncounted.push({ id: r.trade_id, contract: r.contract, state: isStr(r.state) ? r.state : "unknown" });
      continue;
    }
    // Said to count, but without what a figure needs: left out and counted as unread, never guessed at.
    if (!counted(r)) {
      skipped++;
      continue;
    }
    trades.push({
      id: r.trade_id,
      symbol: c.symbol,
      kind: c.kind,
      strike: c.strike,
      expiry: c.expiry,
      side: "long",
      qty: r.qty,
      opened_at: r.opened_at,
      closed_at: r.closed_at,
      entry: r.fill,
      exit: r.exit_fill,
      multiplier: 100,
      pnl: r.pnl_usd,
      close: "order",
    });
    meta.set(r.trade_id, {
      rop: numOr(r.rop),
      reason: str(r.exit_reason),
      hyp: str(r.hyp),
      window: str(r.window),
      quotedAsk: numOr(r.quoted_ask),
      quoteAgeS: numOr(r.quote_age_s),
      bestBid: numOr(r.best_bid),
      worstBid: numOr(r.worst_bid),
      roughTime: r.timed_by === "journal",
    });
  }
  return { trades: sortByClose(trades), meta, uncounted, skipped, truncated: isNum(src.truncated) ? src.truncated : 0 };
}

/** The hand-placed paper account's book; null until the host sends that history. */
export function manualBook(doc: PaperOptions): PaperBook | null {
  const src = obj(obj(doc)?.manual);
  if (!src) return null;
  const trades: Trade[] = [];
  const meta = new Map<string, PaperMeta>();
  const seen = new Set<string>();
  let skipped = 0;
  for (const v of list(src.trades)) {
    const r = manualRow(v);
    const c = r ? parseContract(r.contract) : null;
    if (!r || !c || seen.has(r.id)) {
      skipped++;
      continue;
    }
    seen.add(r.id);
    const expired = r.close === "expired";
    trades.push({
      id: r.id,
      symbol: c.symbol,
      kind: c.kind,
      strike: c.strike,
      expiry: c.expiry,
      side: r.side,
      qty: r.qty,
      opened_at: r.opened_at,
      closed_at: r.closed_at,
      entry: r.entry,
      exit: r.exit,
      multiplier: 100,
      pnl: r.pnl_usd,
      close: expired ? "expired" : "order",
    });
    const cost = r.entry * 100 * r.qty;
    meta.set(r.id, { rop: cost > 0 ? r.pnl_usd / cost : null, reason: expired ? "expired" : null, hyp: null, window: null, quotedAsk: null, quoteAgeS: null, bestBid: null, worstBid: null, roughTime: false });
  }
  return { trades: sortByClose(trades), meta, uncounted: [], skipped, truncated: isNum(src.truncated) ? src.truncated : 0 };
}

export interface ArmBook extends PaperBook {
  hyp: string;
}

/** One book per research arm, in the order sent; null until the host sends them. */
export function armBooks(doc: PaperOptions): ArmBook[] | null {
  const src = obj(doc)?.arms;
  if (!Array.isArray(src)) return null;
  const out: ArmBook[] = [];
  for (const a of src) {
    const arm = obj(a);
    const hyp = arm ? str(arm.hyp) : null;
    if (!arm || !hyp) continue;
    const trades: Trade[] = [];
    const meta = new Map<string, PaperMeta>();
    const seen = new Set<string>();
    let skipped = 0;
    for (const v of list(arm.trades)) {
      const r = armRow(v);
      const c = r ? parseContract(r.contract) : null;
      if (!r || !c || seen.has(r.vid)) {
        skipped++;
        continue;
      }
      seen.add(r.vid);
      trades.push({ id: r.vid, symbol: c.symbol, kind: c.kind, strike: c.strike, expiry: c.expiry, side: "long", qty: 1, opened_at: r.opened_at, closed_at: r.closed_at, entry: r.fill, exit: r.exit_fill, multiplier: 100, pnl: r.pnl_usd, close: "order" });
      meta.set(r.vid, { rop: numOr(r.rop), reason: str(r.exit_reason), hyp, window: null, quotedAsk: null, quoteAgeS: null, bestBid: null, worstBid: null, roughTime: false });
    }
    out.push({ hyp, trades: sortByClose(trades), meta, uncounted: [], skipped, truncated: isNum(arm.truncated) ? arm.truncated : 0 });
  }
  return out;
}

/** A book cut down to the trades a filter kept: the same meta, only those trades. */
export function withTrades(book: PaperBook, trades: Trade[]): PaperBook {
  return { ...book, trades };
}

// ── The glance ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Glance {
  trades: number;
  net: number;
  /** The result of trades closed on New York's today; null when none closed today. */
  today: number | null;
  todayTrades: number;
  winRate: number | null;
  /** The running total after each day, oldest first, led by 0: the sparkline. */
  curve: number[];
  /** The last New York day a trade closed on. */
  last: string | null;
}

export function glance(trades: readonly Trade[], now: Date): Glance {
  const today = nyTime(now.toISOString()).day;
  const days = daily(trades);
  const todays = trades.filter((t) => closeDay(t) === today);
  const wins = trades.filter((t) => t.pnl > 0).length;
  return {
    trades: trades.length,
    net: trades.reduce((s, t) => s + t.pnl, 0),
    today: todays.length ? todays.reduce((s, t) => s + t.pnl, 0) : null,
    todayTrades: todays.length,
    winRate: trades.length ? wins / trades.length : null,
    curve: [0, ...days.map((d) => d.cum)],
    last: days.at(-1)?.day ?? null,
  };
}

// ── Results on the premium, and in R ─────────────────────────────────────────────────────────────────────────────

export interface PremiumStats {
  /** Trades with a result on the premium. */
  n: number;
  /** The average result on the premium (0.1 is +10%); null under MIN_SAMPLE. */
  mean: number | null;
  /** The same average in R (one R is the premium stop). */
  meanR: number | null;
  median: number | null;
}

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function premiumStats(book: PaperBook): PremiumStats {
  const rops = book.trades.map((t) => book.meta.get(t.id)?.rop).filter(isNum);
  const enough = rops.length >= MIN_SAMPLE;
  const mean = enough ? rops.reduce((s, v) => s + v, 0) / rops.length : null;
  return { n: rops.length, mean, meanR: mean === null ? null : mean / R_UNIT, median: enough ? median(rops) : null };
}

/** The bands of the histogram of results on the premium, worst first. `to` is exclusive; null is open-ended. */
export const ROP_BANDS = [
  { key: "a", label: "−25% or worse", from: null, to: -0.2499 },
  { key: "b", label: "−25% to −10%", from: -0.2499, to: -0.1 },
  { key: "c", label: "−10% to 0", from: -0.1, to: 0 },
  { key: "d", label: "0 to +10%", from: 0, to: 0.1 },
  { key: "e", label: "+10% to +25%", from: 0.1, to: 0.25 },
  { key: "f", label: "+25% to +50%", from: 0.25, to: 0.5 },
  { key: "g", label: "Over +50%", from: 0.5, to: null },
] as const;

export interface RopBand {
  key: string;
  label: string;
  trades: number;
  /** Dollars made or lost by the trades in the band. */
  pnl: number;
  /** True for a band of losing results. */
  loss: boolean;
}

export function ropHistogram(book: PaperBook): RopBand[] {
  const out: RopBand[] = ROP_BANDS.map((b) => ({ key: b.key, label: b.label, trades: 0, pnl: 0, loss: (b.to ?? 1) <= 0 }));
  for (const t of book.trades) {
    const rop = book.meta.get(t.id)?.rop;
    if (!isNum(rop)) continue;
    const i = ROP_BANDS.findIndex((b) => (b.from === null || rop >= b.from) && (b.to === null || rop < b.to));
    if (i < 0) continue;
    out[i]!.trades++;
    out[i]!.pnl += t.pnl;
  }
  return out;
}

// ── Rolling figures ──────────────────────────────────────────────────────────────────────────────────────────────

export interface RollingPoint {
  /** The trade the window ends on, counted from 1. */
  n: number;
  day: string;
  /** Share of the last ROLLING trades that made money, 0..1. */
  winRate: number;
  /** Average dollars per trade over the last ROLLING trades. */
  expectancy: number;
}

/** One point per trade from the ROLLING-th on: the win rate and average result of the trades up to it. */
export function rolling(trades: readonly Trade[], span = ROLLING): RollingPoint[] {
  const sorted = sortByClose(trades);
  const out: RollingPoint[] = [];
  let wins = 0;
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    sum += t.pnl;
    if (t.pnl > 0) wins++;
    if (i >= span) {
      const old = sorted[i - span]!;
      sum -= old.pnl;
      if (old.pnl > 0) wins--;
    }
    if (i >= span - 1) out.push({ n: i + 1, day: closeDay(t), winRate: wins / span, expectancy: sum / span });
  }
  return out;
}

// ── Groups the journal has no key for ────────────────────────────────────────────────────────────────────────────

/** What a code is called on the page. A code with no entry is shown as it is, with its dashes as spaces. */
export const REASON_LABEL: Record<string, string> = {
  premium: "Premium stop (−25%)",
  target: "Target",
  breakeven: "Stop at entry",
  time: "Time stop",
  flatten: "Flattened at 15:10",
  level: "Level lost",
  kill: "Kill switch",
  latch: "Loss latch",
  expired: "Left to expire",
  stale: "Stale quote",
  blind: "No quote",
};

export const reasonLabel = (code: string | null): string => (code === null ? "Not recorded" : (REASON_LABEL[code] ?? code.replace(/[-_]/g, " ")));

export const WINDOW_LABEL: Record<string, string> = {
  old: "First rules",
  cap15: "Ask cap $15",
  spread5: "Spread cap $5",
  no_oi: "No open-interest floor",
  qqq: "QQQ every session",
};

export const windowLabel = (code: string | null): string => (code === null ? "Not recorded" : (WINDOW_LABEL[code] ?? code.replace(/[-_]/g, " ")));

export const reasonKey = (book: PaperBook) => (t: Trade) => book.meta.get(t.id)?.reason ?? "none";
export const hypKey = (book: PaperBook) => (t: Trade) => book.meta.get(t.id)?.hyp ?? "other";
export const windowKey = (book: PaperBook) => (t: Trade) => book.meta.get(t.id)?.window ?? null;

/** Same-day or a later expiry, by the day the trade was opened in New York. */
export const EXPIRY_ORDER = [
  { key: "same", label: "Expires that day" },
  { key: "later", label: "Expires later" },
] as const;
export const expiryKey = (t: Trade): string | null => (t.expiry ? (t.expiry <= nyTime(t.opened_at).day ? "same" : "later") : null);

/** The premium paid for the whole trade, in bands. */
export const PREMIUM_ORDER = [
  { key: "a", label: "Under $100" },
  { key: "b", label: "$100–$200" },
  { key: "c", label: "$200–$400" },
  { key: "d", label: "Over $400" },
] as const;
export function premiumKey(t: Trade): string {
  const paid = t.entry * t.multiplier * t.qty;
  return paid < 100 ? "a" : paid < 200 ? "b" : paid < 400 ? "c" : "d";
}

/** The rule windows in the order the document gives them, for `groupBy`; a window with no trades stays, empty. */
export function windowOrder(doc: PaperOptions): { key: string; label: string; from: string | null }[] {
  const out: { key: string; label: string; from: string | null }[] = [];
  for (const w of list(obj(obj(doc)?.clone)?.windows)) {
    const o = obj(w);
    if (o && isStr(o.id) && !out.some((x) => x.key === o.id)) out.push({ key: o.id, label: windowLabel(o.id), from: isStr(o.from) ? o.from : null });
  }
  return out;
}

/** The days of the running total a rule window starts on: the first day with a trade on or after its first session. */
export function windowMarks(days: readonly DayRow[], order: readonly { key: string; label: string; from: string | null }[]): { day: string; label: string }[] {
  const out: { day: string; label: string }[] = [];
  for (const w of order) {
    if (!w.from) continue;
    const hit = days.find((d) => d.day >= w.from!);
    if (hit && hit !== days[0] && !out.some((m) => m.day === hit.day)) out.push({ day: hit.day, label: w.label });
  }
  return out;
}

// ── How the fills compared with the quotes ───────────────────────────────────────────────────────────────────────

export interface Execution {
  /** Entries with both a fill and the ask quoted when the order was sent. */
  n: number;
  /** The median of (fill − ask) / ask, in percent: above zero paid more than the ask. Null under MIN_SAMPLE. */
  slipMedianPct: number | null;
  /** Share filled at the ask or better, 0..1. */
  atOrBetter: number | null;
  /** The median age of the quote the entry was priced from, in seconds. Null under MIN_SAMPLE. */
  quoteAgeMedianS: number | null;
  /** Trades with the best and worst bid seen while held. */
  held: number;
  /** The average best bid over the fill, as a result on the premium (0.3 is +30% at the best moment). */
  bestMean: number | null;
  /** The average worst bid, the same way (below zero). */
  worstMean: number | null;
  /** Of the trades that were ahead at some point, the median share of the best gain the exit kept (can be below 0). */
  keptMedian: number | null;
  /** Trades that were up a full R at their best and still closed at a loss. */
  gaveBack: number;
}

export function execution(book: PaperBook): Execution {
  const slips: number[] = [];
  const best: number[] = [];
  const worst: number[] = [];
  const kept: number[] = [];
  const ages: number[] = [];
  let gaveBack = 0;
  for (const t of book.trades) {
    const m = book.meta.get(t.id);
    if (!m || t.entry <= 0) continue;
    if (isNum(m.quotedAsk) && m.quotedAsk > 0) slips.push(((t.entry - m.quotedAsk) / m.quotedAsk) * 100);
    if (isNum(m.quoteAgeS)) ages.push(m.quoteAgeS);
    if (isNum(m.bestBid) && isNum(m.worstBid)) {
      const up = (m.bestBid - t.entry) / t.entry;
      best.push(up);
      worst.push((m.worstBid - t.entry) / t.entry);
      if (up > 0) kept.push((t.exit - t.entry) / (m.bestBid - t.entry));
      if (up >= R_UNIT && t.pnl < 0) gaveBack++;
    }
  }
  const mean = (xs: number[]) => (xs.length >= MIN_SAMPLE ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  return {
    n: slips.length,
    slipMedianPct: slips.length >= MIN_SAMPLE ? median(slips) : null,
    atOrBetter: slips.length >= MIN_SAMPLE ? slips.filter((s) => s <= 0).length / slips.length : null,
    quoteAgeMedianS: ages.length >= MIN_SAMPLE ? median(ages) : null,
    held: best.length,
    bestMean: mean(best),
    worstMean: mean(worst),
    keptMedian: kept.length >= MIN_SAMPLE ? median(kept) : null,
    gaveBack,
  };
}

// ── The check against the clone's own document ───────────────────────────────────────────────────────────────────

export type CrossCheck = { status: "agree" } | { status: "not-comparable" } | { status: "differ"; page: number; clone: number; trades: number };

/** A cent a trade: what rounding each result to cents can add up to. */
const CENT = 0.01;

/**
 * The page's all-time clone total against the total the clone's own document reports (`setups`, the "all" row).
 * They are compared only when both count the same number of trades: the two documents are sent at different
 * moments, so a different count is a trade one has and the other does not have yet, not a fault.
 */
export function crossCheck(all: readonly Trade[], cloneAll: { trades: number; total_usd?: number | null } | null | undefined): CrossCheck {
  if (!cloneAll || !isNum(cloneAll.total_usd) || cloneAll.trades !== all.length || all.length === 0) return { status: "not-comparable" };
  const page = all.reduce((s, t) => s + t.pnl, 0);
  return Math.abs(page - cloneAll.total_usd) <= Math.max(0.05, CENT * all.length) ? { status: "agree" } : { status: "differ", page, clone: cloneAll.total_usd, trades: all.length };
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One closed trade as the list shows it: numbers for the sort, words for the cells. Plain data: it crosses to the browser. */
export interface PaperRow {
  id: string;
  /** When it closed, in ms. */
  at: number;
  /** "12 Oct 26" and "10:42" in New York. */
  day: string;
  opened: string;
  closed: string;
  symbol: string;
  what: string;
  kind: "call" | "put";
  short: boolean;
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  rop: number | null;
  r: number | null;
  holdMin: number;
  held: string;
  reason: string;
  hyp: string | null;
  window: string | null;
  roughTime: boolean;
}

const clock = (iso: string) => {
  const m = nyTime(iso).minute;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const dayWords = (ymd: string) => `${Number(ymd.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(2, 4)}`;

/** The list's rows, newest close first. */
export function paperRows(book: PaperBook): PaperRow[] {
  return [...book.trades]
    .sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at) || b.id.localeCompare(a.id))
    .map((t) => {
      const m = book.meta.get(t.id);
      const rop = m?.rop ?? null;
      const hold = holdMinutes(t);
      const overnight = closeDay(t) !== nyTime(t.opened_at).day;
      return {
        id: t.id,
        at: Date.parse(t.closed_at),
        day: dayWords(closeDay(t)),
        opened: overnight ? `${dayWords(nyTime(t.opened_at).day)} ${clock(t.opened_at)}` : clock(t.opened_at),
        closed: clock(t.closed_at),
        symbol: t.symbol,
        what: contractLabel(t),
        kind: t.kind === "put" ? "put" : "call",
        short: t.side === "short",
        qty: t.qty,
        entry: t.entry,
        exit: t.exit,
        pnl: t.pnl,
        rop,
        r: rop === null ? null : rop / R_UNIT,
        holdMin: hold,
        held: t.close === "expired" ? "to expiry" : fmtMinutes(hold),
        reason: reasonLabel(m?.reason ?? null),
        hyp: m?.hyp ?? null,
        window: m?.window ? windowLabel(m.window) : null,
        roughTime: m?.roughTime ?? false,
      };
    });
}

/** Group rows worth drawing: those with at least one trade. */
export const withTradesOnly = (rows: readonly GroupRow[]): GroupRow[] => rows.filter((r) => r.trades > 0);

/** True when the document is old enough to say so: more than a day behind `now`. */
export function paperStale(doc: Pick<PaperOptions, "as_of">, now: Date): boolean {
  const at = Date.parse(doc.as_of);
  return !Number.isFinite(at) || now.getTime() - at > 26 * 3_600_000;
}
