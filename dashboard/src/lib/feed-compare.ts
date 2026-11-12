// The server comparison of the two stock feeds (DEC-0050 points 5 and 9; docs/runbooks/feed-agreement.md, "Server
// comparison"). SIP is the board's feed; IEX stays as a comparison feed. Once a minute in the session the sampler
// (feed-compare-sample.ts) asks Alpaca for the same snapshots on iex and then on sip and stores both answers; after
// the close the report (feed-compare-report.ts) measures, from those samples, the session's settled 1-minute bars of
// both feeds and the feed-agreement replay, how far the two feeds differ.
//
// A data-quality measurement only: counts, ages and differences. It reads no trade, no P&L and no outcome of any
// setup. Every report is PRIVATE (owner login only). IEX and SIP are kept apart everywhere: each has its own object or
// its own field, and no measure pools the two feeds' values.
//
// Pure: no I/O and no clock. Nothing in the engine imports this file.
import { ENGINE_VERSION, type RowSide } from "./desk-eval";
import { TRADE_STALE_MS } from "./entry-checks";
import type { SessionReport } from "./feed-agreement";

export const COMPARE_V = 1;
export const COMPARE_PREFIX = "desk/feeds/compare/";
export const RULES = "feed-agreement r3 + compare v1";
/** The two requests of a minute must finish at most this far apart for anything of the minute to count. */
export const REQUESTS_WITHIN_MS = 2_000;
/** Two trades (or two quotes) pair only when their times are at most this far apart; a quote must also be at most this old. */
export const PAIR_WITHIN_MS = 5_000;
/** The report is built once the session's close is this far behind. */
export const REPORT_AFTER_CLOSE_MS = 20 * 60_000;
/** The last scheduled build tick (23:50 UTC): a bars failure that may heal is built as no_bars from here. */
export const REPORT_LAST_TICK_UTC_MIN = 23 * 60 + 50;
/** No build after the UTC day's last minute (23:59 UTC): slack for a late 23:50 fire. */
export const REPORT_DEADLINE_UTC_MIN = 23 * 60 + 59;
/** The symbol sampled every minute beside the focus names. */
export const MARKET_SYMBOL = "SPY";

export type CompareFeed = "iex" | "sip";
export type BoardFeed = "iex" | "sip" | "refused";

export const samplePath = (day: string, hhmm: string) => `${COMPARE_PREFIX}${day}/${hhmm}.json`;
export const reportPath = (day: string) => `${COMPARE_PREFIX}${day}/report.json`;
export const SAMPLE_PATH_RE = /^desk\/feeds\/compare\/(\d{4}-\d{2}-\d{2})\/(\d{4})\.json$/;
export const REPORT_PATH_RE = /^desk\/feeds\/compare\/(\d{4}-\d{2}-\d{2})\/report\.json$/;

