// The Trade now board's event line (DEC-0042, note of 2026-11-12): what it says for each kind of event, at the time
// boundaries, around half days, holidays, weekends and both clock changes, and what it says when the calendar does
// not cover the day. Display only: the engine's side is in board-events-engine.test.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradeNowBoard } from "@/components/client/trade-now";
import { BoardEventsLine, MAX_SHOWN } from "@/components/board-events";
import { boardEvents, type BoardEvent, EARNINGS_MAX_AGE_DAYS, type EventCalendar, INDEX_NAMES, NOTE_KINDS, RELEASE_COVERAGE, REPO_CALENDAR, releaseTiming, SOON_MIN } from "@/lib/board-events";
import { FROZEN_NOW, focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_EXTRA_FOCUS } from "@/lib/fixture-script";
import { nyInstant, type Options } from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

/** The instant of a New York wall-clock time, "HH:MM" or "HH:MM:SS". */
const at = (day: string, t: string) => {
  const [h, m, s = 0] = t.split(":").map(Number);
  return nyInstant(day, h! * 60 + m!)! + s * 1000;
};
const texts = (evs: readonly BoardEvent[]) => evs.map((e) => e.text);
const run = (session: string, t: string, names: readonly string[], calendar?: EventCalendar) => boardEvents({ session, now: at(session, t), names, calendar });
/** The repo calendar with extra earnings rows (synthetic), for the days it has none. */
const withEarnings = (...rows: EventCalendar["earnings"]): EventCalendar => ({ ...REPO_CALENDAR, earnings: [...REPO_CALENDAR.earnings, ...rows] });

describe("releases on the board's day", () => {
  it("a Fed decision ahead, with a focus name reporting after the close (2026-12-09, the repo's own rows)", () => {
    expect(texts(run("2026-12-09", "10:00", ["AVGO", "NVDA"]))).toEqual(["Fed decision today at 14:00 New York", "AVGO earnings today after the close (16:00 New York)"]);
  });

  it("the time boundaries: more than SOON_MIN ahead, exactly SOON_MIN ahead, a second short of the minute, exactly now, inside the minute, one minute past", () => {
    expect(SOON_MIN).toBe(30);
    const one = (t: string) => run("2026-12-09", t, [])[0]!;
    expect(one("13:29:00")).toMatchObject({ timing: "ahead", text: "Fed decision today at 14:00 New York" });
    expect(one("13:30:00")).toMatchObject({ timing: "soon", text: "Fed decision at 14:00 New York, in 30 min" });
    expect(one("13:59:30")).toMatchObject({ timing: "soon", text: "Fed decision at 14:00 New York, in 1 min" });
    expect(one("14:00:00")).toMatchObject({ timing: "now", text: "Fed decision at 14:00 New York, now" });
    expect(one("14:00:59")).toMatchObject({ timing: "now", text: "Fed decision at 14:00 New York, now" });
    expect(one("14:01:00")).toMatchObject({ timing: "past", text: "Fed decision was at 14:00 New York today" });
  });

  it("releaseTiming on its own: the minute it is due is now, the minute after is past", () => {
    const t = 1_000_000_000_000;
    expect(releaseTiming(t, t - SOON_MIN * 60_000 - 1)).toEqual({ timing: "ahead", inMin: null });
    expect(releaseTiming(t, t - SOON_MIN * 60_000)).toEqual({ timing: "soon", inMin: SOON_MIN });
    expect(releaseTiming(t, t - 1)).toEqual({ timing: "soon", inMin: 1 });
    expect(releaseTiming(t, t)).toEqual({ timing: "now", inMin: null });
    expect(releaseTiming(t, t + 59_999)).toEqual({ timing: "now", inMin: null });
    expect(releaseTiming(t, t + 60_000)).toEqual({ timing: "past", inMin: null });
  });

  it("a release before the open reads as past during the session (CPI, 2026-11-10)", () => {
    expect(texts(run("2026-11-10", "09:45", []))).toEqual(["CPI inflation was at 08:30 New York today"]);
  });

  it("a release the calendar marks as derived is shown as expected (Fed minutes, 2026-11-18)", () => {
    const [ev] = run("2026-11-18", "10:00", []);
    expect(ev).toMatchObject({ kind: "release", expected: true, text: "Fed minutes today at 14:00 New York, date expected" });
  });

  it("two releases on one day come earliest first", () => {
    const cal: EventCalendar = {
      ...REPO_CALENDAR,
      // A synthetic CPI row beside the repo's own Fed decision on 2026-12-09.
      macro: [...REPO_CALENDAR.macro, { date: "2026-12-09", time_et: "08:30", code: "cpi", quality: "exact" }],
    };
    expect(texts(run("2026-12-09", "09:40", [], cal))).toEqual(["CPI inflation was at 08:30 New York today", "Fed decision today at 14:00 New York"]);
  });

  it("nothing on a day the calendar lists nothing for, and never a line saying the day is clear", () => {
    expect(run("2026-11-12", "10:00", ["SPY", "QQQ"])).toEqual([]);
  });
});

