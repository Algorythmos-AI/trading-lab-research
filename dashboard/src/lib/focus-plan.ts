// A focus name's levels turned into a plan in plain words: a call if it breaks up, a put if it breaks down, each with
// where to enter, where it is wrong and where to take profit, and the short level codes written out.
// Pure: no I/O. The same arithmetic prints the thread's focus card (skills/options-levels/scripts/focus.py card).
import { BAR_MINUTES, FAIL_WITHIN_BARS, SWEEP_MIN_ATR } from "./entry-checks";
import type { Options, OptionsTicker } from "./options";
import { MAX_PREMIUM, MIN_ROOM_MULTIPLE } from "./trade-rules";
import { FIRST_ENTRY_MIN, LUNCH_FROM_MIN, LUNCH_TO_MIN, lunchBlock } from "./trade-state";

type Item = NonNullable<Options["focus"]>["items"][number];

/** What each level code means, in the words used on the card. */
export const LEVEL_WORDS: Record<string, string> = {
  PDH: "yesterday's high",
  PDL: "yesterday's low",
  PDC: "yesterday's close",
  PWH: "last week's high",
  PWL: "last week's low",
  PMH: "last month's high",
  PML: "last month's low",
  WTDH: "this week's high so far",
  WTDL: "this week's low so far",
  MA20: "20-day average price",
  MA50: "50-day average price",
  MA200: "200-day average price",
  "52WH": "one-year high",
  "52WL": "one-year low",
  DEMAND: "buying zone",
  SUPPLY: "selling zone",
  // The pre-market high and low: PMKH / PMKL, never PMH / PML (those are last month's).
  PMKH: "pre-market high",
  PMKL: "pre-market low",
  // The research level codes of DEC-0041. The clone logs them beside its decisions; none is a level it trades at.
  ONH: "overnight high",
  ONL: "overnight low",
  SWH: "five-day high",
  SWL: "five-day low",
  EVH: "last big-news day's high",
  EVL: "last big-news day's low",
  GAPH: "top of today's gap",
  GAPL: "bottom of today's gap",
  ATH: "14-month high",
};

/** The glossary under the cards, in reading order. */
export const GLOSSARY: { code: string; words: string }[] = [
  { code: "PDH / PDL", words: "yesterday's high / low" },
  { code: "PWH / PWL", words: "last week's high / low" },
  { code: "PMH / PML", words: "last month's high / low" },
  { code: "WTDH / WTDL", words: "this week's high / low so far" },
  {
    code: "MA20 / MA50 / MA200",
    words: "the average closing price over 20 / 50 / 200 days",
  },
  { code: "52WH", words: "the highest price in a year" },
  {
    code: "DEMAND / SUPPLY",
    words: "a price zone where buyers / sellers stepped in before",
  },
  {
    code: "Break and hold",
    words:
      "a 2-minute candle closes past the level, the next dip (or bounce) comes back near it and stays on the right side, then a 2-minute close beyond that dip's close confirms the retest",
  },
];

/** "PDL/WTDL" -> "yesterday's low, this week's low so far". Unknown codes stay as they are. */
export function levelWords(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .split("/")
    .map((c) => LEVEL_WORDS[c.trim()] ?? c.trim())
    .join(", ");
}

/** Entry this share of the day's range (ATR) past the level: a limit just through it, not a chase. */
export const ENTRY_ATR = 0.01;
/** Wrong once a 2-minute candle closes this share of the ATR back on the other side of the level. */
export const STOP_ATR = 0.1;

