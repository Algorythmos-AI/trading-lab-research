// The Today page's helpers: the pre-market scan as a person reads it, from fields the snapshot already carries.
import { describe, expect, it } from "vitest";
import { summarize } from "@/lib/summary";
import { CLOCK_TO, detailLabel, eventLabel, scan, scanSentence, sessionClock, why } from "@/lib/today";
import type { Snapshot } from "@/lib/types";
import { fixture } from "./helpers";

// The morning of Mon 2026-10-05 as the host published it (numbers from its stage files; the ticker is invented).
const stats = (traded: number, kept: number) => ({ universe: 4351, snapshot_symbols: traded, kept, split_checked: 0, float_unknown: 8 });
function morning(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ...fixture(),
    market: { phase: "pre-market", et: "Mon 05 Oct 09:04 EDT", sydney: "Tue 06 Oct 00:04 AEDT", trading_day_et: "2026-10-05" },
    ops: {
      ...fixture().ops,
      routine: {
        date: "2026-10-05",
        stages: [
          { stage: "tier1", as_of_et: "08:00", feed: "hybrid", stats: stats(688, 40), counts: { tier1: 0 }, tier1: [], tier2: [], primary: null },
          { stage: "charts", as_of_et: "08:30", feed: "hybrid", stats: stats(762, 47), counts: { tier1: 1, charts: 1 }, tier1: [{ symbol: "ZZZA", score: 3.2 }], tier2: [], primary: null },
          { stage: "tier2", as_of_et: "09:00", feed: "hybrid", stats: stats(801, 47), counts: { tier1: 1, charts: 1, tier2: 0 }, tier1: [{ symbol: "ZZZA", score: 3.4 }], tier2: [], primary: null },
        ],
      },
    },
    ...over,
  } as Snapshot;
}

describe("the pre-market scan", () => {
  it("reads each stage's funnel and the newest candidate list", () => {
    const v = scan(morning());
    expect(v.current).toBe(true);
    expect(v.stages.map((x) => [x.label, x.at, x.traded, x.gapping, x.candidates, x.shortList])).toEqual([
      ["First scan", "08:00", 688, 40, 0, null],
      ["Chart checks", "08:30", 762, 47, 1, null],
      ["Short list", "09:00", 801, 47, 1, 0],
    ]);
    expect(v.latest?.key).toBe("tier2");
    expect(v.candidates).toEqual([{ symbol: "ZZZA", score: 3.4, shortListed: false, primary: false }]);
  });

  it("marks the short list and the primary pick, and counts tickets and signals", () => {
    const s = morning();
    const stages = s.ops!.routine!.stages!;
    stages[2] = { ...stages[2]!, tier2: ["ZZZA"], primary: "ZZZA", counts: { tier1: 1, tier2: 1 } };
    stages.push({ stage: "tickets", as_of_et: "09:15", stats: stats(820, 47), counts: { tier1: 1, tier2: 1, tickets: 1 }, tier1: [{ symbol: "ZZZA", score: 3.4 }], tier2: ["ZZZA"], primary: "ZZZA" });
    stages.push({ stage: null, as_of_et: null, stats: {}, counts: { tier2: 1, signals: 2 }, tier1: [], tier2: ["ZZZA"], primary: null });
    const v = scan(s);
    expect(v.candidates[0]).toMatchObject({ shortListed: true, primary: true });
    expect(v.latest?.key).toBe("tickets"); // the signals check is not a scan
    expect(v.stages.at(-1)).toMatchObject({ key: "signals", label: "Signals", at: null, signals: 2 });
    expect(scanSentence(s)).toBe("Pre-market: 820 scanned, 47 gapping, 1 candidate, 1 trade plan.");
  });

  it("never describes an older session as today's", () => {
    const stale = morning({ market: { phase: "overnight", trading_day_et: "2026-10-06" } });
    expect(scan(stale)).toMatchObject({ current: false, date: "2026-10-05" });
    expect(scanSentence(stale)).toBeNull();
    expect(scanSentence(fixture())).toBeNull(); // the fixture's scan is from the day before its trading day
    expect(scan({ schema: null, schema_version: null, run_id: null, as_of: null })).toMatchObject({ date: null, current: false, stages: [], candidates: [] });
  });

  it("adds the scan to the summary sentence, with counts only", () => {
    expect(scanSentence(morning())).toBe("Pre-market: 801 scanned, 47 gapping, 1 candidate.");
    const text = summarize(morning());
    expect(text).toContain("Pre-market: 801 scanned, 47 gapping, 1 candidate.");
    expect(text).not.toMatch(/\$|ZZZA/); // never money, never a ticker in the one-line summary
  });
});

