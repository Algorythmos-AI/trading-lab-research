// The "Trade now" board on the Options desk: what it shows at the top, which rows it draws and in what order, and
// what it announces. Advisory and read-only: nothing here places an order, and the 9 rules are unchanged. The states
// themselves come from trade-state.ts; this file only puts them on the board.
//
// Pure: no I/O and no clock. The caller passes `now`.
import { OPTIONS_SLOT_UTC } from "./feeds";
import { newYork, weekDate } from "./format";
import { focusPlan, type SidePlan } from "./focus-plan";
import { sessionView, type JournalDoc } from "./journal";
import { closeMinute, type LiveQuote, nyClock, OPEN_MIN, type Options, type OptionsTicker, type TrailPoint } from "./options";
import { DAY_LOSS_LIMIT, dayCheck, MAX_TRADES_PER_DAY, MIN_ROOM_MULTIPLE, PREMIUM_STOP, RISK_PER_TRADE } from "./trade-rules";
import { type AltTrigger, atr2m, BAR_MINUTES, type Bar2, bars2m, flatMinute, FIRST_ENTRY_MIN, mergeBars, MAX_BARS_TO_RETEST, type NameState, type NameStateName, nameState, SERVER_SETTLE_MS } from "./trade-state";
import { BARS_STALE_MS, type BarsFeed } from "./bars-feed";
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

/**
 * When the next focus card is built: the evening edition, at OPTIONS_SLOT_UTC (21:52 UTC) on the first weekday at or
 * after `nowMs` whose build time has not passed. A US holiday can make it a day later.
 */
export function nextEditionAt(nowMs: number): number {
  const DAY = 86_400_000;
  for (let d = Math.floor(nowMs / DAY) * DAY; ; d += DAY) {
    const dow = new Date(d).getUTCDay();
    const at = d + OPTIONS_SLOT_UTC * 60_000;
    if (dow >= 1 && dow <= 5 && at > nowMs) return at;
  }
}

/** The next focus card in words, in New York time: "the evening edition, Mon 2 Nov, 16:52 New York". */
export function refreshWords(nowMs: number): string {
  return `the evening edition, ${newYork(new Date(nextEditionAt(nowMs)).toISOString())} New York`;
}

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
  /** 09:30 to the first entry (09:35): trigger prices only. */
  | { kind: "opening"; line: string }
  /** In the session from the first entry (09:35): a state per name. */
  | { kind: "live" };

