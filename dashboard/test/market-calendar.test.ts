import { describe, expect, it } from "vitest";
import type { Trade } from "@/lib/journal";
import data from "@/lib/market-calendar.json";
import {
  addDays,
  clockSwitches,
  eventsByDay,
  mergeEarnings,
  monthlyExpiry,
  nextEarnings,
  nextHalfDay,
  nextHoliday,
  pickYear,
  RANGE,
  releaseNotes,
  sessionMoves,
  sessionOf,
  sydneySession,
  tradingCalendarDiffs,
  tradingDaysLeft,
  unlistedByMonth,
  yearTotals,
  yearView,
  yourDays,
} from "@/lib/market-calendar";
import { ruleDays } from "@/lib/overview";

/** The instant of a New York wall-clock time; `offset` is New York's hours behind UTC that day (4 or 5). */
const ny = (day: string, hhmm: string, offset = 5) => new Date(`${day}T${String(Number(hhmm.slice(0, 2)) + offset).padStart(2, "0")}:${hhmm.slice(3)}:00Z`);

let n = 0;
const trade = (pnl: number, opened: string, closed: string, extra: Partial<Trade> = {}): Trade => ({
  id: `t${++n}`,
  symbol: "SPY",
  kind: "call",
  strike: 760,
  expiry: closed.slice(0, 10),
  side: "long",
  qty: 1,
  opened_at: opened,
  closed_at: closed,
  entry: 1,
  exit: 1 + pnl / 100,
  multiplier: 100,
  pnl,
  close: "order",
  ...extra,
});

describe("the market days", () => {
  it("covers 2026 to 2029 and nothing past them", () => {
    expect(RANGE).toEqual({ start: "2026-01-01", end: "2029-12-31" });
    expect(sessionOf("2025-12-31").kind).toBe("out_of_range");
    expect(sessionOf("2028-01-03")).toEqual({ kind: "open", name: null, open: 570, close: 960 });
    expect(sessionOf("2029-12-24")).toEqual({ kind: "half", name: "Christmas Eve", open: 570, close: 780 });
    expect(sessionOf("2029-12-25")).toEqual({ kind: "closed", name: "Christmas Day", open: null, close: null });
    expect(sessionOf("2029-12-31")).toEqual({ kind: "open", name: null, open: 570, close: 960 });
    // New Year's Day 2030 is a holiday by every rule, but past the file the page says it does not know.
    expect(sessionOf("2030-01-01").kind).toBe("out_of_range");
  });

  it("names the holidays and the half days", () => {
    expect(sessionOf("2026-11-26")).toEqual({ kind: "closed", name: "Thanksgiving Day", open: null, close: null });
    expect(sessionOf("2026-11-27")).toEqual({ kind: "half", name: "Day after Thanksgiving", open: 570, close: 780 });
    expect(sessionOf("2026-12-24").name).toBe("Christmas Eve");
    expect(sessionOf("2027-12-24").name).toBe("Christmas Day (observed)");
    expect(sessionOf("2026-11-28").kind).toBe("weekend");
    expect(sessionOf("2026-11-30")).toEqual({ kind: "open", name: null, open: 570, close: 960 });
  });
});

describe("trading days left", () => {
  // 2026-11-05 is a Thursday; New York is UTC-5 after 1 November.
  it("counts today until the close, then not", () => {
    expect(tradingDaysLeft(ny("2026-11-05", "09:00"))).toBe(39);
    expect(tradingDaysLeft(ny("2026-11-05", "15:59"))).toBe(39);
    expect(tradingDaysLeft(ny("2026-11-05", "16:00"))).toBe(38);
  });

  it("ends a half day at 1 pm", () => {
    const before = tradingDaysLeft(ny("2026-11-27", "12:59"));
    expect(tradingDaysLeft(ny("2026-11-27", "13:00"))).toBe(before! - 1);
  });

  it("never counts a holiday or a weekend", () => {
    expect(tradingDaysLeft(ny("2026-11-26", "10:00"))).toBe(tradingDaysLeft(ny("2026-11-27", "09:00")));
    expect(tradingDaysLeft(ny("2026-11-28", "10:00"))).toBe(tradingDaysLeft(ny("2026-11-30", "09:00")));
  });

  it("reaches zero after the last close, and refuses a year past the file", () => {
    expect(tradingDaysLeft(ny("2026-12-31", "15:00"))).toBe(1);
    expect(tradingDaysLeft(ny("2026-12-31", "16:30"))).toBe(0);
    expect(tradingDaysLeft(ny("2028-12-29", "15:00"))).toBe(1);
    expect(tradingDaysLeft(ny("2029-01-02", "09:00"))).toBe(251);
    expect(tradingDaysLeft(ny("2029-12-24", "12:00"))).toBe(5);
    expect(tradingDaysLeft(ny("2029-12-31", "15:00"))).toBe(1);
    expect(tradingDaysLeft(ny("2029-12-31", "16:30"))).toBe(0);
    expect(tradingDaysLeft(ny("2030-01-08", "10:00"))).toBeNull();
  });
});

