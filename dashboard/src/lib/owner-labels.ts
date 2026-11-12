// The owner's trade labels: what the Options desk's board showed when he bought each of his own options, worked out
// by an end-of-day replay of the session's edition and its settled 2-minute bars from a named feed. Two experiments
// register the rules: EXP-0031 (DEC-0045 as amended by DEC-0049; IEX) and EXP-0033 (DEC-0050; SIP). Everything that
// differs between them is one explicit rules object (`LabelRules`), required by every entry point; the two frozen
// instances below are built from the records, each field citing its line. There is no default rule set and no default
// feed, and nothing here reads the site's feed setting.
//
// Pure: no I/O and no clock. The engine is injected (`LabelEngine`): the release that first writes labels passes the
// frozen copy of DEC-0045's five engine files, so a later change to the desk never reaches a label. This module imports
// those files for their types only. Nothing in the server's shadow evaluation (desk-eval.ts and its imports) imports
// this module.
//
// Wired to nothing on purpose: DEC-0045 point 5 (and EXP-0033 `window.start`) says no one runs the labeller on the
// owner's journal before the release that first writes labels, and DEC-0049 point 4 makes the fill-time check's pass
// a gate on that release.
//
// One row per buy fill: each distinct (contract, opened_at) of a long call or put bought on the session, from the
// journal's closed pieces and its open lots. A row holds the experiment, the contract and t0, the session, the label
// and its reason, the cautions at t0 (ids and a count of checks not decided), the feed, the engine version, the bars'
// fetch time and a format version. No R, no P&L, no price, no level and no state history.
import type { CheckId, CheckInput, CheckResult, Side } from "./entry-checks";
import type { SidePlan } from "./focus-plan";
import { nyTime } from "./journal";
import { sessionOf } from "./market-calendar";
import type { LiveQuote, Options, OptionsTicker } from "./options";
import { ms } from "./owner-positions";
import { DAY_LOSS_LIMIT, MAX_TRADES_PER_DAY } from "./trade-rules";
import type { Bar2, Bars2m, NameInput, NameState, SideStateName } from "./trade-state";

type FocusItem = NonNullable<Options["focus"]>["items"][number];

// ---- the engine -----------------------------------------------------------------------------------------------------
/**
 * What the replay reads from DEC-0045's five engine files (trade-state.ts, trade-now.ts, entry-checks.ts,
 * focus-plan.ts, options.ts). The release that first writes labels passes its frozen copy; the tests pass the live
 * functions.
 */
export interface LabelEngine {
  /** trade-state.ts: one name's row and both side states. */
  nameState(n: NameInput): NameState;
  /** focus-plan.ts: the call and put plans of a focus item. */
  focusPlan(item: FocusItem): { call: SidePlan | null; put: SidePlan | null };
  /** entry-checks.ts: the cautions at an instant (HYP-0049, HYP-0057). */
  entryChecks(input: CheckInput, side: Side): CheckResult;
  /** trade-state.ts: the 2-minute bars' own ATR, the sweep's unit, as the board passes it (trade-now.ts boardRows). */
  atr2m(closed: readonly Bar2[], n?: number): number | null;
  /** options.ts: the edition's half-day answer, as the board reads it. */
  isHalfDay(e: Options): boolean;
  /** entry-checks.ts: a name and the name that leads it. */
  LEADERS: Readonly<Record<string, string>>;
  /** trade-state.ts. */
  CLOSE_GRACE_MS: number;
  /** entry-checks.ts / trade-state.ts. */
  BAR_MINUTES: number;
  /** trade-state.ts: the board's own boundaries, New York minutes (EXP-0033 `labeller_rules.instants`). */
  FIRST_ENTRY_MIN: number;
  LUNCH_FROM_MIN: number;
  LUNCH_TO_MIN: number;
  /** trade-state.ts: the session's flat minute (15:10 on a full day, 12:10 on a half day). */
  flatMinute(halfDay: boolean): number;
}

// ---- the rules ------------------------------------------------------------------------------------------------------
/** The stock feeds the labels' bars may be asked for. */
export const LABEL_FEEDS = ["iex", "sip"] as const;
export type LabelFeed = (typeof LABEL_FEEDS)[number];

/** The feed, checked: anything but "iex" or "sip" throws. There is no default. */
export function labelFeed(feed: unknown): LabelFeed {
  if (feed !== "iex" && feed !== "sip") throw new TypeError("the labels' feed must be named: iex or sip");
  return feed;
}

/** What differs between the two experiments' labellers. Only the two frozen instances below are accepted. */
export interface LabelRules {
  /** The experiment the rows belong to; stamped on every row. */
  readonly experiment: "EXP-0031" | "EXP-0033";
  /** The feed the bars are asked for by name; stamped on every row. */
  readonly feed: LabelFeed;
  /**
   * Evaluation instants beside the bar-end grid: "none", or the board's own boundaries that fall strictly inside the
   * session (FIRST_ENTRY_MIN, the two ends of LUNCH and the session's flatMinute, New York clock).
   */
  readonly extraInstants: "none" | "board_boundaries";
  /**
   * The edition in force at t0: "stored" (the session's one stored edition; its as_of after t0, or unreadable, is
   * no_record), or "received_by_t0" (the copy the store received last at or before t0, by its receipt time; as_of is
   * never read; no copy by t0 is no_record no_edition).
   */
  readonly edition: "stored" | "received_by_t0";
  /**
   * Bars that could not be had, or an answer that is not full (a request still paging, or no leader bar ending at the
   * close): "no_record" (bars_unavailable), or "retry" (the run writes no rows and asks again later).
   */
  readonly barsMissing: "no_record" | "retry";
  /** Whether each fill is read against the session's board-feed stamps (feed_unknown, board_off). */
  readonly boardFeed: "none" | "stamps";
}

/**
 * EXP-0031 (research/experiments/EXP-0031-owner-trades-board/config.yaml, DEC-0045 section 3, DEC-0049).
 * Its text leaves the alternative's gate, the edition copy, the extra instants and a half-day disagreement open; where
 * it does, the value is the reading this code has carried since its review (said on each field).
 */
