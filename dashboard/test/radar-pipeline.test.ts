// The Radar page's pipeline: the stages of a session's run from what the store holds, as pure functions of one
// observation and the clock (radar-pipeline.ts); the summary the cron writes (radar-pipeline-run.ts, on a store in
// memory); the fixture's variants; and the card as it is drawn. Everything here is synthetic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineClock, pipelineView, PIPELINE_TICK_MS, RadarPipelineView, resetPipelineClock } from "@/components/client/radar-pipeline";
import { RadarSchedulePanel } from "@/components/radar-schedule";
import { feedById, slotsAround, type DocFeed } from "@/lib/feed-watch";
import { weekDate } from "@/lib/format";
import { VARIANT_FLAGS, type VariantFlag } from "@/lib/fixture-variants";
import {
  beaconObs,
  emptyObs,
  firstReceipt,
  funnelObs,
  headlineOf,
  levelsStamp,
  mergeObs,
  nowBefore,
  parsePipelineFile,
  type PipelineFile,
  pipelineDays,
  pipelineStale,
  reliabilityOf,
  scheduleOf,
  serializePipelineFile,
  sessionMark,
  type SessionObs,
  spanWords,
  stageRows,
  stampedOn,
  STAGE_KEYS,
} from "@/lib/radar-pipeline";
import { fixturePipeline, RADAR_HOLIDAY_NOW } from "@/lib/radar-pipeline-fixture";
import { type PipelineDeps, loadRadarPipeline, observeSession, refreshRadarPipeline, startRadarPipelineRefresh } from "@/lib/radar-pipeline-run";
import { RADAR_PIPELINE_PATH, RADAR_ROUTINES } from "@/lib/radar-pipeline-slots";
import funnelJson from "./fixtures/funnel.v1.json";
import runJson from "./fixtures/radar-run.v1.json";

const t = (iso: string) => Date.parse(iso);
const S = "2026-11-19"; // a Thursday session; New York is five hours behind UTC
const P = "2026-11-18";

/** Thursday's run as a clean morning leaves it. */
function clean(over: Partial<SessionObs> = {}): SessionObs {
  return {
    session: S,
    levels_at: "2026-11-18T21:58:00.000Z",
    beacons: {
      build: { state: "finished", trigger: "scheduled", started_at: "2026-11-19T10:30:20.000Z", ended_at: "2026-11-19T10:43:00.000Z", reason: "ok" },
      send: { state: "finished", trigger: "scheduled", started_at: "2026-11-19T10:43:10.000Z", ended_at: "2026-11-19T10:44:00.000Z", reason: "ok" },
    },
    stored_at: "2026-11-19T10:44:00.000Z",
    edition_on_file: true,
    refused_at: null,
    desk_at: "2026-11-19T11:16:00.000Z",
    preopen_at: "2026-11-19T13:52:00.000Z",
    card_at: "2026-11-19T14:12:00.000Z",
    funnel: null,
    complete: true,
    ...over,
  };
}
const states = (obs: SessionObs | null, now: string, session = S) => Object.fromEntries(stageRows(session, obs, t(now)).map((r) => [r.key, r.state]));
const headline = (obs: SessionObs | null, now: string, scheduleOnly = false) => {
  const days = pipelineDays(t(now));
  return headlineOf(days, obs, stageRows(days.focus, obs, t(now)), t(now), scheduleOnly);
};

describe("the schedule", () => {
  it("is New York clock times, with the levels on the session day before", () => {
    const s = scheduleOf(S);
    expect(new Date(s.levels.scheduled).toISOString()).toBe("2026-11-18T21:52:00.000Z");
    expect(new Date(s.build.scheduled).toISOString()).toBe("2026-11-19T10:30:00.000Z");
    expect(new Date(s.stored.scheduled).toISOString()).toBe("2026-11-19T10:45:00.000Z");
    expect(new Date(s.preopen.scheduled).toISOString()).toBe("2026-11-19T13:50:00.000Z");
    expect(new Date(s.card.scheduled).toISOString()).toBe("2026-11-19T14:11:00.000Z");
    expect(new Date(s.open.scheduled).toISOString()).toBe("2026-11-19T14:30:00.000Z");
  });

  it("the levels of a Monday are Friday's, and of the day after a holiday the session before it", () => {
    expect(new Date(scheduleOf("2026-11-23").levels.scheduled).toISOString()).toBe("2026-11-20T21:52:00.000Z");
    // Thanksgiving, Thursday 2026-11-26, is shut: Friday's levels are Wednesday's.
    expect(new Date(scheduleOf("2026-11-27").levels.scheduled).toISOString()).toBe("2026-11-25T21:52:00.000Z");
  });

  it("takes each deadline from the feed watch's own row, so the page and the alerts go by one rule", () => {
    const radar = feedById("radar") as DocFeed;
    const run = slotsAround(radar, t(`${S}T17:00:00Z`)).find((x) => x.day === S)!;
    const s = scheduleOf(S);
    expect(s.stored.deadline).toBe(run.deadline);
    expect(new Date(s.stored.deadline).toISOString()).toBe("2026-11-19T12:12:00.000Z");
    expect(new Date(s.preopen.deadline).toISOString()).toBe("2026-11-19T14:05:00.000Z");
    expect(new Date(s.evidence.deadline).toISOString()).toBe("2026-11-19T14:15:00.000Z");
    // The ledger's and the desk file's rows are not verified: a miss there is "no record", never "late".
    expect(s.card.verified).toBe(false);
    expect(s.evidence.verified).toBe(false);
    expect(s.stored.verified).toBe(true);
  });

  it("in summer the send's UTC slot is an hour later in New York, and an edition inside it is still on time", () => {
    // Monday 2026-10-12, New York four hours behind: the deadline is 12:12 UTC, 08:12 New York.
    const s = scheduleOf("2026-10-12");
    expect(new Date(s.stored.deadline).toISOString()).toBe("2026-10-12T12:12:00.000Z");
    const obs = { ...emptyObs("2026-10-12"), stored_at: "2026-10-12T10:46:00.000Z", edition_on_file: true };
    expect(sessionMark("2026-10-12", obs, t("2026-10-12T20:00:00Z"))).toBe("on_time");
  });
});