describe("what comes next", () => {
  it("finds the next holiday and half day", () => {
    expect(nextHoliday(ny("2026-11-05", "10:00"))).toEqual({ day: "2026-11-26", name: "Thanksgiving Day", inDays: 21 });
    expect(nextHoliday(ny("2026-11-26", "10:00"))?.inDays).toBe(0);
    expect(nextHalfDay(ny("2026-11-05", "10:00"))).toEqual({ day: "2026-11-27", name: "Day after Thanksgiving", inDays: 22 });
  });

  it("drops a half day once its 1 pm close has passed", () => {
    expect(nextHalfDay(ny("2026-11-27", "12:59"))?.day).toBe("2026-11-27");
    expect(nextHalfDay(ny("2026-11-27", "13:00"))?.day).toBe("2026-12-24");
    expect(nextHalfDay(ny("2027-11-26", "13:30"))?.day).toBe("2028-07-03");
    expect(nextHalfDay(ny("2029-12-24", "12:59"))?.day).toBe("2029-12-24");
    expect(nextHalfDay(ny("2029-12-24", "13:00"))).toBeNull();
  });
});

describe("options expiry", () => {
  it("is the third Friday", () => {
    expect(monthlyExpiry(2026, 11)).toBe("2026-11-20");
    expect(monthlyExpiry(2027, 3)).toBe("2027-03-19");
    expect(monthlyExpiry(2026, 1)).toBe("2026-01-16");
  });

  it("moves to the Thursday when that Friday is closed", () => {
    const shut = new Set(["2026-11-20"]);
    expect(monthlyExpiry(2026, 11, (d) => !shut.has(d) && ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))).toBe("2026-11-19");
  });

  it("is never on a holiday in the file", () => {
    for (const y of [2026, 2027]) for (let m = 1; m <= 12; m++) expect(["open", "half"]).toContain(sessionOf(monthlyExpiry(y, m)!).kind);
  });
});

describe("Sydney and the clock switches", () => {
  it("finds every switch in both places", () => {
    const at = (y: number) => clockSwitches(y).map((s) => `${s.day} ${s.where} ${s.direction}`);
    expect(at(2026)).toEqual(["2026-03-08 New York forward", "2026-04-05 Sydney back", "2026-10-04 Sydney forward", "2026-11-01 New York back"]);
    expect(at(2027)).toEqual(["2027-03-14 New York forward", "2027-04-04 Sydney back", "2027-10-03 Sydney forward", "2027-11-07 New York back"]);
  });

  it("puts the session in Sydney time across each season", () => {
    // Both on summer time (US) and standard time (Sydney): 23:30 the same day.
    expect(sydneySession("2026-07-06")?.open).toEqual({ weekday: "Mon", time: "23:30", day: "2026-07-06" });
    // Between the US spring switch and Sydney's autumn one: 00:30 the next day.
    expect(sydneySession("2027-03-16")?.open).toEqual({ weekday: "Wed", time: "00:30", day: "2027-03-17" });
    // US winter, Sydney summer: 01:30 the next day; a half day ends at 05:00.
    expect(sydneySession("2026-11-27")).toEqual({
      open: { weekday: "Sat", time: "01:30", day: "2026-11-28" },
      close: { weekday: "Sat", time: "05:00", day: "2026-11-28" },
    });
    expect(sydneySession("2026-11-26")).toBeNull();
  });

  it("marks the first session at new Sydney times", () => {
    const moves = sessionMoves(2026).map((m) => `${m.day} ${m.from}→${m.to} ${m.cause.where}`);
    expect(moves).toEqual(["2026-03-09 01:30→00:30 New York", "2026-04-06 00:30→23:30 Sydney", "2026-10-05 23:30→00:30 Sydney", "2026-11-02 00:30→01:30 New York"]);
  });
});

