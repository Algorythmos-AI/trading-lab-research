import { describe, expect, it } from "vitest";
import { dailyCheck, inUsSession, journalCheck, lastWeekdays, OPTIONS_SLOT_UTC, RADAR_SLOT_UTC, weekdaySlots } from "@/lib/feeds";
import { auditRows } from "@/lib/v3";

const t = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("weekday slots", () => {
  it("skips the weekend both ways", () => {
    // Sat 17 Oct 2026 23:54Z: the last 21:52 slot was Fri 16 Oct, the next is Mon 19 Oct.
    const { last, next } = weekdaySlots(t("2026-10-17T23:54:00Z"), OPTIONS_SLOT_UTC);
    expect(iso(last)).toBe("2026-10-16T21:52:00.000Z");
    expect(iso(next)).toBe("2026-10-19T21:52:00.000Z");
  });

  it("counts a slot later today as next, not last", () => {
    const { last, next } = weekdaySlots(t("2026-10-14T10:00:00Z"), RADAR_SLOT_UTC);
    expect(iso(last)).toBe("2026-10-13T11:12:00.000Z");
    expect(iso(next)).toBe("2026-10-14T11:12:00.000Z");
  });
});

describe("a once-a-weekday feed", () => {
  const now = t("2026-10-15T23:30:00Z"); // Thu, after the 21:52 slot plus grace
  it("is on time when stamped after the slot", () => {
    expect(dailyCheck("2026-10-15T21:58:00Z", now, OPTIONS_SLOT_UTC).state).toBe("ok");
  });
  it("is late when the newest stamp is the day before", () => {
    expect(dailyCheck("2026-10-14T21:58:00Z", now, OPTIONS_SLOT_UTC).state).toBe("late");
  });
  it("is still running inside the grace if yesterday landed", () => {
    expect(dailyCheck("2026-10-14T21:58:00Z", t("2026-10-15T22:10:00Z"), OPTIONS_SLOT_UTC).state).toBe("due");
  });
  it("is late inside the grace if yesterday never landed either", () => {
    expect(dailyCheck("2026-10-12T21:58:00Z", t("2026-10-15T22:10:00Z"), OPTIONS_SLOT_UTC).state).toBe("late");
  });
  it("stays on time over the weekend", () => {
    expect(dailyCheck("2026-10-16T21:55:00Z", t("2026-10-18T09:00:00Z"), OPTIONS_SLOT_UTC).state).toBe("ok");
  });
  it("has no stamp to judge as late", () => {
    expect(dailyCheck(null, now, OPTIONS_SLOT_UTC).state).toBe("late");
  });
});

describe("the Webull journal", () => {
  it("knows the US session in New York time", () => {
    expect(inUsSession(t("2026-10-15T14:00:00Z"))).toBe(true); // 10:00 EDT
    expect(inUsSession(t("2026-10-15T13:00:00Z"))).toBe(false); // 09:00 EDT
    expect(inUsSession(t("2026-10-17T15:00:00Z"))).toBe(false); // Saturday
  });
  it("must be under 45 minutes old in market hours", () => {
    const now = t("2026-10-15T17:00:00Z");
    expect(journalCheck("2026-10-15T16:40:00Z", now).state).toBe("ok");
    expect(journalCheck("2026-10-15T15:30:00Z", now).state).toBe("late");
  });
  it("gives the first heartbeat of the session time to land", () => {
    expect(journalCheck("2026-10-14T21:40:00Z", t("2026-10-15T13:45:00Z")).state).toBe("ok");
  });
  it("falls back to the evening sync outside market hours", () => {
    expect(journalCheck("2026-10-16T21:40:00Z", t("2026-10-17T23:54:00Z")).state).toBe("ok");
    expect(journalCheck("2026-10-15T21:40:00Z", t("2026-10-17T23:54:00Z")).state).toBe("late");
  });
});

describe("the last weekdays", () => {
  it("lists ten weekdays ending on the latest one", () => {
    const d = lastWeekdays(t("2026-10-18T01:00:00Z"), 10);
    expect(d).toHaveLength(10);
    expect(d.at(-1)).toBe("2026-10-16");
    expect(d[0]).toBe("2026-10-05");
  });
});

describe("audit rows", () => {
  it("folds a day's routine deploys into one row and keeps everything else", () => {
    const rows = auditRows([
      { at: "2026-10-07T01:35:00Z", kind: "deploy", detail: "to aaa; smoke ok" },
      { at: "2026-10-06T23:16:00Z", kind: "deploy", detail: "to bbb; smoke ok" },
      { at: "2026-10-06T20:23:00Z", kind: "alert_fired", detail: "Trading Lab daily summary" },
      { at: "2026-10-06T09:45:00Z", kind: "deploy", detail: "to ccc; smoke ok" },
      { at: "2026-10-06T07:21:00Z", kind: "deploy", detail: "to ddd; smoke FAILED" },
      { at: "2026-10-06T04:17:00Z", kind: "kill_off", detail: null },
    ]);
    expect(rows.map((r) => [r.kind, r.count])).toEqual([
      ["deploy", 2],
      ["alert_fired", 1],
      ["deploy", 1],
      ["deploy", 1],
      ["kill_off", 1],
    ]);
    expect(rows[0]!.detail).toBe("to aaa; smoke ok");
  });
  it("does not fold deploys from different Sydney days", () => {
    const rows = auditRows([
      { at: "2026-10-07T14:00:00Z", kind: "deploy", detail: "to aaa; smoke ok" }, // Thu 8 Oct 01:00 Sydney
      { at: "2026-10-07T12:00:00Z", kind: "deploy", detail: "to bbb; smoke ok" }, // Wed 7 Oct 23:00 Sydney
    ]);
    expect(rows).toHaveLength(2);
  });
});
