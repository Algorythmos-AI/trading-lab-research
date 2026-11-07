import { describe, expect, it } from "vitest";
import { noEntryTimes } from "@/lib/focus-plan";
import { countdown, railDay, sessionClock, sessionTimeline } from "@/lib/session-timeline";
import { FIRST_ENTRY_MIN, flatMinute, LUNCH_FROM_MIN, LUNCH_TO_MIN } from "@/lib/trade-state";

// The status rail's pure parts: the session bar with its no-entry windows, the clock's next boundary, and the day's
// limits in one line. 2026-10-12 is a Monday on EDT (UTC−4); 2026-11-27 a half day on EST (UTC−5).
const S = "2026-10-12";
const at = (hhmmss: string, day = S, offset = "-04:00") => Date.parse(`${day}T${hhmmss}${offset}`);

describe("the session bar", () => {
  it("shades the opening range, the lunch block and the flat time on a full day", () => {
    const t = sessionTimeline(false, null);
    expect(t.open).toBe(570);
    expect(t.close).toBe(960);
    expect(t.windows.map((w) => `${w.kind} ${w.label}`)).toEqual(["opening 09:30–09:35", "lunch 11:30–13:00", "flat 15:10–16:00"]);
    // 390 minutes: the opening range is 5 of them, lunch starts 120 in and lasts 90
    expect(t.windows[0]).toMatchObject({ left: 0, width: 1.28 });
    expect(t.windows[1]).toMatchObject({ left: 30.77, width: 23.08 });
    expect(t.windows[2]!.left + t.windows[2]!.width).toBeCloseTo(100, 1);
    expect(t.now).toBeNull();
    expect(t.hours.map((h) => h.minute)).toEqual([600, 660, 720, 780, 840, 900]);
  });

  it("has no lunch block on a half day, and ends at 13:00 with its own flat time", () => {
    const t = sessionTimeline(true, null);
    expect(t.close).toBe(780);
    expect(t.windows.map((w) => w.label)).toEqual(["09:30–09:35", "12:10–13:00"]);
  });

  it("uses the engine's own minutes, the same ones the focus card prints", () => {
    const words = noEntryTimes(S, false)!;
    const t = sessionTimeline(false, null);
    expect(t.windows[0]!.to).toBe(FIRST_ENTRY_MIN);
    expect(t.windows[0]!.label.endsWith(words.firstEntry)).toBe(true);
    expect(t.windows[1]).toMatchObject({ from: LUNCH_FROM_MIN, to: LUNCH_TO_MIN, label: `${words.lunchFrom}–${words.lunchTo}` });
    expect(t.windows[2]!.from).toBe(flatMinute(false));
    expect(noEntryTimes(S, true)!.lunchFrom).toBeNull();
  });

  it("puts the now tick on the bar only inside the session", () => {
    expect(sessionTimeline(false, 570).now).toBe(0);
    expect(sessionTimeline(false, 765).now).toBe(50);
    expect(sessionTimeline(false, 960).now).toBe(100);
    expect(sessionTimeline(false, 569).now).toBeNull();
    expect(sessionTimeline(false, 961).now).toBeNull();
  });
});

describe("the countdown", () => {
  it("reads m:ss under ten minutes, minutes under an hour, then hours", () => {
    expect(countdown(192)).toBe("3:12");
    expect(countdown(0)).toBe("0:00");
    expect(countdown(-5)).toBe("0:00");
    expect(countdown(14 * 60)).toBe("14 min");
    expect(countdown(65 * 60)).toBe("1 h 05 min");
  });
});