describe("events", () => {
  it("draws the repo's macro rows through the labels, with the expiry", () => {
    const by = eventsByDay([]);
    const first = data.macro.find((e) => e.code === "fomc_decision")!;
    expect(by.get(first.date)?.some((e) => e.label === "Fed decision" && e.timeEt === first.time_et)).toBe(true);
    expect(by.get("2026-11-20")?.map((e) => e.code)).toContain("opex");
  });

  it("keeps earnings to the Options names and says when", () => {
    const rows = mergeEarnings([{ date: "2026-12-10", symbol: "AVGO", when: "amc" }, { date: "2026-12-10", symbol: "ZZZZ", when: "amc" }]);
    const by = eventsByDay(rows);
    expect(by.get("2026-12-10")?.filter((e) => e.group === "earnings").map((e) => e.label)).toEqual(["AVGO earnings, after the close"]);
    // The repo's quality word: an expected row says so, a confirmed one does not.
    for (const e of data.earnings) expect(rows.find((r) => r.date === e.date && r.symbol === e.symbol)?.expected).toBe(e.quality !== "confirmed");
    expect(rows.some((r) => r.expected)).toBe(true);
    expect(rows.find((r) => r.symbol === "NVDA" && r.date === "2026-11-17")?.expected).toBe(false);
  });

  it("gives every Options name its next date or none", () => {
    const next = nextEarnings(mergeEarnings([]), ny("2026-11-05", "10:00"));
    expect(next).toHaveLength(12);
    expect(next.find((x) => x.symbol === "NVDA")?.row?.date).toBe("2026-11-17");
    expect(next.find((x) => x.symbol === "AAPL")?.row).toBeNull();
  });
});

describe("your days", () => {
  // New York is UTC-4 in October.
  const at = (day: string, hhmm: string) => ny(day, hhmm, 4).toISOString();

  it("agrees with the Overview strip on every day", () => {
    const trades = [
      trade(-120, at("2026-10-14", "10:00"), at("2026-10-14", "10:20")),
      ...Array.from({ length: 6 }, (_, i) => trade(5, at("2026-10-15", `10:0${i}`), at("2026-10-15", `10:0${i}`))),
      trade(30, at("2026-10-16", "10:00"), at("2026-10-16", "10:03")),
    ];
    const mine = yourDays(trades);
    for (const d of ruleDays(trades, 100)) expect(mine.get(d.day)?.broke).toBe(d.broke);
    expect(mine.get("2026-10-14")?.broke).toBe("loss");
    expect(mine.get("2026-10-15")?.broke).toBe("count");
    expect(mine.get("2026-10-16")?.broke).toBeNull();
  });

  it("lists the trade rules by number for the day the trade opened", () => {
    const trades = [trade(-60, at("2026-10-14", "10:00"), at("2026-10-14", "10:20"))];
    expect(yourDays(trades).get("2026-10-14")?.rules).toContain(4);
  });

  it("totals each month from the same days", () => {
    const trades = [
      trade(40, at("2026-10-14", "10:00"), at("2026-10-14", "10:20")),
      trade(-150, at("2026-10-15", "10:00"), at("2026-10-15", "10:20")),
    ];
    const months = yearView(2026, ny("2026-11-05", "10:00"), yourDays(trades), new Map());
    const oct = months[9]!;
    expect(oct.label).toBe("October");
    expect([oct.pnl, oct.daysTraded, oct.ruleDays, oct.marketDays]).toEqual([-110, 2, 1, 22]);
    expect(yearTotals(months).marketDays).toBe(251);
    expect(months.flatMap((m) => m.weeks.flat()).filter((c) => c?.isToday).map((c) => c!.day)).toEqual(["2026-11-05"]);
    expect(months[10]!.notes).toContain("26: Thanksgiving Day, closed");
    // A month shows results only once it has begun: November has (today is the 5th), December has not.
    expect([months[9]!.started, months[10]!.started, months[11]!.started]).toEqual([true, true, false]);
  });
});

