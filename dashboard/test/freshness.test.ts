import { describe, expect, it } from "vitest";
import { assumedWindow, etOffsetMin, freshness } from "@/lib/freshness";

const t = (iso: string) => Date.parse(iso);
const PUBLISHED = [{ session: "2026-09-29", start: "2026-09-29T11:30:00+00:00", end: "2026-09-29T22:00:00+00:00" }];

describe("assumed weekday windows (after the published horizon)", () => {
  it("reads New York's offset through daylight saving", () => {
    expect(etOffsetMin(t("2026-10-01T13:00:00Z"))).toBe(-240);
    expect(etOffsetMin(t("2026-11-02T13:00:00Z"))).toBe(-300);
  });

  it("is 07:30-18:00 ET on weekdays only", () => {
    expect(assumedWindow(t("2026-10-01T13:00:00Z"))).toEqual({
      session: "2026-10-01",
      start: "2026-10-01T11:30:00.000Z",
      end: "2026-10-01T22:00:00.000Z",
    });
    expect(assumedWindow(t("2026-11-02T13:00:00Z"))?.start).toBe("2026-11-02T12:30:00.000Z"); // EST
    expect(assumedWindow(t("2026-10-01T11:00:00Z"))).toBeNull(); // 07:00 ET
    expect(assumedWindow(t("2026-10-01T22:30:00Z"))).toBeNull(); // 18:30 ET
    expect(assumedWindow(t("2026-10-03T15:00:00Z"))).toBeNull(); // Saturday
  });

  it("is used only once every published window has ended", () => {
    const after = freshness("2026-09-29T12:00:00Z", PUBLISHED, t("2026-10-01T13:00:00Z"));
    expect(after).toMatchObject({ state: "stopped", inWindow: true, assumed: true });
    const ahead = freshness(
      "2026-09-29T12:00:00Z",
      [{ session: "2026-10-09", start: "2026-10-09T11:30:00+00:00", end: "2026-10-09T22:00:00+00:00" }],
      t("2026-10-01T13:00:00Z"),
    );
    expect(ahead).toMatchObject({ state: "asleep", inWindow: false, assumed: false });
    const inside = freshness("2026-09-29T12:00:00Z", PUBLISHED, t("2026-09-29T13:00:00Z"));
    expect(inside).toMatchObject({ state: "late", assumed: false });
  });
});