describe("the days", () => {
  it("a session day is in view, with the twenty sessions before it", () => {
    const d = pipelineDays(t("2026-11-19T11:00:00Z"));
    expect(d).toMatchObject({ ny_day: S, today_is_session: true, focus: S, previous: P });
    expect(d.sessions).toHaveLength(21);
    expect(d.sessions.at(-1)).toBe(S);
    expect(d.sessions).not.toContain("2026-11-14"); // a Saturday
  });

  it("a US holiday is no session, and the next session is in view", () => {
    const d = pipelineDays(t(RADAR_HOLIDAY_NOW));
    expect(d).toMatchObject({ ny_day: "2026-11-26", today_is_session: false, focus: "2026-11-27", previous: "2026-11-25" });
    expect(d.sessions).not.toContain("2026-11-26");
  });

  it("a weekend is no session", () => {
    expect(pipelineDays(t("2026-11-21T15:00:00Z"))).toMatchObject({ today_is_session: false, focus: "2026-11-23", previous: "2026-11-20" });
  });
});

describe("the rows", () => {
  it("on time: every stage done, each with its minutes against its time and who did it", () => {
    const rows = stageRows(S, clean(), t("2026-11-19T15:00:00Z"));
    expect(rows.map((r) => r.key)).toEqual([...STAGE_KEYS]);
    expect(rows.map((r) => r.state)).toEqual(["done", "done", "done", "done", "done", "done", "done"]);
    expect(rows.map((r) => r.delta_min)).toEqual([6, 0, -1, 4, 2, 1, 0]);
    expect(rows.find((r) => r.key === "build")!.who).toBe("scheduled");
    expect(rows.find((r) => r.key === "stored")!.who).toBe("scheduled");
    expect(headline(clean(), "2026-11-19T15:00:00Z")).toMatchObject({ kind: "on_time", word: "On time", tone: "good" });
  });

  it("before anything: the levels are in, the rest is not due", () => {
    const obs = { ...emptyObs(S), levels_at: "2026-11-18T21:58:00.000Z" };
    expect(states(obs, "2026-11-19T08:00:00Z")).toEqual({ levels: "done", build: "not_due", stored: "not_due", evidence: "not_due", preopen: "not_due", card: "not_due", open: "not_due" });
    expect(headline(obs, "2026-11-19T08:00:00Z")).toMatchObject({ kind: "not_due", word: "Not due yet" });
    expect(nowBefore(stageRows(S, obs, t("2026-11-19T08:00:00Z")), t("2026-11-19T08:00:00Z"))).toBe(1);
  });

  it("building: the build said it started; the edition is waited for", () => {
    const obs: SessionObs = { ...emptyObs(S), beacons: { build: { state: "started", trigger: "scheduled", started_at: "2026-11-19T10:30:20.000Z", ended_at: null, reason: null } } };
    expect(states(obs, "2026-11-19T10:50:00Z")).toMatchObject({ build: "running", stored: "waiting", evidence: "not_due" });
    expect(headline(obs, "2026-11-19T10:50:00Z")).toMatchObject({ kind: "building", word: "Building now", tone: "info" });
  });

  it("a build that started and then said nothing for an hour is late, not running for ever", () => {
    const obs: SessionObs = { ...emptyObs(S), beacons: { build: { state: "started", trigger: "scheduled", started_at: "2026-11-19T10:30:20.000Z", ended_at: null, reason: null } } };
    const build = stageRows(S, obs, t("2026-11-19T11:45:00Z")).find((r) => r.key === "build")!;
    expect(build).toMatchObject({ state: "late", code: "quiet" });
  });

  it("late: the deadline passed with nothing stored, and the badge counts from the scheduled time", () => {
    const obs = { ...emptyObs(S), levels_at: "2026-11-18T21:58:00.000Z" };
    expect(states(obs, "2026-11-19T12:11:00Z").stored).toBe("waiting");
    expect(states(obs, "2026-11-19T12:13:00Z").stored).toBe("late");
    expect(headline(obs, "2026-11-19T12:13:00Z")).toMatchObject({ kind: "late", word: "Late by 1 h 28 min", tone: "bad" });
  });

  it("late: stored after the deadline is never on time (the edition that came 3 h 7 min behind)", () => {
    const obs = clean({ beacons: {}, stored_at: "2026-11-19T13:52:00.000Z", desk_at: null });
    const h = headline(obs, "2026-11-19T15:00:00Z");
    expect(h).toMatchObject({ kind: "late", word: "Late by 3 h 7 min", tone: "bad", late_min: 187 });
    expect(stageRows(S, obs, t("2026-11-19T15:00:00Z")).find((r) => r.key === "stored")).toMatchObject({ state: "done", delta_min: 187, who: "unknown" });
  });

  it("by hand: a person started the run, and the badge says so whenever it arrived", () => {
    const hand = clean({ beacons: { build: { state: "finished", trigger: "manual", started_at: "2026-11-19T13:30:00.000Z", ended_at: "2026-11-19T13:50:00.000Z", reason: "ok" } }, stored_at: "2026-11-19T13:52:00.000Z" });
    expect(headline(hand, "2026-11-19T15:00:00Z")).toMatchObject({ kind: "by_hand", word: "Built by hand", tone: "warn", late_min: 187 });
    expect(stageRows(S, hand, t("2026-11-19T15:00:00Z")).find((r) => r.key === "build")!.who).toBe("manual");
    // Even inside the deadline it is not "On time".
    const early = clean({ beacons: { build: { state: "finished", trigger: "manual", started_at: "2026-11-19T10:31:00.000Z", ended_at: "2026-11-19T10:43:00.000Z", reason: "ok" } } });
    expect(headline(early, "2026-11-19T15:00:00Z")).toMatchObject({ kind: "by_hand", word: "Built by hand", late_min: null });
  });

  it("refused: the ingest refused the edition and nothing is stored", () => {
    const obs: SessionObs = { ...clean({ stored_at: null, edition_on_file: false, desk_at: null, preopen_at: null, card_at: null }), refused_at: "2026-11-19T10:44:30.000Z" };
    const stored = stageRows(S, obs, t("2026-11-19T11:00:00Z")).find((r) => r.key === "stored")!;
    expect(stored).toMatchObject({ state: "failed", code: "refused" });
    expect(headline(obs, "2026-11-19T11:00:00Z")).toMatchObject({ kind: "failed", word: "Edition refused", tone: "bad" });
    // A later good edition clears it: the stage is done.
    expect(states({ ...obs, stored_at: "2026-11-19T11:05:00.000Z" }, "2026-11-19T11:10:00Z").stored).toBe("done");
  });

  it("failed: the build said it failed, with its closed reason", () => {
    const obs: SessionObs = { ...emptyObs(S), beacons: { build: { state: "failed", trigger: "scheduled", started_at: "2026-11-19T10:30:20.000Z", ended_at: "2026-11-19T10:31:00.000Z", reason: "tools-missing" } } };
    expect(stageRows(S, obs, t("2026-11-19T10:40:00Z")).find((r) => r.key === "build")).toMatchObject({ state: "failed", code: "tools-missing", who: "scheduled" });
    expect(headline(obs, "2026-11-19T10:40:00Z")).toMatchObject({ kind: "failed", word: "Build failed" });
    const send: SessionObs = { ...emptyObs(S), beacons: { send: { state: "failed", trigger: "catch-up", started_at: "2026-11-19T11:12:00.000Z", ended_at: "2026-11-19T11:13:00.000Z", reason: "not-stored" } } };
    expect(headline(send, "2026-11-19T11:20:00Z")).toMatchObject({ kind: "failed", word: "Send failed" });
  });

  it("no beacon: the build says no record, never a guess, and the badge goes by the receipt time alone", () => {
    const obs = clean({ beacons: {} });
    const rows = stageRows(S, obs, t("2026-11-19T15:00:00Z"));
    expect(rows.find((r) => r.key === "build")).toMatchObject({ state: "no_record", at: null, who: "unknown", code: "no-beacon" });
    expect(rows.find((r) => r.key === "stored")).toMatchObject({ state: "done", who: "unknown" });
    expect(headline(obs, "2026-11-19T15:00:00Z").kind).toBe("on_time");
    // Before the build's time there is nothing to have a record of.
    expect(states({ ...emptyObs(S) }, "2026-11-19T10:00:00Z").build).toBe("not_due");
  });

  it("an unverified stage with nothing seen is no record, not late; a verified one is late", () => {
    const obs = clean({ desk_at: null, preopen_at: null, card_at: null });
    expect(states(obs, "2026-11-19T16:00:00Z")).toMatchObject({ evidence: "no_record", preopen: "late", card: "no_record", open: "done" });
  });

  it("an edition on file with no receipt time is no record, and the badge says nothing of its timing", () => {
    const obs = { ...emptyObs(S), edition_on_file: true };
    expect(states(obs, "2026-11-19T15:00:00Z").stored).toBe("no_record");
    expect(headline(obs, "2026-11-19T15:00:00Z")).toMatchObject({ kind: "waiting", word: "No record" });
    expect(sessionMark(S, obs, t("2026-11-19T15:00:00Z"))).toBe("no_record");
  });

  it("a skipped build: no session is not due; already stored says nothing of who built it", () => {
    const skipped = (reason: string): SessionObs => ({ ...clean(), beacons: { build: { state: "skipped", trigger: "catch-up", started_at: "2026-11-19T11:30:00.000Z", ended_at: "2026-11-19T11:30:05.000Z", reason } } });
    expect(stageRows(S, skipped("already-stored"), t("2026-11-19T15:00:00Z")).find((r) => r.key === "build")).toMatchObject({ state: "done", at: null, who: "unknown" });
    expect(stageRows(S, skipped("no-session"), t("2026-11-19T15:00:00Z")).find((r) => r.key === "build")!.state).toBe("not_due");
    expect(stageRows(S, skipped("lock-held"), t("2026-11-19T15:00:00Z")).find((r) => r.key === "build")!.state).toBe("running");
    expect(stageRows(S, skipped("blocked"), t("2026-11-19T15:00:00Z")).find((r) => r.key === "build")!.state).toBe("failed");
  });

  it("holiday: no session today, whatever the store holds; the rail is the next session's schedule", () => {
    const now = RADAR_HOLIDAY_NOW;
    const days = pipelineDays(t(now));
    const rows = stageRows(days.focus, null, t(now));
    expect(headlineOf(days, null, rows, t(now))).toMatchObject({ kind: "no_session", word: "No session today", tone: "neutral" });
    expect(rows.every((r) => r.state === "not_due" || r.key === "levels")).toBe(true);
    expect(rows.map((r) => r.state)).not.toContain("late");
  });

  it("schedule only: with no summary nothing is late, failed or done but the open", () => {
    expect(states(null, "2026-11-19T15:00:00Z")).toEqual({ levels: "no_record", build: "no_record", stored: "no_record", evidence: "no_record", preopen: "no_record", card: "no_record", open: "done" });
    expect(states(null, "2026-11-19T09:00:00Z")).toMatchObject({ levels: "no_record", build: "not_due", open: "not_due" });
    expect(headline(null, "2026-11-19T15:00:00Z", true)).toMatchObject({ kind: "schedule_only", word: "Schedule only" });
  });

  it("says a span in hours and minutes", () => {
    expect([spanWords(187), spanWords(42), spanWords(60), spanWords(0)]).toEqual(["3 h 7 min", "42 min", "1 h", "0 min"]);
  });
});