export const EXP_0031_RULES: LabelRules = Object.freeze({
  experiment: "EXP-0031",
  // labels.feed: IEX by name (DEC-0049), never through the site's feed setting or a default
  feed: "iex",
  // labels.evaluation.when: "once per 2-minute bar, at now = the bar's end + CLOSE_GRACE_MS" (nothing else)
  extraInstants: "none",
  // labels.inputs: "the stored edition for the session"; as_of after t0 → no_record is the review's reading
  edition: "stored",
  // labels.feed: "no IEX bars for a session makes its positions no_record"
  barsMissing: "no_record",
  // EXP-0031 has no board-feed stamp (window.feed_change ends the window instead)
  boardFeed: "none",
} as const);

/** EXP-0033 (research/experiments/EXP-0033-owner-trades-board-sip/config.yaml, DEC-0050). */
export const EXP_0033_RULES: LabelRules = Object.freeze({
  experiment: "EXP-0033",
  // labels.feed: SIP by name (DEC-0050), never through the site's feed setting or a default
  feed: "sip",
  // labeller_rules.instants: the grid plus "the board's own boundaries that fall strictly inside the session"
  // (FIRST_ENTRY_MIN, LUNCH, flatMinute); on a half day 13:00:00 is the close and is not an instant
  extraInstants: "board_boundaries",
  // labeller_rules.edition: "the copy for the session that the store received last at or before t0, by the store's
  // own receipt time (never the publisher's as_of)"; none by t0 → no_edition
  edition: "received_by_t0",
  // labels.feed: "no SIP bars for a session follows labeller_rules fetch"; labeller_rules.fetch: "an answer is full
  // when every request's last page came back with no next page token and SMH has a bar ending at the session's close"
  barsMissing: "retry",
  // window.board_feed: covered / feed_unknown / board_off; labeller_rules.no_record_reasons ranks them
  boardFeed: "stamps",
} as const);

/** The rules, checked: only the two frozen instances are accepted. Every entry point calls this first. */
export function labelRules(rules: unknown): LabelRules {
  if (rules !== EXP_0031_RULES && rules !== EXP_0033_RULES) throw new TypeError("a labeller entry point needs EXP_0031_RULES or EXP_0033_RULES");
  return rules as LabelRules;
}

// ---- constants ------------------------------------------------------------------------------------------------------
/** The label row's own format. */
export const LABEL_FORMAT = 1 as const;
/** An enter_zone interval is extended by this much at its end (`labels.zone_extend_s` in both configs). */
export const ZONE_EXTEND_MS = 60_000;
/** The labels, in the registered order: the first that applies (`labels.order` in both configs). */
export const LABELS = ["no_record", "not_focus", "in_zone", "early", "alt", "off_plan"] as const;
export type Label = (typeof LABELS)[number];
/** On-plan labels (`labels.on_plan`). */
export const ON_PLAN: readonly Label[] = ["in_zone", "early"];
/** The cautions counted (`labels.cautions.counted`); the desk-only before10 is not one. */
export const COUNTED_CAUTIONS: readonly CheckId[] = ["range", "gap", "leader", "iv", "late", "winner"];

/**
 * Why a fill is `no_record`: every code either rules object can emit. Each rules object tests its own causes in its
 * own registered order (see NO_RECORD_ORDER) and stores the first that applies.
 */
export const NO_RECORD_REASONS = [
  "edition_missing",
  "edition_time_unknown",
  "edition_after_t0",
  "not_a_session",
  "no_edition",
  "half_day_mismatch",
  "feed_unknown",
  "board_off",
  "bars_unavailable",
  "bars_start_late",
  "bars_gap",
  "leader_bars_start_late",
  "leader_bars_gap",
  "bars_incomplete",
  "side_gap",
  "side_broke_earlier",
] as const;
export type NoRecordReason = (typeof NO_RECORD_REASONS)[number];

/**
 * The causes each rules object can emit, in the order it tests them (the first that applies is stored).
 * - EXP-0031: its `labels.order` names the edition, the bars and the side; the edition's time, the calendar, the
 *   half-day disagreement and the split of the bars cause are this code's readings, kept from review.
 * - EXP-0033: `labeller_rules.no_record_reasons`, word for word (bars_incomplete covers the symbol's and SMH's bars).
 */
export const NO_RECORD_ORDER: Readonly<Record<LabelRules["experiment"], readonly NoRecordReason[]>> = Object.freeze({
  "EXP-0031": [
    "edition_missing",
    "edition_time_unknown",
    "edition_after_t0",
    "not_a_session",
    "half_day_mismatch",
    "bars_unavailable",
    "bars_start_late",
    "bars_gap",
    "leader_bars_start_late",
    "leader_bars_gap",
    "side_gap",
    "side_broke_earlier",
  ],
  "EXP-0033": ["edition_missing", "not_a_session", "no_edition", "half_day_mismatch", "feed_unknown", "board_off", "bars_incomplete", "side_gap", "side_broke_earlier"],
});

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---- the session ----------------------------------------------------------------------------------------------------
export interface LabelSessionBounds {
  day: string;
  /** 09:30 and the close (16:00, or 13:00 on a half day) New York, ms, from market-calendar.json. */
  open: number;
  close: number;
  halfDay: boolean;
}

/** The instant of a New York wall-clock time on a day, right under either daylight-saving offset. */
function nyAt(day: string, minutes: number): number | null {
  const guess = Date.parse(`${day}T00:00:00Z`) + (minutes + 4 * 60) * 60_000;
  if (!Number.isFinite(guess)) return null;
  const at = nyTime(new Date(guess).toISOString());
  const seen = at.day === day ? at.minute : at.day < day ? at.minute - 1440 : at.minute + 1440;
  return guess - (seen - minutes) * 60_000;
}

/** The New York day of an instant. */
export const nyDayOf = (t: number): string => nyTime(new Date(t).toISOString()).day;

/** The regular session of a New York day from the exchange calendar (a half day included), or null. */
export function labelSessionBounds(day: string): LabelSessionBounds | null {
  const s = sessionOf(day);
  if ((s.kind !== "open" && s.kind !== "half") || s.open === null || s.close === null) return null;
  const open = nyAt(day, s.open);
  const close = nyAt(day, s.close);
  return open === null || close === null ? null : { day, open, close, halfDay: s.kind === "half" };
}