export interface SidePlan {
  side: "call" | "put";
  level: number;
  levelName: string;
  entry: number | null;
  stop: number | null;
  /** The first target: twice the distance to the stop (the 2:1 rule). */
  target1: number | null;
  /** The next named level past the first target, if any. */
  target2: { price: number; name: string } | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function side(
  kind: "call" | "put",
  level: number | null | undefined,
  name: string,
  atr: number | null | undefined,
  next: Item["target_up"],
): SidePlan | null {
  if (level == null) return null;
  const dir = kind === "call" ? 1 : -1;
  const a = atr && atr > 0 ? atr : null;
  const entry = a ? r2(level + dir * ENTRY_ATR * a) : null;
  const stop = a ? r2(level - dir * STOP_ATR * a) : null;
  const target1 =
    entry != null && stop != null
      ? r2(entry + dir * MIN_ROOM_MULTIPLE * Math.abs(entry - stop))
      : null;
  const beyond = (p: number) =>
    target1 == null ? true : dir * (p - target1) > 0;
  const target2 =
    next && beyond(next.price)
      ? { price: next.price, name: next.name ?? "" }
      : null;
  return { side: kind, level, levelName: name, entry, stop, target1, target2 };
}

/** The call plan (break up) and the put plan (break down) for one focus name; either is null without its level. */
export function focusPlan(item: Item): {
  call: SidePlan | null;
  put: SidePlan | null;
} {
  return {
    call: side(
      "call",
      item.breakout_above ?? item.resistance?.price,
      item.resistance?.name ?? "",
      item.atr,
      item.target_up,
    ),
    put: side(
      "put",
      item.hold_above ?? item.support?.price,
      item.support?.name ?? "",
      item.atr,
      item.target_down,
    ),
  };
}

// ---- Also watch: the other triggers under test ------------------------------------------------------------------
/** A trigger the card's plan does not take, described as a condition: the board shows it live once it has printed. */
export interface AltCondition {
  kind: "failed_break" | "sweep_reclaim";
  /** The side it would be: a put at the ceiling, a call at the floor. */
  side: "call" | "put";
  level: number;
  /** One line, plain words, prices to 2 decimals. */
  line: string;
}

/**
 * The other triggers at a focus name's levels, as conditions in plain words, with the engine's own numbers
 * (FAIL_WITHIN_BARS, SWEEP_MIN_ATR). The engine (trade-state's altAt) reads both patterns at both levels, each on the
 * side opposite to the plan there, so there are four, in this order: a failed break above the ceiling (a put) and below
 * the floor (a call), then a sweep above the ceiling (a put) and below the floor (a call). As altAt reads them:
 * - failed break: a 2-minute close beyond the level (the close before not beyond it), then within FAIL_WITHIN_BARS
 *   bars the first close back inside it; the stop is past the push's extreme;
 * - sweep: a bar that reaches at least SWEEP_MIN_ATR 2-minute ATRs past the level and closes at it or back inside; the
 *   stop is past that bar's extreme.
 * Static: the board reads them live. None without the plan's ATR: the board never shows one live without it.
 */
export function altTriggers(plan: { call: SidePlan | null; put: SidePlan | null }, atr: number | null | undefined): AltCondition[] {
  if (!(typeof atr === "number" && Number.isFinite(atr) && atr > 0)) return [];
  const out: AltCondition[] = [];
  const mins = FAIL_WITHIN_BARS * BAR_MINUTES;
  const ceiling = plan.call ? { level: plan.call.level, L: plan.call.level.toFixed(2) } : null;
  const floor = plan.put ? { level: plan.put.level, L: plan.put.level.toFixed(2) } : null;
  if (ceiling)
    out.push({
      kind: "failed_break",
      side: "put",
      level: ceiling.level,
      line: `Failed break: if it closes above ${ceiling.L} and back below within ${FAIL_WITHIN_BARS} bars (${mins} min), a put under ${ceiling.L}, stop above the push high`,
    });
  if (floor)
    out.push({
      kind: "failed_break",
      side: "call",
      level: floor.level,
      line: `Failed break: if it closes below ${floor.L} and back above within ${FAIL_WITHIN_BARS} bars (${mins} min), a call above ${floor.L}, stop below the push low`,
    });
  if (ceiling)
    out.push({
      kind: "sweep_reclaim",
      side: "put",
      level: ceiling.level,
      line: `Sweep: if it rises at least ${SWEEP_MIN_ATR} × the ${BAR_MINUTES}-min ATR over ${ceiling.L} and closes back at or below it, a put under ${ceiling.L}, stop above the sweep high`,
    });
  if (floor)
    out.push({
      kind: "sweep_reclaim",
      side: "call",
      level: floor.level,
      line: `Sweep: if it drops at least ${SWEEP_MIN_ATR} × the ${BAR_MINUTES}-min ATR under ${floor.L} and closes back at or above it, a call above ${floor.L}, stop below the sweep low`,
    });
  return out;
}

// ---- The lines to draw on the chart --------------------------------------------------------------------------------
// The owner draws each focus name's levels on the broker's chart beside this page, in one fixed colour code that is the
// same on every name and every day. The card lists those lines, at most six, highest price first like a chart's axis.

type Level = NonNullable<OptionsTicker["levels"]>[number];

/** The kinds of line, each with one colour and one line style. */
export type LineKind = "ceiling" | "floor" | "week" | "month" | "target";

export interface ChartLine {
  price: number;
  kind: LineKind;
  /** The level codes at this price, e.g. ["PML", "PWL"]: written out with levelWords. */
  codes: string[];
  /** The card's targets that fall on this line, e.g. ["call target 1"]. */
  targets: string[];
}

/** At most this many lines a chart: more and the ones that matter today stop standing out. The grey box is not one. */
export const CHART_LINES_MAX = 6;
/** A week or month level further than this many ATRs past the ceiling or floor is too far away to draw today. */
export const REACH_ATR = 3;
/** Levels this share of the ATR apart (or the same cent) are one line on the chart. */
export const MERGE_ATR = 0.02;

/** The level codes drawn as their own lines. PMH / PML are last month's, never pre-market. */
const STRUCTURAL: Record<string, LineKind> = {
  PWH: "week",
  PWL: "week",
  WTDH: "week",
  WTDL: "week",
  PMH: "month",
  PML: "month",
  "52WH": "month",
  // DEC-0041's longer-range research codes, in the colour of their timeframe if an edition ever carries them.
  SWH: "week",
  SWL: "week",
  ATH: "month",
};

/** The owner's colour code, in the words the card and the legend use. */
export const CHART_CODE: Record<
  LineKind,
  { colour: string; line: string; what: string }
> = {
  ceiling: { colour: "Red", line: "solid, thick", what: "Ceiling" },
  floor: { colour: "Green", line: "solid, thick", what: "Floor" },
  week: { colour: "Blue", line: "dashed", what: "Week high / low" },
  month: {
    colour: "Purple",
    line: "dashed",
    what: "Month high / low, one-year high",
  },
  target: { colour: "Grey", line: "thin, dotted", what: "Target" },
};

/** When two candidates share a line, the one that names it: the triggers first, then the bigger timeframe. */
const RANK: Record<LineKind, number> = {
  ceiling: 0,
  floor: 0,
  month: 1,
  week: 2,
  target: 3,
};

interface Candidate extends ChartLine {
  priority: number;
}

const codesOf = (name: string | null | undefined) =>
  name
    ? name
        .split("/")
        .map((c) => c.trim())
        .filter(Boolean)
    : [];
const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * The lines to draw for one focus name: the ceiling and floor, both first targets, and the nearest week or month level
 * past each trigger, then the rest by distance, cut to `max`. Levels at the same price become one line (the ceiling or
 * floor wins it). Week and month levels inside the no-trade box are left off: the box already covers them.
 */
export function chartLevels(
  item: Item,
  levels: readonly Level[] | null | undefined,
  max = CHART_LINES_MAX,
): ChartLine[] {
  const { call, put } = focusPlan(item);
  if (!call && !put) return [];
  const out: Candidate[] = [];
  const add = (
    price: number,
    kind: LineKind,
    codes: string[],
    targets: string[],
    priority: number,
  ) => out.push({ price, kind, codes, targets, priority });
  if (call) add(call.level, "ceiling", codesOf(call.levelName), [], 0);
  if (put) add(put.level, "floor", codesOf(put.levelName), [], 0);
  for (const p of [call, put]) {
    if (!p) continue;
    if (p.target1 != null)
      add(p.target1, "target", [], [`${p.side} target 1`], 1);
    if (p.target2)
      add(
        p.target2.price,
        "target",
        codesOf(p.target2.name),
        [`${p.side} target 2`],
        3,
      );
  }
  const top = call?.level ?? put!.level;
  const bottom = put?.level ?? call!.level;
  const atr = item.atr && item.atr > 0 ? item.atr : null;
  const reach = atr ? REACH_ATR * atr : Infinity;
  const structural = (levels ?? [])
    .filter((l) => STRUCTURAL[l.name] && Number.isFinite(l.price))
    .filter((l) => !(top > bottom && l.price < top && l.price > bottom))
    .filter((l) =>
      l.price >= top ? l.price - top <= reach : bottom - l.price <= reach,
    );
  const above = structural
    .filter((l) => l.price >= top)
    .sort((a, b) => a.price - b.price);
  const below = structural
    .filter((l) => l.price <= bottom)
    .sort((a, b) => b.price - a.price);
  for (const l of structural)
    add(
      l.price,
      STRUCTURAL[l.name]!,
      [l.name],
      [],
      l === above[0] || l === below[0] ? 2 : 4,
    );

  // One line per price: candidates within the merge distance join the line that names it.
  const tol = Math.max(0.005, atr ? MERGE_ATR * atr : 0);
  const lines: Candidate[] = [];
  for (const c of [...out].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || a.priority - b.priority,
  )) {
    const same = lines.find((l) => Math.abs(l.price - c.price) <= tol);
    if (same) {
      same.codes = uniq([...same.codes, ...c.codes]);
      same.targets = uniq([...same.targets, ...c.targets]);
      same.priority = Math.min(same.priority, c.priority);
    } else lines.push({ ...c, codes: [...c.codes], targets: [...c.targets] });
  }
  const dist = (p: number) =>
    p >= top ? p - top : p <= bottom ? bottom - p : 0;
  return lines
    .sort((a, b) => a.priority - b.priority || dist(a.price) - dist(b.price))
    .slice(0, max)
    .sort((a, b) => b.price - a.price)
    .map(({ price, kind, codes, targets }) => ({
      price,
      kind,
      codes,
      targets,
    }));
}