describe("the last sessions", () => {
  it("marks each by its receipt time against its deadline, and gives the on-time rate over those with a record", () => {
    const now = t("2026-11-19T15:00:00Z");
    const days = pipelineDays(now);
    const [a, b, c, d, e] = days.sessions.slice(-6, -1) as [string, string, string, string, string];
    const at = (session: string, hhmm: string) => ({ ...emptyObs(session), stored_at: `${session}T${hhmm}:00.000Z`, edition_on_file: true });
    const file: PipelineFile = {
      v: 1,
      generated_at: new Date(now).toISOString(),
      sessions: [
        at(a, "10:44"),
        at(b, "13:53"),
        { ...at(c, "13:53"), beacons: { build: { state: "finished", trigger: "manual", started_at: `${c}T13:30:00.000Z`, ended_at: `${c}T13:50:00.000Z`, reason: "ok" } } },
        emptyObs(d),
        { ...emptyObs(e), edition_on_file: true },
      ],
    };
    const r = reliabilityOf(days, file, now);
    expect(r.marks).toHaveLength(20);
    expect(r.marks.slice(-5).map((m) => m.mark)).toEqual(["on_time", "late", "by_hand", "missed", "no_record"]);
    // The fifteen sessions the summary does not hold are no record, and stay out of the rate.
    expect(r).toMatchObject({ on_time: 1, late: 1, by_hand: 1, missed: 1, no_record: 16, counted: 4, rate: 0.25 });
    expect(reliabilityOf(days, null, now).rate).toBeNull();
  });

  it("a session whose deadline has not passed is pending, not missed", () => {
    expect(sessionMark(S, emptyObs(S), t("2026-11-19T11:00:00Z"))).toBe("pending");
    expect(sessionMark(S, emptyObs(S), t("2026-11-19T12:13:00Z"))).toBe("missed");
  });
});