/**
 * The evaluation instants, the one place they are made: each 2-minute bar of the session's grid at its end +
 * CLOSE_GRACE_MS, from the first bar's end to the close, and under `extraInstants: "board_boundaries"` the board's own
 * boundaries that fall strictly inside the session (FIRST_ENTRY_MIN, LUNCH_FROM_MIN, LUNCH_TO_MIN and
 * flatMinute(halfDay), New York clock); sorted. A full day adds 09:35, 11:30, 13:00 and 15:10; a half day (close 13:00)
 * adds 09:35, 11:30 and 12:10.
 */
export function evaluationTimes(b: LabelSessionBounds, engine: LabelEngine, rules: LabelRules): number[] {
  const r = labelRules(rules);
  const barMs = engine.BAR_MINUTES * 60_000;
  const out: number[] = [];
  for (let end = b.open + barMs; end <= b.close; end += barMs) out.push(end + engine.CLOSE_GRACE_MS);
  if (r.extraInstants === "board_boundaries")
    for (const m of [engine.FIRST_ENTRY_MIN, engine.LUNCH_FROM_MIN, engine.LUNCH_TO_MIN, engine.flatMinute(b.halfDay)]) {
      const t = nyAt(b.day, m);
      if (t !== null && t > b.open && t < b.close && !out.includes(t)) out.push(t);
    }
  return out.sort((x, y) => x - y);
}

// ---- the inputs -----------------------------------------------------------------------------------------------------
/** A settled 2-minute bar as the labeller keeps it: the engine's Bar2 with Alpaca's volume and VWAP, null when absent. */
export interface LabelBar extends Bar2 {
  v: number | null;
  vw: number | null;
}

/** One copy of an edition as the store kept it, with the store's own receipt time (ISO 8601). */
export interface EditionCopy {
  edition: Options;
  receivedAt: string | null;
}

/** One board-feed stamp (EXP-0033 `window.board_feed.body`), as far as the labeller reads it. */
export interface BoardStamp {
  /** Its path-style identity (`window.board_feed.path`): desk/feeds/board/<New York date>/<HHMM New York>.json. */
  key: string;
  feed: "iex" | "sip" | "refused";
  answered: "ok" | "stale" | "plan" | "error";
  /** Server time, ISO 8601: what positions the stamp in every rule. */
  at: string;
  deployment: string;
}

/** One bars request as the fetch reports it: whether its last page came back with no next page token. */
export interface BarsRequest {
  complete: boolean;
}

export interface ReplayInput {
  /** The New York session. */
  session: string;
  /** The edition copies the store holds (only those for the session are read). */
  editions: readonly EditionCopy[];
  /** The session's settled 2-minute bars per symbol (the focus names and the leaders); null when they could not be
   * had. A symbol asked for that did not trade has its key with an empty list. */
  bars: Readonly<Record<string, readonly LabelBar[]>> | null;
  /** The feed the fetch actually asked for, from its own answer (owner-labels-fetch.ts); must equal the rules' feed. */
  barsFeed: LabelFeed;
  /** When the fetch's answer arrived, from its own answer, ISO 8601; null when the bars could not be had. */
  barsFetchedAt: string | null;
  /** The requests the bars came from, as the fetch reports them; a request still paging leaves the answer not full. */
  requests: readonly BarsRequest[];
  /** The journal (only the pieces and lots of the session's New York day are read). */
  journal: { trades: readonly unknown[]; open?: readonly unknown[] | null };
  /** When the journal was read from the broker: its own read stamp (`as_of`, as the Trades page shows it). */
  journalReadAt: string;
  /** The session's board-feed stamps, read under `boardFeed: "stamps"` only. */
  stamps?: readonly BoardStamp[];
}

/** The 2-minute bars an evaluation reads, as far as completeness goes: `Bars2m.complete` and `Bars2m.gaps`. */
export interface BarsSeen {
  complete: boolean;
  gaps: number;
}

/** One evaluation of one name: its instant, until the next, the row, and what its bars looked like. */
export interface Step {
  now: number;
  /** The next evaluation's instant; Infinity after the last. */
  until: number;
  state: NameState;
  bars: BarsSeen;
  /** The leader's bars, for a name with a leader; null otherwise. */
  leader: BarsSeen | null;
}

/** A side's state over a half-open interval [from, until). */
export interface SideInterval {
  from: number;
  until: number;
  state: SideStateName;
}

export interface NameReplay {
  symbol: string;
  steps: Step[];
  sides: Record<Side, SideInterval[]>;
}

/** One edition copy replayed over the session. */
export interface Replay {
  session: string;
  bounds: LabelSessionBounds | null;
  /** The calendar and this copy disagree on a half day. */
  halfDayMismatch: boolean;
  barsAvailable: boolean;
  /** The copy's focus names, in the card's order. */
  focus: string[];
  names: Record<string, NameReplay>;
}

const NO_TICKER: Pick<OptionsTicker, "levels" | "bars" | "expected_move"> = { levels: [], bars: [], expected_move: null };

function focusItems(e: Options): FocusItem[] {
  const items = Array.isArray(e.focus?.items) ? e.focus.items : [];
  return [...items].filter((i) => typeof i?.symbol === "string").sort((a, b) => a.rank - b.rank);
}

/** One symbol's bars inside the session, one per slot, oldest first. */
function sessionBars(raw: readonly LabelBar[] | undefined, b: LabelSessionBounds): LabelBar[] {
  const by = new Map<number, LabelBar>();
  for (const x of raw ?? []) if (x && isNum(x.start) && isNum(x.end) && x.start >= b.open && x.end <= b.close) by.set(x.start, x);
  return [...by.values()].sort((p, q) => p.start - q.start);
}

/**
 * `Bars2m` from the settled bars alone at `now` (`labels.evaluation.bars`): the bars ended at or before `now`, no bar
 * forming, `since` the first bar's start, `missing` every 2-minute slot from `since` up to `now` (and the close)
 * without a bar, as trade-state's bars2m counts them.
 */