/** One of the focus card's two triggers, as a map marks it: the card's own price, colour and word. */
export interface CardMark {
  price: number;
  kind: "ceiling" | "floor";
  /** The card's word for it: "Ceiling" or "Floor" (CHART_CODE). */
  word: string;
}

/**
 * The focus card's ceiling and floor for a name, highest first: the plan's own trigger levels (focusPlan), the same
 * prices the card's steps and the board's triggers use, so every map that marks them shows the card's price, in the
 * card's red and green, under the card's word. Never a merged chart line: two triggers a cent apart are two marks.
 */
export function cardMarks(item: Item): CardMark[] {
  const { call, put } = focusPlan(item);
  const out: CardMark[] = [];
  if (call) out.push({ price: call.level, kind: "ceiling", word: CHART_CODE.ceiling.what });
  if (put) out.push({ price: put.level, kind: "floor", word: CHART_CODE.floor.what });
  return out.sort((a, b) => b.price - a.price);
}

/** Names whose options expire on Monday, Wednesday and Friday only (the broker's listing, checked 2026-10-27). */
export const MWF_ONLY: ReadonlySet<string> = new Set(["AVGO", "AMD"]);

/**
 * The card's expiry warning for a name without a contract every session: null for the others. On a Tuesday or
 * Thursday it says to take the next day's expiry and size down. Its premiums near the money also tend to run over the
 * premium cap (MAX_PREMIUM).
 */
