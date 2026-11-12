// The exchange calendar's 2028 and 2029, as the page and the desk read it (market-calendar.ts over
// market-calendar.json). 2028 is as NYSE publishes it; 2029's rows are marked expected (Alpaca and the rules) to
// Monday 24 December, where Alpaca's calendar ends, and rule (the rules alone) after it. tests/unit/test_market_calendar.py ties the same file to the Python
// calendar (wt.options.levels) day by day; this file ties the TypeScript reading of it to the file.
import { describe, expect, it } from "vitest";
import data from "@/lib/market-calendar.json";
import { clockSwitches, isExpectedDay, PAST_END, RANGE, releaseNotes, sessionMoves, sessionOf, sydneySession, tradingDaysLeft, yearView } from "@/lib/market-calendar";
import { nyInstant } from "@/lib/options";

const HOLIDAYS: Record<string, string> = {
  "2028-01-17": "Martin Luther King Jr. Day",
  "2028-02-21": "Washington's Birthday",
  "2028-04-14": "Good Friday",
  "2028-05-29": "Memorial Day",
  "2028-06-19": "Juneteenth",
  "2028-07-04": "Independence Day",
  "2028-09-04": "Labor Day",
  "2028-11-23": "Thanksgiving Day",
  "2028-12-25": "Christmas Day",
  "2029-01-01": "New Year's Day",
  "2029-01-15": "Martin Luther King Jr. Day",
  "2029-02-19": "Washington's Birthday",
  "2029-03-30": "Good Friday",
  "2029-05-28": "Memorial Day",
  "2029-06-19": "Juneteenth",
  "2029-07-04": "Independence Day",
  "2029-09-03": "Labor Day",
  "2029-11-22": "Thanksgiving Day",
  "2029-12-25": "Christmas Day",
};
const EARLY_CLOSES: Record<string, string> = {
  "2028-07-03": "Day before Independence Day",
  "2028-11-24": "Day after Thanksgiving",
  "2029-07-03": "Day before Independence Day",
  "2029-11-23": "Day after Thanksgiving",
  "2029-12-24": "Christmas Eve",
};

const addDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const nextWeekday = (d: string) => {
  let x = addDay(d);
  while ([0, 6].includes(new Date(`${x}T12:00:00Z`).getUTCDay())) x = addDay(x);
  return x;
};

describe("the file and its reading agree on every day of the range", () => {
  it("sessions, holidays, half days and their close times", () => {
    const sessions = new Set(data.sessions);
    const holidays = new Map(data.holidays.map((h) => [h.date, h.name]));
    const halves = new Map(data.half_days.map((h) => [h.date, h]));
    let n = 0;
    for (let d = RANGE.start; d <= RANGE.end; d = addDay(d)) {
      const s = sessionOf(d);
      const w = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (w === 0 || w === 6) expect(s.kind, d).toBe("weekend");
      else if (holidays.has(d)) expect(s, d).toEqual({ kind: "closed", name: holidays.get(d), open: null, close: null });
      else if (halves.has(d)) {
        const [h, m] = halves.get(d)!.close_et.split(":").map(Number);
        expect(s, d).toEqual({ kind: "half", name: halves.get(d)!.label, open: 570, close: h! * 60 + m! });
      } else expect(s, d).toEqual({ kind: "open", name: null, open: 570, close: 960 });
      if (s.kind === "open" || s.kind === "half") {
        expect(sessions.has(d), d).toBe(true);
        n++;
      }
    }
    expect(n).toBe(data.sessions.length);
  });
});

