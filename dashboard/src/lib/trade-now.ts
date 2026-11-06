// The "Trade now" board on the Options desk: what it shows at the top, which rows it draws and in what order, and
// what it announces. Advisory and read-only: nothing here places an order, and the 9 rules are unchanged. The states
// themselves come from trade-state.ts; this file only puts them on the board.
//
// Pure: no I/O and no clock. The caller passes `now`.
import { weekDate } from "./format";
import { focusPlan, type SidePlan } from "./focus-plan";
import { sessionView, type JournalDoc } from "./journal";
import { closeMinute, type LiveQuote, nyClock, OPEN_MIN, type Options, type OptionsTicker, type TrailPoint } from "./options";
import { DAY_LOSS_LIMIT, dayCheck, MAX_TRADES_PER_DAY, MIN_ROOM_MULTIPLE, PREMIUM_STOP, RISK_PER_TRADE } from "./trade-rules";
import { type AltTrigger, atr2m, type Bar2, bars2m, flatMinute, FIRST_ENTRY_MIN, mergeBars, type NameState, type NameStateName, nameState } from "./trade-state";
import { LEADERS, type Side } from "./entry-checks";
import type { Tone } from "./labels";

type Item = NonNullable<Options["focus"]>["items"][number];

const p2 = (v: number) => v.toFixed(2);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The state words on the board, in capitals like the desk's other live chips. */
export const STATE_WORD: Record<NameStateName, string> = {
  no_trade: "NO TRADE",
  watch: "WATCH",
  get_ready: "GET READY",
  enter_zone: "ENTER ZONE",
  plan_off: "PLAN OFF",
  missed: "MISSED",
  paused: "PRICES PAUSED",
};

/** When the focus card's next edition is in: the after-close build, in Sydney. */
export const REFRESH_SYDNEY = "08:54";

// ---- the header -----------------------------------------------------------------------------------------------------
export type FeedStatus = "loading" | "off" | "error" | "ok";

export type BoardMode =
  /** The edition's focus card is for an earlier day: no rows. */
  | { kind: "old"; line: string }
  /** Quotes not configured or failing: no rows; the cards below still hold the static plans. */
  | { kind: "off"; line: string }
  /** Waiting for the first quote: trigger prices only. */
  | { kind: "loading"; line: string }
  /** Outside the session: trigger prices only. */
  | { kind: "next"; line: string }
  /** 09:30 to 10:00: trigger prices only. */
  | { kind: "opening"; line: string }
  /** In the session from 10:00: a state per name. */
  | { kind: "live" };

/** What the board's header says, from the edition's session, the feed and the clock (New York). */
export function boardMode(session: string, halfDay: boolean, feed: FeedStatus, now: number): BoardMode {
  // Until the first answer the clock is the browser's, which may be wrong: say nothing about the day yet.
  if (feed === "loading") return { kind: "loading", line: "Connecting to live prices" };
  const clock = nyClock(new Date(now).toISOString());
  const today = clock?.day ?? null;
  if (today !== null && session < today) return { kind: "old", line: `Focus card is for ${weekDate(session)}: refreshed after ${REFRESH_SYDNEY} Sydney` };
  if (feed === "off" || feed === "error") return { kind: "off", line: "Live prices off: use the plans below" };
  const first = `first entries from ${hhmm(FIRST_ENTRY_MIN)} New York`;
  if (today === null || session > today) return { kind: "next", line: `Next session ${weekDate(session)}: ${first}` };
  const m = clock!.minutes;
  if (m < OPEN_MIN) return { kind: "next", line: `Next session today, opens ${hhmm(OPEN_MIN)}: ${first}` };
  if (m >= closeMinute(halfDay)) return { kind: "next", line: `Session closed: the next focus card follows after ${REFRESH_SYDNEY} Sydney` };
  if (m < FIRST_ENTRY_MIN) return { kind: "opening", line: `Opening range forming: ${first}` };
  return { kind: "live" };
}

// ---- the rows -------------------------------------------------------------------------------------------------------
export interface BoardRow {
  symbol: string;
  /** The focus card's rank. */
  focusRank: number;
  price: number | null;
  /** The live state; null outside the live mode, where the row shows its trigger prices only. */
  state: NameState | null;
  /** "Calls above 752.86 · Puts below 748.39": the trigger prices. */
  triggers: string;
  /** The runner line for an entry, testing. */
  runner: string | null;
}

