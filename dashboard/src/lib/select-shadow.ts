// The Radar → Options shadow selection (DEC-0070) for one session, as the Radar pipeline card draws it. Pure: the
// block is the trading host's (paper-options `select`, wt.options.select_status), the clock is passed in.
//
// A shadow: what it shows is not the published focus. The four names on the Options page are still the cloud routine's
// after-close pick until the switch (DEC-0048). The block carries codes, counts, times and flags only; no symbol.
// It never feeds the pipeline's headline, its stage rows or its on-time record (radar-pipeline.ts): a session the
// shadow did not run for reads "no record" here and nowhere else.
import { nyInstant } from "./options";
import type { PaperOptions, SelectSession } from "./paper-options.types";

export type SelectBlock = NonNullable<PaperOptions["select"]>;

/** The job's start, New York minutes after midnight (wt.ops.schedule `options-select`). */
export const SHADOW_START_NY = 6 * 60 + 45;
/** It reads the Radar until 07:45 and has written its run by about 07:55: after this it is overdue. */
export const SHADOW_DUE_NY = 8 * 60;

export type ShadowState = "ran" | "not_due" | "running" | "overdue" | "off" | "no_record";

export interface ShadowView {
  state: ShadowState;
  session: string;
  run: SelectSession | null;
  /** When the job starts for `session` (ms), or null when the day cannot be read. */
  startsAt: number | null;
}

/** The shadow's view of `session` at `nowMs`. `block` null: the host has sent no shadow status. */
export function shadowView(block: SelectBlock | null, session: string, nowMs: number): ShadowView {
  const run = block?.sessions.find((s) => s.session === session) ?? null;
  const startsAt = nyInstant(session, SHADOW_START_NY);
  const dueAt = nyInstant(session, SHADOW_DUE_NY);
  const state: ShadowState = run
    ? "ran"
    : block === null
      ? "no_record"
      : block.off
        ? "off"
        : startsAt !== null && nowMs < startsAt
          ? "not_due"
          : dueAt !== null && nowMs < dueAt
            ? "running"
            : startsAt === null
              ? "no_record"
              : "overdue";
  return { state, session, run, startsAt };
}

export const RADAR_STATUS_WORDS: Record<string, string> = {
  ok: "Radar edition read",
  radar_missing: "Radar missing: ran on the desk's 12",
  radar_stale: "Radar not fresh: ran on the desk's 12",
  radar_invalid: "Radar unreadable: ran on the desk's 12",
};

/** The largest reject codes first, at most `n`, as "code n". */
export function topRejects(rejected: Record<string, number | undefined> | undefined, n = 3): { code: string; count: number }[] {
  return Object.entries(rejected ?? {})
    .flatMap(([code, count]) => (typeof count === "number" ? [{ code, count }] : []))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, n);
}

/** Why a shadow session is not clean (wt.options.radar_select.NOT_CLEAN, plus the page's own `check_invalid`). */
export const NOT_CLEAN_WORDS: Record<string, string> = {
  radar_not_ok: "the Radar was not read ok",
  late: "late",
  radar_bars_failed: "the candidates' bars could not be fetched",
  no_radar_candidates: "no Radar candidates",
  facts_missing: "gate facts missing",
  replay_differs: "the replay differs",
  replay_error: "the replay could not run",
  check_invalid: "the check record is unreadable",
};

/** Clean sessions the switch's operational gate needs when the host sends no number (radar_select.CLEAN_NEEDED). */
export const CLEAN_NEEDED = 5;

export type CheckMark = "clean" | "not_clean" | "no_check";

export interface ProgressView {
  clean: number;
  needed: number;
  /** The recent sessions, oldest first: clean, not clean or not checked. */
  marks: { session: string; mark: CheckMark; reasons: string[] }[];
  /** False for a version 4 block: the host does not check its runs yet. */
  tracked: boolean;
}

/** The shadow's progress toward its five clean sessions. Null when the host has sent no shadow status. */
export function progressView(block: SelectBlock | null): ProgressView | null {
  if (block === null) return null;
  const marks = block.sessions.map((s) => {
    const c = s.check ?? null;
    const mark: CheckMark = c === null ? "no_check" : c.clean ? "clean" : "not_clean";
    return { session: s.session, mark, reasons: c && !c.clean ? c.reasons : [] };
  });
  const p = block.progress;
  return {
    clean: p ? p.clean : marks.filter((m) => m.mark === "clean").length,
    needed: p ? p.needed : CLEAN_NEEDED,
    marks,
    tracked: p !== undefined,
  };
}

/** "3 of 4 of its picks are in the published focus", or why it cannot be said. Null without a check. */
export function publishedWords(check: SelectSession["check"]): string | null {
  if (!check) return null;
  const p = check.published;
  if (p.status === "ok" && typeof p.overlap === "number" && typeof p.of === "number")
    return `${p.overlap} of the published ${p.of} also picked by the shadow`;
  if (p.status === "other_session") return "Published focus was for another session";
  if (p.status === "not_read") return "Published focus not read (checked later)";
  return "Published focus unreadable";
}
