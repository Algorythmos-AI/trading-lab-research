import { describe, expect, it } from "vitest";
import { nextEditionDay, nyAt, radarSchedule, radarScheduleStatus } from "@/lib/radar-schedule";

const t = (iso: string) => Date.parse(iso);

describe("the next edition the routine owes", () => {
  it("skips the weekend", () => {
    expect(nextEditionDay("2026-11-06")).toBe("2026-11-09");
    expect(nextEditionDay("2026-11-09")).toBe("2026-11-10");
  });
});

describe("where the newest edition stands", () => {
  it("is up to date on a Monday morning before the build (the owner's 17:05 Sydney view)", () => {
    const s = radarScheduleStatus("2026-11-06", t("2026-11-09T06:05:00Z"));
    expect(s.state).toBe("current");
    expect(s.day).toBe("2026-11-09");
    expect(s.expected).toBe("2026-11-09T10:45:00.000Z");
  });
  it("is up to date all weekend", () => {
    expect(radarScheduleStatus("2026-11-06", t("2026-11-08T20:00:00Z")).state).toBe("current");
  });
  it("is building between 10:30 UTC and the send's grace", () => {
    expect(radarScheduleStatus("2026-11-06", t("2026-11-09T10:31:00Z")).state).toBe("building");
    expect(radarScheduleStatus("2026-11-06", t("2026-11-09T12:11:00Z")).state).toBe("building");
  });
  it("is late once 12:12 UTC passes with no newer edition", () => {
    const s = radarScheduleStatus("2026-11-06", t("2026-11-09T12:13:00Z"));
    expect(s.state).toBe("late");
    expect(s.lateAfter).toBe("2026-11-09T12:12:00.000Z");
  });
  it("moves on once the new edition is in", () => {
    const s = radarScheduleStatus("2026-11-09", t("2026-11-09T10:50:00Z"));
    expect(s.state).toBe("current");
    expect(s.day).toBe("2026-11-10");
  });
});

describe("the day's timeline", () => {
  it("anchors the build on UTC and the refresh and open on New York, across DST", () => {
    const winter = radarSchedule("2026-11-09");
    expect(winter.map((s) => s.key)).toEqual(["build", "lands", "send", "late", "premarket", "open"]);
    expect(winter.find((s) => s.key === "build")!.at).toBe("2026-11-09T10:30:00.000Z");
    expect(winter.find((s) => s.key === "open")!.at).toBe("2026-11-09T14:30:00.000Z");
    const summer = radarSchedule("2026-10-30");
    expect(summer.find((s) => s.key === "open")!.at).toBe("2026-10-30T13:30:00.000Z");
    expect(summer.find((s) => s.key === "premarket")!.at).toBe("2026-10-30T12:52:00.000Z");
  });
  it("finds New York midnight offsets on both sides of the change", () => {
    expect(new Date(nyAt("2026-11-02", 9 * 60 + 30)).toISOString()).toBe("2026-11-02T14:30:00.000Z");
    expect(new Date(nyAt("2026-10-30", 9 * 60 + 30)).toISOString()).toBe("2026-10-30T13:30:00.000Z");
  });
});
