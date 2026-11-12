// The Trade now board's event line (DEC-0042, note of 2026-11-12): the scheduled releases and the focus names'
// earnings that fall on the board's day, in words, from the event calendar the repo already keeps
// (market-calendar.json, built by scripts/build_market_calendar.py from config/events/). Display only.
//
// Nothing in the desk's engine reads this file: it sits outside the import closure of desk-eval.ts (the engine label,
// scripts/gen-engine.mjs), it is never passed to a state, a level, a guard, the server's evaluation, the shadow
// comparison or an alert, and it changes no state's word, order or colour. It says what is scheduled, when (New York
// time) and for whom. It gives no advice and predicts nothing.
//
// Data honesty. A release the calendar does not list is not shown, and the line never says that a day has no event:
// an empty answer means only that the calendar lists nothing. When the calendar does not cover the day, or has no
// dates yet for a month's releases, keeps no earnings dates for a focus name, or has let a focus name's dates run out,
// it says so. A date the calendar marks as not confirmed is shown as expected. The calendar holds only CPI, the jobs
// report, Fed decisions and minutes, quad witching and the desk names' earnings (RELEASE_COVERAGE): other releases
// (PCE, GDP, ...) are never on the line, and the line's title and screen-reader text say what it covers.
//
// Severity. The dashboard's copy of the calendar carries no severity (the source file's column is not copied into
// market-calendar.json), so nothing here ranks or filters releases by one: every release the copy lists for the day is
// shown, by its own label. Adding the severity to that file would change the engine's label; it is not done here.
import data from "./market-calendar.json";
import { addDays, SHORT_LABEL, sessionOf, unlistedByMonth } from "./market-calendar";
import { eventLabel, nyInstant } from "./options";
import { weekDate } from "./format";

/**
 * A release this many minutes away or less reads "in N min" instead of only its time. Half an hour: about fifteen of
 * the board's 2-minute bars, so the countdown is on the screen before a decision made on the board would reach the
 * broker by hand. It changes the wording only: no state, level, guard or alert reads it.
 */
export const SOON_MIN = 30;

/**
 * A kept name whose latest earnings row is more than this many days before the session, with none after it, is named
 * as having no upcoming date listed. The same horizon as the host's calendar check: EARNINGS_MAX_AGE_DAYS in
 * src/wt/risk/events.py (tests/unit/test_board_events_parity.py holds the two equal). A name reports about once a
 * quarter, so inside this window a quiet name is one whose next date is not due yet, not one that was never added.
 */
export const EARNINGS_MAX_AGE_DAYS = 75;

/** The names that report no earnings: config/options_clone.yaml's contract.index_names (the parity test holds them). */
export const INDEX_NAMES: readonly string[] = ["SPY", "QQQ"];

/** What the calendar this line reads covers, for the line's title and its screen-reader text. */
export const RELEASE_COVERAGE = "Calendar of CPI, jobs, Fed decisions and minutes, quad witching, and the desk names' earnings";

/** The calendar rows this line reads. The default is the repo's own file; a test hands it other rows. */
export interface EventCalendar {
  macro: readonly { date: string; time_et: string; code: string; quality: string }[];
  earnings: readonly { date: string; symbol: string; when: string | null; quality: string }[];
  /** The names whose earnings dates the calendar keeps. */
  options_names: readonly string[];
}

export const REPO_CALENDAR: EventCalendar = { macro: data.macro, earnings: data.earnings, options_names: data.options_names };

export type BoardEventKind =
  /** A scheduled release on the board's day. */
  | "release"
  /** A focus name reports after today's close. */
  | "earnings_after_close"
  /** A focus name reports during today's session. */
  | "earnings_during"
  /** A focus name reports today, at a time of day the calendar does not give. */
  | "earnings_today"
  /** A focus name reports before today's open: "today before the open" until 09:30, "were before" from then. */
  | "earnings_before_open"
  /** A focus name reported after the last session's close. */
  | "earnings_last_close"
  /** A focus name reports before the next session's open. */
  | "earnings_next_open"
  /** The calendar does not cover the day, or has no dates yet for some of the month's releases. */
  | "not_covered"
  /** The calendar keeps no earnings dates for these focus names. */
  | "earnings_not_kept"
  /** The calendar's dates for these focus names have run out: none upcoming, the last one older than the window. */
  | "earnings_not_listed";