describe("each focus name's earnings", () => {
  it("before today's open: still ahead until 09:30 New York, out from 09:30:00", () => {
    const cal = withEarnings({ date: "2026-11-12", symbol: "MSFT", when: "bmo", quality: "confirmed" });
    expect(texts(run("2026-11-12", "05:00", ["MSFT"], cal))).toEqual(["MSFT earnings today before the open"]);
    expect(texts(run("2026-11-12", "09:29:59", ["MSFT"], cal))).toEqual(["MSFT earnings today before the open"]);
    expect(run("2026-11-12", "09:30:00", ["MSFT"], cal)).toEqual([
      { kind: "earnings_before_open", key: "earnings_before_open:MSFT", symbol: "MSFT", timing: null, expected: false, text: "MSFT earnings were before today's open" },
    ]);
  });

  it("today during the session, and today at a time of day the calendar does not give", () => {
    const cal = withEarnings({ date: "2026-11-12", symbol: "MSFT", when: "during", quality: "confirmed" }, { date: "2026-11-12", symbol: "AAPL", when: null, quality: "confirmed" });
    expect(texts(run("2026-11-12", "10:00", ["MSFT", "AAPL"], cal))).toEqual(["MSFT earnings today during the session", "AAPL earnings today, time of day not listed"]);
  });

  it("tomorrow before the open, from a Thursday", () => {
    const cal = withEarnings({ date: "2026-11-13", symbol: "MSFT", when: "bmo", quality: "confirmed" });
    expect(texts(run("2026-11-12", "10:00", ["MSFT"], cal))).toEqual(["MSFT earnings tomorrow before the open"]);
  });

  it("an expected date says so (GOOGL after the close on 2026-10-28, the repo's own row)", () => {
    expect(run("2026-10-28", "11:00", ["GOOGL", "MSFT"])).toEqual([
      { kind: "release", key: "release:fomc_decision:14:00", symbol: null, timing: "ahead", expected: false, text: "Fed decision today at 14:00 New York" },
      { kind: "earnings_after_close", key: "earnings_after_close:GOOGL", symbol: "GOOGL", timing: null, expected: true, text: "GOOGL earnings today after the close (16:00 New York), date expected" },
      { kind: "earnings_after_close", key: "earnings_after_close:MSFT", symbol: "MSFT", timing: null, expected: false, text: "MSFT earnings today after the close (16:00 New York)" },
    ]);
  });

  it("a Friday after-close row, read on the Monday that is the next session", () => {
    const cal = withEarnings({ date: "2026-11-13", symbol: "NVDA", when: "amc", quality: "confirmed" });
    expect(texts(run("2026-11-13", "15:00", ["NVDA"], cal))).toEqual(["NVDA earnings today after the close (16:00 New York)"]);
    expect(texts(run("2026-11-16", "09:40", ["NVDA"], cal))).toEqual(["NVDA earnings were after the last close (Fri 13 Nov)"]);
  });

  it("a Monday before-open row, read on the Friday before it: named by its day, not as tomorrow", () => {
    const cal = withEarnings({ date: "2026-11-16", symbol: "NVDA", when: "bmo", quality: "expected" });
    expect(texts(run("2026-11-13", "15:00", ["NVDA"], cal))).toEqual(["NVDA earnings Mon 16 Nov before the open, the next session, date expected"]);
  });

  it("on a half day the close is 13:00", () => {
    const cal = withEarnings({ date: "2026-11-27", symbol: "AMD", when: "amc", quality: "confirmed" });
    expect(texts(run("2026-11-27", "10:00", ["AMD"], cal))).toEqual(["AMD earnings today after the close (13:00 New York)"]);
  });

  it("the day before a holiday: the next session is the half day after it, and an after-close row on the half day is read after Thanksgiving", () => {
    const cal = withEarnings(
      { date: "2026-11-25", symbol: "AMD", when: "amc", quality: "confirmed" },
      { date: "2026-11-27", symbol: "PLTR", when: "bmo", quality: "confirmed" },
    );
    expect(texts(run("2026-11-25", "10:00", ["AMD", "PLTR"], cal))).toEqual(["AMD earnings today after the close (16:00 New York)", "PLTR earnings Fri 27 Nov before the open, the next session"]);
    // On the half day itself: Wednesday's after-close row is the last close's, and PLTR's is before today's open.
    expect(texts(run("2026-11-27", "09:40", ["AMD", "PLTR"], cal))).toEqual(["AMD earnings were after the last close (Wed 25 Nov)", "PLTR earnings were before today's open"]);
  });

  it("a row further away, or for another name, is not on the line", () => {
    const cal = withEarnings({ date: "2026-11-17", symbol: "NVDA", when: "amc", quality: "confirmed" });
    expect(run("2026-11-12", "10:00", ["NVDA"], cal)).toEqual([]);
    expect(run("2026-11-17", "10:00", ["AAPL"], cal)).toEqual([]);
  });
});