/** What the board's header says, from the edition's session, the feed and the clock (New York). */
export function boardMode(session: string, halfDay: boolean, feed: FeedStatus, now: number): BoardMode {
  // Until the first answer the clock is the browser's, which may be wrong: say nothing about the day yet.
  if (feed === "loading") return { kind: "loading", line: "Connecting to live prices" };
  const clock = nyClock(new Date(now).toISOString());
  const today = clock?.day ?? null;
  if (today !== null && session < today) return { kind: "old", line: `Focus card is for ${weekDate(session)}: refreshed after ${refreshWords(now)}` };
  if (feed === "off" || feed === "error") return { kind: "off", line: "Live prices off: use the plans below" };
  const first = `first entries from ${hhmm(FIRST_ENTRY_MIN)} New York`;
  if (today === null || session > today) return { kind: "next", line: `Next session ${weekDate(session)}: ${first}` };
  const m = clock!.minutes;
  if (m < OPEN_MIN) return { kind: "next", line: `Next session today, opens ${hhmm(OPEN_MIN)}: ${first}` };
  if (m >= closeMinute(halfDay)) return { kind: "next", line: `Session closed: the next focus card follows ${refreshWords(now)}` };
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
  /** The server's session bars per name (`/api/bars`); only those complete when the server read them are used. */
  serverBars: Readonly<Record<string, readonly Bar2[]>>;
  /** When the server read each name's bars (ms, the server's clock); a name without one uses no server bar. */
  serverFetchedAt: Readonly<Record<string, number>>;
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
      // A server bar counts only if it had closed (and its grace passed) when the server read it: a snapshot taken
      // mid-bar is not a close. Where the server has no complete bar, the page's own bar is used.
      const fetchedAt = input.serverFetchedAt[item.symbol] ?? null;
      const serverDone = fetchedAt === null ? [] : (input.serverBars[item.symbol] ?? []).filter((b) => b.end <= fetchedAt - SERVER_SETTLE_MS);
      const bars = mergeBars(serverDone, trail, fetchedAt);
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

/**
 * The rows worth a notice: an entry zone, or a plan off with a live alternative trigger. Keyed so each is told once:
 * an entry by its side, level and break bar (its start), an alternative by the bar that completed it. A new break at
 * the same level later in the session is a new notice.
 */
export function noticeKey(s: NameState): string | null {
  if (s.state === "enter_zone") {
    const brokeAt = s.side ? s[s.side].brokeAt : null;
    const breakStart = brokeAt === null ? "" : brokeAt - BAR_MINUTES * 60_000;
    return `${s.symbol}|enter_zone|${s.side ?? ""}|${s.plan?.level ?? ""}|${breakStart}`;
  }
  if (s.state === "plan_off" && s.alt) return `${s.symbol}|plan_off|${s.alt.kind}|${s.alt.side}|${s.alt.level}|${s.alt.at}`;
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

/** The notices on screen, and what has been told this session. */
export interface NoticeBook {
  seen: SeenStates | null;
  kept: readonly NameState[];
  /** When each notice family (a name, side and level, without the bar) was last told (ms, the board's clock). */
  told?: ReadonlyMap<string, number>;
  /** When each kept notice's state was first missing from the board (ms): it is withdrawn only after WITHDRAW_AFTER_MS. */
  gone?: ReadonlyMap<string, number>;
}

/**
 * A kept notice is withdrawn only once its state has been off the board this long: a single render without it (one
 * failed bars poll, a brief price pause, the bar source switching) must not take a live entry's notice away.
 */
export const WITHDRAW_AFTER_MS = 30_000;
/**
 * The same name, side and level is told again only after this long: a break bar that shifts by a slot when the bars
 * switch between the server's and the page's own is the same entry, not a new one. The retest window (the clone's
 * max_bars_to_retest, 6 bars after the break bar: 14 minutes), so a genuinely new break later is still told.
 */
export const RETELL_AFTER_MS = (MAX_BARS_TO_RETEST + 1) * BAR_MINUTES * 60_000;

/** A notice key without its bar: the same name, side and level. */
const family = (key: string) => key.split("|").slice(0, -1).join("|");

/**
 * One step of the notices as states reach the board: announce what is new (boardAnnounce), keep it in front of the
 * older notices (one per name), and withdraw every kept notice whose state is no longer on the board, for good: its
 * key stays told, so the old notice can never come back with an old state. `book` comes back as the same object
 * when nothing changed.
 */
export function boardNotices(book: NoticeBook, session: string, states: readonly NameState[], now?: number): { book: NoticeBook; fresh: NameState[] } {
  const next = boardAnnounce(book.seen, session, states);
  const live = new Set(states.map(noticeKey).filter((k): k is string => k !== null));
  // Without a clock (the older callers), every new key is told and a missing state is withdrawn at once.
  const timed = typeof now === "number" && Number.isFinite(now);
  const told = new Map(book.seen?.session === session ? (book.told ?? []) : []);
  const fresh = timed
    ? next.fresh.filter((f) => {
        const fam = family(noticeKey(f) ?? "");
        const last = told.get(fam);
        return last === undefined || now - last >= RETELL_AFTER_MS;
      })
    : next.fresh;
  if (timed) for (const f of fresh) told.set(family(noticeKey(f) ?? ""), now);
  // Shown: the newly told in front, then the older ones (one per name). A re-keyed entry inside the retell window
  // replaces its old notice quietly, so the notice follows the live state without ringing again.
  const shownNew = next.fresh;
  const merged = shownNew.length ? [...shownNew, ...book.kept.filter((k) => !shownNew.some((f) => f.symbol === k.symbol))] : book.kept;
  const gone = new Map(book.gone ?? []);
  const kept = merged.filter((k) => {
    const key = noticeKey(k) ?? "";
    if (live.has(key)) {
      gone.delete(key);
      return true;
    }
    if (!timed) return false;
    const since = gone.get(key) ?? now;
    gone.set(key, since);
    return now - since < WITHDRAW_AFTER_MS;
  });
  for (const key of [...gone.keys()]) if (!kept.some((k) => noticeKey(k) === key)) gone.delete(key);
  const keptSame = kept.length === book.kept.length && kept.every((k, i) => k === book.kept[i]);
  const goneSame = gone.size === (book.gone?.size ?? 0) && [...gone].every(([k, v]) => book.gone?.get(k) === v);
  const toldSame = told.size === (book.told?.size ?? 0) && [...told].every(([k, v]) => book.told?.get(k) === v);
  if (next.seen === book.seen && keptSame && goneSame && toldSame) return { book, fresh: [] };
  return { book: { seen: next.seen, kept: keptSame ? book.kept : kept, told, gone }, fresh };
}

/**
 * Which of the server's bars the board may use, from the bars feed and the browser's clock: all of them while the
 * last poll succeeded within BARS_STALE_MS; none once it is older or a poll has failed, and then the board says the
 * session bars are delayed (`delayed`), and every state reads the page's own prices only: the engine then judges
 * a break from what this page saw, and a slot it lacks around the break is a gap (no entry). None, quietly, while
 * loading or not configured.
 */
export function barsInUse(feed: BarsFeed, browserNow: number | null): { bars: Record<string, Bar2[]>; fetchedAt: Record<string, number>; delayed: boolean } {
  if (feed.status === "ok" && !feed.failed && browserNow !== null && browserNow - feed.receivedAt <= BARS_STALE_MS)
    return { bars: feed.bars, fetchedAt: feed.fetchedAt, delayed: false };
  return { bars: {}, fetchedAt: {}, delayed: feed.status === "ok" || feed.status === "error" };
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