// ---- one sample ---------------------------------------------------------------------------------------------------
export interface SnapTrade {
  p: number | null;
  t: number | null;
}
export interface SnapQuote {
  bp: number | null;
  bs: number | null;
  ap: number | null;
  as: number | null;
  t: number | null;
}
export interface SnapMinute {
  t: number | null;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
  vw: number | null;
  n: number | null;
}
/** One symbol's snapshot on one feed: only these fields, each a number (times in ms) or null. Nothing is invented. */
export interface SnapRow {
  latestTrade: SnapTrade | null;
  latestQuote: SnapQuote | null;
  minuteBar: SnapMinute | null;
  dailyBar: { v: number | null } | null;
}
/** One feed's request: when it started and finished (ms), its HTTP status (null: no answer), its rows (null: none read). */
export interface FeedAnswer {
  started: number;
  finished: number;
  status: number | null;
  rows: Record<string, SnapRow> | null;
  /** Answered 400 and was asked again once without any symbol that is not a ticker. */
  retried?: boolean;
}
export interface Sample {
  v: typeof COMPARE_V;
  /** When the run started (ms). */
  at: number;
  /** The symbols asked for, in the order asked. */
  symbols: string[];
  board_feed: BoardFeed;
  iex: FeedAnswer;
  sip: FeedAnswer;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** An RFC 3339 time as ms; Alpaca's nanosecond fractions are cut to milliseconds. Null when unreadable. */
export function timeMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(t) ? t : null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** One raw Alpaca snapshot reduced to the kept fields. */
export function snapRow(raw: unknown): SnapRow {
  const r = obj(raw) ?? {};
  const tr = obj(r.latestTrade);
  const q = obj(r.latestQuote);
  const m = obj(r.minuteBar);
  const d = obj(r.dailyBar);
  return {
    latestTrade: tr ? { p: num(tr.p), t: timeMs(tr.t) } : null,
    latestQuote: q ? { bp: num(q.bp), bs: num(q.bs), ap: num(q.ap), as: num(q.as), t: timeMs(q.t) } : null,
    minuteBar: m ? { t: timeMs(m.t), o: num(m.o), h: num(m.h), l: num(m.l), c: num(m.c), v: num(m.v), vw: num(m.vw), n: num(m.n) } : null,
    dailyBar: d ? { v: num(d.v) } : null,
  };
}

/** The rows of a snapshots answer for the symbols asked: a symbol Alpaca left out has no row. */
export function snapRows(body: unknown, symbols: readonly string[]): Record<string, SnapRow> {
  const b = obj(body) ?? {};
  const map = obj(b.snapshots) ?? b;
  const out: Record<string, SnapRow> = {};
  for (const s of symbols) if (Object.hasOwn(map, s) && obj(map[s])) out[s] = snapRow(map[s]);
  return out;
}

const isAnswer = (v: unknown): v is FeedAnswer => {
  const a = obj(v);
  return !!a && num(a.started) !== null && num(a.finished) !== null && (a.status === null || num(a.status) !== null) && (a.rows === null || obj(a.rows) !== null);
};

/** A stored sample, or null when it is not a v1 sample. */
export function parseSample(text: string | null): Sample | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const s = obj(v);
  if (!s || s.v !== COMPARE_V || num(s.at) === null || !Array.isArray(s.symbols) || !s.symbols.every((x) => typeof x === "string")) return null;
  if (s.board_feed !== "iex" && s.board_feed !== "sip" && s.board_feed !== "refused") return null;
  if (!isAnswer(s.iex) || !isAnswer(s.sip)) return null;
  return s as unknown as Sample;
}

// ---- the paired rules ---------------------------------------------------------------------------------------------
export type MinuteNotComparable = "both_failed" | "iex_failed" | "sip_failed" | "apart";
export type NotComparable = MinuteNotComparable | "missing_symbol" | "bad_price" | "stale_iex" | "stale_sip" | "stale_both" | "trades_apart";
export type QuoteNotComparable = MinuteNotComparable | "missing_quote" | "bad_quote" | "stale_quote_iex" | "stale_quote_sip" | "stale_quote_both" | "quotes_apart";
export const NOT_COMPARABLE: readonly NotComparable[] = ["both_failed", "iex_failed", "sip_failed", "apart", "missing_symbol", "bad_price", "stale_iex", "stale_sip", "stale_both", "trades_apart"];
export const QUOTE_NOT_COMPARABLE: readonly QuoteNotComparable[] = [
  "both_failed",
  "iex_failed",
  "sip_failed",
  "apart",
  "missing_quote",
  "bad_quote",
  "stale_quote_iex",
  "stale_quote_sip",
  "stale_quote_both",
  "quotes_apart",
];

const answered = (a: FeedAnswer) => a.status !== null && a.status >= 200 && a.status < 300 && a.rows !== null;

/**
 * The minute rule: a minute counts at all only when both requests answered 2xx with a readable body (else
 * `both_failed`, `iex_failed` or `sip_failed`) and they finished at most REQUESTS_WITHIN_MS (2 s) apart: 2,000 ms
 * counts, 2,001 ms does not (`apart`). Null when the minute counts.
 */
export function minuteRule(s: Sample): MinuteNotComparable | null {
  const i = answered(s.iex);
  const p = answered(s.sip);
  if (!i && !p) return "both_failed";
  if (!i) return "iex_failed";
  if (!p) return "sip_failed";
  return Math.abs(s.iex.finished - s.sip.finished) > REQUESTS_WITHIN_MS ? "apart" : null;
}