describe("reading what the store holds", () => {
  it("a beacon is read for its own session and stage only, and anything else is dropped", () => {
    expect(beaconObs(runJson, "2026-10-12", "build")).toEqual({ state: "finished", trigger: "scheduled", started_at: "2026-10-12T10:52:03.000Z", ended_at: "2026-10-12T11:04:09.000Z", reason: "ok" });
    expect(beaconObs(runJson, "2026-10-13", "build")).toBeNull();
    expect(beaconObs(runJson, "2026-10-12", "send")).toBeNull();
    expect(beaconObs({ ...runJson, trigger: "cron" }, "2026-10-12", "build")).toBeNull();
    expect(beaconObs({ ...runJson, reason: "<b>free text</b>" }, "2026-10-12", "build")!.reason).toBeNull();
    expect(beaconObs(null, "2026-10-12", "build")).toBeNull();
  });

  it("the first receipt is the store's own time, from the copies' paths; a lost marker counts", () => {
    const paths = [
      "radar/copies/2026-11-19/20261119T135301123Z-run-b.json",
      "radar/copies/2026-11-19/20261119T104412005Z-run-a.lost.json",
      "radar/copies/2026-11-18/20261118T104400000Z-run-z.json",
      "radar/copies/2026-11-19/notes.txt",
    ];
    expect(firstReceipt(paths, "radar/copies/", S)).toBe("2026-11-19T10:44:12.005Z");
    expect(firstReceipt(paths, "radar/copies/", "2026-11-17")).toBeNull();
    expect(firstReceipt([], "radar/copies/", S)).toBeNull();
  });

  it("the funnel's document gives statuses and counts, and nothing else", () => {
    const f = funnelObs(funnelJson, "2026-10-13")!;
    expect(f.radar).toEqual({ evidence: "present", kept_at: "2026-10-12T11:13:02.000Z", judged: null, kept: 42, flagged: 0, replay: "not_run" });
    expect(f.focus).toEqual({ evidence: "present", kept_at: "2026-10-12T22:19:48.000Z", judged: 12, kept: 4, flagged: 2, replay: "match" });
    expect(funnelObs(funnelJson, "2026-10-12")).toBeNull();
    expect(funnelObs({ session: "2026-10-13", stages: "x" }, "2026-10-13")).toBeNull();
    expect(funnelObs({ session: "2026-10-13", stages: [{ stage: "focus_pick", evidence: "present", names_kept: -3, names_judged: "12" }] }, "2026-10-13")!.focus).toMatchObject({ kept: null, judged: null });
  });

  it("a stamp counts only for the day it was made on", () => {
    expect(stampedOn({ as_of: "2026-11-19T14:12:00Z" }, S, 16 * 60)).toBe("2026-11-19T14:12:00.000Z");
    expect(stampedOn({ as_of: "2026-11-19T21:25:00Z" }, S, 16 * 60)).toBeNull(); // after the close: not the morning's
    expect(stampedOn({ as_of: "2026-11-18T14:12:00Z" }, S)).toBeNull();
    expect(stampedOn({ as_of: "soon" }, S)).toBeNull();
    expect(levelsStamp({ session: S, as_of: "2026-11-18T21:58:00Z" }, S)).toBe("2026-11-18T21:58:00.000Z");
    expect(levelsStamp({ session: S, as_of: "2026-11-19T13:52:00Z" }, S)).toBeNull(); // the pre-open refresh's stamp
  });

  it("the summary is parsed field by field: a bad field is dropped, a bad session left out, the rest stands", () => {
    const good = clean({ funnel: funnelObs(funnelJson, "2026-10-13") });
    const text = JSON.stringify({
      v: 1,
      generated_at: "2026-11-19T15:00:00Z",
      sessions: [
        { ...good, stored_at: "not a time", card_at: 12, beacons: { build: good.beacons.build, send: { state: "exploded" }, extra: { state: "finished" } }, note: "<script>" },
        { session: "yesterday" },
        null,
        { session: P },
        { session: P, stored_at: "2026-11-18T10:44:00Z" },
      ],
    });
    const f = parsePipelineFile(text)!;
    expect(f.sessions.map((s) => s.session)).toEqual([P, S]);
    const s = f.sessions[1]!;
    expect(s).toMatchObject({ stored_at: null, card_at: null, desk_at: good.desk_at, edition_on_file: true });
    expect(Object.keys(s.beacons)).toEqual(["build"]);
    expect(s).not.toHaveProperty("note");
    expect(s.funnel?.focus?.kept).toBe(4);
    expect(f.sessions[0]).toEqual({ ...emptyObs(P), complete: false });
    for (const bad of [null, "", "{", "[]", '{"v":2,"generated_at":"2026-11-19T15:00:00Z","sessions":[]}', '{"v":1,"sessions":[]}', '{"v":1,"generated_at":"x","sessions":[]}']) expect(parsePipelineFile(bad)).toBeNull();
    expect(parsePipelineFile(serializePipelineFile(f))).toEqual(f);
  });

  it("a time once seen stays; beacons and the refusal are the newest look's", () => {
    const first = { ...emptyObs(S), card_at: "2026-11-19T14:12:00.000Z", refused_at: "2026-11-19T10:44:30.000Z", beacons: { build: clean().beacons.build! } };
    const later = { ...emptyObs(S), stored_at: "2026-11-19T11:05:00.000Z", edition_on_file: true, beacons: { send: clean().beacons.send! } };
    const m = mergeObs(first, later);
    expect(m).toMatchObject({ card_at: "2026-11-19T14:12:00.000Z", stored_at: "2026-11-19T11:05:00.000Z", refused_at: null, edition_on_file: true });
    expect(Object.keys(m.beacons).sort()).toEqual(["build", "send"]);
    // A look that could not read the beacons or the refusal keeps what it had.
    expect(mergeObs(first, emptyObs(S), { beacons: false, refusal: false })).toMatchObject({ refused_at: first.refused_at, beacons: first.beacons });
  });

  it("is old after three missed ticks", () => {
    const f: PipelineFile = { v: 1, generated_at: "2026-11-19T15:00:00.000Z", sessions: [] };
    expect(pipelineStale(f, t("2026-11-19T15:29:00Z"))).toBe(false);
    expect(pipelineStale(f, t("2026-11-19T15:31:00Z"))).toBe(true);
    expect(pipelineStale(null, t("2026-11-19T15:31:00Z"))).toBe(false);
  });
});

