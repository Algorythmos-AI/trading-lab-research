import { describe, expect, it } from "vitest";
import { builtFromNotice, builtFromOld, builtFromProblem, MAX_BUILD_GAP_DAYS } from "@/lib/options";
import { addDays, RANGE, sessionOf } from "@/lib/market-calendar";
import calendar from "@/lib/market-calendar.json";
import { radarStale } from "@/lib/radar";

/** The rule before the session calendar, kept here word for word: outside the calendar it must still be the answer. */
function calendarDayRule(session: string, builtFrom: string | null | undefined): boolean {
  if (!builtFrom) return false;
  const gap = (Date.parse(`${session}T00:00:00Z`) - Date.parse(`${builtFrom}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(gap) && (gap <= 0 || gap > MAX_BUILD_GAP_DAYS);
}

const isOpen = (day: string) => ["open", "half"].includes(sessionOf(day).kind);

/** The last session before `day` by the Calendar page's own sessionOf, worked out independently of options.ts. */
function previousByCalendar(day: string): string | null {
  for (let d = addDays(day, -1); d >= RANGE.start; d = addDays(d, -1)) if (isOpen(d)) return d;
  return null;
}

describe("builtFromOld", () => {
  it("accepts the previous session, across a weekend and a long weekend", () => {
    expect(builtFromOld("2026-10-14", "2026-10-13")).toBe(false);
    expect(builtFromOld("2026-10-12", "2026-10-09")).toBe(false);
    expect(builtFromOld("2027-03-29", "2027-03-25")).toBe(false); // Good Friday
  });
  it("flags a close too far back, or not before the session", () => {
    expect(builtFromOld("2026-10-14", "2026-10-08")).toBe(true);
    expect(builtFromOld("2026-10-14", "2026-10-14")).toBe(true);
  });
  it("says nothing without a build date", () => {
    expect(builtFromOld("2026-10-14", null)).toBe(false);
    expect(builtFromOld("2026-10-14", undefined)).toBe(false);
    expect(builtFromProblem("2026-10-14", null)).toBeNull();
    expect(builtFromNotice("2026-10-14", undefined)).toBeNull();
  });

  it("every ordinary weekday pair, and Monday from Friday", () => {
    for (const [session, from, before] of [
      ["2026-10-13", "2026-10-12", "2026-10-09"], // Tue from Mon
      ["2026-10-14", "2026-10-13", "2026-10-12"], // Wed from Tue
      ["2026-10-15", "2026-10-14", "2026-10-13"], // Thu from Wed
      ["2026-10-16", "2026-10-15", "2026-10-14"], // Fri from Thu
      ["2026-10-19", "2026-10-16", "2026-10-15"], // Mon from Fri
    ] as const) {
      expect(builtFromOld(session, from)).toBe(false);
      // Built from the session before that one, a pull missed a session.
      expect(builtFromProblem(session, before)).toEqual({ kind: "earlier", last: from });
    }
  });

  it("the session after each kind of holiday", () => {
    const fresh: [string, string, string][] = [
      ["2026-01-20", "2026-01-16", "a Monday holiday (Martin Luther King Jr. Day)"],
      ["2026-11-27", "2026-11-25", "Thanksgiving Thursday: the Friday half day from the Wednesday"],
      ["2026-11-30", "2026-11-27", "the Monday after the Thanksgiving half day"],
      ["2026-04-06", "2026-04-02", "Good Friday 2026"],
      ["2027-03-29", "2027-03-25", "Good Friday 2027"],
      ["2028-07-05", "2028-07-03", "4 July on a Tuesday, built from the Monday half day"],
      ["2029-06-20", "2029-06-18", "Juneteenth on a Tuesday"],
      ["2029-07-05", "2029-07-03", "4 July on a Wednesday, built from the Tuesday half day"],
      ["2026-12-28", "2026-12-24", "Christmas on a Friday, built from the Christmas Eve half day"],
      ["2027-01-04", "2026-12-31", "New Year's Day on a Friday, across the year end"],
      ["2029-01-02", "2028-12-29","New Year's Day on a Monday, across the year end"],
      ["2027-12-27", "2027-12-23", "Christmas observed on Friday 24 December 2027"],
      ["2029-12-26", "2029-12-24", "Christmas on a Tuesday, built from the Monday half day"],
    ];
    for (const [session, from, why] of fresh) expect(builtFromOld(session, from), why).toBe(false);
    // The holiday itself, and the session before the right one, are old.
    expect(builtFromProblem("2026-01-20", "2026-01-19")?.kind).toBe("not_session");
    expect(builtFromProblem("2026-01-20", "2026-01-15")?.kind).toBe("earlier");
    expect(builtFromProblem("2026-11-27", "2026-11-26")?.kind).toBe("not_session");
    expect(builtFromProblem("2026-04-06", "2026-04-03")?.kind).toBe("not_session");
    expect(builtFromProblem("2027-01-04", "2027-01-01")?.kind).toBe("not_session");
    expect(builtFromProblem("2027-01-04", "2026-12-30")?.kind).toBe("earlier");
  });

  it("the missed pulls the calendar-day rule let through", () => {
    // Wednesday from the previous Friday: two sessions missed, five calendar days, which the old rule caught too.
    expect(calendarDayRule("2026-10-14", "2026-10-09")).toBe(true);
    expect(builtFromProblem("2026-10-14", "2026-10-09")).toEqual({ kind: "earlier", last: "2026-10-13" });
    // Monday from the Thursday, the Friday missed: four calendar days, which it let through.
    expect(calendarDayRule("2026-10-19", "2026-10-15")).toBe(false);
    expect(builtFromProblem("2026-10-19", "2026-10-15")).toEqual({ kind: "earlier", last: "2026-10-16" });
    // Tuesday from Friday when Monday was a session.
    expect(calendarDayRule("2026-10-13", "2026-10-09")).toBe(false);
    expect(builtFromProblem("2026-10-13", "2026-10-09")).toEqual({ kind: "earlier", last: "2026-10-12" });
    // Across a holiday: the Thanksgiving half day from the Tuesday, the Wednesday missed.
    expect(calendarDayRule("2026-11-27", "2026-11-24")).toBe(false);
    expect(builtFromProblem("2026-11-27", "2026-11-24")).toEqual({ kind: "earlier", last: "2026-11-25" });
    // The Thursday after 4 July 2029 (a Wednesday) from the Monday, the Tuesday half day missed.
    expect(calendarDayRule("2029-07-05", "2029-07-02")).toBe(false);
    expect(builtFromProblem("2029-07-05", "2029-07-02")).toEqual({ kind: "earlier", last: "2029-07-03" });
    // The old rule caught a five-day gap, and so does the new one.
    expect(calendarDayRule("2026-01-20", "2026-01-15")).toBe(true);
    expect(builtFromProblem("2026-01-20", "2026-01-15")).toEqual({ kind: "earlier", last: "2026-01-16" });
  });

  it("a build date on the session, after it, on a weekend or on a holiday", () => {
    expect(builtFromProblem("2026-10-14", "2026-10-14")).toEqual({ kind: "same_or_later", last: "2026-10-13" });
    expect(builtFromProblem("2026-10-14", "2026-10-15")).toEqual({ kind: "same_or_later", last: "2026-10-13" });
    expect(builtFromProblem("2026-10-14", "2031-01-02")?.kind).toBe("same_or_later");
    expect(builtFromProblem("2026-10-12", "2026-10-10")).toEqual({ kind: "not_session", last: "2026-10-09" });
    expect(builtFromProblem("2026-10-12", "2026-10-11")).toEqual({ kind: "not_session", last: "2026-10-09" });
    expect(builtFromProblem("2026-07-06", "2026-07-03")).toEqual({ kind: "not_session", last: "2026-07-02" }); // 4 July observed
    expect(builtFromProblem("2026-06-22", "2026-06-19")).toEqual({ kind: "not_session", last: "2026-06-18" }); // Juneteenth
  });

  it("an edition for a day the market is closed is old whatever it was built from", () => {
    expect(builtFromProblem("2026-10-10", "2026-10-09")?.kind).toBe("session_closed"); // a Saturday
    expect(builtFromProblem("2026-11-26", "2026-11-25")?.kind).toBe("session_closed"); // Thanksgiving
    expect(builtFromProblem("2026-01-01", "2025-12-31")?.kind).toBe("session_closed"); // the file's first day
    expect(builtFromOld("2026-11-26", null)).toBe(false);
  });

  it("the first and last sessions of the calendar, and one step outside each end", () => {
    const first = calendar.sessions[0]!;
    const last = calendar.sessions.at(-1)!;
    expect([RANGE.start, first, RANGE.end, last]).toEqual(["2026-01-01", "2026-01-02", "2029-12-31", "2029-12-31"]);
    // The last session: exact.
    expect(builtFromOld(last, "2029-12-28")).toBe(false);
    expect(builtFromOld(last, "2029-12-27")).toBe(true);
    expect(builtFromOld(last, "2029-12-29")).toBe(true);
    // The second session: exact, its previous session is the file's first.
    expect(builtFromOld("2026-01-05", first)).toBe(false);
    expect(builtFromProblem("2026-01-05", "2025-12-31")).toEqual({ kind: "earlier", last: first });
    // The first session (its previous one is before the file), the day before the file and the day after it: the
    // calendar cannot say, so the calendar-day rule answers, exactly as before, on every build date around them.
    for (const session of [first, addDays(RANGE.start, -1), addDays(RANGE.end, 1), "2025-06-02", "2030-03-04"]) {
      for (let i = -3; i <= 12; i++) {
        const from = addDays(session, -i);
        expect(builtFromOld(session, from), `${session} from ${from}`).toBe(calendarDayRule(session, from));
      }
    }
    expect(builtFromProblem(first, "2025-12-31")).toBeNull();
    expect(builtFromProblem(first, "2025-12-29")).toBeNull(); // 4 days: the old rule's allowance
    expect(builtFromProblem(first, "2025-12-28")).toEqual({ kind: "far_back", last: null });
    expect(builtFromProblem("2030-01-02", "2030-01-02")).toEqual({ kind: "same_or_later", last: null });
  });

  it("malformed dates never throw and never read as fresh", () => {
    for (const bad of ["", "2026-13-40", "2026-02-30", "20261014", "2026-10-13T20:00:00Z", "2026-10-13 ", "Tue 13 Oct"]) {
      expect(() => builtFromProblem("2026-10-14", bad)).not.toThrow();
      expect(builtFromProblem("2026-10-14", bad), JSON.stringify(bad)).toEqual({ kind: "unreadable", last: null });
      expect(builtFromOld("2026-10-14", bad)).toBe(true);
      // A malformed session with a readable build date is unreadable too.
      expect(builtFromProblem(bad, "2026-10-13")).toEqual({ kind: "unreadable", last: null });
      // Outside the calendar as well: the calendar-day rule read these as fresh (NaN); they are not.
      expect(builtFromOld("2030-03-04", bad)).toBe(true);
    }
    expect(calendarDayRule("2026-10-14", "2026-13-40")).toBe(false);
    expect(calendarDayRule("2026-10-14", "20261014")).toBe(false);
    expect(builtFromOld("", null)).toBe(false);
    expect(builtFromOld("2026-10-14", null)).toBe(false);
    expect(builtFromOld("2026-10-14", undefined)).toBe(false);
  });

  it("over every session in the file: its previous session is fresh, and each of the 10 days before that is old", () => {
    const sessions = calendar.sessions;
    expect(sessions.length).toBeGreaterThan(1000);
    let checked = 0;
    for (const s of sessions) {
      const prev = previousByCalendar(s);
      if (prev === null) {
        expect(s).toBe(sessions[0]); // only the first session has none in the file; the fallback is tested above
        continue;
      }
      expect(builtFromProblem(s, prev), `${s} from ${prev}`).toBeNull();
      for (let i = 1; i <= 10; i++) {
        const d = addDays(prev, -i);
        expect(builtFromOld(s, d), `${s} from ${d}`).toBe(true);
      }
      checked++;
    }
    expect(checked).toBe(sessions.length - 1);
  });

  it("the page's warning says which kind it is", () => {
    expect(builtFromNotice("2026-10-14", "2026-10-13")).toBeNull();
    expect(builtFromNotice("2026-10-14", "2026-10-09")).toBe(
      "These levels for Wed 14 Oct were built from the Fri 9 Oct close, but the last close before Wed 14 Oct was Tue 13 Oct. A session's bars are missing, so check them before use.",
    );
    expect(builtFromNotice("2026-10-14", "2026-10-14")).toBe(
      "These levels for Wed 14 Oct are stamped as built from Wed 14 Oct, which is not before that session. The stamp is wrong, so check them before use.",
    );
    expect(builtFromNotice("2026-10-12", "2026-10-10")).toBe(
      "These levels for Mon 12 Oct are stamped as built from Sat 10 Oct, a day the market was closed. The stamp is wrong, so check them before use.",
    );
    expect(builtFromNotice("2026-11-26", "2026-11-25")).toBe(
      "These levels are stamped for Thu 26 Nov, a day the market is closed. The stamp is wrong, so check them before use.",
    );
    expect(builtFromNotice("2026-10-14", "2026-13-40")).toBe(
      "These levels carry a date that cannot be read, so the close they were built from is unknown. Check them before use.",
    );
    expect(builtFromNotice("2030-03-11", "2030-03-01")).toBe(
      "These levels for Mon 11 Mar were built from the Fri 1 Mar close, more than 4 days earlier. A session's bars may be missing, so check them before use.",
    );
    // No warning says "a weekend": the old text called every flagged close "more than a weekend earlier".
    for (const [s, b] of [["2026-10-14", "2026-10-09"], ["2026-10-14", "2026-10-14"], ["2030-03-11", "2030-03-01"]] as const) expect(builtFromNotice(s, b)).not.toMatch(/weekend/);
  });
});

describe("radarStale", () => {
  const ny = (iso: string) => new Date(iso); // instants written in UTC; EDT is UTC-4
  it("is fresh before the open, and on the day's own edition", () => {
    expect(radarStale("2026-10-13", ny("2026-10-14T13:00:00Z"))).toBe(false); // 09:00 ET
    expect(radarStale("2026-10-14", ny("2026-10-14T15:00:00Z"))).toBe(false);
  });
  it("is stale once a weekday's session opens without a newer edition", () => {
    expect(radarStale("2026-10-13", ny("2026-10-14T13:30:00Z"))).toBe(true); // 09:30 ET
  });
  it("never on a weekend", () => {
    expect(radarStale("2026-10-09", ny("2026-10-10T16:00:00Z"))).toBe(false);
    expect(radarStale("2026-10-09", ny("2026-10-11T16:00:00Z"))).toBe(false);
  });
});
