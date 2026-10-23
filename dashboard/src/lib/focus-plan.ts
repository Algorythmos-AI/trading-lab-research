// A focus name's levels turned into a plan in plain words: a call if it breaks up, a put if it breaks down, each with
// where to enter, where it is wrong and where to take profit, and the short level codes written out.
// Pure: no I/O. The same arithmetic prints the thread's focus card (skills/options-levels/scripts/focus.py card).
import { NEW_YORK, SYDNEY } from "./format";
import type { Options } from "./options";
import { MIN_ROOM_MULTIPLE } from "./trade-rules";

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
};

/** The glossary under the cards, in reading order. */
export const GLOSSARY: { code: string; words: string }[] = [
  { code: "PDH / PDL", words: "yesterday's high / low" },
  { code: "PWH / PWL", words: "last week's high / low" },
  { code: "PMH / PML", words: "last month's high / low" },
  { code: "WTDH / WTDL", words: "this week's high / low so far" },
  { code: "MA20 / MA50 / MA200", words: "the average closing price over 20 / 50 / 200 days" },
  { code: "52WH", words: "the highest price in a year" },
  { code: "DEMAND / SUPPLY", words: "a price zone where buyers / sellers stepped in before" },
  { code: "Break and hold", words: "a 2-minute candle closes past the level, then the next dip (or bounce) stays on the right side of it" },
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

function side(kind: "call" | "put", level: number | null | undefined, name: string, atr: number | null | undefined, next: Item["target_up"]): SidePlan | null {
  if (level == null) return null;
  const dir = kind === "call" ? 1 : -1;
  const a = atr && atr > 0 ? atr : null;
  const entry = a ? r2(level + dir * ENTRY_ATR * a) : null;
  const stop = a ? r2(level - dir * STOP_ATR * a) : null;
  const target1 = entry != null && stop != null ? r2(entry + dir * MIN_ROOM_MULTIPLE * Math.abs(entry - stop)) : null;
  const beyond = (p: number) => (target1 == null ? true : dir * (p - target1) > 0);
  const target2 = next && beyond(next.price) ? { price: next.price, name: next.name ?? "" } : null;
  return { side: kind, level, levelName: name, entry, stop, target1, target2 };
}

/** The call plan (break up) and the put plan (break down) for one focus name; either is null without its level. */
export function focusPlan(item: Item): { call: SidePlan | null; put: SidePlan | null } {
  return {
    call: side("call", item.breakout_above ?? item.resistance?.price, item.resistance?.name ?? "", item.atr, item.target_up),
    put: side("put", item.hold_above ?? item.support?.price, item.support?.name ?? "", item.atr, item.target_down),
  };
}

/** The UTC instant of a New York wall time on a day. */
function nyInstant(ymd: string, hh: number, mm: number): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh, mm);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess - (wall - guess));
}

const sydClock = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: SYDNEY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

/** The no-entry times in Sydney for a session: the first 5 minutes, and 11:30 to 13:00 New York. Null for a bad day. */
export function noEntryTimes(session: string | null | undefined): { firstEntry: string; lunchFrom: string; lunchTo: string } | null {
  if (!session || !/^\d{4}-\d{2}-\d{2}$/.test(session)) return null;
  return {
    firstEntry: sydClock(nyInstant(session, 9, 35)),
    lunchFrom: sydClock(nyInstant(session, 11, 30)),
    lunchTo: sydClock(nyInstant(session, 13, 0)),
  };
}