// ---- the cron's run, on a store in memory ---------------------------------------------------------------------------

function memory(nowIso: string) {
  const docs = new Map<string, string>();
  const beacons = new Map<string, unknown[]>();
  const calls = { read: [] as string[], list: [] as string[], beacons: [] as string[], refusal: 0 };
  const broken = new Set<string>();
  const state = { now: t(nowIso), refusal: { at: null as string | null, current: false }, logs: [] as Record<string, unknown>[] };
  const deps: PipelineDeps = {
    read: async (path) => {
      calls.read.push(path);
      if (broken.has(path)) throw new Error("store down");
      return docs.get(path) ?? null;
    },
    list: async (prefix) => {
      calls.list.push(prefix);
      if (broken.has(prefix)) throw new Error("store down");
      return [...docs.keys()].filter((p) => p.startsWith(prefix));
    },
    write: async (path, body) => {
      if (broken.has(`write:${path}`)) throw new Error("store down");
      docs.set(path, body);
    },
    beacons: async (session) => {
      calls.beacons.push(session);
      if (broken.has(`beacons:${session}`)) throw new Error("store down");
      return beacons.get(session) ?? [];
    },
    refusal: async () => {
      calls.refusal++;
      return state.refusal;
    },
    clock: () => state.now,
    log: (_evt, fields) => void state.logs.push(fields),
  };
  const reset = () => {
    calls.read.length = 0;
    calls.list.length = 0;
    calls.beacons.length = 0;
    calls.refusal = 0;
  };
  return { docs, beacons, calls, broken, state, deps, reset, file: () => parsePipelineFile(docs.get(RADAR_PIPELINE_PATH))! };
}