/**
 * The paired rule for last trades (frozen, compare v1). One symbol of one minute is a **trade pair** only when:
 *  1. the minute counts (minuteRule: both 2xx, finished at most 2 s apart);
 *  2. both answers hold a last trade for the symbol with a time (`missing_symbol`) and a price above zero
 *     (`bad_price`);
 *  3. each feed's last trade is at most TRADE_STALE_MS (entry-checks.ts) older than its own request's finish: exactly
 *     TRADE_STALE_MS counts, one ms more does not (`stale_iex`, `stale_sip`, or `stale_both`);
 *  4. the two trades' times are at most PAIR_WITHIN_MS (5 s) apart: 5,000 ms counts, 5,001 ms does not
 *     (`trades_apart`), so the two prices are from about the same moment.
 * Anything else is counted under its reason, never dropped. The report's `stale_only_iex` and `stale_only_sip` are
 * the one-sided stale counts.
 */
export function pairOf(s: Sample, symbol: string): { ok: true; iex: number; sip: number; gapMs: number } | { ok: false; reason: NotComparable } {
  const m = minuteRule(s);
  if (m) return { ok: false, reason: m };
  const i = s.iex.rows![symbol]?.latestTrade;
  const p = s.sip.rows![symbol]?.latestTrade;
  if (!i || !p || i.t === null || p.t === null) return { ok: false, reason: "missing_symbol" };
  if (i.p === null || p.p === null || i.p <= 0 || p.p <= 0) return { ok: false, reason: "bad_price" };
  const staleI = s.iex.finished - i.t > TRADE_STALE_MS;
  const staleS = s.sip.finished - p.t > TRADE_STALE_MS;
  if (staleI && staleS) return { ok: false, reason: "stale_both" };
  if (staleI) return { ok: false, reason: "stale_iex" };
  if (staleS) return { ok: false, reason: "stale_sip" };
  const gapMs = Math.abs(i.t - p.t);
  if (gapMs > PAIR_WITHIN_MS) return { ok: false, reason: "trades_apart" };
  return { ok: true, iex: i.p, sip: p.p, gapMs };
}

/**
 * The paired rule for quotes (frozen, compare v1). One symbol of one minute is a **quote pair** only when the minute
 * counts (minuteRule), both answers hold a quote with a time (`missing_quote`) and a bid and an ask above zero
 * (`bad_quote`), each quote is at most PAIR_WITHIN_MS (5 s) older than its own request's finish (`stale_quote_iex`,
 * `stale_quote_sip`, `stale_quote_both`), and the two quotes' times are at most PAIR_WITHIN_MS apart (`quotes_apart`).
 * The spreads are measured on quote pairs only.
 */
export function quotePairOf(s: Sample, symbol: string): { ok: true; iex: SnapQuote; sip: SnapQuote } | { ok: false; reason: QuoteNotComparable } {
  const m = minuteRule(s);
  if (m) return { ok: false, reason: m };
  const i = s.iex.rows![symbol]?.latestQuote;
  const p = s.sip.rows![symbol]?.latestQuote;
  if (!i || !p || i.t === null || p.t === null) return { ok: false, reason: "missing_quote" };
  if (i.bp === null || i.ap === null || p.bp === null || p.ap === null || i.bp <= 0 || i.ap <= 0 || p.bp <= 0 || p.ap <= 0) return { ok: false, reason: "bad_quote" };
  const staleI = s.iex.finished - i.t > PAIR_WITHIN_MS;
  const staleS = s.sip.finished - p.t > PAIR_WITHIN_MS;
  if (staleI && staleS) return { ok: false, reason: "stale_quote_both" };
  if (staleI) return { ok: false, reason: "stale_quote_iex" };
  if (staleS) return { ok: false, reason: "stale_quote_sip" };
  if (Math.abs(i.t - p.t) > PAIR_WITHIN_MS) return { ok: false, reason: "quotes_apart" };
  return { ok: true, iex: i, sip: p };
}

// ---- statistics ---------------------------------------------------------------------------------------------------
/** The q-th quantile (0..1) by linear interpolation between order statistics (numpy's default); null for none. */
export function percentile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
export type Dist = { median: number | null; p95: number | null; n: number };
export type DistMax = Dist & { max: number | null };
export type DistTails = { median: number | null; p10: number | null; p90: number | null; n: number };
export const dist = (xs: readonly number[]): Dist => ({ median: percentile(xs, 0.5), p95: percentile(xs, 0.95), n: xs.length });
export const distMax = (xs: readonly number[]): DistMax => ({ ...dist(xs), max: xs.length ? Math.max(...xs) : null });
export const distTails = (xs: readonly number[]): DistTails => ({ median: percentile(xs, 0.5), p10: percentile(xs, 0.1), p90: percentile(xs, 0.9), n: xs.length });