/** The two trigger prices of a focus name, in words. */
export function triggerLine(plan: { call: SidePlan | null; put: SidePlan | null }): string {
  const parts = [plan.call ? `Calls above ${p2(plan.call.level)}` : null, plan.put ? `Puts below ${p2(plan.put.level)}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No trigger levels on the card";
}

/** The second exit plan beside the current one, under test (the board tags it): half at target 1, the rest trailed. */
export function runnerLine(plan: SidePlan | null, halfDay: boolean): string | null {
  if (!plan || plan.target1 === null || plan.entry === null) return null;
  const to = plan.target2 ? p2(plan.target2.price) : "the next level";
  return `Sell half at ${p2(plan.target1)}, stop to ${p2(plan.entry)}, trail the rest under the 2-min EMA9 to ${to} or ${hhmm(flatMinute(halfDay))}. Needs 2 contracts within your $${RISK_PER_TRADE} risk; otherwise skip.`;
}

export interface BoardInput {
  session: string;
  halfDay: boolean;
  items: readonly Item[];
  tickers: readonly OptionsTicker[];
  quotes: Readonly<Record<string, LiveQuote>>;
  trails: Readonly<Record<string, readonly TrailPoint[]>>;
  /** The server's session bars per name (`/api/bars`); the completed ones are used. */
  serverBars: Readonly<Record<string, readonly Bar2[]>>;
  /** The feed's (server) clock (trade-state's serverNow), ms. */
  now: number;
  /** The feed's last answer on the same clock (its `as_of`). */
  receivedAt: number | null;
  dayLimitUsed: boolean;
  wonToday: boolean | null;
}

const NO_TICKER: Pick<OptionsTicker, "levels" | "bars" | "expected_move"> = { levels: [], bars: [], expected_move: null };

/**
 * One row per focus name. In the live mode each row carries its state, and the rows are ordered by how close each
 * name is to an action (the state's rank), then by the card's rank; otherwise they keep the card's order.
 */
export function boardRows(input: BoardInput, live: boolean): BoardRow[] {
  const now = new Date(input.now);
  const rows = [...input.items]
    .sort((a, b) => a.rank - b.rank)
    .map((item): BoardRow => {
      const plan = focusPlan(item);
      const quote = input.quotes[item.symbol] ?? null;
      const triggers = triggerLine(plan);
      const price = quote && quote.day === input.session ? quote.price : null;
      if (!live) return { symbol: item.symbol, focusRank: item.rank, price, state: null, triggers, runner: null };
      const trail = bars2m(input.trails[item.symbol] ?? [], quote, now, input.halfDay, input.session);
      const serverClosed = (input.serverBars[item.symbol] ?? []).filter((b) => b.end <= input.now);
      const bars = mergeBars(serverClosed, trail);
      const lead = LEADERS[item.symbol];
      const state = nameState({
        symbol: item.symbol,
        session: input.session,
        call: plan.call,
        put: plan.put,
        atr: item.atr,
        sweepAtr: atr2m(bars.closed, 14),
        ticker: input.tickers.find((t) => t.symbol === item.symbol) ?? NO_TICKER,
        bars,
        quote,
        leaderQuote: lead ? (input.quotes[lead] ?? null) : null,
        receivedAt: input.receivedAt,
        now,
        halfDay: input.halfDay,
        dayLimitUsed: input.dayLimitUsed,
        wonToday: input.wonToday,
      });
      const runner = state.state === "enter_zone" && state.side ? runnerLine(plan[state.side], input.halfDay) : null;
      return { symbol: item.symbol, focusRank: item.rank, price, state, triggers, runner };
    });
  return live ? rows.sort((a, b) => a.state!.rank - b.state!.rank || a.focusRank - b.focusRank) : rows;
}

// ---- notices --------------------------------------------------------------------------------------------------------
export interface SeenStates {
  session: string;
  keys: ReadonlySet<string>;
}

/** The rows worth a notice: an entry zone, or a plan off with a live alternative trigger. Keyed so each is told once. */
export function noticeKey(s: NameState): string | null {
  if (s.state === "enter_zone") return `${s.symbol}|enter_zone|${s.side ?? ""}|${s.plan?.level ?? ""}`;
  if (s.state === "plan_off" && s.alt) return `${s.symbol}|plan_off|${s.alt.kind}|${s.alt.side}|${s.alt.level}`;
  return null;
}

/**
 * What to announce as states reach the board, like the rule notices (triggers.announce): the first states seen for a
 * session announce nothing, since they were there when the page opened. After that each notice key not seen before is
 * announced once. `seen` comes back as the same object when nothing is new.
 */
export function boardAnnounce(seen: SeenStates | null, session: string, states: readonly NameState[]): { seen: SeenStates; fresh: NameState[] } {
  const keyed = states.map((s) => [noticeKey(s), s] as const).filter((x): x is readonly [string, NameState] => x[0] !== null);
  if (seen === null || seen.session !== session) return { seen: { session, keys: new Set(keyed.map(([k]) => k)) }, fresh: [] };
  const fresh = keyed.filter(([k]) => !seen.keys.has(k));
  if (fresh.length === 0) return { seen, fresh: [] };
  return { seen: { session, keys: new Set([...seen.keys, ...fresh.map(([k]) => k)]) }, fresh: fresh.map(([, s]) => s) };
}

/** A notice's title: "QQQ: ENTER ZONE, call", or "SPY: FAILED BREAK, put" (the alternative, under test). */
export function noticeTitle(s: NameState): string {
  const v = rowView(s);
  return `${s.symbol}: ${v.badge.word}${v.badge.side ? `, ${v.badge.side}` : ""}`;
}

// ---- how a row reads ------------------------------------------------------------------------------------------------
export interface RowView {
  badge: { word: string; tone: Tone; side: Side | null; alt: AltTrigger["kind"] | null };
  /** The row is an idea still under test: the board adds its Testing tag. */
  testing: boolean;
  /** One sentence, sentence case, with no "testing" in it. */
  headline: string;
  /** Entry, stop and first target, formatted, for an entry or a live alternative. */
  grid: { enter: string; stop: string; target: string | null } | null;
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const stopShare = `−${Math.round(PREMIUM_STOP * 100)}%`;

/** The alternative's idea in words: "Put under 779.40, stop above 780.00 (push high)". */
function altIdea(a: AltTrigger): string {
  const put = a.side === "put";
  if (a.kind === "failed_break") return `${cap(a.side)} ${put ? "under" : "over"} ${p2(a.level)}, stop ${put ? "above" : "below"} ${p2(a.stop)} (push ${put ? "high" : "low"})`;
  return `${cap(a.side)} ${put ? "below" : "above"} ${p2(a.level)}, stop ${put ? "above" : "below"} ${p2(a.stop)} (sweep ${put ? "high" : "low"})`;
}

/**
 * What a row shows, from its state. An entry gets a short headline and the plan's numbers; a side whose plan went
 * off (or a watching side) with a live alternative trigger is shown as that alternative, under test, with its own
 * numbers; every other state reads the engine's sentence. "Testing" is never written into a sentence: it is a tag.
 */
export function rowView(s: NameState): RowView {
  const badge = (word: string, tone: Tone, side: Side | null = null, alt: AltTrigger["kind"] | null = null) => ({ word, tone, side, alt });
  const plain = s.line.replace(/\s*·\s*testing\b/gi, "");
  if (s.state === "paused") return { badge: badge(STATE_WORD.paused, "neutral"), testing: false, headline: plain, grid: null };
  if (s.state === "enter_zone" && s.side && s.plan) {
    const p = s.plan;
    return {
      badge: badge(STATE_WORD.enter_zone, "good", s.side),
      testing: false,
      headline: `Retest holding ${p.level !== null ? p2(p.level) : "the level"}: ${s.side} setup ready`,
      grid: { enter: p.entry !== null ? `~${p2(p.entry)}` : "–", stop: p.stop !== null ? `${p2(p.stop)} or ${stopShare}` : stopShare, target: p.target1 !== null ? p2(p.target1) : null },
    };
  }
  const a = s.alt;
  if (a && (s.state === "plan_off" || s.state === "watch" || s.state === "missed")) {
    const dir = a.side === "call" ? 1 : -1;
    const target = a.entry + dir * MIN_ROOM_MULTIPLE * Math.abs(a.entry - a.stop);
    const lead =
      s.state === "plan_off" && s.side && s.plan?.level != null
        ? `${cap(s.side)} plan off at ${p2(s.plan.level)}.`
        : `${a.kind === "failed_break" ? "Failed break" : "Sweep and reclaim"} at ${p2(a.level)}.`;
    return {
      badge: badge(a.kind === "failed_break" ? "FAILED BREAK" : "SWEEP", "warn", a.side, a.kind),
      testing: true,
      headline: `${lead} ${altIdea(a)}.`,
      grid: { enter: `~${p2(a.entry)}`, stop: `${p2(a.stop)} or ${stopShare}`, target: p2(target) },
    };
  }
  const side = s.side && s.state !== "watch" && s.state !== "no_trade" ? s.side : null;
  return { badge: badge(STATE_WORD[s.state], s.tone, side), testing: false, headline: plain, grid: null };
}

// ---- the day, from the journal --------------------------------------------------------------------------------------
/**
 * The day's limits for the board, from the owner's journal: rules 7 and 8 (the day's loss limit and the trade cap)
 * used, and whether a trade has closed green today. `wonToday` is null when the journal is missing or not current.
 */
export function boardDay(doc: JournalDoc | null, now: Date): { dayLimitUsed: boolean; wonToday: boolean | null } {
  if (!doc) return { dayLimitUsed: false, wonToday: null };
  const view = sessionView(doc, now);
  const c = dayCheck(view, { asOf: doc.as_of ?? null, now });
  const dayLimitUsed = c.isToday && (c.net <= -DAY_LOSS_LIMIT || c.used >= MAX_TRADES_PER_DAY);
  if (!c.current) return { dayLimitUsed, wonToday: null };
  return { dayLimitUsed, wonToday: !!view?.isToday && view.trades.some((t) => t.pnl > 0) };
}