describe("the summary the cron writes", () => {
  it("gathers a session from the beacons, the copies' receipt times and the dated documents", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.beacons.set(S, [{ ...runJson, session: S, started_at: "2026-11-19T10:30:20Z", ended_at: "2026-11-19T10:43:00Z" }]);
    m.docs.set(`radar/copies/${S}/20261119T104400000Z-r1.json`, "{}");
    m.docs.set(`radar/editions/${S}.json`, "{}");
    m.docs.set(`options/copies/${S}/20261118T215800000Z-o1.json`, "{}");
    m.docs.set(`radar-desk/editions/${S}.json`, JSON.stringify({ session: S, as_of: "2026-11-19T11:16:00Z", names: [{ symbol: "ZZZZ" }] }));
    m.docs.set(`options/premarket/${S}.json`, JSON.stringify({ session: S, as_of: "2026-11-19T13:52:00Z", items: [] }));
    m.docs.set(`ledger/editions/${P}.json`, JSON.stringify({ session: P, as_of: "2026-11-19T14:12:00Z" }));
    m.docs.set(`funnel/editions/${S}.json`, JSON.stringify({ ...funnelJson, session: S }));
    expect(await refreshRadarPipeline(m.deps)).toBe("written");
    const f = m.file();
    expect(f.generated_at).toBe("2026-11-19T14:20:00.000Z");
    // A first run reads the session in view, the one before it and the six newest of the rest.
    expect(f.sessions).toHaveLength(8);
    const s = f.sessions.at(-1)!;
    expect(s).toMatchObject({
      session: S,
      levels_at: "2026-11-18T21:58:00.000Z",
      stored_at: "2026-11-19T10:44:00.000Z",
      edition_on_file: true,
      refused_at: null,
      desk_at: "2026-11-19T11:16:00.000Z",
      preopen_at: "2026-11-19T13:52:00.000Z",
      card_at: "2026-11-19T14:12:00.000Z",
    });
    expect(s.beacons.build).toMatchObject({ state: "finished", trigger: "scheduled" });
    expect(s.funnel?.focus).toMatchObject({ judged: 12, kept: 4 });
    // Nothing of any document's content is carried: only the fields the summary names.
    expect(m.docs.get(RADAR_PIPELINE_PATH)).not.toContain("ZZZZ");
    expect(m.state.logs.at(-1)).toMatchObject({ outcome: "written", sessions: 8, looked: 8, failed_reads: 0 });
    // The refusal is asked about for the session in view only.
    expect(m.calls.refusal).toBe(1);
  });

  it("the next run looks again only at the session in view and the one before, and reads no time it already holds", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.docs.set(`radar/copies/${S}/20261119T104400000Z-r1.json`, "{}");
    m.docs.set(`ledger/editions/${P}.json`, JSON.stringify({ session: P, as_of: "2026-11-19T14:12:00Z" }));
    for (let i = 0; i < 4; i++) await refreshRadarPipeline(m.deps);
    expect(m.file().sessions).toHaveLength(21);
    m.reset();
    // Later in the day the ledger's document is replaced by the after-close one: the morning's time must stay.
    m.state.now = t("2026-11-19T21:40:00Z");
    m.docs.set(`ledger/editions/${P}.json`, JSON.stringify({ session: P, as_of: "2026-11-19T21:25:00Z" }));
    await refreshRadarPipeline(m.deps);
    expect(m.calls.beacons.sort()).toEqual([P, S]);
    expect(m.calls.list).not.toContain(`radar/copies/${S}/`);
    expect(m.calls.read).not.toContain(`ledger/editions/${P}.json`);
    expect(m.file().sessions.at(-1)).toMatchObject({ card_at: "2026-11-19T14:12:00.000Z", stored_at: "2026-11-19T10:44:00.000Z" });
    expect(m.state.logs.at(-1)).toMatchObject({ outcome: "written", looked: 2 });
  });

  it("a refusal on the session's day stands until an edition is stored", async () => {
    const m = memory("2026-11-19T11:00:00Z");
    m.state.refusal = { at: "2026-11-19T10:44:30Z", current: true };
    await refreshRadarPipeline(m.deps);
    expect(m.file().sessions.at(-1)!.refused_at).toBe("2026-11-19T10:44:30.000Z");
    m.state.refusal = { at: "2026-11-19T10:44:30Z", current: false };
    await refreshRadarPipeline(m.deps);
    expect(m.file().sessions.at(-1)!.refused_at).toBeNull();
    // Yesterday's refusal is not today's.
    m.state.refusal = { at: "2026-11-18T10:44:30Z", current: true };
    await refreshRadarPipeline(m.deps);
    expect(m.file().sessions.at(-1)!.refused_at).toBeNull();
  });

  it("an edition on file with no copy is said to be on file, with no receipt time made up for it", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.docs.set(`radar/editions/${P}.json`, JSON.stringify({ edition_date: P, as_of: "2026-11-18T10:44:00Z" }));
    await refreshRadarPipeline(m.deps);
    const p = m.file().sessions.at(-2)!;
    expect(p).toMatchObject({ session: P, edition_on_file: true, stored_at: null });
  });

  it("the options edition's own stamp stands in for the levels only when no copy was kept and it is the evening's", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.docs.set(`options/editions/${S}.json`, JSON.stringify({ session: S, as_of: "2026-11-18T21:58:00Z" }));
    await refreshRadarPipeline(m.deps);
    expect(m.file().sessions.at(-1)!.levels_at).toBe("2026-11-18T21:58:00.000Z");
  });

  it("a read that fails leaves that time unknown, keeps what was held, and the summary is still written", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.beacons.set(S, [{ ...runJson, session: S }]);
    await refreshRadarPipeline(m.deps);
    m.broken.add(`beacons:${S}`);
    m.broken.add(`radar/copies/${S}/`);
    m.broken.add("radar/editions/");
    await refreshRadarPipeline(m.deps);
    const s = m.file().sessions.at(-1)!;
    expect(s.beacons.build?.state).toBe("finished");
    expect(s.stored_at).toBeNull();
    expect(m.state.logs.at(-1)).toMatchObject({ outcome: "written", failed_reads: 3 });
  });

  it("a past session whose first look had a failed read is not said to have missed, and is read again until whole", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    const old = "2026-11-16";
    m.docs.set(`radar/copies/${old}/20261116T104400000Z-r1.json`, "{}");
    m.broken.add(`radar/copies/${old}/`);
    await refreshRadarPipeline(m.deps);
    const first = m.file().sessions.find((s) => s.session === old)!;
    expect(first).toMatchObject({ stored_at: null, complete: false });
    expect(sessionMark(old, first, m.state.now)).toBe("no_record");
    m.broken.clear();
    await refreshRadarPipeline(m.deps);
    const second = m.file().sessions.find((s) => s.session === old)!;
    expect(second).toMatchObject({ stored_at: "2026-11-16T10:44:00.000Z", complete: true });
    expect(sessionMark(old, second, m.state.now)).toBe("on_time");
    // Whole now, it is not read a third time.
    m.reset();
    await refreshRadarPipeline(m.deps);
    expect(m.calls.beacons).not.toContain(old);
  });

  it("with the listing of editions on file unreadable, no session is whole and none is said to have missed", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.broken.add("radar/editions/");
    await refreshRadarPipeline(m.deps);
    const f = m.file();
    expect(f.sessions.every((s) => !s.complete)).toBe(true);
    expect(f.sessions.map((s) => sessionMark(s.session, s, m.state.now))).not.toContain("missed");
  });

  it("an unreadable summary is started again; a failed write is an error that never rejects", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.docs.set(RADAR_PIPELINE_PATH, "not json");
    expect(await refreshRadarPipeline(m.deps)).toBe("written");
    expect(m.file().sessions).toHaveLength(8);
    m.broken.add(`write:${RADAR_PIPELINE_PATH}`);
    expect(await refreshRadarPipeline(m.deps)).toBe("error");
    expect(m.state.logs.at(-1)).toMatchObject({ outcome: "error", error: "Error" });
  });

  it("a run that hangs is reported as an error inside its budget", async () => {
    const m = memory("2026-11-19T14:20:00Z");
    m.deps.write = () => new Promise(() => undefined);
    expect(await refreshRadarPipeline(m.deps, 20)).toBe("error");
    expect(m.state.logs.at(-1)).toMatchObject({ outcome: "error", error: "Timeout" });
  });

  it("on a holiday it keeps the next session in view and asks nothing of today", async () => {
    const m = memory(RADAR_HOLIDAY_NOW);
    await refreshRadarPipeline(m.deps);
    const f = m.file();
    expect(f.sessions.at(-1)!.session).toBe("2026-11-27");
    expect(f.sessions.map((s) => s.session)).not.toContain("2026-11-26");
  });

  it("one look reads the ledger under the session before", async () => {
    const m = memory("2026-11-23T14:20:00Z");
    m.docs.set("ledger/editions/2026-11-20.json", JSON.stringify({ session: "2026-11-20", as_of: "2026-11-23T14:12:00Z" }));
    const o = await observeSession(m.deps, "2026-11-23", "2026-11-20", null, { inView: true, editionDates: null });
    expect(o.card_at).toBe("2026-11-23T14:12:00.000Z");
  });

  it("starting it beside the cron never throws, with or without a request to keep it alive in", async () => {
    const kept: Promise<unknown>[] = [];
    expect(() => startRadarPipelineRefresh((w) => kept.push(w), () => Promise.reject(new Error("boom")))).not.toThrow();
    await expect(kept[0]).resolves.toBeUndefined();
    let ran = false;
    expect(() =>
      startRadarPipelineRefresh(
        () => {
          throw new Error("no request scope");
        },
        async () => {
          ran = true;
        },
      ),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
  });
});