/** Where a release stands against the board's clock. Wording only. */
export type ReleaseTiming = "ahead" | "soon" | "now" | "past";

/** The kinds that say what the calendar does not cover: drawn after every event, and the first folded away. */
export const NOTE_KINDS: ReadonlySet<BoardEventKind> = new Set<BoardEventKind>(["not_covered", "earnings_not_kept", "earnings_not_listed"]);

export interface BoardEvent {
  kind: BoardEventKind;
  /** Stable within the day: the line keeps its items, in the same order, while only their wording moves. */
  key: string;
  symbol: string | null;
  timing: ReleaseTiming | null;
  /** The calendar marks the date as not confirmed. */
  expected: boolean;
  text: string;
}

const isSession = (day: string) => {
  const k = sessionOf(day).kind;
  return k === "open" || k === "half";
};

/** The first session after `day` (or before it, `step` -1), looking at most two weeks away; null past the calendar. */
function sessionFrom(day: string, step: 1 | -1): string | null {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(day, i * step);
    if (sessionOf(d).kind === "out_of_range") return null;
    if (isSession(d)) return d;
  }
  return null;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const minutesOf = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthWords = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const listWords = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Where a release at `at` (ms) stands at `now` (ms): the minute it is due reads "now", the minute after "past". */
export function releaseTiming(at: number, now: number): { timing: ReleaseTiming; inMin: number | null } {
  const diff = at - now;
  if (diff > SOON_MIN * 60_000) return { timing: "ahead", inMin: null };
  if (diff > 0) return { timing: "soon", inMin: Math.ceil(diff / 60_000) };
  if (diff > -60_000) return { timing: "now", inMin: null };
  return { timing: "past", inMin: null };
}

/**
 * The board's event line for `session`, read at `now` (ms, the board's clock), for the focus names in `names`. Empty
 * unless `now` falls on the session's own New York day: the line is about the day the board is trading. Releases
 * first (earliest first), then each focus name in the order given, then what the calendar does not cover.
 */