describe("the year in the address", () => {
  const now = ny("2026-11-05", "10:00");
  it("takes a covered year and nothing else", () => {
    expect(pickYear("2027", now)).toBe(2027);
    expect(pickYear("2029", now)).toBe(2029);
    expect(pickYear(["2026", "2027"], now)).toBe(2026);
    for (const bad of [undefined, "", "2025", "2030", "abc", "2026.5", "1e3"]) expect(pickYear(bad, now)).toBe(2026);
    expect(pickYear(undefined, ny("2029-01-02", "10:00"))).toBe(2029);
    expect(pickYear(undefined, ny("2030-01-02", "10:00"))).toBe(2026);
  });
});

describe("releases not listed yet", () => {
  it("flags every month after a release's last listed date, and none before", () => {
    const by = unlistedByMonth();
    const flagged = (label: string) => [...by].filter(([, labels]) => labels.includes(label)).map(([month]) => month).sort();
    for (const [code, label] of [["cpi", "CPI"], ["nfp", "Jobs report"], ["fomc_decision", "Fed decisions"]] as const) {
      const last = data.macro.filter((e) => e.code === code).map((e) => e.date).sort().at(-1)!;
      const want: string[] = [];
      for (let m = addDays(`${last.slice(0, 7)}-28`, 7).slice(0, 7); `${m}-01` <= RANGE.end; m = addDays(`${m}-28`, 7).slice(0, 7)) want.push(m);
      expect(flagged(label)).toEqual(want);
      expect(by.get(last.slice(0, 7)) ?? []).not.toContain(label);
    }
    // The Fed's 2027 meetings are listed, so a month of 2027 without one is not flagged; the calendar reaches 2029,
    // past the macro rows, so 2028 and 2029 are not yet announced rather than missing.
    expect(flagged("Fed decisions").filter((m) => m <= "2027-12")).toEqual([]);
    expect(flagged("Fed decisions")).toEqual([...Array(24)].map((_, i) => `${2028 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`));
  });

  it("flags the months after a synthetic calendar's last CPI date, not the months up to it", () => {
    const macro = [
      { code: "cpi", date: "2027-03-10" },
      { code: "cpi", date: "2027-01-13" },
      { code: "nfp", date: "2027-12-03" },
      { code: "fomc_decision", date: "2027-12-08" },
    ];
    const by = unlistedByMonth(undefined, macro);
    expect(by.get("2027-04")).toEqual(["CPI"]);
    expect(by.get("2027-12")).toEqual(["CPI"]);
    for (const m of ["2027-01", "2027-02", "2027-03"]) expect(by.has(m)).toBe(false);
    // No row at all: every month of the range is flagged.
    const none = unlistedByMonth(undefined, [{ code: "nfp", date: "2027-12-03" }, { code: "fomc_decision", date: "2027-12-08" }]);
    expect(none.get(RANGE.start.slice(0, 7))).toEqual(["CPI"]);
  });
});