export function barsAt(bars: readonly LabelBar[], b: LabelSessionBounds, now: number, barMs: number): Bars2m {
  const closed: Bar2[] = bars.filter((x) => x.end <= now).map((x) => ({ start: x.start, end: x.end, o: x.o, h: x.h, l: x.l, c: x.c }));
  if (closed.length === 0) return { closed: [], partial: null, since: null, complete: false, missing: [], gaps: 0 };
  const since = closed[0]!.start;
  const have = new Set(closed.map((x) => x.start));
  const missing: number[] = [];
  for (let s0 = since; s0 + barMs <= Math.min(now, b.close); s0 += barMs) if (!have.has(s0)) missing.push(s0);
  return { closed, partial: null, since, complete: since <= b.open, missing, gaps: missing.length };
}

/**
 * The quote at `now` from the bars ended by then (`labels.evaluation.quote`): the session, the last close, the first
 * bar's open, the highest high and lowest low since the open, no previous close, at `now`. With `withVwap` (the leader
 * quote), the volume-weighted mean of the bars' own VWAPs; a bar without volume or VWAP leaves it null, and the leader
 * check unknown.
 */
export function quoteAt(bars: readonly LabelBar[], session: string, now: number, withVwap: boolean): LiveQuote | null {
  const done = bars.filter((x) => x.end <= now);
  if (done.length === 0) return null;
  let vwap: number | null = null;
  if (withVwap) {
    let vol = 0;
    let sum = 0;
    let ok = true;
    for (const x of done) {
      if (!isNum(x.v) || x.v < 0 || !isNum(x.vw)) ok = false;
      else {
        vol += x.v;
        sum += x.v * x.vw;
      }
    }
    vwap = ok && vol > 0 ? sum / vol : null;
  }
  return {
    day: session,
    price: done[done.length - 1]!.c,
    open: done[0]!.o,
    high: Math.max(...done.map((x) => x.h)),
    low: Math.min(...done.map((x) => x.l)),
    prev_close: null,
    at: new Date(now).toISOString(),
    vwap,
  };
}

type Piece = { symbol: string; kind: string; strike?: number | null; expiry?: string | null; side: string; opened_at: string; closed_at: string; pnl: number };
type HeldLot = { symbol: string; kind: string; strike?: number | null; expiry?: string | null; side: string; opened_at?: string | null };

const isPiece = (t: unknown): t is Piece => {
  const p = t as Partial<Piece> | null;
  return !!p && typeof p === "object" && typeof p.symbol === "string" && typeof p.kind === "string" && typeof p.side === "string" && typeof p.opened_at === "string" && typeof p.closed_at === "string" && Number.isFinite(ms(p.opened_at)) && Number.isFinite(ms(p.closed_at)) && isNum(p.pnl);
};
const isLot = (l: unknown): l is HeldLot => {
  const p = l as Partial<HeldLot> | null;
  return !!p && typeof p === "object" && typeof p.symbol === "string" && typeof p.kind === "string" && typeof p.side === "string";
};
const lotTime = (l: HeldLot): number => (typeof l.opened_at === "string" ? ms(l.opened_at) : NaN);
const contractOf = (x: { symbol: string; kind: string; strike?: number | null; expiry?: string | null }) => JSON.stringify([x.symbol, x.kind, isNum(x.strike) ? x.strike : null, x.expiry ?? null]);

/**
 * The day's two journal inputs at `now` (`labels.evaluation`): `wonToday`, a piece closed before `now` that New York
 * day with pnl above 0; `dayLimitUsed`, the pieces closed before `now` that day summing to the day's loss limit or
 * worse (before fees, as the board reads it), or MAX_TRADES_PER_DAY entries before `now` that day, an entry being each
 * distinct opened_at of one contract among the buy fills (long call and put pieces and lots still held).
 */
export function dayInputsAt(journal: ReplayInput["journal"], session: string, now: number): { wonToday: boolean; dayLimitUsed: boolean } {
  const pieces = (Array.isArray(journal.trades) ? journal.trades : []).filter(isPiece);
  const closed = pieces.filter((p) => ms(p.closed_at) < now && nyDayOf(ms(p.closed_at)) === session);
  const net = closed.reduce((s, p) => s + p.pnl, 0);
  const wonToday = closed.some((p) => p.pnl > 0);
  const entries = new Set<string>();
  // An entry is a buy fill as the record defines one: a distinct (contract, opened_at) of a long call or put, from the
  // closed pieces and the lots still held. Long stock is not an entry.
  const buy = (x: HeldLot, at: number) => {
    if (x.side === "long" && (x.kind === "call" || x.kind === "put") && Number.isFinite(at) && at < now && nyDayOf(at) === session) entries.add(`${contractOf(x)}|${at}`);
  };
  for (const p of pieces) buy(p, ms(p.opened_at));
  for (const l of (Array.isArray(journal.open) ? journal.open : []).filter(isLot)) buy(l, lotTime(l));
  return { wonToday, dayLimitUsed: net <= -DAY_LOSS_LIMIT || entries.size >= MAX_TRADES_PER_DAY };
}

// ---- the fills ------------------------------------------------------------------------------------------------------
/** A buy fill: one distinct (contract, opened_at) of a long call or put. The row's identity. */
export interface Fill {
  symbol: string;
  kind: Side;
  strike: number | null;
  expiry: string | null;
  /** The fill's opened_at, ISO 8601 UTC. */
  t0: string;
}

export interface FillBook {
  fills: Fill[];
  /** Long call or put lots still held with no usable opened_at: no row, counted. */
  lotsWithoutTime: number;
}

/**
 * The session's buy fills (EXP-0033 `labeller_rules.rows`; the same reading for EXP-0031): every distinct (contract,
 * opened_at) of a long call or put whose opened_at is on that New York day, from the journal's closed pieces and its
 * open lots. A buy sold in parts, or partly sold and partly held, is one fill; two buys at different times are two.
 */
