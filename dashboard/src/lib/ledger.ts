// The focus card ledger's edition, read for the pages: what each result is called, the day in one sentence, the
// lesson a day teaches, and the running totals. Pure: no I/O, no clock.
import type { Tone } from "./labels";
import type { Day, LedgerEdition, Name, Side } from "./ledger.types";

export type { Day as LedgerDay, LedgerEdition, Name as LedgerName, Side as LedgerSide };

/** A side's result in plain words, and its tone. A result the page does not know is shown as its code. */
export const RESULT: Record<Side["result"], { label: string; tone: Tone }> = {
  target1: { label: "Hit target 1", tone: "good" },
  target2: { label: "Hit target 2", tone: "good" },
  stopped: { label: "Stopped", tone: "bad" },
  time_exit: { label: "5-minute exit", tone: "neutral" },
  session_close: { label: "Held to close", tone: "neutral" },
  no_trigger: { label: "Level not reached", tone: "neutral" },
  no_fill: { label: "Reached, no retest fill", tone: "neutral" },
  failed_before_retest: { label: "Failed before the retest", tone: "neutral" },
  no_bars: { label: "No bars", tone: "warn" },
};

export const BIAS_LABEL: Record<Name["bias"], string> = { support: "Hold support", breakout: "Breakout watch", range: "Range" };

/** Why the option was sold, in words. */
export function optionExit(reason: NonNullable<Side["option"]>["reason"]): string {
  switch (reason) {
    case "option_stop_25pct":
      return "option −25% stop";
    case "target1":
      return "sold at target 1";
    case "target2":
      return "sold at target 2";
    case "stopped":
      return "sold at the stock stop";
    case "time_exit":
      return "sold at 5 minutes";
    case "session_close":
      return "sold at the close";
    default:
      return "no option bars";
  }
}

/** "347.5C" from a strike and its right. */
export function contractLabel(o: NonNullable<Side["option"]>): string {
  return `${Number.isInteger(o.strike) ? o.strike : o.strike.toFixed(1)}${o.right}`;
}

/** Minutes after 09:30 New York of an instant, for placing it on a session chart; null when there is none. */
export function sessionMinute(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h * 60 + m - 570;
}

export const isWin = (s: Side) => s.filled && (s.result === "target1" || s.result === "target2");

/**
 * A stock winner whose option lost: the −25% option stop came before the stock reached its target. The stock
 * numbers alone hide this, so the review names it.
 */
export function optionStoppedFirst(e: LedgerEdition): { symbol: string; side: Side }[] {
  return e.names.flatMap((n) =>
    n.sides.filter((s) => isWin(s) && s.option?.reason === "option_stop_25pct" && (s.option.pnl_usd ?? 0) < 0).map((side) => ({ symbol: n.symbol, side })),
  );
}

/** Running totals of the days, oldest first, for each exit rule. */
export function running(days: readonly Day[]): { session: string; r: number; r5: number }[] {
  let r = 0;
  let r5 = 0;
  return days.map((d) => {
    r += d.r;
    r5 += d.r_five_min;
    return { session: d.session, r: Math.round(r * 100) / 100, r5: Math.round(r5 * 100) / 100 };
  });
}

/** Sum of each day's option dollars where they were kept, and on how many days. */
export function optionTotal(days: readonly Day[]): { usd: number | null; days: number; first: string | null } {
  const kept = days.filter((d) => d.option_usd !== null);
  return {
    usd: kept.length ? Math.round(kept.reduce((a, d) => a + (d.option_usd ?? 0), 0) * 100) / 100 : null,
    days: kept.length,
    first: kept[0]?.session ?? null,
  };
}

/**
 * The weeks around the scored days as Monday-to-Friday rows, oldest first, each cell the session's date and its
 * day when one was scored. Weekends are left out; a weekday with no score is an empty cell (a holiday, or not yet).
 */
export function weekGrid(days: readonly Day[], last = 6): { date: string; day: Day | null }[][] {
  if (days.length === 0) return [];
  const byDate = new Map(days.map((d) => [d.session, d]));
  const toUtc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * 86_400_000;
  const lastWeek = monday(toUtc(days[days.length - 1]!.session));
  const firstWeek = Math.max(monday(toUtc(days[0]!.session)), lastWeek - (last - 1) * 7 * 86_400_000);
  const weeks: { date: string; day: Day | null }[][] = [];
  for (let w = firstWeek; w <= lastWeek; w += 7 * 86_400_000) {
    weeks.push(
      [0, 1, 2, 3, 4].map((i) => {
        const date = new Date(w + i * 86_400_000).toISOString().slice(0, 10);
        return { date, day: byDate.get(date) ?? null };
      }),
    );
  }
  return weeks;
}

/**
 * Whether the Options page shows the last scored day's review. Not while New York's regular session is open: the
 * page is then for trading, and the desk must fit one laptop screen. After the close, overnight and at weekends it
 * does, and only for a card scored before the session the desk's levels are for: the day just gone, not a stale
 * or a later one. Today keeps a one-line link at all times.
 */
export function showReview(now: Date, scored: string, deskSession: string): boolean {
  if (!(scored < deskSession)) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const weekday = !["Sat", "Sun"].includes(get("weekday"));
  return !(weekday && minute >= 570 && minute < 960);
}