describe("what the calendar does not cover", () => {
  it("a day outside the calendar's range says so, and nothing else", () => {
    expect(run("2030-03-11", "10:00", ["SPY"])).toEqual([
      { kind: "not_covered", key: "not_covered:day", symbol: null, timing: null, expected: false, text: "The event calendar does not cover Mon 11 Mar 2030" },
    ]);
  });

  it("a month after the calendar's last listed releases says which are missing", () => {
    expect(texts(run("2028-01-14", "10:00", []))).toEqual(["The event calendar lists no dates yet for CPI inflation, Jobs report and Fed decision in January 2028"]);
  });

  it("a focus name whose earnings dates the calendar does not keep is named", () => {
    expect(texts(run("2026-11-12", "10:00", ["SPY", "ZZZZ", "XYZ"]))).toEqual(["The event calendar keeps no earnings dates for ZZZZ and XYZ"]);
  });

  it("with no focus names, the releases are still shown", () => {
    expect(texts(run("2026-12-09", "10:00", []))).toEqual(["Fed decision today at 14:00 New York"]);
  });

  it("nothing when the board's clock is not on the session's day (an older or a later edition)", () => {
    expect(boardEvents({ session: "2026-12-09", now: at("2026-12-10", "10:00"), names: ["AVGO"] })).toEqual([]);
    expect(boardEvents({ session: "2026-12-09", now: at("2026-12-08", "23:59"), names: ["AVGO"] })).toEqual([]);
    expect(boardEvents({ session: "2026-12-09", now: at("2026-12-09", "00:00"), names: ["AVGO"] })).toHaveLength(2);
  });
});