export function sessionFills(journal: ReplayInput["journal"], session: string): FillBook {
  const by = new Map<string, Fill>();
  let lotsWithoutTime = 0;
  const add = (x: HeldLot, at: number) => {
    if (x.side !== "long" || (x.kind !== "call" && x.kind !== "put") || nyDayOf(at) !== session) return;
    const key = `${contractOf(x)}|${at}`;
    if (!by.has(key)) by.set(key, { symbol: x.symbol, kind: x.kind, strike: isNum(x.strike) ? x.strike : null, expiry: x.expiry ?? null, t0: new Date(at).toISOString() });
  };
  for (const p of (Array.isArray(journal.trades) ? journal.trades : []).filter(isPiece)) add(p, ms(p.opened_at));
  for (const l of (Array.isArray(journal.open) ? journal.open : []).filter(isLot)) {
    const at = lotTime(l);
    if (Number.isFinite(at)) add(l, at);
    else if (l.side === "long" && (l.kind === "call" || l.kind === "put")) lotsWithoutTime++;
  }
  const fills = [...by.values()].sort((a, b) => (a.t0 < b.t0 ? -1 : a.t0 > b.t0 ? 1 : contractOf(a) < contractOf(b) ? -1 : contractOf(a) > contractOf(b) ? 1 : 0));
  return { fills, lotsWithoutTime };
}

// ---- the edition in force -------------------------------------------------------------------------------------------
const timeOf = (iso: unknown): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The session's copies, oldest receipt first (an unreadable receipt time first, in list order). */
/** JSON with every object's keys sorted, so two equal copies give the same text whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/**
 * The session's copies, oldest receipt first (an unreadable receipt time first). The record does not rank copies
 * received at the same instant; so that the choice never depends on the order the store lists them in, a tie goes to
 * the later as_of (an unreadable one first), and then to the copy whose canonical JSON sorts last.
 */
function sessionCopies(input: ReplayInput): EditionCopy[] {
  const key = (c: EditionCopy) => ({ at: timeOf(c.receivedAt) ?? -Infinity, asOf: timeOf(c.edition.as_of) ?? -Infinity, text: canonical(c.edition) });
  return input.editions
    .filter((c) => !!c?.edition && c.edition.session === input.session)
    .map((c) => ({ c, k: key(c) }))
    .sort((a, b) => a.k.at - b.k.at || a.k.asOf - b.k.asOf || (a.k.text < b.k.text ? -1 : a.k.text > b.k.text ? 1 : 0))
    .map(({ c }) => c);
}

/** The copy in force at t0 under the rules, or why there is none. */
export function editionAt(input: ReplayInput, t0: number, rules: LabelRules): { copy: EditionCopy } | { reason: NoRecordReason } {
  const r = labelRules(rules);
  const copies = sessionCopies(input);
  if (copies.length === 0) return { reason: "edition_missing" };
  if (r.edition === "stored") {
    // The store keeps one edition per session; given several, the last received is the stored one.
    const copy = copies[copies.length - 1]!;
    const asOf = timeOf(copy.edition.as_of);
    if (asOf === null) return { reason: "edition_time_unknown" };
    return t0 < asOf ? { reason: "edition_after_t0" } : { copy };
  }
  // received_by_t0: the store's own receipt time; the publisher's as_of is never read.
  const inForce = copies.filter((c) => {
    const at = timeOf(c.receivedAt);
    return at !== null && at <= t0;
  });
  return inForce.length ? { copy: inForce[inForce.length - 1]! } : { reason: "no_edition" };
}

// ---- the replay -----------------------------------------------------------------------------------------------------
interface Prepared {
  bounds: LabelSessionBounds;
  barMs: number;
  halfDay: boolean;
  edition: Options;
  items: FocusItem[];
  bars: Record<string, LabelBar[]>;
}

function prepare(input: ReplayInput, edition: Options, engine: LabelEngine): Prepared | null {
  const bounds = labelSessionBounds(input.session);
  if (!bounds || edition.session !== input.session) return null;
  const halfDay = engine.isHalfDay(edition);
  if (halfDay !== bounds.halfDay) return null;
  const bars: Record<string, LabelBar[]> = {};
  for (const [s, list] of Object.entries(input.bars ?? {})) bars[s] = sessionBars(list, bounds);
  return { bounds, barMs: engine.BAR_MINUTES * 60_000, halfDay, edition, items: focusItems(edition), bars };
}

/** The engine's inputs for one focus name at `now`, built only from bars that ended at or before `now`. */
function nameInputAt(p: Prepared, input: ReplayInput, engine: LabelEngine, item: FocusItem, now: number): { n: NameInput; leader: Bars2m | null } {
  const plan = engine.focusPlan(item);
  const own = p.bars[item.symbol] ?? [];
  const bars = barsAt(own, p.bounds, now, p.barMs);
  const lead = engine.LEADERS[item.symbol];
  const leadBars = lead ? (p.bars[lead] ?? []) : null;
  const day = dayInputsAt(input.journal, input.session, now);
  const n: NameInput = {
    symbol: item.symbol,
    session: input.session,
    call: plan.call,
    put: plan.put,
    atr: item.atr,
    sweepAtr: engine.atr2m(bars.closed, 14),
    ticker: p.edition.tickers.find((t) => t.symbol === item.symbol) ?? NO_TICKER,
    bars,
    quote: quoteAt(own, input.session, now, false),
    leaderQuote: leadBars ? quoteAt(leadBars, input.session, now, true) : null,
    receivedAt: now,
    now: new Date(now),
    halfDay: p.halfDay,
    dayLimitUsed: day.dayLimitUsed,
    wonToday: day.wonToday,
  };
  return { n, leader: leadBars ? barsAt(leadBars, p.bounds, now, p.barMs) : null };
}

/** The row is gated: it shows neither a side's state nor an alternative while it is no_trade or paused. */
const gated = (s: NameState) => s.state === "no_trade" || s.state === "paused";

/** A side's state (`labels.side_state`): the side's own while the row is neither no_trade nor paused. */
export function sideStateOf(s: NameState, side: Side): SideStateName {
  return gated(s) ? "no_trade" : s[side].state;
}

/** The bars were had and every request finished paging. */
export const barsHad = (input: ReplayInput): boolean => input.bars !== null && Array.isArray(input.requests) && input.requests.every((q) => q?.complete === true);

/**
 * One edition copy replayed over the session (`labels.evaluation`): for each focus name, `nameState` at every instant
 * of evaluationTimes with inputs built only from bars that ended at or before it, and per side the half-open intervals
 * of its state, each holding from its instant until the next. Nothing is evaluated when the calendar has no session,
 * the calendar and the copy disagree on a half day, or the bars could not be had.
 */