/** |a − b| / mid × 10,000, mid the mean of the two; null when either is not above zero. */
export function diffBp(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return (Math.abs(a - b) / ((a + b) / 2)) * 10_000;
}

/** A quote's spread: (ask − bid) / mid × 10,000, or "locked" (ask == bid), "crossed" (ask < bid), or null without both sides. */
export function spreadBp(q: SnapQuote | null | undefined): number | "locked" | "crossed" | null {
  if (!q || q.bp === null || q.ap === null || q.bp <= 0 || q.ap <= 0) return null;
  if (q.ap === q.bp) return "locked";
  if (q.ap < q.bp) return "crossed";
  return ((q.ap - q.bp) / ((q.ap + q.bp) / 2)) * 10_000;
}

// ---- settled 1-minute bars ----------------------------------------------------------------------------------------
/** One settled 1-minute bar as read after the close: its start (ms) and the kept fields. */
export interface MinBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}
export type BarsWhy = "no_focus_names" | "sip-plan" | "sip-not-entitled" | "iex-refused" | "no-bars" | "time-budget" | "upstream";

// ---- the report ---------------------------------------------------------------------------------------------------
export interface CompareDisagreement {
  symbol: string;
  side: RowSide;
  slot: string;
  sip: string;
  iex: string;
}
export interface SignalsOk {
  status: "ok";
  edition_as_of: string | null;
  comparable: number;
  identical: number;
  identical_pct: number | null;
  events_sip: number;
  events_iex: number;
  matched: number;
  sip_only: number;
  iex_only: number;
  disagreements: CompareDisagreement[];
}
export type Signals = SignalsOk | { status: "no_edition" } | { status: "no_bars"; why: BarsWhy };

export type BarsSection =
  | {
      status: "ok";
      aligned: number;
      only_sip: number;
      only_iex: number;
      close_diff_bp: Dist;
      high_low_diff_bp: Dist;
      volume_ratio_sip_over_iex: DistTails;
    }
  | { status: "no_edition" }
  | { status: "no_bars"; why: BarsWhy };

export interface CompareReport {
  v: typeof COMPARE_V;
  day: string;
  engine: string;
  rules: typeof RULES;
  built_at: string;
  board_feed: Record<BoardFeed, number>;
  /** Sample minutes in the session; those stored at or after the close; those that are not v1 samples or fall before the open. */
  samples: { minutes: number; expected: number; unreadable: number; after_close: number };
  signals: Signals;
  prices: {
    pairs: number;
    not_comparable: Record<NotComparable, number>;
    diff_bp: DistMax;
    share_over_1bp: number | null;
    stale_only_iex: number;
    stale_only_sip: number;
    /** |t_sip − t_iex| of the paired last trades, ms. */
    trade_gap_ms: Dist;
    quote_pairs: number;
    quote_not_comparable: Record<QuoteNotComparable, number>;
    /** |mid_sip − mid_iex| / mean mid × 10,000 over the quote pairs, mid = (bid + ask) / 2. */
    quote_mid_diff_bp: DistMax;
  };
  bars: BarsSection;
  spread: { sip_bp: Dist; iex_bp: Dist; locked_or_crossed: { sip: number; iex: number } };
  /** Last-trade ages, measured from each request's start; a trade dated after the start is clamped to 0 and counted as clock_skew. */
  freshness: { sip_trade_age_s: Dist; iex_trade_age_s: Dist; clock_skew: { sip: number; iex: number } };
  limitations: readonly string[];
}

export const COMPARE_LIMITATIONS: readonly string[] = [
  "Data quality only: counts, ages and differences; no trade, no P&L and no outcome of any setup.",
  "Each minute asks iex first and sip right after: a minute counts only when the two requests finished at most 2 s apart.",
  "Each feed's last trade can be a different print; a price pair needs the two trades' times within 5 s of each other.",
  "Spreads, trade ages and quote mids are measured on counted minutes only; spreads and mids on quote pairs only (each quote at most 5 s old, the two within 5 s).",
  "Trade ages are measured from each request's start, so the request's own time in flight is not counted as age; a trade dated after the start is clamped to 0 and counted as clock skew.",
  "The bars section uses each feed's settled 1-minute session bars, read once after the close, aligned only on an identical start; a bar on one feed only is a real absence on the other.",
  "A minute with no sample (no run, no keys, a failed write) is missing from every count and shows only in samples.minutes against samples.expected.",
  "The signals section is the feed-agreement replay on the edition in force at the open and carries that runbook's limitations; its disagreements stay in the stored file.",
];