describe("New York time across both clock changes", () => {
  it("the week after New York's clocks go forward (8 Mar 2026): CPI at 08:30 is ten minutes after 12:20 UTC", () => {
    const evs = boardEvents({ session: "2026-03-11", now: Date.parse("2026-03-11T12:20:00Z"), names: [] });
    expect(texts(evs)).toEqual(["CPI inflation at 08:30 New York, in 10 min"]);
    // The Fed a week later, still on daylight time: 14:00 New York is 18:00 UTC.
    expect(texts(boardEvents({ session: "2026-03-18", now: Date.parse("2026-03-18T17:45:00Z"), names: [] }))).toEqual(["Fed decision at 14:00 New York, in 15 min"]);
  });

  it("the week after New York's clocks go back (1 Nov 2026): the jobs report at 08:30 is five minutes after 13:25 UTC", () => {
    expect(texts(boardEvents({ session: "2026-11-06", now: Date.parse("2026-11-06T13:25:00Z"), names: [] }))).toEqual(["Jobs report at 08:30 New York, in 5 min"]);
    expect(texts(boardEvents({ session: "2026-11-06", now: Date.parse("2026-11-06T13:31:00Z"), names: [] }))).toEqual(["Jobs report was at 08:30 New York today"]);
  });

  it("one fixed set of texts, whatever the machine's own zone (run under TZ=Australia/Sydney and TZ=America/Los_Angeles)", () => {
    const cal = withEarnings({ date: "2026-11-13", symbol: "NVDA", when: "amc", quality: "confirmed" }, { date: "2026-11-16", symbol: "AMD", when: "bmo", quality: "expected" });
    const all = [
      ...run("2026-03-11", "08:20", []),
      ...run("2026-11-06", "08:25", []),
      ...run("2026-11-13", "15:00", ["NVDA", "AMD"], cal),
      ...run("2026-11-16", "09:40", ["NVDA", "AMD"], cal),
      ...run("2026-11-27", "09:40", ["AMD"], cal),
      ...run("2030-03-11", "10:00", []),
    ];
    expect(texts(all)).toEqual([
      "CPI inflation at 08:30 New York, in 10 min",
      "Jobs report at 08:30 New York, in 5 min",
      "NVDA earnings today after the close (16:00 New York)",
      "AMD earnings Mon 16 Nov before the open, the next session, date expected",
      "NVDA earnings were after the last close (Fri 13 Nov)",
      "AMD earnings were before today's open, date expected",
      "The event calendar does not cover Mon 11 Mar 2030",
    ]);
  });
});

describe("the line is steady through the day", () => {
  it("every minute of 2026-12-09 gives the same items in the same order; only the release's wording moves", () => {
    const keys = new Set<string>();
    const timings = new Set<string>();
    for (let m = 0; m < 24 * 60; m++) {
      const evs = boardEvents({ session: "2026-12-09", now: nyInstant("2026-12-09", m)!, names: ["AVGO", "NVDA"] });
      keys.add(evs.map((e) => e.key).join("|"));
      timings.add(String(evs[0]!.timing));
    }
    expect([...keys]).toEqual(["release:fomc_decision:14:00|earnings_after_close:AVGO"]);
    expect([...timings].sort()).toEqual(["ahead", "now", "past", "soon"]);
  });
});