describe("2028 and 2029", () => {
  for (const [day, name] of Object.entries(HOLIDAYS)) {
    it(`${day} ${name} is closed and the next weekday trades`, () => {
      expect(sessionOf(day)).toEqual({ kind: "closed", name, open: null, close: null });
      expect(["open", "half"]).toContain(sessionOf(nextWeekday(day)).kind);
      expect(isExpectedDay(day)).toBe(day >= "2029");
    });
  }

  for (const [day, label] of Object.entries(EARLY_CLOSES)) {
    it(`${day} ${label} closes at 13:00 New York`, () => {
      expect(sessionOf(day)).toEqual({ kind: "half", name: label, open: 570, close: 780 });
      expect(isExpectedDay(day)).toBe(day >= "2029");
    });
  }

  it("has exactly these holidays and half days, and no New Year's Day 2028 or Christmas Eve 2028 close", () => {
    expect(data.holidays.filter((h) => h.date >= "2028").map((h) => h.date)).toEqual(Object.keys(HOLIDAYS));
    expect(data.half_days.filter((h) => h.date >= "2028").map((h) => h.date)).toEqual(Object.keys(EARLY_CLOSES));
    expect(sessionOf("2027-12-31").kind).toBe("open"); // 1 January 2028 is a Saturday: not observed
    expect(sessionOf("2028-12-22").kind).toBe("open"); // 24 December 2028 is a Sunday
  });

  it("the first and last session of each year, and leap day", () => {
    expect(data.sessions.find((d) => d.startsWith("2028"))).toBe("2028-01-03");
    expect(data.sessions.filter((d) => d.startsWith("2028")).at(-1)).toBe("2028-12-29");
    expect(data.sessions.find((d) => d.startsWith("2029"))).toBe("2029-01-02");
    expect(data.sessions.filter((d) => d > "2029-12-24")).toEqual(["2029-12-26", "2029-12-27", "2029-12-28", "2029-12-31"]);
    expect(data.sessions.at(-1)).toBe("2029-12-31");
    expect(data.sessions.filter((d) => d.startsWith("2029")).length).toBe(251);
    expect(sessionOf("2028-02-29").kind).toBe("open");
  });

  it("the month notes say which rows NYSE has not published yet", () => {
    const notes = (y: number, m: number) => yearView(y, new Date("2026-11-12T00:00:00Z"), new Map(), new Map())[m - 1]!.notes;
    expect(notes(2028, 11)).toContain("23: Thanksgiving Day, closed");
    expect(notes(2029, 11)).toContain("22: Thanksgiving Day, closed (expected: NYSE has not published this year yet)");
    expect(notes(2029, 12)).toContain("24: Christmas Eve, closes 1 pm New York (expected: NYSE has not published this year yet)");
    // After Alpaca's last listed day the rules alone stand behind the days: the holiday's note and the month say so.
    expect(notes(2029, 12)).toContain("25: Christmas Day, closed (rule only: after Alpaca's last listed day, 24 Dec 2029; NYSE has not published this year yet)");
    expect(notes(2029, 12)).toContain("25–31: by the exchange's rules only, after Alpaca's last listed day (24 Dec 2029)");
    const dec = yearView(2029, new Date("2026-11-12T00:00:00Z"), new Map(), new Map())[11]!;
    expect(dec.marketDays).toBe(20);
    expect(dec.weeks.flat().filter((c) => c?.kind === "out_of_range")).toEqual([]);
    expect(yearView(2029, new Date("2026-11-12T00:00:00Z"), new Map(), new Map()).reduce((n, m) => n + m.marketDays, 0)).toBe(251);
  });

  it("counts trading days left all through 2029", () => {
    const ny = (iso: string) => new Date(iso);
    expect(tradingDaysLeft(ny("2029-01-02T14:00:00Z"))).toBe(251);
    expect(tradingDaysLeft(ny("2029-07-02T14:00:00Z"))).toBe(127);
    expect(tradingDaysLeft(ny("2029-12-26T15:00:00Z"))).toBe(4);
    expect(tradingDaysLeft(ny("2029-12-31T22:00:00Z"))).toBe(0);
  });

  it("a day past the file is drawn as such, not as a weekend, and says why", () => {
    expect(PAST_END).toBe("past the calendar's end (31 Dec 2029)");
    const jan = yearView(2030, new Date("2026-11-12T00:00:00Z"), new Map(), new Map())[0]!;
    const cells = jan.weeks.flat().filter((c) => c !== null);
    expect(cells.every((c) => c.kind === "out_of_range" && c.name === PAST_END)).toBe(true);
    expect(jan.marketDays).toBe(0);
    expect(jan.notes).toEqual(["1–31: past the calendar's end (31 Dec 2029)"]);
  });

  it("the economic calendar's note on a year the Fed has not published is shown, not dropped", () => {
    const doc = { as_of: "2026-11-12T00:00:00Z", disagreements: [], sources: [{ id: "fed", configured: true, ok: true, fetched_at: "2026-11-12T00:00:00Z", stale_since: null, note: "no panel yet for 2028, 2029: those months are not yet announced, not missing" }] };
    expect(releaseNotes("ok", doc, [], new Date("2026-11-12T01:00:00Z"))).toContainEqual({ tone: "info", text: "Federal Reserve: no panel yet for 2028, 2029: those months are not yet announced, not missing." });
  });
});

describe("New York session times across the clock changes of 2028 and 2029", () => {
  it("finds every switch", () => {
    const at = (y: number) => clockSwitches(y).map((s) => `${s.day} ${s.where} ${s.direction}`);
    expect(at(2028)).toEqual(["2028-03-12 New York forward", "2028-04-02 Sydney back", "2028-10-01 Sydney forward", "2028-11-05 New York back"]);
    expect(at(2029)).toEqual(["2029-03-11 New York forward", "2029-04-01 Sydney back", "2029-10-07 Sydney forward", "2029-11-04 New York back"]);
  });

  // The Friday before and the Monday after each New York change, with New York's hours behind UTC.
  for (const [day, behind] of [
    ["2028-03-10", 5], ["2028-03-13", 4], ["2028-11-03", 4], ["2028-11-06", 5],
    ["2029-03-09", 5], ["2029-03-12", 4], ["2029-11-02", 4], ["2029-11-05", 5],
  ] as const) {
    it(`${day} opens at 09:30 and closes at 16:00 New York (UTC-${behind})`, () => {
      const s = sessionOf(day);
      expect(s.kind).toBe("open");
      expect(nyInstant(day, s.open!)).toBe(Date.parse(`${day}T${String(9 + behind).padStart(2, "0")}:30:00Z`));
      expect(nyInstant(day, s.close!)).toBe(Date.parse(`${day}T${16 + behind}:00:00Z`));
    });
  }

  it("marks the first session at new Sydney times", () => {
    const moves = (y: number) => sessionMoves(y).map((m) => `${m.day} ${m.from}→${m.to} ${m.cause.where}`);
    expect(moves(2028)).toEqual(["2028-03-13 01:30→00:30 New York", "2028-04-03 00:30→23:30 Sydney", "2028-10-02 23:30→00:30 Sydney", "2028-11-06 00:30→01:30 New York"]);
    expect(moves(2029)).toEqual(["2029-03-12 01:30→00:30 New York", "2029-04-02 00:30→23:30 Sydney", "2029-10-08 23:30→00:30 Sydney", "2029-11-05 00:30→01:30 New York"]);
    expect(sydneySession("2029-12-24")?.close).toEqual({ weekday: "Tue", time: "05:00", day: "2029-12-25" });
  });
});