export type BarsInput = { status: "ok"; bars: Record<CompareFeed, Readonly<Record<string, readonly MinBar[]>>> } | { status: "no_edition" } | { status: "no_bars"; why: BarsWhy };

export interface ReportInput {
  day: string;
  /** Minutes in the regular session (390, or 210 on a half day). */
  expected: number;
  builtAt: number;
  samples: readonly Sample[];
  unreadable: number;
  afterClose: number;
  signals: { status: "ok"; report: SessionReport; editionAsOf: string | null } | { status: "no_edition" } | { status: "no_bars"; why: BarsWhy };
  bars: BarsInput;
}

function signalsOf(s: ReportInput["signals"]): Signals {
  if (s.status !== "ok") return s;
  const r = s.report;
  return {
    status: "ok",
    edition_as_of: s.editionAsOf,
    comparable: r.units.comparable,
    identical: r.units.identical,
    identical_pct: r.share === null ? null : Math.round(r.share * 100_000) / 1_000,
    events_sip: r.events.sip,
    events_iex: r.events.iex,
    matched: r.events.matched,
    sip_only: r.events.sip_only,
    iex_only: r.events.iex_only,
    disagreements: r.disagreements.map((d) => ({ symbol: d.symbol, side: d.side, slot: d.slot, sip: d.sip, iex: d.iex })),
  };
}

/** The bars section: the two feeds' settled 1-minute bars aligned on an identical start. */
export function barsSection(b: BarsInput): BarsSection {
  if (b.status !== "ok") return b;
  let aligned = 0;
  let onlySip = 0;
  let onlyIex = 0;
  const closeD: number[] = [];
  const hlD: number[] = [];
  const vol: number[] = [];
  const syms = new Set([...Object.keys(b.bars.iex), ...Object.keys(b.bars.sip)]);
  for (const sym of syms) {
    const i = new Map((b.bars.iex[sym] ?? []).map((x) => [x.t, x]));
    const p = new Map((b.bars.sip[sym] ?? []).map((x) => [x.t, x]));
    for (const t of p.keys()) if (!i.has(t)) onlySip++;
    for (const [t, bi] of i) {
      const bs = p.get(t);
      if (!bs) {
        onlyIex++;
        continue;
      }
      aligned++;
      const c = diffBp(bs.c, bi.c);
      if (c !== null) closeD.push(c);
      for (const d of [diffBp(bs.h, bi.h), diffBp(bs.l, bi.l)]) if (d !== null) hlD.push(d);
      if (bs.v !== null && bi.v !== null && bs.v > 0 && bi.v > 0) vol.push(bs.v / bi.v);
    }
  }
  return { status: "ok", aligned, only_sip: onlySip, only_iex: onlyIex, close_diff_bp: dist(closeD), high_low_diff_bp: dist(hlD), volume_ratio_sip_over_iex: distTails(vol) };
}

const mid = (q: SnapQuote) => (q.bp! + q.ap!) / 2;