describe("no advice, no prediction", () => {
  it("no event text tells the owner what to do or what will happen", () => {
    const cal = withEarnings(
      { date: "2026-11-12", symbol: "MSFT", when: "bmo", quality: "confirmed" },
      { date: "2026-11-12", symbol: "AAPL", when: "during", quality: "expected" },
      { date: "2026-11-12", symbol: "AMD", when: null, quality: "confirmed" },
      { date: "2026-11-11", symbol: "TSLA", when: "amc", quality: "confirmed" },
      { date: "2026-11-13", symbol: "NVDA", when: "bmo", quality: "confirmed" },
    );
    const all = [
      ...run("2026-11-12", "10:00", ["MSFT", "AAPL", "AMD", "TSLA", "NVDA", "ZZZZ"], cal),
      ...run("2026-12-09", "13:45", ["AVGO"]),
      ...run("2026-12-09", "14:00", []),
      ...run("2026-12-09", "15:00", []),
      ...run("2028-01-14", "10:00", []),
      ...run("2030-03-11", "10:00", []),
    ];
    // Every kind is here, so every wording is checked.
    expect(new Set(all.map((e) => e.kind)).size).toBe(9);
    const advice = /\b(avoid|wait|don'?t|do not|should|must|careful|caution|risk|skip|exit|reduce|hold off|stay|consider|volatil\w*|move|spike|expect(?!ed\b))\b/i;
    for (const t of texts(all)) expect(t, t).not.toMatch(advice);
  });
});

describe("the fixture's frozen day draws no line", () => {
  it("the fixture session (2026-10-12) at the frozen clock lists nothing for SPY, QQQ or the script's extra name", () => {
    const e = focusOptions(optionsJson as unknown as Options, true);
    const names = e.focus!.items.map((i) => i.symbol);
    expect(names).toContain(SCRIPT_EXTRA_FOCUS);
    expect(boardEvents({ session: e.session, now: Date.parse(FROZEN_NOW), names })).toEqual([]);
    // Nor at any minute of that day, so no screenshot taken on it can change.
    for (let m = 0; m < 24 * 60; m += 1) expect(boardEvents({ session: e.session, now: nyInstant(e.session, m)!, names })).toEqual([]);
  });
});

// ---- the line as drawn -------------------------------------------------------------------------------------------
const html = (events: readonly BoardEvent[]) => renderToStaticMarkup(createElement(BoardEventsLine, { events })).replaceAll("&#x27;", "'");

describe("BoardEventsLine", () => {
  it("draws nothing for no events", () => {
    expect(html([])).toBe("");
  });

  it("draws each kind as its own item, in the board's small muted type, with no tone of its own", () => {
    const cal = withEarnings(
      { date: "2026-11-12", symbol: "MSFT", when: "bmo", quality: "confirmed" },
      { date: "2026-11-12", symbol: "AAPL", when: "during", quality: "expected" },
      { date: "2026-11-12", symbol: "AMD", when: null, quality: "confirmed" },
      { date: "2026-11-12", symbol: "META", when: "amc", quality: "confirmed" },
      { date: "2026-11-11", symbol: "TSLA", when: "amc", quality: "confirmed" },
      { date: "2026-11-13", symbol: "NVDA", when: "bmo", quality: "confirmed" },
    );
    const cases: [BoardEvent[], string, string][] = [
      [run("2026-12-09", "10:00", []), "release", "Fed decision today at 14:00 New York"],
      [run("2026-11-12", "10:00", ["META"], cal), "earnings_after_close", "META earnings today after the close (16:00 New York)"],
      [run("2026-11-12", "10:00", ["AAPL"], cal), "earnings_during", "AAPL earnings today during the session, date expected"],
      [run("2026-11-12", "10:00", ["AMD"], cal), "earnings_today", "AMD earnings today, time of day not listed"],
      [run("2026-11-12", "10:00", ["MSFT"], cal), "earnings_before_open", "MSFT earnings were before today's open"],
      [run("2026-11-12", "10:00", ["TSLA"], cal), "earnings_last_close", "TSLA earnings were after the last close (Wed 11 Nov)"],
      [run("2026-11-12", "10:00", ["NVDA"], cal), "earnings_next_open", "NVDA earnings tomorrow before the open"],
      [run("2030-03-11", "10:00", []), "not_covered", "The event calendar does not cover Mon 11 Mar 2030"],
      [run("2028-01-14", "10:00", []), "not_covered", "The event calendar lists no dates yet for CPI inflation, Jobs report and Fed decision in January 2028"],
      [run("2026-11-12", "10:00", ["ZZZZ"], cal), "earnings_not_kept", "The event calendar keeps no earnings dates for ZZZZ"],
    ];
    for (const [evs, kind, text] of cases) {
      expect(evs, kind).toHaveLength(1);
      const out = html(evs);
      expect(out, kind).toContain(`data-board-event="${kind}"`);
      expect(out, kind).toContain(`<span>${text}</span>`);
      expect(out, kind).toContain('data-board-events="1"');
      expect(out, kind).toContain("text-muted-foreground");
      // No colour, weight or badge that could compete with a state's.
      expect(out, kind).not.toMatch(/text-(warn|bad|good|explain)|bg-(warn|bad|good)|font-(medium|semibold|bold)|role="alert"/);
    }
  });

  it("several items are separated, and read in order", () => {
    const out = html(run("2026-12-09", "13:45", ["AVGO"]));
    expect(out).toContain('data-board-events="2"');
    expect(out.indexOf("Fed decision at 14:00 New York, in 15 min")).toBeLessThan(out.indexOf("AVGO earnings today after the close (16:00 New York)"));
    expect(out).toContain('data-board-event-timing="soon"');
    expect(out).toContain('data-board-event-symbol="AVGO"');
    // A screen reader hears the whole list once, after what the calendar covers; the drawn items are hidden from it.
    expect(out).toContain(`<span class="sr-only">${RELEASE_COVERAGE}: Fed decision at 14:00 New York, in 15 min; AVGO earnings today after the close (16:00 New York)</span>`);
    expect(out).toContain(`title="${RELEASE_COVERAGE}: Fed decision at 14:00 New York, in 15 min; AVGO earnings today after the close (16:00 New York)"`);
    expect(out).toMatch(/<span aria-hidden="true" data-board-event="release"/);
  });

  it("on the board: under the header, before the rows; events={null} draws the same board as no events prop, and removing the line from a board that has one gives that board back", () => {
    const props = { mode: { kind: "next", line: "Next session" } as const, rows: [], now: at("2026-12-09", "09:00"), paused: false, onOpen: () => undefined };
    const without = renderToStaticMarkup(createElement(TradeNowBoard, props));
    expect(renderToStaticMarkup(createElement(TradeNowBoard, { ...props, events: null }))).toBe(without);
    const line = createElement(BoardEventsLine, { events: run("2026-12-09", "09:00", ["AVGO"]) });
    const withLine = renderToStaticMarkup(createElement(TradeNowBoard, { ...props, events: line }));
    expect(withLine).toContain("data-board-events");
    expect(withLine.indexOf("data-board-header")).toBeLessThan(withLine.indexOf("data-board-events"));
    expect(withLine.indexOf("data-board-events")).toBeLessThan(withLine.indexOf("data-board-line"));
    // Taking the line out gives back the board drawn without one, to the character.
    expect(withLine.replace(/<p data-board-events.*?<\/p>/, "")).toBe(without);
  });
});

describe("names whose dates have run out (the repo's own rows; the last is AVGO on 2026-12-09)", () => {
  const SINGLES = ["AAPL", "MSFT", "META", "TSLA"];
  it("mirrors the host's horizon and the index names", () => {
    expect(EARNINGS_MAX_AGE_DAYS).toBe(75);
    expect(INDEX_NAMES).toEqual(["SPY", "QQQ"]);
  });

  it("2026-11-17, a listed date: shows it, and nothing about the others, all inside the window", () => {
    expect(texts(run("2026-11-17", "10:00", ["NVDA", ...SINGLES, "SPY"]))).toEqual(["NVDA earnings today after the close (16:00 New York)"]);
  });

  it("2026-12-10, just after the last row: AVGO's report is the last close's, the others are quiet", () => {
    expect(texts(run("2026-12-10", "10:00", ["AVGO", ...SINGLES]))).toEqual(["CPI inflation was at 08:30 New York today", "AVGO earnings were after the last close (Wed 9 Dec)"]);
  });

  it("2027-01-28 and 2027-03-01: says no upcoming date is listed, naming the single names in focus, never SPY or QQQ", () => {
    const jan = run("2027-01-28", "10:00", ["SPY", "QQQ", ...SINGLES]);
    expect(jan.filter((e) => e.kind === "earnings_not_listed")).toEqual([
      { kind: "earnings_not_listed", key: "earnings_not_listed", symbol: null, timing: null, expected: false, text: "The event calendar lists no upcoming earnings date for AAPL, MSFT, META and TSLA" },
    ]);
    expect(texts(run("2027-03-01", "10:00", ["QQQ", "AAPL", "MSFT"]))).toContain("The event calendar lists no upcoming earnings date for AAPL and MSFT");
    expect(run("2027-03-01", "10:00", ["SPY", "QQQ"])).toEqual([]);
  });

  it("the window's edge: quiet on the 75th day after a name's last row, named on the 76th; a name with no row at all is named", () => {
    const cal: EventCalendar = { ...REPO_CALENDAR, earnings: [{ date: "2027-01-04", symbol: "AAPL", when: "amc", quality: "confirmed" }] };
    // 2027-03-20 is the 75th day after 2027-01-04, 2027-03-21 the 76th (a weekend: the arithmetic is by day, not session).
    // Only the names' notes are read here (2027-03-19 is also quad witching).
    const note = (day: string, names: string[]) => texts(run(day, "10:00", names, cal).filter((e) => e.kind === "earnings_not_listed"));
    expect(note("2027-03-19", ["AAPL"])).toEqual([]);
    expect(note("2027-03-20", ["AAPL"])).toEqual([]);
    expect(note("2027-03-21", ["AAPL"])).toEqual(["The event calendar lists no upcoming earnings date for AAPL"]);
    expect(note("2027-03-22", ["AAPL"])).toEqual(["The event calendar lists no upcoming earnings date for AAPL"]);
    expect(note("2027-03-19", ["MSFT"])).toEqual(["The event calendar lists no upcoming earnings date for MSFT"]);
  });
});

describe("repeated rows and names", () => {
  it("two rows for one name, day and time of day are one item, the confirmed one; a name listed twice is one name", () => {
    const cal = withEarnings(
      { date: "2026-11-12", symbol: "MSFT", when: "amc", quality: "expected" },
      { date: "2026-11-12", symbol: "MSFT", when: "amc", quality: "confirmed" },
      { date: "2026-11-12", symbol: "MSFT", when: "amc", quality: "expected" },
    );
    expect(run("2026-11-12", "10:00", ["MSFT", "MSFT"], cal)).toEqual([
      { kind: "earnings_after_close", key: "earnings_after_close:MSFT", symbol: "MSFT", timing: null, expected: false, text: "MSFT earnings today after the close (16:00 New York)" },
    ]);
  });

  it("keys are unique whatever the rows hold (a release listed twice)", () => {
    const cal: EventCalendar = { ...REPO_CALENDAR, macro: [...REPO_CALENDAR.macro, { date: "2026-12-09", time_et: "14:00", code: "fomc_decision", quality: "exact" }] };
    const evs = run("2026-12-09", "10:00", ["AVGO"], cal);
    const keys = evs.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["release:fomc_decision:14:00", "release:fomc_decision:14:00#2", "earnings_after_close:AVGO"]);
  });
});