export function expiryNote(
  symbol: string,
  session: string | null | undefined,
): string | null {
  if (!MWF_ONLY.has(symbol) || !session || !/^\d{4}-\d{2}-\d{2}$/.test(session))
    return null;
  const [y, m, d] = session.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  const today =
    day === 1 || day === 3 || day === 5
      ? "Options expire today."
      : "No options expire today: use the next day's expiry and size down.";
  return `${today} Premiums near the money usually run over $${(MAX_PREMIUM / 100).toFixed(2)}, so go further out or skip.`;
}

/** The no-entry lunch window, New York: 11:30 to 13:00 (trade-state's, where the board's gate reads it). */
export { LUNCH_FROM_MIN, LUNCH_TO_MIN };

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * The no-entry times for a session, New York: none before the first entry (FIRST_ENTRY_MIN, 09:35, the owner's rule,
 * DEC-0043) and none from 11:30 to 13:00, which a half day (closing at 13:00) does not have (`lunchBlock`). New York
 * wall times, so the daylight-saving changes move nothing. Null for a bad day.
 */
export function noEntryTimes(
  session: string | null | undefined,
  halfDay = false,
): { firstEntry: string; lunchFrom: string | null; lunchTo: string | null } | null {
  if (!session || !/^\d{4}-\d{2}-\d{2}$/.test(session)) return null;
  const lunch = lunchBlock(halfDay);
  return {
    firstEntry: hhmm(FIRST_ENTRY_MIN),
    lunchFrom: lunch ? hhmm(LUNCH_FROM_MIN) : null,
    lunchTo: lunch ? hhmm(LUNCH_TO_MIN) : null,
  };
}