describe("why names went no further", () => {
  const record = { n_kept: 44, n_passed: 1, n_tier1: 1, n_chart_ok: 0, n_tier2: 0, n_primary: 0, drop_rvol: 30, sole_rvol: 4, drop_float_unknown: 11,
    drop_catalyst_missing: 38, sole_catalyst_missing: 9, chart_trend: 1, chart_pm_consolidation: 1, band2_20_kept: 29, band2_20_passed: 1, band2_20_tier1: 1,
    band2_20_tier2: 0 };

  it("is absent until a host publishes the counts, so an older host changes nothing on the page", () => {
    expect(scan(morning()).why).toBeNull();
    expect(scan(fixture()).why).toBeNull();
    expect(why(undefined, null)).toBeNull();
  });

  it("reads the newest scan stage's steps, reasons, chart checks and the band count", () => {
    const s = morning();
    const stages = s.ops!.routine!.stages!;
    stages[2] = { ...stages[2]!, stats: { ...stats(801, 44), ...record } };
    stages.push({ stage: null, as_of_et: null, stats: {}, counts: { signals: 0 }, tier1: [], tier2: [], primary: null });
    const w = scan(s).why!;
    expect(w.at).toBe("09:00"); // the signals check is not a scan
    expect(w.steps.map((x) => [x.label, x.count])).toEqual([["Gapping up", 44], ["Passed every filter", 1], ["Candidates", 1], ["Passed the chart checks", 0], ["Short list", 0], ["First pick", 0]]);
    expect(w.reasons.map((x) => [x.code, x.count, x.only])).toEqual([["catalyst_missing", 38, 9], ["rvol", 30, 4], ["float_unknown", 11, 0]]);
    expect(w.reasons[0]!.label).toBe("No qualifying news");
    expect(w.chart.map((x) => x.label)).toEqual(["Not holding near its pre-market high", "Not in an uptrend"]);
    expect(w.band.map((x) => [x.code, x.count])).toEqual([["kept", 29], ["passed", 1], ["tier1", 1], ["tier2", 0]]);
    expect(w.failed).toBe(false);
  });

  it("shows a code it has no words for, and says when the host could not build the record", () => {
    expect(why({ n_kept: 3, drop_something_new: 2 }, "08:00")!.reasons).toEqual([{ code: "something_new", label: "something_new", count: 2, only: 0 }]);
    expect(why({ explain_error: 1 }, "08:00")).toMatchObject({ failed: true, steps: [] });
    expect(why({ n_kept: "44" }, "08:00")).toBeNull(); // a number sent as text is not a count
  });
});

describe("plain words for the runner's log", () => {
  it("translates known events and codes and passes unknown ones through", () => {
    expect(eventLabel("armed")).toBe("Armed for the session");
    expect(eventLabel("some_new_event")).toBe("some_new_event");
    expect(eventLabel(null)).toBe("—");
    expect(detailLabel("kill_file, stale_signal_data")).toBe("kill switch on, signal data too old");
    expect(detailLabel("2026-10-05")).toBe("2026-10-05");
    expect(detailLabel(null)).toBe("");
  });
});

describe("the session clock", () => {
  const day = (jobs: Record<string, unknown>) =>
    ({ ...fixture(), market: { phase: "open", trading_day_et: "2026-10-05" }, jobs: { last: jobs } }) as unknown as Snapshot;

  it("places each job's run on the New York day, beside its scheduled start", () => {
    const c = sessionClock(
      day({
        routine: { status: "ok", started: "2026-10-05T11:30:02Z", ended: "2026-10-05T15:31:40Z" },
        "paper-b": { status: "running", started: "2026-10-05T12:30:01Z" },
        forward: { status: "failed", started: "2026-10-02T19:40:00Z", ended: "2026-10-02T20:41:00Z" },
      }),
    );
    expect(c.day).toBe("2026-10-05");
    const [routine, paper, forward] = c.runs;
    expect(routine).toMatchObject({ key: "routine", at: 450, from: 450, to: 691, tone: "good", running: false });
    // Still running: no end, so the browser draws it to "now"; amber, not the status tone.
    expect(paper).toMatchObject({ key: "paper-b", at: 510, from: 510, to: null, tone: "warn", running: true });
    // Its last run was an earlier day: only the scheduled tick is drawn.
    expect(forward).toMatchObject({ key: "forward", at: 940, from: null, to: null, tone: "bad" });
  });

  it("draws a run that ends after midnight to the end of the day", () => {
    const c = sessionClock(day({ forward: { status: "ok", started: "2026-10-05T19:40:00Z", ended: "2026-10-06T05:00:00Z" } }));
    expect(c.runs.find((r) => r.key === "forward")).toMatchObject({ from: 940, to: CLOCK_TO });
  });

  it("has a lane for each job even before any has run", () => {
    expect(sessionClock(day({})).runs.map((r) => [r.key, r.from])).toEqual([
      ["routine", null],
      ["paper-b", null],
      ["forward", null],
    ]);
  });
});