describe("a long line", () => {
  // Eight items: two releases, three earnings, three notes (synthetic rows on a day in a month with no listed releases).
  const cal: EventCalendar = {
    macro: [
      ...REPO_CALENDAR.macro,
      { date: "2028-01-14", time_et: "08:30", code: "cpi", quality: "exact" },
      { date: "2028-01-14", time_et: "14:00", code: "fomc_minutes", quality: "derived" },
    ],
    earnings: [
      { date: "2028-01-14", symbol: "AAPL", when: "bmo", quality: "confirmed" },
      { date: "2028-01-14", symbol: "MSFT", when: "amc", quality: "confirmed" },
      { date: "2028-01-13", symbol: "META", when: "amc", quality: "confirmed" },
    ],
    options_names: REPO_CALENDAR.options_names,
  };
  const evs = run("2028-01-14", "10:00", ["AAPL", "MSFT", "META", "TSLA", "ZZZZ"], cal);

  it("has eight items, the events first and the three notes last", () => {
    expect(evs).toHaveLength(8);
    expect(evs.map((e) => NOTE_KINDS.has(e.kind))).toEqual([false, false, false, false, false, true, true, true]);
  });

  it("draws five and '+3 more', folding notes only; the title and the screen reader have all eight", () => {
    expect(MAX_SHOWN).toBe(5);
    const out = html(evs);
    const drawn = [...out.matchAll(/data-board-event="([a-z_]+)"/g)].map((m) => m[1]);
    expect(drawn).toHaveLength(5);
    expect(drawn.every((k) => !NOTE_KINDS.has(k as BoardEvent["kind"]))).toBe(true);
    expect(out).toContain('data-board-events-more="3"');
    expect(out).toContain("+3 more");
    const all = `${RELEASE_COVERAGE}: ${evs.map((e) => e.text).join("; ")}`;
    expect(out).toContain(`title="${all}"`);
    expect(out).toContain(`<span class="sr-only">${all}</span>`);
  });

  it("an event is never the one folded while a note is drawn, whatever order the items come in", () => {
    const out = html([...evs].reverse());
    const drawn = [...out.matchAll(/data-board-event="([a-z_]+)"/g)].map((m) => m[1]);
    expect(drawn.filter((k) => NOTE_KINDS.has(k as BoardEvent["kind"]))).toEqual([]);
    expect(drawn).toHaveLength(5);
  });
});

describe("what the line covers", () => {
  it("the coverage words match the releases the repo's calendar holds", () => {
    expect(new Set(REPO_CALENDAR.macro.map((r) => r.code))).toEqual(new Set(["cpi", "nfp", "fomc_decision", "fomc_minutes", "quad_witching"]));
    expect(RELEASE_COVERAGE).toBe("Calendar of CPI, jobs, Fed decisions and minutes, quad witching, and the desk names' earnings");
  });
});
