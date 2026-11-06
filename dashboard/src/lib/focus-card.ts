// The focus card's small decisions, kept pure so a test can read them without a browser: which side's strip the board
// points at, what a strip says about the live distance to its trigger, when an alternative chip lights up, and the
// rules that hold for every name, as short chips with their New York times.
// Read only: nothing here is an order.
import { altTriggers, focusPlan, noEntryTimes, type AltCondition } from "./focus-plan";
import type { LadderLiveView } from "./level-ladder";
import type { RowView } from "./trade-now";
import { MAX_PREMIUM, MAX_TRADES_PER_DAY, PREMIUM_STOP, RISK_PER_TRADE, TIME_STOP_MINUTES } from "./trade-rules";

export type CardSide = "call" | "put";

/** What the page's board says about one name, as the card reads it (client/trade-now's useBoardRow, structurally). */
export type CardBoardRead = { view: RowView | null; paused: boolean } | null;

/**
 * How a side's strip is drawn: "on" when the board points at it, "off" when the board points at the other side, and
 * "none" when the board points at neither (both strips drawn alike).
 */
export function stripEmphasis(side: CardSide, pointed: CardSide | null): "on" | "off" | "none" {
  if (!pointed) return "none";
  return pointed === side ? "on" : "off";
}

export interface StripDistance {
  /** "1.18 away", or "+0.4 ATR past" once the price is through the trigger. */
  away: string;
  /** "0.2× move" (or "0.2 ATR"), when the ladder knows the move; null otherwise. */
  move: string | null;
  /** The price is through the trigger. */
  past: boolean;
  /** Measured from a live price, or from the pre-market price before the open. */
  from: "live" | "pre";
  /** This trigger is the nearer of the two. */
  near: boolean;
}

/**
 * The distance a side's strip shows, from the ladder's live view: the call to the ceiling, the put to the floor. Null
 * whenever the view has no distance (prices off, paused, connecting, after the close): never a stale number.
 */
export function stripDistance(view: LadderLiveView, side: CardSide): StripDistance | null {
  if (!view.from) return null;
  const d = view.distances.find((x) => x.to === (side === "call" ? "ceiling" : "floor"));
  if (!d) return null;
  const [away = d.text, ...rest] = d.text.split(" · ");
  return { away, move: rest.length ? rest.join(" · ") : null, past: d.text.endsWith(" past"), from: view.from, near: d.near };
}

/** An alternative chip lights up only while the board shows that very alternative live, and never while paused. */
export function altIsLive(r: CardBoardRead, kind: AltCondition["kind"], side: CardSide): boolean {
  return !!r && !r.paused && !!r.view && r.view.badge.alt === kind && r.view.badge.side === side;
}

export const ALT_WORD: Record<AltCondition["kind"], string> = {
  failed_break: "Failed break",
  sweep_reclaim: "Sweep",
};

export interface AltChip {
  kind: AltCondition["kind"];
  side: CardSide;
  level: number;
  /** "Failed break · put", the price shown beside it. */
  word: string;
  /** The full sentence, behind a fold or a title only. */
  line: string;
}

/** The four alternative triggers of a focus name as chips (none without the plan's ATR). */
export function altChips(item: Parameters<typeof focusPlan>[0]): AltChip[] {
  return altTriggers(focusPlan(item), item.atr).map((a) => ({
    kind: a.kind,
    side: a.side,
    level: a.level,
    word: `${ALT_WORD[a.kind]} · ${a.side}`,
    line: a.line,
  }));
}

export interface RuleChip {
  key: "first" | "lunch" | "premium" | "time" | "max";
  /** The rule in a few words, said large. */
  text: string;
  /** Why, in small words beside it, if anything. */
  note: string | null;
}

/**
 * The rules that hold for every name, as chips: "No entries before 09:35", "No entries 11:30–13:00" (not on a half
 * day), "Option under $2.00", "Out after 5 min", "Max 5 a day". New York times, from the board's own constants; the
 * time chips are left out for a session that is not a day.
 */
export function ruleChips(session: string | null | undefined, halfDay: boolean): RuleChip[] {
  const t = noEntryTimes(session, halfDay);
  const out: RuleChip[] = [];
  if (t) out.push({ key: "first", text: `No entries before ${t.firstEntry}`, note: null });
  if (t?.lunchFrom && t.lunchTo) out.push({ key: "lunch", text: `No entries ${t.lunchFrom}–${t.lunchTo}`, note: null });
  out.push({
    key: "premium",
    text: `Option under $${(MAX_PREMIUM / 100).toFixed(2)}`,
    note: `the −${Math.round(PREMIUM_STOP * 100)}% stop loses at most $${RISK_PER_TRADE}`,
  });
  out.push({ key: "time", text: `Out after ${TIME_STOP_MINUTES} min`, note: "if it isn't working" });
  out.push({ key: "max", text: `Max ${MAX_TRADES_PER_DAY} a day`, note: null });
  return out;
}