describe("the published economic calendar", () => {
  const off = (date: string, code: string, source = "fred", checked_by: string[] = ["bls"]) => ({ date, code, time_et: code === "fomc_decision" ? "14:00" : "08:30", source, checked_by });

  it("prefers the official date over the repo's, month by month, and keeps the repo's where it is silent", () => {
    // The repo lists CPI on 10 Nov 2026; say the official calendar has it on the 12th.
    const by = eventsByDay([], [off("2026-11-12", "cpi"), off("2026-11-13", "ppi")]);
    expect(by.get("2026-11-12")?.find((e) => e.code === "cpi")).toMatchObject({ source: "FRED", checkedBy: ["BLS"], timeEt: "08:30" });
    expect(by.get("2026-11-10")?.some((e) => e.code === "cpi")).toBeFalsy();
    expect(by.get("2026-11-13")?.find((e) => e.code === "ppi")?.label).toBe("PPI inflation");
    // Jobs is not in it: the repo's row stands, and says where it is from.
    expect(by.get("2026-11-06")?.find((e) => e.code === "nfp")?.source).toBe("the trading calendar");
  });

  it("says where the trading calendar differs from the official dates", () => {
    expect(tradingCalendarDiffs([off("2026-11-10", "cpi")])).toEqual([]);
    expect(tradingCalendarDiffs([off("2026-11-12", "cpi")])).toEqual([{ code: "cpi", month: "2026-11", official: ["2026-11-12"], trading: ["2026-11-10"] }]);
    // A month the trading calendar does not list yet (it reaches the end of 2027).
    expect(tradingCalendarDiffs([off("2028-01-07", "nfp")])).toEqual([{ code: "nfp", month: "2028-01", official: ["2028-01-07"], trading: [] }]);
    // A release the trading calendar never carries is not a difference.
    expect(tradingCalendarDiffs([off("2026-11-13", "ppi")])).toEqual([]);
  });

  it("takes its months not yet announced as published", () => {
    const by = unlistedByMonth([{ code: "pce", month: "2027-01" }, { code: "cpi", month: "2027-01" }, { code: "cpi", month: "2030-01" }]);
    expect(by.get("2027-01")).toEqual(["PCE", "CPI"]);
    expect(by.has("2030-01")).toBe(false);
  });
});

describe("what the page says about its release dates", () => {
  const now = ny("2026-11-09", "10:00");
  const src = (id: string, extra: Record<string, unknown> = {}) => ({ id, configured: true, ok: true, fetched_at: "2026-11-07T15:00:00Z", stale_since: null, ...extra });
  const doc = (extra: Record<string, unknown> = {}) => ({ as_of: "2026-11-07T15:00:00Z", sources: ["fred", "fed", "bls", "bea"].map((s) => src(s)), disagreements: [], ...extra });

  it("is quiet when everything was read this week", () => {
    expect(releaseNotes("ok", doc(), [], now)).toEqual([]);
  });

  it("falls back to the repo's calendar, and says so", () => {
    expect(releaseNotes("missing", null, [], now)[0]).toMatchObject({ tone: "info" });
    expect(releaseNotes("error", null, [], now)[0]).toMatchObject({ tone: "warn" });
  });

  it("warns when the calendar is old, a source is stale, sources disagree, or the trading calendar differs", () => {
    const notes = releaseNotes(
      "ok",
      doc({
        as_of: "2026-10-20T15:00:00Z",
        sources: [src("fred", { ok: false, stale_since: "2026-11-07T15:00:00Z" }), src("fed"), src("bls"), src("bea", { ok: false, fetched_at: null })],
        disagreements: [{ code: "cpi", month: "2026-11", source: "fred", dates: ["2026-11-12"], other_source: "bls", other_dates: ["2026-11-10"] }],
      }),
      [{ code: "nfp", month: "2027-01", official: ["2027-01-08"], trading: [] }],
      now,
    );
    expect(notes.map((n) => n.tone)).toEqual(["warn", "warn", "warn", "warn", "warn"]);
    expect(notes[0]!.text).toContain("20 days ago");
    expect(notes[1]!.text).toContain("FRED could not be read on the last run; its dates from Sat 7 Nov are shown");
    expect(notes[2]!.text).toContain("BEA could not be read, and has never been");
    expect(notes[3]!.text).toBe("CPI, Nov 2026: FRED gives Thu 12 Nov, BLS gives Tue 10 Nov. Check before trading around it.");
    expect(notes[4]!.text).toBe("Jobs report, Jan 2027: the official date is Fri 8 Jan, but the calendar the paper runners trade around has no date.");
  });

  it("names a source that is not set up, without calling it a fault", () => {
    const notes = releaseNotes("ok", doc({ sources: [src("fred", { configured: false, ok: false, fetched_at: null }), src("fed"), src("bls", { configured: false, ok: false, fetched_at: null }), src("bea")] }), [], now);
    expect(notes.map((n) => n.tone)).toEqual(["info", "info"]);
  });
});