export function replaySession(input: ReplayInput, copy: EditionCopy, engine: LabelEngine, rules: LabelRules): Replay {
  const r = labelRules(rules);
  const bounds = labelSessionBounds(input.session);
  const base: Replay = {
    session: input.session,
    bounds,
    halfDayMismatch: bounds !== null && engine.isHalfDay(copy.edition) !== bounds.halfDay,
    barsAvailable: barsHad(input),
    focus: copy.edition.session === input.session ? focusItems(copy.edition).map((i) => i.symbol) : [],
    names: {},
  };
  const p = prepare(input, copy.edition, engine);
  if (!p || !base.barsAvailable) return base;
  const times = evaluationTimes(p.bounds, engine, r);
  for (const item of p.items) {
    const steps: Step[] = times.map((now, i) => {
      const { n, leader } = nameInputAt(p, input, engine, item, now);
      return { now, until: times[i + 1] ?? Infinity, state: engine.nameState(n), bars: { complete: n.bars.complete, gaps: n.bars.gaps }, leader: leader ? { complete: leader.complete, gaps: leader.gaps } : null };
    });
    const sides = { call: [] as SideInterval[], put: [] as SideInterval[] };
    for (const s of steps) for (const side of ["call", "put"] as const) sides[side].push({ from: s.now, until: s.until, state: sideStateOf(s.state, side) });
    base.names[item.symbol] = { symbol: item.symbol, steps, sides };
  }
  return base;
}

