import { describe, expect, it } from "vitest";
import { builtFromOld } from "@/lib/options";
import { radarStale } from "@/lib/radar";

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