// ---- the page's read, in both modes ---------------------------------------------------------------------------------

const blob = vi.hoisted(() => ({ text: null as string | null, fail: false, reads: [] as string[] }));
vi.mock("@/lib/blob", async (orig) => ({
  ...(await orig<typeof import("@/lib/blob")>()),
  readText: vi.fn(async (pathname: string) => {
    blob.reads.push(pathname);
    if (blob.fail) throw new Error("store down");
    return blob.text === null ? null : { text: blob.text, etag: '"e"' };
  }),
}));

describe("the page's read", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    blob.text = null;
    blob.fail = false;
    blob.reads.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  const now = new Date("2026-11-19T15:00:00Z");

  it("is one read of the summary; none, unreadable or a failing store all give the schedule alone", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    expect(await loadRadarPipeline(now)).toEqual({ file: null, now });
    expect(blob.reads).toEqual([RADAR_PIPELINE_PATH]);
    blob.text = "{";
    expect((await loadRadarPipeline(now)).file).toBeNull();
    blob.fail = true;
    expect((await loadRadarPipeline(now)).file).toBeNull();
    blob.fail = false;
    blob.text = serializePipelineFile({ v: 1, generated_at: "2026-11-19T14:50:00.000Z", sessions: [clean()] });
    expect((await loadRadarPipeline(now)).file?.sessions[0]?.stored_at).toBe("2026-11-19T10:44:00.000Z");
  });

  it("in fixture mode it is made in memory and the store is never read", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const v = await loadRadarPipeline(now);
    expect(v.file?.sessions).toHaveLength(21);
    expect(blob.reads).toEqual([]);
  });
});

// ---- the fixture's variants and the card --------------------------------------------------------------------------

const FROZEN = t("2026-10-12T15:01:00Z"); // 11:01 New York on the fixture's session
const flags = (...f: VariantFlag[]) => new Set<VariantFlag>(f);

describe("the fixture", () => {
  it("knows every radar flag", () => {
    for (const f of ["radar-building", "radar-late", "radar-hand", "radar-refused", "radar-holiday"]) expect(VARIANT_FLAGS).toContain(f);
  });

  it("a clean run so far, at any time of day: nothing in it is ahead of the clock", () => {
    for (const now of ["2026-10-12T03:00:00Z", "2026-10-12T09:50:00Z", "2026-10-12T15:01:00Z", "2026-10-10T15:00:00Z", RADAR_HOLIDAY_NOW]) {
      const f = fixturePipeline(t(now));
      const times = JSON.stringify(f).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
      expect(times.every((x) => t(x) <= t(now))).toBe(true);
      const v = pipelineView(f, t(now));
      expect(v.rows.map((r) => r.state)).not.toContain("failed");
      expect(v.reliability.marks).toHaveLength(20);
    }
  });

  it("draws each variant's badge at the frozen time", () => {
    const word = (...f: VariantFlag[]) => pipelineView(fixturePipeline(FROZEN, flags(...f)), FROZEN).headline.word;
    expect(word()).toBe("On time");
    expect(word("radar-late")).toBe("Late by 3 h 7 min");
    expect(word("radar-hand")).toBe("Built by hand");
    expect(word("radar-refused")).toBe("Edition refused");
    // A build still running hours past the deadline is late first; the rail says it is running.
    const building = pipelineView(fixturePipeline(FROZEN, flags("radar-building")), FROZEN);
    expect(building.headline.kind).toBe("late");
    expect(building.rows.find((r) => r.key === "build")!.state).toBe("running");
    const early = t("2026-10-12T09:40:00Z");
    expect(pipelineView(fixturePipeline(early, flags("radar-building")), early).headline.word).toBe("Building now");
    const holiday = t(RADAR_HOLIDAY_NOW);
    expect(pipelineView(fixturePipeline(holiday), holiday).headline.word).toBe("No session today");
  });

  it("the last sessions hold one late, one by hand, one never stored and two with no record", () => {
    const r = pipelineView(fixturePipeline(FROZEN), FROZEN).reliability;
    expect(r).toMatchObject({ on_time: 15, late: 1, by_hand: 1, missed: 1, no_record: 2, counted: 18 });
    expect(Math.round(r.rate! * 100)).toBe(83);
  });
});

