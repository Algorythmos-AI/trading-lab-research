// The Engineering wikis' live state: CI lanes, job dots, the host node and the deploy stamp.
import { describe, expect, it } from "vitest";
import { ciLanes, diskTone, hostTone, jobDot, laneTone, stampIso } from "@/lib/wiki";
import { fixture } from "./helpers";

describe("ciLanes", () => {
  const runs = [
    { workflow: "security", conclusion: "success", created: "2026-10-09T02:00:00Z", branch: "main" },
    { workflow: "ci", conclusion: "failure", created: "2026-10-09T01:00:00Z", branch: "main" },
    { workflow: "ci", conclusion: "success", created: "2026-10-09T03:00:00Z", branch: "feat/x" },
    { workflow: "ci", conclusion: "", created: "2026-10-09T04:00:00Z", branch: "main" },
    { workflow: "Zeta", conclusion: "success", created: "2026-10-09T00:00:00Z", branch: "main" },
    { workflow: null, conclusion: "success", created: "2026-10-09T00:00:00Z", branch: "main" },
    null,
  ];

  it("orders known workflows the way a change meets them, then the rest by name", () => {
    expect(ciLanes(runs).map((l) => l.workflow)).toEqual(["ci", "security", "Zeta"]);
  });

  it("puts each lane oldest first and marks main, other branches and runs in progress", () => {
    const ci = ciLanes(runs)[0]!;
    expect(ci.cells.map((c) => [c.tone, c.main, c.running])).toEqual([
      ["bad", true, false],
      ["good", false, false],
      ["info", true, true],
    ]);
    expect(ci.latestMain?.conclusion).toBe("in progress");
  });

  it("keeps only the newest runs per lane", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      workflow: "ci",
      conclusion: "success",
      created: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      branch: "main",
    }));
    const lane = ciLanes(many, 30)[0]!;
    expect(lane.cells).toHaveLength(30);
    expect(lane.cells.at(-1)?.created).toBe(many.at(-1)?.created);
  });

  it("colours a path node from the newest run on main, neutral when there is none", () => {
    const lanes = ciLanes(runs);
    expect(laneTone(lanes, "security")).toBe("good");
    expect(laneTone(lanes, "ci")).toBe("info");
    expect(laneTone(lanes, "dashboard")).toBe("neutral");
  });

  it("reads the fixture snapshot's runs", () => {
    const lanes = ciLanes(fixture().platform?.runs);
    expect(lanes.map((l) => l.workflow)).toEqual(["security", "CodeQL"]);
    expect(lanes.every((l) => l.cells.length > 0)).toBe(true);
  });

  it("is empty without runs", () => {
    expect(ciLanes(null)).toEqual([]);
    expect(ciLanes([])).toEqual([]);
  });
});

describe("jobDot", () => {
  it("pulses while a job runs and names its state", () => {
    expect(jobDot({ status: "running" })).toEqual({ tone: "info", pulse: true, word: "running" });
    expect(jobDot({ status: "ok", exit: 0 })).toEqual({ tone: "good", pulse: false, word: "ok" });
    expect(jobDot({ status: "refused" }).tone).toBe("warn");
    expect(jobDot({ status: "failed" }).tone).toBe("bad");
    expect(jobDot(null)).toEqual({ tone: "neutral", pulse: false, word: "no run yet" });
  });
});

describe("hostTone", () => {
  it("is red after a failed smoke test, amber with commits waiting, green on main", () => {
    expect(hostTone({ behind: 0, smoke_ok: false }).tone).toBe("bad");
    expect(hostTone({ behind: 2, smoke_ok: true })).toEqual({ tone: "warn", word: "2 reviewed commits waiting" });
    expect(hostTone({ behind: 1, smoke_ok: true }).word).toBe("1 reviewed commit waiting");
    expect(hostTone({ behind: 0, smoke_ok: true }).tone).toBe("good");
    expect(hostTone({}).tone).toBe("neutral");
  });
});

describe("diskTone", () => {
  it("is red under the floor, amber under the target", () => {
    expect(diskTone(2.5, 3, 15)).toBe("bad");
    expect(diskTone(4, 3, 15)).toBe("warn");
    expect(diskTone(20, 3, 15)).toBe("good");
    expect(diskTone(4, 3)).toBe("good");
    expect(diskTone(null, 3, 15)).toBe("neutral");
  });
});

describe("stampIso", () => {
  it("reads a deploy record's stamp and passes ISO through", () => {
    expect(stampIso("20260929T043000Z")).toBe("2026-09-29T04:30:00Z");
    expect(stampIso("2026-09-29T04:30:00Z")).toBe("2026-09-29T04:30:00Z");
    expect(stampIso("soon")).toBeNull();
    expect(stampIso(null)).toBeNull();
  });
});
