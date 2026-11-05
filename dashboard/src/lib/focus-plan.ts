// A focus name's levels turned into a plan in plain words: a call if it breaks up, a put if it breaks down, each with
// where to enter, where it is wrong and where to take profit, and the short level codes written out.
// Pure: no I/O. The same arithmetic prints the thread's focus card (skills/options-levels/scripts/focus.py card).
import { NEW_YORK, SYDNEY } from "./format";
import type { Options, OptionsTicker } from "./options";
import { MAX_PREMIUM, MIN_ROOM_MULTIPLE } from "./trade-rules";

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
  ATH: "all-time high",
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
      "a 2-minute candle closes past the level, then the next dip (or bounce) stays on the right side of it",
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

/** The UTC instant of a New York wall time on a day. */
function nyInstant(ymd: string, hh: number, mm: number): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh, mm);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: NEW_YORK,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
  );
  return new Date(guess - (wall - guess));
}

const sydClock = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: SYDNEY,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

/** The no-entry times in Sydney for a session: the first 5 minutes, and 11:30 to 13:00 New York. Null for a bad day. */
export function noEntryTimes(
  session: string | null | undefined,
): { firstEntry: string; lunchFrom: string; lunchTo: string } | null {
  if (!session || !/^\d{4}-\d{2}-\d{2}$/.test(session)) return null;
  return {
    firstEntry: sydClock(nyInstant(session, 9, 35)),
    lunchFrom: sydClock(nyInstant(session, 11, 30)),
    lunchTo: sydClock(nyInstant(session, 13, 0)),
  };
}