/** The evaluation holding `t`: the latest with now ≤ t; null before the first. */
export function stepAt(name: NameReplay, t: number): Step | null {
  let lo = 0;
  let hi = name.steps.length - 1;
  let found: Step | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (name.steps[mid]!.now <= t) {
      found = name.steps[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// ---- the board-feed stamps (EXP-0033 window.board_feed) --------------------------------------------------------------
const TWO_MIN = 2 * 60_000;
const TEN_MIN = 10 * 60_000;

/**
 * What the session's stamps say at t0, by the per-position rules of `window.board_feed` only (the window-ending rules
 * are not here). Only stamps of t0's New York day with a readable `at` are read, in the order of their `at`:
 * - covered: a stamp reading sip has its at in [t0 − 2 min, t0], or t0 lies strictly between the at of two consecutive
 *   stamps that both read sip; `coveredBy` is the key of the covering stamp: the latest sip stamp in the window, or
 *   else the earlier stamp of the bracketing pair; null when not covered;
 * - boardOff: among the stamps whose at is at or before t0, a run of consecutive stamps answering other than ok
 *   (stale, plan or error) whose last stamp's at minus its first's is 10 minutes or more and whose last stamp's at lies
 *   in [t0 − 2 min, t0].
 */
export function boardFeedAt(stamps: readonly BoardStamp[], t0: number): { covered: boolean; coveredBy: string | null; boardOff: boolean } {
  const day = nyDayOf(t0);
  const list = stamps
    .map((s) => ({ s, at: timeOf(s?.at) }))
    .filter((x): x is { s: BoardStamp; at: number } => x.at !== null && nyDayOf(x.at) === day)
    .sort((a, b) => a.at - b.at);
  const inWindow = (at: number) => t0 - TWO_MIN <= at && at <= t0;
  let coveredBy: string | null = null;
  for (const x of list) if (x.s.feed === "sip" && inWindow(x.at)) coveredBy = x.s.key;
  for (let i = 0; coveredBy === null && i + 1 < list.length; i++) {
    const a = list[i]!;
    const b = list[i + 1]!;
    if (a.s.feed === "sip" && b.s.feed === "sip" && a.at < t0 && t0 < b.at) coveredBy = a.s.key;
  }
  const upTo = list.filter((x) => x.at <= t0);
  let boardOff = false;
  for (let j = upTo.length - 1; j >= 0 && !boardOff; j--) {
    const last = upTo[j]!;
    if (!inWindow(last.at)) break;
    if (last.s.answered === "ok") continue;
    let i = j;
    while (i > 0 && upTo[i - 1]!.s.answered !== "ok") i--;
    if (last.at - upTo[i]!.at >= TEN_MIN) boardOff = true;
  }
  return { covered: coveredBy !== null, coveredBy, boardOff };
}

// ---- the label ------------------------------------------------------------------------------------------------------
export interface Labelled {
  label: Label;
  /** The cause, for `no_record` only: the first that applies in the rules' NO_RECORD_ORDER. */
  reason: NoRecordReason | null;
}

/** A label with what it was read against (`row_stores_also`'s audit fields). */
export interface LabelDecision extends Labelled {
  /** The edition copy the label was read against; null when the label was decided before a copy was chosen. */
  copy: EditionCopy | null;
  /** The key of the stamp that covered t0, or null (always null when the rules read no stamps). */
  stampKey: string | null;
}

/** What the labeller needs of a fill: its symbol, kind and t0. */
export type LabelPosition = Pick<Fill, "symbol" | "kind" | "t0">;

const noRecord = (reason: NoRecordReason): Labelled => ({ label: "no_record", reason });
const plain = (label: Exclude<Label, "no_record">): Labelled => ({ label, reason: null });

/** The label from a replay once the edition and board-feed causes are cleared: not_focus, the bars, the side, the states. */
function labelOnReplay(position: LabelPosition, t0: number, replay: Replay, rules: LabelRules): Labelled {
  const exp33 = rules.experiment === "EXP-0033";
  if (!replay.focus.includes(position.symbol)) return plain("not_focus");
  const name = replay.names[position.symbol];
  if (!replay.barsAvailable || !name) return noRecord(exp33 ? "bars_incomplete" : "bars_unavailable");
  const side: Side = position.kind;
  const at = stepAt(name, t0);
  if (at) {
    if (!at.bars.complete) return noRecord(exp33 ? "bars_incomplete" : "bars_start_late");
    if (at.bars.gaps > 0) return noRecord(exp33 ? "bars_incomplete" : "bars_gap");
    if (at.leader && !at.leader.complete) return noRecord(exp33 ? "bars_incomplete" : "leader_bars_start_late");
    if (at.leader && at.leader.gaps > 0) return noRecord(exp33 ? "bars_incomplete" : "leader_bars_gap");
    if (at.state[side].gap) return noRecord("side_gap");
    if (at.state[side].brokeEarlier) return noRecord("side_broke_earlier");
  }
  const own = name.sides[side];
  if (own.some((x) => x.state === "enter_zone" && x.from <= t0 && t0 < x.until + ZONE_EXTEND_MS)) return plain("in_zone");
  if (own.some((x) => x.state === "get_ready" && x.from <= t0 && t0 < x.until)) return plain("early");
  if (at && !gated(at.state) && (["call", "put"] as const).some((s) => at.state[s].alt?.side === side)) return plain("alt");
  return plain("off_plan");
}

/**
 * Replays the session lazily, one replay per edition copy, and labels fills against the copy in force at each t0.
 * The label is the first of `labels.order` that applies, read on the fill's own side; a no_record row stores one
 * reason, the first that applies in the rules' NO_RECORD_ORDER.
 */
export class SessionLabeller {
  private readonly replays = new Map<EditionCopy, Replay>();
  readonly rules: LabelRules;

  constructor(
    readonly input: ReplayInput,
    readonly engine: LabelEngine,
    rules: LabelRules,
  ) {
    this.rules = labelRules(rules);
  }

  replayFor(copy: EditionCopy): Replay {
    let r = this.replays.get(copy);
    if (!r) this.replays.set(copy, (r = replaySession(this.input, copy, this.engine, this.rules)));
    return r;
  }

  /** The fill's label, its reason, and what it was read against. */
  decide(position: LabelPosition): LabelDecision {
    const t0 = ms(position.t0);
    if (!Number.isFinite(t0) || nyDayOf(t0) !== this.input.session) throw new RangeError("the fill's t0 is not on the replay's session");
    const bf = this.rules.boardFeed === "stamps" ? boardFeedAt(this.input.stamps ?? [], t0) : null;
    const stampKey = bf?.coveredBy ?? null;
    const out = (l: Labelled, copy: EditionCopy | null = null): LabelDecision => ({ ...l, copy, stampKey });
    const bounds = labelSessionBounds(this.input.session);
    const e = editionAt(this.input, t0, this.rules);
    if (this.rules.experiment === "EXP-0033") {
      // labeller_rules.no_record_reasons, in its order
      if ("reason" in e && e.reason === "edition_missing") return out(noRecord("edition_missing"));
      if (!bounds || t0 < bounds.open || t0 >= bounds.close) return out(noRecord("not_a_session"));
      if ("reason" in e) return out(noRecord("no_edition"));
      const replay = this.replayFor(e.copy);
      if (replay.halfDayMismatch) return out(noRecord("half_day_mismatch"), e.copy);
      if (!bf!.covered) return out(noRecord("feed_unknown"), e.copy);
      if (bf!.boardOff) return out(noRecord("board_off"), e.copy);
      return out(labelOnReplay(position, t0, replay, this.rules), e.copy);
    }
    if ("reason" in e) return out(noRecord(e.reason));
    if (!bounds) return out(noRecord("not_a_session"));
    const replay = this.replayFor(e.copy);
    if (replay.halfDayMismatch) return out(noRecord("half_day_mismatch"), e.copy);
    return out(labelOnReplay(position, t0, replay, this.rules), e.copy);
  }

  /** The fill's label and reason. */
  label(position: LabelPosition): Labelled {
    const d = this.decide(position);
    return { label: d.label, reason: d.reason };
  }

  /**
   * The cautions at t0 (`labels.cautions`, HYP-0049 / HYP-0057): `entryChecks(input, kind)` at now = t0 against the
   * copy in force, inputs built as for an evaluation from bars ended by t0. The counted ids it returns, sorted, and the
   * number of entries in its `unknown`. Null when the inputs cannot be built.
   */
  cautions(position: LabelPosition): { cautions: CheckId[]; unknown: number } | null {
    const t0 = ms(position.t0);
    if (!Number.isFinite(t0) || !barsHad(this.input)) return null;
    const e = editionAt(this.input, t0, this.rules);
    if ("reason" in e) return null;
    const p = prepare(this.input, e.copy.edition, this.engine);
    const item = p?.items.find((i) => i.symbol === position.symbol);
    if (!p || !item) return null;
    const { n } = nameInputAt(p, this.input, this.engine, item, t0);
    const r = this.engine.entryChecks(
      { symbol: n.symbol, ticker: n.ticker, session: n.session, quote: n.quote, leaderQuote: n.leaderQuote ?? null, bars: n.bars.closed, since: n.bars.since, gaps: n.bars.gaps, halfDay: n.halfDay, now: n.now, wonToday: n.wonToday },
      position.kind,
    );
    const ids = [...new Set(r.cautions.map((c) => c.id).filter((id): id is CheckId => (COUNTED_CAUTIONS as readonly string[]).includes(id)))].sort();
    return { cautions: ids, unknown: r.unknown.length };
  }
}

/** One fill's label (a SessionLabeller for one call). */
export function labelPosition(position: LabelPosition, input: ReplayInput, engine: LabelEngine, rules: LabelRules): Labelled {
  return new SessionLabeller(input, engine, rules).label(position);
}

/** One fill's cautions at t0 (a SessionLabeller for one call). */
export function cautionsAt(position: LabelPosition, input: ReplayInput, engine: LabelEngine, rules: LabelRules): { cautions: CheckId[]; unknown: number } | null {
  return new SessionLabeller(input, engine, rules).cautions(position);
}

// ---- the bars' answer -------------------------------------------------------------------------------------------------
/**
 * Whether the bars are a full answer (EXP-0033 `labeller_rules.fetch`): bars were had, every request's last page came
 * back with no next page token, every focus name of every edition copy of the session and every leader has a key in
 * the bars (a name never fetched is not a final answer), and every leader (SMH) has a bar ending at the session's close. A focus name with no
 * trade in a late slot does not make it short; an empty slot inside a full answer is final.
 */
export function barsAnswerFull(input: ReplayInput, engine: LabelEngine): boolean {
  const b = labelSessionBounds(input.session);
  if (!b || !barsHad(input) || input.requests.length === 0) return false;
  const bars = input.bars!;
  const leaders = Object.values(engine.LEADERS);
  // Every focus name of every copy of the session, and every leader, was asked for: its key is there (an empty list
  // is a name that did not trade, which is still a full answer).
  const asked = new Set<string>(leaders);
  for (const c of sessionCopies(input)) for (const i of focusItems(c.edition)) asked.add(i.symbol);
  if (![...asked].every((s) => Object.hasOwn(bars, s) && Array.isArray(bars[s]))) return false;
  return leaders.every((s) => sessionBars(bars[s], b).some((x) => x.end === b.close));
}

// ---- the row --------------------------------------------------------------------------------------------------------
/** One buy fill's label as it is stored: nothing else (no R, no P&L, no price, no level, no state history). */
export interface LabelRow {
  format: typeof LABEL_FORMAT;
  /** The experiment whose rules made the row. */
  experiment: LabelRules["experiment"];
  /** The contract, as the journal gives it: identity, not a price. */
  symbol: string;
  kind: Side;
  strike: number | null;
  expiry: string | null;
  /** The fill's opened_at, ISO 8601 UTC. */
  t0: string;
  /** The New York session (t0's day). */
  session: string;
  label: Label;
  reason: NoRecordReason | null;
  /** The counted cautions at t0, sorted (`row_stores_also`); null when the label is no_record or not_focus. */
  cautions: CheckId[] | null;
  /** How many checks entryChecks could not decide at t0 (`row_stores_also`); null with `cautions`. */
  unknown: number | null;
  /** The receipt time of the edition copy used (`row_stores_also`, audit); null when no copy was used. */
  edition_copy_received_at: string | null;
  /** The key of the stamp that covered t0, or null (`row_stores_also`, audit). */
  covering_stamp_key: string | null;
  /** The feed the bars were asked for (`row_stores`), from the fetch's own answer. */
  feed: LabelFeed;
  /** DEC-0045's ENGINE_VERSION of the engine that was passed (`row_stores`). */
  engine_version: string;
  /** When the bars were fetched, ISO 8601 (`row_stores`), from the fetch's own answer; null when they could not be had. */
  bars_fetched_at: string | null;
}

/** The row's keys, in order. */
export const LABEL_ROW_KEYS = [
  "format",
  "experiment",
  "symbol",
  "kind",
  "strike",
  "expiry",
  "t0",
  "session",
  "label",
  "reason",
  "cautions",
  "unknown",
  "edition_copy_received_at",
  "covering_stamp_key",
  "feed",
  "engine_version",
  "bars_fetched_at",
] as const;

export interface LabelMeta {
  /** DEC-0045's ENGINE_VERSION of the engine passed: required, never empty. */
  engineVersion: string;
}

export type LabelRun =
  | { state: "labelled"; rows: LabelRow[]; summary: { fills: number; lotsWithoutTime: number } }
  /**
   * No row is written; ask again later. bars_unavailable / bars_not_full: under `barsMissing: "retry"`, the bars were
   * not had or the answer is not full. journal_not_current: the journal was read before the session's close +
   * JOURNAL_SETTLE_MS, so the day's fills may not all be in it yet.
   */
  | { state: "retry"; why: "bars_unavailable" | "bars_not_full" | "journal_not_current" };

/**
 * How long after the close the journal must have been read before a session's rows are written: the record's own
 * delay for the bars (EXP-0033 `labeller_rules.fetch`, "no sooner than 20 minutes after the close"), applied to the
 * journal too, under both rules objects (the cautious reading; EXP-0031 will not run).
 *
 * Still owed by the release PR: rows are written once, so a fill that reaches the journal only after the session's
 * rows were written has no row. The release must count such fills (a buy fill of a written session with no row) and
 * report them; this module cannot see them.
 */
export const JOURNAL_SETTLE_MS = 20 * 60_000;

const isoOrNull = (v: string | null): string | null => {
  const t = timeOf(v);
  return t === null ? null : new Date(t).toISOString();
};

/**
 * Every buy fill of the session labelled: the copy in force per fill, replayed once per copy, and the label and the
 * cautions at t0 worked out in the same run; rows by t0 then contract. Throws when the meta's engine version is empty,
 * when the bars' own feed is not the rules' feed, or when bars were had with no readable fetch time.
 *
 * A day the calendar gives no regular session needs no bars and no journal check: its fills are labelled by the rules'
 * order alone (not_a_session, or edition_missing first when no copy is stored).
 */
export function labelSession(input: ReplayInput, engine: LabelEngine, rules: LabelRules, meta: LabelMeta): LabelRun {
  const r = labelRules(rules);
  const feed = labelFeed(r.feed);
  if (typeof meta?.engineVersion !== "string" || meta.engineVersion.trim() === "") throw new TypeError("the label rows need the engine's version");
  if (labelFeed(input.barsFeed) !== feed) throw new TypeError(`the bars came from ${input.barsFeed}, and ${r.experiment} reads ${feed}`);
  const fetchedAt = isoOrNull(input.barsFetchedAt);
  if (input.bars !== null && fetchedAt === null) throw new TypeError("bars were had with no readable fetch time");
  const bounds = labelSessionBounds(input.session);
  if (bounds) {
    const readAt = timeOf(input.journalReadAt);
    if (readAt === null || readAt < bounds.close + JOURNAL_SETTLE_MS) return { state: "retry", why: "journal_not_current" };
    if (r.barsMissing === "retry" && !barsAnswerFull(input, engine)) return { state: "retry", why: input.bars === null ? "bars_unavailable" : "bars_not_full" };
  }
  const s = new SessionLabeller(input, engine, r);
  const book = sessionFills(input.journal, input.session);
  const rows = book.fills.map((f): LabelRow => {
    const d = s.decide(f);
    const c = d.label === "no_record" || d.label === "not_focus" ? null : s.cautions(f);
    return {
      format: LABEL_FORMAT,
      experiment: r.experiment,
      symbol: f.symbol,
      kind: f.kind,
      strike: f.strike,
      expiry: f.expiry,
      t0: f.t0,
      session: input.session,
      label: d.label,
      reason: d.reason,
      cautions: c ? c.cautions : null,
      unknown: c ? c.unknown : null,
      edition_copy_received_at: d.copy ? isoOrNull(d.copy.receivedAt) : null,
      covering_stamp_key: d.stampKey,
      feed: input.barsFeed,
      engine_version: meta.engineVersion,
      bars_fetched_at: input.bars === null ? null : fetchedAt,
    };
  });
  return { state: "labelled", rows, summary: { fills: book.fills.length, lotsWithoutTime: book.lotsWithoutTime } };
}