describe("the card", () => {
  const html = (file: PipelineFile | null, nowMs: number) => renderToString(createElement(RadarPipelineView, { file, nowMs }));

  it("draws the badge, seven stages, the last sessions and the funnel's counts", () => {
    const out = html(fixturePipeline(FROZEN), FROZEN);
    expect(out).toContain('aria-label="Radar pipeline: On time"');
    expect(out.match(/data-rail-state=/g)).toHaveLength(7);
    expect(out).toContain("83% on time");
    expect(out.match(/data-mark=/g)).toHaveLength(20);
    expect(out).toContain("Replay matches");
    expect(out).not.toContain("data-rail-now-mark"); // every stage's time has passed
    expect(html(fixturePipeline(t("2026-10-12T12:00:00Z")), t("2026-10-12T12:00:00Z"))).toContain("data-rail-now-mark");
  });

  it("shows the sample size beside the on-time rate, and that no-record sessions are left out", () => {
    const out = html(fixturePipeline(FROZEN), FROZEN);
    // 18 sessions carry a record; 2 of the 20 have none and are not in the rate.
    expect(out).toMatch(/data-on-time-n[^>]*>n=<!-- -->18<!-- --> of 20</);
    const r = pipelineView(fixturePipeline(FROZEN), FROZEN).reliability;
    expect(r.counted + r.no_record).toBe(r.marks.length);
    expect(html(null, FROZEN)).not.toContain("data-on-time-n");
  });

  it("draws the Radar's count and the desk's pick as two separate facts, never one funnel", () => {
    const v = pipelineView(fixturePipeline(FROZEN), FROZEN);
    const out = html(fixturePipeline(FROZEN), FROZEN);
    expect(out).not.toContain("on the radar");
    expect(out).not.toMatch(/>in focus</);
    expect(out).not.toMatch(/[Ss]election funnel/);
    // The Radar's count is the previous session's morning edition.
    expect(v.days.previous).toBe(v.days.sessions[v.days.sessions.length - 2]);
    const radar = /data-radar-scanned[\s\S]*?<\/li>/.exec(out)![0];
    expect(radar).toContain("Radar scanned");
    expect(radar).toContain(`morning of ${weekDate(v.days.previous)}`);
    expect(radar).toContain(String(v.obs!.funnel!.radar!.kept));
    const desk = /data-desk-picked[\s\S]*?<\/li>/.exec(out)![0];
    expect(desk).toContain(`>${v.obs!.funnel!.focus!.judged}<`);
    expect(desk).toContain(`>${v.obs!.funnel!.focus!.kept}<`);
    expect(desk).toContain("picked");
    expect(out).toContain("not drawn from the Radar");
  });

  it("with no summary it is the schedule alone, and says so", () => {
    const out = html(null, FROZEN);
    expect(out).toContain('aria-label="Radar pipeline: Schedule only"');
    expect(out).toContain("No pipeline record has been written yet");
    expect(out).not.toMatch(/>Late<|>Failed</);
    expect(out).toContain("No record of the Radar scan or the desk pick for this session yet");
  });

  it("an old summary says how old", () => {
    const f = { ...fixturePipeline(FROZEN), generated_at: new Date(FROZEN - 95 * 60_000).toISOString() };
    expect(html(f, FROZEN)).toContain("1 h 35 min");
    expect(html(fixturePipeline(FROZEN), FROZEN)).not.toContain("data-pipeline-stale");
  });

  it("names the holiday, and the next session", () => {
    const out = html(fixturePipeline(t(RADAR_HOLIDAY_NOW)), t(RADAR_HOLIDAY_NOW));
    expect(out).toContain('aria-label="Radar pipeline: No session today"');
    expect(out).toContain("Thanksgiving");
    expect(out).not.toMatch(/>Late</);
  });

  it("lists the four routines with their ids", () => {
    const out = renderToString(createElement(RadarSchedulePanel, { file: fixturePipeline(FROZEN), now: new Date(FROZEN) }));
    expect(RADAR_ROUTINES.map((r) => r.id)).toEqual(["trig_01PW2UvCBejb4UxCEB58PEVp", "trig_015qsK3nrRQgscNZh6strL4F", "trig_01B1TN3d4x7dZ3Wxad2LmYgb", "trig_01WyzH7k8xAUgj8RZsakUDW7"]);
    for (const r of RADAR_ROUTINES) expect(out).toContain(r.id);
    expect(out).toContain("every 20 minutes until 13:45 UTC");
  });

  it("carries no symbol and none of the words the pages may not use, in any variant", () => {
    const variants: VariantFlag[][] = [[], ["radar-building"], ["radar-late"], ["radar-hand"], ["radar-refused"]];
    for (const f of variants) {
      const out = renderToString(createElement(RadarSchedulePanel, { file: fixturePipeline(FROZEN, flags(...f)), now: new Date(FROZEN) }));
      const text = out.replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/\bseal/i);
      expect(text).not.toMatch(/\b(SPY|QQQ|AAPL|NVDA|TSLA|MSFT)\b/);
    }
    for (const file of ["../src/components/client/radar-pipeline.tsx", "../src/components/radar-schedule.tsx", "../src/lib/radar-pipeline-slots.ts", "../src/lib/radar-pipeline-fixture.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(src, file).not.toMatch(/seal/i);
    }
  });
});

describe("the clock", () => {
  beforeEach(() => resetPipelineClock());

  it("is the server's time plus the monotonic time since it arrived, in whole ticks", () => {
    expect(pipelineClock(1_000_000, 500)).toBe(1_000_000);
    expect(pipelineClock(1_000_000, 500 + PIPELINE_TICK_MS - 1)).toBe(1_000_000);
    expect(pipelineClock(1_000_000, 500 + 3 * PIPELINE_TICK_MS + 7)).toBe(1_000_000 + 3 * PIPELINE_TICK_MS);
    // A new server time is anchored where it arrives; the older one keeps its own anchor.
    expect(pipelineClock(1_060_000, 60_500)).toBe(1_060_000);
    expect(pipelineClock(1_000_000, 60_500)).toBe(1_000_000 + 6 * PIPELINE_TICK_MS);
  });
});