export function boardEvents({ session, now, names: given, calendar = REPO_CALENDAR }: { session: string; now: number; names: readonly string[]; calendar?: EventCalendar }): BoardEvent[] {
  // A name listed twice is one name.
  const names = [...new Set(given)];
  const open = nyInstant(session, 0);
  const next = nyInstant(addDays(session, 1), 0);
  if (open === null || next === null || !(now >= open && now < next)) return [];
  const day = sessionOf(session);
  if (day.kind === "out_of_range") {
    return [{ kind: "not_covered", key: "not_covered:day", symbol: null, timing: null, expected: false, text: `The event calendar does not cover ${weekDate(session)} ${session.slice(0, 4)}` }];
  }
  const out: BoardEvent[] = [];

  // Releases on the day, earliest first.
  const releases = calendar.macro
    .filter((r) => r.date === session)
    .map((r) => ({ r, min: minutesOf(r.time_et) }))
    .sort((a, b) => (a.min ?? 9999) - (b.min ?? 9999) || a.r.code.localeCompare(b.r.code));
  for (const { r, min } of releases) {
    const label = eventLabel(r.code);
    const expected = r.quality !== "exact";
    const tail = expected ? ", date expected" : "";
    const at = min === null ? null : nyInstant(session, min);
    if (min === null || at === null) {
      out.push({ kind: "release", key: `release:${r.code}:${r.time_et}`, symbol: null, timing: null, expected, text: `${label} today, time not listed${tail}` });
      continue;
    }
    const t = releaseTiming(at, now);
    const time = `${hhmm(min)} New York`;
    const text =
      t.timing === "ahead"
        ? `${label} today at ${time}`
        : t.timing === "soon"
          ? `${label} at ${time}, in ${t.inMin} min`
          : t.timing === "now"
            ? `${label} at ${time}, now`
            : `${label} was at ${time} today`;
    out.push({ kind: "release", key: `release:${r.code}:${r.time_et}`, symbol: null, timing: t.timing, expected, text: `${text}${tail}` });
  }

  // Each focus name's earnings around the day. One row per name, day and time of day: a confirmed row before an
  // expected one.
  const byKey = new Map<string, EventCalendar["earnings"][number]>();
  for (const r of calendar.earnings) {
    const k = `${r.symbol}|${r.date}|${r.when ?? ""}`;
    const had = byKey.get(k);
    if (!had || (had.quality !== "confirmed" && r.quality === "confirmed")) byKey.set(k, r);
  }
  const earnings = [...byKey.values()];
  const kept = new Set(calendar.options_names);
  const index = new Set(INDEX_NAMES);
  const prev = sessionFrom(session, -1);
  const after = sessionFrom(session, 1);
  const openAt = day.open === null ? null : nyInstant(session, day.open);
  const oldest = addDays(session, -EARNINGS_MAX_AGE_DAYS);
  const notKept: string[] = [];
  const notListed: string[] = [];
  for (const symbol of names) {
    if (!kept.has(symbol)) {
      notKept.push(symbol);
      continue;
    }
    const rows = earnings.filter((r) => r.symbol === symbol);
    const add = (kind: BoardEventKind, row: { quality: string }, words: string) => {
      const expected = row.quality !== "confirmed";
      out.push({ kind, key: `${kind}:${symbol}`, symbol, timing: null, expected, text: `${symbol} ${words}${expected ? ", date expected" : ""}` });
    };
    for (const r of rows.filter((x) => x.date === session)) {
      if (r.when === "bmo") add("earnings_before_open", r, openAt !== null && now < openAt ? "earnings today before the open" : "earnings were before today's open");
      else if (r.when === "amc") add("earnings_after_close", r, `earnings today after the close (${day.close === null ? "close" : hhmm(day.close)} New York)`);
      else if (r.when === "during") add("earnings_during", r, "earnings today during the session");
      else add("earnings_today", r, "earnings today, time of day not listed");
    }
    if (prev) for (const r of rows.filter((x) => x.date === prev && x.when === "amc")) add("earnings_last_close", r, `earnings were after the last close (${weekDate(prev)})`);
    if (after) {
      for (const r of rows.filter((x) => x.date === after && x.when === "bmo")) {
        add("earnings_next_open", r, after === addDays(session, 1) ? "earnings tomorrow before the open" : `earnings ${weekDate(after)} before the open, the next session`);
      }
    }
    // A single name whose dates have run out: none from the last session on, and the latest older than the window.
    if (!index.has(symbol) && !rows.some((r) => r.date >= (prev ?? session))) {
      const latest = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
      if (latest === "" || latest < oldest) notListed.push(symbol);
    }
  }

  // What the calendar does not cover, after every event. Labels as the items name the same releases.
  const unlisted = (unlistedByMonth(undefined, calendar.macro).get(session.slice(0, 7)) ?? []).map((label) => {
    const code = Object.keys(SHORT_LABEL).find((c) => SHORT_LABEL[c] === label);
    return code ? eventLabel(code) : label;
  });
  if (unlisted.length) {
    out.push({ kind: "not_covered", key: "not_covered:month", symbol: null, timing: null, expected: false, text: `The event calendar lists no dates yet for ${listWords(unlisted)} in ${monthWords(session.slice(0, 7))}` });
  }
  if (notListed.length) {
    out.push({ kind: "earnings_not_listed", key: "earnings_not_listed", symbol: null, timing: null, expected: false, text: `The event calendar lists no upcoming earnings date for ${listWords(notListed)}` });
  }
  if (notKept.length) {
    out.push({ kind: "earnings_not_kept", key: "earnings_not_kept", symbol: null, timing: null, expected: false, text: `The event calendar keeps no earnings dates for ${listWords(notKept)}` });
  }
  // Keys unique whatever the rows hold: a repeat gets a count.
  const seen = new Map<string, number>();
  return out.map((e) => {
    const n = seen.get(e.key) ?? 0;
    seen.set(e.key, n + 1);
    return n === 0 ? e : { ...e, key: `${e.key}#${n + 1}` };
  });
}
