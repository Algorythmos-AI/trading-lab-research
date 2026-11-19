// The Radar pipeline's summary in fixture mode (the browser tests and local runs): made in memory from the clock, so
// the page draws its real structure with no store. Pure. Every time in it lies at or before `nowMs`, as in a real
// summary: what has not happened yet has not been seen.
import type { VariantFlag } from "./fixture-variants";
import { emptyObs, type BeaconObs, type PipelineFile, pipelineDays, scheduleOf, type SessionObs, type Trigger } from "./radar-pipeline";

const MIN = 60_000;

/** `radar-holiday`: the pipeline is drawn for this instant, 10:00 New York on Thanksgiving 2026 (the market is shut). */
export const RADAR_HOLIDAY_NOW = "2026-11-26T15:00:00Z";

/** How far behind its scheduled time the `radar-late` and `radar-hand` editions are stored: 3 h 7 min. */
export const FIXTURE_LATE_MIN = 187;

const at = (t: number) => new Date(t).toISOString();

/** A whole session as a clean run leaves it: every stage a few minutes after its time, started by `trigger`. */
function ran(session: string, trigger: Trigger, storedLateMin = 4): SessionObs {
  const t = scheduleOf(session);
  const beacon = (from: number, mins: number): BeaconObs => ({ state: "finished", trigger, started_at: at(from), ended_at: at(from + mins * MIN), reason: "ok" });
  const stored = t.stored.scheduled + storedLateMin * MIN;
  const build = stored - 14 * MIN;
  const kept = Math.max(stored, t.evidence.scheduled) + 2 * MIN;
  return {
    session,
    levels_at: at(t.levels.scheduled + 6 * MIN),
    beacons: { build: beacon(build, 12), send: beacon(stored - MIN, 1), evidence: beacon(kept - MIN, 1), desk: beacon(kept, 1) },
    stored_at: at(stored),
    edition_on_file: true,
    refused_at: null,
    desk_at: at(kept + MIN),
    preopen_at: at(Math.max(t.preopen.scheduled + 2 * MIN, kept + 2 * MIN)),
    card_at: at(Math.max(t.card.scheduled + MIN, kept + 3 * MIN)),
    funnel: {
      radar: { evidence: "present", kept_at: at(kept), judged: null, kept: 42, flagged: 0, replay: "not_run" },
      focus: { evidence: "present", kept_at: at(t.levels.scheduled + 8 * MIN), judged: 12, kept: 4, flagged: 2, replay: "match" },
    },
  };
}

/** `o` as it stood at `nowMs`: anything stamped after it has not been seen yet. */
function asOf(o: SessionObs, nowMs: number): SessionObs {
  const seen = (iso: string | null) => (iso !== null && Date.parse(iso) <= nowMs ? iso : null);
  const beacons: SessionObs["beacons"] = {};
  for (const [stage, b] of Object.entries(o.beacons) as [keyof SessionObs["beacons"], BeaconObs][]) {
    if (Date.parse(b.started_at) > nowMs) continue;
    beacons[stage] = b.ended_at !== null && Date.parse(b.ended_at) > nowMs ? { ...b, state: "started", ended_at: null, reason: null } : b;
  }
  const stored = seen(o.stored_at);
  return {
    ...o,
    levels_at: seen(o.levels_at),
    beacons,
    stored_at: stored,
    edition_on_file: stored !== null,
    refused_at: seen(o.refused_at),
    desk_at: seen(o.desk_at),
    preopen_at: seen(o.preopen_at),
    card_at: seen(o.card_at),
    funnel: o.funnel && seen(o.levels_at) ? { radar: o.funnel.radar && seen(o.funnel.radar.kept_at) ? o.funnel.radar : null, focus: o.funnel.focus } : null,
  };
}

/**
 * The summary at `nowMs`. The twenty sessions before the one in view: clean runs, but for one stored late by the
 * catch-up, one built by hand, one never stored, and the two oldest from before the beacon (an edition on file, no
 * receipt time, no build record). The session in view is a clean run so far, or as the `radar-*` flag says:
 * `radar-building` (the build has started and not ended), `radar-late` (stored 3 h 7 min behind, by the catch-up),
 * `radar-hand` (the same, started by a person), `radar-refused` (built, then refused by the ingest).
 */
export function fixturePipeline(nowMs: number, flags: ReadonlySet<VariantFlag> = new Set()): PipelineFile {
  const days = pipelineDays(nowMs);
  const sessions = days.sessions.map((session, i): SessionObs => {
    if (session !== days.focus) {
      if (i < 2) return { ...emptyObs(session), edition_on_file: true };
      if (i === 6) return ran(session, "catch-up", FIXTURE_LATE_MIN);
      if (i === 11) return ran(session, "manual", FIXTURE_LATE_MIN);
      if (i === 15) return { ...emptyObs(session), levels_at: ran(session, "scheduled").levels_at };
      return ran(session, "scheduled");
    }
    const t = scheduleOf(session);
    if (flags.has("radar-building")) {
      const o = asOf(ran(session, "scheduled"), nowMs);
      const started = at(Math.min(nowMs - 3 * MIN, Math.max(t.build.scheduled + MIN, nowMs - 9 * MIN)));
      return { ...emptyObs(session), levels_at: o.levels_at, funnel: o.funnel, beacons: { build: { state: "started", trigger: "scheduled", started_at: started, ended_at: null, reason: null } } };
    }
    if (flags.has("radar-refused")) {
      const o = asOf(ran(session, "scheduled"), nowMs);
      const refused = t.stored.scheduled + 4 * MIN;
      if (refused > nowMs) return o;
      return {
        ...emptyObs(session),
        levels_at: o.levels_at,
        funnel: o.funnel ? { radar: null, focus: o.funnel.focus } : null,
        beacons: { build: o.beacons.build, send: { state: "failed", trigger: "scheduled", started_at: at(refused - MIN), ended_at: at(refused), reason: "not-stored" } },
        refused_at: at(refused),
      };
    }
    if (flags.has("radar-late")) return asOf(ran(session, "catch-up", FIXTURE_LATE_MIN), nowMs);
    if (flags.has("radar-hand")) return asOf(ran(session, "manual", FIXTURE_LATE_MIN), nowMs);
    return asOf(ran(session, "scheduled"), nowMs);
  });
  return { v: 1, generated_at: at(nowMs - 4 * MIN), sessions };
}
