// Each desk's kill file (no single file stops every desk): the Risk page's panel and the health banner read Gap
// Hunter's own file (gap_hunter.kill) beside the root one (kill.on), not only the root file.
import { describe, expect, it } from "vitest";
import { computeHealth } from "@/lib/health";
import { anyKillOn, deskKills, killOverall } from "@/lib/kill";
import type { Snapshot } from "@/lib/types";
import { cleanSnapshot } from "./helpers";

const IN_WINDOW = new Date("2026-09-29T12:10:00Z");
const snap = (root: boolean, gap?: boolean) =>
  ({ ...cleanSnapshot(), kill: { on: root, since: null, reason: null }, ...(gap === undefined ? {} : { gap_hunter: { kill: gap } }) }) as unknown as Snapshot;

describe("deskKills", () => {
  it("lists Gap Hunter's file and the root file", () => {
    const rows = deskKills(snap(false, true));
    expect(rows.map((r) => [r.key, r.label, r.on])).toEqual([
      ["s", "Gap Hunter", true],
      ["root", "Options clone (root KILL)", false],
    ]);
    expect(killOverall(rows)).toBe(true);
  });

  it("says Unknown, not Off, when Gap Hunter's panel was not sent", () => {
    expect(deskKills(snap(false)).map((r) => r.on)).toEqual([null, false]);
    expect(killOverall(deskKills(snap(false)))).toBeNull();
    expect(killOverall(deskKills(snap(false, false)))).toBe(false);
    expect(deskKills(null).map((r) => r.on)).toEqual([null, null]);
  });
});

describe("the health banner", () => {
  it("is AMBER when only Gap Hunter's file is on, though the root file is off", () => {
    const h = computeHealth(snap(false, true), IN_WINDOW);
    expect(h.reasons.filter((r) => r.code.startsWith("kill")).map((r) => [r.code, r.text])).toEqual([
      ["kill:s", "Gap Hunter's kill switch is on: it opens no new entries."],
    ]);
  });

  it("names the root file and Gap Hunter's apart", () => {
    const h = computeHealth(snap(true, true), IN_WINDOW);
    expect(h.reasons.map((r) => r.code).filter((c) => c.startsWith("kill"))).toEqual(["kill", "kill:s"]);
  });
});

describe("the Risk page's summary", () => {
  it("says on when only Gap Hunter's file is on, so the section opens though the root file is off", () => {
    expect(anyKillOn(snap(false, true))).toBe(true);
    expect(anyKillOn(snap(true, false))).toBe(true);
    expect(anyKillOn(snap(false, false))).toBe(false);
    expect(anyKillOn(snap(false))).toBeNull();
  });
});