describe("the clock's next boundary", () => {
  const line = (t: string, halfDay = false, day = S, offset = "-04:00") => sessionClock(day, halfDay, at(t, day, offset)).line;

  it("walks a full day", () => {
    expect(line("08:00:00")).toBe("Opens 09:30 in 1 h 30 min · first entries 09:35");
    expect(line("09:31:48")).toBe("First entries in 3:12");
    expect(line("11:16:00")).toBe("Lunch block 11:30–13:00 in 14 min");
    expect(line("12:00:00")).toBe("No new entries until 13:00");
    expect(line("13:00:00")).toBe("New entries end 15:10 in 2 h 10 min");
    expect(line("15:18:00")).toBe("No new entries · close 16:00 in 42 min");
    expect(line("16:00:00")).toBe("Closed");
  });

  it("allows entries by the clock only outside the no-entry windows", () => {
    const entries = (t: string) => sessionClock(S, false, at(t)).entries;
    expect(entries("09:34:59")).toBe(false);
    expect(entries("09:35:00")).toBe(true);
    expect(entries("11:30:00")).toBe(false);
    expect(entries("13:00:00")).toBe(true);
    expect(entries("15:10:00")).toBe(false);
  });

  it("closes a half day at 13:00 with no lunch block", () => {
    const H = "2026-11-27";
    expect(line("11:00:00", true, H, "-05:00")).toBe("New entries end 12:10 in 1 h 10 min");
    expect(line("12:20:00", true, H, "-05:00")).toBe("No new entries · close 13:00 in 40 min");
    expect(line("13:00:00", true, H, "-05:00")).toBe("Closed");
  });

  it("names the next session before its day, and is closed after it", () => {
    expect(sessionClock(S, false, at("20:00:00", "2026-10-09")).line).toBe("Next session Mon 12 Oct · opens 09:30 · first entries 09:35");
    expect(sessionClock(S, false, at("20:00:00", "2026-10-13")).phase).toBe("closed");
  });

  it("works an older card's clock from today's trading day, never Closed in market hours", () => {
    // Tue 13 Oct at 10:30 with Monday's card: the market is open, whatever the card's day
    const old = sessionClock(S, false, at("10:30:00", "2026-10-13"));
    expect(old).toMatchObject({ phase: "open", entries: true, minute: 630, halfDay: false });
    expect(old.line).toBe("Lunch block 11:30–13:00 in 1 h 00 min");
    expect(sessionClock(S, false, at("09:31:48", "2026-10-13")).line).toBe("First entries in 3:12");
    // today's own half day, not the card's: Fri 27 Nov closes at 13:00 with Thursday's card (a holiday) behind it
    const half = sessionClock("2026-11-25", false, at("12:20:00", "2026-11-27", "-05:00"));
    expect(half).toMatchObject({ phase: "flat", halfDay: true, line: "No new entries · close 13:00 in 40 min" });
    // a weekend and a holiday are closed; a day past the calendar says the card is old instead of guessing
    expect(sessionClock(S, false, at("10:30:00", "2026-10-17")).line).toBe("Closed");
    expect(sessionClock("2026-11-25", false, at("10:30:00", "2026-11-26", "-05:00")).line).toBe("Closed");
    expect(sessionClock("2027-12-31", false, Date.parse("2028-01-04T15:30:00Z"))).toMatchObject({ phase: "closed", line: "Old focus card", minute: null });
  });

  it("follows New York across the clock change", () => {
    // 2026-11-02 is a Monday on EST: 14:31 UTC is 09:31 New York
    expect(sessionClock("2026-11-02", false, Date.parse("2026-11-02T14:31:00Z")).line).toBe("First entries in 4:00");
  });

  it("gives the timeline its minute, with the seconds", () => {
    expect(sessionClock(S, false, at("10:28:30")).minute).toBe(628.5);
  });
});

describe("the day's limits in one line", () => {
  const base = { isToday: true, current: true, used: 0, net: 0, openLine: "" };
  it("reads the status, the trades and the loss against the limits", () => {
    expect(railDay({ ...base, status: "clear" })).toEqual({ word: "Clear", tone: "good", line: "Clear · 0/5 trades · $0 of $100", open: null, room: "A stop now leaves $50 of $100 and 4 trades." });
    expect(railDay({ ...base, status: "careful", used: 4, net: -12.4 }).line).toBe("Careful · 4/5 trades · $12 of $100");
    expect(railDay({ ...base, status: "stop", net: -104 })).toMatchObject({ tone: "bad", line: "Stop for today · 0/5 trades · $104 of $100" });
    // a profit is no loss
    expect(railDay({ ...base, status: "clear", net: 40 }).line).toBe("Clear · 0/5 trades · $0 of $100");
  });

  it("says a new day, and that the journal is not current, as the day bar does", () => {
    expect(railDay({ ...base, status: "clear", isToday: false }).word).toBe("New day");
    expect(railDay({ ...base, status: "unknown", isToday: false, current: false })).toMatchObject({ word: "Journal not current", tone: "warn" });
  });

  it("carries the open positions' caution apart", () => {
    const open = "1 position open: its open loss isn't priced here, and rule 7 counts it; check Webull.";
    expect(railDay({ ...base, status: "clear", openLine: open }).open).toBe(open);
  });
});