/** The day's report from its samples (already limited to the session), the 1-minute bars and the replay. */
export function buildReport(input: ReportInput): CompareReport {
  const samples = [...input.samples].sort((a, b) => a.at - b.at);
  const board: Record<BoardFeed, number> = { sip: 0, iex: 0, refused: 0 };
  const nc = Object.fromEntries(NOT_COMPARABLE.map((r) => [r, 0])) as Record<NotComparable, number>;
  const qnc = Object.fromEntries(QUOTE_NOT_COMPARABLE.map((r) => [r, 0])) as Record<QuoteNotComparable, number>;
  const diffs: number[] = [];
  const gaps: number[] = [];
  const midDiffs: number[] = [];
  const spreads: Record<CompareFeed, number[]> = { iex: [], sip: [] };
  const lockedOrCrossed: Record<CompareFeed, number> = { iex: 0, sip: 0 };
  const ages: Record<CompareFeed, number[]> = { iex: [], sip: [] };
  const skew: Record<CompareFeed, number> = { iex: 0, sip: 0 };
  for (const s of samples) {
    board[s.board_feed]++;
    const counted = minuteRule(s) === null;
    for (const sym of s.symbols) {
      const pr = pairOf(s, sym);
      if (pr.ok) {
        const d = diffBp(pr.sip, pr.iex);
        if (d !== null) diffs.push(d);
        gaps.push(pr.gapMs);
      } else nc[pr.reason]++;
      const qp = quotePairOf(s, sym);
      if (qp.ok) {
        const d = diffBp(mid(qp.sip), mid(qp.iex));
        if (d !== null) midDiffs.push(d);
        for (const f of ["iex", "sip"] as const) {
          const sp = spreadBp(qp[f]);
          if (sp === "locked" || sp === "crossed") lockedOrCrossed[f]++;
          else if (sp !== null) spreads[f].push(sp);
        }
      } else qnc[qp.reason]++;
      if (!counted) continue;
      for (const f of ["iex", "sip"] as const) {
        const t = s[f].rows![sym]?.latestTrade?.t ?? null;
        if (t === null) continue;
        const age = (s[f].started - t) / 1000;
        if (age < 0) skew[f]++;
        ages[f].push(Math.max(0, age));
      }
    }
  }
  return {
    v: COMPARE_V,
    day: input.day,
    engine: ENGINE_VERSION,
    rules: RULES,
    built_at: new Date(input.builtAt).toISOString(),
    board_feed: board,
    samples: { minutes: samples.length, expected: input.expected, unreadable: input.unreadable, after_close: input.afterClose },
    signals: signalsOf(input.signals),
    prices: {
      pairs: diffs.length,
      not_comparable: nc,
      diff_bp: distMax(diffs),
      share_over_1bp: diffs.length ? diffs.filter((d) => d > 1).length / diffs.length : null,
      stale_only_iex: nc.stale_iex,
      stale_only_sip: nc.stale_sip,
      trade_gap_ms: dist(gaps),
      quote_pairs: midDiffs.length,
      quote_not_comparable: qnc,
      quote_mid_diff_bp: distMax(midDiffs),
    },
    bars: barsSection(input.bars),
    spread: { sip_bp: dist(spreads.sip), iex_bp: dist(spreads.iex), locked_or_crossed: { sip: lockedOrCrossed.sip, iex: lockedOrCrossed.iex } },
    freshness: { sip_trade_age_s: dist(ages.sip), iex_trade_age_s: dist(ages.iex), clock_skew: { sip: skew.sip, iex: skew.iex } },
    limitations: COMPARE_LIMITATIONS,
  };
}

/** A stored report, or null when it is not a v1 report of the compare. */
export function parseReport(text: string | null): CompareReport | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const r = obj(v);
  if (!r || r.v !== COMPARE_V || typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || typeof r.engine !== "string") return null;
  if (!obj(r.samples) || !obj(r.signals) || !obj(r.prices) || !obj(r.bars) || !obj(r.spread) || !obj(r.freshness) || !obj(r.board_feed)) return null;
  return r as unknown as CompareReport;
}

/** What the site may read of a report: the replay's per-slot disagreements are left out (they stay in the stored file). */
export type CompareReportView = Omit<CompareReport, "signals"> & { signals: Omit<SignalsOk, "disagreements"> | Exclude<Signals, SignalsOk> };
export function reportView(r: CompareReport): CompareReportView {
  if (r.signals.status !== "ok") return r as CompareReportView;
  const { disagreements: _drop, ...signals } = r.signals;
  void _drop;
  return { ...r, signals };
}

/**
 * The stored edition in force at the session's open: of the candidates whose session is `day`, the newest built at or
 * before the open; when every one was built after the open, the earliest. Null when none is that session's.
 */
export function editionInForce<E extends { session?: unknown; as_of?: unknown }>(candidates: readonly (E | null)[], day: string, openMs: number): E | null {
  const asOf = (e: E) => (typeof e.as_of === "string" ? Date.parse(e.as_of) : NaN);
  const mine = candidates.filter((e): e is E => !!e && e.session === day && Number.isFinite(asOf(e)));
  const before = mine.filter((e) => asOf(e) <= openMs).sort((a, b) => asOf(b) - asOf(a));
  if (before.length) return before[0]!;
  return [...mine].sort((a, b) => asOf(a) - asOf(b))[0] ?? null;
}
